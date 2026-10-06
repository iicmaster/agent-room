// The remote exposure check driver (Story 5.3): a real child process spawned
// by tests/viewer-exposure.test.mjs that walks the exposure drill against a
// viewer surface living on a NON-LOOPBACK interface.
//
// TOPOLOGY (the Story 4.7 harness's native-TLS face, reused): one real
// direct-launch server child (server/api/server.mjs) started through the
// strict topology env — AGENT_ROOM_HOST names the machine's non-loopback
// IPv4 interface address (the tests/ensure-server.test.mjs discovery
// pattern) and AGENT_ROOM_TLS_CERT/KEY point at the same throwaway
// certificates the Story 4.7/4.8 suites generated (EC P-256, SANs
// IP:127.0.0.1 + DNS:localhost). Every dial in this driver is an https
// request to that non-loopback address with Node's DEFAULT verification —
// chain via NODE_EXTRA_CA_CERTS (the 4.7 harness's documented mechanism for
// adding a private root WITHOUT touching strictness) and hostname check
// against the material's SAN name carried by the `servername` dial option.
// No override exists anywhere: zero rejectUnauthorized, zero env kills, zero
// checkServerIdentity replacements. HONEST SCOPE (the 4.7 precedent
// restated): the automated proof is one host through real TLS whose only
// open door is the non-loopback interface (the loopback door on the same
// port is probed and must refuse); the literal cross-machine wire is Epic
// 6's REL-1. On a host with no non-loopback IPv4 address the parent skips
// the drill entirely (the ensure-server precedent) and never spawns this
// driver.
//
// THE DRILL, against that exposed surface:
//   1. An unauthenticated request "from another host" — dialed via the
//      non-loopback address with no credential, a junk credential, or a
//      well-formed wrong credential — is refused across the WHOLE viewer
//      surface (the static shell, a whitelisted asset, the boot descriptor,
//      the auth bridge, the broadcast page by its real room id, the SSE
//      stream) with the canonical coded 401, no Set-Cookie, and ZERO body
//      previews: no message text, no room or realm names, no presence, no
//      HTML, no asset names.
//   2. The viewer surface is GET-only: every viewer route answers every
//      non-GET method (POST/PUT/PATCH/DELETE) the frozen table's 404
//      route_not_found — never executed — including the CORRECT viewer
//      token on the wrong method (the credential cannot buy the verb).
//   3. The viewer token never authorizes any API write: presented as Bearer
//      on every write-capable API route (the local exchange, the session
//      bind/rename/release, the direct open, the message send, the
//      enrollment route both as a malformed and as a well-formed unknown
//      invite) every one refuses; the viewer cookie is equally nothing on
//      the API class; the operator writes (trust set, invite mint, ban) are
//      CLI-host commands with NO HTTP route at all (AR-13), and the probed
//      phantom paths answer 404 with the token presented; and the one
//      route that answers 200 to any well-formed key — the privilegeless
//      challenge — carries no session in its result and its nonce answers
//      `not_enrolled` to a fresh key's valid signature: the viewer
//      credential minted zero authority. A before/after count plus the
//      presence snapshot prove nothing was written anywhere.
//   4. The holder's path still works (the positive control): the correct
//      viewer token mints the cookie over the same non-loopback interface,
//      the cookie reads the boot descriptor, the static shell, the
//      Broadcast Room page carrying the holders-only message, and the live
//      SSE stream delivering it.
//   5. The server child's stderr over the whole drill is EMPTY — no noise,
//      and therefore neither the viewer token nor any cookie value.
//
// The driver prints one line `REPORT:{...json}` on success; anything else
// is a failure the parent surfaces with the driver's stderr. The viewer
// token and cookie value NEVER appear in the report.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import https from 'node:https'
import { once } from 'node:events'
import os from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { INVITE_TOKEN_PREFIX, INVITE_TOKEN_CHARS, VIEWER_TOKEN_MAX_CHARS } from '../server/constants.mjs'
import { loadOrCreateViewerToken } from '../server/runtime.mjs'
import { loadOrCreateLocalToken } from '../server/api/local-token.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = join(ROOT, 'server', 'api', 'server.mjs')

const root = process.env.AGENT_ROOM_EXPOSURE_ROOT
const certPath = process.env.AGENT_ROOM_EXPOSURE_CERT
const keyPath = process.env.AGENT_ROOM_EXPOSURE_KEY

if (!root || !certPath || !keyPath) {
  console.error('driver misconfigured: AGENT_ROOM_EXPOSURE_ROOT/CERT/KEY are required')
  process.exit(3)
}

function fail(message) {
  console.error(`driver failed: ${message}`)
  process.exit(1)
}

// --- Harness budgets and drill shape (local constants, never product limits) ---

// The machine's non-loopback interface address is the drill's exposed door;
// the reused material's SAN name is the name the default-verified TLS dial
// proves (chain + hostname checks fully on — see the header).
const ACTOR_CHAT_ID = 'ExposureActor'
const HOLDERS_MESSAGE_ID = 'exposure-holders-only'
const HOLDERS_TEXT = 'exposure drill: the holders-only line (story 5.3)'
const STARTUP_DEADLINE_MS = 25_000
const RAW_REQUEST_TIMEOUT_MS = 15_000
const READY_POLL_INTERVAL_MS = 25
const STREAM_SETTLE_BOUND_MS = 5_000
const RUNTIME_RECORD_FILENAME = 'runtime.json'

// Wire vocabulary as literals of this file (the oracle discipline: expected
// values are built here, never imported).
const PROTOCOL_KEY = 'agent-room-protocol'
const PROTOCOL_VERSION = '1'
const HOST_NAME_FOR_TLS = 'localhost'

// One marker list, checked against EVERY refusal body: a refusal that
// carries any of these is a free preview, and the AC refuses free previews.
const PREVIEW_MARKERS = Object.freeze([
  HOLDERS_TEXT,
  ACTOR_CHAT_ID,
  'realm_id',
  'broadcast_room_id',
  'presence',
  '<script',
  '<!doctype',
  'app.js',
  'head_seq',
  '"messages"',
])

const jsonHeaders = { [PROTOCOL_KEY]: PROTOCOL_VERSION, 'content-type': 'application/json; charset=utf-8' }
const getJsonHeaders = { [PROTOCOL_KEY]: PROTOCOL_VERSION }
const codeOf = response => response.json?.error?.code ?? null
const resultOf = response => response.json?.result ?? null

const sleep = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })

// The established non-loopback discovery (tests/ensure-server.test.mjs): the
// first non-internal IPv4 address, or null when this host has none.
function lanAddress() {
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const info of entries ?? []) {
      if (!info.internal && info.family === 'IPv4') return info.address
    }
  }
  return null
}

// --- The wire: default-verified https dials to the non-loopback address ----

function request(host, port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = https.request(
      { host, port, path, method, agent: false, servername: HOST_NAME_FOR_TLS, headers },
      response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('error', rejectPromise)
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let json = null
          try { json = JSON.parse(text) } catch { /* streamed or HTML bodies stay unparsed */ }
          resolvePromise({ status: response.statusCode, headers: response.headers, text, json })
        })
      },
    )
    req.setTimeout(RAW_REQUEST_TIMEOUT_MS, () => req.destroy(new Error(`${method} ${path} timed out`)))
    req.on('error', rejectPromise)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

// The SSE face of the same dial: parses frames as they arrive (the
// tests/viewer.test.mjs parser, carried over the TLS leg).
function openStream(host, port, path, headers) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = https.request({ host, port, path, method: 'GET', headers, agent: false, servername: HOST_NAME_FOR_TLS })
    const stream = { req, status: null, responseHeaders: null, events: [], raw: '', retry: null, closed: false }
    req.on('response', response => {
      stream.status = response.statusCode
      stream.responseHeaders = response.headers
      response.setEncoding('utf8')
      response.on('data', chunk => {
        stream.raw += chunk
        let boundary = stream.raw.indexOf('\n\n')
        while (boundary !== -1) {
          const frame = stream.raw.slice(0, boundary)
          stream.raw = stream.raw.slice(boundary + 2)
          const event = { id: null, event: 'message', data: null, retry: null }
          for (const line of frame.split('\n')) {
            const separator = line.indexOf(':')
            if (separator === -1) continue
            const field = line.slice(0, separator)
            const value = line.slice(separator + 1).replace(/^ /, '')
            if (field === 'id') event.id = value
            else if (field === 'event') event.event = value
            else if (field === 'data') event.data = value
            else if (field === 'retry') event.retry = value
          }
          if (event.data !== null) stream.events.push(event)
          if (event.retry !== null) stream.retry = event.retry
          boundary = stream.raw.indexOf('\n\n')
        }
      })
      resolvePromise(stream)
    })
    req.setTimeout(RAW_REQUEST_TIMEOUT_MS, () => req.destroy(new Error('the stream open timed out')))
    req.on('error', error => {
      if (stream.status === null) rejectPromise(error)
      else stream.closed = true
    })
    req.end()
  })
}

function waitForEvent(stream, name, message) {
  const deadline = Date.now() + STREAM_SETTLE_BOUND_MS
  return new Promise((resolvePromise, rejectPromise) => {
    const poll = () => {
      const found = stream.events.find(event => event.event === name)
      if (found) {
        resolvePromise(found)
        return
      }
      if (Date.now() >= deadline) {
        rejectPromise(new Error(`${message}: no ${name} event within ${STREAM_SETTLE_BOUND_MS} ms (got ${stream.events.map(event => event.event).join(', ') || 'nothing'})`))
        return
      }
      setTimeout(poll, 20)
    }
    poll()
  })
}

async function waitForMessageText(stream, text, message) {
  const deadline = Date.now() + STREAM_SETTLE_BOUND_MS
  for (;;) {
    const found = stream.events.find(event => {
      if (event.event !== 'message') return false
      try { return JSON.parse(event.data).text === text } catch { return false }
    })
    if (found) return found
    if (Date.now() >= deadline) {
      throw new Error(`${message}: the line never rode the stream (${stream.events.length} events seen)`)
    }
    await sleep(25)
  }
}

// The loopback door on the SAME port the exposed interface serves: if it
// answers, the drill's traffic is not riding the interface it claims.
function dialLoopbackDoor(port) {
  return new Promise(resolvePromise => {
    const probe = https.request({ host: '127.0.0.1', port, path: '/health', method: 'GET', agent: false }, () => resolvePromise('ANSWERED'))
    probe.setTimeout(3_000, () => { probe.destroy(); resolvePromise('TIMEOUT') })
    probe.on('error', error => resolvePromise(error?.code ?? 'ERROR'))
    probe.end()
  })
}

// --- The real server child (the direct launch on the non-loopback interface) -

function spawnServerChild(dataDir, host) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      PATH: process.env.PATH ?? '',
      LANG: process.env.LANG ?? 'C.UTF-8',
      AGENT_ROOM_DATA_DIR: dataDir,
      AGENT_ROOM_HOST: host,
      AGENT_ROOM_TLS_CERT: certPath,
      AGENT_ROOM_TLS_KEY: keyPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stderrChunks = []
  child.stderr.on('data', chunk => stderrChunks.push(chunk))
  child.stdout.resume()
  return {
    child,
    stderrText: () => Buffer.concat(stderrChunks).toString('utf8'),
    stop: async () => {
      try { child.kill('SIGTERM') } catch { /* the bounded wait below is authoritative */ }
      const raced = await Promise.race([
        once(child, 'exit'),
        sleep(2_000).then(() => 'timeout'),
      ])
      if (raced === 'timeout' && child.exitCode === null && child.signalCode === null) {
        try { child.kill('SIGKILL') } catch { /* reported by the exit await */ }
        await once(child, 'exit').catch(() => {})
      }
      return child.exitCode
    },
  }
}

// Readiness is declared ONLY by a runtime record naming THIS child's pid
// with a valid port, probed through the exposed interface (the
// restart-survival discipline over the drill's own door).
async function waitReady(serverState, dataDir, host) {
  const runtimePath = join(dataDir, RUNTIME_RECORD_FILENAME)
  const deadline = Date.now() + STARTUP_DEADLINE_MS
  for (;;) {
    if (serverState.child.exitCode !== null || serverState.child.signalCode !== null) {
      throw new Error(`the server child exited early (code=${serverState.child.exitCode}); stderr=${serverState.stderrText()}`)
    }
    if (existsSync(runtimePath)) {
      try {
        const record = JSON.parse(readFileSync(runtimePath, 'utf8'))
        if (record.pid === serverState.child.pid && Number.isInteger(record.port) && record.port > 0) {
          const health = await request(host, record.port, 'GET', '/health').catch(() => null)
          if (health?.status === 200 && health.json?.ok === true) return record
        }
      } catch { /* atomic rename: readers retry */ }
    }
    if (Date.now() > deadline) {
      throw new Error(`the server child never became ready within ${STARTUP_DEADLINE_MS} ms; stderr=${serverState.stderrText()}`)
    }
    await sleep(READY_POLL_INTERVAL_MS)
  }
}

// The in-room participant: the operator side provisions the local token (the
// file the pre-auth exchange reads per request), the keypair is born here,
// and the whole journey rides the exposed interface like every other dial.
async function connectActor(host, port, dataDir) {
  const { publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const raw = spki.subarray(spki.length - 32)
  const publicKeyBase64url = raw.toString('base64url')
  const auth = await request(host, port, 'POST', '/api/auth/local', {
    headers: { [PROTOCOL_KEY]: PROTOCOL_VERSION, authorization: `Bearer ${loadOrCreateLocalToken(dataDir)}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ public_key: publicKeyBase64url }),
  })
  assert.equal(auth.status, 200, `the actor's local exchange: ${auth.status} ${auth.text}`)
  const sessionToken = resultOf(auth).session_token
  const bound = await request(host, port, 'POST', '/api/session', {
    headers: { ...jsonHeaders, authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ chat_id: ACTOR_CHAT_ID, client_type: 'mcp' }),
  })
  assert.equal(bound.status, 200, `the actor's bind: ${bound.status} ${bound.text}`)
  const status = await request(host, port, 'GET', '/api/status', {
    headers: { ...getJsonHeaders, authorization: `Bearer ${sessionToken}` },
  })
  assert.equal(status.status, 200, `the actor's status read: ${status.status} ${status.text}`)
  const broadcastRoomId = resultOf(status).broadcast_room_id
  const send = await request(host, port, 'POST', `/api/rooms/${broadcastRoomId}/messages`, {
    headers: { ...jsonHeaders, authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ chat_id: ACTOR_CHAT_ID, client_message_id: HOLDERS_MESSAGE_ID, text: HOLDERS_TEXT }),
  })
  assert.equal(send.status, 200, `the actor's send: ${send.status} ${send.text}`)
  assert.equal(resultOf(send).status, 'committed', `the holders-only line committed: ${send.text}`)
  return {
    publicKeyBase64url,
    broadcastRoomId,
    async pageRead() {
      const page = await request(host, port, 'GET', `/api/rooms/${broadcastRoomId}/messages?after_seq=0`, {
        headers: { ...getJsonHeaders, authorization: `Bearer ${sessionToken}` },
      })
      assert.equal(page.status, 200, `the actor's page read: ${page.status} ${page.text}`)
      return resultOf(page)
    },
    async presence() {
      const presence = await request(host, port, 'GET', '/api/presence', {
        headers: { ...getJsonHeaders, authorization: `Bearer ${sessionToken}` },
      })
      assert.equal(presence.status, 200, `the actor's presence read: ${presence.status} ${presence.text}`)
      return resultOf(presence)
    },
  }
}

// --- The drill -----------------------------------------------------------------

async function run() {
  const host = lanAddress()
  if (host === null) {
    fail('no non-loopback IPv4 address on this host (the parent skips the drill there and never spawns this driver)')
  }
  const dataDir = join(root, 'data')
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  // The operator provisions the viewer token on the host before anything
  // listens — the HTTP surface never creates the file.
  const viewerToken = loadOrCreateViewerToken(dataDir)
  const cookieValue = { value: null }

  const serverState = spawnServerChild(dataDir, host)
  try {
    const record = await waitReady(serverState, dataDir, host)
    const port = record.port

    // --- 1. The topology: the ONLY open door is the non-loopback interface ---
    const loopbackDoor = await dialLoopbackDoor(port)
    assert.equal(loopbackDoor, 'ECONNREFUSED', `the loopback door on the same port must refuse, got ${loopbackDoor}`)

    // The in-room participant and the one holders-only message.
    const actor = await connectActor(host, port, dataDir)
    const pageBefore = await actor.pageRead()
    assert.equal(pageBefore.messages.length, 1, 'the drill starts from exactly one committed message')

    // --- 2. The unauthenticated matrix: zero free previews --------------------
    const unauthenticatedRows = []
    async function unauthenticatedRefusal(label, path, headers = {}) {
      const response = await request(host, port, 'GET', path, { headers })
      assert.equal(response.status, 401, `${label}: expected the 401 family, got ${response.status}: ${response.text}`)
      assert.equal(codeOf(response), 'unauthorized', `${label}: expected the canonical code, got ${response.text}`)
      assert.equal(response.headers['set-cookie'], undefined, `${label}: a refusal must mint no credential`)
      for (const marker of PREVIEW_MARKERS) {
        assert.equal(response.text.includes(marker), false, `${label}: the refusal body previews "${marker}"`)
      }
      unauthenticatedRows.push({ label, status: response.status, code: codeOf(response) })
    }
    const wrongWellFormedToken = 'A'.repeat(VIEWER_TOKEN_MAX_CHARS)
    const garbageCookie = { cookie: 'agent_room_viewer=not-a-real-cookie-value-at-all-00000000000' }
    await unauthenticatedRefusal('the static shell', '/viewer/')
    await unauthenticatedRefusal('a whitelisted asset', '/viewer/app.js')
    await unauthenticatedRefusal('the second asset', '/viewer/styles.css')
    await unauthenticatedRefusal('the boot descriptor', '/viewer/boot.json')
    await unauthenticatedRefusal('the auth bridge without a credential', '/viewer/auth')
    await unauthenticatedRefusal('the auth bridge with a junk credential', '/viewer/auth', { authorization: 'Bearer not-a-real-credential-shape' })
    await unauthenticatedRefusal('the auth bridge with a well-formed wrong token', '/viewer/auth', { authorization: `Bearer ${wrongWellFormedToken}` })
    await unauthenticatedRefusal('the broadcast page by its real room id', `/viewer/api/rooms/${actor.broadcastRoomId}/messages`)
    await unauthenticatedRefusal('the broadcast page with a garbage cookie', `/viewer/api/rooms/${actor.broadcastRoomId}/messages`, garbageCookie)
    await unauthenticatedRefusal('the broadcast page with a Bearer on the wrong class', `/viewer/api/rooms/${actor.broadcastRoomId}/messages`, { authorization: `Bearer ${viewerToken}` })
    await unauthenticatedRefusal('the SSE stream', `/viewer/api/rooms/${actor.broadcastRoomId}/events`)
    await unauthenticatedRefusal('the SSE stream with a garbage cookie', `/viewer/api/rooms/${actor.broadcastRoomId}/events`, garbageCookie)

    // --- 3. GET-only: no credential can buy a verb -----------------------------
    const getOnlyRows = []
    const viewerPaths = Object.freeze([
      '/viewer/auth',
      '/viewer/',
      '/viewer/boot.json',
      `/viewer/api/rooms/${actor.broadcastRoomId}/messages`,
      `/viewer/api/rooms/${actor.broadcastRoomId}/events`,
    ])
    for (const path of viewerPaths) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const response = await request(host, port, method, path, {
          headers: { 'content-type': 'application/json; charset=utf-8' },
          body: method === 'GET' ? undefined : JSON.stringify({}),
        })
        assert.equal(response.status, 404, `${method} ${path}: expected the frozen table's 404, got ${response.status}: ${response.text}`)
        assert.equal(codeOf(response), 'route_not_found', `${method} ${path}: ${response.text}`)
        getOnlyRows.push({ label: `${method} ${path}`, status: response.status, code: codeOf(response) })
      }
    }
    // The CORRECT token on the wrong method: the credential cannot buy the
    // verb — 404, and no cookie rides the refusal.
    const credentialedPost = await request(host, port, 'POST', '/viewer/auth', {
      headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${viewerToken}` },
      body: JSON.stringify({}),
    })
    assert.equal(credentialedPost.status, 404, `POST /viewer/auth with the correct token: ${credentialedPost.status} ${credentialedPost.text}`)
    assert.equal(codeOf(credentialedPost), 'route_not_found', credentialedPost.text)
    assert.equal(credentialedPost.headers['set-cookie'], undefined, 'the refused verb minted no credential')

    // --- 4. The viewer token never authorizes any API write --------------------
    const mint = await request(host, port, 'GET', '/viewer/auth', { headers: { authorization: `Bearer ${viewerToken}` } })
    assert.equal(mint.status, 200, `the bridge mint over the exposed interface: ${mint.status} ${mint.text}`)
    const setCookie = mint.headers['set-cookie']?.[0] ?? ''
    assert.match(setCookie, /^agent_room_viewer=[A-Za-z0-9_-]{43}; Path=\/viewer; HttpOnly; SameSite=Strict$/, `the minted cookie's flags: ${setCookie}`)
    cookieValue.value = /^agent_room_viewer=([A-Za-z0-9_-]+);/.exec(`${setCookie};`)[1]
    const cookie = { cookie: `agent_room_viewer=${cookieValue.value}` }

    // 4a. The token as Bearer on every write-capable API route.
    const bearerRows = []
    async function bearerRefusal(label, method, path, body) {
      const response = await request(host, port, method, path, {
        headers: { ...jsonHeaders, authorization: `Bearer ${viewerToken}` },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      assert.ok(response.status === 401 || response.status === 403, `${label}: expected the 401/403 family, got ${response.status}: ${response.text}`)
      assert.equal(codeOf(response), 'unauthorized', `${label}: ${response.text}`)
      bearerRows.push({ label, status: response.status, code: codeOf(response) })
    }
    await bearerRefusal('local exchange', 'POST', '/api/auth/local', { public_key: actor.publicKeyBase64url })
    await bearerRefusal('session bind', 'POST', '/api/session', { chat_id: 'ViewerWasHere' })
    await bearerRefusal('session rename', 'PATCH', '/api/session', { chat_id: 'ViewerWasHere' })
    await bearerRefusal('session release', 'DELETE', '/api/session')
    await bearerRefusal('direct open', 'POST', '/api/rooms/direct', { chat_id: 'SomeoneElse' })
    await bearerRefusal('message send', 'POST', `/api/rooms/${actor.broadcastRoomId}/messages`, { chat_id: ACTOR_CHAT_ID, client_message_id: 'viewer-write-1', text: 'a line the viewer token must never write' })

    // 4b. The enrollment route: the token is not an invite, in either spelling.
    const enrollShape = await request(host, port, 'POST', '/api/auth/enroll', {
      headers: { ...jsonHeaders, authorization: `Bearer ${viewerToken}` },
      body: JSON.stringify({ invite_token: viewerToken, public_key: actor.publicKeyBase64url, signature: 'AA' }),
    })
    assert.equal(enrollShape.status, 400, `the token as invite_token: ${enrollShape.status} ${enrollShape.text}`)
    assert.equal(codeOf(enrollShape), 'invalid_request', enrollShape.text)
    const wellFormedUnknownInvite = `${INVITE_TOKEN_PREFIX}${'z'.repeat(3)}${'Y'.repeat(INVITE_TOKEN_CHARS - 3)}`
    const enrollUnknown = await request(host, port, 'POST', '/api/auth/enroll', {
      headers: { ...jsonHeaders, authorization: `Bearer ${viewerToken}` },
      body: JSON.stringify({ invite_token: wellFormedUnknownInvite, public_key: actor.publicKeyBase64url, signature: 'A'.repeat(86) }),
    })
    assert.equal(enrollUnknown.status, 403, `a well-formed unknown invite beside the token: ${enrollUnknown.status} ${enrollUnknown.text}`)
    assert.equal(codeOf(enrollUnknown), 'invite_invalid', enrollUnknown.text)

    // 4c. The operator writes have NO HTTP surface at all (AR-13): the CLI
    // host's trust set, invite mint, and ban answer nothing on the wire — the
    // probed phantom paths 404 with the token presented.
    const phantomRows = []
    for (const path of ['/api/trust', '/api/invites', '/api/ban', '/api/rooms']) {
      const response = await request(host, port, 'POST', path, {
        headers: { ...jsonHeaders, authorization: `Bearer ${viewerToken}` },
        body: JSON.stringify({}),
      })
      assert.equal(response.status, 404, `POST ${path}: expected route_not_found, got ${response.status}: ${response.text}`)
      assert.equal(codeOf(response), 'route_not_found', `POST ${path}: ${response.text}`)
      phantomRows.push({ label: `POST ${path}`, status: response.status, code: codeOf(response) })
    }

    // 4d. The one route that answers 200 to any well-formed key — the
    // privilegeless challenge — carries no session in its result, and the
    // nonce it issues answers `not_enrolled` to a fresh key's VALID
    // signature: the viewer credential minted zero authority.
    const fresh = generateKeyPairSync('ed25519')
    const freshSpki = fresh.publicKey.export({ type: 'spki', format: 'der' })
    const freshRaw = freshSpki.subarray(freshSpki.length - 32)
    const challenge = await request(host, port, 'POST', '/api/auth/challenge', {
      headers: { ...jsonHeaders, authorization: `Bearer ${viewerToken}` },
      body: JSON.stringify({ public_key: freshRaw.toString('base64url') }),
    })
    assert.equal(challenge.status, 200, `the privilegeless challenge: ${challenge.status} ${challenge.text}`)
    assert.equal(typeof resultOf(challenge).nonce, 'string', 'a nonce was issued to the well-formed key')
    assert.equal(resultOf(challenge).session_token, undefined, 'the challenge result carries no session')
    const answerSignature = cryptoSign(null, Buffer.from(resultOf(challenge).nonce, 'base64url'), fresh.privateKey).toString('base64url')
    const freshAnswer = await request(host, port, 'POST', '/api/auth/answer', {
      headers: { ...jsonHeaders, authorization: `Bearer ${viewerToken}` },
      body: JSON.stringify({ nonce: resultOf(challenge).nonce, signature: answerSignature }),
    })
    assert.equal(freshAnswer.status, 403, `the fresh key's valid answer: ${freshAnswer.status} ${freshAnswer.text}`)
    assert.equal(codeOf(freshAnswer), 'not_enrolled', `the viewer credential enrolled no one: ${freshAnswer.text}`)

    // 4e. The viewer COOKIE is equally nothing on the API class.
    const cookieRows = []
    async function cookieRefusal(label, method, path, body) {
      const response = await request(host, port, method, path, {
        headers: { ...jsonHeaders, ...cookie },
        body: body === undefined ? undefined : JSON.stringify(body),
      })
      assert.equal(response.status, 401, `${label}: expected 401, got ${response.status}: ${response.text}`)
      assert.equal(codeOf(response), 'unauthorized', `${label}: ${response.text}`)
      cookieRows.push({ label, status: response.status, code: codeOf(response) })
    }
    await cookieRefusal('local exchange', 'POST', '/api/auth/local', { public_key: actor.publicKeyBase64url })
    await cookieRefusal('session bind', 'POST', '/api/session', { chat_id: 'ViewerWasHere' })
    await cookieRefusal('session release', 'DELETE', '/api/session')
    await cookieRefusal('direct open', 'POST', '/api/rooms/direct', { chat_id: 'SomeoneElse' })
    await cookieRefusal('message send', 'POST', `/api/rooms/${actor.broadcastRoomId}/messages`, { chat_id: ACTOR_CHAT_ID, client_message_id: 'viewer-write-2', text: 'a line the viewer cookie must never write' })

    // --- 5. Nothing was written anywhere ---------------------------------------
    const pageAfter = await actor.pageRead()
    assert.equal(pageAfter.messages.length, 1, `the drill wrote nothing: the room holds exactly the holders-only line (got ${pageAfter.messages.length})`)
    const presence = await actor.presence()
    assert.deepEqual(
      presence.online.map(row => row.chat_id),
      [ACTOR_CHAT_ID],
      `no session was ever bound by the viewer credential: ${JSON.stringify(presence.online)}`,
    )

    // --- 6. The positive control: the holder's path over the same interface ----
    const boot = await request(host, port, 'GET', '/viewer/boot.json', { headers: cookie })
    assert.equal(boot.status, 200, `the holder's boot descriptor: ${boot.status} ${boot.text}`)
    assert.match(resultOf(boot).realm_id, /^[0-9a-f-]{36}$/, 'the descriptor names the realm')
    assert.equal(resultOf(boot).broadcast_room_id, actor.broadcastRoomId, 'the descriptor names the Broadcast Room')
    const shell = await request(host, port, 'GET', '/viewer/', { headers: cookie })
    assert.equal(shell.status, 200, `the holder's static shell: ${shell.status} ${shell.text}`)
    assert.match(shell.headers['content-type'], /text\/html/, 'the shell is HTML')
    const holderPage = await request(host, port, 'GET', `/viewer/api/rooms/${actor.broadcastRoomId}/messages`, { headers: cookie })
    assert.equal(holderPage.status, 200, `the holder's page read: ${holderPage.status} ${holderPage.text}`)
    const holdersLineSeen = resultOf(holderPage).messages.some(message => message.text === HOLDERS_TEXT)
    assert.equal(holdersLineSeen, true, 'the holder sees the Broadcast Room message')
    const stream = await openStream(host, port, `/viewer/api/rooms/${actor.broadcastRoomId}/events`, cookie)
    assert.equal(stream.status, 200, 'the holder stream opens')
    assert.match(stream.responseHeaders['content-type'], /text\/event-stream/, 'the stream is an event stream')
    await waitForEvent(stream, 'presence', 'the stream should open with presence')
    await waitForMessageText(stream, HOLDERS_TEXT, 'the holders-only line should ride the stream')
    stream.req.destroy()

    // --- 7. Stop clean; the whole drill's stderr is empty -----------------------
    const exitCode = await serverState.stop()
    assert.equal(exitCode, 0, `the server child exits 0 on SIGTERM (got ${exitCode})`)
    const stderr = serverState.stderrText()
    assert.equal(stderr, '', `no stderr noise over the whole drill — and therefore no secrets: ${JSON.stringify(stderr)}`)

    const report = {
      host,
      port,
      topology: {
        exposedDoorAnswered: true,
        loopbackDoor,
        defaultVerifiedTls: true,
      },
      unauthenticated: {
        rows: unauthenticatedRows,
        zeroPreviews: true,
        noSetCookie: true,
        previewMarkersChecked: PREVIEW_MARKERS.length,
      },
      getOnly: {
        rows: getOnlyRows,
        credentialedPost: { label: 'POST /viewer/auth with the correct token', status: credentialedPost.status, code: codeOf(credentialedPost), noSetCookie: true },
      },
      isolation: {
        bearerRows,
        enrollRows: [
          { label: 'the token as invite_token', status: enrollShape.status, code: codeOf(enrollShape) },
          { label: 'a well-formed unknown invite beside the token', status: enrollUnknown.status, code: codeOf(enrollUnknown) },
        ],
        phantomRows,
        challenge: {
          status: challenge.status,
          nonceIssued: true,
          sessionCarried: false,
          answerStatus: freshAnswer.status,
          freshAnswerCode: codeOf(freshAnswer),
        },
        cookieRows,
      },
      writesDidNotHappen: {
        broadcastBefore: pageBefore.messages.length,
        broadcastAfter: pageAfter.messages.length,
        presenceOnline: [ACTOR_CHAT_ID],
      },
      holder: {
        mintStatus: mint.status,
        cookieFlags: true,
        bootStatus: boot.status,
        shellStatus: shell.status,
        pageStatus: holderPage.status,
        holdersLineSeen,
        streamStatus: stream.status,
        streamPresenceSeen: true,
        streamMessageSeen: true,
      },
      secrets: {
        stderrEmpty: true,
        cleanOfViewerToken: !stderr.includes(viewerToken),
        cleanOfCookie: !stderr.includes(cookieValue.value),
      },
    }
    console.log(`REPORT:${JSON.stringify(report)}`)
    process.exit(0)
  } finally {
    if (serverState.child.exitCode === null && serverState.child.signalCode === null) {
      try { serverState.child.kill('SIGKILL') } catch { /* already gone */ }
    }
  }
}

run().catch(error => {
  fail(error?.stack ?? String(error))
})
