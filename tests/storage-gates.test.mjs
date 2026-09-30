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
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, statfsSync, writeFileSync } from 'node:fs'
import { generateKeyPairSync } from 'node:crypto'
import http from 'node:http'
import { once } from 'node:events'
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

// Page ceilings for the disk-full simulation (matrix row 7): the store's
// open-time maxPageCount seam caps the connection's database pages, so the
// NEXT page allocation answers SQLITE_FULL (errcode 13) — the same result
// code a genuinely full filesystem produces — while the injected free-space
// source stays far above the refuse reserve. The mapping under test is the
// race case: the gate passed, and the WRITE hit the full disk.
const DISK_FULL_PAGES = 28

function largeText(seed, size = 3000) {
  return `${seed}-`.padEnd(size, seed)
}

test('a disk-full write at the insert (SQLITE_FULL) maps to the same coded storage_low after the rollback', t => {
  const dataDir = makeDataDir(t)
  // The gate admits (free space far above every reserve); the disk fills
  // UNDER the write, which is the race window the mapping exists to close.
  const { store, warnings } = openGatedStore(t, dataDir, { free: 2 * GIB, maxPageCount: DISK_FULL_PAGES })
  const roomId = seedRoom(store)

  let committed = 0
  let mappedRefusal = null
  for (let attempt = 0; attempt < 64; attempt++) {
    try {
      const outcome = append(store, roomId, `full-${attempt}`, largeText(`filler-${attempt}`))
      assert.equal(outcome.duplicate, false)
      assert.equal(outcome.duplicateDropped, false)
      committed += 1
    } catch (error) {
      mappedRefusal = error
      break
    }
  }
  assert.ok(mappedRefusal, 'the page ceiling must fill within the bounded loop')
  assert.ok(committed >= 1, 'at least one message committed before the ceiling')

  // The refusal is the MAPPED coded storage_low — the disk-full variant of
  // the message (the gate's own refusal names the refuse reserve; this one
  // names the disk), and the warn sink stayed silent because the gate never
  // fired: the free-space source was above every reserve the whole time.
  assert.ok(mappedRefusal instanceof AgentRoomRuntimeError)
  assert.equal(mappedRefusal.code, 'storage_low')
  assert.match(mappedRefusal.message, /disk holding the agent-room data directory is full/)
  assert.doesNotMatch(mappedRefusal.message, /below the refuse reserve/)
  assert.deepEqual(warnings, [], 'the disk-full write is not the gate refusal — the source stayed above the reserves')

  // The rollback wrote nothing: the log is exactly the committed prefix, the
  // head did not move, and no sequence was consumed.
  const headBefore = store.headSeq(roomId)
  const ids = messageRows(dataDir).map(row => row.client_message_id)
  assert.deepEqual(ids, Array.from({ length: committed }, (_, index) => `full-${index}`))
  assert.equal(headBefore, committed)

  // A further NEW append is still refused (the disk is still full), and an
  // exact retry of a COMMITTED message keeps resolving from reads.
  assert.throws(
    () => append(store, roomId, `full-after-${committed}`, largeText('filler-after')),
    error => error.code === 'storage_low' && /disk holding/.test(error.message),
  )
  const retry = append(store, roomId, 'full-0', largeText('filler-0'))
  assert.equal(retry.duplicate, true, 'accepted work keeps resolving below the full disk')

  // Recovery: a fresh connection without the ceiling (space "freed") takes
  // the gap-free next sequence — the failed transaction consumed nothing.
  store.close()
  const reopened = openRoomLog({ dataDir })
  t.after(() => reopened.close())
  const after = reopened.appendMessage({
    roomId,
    actorFingerprint: BROADCAST.fingerprint,
    chatId: BROADCAST.chatId,
    clientMessageId: 'after-recovery',
    text: 'the next commit after space returned',
  })
  assert.equal(after.message.seq, committed + 1)
})

test('a disk-full send over the wire answers 200 {status:storage_low}, never a raw SQLite error', async t => {
  const dataDir = makeDataDir(t)
  const server = await startTestServer(t, dataDir, {
    storageFreeBytesFn: () => 2 * GIB,
    maxPageCount: 40,
  })
  const alice = await connectSession(server.port, dataDir, 'Alice')
  const roomId = alice.broadcastRoomId

  let refusedResponse = null
  let refusedText = null
  let committedCount = 0
  for (let attempt = 0; attempt < 64; attempt++) {
    const text = largeText(`wire-filler-${attempt}`, 6000)
    const sent = await alice.send(roomId, `wire-full-${attempt}`, text)
    if (sent.json().result?.status === 'storage_low') {
      refusedResponse = sent
      refusedText = text
      break
    }
    assert.equal(sent.status, 200, sent.text)
    assert.equal(sent.json().result.status, 'committed')
    committedCount += 1
  }
  assert.ok(refusedResponse, 'the ceiling must fill within the bounded loop')
  assert.ok(committedCount >= 1)

  // The explicit, never-acknowledged 200 result — the same face the gate's
  // refusal answers, never an error envelope and never a raw SQLite error.
  assert.equal(refusedResponse.status, 200, refusedResponse.text)
  const body = refusedResponse.json()
  assert.equal(body.ok, true)
  assert.deepEqual(body.result, { status: 'storage_low' })

  // No acknowledgment, durably: the refused text is absent from the page,
  // and after a full server stop a fresh store connection shows exactly the
  // committed prefix with the next append taking the gap-free sequence.
  const page = await alice.read(roomId)
  const committedTexts = page.json().result.messages.map(message => message.text)
  assert.ok(committedTexts.length === committedCount, 'the page holds exactly the committed prefix')
  assert.ok(!committedTexts.includes(refusedText), 'the refused message is absent')
  const headAtRefusal = page.json().result.head_seq
  assert.equal(headAtRefusal, committedCount)

  await server.close()
  const reopened = openRoomLog({ dataDir })
  t.after(() => reopened.close())
  const rows = reopened.readPage({ roomId, actorFingerprint: alice.fingerprint, afterSeq: 0, limit: READ_PAGE_MAX })
  assert.deepEqual(rows.map(row => row.client_message_id), Array.from({ length: committedCount }, (_, index) => `wire-full-${index}`))
  const back = reopened.appendMessage({
    roomId,
    actorFingerprint: alice.fingerprint,
    chatId: 'Alice',
    clientMessageId: 'wire-full-after-recovery',
    text: 'commits once the disk has room again',
  })
  assert.equal(back.message.seq, committedCount + 1)
})

test('a warn line captured for an append that then rolls back is dropped: the emit happens only after a commit', t => {
  // The post-COMMIT deferral is behavioral, not cosmetic: the gate captures
  // the interval's line INSIDE the transaction, and only a COMMITTED append
  // emits it. This row discriminates the deferral from in-transaction
  // emission — with emission inside the check, the count below would read 2.
  const dataDir = makeDataDir(t)
  // Warn zone the whole time (HALF_GIB free) with a small page ceiling: the
  // disk fills UNDER the writes while the gate keeps warning.
  const { store, warnings } = openGatedStore(t, dataDir, { free: HALF_GIB, maxPageCount: DISK_FULL_PAGES })
  const roomId = seedRoom(store)

  // Fill inside ONE warn interval (every append rides nowMs=1000): the first
  // committed append emits the interval's single line, and the ceiling's
  // failure point is page-exact, not attempt-exact, so the loop just finds it.
  let committed = 0
  for (let attempt = 0; attempt < 64; attempt++) {
    try {
      const outcome = append(store, roomId, `deferral-${attempt}`, largeText(`deferral-${attempt}`), { nowMs: 1000 })
      assert.equal(outcome.duplicate, false)
      committed += 1
    } catch (error) {
      assert.equal(error.code, 'storage_low')
      assert.match(error.message, /disk holding/, 'the ceiling fails the write, not the gate')
      break
    }
  }
  assert.ok(committed >= 1, 'at least one warn-zone append committed before the ceiling')
  assert.equal(warnings.length, 1, 'the whole first interval emitted exactly one line')

  // The NEXT interval's append: the gate captures a fresh line (the interval
  // rolled) and the disk-full write throws storage_low. The captured line is
  // DROPPED — a rolled-back transaction never reaches the post-COMMIT emit —
  // so the count stays 1; in-transaction emission would have made it 2, and
  // the rate-limit slot it consumed dies with the transaction.
  assert.throws(
    () => append(store, roomId, 'deferral-next-interval', largeText('deferral-next-interval'), { nowMs: 1000 + STORAGE_WARN_INTERVAL_MS }),
    error => error.code === 'storage_low' && /disk holding/.test(error.message),
  )
  assert.equal(
    warnings.length,
    1,
    'the captured line of a rolled-back append is dropped — the emit fires only after a commit',
  )
})

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
    { maxPageCount: 0 },
    { maxPageCount: 1.5 },
    { maxPageCount: 'big' },
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

test('a throwing warn sink never recolors committed work', t => {
  // The post-COMMIT emit is isolated: a diagnostics failure (an injected
  // sink that throws) must not convert an already-COMMITTED send into a
  // thrown error — the default stderr sink cannot practically throw, so this
  // is the test/embedder seam's discipline, and an idempotent retry would
  // heal it anyway, but committed is committed.
  const dataDir = makeDataDir(t)
  const sinkThrows = () => { throw new Error('sink exploded') }
  const { store } = openGatedStore(t, dataDir, { free: HALF_GIB, warn: sinkThrows })
  const roomId = seedRoom(store)

  const outcome = append(store, roomId, 'loud-sink-1', 'committed despite the failing diagnostics')
  assert.equal(outcome.duplicate, false)
  assert.equal(outcome.message.seq, 1, 'the committed outcome still returns')

  // The row is durably there: a fresh read-only inspection sees exactly it.
  assert.deepEqual(messageRows(dataDir).map(row => row.client_message_id), ['loud-sink-1'])
  assert.equal(store.headSeq(roomId), 1)

  // The store keeps working: the next append commits too (its emit also
  // fails silently, inside the same interval).
  const second = append(store, roomId, 'loud-sink-2', 'still committing')
  assert.equal(second.message.seq, 2)
})

test('the storage gate clock is injectable at the server layer: the warn interval rolls on driven sends', async t => {
  // The send route passes no nowMs, so the server's storageNowMs injection
  // answers every append's clock — the warn interval is drivable precisely
  // through real sends instead of only on the wall clock.
  const dataDir = makeDataDir(t)
  let nowMs = 1_000_000
  const warnings = []
  const server = await startTestServer(t, dataDir, {
    storageFreeBytesFn: () => HALF_GIB,
    storageWarn: line => warnings.push(line),
    storageNowMs: () => nowMs,
  })
  const alice = await connectSession(server.port, dataDir, 'Alice')
  const roomId = alice.broadcastRoomId

  const first = await alice.send(roomId, 'clock-1', 'the first interval warns once')
  assert.equal(first.json().result.status, 'committed', first.text)
  assert.equal(warnings.length, 1)

  // One millisecond inside the window: still the same line.
  nowMs += STORAGE_WARN_INTERVAL_MS - 1
  const second = await alice.send(roomId, 'clock-2', 'still the first interval')
  assert.equal(second.json().result.status, 'committed', second.text)
  assert.equal(warnings.length, 1, 'no second line inside the interval')

  // The window rolls on the driven clock: the next send warns again.
  nowMs += 1
  const third = await alice.send(roomId, 'clock-3', 'the second interval')
  assert.equal(third.json().result.status, 'committed', third.text)
  assert.equal(warnings.length, 2, 'the interval rolled exactly on the injected clock')

  // The driven clock rode created_at: the three sends are ordered by it.
  const page = await alice.read(roomId)
  assert.deepEqual(page.json().result.messages.map(message => message.client_message_id), ['clock-1', 'clock-2', 'clock-3'])
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
    { maxPageCount: 0 },
  ]) {
    await assert.rejects(
      () => startServer({ dataDir, port: 0, ...options }),
      error => error.code === 'invalid_argument',
      JSON.stringify(options),
    )
  }
})

// --- The direct launch: the env knobs over a REAL spawned child -----------------

const SERVER_ENTRY = join(ROOT, 'server', 'api', 'server.mjs')
const RUNTIME_RECORD_FILENAME = 'runtime.json'
const CHILD_STARTUP_DEADLINE_MS = 10_000
const CHILD_READY_POLL_MS = 25
const CHILD_REAP_GRACE_MS = 2_000

// The harness is its child's operator (the 4.4 convention): the gates' env
// floors are raised so the row's point is the storage tuning, not throttling.
const CHILD_FLOOR_ENV = Object.freeze({
  AGENT_ROOM_SEND_TOKEN_REFILL_PER_SECOND: '2000',
  AGENT_ROOM_SEND_TOKEN_CAPACITY: '100000',
  AGENT_ROOM_REQUEST_BUDGET_PER_MINUTE: '120000',
  AGENT_ROOM_REQUEST_BUDGET_BURST: '100000',
})

// One real spawned server child of the DIRECT LAUNCH (server/api/server.mjs
// as main), carrying the test's env knobs. Readiness is declared ONLY by a
// runtime record naming THIS child's pid with a valid port — the stale-record
// discipline — so the port is provably this child's.
async function spawnServerChild(t, dataDir, env = {}) {
  const runtimePath = join(dataDir, RUNTIME_RECORD_FILENAME)
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, AGENT_ROOM_DATA_DIR: dataDir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdout.resume()

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      const raced = await Promise.race([
        once(child, 'exit'),
        new Promise(resolvePromise => setTimeout(() => resolvePromise('timeout'), CHILD_REAP_GRACE_MS)),
      ])
      if (raced === 'timeout' && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await once(child, 'exit').catch(() => {})
      }
    }
  })

  const deadline = Date.now() + CHILD_STARTUP_DEADLINE_MS
  for (;;) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(`the server child exited early (code=${child.exitCode} signal=${child.signalCode}); stderr=${stderr}`)
    }
    if (existsSync(runtimePath)) {
      try {
        const record = JSON.parse(readFileSync(runtimePath, 'utf8'))
        if (
          record && typeof record === 'object'
          && record.pid === child.pid
          && Number.isInteger(record.port) && record.port > 0 && record.port <= 65535
          && typeof record.version === 'string' && record.version.length > 0
        ) {
          return { port: record.port, stderrText: () => stderr }
        }
      } catch {
        // A partially written record: keep polling until the deadline.
      }
    }
    if (Date.now() > deadline) {
      throw new Error(`the server child never became ready; stderr=${stderr}`)
    }
    await new Promise(resolvePromise => setTimeout(resolvePromise, CHILD_READY_POLL_MS))
  }
}

test('the direct launch honors the AGENT_ROOM_STORAGE_* env knobs: a raised refuse reserve refuses sends', async t => {
  const dataDir = makeDataDir(t)
  // The refuse reserve tuned far above any real free space (and the warn
  // reserve above it, the pair being validated together): the child's real
  // filesystem would pass the DEFAULT reserves, so a refusal here is the env
  // surface working end to end — env → direct launch → store gate → wire.
  const child = await spawnServerChild(t, dataDir, {
    ...CHILD_FLOOR_ENV,
    AGENT_ROOM_STORAGE_WARN_BYTES: String(2 ** 50),
    AGENT_ROOM_STORAGE_REFUSE_BYTES: String(2 ** 49),
  })
  const alice = await connectSession(child.port, dataDir, 'Alice')
  const roomId = alice.broadcastRoomId

  const sent = await alice.send(roomId, 'env-refused-1', 'refused through the env-tuned reserve')
  assert.equal(sent.status, 200, sent.text)
  assert.equal(sent.json().ok, true)
  assert.deepEqual(sent.json().result, { status: 'storage_low' })

  const page = await alice.read(roomId)
  assert.equal(page.status, 200, page.text)
  assert.deepEqual(page.json().result.messages.map(message => message.text), [])
})

test('the direct launch survives junk AGENT_ROOM_STORAGE_* env: one warning line, declared defaults in effect', async t => {
  const dataDir = makeDataDir(t)
  // Precondition for "defaults in effect": the data dir's real filesystem
  // must hold more free space than the default refuse reserve, or the commit
  // below would read the machine, not the fallback. A disk this full fails
  // the suite's own write-heavy rows anyway; the assert names it plainly.
  const realFree = statfsFreeBytes(dataDir)
  assert.ok(
    realFree > REFUSE,
    `precondition: ${realFree} free bytes must exceed the default refuse reserve (${REFUSE}) for this proof`,
  )
  const child = await spawnServerChild(t, dataDir, {
    ...CHILD_FLOOR_ENV,
    AGENT_ROOM_STORAGE_REFUSE_BYTES: 'plenty',
  })
  const alice = await connectSession(child.port, dataDir, 'Alice')
  const roomId = alice.broadcastRoomId

  const sent = await alice.send(roomId, 'env-junk-1', 'commits under the default reserves')
  assert.equal(sent.status, 200, sent.text)
  assert.equal(sent.json().result.status, 'committed')
  const page = await alice.read(roomId)
  assert.deepEqual(page.json().result.messages.map(message => message.text), ['commits under the default reserves'])

  // The junk value warned EXACTLY once — one line per knob per boot, the
  // fallback naming the declared default the server then ran on.
  const stderrText = child.stderrText()
  const warningLines = stderrText.split('\n').filter(lineText => lineText.includes('ignoring invalid AGENT_ROOM_STORAGE'))
  assert.equal(warningLines.length, 1, stderrText)
  assert.match(warningLines[0], /agent-room-server: ignoring invalid AGENT_ROOM_STORAGE_REFUSE_BYTES "plenty"/)
  assert.match(warningLines[0], new RegExp(`using the default ${REFUSE}`))
})

test('the direct launch dies early and coded on a contradictory resolved pair from env', async t => {
  // The guide's §5 row for a direct launch: valid WARN=0 beside the
  // junk-fallback REFUSE default is a resolved-pair contradiction — the boot
  // fails immediately with the one coded stderr line (startServer's async
  // validation rejects through the launch's catch), never a half-started
  // server. Breaking the direct launch's env wiring fails this row.
  const dataDir = makeDataDir(t)
  await assert.rejects(
    () => spawnServerChild(t, dataDir, { AGENT_ROOM_STORAGE_WARN_BYTES: '0' }),
    error => /server child exited early/.test(error.message)
      && error.message.includes(`agent-room-server: invalid_argument: storageRefuseFreeBytes (${REFUSE}) must not exceed storageWarnFreeBytes (0)`),
  )
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
  //
  // Why a TOLERANCE and not an equality: the 2% relative window exists to
  // guard filesystems whose root reservation makes bavail differ measurably
  // from bfree (some filesystems reserve several percent for root — the
  // exact reason the gate reads bavail). On a filesystem where bavail equals
  // bfree (this APFS tmpdir measures rel_diff 0) the tolerance cannot
  // distinguish the two fields — that distinction is unprovable by assertion
  // here without faking a reserved-block filesystem, which the zero-mock
  // house style forbids; the bavail-not-bfree choice is pinned by the
  // mechanism comment in ./server/store/storage-gate.mjs instead, and this
  // row proves the real syscall answers a live, finite, plausible byte count
  // through the shipped source.
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
  // Precondition for the 'ok' pins below (capacityOf derives 'ok' only above
  // the default 1 GiB warn reserve): the host's real free space must clear
  // it, or this row fails with a self-explaining precondition message
  // instead of a confusing 'warn' diff.
  const realFree = statfsFreeBytes(dataDir)
  assert.ok(
    realFree >= GIB,
    `precondition: ${realFree} free bytes must be at least the default warn reserve (${GIB}) for the 'ok' pins`,
  )
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

  // FR-22's byte counts ride the same line, sized by stat with NO store
  // open: an untouched data directory has neither file yet — zero bytes.
  assert.equal(line.capacity.database_bytes, 0)
  assert.equal(line.capacity.wal_bytes, 0)

  // A written realm shows in the counts: the main file holds the log's
  // pages, and the WAL sidecar holds the un-checkpointed frames of the
  // still-open connection.
  const store = openRoomLog({ dataDir })
  const roomId = seedRoom(store)
  append(store, roomId, 'counted-1', 'the byte counts see this row')
  const withStore = await runCli(t, dataDir, ['capacity'])
  assert.equal(withStore.exitCode, 0, withStore.stderr)
  const [storeLine] = jsonLines(withStore.stdout)
  assert.ok(storeLine.capacity.database_bytes > 0, 'the database file is counted')
  assert.ok(storeLine.capacity.wal_bytes > 0, 'the WAL sidecar is counted while frames are un-checkpointed')
  store.close()

  // A clean close checkpoints the WAL into the main file (the guide's
  // stop-copy-restart discipline): the sidecar reads zero, the main file
  // keeps every byte.
  const afterClose = await runCli(t, dataDir, ['capacity'])
  assert.equal(afterClose.exitCode, 0, afterClose.stderr)
  const [closedLine] = jsonLines(afterClose.stdout)
  assert.ok(closedLine.capacity.database_bytes >= storeLine.capacity.database_bytes, 'the checkpoint keeps the bytes in the main file')
  assert.equal(closedLine.capacity.wal_bytes, 0, 'the checkpointed sidecar is gone (zero bytes, absent-file-aware)')

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

test('agent-room capacity refuses a contradictory resolved pair: valid WARN=0 beside the junk-fallback refuse', async t => {
  // The guide's documented failure mode (§1): the per-key junk fallback
  // produces WARN=0 (valid) beside REFUSE=default 256 MiB, and the RESOLVED
  // pair is then validated — refuse above warn fails coded, so a junk value
  // CAN fail the command after all. This is the env-driven proof: breaking
  // runCapacity's resolveStorageThresholds or the env wiring fails this row.
  const dataDir = makeDataDir(t)
  const contradictory = await runCli(t, dataDir, ['capacity'], {
    env: { AGENT_ROOM_STORAGE_WARN_BYTES: '0' },
  })
  assert.equal(contradictory.exitCode, 1, contradictory.stderr)
  assert.equal(contradictory.stdout, '', 'the refusal carries no report line')
  const [errorLine] = jsonLines(contradictory.stderr)
  assert.equal(errorLine.ok, false)
  assert.equal(errorLine.code, 'invalid_argument')
  assert.match(
    errorLine.message,
    new RegExp(`storageRefuseFreeBytes \\(${REFUSE}\\) must not exceed storageWarnFreeBytes \\(0\\)`),
  )
})

test('agent-room capacity answers with the store file corrupt or absent and refuses a non-ENOENT statfs failure', async t => {
  // The headline property: the command opens NO store. A corrupt
  // agent-room.sqlite (garbage bytes — a file no SQLite connection can open)
  // changes nothing: the answer is still exactly one JSON line, exit 0 —
  // precisely when an operator needs the capacity view most.
  const corruptDir = makeDataDir(t)
  writeFileSync(join(corruptDir, ROOM_LOG_DATABASE_FILENAME), Buffer.from('this is not a database', 'utf8'))
  // Precondition for the 'ok' pin (capacityOf derives 'ok' only above the
  // default warn reserve): the host's real free space must clear it.
  const corruptFree = statfsFreeBytes(corruptDir)
  assert.ok(
    corruptFree >= GIB,
    `precondition: ${corruptFree} free bytes must be at least the default warn reserve (${GIB}) for the 'ok' pin`,
  )
  const corrupt = await runCli(t, corruptDir, ['capacity'])
  assert.equal(corrupt.exitCode, 0, corrupt.stderr)
  assert.equal(corrupt.stdout.split('\n').filter(lineText => lineText.length > 0).length, 1, 'exactly one JSON line')
  const [corruptLine] = jsonLines(corrupt.stdout)
  assert.equal(corruptLine.capacity.state, 'ok')
  assert.equal(corruptLine.capacity.admits_appends, true)
  // The corrupt file's own byte count still rides the line — the command
  // sizes files, it never opens them.
  assert.ok(corruptLine.capacity.database_bytes > 0)
  assert.equal(corruptLine.capacity.wal_bytes, 0)

  // A data directory that cannot be INSPECTED at all — a path resolving
  // through a regular file (ENOTDIR, not ENOENT) — is the coded refusal with
  // its recovery-shaped message, exit 1, nothing on stdout.
  const blockedDir = makeDataDir(t)
  writeFileSync(join(blockedDir, 'a-regular-file'), Buffer.from('x', 'utf8'))
  const blocked = await runCli(t, join(blockedDir, 'a-regular-file', 'deeper'), ['capacity'])
  assert.equal(blocked.exitCode, 1)
  assert.equal(blocked.stdout, '')
  const [blockedLine] = jsonLines(blocked.stderr)
  assert.equal(blockedLine.ok, false)
  assert.equal(blockedLine.code, 'data_directory_invalid')
  assert.match(blockedLine.message, /could not be inspected/)
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
    ['the refuse env knob', /AGENT_ROOM_STORAGE_REFUSE_BYTES/],
    ['the disk-full failure row', /SQLITE_FULL/],
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
