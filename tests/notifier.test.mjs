// The companion notifier: an idle host learns a message arrived.
//
// MCP is pull — the host only calls tools during a model turn — so the MCP
// process itself (the one process allowed to hold the session: one Chat ID =
// one session) long-polls every room the installation is in and appends one
// JSON line per foreign message to PLUGIN_DATA/inbox.jsonl, the file a host
// tails to wake up. message_read stays the authoritative read path; the inbox
// is only the wake signal.
//
// The integration rows drive real mcp-stdio children against ONE real spawned
// server at the server's DEFAULT request budget (no operator floors), zero
// mocks: alice (notifier on, with AGENT_ROOM_NOTIFY_CMD), bob (the sender),
// carol (AGENT_ROOM_NOTIFIER=off). The pure rows pin the line shape and the
// >20-room selection rule against the real trust matrix.
//
// Adopted from PR #3 (ngs-th) with the Layer-2 integration (see
// server/client/notifier.mjs for the provenance note).

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  CLIENT_RELEASE_TIMEOUT_MS,
  NOTIFIER_ACTIVE_WINDOW_MS,
  NOTIFIER_PREVIEW_MAX,
  NOTIFIER_ROOM_LIMIT,
  NOTIFIER_ROOM_REFRESH_MS,
} from '../server/constants.mjs'
import { untrustedMessageEnvelope } from '../server/client/api-client.mjs'
import { REMOTE_TRANSPORT, applyTrustMatrix, emptyAllowlist } from '../server/client/trust.mjs'
import { INBOX_FILENAME, inboxEntry, selectWatchedRooms } from '../server/client/notifier.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MCP_ENTRY = join(ROOT, 'server', 'mcp-stdio.mjs')
const SERVER_ENTRY = join(ROOT, 'server', 'api', 'server.mjs')

// Harness bounds (not product limits): the brief's ≤25 s delivery bound; a
// DM a peer opens is discovered on the next room-list re-read, so that row
// waits one refresh period plus the delivery margin; a DM opened by alice
// herself (room_direct_open kicks the re-read) must land well inside one
// refresh period; the server readiness wait; and the stdin-close exit bound —
// the release budget plus a margin. A long-poll left held after teardown
// keeps the process alive for the whole hold, far past this bound.
const DELIVERY_TIMEOUT_MS = 25_000
const PEER_DM_TIMEOUT_MS = NOTIFIER_ROOM_REFRESH_MS + 10_000
const KICKED_DM_TIMEOUT_MS = 5_000
const SERVER_READY_TIMEOUT_MS = 10_000
const EXIT_AFTER_STDIN_CLOSE_MS = CLIENT_RELEASE_TIMEOUT_MS + 2_000
const LINE_KEYS = ['chat_id', 'fingerprint', 'held', 'preview', 'room_id', 'seq', 'ts']

const sleep = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })

async function waitFor(check, label, timeoutMs = DELIVERY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = check()
    if (value) return value
    if (Date.now() > deadline) throw new Error(`timed out after ${timeoutMs} ms waiting for ${label}`)
    await sleep(50)
  }
}

function inboxLines(pluginData) {
  const path = join(pluginData, INBOX_FILENAME)
  if (!existsSync(path)) return []
  return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line))
}

function structured(toolResult) {
  assert.equal(toolResult.isError, undefined, JSON.stringify(toolResult.structuredContent))
  return toolResult.structuredContent
}

function makeWorld(t) {
  const parent = mkdtempSync(join(tmpdir(), 'agent-room-notifier-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const sharedData = join(parent, 'shared')
  mkdirSync(sharedData, { mode: 0o700 })
  const pluginDataFor = chatId => {
    const pluginData = join(parent, chatId)
    mkdirSync(pluginData, { mode: 0o700 })
    writeFileSync(join(pluginData, 'config.json'), `${JSON.stringify({ chat_id: chatId })}\n`, { mode: 0o600 })
    return pluginData
  }
  const server = spawn(process.execPath, [SERVER_ENTRY], {
    env: { PATH: process.env.PATH || '', LANG: process.env.LANG || 'C.UTF-8', AGENT_ROOM_DATA_DIR: sharedData },
    stdio: ['ignore', 'ignore', 'pipe'],
  })
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGKILL')
      await once(server, 'exit').catch(() => {})
    }
  })
  const waitReady = () => waitFor(() => {
    if (server.exitCode !== null) throw new Error('server child exited early')
    try {
      return JSON.parse(readFileSync(join(sharedData, 'runtime.json'), 'utf8')).port > 0
    } catch { return false }
  }, 'the server runtime record', SERVER_READY_TIMEOUT_MS)
  return { parent, sharedData, pluginDataFor, waitReady }
}

function startMcpChild(t, { pluginData, sharedData, env = {} }) {
  const child = spawn(process.execPath, [MCP_ENTRY], {
    cwd: pluginData,
    env: {
      PATH: process.env.PATH || '',
      LANG: process.env.LANG || 'C.UTF-8',
      PLUGIN_DATA: pluginData,
      AGENT_ROOM_DATA_DIR: sharedData,
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  const exited = once(child, 'exit')
  let stdout = ''
  let stderr = ''
  let nextId = 1
  const pending = new Map()
  child.stdout.on('data', chunk => {
    stdout += chunk
    for (let newline; (newline = stdout.indexOf('\n')) !== -1;) {
      const line = stdout.slice(0, newline)
      stdout = stdout.slice(newline + 1)
      const message = JSON.parse(line)
      pending.get(String(message.id))?.(message)
      pending.delete(String(message.id))
    }
  })
  child.stderr.on('data', chunk => { stderr += chunk })
  const request = (method, params = {}) => new Promise((resolveRequest, rejectRequest) => {
    const id = nextId++
    const timer = setTimeout(() => rejectRequest(new Error(`MCP ${method} timed out; stderr=${stderr}`)), 30_000)
    pending.set(String(id), message => { clearTimeout(timer); resolveRequest(message) })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
  const handle = {
    child,
    exited,
    async initialize() {
      const response = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'NotifierTest', version: '1.0.0' } })
      assert.equal(response.result.protocolVersion, '2025-06-18')
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    },
    async tool(name, args = {}) {
      const response = await request('tools/call', { name, arguments: args })
      assert.equal(response.error, undefined, JSON.stringify(response.error))
      return response.result
    },
    async close() {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.stdin.end()
      child.kill('SIGTERM')
      const timer = setTimeout(() => child.kill('SIGKILL'), 2_000)
      await exited
      clearTimeout(timer)
    },
    get stderr() { return stderr },
  }
  t.after(() => handle.close())
  return handle
}

test('the notifier writes one inbox line per foreign message, skips its own, follows DMs opened later, runs AGENT_ROOM_NOTIFY_CMD, stays off when disabled, and leaves no long-poll after stdin closes', async t => {
  const world = makeWorld(t)
  await world.waitReady()

  const alicePlugin = world.pluginDataFor('alice')
  const bobPlugin = world.pluginDataFor('bob')
  const carolPlugin = world.pluginDataFor('carol')
  // The notify hook: a no-shell executable that appends its stdin to a file.
  const hookOut = join(world.parent, 'hook.out')
  const hook = join(world.parent, 'hook.sh')
  writeFileSync(hook, `#!/bin/sh\ncat >> '${hookOut}'\n`, { mode: 0o700 })
  chmodSync(hook, 0o700)

  const alice = startMcpChild(t, { pluginData: alicePlugin, sharedData: world.sharedData, env: { AGENT_ROOM_NOTIFY_CMD: hook } })
  const bob = startMcpChild(t, { pluginData: bobPlugin, sharedData: world.sharedData })
  const carol = startMcpChild(t, { pluginData: carolPlugin, sharedData: world.sharedData, env: { AGENT_ROOM_NOTIFIER: 'off' } })
  for (const peer of [alice, bob, carol]) await peer.initialize()

  // Nothing watches before the first bind: the client stays lazy.
  assert.equal(existsSync(join(alicePlugin, INBOX_FILENAME)), false, 'no inbox before the first tool call')

  const aliceStatus = structured(await alice.tool('room_status'))
  const bobStatus = structured(await bob.tool('room_status'))
  structured(await carol.tool('room_status'))
  const broadcast = aliceStatus.broadcast_room_id

  // The inbox appears (empty, 0600) once the notifier watches the rooms that
  // existed at start — the readiness a host arms `tail -f` on.
  const inboxPath = join(alicePlugin, INBOX_FILENAME)
  await waitFor(() => existsSync(inboxPath), "alice's inbox.jsonl")
  assert.equal(lstatSync(inboxPath).isFile(), true)
  assert.equal(lstatSync(inboxPath).mode & 0o777, 0o600, 'inbox.jsonl is 0600')
  assert.deepEqual(inboxLines(alicePlugin), [], 'history before the start is never replayed')

  // alice's own message is skipped; bob's (long, multi-line) arrives as one line.
  structured(await alice.tool('message_send', { room_id: broadcast, client_message_id: 'a-1', text: 'from alice herself' }))
  const bobText = `hello alice\nsecond line ${'x'.repeat(300)}`
  const bobSent = structured(await bob.tool('message_send', { room_id: broadcast, client_message_id: 'b-1', text: bobText }))
  await waitFor(() => inboxLines(alicePlugin).length > 0, "bob's broadcast line")
  let lines = inboxLines(alicePlugin)
  assert.equal(lines.length, 1, `exactly one line (alice's own message is not written): ${JSON.stringify(lines)}`)
  const [line] = lines
  assert.deepEqual(Object.keys(line).sort(), LINE_KEYS)
  assert.equal(line.room_id, broadcast)
  assert.equal(line.seq, bobSent.seq, 'the line names the committed seq')
  assert.equal(line.chat_id, 'bob')
  assert.equal(line.fingerprint, bobStatus.fingerprint)
  assert.equal(line.held, false, 'a local-transport sender delivers')
  assert.equal(Array.from(line.preview).length, NOTIFIER_PREVIEW_MAX, 'preview is cut to the declared maximum')
  assert.ok(line.preview.startsWith('hello alice second line xxx'), `envelope stripped, whitespace folded: ${line.preview}`)
  assert.equal(line.preview.includes('untrusted_message'), false)
  assert.ok(Number.isFinite(Date.parse(line.ts)), 'ts is a timestamp')

  // The notify hook ran without a shell and received the same line on stdin.
  await waitFor(() => existsSync(hookOut) && readFileSync(hookOut, 'utf8').includes('\n'), 'the notify hook output')
  assert.deepEqual(readFileSync(hookOut, 'utf8').split('\n').filter(Boolean).map(text => JSON.parse(text)), [line])

  // A Direct Room bob opens and writes into AFTER alice's notifier started is
  // followed from its first message — the room is new, so all of it is news.
  const dm = structured(await bob.tool('room_direct_open', { chat_id: 'alice' })).room_id
  const dmFirst = structured(await bob.tool('message_send', { room_id: dm, client_message_id: 'b-dm-1', text: 'first dm' }))
  await waitFor(() => inboxLines(alicePlugin).some(entry => entry.room_id === dm), 'the peer-opened DM line', PEER_DM_TIMEOUT_MS)
  const dmSecond = structured(await bob.tool('message_send', { room_id: dm, client_message_id: 'b-dm-2', text: 'second dm' }))
  await waitFor(() => inboxLines(alicePlugin).filter(entry => entry.room_id === dm).length === 2, 'the second DM line')

  // The DM line above came from a periodic re-read, so the next one is a full
  // period away: a DM alice opens herself is picked up at once because
  // room_direct_open kicks the re-read.
  const carolDm = structured(await alice.tool('room_direct_open', { chat_id: 'carol' })).room_id
  const carolSent = structured(await carol.tool('message_send', { room_id: carolDm, client_message_id: 'c-dm-1', text: 'from carol' }))
  await waitFor(() => inboxLines(alicePlugin).some(entry => entry.room_id === carolDm), 'the kicked DM line', KICKED_DM_TIMEOUT_MS)
  lines = inboxLines(alicePlugin)
  assert.deepEqual(
    lines.map(entry => [entry.room_id, entry.seq, entry.chat_id, entry.preview]),
    [
      [broadcast, bobSent.seq, 'bob', line.preview],
      [dm, dmFirst.seq, 'bob', 'first dm'],
      [dm, dmSecond.seq, 'bob', 'second dm'],
      [carolDm, carolSent.seq, 'carol', 'from carol'],
    ],
    'one line per foreign message, in arrival order, no duplicates',
  )
  const hookLines = () => readFileSync(hookOut, 'utf8').split('\n').filter(Boolean).map(text => JSON.parse(text))
  await waitFor(() => hookLines().length === lines.length, 'the hook to see every line')
  assert.deepEqual(hookLines(), lines, 'the hook received exactly the inbox lines, one per run')

  // AGENT_ROOM_NOTIFIER=off: carol received the same broadcast but has no inbox.
  assert.equal(existsSync(join(carolPlugin, INBOX_FILENAME)), false, 'a disabled notifier writes nothing')

  // Teardown: closing stdin alone (no signal) ends the process within the
  // release budget — every held long-poll was aborted, none outlives the host.
  const startedAt = Date.now()
  alice.child.stdin.end()
  const exit = await Promise.race([alice.exited, sleep(EXIT_AFTER_STDIN_CLOSE_MS).then(() => null)])
  assert.notEqual(exit, null, `alice did not exit within ${EXIT_AFTER_STDIN_CLOSE_MS} ms of stdin closing`)
  assert.ok(Date.now() - startedAt < EXIT_AFTER_STDIN_CLOSE_MS)

  for (const peer of [alice, bob, carol]) assert.equal(peer.stderr, '', 'the notifier is silent on stderr')
})

test('inboxEntry: the envelope is stripped, a held row keeps metadata with an empty preview, and no body leaks', () => {
  const own = 'sha256:' + 'a'.repeat(64)
  const peer = 'sha256:' + 'b'.repeat(64)
  const raw = { seq: 7, chat_id: 'bob', actor_fingerprint: peer, created_at: '2026-10-31T00:00:00.000Z' }
  const text = untrustedMessageEnvelope({ text: 'secret plan  with\n\nspaces', senderChatId: 'bob', senderFingerprint: peer })

  const delivered = inboxEntry('room-1', { ...raw, text })
  assert.deepEqual(delivered, {
    ts: '2026-10-31T00:00:00.000Z', room_id: 'room-1', seq: 7, chat_id: 'bob', fingerprint: peer, held: false, preview: 'secret plan with spaces',
  })

  const [heldRow] = applyTrustMatrix(
    { messages: [{ ...raw, text }] },
    { ownFingerprint: own, transport: REMOTE_TRANSPORT, allowlist: emptyAllowlist() },
  ).messages
  assert.equal(heldRow.held, true, 'a non-allowlisted remote sender is held by the real matrix')
  const held = inboxEntry('room-1', heldRow)
  assert.equal(held.held, true)
  assert.equal(held.preview, '', 'a held message carries no preview')
  assert.equal(JSON.stringify(held).includes('secret'), false, 'no held body byte reaches the line')
})

test('selectWatchedRooms: up to the limit every room is watched; past it, the Broadcast Room plus the most recently active DMs inside the window', () => {
  const now = Date.parse('2026-10-31T12:00:00.000Z')
  const rooms = count => Array.from({ length: count }, (_, index) => ({
    roomId: `dm-${index}`, kind: 'direct', lastActivityMs: now - index * 60_000,
  }))
  const few = [{ roomId: 'b', kind: 'broadcast', lastActivityMs: 0 }, ...rooms(NOTIFIER_ROOM_LIMIT - 1)]
  assert.equal(selectWatchedRooms(few, now).length, NOTIFIER_ROOM_LIMIT, 'at the limit nothing is dropped, even quiet rooms')

  const stale = { roomId: 'old', kind: 'direct', lastActivityMs: now - NOTIFIER_ACTIVE_WINDOW_MS - 1 }
  const many = [stale, { roomId: 'b', kind: 'broadcast', lastActivityMs: 0 }, ...rooms(NOTIFIER_ROOM_LIMIT + 5)]
  const watched = selectWatchedRooms(many, now)
  assert.equal(watched.length, NOTIFIER_ROOM_LIMIT, 'past the limit the watch set is capped')
  assert.equal(watched[0], 'b', 'the Broadcast Room is always watched')
  assert.equal(watched.includes('old'), false, 'a DM quiet past the window is dropped')
  assert.deepEqual(watched.slice(1), rooms(NOTIFIER_ROOM_LIMIT - 1).map(room => room.roomId), 'the most recently active DMs win')
})
