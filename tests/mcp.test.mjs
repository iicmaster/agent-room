import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, rm, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { MESSAGE_TEXT_MAX } from '../server/constants.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = join(ROOT, 'server', 'mcp-stdio.mjs')

function startClient({ instanceData, sharedData, name, serverPath = SERVER }) {
  const child = spawn(process.execPath, [serverPath], {
    cwd: instanceData,
    env: {
      PATH: process.env.PATH || '',
      LANG: process.env.LANG || 'C.UTF-8',
      PLUGIN_DATA: instanceData,
      AGENT_ROOM_DATA_DIR: sharedData,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let stdout = ''
  let stderr = ''
  let nextId = 1
  const pending = new Map()

  child.stdout.on('data', chunk => {
    stdout += chunk
    for (;;) {
      const newline = stdout.indexOf('\n')
      if (newline === -1) break
      const line = stdout.slice(0, newline)
      stdout = stdout.slice(newline + 1)
      if (!line) continue
      const message = JSON.parse(line)
      const waiter = pending.get(String(message.id))
      if (waiter) {
        pending.delete(String(message.id))
        waiter.resolve(message)
      }
    }
  })
  child.stderr.on('data', chunk => { stderr += chunk })

  const request = (method, params = {}, timeoutMs = 8_000) => new Promise((resolveRequest, reject) => {
    const id = nextId++
    const timer = setTimeout(() => {
      pending.delete(String(id))
      reject(new Error(`MCP request timed out: ${method}; stderr=${stderr}`))
    }, timeoutMs)
    pending.set(String(id), {
      resolve(message) {
        clearTimeout(timer)
        resolveRequest(message)
      },
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })

  return {
    child,
    request,
    async initialize() {
      const response = await request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name, version: '1.0.0' },
      })
      assert.equal(response.result.protocolVersion, '2025-06-18')
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    },
    async tool(name, argumentsValue = {}, timeoutMs) {
      const response = await request('tools/call', { name, arguments: argumentsValue }, timeoutMs)
      assert.equal(response.error, undefined, JSON.stringify(response.error))
      return response.result
    },
    async close() {
      child.stdin.end()
      if (child.exitCode === null) child.kill('SIGTERM')
      await new Promise(resolveClose => {
        if (child.exitCode !== null) return resolveClose()
        child.once('exit', resolveClose)
        setTimeout(() => {
          if (child.exitCode === null) child.kill('SIGKILL')
        }, 1_000).unref()
      })
    },
    get stderr() { return stderr },
  }
}

function structured(toolResult) {
  assert.equal(toolResult.isError, undefined, JSON.stringify(toolResult.structuredContent))
  assert.deepEqual(JSON.parse(toolResult.content[0].text), toolResult.structuredContent)
  return toolResult.structuredContent
}

test('two real MCP stdio clients with separate PLUGIN_DATA share one daemon and room', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-room-mcp-'))
  const sharedData = join(parent, 'shared')
  const firstData = join(parent, 'client-a')
  const secondData = join(parent, 'client-b')
  const aliasedRoot = join(parent, 'aliased-plugin-root')
  await Promise.all([
    import('node:fs/promises').then(({ mkdir }) => mkdir(sharedData)),
    import('node:fs/promises').then(({ mkdir }) => mkdir(firstData)),
    import('node:fs/promises').then(({ mkdir }) => mkdir(secondData)),
  ])
  await symlink(ROOT, aliasedRoot, 'dir')
  const alpha = startClient({
    instanceData: firstData,
    sharedData,
    name: 'Alpha',
    serverPath: join(aliasedRoot, 'server', 'mcp-stdio.mjs'),
  })
  const beta = startClient({ instanceData: secondData, sharedData, name: 'Beta' })
  let daemonPid = null
  t.after(async () => {
    await Promise.all([alpha.close(), beta.close()])
    if (daemonPid) {
      try { process.kill(daemonPid, 'SIGTERM') } catch { /* already stopped */ }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
    } else {
      const runtimePath = join(sharedData, 'runtime.json')
      if (existsSync(runtimePath)) {
        try { process.kill(JSON.parse(readFileSync(runtimePath, 'utf8')).pid, 'SIGTERM') } catch { /* already stopped */ }
      }
    }
    await rm(parent, { recursive: true, force: true })
  })

  await Promise.all([alpha.initialize(), beta.initialize()])
  const tools = await alpha.request('tools/list')
  assert.deepEqual(tools.result.tools.map(tool => tool.name), [
    'room_create',
    'room_join',
    'message_send',
    'message_read',
    'room_status',
  ])
  const unknownTool = await alpha.request('tools/call', { name: 'does_not_exist', arguments: {} })
  assert.equal(unknownTool.error.code, -32602)
  const unsupportedVersion = await alpha.request('initialize', {
    protocolVersion: '2026-07-28',
    capabilities: {},
    clientInfo: { name: 'Alpha', version: '1.0.0' },
  })
  assert.equal(unsupportedVersion.result.protocolVersion, '2025-06-18')

  const [alphaStatusResult, betaStatusResult] = await Promise.all([
    alpha.tool('room_status'),
    beta.tool('room_status'),
  ])
  const alphaStatus = structured(alphaStatusResult)
  const betaStatus = structured(betaStatusResult)
  daemonPid = alphaStatus.pid
  assert.equal(betaStatus.pid, alphaStatus.pid)
  assert.notEqual(alphaStatus.actor.id, betaStatus.actor.id)
  assert.match(alphaStatus.viewerUrl, /^http:\/\/127\.0\.0\.1:/)

  const room = structured(await alpha.tool('room_create', { title: 'Cross-client room' }))
  const titleBoundary = await alpha.tool('room_create', { title: 'x'.repeat(121) })
  assert.equal(titleBoundary.isError, true)
  assert.equal(titleBoundary.structuredContent.error.code, 'invalid_arguments')
  structured(await beta.tool('room_join', { room_id: room.id, display_name: 'Beta agent' }))
  const firstSend = structured(await alpha.tool('message_send', {
    room_id: room.id,
    client_message_id: 'alpha-1',
    text: 'Hello from Alpha',
  }))
  assert.equal(firstSend.duplicate, false)
  const textBoundary = await alpha.tool('message_send', {
    room_id: room.id,
    client_message_id: 'too-long',
    text: 'x'.repeat(MESSAGE_TEXT_MAX + 1),
  })
  assert.equal(textBoundary.isError, true)
  assert.equal(textBoundary.structuredContent.error.code, 'invalid_arguments')

  const betaRead = structured(await beta.tool('message_read', {
    room_id: room.id,
    after_seq: 0,
    limit: 50,
  }))
  assert.deepEqual(betaRead.messages, [firstSend.message])

  const replay = structured(await alpha.tool('message_send', {
    room_id: room.id,
    client_message_id: 'alpha-1',
    text: 'Hello from Alpha',
  }))
  assert.equal(replay.duplicate, true)
  assert.equal(replay.message.seq, firstSend.message.seq)

  const betaSend = structured(await beta.tool('message_send', {
    room_id: room.id,
    client_message_id: 'beta-1',
    text: 'Hello back',
    reply_to_seq: firstSend.message.seq,
  }))
  const alphaRead = structured(await alpha.tool('message_read', {
    room_id: room.id,
    after_seq: firstSend.message.seq,
    wait_ms: 50,
  }))
  assert.deepEqual(alphaRead.messages, [betaSend.message])
  assert.equal(alpha.stderr, '')
  assert.equal(beta.stderr, '')
})
