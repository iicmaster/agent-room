// Story 2.1 acceptance, black-box where it matters: session room isolation
// (AC1/AC2), the read command's selector grammar and cursor contract (AC3),
// and the held-row projection (AC4). Every HTTP assertion drives the real
// spawned server; the read assertions drive the real CLI dispatcher, because
// "read_seq advances only after stdout flush" is a property of that surface
// and nowhere else.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { PROTOCOL_VERSION } from '../server/constants.mjs'
import { loadOrCreateLocalToken } from '../server/api/local-token.mjs'
import { loadOrCreateKeypair, signWithInstallationKey } from '../server/keys.mjs'
import { openRoomLog } from '../server/store/room-log.mjs'
import { CONNECTION_MODE_ENV } from '../server/client/api-client.mjs'
import { main as cliMain } from '../server/cli/agent-room.mjs'
import { runReadFamilyCommand } from '../server/cli/message-commands.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = join(ROOT, 'server', 'api', 'server.mjs')
const PROTOCOL_KEY = 'agent-room-protocol'

const sleep = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })

function makeWorld(t) {
  const parent = mkdtempSync(join(tmpdir(), 'agent-room-story21-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const sharedData = join(parent, 'shared')
  const pluginData = join(parent, 'plugin-data')
  const otherPluginData = join(parent, 'plugin-data-other')
  for (const dir of [sharedData, pluginData, otherPluginData]) mkdirSync(dir, { mode: 0o700 })
  writeFileSync(join(pluginData, 'config.json'), `${JSON.stringify({ chat_id: 'sender' })}\n`, { mode: 0o600 })
  writeFileSync(join(otherPluginData, 'config.json'), `${JSON.stringify({ chat_id: 'other' })}\n`, { mode: 0o600 })

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, AGENT_ROOM_DATA_DIR: sharedData },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const waitReady = async () => {
    const deadline = Date.now() + 10_000
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('server child exited early')
      if (existsSync(join(sharedData, 'runtime.json'))) {
        try {
          const record = JSON.parse(readFileSync(join(sharedData, 'runtime.json'), 'utf8'))
          if (Number.isInteger(record.port) && record.port > 0) return record
        } catch { /* atomic rename: retry */ }
      }
      if (Date.now() > deadline) throw new Error('server child never became ready')
      await sleep(25)
    }
  }
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit').catch(() => {})
    }
  })
  return { parent, sharedData, pluginData, otherPluginData, waitReady }
}

function httpRequest(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('error', rejectPromise)
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolvePromise({ status: response.statusCode, json: () => JSON.parse(text), text })
      })
    })
    req.on('error', rejectPromise)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

const bearerHeaders = token => ({
  [PROTOCOL_KEY]: PROTOCOL_VERSION,
  authorization: `Bearer ${token}`,
  'content-type': 'application/json; charset=utf-8',
})
const sessionHeaders = capability => ({
  [PROTOCOL_KEY]: PROTOCOL_VERSION,
  authorization: `Session ${capability}`,
  'content-type': 'application/json; charset=utf-8',
})

// One installation key exchanging the local token for a session bearer. The
// key is the INSTALLATION identity: two sessions under one installation
// share it, which is exactly the sibling case AC1 pins.
async function installationBearer(port, sharedData, raw) {
  const localToken = loadOrCreateLocalToken(sharedData)
  const auth = await httpRequest(port, 'POST', '/api/auth/local', {
    headers: bearerHeaders(localToken),
    body: { public_key: raw.toString('base64url') },
  })
  assert.equal(auth.status, 200, auth.text)
  return auth.json().result.session_token
}

// One SESSION principal: allocate (or resume) under an installation bearer,
// then bind its Chat ID so the address is complete.
async function allocateSession(port, bearer, baseName, machine = 'localhost') {
  const allocated = await httpRequest(port, 'POST', '/api/session-principals', {
    headers: bearerHeaders(bearer),
    body: { base_chat_id: baseName, machine, client_type: 'api' },
  })
  assert.equal(allocated.status, 200, allocated.text)
  return allocated.json().result
}

async function sendAddressed(port, capability, to, text, clientMessageId) {
  const sent = await httpRequest(port, 'POST', '/api/messages', {
    headers: sessionHeaders(capability),
    body: { to, text, client_message_id: clientMessageId },
  })
  assert.equal(sent.status, 200, sent.text)
  return sent.json().result
}

const roomsOf = async (port, headers) => {
  const response = await httpRequest(port, 'GET', '/api/rooms', { headers })
  assert.equal(response.status, 200, response.text)
  return response.json().result.rooms
}

const newKey = () => generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)

// --- AC1: three sessions of one installation, isolated from each other -------

test('AC1: a Session sees exactly its OWN pair rooms; a sibling session of the same installation sees a different list', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  const port = record.port

  const raw = newKey()
  const bearer = await installationBearer(port, world.sharedData, raw)
  const a = await allocateSession(port, bearer, 'alice')
  const b = await allocateSession(port, bearer, 'bob')
  const c = await allocateSession(port, bearer, 'carol')
  // A and B exchange a message, which opens their pair room.
  await sendAddressed(port, a.session_capability, b.address, 'hello bob', 'a-1')

  const roomsA = await roomsOf(port, sessionHeaders(a.session_capability))
  const roomsB = await roomsOf(port, sessionHeaders(b.session_capability))
  const roomsC = await roomsOf(port, sessionHeaders(c.session_capability))

  assert.equal(roomsA.length, 1, 'A belongs to exactly one pair room')
  assert.equal(roomsA[0].kind, 'direct')
  assert.equal(roomsA[0].peer_session_id, b.session_id, 'A sees B as its peer')
  assert.equal(roomsB.length, 1)
  assert.equal(roomsB[0].room_id, roomsA[0].room_id, 'B sees the same room')
  assert.equal(roomsB[0].peer_session_id, a.session_id, 'B sees A as its peer')

  // C is the THIRD session of the same installation: same fingerprint, same
  // realm, zero shared rooms.
  assert.deepEqual(roomsC, [], 'a sibling session sees no room it is not a member of')

  // And the sibling cannot read A and B's room either — the isolation is in
  // the ACL, not only in the listing.
  const denied = await httpRequest(port, 'GET', `/api/rooms/${roomsA[0].room_id}/messages?after_seq=0`, {
    headers: sessionHeaders(c.session_capability),
  })
  assert.equal(denied.status, 403, denied.text)
  assert.equal(denied.json().error.code, 'actor_not_member')
})

// --- AC2: a Bearer sees the Actor's rooms and NEVER a session-pair room ------

test('AC2: a Bearer sees the Broadcast and fingerprint direct rooms only — a session-pair room is invisible to it', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  const port = record.port

  const rawA = newKey()
  const bearerA = await installationBearer(port, world.sharedData, rawA)
  const a = await allocateSession(port, bearerA, 'alice')
  const b = await allocateSession(port, bearerA, 'bob')
  await sendAddressed(port, a.session_capability, b.address, 'private', 'a-1')

  // A fingerprint direct room for the SAME installation: the Bearer must keep
  // seeing this one (it is Actor-scoped, not session-scoped). The target must
  // hold a durable claim, so the peer binds its own Chat ID first via the
  // ordinary connect route.
  const status = await httpRequest(port, 'GET', '/api/status', { headers: bearerHeaders(bearerA) })
  const broadcast = status.json().result.broadcast_room_id
  const rawPeer = newKey()
  const peerBearer = await installationBearer(port, world.sharedData, rawPeer)
  const bound = await httpRequest(port, 'POST', '/api/session', {
    headers: bearerHeaders(peerBearer),
    body: { chat_id: 'dave' },
  })
  assert.equal(bound.status, 200, bound.text)
  const direct = await httpRequest(port, 'POST', '/api/rooms/direct', {
    headers: bearerHeaders(bearerA),
    body: { chat_id: 'dave' },
  })
  assert.equal(direct.status, 200, direct.text)
  const directRoomId = direct.json().result.room_id

  const rooms = await roomsOf(port, bearerHeaders(bearerA))
  const ids = rooms.map(room => room.room_id)
  assert.ok(ids.includes(broadcast), 'the Broadcast Room is listed for every Actor')
  assert.ok(ids.includes(directRoomId), 'a fingerprint direct room stays Actor-scoped')
  assert.equal(rooms.length, 2, `exactly two rooms, saw ${JSON.stringify(rooms)}`)
  for (const room of rooms) {
    assert.equal(Object.hasOwn(room, 'peer_session_id'), false, 'a Bearer row never carries a peer session id')
    assert.ok(!room.room_id.startsWith('ssession:'), 'a session-pair key never leaks into the Actor list')
  }
})

// --- AC3: read --peer over a real session, cursor and held projection --------

const parseReceipt = outcome => {
  assert.equal(outcome.status, 'ok', JSON.stringify(outcome))
  return JSON.parse(outcome.lines[0])
}

const scopeDirOf = pluginData => readdirSync(join(pluginData, 'sessions')).filter(name => !name.startsWith('.'))

// The CLI mints (or reuses) a session principal per scope. Its address lives
// in that scope's session.json — the only place this test learns where to
// send the messages the read is supposed to find, exactly as a real peer
// would learn it from `agent-room sessions`.
async function primeReaderSession({ pluginDataDir, sharedDataDir, env, peer, port }) {
  const first = await runReadFamilyCommand(['--peer', peer.address], { pluginDataDir, sharedDataDir, env })
  assert.equal(first.status, 'ok', JSON.stringify(first))
  assert.deepEqual(parseReceipt(first).messages, [], 'nothing has been sent yet')
  const stored = JSON.parse(readFileSync(join(pluginDataDir, 'sessions', env.AGENT_ROOM_SESSION_SCOPE, 'session.json'), 'utf8'))
  assert.match(stored.address, /~/, 'the scope holds a full session address')
  return stored.address
}

test('AC3/AC4: read --peer answers the pair page, advances read_seq (never notified_seq), and a held row has NO text key', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  const port = record.port

  // Two installations in ONE realm: the reader's trust matrix holds a remote
  // sender with no allowlist entry.
  const peerRaw = newKey()
  const peerBearer = await installationBearer(port, world.sharedData, peerRaw)
  const peer = await allocateSession(port, peerBearer, 'peer')

  const localDeps = { pluginDataDir: world.pluginData, sharedDataDir: world.sharedData, env: { AGENT_ROOM_SESSION_SCOPE: 'reader-scope' } }
  const readerAddress = await primeReaderSession({ ...localDeps, peer, port })
  for (const index of [1, 2, 3]) {
    await sendAddressed(port, peer.session_capability, readerAddress, `message ${index}`, `p-${index}`)
  }

  // The local-transport read: everything delivers, three rows, cursor moves.
  const localRead = await runReadFamilyCommand(['--peer', peer.address], localDeps)
  const localReceipt = parseReceipt(localRead)
  assert.equal(localReceipt.messages.length, 3, 'three rows for the three messages')
  assert.equal(localReceipt.next_after_seq, 3)
  assert.equal(localReceipt.read_seq, 3)
  assert.equal(localReceipt.cursor_written, true)
  await localRead.afterFlush()
  const localDoc = JSON.parse(readFileSync(join(world.pluginData, 'sessions', 'reader-scope', 'cursors.json'), 'utf8'))
  const roomEntry = localDoc.realms[localReceipt.realm_id].rooms[localReceipt.room_id]
  assert.equal(localDoc.version, 2)
  assert.equal(roomEntry.read_seq, 3, 'AC3: read_seq === 3')
  assert.equal(roomEntry.notified_seq, 0, 'AC3: notified_seq === 0 — nothing in this story advances it')
  for (const row of localReceipt.messages) {
    assert.deepEqual(Object.keys(row).sort(), ['from_address', 'seq', 'text', 'trusted'], 'the projection is exactly the four declared keys')
    assert.equal(row.trusted, true, 'local transport delivers')
    assert.equal(row.from_address, peer.address, 'attribution is the sender session address')
  }

  // The re-read is empty: the cursor did its job.
  const reRead = parseReceipt(await runReadFamilyCommand(['--peer', peer.base_name], localDeps))
  assert.deepEqual(reRead.messages, [], 'the consumed page is not re-delivered')
  assert.equal(reRead.next_after_seq, 3)
  assert.equal(reRead.room_id, localReceipt.room_id, 'the base name resolves to the same pair room')

  // AC4, on the declared-remote lane: the same rows arrive held — metadata
  // only, no text key at all, never the body. The reader's installation key
  // must be enrolled for the challenge lane, exactly as a remote peer's is.
  const keypair = loadOrCreateKeypair(world.pluginData)
  const store = openRoomLog({ dataDir: world.sharedData })
  const invite = store.mintInvite({ uses: 1, ttlSeconds: 3600 })
  store.close()
  const enrolled = await httpRequest(port, 'POST', '/api/auth/enroll', {
    headers: bearerHeaders(),
    body: {
      invite_token: invite.token,
      public_key: keypair.publicKey.toString('base64url'),
      signature: signWithInstallationKey(world.pluginData, Buffer.from(invite.token, 'utf8')).toString('base64url'),
    },
  })
  assert.equal(enrolled.status, 200, enrolled.text)

  const remoteDeps = {
    pluginDataDir: world.pluginData,
    sharedDataDir: world.sharedData,
    env: { AGENT_ROOM_SESSION_SCOPE: 'reader-remote-scope', [CONNECTION_MODE_ENV]: 'remote' },
  }
  await primeReaderSession({ ...remoteDeps, peer, port })
  const remoteReader = JSON.parse(readFileSync(join(world.pluginData, 'sessions', 'reader-remote-scope', 'session.json'), 'utf8'))
  await sendAddressed(port, peer.session_capability, remoteReader.address, 'secret plan', 'p-secret')

  const remoteRead = await runReadFamilyCommand(['--peer', peer.address], remoteDeps)
  const remoteReceipt = parseReceipt(remoteRead)
  assert.equal(remoteReceipt.transport, 'remote', 'the declaration earns the remote transport mark')
  assert.equal(remoteReceipt.messages.length, 1)
  const [heldRow] = remoteReceipt.messages
  assert.equal(heldRow.held, true, 'a non-allowlisted remote sender is held')
  assert.equal(heldRow.trusted, false)
  assert.equal(Object.hasOwn(heldRow, 'text'), false, 'AC4: a held row has NO text key at all')
  assert.deepEqual(Object.keys(heldRow).sort(), ['from_address', 'held', 'seq', 'trusted'])
  assert.equal(JSON.stringify(remoteReceipt.messages).includes('secret plan'), false, 'no body byte leaves')
})

// --- AC3: PEER_NO_ROOM is an empty page at exit 0, and creates nothing -------

test('PEER_NO_ROOM: --peer a session you never messaged answers an empty page at exit 0 and creates no room', async t => {
  const world = makeWorld(t)
  await world.waitReady()

  const port = (await world.waitReady()).port
  const allocations = await allocateSession(port, await installationBearer(port, world.sharedData, newKey()), 'ghost')

  const deps = { pluginDataDir: world.pluginData, sharedDataDir: world.sharedData, env: { AGENT_ROOM_SESSION_SCOPE: 'no-room-scope' } }
  const outcome = await runReadFamilyCommand(['--peer', allocations.address], deps)
  const receipt = parseReceipt(outcome)
  assert.equal(receipt.room_id, null)
  assert.deepEqual(receipt.messages, [])
  assert.equal(receipt.cursor_written, false)
  assert.equal(outcome.afterFlush, undefined, 'nothing to advance: no page was consumed')

  // Nothing was created anywhere: the pair room does not exist, and the
  // reading session's own room list is empty.
  const own = JSON.parse(readFileSync(join(world.pluginData, 'sessions', 'no-room-scope', 'session.json'), 'utf8'))
  const rooms = await roomsOf(port, sessionHeaders(own.capability))
  assert.deepEqual(rooms, [], 'a read never opens a pair room')
})

// --- AC3: STDOUT_FAIL keeps the cursor still --------------------------------

test('STDOUT_FAIL: a failing stdout (EPIPE) exits 1 and leaves read_seq untouched', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  const port = record.port

  const peerRaw = newKey()
  const peerBearer = await installationBearer(port, world.sharedData, peerRaw)
  const peer = await allocateSession(port, peerBearer, 'peer')
  const env = { AGENT_ROOM_SESSION_SCOPE: 'epipe-scope' }
  const deps = { pluginDataDir: world.pluginData, sharedDataDir: world.sharedData, env }
  const readerAddress = await primeReaderSession({ ...deps, peer, port })
  await sendAddressed(port, peer.session_capability, readerAddress, 'boom', 'p-1')

  const errors = []
  const previousExitCode = process.exitCode
  process.exitCode = undefined
  try {
    const outcome = await cliMain(['read', '--peer', peer.address], {
      input: { setEncoding() {}, on() {}, once() {}, removeListener() {} },
      // The consumer is gone: every write reports EPIPE, exactly as a closed
      // pipe does.
      output: {
        write(_text, callback) {
          const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })
          if (typeof callback === 'function') callback(error)
          return false
        },
      },
      errorOutput: { write: text => errors.push(text) },
      sharedDataDir: world.sharedData,
      pluginDataDir: world.pluginData,
      env,
    })
    assert.equal(outcome.status, 'refusal', 'a failed flush is not a success')
    assert.equal(process.exitCode, 1, 'STDOUT_FAIL exits 1')
    const coded = JSON.parse(errors[0])
    assert.equal(coded.code, 'EPIPE', 'the refusal names the transport failure')
    assert.match(coded.message, /cursor was not advanced/)
  } finally {
    process.exitCode = previousExitCode
  }

  // No cursor file was written at all: the page was not consumed.
  assert.equal(
    existsSync(join(world.pluginData, 'sessions', 'epipe-scope', 'cursors.json')),
    false,
    'a failed flush writes no cursor file',
  )
})

// --- AC3: the selector grammar and the exit-2 usage errors ------------------

test('usage: no selector exits 2 naming both flags; both selectors, a bad --limit and a missing peer are refused', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  const port = record.port
  const deps = { pluginDataDir: world.pluginData, sharedDataDir: world.sharedData, env: {} }

  const noSelector = await runReadFamilyCommand([], deps)
  assert.equal(noSelector.status, 'usage')
  assert.match(noSelector.message, /--peer/)
  assert.match(noSelector.message, /--room/)
  assert.match(noSelector.message, /selector is required/)

  const both = await runReadFamilyCommand(['--peer', 'peer-x', '--room', 'room-x'], deps)
  assert.equal(both.status, 'usage')
  assert.match(both.message, /mutually exclusive/)

  for (const limit of ['0', '201']) {
    const outcome = await runReadFamilyCommand(['--room', 'room-x', '--limit', limit], deps)
    assert.equal(outcome.status, 'usage', `--limit ${limit} is a usage error`)
    assert.match(outcome.message, /--limit/)
  }

  // A selector that resolves to nothing is the coded peer_not_found refusal
  // (exit 1, not a usage error): the grammar was fine, the peer was not.
  const missing = await runReadFamilyCommand(['--peer', 'nobody-here'], deps)
  assert.equal(missing.status, 'refusal')
  assert.equal(missing.code, 'peer_not_found')

  // The dispatcher maps usage to exit 2 and refusal to exit 1.
  const previousExitCode = process.exitCode
  process.exitCode = undefined
  try {
    await cliMain(['read'], {
      input: { setEncoding() {}, on() {}, once() {}, removeListener() {} },
      output: { write() {} },
      errorOutput: { write() {} },
      sharedDataDir: world.sharedData,
      pluginDataDir: world.pluginData,
      env: {},
    })
    assert.equal(process.exitCode, 2, 'a usage error exits 2')
  } finally {
    process.exitCode = previousExitCode
  }
})

// --- AC3: peer resolution — two sessions sharing a base name is ambiguous ---

test('peer resolution: a base name held by two sessions refuses peer_ambiguous; the full address resolves', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  const port = record.port

  // Two RETAINED principals sharing one base name. A base name is exclusive
  // only while its lease is live, so the first session releases its lease (it
  // stays retained for 30 days) and the second then takes the same base with
  // its own locator token. The addresses differ; the BASE is shared — which is
  // exactly the state a bare `--peer twin` cannot resolve on its own.
  const raw = newKey()
  const bearer = await installationBearer(port, world.sharedData, raw)
  const first = await allocateSession(port, bearer, 'twin', 'box-one')
  const released = await httpRequest(port, 'DELETE', '/api/session-principals/current', {
    headers: sessionHeaders(first.session_capability),
  })
  assert.equal(released.status, 200, released.text)
  const second = await allocateSession(port, bearer, 'twin', 'box-two')
  assert.equal(first.base_name, second.base_name)
  assert.notEqual(first.address, second.address)

  const deps = { pluginDataDir: world.pluginData, sharedDataDir: world.sharedData, env: { AGENT_ROOM_SESSION_SCOPE: 'ambig-scope' } }
  const ambiguous = await runReadFamilyCommand(['--peer', 'twin'], deps)
  assert.equal(ambiguous.status, 'refusal')
  assert.equal(ambiguous.code, 'peer_ambiguous', 'a shared base name is never guessed past')
  assert.match(ambiguous.message, /full address/)

  // The full address disambiguates: it resolves to one session, and the
  // never-messaged pair answers an empty page rather than an error.
  const exact = await runReadFamilyCommand(['--peer', first.address], deps)
  assert.equal(exact.status, 'ok', JSON.stringify(exact))
  const receipt = parseReceipt(exact)
  assert.equal(receipt.peer_session_id, first.session_id)
  assert.notEqual(first.session_id, second.session_id)
})
