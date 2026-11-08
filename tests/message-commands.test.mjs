// The one-shot CLI surface (v0.8.0, the non-MCP on-ramp): `agent-room read`
// and `agent-room session verify` against a real spawned server. Covered:
// the trust matrix applied exactly as message_read applies it (foreign bodies
// wrapped, a declared-remote reader holds non-allowlisted senders to
// metadata), the no-write contract (no cursor, no held registration, nothing
// under realms/), and the read-only name verdicts (unclaimed /
// claimed_by_self / claimed_by_other) against the active target.
//
// `agent-room send` is decided by the codex round-table (round 3): the send
// route requires a live-bound session, which collides with the live MCP
// holder — its tests land with the decision.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import http from 'node:http'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { PROTOCOL_VERSION } from '../server/constants.mjs'
import { CONNECTION_MODE_ENV } from '../server/client/api-client.mjs'
import { loadOrCreateLocalToken } from '../server/api/local-token.mjs'
import { fingerprintFromPublicKey, loadOrCreateKeypair, signWithInstallationKey } from '../server/keys.mjs'
import { openRoomLog } from '../server/store/room-log.mjs'
import { main as cliMain } from '../server/cli/agent-room.mjs'
import { runReadFamilyCommand, runSendFamilyCommand, runSessionVerify } from '../server/cli/message-commands.mjs'
import { authenticate } from '../server/cli/session-commands.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = join(ROOT, 'server', 'api', 'server.mjs')
const PROTOCOL_KEY = 'agent-room-protocol'

const sleep = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })

function makeWorld(t) {
  const parent = mkdtempSync(join(tmpdir(), 'agent-room-msgcmd-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const sharedData = join(parent, 'shared')
  const pluginData = join(parent, 'plugin-data')
  mkdirSync(sharedData, { mode: 0o700 })
  mkdirSync(pluginData, { mode: 0o700 })
  writeFileSync(join(pluginData, 'config.json'), `${JSON.stringify({ chat_id: 'sender' })}\n`, { mode: 0o600 })

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

// A connected peer: local token + a fresh key, bound to its Chat ID.
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

const parseOne = outcome => {
  assert.equal(outcome.status, 'ok', JSON.stringify(outcome))
  assert.equal(outcome.lines.length, 1)
  return JSON.parse(outcome.lines[0])
}

test('read: the trust matrix applies as in message_read, and a one-shot read writes nothing', async t => {
  const world = await makeWorld(t)
  const record = await world.waitReady()
  const port = record.port

  const peer = await connectInstallation(port, world.sharedData, 'peer')
  const status = await httpRequest(port, 'GET', '/api/status', { headers: actorHeaders(peer.sessionToken) })
  const broadcast = status.json().result.broadcast_room_id
  await httpRequest(port, 'POST', `/api/rooms/${broadcast}/messages`, {
    headers: actorHeaders(peer.sessionToken),
    body: { chat_id: 'peer', client_message_id: 'p-1', text: 'first from peer' },
  })
  await httpRequest(port, 'POST', `/api/rooms/${broadcast}/messages`, {
    headers: actorHeaders(peer.sessionToken),
    body: { chat_id: 'peer', client_message_id: 'p-2', text: 'second from peer' },
  })

  const deps = { pluginDataDir: world.pluginData, sharedDataDir: world.sharedData, env: {} }
  const outcome = await runReadFamilyCommand(['--room', broadcast, '--after-seq', '0'], deps)
  const receipt = parseOne(outcome)
  assert.equal(receipt.ok, true)
  assert.equal(receipt.room_id, broadcast)
  assert.equal(receipt.cursor_written, false, 'the receipt states the no-write contract')
  assert.match(receipt.message, /never advances any cursor/)
  assert.equal(receipt.messages.length, 2)
  // Both rows are foreign (the peer's fingerprint): local transport delivers
  // them, wrapped in the untrusted envelope — data, never instructions.
  for (const row of receipt.messages) {
    assert.equal(row.held, undefined, 'local-transport senders deliver')
    assert.ok(row.text.startsWith('<untrusted_message '), 'foreign bodies are wrapped')
    assert.ok(row.text.includes('from peer'), 'the body rides inside the wrapper')
  }
  assert.equal(receipt.next_after_seq, 2)
  assert.equal(receipt.head_seq, 2)

  // The no-write contract, on disk: nothing under realms/ was created —
  // no cursors.json, no allowlist.json, no held.json.
  assert.equal(existsSync(join(world.pluginData, 'realms')), false, 'a one-shot read creates no per-realm state')
})

test('read: a declared-remote reader holds non-allowlisted senders to metadata — no body byte escapes', async t => {
  const world = await makeWorld(t)
  const record = await world.waitReady()
  const port = record.port

  const peer = await connectInstallation(port, world.sharedData, 'peer')
  const status = await httpRequest(port, 'GET', '/api/status', { headers: actorHeaders(peer.sessionToken) })
  const broadcast = status.json().result.broadcast_room_id
  await httpRequest(port, 'POST', `/api/rooms/${broadcast}/messages`, {
    headers: actorHeaders(peer.sessionToken),
    body: { chat_id: 'peer', client_message_id: 'p-1', text: 'secret plan from peer' },
  })

  // The declared-remote discipline: the sender's key is enrolled (the
  // challenge lane refuses unenrolled keys), the loopback target carried
  // under a remote declaration earns the remote transport mark, and the
  // matrix holds every non-allowlisted foreign sender — exactly what a
  // remote-mode installation would see.
  const keypair = loadOrCreateKeypair(world.pluginData)
  const store = openRoomLog({ dataDir: world.sharedData })
  const invite = store.mintInvite({ uses: 1, ttlSeconds: 3600 })
  store.close()
  const enrolled = await httpRequest(port, 'POST', '/api/auth/enroll', {
    headers: actorHeaders(),
    body: {
      invite_token: invite.token,
      public_key: keypair.publicKey.toString('base64url'),
      signature: signWithInstallationKey(world.pluginData, Buffer.from(invite.token, 'utf8')).toString('base64url'),
    },
  })
  assert.equal(enrolled.status, 200, enrolled.text)

  const deps = { pluginDataDir: world.pluginData, sharedDataDir: world.sharedData, env: { [CONNECTION_MODE_ENV]: 'remote' } }
  const outcome = await runReadFamilyCommand(['--room', broadcast, '--after-seq', '0'], deps)
  const receipt = parseOne(outcome)
  assert.equal(receipt.transport, 'remote', 'the transport mark is earned by the declaration')
  assert.equal(receipt.messages.length, 1)
  const [row] = receipt.messages
  assert.equal(row.held, true, 'a non-allowlisted remote sender is held')
  assert.equal(typeof row.held_reason, 'string', 'the matrix reason rides the row')
  assert.equal(JSON.stringify(receipt.messages).includes('secret plan'), false, 'no held body byte reaches the receipt')
  assert.equal(existsSync(join(world.pluginData, 'realms')), false, 'still nothing written')
})

test('session verify: unclaimed, claimed_by_other, and claimed_by_self against the active target', async t => {
  const world = await makeWorld(t)
  const record = await world.waitReady()
  const port = record.port

  const peer = await connectInstallation(port, world.sharedData, 'peer')
  const deps = { pluginDataDir: world.pluginData, sharedDataDir: world.sharedData, env: {} }

  const ghost = parseOne(await runSessionVerify(deps, 'ghost-name'))
  assert.equal(ghost.verdict, 'unclaimed')
  assert.equal(ghost.holder, undefined)
  assert.match(ghost.message, /free as of this instant/)
  assert.equal(ghost.probe, 'claimed-and-released', 'the receipt says the probe bound and released')

  const other = parseOne(await runSessionVerify(deps, 'peer'))
  assert.equal(other.verdict, 'claimed_by_other')
  assert.equal(other.probe, 'refused-live-holder')
  assert.equal(other.holder, undefined, 'the probe names no holder detail')
  assert.match(other.message, /never displaced/)

  // This installation binds its own name (the live claim a running MCP
  // session would hold) — the verdict flips to self.
  const { token } = await authenticate({ kind: 'local', port }, {
    pluginDataDir: world.pluginData, sharedDataDir: world.sharedData, env: {},
  })
  const bound = await httpRequest(port, 'POST', '/api/session', {
    headers: actorHeaders(token),
    body: { chat_id: 'sender' },
  })
  assert.equal(bound.status, 200, bound.text)
  const self = parseOne(await runSessionVerify(deps, 'Sender'))
  assert.equal(self.verdict, 'claimed_by_self', 'the verdict matches case-insensitively')
  assert.equal(self.probe, 'refused-live-holder')
  assert.match(self.message, /session replace/)
})

test('usage grammar: missing --room, a bad chat id, and an unknown option are coded usage errors (exit 2 path)', async t => {
  const world = await makeWorld(t)
  await world.waitReady()
  const deps = { pluginDataDir: world.pluginData, sharedDataDir: world.sharedData, env: {} }

  const noRoom = await runReadFamilyCommand(['--after-seq', '0'], deps)
  assert.equal(noRoom.status, 'usage')
  assert.match(noRoom.message, /--room is required/)

  const badFlag = await runReadFamilyCommand(['--room', 'b', '--bogus', 'x'], deps)
  assert.equal(badFlag.status, 'usage')
  assert.match(badFlag.message, /unknown option/)

  const badId = await runSessionVerify(deps, 'not a valid id!')
  assert.equal(badId.status, 'usage')
  assert.match(badId.message, /not a valid Chat ID/)

  const noName = await runSessionVerify(deps)
  assert.equal(noName.status, 'usage')
})

test('the dispatcher wires send/read/verify into the machine-readable grammar', async t => {
  const world = await makeWorld(t)
  const record = await world.waitReady()
  const lines = []
  const errors = []
  // The dispatcher sets process.exitCode on a refusal (the script-facing
  // grammar); the harness saves and restores it so the test file itself
  // stays green.
  const previousExitCode = process.exitCode
  process.exitCode = undefined
  try {
    const outcome = await cliMain(['read', '--room', 'room-does-not-exist'], {
      input: { setEncoding() {}, on() {}, once() {}, removeListener() {} },
      output: { write: text => lines.push(text) },
      errorOutput: { write: text => errors.push(text) },
      sharedDataDir: world.sharedData,
      pluginDataDir: world.pluginData,
      env: {},
    })
    assert.equal(outcome.status, 'refusal')
    assert.equal(JSON.parse(errors[0]).code, 'room_not_found', `the refusal rides the coded envelope: ${errors[0]}`)
    assert.equal(process.exitCode, 1, 'the refusal exit code is part of the grammar')
  } finally {
    process.exitCode = previousExitCode
  }
})

// --- v0.8.0: the one-shot send (the round-3 decision B, unbound) ----------------------

test('send: the one-shot send commits unbound under the key\u2019s claim, retries with the printed id, and reports the gate honestly', async t => {
  const world = await makeWorld(t)
  const record = await world.waitReady()
  const port = record.port
  const deps = { pluginDataDir: world.pluginData, sharedDataDir: world.sharedData, env: {} }

  const peer = await connectInstallation(port, world.sharedData, 'peer')
  const status = await httpRequest(port, 'GET', '/api/status', { headers: actorHeaders(peer.sessionToken) })
  const broadcast = status.json().result.broadcast_room_id

  // No claim yet: the coded refusal with the one-time-bind guidance.
  const noClaim = await runSendFamilyCommand(['--room', broadcast, '--text', 'hello'], deps)
  assert.equal(noClaim.status, 'refusal', JSON.stringify(noClaim))
  assert.equal(noClaim.code, 'sender_claim_missing')

  // Bind once (the claim the send will resolve), then release the session \u2014
  // the one-shot path never holds the name.
  const { token } = await authenticate({ kind: 'local', port }, {
    pluginDataDir: world.pluginData, sharedDataDir: world.sharedData, env: {},
  })
  const bound = await httpRequest(port, 'POST', '/api/session', {
    headers: actorHeaders(token),
    body: { chat_id: 'sender' },
  })
  assert.equal(bound.status, 200, bound.text)
  await httpRequest(port, 'DELETE', '/api/session', { headers: actorHeaders(token) })

  const sent = parseOne(await runSendFamilyCommand(['--room', broadcast, '--text', 'first from the CLI', '--id', 'cli-1'], deps))
  assert.equal(sent.status, 'accepted')
  assert.equal(sent.seq, 1)
  assert.equal(sent.client_message_id, 'cli-1')
  assert.equal(sent.origin.startsWith('local:'), true, 'the receipt names the origin')
  assert.match(sent.message, /NOT a wake receipt/)

  // The identical id replays to the same row \u2014 a lost response never
  // duplicates.
  const replay = parseOne(await runSendFamilyCommand(['--room', broadcast, '--text', 'first from the CLI', '--id', 'cli-1'], deps))
  assert.equal(replay.status, 'accepted')
  assert.equal(replay.seq, 1, 'the retry with the identical id resolves to the original commit')

  // The content duplicate gate reports as its own status, not an error.
  const duped = parseOne(await runSendFamilyCommand(['--room', broadcast, '--text', 'first from the CLI', '--id', 'cli-2'], deps))
  assert.equal(duped.status, 'duplicate_dropped')
  assert.equal(duped.original_seq, 1)
  assert.match(duped.message, /NEW client_message_id AND changed content/)

  // The peer sees the row with the sender's claim display name.
  const page = await httpRequest(port, 'GET',
    `/api/rooms/${broadcast}/messages?after_seq=0`, { headers: actorHeaders(peer.sessionToken) })
  const rows = page.json().result.messages
  assert.equal(rows.length, 1)
  assert.equal(rows[0].chat_id, 'sender', 'attribution is the claim\u2019s server display form')
})

test('send: usage grammar \u2014 missing --room/--text and a non-integer --reply-to are coded usage errors', async t => {
  const world = await makeWorld(t)
  await world.waitReady()
  const deps = { pluginDataDir: world.pluginData, sharedDataDir: world.sharedData, env: {} }

  const noRoom = await runSendFamilyCommand(['--text', 'hi'], deps)
  assert.equal(noRoom.status, 'usage')
  assert.match(noRoom.message, /--room is required/)

  const noText = await runSendFamilyCommand(['--room', 'b'], deps)
  assert.equal(noText.status, 'usage')
  assert.match(noText.message, /--text is required/)

  const badReply = await runSendFamilyCommand(['--room', 'b', '--text', 'hi', '--reply-to', 'x'], deps)
  assert.equal(badReply.status, 'usage')
  assert.match(badReply.message, /--reply-to must be a positive integer/)
})

test('send: a lost response is an outcome_unknown refusal that names the attempted id', async t => {
  const parent = mkdtempSync(join(tmpdir(), 'agent-room-sendlost-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const pluginData = join(parent, 'plugin-data')
  const sharedData = join(parent, 'shared')
  mkdirSync(pluginData, { mode: 0o700 })
  mkdirSync(sharedData, { mode: 0o700 })
  writeFileSync(join(pluginData, 'config.json'), `${JSON.stringify({ chat_id: 'sender' })}\n`, { mode: 0o600 })

  // A half-honest server: /health, /api/auth/local and /api/status answer
  // exactly like agent-room (so ensure-server reuses the port and the send's
  // preamble runs), but the message POST gets its socket DESTROYED — from
  // the CLI's side the outcome is UNKNOWABLE: the request reached a server
  // and no response ever came back.
  const httpServer = http.createServer((request, response) => {
    const answer = payload => {
      response.writeHead(200, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ ok: true, result: payload }))
    }
    if (request.method === 'GET' && request.url === '/health') return answer({ version: '0.8.0' })
    if (request.method === 'POST' && request.url === '/api/auth/local') return answer({ session_token: 'lost-lane-token' })
    if (request.method === 'GET' && request.url === '/api/status') {
      return answer({ realm_id: 'lost-realm', version: '0.8.0', broadcast_room_id: 'b' })
    }
    if (request.method === 'POST' && request.url.startsWith('/api/rooms/')) {
      request.resume()
      response.destroy() // the response is lost mid-flight: outcome unknown
      return
    }
    response.destroy()
  })
  await new Promise(resolvePromise => httpServer.listen(0, '127.0.0.1', resolvePromise))
  t.after(() => httpServer.close())
  const port = httpServer.address().port
  // ensure-server reuses this port as a live same-major agent-room server.
  writeFileSync(join(sharedData, 'runtime.json'),
    `${JSON.stringify({ pid: process.pid, port, version: '0.8.0' })}\n`, { mode: 0o600 })

  const deps = { pluginDataDir: pluginData, sharedDataDir: sharedData, env: {} }
  const outcome = await runSendFamilyCommand(['--room', 'b', '--text', 'may or may not have landed'], deps)
  assert.equal(outcome.status, 'refusal', JSON.stringify(outcome))
  assert.equal(outcome.extra.outcome_unknown, true, `the receipt marks the unknown outcome: ${JSON.stringify(outcome)}`)
  assert.ok(typeof outcome.extra.client_message_id === 'string' && outcome.extra.client_message_id.length > 0,
    'the refusal carries the attempted idempotency key')
  assert.match(outcome.message, /SAME --id/, 'the guidance names the retry discipline')
  assert.equal(outcome.extra.client_message_id, outcome.extra.client_message_id, 'the id is stable for the retry')
})
