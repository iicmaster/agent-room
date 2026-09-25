// Story 1.7 acceptance: POST /api/rooms/direct — the DM discovery surface.
// Every matrix row runs against real spawned server children with real
// keypairs and sessions from the Story 1.4/1.5 path. The rows cover the
// happy path (existing-or-created pair room; concurrent opens converge on
// one room), the ambiguity round-trip (several Actors claiming one name
// answer 409 ambiguous_chat_id with candidates — fingerprint + last_seen —
// and target_fingerprint completes resolution, never a guess), the unknown
// name (404 chat_id_not_found, naming the miss), self-DM refusal, and the
// shape/NFR-3 rejections (unknown fields, malformed grammar, malformed
// fingerprint, credential-less).

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import http from 'node:http'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { DatabaseSync } from 'node:sqlite'

import { PUBLIC_ERROR_STATUS } from '../server/constants.mjs'
import { loadOrCreateLocalToken } from '../server/api/local-token.mjs'
import { fingerprintFromPublicKey } from '../server/keys.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = join(ROOT, 'server', 'api', 'server.mjs')
const RUNTIME_RECORD_FILENAME = 'runtime.json'
const PROTOCOL_KEY = 'agent-room-protocol'

const sleep = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })

// One installation identity: a real Ed25519 keypair, presented the way the
// 1.1-born client presents it — the raw 32-byte public key, base64url.
function installation() {
  const { publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const raw = spki.subarray(spki.length - 32)
  return {
    raw,
    publicKey: raw.toString('base64url'),
    fingerprint: fingerprintFromPublicKey(raw),
  }
}

function makeDataDir(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-direct-open-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  return dataDir
}

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
        throw new Error(`server child exited early (code=${child.exitCode}); stderr: ${stderrText()}`)
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

  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    await once(child, 'exit')
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

async function exchange(port, installation_, localToken) {
  return request(port, 'POST', '/api/auth/local', {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${localToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ public_key: installation_.publicKey }),
  })
}

async function connectInstallation(port, localToken, installation_, chatId) {
  const auth = await exchange(port, installation_, localToken)
  assert.equal(auth.status, 200, auth.text)
  const sessionToken = auth.json().result.session_token
  const connected = await request(port, 'POST', '/api/session', {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${sessionToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ chat_id: chatId }),
  })
  assert.equal(connected.status, 200, connected.text)
  return { sessionToken, fingerprint: installation_.fingerprint }
}

// A durable claim on a name WITHOUT holding it live: connect, then release.
// The claim row persists (the ambiguity data); the live name frees for the
// next claimant — how two Actors come to both hold claims on "bob".
async function claimAndRelease(port, localToken, installation_, chatId) {
  const session = await connectInstallation(port, localToken, installation_, chatId)
  const released = await request(port, 'DELETE', '/api/session', {
    headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${session.sessionToken}` },
  })
  assert.equal(released.status, 200, released.text)
  return session
}

// The route under test.
function directOpen(port, sessionToken, body) {
  return request(port, 'POST', '/api/rooms/direct', {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${sessionToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  })
}

// Pair rooms, read straight from the store's SQLite file.
function roomRows(dataDir) {
  const db = new DatabaseSync(join(dataDir, 'agent-room.sqlite'))
  try {
    return db.prepare(`
      SELECT id, kind, pair_key, created_by_fingerprint
      FROM rooms
      WHERE kind = 'direct'
      ORDER BY pair_key
    `).all()
  } finally {
    db.close()
  }
}

// --- Matrix rows (real child processes) -------------------------------------------

test('direct open happy path: the unique claim resolves to a pair room, concurrent opens converge on one room', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const peer = installation()

  const aliceSession = await connectInstallation(record.port, localToken, alice, 'Alice')
  await connectInstallation(record.port, localToken, peer, 'Peer')

  const opened = await directOpen(record.port, aliceSession.sessionToken, { chat_id: 'Peer' })
  assert.equal(opened.status, 200, opened.text)
  const first = opened.json()
  assert.equal(first.ok, true)
  // The response stays inside the frozen vocabulary: room_id + kind only.
  assert.deepEqual(Object.keys(first.result).sort(), ['kind', 'room_id'])
  assert.equal(first.result.kind, 'direct')

  // Concurrent opens by the same caller, in flight together: the pair-key
  // idempotency returns the identical room id for both (any casing of the
  // name — the claim comparison is case-insensitive).
  const [raceA, raceB] = await Promise.all([
    directOpen(record.port, aliceSession.sessionToken, { chat_id: 'Peer' }),
    directOpen(record.port, aliceSession.sessionToken, { chat_id: 'PEER' }),
  ])
  assert.equal(raceA.status, 200, raceA.text)
  assert.equal(raceB.status, 200, raceB.text)
  assert.equal(raceA.json().result.room_id, first.result.room_id)
  assert.equal(raceB.json().result.room_id, first.result.room_id)

  // Exactly one direct room exists, keyed by the canonical pair.
  const rooms = roomRows(dataDir)
  assert.equal(rooms.length, 1)
  const [min, max] = [alice.fingerprint, peer.fingerprint].sort()
  assert.equal(rooms[0].pair_key, `direct:${min}:${max}`)

  await stop()

  // The pair room survives restart (durable store), and opening from the
  // peer's side — the reversed argument order — is the same room.
  const second = spawnServerChild(t, dataDir)
  const secondRecord = await second.waitReady()
  const secondLocalToken = loadOrCreateLocalToken(dataDir)
  const peerAgain = await connectInstallation(secondRecord.port, secondLocalToken, peer, 'Peer')
  const aliceAgain = await connectInstallation(secondRecord.port, secondLocalToken, alice, 'Alice')
  const reverse = await directOpen(secondRecord.port, peerAgain.sessionToken, { chat_id: 'Alice' })
  assert.equal(reverse.status, 200, reverse.text)
  assert.equal(reverse.json().result.room_id, first.result.room_id, 'the pair key is order-independent')
  const still = await directOpen(secondRecord.port, aliceAgain.sessionToken, { chat_id: 'Peer' })
  assert.equal(still.json().result.room_id, first.result.room_id)
  assert.equal(roomRows(dataDir).length, 1)
  await second.stop()
})

test('ambiguous chat id: several Actors claiming one name answer 409 with candidates and never a guess', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const bobOne = installation()
  const bobTwo = installation()

  const aliceSession = await connectInstallation(record.port, localToken, alice, 'Alice')
  await claimAndRelease(record.port, localToken, bobOne, 'bob')
  // The second claimant claims after the first: its claim is the most
  // recent, so it must be the FIRST candidate.
  await claimAndRelease(record.port, localToken, bobTwo, 'BOB')

  const ambiguous = await directOpen(record.port, aliceSession.sessionToken, { chat_id: 'bob' })
  assert.equal(ambiguous.status, 409, ambiguous.text)
  assert.equal(PUBLIC_ERROR_STATUS.ambiguous_chat_id, 409)
  const failure = ambiguous.json()
  assert.equal(failure.ok, false)
  assert.equal(failure.error.code, 'ambiguous_chat_id')
  assert.match(failure.error.message, /claimed by 2 actors/)
  // The candidates ride the error envelope, most recent first, each carrying
  // fingerprint + last_seen — the completable disambiguation data.
  const candidates = failure.error.candidates
  assert.ok(Array.isArray(candidates))
  assert.equal(candidates.length, 2)
  assert.deepEqual(
    candidates.map(candidate => candidate.fingerprint).sort(),
    [bobOne.fingerprint, bobTwo.fingerprint].sort(),
  )
  assert.equal(candidates[0].fingerprint, bobTwo.fingerprint, 'most recent claim first')
  for (const candidate of candidates) {
    assert.deepEqual(Object.keys(candidate).sort(), ['fingerprint', 'last_seen'])
    assert.ok(!Number.isNaN(Date.parse(candidate.last_seen)), 'last_seen is a timestamp')
  }

  // The refusal created no room and guessed nothing.
  assert.equal(roomRows(dataDir).length, 0)
  await stop()
})

test('disambiguation: target_fingerprint resolves to that candidate\'s pair room, and only theirs', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const bobOne = installation()
  const bobTwo = installation()

  const aliceSession = await connectInstallation(record.port, localToken, alice, 'Alice')
  await claimAndRelease(record.port, localToken, bobOne, 'bob')
  await claimAndRelease(record.port, localToken, bobTwo, 'bob')

  const resolved = await directOpen(record.port, aliceSession.sessionToken, {
    chat_id: 'bob',
    target_fingerprint: bobOne.fingerprint,
  })
  assert.equal(resolved.status, 200, resolved.text)
  const roomId = resolved.json().result.room_id
  assert.equal(typeof roomId, 'string')
  assert.equal(roomId.length > 0, true)

  const rooms = roomRows(dataDir)
  assert.equal(rooms.length, 1, 'exactly the resolved pair room was created')
  const [min, max] = [alice.fingerprint, bobOne.fingerprint].sort()
  assert.equal(rooms[0].pair_key, `direct:${min}:${max}`)

  // Re-resolving with the same target returns the same room; resolving with
  // the other candidate creates the OTHER pair room, never a guess.
  const again = await directOpen(record.port, aliceSession.sessionToken, {
    chat_id: 'bob',
    target_fingerprint: bobOne.fingerprint,
  })
  assert.equal(again.json().result.room_id, roomId)
  const other = await directOpen(record.port, aliceSession.sessionToken, {
    chat_id: 'bob',
    target_fingerprint: bobTwo.fingerprint,
  })
  assert.equal(other.status, 200, other.text)
  assert.notEqual(other.json().result.room_id, roomId)
  assert.equal(roomRows(dataDir).length, 2)
  await stop()
})

test('unknown chat id and unmatched target fingerprint answer 404 chat_id_not_found, naming the miss', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const peer = installation()

  const aliceSession = await connectInstallation(record.port, localToken, alice, 'Alice')

  const nobody = await directOpen(record.port, aliceSession.sessionToken, { chat_id: 'nobody' })
  assert.equal(nobody.status, 404, nobody.text)
  assert.equal(nobody.json().error.code, 'chat_id_not_found')
  assert.match(nobody.json().error.message, /nobody/)
  assert.equal(nobody.json().error.candidates, undefined, 'a bare miss carries no candidates')

  await connectInstallation(record.port, localToken, peer, 'Peer')
  const unmatched = await directOpen(record.port, aliceSession.sessionToken, {
    chat_id: 'Peer',
    target_fingerprint: `sha256:${'a'.repeat(64)}`,
  })
  assert.equal(unmatched.status, 404, unmatched.text)
  assert.equal(unmatched.json().error.code, 'chat_id_not_found')
  assert.match(unmatched.json().error.message, /fingerprint/)

  assert.equal(roomRows(dataDir).length, 0, 'misses create nothing')
  await stop()
})

test('self-DM is refused with a distinct message on the invalid_request family', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()

  const aliceSession = await connectInstallation(record.port, localToken, alice, 'Alice')
  await connectInstallation(record.port, localToken, installation(), 'Mirror')

  // Alice's own name: her claim resolves to her own fingerprint — refused.
  const self = await directOpen(record.port, aliceSession.sessionToken, { chat_id: 'Alice' })
  assert.equal(self.status, 400, self.text)
  assert.equal(self.json().error.code, 'invalid_request')
  assert.match(self.json().error.message, /self-DM/)

  // The same by fingerprint: target_fingerprint equal to the caller (her own
  // claim on her own name) is the same self-DM refusal.
  const byFingerprint = await directOpen(record.port, aliceSession.sessionToken, {
    chat_id: 'Alice',
    target_fingerprint: alice.fingerprint,
  })
  assert.equal(byFingerprint.status, 400, byFingerprint.text)
  assert.equal(byFingerprint.json().error.code, 'invalid_request')
  assert.match(byFingerprint.json().error.message, /self-DM/)

  assert.equal(roomRows(dataDir).length, 0)
  await stop()
})

test('shape and NFR-3 rejections: unknown fields, malformed grammar, malformed fingerprint, no credential', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()

  const aliceSession = await connectInstallation(record.port, localToken, alice, 'Alice')

  // Identity-smuggling fields have no allowed name on the route: the frozen
  // field gate rejects them before the handler (NFR-3 negative).
  for (const smuggled of [
    { chat_id: 'Peer', actor_id: 'someone' },
    { chat_id: 'Peer', fingerprint: `sha256:${'b'.repeat(64)}` },
    { chat_id: 'Peer', sender_fingerprint: `sha256:${'c'.repeat(64)}` },
  ]) {
    const refused = await directOpen(record.port, aliceSession.sessionToken, smuggled)
    assert.equal(refused.status, 400, JSON.stringify(smuggled))
    assert.equal(refused.json().error.code, 'unknown_field', JSON.stringify(smuggled))
  }

  // Missing/malformed chat id and malformed fingerprint are shape rejections.
  for (const body of [{}, { chat_id: '' }, { chat_id: null }, { chat_id: 'bad name!' }, { chat_id: 42 }]) {
    const refused = await directOpen(record.port, aliceSession.sessionToken, body)
    assert.equal(refused.status, 400, JSON.stringify(body))
    assert.ok(
      ['invalid_request', 'invalid_chat_id'].includes(refused.json().error.code),
      JSON.stringify(body),
    )
  }
  const badFingerprint = await directOpen(record.port, aliceSession.sessionToken, {
    chat_id: 'Alice',
    target_fingerprint: 'not-a-fingerprint',
  })
  assert.equal(badFingerprint.status, 400)
  assert.equal(badFingerprint.json().error.code, 'invalid_actor_id')

  // No session, no state change.
  const anonymous = await request(record.port, 'POST', '/api/rooms/direct', {
    headers: { [PROTOCOL_KEY]: '1', 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ chat_id: 'Alice' }),
  })
  assert.equal(anonymous.status, 401)
  assert.equal(anonymous.json().error.code, 'unauthorized')

  assert.equal(roomRows(dataDir).length, 0, 'rejections change no room state')
  await stop()
})
