// Story 4.5 acceptance: ban by identity key.
//
// The criterion's three clauses, each proven against the real surfaces:
//
//   1. `agent-room ban <fingerprint>` / `unban <fingerprint>` are commands of
//      the CLI HOST Story 4.2 established (review MED-1) — the same bin, the
//      same JSON-lines grammar, the same stable exit codes (0 ok, 1 refusal,
//      2 usage). The store is opened directly, in process (AR-13: the
//      operator boundary is the host; no operator HTTP route exists).
//   2. When a fingerprint is banned, every send, read, or re-enroll from that
//      key is refused `banned` (403, the send-status code's HTTP face) AT
//      NEXT REQUEST, and an active long-poll is NOT held past its 20 s
//      window: the poll loop re-checks the ban gate each iteration and
//      answers the coded refusal at the next wake (≤ the 250 ms poll
//      interval) — the registry/state the poll checks, never a killed
//      connection. The re-enroll refusal lives INSIDE the enrollment
//      transaction, after the possession proof and before any use is
//      consumed (ban state leaks to no caller who cannot prove possession;
//      a banned attempt consumes nothing — not even a reattach).
//   3. Ban state survives restart. The banned_actors table is durable and
//      converges additively on open; the persistence proof here — CLI write,
//      SIGKILL, respawn, refusal — is the Epic 2 review's B1 boundary
//      closing (the survival matrix's invite/ban row is owned by 4.2/4.5).
//
// Visibility discipline: the operator CLI is a SEPARATE PROCESS from the
// server (even when the tests drive it in-process, the restart rows drive it
// as a real child), so the server's per-request store read — the authz
// stage's direct indexed query, deliberately not a cached set — is the only
// mechanism that can make a ban visible at next request. Unban deletes the
// row and traffic flows again immediately. A non-banned Actor is untouched,
// and a ban never touches history: committed messages stay readable.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  FINGERPRINT_PATTERN,
  READ_HOLD_MAX_MS,
} from '../server/constants.mjs'
import { openRoomLog, ROOM_LOG_DATABASE_FILENAME } from '../server/store/room-log.mjs'
import { startServer } from '../server/api/server.mjs'
import { createEnrollRateLimiter } from '../server/api/enroll-rate-limit.mjs'
import { loadOrCreateLocalToken } from '../server/api/local-token.mjs'
import { assemblePipeline, runPipeline } from '../server/api/pipeline.mjs'
import { AuthzStage } from '../server/api/pipeline.mjs'
import { fingerprintFromPublicKey } from '../server/keys.mjs'
import { main } from '../server/cli/agent-room.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = join(ROOT, 'server', 'api', 'server.mjs')
const CLI_ENTRY = join(ROOT, 'server', 'cli', 'agent-room.mjs')
const RUNTIME_RECORD_FILENAME = 'runtime.json'
const PROTOCOL_KEY = 'agent-room-protocol'

const sleep = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })

// Operator floors for wire tests that need throughput instead of throttling
// (deliberately far above the declared defaults — the gates still run, they
// just never refuse these workloads; Story 4.5's refusals are the authz
// stage's, and the budget stage must never preempt them in these rows).
const FLOORS_OFF = Object.freeze({
  sendTokenRefillPerSecond: 1000,
  sendTokenCapacity: 1000,
  requestBudgetPerMinute: 60000,
  requestBudgetBurst: 1000,
})

// --- Harness: dirs, installations, the store, the CLI, servers, children -------

function makeDataDir(t, prefix = 'agent-room-ban-') {
  const dataDir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  return dataDir
}

// One installation identity: a real Ed25519 keypair, the raw 32-byte public
// key, its canonical fingerprint, and the enrollment possession proof over
// the exact invite token bytes.
function installation() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const raw = spki.subarray(spki.length - 32)
  return {
    raw,
    publicKey: raw.toString('base64url'),
    fingerprint: fingerprintFromPublicKey(raw),
    signToken: token => cryptoSign(null, Buffer.from(token, 'utf8'), privateKey).toString('base64url'),
  }
}

// A stable well-formed fingerprint with no key behind it — the preemptive
// ban rows use this (a ban is about the identity, and needs no keyholder).
const FOREIGN_FINGERPRINT = `sha256:${'f'.repeat(64)}`

// The canonical ISO 8601 UTC shape every durable ban timestamp carries: the
// store normalizes through toISOString at the write (bans.mjs), so the shape
// is pinning the write path's normalization, not hoping for it.
const ISO_8601_CANONICAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/

// The CLI runs IN-PROCESS through the real dispatch with injected streams and
// directories, so the assertions see exactly the bytes a terminal would.
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
    return { stdout, stderr, exitCode: process.exitCode ?? 0 }
  } finally {
    process.exitCode = previousExitCode
  }
}

function jsonLines(text) {
  return text.split('\n').filter(lineText => lineText.length > 0).map(lineText => JSON.parse(lineText))
}

// The ban family as a REAL child process — the cross-process discipline the
// restart rows prove (the operator CLI and the server are separate processes
// over one store file).
function spawnCliChild(t, dataDir, args) {
  const child = spawn(process.execPath, [CLI_ENTRY, ...args], {
    env: { ...process.env, AGENT_ROOM_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  const settled = new Promise(resolvePromise => {
    child.on('exit', code => resolvePromise({ stdout, stderr, code }))
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit').catch(() => {})
    }
  })
  return { settled }
}

// Read-only inspection of the durable ban rows (never through the store's
// write path — the inspection asserts what is ON DISK). A data dir whose
// store file was never created has no rows.
function banRows(dataDir) {
  if (!existsSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME))) return []
  const inspector = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME), { readOnly: true })
  try {
    // node:sqlite rows have null prototypes: project to plain objects so
    // deepStrictEqual compares values, not prototypes.
    return inspector.prepare(`
      SELECT actor_fingerprint, banned_at, reason FROM banned_actors
      ORDER BY banned_at ASC, actor_fingerprint ASC
    `).all().map(row => ({ ...row }))
  } finally {
    inspector.close()
  }
}

// Small direct HTTP client: no keep-alive.
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
          resolvePromise({ status: response.statusCode, headers: response.headers, text, json: () => JSON.parse(text) })
        })
      },
    )
    req.on('error', rejectPromise)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const jsonHeaders = { [PROTOCOL_KEY]: '1', 'content-type': 'application/json; charset=utf-8' }

// In-process startServer harness over the real host and store. The enroll
// limiter is widened so enrollment rows can attempt freely; the rate-gate
// floors are widened so the refusals under test are always the authz stage's.
async function startTestServer(t, dataDir, options = {}) {
  const server = await startServer({
    dataDir,
    port: 0,
    host: '127.0.0.1',
    enrollRateLimiter: createEnrollRateLimiter({ limit: 1000 }),
    ...FLOORS_OFF,
    ...options,
  })
  t.after(() => server.close())
  return server
}

// One installed, connected session: local credential exchange (the Local
// Mode auto-enrollment path — which is deliberately NOT ban-gated: the ban
// holds at the resource boundary, and this is also how a restarted server's
// test driver re-authenticates), the Chat ID bind, and the Broadcast Room id.
// An existing installation may be passed so a reconnection after a restart
// presents the SAME key.
async function connectSession(port, dataDir, chatId, existing) {
  const actor = existing ?? installation()
  const auth = await request(port, 'POST', '/api/auth/local', {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${loadOrCreateLocalToken(dataDir)}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ public_key: actor.publicKey }),
  })
  assert.equal(auth.status, 200, auth.text)
  const sessionToken = auth.json().result.session_token
  const bound = await request(port, 'POST', '/api/session', {
    headers: { ...jsonHeaders, authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ chat_id: chatId }),
  })
  assert.equal(bound.status, 200, bound.text)
  const status = await request(port, 'GET', '/api/status', {
    headers: { ...jsonHeaders, authorization: `Bearer ${sessionToken}` },
  })
  assert.equal(status.status, 200, status.text)
  return {
    actor,
    sessionToken,
    fingerprint: actor.fingerprint,
    chatId,
    broadcastRoomId: status.json().result.broadcast_room_id,
    send(roomId, clientMessageId, text) {
      return request(port, 'POST', `/api/rooms/${roomId}/messages`, {
        headers: { ...jsonHeaders, authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({ chat_id: chatId, client_message_id: clientMessageId, text }),
      })
    },
    read(roomId, query = '') {
      return request(port, 'GET', `/api/rooms/${roomId}/messages${query}`, {
        headers: { ...jsonHeaders, authorization: `Bearer ${sessionToken}` },
      })
    },
  }
}

// A real spawned server child (the invite harness style): the process
// boundary is the evidence for the restart row.
function spawnServerChild(t, dataDir) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, AGENT_ROOM_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stderrChunks = []
  child.stderr.on('data', chunk => stderrChunks.push(chunk))
  const stderrText = () => Buffer.concat(stderrChunks).toString('utf8')
  const runtimePath = join(dataDir, RUNTIME_RECORD_FILENAME)
  // Ready means THIS child's record is on disk AND its port answers /health
  // — a predecessor's stale record (a killed server never unlinks it) must
  // never be mistaken for the new listener.
  const waitReady = async () => {
    const deadline = Date.now() + 15 * 1000
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`server child exited early (code=${child.exitCode}); stderr: ${stderrText()}`)
      }
      if (existsSync(runtimePath)) {
        try {
          const record = JSON.parse(readFileSync(runtimePath, 'utf8'))
          if (record.pid === child.pid && Number.isInteger(record.port) && record.port > 0) {
            const health = await request(record.port, 'GET', '/health').catch(() => null)
            if (health?.status === 200) return record
          }
        } catch { /* atomic rename: readers retry */ }
      }
      if (Date.now() > deadline) throw new Error(`server child never became ready; stderr: ${stderrText()}`)
      await sleep(25)
    }
  }
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit').catch(() => {})
    }
  })
  return { child, waitReady, stderrText }
}

// --- The store surface: the ban registry ----------------------------------------

test('the ban registry persists bans by fingerprint, keeps the first ban on re-ban, and answers the gate read', t => {
  const dataDir = makeDataDir(t)
  const store = openRoomLog({ dataDir })
  const fingerprint = FOREIGN_FINGERPRINT

  // The gate read before any ban: a pure read, never a row.
  assert.equal(store.isActorBanned(fingerprint), false)
  assert.deepEqual(banRows(dataDir), [])

  // A preemptive ban — no enrollment, no claim, no message anywhere — is a
  // first-class success: the ban is about the identity, not its history.
  const banned = store.banActor({ actorFingerprint: fingerprint, reason: 'abuse' })
  assert.equal(banned.actor_fingerprint, fingerprint)
  assert.match(banned.banned_at, ISO_8601_CANONICAL, 'banned_at is a canonical ISO 8601 UTC timestamp')
  assert.equal(banned.reason, 'abuse')
  assert.equal(store.isActorBanned(fingerprint), true)

  // Re-ban is idempotent: the FIRST ban's timestamp and reason stick.
  const again = store.banActor({ actorFingerprint: fingerprint, reason: 'second note' })
  assert.equal(again.banned_at, banned.banned_at)
  assert.equal(again.reason, 'abuse')
  assert.equal(banRows(dataDir).length, 1)

  // Unban deletes the row; the gate read flips immediately.
  const unbanned = store.unbanActor({ actorFingerprint: fingerprint })
  assert.equal(unbanned.actor_fingerprint, fingerprint)
  assert.equal(unbanned.removed, true)
  assert.equal(store.isActorBanned(fingerprint), false)
  assert.deepEqual(banRows(dataDir), [])

  // Unban of a key that holds no ban is already the requested state.
  const nothing = store.unbanActor({ actorFingerprint: fingerprint })
  assert.equal(nothing.removed, false)
  assert.equal(store.isActorBanned(fingerprint), false)

  // Ban without a reason stores NULL — never an empty string. The row is
  // captured once so the assertion is not a tautology on its own input.
  store.banActor({ actorFingerprint: fingerprint })
  const [nullReasonRow] = banRows(dataDir)
  assert.equal(nullReasonRow.reason, null)
  assert.equal(nullReasonRow.actor_fingerprint, fingerprint)
  assert.match(nullReasonRow.banned_at, ISO_8601_CANONICAL)
  store.close()
})

test('the ban registry refuses malformed identities and reasons with coded store errors', t => {
  const dataDir = makeDataDir(t)
  const store = openRoomLog({ dataDir })
  // The CODE is the pin (the wire face the authz-stage refusal rides); the
  // message regex rides along for readability.
  assert.throws(
    () => store.isActorBanned('not-a-fingerprint'),
    error => error.code === 'invalid_actor_id' && /sha256:/.test(error.message),
  )
  assert.throws(
    () => store.banActor({ actorFingerprint: 'sha256:NOTHEX' }),
    error => error.code === 'invalid_actor_id' && /sha256:/.test(error.message),
  )
  assert.throws(
    () => store.unbanActor({ actorFingerprint: FOREIGN_FINGERPRINT.toUpperCase() }),
    error => error.code === 'invalid_actor_id' && /sha256:/.test(error.message),
  )
  assert.throws(
    () => store.banActor({ actorFingerprint: FOREIGN_FINGERPRINT, reason: '   ' }),
    error => error.code === 'invalid_request' && /reason/.test(error.message),
  )
  assert.throws(
    () => store.banActor({ actorFingerprint: FOREIGN_FINGERPRINT, reason: 42 }),
    error => error.code === 'invalid_request' && /reason/.test(error.message),
  )
  assert.equal(store.isActorBanned(FOREIGN_FINGERPRINT), false, 'refused writes store nothing')
  store.close()
})

test('the banned_actors CHECK constraint refuses non-canonical keys at the storage layer', t => {
  const dataDir = makeDataDir(t)
  // Materialize the schema through the store's own open path, then go under
  // it: a raw handle INSERTs directly, bypassing requireFingerprint — the
  // only way to prove the CHECK constraint (the constants pattern's storage
  // face) is real and not redundant with the module's argv-shaped guard.
  const store = openRoomLog({ dataDir })
  store.close()
  const raw = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME))
  try {
    const insert = raw.prepare(`
      INSERT INTO banned_actors (actor_fingerprint, banned_at, reason)
      VALUES (?, ?, ?)
    `)
    // Uppercase hex, an uppercase prefix, and a short hex tail: each is a
    // CHECK violation — a decorated spelling could not insert even if a
    // future writer bypassed requireFingerprint.
    for (const bad of [
      `sha256:${'A'.repeat(64)}`,
      `SHA256:${'a'.repeat(64)}`,
      `sha256:${'a'.repeat(63)}`,
    ]) {
      assert.throws(
        () => insert.run(bad, '2026-09-30T00:00:00.000Z', null),
        error => /CHECK constraint failed/.test(error.message),
        bad,
      )
    }
    // The canonical shape inserts — the constraint admits exactly the key
    // the constants module defines.
    insert.run(`sha256:${'b'.repeat(64)}`, '2026-09-30T00:00:00.000Z', null)
    assert.equal(
      raw.prepare('SELECT count(*) AS count FROM banned_actors').get().count,
      1,
      'only the canonical insert landed',
    )
  } finally {
    raw.close()
  }
})

test('ban state survives close and reopen — the store restart (B1)', t => {
  const dataDir = makeDataDir(t)
  const fingerprint = FOREIGN_FINGERPRINT

  const first = openRoomLog({ dataDir })
  first.banActor({ actorFingerprint: fingerprint, reason: 'sticks' })
  assert.equal(first.isActorBanned(fingerprint), true)
  first.close()

  const second = openRoomLog({ dataDir })
  assert.equal(second.isActorBanned(fingerprint), true, 'the ban row outlived the connection')
  second.unbanActor({ actorFingerprint: fingerprint })
  second.close()

  const third = openRoomLog({ dataDir })
  assert.equal(third.isActorBanned(fingerprint), false, 'the unban outlived the connection too')
  third.close()
})

test('the banned_actors table converges additively on open and refuses a divergent shape', t => {
  const dataDir = makeDataDir(t)
  const fingerprint = FOREIGN_FINGERPRINT

  const readUserVersion = () => {
    const raw = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME), { readOnly: true })
    try {
      return raw.prepare('PRAGMA user_version').get().user_version
    } finally {
      raw.close()
    }
  }

  // A v2 store from before this story's table (or any earlier build): the
  // open path converges the missing table additively, no version bump.
  const first = openRoomLog({ dataDir })
  first.close()
  const versionBefore = readUserVersion()
  const dropper = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME))
  dropper.exec('DROP TABLE banned_actors;')
  dropper.close()

  const second = openRoomLog({ dataDir })
  assert.equal(second.isActorBanned(fingerprint), false, 'the converged table is empty, not an error')
  second.banActor({ actorFingerprint: fingerprint })
  assert.equal(second.isActorBanned(fingerprint), true)
  second.close()
  assert.equal(readUserVersion(), versionBefore, 'the additive convergence bumped no schema version')

  // A foreign squatter of the name (a divergent column set) is a coded
  // schema failure at open, never a runtime surprise mid-gate — and the
  // refusal writes no schema version either.
  const squatter = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME))
  squatter.exec('DROP TABLE banned_actors;')
  squatter.exec('CREATE TABLE banned_actors (actor_fingerprint TEXT PRIMARY KEY) STRICT;')
  squatter.close()
  assert.throws(() => openRoomLog({ dataDir }), error => error.code === 'database_schema_invalid')
  assert.equal(readUserVersion(), versionBefore, 'the divergent-shape refusal bumped no schema version')
})

// --- The authz stage: structural pass-through and the per-request gate ----------

test('the authz stage refuses a banned session key and stays a structural pass-through without a ban surface', async () => {
  const stages = assemblePipeline('actor', {
    sessionVerifier: () => ({ sessionKey: 'k', actorFingerprint: FOREIGN_FINGERPRINT }),
  })

  // A context with no store (a direct assemblePipeline caller) passes — the
  // stage's gate is the store's ban surface, never an in-process set. (The
  // actor class runs the protocol stage, so the context carries the header.)
  const noStore = await runPipeline(stages, {
    method: 'GET',
    route: { class: 'actor', path: '/api/status', requestFields: [] },
    headers: { [PROTOCOL_KEY]: '1' },
    remoteAddress: '127.0.0.1',
  }, () => ({ fine: true }))
  assert.equal(noStore.ok, true, noStore.error?.message ?? noStore.reason)

  // With the ban surface present, a banned fingerprint is refused `banned`
  // before the handler; an unbanned one passes.
  const calls = []
  const gateStore = {
    isActorBanned(fingerprint) {
      calls.push(fingerprint)
      return fingerprint === FOREIGN_FINGERPRINT
    },
  }
  const context = {
    method: 'GET',
    route: { class: 'actor', path: '/api/status', requestFields: [] },
    headers: { [PROTOCOL_KEY]: '1' },
    remoteAddress: '127.0.0.1',
    session: { sessionKey: 'k', actorFingerprint: FOREIGN_FINGERPRINT },
    store: gateStore,
  }
  const refused = await runPipeline(stages, context, () => ({ never: true }))
  assert.equal(refused.ok, false)
  assert.equal(refused.code, 'banned')
  assert.equal(refused.status, 403)
  assert.deepEqual(calls, [FOREIGN_FINGERPRINT])

  // The unbanned arm at stage level: a different session fingerprint is
  // consulted by the same gate and passes — the refusal is per-fingerprint,
  // never per-request.
  const unbannedFingerprint = `sha256:${'c'.repeat(64)}`
  const unbannedStages = assemblePipeline('actor', {
    sessionVerifier: () => ({ sessionKey: 'k2', actorFingerprint: unbannedFingerprint }),
  })
  const allowed = await runPipeline(unbannedStages, {
    method: 'GET',
    route: { class: 'actor', path: '/api/status', requestFields: [] },
    headers: { [PROTOCOL_KEY]: '1' },
    remoteAddress: '127.0.0.1',
    store: gateStore,
  }, () => ({ fine: true }))
  assert.equal(allowed.ok, true, allowed.error?.message ?? allowed.reason)
  assert.deepEqual(
    calls,
    [FOREIGN_FINGERPRINT, unbannedFingerprint],
    'the gate consulted both fingerprints and banned only the first',
  )

  // A store WITHOUT the ban surface (the typeof guard) stays the structural
  // pass-through — the same direct-caller tolerance as no store at all.
  const banless = await runPipeline(unbannedStages, {
    method: 'GET',
    route: { class: 'actor', path: '/api/status', requestFields: [] },
    headers: { [PROTOCOL_KEY]: '1' },
    remoteAddress: '127.0.0.1',
    session: { sessionKey: 'k', actorFingerprint: FOREIGN_FINGERPRINT },
    store: {},
  }, () => ({ fine: true }))
  assert.equal(banless.ok, true, banless.error?.message ?? banless.reason)
})

// --- The wire: refusal at next request, every session-authenticated route -------

test('a ban lands at next request: send and read are refused banned, a non-banned peer is untouched, history is kept', async t => {
  const dataDir = makeDataDir(t)
  const server = await startTestServer(t, dataDir)
  const port = server.port

  const alice = await connectSession(port, dataDir, 'Alice')
  const bob = await connectSession(port, dataDir, 'Bob')
  const roomId = alice.broadcastRoomId
  const preBan = await alice.send(roomId, 'pre-ban-1', 'before the ban')
  assert.equal(preBan.status, 200, preBan.text)
  assert.equal(preBan.json().result.status, 'committed')

  // The operator bans Alice through the CLI host — the same bin, run while
  // the server holds its own store connection (WAL: two processes, one file).
  const cli = await runCli(dataDir, ['ban', alice.fingerprint, '--reason', 'rowdy'])
  assert.equal(cli.exitCode, 0, cli.stderr)

  // AT NEXT REQUEST: the send is refused `banned` (403 — the send-status
  // code's HTTP face), never reaching the append transaction.
  const refusedSend = await alice.send(roomId, 'post-ban-1', 'after the ban')
  assert.equal(refusedSend.status, 403, refusedSend.text)
  assert.equal(refusedSend.json().error.code, 'banned')
  assert.equal(refusedSend.json().error.message, 'this key is banned by the operator')

  // The read (long-poll route, wait_ms 0) and the other session-authenticated
  // reads answer the same code — the gate is the authz stage's, route-wide.
  const refusedRead = await alice.read(roomId)
  assert.equal(refusedRead.status, 403)
  assert.equal(refusedRead.json().error.code, 'banned')
  for (const path of ['/api/rooms', '/api/status', '/api/presence']) {
    const refused = await request(port, 'GET', path, {
      headers: { ...jsonHeaders, authorization: `Bearer ${alice.sessionToken}` },
    })
    assert.equal(refused.status, 403, `${path}: ${refused.text}`)
    assert.equal(refused.json().error.code, 'banned')
  }

  // A non-banned Actor is untouched: Bob sends, and reads the room with
  // Alice's PRE-BAN message still in it (a ban never touches history).
  const bobSend = await bob.send(roomId, 'bob-1', 'still here')
  assert.equal(bobSend.status, 200, bobSend.text)
  const bobRead = await bob.read(roomId)
  assert.equal(bobRead.status, 200, bobRead.text)
  const texts = bobRead.json().result.messages.map(message => message.text)
  assert.ok(texts.includes('before the ban'), 'the pre-ban message stays readable')
  assert.ok(!texts.includes('after the ban'), 'the refused send never committed')
})

test('the challenge route stays privilegeless-open to a banned key: a nonce is issued, ban state leaks nothing', async t => {
  const dataDir = makeDataDir(t)
  const server = await startTestServer(t, dataDir)
  const port = server.port
  const stranger = installation()
  const store = openRoomLog({ dataDir })
  store.banActor({ actorFingerprint: stranger.fingerprint })
  store.close()

  // Issuing a nonce is privilegeless (no session identity, zero state): the
  // banned key's challenge answers 200 with a nonce exactly like any other
  // well-formed key's — gating it would leak ban state to unauthenticated
  // callers, so the ban holds at the resource boundary instead.
  const challenge = await request(port, 'POST', '/api/auth/challenge', {
    headers: jsonHeaders,
    body: JSON.stringify({ public_key: stranger.publicKey }),
  })
  assert.equal(challenge.status, 200, challenge.text)
  const nonce = challenge.json().result.nonce
  assert.equal(typeof nonce, 'string')
  assert.match(nonce, /^[A-Za-z0-9_-]+$/, 'the nonce is base64url')
  assert.ok(nonce.length >= 22, `the nonce encodes at least 16 bytes (${nonce.length} chars)`)
})

test('an active long-poll terminates within its window when the key is banned mid-hold', async t => {
  const dataDir = makeDataDir(t)
  const server = await startTestServer(t, dataDir)
  const port = server.port
  const alice = await connectSession(port, dataDir, 'Alice')
  const roomId = alice.broadcastRoomId

  // A full-window hold (the 20 s bound from the constants module). The ban
  // lands ~300 ms into the hold; the poll must answer at its NEXT WAKE —
  // never run past the window, never be killed mid-connection.
  const started = Date.now()
  const pollPromise = alice.read(roomId, `?after_seq=0&wait_ms=${READ_HOLD_MAX_MS}`)
  await sleep(300)
  const store = openRoomLog({ dataDir })
  store.banActor({ actorFingerprint: alice.fingerprint })
  store.close()
  const poll = await pollPromise
  const elapsed = Date.now() - started

  assert.ok(elapsed < READ_HOLD_MAX_MS, `the poll terminated within its window (${elapsed} ms)`)
  assert.ok(elapsed < 5000, `the poll terminated at the next poll wake, not at the deadline (${elapsed} ms)`)
  assert.equal(poll.status, 403, poll.text)
  assert.equal(poll.json().error.code, 'banned')

  // A fresh poll from the banned key is refused at ADMISSION (the authz
  // stage), before the hold loop ever starts.
  const admitted = Date.now()
  const refused = await alice.read(roomId, `?after_seq=0&wait_ms=${READ_HOLD_MAX_MS}`)
  assert.equal(refused.status, 403)
  assert.equal(refused.json().error.code, 'banned')
  assert.ok(Date.now() - admitted < 5000, 'the admission refusal is immediate')
})

test('re-enroll from a banned key is refused banned after proof and before any use is consumed', async t => {
  const dataDir = makeDataDir(t)
  const server = await startTestServer(t, dataDir)
  const port = server.port

  // Mint through the store (the CLI mint receipt carries the token exactly
  // once; the store seam is the same surface), then ban the enrollee first:
  // the preemptive direction of the re-enroll gate.
  const store = openRoomLog({ dataDir })
  const invite = store.mintInvite({ uses: 1, ttlSeconds: 3600 })
  const bob = installation()
  store.banActor({ actorFingerprint: bob.fingerprint })
  store.close()

  const enroll = await request(port, 'POST', '/api/auth/enroll', {
    headers: jsonHeaders,
    body: JSON.stringify({
      invite_token: invite.token,
      public_key: bob.publicKey,
      signature: bob.signToken(invite.token),
    }),
  })
  assert.equal(enroll.status, 403, enroll.text)
  assert.equal(enroll.json().error.code, 'banned')

  // Nothing was consumed and nothing was enrolled: the failed attempt
  // rolled back into a no-op.
  const after = openRoomLog({ dataDir })
  assert.equal(after.listInvites()[0].uses_remaining, 1, 'the banned attempt consumed no use')
  assert.equal(after.isActorEnrolled(bob.fingerprint), false, 'the banned attempt enrolled nothing')
  after.close()

  // The no-leak discipline: ban state is never revealed to a caller who
  // cannot prove possession — a banned key with a broken proof answers
  // signature_invalid, the same answer any unproven key gets.
  const prober = installation()
  const store2 = openRoomLog({ dataDir })
  const invite2 = store2.mintInvite({ uses: 1, ttlSeconds: 3600 })
  store2.banActor({ actorFingerprint: prober.fingerprint })
  store2.close()
  const badProof = await request(port, 'POST', '/api/auth/enroll', {
    headers: jsonHeaders,
    body: JSON.stringify({
      invite_token: invite2.token,
      public_key: prober.publicKey,
      signature: bob.signToken(invite2.token), // a valid proof — for the WRONG key
    }),
  })
  assert.equal(badProof.status, 401, badProof.text)
  assert.equal(badProof.json().error.code, 'signature_invalid')

  // The reattach direction: a key that enrolled BEFORE the ban and retries
  // its (still valid) invite after it is refused too — every re-enroll from
  // a banned key is a `banned` refusal.
  const carol = installation()
  const store3 = openRoomLog({ dataDir })
  const invite3 = store3.mintInvite({ uses: 2, ttlSeconds: 3600 })
  store3.close()
  const firstEnroll = await request(port, 'POST', '/api/auth/enroll', {
    headers: jsonHeaders,
    body: JSON.stringify({
      invite_token: invite3.token,
      public_key: carol.publicKey,
      signature: carol.signToken(invite3.token),
    }),
  })
  assert.equal(firstEnroll.status, 200, firstEnroll.text)
  const store4 = openRoomLog({ dataDir })
  store4.banActor({ actorFingerprint: carol.fingerprint })
  store4.close()
  const reattach = await request(port, 'POST', '/api/auth/enroll', {
    headers: jsonHeaders,
    body: JSON.stringify({
      invite_token: invite3.token,
      public_key: carol.publicKey,
      signature: carol.signToken(invite3.token),
    }),
  })
  assert.equal(reattach.status, 403, reattach.text)
  assert.equal(reattach.json().error.code, 'banned')

  // The refused reattach consumed nothing either: carol's pre-ban enrollment
  // holds the only consumption row, and the budget is where it was.
  const afterReattach = openRoomLog({ dataDir })
  assert.equal(afterReattach.listInvites()[0].uses_remaining, 1, 'the refused reattach consumed no use')
  afterReattach.close()
})

test('unban restores sends and reads immediately', async t => {
  const dataDir = makeDataDir(t)
  const server = await startTestServer(t, dataDir)
  const port = server.port
  const alice = await connectSession(port, dataDir, 'Alice')
  const roomId = alice.broadcastRoomId

  assert.equal((await runCli(dataDir, ['ban', alice.fingerprint])).exitCode, 0)
  assert.equal((await alice.send(roomId, 'banned-1', 'refused')).status, 403)

  assert.equal((await runCli(dataDir, ['unban', alice.fingerprint])).exitCode, 0)
  const restored = await alice.send(roomId, 'restored-1', 'flowing again')
  assert.equal(restored.status, 200, restored.text)
  assert.equal(restored.json().result.status, 'committed')
  const read = await alice.read(roomId)
  assert.equal(read.status, 200, read.text)
})

// --- Persistence across a real server restart (B1 closed) -----------------------

test('ban state survives a full server restart: CLI child writes, SIGKILL, respawn, refusal', async t => {
  const dataDir = makeDataDir(t, 'agent-room-ban-restart-')

  // First server life: a real child, a real session, a real send.
  const first = spawnServerChild(t, dataDir)
  const firstRecord = await first.waitReady()
  const alice = await connectSession(firstRecord.port, dataDir, 'Alice')
  const preBan = await alice.send(alice.broadcastRoomId, 'pre-restart', 'still here')
  assert.equal(preBan.status, 200, preBan.text)

  // The operator bans through a REAL CLI child — a separate process from the
  // server, exactly the production discipline (AR-13).
  const banChild = spawnCliChild(t, dataDir, ['ban', alice.fingerprint, '--reason', 'restart-proof'])
  const banOutcome = await banChild.settled
  assert.equal(banOutcome.code, 0, banOutcome.stderr)
  assert.deepEqual(jsonLines(banOutcome.stdout)[0].command, 'ban')

  // The running server refuses at next request (cross-process WAL
  // visibility, no cached state).
  const refusedLive = await alice.send(alice.broadcastRoomId, 'after-ban', 'refused')
  assert.equal(refusedLive.status, 403, refusedLive.text)
  assert.equal(refusedLive.json().error.code, 'banned')

  // SIGKILL the server — the harshest possible stop — and respawn on the
  // same data dir.
  first.child.kill('SIGKILL')
  await once(first.child, 'exit')

  const second = spawnServerChild(t, dataDir)
  const secondRecord = await second.waitReady()

  // The old session died with the old process. The SAME key re-authenticates
  // through the local credential exchange (deliberately not ban-gated — the
  // ban holds at the resource boundary), and the ban refuses EVERYTHING at
  // next request: the session bind is an actor-class route like any other,
  // and the send and read refusals land at the authz stage before any
  // handler — even a session with no bound Chat ID.
  const auth = await request(secondRecord.port, 'POST', '/api/auth/local', {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${loadOrCreateLocalToken(dataDir)}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ public_key: alice.actor.publicKey }),
  })
  assert.equal(auth.status, 200, auth.text)
  const rebornToken = auth.json().result.session_token
  const bannedHeaders = { ...jsonHeaders, authorization: `Bearer ${rebornToken}` }

  const refusedBind = await request(secondRecord.port, 'POST', '/api/session', {
    headers: bannedHeaders,
    body: JSON.stringify({ chat_id: 'Alice2' }),
  })
  assert.equal(refusedBind.status, 403, refusedBind.text)
  assert.equal(refusedBind.json().error.code, 'banned')

  const status = await request(secondRecord.port, 'GET', '/api/status', {
    headers: { ...jsonHeaders, authorization: `Bearer ${rebornToken}` },
  })
  // /api/status is refused too, so the Broadcast Room id comes from the
  // pre-restart page the old session took.
  assert.equal(status.status, 403, status.text)
  const roomId = alice.broadcastRoomId
  const refusedSend = await request(secondRecord.port, 'POST', `/api/rooms/${roomId}/messages`, {
    headers: bannedHeaders,
    body: JSON.stringify({ chat_id: 'Alice', client_message_id: 'post-restart', text: 'refused' }),
  })
  assert.equal(refusedSend.status, 403, refusedSend.text)
  assert.equal(refusedSend.json().error.code, 'banned')
  const refusedRead = await request(secondRecord.port, 'GET', `/api/rooms/${roomId}/messages`, {
    headers: bannedHeaders,
  })
  assert.equal(refusedRead.status, 403)
  assert.equal(refusedRead.json().error.code, 'banned')

  // The row is on disk, verbatim, with its reason.
  const rows = banRows(dataDir)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].actor_fingerprint, alice.fingerprint)
  assert.equal(rows[0].reason, 'restart-proof')
  assert.match(rows[0].banned_at, ISO_8601_CANONICAL, 'the on-disk banned_at is canonical ISO 8601 UTC')
})

// --- The CLI family: JSON lines, exit codes, grammar ----------------------------

test('the ban family answers JSON lines with stable exit codes on the Story 4.2 host', async t => {
  const dataDir = makeDataDir(t)
  const fingerprint = FOREIGN_FINGERPRINT

  // Ban: one JSON line on stdout, exit 0, stderr empty.
  const banned = await runCli(dataDir, ['ban', fingerprint, '--reason', 'grammar'])
  assert.equal(banned.exitCode, 0, banned.stderr)
  assert.equal(banned.stderr, '')
  const [banLine] = jsonLines(banned.stdout)
  assert.equal(banned.stdout.split('\n').filter(lineText => lineText.length > 0).length, 1, 'exactly one JSON line')
  assert.equal(banLine.ok, true)
  assert.equal(banLine.command, 'ban')
  assert.equal(banLine.ban.fingerprint, fingerprint)
  assert.equal(banLine.ban.banned, true)
  assert.match(banLine.ban.banned_at, ISO_8601_CANONICAL, 'the receipt banned_at is canonical ISO 8601 UTC')
  assert.equal(banLine.ban.reason, 'grammar')

  // Re-ban: idempotent success reporting the FIRST ban's state.
  const rebanned = await runCli(dataDir, ['ban', fingerprint])
  assert.equal(rebanned.exitCode, 0, rebanned.stderr)
  const [rebanLine] = jsonLines(rebanned.stdout)
  assert.equal(rebanLine.ban.banned_at, banLine.ban.banned_at)
  assert.equal(rebanLine.ban.reason, 'grammar', 'the first reason sticks')

  // Unban: one JSON line, exit 0, the resulting state is banned:false.
  const unbanned = await runCli(dataDir, ['unban', fingerprint])
  assert.equal(unbanned.exitCode, 0, unbanned.stderr)
  assert.equal(unbanned.stderr, '')
  assert.equal(unbanned.stdout.split('\n').filter(lineText => lineText.length > 0).length, 1, 'exactly one JSON line')
  const [unbanLine] = jsonLines(unbanned.stdout)
  assert.equal(unbanLine.ok, true)
  assert.equal(unbanLine.command, 'unban')
  assert.equal(unbanLine.ban.fingerprint, fingerprint)
  assert.equal(unbanLine.ban.banned, false)

  // Unban of a key that holds no ban: already the requested state, exit 0.
  const stranger = `sha256:${'e'.repeat(64)}`
  const nothing = await runCli(dataDir, ['unban', stranger])
  assert.equal(nothing.exitCode, 0, nothing.stderr)
  assert.equal(nothing.stdout.split('\n').filter(lineText => lineText.length > 0).length, 1, 'exactly one JSON line')
  assert.equal(jsonLines(nothing.stdout)[0].ban.banned, false)

  // The store row is gone after the unban (the CLI output is the resulting
  // state, the row is the mechanism).
  assert.deepEqual(banRows(dataDir), [])

  // Help carries both commands (the family joined the 4.2 host).
  const help = await runCli(dataDir, ['help'])
  assert.equal(help.exitCode, 0, help.stderr)
  assert.match(help.stdout, /agent-room ban <fingerprint> \[--reason <text>\]/)
  assert.match(help.stdout, /agent-room unban <fingerprint>/)
})

test('the ban family refuses malformed usage with one coded JSON line on stderr and exit 2', async t => {
  const dataDir = makeDataDir(t)
  const fingerprint = FOREIGN_FINGERPRINT
  for (const [argv, code, messagePart] of [
    [['ban'], 'usage', 'expected exactly one fingerprint'],
    [['ban', 'not-a-fingerprint'], 'usage', 'is not a fingerprint'],
    [['ban', fingerprint.toUpperCase()], 'usage', 'is not a fingerprint'],
    [['ban', fingerprint, 'extra'], 'usage', 'unexpected argument'],
    [['ban', fingerprint, '--reason'], 'usage', '--reason needs a value'],
    [['ban', fingerprint, '--why', 'x'], 'usage', 'unknown option'],
    [['unban'], 'usage', 'expected exactly one fingerprint'],
    [['unban', 'sha256:short'], 'usage', 'is not a fingerprint'],
    [['unban', fingerprint, '--reason', 'x'], 'usage', 'unexpected argument'],
  ]) {
    const outcome = await runCli(dataDir, argv)
    assert.equal(outcome.exitCode, 2, `${JSON.stringify(argv)}: ${outcome.stderr}`)
    assert.equal(outcome.stdout, '', `${JSON.stringify(argv)}: nothing on stdout`)
    const [errorLine] = jsonLines(outcome.stderr)
    assert.equal(errorLine.ok, false, JSON.stringify(argv))
    assert.equal(errorLine.code, code, JSON.stringify(argv))
    assert.match(errorLine.message, new RegExp(messagePart), JSON.stringify(argv))
  }

  // No store row was written by any refused invocation — and stronger: the
  // argv gate runs BEFORE the store opens, so no store file exists at all.
  assert.deepEqual(banRows(dataDir), [])
  assert.equal(
    existsSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME)),
    false,
    'the family never opened the store for a refused argv',
  )
})

test('the ban family answers a coded store failure on the refusal leg: exit 1, one JSON line on stderr', async t => {
  // Valid argv, a store path that cannot open: openRoomLog throws the coded
  // data_directory_invalid, the family's catch maps it to status:'refusal',
  // and the host's single JSON-error printer answers exactly one coded line
  // on stderr with exit 1 — the grammar's third leg, after ok (0) and
  // usage (2).
  const parent = makeDataDir(t)
  const notADirectory = join(parent, 'not-a-directory')
  writeFileSync(notADirectory, 'a regular file, never a data dir')
  const outcome = await runCli(notADirectory, ['ban', FOREIGN_FINGERPRINT, '--reason', 'broken store'])
  assert.equal(outcome.exitCode, 1, outcome.stderr)
  assert.equal(outcome.stdout, '')
  const errorLines = jsonLines(outcome.stderr)
  assert.equal(errorLines.length, 1, 'exactly one JSON line on stderr')
  assert.equal(errorLines[0].ok, false)
  assert.equal(errorLines[0].command, 'ban')
  assert.equal(errorLines[0].code, 'data_directory_invalid')
  assert.ok(errorLines[0].message.length > 0)
})

test('the canonical fingerprint shape the CLI gate enforces is the constants pattern', () => {
  // The grammar gate cites FINGERPRINT_PATTERN — the same shape the store's
  // CHECK constraint and the session principal carry. Pinned here so the
  // CLI can never drift into accepting a decorated spelling the store
  // refuses.
  assert.match(FOREIGN_FINGERPRINT, FINGERPRINT_PATTERN)
  assert.equal(FINGERPRINT_PATTERN.test('sha256:' + 'A'.repeat(64)), false, 'uppercase hex is not canonical')
  assert.equal(FINGERPRINT_PATTERN.test('SHA256:' + 'a'.repeat(64)), false, 'an uppercase prefix is not canonical')
})
