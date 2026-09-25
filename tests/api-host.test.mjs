// Story 1.3 acceptance: the HTTP API host, the fixed middleware pipeline, the
// protocol gate over the whole /api/ prefix, health, realm bootstrap, and the
// core boundary. Live rows spawn the real server child (node:test with real
// child processes); pipeline rows run in-process with sentinel stages and
// handler spies; the rejection invariant hashes the database file before and
// after rejected requests.

import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { once } from 'node:events'
import http from 'node:http'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { Readable } from 'node:stream'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { APP_VERSION } from '../server/runtime.mjs'
import {
  FRAME_MAX_BYTES,
  PUBLIC_ERRORS,
  PUBLIC_ERROR_STATUS,
} from '../server/constants.mjs'
import { ROOM_LOG_DATABASE_FILENAME, openRoomLog } from '../server/store/room-log.mjs'
import { bootstrapRealm } from '../server/core/realm.mjs'
import { startServer, registerHandler } from '../server/api/server.mjs'
import {
  AuthStage,
  AuthzStage,
  BudgetStage,
  ProtocolStage,
  TransportStage,
  assemblePipeline,
  assertStageOrder,
  reject,
  runPipeline,
} from '../server/api/pipeline.mjs'
import { ROUTE_TABLE } from '../server/api/routes.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = join(ROOT, 'server', 'api', 'server.mjs')
const RUNTIME_RECORD_FILENAME = 'runtime.json'
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
const PROTOCOL_KEY = 'agent-room-protocol'

const sleep = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })

function makeDataDir(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-api-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  return dataDir
}

// Spawns the real server entrypoint as a child process pointed at a private
// data dir, exactly as Local Mode launches it.
function spawnServerChild(t, dataDir) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, AGENT_ROOM_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stderrChunks = []
  child.stderr.on('data', chunk => stderrChunks.push(chunk))
  const stderrText = () => Buffer.concat(stderrChunks).toString('utf8')
  const runtimePath = join(dataDir, RUNTIME_RECORD_FILENAME)

  const waitReady = async () => {
    const deadline = Date.now() + 10 * 1000
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`server child exited early (code=${child.exitCode}, signal=${child.signalCode}); stderr: ${stderrText()}`)
      }
      if (existsSync(runtimePath)) {
        try {
          const record = JSON.parse(readFileSync(runtimePath, 'utf8'))
          if (Number.isInteger(record.port) && record.port > 0) return record
        } catch {
          // Atomic rename means readers never see partial files; retry anyway.
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`server child never wrote runtime.json; stderr: ${stderrText()}`)
      }
      await sleep(25)
    }
  }

  const stop = async (expectedExitCode = 0) => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM')
    const [code] = await once(child, 'exit')
    if (expectedExitCode !== null) assert.equal(code, expectedExitCode)
    return code
  }

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit').catch(() => {})
    }
  })

  return { child, waitReady, stop, stderrText }
}

// Small direct HTTP client: no keep-alive, so killed children never leave
// pooled sockets behind between tests.
function request(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers, agent: false },
      response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('error', rejectPromise)
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolvePromise({
            status: response.statusCode,
            headers: response.headers,
            text,
            json: () => JSON.parse(text),
          })
        })
      },
    )
    req.on('error', rejectPromise)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

function hashStore(dataDir) {
  const databasePath = join(dataDir, ROOM_LOG_DATABASE_FILENAME)
  return [databasePath, `${databasePath}-wal`]
    .filter(existsSync)
    .map(path => createHash('sha256').update(readFileSync(path)).digest('hex'))
    .join(',')
}

function inspectRealm(dataDir) {
  const database = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME))
  try {
    const realm = database
      .prepare('SELECT singleton, realm_id, created_at FROM realms WHERE singleton = 1')
      .get() ?? null
    const broadcastRooms = database.prepare(`
      SELECT id, kind, title, created_by_fingerprint
      FROM rooms
      WHERE kind = 'broadcast'
      ORDER BY created_at ASC, id ASC
    `).all()
    return { realm, broadcastRooms }
  } finally {
    database.close()
  }
}

// Captures process.stderr writes around an async body (in-process fallback
// diagnostics are asserted, then the original writer is restored).
async function captureStderr(body) {
  const original = process.stderr.write.bind(process.stderr)
  const chunks = []
  process.stderr.write = (chunk, ...rest) => {
    chunks.push(String(chunk))
    return original(chunk, ...rest)
  }
  try {
    return { result: await body(), chunks }
  } finally {
    process.stderr.write = original
  }
}

async function freePort() {
  const probe = net.createServer()
  await new Promise((resolvePromise, rejectPromise) => {
    probe.once('error', rejectPromise)
    probe.listen(0, '127.0.0.1', () => resolvePromise())
  })
  const port = probe.address().port
  await new Promise(resolvePromise => probe.close(resolvePromise))
  return port
}

// --- Sentinel pipeline tests (in-process, handler spies) ----------------------

const routeFor = (method, path) => {
  const route = ROUTE_TABLE.find(entry => entry.method === method && entry.path === path)
  assert.ok(route, `${method} ${path} must exist in the frozen route table`)
  return route
}

function makeContext(route, overrides = {}) {
  const query = overrides.query ?? {}
  return {
    method: route.method,
    route,
    headers: {},
    query,
    queryKeys: Object.keys(query),
    remoteAddress: '127.0.0.1',
    encrypted: false,
    ...overrides,
  }
}

function instrument(stages, invoked) {
  return stages.map(stage => ({
    name: stage.name,
    process: async context => {
      invoked.push(stage.name)
      return stage.process(context)
    },
  }))
}

async function runWithSpy(stages, context, handler) {
  const invoked = []
  let handlerCalls = 0
  const outcome = await runPipeline(instrument(stages, invoked), context, context => {
    handlerCalls += 1
    return handler?.(context)
  })
  return { invoked, handlerCalls, outcome }
}

const passingVerifier = () => ({ fingerprint: `sha256:${'a'.repeat(64)}` })

test('the four classes assemble the one fixed pipeline; viewer and health skip protocol', () => {
  const expected = {
    actor: ['protocol', 'transport', 'auth', 'budgets', 'authz'],
    'pre-auth': ['protocol', 'transport', 'auth', 'budgets', 'authz'],
    viewer: ['transport', 'auth', 'budgets', 'authz'],
    health: ['transport', 'auth', 'budgets', 'authz'],
  }
  for (const [routeClass, names] of Object.entries(expected)) {
    assert.deepEqual(assemblePipeline(routeClass).map(stage => stage.name), names, routeClass)
  }
  assert.throws(() => assemblePipeline('operator'), /unknown route class/)
})

test('stages execute in canonical order and the handler is last', async () => {
  const context = makeContext(routeFor('GET', '/api/status'), {
    headers: { [PROTOCOL_KEY]: '1' },
  })
  const { invoked, handlerCalls, outcome } = await runWithSpy(
    assemblePipeline('actor', { sessionVerifier: passingVerifier }),
    context,
  )
  assert.deepEqual(invoked, ['protocol', 'transport', 'auth', 'budgets', 'authz'])
  assert.equal(handlerCalls, 1)
  assert.equal(outcome.ok, true)
  assert.deepEqual(context.session, { fingerprint: `sha256:${'a'.repeat(64)}` })
})

test('a rejection at any stage never reaches the handler or a later stage', async () => {
  // Protocol rejection: missing header on an actor route.
  const protocolRun = await runWithSpy(
    assemblePipeline('actor'),
    makeContext(routeFor('GET', '/api/status')),
  )
  assert.deepEqual(protocolRun.invoked, ['protocol'])
  assert.equal(protocolRun.handlerCalls, 0)
  assert.equal(protocolRun.outcome.code, 'protocol_required')
  assert.equal(protocolRun.outcome.status, 400)

  // Transport refusal: off-loopback plain HTTP.
  const transportRun = await runWithSpy(
    assemblePipeline('actor'),
    makeContext(routeFor('GET', '/api/status'), {
      headers: { [PROTOCOL_KEY]: '1' },
      remoteAddress: '203.0.113.7',
    }),
  )
  assert.deepEqual(transportRun.invoked, ['protocol', 'transport'])
  assert.equal(transportRun.handlerCalls, 0)
  assert.equal(transportRun.outcome.refusal, true)

  // Auth rejection: the default verifier rejects every actor request.
  const authRun = await runWithSpy(
    assemblePipeline('actor'),
    makeContext(routeFor('GET', '/api/status'), { headers: { [PROTOCOL_KEY]: '1' } }),
  )
  assert.deepEqual(authRun.invoked, ['protocol', 'transport', 'auth'])
  assert.equal(authRun.handlerCalls, 0)
  assert.equal(authRun.outcome.code, 'unauthorized')
  assert.equal(authRun.outcome.status, 401)
  assert.equal(authRun.outcome.message, PUBLIC_ERRORS.unauthorized)

  // Pre-auth carries no session token: the auth stage passes through.
  const preAuthRun = await runWithSpy(
    assemblePipeline('pre-auth'),
    makeContext(routeFor('POST', '/api/auth/local'), { headers: { [PROTOCOL_KEY]: '1' } }),
  )
  assert.deepEqual(preAuthRun.invoked, ['protocol', 'transport', 'auth', 'budgets', 'authz'])
  assert.equal(preAuthRun.handlerCalls, 1)

  // Health is unauthenticated and protocol-exempt.
  const healthRun = await runWithSpy(
    assemblePipeline('health'),
    makeContext(routeFor('GET', '/health')),
  )
  assert.deepEqual(healthRun.invoked, ['transport', 'auth', 'budgets', 'authz'])
  assert.equal(healthRun.handlerCalls, 1)
})

test('rejecting sentinels in budgets and authz keep the invariant and fall back to table statuses', async () => {
  // A sentinel rejection without a status must fall back to the declared
  // table status for its code — never an undefined status on the wire.
  const rejectingStage = name => ({
    name,
    process: () => ({ ok: false, code: 'unauthorized', message: 'stop' }),
  })
  for (const stageName of ['budgets', 'authz']) {
    const stages = [
      new ProtocolStage(),
      new TransportStage(),
      new AuthStage({ sessionVerifier: passingVerifier }),
      stageName === 'budgets' ? rejectingStage('budgets') : new BudgetStage(),
      stageName === 'authz' ? rejectingStage('authz') : new AuthzStage(),
    ]
    const context = makeContext(routeFor('GET', '/api/status'), { headers: { [PROTOCOL_KEY]: '1' } })
    const { invoked, handlerCalls, outcome } = await runWithSpy(stages, context)
    const cutoff = invoked.indexOf(stageName)
    assert.deepEqual(invoked, ['protocol', 'transport', 'auth', 'budgets', 'authz'].slice(0, cutoff + 1))
    assert.equal(handlerCalls, 0)
    assert.equal(outcome.ok, false)
    assert.equal(outcome.status, PUBLIC_ERROR_STATUS.unauthorized)
  }
})

test('a reordered or duplicated construction fails the order assertion', async () => {
  const reordered = [
    new TransportStage(),
    new ProtocolStage(),
    new AuthStage(),
    new BudgetStage(),
    new AuthzStage(),
  ]
  assert.throws(() => assertStageOrder(reordered), /out of order/)
  await assert.rejects(
    () => runPipeline(reordered, makeContext(routeFor('GET', '/health')), () => ({})),
    /out of order/,
  )

  const duplicated = [
    new ProtocolStage(),
    new ProtocolStage(),
    new TransportStage(),
    new AuthStage(),
    new BudgetStage(),
    new AuthzStage(),
  ]
  assert.throws(() => assertStageOrder(duplicated), /out of order/)
  assert.throws(
    () => assertStageOrder([{ name: 'nope', process: () => undefined }]),
    /unknown pipeline stage/,
  )
})

test('unknown request fields are rejected, not ignored, before the handler', async () => {
  // Query fields on GET.
  const queryRun = await runWithSpy(
    assemblePipeline('actor', { sessionVerifier: passingVerifier }),
    makeContext(routeFor('GET', '/api/presence'), {
      headers: { [PROTOCOL_KEY]: '1' },
      query: { include_offline: 'true', bogus: '1' },
    }),
  )
  assert.equal(queryRun.outcome.code, 'unknown_field')
  assert.equal(queryRun.outcome.status, 400)
  assert.match(queryRun.outcome.message, /"bogus"/)
  assert.equal(queryRun.handlerCalls, 0)

  // Body fields on POST.
  const bodyRun = await runWithSpy(
    assemblePipeline('actor', { sessionVerifier: passingVerifier }),
    makeContext(routeFor('POST', '/api/rooms/:id/messages'), {
      headers: { [PROTOCOL_KEY]: '1' },
      bodyStream: Readable.from(['{"text":"hi","evil":true}']),
    }),
  )
  assert.equal(bodyRun.outcome.code, 'unknown_field')
  assert.match(bodyRun.outcome.message, /"evil"/)
  assert.equal(bodyRun.handlerCalls, 0)

  // A conforming body is parsed into context.body for the handler.
  let seen
  const goodRun = await runWithSpy(
    assemblePipeline('actor', { sessionVerifier: passingVerifier }),
    makeContext(routeFor('POST', '/api/rooms/:id/messages'), {
      headers: { [PROTOCOL_KEY]: '1' },
      bodyStream: Readable.from(['{"chat_id":"alice","client_message_id":"m-1","text":"hello"}']),
    }),
    context => { seen = context.body },
  )
  assert.equal(goodRun.handlerCalls, 1)
  assert.deepEqual(seen, { chat_id: 'alice', client_message_id: 'm-1', text: 'hello' })

  // Oversized frames are refused before parsing, declared or streamed.
  const oversizedRoute = routeFor('POST', '/api/rooms/:id/messages')
  const declared = await runWithSpy(
    assemblePipeline('actor', { sessionVerifier: passingVerifier }),
    makeContext(oversizedRoute, {
      headers: { [PROTOCOL_KEY]: '1', 'content-length': String(FRAME_MAX_BYTES + 1) },
      bodyStream: Readable.from(['{}']),
    }),
  )
  assert.equal(declared.outcome.code, 'request_too_large')
  const streamed = await runWithSpy(
    assemblePipeline('actor', { sessionVerifier: passingVerifier }),
    makeContext(oversizedRoute, {
      headers: { [PROTOCOL_KEY]: '1' },
      bodyStream: Readable.from([Buffer.alloc(FRAME_MAX_BYTES + 1, 0x61)]),
    }),
  )
  assert.equal(streamed.outcome.code, 'request_too_large')
  assert.equal(streamed.handlerCalls, 0)

  // Malformed JSON and non-object bodies are coded rejections.
  for (const body of ['{"text": ', '[1,2]']) {
    const run = await runWithSpy(
      assemblePipeline('actor', { sessionVerifier: passingVerifier }),
      makeContext(oversizedRoute, {
        headers: { [PROTOCOL_KEY]: '1' },
        bodyStream: Readable.from([body]),
      }),
    )
    assert.equal(run.outcome.code, 'invalid_request', body)
    assert.equal(run.handlerCalls, 0)
  }

  // Health is strict about query fields too.
  const healthStrict = await runWithSpy(
    assemblePipeline('health'),
    makeContext(routeFor('GET', '/health'), { query: { x: '1' } }),
  )
  assert.equal(healthStrict.outcome.code, 'unknown_field')
})

test('GET/DELETE bodies and duplicate query keys are malformed requests', async () => {
  // A declared non-empty body on GET.
  const getBody = await runWithSpy(
    assemblePipeline('health'),
    makeContext(routeFor('GET', '/health'), { headers: { 'content-length': '5' } }),
  )
  assert.equal(getBody.outcome.code, 'invalid_request')
  assert.equal(getBody.handlerCalls, 0)

  // A declared non-empty body on DELETE.
  const deleteBody = await runWithSpy(
    assemblePipeline('actor', { sessionVerifier: passingVerifier }),
    makeContext(routeFor('DELETE', '/api/session'), {
      headers: { [PROTOCOL_KEY]: '1', 'content-length': '2' },
    }),
  )
  assert.equal(deleteBody.outcome.code, 'invalid_request')

  // Duplicate query keys never collapse to last-key-wins.
  const duplicates = await runWithSpy(
    assemblePipeline('actor', { sessionVerifier: passingVerifier }),
    makeContext(routeFor('GET', '/api/presence'), {
      headers: { [PROTOCOL_KEY]: '1' },
      query: { include_offline: 'true' },
      queryKeys: ['include_offline', 'include_offline'],
    }),
  )
  assert.equal(duplicates.outcome.code, 'invalid_request')
  assert.equal(duplicates.outcome.status, 400)

  // A client abort mid-body is a cancelled request, never a server fault.
  const doomed = new Readable({ read() { this.destroy(new Error('client gone')) } })
  const cancelled = await runWithSpy(
    assemblePipeline('actor', { sessionVerifier: passingVerifier }),
    makeContext(routeFor('POST', '/api/rooms/:id/messages'), {
      headers: { [PROTOCOL_KEY]: '1' },
      bodyStream: doomed,
    }),
  )
  assert.equal(cancelled.outcome.code, 'request_cancelled')
  assert.equal(cancelled.outcome.status, PUBLIC_ERROR_STATUS.request_cancelled)
})

test('verifier slots never cross: viewer credentials cannot authenticate actor routes', async () => {
  // A malformed verifier outcome becomes a coded unauthorized rejection —
  // never a crash and never a bogus session.
  for (const malformed of ['yes', 42, true, ['array'], { ok: false }, { ok: false, code: 'not_a_code' }]) {
    const stages = assemblePipeline('actor', { sessionVerifier: () => malformed })
    const context = makeContext(routeFor('GET', '/api/status'), { headers: { [PROTOCOL_KEY]: '1' } })
    const outcome = await runPipeline(stages, context, () => ({}))
    assert.equal(outcome.ok, false, JSON.stringify(malformed))
    assert.equal(outcome.code, 'unauthorized', JSON.stringify(malformed))
    assert.equal(outcome.status, 401)
    assert.equal(outcome.message, PUBLIC_ERRORS.unauthorized)
    assert.equal(context.session, undefined)
  }

  // A registered rejection code keeps its own status; a missing status falls
  // back to the table.
  const stages = assemblePipeline('actor', {
    sessionVerifier: () => ({ ok: false, code: 'invalid_chat_id' }),
  })
  const outcome = await runPipeline(stages, makeContext(routeFor('GET', '/api/status')), () => ({}))
  assert.equal(outcome.status, PUBLIC_ERROR_STATUS.invalid_chat_id)
})

// --- Live server rows (real child processes) ----------------------------------

test('GET /health answers unauthenticated and side-effect-free', async t => {
  const dataDir = makeDataDir(t)
  const { child, waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  assert.equal(record.version, APP_VERSION)
  assert.equal(record.pid, child.pid)

  const before = hashStore(dataDir)
  const response = await request(record.port, 'GET', '/health')
  assert.equal(response.status, 200)
  const payload = response.json()
  assert.equal(payload.ok, true)
  assert.equal(payload.result.version, APP_VERSION)
  assert.equal(response.headers[PROTOCOL_KEY], undefined)
  assert.equal(hashStore(dataDir), before)
  await stop(0)
})

test('the protocol gate covers any /api/* request and echoes the supported version', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const before = hashStore(dataDir)

  const missing = await request(record.port, 'GET', '/api/status')
  assert.equal(missing.status, 400)
  const missingPayload = missing.json()
  assert.equal(missingPayload.ok, false)
  assert.equal(missingPayload.error.code, 'protocol_required')
  assert.equal(missing.headers[PROTOCOL_KEY], '1')

  for (const value of ['2', '0', '1x', 'v1']) {
    const response = await request(record.port, 'GET', '/api/status', {
      headers: { [PROTOCOL_KEY]: value },
    })
    assert.equal(response.status, 400, value)
    const payload = response.json()
    assert.equal(payload.ok, false, value)
    assert.equal(payload.error.code, 'invalid_protocol', value)
    assert.match(payload.error.message, /supported versions: 1/, value)
    assert.equal(response.headers[PROTOCOL_KEY], '1', value)
  }

  assert.equal(hashStore(dataDir), before)
  await stop(0)
})

test('valid versions are echoed and the default verifier rejects actor requests', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const before = hashStore(dataDir)

  const response = await request(record.port, 'GET', '/api/status', {
    headers: { [PROTOCOL_KEY]: '1' },
  })
  assert.equal(response.status, 401)
  const payload = response.json()
  assert.equal(payload.ok, false)
  assert.equal(payload.error.code, 'unauthorized')
  assert.equal(payload.error.message, PUBLIC_ERRORS.unauthorized)
  assert.equal(response.headers[PROTOCOL_KEY], '1')

  assert.equal(hashStore(dataDir), before)
  await stop(0)
})

test('unregistered routes 404 behind the gates; unknown paths 404; echoes follow the /api prefix', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const before = hashStore(dataDir)

  // Pre-auth route with a valid header: gates pass and the Story 1.4 local
  // credential handler is registered — with no Bearer credential it answers
  // the canonical unauthorized (Story 1.3's unregistered 404 became live).
  const fallthrough = await request(record.port, 'POST', '/api/auth/local', {
    headers: { [PROTOCOL_KEY]: '1' },
  })
  assert.equal(fallthrough.status, 401)
  assert.equal(fallthrough.json().error.code, 'unauthorized')
  assert.equal(fallthrough.headers[PROTOCOL_KEY], '1')

  // The other pre-auth routes stay unregistered until their stories: they
  // answer 404 route_not_found behind the gates.
  for (const path of ['/api/auth/enroll', '/api/auth/challenge', '/api/auth/answer']) {
    const unregistered = await request(record.port, 'POST', path, {
      headers: { [PROTOCOL_KEY]: '1' },
    })
    assert.equal(unregistered.status, 404, path)
    assert.equal(unregistered.json().error.code, 'route_not_found', path)
    assert.equal(unregistered.headers[PROTOCOL_KEY], '1', path)
  }

  // An unknown field on that route is rejected before the handler position.
  const unknownField = await request(record.port, 'POST', '/api/auth/local', {
    headers: { [PROTOCOL_KEY]: '1' },
    body: '{"bogus":1}',
  })
  assert.equal(unknownField.status, 400)
  const unknownFieldPayload = unknownField.json()
  assert.equal(unknownFieldPayload.error.code, 'unknown_field')
  assert.match(unknownFieldPayload.error.message, /"bogus"/)
  assert.equal(unknownField.headers[PROTOCOL_KEY], '1')

  // An unmatched /api/* path with a valid header falls through to 404 —
  // after the gate, and still echoing the supported version.
  const unknownApiPath = await request(record.port, 'GET', '/api/nope', {
    headers: { [PROTOCOL_KEY]: '1' },
  })
  assert.equal(unknownApiPath.status, 404)
  assert.equal(unknownApiPath.json().error.code, 'route_not_found')
  assert.equal(unknownApiPath.headers[PROTOCOL_KEY], '1')

  // An unmatched /api/* path without the header is gated first.
  const ungated = await request(record.port, 'GET', '/api/nope')
  assert.equal(ungated.status, 400)
  assert.equal(ungated.json().error.code, 'protocol_required')

  // Non-/api unknown paths 404 without any gate or echo.
  const unknownPath = await request(record.port, 'GET', '/nope')
  assert.equal(unknownPath.status, 404)
  assert.equal(unknownPath.json().error.code, 'route_not_found')
  assert.equal(unknownPath.headers[PROTOCOL_KEY], undefined)

  assert.equal(hashStore(dataDir), before)
  await stop(0)
})

test('first boot mints the realm and the implicit Broadcast Room with no fabricated creator', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()

  assert.equal(statSync(dataDir).mode & 0o777, 0o700)
  assert.equal(statSync(join(dataDir, RUNTIME_RECORD_FILENAME)).mode & 0o777, 0o600)
  assert.deepEqual(Object.keys(record).sort(), ['pid', 'port', 'version'])

  const { realm, broadcastRooms } = inspectRealm(dataDir)
  assert.ok(realm, 'a realm row must exist after first boot')
  assert.match(realm.realm_id, UUID_V4_PATTERN)
  assert.equal(broadcastRooms.length, 1)
  assert.equal(broadcastRooms[0].title, 'Broadcast Room')
  // The implicit Broadcast Room predates any Actor: its creator is NULL, and
  // no fingerprint-shaped fabricated identity exists anywhere.
  assert.equal(broadcastRooms[0].created_by_fingerprint, null)

  const health = await request(record.port, 'GET', '/health')
  assert.equal(health.status, 200)

  await stop(0)
  assert.equal(existsSync(join(dataDir, RUNTIME_RECORD_FILENAME)), false, 'stop removes the owned runtime record')
})

test('restart on the same data dir keeps the realm id and exactly one Broadcast Room', async t => {
  const dataDir = makeDataDir(t)

  const first = spawnServerChild(t, dataDir)
  await first.waitReady()
  const firstRealm = inspectRealm(dataDir)
  assert.match(firstRealm.realm.realm_id, UUID_V4_PATTERN)
  assert.equal(firstRealm.broadcastRooms.length, 1)
  await first.stop(0)

  const second = spawnServerChild(t, dataDir)
  const secondRecord = await second.waitReady()
  assert.notEqual(secondRecord.pid, first.child.pid)
  const secondRealm = inspectRealm(dataDir)
  assert.equal(secondRealm.realm.realm_id, firstRealm.realm.realm_id)
  assert.equal(secondRealm.broadcastRooms.length, 1)
  assert.equal(secondRealm.broadcastRooms[0].id, firstRealm.broadcastRooms[0].id)
  await second.stop(0)
})

test('direct launch gates startup failures to one stderr line and exit code 1', async t => {
  const dataDir = makeDataDir(t)
  writeFileSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME), 'this is not a database\n', 'utf8')

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, AGENT_ROOM_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stderrChunks = []
  child.stderr.on('data', chunk => stderrChunks.push(chunk))
  const [code] = await once(child, 'exit')

  assert.equal(code, 1)
  const stderr = Buffer.concat(stderrChunks).toString('utf8')
  const lines = stderr.split('\n').filter(line => line.length > 0)
  assert.equal(lines.length, 1, `expected exactly one stderr line, got: ${stderr}`)
  assert.match(lines[0], /^agent-room-server: \S+: .+/)
  assert.equal(stderr.includes('    at '), false, 'no stack trace on direct launch')
  assert.equal(existsSync(join(dataDir, RUNTIME_RECORD_FILENAME)), false)
})

test('a post-listen startup failure closes the listener and releases the port', async t => {
  const dataDir = makeDataDir(t)
  // Obstruct the runtime record: the write happens only after listen().
  mkdirSync(join(dataDir, RUNTIME_RECORD_FILENAME))
  const port = await freePort()

  await assert.rejects(() => startServer({ dataDir, port }))

  // The port must already be released: a fresh listener can bind it.
  const probe = net.createServer()
  await new Promise((resolvePromise, rejectPromise) => {
    probe.once('error', rejectPromise)
    probe.listen(port, '127.0.0.1', () => resolvePromise())
  })
  await new Promise(resolvePromise => probe.close(resolvePromise))

  // With the obstruction removed, startup succeeds on the very same port.
  rmdirSync(join(dataDir, RUNTIME_RECORD_FILENAME))
  const server = await startServer({ dataDir, port })
  assert.equal(server.port, port)
  const health = await request(port, 'GET', '/health')
  assert.equal(health.status, 200)
  await server.close()
})

// --- In-process host rows (verifier slots, fallbacks, handler registry) --------

test('viewer routes run the viewer verifier slot, never the session slot, and never echo', async t => {
  const dataDir = makeDataDir(t)
  const viewerCalls = []
  const sessionCalls = []
  const server = await startServer({
    dataDir,
    viewerVerifier: () => {
      viewerCalls.push(1)
      return reject('unauthorized')
    },
    sessionVerifier: () => {
      sessionCalls.push(1)
      return undefined
    },
  })
  try {
    const response = await request(server.port, 'GET', '/viewer/auth')
    assert.equal(response.status, 401)
    assert.equal(response.json().error.code, 'unauthorized')
    assert.equal(viewerCalls.length, 1)
    assert.equal(sessionCalls.length, 0)
    assert.equal(response.headers[PROTOCOL_KEY], undefined)
  } finally {
    await server.close()
  }
})

test('default verifiers reject actor and viewer requests with the canonical message', async t => {
  const dataDir = makeDataDir(t)
  const server = await startServer({ dataDir })
  try {
    const viewer = await request(server.port, 'GET', '/viewer/auth')
    assert.equal(viewer.status, 401)
    assert.equal(viewer.json().error.message, PUBLIC_ERRORS.unauthorized)
    assert.equal(viewer.headers[PROTOCOL_KEY], undefined)

    const actor = await request(server.port, 'GET', '/api/status', {
      headers: { [PROTOCOL_KEY]: '1' },
    })
    assert.equal(actor.status, 401)
    assert.equal(actor.json().error.code, 'unauthorized')
    assert.equal(actor.json().error.message, PUBLIC_ERRORS.unauthorized)
    assert.equal(actor.headers[PROTOCOL_KEY], '1')

    const health = await request(server.port, 'GET', '/health')
    assert.equal(health.status, 200)
  } finally {
    await server.close()
  }
})

test('malformed verifier wiring fails at startup, never per-request', async t => {
  const dataDir = makeDataDir(t)
  await assert.rejects(() => startServer({ dataDir, sessionVerifier: null }), /sessionVerifier must be a function/)
  await assert.rejects(() => startServer({ dataDir, sessionVerifier: 'nope' }), /sessionVerifier must be a function/)
  await assert.rejects(() => startServer({ dataDir, viewerVerifier: null }), /viewerVerifier must be a function/)
  await assert.rejects(() => startServer({ dataDir, viewerVerifier: 7 }), /viewerVerifier must be a function/)
})

test('handler crashes answer request_failed (500) with one redacted stderr line', async t => {
  const dataDir = makeDataDir(t)
  // The implemented-flag contract requires the override to stay registered,
  // so the crash handler takes over the (marked) health route.
  const remove = registerHandler('GET /health', () => {
    throw new Error('boom: password=hunter2 token=abc123')
  })
  const server = await startServer({ dataDir })
  try {
    const { result: outcome, chunks } = await captureStderr(() => request(server.port, 'GET', '/health'))
    assert.equal(outcome.status, 500)
    const payload = outcome.json()
    assert.equal(payload.error.code, 'request_failed')
    // The wire keeps the canonical message; internal detail and secrets never.
    assert.equal(payload.error.message, PUBLIC_ERRORS.request_failed)
    assert.equal(outcome.text.includes('hunter2'), false)
    assert.equal(outcome.text.includes('abc123'), false)
    // One diagnosable stderr line, itself redacted of credential-shaped values.
    const stderr = chunks.join('')
    const lines = stderr.split('\n').filter(line => line.includes('agent-room-server:'))
    assert.equal(lines.length, 1, `expected one fallback stderr line, got: ${stderr}`)
    assert.match(lines[0], /agent-room-server: Error: boom: password=\[redacted\] token=\[redacted\]/)
    assert.equal(stderr.includes('hunter2'), false)
    assert.equal(stderr.includes('abc123'), false)
  } finally {
    remove()
    await server.close()
  }
})

test('registerHandler validates keys against the frozen route table', async t => {
  assert.throws(() => registerHandler('GET /healt', () => ({})), /frozen route table/)
  assert.throws(() => registerHandler('PATCH /health', () => ({})), /frozen route table/)
  assert.throws(() => registerHandler('GET /health', 'not-a-function'), /must be a function/)
  assert.throws(() => registerHandler('GET /health', () => ({}), 'actor'), /class "health"/)

  // Register, prove it serves, then restore the default health handler.
  const remove = registerHandler('GET /health', () => ({ served: true }), 'health')
  const dataDir = makeDataDir(t)
  const server = await startServer({ dataDir })
  try {
    const response = await request(server.port, 'GET', '/health')
    assert.equal(response.status, 200)
    assert.equal(response.json().result.served, true)
  } finally {
    await server.close()
    remove()
    registerHandler('GET /health', function health() {
      return { version: APP_VERSION }
    }, 'health')
  }
})

test('startServer refuses non-loopback hosts and malformed options', async t => {
  const dataDir = makeDataDir(t)
  await assert.rejects(() => startServer({ dataDir, host: '0.0.0.0' }), /binds loopback only/)
  await assert.rejects(() => startServer({ dataDir, host: 'localhost' }), /binds loopback only/)
  await assert.rejects(() => startServer({}), /dataDir must be a non-empty path/)
  await assert.rejects(() => startServer({ dataDir, port: -1 }), /port must be an integer/)
  await assert.rejects(() => startServer({ dataDir, port: 70000 }), /port must be an integer/)
})

// --- Realm bootstrap rows ------------------------------------------------------

test('realm primitives mint, re-read, converge on double-mint, and recover partial boots', t => {
  const dataDir = makeDataDir(t)
  const store = openRoomLog({ dataDir })
  t.after(() => store.close())

  // Fresh store: no realm, no Broadcast Room.
  assert.equal(store.getRealmId(), null)
  assert.equal(store.findBroadcastRoom(), null)

  // Mint + re-read.
  const realmId = randomUUID()
  assert.equal(store.insertRealm(realmId), realmId)
  assert.equal(store.getRealmId(), realmId)

  // Double-mint convergence: a racing minter re-reads the winner's id.
  assert.equal(store.insertRealm(randomUUID()), realmId)
  assert.equal(store.getRealmId(), realmId)

  // Malformed ids are coded rejections.
  assert.throws(() => store.insertRealm('not-a-uuid'), /UUID/)

  // Broadcast ensure is idempotent and creator-less.
  const broadcast = store.ensureBroadcastRoom()
  assert.equal(broadcast.created_by_fingerprint, null)
  assert.equal(store.ensureBroadcastRoom().id, broadcast.id)
  assert.equal(store.findBroadcastRoom().id, broadcast.id)

  // Double bootstrap converges: same realm, exactly one Broadcast Room.
  const first = bootstrapRealm(store)
  const second = bootstrapRealm(store)
  assert.equal(first.realmId, realmId)
  assert.equal(second.realmId, realmId)
  assert.equal(second.broadcastRoom.id, first.broadcastRoom.id)

  // Partial-bootstrap recovery: realm present, Broadcast Room missing.
  const raw = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME))
  t.after(() => raw.close())
  raw.prepare('DELETE FROM rooms WHERE kind = \'broadcast\'').run()
  assert.equal(store.findBroadcastRoom(), null)
  const recovered = bootstrapRealm(store)
  assert.equal(recovered.realmId, realmId)
  assert.equal(recovered.broadcastRoom.created_by_fingerprint, null)
  assert.equal(store.findBroadcastRoom().id, recovered.broadcastRoom.id)
  assert.equal(store.getRealmId(), realmId)
})

test('a pre-1.3 v2 store (no realms table, NOT NULL creator) converges on open and bootstraps', t => {
  const dataDir = makeDataDir(t)
  const databasePath = join(dataDir, ROOM_LOG_DATABASE_FILENAME)

  // Build the database exactly as story 1.2 created it: rooms with a NOT NULL
  // creator, direct_members, messages — and no realms table.
  const fingerprint = `sha256:${createHash('sha256').update('legacy-alice').digest('hex')}`
  const raw = new DatabaseSync(databasePath)
  raw.exec(`
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT,
      pair_key TEXT UNIQUE,
      created_by_fingerprint TEXT NOT NULL,
      created_at TEXT NOT NULL,
      CHECK (kind IN ('broadcast', 'direct')),
      CHECK ((kind = 'direct') = (pair_key IS NOT NULL)),
      CHECK (kind = 'direct' OR title IS NOT NULL),
      CHECK (kind = 'direct' OR length(title) BETWEEN 1 AND 120),
      CHECK (length(id) BETWEEN 1 AND 128),
      CHECK (length(created_by_fingerprint) = 71
             AND substr(created_by_fingerprint, 1, 7) = 'sha256:'
             AND substr(created_by_fingerprint, 8) NOT GLOB '*[^0-9a-f]*')
    ) STRICT;
    CREATE TABLE direct_members (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
      actor_fingerprint TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (room_id, actor_fingerprint)
    ) STRICT;
    CREATE TABLE messages (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
      seq INTEGER NOT NULL,
      actor_fingerprint TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      client_message_id TEXT NOT NULL,
      text TEXT NOT NULL,
      reply_to_seq INTEGER,
      created_at TEXT NOT NULL,
      PRIMARY KEY (room_id, seq),
      UNIQUE (room_id, actor_fingerprint, client_message_id),
      FOREIGN KEY (room_id, reply_to_seq)
        REFERENCES messages(room_id, seq) ON DELETE RESTRICT,
      CHECK (seq >= 1),
      CHECK (reply_to_seq IS NULL OR reply_to_seq >= 1)
    ) STRICT;
    PRAGMA user_version = 2;
  `)
  raw.prepare(`
    INSERT INTO rooms (id, kind, title, pair_key, created_by_fingerprint, created_at)
    VALUES ('legacy-room', 'broadcast', 'Legacy', NULL, ?, '2026-09-24T00:00:00.000Z')
  `).run(fingerprint)
  raw.prepare(`
    INSERT INTO messages (room_id, seq, actor_fingerprint, chat_id, client_message_id, text, reply_to_seq, created_at)
    VALUES ('legacy-room', 1, ?, 'alice', 'legacy-1', 'legacy text', NULL, '2026-09-24T00:00:01.000Z')
  `).run(fingerprint)
  raw.close()

  // Open with the current store: realms added, creator column nullable,
  // legacy data intact, bootstrap completes.
  const store = openRoomLog({ dataDir })
  t.after(() => store.close())

  const inspector = new DatabaseSync(databasePath)
  t.after(() => inspector.close())
  const tableNames = inspector.prepare(`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name
  `).all().map(row => row.name)
  // Story 1.5: chat_id_claims joins additively beside the 1.3 realms table.
  assert.deepEqual(tableNames, ['chat_id_claims', 'direct_members', 'messages', 'realms', 'rooms'])
  const creatorColumn = inspector
    .prepare(`SELECT "notnull" AS "notnull" FROM pragma_table_info('rooms') WHERE name = 'created_by_fingerprint'`)
    .get()
  assert.equal(Number(creatorColumn.notnull), 0)
  const legacy = inspector.prepare('SELECT COUNT(*) AS count FROM messages').get()
  assert.equal(Number(legacy.count), 1)

  const { realmId, broadcastRoom } = bootstrapRealm(store)
  assert.match(realmId, UUID_V4_PATTERN)
  assert.equal(broadcastRoom.id, 'legacy-room')
  assert.equal(store.findBroadcastRoom().id, 'legacy-room')
  assert.equal(inspectRealm(dataDir).broadcastRooms.length, 1)
})

// Kept last: it temporarily unregisters the module's live auth/local handler
// and restores it with a behavior-compatible stand-in.
test('startup enforces the implemented-flag contract in both directions', async t => {
  const dataDir = makeDataDir(t)

  // A registered handler on a route without the implemented mark fails
  // startup — a live handler the wire contract does not promise. (GET
  // /api/status went live in Story 1.6, so the probe uses the still
  // unregistered GET /api/rooms.)
  const removeRooms = registerHandler('GET /api/rooms', () => ({}))
  try {
    await assert.rejects(
      () => startServer({ dataDir }),
      error => error?.code === 'invalid_argument' && /not marked implemented/.test(error.message),
    )
  } finally {
    removeRooms()
  }

  // A marked route without a registered handler fails startup the other way.
  // Re-registering with a stand-in and dropping it unregisters the module's
  // live handler (the remover only removes its own registration).
  const removeLocal = registerHandler('POST /api/auth/local', () => ({}), 'pre-auth')
  removeLocal()
  try {
    await assert.rejects(
      () => startServer({ dataDir }),
      error => error?.code === 'invalid_argument' && /marked implemented but has no registered handler/.test(error.message),
    )
  } finally {
    // Restore a behavior-compatible local credential handler: identical to
    // the original for unauthenticated requests (the canonical unauthorized).
    registerHandler('POST /api/auth/local', () => reject('unauthorized'), 'pre-auth')
  }

  // With the contract satisfied again, startup succeeds.
  const server = await startServer({ dataDir })
  try {
    const health = await request(server.port, 'GET', '/health')
    assert.equal(health.status, 200)
  } finally {
    await server.close()
  }
})
