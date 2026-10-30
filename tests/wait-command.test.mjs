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
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import http from 'node:http'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { PROTOCOL_VERSION } from '../server/constants.mjs'
import { atomicWriteJson, readJsonFile } from '../server/runtime.mjs'
import { loadOrCreateLocalToken } from '../server/api/local-token.mjs'
import { loadOrCreateKeypair } from '../server/keys.mjs'
import { main as cliMain } from '../server/cli/agent-room.mjs'
import { runWaitFamilyCommand } from '../server/cli/wait-commands.mjs'

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
  return { sessionToken }
}

// The wait installation's own identity pieces: config.json (the gate the
// wait refuses without) and ONE durable claim of its Chat ID — the claim a
// live MCP client would have created at startup, which is what lets a peer
// open a DM to this name at all. The claim-and-release mirrors setup's own
// live probe; the name is free again for the real client.
async function prepareWaitInstallation(port, sharedData, pluginData, chatId) {
  atomicWriteJson(join(pluginData, 'config.json'), { chat_id: chatId, set_up_at: new Date().toISOString() })
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
  await httpRequest(port, 'DELETE', '/api/session', { headers: actorHeaders(sessionToken) })
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

async function peerSends(port, peerToken, roomId, clientMessageId, text) {
  const sent = await httpRequest(port, 'POST', `/api/rooms/${encodeURIComponent(roomId)}/messages`, {
    headers: actorHeaders(peerToken),
    body: { chat_id: 'Peer', client_message_id: clientMessageId, text },
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

const wait = (world, tokens) => runWaitFamilyCommand(tokens, {
  sharedDataDir: world.sharedData,
  pluginDataDir: world.pluginData,
})

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

  const dead = spawn('true')
  await once(dead, 'exit')
  atomicWriteJson(lockPath, { pid: dead.pid, started_at: new Date().toISOString(), timeout_ms: 1000 })
  const reclaimed = parseHint(await wait(world, ['--timeout', '1']))
  assert.equal(reclaimed.status, 'timeout', 'a dead waiter\u2019s lock is reclaimed and the wait proceeds')
  assert.equal(existsSync(lockPath), false)
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
