// The `agent-room wait` companion notifier (Epic 8, 2026-10-31) against a
// real spawned server. Covered: DM discovery mid-wait (the primary user
// journey — a room the watcher could not know about at launch), the
// unread-backlog hint (a room the agent never read starts at cursor 0), the
// cursor baseline honored BOTH ways (read history never re-hints; a new
// message past the cursor does), --room narrowing (a watched-scope room is
// never reported for an unwatched room), hint-only output (message bodies
// appear nowhere; cursor/trust state is never written), the one-wait fence
// (live lock refuses, crashed lock is reclaimed), the not_set_up refusal
// that creates nothing, and the usage grammar (exit 2).

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import http from 'node:http'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { PROTOCOL_VERSION } from '../server/constants.mjs'
import { CONNECTION_MODE_ENV } from '../server/client/api-client.mjs'
import { atomicWriteJson, readJsonFile } from '../server/runtime.mjs'
import { loadOrCreateLocalToken } from '../server/api/local-token.mjs'
import { fingerprintFromPublicKey, loadOrCreateKeypair, signWithInstallationKey } from '../server/keys.mjs'
import { applyTrustMatrix, loadAllowlist, setAllowlistEntry, setAcceptAll, REMOTE_TRANSPORT } from '../server/client/trust.mjs'
import { openRoomLog } from '../server/store/room-log.mjs'
import { TEST_CA_CERT, startTrustedTlsFront } from './remote-tls-fixture.mjs'
import { main as cliMain } from '../server/cli/agent-room.mjs'
import { runWaitFamilyCommand } from '../server/cli/wait-commands.mjs'
import { authenticate } from '../server/cli/session-commands.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = join(ROOT, 'server', 'api', 'server.mjs')
const PROTOCOL_KEY = 'agent-room-protocol'

const sleep = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })

function makeWorld(t) {
  const parent = mkdtempSync(join(tmpdir(), 'agent-room-wait-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const sharedData = join(parent, 'shared')
  const pluginData = join(parent, 'plugin-data')
  mkdirSync(sharedData, { mode: 0o700 })
  mkdirSync(pluginData, { mode: 0o700 })

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, AGENT_ROOM_DATA_DIR: sharedData },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const waitReady = async () => {
    const deadline = Date.now() + 10 * 1000
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('server child exited early')
      if (existsSync(join(sharedData, 'runtime.json'))) {
        try {
          const record = JSON.parse(readFileSync(join(sharedData, 'runtime.json'), 'utf8'))
          if (Number.isInteger(record.port) && record.port > 0) return record
        } catch { /* atomic rename: readers retry */ }
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

  return { parent, sharedData, pluginData, waitReady }
}

function httpRequest(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers, agent: false },
      response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('error', rejectPromise)
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolvePromise({ status: response.statusCode, json: () => JSON.parse(text), text })
        })
      },
    )
    req.on('error', rejectPromise)
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body))
    req.end()
  })
}

const actorHeaders = token => ({
  [PROTOCOL_KEY]: PROTOCOL_VERSION,
  authorization: `Bearer ${token}`,
  'content-type': 'application/json; charset=utf-8',
})

// A connected installation for the peer side: local token + a fresh key,
// bound to its Chat ID (the durable claim row makes the name discoverable).
async function connectInstallation(port, sharedData, chatId) {
  const localToken = loadOrCreateLocalToken(sharedData)
  const { publicKey } = generateKeyPairSync('ed25519')
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  const fingerprint = fingerprintFromPublicKey(raw)
  const auth = await httpRequest(port, 'POST', '/api/auth/local', {
    headers: actorHeaders(localToken),
    body: { public_key: raw.toString('base64url') },
  })
  assert.equal(auth.status, 200, auth.text)
  const sessionToken = auth.json().result.session_token
  const connected = await httpRequest(port, 'POST', '/api/session', {
    headers: actorHeaders(sessionToken),
    body: { chat_id: chatId },
  })
  assert.equal(connected.status, 200, connected.text)
  return { sessionToken, fingerprint }
}

// The wait installation's own identity pieces: config.json (the gate the
// wait refuses without) and ONE durable claim of its Chat ID — the claim a
// live MCP client would have created at startup, which is what lets a peer
// open a DM to this name at all. The claim-and-release mirrors setup's own
// live probe; the name is free again for the real client.
async function challengeSession(port, pluginData) {
  const keypair = loadOrCreateKeypair(pluginData)
  const challenge = await httpRequest(port, 'POST', '/api/auth/challenge', {
    headers: actorHeaders(),
    body: { public_key: keypair.publicKey.toString('base64url') },
  })
  assert.equal(challenge.status, 200, challenge.text)
  const nonce = challenge.json().result.nonce
  const answer = await httpRequest(port, 'POST', '/api/auth/answer', {
    headers: actorHeaders(),
    body: { nonce, signature: signWithInstallationKey(pluginData, Buffer.from(nonce, 'base64url')).toString('base64url') },
  })
  assert.equal(answer.status, 200, answer.text)
  return answer.json().result.session_token
}

async function challengeAndBind(port, pluginData, chatId) {
  const token = await challengeSession(port, pluginData)
  const bound = await httpRequest(port, 'POST', '/api/session', { headers: actorHeaders(token), body: { chat_id: chatId } })
  assert.equal(bound.status, 200, bound.text)
  return { token, release: () => httpRequest(port, 'DELETE', '/api/session', { headers: actorHeaders(token) }) }
}

async function prepareWaitInstallation(port, sharedData, pluginData, chatId, { enroll = false, bind = true } = {}) {
  atomicWriteJson(join(pluginData, 'config.json'), { chat_id: chatId, set_up_at: new Date().toISOString() })
  const keypair = loadOrCreateKeypair(pluginData)
  const localToken = loadOrCreateLocalToken(sharedData)
  if (enroll) {
    const store = openRoomLog({ dataDir: sharedData })
    const invite = store.mintInvite({ uses: 1, ttlSeconds: 3600 })
    store.close()
    const enrollment = await httpRequest(port, 'POST', '/api/auth/enroll', {
      headers: actorHeaders(),
      body: { invite_token: invite.token, public_key: keypair.publicKey.toString('base64url'), signature: signWithInstallationKey(pluginData, Buffer.from(invite.token, 'utf8')).toString('base64url') },
    })
    assert.equal(enrollment.status, 200, enrollment.text)
  }
  let sessionToken
  if (enroll) {
    const challenge = await httpRequest(port, 'POST', '/api/auth/challenge', { headers: actorHeaders(), body: { public_key: keypair.publicKey.toString('base64url') } })
    assert.equal(challenge.status, 200, challenge.text)
    const nonce = challenge.json().result.nonce
    const answer = await httpRequest(port, 'POST', '/api/auth/answer', { headers: actorHeaders(), body: { nonce, signature: signWithInstallationKey(pluginData, Buffer.from(nonce, 'base64url')).toString('base64url') } })
    assert.equal(answer.status, 200, answer.text)
    sessionToken = answer.json().result.session_token
  } else {
    const auth = await httpRequest(port, 'POST', '/api/auth/local', { headers: actorHeaders(localToken), body: { public_key: keypair.publicKey.toString('base64url') } })
    assert.equal(auth.status, 200, auth.text)
    sessionToken = auth.json().result.session_token
  }
  if (bind) {
    const bound = await httpRequest(port, 'POST', '/api/session', { headers: actorHeaders(sessionToken), body: { chat_id: chatId } })
    assert.equal(bound.status, 200, bound.text)
    await httpRequest(port, 'DELETE', '/api/session', { headers: actorHeaders(sessionToken) })
  }
  return keypair
}

async function peerOpensDirectRoom(port, peerToken, targetChatId) {
  const opened = await httpRequest(port, 'POST', '/api/rooms/direct', {
    headers: actorHeaders(peerToken),
    body: { chat_id: targetChatId },
  })
  assert.equal(opened.status, 200, opened.text)
  return opened.json().result
}

async function peerSends(port, peerToken, roomId, clientMessageId, text, chatId = 'Peer') {
  const sent = await httpRequest(port, 'POST', `/api/rooms/${encodeURIComponent(roomId)}/messages`, {
    headers: actorHeaders(peerToken),
    body: { chat_id: chatId, client_message_id: clientMessageId, text },
  })
  assert.equal(sent.status, 200, sent.text)
  return sent.json().result
}

// The realm id and the Broadcast room id, read through the API the same way
// the wait command reads them (the realm id names the cursor directory).
async function realmFacts(port, sharedData) {
  const localToken = loadOrCreateLocalToken(sharedData)
  const { publicKey } = generateKeyPairSync('ed25519')
  const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  const auth = await httpRequest(port, 'POST', '/api/auth/local', {
    headers: actorHeaders(localToken),
    body: { public_key: raw.toString('base64url') },
  })
  const token = auth.json().result.session_token
  const status = await httpRequest(port, 'GET', '/api/status', { headers: actorHeaders(token) })
  const rooms = await httpRequest(port, 'GET', '/api/rooms', { headers: actorHeaders(token) })
  const broadcast = rooms.json().result.rooms.find(room => room.kind === 'broadcast')
  return { realmId: status.json().result.realm_id, broadcastRoomId: broadcast.room_id }
}

const wait = (world, tokens, env = process.env) => runWaitFamilyCommand(tokens, {
  sharedDataDir: world.sharedData,
  pluginDataDir: world.pluginData,
  env,
})

function waitChild(world, tokens, extraEnv = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [join(ROOT, 'tests', 'wait-cli-child.mjs'), ...tokens], {
      env: { ...process.env, AGENT_ROOM_DATA_DIR: world.sharedData, PLUGIN_DATA: world.pluginData, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk })
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk })
    child.once('error', rejectPromise)
    child.once('close', code => resolvePromise({ code, stdout, stderr }))
  })
}

const parseHint = outcome => {
  assert.equal(outcome.status, 'ok')
  assert.equal(outcome.lines.length, 1)
  return JSON.parse(outcome.lines[0])
}

test('wait: a DM opened mid-wait is discovered and the hint carries no message bodies', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  await prepareWaitInstallation(record.port, world.sharedData, world.pluginData, 'Watcher')
  const peer = await connectInstallation(record.port, world.sharedData, 'Peer')

  const pending = wait(world, ['--timeout', '30'])
  await sleep(1500)
  const dm = await peerOpensDirectRoom(record.port, peer.sessionToken, 'Watcher')
  await peerSends(record.port, peer.sessionToken, dm.room_id, 'dm-1', 'SECRET-BODY-xyzzy the wake test body')

  const outcome = await pending
  const hint = parseHint(outcome)
  assert.equal(hint.ok, true)
  assert.equal(hint.command, 'wait')
  assert.equal(hint.status, 'new_messages')
  assert.equal(hint.room_id, dm.room_id)
  assert.equal(hint.seq, 1)
  assert.equal(typeof hint.elapsed_ms, 'number')
  // Hint-only: the message BODY appears nowhere in the machine output.
  assert.ok(!outcome.lines[0].includes('SECRET-BODY-xyzzy'))
  // The wait wrote nothing but its own lock — and the lock is released.
  assert.equal(existsSync(join(world.pluginData, 'wait.lock')), false, 'the wait lock is released on exit')
  assert.equal(existsSync(join(world.pluginData, 'realms')), false, 'the wait never writes cursors')
})

test('wait: an unread backlog hints immediately (a never-read room starts at 0)', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  await prepareWaitInstallation(record.port, world.sharedData, world.pluginData, 'Watcher')
  const peer = await connectInstallation(record.port, world.sharedData, 'Peer')
  const { broadcastRoomId } = await realmFacts(record.port, world.sharedData)
  await peerSends(record.port, peer.sessionToken, broadcastRoomId, 'old-1', 'backlog one')

  const outcome = await wait(world, ['--timeout', '30'])
  const hint = parseHint(outcome)
  assert.equal(hint.status, 'new_messages')
  assert.equal(hint.room_id, broadcastRoomId)
  assert.equal(hint.seq, 1)
  assert.ok(hint.elapsed_ms < 10_000, 'an unread backlog answers on the first cycle, not at the deadline')
  assert.ok(!outcome.lines[0].includes('backlog one'))
})

test('wait: the cursor baseline is honored — read history stays quiet, new mail past it fires', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  await prepareWaitInstallation(record.port, world.sharedData, world.pluginData, 'Watcher')
  const peer = await connectInstallation(record.port, world.sharedData, 'Peer')
  const { realmId, broadcastRoomId } = await realmFacts(record.port, world.sharedData)
  await peerSends(record.port, peer.sessionToken, broadcastRoomId, 'read-1', 'already read')
  // The agent's own MCP adapter has consumed seq 1: the durable cursor says so.
  atomicWriteJson(join(world.pluginData, 'realms', realmId, 'cursors.json'), {
    version: 1,
    cursors: { [broadcastRoomId]: { after_seq: 1, updated_at: new Date().toISOString() } },
  })

  const quiet = parseHint(await wait(world, ['--timeout', '2']))
  assert.equal(quiet.status, 'timeout', 'history below the cursor never re-hints')
  assert.ok(quiet.elapsed_ms >= 2000)
  assert.deepEqual(quiet.unwatched, [])
  assert.ok(quiet.watched.includes(broadcastRoomId))

  await peerSends(record.port, peer.sessionToken, broadcastRoomId, 'new-1', 'fresh mail')
  const fired = parseHint(await wait(world, ['--timeout', '30']))
  assert.equal(fired.status, 'new_messages')
  assert.equal(fired.seq, 2, 'the hint names the FIRST unread sequence, not the cursor')
})

test('wait: --room narrows the watch — an unread unwatched room never fires, watched reports honestly', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  await prepareWaitInstallation(record.port, world.sharedData, world.pluginData, 'Watcher')
  const peer = await connectInstallation(record.port, world.sharedData, 'Peer')
  const { broadcastRoomId } = await realmFacts(record.port, world.sharedData)
  const dm = await peerOpensDirectRoom(record.port, peer.sessionToken, 'Watcher')
  await peerSends(record.port, peer.sessionToken, dm.room_id, 'dm-1', 'unread DM')

  const narrowed = parseHint(await wait(world, ['--room', broadcastRoomId, '--timeout', '2']))
  assert.equal(narrowed.status, 'timeout', 'the unread DM is outside the requested watch')
  assert.deepEqual(narrowed.watched, [broadcastRoomId])

  const pointed = parseHint(await wait(world, ['--room', dm.room_id, '--timeout', '30']))
  assert.equal(pointed.status, 'new_messages')
  assert.equal(pointed.room_id, dm.room_id)
})

test('wait: an unknown --room refuses with room_not_found', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  await prepareWaitInstallation(record.port, world.sharedData, world.pluginData, 'Watcher')
  const outcome = await wait(world, ['--room', 'room-does-not-exist', '--timeout', '2'])
  assert.equal(outcome.status, 'refusal')
  assert.equal(outcome.code, 'room_not_found')
})

test('wait: without setup it refuses not_set_up and creates nothing', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  const outcome = await wait(world, ['--timeout', '2'])
  assert.equal(outcome.status, 'refusal')
  assert.equal(outcome.code, 'not_set_up')
  assert.deepEqual(readdirSync(world.pluginData), [], 'the refusal created no key, no config, nothing')
  assert.equal(existsSync(join(world.pluginData, 'wait.lock')), false)
})

test('wait: the one-per-installation fence — a live waiter refuses, a crashed lock is reclaimed', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  await prepareWaitInstallation(record.port, world.sharedData, world.pluginData, 'Watcher')
  const lockPath = join(world.pluginData, 'wait.lock')

  // The live waiter is a REAL spawned wait process (the background-task
  // consumption path end to end): it holds the lock while it waits, prints
  // its clean timeout hint on stdout, and exits 0.
  const waiter = spawn(process.execPath, [join(ROOT, 'server', 'cli', 'agent-room.mjs'), 'wait', '--timeout', '5'], {
    env: {
      ...process.env,
      PLUGIN_DATA: world.pluginData,
      AGENT_ROOM_DATA_DIR: world.sharedData,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let waiterStdout = ''
  waiter.stdout.setEncoding('utf8')
  waiter.stdout.on('data', chunk => { waiterStdout += chunk })
  t.after(async () => {
    if (waiter.exitCode === null && waiter.signalCode === null) {
      waiter.kill('SIGKILL')
      await once(waiter, 'exit').catch(() => {})
    }
  })
  await sleep(1000)
  assert.equal(existsSync(lockPath), true, 'the live waiter holds the lock')

  const liveRefusal = await wait(world, ['--timeout', '2'])
  assert.equal(liveRefusal.status, 'refusal')
  assert.equal(liveRefusal.code, 'wait_already_active')
  assert.equal(readJsonFile(lockPath).pid, waiter.pid, 'a refused wait leaves the live lock alone')

  const waiterExit = await once(waiter, 'exit')
  assert.equal(waiterExit[1], null, 'the waiter exited cleanly')
  const waiterHint = JSON.parse(waiterStdout.trim().split('\n').pop())
  assert.equal(waiterHint.status, 'timeout', 'the spawned waiter prints its own clean timeout hint')
  assert.equal(waiterExit[0], 0, 'a clean timeout exits 0 — a hint, not a failure')
  assert.equal(existsSync(lockPath), false, 'the lock is released on exit')

  // The round-5 gate: a stale lock FAILS CLOSED in the auto path — no
  // auto-reclaim, because no rename-based take-over can be a
  // compare-and-swap against a fresh winner — and the refusal names the
  // explicit take-over.
  const dead = spawn('true')
  await once(dead, 'exit')
  atomicWriteJson(lockPath, { pid: dead.pid, started_at: new Date().toISOString(), timeout_ms: 1000 })
  const staleRefusal = await wait(world, ['--timeout', '1'])
  assert.equal(staleRefusal.status, 'refusal')
  assert.equal(staleRefusal.code, 'wait_already_active')
  assert.match(staleRefusal.message, /stale lock whose pid/)
  assert.match(staleRefusal.message, /--reclaim/, 'the refusal names the explicit take-over')

  // The explicit take-over removes the stale lock and runs; a second
  // concurrent reclaim of a LIVE lock would take it by force (documented) —
  // here the fence is free, so the reclaim proceeds normally.
  const reclaimed = parseHint(await wait(world, ['--reclaim', '--timeout', '1']))
  assert.equal(reclaimed.status, 'timeout', 'the explicit take-over opens the fence')
  assert.equal(existsSync(lockPath), false, 'and the lock is released on exit')
})

// Send as the wait installation itself (its own keypair, a temporary session
// released right after): the row `message_send` allocates without ever
// advancing the MCP read cursor — the issue #4 shape.
async function sendAsInstallation(port, sharedData, pluginData, chatId, roomId, clientMessageId, text) {
  const keypair = loadOrCreateKeypair(pluginData)
  const localToken = loadOrCreateLocalToken(sharedData)
  const auth = await httpRequest(port, 'POST', '/api/auth/local', {
    headers: actorHeaders(localToken),
    body: { public_key: keypair.publicKey.toString('base64url') },
  })
  assert.equal(auth.status, 200, auth.text)
  const sessionToken = auth.json().result.session_token
  const bound = await httpRequest(port, 'POST', '/api/session', {
    headers: actorHeaders(sessionToken),
    body: { chat_id: chatId },
  })
  assert.equal(bound.status, 200, bound.text)
  const sent = await httpRequest(port, 'POST', `/api/rooms/${encodeURIComponent(roomId)}/messages`, {
    headers: actorHeaders(sessionToken),
    body: { chat_id: chatId, client_message_id: clientMessageId, text },
  })
  assert.equal(sent.status, 200, sent.text)
  await httpRequest(port, 'DELETE', '/api/session', { headers: actorHeaders(sessionToken) })
  return sent.json().result
}

// Wait classifies raw server rows with the receiving installation's trust matrix.

test('wait trust: configured Remote Mode holds untrusted rows and allows the exact fingerprint', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  const caPath = join(world.parent, 'wait-test-ca.pem')
  const previousCa = process.env.NODE_EXTRA_CA_CERTS
  writeFileSync(caPath, TEST_CA_CERT, { mode: 0o600 })
  process.env.NODE_EXTRA_CA_CERTS = caPath
  t.after(() => { if (previousCa === undefined) delete process.env.NODE_EXTRA_CA_CERTS; else process.env.NODE_EXTRA_CA_CERTS = previousCa })

  const receiver = await prepareWaitInstallation(record.port, world.sharedData, world.pluginData, 'Watcher', { enroll: true, bind: false })
  const receiverSeed = await challengeSession(record.port, world.pluginData, receiver)
  const seedBind = await httpRequest(record.port, 'POST', '/api/session', { headers: actorHeaders(receiverSeed), body: { chat_id: 'Watcher' } })
  assert.equal(seedBind.status, 200, seedBind.text)
  const receiverPresence = await httpRequest(record.port, 'GET', '/api/presence', { headers: actorHeaders(receiverSeed) })
  assert.equal(receiverPresence.status, 200, receiverPresence.text)
  const receiverStatus = await httpRequest(record.port, 'GET', '/api/status', { headers: actorHeaders(receiverSeed) })
  assert.equal(receiverStatus.status, 200, receiverStatus.text)
  const receiverRooms = await httpRequest(record.port, 'GET', '/api/rooms', { headers: actorHeaders(receiverSeed) })
  assert.equal(receiverRooms.status, 200, receiverRooms.text)
  await httpRequest(record.port, 'DELETE', '/api/session', { headers: actorHeaders(receiverSeed) })

  const peerPlugin = join(world.parent, 'remote-peer')
  mkdirSync(peerPlugin, { mode: 0o700 })
  atomicWriteJson(join(peerPlugin, 'config.json'), { chat_id: 'PeerRemote' })
  const peer = await prepareWaitInstallation(record.port, world.sharedData, peerPlugin, 'PeerRemote', { enroll: true, bind: false })
  const peerSession = await challengeAndBind(record.port, peerPlugin, 'PeerRemote')
  const peerFingerprint = peer.fingerprint
  const peerToken = peerSession.token
  const realmId = receiverStatus.json().result.realm_id
  const broadcastRoomId = receiverRooms.json().result.rooms.find(room => room.kind === 'broadcast').room_id
  const front = await startTrustedTlsFront(t)
  front.setBackend(record.port)
  atomicWriteJson(join(world.pluginData, 'remote-config.json'), { server_url: front.origin, set_at: new Date().toISOString() })

  const held = await peerSends(record.port, peerToken, broadcastRoomId, 'remote-held', 'HELD BODY MUST NOT LEAK', 'PeerRemote')
  const firstRun = await waitChild(world, ['--timeout', '5'], { NODE_EXTRA_CA_CERTS: caPath })
  assert.equal(firstRun.code, 0, firstRun.stderr)
  const firstHint = JSON.parse(firstRun.stdout.trim())
  assert.equal(firstHint.status, 'new_messages', 'first held contact is a metadata wake')
  assert.equal(firstHint.seq, held.seq)
  assert.ok(!firstRun.stdout.includes('HELD BODY'))

  await peerSends(record.port, peerToken, broadcastRoomId, 'remote-held-repeat', 'REPEAT HELD BODY', 'PeerRemote')
  const repeatRun = await waitChild(world, ['--timeout', '1'], { NODE_EXTRA_CA_CERTS: caPath })
  assert.equal(repeatRun.code, 0, repeatRun.stderr)
  assert.equal(JSON.parse(repeatRun.stdout.trim()).status, 'timeout', 'same untrusted sender repeat is cooled down')
  assert.ok(!repeatRun.stdout.includes('REPEAT HELD BODY'))

  setAllowlistEntry(world.pluginData, realmId, peerFingerprint, true)
  const delivered = await peerSends(record.port, peerToken, broadcastRoomId, 'remote-allowed', 'trusted body stays outside hint', 'PeerRemote')
  const allowedRun = await waitChild(world, ['--timeout', '5'], { NODE_EXTRA_CA_CERTS: caPath })
  assert.equal(allowedRun.code, 0, allowedRun.stderr)
  const hint = JSON.parse(allowedRun.stdout.trim())
  assert.equal(hint.status, 'new_messages')
  assert.equal(hint.seq, held.seq, 'allowlisting makes the oldest unread held row readable; wake did not consume it')
  assert.equal(delivered.seq, held.seq + 2, 'the cooled repeat remains in the durable sequence')
  assert.ok(!allowedRun.stdout.includes('trusted body'))
})

test('wait trust: declared Remote Mode on loopback uses challenge auth and fails closed on unallowlisted rows', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  const receiver = await prepareWaitInstallation(record.port, world.sharedData, world.pluginData, 'Watcher', { enroll: true, bind: false })
  const receiverSeed = await challengeSession(record.port, world.pluginData, receiver)
  const seedBind = await httpRequest(record.port, 'POST', '/api/session', { headers: actorHeaders(receiverSeed), body: { chat_id: 'Watcher' } })
  assert.equal(seedBind.status, 200, seedBind.text)
  const receiverStatus = await httpRequest(record.port, 'GET', '/api/status', { headers: actorHeaders(receiverSeed) })
  const receiverRooms = await httpRequest(record.port, 'GET', '/api/rooms', { headers: actorHeaders(receiverSeed) })
  assert.equal(receiverStatus.status, 200, receiverStatus.text)
  assert.equal(receiverRooms.status, 200, receiverRooms.text)
  const realmId = receiverStatus.json().result.realm_id
  const broadcastRoomId = receiverRooms.json().result.rooms.find(r => r.kind === 'broadcast').room_id
  await httpRequest(record.port, 'DELETE', '/api/session', { headers: actorHeaders(receiverSeed) })

  const peer = await connectInstallation(record.port, world.sharedData, 'Peer')
  const env = { ...process.env, [CONNECTION_MODE_ENV]: REMOTE_TRANSPORT }
  const held = await peerSends(record.port, peer.sessionToken, broadcastRoomId, 'declared-held', 'DECLARED HELD BODY', 'Peer')
  const firstHint = parseHint(await wait(world, ['--timeout', '5'], env))
  assert.equal(firstHint.status, 'new_messages', 'first held contact wakes in declared remote mode')
  assert.equal(firstHint.seq, held.seq)
  assert.ok(!JSON.stringify(firstHint).includes('DECLARED HELD BODY'))

  await peerSends(record.port, peer.sessionToken, broadcastRoomId, 'declared-repeat', 'DECLARED REPEAT BODY', 'Peer')
  const repeatHint = parseHint(await wait(world, ['--timeout', '1'], env))
  assert.equal(repeatHint.status, 'timeout', 'repeat from the same untrusted fingerprint is cooled down')
  assert.ok(!JSON.stringify(repeatHint).includes('DECLARED REPEAT BODY'))

  setAllowlistEntry(world.pluginData, realmId, peer.fingerprint, true)
  await peerSends(record.port, peer.sessionToken, broadcastRoomId, 'declared-allowed', 'allowed', 'Peer')
  const allowedHint = parseHint(await wait(world, ['--timeout', '5'], env))
  assert.equal(allowedHint.status, 'new_messages')
  assert.equal(allowedHint.seq, held.seq, 'after allow, the oldest unread row is eligible')
})

test('wait trust: declared Remote Mode on loopback challenges and holds an unallowlisted row', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  const receiver = await prepareWaitInstallation(record.port, world.sharedData, world.pluginData, 'Watcher', { enroll: true, bind: false })
  const receiverToken = await challengeSession(record.port, world.pluginData, receiver)
  const bound = await httpRequest(record.port, 'POST', '/api/session', { headers: actorHeaders(receiverToken), body: { chat_id: 'Watcher' } })
  assert.equal(bound.status, 200, bound.text)
  const rooms = await httpRequest(record.port, 'GET', '/api/rooms', { headers: actorHeaders(receiverToken) })
  const status = await httpRequest(record.port, 'GET', '/api/status', { headers: actorHeaders(receiverToken) })
  assert.equal(rooms.status, 200, rooms.text)
  assert.equal(status.status, 200, status.text)
  const broadcastRoomId = rooms.json().result.rooms.find(r => r.kind === 'broadcast').room_id
  const realm = status.json().result.realm_id
  await httpRequest(record.port, 'DELETE', '/api/session', { headers: actorHeaders(receiverToken) })

  const peer = await connectInstallation(record.port, world.sharedData, 'Peer')
  const peerFingerprint = peer.fingerprint
  const env = { ...process.env, [CONNECTION_MODE_ENV]: REMOTE_TRANSPORT }
  const testTarget = { kind: 'local', port: record.port }
  const declaredAuth = await authenticate(testTarget, { pluginDataDir: world.pluginData, sharedDataDir: world.sharedData, env })
  assert.equal(declaredAuth.transport, REMOTE_TRANSPORT)
  const held = await peerSends(record.port, peer.sessionToken, broadcastRoomId, 'declared-held', 'DECLARED HELD BODY', 'Peer')
  const firstHint = parseHint(await wait(world, ['--timeout', '5'], env))
  assert.equal(firstHint.status, 'new_messages', 'declared-remote first held contact wakes')
  assert.equal(firstHint.seq, held.seq)
  assert.ok(!JSON.stringify(firstHint).includes('DECLARED HELD BODY'))
  await peerSends(record.port, peer.sessionToken, broadcastRoomId, 'declared-repeat', 'DECLARED REPEAT BODY', 'Peer')
  const repeatHint = parseHint(await wait(world, ['--timeout', '1'], env))
  assert.equal(repeatHint.status, 'timeout', 'declared-remote repeat is cooled down')
  assert.ok(!JSON.stringify(repeatHint).includes('DECLARED REPEAT BODY'))

  setAllowlistEntry(world.pluginData, realm, peer.fingerprint, true)
  const delivered = await peerSends(record.port, peer.sessionToken, broadcastRoomId, 'declared-allowed', 'allowed', 'Peer')
  const allowedHint = parseHint(await wait(world, ['--timeout', '5'], env))
  assert.equal(allowedHint.status, 'new_messages')
  assert.equal(allowedHint.seq, held.seq, 'allowlisting releases the oldest unread row first')
})

test('wait: the installation\u2019s own sends never wake it (issue #4)', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  await prepareWaitInstallation(record.port, world.sharedData, world.pluginData, 'Watcher')
  const peer = await connectInstallation(record.port, world.sharedData, 'Peer')
  const { broadcastRoomId } = await realmFacts(record.port, world.sharedData)

  const pending = wait(world, ['--timeout', '3'])
  await sleep(500)
  const own = await sendAsInstallation(record.port, world.sharedData, world.pluginData, 'Watcher', broadcastRoomId, 'own-1', 'the watcher\u2019s own broadcast message')
  await sleep(300)
  const peerSent = await peerSends(record.port, peer.sessionToken, broadcastRoomId, 'peer-1', 'a real peer message')
  assert.notEqual(peerSent.seq, own.seq)

  const outcome = await pending
  const hint = parseHint(outcome)
  assert.equal(hint.status, 'new_messages', 'the peer message still fires the hint')
  assert.equal(hint.seq, peerSent.seq, 'the hint names the PEER seq, never the own send')
  assert.ok(!outcome.lines[0].includes('own broadcast message'))
})

test('wait: own sends alone are silence — a quiet wait times out cleanly', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  await prepareWaitInstallation(record.port, world.sharedData, world.pluginData, 'Watcher')
  const { broadcastRoomId } = await realmFacts(record.port, world.sharedData)

  const pending = wait(world, ['--timeout', '3'])
  await sleep(500)
  await sendAsInstallation(record.port, world.sharedData, world.pluginData, 'Watcher', broadcastRoomId, 'own-2', 'only my own message')
  const hint = parseHint(await pending)
  assert.equal(hint.status, 'timeout', 'an all-own page is silence: the wait does not wake on itself')
  assert.ok(hint.elapsed_ms >= 3000)
})

test('wait: usage grammar — bad bounds, unknown options, positionals, duplicate rooms', async t => {
  const world = makeWorld(t)
  await world.waitReady()
  const usage = await wait(world, ['--timeout', '601'])
  assert.equal(usage.status, 'usage')
  assert.equal((await wait(world, ['--timeout', '0'])).status, 'usage')
  assert.equal((await wait(world, ['--timeout', 'abc'])).status, 'usage')
  assert.equal((await wait(world, ['--room'])).status, 'usage')
  assert.equal((await wait(world, ['--wat'])).status, 'usage')
  assert.equal((await wait(world, ['now'])).status, 'usage')
  const repeated = await wait(world, ['--timeout', '2', '--room', 'a', '--room', 'a'])
  assert.equal(repeated.status, 'usage')

  const savedExitCode = process.exitCode
  try {
    const outcome = await cliMain(['wait', '--timeout', 'abc'], {
      input: process.stdin,
      output: process.stdout,
      errorOutput: process.stderr,
      sharedDataDir: world.sharedData,
      pluginDataDir: world.pluginData,
    })
    assert.equal(outcome.status, 'usage')
    assert.equal(process.exitCode, 2, 'usage exits 2')
  } finally {
    process.exitCode = savedExitCode
  }
})

test('wait: the 7th room is overflow and is really head-checked — its unread row fires (advisory-found defect)', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  await prepareWaitInstallation(record.port, world.sharedData, world.pluginData, 'Watcher')
  const peer = await connectInstallation(record.port, world.sharedData, 'Peer')

  // Seven rooms, watched via --room in a KNOWN order: held = the first six,
  // overflow = the seventh. Only the overflow room gets unread content, so a
  // hint can only come from the head-check the overflow path promises.
  // Distinct rooms need distinct pairs: one peer per DM (open-or-create
  // converges a repeated pair to ONE room).
  const roomIds = []
  const roomOpeners = []
  for (let i = 0; i < 7; i += 1) {
    const dmPeer = await connectInstallation(record.port, world.sharedData, 'Peer' + i)
    const dm = await peerOpensDirectRoom(record.port, dmPeer.sessionToken, 'Watcher')
    roomIds.push(dm.room_id)
    roomOpeners.push(dmPeer)
  }
  const tokens = roomIds.map(id => ['--room', id]).flat()
  // Unread backlog in the SEVENTH room only, present BEFORE the wait arms:
  // the overflow head-check must find it on the first cycle. (A row landing
  // mid-cycle is found one cycle later — held holds run ~20 s — which is the
  // documented overflow latency, not this defect.)
  const seventh = roomIds[6]
  const sent = await peerSends(record.port, roomOpeners[6].sessionToken, seventh, 'overflow-1', 'the seventh room speaks', 'Peer6')

  const pending = wait(world, [...tokens, '--timeout', '20'])
  const outcome = await pending
  const hint = parseHint(outcome)
  assert.equal(hint.status, 'new_messages', 'the overflow room\u2019s unread row must fire the hint')
  assert.equal(hint.room_id, seventh)
  assert.equal(hint.seq, sent.seq)
  assert.ok(!outcome.lines[0].includes('the seventh room speaks'))
})

test('wait trust: the 7th overflow room classifies a raw remote row as held and emits first-contact metadata', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  const receiver = await prepareWaitInstallation(record.port, world.sharedData, world.pluginData, 'Watcher', { enroll: true, bind: false })
  const receiverToken = await challengeSession(record.port, world.pluginData, receiver)
  const bound = await httpRequest(record.port, 'POST', '/api/session', { headers: actorHeaders(receiverToken), body: { chat_id: 'Watcher' } })
  assert.equal(bound.status, 200, bound.text)
  const rooms = await httpRequest(record.port, 'GET', '/api/rooms', { headers: actorHeaders(receiverToken) })
  assert.equal(rooms.status, 200, rooms.text)
  const roomId = rooms.json().result.rooms.find(room => room.kind === 'broadcast').room_id
  await httpRequest(record.port, 'DELETE', '/api/session', { headers: actorHeaders(receiverToken) })

  const peers = []
  const dmRooms = []
  for (let i = 0; i < 7; i += 1) {
    const peer = await connectInstallation(record.port, world.sharedData, `OverflowPeer${i}`)
    const dm = await peerOpensDirectRoom(record.port, peer.sessionToken, 'Watcher')
    peers.push(peer)
    dmRooms.push(dm.room_id)
  }
  const seventh = dmRooms[6]
  const sent = await peerSends(record.port, peers[6].sessionToken, seventh, 'overflow-held', 'OVERFLOW HELD BODY', 'OverflowPeer6')
  const env = { ...process.env, [CONNECTION_MODE_ENV]: REMOTE_TRANSPORT }
  const roomTokens = dmRooms.map(id => ['--room', id]).flat()
  const outcome = await wait(world, [...roomTokens, '--timeout', '10'], env)
  assert.equal(outcome.status, 'ok', JSON.stringify(outcome))
  const hint = parseHint(outcome)
  assert.equal(hint.status, 'new_messages', 'the overflow probe must classify and allow first-contact metadata wake')
  assert.equal(hint.room_id, seventh)
  assert.equal(hint.seq, sent.seq)
  assert.ok(!JSON.stringify(hint).includes('OVERFLOW HELD BODY'))
})

test('wait race: a losing held room does not spend its sender wake grant', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  const receiver = await prepareWaitInstallation(record.port, world.sharedData, world.pluginData, 'Watcher', { enroll: true, bind: false })
  const receiverToken = await challengeSession(record.port, world.pluginData, receiver)
  const bound = await httpRequest(record.port, 'POST', '/api/session', { headers: actorHeaders(receiverToken), body: { chat_id: 'Watcher' } })
  assert.equal(bound.status, 200, bound.text)
  const rooms = await httpRequest(record.port, 'GET', '/api/rooms', { headers: actorHeaders(receiverToken) })
  assert.equal(rooms.status, 200, rooms.text)
  const roomId = rooms.json().result.rooms.find(room => room.kind === 'broadcast').room_id
  await httpRequest(record.port, 'DELETE', '/api/session', { headers: actorHeaders(receiverToken) })

  const senderA = await connectInstallation(record.port, world.sharedData, 'RacePeerA')
  const senderB = await connectInstallation(record.port, world.sharedData, 'RacePeerB')
  // Both messages are already unread when the two room probes start. The
  // first candidate emits one hint; the other room is a losing probe and must
  // not reserve cooldown/budget after the wait returns.
  const sentA = await peerSends(record.port, senderA.sessionToken, roomId, 'race-a', 'first held candidate', 'RacePeerA')
  const sentB = await peerSends(record.port, senderB.sessionToken, roomId, 'race-b', 'second held candidate', 'RacePeerB')
  const env = { ...process.env, [CONNECTION_MODE_ENV]: REMOTE_TRANSPORT }
  const first = parseHint(await wait(world, ['--room', roomId, '--timeout', '5'], env))
  assert.equal(first.status, 'new_messages')
  assert.ok([sentA.seq, sentB.seq].includes(first.seq))
  const loserSeq = first.seq === sentA.seq ? sentB.seq : sentA.seq
  const next = parseHint(await wait(world, ['--room', roomId, '--timeout', '5'], env))
  assert.equal(next.status, 'new_messages', 'the losing sender still has its first-contact wake grant')
  assert.equal(next.seq, loserSeq)
})
