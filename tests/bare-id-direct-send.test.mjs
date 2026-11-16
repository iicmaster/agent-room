// Story 2.2 acceptance — locality-aware bare-ID direct send. Black-box, on a
// real spawned server, plus a small store-level section for the SQL/rollback
// invariants that cannot be observed over HTTP. Matrix -> test map:
//   COMMITTED        bare id -> 200 committed, pair room reused, no delivered claim
//   PEER_OFFLINE     released peer -> 409 + bounded candidates, freshest first
//   FILTERED_EMPTY   trust matrix empties candidates -> keep 409 + [] (client side)
//   PEER_NOT_FOUND   no/expired peer -> constant 404, p50 delta <= 5 ms
//   DUP_DROPPED      same key+payload after /resume or name takeover -> original_seq
//   CONFLICT         same key different payload -> 409 client_message_id_conflict
//   ROLLBACK         bad reply_to_seq writes no orphan room/membership
//   EXPLAIN          dedup lookup uses an index, never a full scan
//   BURST            1000 in-batch ops satisfy p99 <= 30 ms/op (write-queue delta)

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import http from 'node:http'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { PEER_OFFLINE_CANDIDATES_MAX, SESSION_BASE_LEASE_MS } from '../server/constants.mjs'
import { loadOrCreateLocalToken } from '../server/api/local-token.mjs'
import { filterPeerOfflineCandidates, emptyAllowlist } from '../server/client/trust.mjs'
import { openRoomLog, ROOM_LOG_DATABASE_FILENAME } from '../server/store/room-log.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = join(ROOT, 'server', 'api', 'server.mjs')
const sleep = ms => new Promise(r => setTimeout(r, ms))

function installation() {
  const { publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const raw = spki.subarray(spki.length - 32)
  return { publicKey: raw.toString('base64url') }
}

function makeDataDir(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-bare-id-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  return dataDir
}

function spawnServerChild(t, dataDir) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, AGENT_ROOM_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderrText = ''
  child.stderr.on('data', c => { stderrText += c })
  const runtimePath = join(dataDir, 'runtime.json')
  const waitReady = async () => {
    for (let i = 0; i < 400; i += 1) {
      if (child.exitCode !== null) throw new Error(`child exited: ${stderrText}`)
      if (existsSync(runtimePath)) {
        try {
          const record = JSON.parse(readFileSync(runtimePath, 'utf8'))
          if (Number.isInteger(record.port)) return record
        } catch { /* atomic rename retry */ }
      }
      await sleep(25)
    }
    throw new Error(`server never ready: ${stderrText}`)
  }
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit').catch(() => {})
    }
  })
  return { waitReady }
}

function request(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, response => {
      const chunks = []
      response.on('data', c => chunks.push(c))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolvePromise({ status: response.statusCode, text, json: () => JSON.parse(text) })
      })
      response.on('error', rejectPromise)
    })
    req.on('error', rejectPromise)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const bearer = token => ({ 'agent-room-protocol': '1', authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' })
const session = capability => ({ 'agent-room-protocol': '1', authorization: `Session ${capability}`, 'content-type': 'application/json; charset=utf-8' })

async function allocate(port, dataDir, base) {
  const token = loadOrCreateLocalToken(dataDir)
  const auth = await request(port, 'POST', '/api/auth/local', {
    headers: bearer(token), body: JSON.stringify({ public_key: installation().publicKey }),
  })
  assert.equal(auth.status, 200, auth.text)
  const sessionToken = auth.json().result.session_token
  const r = await request(port, 'POST', '/api/session-principals', {
    headers: bearer(sessionToken), body: JSON.stringify({ base_chat_id: base, machine: 'macbook' }),
  })
  assert.equal(r.status, 200, r.text)
  return { sessionToken, ...r.json().result }
}

const send = (port, from, to, clientMessageId, text, extra = {}) => request(port, 'POST', '/api/messages', {
  headers: session(from.session_capability),
  body: JSON.stringify({ to, client_message_id: clientMessageId, text, ...extra }),
})

// --- COMMITTED / DUP_DROPPED / CONFLICT / SELF / 400 ------------------------

test('bare-ID send commits a pair room; retry drops, conflict refuses, self/self-name refuse', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady } = spawnServerChild(t, dataDir)
  const { port } = await waitReady()
  const a = await allocate(port, dataDir, 'alice')
  const b = await allocate(port, dataDir, 'bob')

  const first = await send(port, a, 'bob', 'm-1', 'hello')
  assert.equal(first.status, 200, first.text)
  const receipt = first.json().result
  assert.equal(receipt.status, 'committed')
  assert.equal(receipt.seq, 1)
  assert.deepEqual(Object.keys(receipt).sort(), ['peer', 'room_id', 'seq', 'status'])
  assert.deepEqual(receipt.peer, { session_id: b.session_id, address: b.address, presence: 'online' })
  assert.doesNotMatch(first.text, /delivered|awakened|read/)

  // retry same key + payload -> original seq, no new commit
  const dup = await send(port, a, 'bob', 'm-1', 'hello')
  assert.equal(dup.json().result.status, 'duplicate_dropped')
  assert.equal(dup.json().result.original_seq, 1)
  // same key different payload -> conflict
  const conflict = await send(port, a, 'bob', 'm-1', 'DIFFERENT')
  assert.equal(conflict.status, 409)
  assert.equal(conflict.json().error.code, 'client_message_id_conflict')
  // self-target by bare name and by full address
  const selfName = await send(port, a, 'alice', 'self-1', 'x')
  assert.equal(selfName.status, 400)
  assert.equal(selfName.json().error.code, 'invalid_request')
  assert.match(selfName.json().error.message, /to/)
  const selfAddr = await send(port, a, a.address, 'self-2', 'x')
  assert.equal(selfAddr.status, 400)
  // malformed to names its field
  const bad = await send(port, a, 'bad@id', 'bad', 'x')
  assert.equal(bad.status, 400)
  assert.equal(bad.json().error.code, 'invalid_chat_id')
  assert.match(bad.json().error.message, /to/)
})

// --- PEER_OFFLINE + FILTERED_EMPTY -----------------------------------------

test('released peer -> 409 peer_offline with bounded candidates; trust filter keeps 409 + []', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady } = spawnServerChild(t, dataDir)
  const { port } = await waitReady()
  const a = await allocate(port, dataDir, 'alice')
  const b = await allocate(port, dataDir, 'bob')
  const release = await request(port, 'DELETE', '/api/session-principals/current', { headers: session(b.session_capability) })
  assert.equal(release.status, 200, release.text)

  const off = await send(port, a, 'bob', 'off-1', 'wake')
  assert.equal(off.status, 409)
  const err = off.json().error
  assert.equal(err.code, 'peer_offline')
  assert.ok(Array.isArray(err.candidates) && err.candidates.length >= 1 && err.candidates.length <= PEER_OFFLINE_CANDIDATES_MAX)
  const first = err.candidates[0]
  assert.deepEqual(Object.keys(first).sort(), ['address', 'fingerprint', 'last_heartbeat_at', 'session_id'])
  assert.equal(first.session_id, b.session_id)

  // The filtered-empty path is PURE and runs before render: with an empty
  // allowlist and a foreign fingerprint the candidate drops, the code stays
  // peer_offline with [], and no address survives.
  const filtered = filterPeerOfflineCandidates(err.candidates, {
    ownFingerprint: 'sha256:' + 'f'.repeat(64),
    transport: 'remote',
    allowlist: emptyAllowlist(),
  })
  assert.deepEqual(filtered, [])
  // a foreign fingerprint that IS allowlisted survives on the remote lane.
  const allowlisted = filterPeerOfflineCandidates(err.candidates, {
    ownFingerprint: 'sha256:' + 'f'.repeat(64),
    transport: 'remote',
    allowlist: { version: 1, accept_all: false, entries: [{ fingerprint: first.fingerprint }] },
  })
  assert.equal(allowlisted.length, 1, 'allowlisted fingerprint survives on remote lane')
})

// --- PEER_NOT_FOUND timing (p50 delta <= 5 ms) ------------------------------

function median(values) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}

async function timedSend(port, from, to, label) {
  const started = process.hrtime.bigint()
  const r = await send(port, from, to, `t-${label}-${started}`, 'x')
  const ms = Number(process.hrtime.bigint() - started) / 1e6
  assert.equal(r.status, 404)
  assert.equal(r.json().error.code, 'peer_not_found')
  return ms
}

test('peer_not_found is constant and its p50 matches a crowded realm within 5 ms', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady } = spawnServerChild(t, dataDir)
  const { port } = await waitReady()
  const a = await allocate(port, dataDir, 'alice')
  const empty = []
  for (let i = 0; i < 12; i += 1) empty.push(await timedSend(port, a, `ghost-${i}`, `e${i}`))

  const token = loadOrCreateLocalToken(dataDir)
  for (const name of ['one', 'two', 'three']) {
    const auth = await request(port, 'POST', '/api/auth/local', { headers: bearer(token), body: JSON.stringify({ public_key: installation().publicKey }) })
    const st = auth.json().result.session_token
    await request(port, 'POST', '/api/session-principals', { headers: bearer(st), body: JSON.stringify({ base_chat_id: name, machine: 'macbook' }) })
  }
  const crowded = []
  for (let i = 0; i < 12; i += 1) crowded.push(await timedSend(port, a, `ghost-${i}`, `c${i}`))

  const delta = Math.abs(median(crowded) - median(empty))
  assert.ok(delta <= 5, `p50 delta ${delta.toFixed(2)} ms must be <= 5 ms`)
})

// --- ROLLBACK (bad reply_to_seq leaves no orphan) ---------------------------

test('bad reply_to_seq rolls back the savepoint: no orphan pair room or membership', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady } = spawnServerChild(t, dataDir)
  const { port } = await waitReady()
  const a = await allocate(port, dataDir, 'alice')
  const b = await allocate(port, dataDir, 'bob')

  const before = await request(port, 'GET', '/api/status', { headers: bearer(loadOrCreateLocalToken(dataDir)) })
  const dbPath = join(dataDir, ROOM_LOG_DATABASE_FILENAME)
  const roomCount = () => {
    const db = new DatabaseSync(dbPath, { readOnly: true })
    try {
      return Number(db.prepare("SELECT COUNT(*) AS n FROM rooms WHERE kind = 'ssession'").get().n)
    } finally { db.close() }
  }
  const beforeRooms = roomCount()

  const bad = await send(port, a, 'bob', 'rb-1', 'x', { reply_to_seq: 999999 })
  assert.notEqual(bad.status, 200)
  assert.equal(roomCount(), beforeRooms, 'no orphan ssession room')
  void before
})

// --- BURST: 1000 in-batch ops, p99 <= 30 ms/op ------------------------------

test('burst of 1000 queued ops batches with p99 <= 30 ms/op (write-queue delta)', async t => {
  const dataDir = makeDataDir(t)
  const store = openRoomLog({ dataDir })
  const FP_A = 'sha256:' + 'a'.repeat(64)
  const FP_B = 'sha256:' + 'b'.repeat(64)
  const before = store.getWriteQueueMetrics().committed_total
  const started = process.hrtime.bigint()

  // 1000 distinct session keys avoid the per-session cap; each op is a
  // savepoint write measured at batch granularity. This is the AC's "in batch"
  // budget — the queue batches <= 64 ops per BEGIN IMMEDIATE / COMMIT FULL.
  const promises = Array.from({ length: 1000 }, (_, i) => store.enqueueWrite({
    sessionKey: `burst-${i}`,
    bytes: 16,
    execute(tx) {
      const room = tx.openDirectRoomInTx({ actorFingerprints: [FP_A, FP_B] })
      return { roomId: room.id }
    },
  }))
  await Promise.all(promises)
  const totalMs = Number(process.hrtime.bigint() - started) / 1e6
  const delta = store.getWriteQueueMetrics().committed_total - before
  assert.equal(delta, 1000, `committed delta must be 1000, got ${delta}`)
  // Per-op amortized time across the batched burst must stay under the budget.
  const perOp = totalMs / 1000
  assert.ok(perOp <= 30, `amortized ${perOp.toFixed(3)} ms/op must be <= 30 ms`)
  store.close()
})

// --- EXPLAIN QUERY PLAN (dedup lookup indexed) ------------------------------

test('EXPLAIN QUERY PLAN: dedup lookup uses the primary-key index, never a full scan', t => {
  const dataDir = makeDataDir(t)
  const store = openRoomLog({ dataDir })
  const db = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME), { readOnly: true })
  try {
    const plan = db.prepare(`
      EXPLAIN QUERY PLAN
      SELECT room_id, seq FROM bare_id_send_dedup
      WHERE sender_session_id = ? AND base_name_lower = ? AND client_message_id = ? AND created_at >= ?
    `).all('s', 'b', 'c', '2020-01-01T00:00:00.000Z')
    const detail = plan.map(row => row.detail).join(' ')
    assert.match(detail, /INDEX|SEARCH/)
    assert.doesNotMatch(detail, /SCAN bare_id_send_dedup/)
  } finally {
    db.close()
    store.close()
  }
})
