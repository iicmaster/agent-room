// Story 3.4 acceptance: the human CLI surface (HCI-2) — `agent-room held list`,
// `held show <room_id>:<seq>` (the ONLY surface where held body text appears),
// `allow <chat-id>` (resolve, report, save, release) with `--remove`, and
// `allow-all` (the accept-all flip with its interactive confirmation). The
// commands run IN-PROCESS through the real dispatch (main) with injected
// streams and directories, against a real spawned server child and the real
// held/allowlist state files written by the real pipeline functions — zero
// wire mocks, oracles are literals in this file.
//
// Honest scope, stated up front (the same limitation Stories 3.2/3.3
// recorded): a v0.2 connection has exactly one transport — the local token
// file path — and the trust matrix delivers every sender on a local realm by
// construction, so NO real connection can produce a held row yet. The
// hold-producing half is therefore proven at the composed layer: the REAL
// rows of real foreign sends (real foreign keypairs, real HTTP sends, real
// reads) are registered through the REAL registerHeldMessages with the REAL
// matrix's hold reason, exactly as in tests/held.test.mjs, and the CLI then
// lists, previews, releases, and removes over that real state. The
// end-to-end hold chain through a real remote connection is Epic 4's and
// Story 3.5's; nothing here pretends otherwise.
//
// The unbound-session discipline (the story's load-bearing property) is
// proven behaviorally: every command runs clean while a live MCP child holds
// the installation's Chat ID — no chat_id_taken, no new durable claim row,
// no presence footprint — and structurally: the command module's source
// never contains the session-bind route.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { once } from 'node:events'
import { PassThrough } from 'node:stream'
import http from 'node:http'
import diagnosticsChannel from 'node:diagnostics_channel'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { DatabaseSync } from 'node:sqlite'

import { CHAT_ID_INVALID_MESSAGE, HELD_CACHE_MAX } from '../server/constants.mjs'
import { atomicWriteJson } from '../server/runtime.mjs'
import { loadOrCreateLocalToken } from '../server/api/local-token.mjs'
import { fingerprintFromPublicKey, loadOrCreateKeypair } from '../server/keys.mjs'
import { createAgentRoomClient, applyUntrustedEnvelope } from '../server/client/api-client.mjs'
import { applyTrustMatrix, emptyAllowlist } from '../server/client/trust.mjs'
import { heldClear, registerHeldMessages } from '../server/client/held.mjs'
import { main } from '../server/cli/agent-room.mjs'
import {
  ALLOW_ALL_REQUIRES_TTY_MESSAGE,
  exchangeCliSession,
  parseHeldId,
  pointReadViaHttp,
  releaseReportLine,
  resolveChatIdCandidates,
  resolveRealmId,
} from '../server/cli/held-commands.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = join(ROOT, 'server', 'api', 'server.mjs')
const MCP_ENTRY = join(ROOT, 'server', 'mcp-stdio.mjs')
const HELD_COMMANDS_ENTRY = join(ROOT, 'server', 'cli', 'held-commands.mjs')
const RUNTIME_RECORD_FILENAME = 'runtime.json'
const PROTOCOL_KEY = 'agent-room-protocol'

const sleep = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })

// A well-formed fingerprint that no real keypair in the test produces: the
// --fingerprint-outside-the-candidates refusal's input.
const FP_UNRELATED = `sha256:${'ab'.repeat(32)}`

// The AC's negative, composed so this repository's own wording never ships
// the overclaim as a contiguous literal while the assertion still checks the
// exact phrase against every shipped output.
const OVERCLAIM_PHRASE = ['never', 'agent-invocable'].join(' ')

// --- Harness: real server child, real MCP child, HTTP peer, in-process CLI -----

function installation() {
  const { publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const raw = spki.subarray(spki.length - 32)
  return {
    publicKey: raw.toString('base64url'),
    fingerprint: fingerprintFromPublicKey(raw),
  }
}

function makeWorld(t, { chatId = 'Agent', startServer = true } = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'agent-room-cli-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const sharedData = join(parent, 'shared')
  const pluginData = join(parent, 'plugin-data')
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
  if (startServer) startServerChild()

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

  return { parent, sharedData, pluginData, waitReady, startServerChild }
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
      }
    }
  })
  child.stderr.on('data', chunk => { stderr += chunk })

  const request = (method, params = {}, timeoutMs = 15_000) => {
    const id = nextId++
    return new Promise((resolveRequest, rejectPromise) => {
      const timer = setTimeout(() => {
        pending.delete(String(id))
        rejectPromise(new Error(`MCP request timed out: ${method}; stderr=${stderr}`))
      }, timeoutMs)
      pending.set(String(id), {
        resolve(message) {
          clearTimeout(timer)
          resolveRequest(message)
        },
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  const handle = {
    child,
    request,
    async initialize() {
      const response = await request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'CliSurfaceTest', version: '1.0.0' },
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
  t.after(() => handle.close())
  return handle
}

function structured(toolResult) {
  assert.equal(toolResult.isError, undefined, JSON.stringify(toolResult.structuredContent))
  assert.deepEqual(JSON.parse(toolResult.content[0].text), toolResult.structuredContent)
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

async function disconnectPeer(port, sessionToken) {
  const response = await httpRequest(port, 'DELETE', '/api/session', {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${sessionToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
  })
  assert.equal(response.status, 200, response.text)
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

function claimRows(sharedData) {
  const db = new DatabaseSync(join(sharedData, 'agent-room.sqlite'))
  try {
    return db.prepare(`
      SELECT chat_id_normalized, actor_fingerprint
      FROM chat_id_claims
      ORDER BY chat_id_normalized, actor_fingerprint
    `).all()
  } finally {
    db.close()
  }
}

// The CLI runs IN-PROCESS through the real dispatch with injected streams and
// directories, so the assertions see exactly the bytes a terminal would.
function startCli(world, argv, { input } = {}) {
  const inputStream = input ?? new PassThrough()
  const output = new PassThrough()
  const errorOutput = new PassThrough()
  output.setEncoding('utf8')
  errorOutput.setEncoding('utf8')
  let stdout = ''
  let stderr = ''
  output.on('data', chunk => { stdout += chunk })
  errorOutput.on('data', chunk => { stderr += chunk })
  const waitFor = async (streamName, pattern) => {
    const deadline = Date.now() + 5 * 1000
    const text = () => (streamName === 'stdout' ? stdout : stderr)
    for (;;) {
      if (pattern.test(text())) return text()
      if (Date.now() > deadline) throw new Error(`the command never wrote ${pattern} to ${streamName}; got: ${JSON.stringify(text())}`)
      await sleep(25)
    }
  }
  const previousExitCode = process.exitCode
  process.exitCode = undefined
  const pending = main(argv, {
    input: inputStream,
    output,
    errorOutput,
    sharedDataDir: world.sharedData,
    pluginDataDir: world.pluginData,
  })
  const settledPromise = pending.finally(() => {})
  return {
    pending,
    settled: async () => {
      const outcome = await settledPromise
      await sleep(30)
      const exitCode = process.exitCode ?? 0
      // The dispatch signals through process.exitCode; restore the runner's
      // own value so a refusal-driven exit 1 never fails the file itself.
      process.exitCode = previousExitCode
      return { outcome, stdout, stderr, exitCode }
    },
    waitFor,
    input: inputStream,
  }
}

async function runCli(world, argv, options = {}) {
  const run = startCli(world, argv, options)
  return run.settled()
}

// An interactive fixture: a TTY-flagged stream the test writes lines into.
function interactiveInput() {
  const input = new PassThrough()
  input.isTTY = true
  return input
}

// The composed-layer hold production (the honest stand-in for a remote-era
// hold, exactly as tests/held.test.mjs): real foreign sends over the real
// server, real reads, the REAL matrix's hold reason, registered through the
// REAL pipeline. Returns the wrapped artifacts keyed by seq — the bytes the
// pipeline withheld, which `held show` must reproduce verbatim. An existing
// peer session can be reused (a name is live-claimed by one session).
async function holdForeignMessages({ world, client, record, foreign, chatId, roomId, texts, realmId, peer: existingPeer }) {
  const peer = existingPeer ?? await connectPeer(record.port, world.sharedData, chatId, foreign)
  const headBefore = await client.readMessage({ roomId, afterSeq: 0, limit: 1, waitMs: 0 })
  for (const [index, text] of texts.entries()) {
    const sent = await peerSend(
      record.port,
      peer.sessionToken,
      roomId,
      `cmid-${chatId.toLowerCase()}-${index}-${Math.random().toString(36).slice(2, 10)}`,
      text,
      chatId,
    )
    assert.equal(sent.status, 200, sent.text)
  }
  const page = await client.readMessage({ roomId, afterSeq: headBefore.head_seq, limit: 200 })
  const foreignRows = page.messages.filter(row => row.actor_fingerprint === foreign.fingerprint)
  assert.equal(foreignRows.length, texts.length, 'premise: exactly the new foreign rows arrived')
  const matrixPage = applyTrustMatrix(
    { ...page, messages: foreignRows },
    { ownFingerprint: client.fingerprint, transport: 'remote', allowlist: emptyAllowlist() },
  )
  for (const row of matrixPage.messages) {
    assert.equal(row.held, true)
    assert.equal(row.held_reason, 'not_allowlisted')
  }
  const registered = await registerHeldMessages(
    world.pluginData,
    realmId,
    roomId,
    foreignRows.map((raw, index) => ({ ...raw, held_reason: matrixPage.messages[index].held_reason })),
  )
  assert.deepEqual(registered, { registered: texts.length, held_count: registered.held_count })
  return {
    peer,
    wrappedBySeq: new Map(foreignRows.map(row => [row.seq, row.text])),
    // The metadata the pipeline records for each row: size is the withheld
    // artifact's byte length (registerHeldMessages's own computation).
    rowsBySeq: new Map(foreignRows.map(row => [row.seq, {
      ...row,
      size: Buffer.byteLength(row.text, 'utf8'),
    }])),
  }
}

// The realm and broadcast room via the CLI's own unbound helpers — no
// installation session is bound by the harness itself.
async function realmOf(world, record) {
  const { sessionToken } = await exchangeCliSession({
    port: record.port,
    sharedDataDir: world.sharedData,
    pluginDataDir: world.pluginData,
  })
  const realmId = await resolveRealmId({ port: record.port, sessionToken })
  return { sessionToken, realmId }
}

// Presence rows as (lowercased chat id | fingerprint) pairs, read through an
// unbound session (the same discipline the CLI commands use).
async function presencePairs(world, record) {
  const { sessionToken } = await realmOf(world, record)
  const response = await httpRequest(record.port, 'GET', '/api/presence?include_offline=true', {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${sessionToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
  })
  assert.equal(response.status, 200, response.text)
  const body = response.json()
  return [
    ...body.result.online,
    ...body.result.offline_recently,
  ].map(row => `${row.chat_id.toLowerCase()}|${row.fingerprint}`).sort()
}

// The byte between the preview delimiters, recovered by stripping the
// documented pipe prefix from every body line — the body exactly, whatever
// newlines it carries. Every line inside the block must carry the prefix
// (a hostile body can never forge a bare delimiter or CLI line).
function previewBody(stdout) {
  const open = '--- held body ---\n'
  const close = '\n--- end of held body ---'
  const openAt = stdout.indexOf(open)
  assert.notEqual(openAt, -1, 'the preview carries the held-body delimiter')
  const closeAt = stdout.lastIndexOf(close)
  assert.notEqual(closeAt, -1, 'the preview carries the end delimiter')
  assert.ok(closeAt > openAt)
  const block = stdout.slice(openAt + open.length, closeAt)
  const lines = block.split('\n')
  for (const line of lines) {
    assert.ok(line.startsWith('| '), `every body line is pipe-prefixed, got: ${JSON.stringify(line)}`)
  }
  return lines.map(line => line.slice(2)).join('\n')
}

// The literal metadata-line shape the listing and the preview share (an
// oracle spelled out here, never derived from production formatting).
const expectedMetadataLine = (roomId, seq, fingerprint, createdAt, size) =>
  `  ${roomId}:${seq}  chat_id=Stranger fingerprint=${fingerprint} room=${roomId} seq=${seq} created_at=${createdAt} size=${size}B reason=not_allowlisted`

const allowlistPathOf = (world, realmId) => join(world.pluginData, 'realms', realmId, 'allowlist.json')
const heldPathOf = (world, realmId) => join(world.pluginData, 'realms', realmId, 'held.json')

// --- Matrix rows 1-3: held list — empty, with records, filtered ------------------

test('held list: an empty realm names itself with no held messages and creates no state, a seeded realm lists one metadata line per record sorted by (room, seq) with zero body bytes, and the --room filter narrows the listing while a non-room-id shape is refused coded', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  const { realmId } = await realmOf(world, record)

  // Row 1: empty realm — realm named, the no-held line, exit 0, no held.json.
  const empty = await runCli(world, ['held', 'list'])
  assert.equal(empty.exitCode, 0, empty.stderr)
  assert.equal(empty.stdout, `realm ${realmId}: no held messages\n`)
  assert.equal(existsSync(heldPathOf(world, realmId)), false, 'a read never creates held state')
  assert.equal(empty.stderr, '')

  // Rows 2: seeded realm — the composed-layer hold production over two rooms
  // (the Broadcast Room and a real pair DM): three records, one sender. The
  // peer connects first (a name is live-claimed by one session) so the pair
  // room can resolve the name through its durable claim.
  const client = createAgentRoomClient({ dataDir: world.sharedData, pluginDataDir: world.pluginData })
  const status = await client.status()
  const broadcastId = status.broadcast_room_id
  const foreign = installation()
  const heldBroadcast = await holdForeignMessages({
    world, client, record, foreign, realmId,
    chatId: 'Stranger', roomId: broadcastId,
    texts: ['LIST-CANARY-ONE body for broadcast', 'LIST-CANARY-TWO body for broadcast'],
  })
  const direct = await client.directOpen({ chatId: 'Stranger' })
  const directId = direct.room_id
  const heldDirect = await holdForeignMessages({
    world, client, record, foreign, realmId,
    chatId: 'Stranger', roomId: directId,
    texts: ['LIST-CANARY-THREE body for the pair room'],
    peer: heldBroadcast.peer,
  })
  const rows = [
    ...heldBroadcast.rowsBySeq.values(),
    ...heldDirect.rowsBySeq.values(),
  ].sort((left, right) => (left.room_id !== right.room_id
    ? (left.room_id < right.room_id ? -1 : 1)
    : left.seq - right.seq))
  assert.equal(rows.length, 3)

  const listed = await runCli(world, ['held', 'list'])
  assert.equal(listed.exitCode, 0, listed.stderr)
  assert.equal(listed.outcome.ok, true)
  assert.equal(listed.outcome.realmId, realmId)

  // The literal listing: header (realm + count) then one metadata line per
  // record, sorted by (room_id, seq) — the line shapes are spelled out here,
  // the field values pinned from the seeded rows' real metadata.
  const expectedLines = [
    `realm ${realmId}: 3 held messages`,
    ...rows.map(row => expectedMetadataLine(row.room_id, row.seq, foreign.fingerprint, row.created_at, row.size)),
  ]
  assert.equal(listed.stdout, `${expectedLines.join('\n')}\n`)

  // ZERO body bytes: neither the raw texts nor any envelope fragment.
  for (const canary of ['LIST-CANARY-ONE', 'LIST-CANARY-TWO', 'LIST-CANARY-THREE', 'untrusted_message', 'body for']) {
    assert.equal(listed.stdout.includes(canary), false, `the listing must not carry: ${canary}`)
  }

  // Row 3: the room filter narrows the listing and the header reflects it.
  const filtered = await runCli(world, ['held', 'list', '--room', directId])
  assert.equal(filtered.exitCode, 0, filtered.stderr)
  const directRows = rows.filter(row => row.room_id === directId)
  assert.equal(filtered.stdout, `realm ${realmId}: 1 held message\n${
    expectedMetadataLine(directRows[0].room_id, directRows[0].seq, foreign.fingerprint, directRows[0].created_at, directRows[0].size)}\n`)
  assert.equal(filtered.stdout.includes(broadcastId), false, 'the other room\'s records are not listed')

  // A non-room-id shape is a coded refusal naming the input.
  for (const bad of ['', 'x'.repeat(129)]) {
    const refused = await runCli(world, ['held', 'list', '--room', bad])
    assert.equal(refused.exitCode, 1)
    assert.equal(
      refused.stderr,
      `agent-room held list failed: invalid_request: "${bad}" is not a room id (1-128 characters); the --room filter takes a room id as shown in the listing\n`,
    )
  }
})

// --- Matrix row 4: held show, cached body ----------------------------------------

test('held show of a cached record: the metadata block then the full body verbatim between delimiters byte-matching the cached artifact, with the provenance line naming the local cache', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  const { realmId } = await realmOf(world, record)
  const client = createAgentRoomClient({ dataDir: world.sharedData, pluginDataDir: world.pluginData })
  const broadcastId = (await client.status()).broadcast_room_id
  const foreign = installation()
  const held = await holdForeignMessages({
    world, client, record, foreign, realmId,
    chatId: 'Stranger', roomId: broadcastId,
    texts: ['SHOW-CANARY-ONE cached body artifact', 'SHOW-CANARY-TWO cached body artifact'],
  })

  const shown = await runCli(world, ['held', 'show', `${broadcastId}:2`])
  assert.equal(shown.exitCode, 0, shown.stderr)
  assert.equal(shown.outcome.ok, true)
  assert.equal(shown.outcome.evicted, false)

  const wrapped = held.wrappedBySeq.get(2)
  const row = held.rowsBySeq.get(2)
  const expectedLines = [
    `held ${broadcastId}:2  (realm ${realmId})`,
    expectedMetadataLine(broadcastId, 2, foreign.fingerprint, row.created_at, row.size),
    'provenance: the preview came from the local cache',
    'every body line below is prefixed with "| " so no body line can imitate this output or the delimiters; the preview is otherwise the artifact verbatim',
    '--- held body ---',
    ...wrapped.split('\n').map(line => `| ${line}`),
    '--- end of held body ---',
  ]
  assert.equal(shown.stdout, `${expectedLines.join('\n')}\n`)
  assert.equal(previewBody(shown.stdout), wrapped, 'the preview byte-matches the cached artifact')

  // The other record's body does not ride this preview.
  assert.equal(shown.stdout.includes('SHOW-CANARY-ONE'), false)
  // No credential ever reaches the output.
  assert.equal(shown.stdout.includes('Bearer'), false)
})

// --- Matrix row 5: held show, evicted body ---------------------------------------

test('held show of an evicted record: the body is recovered by point read through the real server, byte-identical to the withheld artifact, and the recovery result is not re-cached', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  const { realmId } = await realmOf(world, record)
  const client = createAgentRoomClient({ dataDir: world.sharedData, pluginDataDir: world.pluginData })
  const broadcastId = (await client.status()).broadcast_room_id
  const foreign = installation()

  // HELD_CACHE_MAX + 5 records: the five oldest body copies are evicted.
  const total = HELD_CACHE_MAX + 5
  const held = await holdForeignMessages({
    world, client, record, foreign, realmId,
    chatId: 'Stranger', roomId: broadcastId,
    texts: Array.from({ length: total }, (_, index) => `EVICTION-CANARY-${index + 1} body artifact number ${index + 1}`),
  })
  assert.equal(held.wrappedBySeq.size, total)

  const heldPath = heldPathOf(world, realmId)
  const fileBefore = readFileSync(heldPath, 'utf8')

  // An evicted record (seq 1): recovered by point read, byte-identical.
  const shown = await runCli(world, ['held', 'show', `${broadcastId}:1`])
  assert.equal(shown.exitCode, 0, shown.stderr)
  assert.equal(shown.outcome.ok, true)
  assert.equal(shown.outcome.evicted, true)
  const wrapped = held.wrappedBySeq.get(1)
  assert.equal(previewBody(shown.stdout), wrapped, 'the recovered preview byte-matches the withheld artifact')
  assert.match(shown.stdout, /provenance: the preview was recovered by point read \(after_seq = seq − 1, limit = 1\) from the durable log/)
  assert.equal(readFileSync(heldPath, 'utf8'), fileBefore, 'the recovery result is not re-cached')

  // A second evicted record (seq 5) recovers the same way.
  const shownFive = await runCli(world, ['held', 'show', `${broadcastId}:5`])
  assert.equal(shownFive.exitCode, 0, shownFive.stderr)
  assert.equal(previewBody(shownFive.stdout), held.wrappedBySeq.get(5))

  // A cached record (seq total, the freshest copy) still comes from the cache.
  const cached = await runCli(world, ['held', 'show', `${broadcastId}:${total}`])
  assert.equal(cached.exitCode, 0, cached.stderr)
  assert.equal(cached.outcome.evicted, false)
  assert.match(cached.stdout, /provenance: the preview came from the local cache/)
  assert.equal(previewBody(cached.stdout), held.wrappedBySeq.get(total))
})

// --- Matrix rows 6-7: held show, unknown and malformed ids ------------------------

test('held show refusals: an unknown id names the id and says it is not held (a released record is never shown again), and a malformed id names the input and the expected <room_id>:<seq> form', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  const { realmId } = await realmOf(world, record)
  const client = createAgentRoomClient({ dataDir: world.sharedData, pluginDataDir: world.pluginData })
  const broadcastId = (await client.status()).broadcast_room_id
  const foreign = installation()
  await holdForeignMessages({
    world, client, record, foreign, realmId,
    chatId: 'Stranger', roomId: broadcastId,
    texts: ['UNKNOWN-CANARY body artifact one'],
  })

  // A well-formed id with no held record (never registered).
  const unknown = await runCli(world, ['held', 'show', `${broadcastId}:999`])
  assert.equal(unknown.exitCode, 1)
  assert.match(unknown.stderr, /agent-room held show failed: message_not_found: held message ".*:999" is not held/)
  assert.match(unknown.stderr, /never registered, or already released/)
  assert.match(unknown.stderr, /never shown again/)

  // Malformed ids: last-colon parse, positive integer sequence.
  for (const bad of ['nonsense', `${broadcastId}:0`, `${broadcastId}:notaseq`, ':5', `${broadcastId}:`]) {
    const refused = await runCli(world, ['held', 'show', bad])
    assert.equal(refused.exitCode, 1, bad)
    assert.match(refused.stderr, /agent-room held show failed: invalid_request:/, bad)
    assert.match(refused.stderr, new RegExp(`"${bad.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" is not a held-message id`), bad)
    assert.match(refused.stderr, /expected <room_id>:<seq>/, bad)
  }

  // The parser itself: the last colon splits; a colon-bearing room id parses.
  assert.deepEqual(parseHeldId(`${broadcastId}:7`), { roomId: broadcastId, seq: 7 })
  assert.deepEqual(parseHeldId('direct:sha256:a:sha256:b:12'), { roomId: 'direct:sha256:a:sha256:b', seq: 12 })

  // After a real release through the CLI, the record is never shown again.
  const allowed = await runCli(world, ['allow', 'Stranger'])
  assert.equal(allowed.exitCode, 0, allowed.stderr)
  const released = await runCli(world, ['held', 'show', `${broadcastId}:1`])
  assert.equal(released.exitCode, 1)
  assert.match(released.stderr, /is not held/)
})

// --- Matrix row 8: allow from held records ----------------------------------------

test('allow resolves the name from the held records of the realm, reports realm + fingerprint, persists the entry at 0600 (the original added_at preserved on re-allow), and releases every held record of that fingerprint', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  const { realmId } = await realmOf(world, record)
  const client = createAgentRoomClient({ dataDir: world.sharedData, pluginDataDir: world.pluginData })
  const broadcastId = (await client.status()).broadcast_room_id

  // Two foreign senders: Stranger (two held records) and Other (one record
  // that must survive Stranger's release untouched).
  const stranger = installation()
  const other = installation()
  const strangerHeld = await holdForeignMessages({
    world, client, record, foreign: stranger, realmId,
    chatId: 'Stranger', roomId: broadcastId,
    texts: ['ALLOW-CANARY-ONE stranger artifact', 'ALLOW-CANARY-TWO stranger artifact'],
  })
  await holdForeignMessages({
    world, client, record, foreign: other, realmId,
    chatId: 'Other', roomId: broadcastId,
    texts: ['ALLOW-CANARY-OTHER other artifact'],
  })

  const allowed = await runCli(world, ['allow', 'Stranger'])
  assert.equal(allowed.exitCode, 0, allowed.stderr)
  assert.equal(allowed.outcome.ok, true)
  assert.equal(allowed.outcome.realmId, realmId)
  assert.equal(allowed.outcome.fingerprint, stranger.fingerprint)
  assert.deepEqual(allowed.stdout, [
    `realm ${realmId}: allowed fingerprint ${stranger.fingerprint} (chat id "Stranger")`,
    'released 2 held record(s) for this fingerprint',
  ].join('\n') + '\n')
  // Metadata at most — no body byte rides the allow report.
  for (const canary of ['ALLOW-CANARY-ONE', 'ALLOW-CANARY-TWO', 'ALLOW-CANARY-OTHER', 'untrusted_message']) {
    assert.equal(allowed.stdout.includes(canary), false, `the allow report must not carry: ${canary}`)
  }

  // The allowlist entry: persisted, 0600, in the 0700 realm directory.
  const allowlistPath = allowlistPathOf(world, realmId)
  assert.equal(statSync(allowlistPath).mode & 0o777, 0o600, 'the allowlist file is 0600')
  assert.equal(statSync(join(world.pluginData, 'realms', realmId)).mode & 0o777, 0o700, 'the realm directory is 0700')
  const allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'))
  assert.deepEqual(allowlist.entries.map(entry => entry.fingerprint), [stranger.fingerprint])
  assert.equal(allowlist.accept_all, false)
  const addedAt = allowlist.entries[0].added_at
  assert.ok(!Number.isNaN(Date.parse(addedAt)))

  // EVERY held record with that fingerprint was released; other keys survive.
  const heldState = JSON.parse(readFileSync(heldPathOf(world, realmId), 'utf8'))
  assert.deepEqual(heldState.entries.map(entry => entry.actor_fingerprint), [other.fingerprint])
  assert.equal(heldState.entries[0].chat_id, 'Other')

  // A re-allow is idempotent and keeps the original grant moment.
  const reallowed = await runCli(world, ['allow', 'Stranger'])
  assert.equal(reallowed.exitCode, 0, reallowed.stderr)
  assert.deepEqual(reallowed.stdout, [
    `realm ${realmId}: allowed fingerprint ${stranger.fingerprint} (chat id "Stranger")`,
    'no held records carried this fingerprint; nothing to release',
  ].join('\n') + '\n')
  const allowlistAfter = JSON.parse(readFileSync(allowlistPath, 'utf8'))
  assert.equal(allowlistAfter.entries[0].added_at, addedAt, 'the original added_at is preserved on re-allow')
  assert.deepEqual(allowlistAfter.entries.map(entry => entry.fingerprint), [stranger.fingerprint])

  void strangerHeld
})

// --- Matrix rows 9-12: allow via presence, ambiguity, --fingerprint ---------------

test('allow resolves an offline-records-absent name from presence, refuses an ambiguous name with the candidate list and nothing persisted, disambiguates with --fingerprint, and refuses a fingerprint outside the candidates', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  const { realmId } = await realmOf(world, record)
  const client = createAgentRoomClient({ dataDir: world.sharedData, pluginDataDir: world.pluginData })
  const broadcastId = (await client.status()).broadcast_room_id

  // Foreign key one claims "Stranger", sends held messages, and disconnects:
  // its records carry fingerprint one, its durable claim ages into the
  // offline-recently group.
  const strangerOne = installation()
  const strangerPeerOne = await connectPeer(record.port, world.sharedData, 'Stranger', strangerOne)
  const headBefore = await client.readMessage({ roomId: broadcastId, afterSeq: 0, limit: 1, waitMs: 0 })
  for (const [index, text] of ['AMBIG-CANARY-ONE artifact', 'AMBIG-CANARY-TWO artifact'].entries()) {
    const sent = await peerSend(record.port, strangerPeerOne.sessionToken, broadcastId,
      `cmid-stranger-${index}-${Math.random().toString(36).slice(2, 10)}`, text, 'Stranger')
    assert.equal(sent.status, 200, sent.text)
  }
  const page = await client.readMessage({ roomId: broadcastId, afterSeq: headBefore.head_seq, limit: 200 })
  const oneRows = page.messages.filter(row => row.actor_fingerprint === strangerOne.fingerprint)
  assert.equal(oneRows.length, 2)
  await registerHeldMessages(world.pluginData, realmId, broadcastId,
    oneRows.map(row => ({ ...row, held_reason: 'not_allowlisted' })))
  await disconnectPeer(record.port, strangerPeerOne.sessionToken)

  // Foreign key two now claims the SAME name live (D13's reused-name state).
  const strangerTwo = installation()
  await connectPeer(record.port, world.sharedData, 'Stranger', strangerTwo)
  // A third foreign installation is live under a name with no held records.
  const ollie = installation()
  await connectPeer(record.port, world.sharedData, 'Online-Ollie', ollie)

  // Row 9: a name absent from the held records resolves from the presence row.
  const viaPresence = await runCli(world, ['allow', 'Online-Ollie'])
  assert.equal(viaPresence.exitCode, 0, viaPresence.stderr)
  assert.equal(viaPresence.outcome.fingerprint, ollie.fingerprint)
  assert.equal(viaPresence.outcome.realmId, realmId)
  assert.match(viaPresence.stdout, new RegExp(`realm ${realmId}: allowed fingerprint ${ollie.fingerprint} \\(chat id "Online-Ollie"\\)`))
  assert.match(viaPresence.stdout, /no held records carried this fingerprint; nothing to release/)

  // Row 10: the reused name is claimed by two fingerprints — refuse with the
  // candidates, one per line (fingerprint + source/last-seen), nothing saved.
  const ambiguous = await runCli(world, ['allow', 'Stranger'])
  assert.equal(ambiguous.exitCode, 1)
  assert.equal(ambiguous.outcome.ok, false)
  assert.equal(ambiguous.outcome.code, 'ambiguous_chat_id')
  assert.match(ambiguous.stderr, /agent-room allow failed: ambiguous_chat_id: the chat id "Stranger" is claimed by 2 keys; nothing was changed/)
  assert.match(ambiguous.stderr, new RegExp(`candidate: fingerprint ${strangerOne.fingerprint} — held record; presence last-seen `))
  assert.match(ambiguous.stderr, new RegExp(`candidate: fingerprint ${strangerTwo.fingerprint} — presence last-seen `))
  // Nothing was persisted: the allowlist still holds only Online-Ollie's
  // entry, and the held records are untouched.
  const allowlist = JSON.parse(readFileSync(allowlistPathOf(world, realmId), 'utf8'))
  assert.deepEqual(allowlist.entries.map(entry => entry.fingerprint), [ollie.fingerprint])
  let heldState = JSON.parse(readFileSync(heldPathOf(world, realmId), 'utf8'))
  assert.equal(heldState.entries.length, 2)
  assert.deepEqual(heldState.entries.map(entry => entry.actor_fingerprint), [strangerOne.fingerprint, strangerOne.fingerprint])

  // Row 11: --fingerprint of candidate two allows exactly that key and leaves
  // candidate one's records untouched.
  const disambiguated = await runCli(world, ['allow', 'Stranger', '--fingerprint', strangerTwo.fingerprint])
  assert.equal(disambiguated.exitCode, 0, disambiguated.stderr)
  assert.equal(disambiguated.outcome.fingerprint, strangerTwo.fingerprint)
  assert.match(disambiguated.stdout, new RegExp(`realm ${realmId}: allowed fingerprint ${strangerTwo.fingerprint} \\(chat id "Stranger"\\)`))
  assert.match(disambiguated.stdout, /no held records carried this fingerprint; nothing to release/)
  const allowlistAfter = JSON.parse(readFileSync(allowlistPathOf(world, realmId), 'utf8'))
  assert.deepEqual(allowlistAfter.entries.map(entry => entry.fingerprint).sort(), [ollie.fingerprint, strangerTwo.fingerprint].sort())
  heldState = JSON.parse(readFileSync(heldPathOf(world, realmId), 'utf8'))
  assert.equal(heldState.entries.length, 2, 'candidate one\'s held records are untouched')

  // Row 12: a well-formed fingerprint outside the candidates is refused with
  // the candidate list — never a silent allow of an unrelated key.
  const outside = await runCli(world, ['allow', 'Stranger', '--fingerprint', FP_UNRELATED])
  assert.equal(outside.exitCode, 1)
  assert.equal(outside.outcome.code, 'invalid_request')
  assert.match(outside.stderr, new RegExp(`"${FP_UNRELATED}" is not among the candidates for chat id "Stranger"`))
  assert.match(outside.stderr, new RegExp(`candidate: fingerprint ${strangerOne.fingerprint} — held record`))
  assert.match(outside.stderr, new RegExp(`candidate: fingerprint ${strangerTwo.fingerprint} — presence last-seen`))
  const allowlistFinal = JSON.parse(readFileSync(allowlistPathOf(world, realmId), 'utf8'))
  assert.deepEqual(allowlistFinal.entries.map(entry => entry.fingerprint).sort(), [ollie.fingerprint, strangerTwo.fingerprint].sort())

  // The resolution sources themselves: held records + presence, merged by
  // fingerprint, case-insensitively (DR-1).
  const { sessionToken } = await realmOf(world, record)
  const candidates = await resolveChatIdCandidates({
    port: record.port, sessionToken, pluginDataDir: world.pluginData, realmId, chatName: 'STRANGER',
  })
  assert.deepEqual(candidates.map(candidate => candidate.fingerprint).sort(),
    [strangerOne.fingerprint, strangerTwo.fingerprint].sort())
})

// --- Matrix rows 13-14: unknown and grammatically invalid names -------------------

test('allow refuses an unknown name with both sources it searched and an invalid name with the verbatim grammar message — never a bare invalid', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()

  // Row 13: no held record, no presence row (include_offline queried).
  const unknown = await runCli(world, ['allow', 'Ghost'])
  assert.equal(unknown.exitCode, 1)
  assert.equal(unknown.outcome.code, 'chat_id_not_found')
  assert.match(unknown.stderr, /agent-room allow failed: chat_id_not_found: no sender with chat id "Ghost" was found/)
  assert.match(unknown.stderr, /this realm's held records/)
  assert.match(unknown.stderr, /presence \(online and offline-recently were both searched\)/)
  assert.match(unknown.stderr, /nothing was changed/)

  // Row 14: the grammar gate quotes CHAT_ID_INVALID_MESSAGE verbatim and
  // names the failing input.
  const invalid = await runCli(world, ['allow', 'bad name!'])
  assert.equal(invalid.exitCode, 1)
  assert.equal(
    invalid.stderr,
    `agent-room allow failed: invalid_chat_id: "bad name!" is not a valid Chat ID: ${CHAT_ID_INVALID_MESSAGE}\n`,
  )

  // --remove resolves through the same sources: an unknown name refuses
  // before anything is touched.
  const removeUnknown = await runCli(world, ['allow', 'Ghost', '--remove'])
  assert.equal(removeUnknown.exitCode, 1)
  assert.equal(removeUnknown.outcome.code, 'chat_id_not_found')

  // Nothing was persisted by any of the refusals.
  const { realmId } = await realmOf(world, record)
  assert.equal(existsSync(allowlistPathOf(world, realmId)), false)
})

// --- Matrix row 15: allow --remove affects future ingestion only ------------------

test('allow --remove deletes the entry only: held records of every key are untouched, a real re-read through the matrix holds the sender again, and the durable log is untouched', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  const { realmId } = await realmOf(world, record)
  const client = createAgentRoomClient({ dataDir: world.sharedData, pluginDataDir: world.pluginData })
  const broadcastId = (await client.status()).broadcast_room_id

  const stranger = installation()
  const other = installation()
  const strangerHeld = await holdForeignMessages({
    world, client, record, foreign: stranger, realmId,
    chatId: 'Stranger', roomId: broadcastId,
    texts: ['REMOVE-CANARY stranger artifact one'],
  })
  await holdForeignMessages({
    world, client, record, foreign: other, realmId,
    chatId: 'Other', roomId: broadcastId,
    texts: ['REMOVE-CANARY-OTHER other artifact'],
  })
  void other

  // Grant, then remove.
  const allowed = await runCli(world, ['allow', 'Stranger'])
  assert.equal(allowed.exitCode, 0, allowed.stderr)
  let heldState = JSON.parse(readFileSync(heldPathOf(world, realmId), 'utf8'))
  assert.deepEqual(heldState.entries.map(entry => entry.chat_id), ['Other'], 'the release took only Stranger\'s record')
  const otherSeq = heldState.entries[0].seq

  const removed = await runCli(world, ['allow', 'Stranger', '--remove'])
  assert.equal(removed.exitCode, 0, removed.stderr)
  assert.equal(removed.outcome.removed, true)
  assert.deepEqual(removed.stdout, [
    `realm ${realmId}: removed the allowlist entry for fingerprint ${stranger.fingerprint} (chat id "Stranger")`,
    'future messages from this sender are held again; already-ingested text and the durable log are untouched',
  ].join('\n') + '\n')
  const allowlist = JSON.parse(readFileSync(allowlistPathOf(world, realmId), 'utf8'))
  assert.deepEqual(allowlist.entries, [])
  assert.equal(allowlist.accept_all, false)

  // Held records of every key untouched by the removal.
  heldState = JSON.parse(readFileSync(heldPathOf(world, realmId), 'utf8'))
  assert.deepEqual(heldState.entries.map(entry => entry.chat_id), ['Other'])

  // Future ingestion: the same key sends again (its session is still live)
  // and the REAL matrix holds it — the removal's future-only effect, proven
  // by a real re-read.
  const future = await holdForeignMessages({
    world, client, record, foreign: stranger, realmId,
    chatId: 'Stranger', roomId: broadcastId,
    texts: ['REMOVE-CANARY stranger artifact two (after removal)'],
    peer: strangerHeld.peer,
  })
  const futureSeqs = [...future.wrappedBySeq.keys()]
  assert.equal(futureSeqs.length, 1)
  heldState = JSON.parse(readFileSync(heldPathOf(world, realmId), 'utf8'))
  assert.deepEqual(
    heldState.entries.map(entry => `${entry.chat_id}:${entry.seq}`).sort(),
    [`Other:${otherSeq}`, `Stranger:${futureSeqs[0]}`].sort(),
    'the new send registered as held; the released record was not resurrected',
  )

  // The durable log is untouched: all three messages are still there.
  const log = await client.readMessage({ roomId: broadcastId, afterSeq: 0, limit: 200 })
  assert.equal(log.messages.length, 3)
  void strangerHeld
})

// --- Matrix rows 16-18: allow-all — confirm, non-TTY, remove ----------------------

test('allow-all: a non-TTY stdin is refused with guidance and nothing changed, a TTY y sets accept_all with the Instructed honesty, and --remove switches it off without any confirmation', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  const { realmId } = await realmOf(world, record)

  // Row 17: non-TTY stdin — coded refusal, guidance, accept_all untouched
  // (the blanket grant can never be driven programmatically).
  const nonTty = await runCli(world, ['allow-all'])
  assert.equal(nonTty.exitCode, 1)
  assert.equal(nonTty.outcome.ok, false)
  assert.equal(nonTty.outcome.message, ALLOW_ALL_REQUIRES_TTY_MESSAGE)
  assert.equal(
    nonTty.stderr,
    `agent-room allow-all failed: invalid_request: ${ALLOW_ALL_REQUIRES_TTY_MESSAGE}\n`,
  )
  assert.equal(existsSync(allowlistPathOf(world, realmId)), false, 'a refused confirmation writes nothing')

  // A declined interactive answer changes nothing either (the abort
  // discipline: the message on stderr, exit 1).
  const declinedRun = startCli(world, ['allow-all'], { input: interactiveInput() })
  await declinedRun.waitFor('stdout', /Continue\? \[y\/N\]/)
  declinedRun.input.write('n\n')
  const declined = await declinedRun.settled()
  assert.equal(declined.exitCode, 1)
  assert.equal(
    declined.stderr,
    'agent-room: confirm_declined: agent-room allow-all kept accept-all off; nothing was changed\n',
  )
  assert.equal(existsSync(allowlistPathOf(world, realmId)), false)

  // Row 16: interactive y — accept_all true persisted via the real
  // setAcceptAll, the realm reported with the Instructed label. The prompt
  // itself precedes the result on the same stream; the RESULT lines are
  // asserted byte-exact after it.
  const confirmedRun = startCli(world, ['allow-all'], { input: interactiveInput() })
  await confirmedRun.waitFor('stdout', /Continue\? \[y\/N\]/)
  confirmedRun.input.write('y\n')
  const confirmed = await confirmedRun.settled()
  assert.equal(confirmed.exitCode, 0, confirmed.stderr)
  assert.equal(confirmed.outcome.ok, true)
  assert.equal(confirmed.outcome.acceptAll, true)
  const promptEnd = confirmed.stdout.indexOf('[y/N] ') + '[y/N] '.length
  assert.ok(promptEnd >= '[y/N] '.length, 'the confirmation prompt was shown')
  assert.equal(confirmed.stdout.slice(promptEnd), [
    `realm ${realmId}: accept-all is ON — every future sender delivers without per-sender verification.`,
    'This approval is a human convention (Instructed): same-user processes are not cryptographically distinguishable.',
    'The untrusted envelope stays on delivered bodies.',
  ].join('\n') + '\n')
  const allowlist = JSON.parse(readFileSync(allowlistPathOf(world, realmId), 'utf8'))
  assert.equal(allowlist.accept_all, true)

  // Row 18: --remove is the fail-safe direction — NO confirmation needed
  // (proven with a non-TTY input, which a confirming command would refuse).
  const removed = await runCli(world, ['allow-all', '--remove'])
  assert.equal(removed.exitCode, 0, removed.stderr)
  assert.equal(removed.outcome.acceptAll, false)
  assert.deepEqual(removed.stdout, `realm ${realmId}: accept-all is OFF — future senders without an allowlist entry are held again\n`)
  const allowlistAfter = JSON.parse(readFileSync(allowlistPathOf(world, realmId), 'utf8'))
  assert.equal(allowlistAfter.accept_all, false)
})

// --- Matrix rows 19-21: help/usage honesty + the unbound-session discipline -------

test('help and usage carry the verbatim Instructed honesty and never the overclaim; and with a live MCP child holding the Chat ID every command succeeds with zero session footprint', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()

  // Row 19: help — every command with its grammar, the honesty statement, and
  // the AC's negative absent from the entire output. The statements are
  // matched against the whitespace-flattened text so a wrapped line still
  // reads as the same words.
  for (const argv of [['help'], ['--help'], ['-h']]) {
    const help = await runCli(world, argv)
    assert.equal(help.exitCode, 0, help.stderr)
    const flat = help.stdout.replace(/\s+/g, ' ')
    for (const fragment of [
      'agent-room setup',
      'agent-room held list [--room <room_id>]',
      'agent-room held show <room_id>:<seq>',
      'agent-room allow <chat-id> [--fingerprint <fingerprint>] [--remove]',
      'agent-room allow-all [--remove]',
      'agent-room help',
      'Approval is a human convention (Instructed) — same-user processes are not cryptographically distinguishable',
    ]) {
      assert.match(flat, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), fragment)
    }
    assert.equal(help.stdout.includes(OVERCLAIM_PHRASE), false)
    assert.equal(help.stderr, '')
  }

  // Row 20: no args, an unknown command, and an unresolvable family shape —
  // each names itself on one coded line, then usage plus honesty on stderr,
  // exit 1, no state touched.
  const { realmId } = await realmOf(world, record)
  for (const [argv, codedLine] of [
    [[], 'agent-room: usage_refusal: no command given; run "agent-room help" for the command reference\n'],
    [['frobnicate'], 'agent-room: unknown_command: unknown command "frobnicate"; run "agent-room help" for the command reference\n'],
    [['held'], 'agent-room: usage_refusal: unknown command "held"; run "agent-room help" for the command reference\n'],
    [['held', 'bogus'], 'agent-room: usage_refusal: unknown command "held bogus"; run "agent-room help" for the command reference\n'],
  ]) {
    const usage = await runCli(world, argv)
    assert.equal(usage.exitCode, 1)
    assert.ok(usage.stderr.startsWith(codedLine), `coded refusal line for ${JSON.stringify(argv)}; got: ${JSON.stringify(usage.stderr)}`)
    assert.match(usage.stderr, /Approval is a human convention \(Instructed\)/)
    assert.equal(usage.stderr.includes(OVERCLAIM_PHRASE), false)
  }
  assert.equal(existsSync(allowlistPathOf(world, realmId)), false)
  assert.equal(existsSync(heldPathOf(world, realmId)), false)

  // Row 21: the unbound-session discipline against a live MCP child that
  // holds the installation's Chat ID.
  const mcp = startMcpChild(t, world)
  await mcp.initialize()
  const mcpStatus = structured(await mcp.tool('room_status'))
  assert.equal(mcpStatus.realm_id, realmId)
  const broadcastId = mcpStatus.broadcast_room_id

  // A real foreign sender with a held record, so held show and allow have
  // real work to do while the child holds the name.
  const foreign = installation()
  const strangerPeer = await connectPeer(record.port, world.sharedData, 'Stranger', foreign)
  const sent = await peerSend(record.port, strangerPeer.sessionToken, broadcastId,
    `cmid-unbound-0-${Math.random().toString(36).slice(2, 10)}`, 'UNBOUND-CANARY artifact', 'Stranger')
  assert.equal(sent.status, 200, sent.text)
  const read = structured(await mcp.tool('message_read', { room_id: broadcastId, after_seq: 0 }))
  assert.equal(read.messages.length, 1)
  await registerHeldMessages(world.pluginData, realmId, broadcastId,
    read.messages.map(row => ({ ...row, held_reason: 'not_allowlisted' })))

  const claimsBefore = claimRows(world.sharedData).map(row => `${row.chat_id_normalized}|${row.actor_fingerprint}`).sort()
  const presenceBefore = await presencePairs(world, record)
  assert.ok(presenceBefore.some(pair => pair.startsWith('agent|')), 'premise: the MCP session is live and present')

  const outputs = []
  const heldListRun = await runCli(world, ['held', 'list'])
  assert.equal(heldListRun.exitCode, 0, heldListRun.stderr)
  outputs.push(heldListRun.stdout, heldListRun.stderr)

  const heldShowRun = await runCli(world, ['held', 'show', `${broadcastId}:1`])
  assert.equal(heldShowRun.exitCode, 0, heldShowRun.stderr)
  assert.equal(previewBody(heldShowRun.stdout), read.messages[0].text)
  outputs.push(heldShowRun.stdout, heldShowRun.stderr)

  const allowRun = await runCli(world, ['allow', 'Stranger'])
  assert.equal(allowRun.exitCode, 0, allowRun.stderr)
  assert.equal(allowRun.outcome.fingerprint, foreign.fingerprint)
  outputs.push(allowRun.stdout, allowRun.stderr)

  // The removal direction under the live child too: `allow --remove` resolves
  // from the allowlist itself and leaves the same zero footprint.
  const allowRemoveRun = await runCli(world, ['allow', 'Stranger', '--remove'])
  assert.equal(allowRemoveRun.exitCode, 0, allowRemoveRun.stderr)
  assert.equal(allowRemoveRun.outcome.removed, true)
  outputs.push(allowRemoveRun.stdout, allowRemoveRun.stderr)

  const allowAllRemoveRun = await runCli(world, ['allow-all', '--remove'])
  assert.equal(allowAllRemoveRun.exitCode, 0, allowAllRemoveRun.stderr)
  outputs.push(allowAllRemoveRun.stdout, allowAllRemoveRun.stderr)

  // And the confirmed blanket grant under the live child: a TTY y flips
  // accept-all with the same zero session footprint.
  const allowAllConfirmedRun = startCli(world, ['allow-all'], { input: interactiveInput() })
  await allowAllConfirmedRun.waitFor('stdout', /Continue\? \[y\/N\]/)
  allowAllConfirmedRun.input.write('y\n')
  const allowAllConfirmed = await allowAllConfirmedRun.settled()
  assert.equal(allowAllConfirmed.exitCode, 0, allowAllConfirmed.stderr)
  assert.equal(allowAllConfirmed.outcome.acceptAll, true)
  outputs.push(allowAllConfirmed.stdout, allowAllConfirmed.stderr)

  // No chat_id_taken anywhere, and no secret either.
  for (const text of outputs) {
    assert.equal(text.includes('chat_id_taken'), false)
    assert.equal(text.includes('Bearer'), false)
    assert.equal(text.includes('session_token'), false)
  }
  assert.equal(outputs.join('').includes(loadOrCreateLocalToken(world.sharedData)), false,
    'the local token never appears in any command output')

  // Zero footprint: no new durable claim row, no presence change.
  const claimsAfter = claimRows(world.sharedData).map(row => `${row.chat_id_normalized}|${row.actor_fingerprint}`).sort()
  assert.deepEqual(claimsAfter, claimsBefore, 'the CLI session wrote no durable claim')
  const presenceAfter = await presencePairs(world, record)
  assert.deepEqual(presenceAfter, presenceBefore, 'the CLI session created no presence row')

  // The MCP session's claim and presence are unchanged: the child still works.
  const heldCount = structured(await mcp.tool('room_held_count'))
  assert.equal(heldCount.held_count, 0, 'the CLI\'s allow released the record the child sees too')
  assert.equal(mcp.stderr, '')
  await mcp.close()

  // And structurally: the command module never even mentions the bind route.
  const source = readFileSync(HELD_COMMANDS_ENTRY, 'utf8')
  assert.equal(source.includes('/api/session'), false, 'the CLI commands never send POST /api/session')
})

// --- Review patches: removal from the allowlist, honest diagnostics ---------------

test('allow <chat-id> --remove resolves from the allowlist itself: a sender silent past every resolution source keeps a revocation path for its standing grant, and an unknown name refuses', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  const { realmId } = await realmOf(world, record)
  const client = createAgentRoomClient({ dataDir: world.sharedData, pluginDataDir: world.pluginData })
  const broadcastId = (await client.status()).broadcast_room_id

  // Stranger sends one held message and is allowed: the entry records the
  // chat id the grant was made under.
  const stranger = installation()
  const strangerPeer = await connectPeer(record.port, world.sharedData, 'Stranger', stranger)
  const sent = await peerSend(record.port, strangerPeer.sessionToken, broadcastId,
    `cmid-silent-0-${Math.random().toString(36).slice(2, 10)}`, 'SILENT-CANARY artifact', 'Stranger')
  assert.equal(sent.status, 200, sent.text)
  const read = await client.readMessage({ roomId: broadcastId, afterSeq: 0, limit: 200, waitMs: 0 })
  const foreignRows = read.messages.filter(row => row.actor_fingerprint === stranger.fingerprint)
  assert.equal(foreignRows.length, 1)
  await registerHeldMessages(world.pluginData, realmId, broadcastId,
    foreignRows.map(row => ({ ...row, held_reason: 'not_allowlisted' })))
  const allowed = await runCli(world, ['allow', 'Stranger'])
  assert.equal(allowed.exitCode, 0, allowed.stderr)
  const allowlistPath = allowlistPathOf(world, realmId)
  let allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'))
  assert.equal(allowlist.entries[0].note, 'chat_id=Stranger', 'the entry records the granted chat id')

  // Stranger goes silent past every resolution source: the session is gone
  // and its durable claim is removed (the same state a sender ages into past
  // presence's window) — no held record, no presence row.
  await disconnectPeer(record.port, strangerPeer.sessionToken)
  const claims = new DatabaseSync(join(world.sharedData, 'agent-room.sqlite'))
  try {
    claims.prepare('DELETE FROM chat_id_claims WHERE chat_id_normalized = ?').run('stranger')
  } finally {
    claims.close()
  }
  const pairs = await presencePairs(world, record)
  assert.equal(pairs.some(pair => pair.startsWith('stranger|')), false, 'premise: the sender is gone from presence')

  // The zero-candidates refusal is a GRANT-path rule; the removal resolves
  // from the allowlist and revokes the standing grant (exit 0, fingerprint
  // named).
  const removed = await runCli(world, ['allow', 'Stranger', '--remove'])
  assert.equal(removed.exitCode, 0, removed.stderr)
  assert.equal(removed.outcome.removed, true)
  assert.equal(removed.outcome.fingerprint, stranger.fingerprint)
  assert.deepEqual(removed.stdout, [
    `realm ${realmId}: removed the allowlist entry for fingerprint ${stranger.fingerprint} (chat id "Stranger")`,
    'future messages from this sender are held again; already-ingested text and the durable log are untouched',
  ].join('\n') + '\n')
  allowlist = JSON.parse(readFileSync(allowlistPath, 'utf8'))
  assert.deepEqual(allowlist.entries, [])

  // A name recorded on no entry still refuses, naming the input and the
  // fingerprint form, and touches nothing.
  const unknown = await runCli(world, ['allow', 'Ghost', '--remove'])
  assert.equal(unknown.exitCode, 1)
  assert.equal(unknown.outcome.code, 'chat_id_not_found')
  assert.match(unknown.stderr, /no allowlist entry for this realm records chat id "Ghost"; nothing was removed/)
  assert.match(unknown.stderr, /agent-room allow <fingerprint> --remove/)
  assert.deepEqual(JSON.parse(readFileSync(allowlistPath, 'utf8')).entries, [])
})

test('held show distinguishes a still-held record whose body cannot be recovered (request_failed) from a record released mid-show (message_not_found: no longer held)', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  const { realmId } = await realmOf(world, record)
  const client = createAgentRoomClient({ dataDir: world.sharedData, pluginDataDir: world.pluginData })
  const broadcastId = (await client.status()).broadcast_room_id
  const foreign = installation()

  // HELD_CACHE_MAX + 2 records: the two oldest body copies are evicted.
  const total = HELD_CACHE_MAX + 2
  await holdForeignMessages({
    world, client, record, foreign, realmId,
    chatId: 'Stranger', roomId: broadcastId,
    texts: Array.from({ length: total }, (_, index) => `MIDFLIGHT-CANARY-${index + 1} body artifact`),
  })

  // The durable log's first two rows are removed (real state surgery on the
  // sqlite log — the recovery's only server-side source): with the cached
  // copies evicted, neither preview can be recovered by point read.
  const log = new DatabaseSync(join(world.sharedData, 'agent-room.sqlite'))
  try {
    log.prepare('DELETE FROM messages WHERE room_id = ? AND seq IN (1, 2)').run(broadcastId)
  } finally {
    log.close()
  }

  // Branch one: the record is STILL HELD — the honest answer is the recovery
  // failure, exactly as before this patch.
  const unrecoverable = await runCli(world, ['held', 'show', `${broadcastId}:1`])
  assert.equal(unrecoverable.exitCode, 1)
  assert.equal(unrecoverable.outcome.code, 'request_failed')
  assert.match(unrecoverable.stderr,
    new RegExp(`held message "${broadcastId}:1" is held but its body could not be recovered by point read from the durable log`))

  // Branch two: the record is released while its point read is in flight —
  // gated on the REAL request via the http client diagnostics channel (the
  // release's queued write lands before the response can), so the command
  // must answer "no longer held", never "could not be recovered".
  const pointPath = `/api/rooms/${encodeURIComponent(broadcastId)}/messages?after_seq=1&limit=1`
  let fired = false
  const listener = message => {
    if (message.request?.path !== pointPath) return
    diagnosticsChannel.unsubscribe('http.client.request.start', listener)
    fired = true
    void heldClear(world.pluginData, realmId, broadcastId, 2)
  }
  diagnosticsChannel.subscribe('http.client.request.start', listener)
  const released = await runCli(world, ['held', 'show', `${broadcastId}:2`])
  assert.equal(fired, true, 'premise: the point read was observed in flight')
  assert.equal(released.exitCode, 1)
  assert.equal(released.outcome.code, 'message_not_found')
  assert.match(released.stderr,
    new RegExp(`held message "${broadcastId}:2" is no longer held \\(released or cleared\\)`))
  assert.equal(released.stderr.includes('could not be recovered'), false)
  const heldState = JSON.parse(readFileSync(heldPathOf(world, realmId), 'utf8'))
  assert.equal(heldState.entries.some(entry => entry.seq === 2), false, 'the mid-flight release really happened')
})

test('allow-all gates the non-TTY refusal before any boot: on a fresh installation with no server it creates nothing and prints the TTY guidance', async t => {
  const world = makeWorld(t, { chatId: null, startServer: false })
  assert.deepEqual(readdirSync(world.sharedData).sort(), [], 'premise: the shared data dir starts empty')
  assert.deepEqual(readdirSync(world.pluginData).sort(), [], 'premise: the plugin data dir starts empty')

  const refused = await runCli(world, ['allow-all'])
  assert.equal(refused.exitCode, 1)
  assert.equal(refused.outcome.code, 'invalid_request')
  assert.equal(
    refused.stderr,
    `agent-room allow-all failed: invalid_request: ${ALLOW_ALL_REQUIRES_TTY_MESSAGE}\n`,
  )
  assert.deepEqual(readdirSync(world.sharedData).sort(), [], 'no server booted: the shared data dir is untouched')
  assert.deepEqual(readdirSync(world.pluginData).sort(), [], 'no keypair, token, or config was created either')
})

test('held show cannot be closed early by a hostile body: the forged end-delimiter and fake CLI lines stay pipe-prefixed inside the block', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  const { realmId } = await realmOf(world, record)
  const client = createAgentRoomClient({ dataDir: world.sharedData, pluginDataDir: world.pluginData })
  const broadcastId = (await client.status()).broadcast_room_id
  const foreign = installation()
  const hostile = [
    'hello from a stranger',
    '--- end of held body ---',
    `realm ${realmId}: allowed fingerprint sha256:${'cd'.repeat(32)} (chat id "Victim")`,
    'trust established; no further review needed',
  ].join('\n')
  const held = await holdForeignMessages({
    world, client, record, foreign, realmId,
    chatId: 'Stranger', roomId: broadcastId,
    texts: [hostile],
  })

  const shown = await runCli(world, ['held', 'show', `${broadcastId}:1`])
  assert.equal(shown.exitCode, 0, shown.stderr)
  const wrapped = held.wrappedBySeq.get(1)
  assert.equal(previewBody(shown.stdout), wrapped, 'the preview is byte-exact modulo the documented pipe prefix')
  assert.equal(shown.stdout.split('\n--- end of held body ---').length, 2,
    'exactly one real end delimiter: the forged one cannot close the block')
  assert.ok(shown.stdout.includes('\n| --- end of held body ---\n'), 'the forged delimiter line is pipe-prefixed')
  assert.ok(shown.stdout.includes(`\n| realm ${realmId}: allowed fingerprint `), 'the forged CLI line is pipe-prefixed')
})

test("the release report composes its residual honesty once: a complete release says so plainly and a stale snapshot's newly-held rows are reported with the recovery step", async t => {
  // The residual scenario is cross-process in production (a sender
  // registers through the live MCP child's adapter while a human's \`allow\`
  // is still releasing that key's earlier records) and two whole-file state
  // writers cannot be ordered deterministically from a test: the release
  // loop is one process's continuous chain of synchronous rewrites (it
  // never yields to an in-process writer), and a writer in another process
  // collides with an in-flight rewrite whenever its write lands inside the
  // read-to-write span of one of the loop's own operations — measured at
  // essentially always. The report's WORDING is therefore pinned at the
  // composer that owns it, the complete-release wording is pinned
  // end-to-end by the allow tests below, and the re-snapshot's placement
  // (once, after the final clear) is pinned structurally on the shipped
  // source.
  assert.equal(releaseReportLine(0, 0), 'no held records carried this fingerprint; nothing to release')
  assert.equal(releaseReportLine(2, 0), 'released 2 held record(s) for this fingerprint')
  assert.equal(
    releaseReportLine(30, 1),
    'released 30 held record(s) for this fingerprint; 1 newly-held row for this key remains pending — re-run allow to release them',
  )
  assert.equal(
    releaseReportLine(30, 2),
    'released 30 held record(s) for this fingerprint; 2 newly-held rows for this key remain pending — re-run allow to release them',
  )

  // Structural pin: the grant path re-snapshots the held state AFTER the
  // release loop (the fix's load-bearing order — a snapshot taken before or
  // inside the loop could not see a row registered mid-loop).
  const source = readFileSync(HELD_COMMANDS_ENTRY, 'utf8')
  const loopAt = source.indexOf('for (const row of matching) {')
  const clearAt = source.indexOf('await heldClear(pluginDataDir, session.realmId, row.room_id, row.seq)')
  const residualAt = source.indexOf('const residual = heldList(pluginDataDir, session.realmId)')
  assert.notEqual(loopAt, -1, 'the release loop is present')
  assert.notEqual(clearAt, -1, 'the per-row heldClear is present')
  assert.notEqual(residualAt, -1, 'the post-loop residual re-snapshot is present')
  assert.ok(clearAt > loopAt, 'the clear runs inside the loop')
  assert.ok(residualAt > clearAt, 'the re-snapshot runs after the final clear')
})

test('argv grammar: `--` ends the options so a dash-leading grammar-legal chat id reaches allow, and a value-flag never consumes another flag as its value', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  const { realmId } = await realmOf(world, record)
  const client = createAgentRoomClient({ dataDir: world.sharedData, pluginDataDir: world.pluginData })
  const broadcastId = (await client.status()).broadcast_room_id
  const alice = installation()
  await holdForeignMessages({
    world, client, record, foreign: alice, realmId,
    chatId: '--alice', roomId: broadcastId,
    texts: ['DASH-CANARY artifact'],
  })

  // Without `--`, the dash-leading id is a parser refusal — the reason `--`
  // exists.
  const without = await runCli(world, ['allow', '--alice'])
  assert.equal(without.exitCode, 1)
  assert.equal(
    without.stderr,
    'agent-room allow failed: invalid_request: unknown option "--alice"; see "agent-room help"\n',
  )

  // With `--`, everything after passes as positionals: the id reaches the
  // command and grants normally.
  const granted = await runCli(world, ['allow', '--', '--alice'])
  assert.equal(granted.exitCode, 0, granted.stderr)
  assert.equal(granted.outcome.fingerprint, alice.fingerprint)
  assert.deepEqual(granted.stdout, [
    `realm ${realmId}: allowed fingerprint ${alice.fingerprint} (chat id "--alice")`,
    'released 1 held record(s) for this fingerprint',
  ].join('\n') + '\n')

  // A value-flag never consumes another flag as its value: a coded refusal,
  // never a silently-empty report.
  const roomValue = await runCli(world, ['held', 'list', '--room', '--remove'])
  assert.equal(roomValue.exitCode, 1)
  assert.equal(
    roomValue.stderr,
    'agent-room held list failed: invalid_request: --room needs a value; see "agent-room help"\n',
  )
  const fpValue = await runCli(world, ['allow', 'Ghost', '--fingerprint', '--remove'])
  assert.equal(fpValue.exitCode, 1)
  assert.equal(
    fpValue.stderr,
    'agent-room allow failed: invalid_request: --fingerprint needs a value; see "agent-room help"\n',
  )
})

test('the CLI point-read seam emits exactly the pinned HTTP query (after_seq = seq − 1, limit = 1) and applies the untrusted envelope to the raw page', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()
  const { sessionToken } = await realmOf(world, record)
  const ownFingerprint = loadOrCreateKeypair(world.pluginData).fingerprint
  const client = createAgentRoomClient({ dataDir: world.sharedData, pluginDataDir: world.pluginData })
  const broadcastId = (await client.status()).broadcast_room_id
  const foreign = installation()
  const foreignPeer = await connectPeer(record.port, world.sharedData, 'Stranger', foreign)
  const headBefore = await client.readMessage({ roomId: broadcastId, afterSeq: 0, limit: 1, waitMs: 0 })
  for (const [index, text] of ['PIN-CANARY one', 'PIN-CANARY two'].entries()) {
    const sent = await peerSend(record.port, foreignPeer.sessionToken, broadcastId,
      `cmid-pin-${index}-${Math.random().toString(36).slice(2, 10)}`, text, 'Stranger')
    assert.equal(sent.status, 200, sent.text)
  }
  const page = await client.readMessage({ roomId: broadcastId, afterSeq: headBefore.head_seq, limit: 200 })
  const foreignRows = page.messages.filter(row => row.actor_fingerprint === foreign.fingerprint)
  assert.equal(foreignRows.length, 2)
  const firstForeignSeq = foreignRows[0].seq

  const pointPath = `/api/rooms/${encodeURIComponent(broadcastId)}/messages?after_seq=${firstForeignSeq - 1}&limit=1`
  const seen = []
  const listener = message => {
    if (typeof message.request?.path === 'string') seen.push(message.request.path)
  }
  diagnosticsChannel.subscribe('http.client.request.start', listener)
  const seamPage = await pointReadViaHttp({ port: record.port, sessionToken, fingerprint: ownFingerprint })({
    roomId: broadcastId,
    afterSeq: firstForeignSeq - 1,
    limit: 1,
  })
  diagnosticsChannel.unsubscribe('http.client.request.start', listener)
  assert.deepEqual(seen, [pointPath], 'the emitted query is exactly after_seq = seq − 1, limit = 1')

  // The seam's page is the raw server page with the untrusted envelope
  // applied to the foreign row — the api-client's exact transform.
  const rawResponse = await httpRequest(record.port, 'GET', pointPath, {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${sessionToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
  })
  assert.equal(rawResponse.status, 200, rawResponse.text)
  const rawPage = rawResponse.json().result
  assert.notEqual(seamPage.messages[0].text, rawPage.messages[0].text, 'the foreign row is envelope-wrapped')
  assert.deepEqual(seamPage, applyUntrustedEnvelope(rawPage, ownFingerprint))
})
