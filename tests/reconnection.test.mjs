// Story 2.2 acceptance: reconnection & room discovery over the real HTTP path.
// Every matrix row runs against real spawned server children (node:test with
// real child processes) with real keypairs, real 0600 local-token files, and
// real createAgentRoomClient instances. The reconnect seams (reconnectSleep,
// reconnectRandom, reconnectProbe) pace time only — they never fake the
// server, the store, or the HTTP path: the escalation row's server child is
// really killed, the recovery rows really restart on new ports, and the
// preserved-contract row rides the client's REAL default recovery probe.
//
// The enumeration rows project against a second read-only-style SQLite
// connection on the WAL file (the session-routes inspection style); the
// returning clients are fresh createAgentRoomClient instances with no cached
// port or token. The catch-up and cursor rows drive the real MCP adapter
// in-process over real JSON-RPC streams, so the client-owned cursor file
// (the adapter's monotonic merge) is exercised, not re-implemented. Every
// wait is deadline-bounded; no test sleeps for real seconds. Oracles are
// literals in this file.

import assert from 'node:assert/strict'
import { existsSync, lstatSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import http from 'node:http'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { DatabaseSync } from 'node:sqlite'

import { createAgentRoomClient, reconnectDelayMs } from '../server/client/api-client.mjs'
import { createMcpServer } from '../server/mcp-stdio.mjs'
import { loadOrCreateLocalToken } from '../server/api/local-token.mjs'
import { loadOrCreateKeypair } from '../server/keys.mjs'
import { atomicWriteJson } from '../server/runtime.mjs'
import { ROOM_LOG_DATABASE_FILENAME } from '../server/store/room-log.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = join(ROOT, 'server', 'api', 'server.mjs')
const RUNTIME_RECORD_FILENAME = 'runtime.json'
const PROTOCOL_KEY = 'agent-room-protocol'
const DB_FILENAME = ROOM_LOG_DATABASE_FILENAME

// Harness budgets: local constants of this file, never production modules.
const STARTUP_DEADLINE_MS = 10 * 1000
const CALL_DEADLINE_MS = 10 * 1000
const POLL_MS = 25

const sleep = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })

// Every wait is deadline-bounded: a hung call fails the test, never the clock.
async function withDeadline(promise, label, budgetMs = CALL_DEADLINE_MS) {
  let timer = null
  try {
    return await Promise.race([
      promise,
      new Promise((_, rejectPromise) => {
        timer = setTimeout(() => rejectPromise(new Error(`${label} exceeded its ${budgetMs}ms deadline`)), budgetMs)
      }),
    ])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

const range = (from, to) => Array.from({ length: to - from + 1 }, (_, index) => from + index)

// One installation identity: a real Ed25519 keypair, presented the way the
// 1.1-born client presents it — the raw 32-byte public key, base64url.
function installation() {
  const { publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const raw = spki.subarray(spki.length - 32)
  return { publicKey: raw.toString('base64url') }
}

function makeDataDir(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-reconnection-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  return dataDir
}

// One installation's PLUGIN_DATA: a 0700 directory whose 0600 config names
// the Chat ID the setup command would have written.
function makePluginDir(t, chatId) {
  const pluginData = mkdtempSync(join(tmpdir(), 'agent-room-reconnection-client-'))
  atomicWriteJson(join(pluginData, 'config.json'), { chat_id: chatId })
  t.after(() => rmSync(pluginData, { recursive: true, force: true }))
  return pluginData
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
    const deadline = Date.now() + STARTUP_DEADLINE_MS
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
      await sleep(POLL_MS)
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

// The Story 1.4 credential exchange against a running server.
function exchange(port, installation_, localToken) {
  return request(port, 'POST', '/api/auth/local', {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${localToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ public_key: installation_.publicKey }),
  })
}

function sessionRequest(port, method, sessionToken, body) {
  return request(port, method, '/api/session', {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${sessionToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

async function connectRaw(port, localToken, installation_, chatId) {
  const auth = await exchange(port, installation_, localToken)
  assert.equal(auth.status, 200, auth.text)
  const sessionToken = auth.json().result.session_token
  const connected = await sessionRequest(port, 'POST', sessionToken, { chat_id: chatId })
  assert.equal(connected.status, 200, connected.text)
  return sessionToken
}

async function directOpenRaw(port, sessionToken, chatId) {
  const response = await request(port, 'POST', '/api/rooms/direct', {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${sessionToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ chat_id: chatId }),
  })
  assert.equal(response.status, 200, response.text)
  return response.json().result
}

async function sendRaw(port, sessionToken, senderChatId, roomId, clientMessageId, text) {
  const response = await request(port, 'POST', `/api/rooms/${encodeURIComponent(roomId)}/messages`, {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${sessionToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ chat_id: senderChatId, client_message_id: clientMessageId, text }),
  })
  assert.equal(response.status, 200, response.text)
  return response.json().result
}

// A returning client's predecessor: the SAME installation (the keypair files
// in its PLUGIN_DATA) driven over raw HTTP for its one-time bind, then a
// clean disconnect — the live name is freed, the durable claim row stays (the
// documented disconnect semantics), and the fresh client instance can bind
// again without colliding with a still-live holder.
async function retireInstallation(port, localToken, pluginData, chatId) {
  const { publicKey } = loadOrCreateKeypair(pluginData)
  const identity = { publicKey: publicKey.toString('base64url') }
  const sessionToken = await connectRaw(port, localToken, identity, chatId)
  const released = await sessionRequest(port, 'DELETE', sessionToken)
  assert.equal(released.status, 200, released.text)
  return identity
}

// Durable rows, read straight from the store's SQLite file — the same
// second-connection inspection style tests/session-routes.test.mjs uses.
function sqlRows(dataDir, query) {
  const db = new DatabaseSync(join(dataDir, DB_FILENAME))
  try {
    return db.prepare(query).all()
  } finally {
    db.close()
  }
}

const roomRows = dataDir => sqlRows(
  dataDir,
  'SELECT id, kind, pair_key, created_by_fingerprint, created_at FROM rooms ORDER BY created_at ASC, id ASC',
)
const claimRows = dataDir => sqlRows(
  dataDir,
  'SELECT chat_id_normalized, actor_fingerprint, chat_id_display, last_seen_at FROM chat_id_claims ORDER BY chat_id_display, actor_fingerprint',
)
const directMemberRows = dataDir => sqlRows(
  dataDir,
  'SELECT room_id, actor_fingerprint, joined_at FROM direct_members ORDER BY room_id, actor_fingerprint',
)

function cursorValue(pluginData, realmId, roomId) {
  return JSON.parse(
    readFileSync(join(pluginData, 'realms', realmId, 'cursors.json'), 'utf8'),
  ).cursors[roomId].after_seq
}

// The real MCP adapter, driven in-process over real JSON-RPC streams: the
// cursor rows observe the adapter's own client-owned cursor file, so the
// monotonic merge is exercised, never re-implemented. The adapter's client
// attaches to the spawned server through the shared data dir exactly as a
// real child would.
function startLocalMcp(t, { dataDir, pluginData }) {
  const input = new PassThrough()
  const output = new PassThrough()
  const server = createMcpServer({
    input,
    output,
    env: { ...process.env, AGENT_ROOM_DATA_DIR: dataDir, PLUGIN_DATA: pluginData },
  })
  t.after(() => server.close())

  let buffer = ''
  const pending = new Map()
  let nextId = 1
  output.setEncoding('utf8')
  output.on('data', chunk => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline === -1) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.trim().length === 0) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      const settle = pending.get(message.id)
      if (settle !== undefined) {
        pending.delete(message.id)
        settle(message)
      }
    }
  })

  const call = (method, params) => new Promise((resolvePromise, rejectPromise) => {
    const id = nextId
    nextId += 1
    const timer = setTimeout(() => {
      if (pending.delete(id)) {
        rejectPromise(new Error(`the in-process MCP call ${method} exceeded its ${CALL_DEADLINE_MS}ms deadline`))
      }
    }, CALL_DEADLINE_MS)
    pending.set(id, message => {
      clearTimeout(timer)
      resolvePromise(message)
    })
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`)
  })

  return {
    async initialize() {
      const response = await call('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'agent-room-reconnection-test', version: '0.0.0' },
      })
      assert.equal(response.result?.serverInfo?.name, 'agent-room')
    },
    async tool(name, args = {}) {
      const response = await withDeadline(call('tools/call', { name, arguments: args }), `MCP tool ${name}`)
      if (response.error !== undefined) {
        throw new Error(`the in-process MCP call failed: ${JSON.stringify(response.error)}`)
      }
      const structured = response.result?.structuredContent
      if (structured?.ok === false) {
        throw new Error(`the tool answered an error: ${JSON.stringify(structured)}`)
      }
      return structured
    },
  }
}

// --- Enumeration rows --------------------------------------------------------------

test('enumeration: the returning session lists the Broadcast Room first, then its DMs in creation order, exactly {room_id, kind}', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  assert.equal(lstatSync(join(dataDir, 'local-token')).mode & 0o777, 0o600, 'the local token file is 0600')

  const alicePlugin = makePluginDir(t, 'Alice')
  const bobPlugin = makePluginDir(t, 'Bob')
  const carolPlugin = makePluginDir(t, 'Carol')

  // Alice's installation claimed its name once and went away: the live name
  // is freed, the durable claim row stays for offline resolution.
  await retireInstallation(record.port, localToken, alicePlugin, 'Alice')

  // Live peer sessions; each opens its pair room with the offline Alice
  // through the durable claims index, in a pinned creation order.
  const bob = createAgentRoomClient({ dataDir, pluginDataDir: bobPlugin })
  const carol = createAgentRoomClient({ dataDir, pluginDataDir: carolPlugin })
  await withDeadline(bob.status(), 'bob bind')
  await withDeadline(carol.status(), 'carol bind')
  const bobOpen = await withDeadline(bob.directOpen({ chatId: 'Alice' }), 'bob opens alice')
  await sleep(5)
  const carolOpen = await withDeadline(carol.directOpen({ chatId: 'Alice' }), 'carol opens alice')
  await sleep(5)

  // Alice's client reconnects — a fresh instance, no cached port or token —
  // and enumerates.
  const returning = createAgentRoomClient({ dataDir, pluginDataDir: alicePlugin })
  const status = await withDeadline(returning.status(), 'returning status')
  const first = await withDeadline(returning.listRooms(), 'listRooms (first call)')
  const second = await withDeadline(returning.listRooms(), 'listRooms (second call)')
  assert.deepEqual(first, second, 'two calls, one deterministic order')

  assert.deepEqual(Object.keys(first).sort(), ['rooms'], 'the response is exactly {rooms: [...]}')
  assert.equal(first.rooms.length, 3)
  for (const row of first.rooms) {
    assert.deepEqual(Object.keys(row).sort(), ['kind', 'room_id'],
      'a row carries exactly the frozen-vocabulary projection — no pair_key, title, creator, or timestamp')
    assert.ok(['broadcast', 'direct'].includes(row.kind), row.kind)
  }
  assert.deepEqual(first.rooms, [
    { room_id: status.broadcast_room_id, kind: 'broadcast' },
    { room_id: bobOpen.room_id, kind: 'direct' },
    { room_id: carolOpen.room_id, kind: 'direct' },
  ])

  // The room ids byte-match the store's own rows, in the store's order.
  assert.deepEqual(
    first.rooms.map(row => [row.room_id, row.kind]),
    roomRows(dataDir).map(row => [row.id, row.kind]),
  )
  await stop()
})

test('enumeration: a DM opened while the client was away is discovered and immediately readable', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alicePlugin = makePluginDir(t, 'Alice')
  const bobPlugin = makePluginDir(t, 'Bob')

  // Alice is away: her installation's durable claim is all that remains.
  await retireInstallation(record.port, localToken, alicePlugin, 'Alice')

  // A live session resolves the offline Alice through the durable claims
  // index and opens the pair room in her absence.
  const bob = createAgentRoomClient({ dataDir, pluginDataDir: bobPlugin })
  await withDeadline(bob.status(), 'bob bind')
  const opened = await withDeadline(bob.directOpen({ chatId: 'Alice' }), 'bob opens the absent alice')
  const sent = await withDeadline(bob.sendMessage({
    roomId: opened.room_id,
    clientMessageId: 'dm-1',
    text: 'opened while you were away',
  }), 'bob sends into the new DM')
  assert.equal(sent.status, 'committed')

  // Alice's client reconnects and enumerates: the DM is listed with no prior
  // knowledge on her side, and its id is the one bob's open returned.
  const alice = createAgentRoomClient({ dataDir, pluginDataDir: alicePlugin })
  const rooms = await withDeadline(alice.listRooms(), 'alice enumerates')
  const discovered = rooms.rooms.find(row => row.room_id === opened.room_id)
  assert.ok(discovered, 'the DM bob opened during the absence is listed')
  assert.equal(discovered.kind, 'direct')

  // She reads from it immediately under her cursor discipline — membership
  // came from the room bob opened, never from any enrollment on her side.
  const page = await withDeadline(alice.readMessage({ roomId: opened.room_id, afterSeq: 0 }), 'alice reads the DM')
  assert.equal(page.messages.length, 1)
  assert.equal(page.messages[0].seq, 1)
  assert.equal(page.next_after_seq, 1)
  assert.equal(page.head_seq, 1)
  // Bob's body is foreign: the static untrusted envelope wraps it.
  assert.match(page.messages[0].text, /opened while you were away/)
  assert.match(page.messages[0].text, /untrusted_message/)
  await stop()
})

test('enumeration: third-party DMs never appear; the same-Actor DM does', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const alicePlugin = makePluginDir(t, 'Alice')
  const bobPlugin = makePluginDir(t, 'Bob')
  const carolPlugin = makePluginDir(t, 'Carol')
  const davePlugin = makePluginDir(t, 'Dave')

  const alice = createAgentRoomClient({ dataDir, pluginDataDir: alicePlugin })
  const bob = createAgentRoomClient({ dataDir, pluginDataDir: bobPlugin })
  const carol = createAgentRoomClient({ dataDir, pluginDataDir: carolPlugin })
  const dave = createAgentRoomClient({ dataDir, pluginDataDir: davePlugin })
  await withDeadline(alice.status(), 'alice bind')
  await withDeadline(bob.status(), 'bob bind')
  await withDeadline(carol.status(), 'carol bind')
  await withDeadline(dave.status(), 'dave bind')
  const statusA = await withDeadline(alice.status(), 'alice status')

  const aliceBob = await withDeadline(alice.directOpen({ chatId: 'Bob' }), 'open the alice-bob DM')
  await sleep(5)
  const carolDave = await withDeadline(carol.directOpen({ chatId: 'Dave' }), 'open the carol-dave DM')
  await sleep(5)
  const selfDm = await withDeadline(alice.directOpen({ chatId: 'Alice' }), 'open the same-Actor DM')

  const rooms = await withDeadline(alice.listRooms(), 'alice enumerates')
  assert.deepEqual(rooms.rooms, [
    { room_id: statusA.broadcast_room_id, kind: 'broadcast' },
    { room_id: aliceBob.room_id, kind: 'direct' },
    { room_id: selfDm.room_id, kind: 'direct' },
  ])
  assert.equal(
    rooms.rooms.some(row => row.room_id === carolDave.room_id),
    false,
    `a third-party DM leaked into the enumeration; direct_members: ${JSON.stringify(directMemberRows(dataDir))}`,
  )

  // The same-Actor room appears because its single membership row names
  // alice — the same fingerprint twice.
  const selfMembers = directMemberRows(dataDir).filter(row => row.room_id === selfDm.room_id)
  assert.deepEqual(
    selfMembers.map(row => row.actor_fingerprint),
    [alice.fingerprint],
    `the self-DM's membership rows: ${JSON.stringify(directMemberRows(dataDir))}`,
  )
  await stop()
})

test('enumeration: a fresh realm lists exactly the Broadcast Room, whose id matches /api/status', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  await waitReady()
  const pluginData = makePluginDir(t, 'Nia')

  // A newly connected session: implicit membership needs no enrollment event.
  const client = createAgentRoomClient({ dataDir, pluginDataDir: pluginData })
  const status = await withDeadline(client.status(), 'status')
  const rooms = await withDeadline(client.listRooms(), 'listRooms')
  assert.deepEqual(rooms, { rooms: [{ room_id: status.broadcast_room_id, kind: 'broadcast' }] })
  await stop()
})

test('enumeration rejections: the frozen route denies everything but a clean session-token GET and changes no state', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const before = roomRows(dataDir)
  assert.equal(before.length, 1, 'the fresh realm holds exactly the Broadcast Room')
  const broadcastId = before[0].id

  // A valid session token (exchanged, unbound — the route needs no Chat ID).
  const auth = await exchange(record.port, installation(), localToken)
  assert.equal(auth.status, 200, auth.text)
  const sessionToken = auth.json().result.session_token
  const authedHeaders = { [PROTOCOL_KEY]: '1', authorization: `Bearer ${sessionToken}` }

  // No credential: 401 unauthorized.
  const anonymous = await request(record.port, 'GET', '/api/rooms', { headers: { [PROTOCOL_KEY]: '1' } })
  assert.equal(anonymous.status, 401)
  assert.equal(anonymous.json().error.code, 'unauthorized')

  // Any query key is an unknown_field rejection (the route's requestFields
  // stay empty).
  const fielded = await request(record.port, 'GET', '/api/rooms?limit=5', { headers: authedHeaders })
  assert.equal(fielded.status, 400)
  assert.equal(fielded.json().error.code, 'unknown_field')
  assert.match(fielded.json().error.message, /"limit"/)

  // Duplicate query keys are a malformed request, not last-key-wins.
  const duplicated = await request(record.port, 'GET', '/api/rooms?a=1&a=1', { headers: authedHeaders })
  assert.equal(duplicated.status, 400)
  assert.equal(duplicated.json().error.code, 'invalid_request')

  // The protocol gate applies to the actor class.
  const ungated = await request(record.port, 'GET', '/api/rooms', {
    headers: { authorization: `Bearer ${sessionToken}` },
  })
  assert.equal(ungated.status, 400)
  assert.equal(ungated.json().error.code, 'protocol_required')

  // POST matches no route — 404 route_not_found behind the gates.
  const posted = await request(record.port, 'POST', '/api/rooms', { headers: authedHeaders })
  assert.equal(posted.status, 404)
  assert.equal(posted.json().error.code, 'route_not_found')

  // Every rejection changed no state and leaked no room data.
  assert.deepEqual(roomRows(dataDir), before)
  for (const denial of [anonymous, fielded, duplicated, ungated, posted]) {
    assert.equal(denial.text.includes(broadcastId), false, `a denial leaked room data: ${denial.text}`)
  }
  await stop()
})

// --- Reconnection rows --------------------------------------------------------------

test('reconnection: after a restart the fresh client re-authenticates locally and re-claims the same Chat ID', async t => {
  const dataDir = makeDataDir(t)
  const first = spawnServerChild(t, dataDir)
  const recordA = await first.waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alicePlugin = makePluginDir(t, 'Alice')

  const firstClient = createAgentRoomClient({ dataDir, pluginDataDir: alicePlugin })
  const statusA = await withDeadline(firstClient.status(), 'the first status')
  const fingerprint = firstClient.fingerprint
  const claimBefore = claimRows(dataDir).find(row => row.actor_fingerprint === fingerprint)
  assert.equal(claimBefore.chat_id_display, 'Alice')

  // The restart: the in-memory session and live-Chat-ID registries clear by
  // design; the durable claim row survives.
  await first.stop()
  const second = spawnServerChild(t, dataDir)
  const recordB = await second.waitReady()
  assert.notEqual(recordB.port, recordA.port)

  // The fresh client process calls a tool-surface method: the 0600 local
  // token plus its public key exchange a NEW session token at POST
  // /api/auth/local (the old token died with the process — only a fresh
  // exchange can authenticate), and the bind re-claims the same Chat ID (no
  // holder exists post-restart, so no chat_id_taken).
  const returning = createAgentRoomClient({ dataDir, pluginDataDir: alicePlugin })
  const statusB = await withDeadline(returning.status(), 'the returning status')
  assert.equal(statusB.realm_id, statusA.realm_id, 'the realm survived the restart')
  assert.equal(statusB.broadcast_room_id, statusA.broadcast_room_id, 'the Broadcast Room survived')
  assert.equal(returning.chatId, 'Alice', 'the SAME Chat ID re-bound')
  assert.equal(returning.fingerprint, fingerprint, 'the SAME Actor re-bound')

  // The durable claim row advanced — never backward — under the same identity.
  const claimAfter = claimRows(dataDir).find(row => row.actor_fingerprint === fingerprint)
  assert.equal(claimAfter.chat_id_display, 'Alice')
  assert.ok(
    claimAfter.last_seen_at > claimBefore.last_seen_at,
    `the claim advanced (${claimBefore.last_seen_at} -> ${claimAfter.last_seen_at})`,
  )

  // Presence shows the re-claimed name online for the same fingerprint.
  const presence = await withDeadline(returning.presence(), 'the returning presence')
  assert.ok(
    presence.online.some(row => row.chat_id === 'Alice' && row.fingerprint === fingerprint),
    `presence: ${JSON.stringify(presence)}`,
  )
  await second.stop()
})

test('reconnection: re-picking binds the new name while the old durable claim row stays', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const pluginData = makePluginDir(t, 'Alice')

  // The installation's first life: bound, then cleanly disconnected — the
  // live name freed, the durable claim row kept.
  const { fingerprint } = loadOrCreateKeypair(pluginData)
  await retireInstallation(record.port, localToken, pluginData, 'Alice')
  const claimsBefore = claimRows(dataDir).filter(row => row.actor_fingerprint === fingerprint)
  assert.deepEqual(claimsBefore.map(row => row.chat_id_display), ['Alice'])

  // The setup command's re-run artifact: the config now names a new Chat ID.
  atomicWriteJson(join(pluginData, 'config.json'), { chat_id: 'Alicia' })

  // A fresh client connects against the live server: the new name binds.
  const returning = createAgentRoomClient({ dataDir, pluginDataDir: pluginData })
  await withDeadline(returning.status(), 'the returning status')
  assert.equal(returning.chatId, 'Alicia', 'the new name bound')

  // The OLD durable claim row remains — claims are never deleted on connect
  // or rename — and presence shows the new name for the fingerprint.
  const claimsAfter = claimRows(dataDir).filter(row => row.actor_fingerprint === fingerprint)
  assert.deepEqual(
    claimsAfter.map(row => row.chat_id_display).sort(),
    ['Alice', 'Alicia'],
    `claims: ${JSON.stringify(claimRows(dataDir))}`,
  )
  const presence = await withDeadline(returning.presence(), 'the returning presence')
  const ownRows = presence.online.filter(row => row.fingerprint === fingerprint)
  assert.deepEqual(ownRows.map(row => row.chat_id), ['Alicia'], `presence: ${JSON.stringify(presence)}`)
  await stop()
})

// --- Catch-up rows (the real MCP adapter, real cursor file) -------------------------

async function startCatchUpWorld(t) {
  const dataDir = makeDataDir(t)
  const spawned = spawnServerChild(t, dataDir)
  const record = await spawned.waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const readerPlugin = makePluginDir(t, 'Rita')

  const mcp = startLocalMcp(t, { dataDir, pluginData: readerPlugin })
  await mcp.initialize()

  // The reader binds through its first tool call; the peer session then
  // opens the pair room with the reader's resolved claim.
  const status = await mcp.tool('room_status')
  const realmId = status.realm_id
  const beaToken = await connectRaw(record.port, localToken, installation(), 'Bea')
  const room = (await directOpenRaw(record.port, beaToken, 'Rita')).room_id

  // One pre-absence message fixes the persisted cursor at 1.
  await sendRaw(record.port, beaToken, 'Bea', room, 'seed', 'before the absence')
  const firstPage = await mcp.tool('message_read', { room_id: room })
  assert.deepEqual(firstPage.messages.map(message => message.seq), [1])
  assert.equal(cursorValue(readerPlugin, realmId, room), 1, 'the persisted cursor sits at the pre-absence seq')

  return { record, localToken, readerPlugin, mcp, realmId, room, beaToken, spawned }
}

test('catch-up: bounded pages tile [cursor+1 … head] exactly once and stop at head-at-read-time', async t => {
  const { readerPlugin, mcp, realmId, room, beaToken, record, spawned } = await startCatchUpWorld(t)

  // 120 messages accumulate while the reader is absent.
  for (let seq = 2; seq <= 121; seq += 1) {
    await sendRaw(record.port, beaToken, 'Bea', room, `backlog-${seq}`, `backlog ${seq}`)
  }

  // The catch-up loop: cursorless reads (after_seq omitted — the persisted
  // cursor resumes), default limit (50), until a page's next_after_seq
  // reaches the head observed at that read.
  const seen = []
  let pages = 0
  for (;;) {
    const page = await mcp.tool('message_read', { room_id: room })
    pages += 1
    assert.ok(pages < 10, `the loop terminated in bounded pages (${pages} so far)`)
    assert.ok(page.messages.length <= 50, `a page is bounded by the default limit (got ${page.messages.length})`)
    assert.equal(typeof page.next_after_seq, 'number', 'the page carries next_after_seq')
    assert.equal(typeof page.head_seq, 'number', 'the page carries head_seq')
    const headAtRead = page.head_seq
    seen.push(...page.messages.map(message => message.seq))
    if (page.next_after_seq >= headAtRead) break
  }
  assert.deepEqual(
    seen,
    range(2, 121),
    'the pages tile [cursor+1 … head] exactly once each: no gap, no re-delivery, no room straddling',
  )
  assert.equal(cursorValue(readerPlugin, realmId, room), 121, 'the durable cursor reached the head')
  await spawned.stop()
})

test('catch-up: traffic arriving between pages is read under the same cursor discipline', async t => {
  const { readerPlugin, mcp, realmId, room, beaToken, record, spawned } = await startCatchUpWorld(t)
  for (let seq = 2; seq <= 121; seq += 1) {
    await sendRaw(record.port, beaToken, 'Bea', room, `backlog-${seq}`, `backlog ${seq}`)
  }

  // Page one of the catch-up.
  const pageOne = await mcp.tool('message_read', { room_id: room })
  assert.deepEqual(pageOne.messages.map(message => message.seq), range(2, 51))
  assert.equal(pageOne.head_seq, 121)

  // The head moves while the reader is between pages.
  for (let seq = 122; seq <= 131; seq += 1) {
    await sendRaw(record.port, beaToken, 'Bea', room, `late-${seq}`, `late ${seq}`)
  }

  // The next pages return the arrivals under the same discipline: strictly
  // after the last consumed seq, bounded, cursor-advancing — no gap at the
  // arrival boundary, no re-delivered page, no required restart of the read.
  const pageTwo = await mcp.tool('message_read', { room_id: room })
  assert.deepEqual(pageTwo.messages.map(message => message.seq), range(52, 101))
  assert.equal(pageTwo.head_seq, 131, 'the moved head is observed at this read')
  const pageThree = await mcp.tool('message_read', { room_id: room })
  assert.deepEqual(pageThree.messages.map(message => message.seq), range(102, 131))
  assert.equal(pageThree.next_after_seq, 131)
  assert.equal(pageThree.head_seq, 131)

  const seen = [pageOne, pageTwo, pageThree].flatMap(page => page.messages.map(message => message.seq))
  assert.deepEqual(seen, range(2, 131), 'no message skipped, none silently dropped, none delivered twice')
  assert.equal(cursorValue(readerPlugin, realmId, room), 131)
  await spawned.stop()
})

test('cursor discipline: an explicit low page during catch-up re-reads history but never regresses the durable cursor', async t => {
  const { readerPlugin, mcp, realmId, room, beaToken, record, spawned } = await startCatchUpWorld(t)
  for (let seq = 2; seq <= 121; seq += 1) {
    await sendRaw(record.port, beaToken, 'Bea', room, `backlog-${seq}`, `backlog ${seq}`)
  }
  const pageOne = await mcp.tool('message_read', { room_id: room })
  assert.deepEqual(pageOne.messages.map(message => message.seq), range(2, 51))
  assert.equal(cursorValue(readerPlugin, realmId, room), 51)

  // The low page re-reads history — re-delivery after reconnect is permitted
  // (FR-8) — but the durable cursor keeps its higher value: the monotonic
  // max(existing, next_after_seq) merge, observed through the client
  // library's own cursor file.
  const low = await mcp.tool('message_read', { room_id: room, after_seq: 0, limit: 1 })
  assert.deepEqual(low.messages.map(message => message.seq), [1])
  assert.equal(low.next_after_seq, 1)
  assert.equal(cursorValue(readerPlugin, realmId, room), 51, 'the durable cursor never moved backwards')

  // The next cursorless read resumes from the advanced value, not the low
  // page's: the consumed pages are not re-delivered as new.
  const resumed = await mcp.tool('message_read', { room_id: room })
  assert.deepEqual(resumed.messages.map(message => message.seq), range(52, 101))
  assert.equal(resumed.next_after_seq, 101)
  assert.equal(cursorValue(readerPlugin, realmId, room), 101)
  await spawned.stop()
})

// --- Backoff rows -------------------------------------------------------------------

test('backoff schedule: the pure delay doubles 1 s→60 s and is uniformly jittered ±0.1, rounded to whole milliseconds', () => {
  // Literal oracles: the base schedule at the declared constants, its low
  // (base × 0.9) and high (base × 1.1) bounds, and the bare base at the
  // midpoint of the jitter band. The cap repeats from the seventh retry on.
  const bases = [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]
  const lows = [900, 1800, 3600, 7200, 14400, 28800, 54000, 54000, 54000]
  const highs = [1100, 2200, 4400, 8800, 17600, 35200, 66000, 66000, 66000]
  for (let index = 0; index < bases.length; index += 1) {
    const retry = index + 1
    assert.equal(reconnectDelayMs(retry, { random: () => 0 }), lows[index], `retry ${retry} low bound`)
    assert.equal(reconnectDelayMs(retry, { random: () => 1 }), highs[index], `retry ${retry} high bound`)
    assert.equal(reconnectDelayMs(retry, { random: () => 0.5 }), bases[index], `retry ${retry} bare base`)
  }
  for (let index = 0; index < bases.length; index += 1) {
    for (const seed of [0, 0.125, 0.25, 0.5, 0.75, 1]) {
      const delay = reconnectDelayMs(index + 1, { random: () => seed })
      assert.ok(Number.isInteger(delay), `rounded to an integer (retry ${index + 1}, seed ${seed}: ${delay})`)
      assert.ok(
        delay >= lows[index] && delay <= highs[index],
        `within the jitter band (retry ${index + 1}, seed ${seed}: ${delay})`,
      )
    }
  }
  // The schedule starts at the first retry; junk retries are refused.
  assert.throws(() => reconnectDelayMs(0), /retry/)
  assert.throws(() => reconnectDelayMs(1.5), /retry/)
})

test('backoff loop: a dead recorded connection escalates through the full schedule in one call and surfaces the last real error', async t => {
  const dataDir = makeDataDir(t)
  const { child, waitReady } = spawnServerChild(t, dataDir)
  await waitReady()
  const pluginData = makePluginDir(t, 'Alice')
  const sleeps = []
  const client = createAgentRoomClient({
    dataDir,
    pluginDataDir: pluginData,
    reconnectSleep: async ms => { sleeps.push(ms) },
    // Seeded at the jitter band's midpoint: every wait is exactly its base
    // delay, so the recorded slices reconstruct the literal schedule below.
    reconnectRandom: () => 0.5,
  })
  // The warm-up caches the port and the session while the server is alive.
  await withDeadline(client.status(), 'the warm-up status')

  // The server child is really killed: its recorded port refuses connections,
  // and the real (default) recovery probe — the recorded runtime record's
  // port — never answers agent-room during any wait.
  child.kill('SIGKILL')
  await once(child, 'exit')

  const started = Date.now()
  await assert.rejects(
    () => withDeadline(client.status(), 'the dead-connection call'),
    error => error?.outcomeUnknown === true && error?.transportCode === 'ECONNREFUSED',
    'after the capped wait\'s attempt fails, the last real transport error surfaces',
  )
  // The injected sleep paced the whole escalation: no real seconds passed.
  assert.ok(Date.now() - started < 5_000, `the loop must not sleep for real (took ${Date.now() - started}ms)`)

  // Attempt 1 was immediate (no wait precedes it), then the loop waited
  // exactly the schedule's delays in order — seven waits at the declared
  // constants, reconstructed here from the probe-cadence slices (every
  // scheduled delay is a multiple of the 250 ms cadence).
  const schedule = [1000, 2000, 4000, 8000, 16000, 32000, 60000]
  const cadence = 250
  assert.deepEqual(
    sleeps,
    schedule.flatMap(delay => {
      const slices = []
      for (let remaining = delay; remaining > 0; remaining -= cadence) {
        slices.push(Math.min(cadence, remaining))
      }
      return slices
    }),
  )
})

test('backoff loop: a detected agent-room recovery cuts the first wait and the immediate retry re-authenticates and succeeds', async t => {
  const dataDir = makeDataDir(t)
  const first = spawnServerChild(t, dataDir)
  const recordA = await first.waitReady()
  const pluginData = makePluginDir(t, 'Alice')
  const sleeps = []
  let probeArmed = false
  const client = createAgentRoomClient({
    dataDir,
    pluginDataDir: pluginData,
    reconnectSleep: async ms => {
      sleeps.push(ms)
      probeArmed = true
    },
    reconnectProbe: async () => (probeArmed
      ? { reachable: true, agentRoom: true }
      : { reachable: false, agentRoom: false }),
  })
  const warm = await withDeadline(client.status(), 'the warm-up status')

  // The recorded server dies; a fresh one answers on a new port (its runtime
  // record published) before the client's next call.
  await first.stop()
  const second = spawnServerChild(t, dataDir)
  const recordB = await second.waitReady()
  assert.notEqual(recordB.port, recordA.port)

  // The detected recovery cut the first wait: the immediate retry re-resolved
  // the recorded server, re-authenticated (a dead token cannot bind), and
  // re-claimed the Chat ID.
  const recovered = await withDeadline(client.status(), 'the recovery call')
  assert.equal(recovered.realm_id, warm.realm_id, 'the same realm answers')
  assert.equal(client.chatId, 'Alice', 'the same Chat ID re-bound — the retry re-authenticated')

  // The first wait ended early: exactly one probe-cadence slice elapsed — no
  // further slice sleeps — and the total recorded wait is strictly below the
  // scheduled first delay (1000 ms). Detection rode the injected read-only
  // probe; it mutated nothing and booted nothing.
  assert.deepEqual(sleeps, [250])
  assert.ok(sleeps[0] < 1000, 'the detected recovery cut the wait short')
  await second.stop()
})

test('existing single-recovery preserved: a restart on a new port recovers on the immediate first attempt with zero backoff waits', async t => {
  const dataDir = makeDataDir(t)
  const first = spawnServerChild(t, dataDir)
  const recordA = await first.waitReady()
  const pluginData = makePluginDir(t, 'Alice')
  const sleeps = []
  // No injected probe: the client's REAL default recovery probe (the recorded
  // runtime record's port, health-probed) does the detection.
  const client = createAgentRoomClient({
    dataDir,
    pluginDataDir: pluginData,
    reconnectSleep: async ms => { sleeps.push(ms) },
  })
  const warm = await withDeadline(client.status(), 'the warm-up status')

  // The Story 1.7 recovery contract's setting: the server restarts on a new
  // port BEFORE the client's next call.
  await first.stop()
  const second = spawnServerChild(t, dataDir)
  const recordB = await second.waitReady()
  assert.notEqual(recordB.port, recordA.port)

  // The first (immediate) attempt's recovery still resolves it: the real
  // probe detects the answering recorded server and cuts the first wait at
  // ZERO slices — the cache drops, ensureServer re-resolves runtime.json, the
  // client re-authenticates, one retry, success.
  const recovered = await withDeadline(client.status(), 'the recovery call')
  assert.equal(recovered.realm_id, warm.realm_id, 'the durable realm survived the restart')
  assert.equal(recovered.broadcast_room_id, warm.broadcast_room_id, 'the Broadcast Room survived')
  assert.equal(client.chatId, 'Alice')
  assert.deepEqual(sleeps, [], 'zero backoff waits recorded: attempt 1 is immediate')

  // The recovered session is stable: the next call needs no recovery.
  const again = await withDeadline(client.status(), 'the follow-up call')
  assert.equal(again.realm_id, warm.realm_id)
  assert.deepEqual(sleeps, [])
  await second.stop()
})
