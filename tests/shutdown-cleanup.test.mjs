import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { loadOrCreateLocalToken } from '../server/api/local-token.mjs'
import { startServer } from '../server/api/server.mjs'
import { main as cliMain } from '../server/cli/agent-room.mjs'
import { CLIENT_RELEASE_TIMEOUT_MS, PROTOCOL_HEADER, PROTOCOL_VERSION, READ_HOLD_MAX_MS } from '../server/constants.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MCP_ENTRY = join(ROOT, 'server', 'mcp-stdio.mjs')

function makeTempPair(t, prefix) {
  const parent = mkdtempSync(join(tmpdir(), prefix))
  const sharedData = join(parent, 'shared')
  const pluginData = join(parent, 'plugin')
  mkdirSync(sharedData, { recursive: true, mode: 0o700 })
  mkdirSync(pluginData, { recursive: true, mode: 0o700 })
  t.after(async () => {
    const runtimePath = join(sharedData, 'runtime.json')
    if (existsSync(runtimePath)) {
      try {
        const pid = JSON.parse(readFileSync(runtimePath, 'utf8'))?.pid
        if (Number.isInteger(pid) && pid > 1) {
          for (const signal of ['SIGTERM', 'SIGKILL']) {
            try { process.kill(pid, 0) } catch { break }
            try { process.kill(pid, signal) } catch {}
            const deadline = Date.now() + 2000
            while (Date.now() < deadline) {
              try { process.kill(pid, 0) } catch { break }
              await new Promise(r => setTimeout(r, 25))
            }
          }
        }
      } catch {}
    }
    rmSync(parent, { recursive: true, force: true })
  })
  return { parent, sharedData, pluginData }
}

test('server.close() aborts in-flight long-poll sleep cleanly without touching a closed store', async t => {
  const { sharedData } = makeTempPair(t, 'agent-room-lp-close-')
  const localToken = loadOrCreateLocalToken(sharedData)
  const server = await startServer({ dataDir: sharedData })
  let closeCalled = false
  t.after(async () => {
    if (!closeCalled) await server.close()
  })

  const { publicKey } = generateKeyPairSync('ed25519')
  const pub = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url')
  const authRes = await fetch(`http://127.0.0.1:${server.port}/api/auth/local`, {
    method: 'POST',
    headers: {
      [PROTOCOL_HEADER]: String(PROTOCOL_VERSION),
      authorization: `Bearer ${localToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ public_key: pub }),
  }).then(r => r.json())
  const token = authRes.result.session_token
  const roomsRes = await fetch(`http://127.0.0.1:${server.port}/api/rooms`, {
    headers: { [PROTOCOL_HEADER]: String(PROTOCOL_VERSION), authorization: `Bearer ${token}` },
  }).then(r => r.json())
  const roomId = roomsRes.result.rooms[0].room_id

  const req = http.get(
    `http://127.0.0.1:${server.port}/api/rooms/${encodeURIComponent(roomId)}/messages?after_seq=0&limit=10&wait_ms=${READ_HOLD_MAX_MS}`,
    { headers: { [PROTOCOL_HEADER]: String(PROTOCOL_VERSION), authorization: `Bearer ${token}` } },
  )
  req.on('error', () => {})
  t.after(() => req.destroy())

  await new Promise(r => setTimeout(r, 150))
  const started = Date.now()
  closeCalled = true
  await server.close()
  const elapsedMs = Date.now() - started
  assert.ok(elapsedMs < 1000, `server.close() with active long-poll took ${elapsedMs}ms`)
})

test('mcp-stdio exits promptly on stdin close without lingering on the release timeout timer', async t => {
  const { sharedData, pluginData } = makeTempPair(t, 'agent-room-mcp-exit-')
  writeFileSync(join(pluginData, 'config.json'), JSON.stringify({ chat_id: 'ShutdownProbe' }))

  const child = spawn(process.execPath, [MCP_ENTRY], {
    env: {
      ...process.env,
      AGENT_ROOM_DATA_DIR: sharedData,
      PLUGIN_DATA: pluginData,
      AGENT_ROOM_NOTIFIER: '0',
      AGENT_ROOM_SESSION_PRINCIPAL: '0',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit')
    }
  })

  let stderr = ''
  child.stderr.on('data', chunk => { stderr += chunk })

  child.stdin.write(`${JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'probe', version: '1' } },
  })}\n`)
  await new Promise(r => setTimeout(r, 100))
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} })}\n`)
  await new Promise(r => setTimeout(r, 100))

  const started = Date.now()
  child.stdin.end()
  const [code, signal] = await once(child, 'exit')
  const elapsedMs = Date.now() - started

  assert.equal(code, 0, `expected clean exit 0, got code=${code} signal=${signal} stderr=${stderr}`)
  assert.ok(
    elapsedMs < CLIENT_RELEASE_TIMEOUT_MS / 2,
    `mcp-stdio lingered ${elapsedMs}ms after stdin close (budget ${CLIENT_RELEASE_TIMEOUT_MS}ms)`,
  )
})

test('setup --chat-id with invalid grammar refuses without booting a detached server', async t => {
  const { sharedData, pluginData } = makeTempPair(t, 'agent-room-setup-grammar-')
  const savedExitCode = process.exitCode
  try {
    const outcome = await cliMain(['setup', '--chat-id=bad id with spaces'], {
      input: new PassThrough(),
      output: new PassThrough(),
      errorOutput: new PassThrough(),
      sharedDataDir: sharedData,
      pluginDataDir: pluginData,
    })
    assert.equal(outcome.status, 'refused')
    assert.equal(existsSync(join(sharedData, 'runtime.json')), false, 'no detached server should boot')
  } finally {
    process.exitCode = savedExitCode
  }
})
