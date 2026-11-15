// Story 1.1 acceptance: bounded write queue, SQLite savepoint batching, async
// SQLITE_BUSY backoff, transaction fencing, status telemetry, graceful drain,
// and pre-auth-only enrollment pacing.
//
// Matrix row -> test map:
//   role pragmas        openRoomLog server (50 ms) vs cli (5000 ms) + invalid role
//   HAPPY_BURST         1,000 concurrent sends via both send routes, 0 HTTP 429s
//   MIXED_BATCH         64 queued ops w/ 1 invalid reply_to_seq; 63 sibling saves
//   PER_SESSION_CAP     > 16 queued for 1 session -> 503 queue_full; sibling session OK
//   GLOBAL_CAP          2,048 ops cap + WRITE_QUEUE_MAX_BYTES cap -> queue_full
//   HB_COALESCE         10 queued heartbeats collapse to 1 write; all callers settle
//   BUSY_RECOVER        300 ms external SQLite lock -> async retry recovers, /health fast
//   BUSY_EXHAUSTED      > 1,500 ms lock -> 503 queue_full + Retry-After, /health responsive
//   TX_FENCE            in-batch ban (403), superseded Bearer (401), revoked session (401)
//   PREAUTH_ENROLL      AGENT_ROOM_TRUSTED_PROXY=true + X-Forwarded-For -> 6th 429 + Retry-After
//   STATUS_METRICS      GET /api/status (Bearer & Session) 8 metrics; /health omits write_queue
//   SHUTDOWN_DRAIN      close() drains queued writes within budget; late enqueue rejects 503

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, randomUUID, sign as cryptoSign } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PassThrough } from 'node:stream'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  ENROLLMENT_PER_MINUTE,
  ENROLLMENT_WINDOW_MS,
  MESSAGE_TEXT_MAX,
  PUBLIC_ERROR_STATUS,
  WRITE_QUEUE_BATCH_MAX,
  WRITE_QUEUE_BUSY_BUDGET_MS,
  WRITE_QUEUE_BUSY_TIMEOUT_MS,
  WRITE_QUEUE_DRAIN_MS,
  WRITE_QUEUE_MAX_BYTES,
  WRITE_QUEUE_MAX_OPS,
  WRITE_QUEUE_PER_SESSION_MAX,
} from '../server/constants.mjs'
import { main } from '../server/cli/agent-room.mjs'
import { createEnrollRateLimiter } from '../server/api/enroll-rate-limit.mjs'
import { loadOrCreateLocalToken } from '../server/api/local-token.mjs'
import { gateLimitsFromEnv, startServer, trustedProxyFromEnv } from '../server/api/server.mjs'
import { createAgentRoomClient } from '../server/client/api-client.mjs'
import { createSessionRegistry } from '../server/identity/sessions.mjs'
import { fingerprintFromPublicKey, loadOrCreateKeypair } from '../server/keys.mjs'
import { atomicWriteJson } from '../server/runtime.mjs'
import { openRoomLog, ROOM_LOG_DATABASE_FILENAME } from '../server/store/room-log.mjs'
import { createWriteQueue, isDatabaseBusyError } from '../server/store/write-queue.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = join(ROOT, 'server', 'api', 'server.mjs')
const RUNTIME_RECORD_FILENAME = 'runtime.json'
const PROTOCOL_KEY = 'agent-room-protocol'
const STATUS_METRIC_KEYS = [
  'batches_total',
  'busy_retries_total',
  'bytes',
  'coalesced_total',
  'committed_total',
  'depth',
  'max_depth',
  'rejected_total',
]

const sleep = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })

function makeDataDir(t, prefix = 'agent-room-wq-') {
  const dataDir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  return dataDir
}

function installation() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const raw = spki.subarray(spki.length - 32)
  return {
    publicKey: raw.toString('base64url'),
    fingerprint: fingerprintFromPublicKey(raw),
    signToken: token => cryptoSign(null, Buffer.from(token, 'utf8'), privateKey).toString('base64url'),
  }
}

function request(port, method, path, { headers = {}, body, agent = false } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers, agent },
      response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('error', rejectPromise)
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed = null
          try { parsed = text.length > 0 ? JSON.parse(text) : null } catch { parsed = null }
          resolvePromise({
            status: response.statusCode,
            headers: response.headers,
            text,
            json: () => {
              if (parsed === null) throw new Error(`Expected JSON response, got: ${text}`)
              return parsed
            },
          })
        })
      },
    )
    req.on('error', rejectPromise)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

function jsonHeaders(extra = {}) {
  return {
    [PROTOCOL_KEY]: '1',
    'content-type': 'application/json; charset=utf-8',
    ...extra,
  }
}

function bearerHeaders(token, extra = {}) {
  return jsonHeaders({ authorization: `Bearer ${token}`, ...extra })
}

function sessionHeaders(capability, extra = {}) {
  return jsonHeaders({ authorization: `Session ${capability}`, ...extra })
}

async function startTestServer(t, dataDir, options = {}) {
  const server = await startServer({
    dataDir,
    port: 0,
    host: '127.0.0.1',
    enrollRateLimiter: options.enrollRateLimiter ?? createEnrollRateLimiter({ limit: 1000 }),
    ...options,
  })
  t.after(async () => { await server.close() })
  return server
}

async function authLocal(port, dataDir, installer) {
  const localToken = loadOrCreateLocalToken(dataDir)
  const response = await request(port, 'POST', '/api/auth/local', {
    headers: bearerHeaders(localToken),
    body: JSON.stringify({ public_key: installer.publicKey }),
  })
  assert.equal(response.status, 200, response.text)
  const payload = response.json()
  assert.equal(payload.ok, true)
  return payload.result.session_token
}

async function bindChatId(port, sessionToken, chatId, clientType = 'cli') {
  const response = await request(port, 'POST', '/api/session', {
    headers: bearerHeaders(sessionToken),
    body: JSON.stringify({ chat_id: chatId, client_type: clientType }),
  })
  assert.equal(response.status, 200, response.text)
  return response.json().result
}

async function allocatePrincipal(port, sessionToken, baseChatId, clientType = 'cli', machine = 'workstation') {
  const response = await request(port, 'POST', '/api/session-principals', {
    headers: bearerHeaders(sessionToken),
    body: JSON.stringify({ base_chat_id: baseChatId, client_type: clientType, machine }),
  })
  assert.equal(response.status, 200, response.text)
  return response.json().result
}

async function fetchStatus(port, headers) {
  const response = await request(port, 'GET', '/api/status', { headers })
  assert.equal(response.status, 200, response.text)
  return response.json().result
}

function openLockConnection(dataDir) {
  const db = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME))
  db.exec('PRAGMA busy_timeout = 5000;')
  return db
}

async function waitForCondition(predicate, { timeoutMs = 2000, stepMs = 10, description = 'condition' } = {}) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) {
      throw new Error(`Timed out after ${timeoutMs}ms waiting for ${description}`)
    }
    await sleep(stepMs)
  }
}

async function runCli(dataDir, argv) {
  const output = new PassThrough()
  const errorOutput = new PassThrough()
  output.setEncoding('utf8')
  errorOutput.setEncoding('utf8')
  let stdout = ''
  let stderr = ''
  output.on('data', chunk => { stdout += chunk })
  errorOutput.on('data', chunk => { stderr += chunk })
  const previousExitCode = process.exitCode
  process.exitCode = undefined
  try {
    await main(argv, {
      input: new PassThrough(),
      output,
      errorOutput,
      sharedDataDir: dataDir,
      pluginDataDir: join(dataDir, 'plugin-data-unused'),
    })
    await sleep(10)
    const exitCode = process.exitCode ?? 0
    return { exitCode, stdout, stderr }
  } finally {
    process.exitCode = previousExitCode
  }
}

function spawnServerChild(t, dataDir, extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, AGENT_ROOM_DATA_DIR: dataDir, ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stderrChunks = []
  child.stderr.on('data', chunk => stderrChunks.push(chunk))
  const stderrText = () => Buffer.concat(stderrChunks).toString('utf8')
  const runtimePath = join(dataDir, RUNTIME_RECORD_FILENAME)
  const waitReady = async () => {
    const deadline = Date.now() + 10_000
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`server child exited early (code=${child.exitCode}); stderr: ${stderrText()}`)
      }
      if (existsSync(runtimePath)) {
        try {
          const record = JSON.parse(readFileSync(runtimePath, 'utf8'))
          if (Number.isInteger(record.port) && record.port > 0) return record
        } catch { /* retry atomic rename */ }
      }
      if (Date.now() > deadline) {
        throw new Error(`server child never became ready; stderr: ${stderrText()}`)
      }
      await sleep(25)
    }
  }
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      const exited = await Promise.race([
        new Promise(resolvePromise => child.once('exit', () => resolvePromise(true))),
        sleep(2500).then(() => false),
      ])
      if (!exited && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
      }
    }
  })
  return { child, waitReady, stderrText }
}

test('openRoomLog enforces server vs cli busy_timeout pragma by role and rejects invalid roles', t => {
  const cliDir = makeDataDir(t, 'agent-room-wq-cli-')
  const serverDir = makeDataDir(t, 'agent-room-wq-srv-')

  const cliStore = openRoomLog({ dataDir: cliDir })
  t.after(() => cliStore.close())
  assert.equal(cliStore.pragmas.busyTimeout, 5000)

  const serverStore = openRoomLog({ dataDir: serverDir, role: 'server' })
  t.after(() => serverStore.close())
  assert.equal(serverStore.pragmas.busyTimeout, WRITE_QUEUE_BUSY_TIMEOUT_MS)
  assert.equal(WRITE_QUEUE_BUSY_TIMEOUT_MS, 50)

  assert.throws(
    () => openRoomLog({ dataDir: cliDir, role: 'daemon' }),
    error => error?.code === 'invalid_argument',
  )
})

test('HAPPY_BURST: 1,000 concurrent sends across POST /api/messages and POST /api/rooms/:id/messages commit with 0 HTTP 429s', async t => {
  const dataDir = makeDataDir(t)
  const server = await startTestServer(t, dataDir)
  const agent = new http.Agent({ keepAlive: true, maxSockets: 128 })
  t.after(() => agent.destroy())

  const actorA = installation()
  const actorB = installation()
  const tokenA = await authLocal(server.port, dataDir, actorA)
  const tokenB = await authLocal(server.port, dataDir, actorB)

  await bindChatId(server.port, tokenA, 'burst-alice')
  await bindChatId(server.port, tokenB, 'burst-bob')

  const senderA = await allocatePrincipal(server.port, tokenA, 'burst-alice', 'cli', 'box-a')
  const senderB = await allocatePrincipal(server.port, tokenB, 'burst-bob', 'mcp', 'box-b')
  const peerA = await allocatePrincipal(server.port, tokenA, 'burst-alice-peer', 'cli', 'box-c')
  const peerB = await allocatePrincipal(server.port, tokenB, 'burst-bob-peer', 'mcp', 'box-d')

  const statusBefore = await fetchStatus(server.port, bearerHeaders(tokenA))
  const broadcastRoomId = statusBefore.broadcast_room_id
  const bodyChunk = 'b'.repeat(256)

  const requests = []
  for (let index = 0; index < 1000; index += 1) {
    if (index % 2 === 0) {
      const from = index % 4 === 0 ? senderA : senderB
      const to = index % 4 === 0 ? peerA.address : peerB.address
      requests.push(request(server.port, 'POST', '/api/messages', {
        agent,
        headers: sessionHeaders(from.session_capability),
        body: JSON.stringify({
          to,
          client_message_id: `pair-${index}-${randomUUID()}`,
          text: `${bodyChunk}-${index}`,
        }),
      }))
    } else {
      const useA = index % 4 === 1
      const senderToken = useA ? tokenA : tokenB
      const senderChatId = useA ? 'burst-alice' : 'burst-bob'
      requests.push(request(server.port, 'POST', `/api/rooms/${encodeURIComponent(broadcastRoomId)}/messages`, {
        agent,
        headers: bearerHeaders(senderToken),
        body: JSON.stringify({
          chat_id: senderChatId,
          client_message_id: `room-${index}-${randomUUID()}`,
          text: `${bodyChunk}-${index}`,
        }),
      }))
    }
  }

  const responses = await Promise.all(requests)
  const count429 = responses.filter(res => res.status === 429).length
  assert.equal(count429, 0, 'burst traffic must never receive HTTP 429')

  for (let index = 0; index < responses.length; index += 1) {
    const res = responses[index]
    assert.equal(res.status, 200, `send #${index} failed: ${res.status} ${res.text}`)
    const payload = res.json()
    assert.equal(payload.ok, true)
    assert.equal(payload.result.status, 'committed')
    assert.ok(Number.isSafeInteger(payload.result.seq) && payload.result.seq >= 1)
  }

  const statusAfter = await fetchStatus(server.port, bearerHeaders(tokenA))
  const metrics = statusAfter.write_queue
  assert.deepEqual(Object.keys(metrics).sort(), STATUS_METRIC_KEYS)
  assert.equal(metrics.depth, 0)
  assert.equal(metrics.bytes, 0)
  assert.equal(metrics.committed_total, 1000)
  assert.equal(metrics.rejected_total, 0)
  assert.ok(metrics.batches_total >= 1 && metrics.batches_total < 1000, `expected batched commits, got ${metrics.batches_total}`)
  assert.ok(metrics.max_depth > 1, `expected queue depth > 1 during burst, got ${metrics.max_depth}`)

  const inspector = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME), { readOnly: true })
  try {
    const countRow = inspector.prepare('SELECT COUNT(*) AS count FROM messages').get()
    assert.equal(Number(countRow.count), 1000)
  } finally {
    inspector.close()
  }
})

test('MIXED_BATCH: 64 queued ops with 1 bad reply_to_seq isolate the savepoint error while 63 sibling ops commit', async t => {
  const dataDir = makeDataDir(t)
  const server = await startTestServer(t, dataDir)
  const agent = new http.Agent({ keepAlive: true, maxSockets: 96 })
  t.after(() => agent.destroy())

  const actor = installation()
  const token = await authLocal(server.port, dataDir, actor)
  const peer = await allocatePrincipal(server.port, token, 'mixed-peer', 'cli', 'm-peer')

  // Allocate 5 sender sessions so all 64 concurrent sends fit under WRITE_QUEUE_PER_SESSION_MAX (16 each).
  const senders = []
  for (let s = 0; s < 5; s += 1) {
    senders.push(await allocatePrincipal(server.port, token, `mixed-s-${s}`, 'cli', `m-${s}`))
  }

  const lockDb = openLockConnection(dataDir)
  t.after(() => { try { lockDb.close() } catch { /* ignore */ } })
  lockDb.exec('BEGIN IMMEDIATE;')

  const promises = []
  const badIndex = 31
  for (let index = 0; index < WRITE_QUEUE_BATCH_MAX; index += 1) {
    const sender = senders[index % senders.length]
    const body = {
      to: peer.address,
      client_message_id: `mixed-${index}-${randomUUID()}`,
      text: `mixed-payload-${index}`,
      ...(index === badIndex ? { reply_to_seq: 999999 } : {}),
    }
    promises.push(request(server.port, 'POST', '/api/messages', {
      agent,
      headers: sessionHeaders(sender.session_capability),
      body: JSON.stringify(body),
    }))
  }

  // Wait until at least one batch attempt is spinning or all 64 entered queue, then commit lock.
  await waitForCondition(async () => {
    const st = await fetchStatus(server.port, bearerHeaders(token))
    return st.write_queue.depth + st.write_queue.busy_retries_total > 0 && st.write_queue.max_depth >= 1
  }, { description: 'mixed batch to enter queue' })
  await sleep(60)
  lockDb.exec('COMMIT;')

  const responses = await Promise.all(promises)
  let committed = 0
  for (let index = 0; index < responses.length; index += 1) {
    const res = responses[index]
    if (index === badIndex) {
      assert.equal(res.status, 404, res.text)
      assert.equal(res.json().error.code, 'message_not_found')
    } else {
      assert.equal(res.status, 200, `op #${index} unexpected ${res.status}: ${res.text}`)
      assert.equal(res.json().result.status, 'committed')
      committed += 1
    }
  }
  assert.equal(committed, WRITE_QUEUE_BATCH_MAX - 1)

  const inspector = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME), { readOnly: true })
  try {
    const row = inspector.prepare('SELECT COUNT(*) AS count FROM messages').get()
    assert.equal(Number(row.count), WRITE_QUEUE_BATCH_MAX - 1)
  } finally {
    inspector.close()
  }
})

test('PER_SESSION_CAP: > 16 queued ops on one session reject with 503 queue_full + Retry-After while sibling session on same actor succeeds', async t => {
  // Unit determinism check on createWriteQueue (synchronous enqueue loop fills pending before pump runs)
  const queue = createWriteQueue({
    runBatch: batch => batch.map(op => ({ ok: true, result: op.execute() })),
  })

  const sessionAResults = []
  for (let index = 0; index < WRITE_QUEUE_PER_SESSION_MAX; index += 1) {
    sessionAResults.push(queue.enqueue({
      sessionKey: 'session:A',
      bytes: 64,
      execute: () => ({ index }),
    }))
  }
  await assert.rejects(
    queue.enqueue({ sessionKey: 'session:A', bytes: 64, execute: () => ({ index: 99 }) }),
    err => err?.code === 'queue_full'
      && Number.isInteger(err.retry_after_ms)
      && err.retry_after_ms > 0
      && PUBLIC_ERROR_STATUS[err.code] === 503,
  )
  const siblingPromise = queue.enqueue({ sessionKey: 'session:B', bytes: 64, execute: () => 'sibling-ok' })
  assert.equal(queue.getMetrics().rejected_total, 1)

  assert.equal((await Promise.all(sessionAResults)).length, WRITE_QUEUE_PER_SESSION_MAX)
  assert.equal(await siblingPromise, 'sibling-ok')

  // End-to-end live HTTP check with two sessions sharing one installation actor
  const dataDir = makeDataDir(t)
  const server = await startTestServer(t, dataDir)
  const agent = new http.Agent({ keepAlive: true, maxSockets: 64 })
  t.after(() => agent.destroy())

  const actor = installation()
  const token = await authLocal(server.port, dataDir, actor)
  const sessionA = await allocatePrincipal(server.port, token, 'cap-alice', 'cli', 'box-a')
  const sessionB = await allocatePrincipal(server.port, token, 'cap-bob', 'cli', 'box-b')
  const peer = await allocatePrincipal(server.port, token, 'cap-peer', 'mcp', 'box-c')

  // Hold SQLite write lock across the flush window so all concurrent HTTP requests sit queued together.
  const lockDb = openLockConnection(dataDir)
  t.after(() => { try { lockDb.close() } catch { /* ignore */ } })
  lockDb.exec('BEGIN IMMEDIATE;')

  const totalForA = WRITE_QUEUE_PER_SESSION_MAX + 3
  const sendPromisesA = Array.from({ length: totalForA }, (_, index) =>
    request(server.port, 'POST', '/api/messages', {
      agent,
      headers: sessionHeaders(sessionA.session_capability),
      body: JSON.stringify({
        to: peer.address,
        client_message_id: `cap-a-${index}-${randomUUID()}`,
        text: `cap-message-${index}`,
      }),
    }),
  )
  const sendPromisesB = Array.from({ length: 2 }, (_, index) =>
    request(server.port, 'POST', '/api/messages', {
      agent,
      headers: sessionHeaders(sessionB.session_capability),
      body: JSON.stringify({
        to: peer.address,
        client_message_id: `cap-b-${index}-${randomUUID()}`,
        text: `sibling-message-${index}`,
      }),
    }),
  )

  await sleep(80)
  lockDb.exec('COMMIT;')

  const [resultsA, resultsB] = await Promise.all([
    Promise.all(sendPromisesA),
    Promise.all(sendPromisesB),
  ])

  const committedA = resultsA.filter(res => res.status === 200)
  const rejectedA = resultsA.filter(res => res.status === 503)
  assert.equal(committedA.length, WRITE_QUEUE_PER_SESSION_MAX)
  assert.equal(rejectedA.length, totalForA - WRITE_QUEUE_PER_SESSION_MAX)

  for (const res of rejectedA) {
    const payload = res.json()
    assert.equal(payload.ok, false)
    assert.equal(payload.error.code, 'queue_full')
    assert.ok(Number.isInteger(payload.error.retry_after_ms) && payload.error.retry_after_ms > 0)
    assert.ok(Number(res.headers['retry-after']) >= 1)
  }
  for (const res of resultsB) {
    assert.equal(res.status, 200, res.text)
    assert.equal(res.json().result.status, 'committed')
  }
})

test('GLOBAL_CAP: queue enforces WRITE_QUEUE_MAX_OPS (2048) and WRITE_QUEUE_MAX_BYTES with immediate 503 queue_full', async () => {
  // 1) Op cap (WRITE_QUEUE_MAX_OPS = 2048) across distinct sessions
  const opQueue = createWriteQueue({
    runBatch: batch => batch.map(op => ({ ok: true, result: op.execute() })),
  })

  const opsPromises = []
  for (let index = 0; index < WRITE_QUEUE_MAX_OPS; index += 1) {
    const sessionBucket = Math.floor(index / WRITE_QUEUE_PER_SESSION_MAX)
    opsPromises.push(opQueue.enqueue({
      sessionKey: `s-${sessionBucket}`,
      bytes: 16,
      execute: () => index,
    }))
  }
  assert.equal(opQueue.getMetrics().depth, WRITE_QUEUE_MAX_OPS)
  assert.equal(opQueue.getMetrics().max_depth, WRITE_QUEUE_MAX_OPS)

  await assert.rejects(
    opQueue.enqueue({ sessionKey: 's-overflow', bytes: 16, execute: () => 'nope' }),
    err => err?.code === 'queue_full' && PUBLIC_ERROR_STATUS[err.code] === 503 && err.retry_after_ms > 0,
  )
  assert.equal(opQueue.getMetrics().rejected_total, 1)

  await Promise.all(opsPromises)
  assert.equal(opQueue.getMetrics().depth, 0)
  assert.equal(opQueue.getMetrics().committed_total, WRITE_QUEUE_MAX_OPS)

  // 2) Byte cap (WRITE_QUEUE_MAX_BYTES)
  const byteQueue = createWriteQueue({
    runBatch: batch => batch.map(op => ({ ok: true, result: op.execute() })),
  })

  const halfMax = WRITE_QUEUE_MAX_BYTES / 2
  const b1 = byteQueue.enqueue({ sessionKey: 'bytes-1', bytes: halfMax, execute: () => 1 })
  const b2 = byteQueue.enqueue({ sessionKey: 'bytes-2', bytes: halfMax, execute: () => 2 })
  assert.equal(byteQueue.getMetrics().bytes, WRITE_QUEUE_MAX_BYTES)

  await assert.rejects(
    byteQueue.enqueue({ sessionKey: 'bytes-3', bytes: 1, execute: () => 3 }),
    err => err?.code === 'queue_full' && PUBLIC_ERROR_STATUS[err.code] === 503 && err.retry_after_ms > 0,
  )
  assert.equal(byteQueue.getMetrics().rejected_total, 1)

  assert.deepEqual(await Promise.all([b1, b2]), [1, 2])
  assert.equal(byteQueue.getMetrics().bytes, 0)
})

test('HB_COALESCE: 10 rapid heartbeats for one session collapse into 1 write with latest generation and settle all callers', async t => {
  // Unit verification of latest-payload coalescing & error fan-out
  let executions = 0
  let lastSeenGeneration = null
  const unitQueue = createWriteQueue({
    runBatch: batch => batch.map(op => {
      executions += 1
      lastSeenGeneration = op.payload.generation
      return { ok: true, result: { status: 'retained', generation: op.payload.generation } }
    }),
  })

  const unitPromises = []
  for (let gen = 1; gen <= 10; gen += 1) {
    unitPromises.push(unitQueue.enqueue({
      sessionKey: 'hb:sess-unit',
      coalesceKey: 'hb:sess-unit',
      bytes: 64,
      payload: { generation: gen },
      execute: (_tx, op) => ({ ok: true, generation: op.payload.generation }),
    }))
  }
  const unitResults = await Promise.all(unitPromises)
  assert.equal(executions, 1)
  assert.equal(lastSeenGeneration, 10)
  assert.equal(unitQueue.getMetrics().coalesced_total, 9)
  assert.equal(unitQueue.getMetrics().committed_total, 1)
  for (const item of unitResults) {
    assert.deepEqual(item, { status: 'retained', generation: 10 })
  }

  // Error propagation across coalesced waiters
  let failExecutions = 0
  const failingQueue = createWriteQueue({
    runBatch: batch => {
      failExecutions += 1
      return batch.map(() => ({
        ok: false,
        error: Object.assign(new Error('fenced'), { code: 'session_revoked' }),
      }))
    },
  })
  const failWaiters = Array.from({ length: 4 }, (_, index) => failingQueue.enqueue({
    sessionKey: 'hb:sess-fail',
    coalesceKey: 'hb:sess-fail',
    bytes: 32,
    payload: { index },
    execute: () => ({}),
  }))
  const settled = await Promise.allSettled(failWaiters)
  assert.equal(failExecutions, 1)
  for (const outcome of settled) {
    assert.equal(outcome.status, 'rejected')
    assert.equal(outcome.reason?.code, 'session_revoked')
  }

  // End-to-end HTTP POST /api/session-principals/heartbeat coalescing
  const dataDir = makeDataDir(t)
  const server = await startTestServer(t, dataDir)
  const agent = new http.Agent({ keepAlive: true, maxSockets: 32 })
  t.after(() => agent.destroy())

  const actor = installation()
  const token = await authLocal(server.port, dataDir, actor)
  const principal = await allocatePrincipal(server.port, token, 'hb-alice', 'cli', 'box-hb')

  const lockDb = openLockConnection(dataDir)
  t.after(() => { try { lockDb.close() } catch { /* ignore */ } })
  lockDb.exec('BEGIN IMMEDIATE;')

  const httpPromises = Array.from({ length: 10 }, () =>
    request(server.port, 'POST', '/api/session-principals/heartbeat', {
      agent,
      headers: sessionHeaders(principal.session_capability),
      body: JSON.stringify({ session_id: principal.session_id, generation: principal.generation }),
    }),
  )

  await sleep(60)
  lockDb.exec('COMMIT;')

  const httpResponses = await Promise.all(httpPromises)
  for (const res of httpResponses) {
    assert.equal(res.status, 200, res.text)
    const hbResult = res.json().result
    assert.equal(hbResult.session_id, principal.session_id)
    assert.equal(hbResult.generation, principal.generation)
    assert.equal(typeof hbResult.base_lease_expires_at, 'string')
  }

  const statusAfter = await fetchStatus(server.port, bearerHeaders(token))
  assert.ok(
    statusAfter.write_queue.coalesced_total >= 8,
    `expected >= 8 coalesced heartbeats, got ${statusAfter.write_queue.coalesced_total}`,
  )
  assert.ok(statusAfter.write_queue.committed_total <= 2)
})

test('BUSY_RECOVER: external 300 ms SQLite write lock causes async backoff recovery while GET /health stays responsive', async t => {
  const dataDir = makeDataDir(t)
  const server = await startTestServer(t, dataDir)

  const actor = installation()
  const token = await authLocal(server.port, dataDir, actor)
  const sender = await allocatePrincipal(server.port, token, 'busy-sender', 'cli', 'm1')
  const peer = await allocatePrincipal(server.port, token, 'busy-peer', 'cli', 'm2')

  const lockDb = openLockConnection(dataDir)
  t.after(() => { try { lockDb.close() } catch { /* ignore */ } })
  lockDb.exec('BEGIN IMMEDIATE;')

  const sendPromises = Array.from({ length: 5 }, (_, index) =>
    request(server.port, 'POST', '/api/messages', {
      headers: sessionHeaders(sender.session_capability),
      body: JSON.stringify({
        to: peer.address,
        client_message_id: `busy-rec-${index}-${randomUUID()}`,
        text: `recover-${index}`,
      }),
    }),
  )

  await sleep(180)
  const healthStart = Date.now()
  const healthRes = await request(server.port, 'GET', '/health')
  const healthElapsedMs = Date.now() - healthStart
  assert.equal(healthRes.status, 200)
  assert.ok(healthElapsedMs < 100, `expected GET /health < 100ms under busy lock, took ${healthElapsedMs}ms`)

  await sleep(120)
  lockDb.exec('COMMIT;')

  const responses = await Promise.all(sendPromises)
  for (const res of responses) {
    assert.equal(res.status, 200, res.text)
    assert.equal(res.json().result.status, 'committed')
  }

  const status = await fetchStatus(server.port, bearerHeaders(token))
  assert.ok(status.write_queue.busy_retries_total > 0, 'expected SQLITE_BUSY retries to be counted')
  assert.equal(status.write_queue.rejected_total, 0)
})

test('BUSY_EXHAUSTED: external lock exceeding 1,500 ms rejects batch with 503 queue_full + Retry-After and server remains healthy', async t => {
  assert.equal(WRITE_QUEUE_BUSY_BUDGET_MS, 1500)
  const dataDir = makeDataDir(t)
  const server = await startTestServer(t, dataDir)

  const actor = installation()
  const token = await authLocal(server.port, dataDir, actor)
  const sender = await allocatePrincipal(server.port, token, 'exhaust-sender', 'cli', 'm1')
  const peer = await allocatePrincipal(server.port, token, 'exhaust-peer', 'cli', 'm2')

  const lockDb = openLockConnection(dataDir)
  t.after(() => { try { lockDb.close() } catch { /* ignore */ } })
  lockDb.exec('BEGIN IMMEDIATE;')

  const exhaustedPromises = Array.from({ length: 2 }, (_, index) =>
    request(server.port, 'POST', '/api/messages', {
      headers: sessionHeaders(sender.session_capability),
      body: JSON.stringify({
        to: peer.address,
        client_message_id: `exhaust-${index}-${randomUUID()}`,
        text: `exhaust-${index}`,
      }),
    }),
  )

  // Verify /health never stalls mid-retry
  await sleep(300)
  const healthStart = Date.now()
  const healthRes = await request(server.port, 'GET', '/health')
  assert.equal(healthRes.status, 200)
  assert.ok(Date.now() - healthStart < 100, 'GET /health must stay responsive during retry exhaustion')

  const responses = await Promise.all(exhaustedPromises)
  for (const res of responses) {
    assert.equal(res.status, 503, res.text)
    const payload = res.json()
    assert.equal(payload.ok, false)
    assert.equal(payload.error.code, 'queue_full')
    assert.ok(Number.isInteger(payload.error.retry_after_ms) && payload.error.retry_after_ms > 0)
    assert.ok(Number(res.headers['retry-after']) >= 1)
  }

  lockDb.exec('COMMIT;')

  const status = await fetchStatus(server.port, bearerHeaders(token))
  assert.ok(status.write_queue.busy_retries_total > 0)
  assert.ok(status.write_queue.rejected_total >= 2)

  // After lock clears, subsequent sends succeed normally.
  const followUp = await request(server.port, 'POST', '/api/messages', {
    headers: sessionHeaders(sender.session_capability),
    body: JSON.stringify({
      to: peer.address,
      client_message_id: `recover-after-${randomUUID()}`,
      text: 'server-back-to-normal',
    }),
  })
  assert.equal(followUp.status, 200, followUp.text)
  assert.equal(followUp.json().result.status, 'committed')

  assert.equal(isDatabaseBusyError({ errcode: 5, message: 'database is locked' }), true)
  assert.equal(isDatabaseBusyError({ errcode: 261, message: 'database is locked (recovery)' }), true)
  assert.equal(isDatabaseBusyError({ code: 'database_busy', message: 'busy' }), true)
  assert.equal(isDatabaseBusyError({ code: 'ERR_SQLITE_ERROR', errcode: 19, message: 'constraint' }), false)
})

test('TX_FENCE: batch validation rejects banned actors (403), superseded bearers (401), and revoked principals (401) with 0 inserts', async t => {
  const dataDir = makeDataDir(t)
  const sessionRegistry = createSessionRegistry()
  const server = await startTestServer(t, dataDir, { sessionRegistry })

  const actorBan = installation()
  const actorSupersede = installation()
  const actorRevoke = installation()
  const tokenBan = await authLocal(server.port, dataDir, actorBan)
  const tokenSupersede = await authLocal(server.port, dataDir, actorSupersede)
  const tokenRevoke = await authLocal(server.port, dataDir, actorRevoke)

  await bindChatId(server.port, tokenBan, 'fence-ban')
  await bindChatId(server.port, tokenSupersede, 'fence-supersede')
  // Release live presence (preserving the durable chat_id_claims row) so auth
  // does not run a synchronous touch write while lockDb holds the write lock
  // ahead of the queued batch execution.
  assert.equal((await request(server.port, 'DELETE', '/api/session', { headers: bearerHeaders(tokenBan) })).status, 200)
  assert.equal((await request(server.port, 'DELETE', '/api/session', { headers: bearerHeaders(tokenSupersede) })).status, 200)
  const principalRevoke = await allocatePrincipal(server.port, tokenRevoke, 'fence-revoke', 'cli', 'm-rev')
  const peer = await allocatePrincipal(server.port, tokenRevoke, 'fence-peer', 'cli', 'm-peer')

  const { broadcast_room_id: roomId } = await fetchStatus(server.port, bearerHeaders(tokenRevoke))
  const verifiedSupersede = sessionRegistry.verify(tokenSupersede)
  assert.equal(verifiedSupersede.actorFingerprint, actorSupersede.fingerprint)
  const supersedeSessionKey = createHash('sha256').update(tokenSupersede, 'utf8').digest('hex')

  const lockDb = openLockConnection(dataDir)
  t.after(() => { try { lockDb.close() } catch { /* ignore */ } })

  // Hold SQLite write lock so all 3 queued sends reach validateFence AFTER mutation lands.
  lockDb.exec('BEGIN IMMEDIATE;')

  const banClientMsgId = `fence-ban-${randomUUID()}`
  const supClientMsgId = `fence-sup-${randomUUID()}`
  const revClientMsgId = `fence-rev-${randomUUID()}`

  const banPromise = request(server.port, 'POST', `/api/rooms/${encodeURIComponent(roomId)}/messages`, {
    headers: bearerHeaders(tokenBan),
    body: JSON.stringify({
      chat_id: 'fence-ban',
      client_message_id: banClientMsgId,
      text: 'should-fence-ban',
    }),
  })
  const supPromise = request(server.port, 'POST', `/api/rooms/${encodeURIComponent(roomId)}/messages`, {
    headers: bearerHeaders(tokenSupersede),
    body: JSON.stringify({
      chat_id: 'fence-supersede',
      client_message_id: supClientMsgId,
      text: 'should-fence-supersede',
    }),
  })
  const revPromise = request(server.port, 'POST', '/api/messages', {
    headers: sessionHeaders(principalRevoke.session_capability),
    body: JSON.stringify({ to: peer.address, client_message_id: revClientMsgId, text: 'should-fence-revoke' }),
  })

  await waitForCondition(async () => {
    const st = await fetchStatus(server.port, bearerHeaders(tokenRevoke))
    return st.write_queue.depth + st.write_queue.busy_retries_total >= 1 && st.write_queue.max_depth >= 1
  }, { description: 'fenced requests to enter write queue' })
  await sleep(60)

  // Mutate durable ban + revocation inside the held SQLite lock, and supersede Bearer session.
  lockDb.prepare('INSERT INTO banned_actors (actor_fingerprint, banned_at, reason) VALUES (?, ?, ?)').run(
    actorBan.fingerprint,
    new Date().toISOString(),
    'tx-fence-test',
  )
  lockDb.prepare("UPDATE session_principals SET principal_status = 'revoked' WHERE session_id = ?").run(
    principalRevoke.session_id,
  )
  sessionRegistry.supersede(supersedeSessionKey)
  lockDb.exec('COMMIT;')

  const [banRes, supRes, revRes] = await Promise.all([banPromise, supPromise, revPromise])

  assert.equal(banRes.status, 403, banRes.text)
  assert.equal(banRes.json().error.code, 'banned')

  assert.equal(supRes.status, 401, supRes.text)
  assert.equal(supRes.json().error.code, 'unauthorized')

  assert.equal(revRes.status, 401, revRes.text)
  assert.equal(revRes.json().error.code, 'session_revoked')

  const inspector = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME), { readOnly: true })
  try {
    const rows = inspector.prepare(
      'SELECT client_message_id FROM messages WHERE client_message_id IN (?, ?, ?)',
    ).all(banClientMsgId, supClientMsgId, revClientMsgId)
    assert.equal(rows.length, 0, 'fenced batch writes must leave zero rows in messages')
  } finally {
    inspector.close()
  }
})

test('PREAUTH_ENROLL: pre-auth enrollment keeps 5/min per-IP gate with AGENT_ROOM_TRUSTED_PROXY=true + Retry-After', async t => {
  const { trustedProxy, warning: proxyWarning } = trustedProxyFromEnv({ AGENT_ROOM_TRUSTED_PROXY: 'true' })
  assert.equal(trustedProxy, true)
  assert.equal(proxyWarning ?? null, null)
  assert.equal(trustedProxyFromEnv({}).trustedProxy, false)
  assert.equal(gateLimitsFromEnv({}).gateLimits.duplicateWindowMs > 0, true)

  const dataDir = makeDataDir(t)
  // Mint a multi-use invite through the CLI before booting the child server.
  const mintRes = await runCli(dataDir, ['invite', 'mint', '--uses', String(ENROLLMENT_PER_MINUTE + 5)])
  assert.equal(mintRes.exitCode, 0, mintRes.stderr)
  const inviteToken = JSON.parse(mintRes.stdout.trim()).token

  const spawned = spawnServerChild(t, dataDir, { AGENT_ROOM_TRUSTED_PROXY: 'true' })
  const record = await spawned.waitReady()

  for (let index = 0; index < ENROLLMENT_PER_MINUTE; index += 1) {
    const peer = installation()
    const res = await request(record.port, 'POST', '/api/auth/enroll', {
      headers: jsonHeaders({ 'x-forwarded-for': '198.51.100.10' }),
      body: JSON.stringify({
        invite_token: inviteToken,
        public_key: peer.publicKey,
        signature: peer.signToken(inviteToken),
      }),
    })
    assert.equal(res.status, 200, `enroll #${index} unexpected status ${res.status}: ${res.text}`)
  }

  // 6th enrollment within 60s for 198.51.100.10 triggers 429 rate_limited + Retry-After.
  const throttledPeer = installation()
  const throttledRes = await request(record.port, 'POST', '/api/auth/enroll', {
    headers: jsonHeaders({ 'x-forwarded-for': '198.51.100.10' }),
    body: JSON.stringify({
      invite_token: inviteToken,
      public_key: throttledPeer.publicKey,
      signature: throttledPeer.signToken(inviteToken),
    }),
  })
  assert.equal(throttledRes.status, 429, throttledRes.text)
  assert.equal(throttledRes.json().error.code, 'rate_limited')
  assert.ok(
    Number.isInteger(throttledRes.json().error.retry_after_ms)
      && throttledRes.json().error.retry_after_ms >= 1
      && throttledRes.json().error.retry_after_ms <= ENROLLMENT_WINDOW_MS,
    `expected error.retry_after_ms in [1, ${ENROLLMENT_WINDOW_MS}], got ${throttledRes.text}`,
  )
  assert.ok(Number(throttledRes.headers['retry-after']) >= 1)

  // Distinct forwarded client IP is not penalized.
  const otherIpPeer = installation()
  const otherIpRes = await request(record.port, 'POST', '/api/auth/enroll', {
    headers: jsonHeaders({ 'x-forwarded-for': '198.51.100.11' }),
    body: JSON.stringify({
      invite_token: inviteToken,
      public_key: otherIpPeer.publicKey,
      signature: otherIpPeer.signToken(inviteToken),
    }),
  })
  assert.equal(otherIpRes.status, 200, otherIpRes.text)
})

test('STATUS_METRICS: GET /api/status supports Bearer & Session auth with exact 8-field write_queue metrics; /health omits it', async t => {
  const dataDir = makeDataDir(t)
  const server = await startTestServer(t, dataDir)

  const actor = installation()
  const token = await authLocal(server.port, dataDir, actor)
  const sender = await allocatePrincipal(server.port, token, 'status-sender', 'cli', 'm-stat')
  const peer = await allocatePrincipal(server.port, token, 'status-peer', 'cli', 'm-peer')

  const secretSnippet = 'SUPER_SECRET_BODY_DO_NOT_LEAK'
  const sendRes = await request(server.port, 'POST', '/api/messages', {
    headers: sessionHeaders(sender.session_capability),
    body: JSON.stringify({
      to: peer.address,
      client_message_id: `status-msg-${randomUUID()}`,
      text: secretSnippet,
    }),
  })
  assert.equal(sendRes.status, 200, sendRes.text)

  for (const headers of [bearerHeaders(token), sessionHeaders(sender.session_capability)]) {
    const statusRes = await request(server.port, 'GET', '/api/status', { headers })
    assert.equal(statusRes.status, 200, statusRes.text)
    assert.equal(statusRes.text.includes(secretSnippet), false)
    assert.equal(statusRes.text.includes(token), false)
    assert.equal(statusRes.text.includes(sender.session_capability), false)

    const body = statusRes.json()
    assert.equal(body.ok, true)
    assert.deepEqual(Object.keys(body.result).sort(), [
      'broadcast_room_id',
      'realm_id',
      'version',
      'write_queue',
    ])
    const wq = body.result.write_queue
    assert.deepEqual(Object.keys(wq).sort(), STATUS_METRIC_KEYS)
    for (const key of STATUS_METRIC_KEYS) {
      assert.ok(Number.isSafeInteger(wq[key]) && wq[key] >= 0, `${key} must be non-negative int`)
    }
    assert.ok(wq.committed_total >= 1)
  }

  const badQuery = await request(server.port, 'GET', '/api/status?unexpected=1', {
    headers: bearerHeaders(token),
  })
  assert.equal(badQuery.status, 400)
  assert.equal(badQuery.json().error.code, 'unknown_field')

  const healthRes = await request(server.port, 'GET', '/health')
  assert.equal(healthRes.status, 200)
  assert.deepEqual(Object.keys(healthRes.json().result), ['version'])
})

test('SHUTDOWN_DRAIN: server.close() drains queued writes before closing store, late enqueues reject 503, and drain timeout fails bounded', async t => {
  assert.equal(WRITE_QUEUE_DRAIN_MS, 2000)

  // Unit + room-log store verification of late-enqueue rejection, bounded drain timeout, and WAL checkpoint on close
  const busyError = Object.assign(new Error('database is locked'), { errcode: 5 })
  const slowQueue = createWriteQueue({
    runBatch: () => { throw busyError },
  })
  const slowOp = assert.rejects(
    slowQueue.enqueue({ sessionKey: 's-drain', bytes: 32, execute: () => 'ok' }),
    err => err?.code === 'queue_full' && PUBLIC_ERROR_STATUS[err.code] === 503,
  )
  await sleep(30)
  const drainOutcome = await slowQueue.drain(40)
  assert.deepEqual(drainOutcome, { drained: false, timedOut: true, remaining: 1 })
  await assert.rejects(
    slowQueue.enqueue({ sessionKey: 's-late', bytes: 32, execute: () => 'late' }),
    err => err?.code === 'queue_full' && PUBLIC_ERROR_STATUS[err.code] === 503,
  )
  await slowOp

  // Store-level drain during active write lock rejects late enqueues with 503 queue_full and checkpoints on close
  const storeDir = makeDataDir(t, 'agent-room-wq-drain-store-')
  const store = openRoomLog({ dataDir: storeDir, role: 'server' })
  const storeLock = openLockConnection(storeDir)
  t.after(() => {
    try { storeLock.close() } catch { /* ignore */ }
    try { store.close() } catch { /* ignore */ }
  })
  storeLock.exec('BEGIN IMMEDIATE;')
  const queuedStoreWrite = store.enqueueWrite({
    sessionKey: 'store-drain-1',
    bytes: 16,
    execute: () => 'store-committed',
  })
  await sleep(30)
  const storeDrain = store.drainWriteQueue()
  await assert.rejects(
    store.enqueueWrite({ sessionKey: 'store-drain-late', bytes: 16, execute: () => 'nope' }),
    err => err?.code === 'queue_full' && PUBLIC_ERROR_STATUS[err.code] === 503 && err.retry_after_ms > 0,
  )
  storeLock.exec('COMMIT;')
  storeLock.close()
  assert.equal((await storeDrain).drained, true)
  assert.equal(await queuedStoreWrite, 'store-committed')
  store.close()

  // Live server graceful drain across 5 queued HTTP SQLite writes
  const dataDir = makeDataDir(t)
  const server = await startServer({
    dataDir,
    port: 0,
    host: '127.0.0.1',
    enrollRateLimiter: createEnrollRateLimiter({ limit: 1000 }),
  })
  t.after(async () => { await server.close() })

  const actor = installation()
  const token = await authLocal(server.port, dataDir, actor)
  const sender = await allocatePrincipal(server.port, token, 'drain-sender', 'cli', 'm-drain')
  const peer = await allocatePrincipal(server.port, token, 'drain-peer', 'cli', 'm-peer')

  const lockDb = openLockConnection(dataDir)
  t.after(() => { try { lockDb.close() } catch { /* ignore */ } })
  lockDb.exec('BEGIN IMMEDIATE;')

  const ids = Array.from({ length: 5 }, (_, index) => `drain-${index}-${randomUUID()}`)
  const inFlightPromises = ids.map((clientMessageId, index) =>
    request(server.port, 'POST', '/api/messages', {
      headers: sessionHeaders(sender.session_capability),
      body: JSON.stringify({
        to: peer.address,
        client_message_id: clientMessageId,
        text: `drain-msg-${index}`,
      }),
    }),
  )

  await waitForCondition(async () => {
    const st = await fetchStatus(server.port, bearerHeaders(token))
    return st.write_queue.depth === 5
  }, { description: 'all 5 shutdown-drain messages to enter write queue' })

  let closedDone = false
  const closePromise = server.close().then(() => { closedDone = true })

  // Drain must not complete while queued batch is blocked on lockDb (within 2,000 ms budget).
  await sleep(40)
  assert.equal(closedDone, false)

  lockDb.exec('COMMIT;')
  lockDb.close()

  await closePromise
  assert.equal(closedDone, true)

  const responses = await Promise.all(inFlightPromises)
  for (const res of responses) {
    assert.equal(res.status, 200, res.text)
    assert.equal(res.json().result.status, 'committed')
  }

  const inspector = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME), { readOnly: true })
  try {
    const countRow = inspector.prepare('SELECT COUNT(*) AS count FROM messages').get()
    assert.equal(Number(countRow.count), 5)
    assert.ok(MESSAGE_TEXT_MAX > 0)
  } finally {
    inspector.close()
  }
})

test('BINDING_TRANSITION: queued POST /api/rooms/:id/messages rejects DELETE /api/session (401) and PATCH /api/session (400) with zero commits', async t => {
  const dataDir = makeDataDir(t)
  const server = await startTestServer(t, dataDir)

  const actorDel = installation()
  const actorPatch = installation()
  const actorUnbound = installation()
  const statusActor = installation()
  const tokenDel = await authLocal(server.port, dataDir, actorDel)
  const tokenPatch = await authLocal(server.port, dataDir, actorPatch)
  const tokenUnbound = await authLocal(server.port, dataDir, actorUnbound)
  const statusToken = await authLocal(server.port, dataDir, statusActor)
  const lockSender = await allocatePrincipal(server.port, statusToken, 'lock-bt-a', 'cli', 'm-bt-a')
  const lockPeer = await allocatePrincipal(server.port, statusToken, 'lock-bt-b', 'cli', 'm-bt-b')

  await bindChatId(server.port, tokenDel, 'DelSender')
  await bindChatId(server.port, tokenPatch, 'PatchSender')
  await bindChatId(server.port, tokenUnbound, 'OldClaimedName')
  assert.equal(
    (await request(server.port, 'DELETE', '/api/session', { headers: bearerHeaders(tokenUnbound) })).status,
    200,
  )

  const { broadcast_room_id: roomId } = await fetchStatus(server.port, bearerHeaders(statusToken))
  const lockDb = openLockConnection(dataDir)
  t.after(() => { try { lockDb.close() } catch { /* ignore */ } })
  lockDb.exec('BEGIN IMMEDIATE;')

  const blockerPromise = request(server.port, 'POST', '/api/messages', {
    headers: sessionHeaders(lockSender.session_capability),
    body: JSON.stringify({
      to: lockPeer.address,
      client_message_id: `bt-blocker-${randomUUID()}`,
      text: 'hold pump active in 200ms backoff',
    }),
  })

  // Wait until blocker batch enters the 200 ms busy-backoff sleep, then release SQLite lock
  // so bound-Bearer auth touch() succeeds while the write queue remains paused in sleepBackoff.
  await waitForCondition(async () => {
    const st = await fetchStatus(server.port, bearerHeaders(statusToken))
    return st.write_queue.depth === 1 && st.write_queue.busy_retries_total >= 4
  }, { stepMs: 5, description: 'blocker write to enter 200ms busy backoff' })

  lockDb.exec('COMMIT;')
  lockDb.close()

  const delMsgId = `del-queue-${randomUUID()}`
  const patchMsgId = `patch-queue-${randomUUID()}`
  const unboundMsgId = `unbound-queue-${randomUUID()}`

  const delSendPromise = request(server.port, 'POST', `/api/rooms/${encodeURIComponent(roomId)}/messages`, {
    headers: bearerHeaders(tokenDel),
    body: JSON.stringify({ chat_id: 'DelSender', client_message_id: delMsgId, text: 'after-delete' }),
  })
  const patchSendPromise = request(server.port, 'POST', `/api/rooms/${encodeURIComponent(roomId)}/messages`, {
    headers: bearerHeaders(tokenPatch),
    body: JSON.stringify({ chat_id: 'PatchSender', client_message_id: patchMsgId, text: 'after-patch' }),
  })
  const unboundSendPromise = request(server.port, 'POST', `/api/rooms/${encodeURIComponent(roomId)}/messages`, {
    headers: bearerHeaders(tokenUnbound),
    body: JSON.stringify({ chat_id: 'OldClaimedName', client_message_id: unboundMsgId, text: 'after-rebind' }),
  })

  await waitForCondition(async () => {
    const st = await fetchStatus(server.port, bearerHeaders(statusToken))
    return st.write_queue.depth >= 4
  }, { stepMs: 2, description: 'all 3 room messages to enqueue behind sleeping batch' })

  const [deleteRes, patchSessionRes, bindNewRes] = await Promise.all([
    request(server.port, 'DELETE', '/api/session', { headers: bearerHeaders(tokenDel) }),
    request(server.port, 'PATCH', '/api/session', {
      headers: bearerHeaders(tokenPatch),
      body: JSON.stringify({ chat_id: 'PatchRenamed', client_type: 'cli' }),
    }),
    request(server.port, 'POST', '/api/session', {
      headers: bearerHeaders(tokenUnbound),
      body: JSON.stringify({ chat_id: 'NewlyBoundName', client_type: 'cli' }),
    }),
  ])
  assert.equal(deleteRes.status, 200, deleteRes.text)
  assert.equal(patchSessionRes.status, 200, patchSessionRes.text)
  assert.equal(bindNewRes.status, 200, bindNewRes.text)

  const [blockerRes, delSendRes, patchSendRes, unboundSendRes] = await Promise.all([
    blockerPromise,
    delSendPromise,
    patchSendPromise,
    unboundSendPromise,
  ])
  assert.equal(blockerRes.status, 200, blockerRes.text)

  assert.equal(delSendRes.status, 401, delSendRes.text)
  assert.equal(delSendRes.json().error.code, 'unauthorized')

  assert.equal(patchSendRes.status, 400, patchSendRes.text)
  assert.equal(patchSendRes.json().error.code, 'invalid_request')

  assert.equal(unboundSendRes.status, 400, unboundSendRes.text)
  assert.equal(unboundSendRes.json().error.code, 'invalid_request')

  const inspector = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME), { readOnly: true })
  try {
    const rows = inspector.prepare(
      'SELECT client_message_id FROM messages WHERE client_message_id IN (?, ?, ?)',
    ).all(delMsgId, patchMsgId, unboundMsgId)
    assert.equal(rows.length, 0)
  } finally {
    inspector.close()
  }
})

test('BOUND_BEARER_SHUTDOWN_DRAIN: bound Bearer POST /api/rooms/:id/messages queued before server.close() drains 200 before LIVE_SESSION_REGISTRY.clear()', async t => {
  const dataDir = makeDataDir(t)
  // Do NOT pass custom liveSessionRegistry so default LIVE_SESSION_REGISTRY ownership is exercised.
  const server = await startServer({
    dataDir,
    port: 0,
    host: '127.0.0.1',
    enrollRateLimiter: createEnrollRateLimiter({ limit: 1000 }),
  })
  t.after(async () => { await server.close() })

  const actor = installation()
  const statusActor = installation()
  const token = await authLocal(server.port, dataDir, actor)
  const statusToken = await authLocal(server.port, dataDir, statusActor)
  const lockSender = await allocatePrincipal(server.port, statusToken, 'lock-bd-a', 'cli', 'm-bd-a')
  const lockPeer = await allocatePrincipal(server.port, statusToken, 'lock-bd-b', 'cli', 'm-bd-b')
  await bindChatId(server.port, token, 'BoundDrainSender')
  const { broadcast_room_id: roomId } = await fetchStatus(server.port, bearerHeaders(statusToken))

  const lockDb = openLockConnection(dataDir)
  t.after(() => { try { lockDb.close() } catch { /* ignore */ } })
  lockDb.exec('BEGIN IMMEDIATE;')

  const blockerPromise = request(server.port, 'POST', '/api/messages', {
    headers: sessionHeaders(lockSender.session_capability),
    body: JSON.stringify({
      to: lockPeer.address,
      client_message_id: `bd-blocker-${randomUUID()}`,
      text: 'hold pump active',
    }),
  })
  await waitForCondition(async () => {
    const st = await fetchStatus(server.port, bearerHeaders(statusToken))
    return st.write_queue.depth === 1 && st.write_queue.busy_retries_total >= 4
  }, { stepMs: 5, description: 'blocker write to enter 200ms backoff' })

  // Briefly unlock SQLite so bound-Bearer auth touch() passes while pump sleeps, then re-lock for shutdown hold.
  lockDb.exec('COMMIT;')

  const msgId = `bound-drain-${randomUUID()}`
  const sendPromise = request(server.port, 'POST', `/api/rooms/${encodeURIComponent(roomId)}/messages`, {
    headers: bearerHeaders(token),
    body: JSON.stringify({
      chat_id: 'BoundDrainSender',
      client_message_id: msgId,
      text: 'must commit before LIVE_SESSION_REGISTRY.clear()',
    }),
  })

  await waitForCondition(async () => {
    const st = await fetchStatus(server.port, bearerHeaders(statusToken))
    return st.write_queue.depth >= 2
  }, { stepMs: 2, description: 'bound Bearer room send to enter write queue' })

  lockDb.exec('BEGIN IMMEDIATE;')

  let closedDone = false
  const closePromise = server.close().then(() => { closedDone = true })
  await sleep(40)
  assert.equal(closedDone, false)

  lockDb.exec('COMMIT;')
  lockDb.close()

  await closePromise
  assert.equal(closedDone, true)

  const [blockerRes, sendRes] = await Promise.all([blockerPromise, sendPromise])
  assert.equal(blockerRes.status, 200, blockerRes.text)
  assert.equal(sendRes.status, 200, sendRes.text)
  assert.equal(sendRes.json().result.status, 'committed')

  const inspector = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME), { readOnly: true })
  try {
    const row = inspector.prepare('SELECT chat_id, client_message_id FROM messages WHERE client_message_id = ?').get(msgId)
    assert.equal(row?.chat_id, 'BoundDrainSender')
    assert.equal(row?.client_message_id, msgId)
  } finally {
    inspector.close()
  }
})

test('RETENTION_AND_MIXED_GEN_HB: backdated retention fails POST /api/messages & GET /api/status (409 session_expired), and mixed gen 1 vs gen 2 queued HBs fence gen 1 independently', async t => {
  const dataDir = makeDataDir(t)
  const server = await startTestServer(t, dataDir)

  const actor = installation()
  const statusActor = installation()
  const token = await authLocal(server.port, dataDir, actor)
  const statusToken = await authLocal(server.port, dataDir, statusActor)
  const expiredSender = await allocatePrincipal(server.port, token, 'ret-expired', 'cli', 'm-ret')
  const peer = await allocatePrincipal(server.port, token, 'ret-peer', 'cli', 'm-peer')
  const hbActor = await allocatePrincipal(server.port, token, 'hb-gen', 'cli', 'm-hb-gen')

  // Backdate retention expiry while keeping principal_status = 'retained'.
  const pastIso = new Date(Date.now() - 60_000).toISOString()
  const lockDb = openLockConnection(dataDir)
  t.after(() => { try { lockDb.close() } catch { /* ignore */ } })
  lockDb.prepare('UPDATE session_principals SET principal_retention_expires_at = ? WHERE session_id = ?').run(
    pastIso,
    expiredSender.session_id,
  )

  const expiredStatusRes = await request(server.port, 'GET', '/api/status', {
    headers: sessionHeaders(expiredSender.session_capability),
  })
  assert.equal(expiredStatusRes.status, PUBLIC_ERROR_STATUS.session_expired, expiredStatusRes.text)
  assert.equal(expiredStatusRes.json().error.code, 'session_expired')

  const expiredMsgRes = await request(server.port, 'POST', '/api/messages', {
    headers: sessionHeaders(expiredSender.session_capability),
    body: JSON.stringify({
      to: peer.address,
      client_message_id: `expired-ret-${randomUUID()}`,
      text: 'should fail retention check',
    }),
  })
  assert.equal(expiredMsgRes.status, PUBLIC_ERROR_STATUS.session_expired, expiredMsgRes.text)
  assert.equal(expiredMsgRes.json().error.code, 'session_expired')

  // Mixed-generation concurrent heartbeats: gen 1 queued before resume, gen 2 queued before batch 2 runs.
  lockDb.exec('BEGIN IMMEDIATE;')
  const blockerPromise = request(server.port, 'POST', '/api/messages', {
    headers: sessionHeaders(hbActor.session_capability),
    body: JSON.stringify({
      to: peer.address,
      client_message_id: `blocker-${randomUUID()}`,
      text: 'hold pump active in backoff',
    }),
  })
  await waitForCondition(async () => {
    const st = await fetchStatus(server.port, bearerHeaders(statusToken))
    return st.write_queue.depth === 1 && st.write_queue.busy_retries_total >= 4
  }, { stepMs: 5, description: 'blocker write to enter 200ms backoff window' })

  const gen1Promise = request(server.port, 'POST', '/api/session-principals/heartbeat', {
    headers: sessionHeaders(hbActor.session_capability),
    body: JSON.stringify({ session_id: hbActor.session_id, generation: 1 }),
  })
  await waitForCondition(async () => {
    const st = await fetchStatus(server.port, bearerHeaders(statusToken))
    return st.write_queue.depth === 2
  }, { stepMs: 2, description: 'gen 1 heartbeat to enqueue behind sleeping batch' })

  lockDb.exec('COMMIT;')
  lockDb.close()

  const resumeRes = await request(server.port, 'POST', '/api/session-principals/resume', {
    headers: sessionHeaders(hbActor.session_capability),
    body: JSON.stringify({ session_id: hbActor.session_id, generation: 1 }),
  })
  assert.equal(resumeRes.status, 200, resumeRes.text)
  assert.equal(resumeRes.json().result.generation, 2)
  const gen2Capability = resumeRes.json().result.session_capability

  const gen2Promise = request(server.port, 'POST', '/api/session-principals/heartbeat', {
    headers: sessionHeaders(gen2Capability),
    body: JSON.stringify({ session_id: hbActor.session_id, generation: 2 }),
  })

  const [blockerRes, gen1Res, gen2Res] = await Promise.all([blockerPromise, gen1Promise, gen2Promise])
  assert.equal(blockerRes.status, 200, blockerRes.text)
  assert.equal(gen1Res.status, 409, gen1Res.text)
  assert.equal(gen1Res.json().error.code, 'session_expired')
  assert.equal(gen2Res.status, 200, gen2Res.text)
  assert.equal(gen2Res.json().result.generation, 2)
})

test('PRE_ENQUEUE_VALIDATION_AND_HYGIENE: oversized text fails fast pre-enqueue, api-client preserves retry_after_ms on queue_full, coalesced waiter cap holds, and store.close() aborts queue timers', async t => {
  const dataDir = makeDataDir(t)
  const server = await startTestServer(t, dataDir)

  const actor = installation()
  const statusActor = installation()
  const token = await authLocal(server.port, dataDir, actor)
  const statusToken = await authLocal(server.port, dataDir, statusActor)
  await bindChatId(server.port, token, 'ValidCheck')
  const senderPrincipal = await allocatePrincipal(server.port, token, 'valid-p', 'cli', 'm-val')
  const peerPrincipal = await allocatePrincipal(server.port, token, 'valid-peer', 'cli', 'm-val-p')
  const { broadcast_room_id: roomId } = await fetchStatus(server.port, bearerHeaders(statusToken))

  const beforeStatus = await fetchStatus(server.port, bearerHeaders(statusToken))
  const oversizedText = 'x'.repeat(MESSAGE_TEXT_MAX + 1)

  const badRoomRes = await request(server.port, 'POST', `/api/rooms/${encodeURIComponent(roomId)}/messages`, {
    headers: bearerHeaders(token),
    body: JSON.stringify({
      chat_id: 'ValidCheck',
      client_message_id: `too-big-${randomUUID()}`,
      text: oversizedText,
    }),
  })
  assert.equal(badRoomRes.status, 400, badRoomRes.text)
  assert.equal(badRoomRes.json().error.code, 'invalid_text')

  const badAddressedRes = await request(server.port, 'POST', '/api/messages', {
    headers: sessionHeaders(senderPrincipal.session_capability),
    body: JSON.stringify({
      to: peerPrincipal.address,
      client_message_id: `too-big-addr-${randomUUID()}`,
      text: oversizedText,
    }),
  })
  assert.equal(badAddressedRes.status, 400, badAddressedRes.text)
  assert.equal(badAddressedRes.json().error.code, 'invalid_text')

  const afterStatus = await fetchStatus(server.port, bearerHeaders(statusToken))
  assert.equal(afterStatus.write_queue.rejected_total, beforeStatus.write_queue.rejected_total)

  // Coalesced waiter cap rejects when existing.waiters.length >= maxOps.
  const capQueue = createWriteQueue({
    maxOps: 2,
    runBatch: batch => batch.map(() => ({ ok: true, result: 'ok' })),
  })
  const w1 = capQueue.enqueue({ sessionKey: 'cap-s', coalesceKey: 'hb:cap', bytes: 0, execute: () => 'ok' })
  const w2 = capQueue.enqueue({ sessionKey: 'cap-s', coalesceKey: 'hb:cap', bytes: 0, execute: () => 'ok' })
  await assert.rejects(
    capQueue.enqueue({ sessionKey: 'cap-s', coalesceKey: 'hb:cap', bytes: 0, execute: () => 'ok' }),
    err => err?.code === 'queue_full' && err.retry_after_ms >= 1,
  )
  assert.deepEqual(await Promise.all([w1, w2]), ['ok', 'ok'])

  // api-client preserves error.retry_after_ms on 503 queue_full.
  const pluginDataDir = mkdtempSync(join(tmpdir(), 'agent-room-wq-client-'))
  t.after(() => rmSync(pluginDataDir, { recursive: true, force: true }))
  loadOrCreateKeypair(pluginDataDir)
  atomicWriteJson(join(pluginDataDir, 'config.json'), { chat_id: 'ApiClientQueueFull' })
  const client = createAgentRoomClient({ dataDir, pluginDataDir })
  t.after(() => client.release().catch(() => {}))
  await client.status()

  const lockDb = openLockConnection(dataDir)
  t.after(() => { try { lockDb.close() } catch { /* ignore */ } })
  lockDb.exec('BEGIN IMMEDIATE;')
  const blockerPromise = request(server.port, 'POST', '/api/messages', {
    headers: sessionHeaders(senderPrincipal.session_capability),
    body: JSON.stringify({
      to: peerPrincipal.address,
      client_message_id: `client-blocker-${randomUUID()}`,
      text: 'hold pump in 200ms backoff for client fillers',
    }),
  })
  await waitForCondition(async () => {
    const st = await fetchStatus(server.port, bearerHeaders(statusToken))
    return st.write_queue.depth === 1 && st.write_queue.busy_retries_total >= 4
  }, { stepMs: 5, description: 'blocker write to enter 200ms backoff window' })

  // Release SQLite lock so bound-Bearer client touch() succeeds while write queue stays paused in 200ms backoff.
  lockDb.exec('COMMIT;')
  lockDb.close()

  const fillerClientMsgs = Array.from({ length: WRITE_QUEUE_PER_SESSION_MAX }, (_, index) =>
    client.sendMessage({ roomId, clientMessageId: `fill-${index}-${randomUUID()}`, text: `fill-${index}` }),
  )
  await waitForCondition(async () => {
    const st = await fetchStatus(server.port, bearerHeaders(statusToken))
    return st.write_queue.depth >= 1 + WRITE_QUEUE_PER_SESSION_MAX
  }, { stepMs: 2, description: '16 client messages to fill per-session write queue cap' })

  await assert.rejects(
    client.sendMessage({ roomId, clientMessageId: `overflow-${randomUUID()}`, text: 'should get queue_full' }),
    err => err?.code === 'queue_full' && Number.isInteger(err.retry_after_ms) && err.retry_after_ms >= 1,
  )
  const blockerRes = await blockerPromise
  assert.equal(blockerRes.status, 200, blockerRes.text)
  await Promise.all(fillerClientMsgs)

  // Direct store.close() aborts pending write-queue timers and rejects waiters cleanly without hanging.
  const directDir = makeDataDir(t, 'agent-room-wq-direct-close-')
  const directStore = openRoomLog({ dataDir: directDir, role: 'server' })
  const directLock = openLockConnection(directDir)
  t.after(() => { try { directLock.close() } catch { /* ignore */ } })
  directLock.exec('BEGIN IMMEDIATE;')
  const abortedWrite = assert.rejects(
    directStore.enqueueWrite({
      sessionKey: 'abort-s',
      bytes: 16,
      execute: () => 'never-committed',
    }),
    err => err?.code === 'queue_full',
  )
  await sleep(120)
  const drainInFlight = directStore.drainWriteQueue()
  directStore.close()
  directLock.exec('COMMIT;')
  directLock.close()
  await abortedWrite
  const drainOutcome = await drainInFlight
  assert.equal(drainOutcome.timedOut, false)
})
