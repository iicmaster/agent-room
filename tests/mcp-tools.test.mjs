// Story 1.7 acceptance: the five MCP tools (room_presence, room_direct_open,
// message_send, message_read, room_status) over real mcp-stdio child
// processes against a real spawned loopback server — zero mocks on the wire.
// The rows cover the tools list (exactly five, "list agents" phrasing, no
// native-named aliases, closed schemas), the end-to-end conversation (status,
// direct open, committed send, peer round-trip, long-poll read, presence with
// the 'mcp' client type), the ambiguity round-trip through the tool surface,
// client-owned cursor persistence per (installation, realm, room) surviving
// restart, outcome_unknown resolution through a response-dropping proxy (the
// retry with the identical client_message_id returns the original — never a
// duplicate row), stdin purity, argument boundaries, and the first-run row.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import net from 'node:net'
import http from 'node:http'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  FRAME_MAX_BYTES,
  MESSAGE_TEXT_MAX,
  READ_HOLD_MAX_MS,
} from '../server/constants.mjs'
import { APP_VERSION, atomicWriteJson } from '../server/runtime.mjs'
import { loadOrCreateLocalToken } from '../server/api/local-token.mjs'
import { fingerprintFromPublicKey } from '../server/keys.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MCP_ENTRY = join(ROOT, 'server', 'mcp-stdio.mjs')
const SERVER_ENTRY = join(ROOT, 'server', 'api', 'server.mjs')
const RUNTIME_RECORD_FILENAME = 'runtime.json'
const PROTOCOL_KEY = 'agent-room-protocol'

const sleep = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })

// --- Harness: real server child, real MCP child, HTTP peer --------------------

function installation() {
  const { publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const raw = spki.subarray(spki.length - 32)
  return {
    publicKey: raw.toString('base64url'),
    fingerprint: fingerprintFromPublicKey(raw),
  }
}

function makeWorld(t, { chatId = 'Agent' } = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'agent-room-mcp-tools-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const sharedData = join(parent, 'shared')
  const pluginData = join(parent, 'client-a')
  mkdirSync(sharedData, { recursive: true, mode: 0o700 })
  mkdirSync(pluginData, { recursive: true, mode: 0o700 })
  if (chatId !== null) {
    atomicWriteJson(join(pluginData, 'config.json'), { chat_id: chatId })
  }

  const runtimePath = join(sharedData, RUNTIME_RECORD_FILENAME)
  let serverChild = null

  function startServerChild() {
    serverChild = spawn(process.execPath, [SERVER_ENTRY], {
      env: { ...process.env, AGENT_ROOM_DATA_DIR: sharedData },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    t.after(async () => {
      if (serverChild.exitCode === null && serverChild.signalCode === null) {
        serverChild.kill('SIGKILL')
        await once(serverChild, 'exit').catch(() => {})
      }
    })
    return serverChild
  }
  startServerChild()

  const waitReady = async () => {
    const deadline = Date.now() + 10 * 1000
    for (;;) {
      if (serverChild.exitCode !== null || serverChild.signalCode !== null) throw new Error('server child exited early')
      if (existsSync(runtimePath)) {
        try {
          const record = JSON.parse(readFileSync(runtimePath, 'utf8'))
          if (Number.isInteger(record.port) && record.port > 0) return record
        } catch { /* atomic rename: readers retry */ }
      }
      if (Date.now() > deadline) throw new Error('server child never became ready')
      await sleep(25)
    }
  }

  const stopServer = async () => {
    if (serverChild.exitCode !== null || serverChild.signalCode !== null) return
    serverChild.kill('SIGTERM')
    await once(serverChild, 'exit')
  }

  return { parent, sharedData, pluginData, waitReady, stopServer, startServerChild, runtimePath }
}

function startMcpChild(t, { pluginData, sharedData } = {}) {
  const child = spawn(process.execPath, [MCP_ENTRY], {
    cwd: pluginData,
    env: {
      PATH: process.env.PATH || '',
      LANG: process.env.LANG || 'C.UTF-8',
      PLUGIN_DATA: pluginData,
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
  const settled = []

  child.stdout.on('data', chunk => {
    stdout += chunk
    for (;;) {
      const newline = stdout.indexOf('\n')
      if (newline === -1) break
      const line = stdout.slice(0, newline)
      stdout = stdout.slice(newline + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch { continue }
      const waiter = pending.get(String(message.id))
      if (waiter) {
        pending.delete(String(message.id))
        waiter.resolve(message)
      } else {
        settled.push(message)
      }
    }
  })
  child.stderr.on('data', chunk => { stderr += chunk })

  const request = (method, params = {}, timeoutMs = 15_000) => new Promise((resolveRequest, reject) => {
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

  // Wait for a message the id-based dispatcher does not own (parse errors,
  // oversized-frame answers — responses with id null).
  const waitFor = (predicate, timeoutMs = 5_000) => new Promise((resolvePromise, rejectPromise) => {
    const found = settled.find(predicate)
    if (found !== undefined) {
      resolvePromise(found)
      return
    }
    const timer = setTimeout(() => {
      child.stdout.removeListener('data', onChunk)
      rejectPromise(new Error('no matching MCP message arrived'))
    }, timeoutMs)
    const onChunk = () => {
      const match = settled.find(predicate)
      if (match !== undefined) {
        clearTimeout(timer)
        child.stdout.removeListener('data', onChunk)
        resolvePromise(match)
      }
    }
    child.stdout.on('data', onChunk)
  })

  const handle = {
    child,
    request,
    waitFor,
    async initialize() {
      const response = await request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'McpToolsTest', version: '1.0.0' },
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
      // Idempotent: a signal exit keeps exitCode null while signalCode is
      // set, so the guard must cover both — a second close() must never wait
      // on an `exit` event that already fired.
      if (child.exitCode !== null || child.signalCode !== null) return
      child.stdin.end()
      child.kill('SIGTERM')
      await new Promise(resolveClose => {
        child.once('exit', resolveClose)
        setTimeout(() => {
          if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        }, 1_000).unref()
      })
    },
    get stderr() { return stderr },
  }
  // Registered here so a mid-test failure can never orphan the child with
  // open stdio pipes (which would hang the runner at exit). Idempotent.
  t.after(() => handle.close())
  return handle
}

function structured(toolResult) {
  assert.equal(toolResult.isError, undefined, JSON.stringify(toolResult.structuredContent))
  assert.deepEqual(JSON.parse(toolResult.content[0].text), toolResult.structuredContent)
  return toolResult.structuredContent
}

function structuredError(toolResult) {
  assert.equal(toolResult.isError, true, JSON.stringify(toolResult.structuredContent))
  return toolResult.structuredContent
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
    if (body !== undefined) req.write(body)
    req.end()
  })
}

async function connectPeer(port, sharedData, chatId, install = installation()) {
  const localToken = loadOrCreateLocalToken(sharedData)
  const auth = await httpRequest(port, 'POST', '/api/auth/local', {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${localToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ public_key: install.publicKey }),
  })
  assert.equal(auth.status, 200, auth.text)
  const sessionToken = auth.json().result.session_token
  const connected = await httpRequest(port, 'POST', '/api/session', {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${sessionToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ chat_id: chatId }),
  })
  assert.equal(connected.status, 200, connected.text)
  return { sessionToken, fingerprint: install.fingerprint }
}

// A durable claim on a name WITHOUT holding it live: connect, then release.
// The claim row persists (the ambiguity data); the live name frees for the
// next claimant — how two Actors come to both hold claims on "bob".
async function claimAndReleasePeer(port, sharedData, chatId) {
  const session = await connectPeer(port, sharedData, chatId)
  const released = await httpRequest(port, 'DELETE', '/api/session', {
    headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${session.sessionToken}` },
  })
  assert.equal(released.status, 200, released.text)
  return session
}

function peerGet(port, token, path) {
  return httpRequest(port, 'GET', path, {
    headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${token}` },
  })
}

function peerSend(port, token, roomId, clientMessageId, text, chatId) {
  return httpRequest(port, 'POST', `/api/rooms/${roomId}/messages`, {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${token}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ chat_id: chatId, client_message_id: clientMessageId, text }),
  })
}

// A transparent TCP proxy that can silently destroy the CLIENT side of the
// first matching exchange — either before forwarding (request drop) or after
// receiving the upstream response (response drop). The response drop is the
// interesting outcome_unknown case: the send DID commit, the client never
// learned it, and only the idempotent retry can resolve the truth.
function startDropProxy(t, targetPort, { drop = 'response', matches } = {}) {
  const seen = { firstMatchStatus: null, dropsUsed: 0 }
  const server = net.createServer(clientSocket => {
    let buffered = Buffer.alloc(0)
    let upstream = null
    let decided = false
    const forward = () => {
      upstream = net.connect(targetPort, '127.0.0.1')
      upstream.write(buffered)
      clientSocket.removeAllListeners('data')
      clientSocket.pipe(upstream)
      upstream.pipe(clientSocket)
      upstream.on('error', () => clientSocket.destroy())
    }
    clientSocket.on('data', chunk => {
      if (decided) return
      buffered = Buffer.concat([buffered, chunk])
      const headerEnd = buffered.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const headerText = buffered.slice(0, headerEnd).toString('utf8')
      const [requestLine, ...headerLines] = headerText.split('\r\n')
      const headerMap = new Map(headerLines.map(line => {
        const colon = line.indexOf(':')
        return [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1).trim()]
      }))
      const contentLength = Number(headerMap.get('content-length') ?? '0')
      if (buffered.length < headerEnd + 4 + contentLength) return
      const [method, path] = requestLine.split(' ')
      const interesting = (matches ? matches(method, path) : false) && seen.dropsUsed < 1
      decided = true
      if (interesting && drop === 'request') {
        seen.dropsUsed += 1
        clientSocket.destroy()
        return
      }
      if (interesting && drop === 'response') {
        seen.dropsUsed += 1
        // Forward, read the upstream response head, then destroy the client
        // side without ever delivering a byte of the answer.
        upstream = net.connect(targetPort, '127.0.0.1')
        upstream.write(buffered)
        clientSocket.removeAllListeners('data')
        let responseBuffer = Buffer.alloc(0)
        upstream.on('data', responseChunk => {
          responseBuffer = Buffer.concat([responseBuffer, responseChunk])
          const responseEnd = responseBuffer.indexOf('\r\n\r\n')
          if (responseEnd === -1) return
          seen.firstMatchStatus = Number(responseBuffer.toString('utf8', 0, responseEnd).split(' ')[1])
          upstream.removeAllListeners('data')
          upstream.destroy()
          clientSocket.destroy()
        })
        upstream.on('error', () => clientSocket.destroy())
        clientSocket.on('error', () => {})
        return
      }
      forward()
    })
    clientSocket.on('error', () => {})
  })
  return new Promise(resolveProxy => {
    server.listen(0, '127.0.0.1', () => {
      t.after(() => new Promise(resolveClose => server.close(() => resolveClose())))
      resolveProxy({ port: server.address().port, seen })
    })
  })
}

// --- Matrix rows ---------------------------------------------------------------

test('tools list: exactly the five tools, "list agents" phrasing, no native-named aliases, closed schemas', async t => {
  const world = makeWorld(t)
  await world.waitReady()
  const mcp = startMcpChild(t, world)
  t.after(() => mcp.close())
  await mcp.initialize()

  const listed = await mcp.request('tools/list')
  const names = listed.result.tools.map(tool => tool.name)
  assert.deepEqual(names, [
    'room_presence',
    'room_direct_open',
    'message_send',
    'message_read',
    'room_status',
  ])
  // No native-named aliases and no join verbs: the retired surface is gone.
  for (const name of names) {
    assert.equal(['room_create', 'room_join'].includes(name), false, name)
  }
  for (const tool of listed.result.tools) {
    assert.match(tool.description, /Agent Room/, tool.name)
    // The schema-level identity posture: every schema closes its argument set.
    assert.equal(tool.inputSchema.additionalProperties, false, tool.name)
  }
  assert.match(listed.result.tools.find(tool => tool.name === 'room_presence').description, /list agents/)
  assert.match(listed.result.tools.find(tool => tool.name === 'room_direct_open').description, /list agents/)

  // Unknown tools are refused at the JSON-RPC layer.
  const unknownTool = await mcp.request('tools/call', { name: 'room_create', arguments: {} })
  assert.equal(unknownTool.error.code, -32602)
  const notATool = await mcp.request('tools/call', { name: 'does_not_exist', arguments: {} })
  assert.equal(notATool.error.code, -32602)

  assert.equal(mcp.stderr, '')
  await mcp.close()
})

test('end-to-end: status, presence (mcp client type), direct open, committed send, peer round-trip, long-poll read', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  const mcp = startMcpChild(t, world)
  t.after(() => mcp.close())
  await mcp.initialize()

  const peer = await connectPeer(record.port, world.sharedData, 'Peer')

  // room_status: the realm the child keys its cursors by, the Broadcast Room,
  // and this installation's identity — chat_id from its config, fingerprint
  // from its keypair.
  const status = structured(await mcp.tool('room_status'))
  const serverStatus = (await peerGet(record.port, peer.sessionToken, '/api/status')).json().result
  assert.equal(status.realm_id, serverStatus.realm_id)
  assert.equal(status.broadcast_room_id, serverStatus.broadcast_room_id)
  assert.equal(status.version, APP_VERSION)
  assert.equal(status.chat_id, 'Agent')
  assert.match(status.fingerprint, /^sha256:[0-9a-f]{64}$/)

  // Presence shows both agents; the child's session declared client_type mcp.
  const presence = (await peerGet(record.port, peer.sessionToken, '/api/presence')).json().result
  const childRow = presence.online.find(row => row.chat_id === 'Agent')
  assert.ok(childRow, 'the child session is online')
  assert.equal(childRow.client_type, 'mcp')
  assert.equal(childRow.fingerprint, status.fingerprint)
  assert.ok(presence.online.some(row => row.chat_id === 'Peer'))

  // Direct open via the tool.
  const opened = structured(await mcp.tool('room_direct_open', { chat_id: 'Peer' }))
  assert.deepEqual(Object.keys(opened).sort(), ['kind', 'room_id'])
  assert.equal(opened.kind, 'direct')
  const roomId = opened.room_id

  // Send via the tool: committed, contiguous from 1.
  const sent = structured(await mcp.tool('message_send', {
    room_id: roomId,
    client_message_id: 'm-1',
    text: 'hello peer',
  }))
  assert.equal(sent.status, 'committed')
  assert.equal(sent.seq, 1)
  assert.equal(sent.room_id, roomId)

  // The peer reads the child's message, attributed to the child's identity.
  const page = (await peerGet(record.port, peer.sessionToken, `/api/rooms/${roomId}/messages?after_seq=0`)).json().result
  assert.equal(page.messages.length, 1)
  assert.equal(page.messages[0].text, 'hello peer')
  assert.equal(page.messages[0].chat_id, 'Agent')
  assert.equal(page.messages[0].actor_fingerprint, status.fingerprint)

  // The peer answers; the child long-polls and receives it.
  const peerSent = await peerSend(record.port, peer.sessionToken, roomId, 'p-1', 'hello agent', 'Peer')
  assert.equal(peerSent.status, 200, peerSent.text)
  const read = structured(await mcp.tool('message_read', { room_id: roomId, after_seq: 1, wait_ms: 1000 }))
  assert.equal(read.messages.length, 1)
  assert.equal(read.messages[0].seq, 2)
  assert.equal(read.messages[0].text, 'hello agent')
  assert.equal(read.next_after_seq, 2)
  assert.equal(read.head_seq, 2)

  // Argument boundaries mirror the schemas: an unknown (identity-shaped)
  // field is refused before any call; the text bound is the constants'.
  const smuggled = structuredError(await mcp.tool('message_send', {
    room_id: roomId,
    client_message_id: 'm-x',
    text: 'hi',
    actor_id: 'someone-else',
  }))
  assert.equal(smuggled.error.code, 'invalid_arguments')
  assert.match(smuggled.error.message, /unknown field/)
  const oversized = structuredError(await mcp.tool('message_send', {
    room_id: roomId,
    client_message_id: 'm-big',
    text: 'x'.repeat(MESSAGE_TEXT_MAX + 1),
  }))
  assert.equal(oversized.error.code, 'invalid_arguments')
  assert.match(oversized.error.message, /text must contain 1 to/)

  assert.equal(mcp.stderr, '')
  await mcp.close()
})

test('ambiguity round-trips through the tool: candidates ride the error, target_fingerprint resolves', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  const mcp = startMcpChild(t, world)
  t.after(() => mcp.close())
  await mcp.initialize()

  const bobOne = await claimAndReleasePeer(record.port, world.sharedData, 'bob')
  await claimAndReleasePeer(record.port, world.sharedData, 'BOB')

  // Never a guess: the coded error carries the candidates (fingerprint +
  // last_seen).
  const ambiguous = structuredError(await mcp.tool('room_direct_open', { chat_id: 'bob' }))
  assert.equal(ambiguous.error.code, 'ambiguous_chat_id')
  assert.ok(Array.isArray(ambiguous.error.candidates))
  assert.equal(ambiguous.error.candidates.length, 2)
  for (const candidate of ambiguous.error.candidates) {
    assert.deepEqual(Object.keys(candidate).sort(), ['fingerprint', 'last_seen'])
  }

  // The retry with one candidate's fingerprint completes the flow.
  const resolved = structured(await mcp.tool('room_direct_open', {
    chat_id: 'bob',
    target_fingerprint: bobOne.fingerprint,
  }))
  assert.equal(resolved.kind, 'direct')
  assert.ok(resolved.room_id.length > 0)

  // An unknown name names the miss.
  const ghost = structuredError(await mcp.tool('room_direct_open', { chat_id: 'ghost' }))
  assert.equal(ghost.error.code, 'chat_id_not_found')

  await mcp.close()
})

test('client cursors: persisted per (installation, realm, room) at 0600, resumed, and surviving restart', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  const mcp = startMcpChild(t, world)
  await mcp.initialize()

  // One stable peer installation: after the restart it must still be the
  // SAME Actor (same fingerprint) or the pair room would deny it.
  const peerInstall = installation()
  const peer = await connectPeer(record.port, world.sharedData, 'Peer', peerInstall)
  const opened = structured(await mcp.tool('room_direct_open', { chat_id: 'Peer' }))
  const roomId = opened.room_id
  const realmId = structured(await mcp.tool('room_status')).realm_id

  // First read (no after_seq): the full page, and the cursor lands on disk.
  await peerSend(record.port, peer.sessionToken, roomId, 'p-1', 'one', 'Peer')
  await peerSend(record.port, peer.sessionToken, roomId, 'p-2', 'two', 'Peer')
  const first = structured(await mcp.tool('message_read', { room_id: roomId }))
  assert.deepEqual(first.messages.map(message => message.seq), [1, 2])
  assert.equal(first.next_after_seq, 2)

  const cursorPath = join(world.pluginData, 'realms', realmId, 'cursors.json')
  assert.ok(existsSync(cursorPath), 'the cursor file exists under PLUGIN_DATA/realms/<realm_id>/')
  const cursorFile = statSync(cursorPath)
  assert.equal(cursorFile.mode & 0o777, 0o600, 'the cursor file is 0600')
  const realmDir = statSync(join(world.pluginData, 'realms', realmId))
  assert.equal(realmDir.mode & 0o777, 0o700, 'the realm state directory is 0700')
  const cursorJson = JSON.parse(readFileSync(cursorPath, 'utf8'))
  assert.equal(cursorJson.version, 1)
  assert.equal(cursorJson.cursors[roomId].after_seq, 2)

  // A resumed read (still no after_seq) returns only what is new.
  await peerSend(record.port, peer.sessionToken, roomId, 'p-3', 'three', 'Peer')
  const resumed = structured(await mcp.tool('message_read', { room_id: roomId }))
  assert.deepEqual(resumed.messages.map(message => message.seq), [3])
  assert.equal(resumed.next_after_seq, 3)

  // The cursor is client-owned per installation: a restart resumes exactly
  // where the previous process stopped. The server restarts too — a crashed
  // client's live Chat ID stays lease-held until then (the documented 1.5
  // lease; Epic 2 owns same-name continuity across client-only restarts) —
  // and the cursor file must outlive BOTH processes.
  await mcp.close()
  await world.stopServer()
  world.startServerChild()
  const restartedRecord = await world.waitReady()
  const restartedPeer = await connectPeer(restartedRecord.port, world.sharedData, 'Peer', peerInstall)
  const second = startMcpChild(t, world)
  await second.initialize()
  const fourth = await peerSend(restartedRecord.port, restartedPeer.sessionToken, roomId, 'p-4', 'four', 'Peer')
  assert.equal(fourth.status, 200, fourth.text)
  const afterRestart = structured(await second.tool('message_read', { room_id: roomId, wait_ms: 1000 }))
  assert.deepEqual(afterRestart.messages.map(message => message.seq), [4])
  assert.equal(afterRestart.next_after_seq, 4)

  // An explicit after_seq still works alongside the cursor and advances it.
  const explicit = structured(await second.tool('message_read', { room_id: roomId, after_seq: 0 }))
  assert.deepEqual(explicit.messages.map(message => message.seq), [1, 2, 3, 4])
  const cursorAfter = JSON.parse(readFileSync(cursorPath, 'utf8'))
  assert.equal(cursorAfter.cursors[roomId].after_seq, 4)

  await second.close()
  void record
})

test('outcome_unknown: a send whose response is dropped retries with the identical client_message_id and never duplicates', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()

  // The child must attach THROUGH the proxy: point the runtime record at it
  // (a live pid this process owns, an agent-room /health answer forwarded).
  const proxy = await startDropProxy(t, record.port, {
    drop: 'response',
    matches: (method, path) => method === 'POST' && /^\/api\/rooms\/[^/]+\/messages$/.test(path),
  })
  writeFileSync(world.runtimePath, `${JSON.stringify({
    pid: process.pid,
    port: proxy.port,
    version: APP_VERSION,
  })}\n`, { mode: 0o600 })

  const mcp = startMcpChild(t, world)
  t.after(() => mcp.close())
  await mcp.initialize()
  const peer = await connectPeer(record.port, world.sharedData, 'Peer')

  const opened = structured(await mcp.tool('room_direct_open', { chat_id: 'Peer' }))
  const roomId = opened.room_id

  const sent = structured(await mcp.tool('message_send', {
    room_id: roomId,
    client_message_id: 'm-1',
    text: 'exactly once',
  }))
  // The proxy proves the FIRST attempt reached the server and was answered
  // (200) before the response was destroyed — so the client's retry hit the
  // server's idempotency tuple, not an empty room.
  assert.equal(proxy.seen.firstMatchStatus, 200)
  assert.equal(sent.status, 'committed')
  assert.equal(sent.seq, 1)

  // Exactly one row exists — never a duplicate.
  const page = (await peerGet(record.port, peer.sessionToken, `/api/rooms/${roomId}/messages?after_seq=0`)).json().result
  assert.equal(page.messages.length, 1)
  assert.equal(page.messages[0].client_message_id, 'm-1')

  // An explicit identical resend through the tool returns the original seq.
  const resend = structured(await mcp.tool('message_send', {
    room_id: roomId,
    client_message_id: 'm-1',
    text: 'exactly once',
  }))
  assert.deepEqual(resend, sent)

  await mcp.close()
})

test('stdin purity: JSON-RPC only, parse errors and oversized frames answered, no prompt machinery in the source', async t => {
  // Static half of the purity contract (the spec's verification greps): no
  // prompt machinery, no retired verbs, and no write ever aimed at stdin.
  const source = readFileSync(MCP_ENTRY, 'utf8')
  assert.equal(/prompt|readline/i.test(source), false, 'no prompt or readline machinery')
  assert.equal(/room_create|room_join/.test(source), false, 'the retired verbs are gone')
  assert.equal(/stdin\.write|input\.write/.test(source), false, 'stdin is never written to')

  const world = makeWorld(t)
  await world.waitReady()
  const mcp = startMcpChild(t, world)
  t.after(() => mcp.close())
  await mcp.initialize()

  // A non-JSON line is answered with a parse error (id null) and the process
  // keeps serving JSON-RPC afterwards — stdin stayed the JSON-RPC channel.
  mcp.child.stdin.write('this is not json\n')
  const parseError = await mcp.waitFor(message => message?.error?.code === -32700)
  assert.equal(parseError.jsonrpc, '2.0')

  // An oversized frame is refused too large, never parsed.
  mcp.child.stdin.write(`{"jsonrpc":"2.0","method":"tools/list","id":"big","params":{"pad":"${'x'.repeat(FRAME_MAX_BYTES)}"}}\n`)
  const tooLarge = await mcp.waitFor(message => message?.error?.code === -32600)
  assert.match(tooLarge.error.message, /too large/)

  // The channel still works: a follow-up tools/list answers normally.
  const listed = await mcp.request('tools/list')
  assert.equal(listed.result.tools.length, 5)

  assert.equal(mcp.stderr, '')
  await mcp.close()
})

test('first run: no configured Chat ID fails with coded guidance and the process keeps serving', async t => {
  const world = makeWorld(t, { chatId: null })
  await world.waitReady()
  const mcp = startMcpChild(t, world)
  t.after(() => mcp.close())
  await mcp.initialize()

  const failure = structuredError(await mcp.tool('room_status'))
  assert.equal(failure.error.code, 'invalid_request')
  assert.match(failure.error.message, /No Chat ID is configured/)

  // The process stays alive and answers JSON-RPC afterwards.
  const listed = await mcp.request('tools/list')
  assert.equal(listed.result.tools.length, 5)

  await mcp.close()
})

test('message_read hold: a tool-level wait returns on arrival and respects the hold cap', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  const mcp = startMcpChild(t, world)
  t.after(() => mcp.close())
  await mcp.initialize()

  const peer = await connectPeer(record.port, world.sharedData, 'Peer')
  const roomId = structured(await mcp.tool('room_direct_open', { chat_id: 'Peer' })).room_id

  // A hold that exceeds the server cap is refused through the tool surface.
  const overCap = structuredError(await mcp.tool('message_read', {
    room_id: roomId,
    wait_ms: READ_HOLD_MAX_MS + 5_000,
  }))
  assert.equal(overCap.error.code, 'invalid_arguments')
  assert.match(overCap.error.message, /wait_ms/)

  // A within-cap hold wakes on arrival with the cursor advanced.
  const holding = mcp.tool('message_read', { room_id: roomId, after_seq: 0, wait_ms: 5000 }, 10_000)
  await sleep(200)
  await peerSend(record.port, peer.sessionToken, roomId, 'p-1', 'wake up', 'Peer')
  const woke = structured(await holding)
  assert.equal(woke.messages.length, 1)
  assert.equal(woke.messages[0].text, 'wake up')
  assert.equal(woke.next_after_seq, 1)

  await mcp.close()
  void record
})
