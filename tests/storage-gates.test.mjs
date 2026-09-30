// Story 4.6 acceptance: storage admission control.
//
// The criterion's clauses, each proven against the real surfaces:
//
//   1. Free space below the warn reserve (default 1 GiB) makes the
//      `capacity` command on the CLI HOST Story 4.2 established (review
//      MED-1) warn; below the refuse reserve (default 256 MiB) new appends
//      are refused with the coded `storage_low`. The thresholds are tunable
//      capacity RESERVES (startServer overrides + the AGENT_ROOM_STORAGE_*
//      env knobs), never retention quotas — nothing in this module or the
//      store can delete a committed message.
//   2. A refused (or disk-full) send is EXPLICIT and never acknowledged:
//      the send route answers 200 with {status:'storage_low'} — the FR-17
//      status, not an error envelope and never a commit — the store rolls
//      back having written nothing, sequences are not consumed (the gap-free
//      next append proves it after a restart), an exact retry of an
//      already-committed message keeps resolving to its original below the
//      refuse reserve (the gate is ordered after the idempotency lookup and
//      the duplicate gate, so refusal never drops or alters accepted work),
//      and reads continue wherever storage can serve them (reads are never
//      gated anywhere).
//   3. The backup/restore + disk-expansion guide exists
//      (docs/self-hosting-storage.md) and names its required sections.
//
// Mechanism discipline: the free-space source is INJECTABLE
// (storageFreeBytesFn) at every layer — store, server, and tests — so a full
// disk is simulated without filling a real one, and the real source (one
// statfs of the data directory) is proven against the real filesystem in its
// own row. The warn is rate-limited to one line per minute per store
// connection on the append's own injectable clock.

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, statfsSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  FINGERPRINT_PATTERN,
  READ_PAGE_MAX,
  STORAGE_REFUSE_FREE_BYTES,
  STORAGE_WARN_FREE_BYTES,
  STORAGE_WARN_INTERVAL_MS,
} from '../server/constants.mjs'
import { AgentRoomRuntimeError } from '../server/runtime.mjs'
import { openRoomLog, ROOM_LOG_DATABASE_FILENAME } from '../server/store/room-log.mjs'
import {
  capacityOf,
  createStorageAdmissionGate,
  resolveStorageThresholds,
  statfsFreeBytes,
  storageThresholdsFromEnv,
} from '../server/store/storage-gate.mjs'
import { startServer } from '../server/api/server.mjs'
import { createEnrollRateLimiter } from '../server/api/enroll-rate-limit.mjs'
import { loadOrCreateLocalToken } from '../server/api/local-token.mjs'
import { fingerprintFromPublicKey } from '../server/keys.mjs'
import { main } from '../server/cli/agent-room.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Byte sizes derive from the declared constants (AD-9: no restated limits —
// the literals scan would flag 1024-based spellings in this file anyway).
const GIB = STORAGE_WARN_FREE_BYTES
const REFUSE = STORAGE_REFUSE_FREE_BYTES
const MIB = REFUSE / 256
const HALF_GIB = GIB / 2

// --- Harness: dirs, installations, the store, the CLI, servers -----------------

function makeDataDir(t, prefix = 'agent-room-storage-') {
  const dataDir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  return dataDir
}

function installation() {
  const { publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const raw = spki.subarray(spki.length - 32)
  return {
    publicKey: raw.toString('base64url'),
    fingerprint: fingerprintFromPublicKey(raw),
  }
}

// A stable well-formed fingerprint with no key behind it (not used for sends —
// sends ride a real session — but keeps the harness shape honest).
const FOREIGN_FINGERPRINT = `sha256:${'f'.repeat(64)}`

// Read-only inspection of the durable log rows (never through the store's
// write path — the inspection asserts what is ON DISK).
function messageRows(dataDir) {
  if (!existsSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME))) return []
  const inspector = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME), { readOnly: true })
  try {
    return inspector.prepare('SELECT room_id, seq, client_message_id FROM messages ORDER BY room_id, seq')
      .all()
      .map(row => ({ ...row }))
  } finally {
    inspector.close()
  }
}

// A store whose free-space source and warn sink are the test's to drive.
// `free` may be a number (constant) or a function for per-append control.
function openGatedStore(t, dataDir, { free, warn, ...options } = {}) {
  const freeBytesFn = typeof free === 'function' ? free : () => free
  const warnings = []
  const store = openRoomLog({
    dataDir,
    storageFreeBytesFn: freeBytesFn,
    storageWarn: warn ?? (line => warnings.push(line)),
    ...options,
  })
  t.after(() => store.close())
  return { store, warnings }
}

const BROADCAST = { chatId: 'Seeder', fingerprint: FOREIGN_FINGERPRINT }

// A room to append into, via the implicit Broadcast Room bootstrap.
function seedRoom(store) {
  const room = store.ensureBroadcastRoom()
  return room.id
}

function append(store, roomId, clientMessageId, text, extras = {}) {
  return store.appendMessage({
    roomId,
    actorFingerprint: BROADCAST.fingerprint,
    chatId: BROADCAST.chatId,
    clientMessageId,
    text,
    ...extras,
  })
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

const jsonHeaders = { 'agent-room-protocol': '1', 'content-type': 'application/json; charset=utf-8' }

// Operator floors for wire tests that need throughput instead of throttling
// (the storage refusals under test must never be preempted by a rate gate).
const FLOORS_OFF = Object.freeze({
  sendTokenRefillPerSecond: 1000,
  sendTokenCapacity: 1000,
  requestBudgetPerMinute: 60000,
  requestBudgetBurst: 1000,
})

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

// One installed, connected session (the ban harness's shape): local
// credential exchange, Chat ID bind, the Broadcast Room id, and send/read
// helpers.
async function connectSession(port, dataDir, chatId) {
  const actor = installation()
  const auth = await request(port, 'POST', '/api/auth/local', {
    headers: {
      'agent-room-protocol': '1',
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

// The CLI runs IN-PROCESS through the real dispatch with injected streams,
// directories, and env, so the assertions see exactly the bytes a terminal
// would.
async function runCli(t, dataDir, argv, { env = {} } = {}) {
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
      env,
    })
    return { stdout, stderr, exitCode: process.exitCode ?? 0 }
  } finally {
    process.exitCode = previousExitCode
  }
}

function jsonLines(text) {
  return text.split('\n').filter(lineText => lineText.length > 0).map(lineText => JSON.parse(lineText))
}

// --- The gate module: threshold resolution, capacity states, the gate ----------

test('resolveStorageThresholds accepts reserves, requires refuse <= warn, and rejects junk', () => {
  assert.deepEqual(resolveStorageThresholds({ warnFreeBytes: GIB, refuseFreeBytes: REFUSE }), {
    warnFreeBytes: GIB,
    refuseFreeBytes: REFUSE,
  })
  // A reserve of 0 disables that level (free space is never below zero).
  assert.deepEqual(resolveStorageThresholds({ warnFreeBytes: 0, refuseFreeBytes: 0 }), {
    warnFreeBytes: 0,
    refuseFreeBytes: 0,
  })
  for (const [warnFreeBytes, refuseFreeBytes] of [
    [-1, 0], [0, -1], [1.5, 0], [Number.MAX_SAFE_INTEGER + 1, 0], ['x', 0], [undefined, 0],
  ]) {
    assert.throws(
      () => resolveStorageThresholds({ warnFreeBytes, refuseFreeBytes }),
      error => error.code === 'invalid_argument',
      `${warnFreeBytes}/${refuseFreeBytes}`,
    )
  }
  assert.throws(
    () => resolveStorageThresholds({ warnFreeBytes: REFUSE, refuseFreeBytes: GIB }),
    error => error.code === 'invalid_argument' && /must not exceed/.test(error.message),
    'the refuse reserve cannot sit above the warning reserve',
  )
})

test('capacityOf derives exactly three states and admits_appends only above the refuse reserve', () => {
  assert.deepEqual(capacityOf({ freeBytes: GIB, warnFreeBytes: GIB, refuseFreeBytes: REFUSE }), { state: 'ok', admitsAppends: true })
  assert.deepEqual(capacityOf({ freeBytes: GIB - 1, warnFreeBytes: GIB, refuseFreeBytes: REFUSE }), { state: 'warn', admitsAppends: true })
  assert.deepEqual(capacityOf({ freeBytes: REFUSE, warnFreeBytes: GIB, refuseFreeBytes: REFUSE }), { state: 'warn', admitsAppends: true })
  assert.deepEqual(capacityOf({ freeBytes: REFUSE - 1, warnFreeBytes: GIB, refuseFreeBytes: REFUSE }), { state: 'refuse', admitsAppends: false })
  assert.deepEqual(capacityOf({ freeBytes: 0, warnFreeBytes: GIB, refuseFreeBytes: REFUSE }), { state: 'refuse', admitsAppends: false })
})

test('the gate refuses below the refuse reserve, warns between reserves, and passes above', () => {
  let free = HALF_GIB
  const warnings = []
  const gate = createStorageAdmissionGate({
    dataDir: '/data',
    warnFreeBytes: GIB,
    refuseFreeBytes: REFUSE,
    freeBytesFn: () => free,
    warn: line => warnings.push(line),
  })

  // Above the warn reserve: a no-op that names the state.
  free = 2 * GIB
  assert.deepEqual(gate.check(1000), { freeBytes: 2 * GIB, state: 'ok', admitsAppends: true })
  assert.deepEqual(warnings, [])

  // Between the reserves: admits, and warns once — the line names the free
  // bytes and both reserves.
  free = HALF_GIB
  assert.deepEqual(gate.check(1000), { freeBytes: HALF_GIB, state: 'warn', admitsAppends: true })
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], /storage_low warning/)
  assert.match(warnings[0], new RegExp(`${HALF_GIB} bytes`))
  assert.match(warnings[0], new RegExp(`warning reserve of ${GIB} bytes`))
  assert.match(warnings[0], new RegExp(`refuse reserve of ${REFUSE} bytes`))

  // At the refuse reserve exactly: still warn-zone (strictly below refuses).
  free = REFUSE
  assert.equal(gate.check(2000).state, 'warn')
  assert.equal(warnings.length, 1, 'the second append inside the interval warns again NOT — once per minute')

  // Below the refuse reserve: the coded storage_low, never a warn.
  free = REFUSE - 1
  assert.throws(() => gate.check(3000), error => error instanceof AgentRoomRuntimeError && error.code === 'storage_low')
  assert.equal(warnings.length, 1)

  // The snapshot is the same observation without the refusal.
  assert.deepEqual(gate.snapshot(), { freeBytes: REFUSE - 1, state: 'refuse', admitsAppends: false })
})

test('the gate warn rate limit is one line per interval on the injected clock', () => {
  let free = HALF_GIB
  const warnings = []
  const gate = createStorageAdmissionGate({
    dataDir: '/data',
    warnFreeBytes: GIB,
    refuseFreeBytes: REFUSE,
    freeBytesFn: () => free,
    warn: line => warnings.push(line),
  })
  gate.check(1000)
  gate.check(STORAGE_WARN_INTERVAL_MS - 1 + 1000) // one millisecond inside the window
  assert.equal(warnings.length, 1)
  gate.check(STORAGE_WARN_INTERVAL_MS + 1000) // the window has rolled
  assert.equal(warnings.length, 2)
  // A clock that is not a finite epoch-ms number is a coded internal failure.
  assert.throws(() => gate.check(Number.NaN), error => error.code === 'invalid_argument')
  // A free-space source that answers junk is a coded internal failure, never
  // a silent admission on a broken observation.
  const broken = createStorageAdmissionGate({
    dataDir: '/data',
    freeBytesFn: () => Number.NaN,
  })
  assert.throws(() => broken.check(1000), error => error.code === 'invalid_argument')
  const negative = createStorageAdmissionGate({
    dataDir: '/data',
    freeBytesFn: () => -5,
  })
  assert.throws(() => negative.check(1000), error => error.code === 'invalid_argument')
})

// --- The append path: the gate inside the store's transaction -------------------

test('below the refuse reserve a new append is refused storage_low and writes nothing', t => {
  const dataDir = makeDataDir(t)
  let free = 2 * GIB
  const { store, warnings } = openGatedStore(t, dataDir, { free: () => free })
  const roomId = seedRoom(store)

  const committed = append(store, roomId, 'pre-1', 'committed while space remained')
  assert.equal(committed.duplicate, false)
  assert.equal(committed.message.seq, 1)
  assert.deepEqual(warnings, [], 'above the warn reserve nothing is emitted')

  free = REFUSE - 1
  assert.throws(
    () => append(store, roomId, 'refused-1', 'never committed'),
    error => error instanceof AgentRoomRuntimeError
      && error.code === 'storage_low'
      && /message was not committed/.test(error.message),
  )
  assert.deepEqual(warnings, [], 'a refusal is explicit; it is not a warn')

  // The refused append wrote nothing and consumed no sequence.
  assert.equal(store.headSeq(roomId), 1)
  assert.deepEqual(messageRows(dataDir).map(row => row.client_message_id), ['pre-1'])

  // The gap-free proof: with space back, the NEXT append takes seq 2 — the
  // refusal did not burn a sequence.
  free = 2 * GIB
  const after = append(store, roomId, 'after-1', 'next commit')
  assert.equal(after.message.seq, 2)
})

test('below the refuse reserve accepted work keeps resolving: retries, duplicate drops, and reads', t => {
  const dataDir = makeDataDir(t)
  let free = 2 * GIB
  const { store } = openGatedStore(t, dataDir, { free: () => free })
  const roomId = seedRoom(store)
  const original = append(store, roomId, 'original-1', 'the accepted message')

  free = REFUSE - 1

  // An exact retry of the accepted message resolves from the idempotency
  // tuple BEFORE the gate: the original returns, nothing is re-refused.
  const retry = append(store, roomId, 'original-1', 'the accepted message')
  assert.equal(retry.duplicate, true)
  assert.equal(retry.message.seq, original.message.seq)

  // A NEW send repeating the same payload inside the duplicate window is the
  // duplicate gate's drop — a non-writing resolution that never reaches the
  // storage gate either (refusal never drops accepted work, and the drop
  // allocates nothing).
  const drop = append(store, roomId, 'duplicate-drop-1', 'the accepted message', { nowMs: Date.now() })
  assert.equal(drop.duplicateDropped, true)
  assert.equal(drop.original.seq, original.message.seq)

  // A genuinely new append is still refused.
  assert.throws(() => append(store, roomId, 'refused-2', 'something else'),
    error => error.code === 'storage_low')

  // Reads continue wherever storage can serve them: page and head answer.
  assert.equal(store.readPage({ roomId, actorFingerprint: BROADCAST.fingerprint, afterSeq: 0, limit: READ_PAGE_MAX }).length, 1)
  assert.equal(store.headSeq(roomId), 1)
})

test('between the reserves appends commit and the warn line is emitted once per minute on the append clock', t => {
  const dataDir = makeDataDir(t)
  const { store, warnings } = openGatedStore(t, dataDir, { free: HALF_GIB })
  const roomId = seedRoom(store)

  const first = append(store, roomId, 'warn-1', 'still commits, one', { nowMs: 1000 })
  assert.equal(first.message.seq, 1, 'the warn never refuses')
  assert.equal(warnings.length, 1)
  assert.match(warnings[0], new RegExp(RegExp.escape(dataDir)))
  assert.match(warnings[0], /below the warning reserve/)

  const second = append(store, roomId, 'warn-2', 'still commits, two', { nowMs: 1000 + STORAGE_WARN_INTERVAL_MS - 1 })
  assert.equal(second.message.seq, 2)
  assert.equal(warnings.length, 1, 'one line per minute, not one per append')

  const third = append(store, roomId, 'warn-3', 'still commits, three', { nowMs: 1000 + STORAGE_WARN_INTERVAL_MS })
  assert.equal(third.message.seq, 3)
  assert.equal(warnings.length, 2, 'the next append after the window warns again')

  // Above the warn reserve: silent again.
  const { store: quiet } = openGatedStore(t, makeDataDir(t), { free: 2 * GIB })
  const quietRoomId = seedRoom(quiet)
  append(quiet, quietRoomId, 'quiet-1', 'plenty of space, one', { nowMs: 1000 })
  append(quiet, quietRoomId, 'quiet-2', 'plenty of space, two', { nowMs: 1000 + STORAGE_WARN_INTERVAL_MS + 1 })
})

test('openRoomLog validates the storage reserves and seams at open', t => {
  const dataDir = makeDataDir(t)
  for (const options of [
    { storageWarnFreeBytes: -1 },
    { storageRefuseFreeBytes: -1 },
    { storageWarnFreeBytes: 1.5 },
    { storageRefuseFreeBytes: GIB, storageWarnFreeBytes: REFUSE }, // refuse > warn
    { storageFreeBytesFn: 'not-a-function' },
    { storageWarn: 42 },
  ]) {
    assert.throws(() => openRoomLog({ dataDir, ...options }), error => error.code === 'invalid_argument', JSON.stringify(options))
  }
  // The validated defaults pass and consume the declared constants.
  const { store } = openGatedStore(t, dataDir, { free: 2 * GIB })
  assert.ok(store.databasePath.endsWith(ROOM_LOG_DATABASE_FILENAME))
})

test('storageThresholdsFromEnv parses the two knobs strictly and falls back per junk value', () => {
  // Absent: the declared defaults, no warnings.
  assert.deepEqual(storageThresholdsFromEnv({}), {
    storageWarnFreeBytes: GIB,
    storageRefuseFreeBytes: REFUSE,
    warnings: [],
  })
  // Valid values parse; zero is a valid reserve (disables the level).
  assert.deepEqual(storageThresholdsFromEnv({
    AGENT_ROOM_STORAGE_WARN_BYTES: String(2 * GIB),
    AGENT_ROOM_STORAGE_REFUSE_BYTES: '0',
  }), { storageWarnFreeBytes: 2 * GIB, storageRefuseFreeBytes: 0, warnings: [] })
  // Junk values warn once each and fall back to the declared default.
  const junk = storageThresholdsFromEnv({
    AGENT_ROOM_STORAGE_WARN_BYTES: 'plenty',
    AGENT_ROOM_STORAGE_REFUSE_BYTES: '-5',
  })
  assert.equal(junk.storageWarnFreeBytes, GIB)
  assert.equal(junk.storageRefuseFreeBytes, REFUSE)
  assert.equal(junk.warnings.length, 2)
  assert.match(junk.warnings[0], /AGENT_ROOM_STORAGE_WARN_BYTES/)
  assert.match(junk.warnings[1], /AGENT_ROOM_STORAGE_REFUSE_BYTES/)
})

// --- The real server: refusal over the wire, never acknowledged -----------------

test('a refused send answers 200 {status:storage_low}, is never acknowledged, and survives a restart as absent', async t => {
  const dataDir = makeDataDir(t)
  let free = 2 * GIB
  const server = await startTestServer(t, dataDir, { storageFreeBytesFn: () => free })
  const alice = await connectSession(server.port, dataDir, 'Alice')
  const roomId = alice.broadcastRoomId

  const committed = await alice.send(roomId, 'wire-1', 'committed while space remained')
  assert.equal(committed.status, 200, committed.text)
  assert.equal(committed.json().result.status, 'committed')
  assert.equal(committed.json().result.seq, 1)

  free = REFUSE - 1
  const refused = await alice.send(roomId, 'wire-never', 'the refused send')
  assert.equal(refused.status, 200, refused.text)
  const body = refused.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.result, { status: 'storage_low' }, 'the explicit, never-acknowledged notice')

  // The refused message is absent right now...
  const page = await alice.read(roomId)
  assert.equal(page.status, 200, page.text)
  const texts = page.json().result.messages.map(message => message.text)
  assert.deepEqual(texts, ['committed while space remained'])
  assert.equal(page.json().result.head_seq, 1)

  // ...and absent after a full stop and reopen of the durable store (zero
  // acknowledgment means zero rows, durably).
  await server.close()
  const reopened = openRoomLog({ dataDir })
  const rows = reopened.readPage({ roomId, actorFingerprint: alice.fingerprint, afterSeq: 0, limit: READ_PAGE_MAX })
  assert.deepEqual(rows.map(row => row.client_message_id), ['wire-1'])
  // The refusal consumed no sequence: with space restored, the next append
  // takes the gap-free next seq (2), and the REFUSED send's id is free to
  // commit under its original identity.
  const back = reopened.appendMessage({
    roomId,
    actorFingerprint: alice.fingerprint,
    chatId: 'Alice',
    clientMessageId: 'wire-never',
    text: 'the refused send',
  })
  assert.equal(back.message.seq, 2)
  reopened.close()
})

test('an exact retry of a committed message keeps resolving below the refuse reserve', async t => {
  const dataDir = makeDataDir(t)
  let free = 2 * GIB
  const server = await startTestServer(t, dataDir, { storageFreeBytesFn: () => free })
  const alice = await connectSession(server.port, dataDir, 'Alice')
  const roomId = alice.broadcastRoomId

  const original = await alice.send(roomId, 'retry-1', 'accepted before the reserve breach')
  assert.equal(original.json().result.status, 'committed')

  free = REFUSE - 1
  const retry = await alice.send(roomId, 'retry-1', 'accepted before the reserve breach')
  assert.equal(retry.status, 200, retry.text)
  assert.equal(retry.json().result.status, 'committed', 'the outcome-unknown resolution, not storage_low')
  assert.equal(retry.json().result.seq, original.json().result.seq)

  const stillRefused = await alice.send(roomId, 'retry-2', 'a new send')
  assert.equal(stillRefused.json().result.status, 'storage_low')
})

test('reads continue wherever storage can serve them while sends are refused', async t => {
  const dataDir = makeDataDir(t)
  let free = 2 * GIB
  const server = await startTestServer(t, dataDir, { storageFreeBytesFn: () => free })
  const alice = await connectSession(server.port, dataDir, 'Alice')
  const bob = await connectSession(server.port, dataDir, 'Bob')
  const roomId = alice.broadcastRoomId
  assert.equal((await alice.send(roomId, 'readable-1', 'the log stays readable')).json().result.status, 'committed')

  free = REFUSE - 1
  assert.equal((await alice.send(roomId, 'refused-read-1', 'refused')).json().result.status, 'storage_low')

  for (const session of [alice, bob]) {
    const page = await session.read(roomId, '?wait_ms=0')
    assert.equal(page.status, 200, page.text)
    assert.equal(page.json().result.messages.length, 1)
    const rooms = await request(server.port, 'GET', '/api/rooms', {
      headers: { ...jsonHeaders, authorization: `Bearer ${session.sessionToken}` },
    })
    assert.equal(rooms.status, 200, rooms.text)
  }
  const presence = await request(server.port, 'GET', '/api/presence', {
    headers: { ...jsonHeaders, authorization: `Bearer ${alice.sessionToken}` },
  })
  assert.equal(presence.status, 200, presence.text)
})

test('the server warn reaches the injected sink once per minute and commits between reserves', async t => {
  const dataDir = makeDataDir(t)
  const warnings = []
  const server = await startTestServer(t, dataDir, {
    storageFreeBytesFn: () => HALF_GIB,
    storageWarn: line => warnings.push(line),
  })
  const alice = await connectSession(server.port, dataDir, 'Alice')
  const roomId = alice.broadcastRoomId

  const first = await alice.send(roomId, 'warn-wire-1', 'commits in the warn zone')
  assert.equal(first.json().result.status, 'committed')
  const second = await alice.send(roomId, 'warn-wire-2', 'commits too, distinct text')
  assert.equal(second.json().result.status, 'committed')
  const page = await alice.read(roomId)
  assert.equal(page.json().result.messages.length, 2, 'the warn never refuses a send')

  assert.equal(warnings.length, 1, 'one warn line per minute across both sends')
  assert.match(warnings[0], /storage_low warning/)
  assert.match(warnings[0], new RegExp(RegExp.escape(dataDir)))
})

test('the default warn sink is the server process stderr, rate-limited by the wall clock', async t => {
  const dataDir = makeDataDir(t)
  const server = await startTestServer(t, dataDir, { storageFreeBytesFn: () => HALF_GIB })
  const alice = await connectSession(server.port, dataDir, 'Alice')
  const roomId = alice.broadcastRoomId

  const originalWrite = process.stderr.write
  const captured = []
  process.stderr.write = chunk => {
    captured.push(String(chunk))
    return true
  }
  try {
    const first = await alice.send(roomId, 'stderr-1', 'warns to stderr')
    assert.equal(first.json().result.status, 'committed')
    const second = await alice.send(roomId, 'stderr-2', 'is rate-limited')
    assert.equal(second.json().result.status, 'committed')
  } finally {
    process.stderr.write = originalWrite
  }
  assert.equal(captured.length, 1, 'exactly one stderr line for two immediate sends')
  assert.match(captured[0], /storage_low warning/)
})

test('startServer honors storage threshold overrides and fails malformed ones at startup', async t => {
  // Warn override above the free space, refuse override below it: the send
  // commits and the gate warns — the DECLARED warn reserve is what fired,
  // not the default (the free space is far above the default 1 GiB warn).
  {
    const dataDir = makeDataDir(t)
    const warnings = []
    const server = await startTestServer(t, dataDir, {
      storageWarnFreeBytes: 3 * GIB,
      storageRefuseFreeBytes: 2 * GIB,
      storageFreeBytesFn: () => 2.5 * GIB,
      storageWarn: line => warnings.push(line),
    })
    const alice = await connectSession(server.port, dataDir, 'Alice')
    const sent = await alice.send(alice.broadcastRoomId, 'override-1', 'above the tuned refuse reserve')
    assert.equal(sent.json().result.status, 'committed')
    assert.equal(warnings.length, 1, 'the tuned warn reserve fired where the default would not')
    await server.close()
  }
  // A tuned refuse reserve above the free space refuses where the default
  // would admit.
  {
    const dataDir = makeDataDir(t)
    const server = await startTestServer(t, dataDir, {
      storageWarnFreeBytes: 3 * GIB,
      storageRefuseFreeBytes: 2 * GIB,
      storageFreeBytesFn: () => 1.5 * GIB,
    })
    const alice = await connectSession(server.port, dataDir, 'Alice')
    const sent = await alice.send(alice.broadcastRoomId, 'override-2', 'below the tuned refuse reserve')
    assert.equal(sent.status, 200)
    assert.deepEqual(sent.json().result, { status: 'storage_low' })
    await server.close()
  }
  // Malformed overrides fail startup with the coded invalid_argument.
  const dataDir = makeDataDir(t)
  for (const options of [
    { storageWarnFreeBytes: -1 },
    { storageRefuseFreeBytes: 1.5 },
    { storageRefuseFreeBytes: GIB, storageWarnFreeBytes: REFUSE },
    { storageFreeBytesFn: 7 },
    { storageWarn: 'loud' },
  ]) {
    await assert.rejects(
      () => startServer({ dataDir, port: 0, ...options }),
      error => error.code === 'invalid_argument',
      JSON.stringify(options),
    )
  }
})

// --- The real mechanism: one statfs of the data directory -----------------------

test('the real free-space source is the answer of the filesystem holding the data directory', t => {
  const dataDir = makeDataDir(t)
  const stats = statfsSync(dataDir)
  const expected = stats.bavail * stats.bsize
  const free = statfsFreeBytes(dataDir)
  // The mechanism is one statfs: bavail (available to unprivileged writes)
  // times bsize. The live disk moves between this assertion's own two
  // observations, so exactness is pinned on the shape and the mechanism on a
  // tight relative agreement.
  assert.ok(Number.isInteger(free), `a whole number of bytes: ${free}`)
  assert.ok(Number.isFinite(free) && free > 0, `plausible: ${free} bytes free`)
  assert.ok(free < 2 ** 48, 'well below any addressable-storage absurdity')
  assert.ok(
    Math.abs(free - expected) / expected < 0.02,
    `agrees with a fresh statfs (bavail * bsize = ${expected}) on a live disk`,
  )
})

// --- The CLI host: agent-room capacity -------------------------------------------

test('agent-room capacity reports the data directory against the declared reserves', async t => {
  const dataDir = makeDataDir(t)
  const ok = await runCli(t, dataDir, ['capacity'])
  assert.equal(ok.exitCode, 0, ok.stderr)
  assert.equal(ok.stderr, '')
  assert.equal(ok.stdout.split('\n').filter(lineText => lineText.length > 0).length, 1, 'exactly one JSON line')
  const [line] = jsonLines(ok.stdout)
  assert.equal(line.ok, true)
  assert.equal(line.command, 'capacity')
  assert.equal(line.capacity.data_dir, dataDir)
  assert.ok(Number.isFinite(line.capacity.free_bytes) && line.capacity.free_bytes > 0)
  assert.equal(line.capacity.warn_free_bytes, GIB)
  assert.equal(line.capacity.refuse_free_bytes, REFUSE)
  assert.equal(line.capacity.state, 'ok')
  assert.equal(line.capacity.admits_appends, true)
  assert.equal(line.capacity.detail, undefined)

  // The warn state: exit 0 (a warning is not a refusal), detail present.
  // The warn reserve sits far above any real free space, so the state is
  // derived from the override, not the machine.
  const warn = await runCli(t, dataDir, ['capacity'], {
    env: { AGENT_ROOM_STORAGE_WARN_BYTES: String(GIB * 1024 * 64) },
  })
  assert.equal(warn.exitCode, 0, warn.stderr)
  const [warnLine] = jsonLines(warn.stdout)
  assert.equal(warnLine.capacity.state, 'warn')
  assert.equal(warnLine.capacity.admits_appends, true)
  assert.match(warnLine.capacity.detail, /below the warning reserve/)

  // The refuse state via the documented env knobs: exit 1, the report still
  // on stdout — the state field and the exit code agree.
  const refuse = await runCli(t, dataDir, ['capacity'], {
    env: {
      AGENT_ROOM_STORAGE_WARN_BYTES: String(GIB * 1024 * 128),
      AGENT_ROOM_STORAGE_REFUSE_BYTES: String(GIB * 1024 * 64),
    },
  })
  assert.equal(refuse.exitCode, 1, refuse.stderr)
  const [refuseLine] = jsonLines(refuse.stdout)
  assert.equal(refuseLine.capacity.state, 'refuse')
  assert.equal(refuseLine.capacity.admits_appends, false)
  assert.match(refuseLine.capacity.detail, /storage_low/)

  // A junk env value warns one line on stderr and falls back to the default.
  const junk = await runCli(t, dataDir, ['capacity'], { env: { AGENT_ROOM_STORAGE_REFUSE_BYTES: 'lots' } })
  assert.equal(junk.exitCode, 0, junk.stderr)
  assert.match(junk.stderr, /ignoring invalid AGENT_ROOM_STORAGE_REFUSE_BYTES/)
  assert.equal(jsonLines(junk.stdout)[0].capacity.refuse_free_bytes, REFUSE)
})

test('agent-room capacity refuses unusable surfaces with the coded grammar and usage errors with exit 2', async t => {
  const dataDir = makeDataDir(t)

  // A data directory that does not exist: coded refusal, exit 1, nothing on
  // stdout — with a recovery step in the message, never a dead end.
  const missing = await runCli(t, join(dataDir, 'not-created-yet'), ['capacity'])
  assert.equal(missing.exitCode, 1)
  assert.equal(missing.stdout, '')
  const [errorLine] = jsonLines(missing.stderr)
  assert.equal(errorLine.ok, false)
  assert.equal(errorLine.code, 'data_directory_invalid')
  assert.match(errorLine.message, /does not exist yet; start the server once to create it/)

  // Usage: any argument is refused, exit 2.
  const usage = await runCli(t, dataDir, ['capacity', 'extra'])
  assert.equal(usage.exitCode, 2)
  assert.equal(usage.stdout, '')
  const [usageLine] = jsonLines(usage.stderr)
  assert.equal(usageLine.ok, false)
  assert.equal(usageLine.code, 'usage')

  // Help carries the command (the family joined the 4.2 host).
  const help = await runCli(t, dataDir, ['help'])
  assert.equal(help.exitCode, 0, help.stderr)
  assert.match(help.stdout, /agent-room capacity/)
  assert.match(help.stdout, /self-hosting-storage\.md/)
})

// --- The guide -------------------------------------------------------------------

test('the backup/restore + disk-expansion guide exists and names its required sections', () => {
  const guidePath = join(ROOT, 'docs', 'self-hosting-storage.md')
  assert.equal(existsSync(guidePath), true, 'docs/self-hosting-storage.md is the AC deliverable')
  const guide = readFileSync(guidePath, 'utf8')
  for (const [name, pattern] of [
    ['backing up', /## 2\. Backing up/],
    ['restore', /## 3\. Restoring/],
    ['disk expansion', /## 4\. Disk expansion/],
    ['the storage_low face', /storage_low/],
    ['the capacity command', /agent-room capacity/],
    ['the env knobs', /AGENT_ROOM_STORAGE_WARN_BYTES/],
    ['the reserves-never-quotas rule', /never retention quotas/],
    ['the stop-copy-restart discipline', /stop, copy, restart/],
    ['failure modes', /Failure modes/],
  ]) {
    assert.match(guide, pattern, `the guide must name: ${name}`)
  }
})

test('the canonical fingerprint shape stays the constants pattern (harness sanity)', () => {
  assert.match(FOREIGN_FINGERPRINT, FINGERPRINT_PATTERN)
})
