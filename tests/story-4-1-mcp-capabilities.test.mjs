// Story 4.1 AC1/AC4 (in-process): initialize negotiation, declared capabilities,
// honest tier disclosure, resource subscribe cap, and the AQ-2 absolute gate
// over the real adapter surface. No server needed for these rows.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { createMcpServer } from '../server/mcp-stdio.mjs'
import { CHANNEL_TIER } from '../server/client/channel-verification.mjs'

const ROOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = join(ROOT_DIR, 'server', 'api', 'server.mjs')
const sleep = ms => new Promise(r => setTimeout(r, ms))

function harness(t, { env = {} } = {}) {
  const pluginData = mkdtempSync(join(tmpdir(), 'ar41-caps-'))
  const dataDir = mkdtempSync(join(tmpdir(), 'ar41-shared-'))
  t.after(() => { rmSync(pluginData, { recursive: true, force: true }); rmSync(dataDir, { recursive: true, force: true }) })
  const input = new PassThrough()
  const output = new PassThrough()
  output.setEncoding('utf8')
  const server = createMcpServer({
    input,
    output,
    env: {
      ...process.env,
      PLUGIN_DATA: pluginData,
      AGENT_ROOM_DATA_DIR: dataDir,
      AGENT_ROOM_NOTIFIER: 'off',
      AGENT_ROOM_SESSION_PRINCIPAL: 'off',
      ...env,
    },
  })
  t.after(() => server.close())
  let buffer = ''
  const pending = new Map()
  let nextId = 1
  output.on('data', chunk => {
    buffer += chunk
    for (;;) {
      const nl = buffer.indexOf('\n')
      if (nl === -1) break
      const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1)
      if (!line) continue
      let msg; try { msg = JSON.parse(line) } catch { continue }
      const settle = pending.get(msg.id)
      if (settle) { pending.delete(msg.id); settle(msg) }
    }
  })
  const call = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => reject(new Error(`timeout: ${method}`)), 3000)
    pending.set(id, msg => { clearTimeout(timer); resolve(msg) })
    input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`)
  })
  return { call, server }
}

test('initialize announces resources.subscribe + experimental channel and downgrades cleanly', async t => {
  const { call } = harness(t)
  const result = await call('initialize', {
    protocolVersion: '2026-07-28', capabilities: {}, clientInfo: { name: 'x', version: '1' },
  })
  assert.equal(result.result.protocolVersion, '2025-06-18')
  assert.equal(result.result.capabilities.resources.subscribe, true)
  assert.ok('claude/channel' in result.result.capabilities.experimental)
  assert.match(result.result.instructions, /--channels Unverified/)
})

test('an unsupported protocol version answers a JSON-RPC error', async t => {
  const { call } = harness(t)
  const result = await call('initialize', { protocolVersion: '1999-01-01', capabilities: {} })
  assert.equal(result.error.code, -32602)
  assert.match(result.error.message, /unsupported MCP protocol version/)
})

test('three host capabilities gate the active tier 1/0/0 and no active push is fired when unverified', async t => {
  const fixtures = [
    { params: { protocolVersion: '2025-06-18', capabilities: { experimental: { 'claude/channel': {} } } }, active: true },
    { params: { protocolVersion: '2025-06-18', capabilities: {} }, active: false },
    { params: { protocolVersion: '2025-06-18', capabilities: { experimental: { 'claude/channel': { channelsEnabled: false } } } }, active: false },
  ]
  const tiers = []
  for (const fixture of fixtures) {
    const { call, server } = harness(t)
    const init = await call('initialize', fixture.params)
    const tier = init.result.instructions.includes('Tier 1A Active') ? CHANNEL_TIER.ACTIVE : CHANNEL_TIER.UNVERIFIED
    assert.equal(tier === CHANNEL_TIER.ACTIVE, fixture.active)
    tiers.push(tier === CHANNEL_TIER.ACTIVE ? 1 : 0)
    // For UNVERIFIED hosts, driving a judged row through the SAME seam the
    // notifier uses MUST short-circuit BEFORE any network/realm work: no active
    // push. (The active case needs a live server for realmIdOf; its full
    // 1/0/0 black-box evidence is in the comprehensive test.)
    if (!fixture.active) {
      const outcome = await server.handleWake({ roomId: 'r1', row: { seq: 1, chat_id: 'peer', actor_fingerprint: 'sha256:peer', text: 'hello', held: false } })
      assert.deepEqual(outcome, { skipped: 'unverified' })
    }
  }
  assert.deepEqual(tiers, [1, 0, 0])
})

test('resources/subscribe caps at 20, rejects invalid URIs; generic host still calls tools', async t => {
  const { call } = harness(t)
  await call('initialize', { protocolVersion: '2025-06-18', capabilities: {} })
  for (let i = 0; i < 20; i += 1) {
    const ok = await call('resources/subscribe', { uri: `agent-room://rooms/r${i}` })
    assert.equal(ok.error, undefined)
  }
  const over = await call('resources/subscribe', { uri: 'agent-room://rooms/overflow' })
  assert.equal(over.error.code, -32602)
  const bad = await call('resources/subscribe', { uri: 'other://rooms/r1' })
  assert.equal(bad.error.code, -32602)
  const listed = await call('resources/list')
  assert.equal(listed.result.resources.length, 20)
  const unsub = await call('resources/unsubscribe', { uri: 'agent-room://rooms/r0' })
  assert.equal(unsub.error, undefined)
  // A host with no experimental still calls tools/list without error.
  const tools = await call('tools/list')
  assert.ok(tools.result.tools.length >= 11)
})

async function startLiveRoomWorld(t) {
  const root = mkdtempSync(join(tmpdir(), 'ar41-live-'))
  const dataDir = join(root, 'shared')
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, AGENT_ROOM_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit').catch(() => {})
    }
    rmSync(root, { recursive: true, force: true })
  })
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) throw new Error('server exited early')
    const rt = join(dataDir, 'runtime.json')
    if (existsSync(rt)) {
      try {
        const parsed = JSON.parse(readFileSync(rt, 'utf8'))
        if (Number.isInteger(parsed.port) && parsed.port > 0) break
      } catch { /* retry atomic write */ }
    }
    await sleep(25)
  }

  const clients = []
  t.after(async () => {
    for (const c of clients) await c.close().catch(() => {})
  })

  const openClient = async (pluginData, scope) => {
    mkdirSync(pluginData, { recursive: true, mode: 0o700 })
    const input = new PassThrough()
    const output = new PassThrough()
    output.setEncoding('utf8')
    const server = createMcpServer({
      input,
      output,
      env: {
        ...process.env,
        PLUGIN_DATA: pluginData,
        AGENT_ROOM_DATA_DIR: dataDir,
        AGENT_ROOM_NOTIFIER: 'off',
        AGENT_ROOM_SESSION_PRINCIPAL: 'on',
        AGENT_ROOM_SESSION_SCOPE: scope,
      },
    })
    clients.push(server)
    let buf = ''
    const pending = new Map()
    let nextId = 1
    output.on('data', chunk => {
      buf += chunk
      for (;;) {
        const nl = buf.indexOf('\n')
        if (nl === -1) break
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1)
        if (!line) continue
        let msg; try { msg = JSON.parse(line) } catch { continue }
        const settle = pending.get(msg.id)
        if (settle) { pending.delete(msg.id); settle(msg) }
      }
    })
    const call = (method, params) => new Promise((resolvePromise, rejectPromise) => {
      const id = nextId++
      const timer = setTimeout(() => rejectPromise(new Error(`timeout: ${method}`)), 5000)
      pending.set(id, msg => { clearTimeout(timer); resolvePromise(msg) })
      input.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }) })}\n`)
    })
    const tool = async (name, args = {}) => {
      const res = await call('tools/call', { name, arguments: args })
      assert.equal(res.error, undefined, JSON.stringify(res))
      return JSON.parse(res.result.content[0].text)
    }
    await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: scope, version: '1' } })
    const status = await tool('room_status')
    assert.ok(status.session_address, `${scope} acquired session_address`)
    return { call, tool, status }
  }

  return { root, dataDir, openClient }
}

test('MCP room_list includes ssession pair rooms for the owning session while isolating shared-PLUGIN_DATA siblings', async t => {
  const { root, openClient } = await startLiveRoomWorld(t)
  const pdA = join(root, 'pd-a')
  const pdBC = join(root, 'pd-bc')
  const a = await openClient(pdA, 'scope-a')
  const b = await openClient(pdBC, 'scope-b')
  const c = await openClient(pdBC, 'scope-c')

  const sent = await a.tool('message_send', {
    to: b.status.session_address,
    client_message_id: 'reg-room-list-1',
    text: 'secret-dm-for-b',
  })
  assert.ok(sent.room_id)

  const bRooms = await b.tool('room_list')
  const bPair = bRooms.rooms.find(r => r.room_id === sent.room_id)
  assert.ok(bPair, 'receiver session discovers incoming ssession pair room via room_list')
  assert.equal(bPair.kind, 'direct')
  assert.ok(typeof bPair.peer_session_id === 'string' && bPair.peer_session_id.length > 0)

  const page = await b.tool('message_read', { room_id: sent.room_id, after_seq: 0 })
  assert.match(page.messages[0].text, /secret-dm-for-b/)

  const cRooms = await c.tool('room_list')
  assert.equal(cRooms.rooms.find(r => r.room_id === sent.room_id), undefined, 'sibling sharing PLUGIN_DATA does not see B pair room')
})

test('MCP resources/read enforces pair-room membership using the session-scoped rooms envelope', async t => {
  const { root, openClient } = await startLiveRoomWorld(t)
  const pdA = join(root, 'pd-a2')
  const pdBC = join(root, 'pd-bc2')
  const a = await openClient(pdA, 'scope-a2')
  const b = await openClient(pdBC, 'scope-b2')
  const c = await openClient(pdBC, 'scope-c2')

  const sent = await a.tool('message_send', {
    to: b.status.session_address,
    client_message_id: 'reg-res-read-1',
    text: 'resource-read-check',
  })
  const uri = `agent-room://rooms/${sent.room_id}`

  const bRead = await b.call('resources/read', { uri })
  assert.equal(bRead.error, undefined, JSON.stringify(bRead))
  assert.ok(Array.isArray(bRead.result?.contents))

  const cRead = await c.call('resources/read', { uri })
  assert.equal(cRead.error?.code, -32602)
  assert.match(cRead.error?.message ?? '', /invalid or foreign resource uri/)
})
