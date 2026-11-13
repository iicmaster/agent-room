// v0.9.0 addressed send — end to end on a real spawned server child: ten
// concurrent allocations get ten distinct addresses (the CAP-1 acceptance),
// one POST /api/messages resolves the pair room and commits (CAP-2), the
// unknown-address refusal is quiet and byte-identical (CAP-3), the receipt
// vocabulary says committed + presence and never delivered/read (CAP-5),
// a third session — including one sharing an installation key — reads
// nothing (CAP-6/THIRD_SESSION_ACL), an offline-but-retained peer resumes
// with its capability and reads from its cursor, and the capability
// selectors authenticate without ever being authority.

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { once } from 'node:events'
import http from 'node:http'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { loadOrCreateLocalToken } from '../server/api/local-token.mjs'
import { fingerprintFromPublicKey } from '../server/keys.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = join(ROOT, 'server', 'api', 'server.mjs')
const RUNTIME_RECORD_FILENAME = 'runtime.json'
const PROTOCOL_KEY = 'agent-room-protocol'
const PEER_NOT_FOUND_BODY = JSON.stringify({
  ok: false,
  error: { code: 'peer_not_found', message: 'no session principal resolves to this address' },
}) + '\n'

const sleep = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })

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
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-addressed-send-'))
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

function headersFor({ token, capability }) {
  return {
    [PROTOCOL_KEY]: '1',
    ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    ...(capability === undefined ? {} : { authorization: `Session ${capability}` }),
    'content-type': 'application/json; charset=utf-8',
  }
}

const bearerOf = token => headersFor({ token })

async function authenticateInstallation(port, dataDir, installation_, chatId) {
  const localToken = loadOrCreateLocalToken(dataDir)
  const auth = await request(port, 'POST', '/api/auth/local', {
    headers: { ...bearerOf(localToken), 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ public_key: installation_.publicKey }),
  })
  assert.equal(auth.status, 200, auth.text)
  const sessionToken = auth.json().result.session_token
  const connected = await request(port, 'POST', '/api/session', {
    headers: { ...bearerOf(sessionToken), 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ chat_id: chatId, client_type: 'api' }),
  })
  assert.equal(connected.status, 200, connected.text)
  return sessionToken
}

async function allocateSession(port, token, base, machine = 'macbook') {
  const response = await request(port, 'POST', '/api/session-principals', {
    headers: { ...bearerOf(token), 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ base_chat_id: base, machine, client_type: 'api' }),
  })
  assert.equal(response.status, 200, response.text)
  return response.json().result
}

async function addressedSend(port, principal, to, clientMessageId, text, extra = {}) {
  return request(port, 'POST', '/api/messages', {
    headers: headersFor({ capability: principal.session_capability }),
    body: JSON.stringify({
      to,
      client_message_id: clientMessageId,
      text,
      ...(extra.reply_to_seq === undefined ? {} : { reply_to_seq: extra.reply_to_seq }),
    }),
  })
}

// --- CAP-1: ten concurrent allocations -------------------------------------------

test('ten concurrent allocations from one installation receive ten distinct addresses and capabilities', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const token = await authenticateInstallation(record.port, dataDir, installation(), 'Allocator')

  const allocated = await Promise.all(Array.from({ length: 10 }, () =>
    allocateSession(record.port, token, 'zcode')))
  const addresses = new Set(allocated.map(entry => entry.address))
  const sessionIds = new Set(allocated.map(entry => entry.session_id))
  const capabilities = new Set(allocated.map(entry => entry.session_capability))
  assert.equal(addresses.size, 10, 'ten distinct full addresses')
  assert.equal(sessionIds.size, 10, 'ten distinct session ids')
  assert.equal(capabilities.size, 10, 'ten distinct capabilities')
  for (const address of addresses) assert.match(address, /^zcode~[A-Za-z0-9_-]{10}@macbook$/)

  // The explicit listing sees all ten, and only the installations' own.
  const list = await request(record.port, 'GET', '/api/session-principals', { headers: bearerOf(token) })
  assert.equal(list.status, 200, list.text)
  const listed = list.json().result.sessions
  assert.equal(listed.filter(row => row.base_name === 'zcode').length, 10)
  assert.ok(listed.every(row => row.address !== undefined && row.presence === 'online'))
  // The wire projection carries no credential material.
  assert.ok(listed.every(row => row.session_capability === undefined && row.capability_digest === undefined))
})

// --- CAP-2 + CAP-5: one call from address to committed seq ------------------------

test('addressed send A to B: committed seq, peer presence online, idempotent retry, pair room reused', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const installA = installation()
  const tokenA = await authenticateInstallation(record.port, dataDir, installA, 'Alice')
  const tokenB = await authenticateInstallation(record.port, dataDir, installation(), 'Bob')
  const a = await allocateSession(record.port, tokenA, 'alice')
  const b = await allocateSession(record.port, tokenB, 'bob')

  const first = await addressedSend(record.port, a, b.address, 'dm-1', 'nonce-123')
  assert.equal(first.status, 200, first.text)
  const committed = first.json().result
  assert.equal(committed.status, 'committed')
  assert.equal(committed.seq, 1)
  assert.ok(typeof committed.room_id === 'string' && committed.room_id.length > 0)
  assert.deepEqual(committed.peer, { session_id: b.session_id, address: b.address, presence: 'online' })
  // CAP-5: the receipt vocabulary never claims delivery.
  assert.doesNotMatch(first.text, /delivered|handled|awakened/)

  // A repeat send reuses the SAME pair room (CAP-6).
  const second = await addressedSend(record.port, a, b.address, 'dm-2', 'again')
  assert.equal(second.json().result.room_id, committed.room_id)

  // The exact retry (same id, same payload) returns the ORIGINAL seq (S6).
  const retry = await addressedSend(record.port, a, b.address, 'dm-1', 'nonce-123')
  assert.equal(retry.json().result.status, 'committed')
  assert.equal(retry.json().result.seq, 1)

  // B reads the pair room with its capability — one namespace, its own ACL.
  const read = await request(record.port, 'GET', `/api/rooms/${committed.room_id}/messages?after_seq=0`, {
    headers: headersFor({ capability: b.session_capability }),
  })
  assert.equal(read.status, 200, read.text)
  const page = read.json().result
  assert.deepEqual(page.messages.map(row => [row.seq, row.chat_id, row.actor_fingerprint]), [
    [1, a.address, installA.fingerprint],
    [2, a.address, installA.fingerprint],
  ])
  assert.equal(page.head_seq, 2)
})

// --- CAP-3: the quiet constant refusal ----------------------------------------------

test('peer_not_found is byte-identical whether the realm holds zero or three other sessions', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const token = await authenticateInstallation(record.port, dataDir, installation(), 'Alice')
  const principal = await allocateSession(record.port, token, 'alice')
  const ghost = 'ghost~aaaaaaaaaa@nowhere'

  const alone = await addressedSend(record.port, principal, ghost, 'dm-1', 'x')
  assert.equal(alone.status, 404)
  assert.equal(alone.text, PEER_NOT_FOUND_BODY)

  // Populate the realm with other sessions; the refusal does not change.
  for (const name of ['One', 'Two', 'Three']) {
    const peerToken = await authenticateInstallation(record.port, dataDir, installation(), name)
    await allocateSession(record.port, peerToken, name.toLowerCase())
  }
  const crowded = await addressedSend(record.port, principal, ghost, 'dm-2', 'x')
  assert.equal(crowded.status, 404)
  assert.equal(crowded.text, PEER_NOT_FOUND_BODY)
  assert.doesNotMatch(crowded.text, /One|Two|Three|sessions|count/)

  // A malformed address refuses with the grammar, never a resolution attempt.
  const malformed = await addressedSend(record.port, principal, 'ghost@nowhere', 'dm-3', 'x')
  assert.equal(malformed.status, 400)
  assert.equal(malformed.json().error.code, 'invalid_chat_id')
})

// --- Offline peer: release → committed offline → resume → read ---------------------

test('OFFLINE_SEND + resume: the durable principal receives while offline and reads on return', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const tokenA = await authenticateInstallation(record.port, dataDir, installation(), 'Alice')
  const tokenB = await authenticateInstallation(record.port, dataDir, installation(), 'Bob')
  const a = await allocateSession(record.port, tokenA, 'alice')
  const b = await allocateSession(record.port, tokenB, 'bob')

  // B goes offline the orderly way: its base lease is released (the
  // durable principal, address, membership and mailbox all persist).
  const released = await request(record.port, 'DELETE', '/api/session-principals/current', {
    headers: headersFor({ capability: b.session_capability }),
  })
  assert.equal(released.status, 200, released.text)
  // Idempotent: a second release answers success.
  const releasedAgain = await request(record.port, 'DELETE', '/api/session-principals/current', {
    headers: headersFor({ capability: b.session_capability }),
  })
  assert.equal(releasedAgain.status, 200, releasedAgain.text)

  const sent = await addressedSend(record.port, a, b.address, 'dm-1', 'wake up')
  assert.equal(sent.status, 200, sent.text)
  const receipt = sent.json().result
  assert.equal(receipt.status, 'committed')
  assert.equal(receipt.seq, 1)
  assert.equal(receipt.peer.presence, 'offline', 'the released peer reads offline')
  assert.doesNotMatch(sent.text, /delivered|handled|awakened/)

  // B resumes with its stored capability: the generation increments, the
  // same full address returns, and the lease refreshes.
  const resumed = await request(record.port, 'POST', '/api/session-principals/resume', {
    headers: headersFor({ capability: b.session_capability }),
    body: JSON.stringify({ session_id: b.session_id, generation: b.generation }),
  })
  assert.equal(resumed.status, 200, resumed.text)
  const resumedPrincipal = resumed.json().result
  assert.equal(resumedPrincipal.session_id, b.session_id)
  assert.equal(resumedPrincipal.address, b.address)
  assert.equal(resumedPrincipal.generation, b.generation + 1)

  // The OLD generation is fenced now: its beat answers session_expired.
  const staleBeat = await request(record.port, 'POST', '/api/session-principals/heartbeat', {
    headers: headersFor({ capability: b.session_capability }),
    body: JSON.stringify({ session_id: b.session_id, generation: b.generation }),
  })
  assert.equal(staleBeat.status, 409)
  assert.equal(staleBeat.json().error.code, 'session_expired')

  // The resumed generation beats cleanly.
  const beat = await request(record.port, 'POST', '/api/session-principals/heartbeat', {
    headers: headersFor({ capability: b.session_capability }),
    body: JSON.stringify({ session_id: b.session_id, generation: resumedPrincipal.generation }),
  })
  assert.equal(beat.status, 200, beat.text)
  assert.equal(beat.json().result.generation, resumedPrincipal.generation)

  // And B reads the message that waited in its mailbox.
  const room = receipt.room_id
  const read = await request(record.port, 'GET', `/api/rooms/${room}/messages?after_seq=0`, {
    headers: headersFor({ capability: b.session_capability }),
  })
  assert.equal(read.status, 200, read.text)
  const page = read.json().result
  assert.equal(page.messages[0].text, 'wake up')
})

// --- THIRD_SESSION_ACL ---------------------------------------------------------------

test('a third session — including one sharing an installation key — reads nothing', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const installA = installation()
  const installB = installation()
  const tokenA = await authenticateInstallation(record.port, dataDir, installA, 'Alice')
  const tokenB = await authenticateInstallation(record.port, dataDir, installB, 'Bob')
  const a = await allocateSession(record.port, tokenA, 'alice')
  const b = await allocateSession(record.port, tokenB, 'bob')
  const sent = await addressedSend(record.port, a, b.address, 'dm-1', 'private')
  assert.equal(sent.status, 200, sent.text)
  const room = sent.json().result.room_id

  // C on A's OWN installation key: no membership row, no read.
  const tokenC = await authenticateInstallation(record.port, dataDir, installA, 'Charlie')
  const c = await allocateSession(record.port, tokenC, 'charlie')
  const insiderRead = await request(record.port, 'GET', `/api/rooms/${room}/messages?after_seq=0`, {
    headers: headersFor({ capability: c.session_capability }),
  })
  assert.equal(insiderRead.status, 403)
  assert.equal(insiderRead.json().error.code, 'actor_not_member')
  assert.ok(!insiderRead.text.includes('private'), 'no body byte leaks')

  // A session capability for A used to read through the OLD route's field
  // gate changes nothing: the room is not a fingerprint room.
  const fingerprintRoute = await request(record.port, 'GET', `/api/rooms/${room}/messages?after_seq=0`, {
    headers: bearerOf(tokenB),
  })
  assert.equal(fingerprintRoute.status, 401, 'a bearer-only caller on a session-pair room reads nothing')
  assert.equal(fingerprintRoute.json().error.code, 'session_capability_required')

  // And B still reads with its own capability.
  const peerRead = await request(record.port, 'GET', `/api/rooms/${room}/messages?after_seq=0`, {
    headers: headersFor({ capability: b.session_capability }),
  })
  assert.equal(peerRead.status, 200, peerRead.text)
  assert.equal(peerRead.json().result.messages[0].text, 'private')
})

// --- CAPABILITY_MISMATCH: selectors are never authority ------------------------------

test("A's capability with B's selectors is session_credential_invalid and writes nothing", async t => {
  const dataDir = makeDataDir(t)
  const { waitReady } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const tokenA = await authenticateInstallation(record.port, dataDir, installation(), 'Alice')
  const tokenB = await authenticateInstallation(record.port, dataDir, installation(), 'Bob')
  const a = await allocateSession(record.port, tokenA, 'alice')
  const b = await allocateSession(record.port, tokenB, 'bob')
  const room = await request(record.port, 'POST', '/api/session-principals', {
    headers: { ...bearerOf(tokenA), 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ base_chat_id: 'roommaker', machine: 'macbook' }),
  })

  // Heartbeat: A's capability, B's session id / generation.
  const mismatchedBeat = await request(record.port, 'POST', '/api/session-principals/heartbeat', {
    headers: headersFor({ capability: a.session_capability }),
    body: JSON.stringify({ session_id: b.session_id, generation: b.generation }),
  })
  assert.equal(mismatchedBeat.status, 401)
  assert.equal(mismatchedBeat.json().error.code, 'session_credential_invalid')
  // The capability's OWN session id with a stale generation: the fence, not
  // the credential gate — session_expired, and nothing renews.
  const mismatchedGeneration = await request(record.port, 'POST', '/api/session-principals/heartbeat', {
    headers: headersFor({ capability: a.session_capability }),
    body: JSON.stringify({ session_id: a.session_id, generation: 99 }),
  })
  assert.equal(mismatchedGeneration.status, 409)
  assert.equal(mismatchedGeneration.json().error.code, 'session_expired')

  // No send/heartbeat/read happened for B: its lease is exactly as issued.
  const list = await request(record.port, 'GET', '/api/session-principals', { headers: bearerOf(tokenA) })
  const bRow = list.json().result.sessions.find(row => row.session_id === b.session_id)
  assert.equal(bRow.base_lease_expires_at, b.base_lease_expires_at)
  void room
})

test('credential discipline: bearer alone, missing capability, wrong shape, and unauthenticated allocate', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const token = await authenticateInstallation(record.port, dataDir, installation(), 'Alice')

  // Allocate refuses without the installation bearer.
  const anonymous = await request(record.port, 'POST', '/api/session-principals', {
    headers: { [PROTOCOL_KEY]: '1', 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ base_chat_id: 'x', machine: 'm' }),
  })
  assert.equal(anonymous.status, 401)
  assert.equal(anonymous.json().error.code, 'unauthorized')

  const principal = await allocateSession(record.port, token, 'alice')

  // Bearer alone on a session-scoped route: session_capability_required.
  const bearerOnly = await request(record.port, 'POST', '/api/messages', {
    headers: { ...bearerOf(token), 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ to: 'ghost~aaaaaaaaaa@nowhere', client_message_id: 'x', text: 'x' }),
  })
  assert.equal(bearerOnly.status, 401)
  assert.equal(bearerOnly.json().error.code, 'session_capability_required')

  // A Session header on the OLD send route keeps the frozen behavior: the
  // canonical unauthorized, byte-for-byte as before this increment.
  const sessionOnOldRoute = await request(record.port, 'POST', '/api/rooms/abc/messages', {
    headers: headersFor({ capability: principal.session_capability }),
    body: JSON.stringify({ chat_id: 'alice', client_message_id: 'x', text: 'x' }),
  })
  assert.equal(sessionOnOldRoute.status, 401)
  assert.equal(sessionOnOldRoute.json().error.code, 'unauthorized')

  // A present-but-non-canonical capability never reaches digest work.
  const junk = await request(record.port, 'POST', '/api/messages', {
    headers: { authorization: `Session ${principal.session_capability}xx`, [PROTOCOL_KEY]: '1', 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ to: 'ghost~aaaaaaaaaa@nowhere', client_message_id: 'x', text: 'x' }),
  })
  assert.equal(junk.status, 401)
  assert.equal(junk.json().error.code, 'session_credential_invalid')

  // An unknown capability digest: session_credential_invalid.
  const unknown = await request(record.port, 'POST', '/api/messages', {
    headers: headersFor({ capability: 'A'.repeat(43) }),
    body: JSON.stringify({ to: 'ghost~aaaaaaaaaa@nowhere', client_message_id: 'x', text: 'x' }),
  })
  assert.equal(unknown.status, 401)
  assert.equal(unknown.json().error.code, 'session_credential_invalid')
})

test('revoke over the wire ends the principal; the operator command shape is installation-scoped', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const tokenA = await authenticateInstallation(record.port, dataDir, installation(), 'Alice')
  const otherToken = await authenticateInstallation(record.port, dataDir, installation(), 'Other')
  const a = await allocateSession(record.port, tokenA, 'alice')
  const foreign = await allocateSession(record.port, otherToken, 'foreign')

  // A foreign installation cannot revoke; the refusal is zero-state.
  const foreignRevoke = await request(record.port, 'POST', '/api/session-principals/revoke', {
    headers: { ...bearerOf(otherToken), 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ session_id: a.session_id, reason: 'operator' }),
  })
  assert.equal(foreignRevoke.status, 401)

  // The owner revokes; future capability use answers session_revoked.
  const revoked = await request(record.port, 'POST', '/api/session-principals/revoke', {
    headers: { ...bearerOf(tokenA), 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ session_id: a.session_id, reason: 'operator' }),
  })
  assert.equal(revoked.status, 200, revoked.text)
  // Idempotent.
  const revokedAgain = await request(record.port, 'POST', '/api/session-principals/revoke', {
    headers: { ...bearerOf(tokenA), 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ session_id: a.session_id, reason: 'operator' }),
  })
  assert.equal(revokedAgain.status, 200, revokedAgain.text)

  const beaten = await request(record.port, 'POST', '/api/session-principals/heartbeat', {
    headers: headersFor({ capability: a.session_capability }),
    body: JSON.stringify({ session_id: a.session_id, generation: a.generation }),
  })
  assert.equal(beaten.status, 401)
  assert.equal(beaten.json().error.code, 'session_revoked')

  // Addressed sends to a revoked principal's address refuse quietly.
  const tokenB = await authenticateInstallation(record.port, dataDir, installation(), 'Bob')
  const b = await allocateSession(record.port, tokenB, 'bob')
  const toRevoked = await addressedSend(record.port, b, a.address, 'dm-1', 'x')
  assert.equal(toRevoked.status, 404)
  assert.equal(toRevoked.json().error.code, 'peer_not_found')
  void foreign
})

test('the client lifecycle end to end: ensure, addressed send, offline peer resume through the stored credential', async t => {
  const dataDir = makeDataDir(t)
  const pluginData = mkdtempSync(join(tmpdir(), 'agent-room-addressed-client-'))
  t.after(() => rmSync(pluginData, { recursive: true, force: true }))
  const { waitReady } = spawnServerChild(t, dataDir)
  const record = await waitReady()

  // A configured installation: the setup command's own file shape.
  mkdirSync(pluginData, { recursive: true })
  writeFileSync(join(pluginData, 'config.json'), `${JSON.stringify({ chat_id: 'Client' })}\n`)

  const { createAgentRoomClient } = await import('../server/client/api-client.mjs')
  const { loadSessionState } = await import('../server/client/session-state.mjs')
  const sender = createAgentRoomClient({
    dataDir,
    pluginDataDir: pluginData,
    sessionScope: 'sender-scope',
  })
  const principal = await sender.ensureSessionPrincipal()
  assert.match(principal.address, /^Client~[A-Za-z0-9_-]{10}@/)

  // The credential file is on disk at 0600, with the capability in it — the
  // only place the raw value persists client-side.
  const { statSync } = await import('node:fs')
  const statePath = join(pluginData, 'sessions', 'sender-scope', 'session.json')
  assert.equal(statSync(statePath).mode & 0o777, 0o600)
  const stored = loadSessionState(pluginData, 'sender-scope')
  assert.equal(stored.sessionId, principal.sessionId)
  assert.equal(stored.capability, principal.capability)

  // A peer over the wire — under the PEER CLIENT's own installation key, so
  // the principal it allocates belongs to the installation the client will
  // later authenticate as (the room listing keys on the installation
  // fingerprint).
  const peerPluginData = mkdtempSync(join(tmpdir(), 'agent-room-addressed-peer-'))
  t.after(() => rmSync(peerPluginData, { recursive: true, force: true }))
  mkdirSync(peerPluginData, { recursive: true })
  // A distinct chat id for the peer client's own bind: the LIVE 'Peer' name
  // is held by the HTTP-installed session below, and the client never takes
  // a held name — the session PRINCIPAL it resumes is identified by its
  // stored capability, not by the chat id.
  writeFileSync(join(peerPluginData, 'config.json'), `${JSON.stringify({ chat_id: 'PeerCli' })}\n`)
  const { loadOrCreateKeypair } = await import('../server/keys.mjs')
  const peerKeypair = loadOrCreateKeypair(peerPluginData)
  const peerInstall = { publicKey: peerKeypair.publicKey.toString('base64url') }
  const peerToken = await authenticateInstallation(record.port, dataDir, peerInstall, 'Peer')
  const peer = await allocateSession(record.port, peerToken, 'peer')
  const sent = await sender.sendToAddress({ to: peer.address, clientMessageId: 'c-1', text: 'by address' })
  assert.equal(sent.status, 'committed')
  assert.equal(sent.peer.address, peer.address)

  // Peer offline: still committed, presence offline.
  const { openRoomLog } = await import('../server/store/room-log.mjs')
  void openRoomLog
  await request(record.port, 'DELETE', '/api/session-principals/current', {
    headers: headersFor({ capability: peer.session_capability }),
  })
  const offline = await sender.sendToAddress({ to: peer.address, clientMessageId: 'c-2', text: 'while away' })
  assert.equal(offline.status, 'committed')
  assert.equal(offline.peer.presence, 'offline')

  // The peer's own client resumes through ITS stored credential file.
  const { saveSessionState } = await import('../server/client/session-state.mjs')
  saveSessionState(peerPluginData, 'peer-scope', {
    sessionId: peer.session_id,
    generation: peer.generation,
    address: peer.address,
    baseName: 'peer',
    machine: peer.machine,
    capability: peer.session_capability,
  })
  const peerClient = createAgentRoomClient({
    dataDir,
    pluginDataDir: peerPluginData,
    sessionScope: 'peer-scope',
  })
  const resumed = await peerClient.ensureSessionPrincipal()
  assert.equal(resumed.sessionId, peer.session_id)
  assert.equal(resumed.address, peer.address)
  assert.equal(resumed.generation, peer.generation + 1, 'resume increments the generation')

  // The sender's heartbeat loop renews its lease across the 10 s cadence:
  // after one beat interval its own listing row still reads ONLINE (an
  // unacknowledged beat would let the lease lapse to offline).
  sender.startSessionHeartbeat()
  await sleep(11_500)
  const senderRows = (await sender.listSessions()).sessions
  const senderRow = senderRows.find(row => row.session_id === principal.sessionId)
  assert.ok(senderRow, 'the sender’s principal appears in the listing')
  assert.equal(senderRow.presence, 'online', 'the beat renewed the lease across one full interval')

  // And the peer client reads the pair room through the listing + capability.
  const rooms = await peerClient.listRooms()
  const pair = rooms.rooms.find(row => row.room_id === sent.room_id)
  assert.ok(pair, 'the pair room is discoverable through the installation listing')
  const page = await peerClient.readMessage({ roomId: sent.room_id, afterSeq: 0 })
  const texts = page.messages.map(row => row.text).slice(0, 2)
  assert.match(texts[0], /by address/)
  assert.match(texts[1], /while away/)
  // The sender is a FOREIGN installation to the peer client: the rows arrive
  // wrapped in the static untrusted envelope, attributed by session address.
  assert.ok(texts.every(text => text.startsWith('<untrusted_message')), 'foreign sender rows arrive wrapped')
  assert.equal(page.messages[0].chat_id.startsWith('Client~'), true)
})

test('unknown fields and bad shapes refuse before any state changes', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const token = await authenticateInstallation(record.port, dataDir, installation(), 'Alice')
  const unknownField = await request(record.port, 'POST', '/api/session-principals', {
    headers: { ...bearerOf(token), 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ base_chat_id: 'alice', machine: 'macbook', fingerprint: 'sha256:' + 'a'.repeat(64) }),
  })
  assert.equal(unknownField.status, 400)
  assert.equal(unknownField.json().error.code, 'unknown_field', 'a body-supplied fingerprint is not a field at all — identity comes from the token')

  const badBase = await request(record.port, 'POST', '/api/session-principals', {
    headers: { ...bearerOf(token), 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ base_chat_id: 'not a valid chat id!', machine: 'macbook' }),
  })
  assert.equal(badBase.status, 400)
  assert.equal(badBase.json().error.code, 'invalid_chat_id')

  const badMachine = await request(record.port, 'POST', '/api/session-principals', {
    headers: { ...bearerOf(token), 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ base_chat_id: 'alice', machine: 'bad machine!' }),
  })
  assert.equal(badMachine.status, 400)
  assert.equal(badMachine.json().error.code, 'invalid_request')

  // Nothing was allocated by any of the refusals.
  const list = await request(record.port, 'GET', '/api/session-principals', { headers: bearerOf(token) })
  assert.equal(list.json().result.sessions.length, 0)
})

test('the CLI family: agent-room sessions lists, agent-room dm sends by address, send --to matches', async t => {
  const dataDir = makeDataDir(t)
  const pluginData = mkdtempSync(join(tmpdir(), 'agent-room-addressed-cli-'))
  t.after(() => rmSync(pluginData, { recursive: true, force: true }))
  const { waitReady } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  mkdirSync(pluginData, { recursive: true })
  writeFileSync(join(pluginData, 'config.json'), `${JSON.stringify({ chat_id: 'CliSender' })}\n`)

  // The peer exists as a plain session principal over the wire.
  const peerToken = await authenticateInstallation(record.port, dataDir, installation(), 'Peer')
  const peer = await allocateSession(record.port, peerToken, 'peer')

  const { runDmCommand, runSessionsCommand, runSendFamilyCommand } = await import('../server/cli/message-commands.mjs')
  const deps = { pluginDataDir: pluginData, sharedDataDir: dataDir, env: process.env }

  // `agent-room sessions` — the explicit listing, one JSON line.
  const sessions = await runSessionsCommand([], deps)
  assert.equal(sessions.status, 'ok', JSON.stringify(sessions))
  const listed = JSON.parse(sessions.lines[0])
  assert.equal(listed.ok, true)
  assert.equal(listed.command, 'sessions')
  assert.equal(typeof listed.realm_id, 'string')
  assert.equal(listed.sessions.filter(row => row.base_name === 'peer').length, 1)
  assert.ok(listed.sessions.every(row => row.session_capability === undefined))

  // `agent-room dm --to <address> --text` — the four-step operator flow.
  const dm = await runDmCommand(['--to', peer.address, '--text', 'nonce-cli-123'], deps)
  assert.equal(dm.status, 'ok', JSON.stringify(dm))
  const dmReceipt = JSON.parse(dm.lines[0])
  assert.equal(dmReceipt.status, 'committed')
  assert.equal(dmReceipt.committed_seq, 1)
  assert.equal(dmReceipt.room_id.length > 0, true)
  assert.deepEqual(dmReceipt.peer, { session_id: peer.session_id, address: peer.address, presence: 'online' })
  assert.doesNotMatch(dm.lines[0], /delivered|handled|awakened/)

  // The peer reads its mailbox through the pair room the dm created.
  const read = await request(record.port, 'GET', `/api/rooms/${dmReceipt.room_id}/messages?after_seq=0`, {
    headers: headersFor({ capability: peer.session_capability }),
  })
  assert.equal(read.status, 200, read.text)
  assert.equal(read.json().result.messages[0].text, 'nonce-cli-123')
  assert.equal(read.json().result.messages[0].chat_id.startsWith('CliSender~'), true)

  // `agent-room send --to` — the same addressed wire under the send command.
  const send = await runSendFamilyCommand(['--to', peer.address, '--text', 'via send to'], deps)
  assert.equal(send.status, 'ok', JSON.stringify(send))
  const sendReceipt = JSON.parse(send.lines[0])
  assert.equal(sendReceipt.status, 'committed')
  // `send --to` runs under its OWN ephemeral session principal (one-shot
  // process = one addressable session), so its pair room with the peer is a
  // NEW room and its local sequence starts at 1.
  assert.equal(sendReceipt.committed_seq, 1)
  assert.notEqual(sendReceipt.room_id, dmReceipt.room_id)
  assert.equal(sendReceipt.peer.presence, 'online')

  // An unknown address refuses quietly through the CLI as well: the receipt
  // names the constant code and carries no roster.
  const ghost = await runDmCommand(['--to', 'ghost~aaaaaaaaaa@nowhere', '--text', 'x'], deps)
  assert.equal(ghost.status, 'refusal')
  assert.equal(ghost.code, 'peer_not_found')
  assert.doesNotMatch(JSON.stringify(ghost), /Peer|sessions|count/)

  // A malformed address is a usage refusal naming the grammar.
  const malformed = await runDmCommand(['--to', 'peer@macbook', '--text', 'x'], deps)
  assert.equal(malformed.status, 'usage')
})
