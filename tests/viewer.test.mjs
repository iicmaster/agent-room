// Stories 5.1 + 5.2 acceptance: the viewer auth bridge and the live room &
// presence view (FR-18, HCI-5, DR-3).
//
// What is proven, against the real server and real HTTP:
//
//   5.1 The bridge — GET /viewer/auth (viewer class, Bearer viewer token)
//       mints an HttpOnly, SameSite=Strict, Path=/viewer session cookie
//       whose value is an independent 256-bit random value; a credential in
//       a QUERY STRING is structurally impossible (the route's frozen field
//       set is empty, so ?token=… dies as unknown_field before the handler);
//       the viewer token and the cookie are valid on NO other route class
//       and session tokens never authenticate any viewer route; the operator
//       rotates via `agent-room viewer rotate` (the receipt's token is the
//       file's) and a rotation invalidates the old token at its next mint
//       AND every cookie minted under it at its next presentation — the
//       bridge re-reads the token file per request, so the rotation of a
//       separate CLI process holds at next request with no restart.
//
//   5.2 The live view — the cookie-authenticated viewer session renders the
//       Broadcast Room and the presence list via ONE SSE stream carrying
//       room-message events AND presence snapshots (no second channel, no
//       client polling; the server-side wake loop is the long-poll read's
//       own bounded re-poll pattern), with every FR-18 state exercised by a
//       trigger-and-assert row below — each row names its state, drives the
//       cause, and asserts the observed result:
//         authenticated → static view + boot descriptor + stream open
//         loading       → stream open: the FIRST frame is the presence
//                         snapshot, before any message exists
//         empty         → empty room: empty page read, no message events
//                         until one commits
//         online        → bound sessions appear in the online group
//         offline-
//         recently      → a disconnected session moves to the offline-
//                         recently group on the same stream
//         unreachable   → after the server stops, connections are REFUSED
//                         (reported unreachable, never "everyone offline")
//         reconnecting  → a dropped stream reconnects with Last-Event-ID
//                         and replays exactly the missed messages
//         token-rotation→ after rotation the old cookie's requests (and any
//                         new stream) answer 401; the new token's cookie
//                         opens a working stream again
//       A committed message arrives on the stream within the 5 s freshness
//       bound; all viewer responses carry the strict CSP (no unsafe-inline)
//       and hostile text arrives as inert DATA; Direct Rooms are refused by
//       construction (room_not_found, the same answer a nonexistent id
//       gets) and never ride the stream or the boot descriptor.
//
// House style: real surfaces end to end — in-process startServer over the
// real store for the wire rows, a real spawned server child for the
// cross-process rotation row and the no-secrets-in-logs scan, the real CLI
// dispatch for `viewer rotate`.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { generateKeyPairSync } from 'node:crypto'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  VIEWER_FRESHNESS_SECONDS,
  VIEWER_TOKEN_MAX_CHARS,
} from '../server/constants.mjs'
import { openRoomLog } from '../server/store/room-log.mjs'
import { startServer } from '../server/api/server.mjs'
import { createEnrollRateLimiter } from '../server/api/enroll-rate-limit.mjs'
import { loadOrCreateLocalToken } from '../server/api/local-token.mjs'
import {
  loadOrCreateViewerToken,
  rotateViewerToken,
} from '../server/runtime.mjs'
import { fingerprintFromPublicKey } from '../server/keys.mjs'
import { main } from '../server/cli/agent-room.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = join(ROOT, 'server', 'api', 'server.mjs')
const RUNTIME_RECORD_FILENAME = 'runtime.json'
const PROTOCOL_KEY = 'agent-room-protocol'
const SLEEP = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })

// Operator floors so the wire rows' sends are never rate-gate refusals (the
// gates still run; these workloads never trip them).
const FLOORS_OFF = Object.freeze({
  sendTokenRefillPerSecond: 1000,
  sendTokenCapacity: 1000,
  requestBudgetPerMinute: 60000,
  requestBudgetBurst: 1000,
})

// The exact CSP the viewer dispatch sets (viewer.mjs): nothing inline, no
// remote origins, no framing, no referrer — the inert-rendering backstop.
const VIEWER_CSP = [
  "default-src 'self'",
  "connect-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
].join('; ')

// --- Harness --------------------------------------------------------------------

function makeDataDir(t, prefix = 'agent-room-viewer-') {
  const dataDir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  return dataDir
}

function installation() {
  const { publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const raw = spki.subarray(spki.length - 32)
  return {
    raw,
    publicKey: raw.toString('base64url'),
    fingerprint: fingerprintFromPublicKey(raw),
  }
}

async function startTestServer(t, dataDir, options = {}) {
  const server = await startServer({
    dataDir,
    port: 0,
    host: '127.0.0.1',
    enrollRateLimiter: createEnrollRateLimiter({ limit: 1000 }),
    ...FLOORS_OFF,
    ...options,
  })
  t.after(() => server.close())
  return server
}

// Small direct HTTP client: no keep-alive, full control over headers.
function request(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers, agent: false },
      response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('error', rejectPromise)
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolvePromise({
            status: response.statusCode,
            headers: response.headers,
            text,
            json: () => JSON.parse(text),
          })
        })
      },
    )
    req.on('error', rejectPromise)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const jsonHeaders = { [PROTOCOL_KEY]: '1', 'content-type': 'application/json; charset=utf-8' }

// One connected session that can send to a room (the local-auth exchange,
// the Chat ID bind, and the Broadcast Room id).
async function connectSession(port, dataDir, chatId) {
  const actor = installation()
  const auth = await request(port, 'POST', '/api/auth/local', {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${loadOrCreateLocalToken(dataDir)}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ public_key: actor.publicKey }),
  })
  assert.equal(auth.status, 200, auth.text)
  const sessionToken = auth.json().result.session_token
  const bound = await request(port, 'POST', '/api/session', {
    headers: { ...jsonHeaders, authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ chat_id: chatId, client_type: 'mcp' }),
  })
  assert.equal(bound.status, 200, bound.text)
  const status = await request(port, 'GET', '/api/status', {
    headers: { ...jsonHeaders, authorization: `Bearer ${sessionToken}` },
  })
  assert.equal(status.status, 200, status.text)
  return {
    actor,
    sessionToken,
    fingerprint: actor.fingerprint,
    chatId,
    broadcastRoomId: status.json().result.broadcast_room_id,
    async send(roomId, clientMessageId, text, extra = {}) {
      return request(port, 'POST', `/api/rooms/${roomId}/messages`, {
        headers: { ...jsonHeaders, authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({ chat_id: chatId, client_message_id: clientMessageId, text, ...extra }),
      })
    },
    async openDirect(targetFingerprint) {
      return request(port, 'POST', '/api/rooms/direct', {
        headers: { ...jsonHeaders, authorization: `Bearer ${sessionToken}` },
        body: JSON.stringify({ chat_id: 'peer', target_fingerprint: targetFingerprint }),
      })
    },
    async disconnect() {
      return request(port, 'DELETE', '/api/session', {
        headers: { ...jsonHeaders, authorization: `Bearer ${sessionToken}` },
      })
    },
  }
}

// The CLI in-process through the real dispatch (the ban harness's shape).
async function runCli(dataDir, argv) {
  const output = new PassThrough()
  const errorOutput = new PassThrough()
  output.setEncoding('utf8')
  errorOutput.setEncoding('utf8')
  let stdout = ''
  let stderr = ''
  output.on('data', chunk => { stdout += chunk })
  errorOutput.on('data', chunk => { stderr += chunk })
  const previousExitCode = process.exitCode
  process.exitCode = undefined
  try {
    await main(argv, {
      input: new PassThrough(),
      output,
      errorOutput,
      sharedDataDir: dataDir,
      pluginDataDir: join(dataDir, 'plugin-data-unused'),
    })
    await SLEEP(10)
    return { stdout, stderr, exitCode: process.exitCode ?? 0 }
  } finally {
    process.exitCode = previousExitCode
  }
}

// Mint a viewer session: the bridge exchange, returning the raw Set-Cookie
// header value and the bare cookie value the Cookie header carries.
async function mintViewerCookie(port, viewerToken) {
  const mint = await request(port, 'GET', '/viewer/auth', {
    headers: { authorization: `Bearer ${viewerToken}` },
  })
  return mint
}

function cookieValueOf(setCookie) {
  const match = /^agent_room_viewer=([A-Za-z0-9_-]+);/.exec(`${setCookie};`)
  return match === null ? null : match[1]
}

function cookieHeaderOf(setCookie) {
  return { cookie: `agent_room_viewer=${cookieValueOf(setCookie)}` }
}

// A minimal SSE client over the real HTTP surface: parses frames as they
// arrive and lets rows await a named event.
async function openEventStream(t, port, path, headers = {}) {
  const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers, agent: false })
  const stream = {
    req,
    status: null,
    responseHeaders: null,
    events: [],
    raw: '',
    retry: null,
    closed: false,
  }
  req.on('close', () => { stream.closed = true })
  // The request must be ended BEFORE the response can ever arrive.
  req.end()
  const response = await new Promise((resolvePromise, rejectPromise) => {
    req.on('response', resolvePromise)
    req.on('error', rejectPromise)
  })
  stream.status = response.statusCode
  stream.responseHeaders = response.headers
  response.setEncoding('utf8')
  response.on('data', chunk => {
    stream.raw += chunk
    let boundary = stream.raw.indexOf('\n\n')
    while (boundary !== -1) {
      const frame = stream.raw.slice(0, boundary)
      stream.raw = stream.raw.slice(boundary + 2)
      const event = { id: null, event: 'message', data: null, retry: null, comment: null }
      for (const line of frame.split('\n')) {
        if (line.startsWith(':')) {
          event.comment = line.slice(1).trim()
          continue
        }
        const separator = line.indexOf(':')
        if (separator === -1) continue
        const field = line.slice(0, separator)
        const value = line.slice(separator + 1).replace(/^ /, '')
        if (field === 'id') event.id = value
        else if (field === 'event') event.event = value
        else if (field === 'data') event.data = value
        else if (field === 'retry') event.retry = value
      }
      // Only frames that carry DATA are events (the SSE `message` default
      // exists for data frames); retry hints and keep-alive comments are
      // transport machinery, recorded on the stream but never as events.
      if (event.data !== null) stream.events.push(event)
      if (event.retry !== null) stream.retry = event.retry
      boundary = stream.raw.indexOf('\n\n')
    }
  })
  response.on('end', () => { stream.closed = true })
  response.on('error', () => { stream.closed = true })
  if (t !== null) {
    t.after(() => { req.destroy() })
  }
  return stream
}

function eventOfType(stream, name) {
  return stream.events.find(event => event.event === name) ?? null
}

// Resolves with the first event of `name`, failing the row after timeoutMs.
function waitForEvent(stream, name, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  return new Promise((resolvePromise, rejectPromise) => {
    const poll = () => {
      const found = eventOfType(stream, name)
      if (found) {
        resolvePromise(found)
        return
      }
      if (Date.now() >= deadline) {
        rejectPromise(new Error(`${message}: no ${name} event within ${timeoutMs} ms (got ${stream.events.map(event => event.event).join(', ') || 'nothing'})`))
        return
      }
      setTimeout(poll, 20)
    }
    poll()
  })
}

// Wait until a predicate sees a matching event (presence snapshots repeat).
async function waitForMatchingEvent(stream, name, predicate, timeoutMs, message) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const found = stream.events.find(event => event.event === name && predicate(event))
    if (found) return found
    const remaining = deadline - Date.now()
    if (remaining <= 0) {
      throw new Error(`${message}: no matching ${name} event within ${timeoutMs} ms`)
    }
    await SLEEP(25)
  }
}

// A real spawned server child (the invite/ban harness style): the process
// boundary is the evidence for the cross-process rotation and the stderr
// credential scan.
function spawnServerChild(t, dataDir) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, AGENT_ROOM_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stderrChunks = []
  child.stderr.on('data', chunk => stderrChunks.push(chunk))
  const stderrText = () => Buffer.concat(stderrChunks).toString('utf8')
  const runtimePath = join(dataDir, RUNTIME_RECORD_FILENAME)
  const waitReady = async () => {
    const deadline = Date.now() + 15 * 1000
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`server child exited early (code=${child.exitCode}); stderr: ${stderrText()}`)
      }
      if (existsSync(runtimePath)) {
        try {
          const record = JSON.parse(readFileSync(runtimePath, 'utf8'))
          if (record.pid === child.pid && Number.isInteger(record.port) && record.port > 0) {
            const health = await request(record.port, 'GET', '/health').catch(() => null)
            if (health?.status === 200) return record
          }
        } catch { /* atomic rename: readers retry */ }
      }
      if (Date.now() > deadline) throw new Error(`server child never became ready; stderr: ${stderrText()}`)
      await SLEEP(25)
    }
  }
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit').catch(() => {})
    }
  })
  return { child, waitReady, stderrText }
}

// --- Story 5.1: the auth bridge --------------------------------------------------

test('the auth bridge mints an HttpOnly SameSite=Strict path-scoped cookie from the Bearer viewer token', async t => {
  const dataDir = makeDataDir(t)
  const viewerToken = loadOrCreateViewerToken(dataDir)
  const server = await startTestServer(t, dataDir)

  // No credential → the canonical refusal, zero state.
  const anonymous = await request(server.port, 'GET', '/viewer/auth')
  assert.equal(anonymous.status, 401)
  assert.equal(anonymous.json().error.code, 'unauthorized')
  assert.equal(anonymous.headers['set-cookie'], undefined)

  // A credential in the QUERY STRING is structurally impossible: the frozen
  // field set is empty, so even the RIGHT token rides to an unknown_field
  // rejection in the field gate — never a fallback read.
  const inQuery = await request(server.port, 'GET', `/viewer/auth?token=${encodeURIComponent(viewerToken)}`)
  assert.equal(inQuery.status, 400)
  assert.equal(inQuery.json().error.code, 'unknown_field')
  assert.equal(inQuery.headers['set-cookie'], undefined)

  // A wrong or malformed Bearer → 401, no cookie.
  const wrong = await request(server.port, 'GET', '/viewer/auth', {
    headers: { authorization: `Bearer ${'A'.repeat(VIEWER_TOKEN_MAX_CHARS)}` },
  })
  assert.equal(wrong.status, 401)
  const junk = await request(server.port, 'GET', '/viewer/auth', {
    headers: { authorization: 'Bearer not-a-real-credential-shape' },
  })
  assert.equal(junk.status, 401)
  const basic = await request(server.port, 'GET', '/viewer/auth', {
    headers: { authorization: `Basic ${Buffer.from('user:pass').toString('base64url')}` },
  })
  assert.equal(basic.status, 401)

  // The real exchange: the cookie's flags are the AC, verbatim.
  const mint = await mintViewerCookie(server.port, viewerToken)
  assert.equal(mint.status, 200, mint.text)
  assert.equal(mint.json().ok, true)
  // The credential is never echoed into any body.
  assert.equal(mint.text.includes(viewerToken), false)
  const setCookie = mint.headers['set-cookie'][0]
  assert.match(
    setCookie,
    /^agent_room_viewer=[A-Za-z0-9_-]{43}; Path=\/viewer; HttpOnly; SameSite=Strict$/,
  )

  // The cookie authenticates the viewer surface it is scoped to.
  const boot = await request(server.port, 'GET', '/viewer/boot.json', { headers: cookieHeaderOf(setCookie) })
  assert.equal(boot.status, 200, boot.text)
  assert.equal(boot.json().ok, true)
  assert.match(boot.json().result.realm_id, /^[0-9a-f-]{36}$/)
  assert.equal(typeof boot.json().result.broadcast_room_id, 'string')
  assert.ok(boot.json().result.broadcast_room_id.length > 0)
  assert.equal(typeof boot.json().result.version, 'string')
})

test('the viewer token and the cookie are valid on no other route class, and session tokens never authenticate viewer routes', async t => {
  const dataDir = makeDataDir(t)
  const viewerToken = loadOrCreateViewerToken(dataDir)
  const server = await startTestServer(t, dataDir)
  const session = await connectSession(server.port, dataDir, 'Alice')

  // The viewer token as Bearer on the actor class → the session verifier's
  // canonical refusal (it is not a session).
  const tokenOnActor = await request(server.port, 'GET', '/api/status', {
    headers: { ...jsonHeaders, authorization: `Bearer ${viewerToken}` },
  })
  assert.equal(tokenOnActor.status, 401)
  assert.equal(tokenOnActor.json().error.code, 'unauthorized')

  // The viewer cookie on the actor class → equally nothing: the session
  // verifier reads no cookie jar.
  const mint = await mintViewerCookie(server.port, viewerToken)
  assert.equal(mint.status, 200)
  const setCookie = mint.headers['set-cookie'][0]
  const cookieOnActor = await request(server.port, 'GET', '/api/status', {
    headers: { ...jsonHeaders, ...cookieHeaderOf(setCookie) },
  })
  assert.equal(cookieOnActor.status, 401)
  assert.equal(cookieOnActor.json().error.code, 'unauthorized')

  // A session token on the viewer routes → 401 everywhere: /viewer/auth (it
  // is not the viewer token), the static surface, the boot descriptor, and
  // the broadcast read.
  const sessionOnAuth = await request(server.port, 'GET', '/viewer/auth', {
    headers: { authorization: `Bearer ${session.sessionToken}` },
  })
  assert.equal(sessionOnAuth.status, 401)
  assert.equal(sessionOnAuth.headers['set-cookie'], undefined)
  for (const path of ['/viewer/', '/viewer/boot.json', `/viewer/api/rooms/${session.broadcastRoomId}/messages`]) {
    const refusal = await request(server.port, 'GET', path, {
      headers: { authorization: `Bearer ${session.sessionToken}` },
    })
    assert.equal(refusal.status, 401, path)
    assert.equal(refusal.json().error.code, 'unauthorized', path)
  }
  // A session token as a COOKIE is not a viewer cookie either.
  const sessionAsCookie = await request(server.port, 'GET', '/viewer/boot.json', {
    headers: { cookie: `agent_room_viewer=${session.sessionToken}` },
  })
  assert.equal(sessionAsCookie.status, 401)

  // The viewer surface is GET-only by the frozen table: no POST row exists.
  const post = await request(server.port, 'POST', '/viewer/auth', {
    headers: { 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({}),
  })
  assert.equal(post.status, 404)
  assert.equal(post.json().error.code, 'route_not_found')
})

test('no credential ever appears in a query string, a log, or a referrer-leaking link', async t => {
  // The cross-process row: a real server child, a full viewer journey
  // (mint → read → stream → rotate → re-mint) across separate processes,
  // then the whole stderr of the server child scanned for every credential.
  const dataDir = makeDataDir(t)
  const viewerToken = loadOrCreateViewerToken(dataDir)
  const { waitReady, stderrText } = spawnServerChild(t, dataDir)
  const record = await waitReady()

  const mint = await mintViewerCookie(record.port, viewerToken)
  assert.equal(mint.status, 200)
  const setCookie = mint.headers['set-cookie'][0]
  const cookieValue = cookieValueOf(setCookie)
  assert.ok(cookieValue)

  const boot = await request(record.port, 'GET', '/viewer/boot.json', { headers: cookieHeaderOf(setCookie) })
  assert.equal(boot.status, 200)
  const stream = await openEventStream(
    t,
    record.port,
    `/viewer/api/rooms/${boot.json().result.broadcast_room_id}/events`,
    cookieHeaderOf(setCookie),
  )
  assert.equal(stream.status, 200)
  await waitForEvent(stream, 'presence', 5000, 'stream should open with presence')
  stream.req.destroy()

  // The operator rotates from a SEPARATE process while the server runs.
  const rotation = await runCli(dataDir, ['viewer', 'rotate'])
  assert.equal(rotation.exitCode, 0, rotation.stderr)
  const receipt = JSON.parse(rotation.stdout.trim())
  const newToken = receipt.viewer.token
  assert.notEqual(newToken, viewerToken)
  assert.equal(newToken, readFileSync(join(dataDir, 'viewer-token'), 'utf8').trim())

  // Re-mint under the new token.
  const reMint = await mintViewerCookie(record.port, newToken)
  assert.equal(reMint.status, 200)
  const newCookie = cookieValueOf(reMint.headers['set-cookie'][0])

  // The whole journey's stderr: no token, no old token, no cookie value.
  const stderr = stderrText()
  assert.equal(stderr.includes(viewerToken), false, `server stderr leaked the viewer token: ${stderr}`)
  assert.equal(stderr.includes(newToken), false, `server stderr leaked the rotated viewer token: ${stderr}`)
  assert.equal(stderr.includes(cookieValue), false, 'server stderr leaked the viewer cookie')
  assert.equal(stderr.includes(newCookie), false, 'server stderr leaked the new viewer cookie')

  // And no referrer can leak what is never in a URL: the policy is on every
  // viewer response (asserted on HTML/JSON/SSE in their own rows; here on
  // the bridge itself).
  const reMint2 = await mintViewerCookie(record.port, newToken)
  assert.equal(reMint2.headers['referrer-policy'], 'no-referrer')
})

test('the operator rotates the viewer token: the new token mints, the old token cannot, and every old cookie dies at next request', async t => {
  const dataDir = makeDataDir(t)
  const firstToken = loadOrCreateViewerToken(dataDir)
  const server = await startTestServer(t, dataDir)

  const firstMint = await mintViewerCookie(server.port, firstToken)
  assert.equal(firstMint.status, 200)
  const firstCookie = firstMint.headers['set-cookie'][0]
  const bootBefore = await request(server.port, 'GET', '/viewer/boot.json', { headers: cookieHeaderOf(firstCookie) })
  assert.equal(bootBefore.status, 200)

  // The rotation receipt carries the NEW token exactly once (the invite-mint
  // pattern), and the file holds it.
  const rotation = await runCli(dataDir, ['viewer', 'rotate'])
  assert.equal(rotation.exitCode, 0, rotation.stderr)
  assert.equal(rotation.stderr, '')
  const lines = rotation.stdout.trim().split('\n')
  assert.equal(lines.length, 1)
  const receipt = JSON.parse(lines[0])
  assert.equal(receipt.ok, true)
  assert.equal(receipt.command, 'viewer rotate')
  assert.equal(receipt.viewer.rotated, true)
  const secondToken = receipt.viewer.token
  assert.match(secondToken, /^[A-Za-z0-9_-]{43}$/)
  assert.notEqual(secondToken, firstToken)
  assert.equal(readFileSync(join(dataDir, 'viewer-token'), 'utf8').trim(), secondToken)

  // The old token refuses at its next mint…
  const oldMint = await mintViewerCookie(server.port, firstToken)
  assert.equal(oldMint.status, 401)
  // …and every cookie minted under it is invalid at its next presentation.
  const oldCookieBoot = await request(server.port, 'GET', '/viewer/boot.json', { headers: cookieHeaderOf(firstCookie) })
  assert.equal(oldCookieBoot.status, 401)
  const oldCookieMessages = await request(server.port, 'GET', '/viewer/api/rooms/x/messages', { headers: cookieHeaderOf(firstCookie) })
  assert.equal(oldCookieMessages.status, 401)

  // The new token mints a working session.
  const secondMint = await mintViewerCookie(server.port, secondToken)
  assert.equal(secondMint.status, 200)
  const secondBoot = await request(
    server.port,
    'GET',
    '/viewer/boot.json',
    { headers: cookieHeaderOf(secondMint.headers['set-cookie'][0]) },
  )
  assert.equal(secondBoot.status, 200)

  // Grammar: the family refuses usage errors through the host's coded
  // stderr + exit code (0 ok / 1 refusal / 2 usage).
  const extraArg = await runCli(dataDir, ['viewer', 'rotate', '--force'])
  assert.equal(extraArg.exitCode, 2)
  assert.deepEqual(JSON.parse(extraArg.stderr.trim().split('\n')[0]).code, 'usage')
  const unknownSub = await runCli(dataDir, ['viewer', 'frobnicate'])
  assert.equal(unknownSub.exitCode, 2)
})

// --- Story 5.2: the live view ----------------------------------------------------

test('an authenticated viewer session renders the static live view, the boot descriptor, and ONE stream (authenticated)', async t => {
  const dataDir = makeDataDir(t)
  const viewerToken = loadOrCreateViewerToken(dataDir)
  const server = await startTestServer(t, dataDir)
  const mint = await mintViewerCookie(server.port, viewerToken)
  assert.equal(mint.status, 200)
  const cookie = cookieHeaderOf(mint.headers['set-cookie'][0])

  // The static shell: HTML + assets under /viewer/, the strict CSP on every
  // byte, no free previews without the cookie.
  const html = await request(server.port, 'GET', '/viewer/', { headers: cookie })
  assert.equal(html.status, 200)
  assert.match(html.headers['content-type'], /text\/html/)
  assert.equal(html.headers['content-security-policy'], VIEWER_CSP)
  assert.equal(html.headers['referrer-policy'], 'no-referrer')
  assert.equal(html.headers['x-content-type-options'], 'nosniff')
  assert.equal(html.headers['x-frame-options'], 'DENY')
  assert.match(html.text, /viewer\/app\.js/)
  const script = await request(server.port, 'GET', '/viewer/app.js', { headers: cookie })
  assert.equal(script.status, 200)
  assert.match(script.headers['content-type'], /text\/javascript/)
  const styles = await request(server.port, 'GET', '/viewer/styles.css', { headers: cookie })
  assert.equal(styles.status, 200)
  assert.match(styles.headers['content-type'], /text\/css/)
  // Unlisted paths under the wildcard refuse — no traversal, no listing.
  const unlisted = await request(server.port, 'GET', '/viewer/nope.js', { headers: cookie })
  assert.equal(unlisted.status, 404)
  assert.equal(unlisted.json().error.code, 'route_not_found')
  const traversal = await request(server.port, 'GET', '/viewer/%2e%2e/server.mjs', { headers: cookie })
  assert.equal(traversal.status, 404)

  // Without the cookie there is no preview of any of it.
  const anonymous = await request(server.port, 'GET', '/viewer/')
  assert.equal(anonymous.status, 401)

  // The Broadcast Room stream: text/event-stream, security headers on the
  // stream too, no protocol echo on any viewer response.
  const boot = await request(server.port, 'GET', '/viewer/boot.json', { headers: cookie })
  assert.equal(boot.headers['content-security-policy'], VIEWER_CSP)
  const broadcastRoomId = boot.json().result.broadcast_room_id
  const stream = await openEventStream(
    t,
    server.port,
    `/viewer/api/rooms/${broadcastRoomId}/events`,
    cookie,
  )
  assert.equal(stream.status, 200)
  assert.match(stream.responseHeaders['content-type'], /text\/event-stream/)
  assert.equal(stream.responseHeaders['content-security-policy'], VIEWER_CSP)
  assert.equal(stream.responseHeaders['referrer-policy'], 'no-referrer')
  assert.equal(stream.responseHeaders[PROTOCOL_KEY.toLowerCase()], undefined)
  // The reconnect hint rode the raw stream: the browser re-opens on its own
  // and carries the last id back as Last-Event-ID. (The parser consumes
  // complete frames, so the recorded retry field is the durable evidence —
  // raw may already be drained past the hint by the time presence arrived.)
  await waitForEvent(stream, 'presence', 5000, 'the stream should open with the first presence snapshot')
  assert.match(String(stream.retry), /^\d+$/)
})

test('loading then empty: the stream opens with a presence snapshot and an empty room sends no message events', async t => {
  const dataDir = makeDataDir(t)
  const viewerToken = loadOrCreateViewerToken(dataDir)
  const server = await startTestServer(t, dataDir)
  const mint = await mintViewerCookie(server.port, viewerToken)
  const cookie = cookieHeaderOf(mint.headers['set-cookie'][0])
  const boot = await request(server.port, 'GET', '/viewer/boot.json', { headers: cookie })
  const broadcastRoomId = boot.json().result.broadcast_room_id

  // LOADING → the first frame the stream delivers is the presence snapshot
  // (the moment the loading state can end), before any message exists.
  const stream = await openEventStream(t, server.port, `/viewer/api/rooms/${broadcastRoomId}/events`, cookie)
  assert.equal(stream.status, 200)
  const firstPresence = await waitForEvent(stream, 'presence', 5000, 'first stream frame should be presence')
  const snapshot = JSON.parse(firstPresence.data)
  assert.deepEqual(Object.keys(snapshot).sort(), ['offline_recently', 'online'])
  assert.deepEqual(snapshot.online, [])
  assert.deepEqual(snapshot.offline_recently, [])

  // EMPTY → the page read answers the empty contract…
  const page = await request(server.port, 'GET', `/viewer/api/rooms/${broadcastRoomId}/messages?after_seq=0&limit=50`, { headers: cookie })
  assert.equal(page.status, 200)
  assert.deepEqual(page.json().result, { messages: [], next_after_seq: 0, head_seq: 0 })

  // …and no message event arrives while nothing is sent (the room's state is
  // rendered empty, live, not stalled in loading).
  await SLEEP(700)
  assert.equal(eventOfType(stream, 'message'), null)
})

test('online and offline-recently ride the same stream as the room', async t => {
  const dataDir = makeDataDir(t)
  const viewerToken = loadOrCreateViewerToken(dataDir)
  const server = await startTestServer(t, dataDir)
  const alice = await connectSession(server.port, dataDir, 'Alice')
  const bob = await connectSession(server.port, dataDir, 'Bob')
  const mint = await mintViewerCookie(server.port, viewerToken)
  const cookie = cookieHeaderOf(mint.headers['set-cookie'][0])

  const stream = await openEventStream(
    t,
    server.port,
    `/viewer/api/rooms/${alice.broadcastRoomId}/events`,
    cookie,
  )
  await waitForEvent(stream, 'presence', 5000, 'initial presence')

  // ONLINE: both sessions, full presence rows, on the SAME stream that
  // carries the messages (one EventSource renders both panels).
  const onlineEvent = await waitForMatchingEvent(
    stream,
    'presence',
    event => JSON.parse(event.data).online.length >= 2,
    5000,
    'both sessions should appear online',
  )
  const online = JSON.parse(onlineEvent.data).online
  const aliceRow = online.find(row => row.chat_id === 'Alice')
  const bobRow = online.find(row => row.chat_id === 'Bob')
  assert.equal(aliceRow.fingerprint, alice.fingerprint)
  assert.equal(aliceRow.client_type, 'mcp')
  assert.match(aliceRow.connected_since, /^\d{4}-\d{2}-\d{2}T/)
  assert.match(aliceRow.last_seen, /^\d{4}-\d{2}-\d{2}T/)

  // OFFLINE-RECENTLY: Bob disconnects; the SAME stream moves him to the
  // offline-recently group (from the durable claims index) while Alice
  // stays online.
  const disconnect = await bob.disconnect()
  assert.equal(disconnect.status, 200)
  const offlineEvent = await waitForMatchingEvent(
    stream,
    'presence',
    event => {
      const parsed = JSON.parse(event.data)
      return parsed.offline_recently.some(row => row.chat_id === 'Bob')
        && parsed.online.every(row => row.chat_id !== 'Bob')
    },
    5000,
    'Bob should move to offline_recently on the stream',
  )
  const bobOffline = JSON.parse(offlineEvent.data).offline_recently.find(row => row.chat_id === 'Bob')
  assert.equal(bobOffline.fingerprint, bob.fingerprint)
  assert.match(bobOffline.last_seen, /^\d{4}-\d{2}-\d{2}T/)
})

test('a committed message renders through the stream within the 5 s freshness bound', async t => {
  const dataDir = makeDataDir(t)
  const viewerToken = loadOrCreateViewerToken(dataDir)
  const server = await startTestServer(t, dataDir)
  const alice = await connectSession(server.port, dataDir, 'Alice')
  const mint = await mintViewerCookie(server.port, viewerToken)
  const cookie = cookieHeaderOf(mint.headers['set-cookie'][0])

  const stream = await openEventStream(
    t,
    server.port,
    `/viewer/api/rooms/${alice.broadcastRoomId}/events`,
    cookie,
  )
  await waitForEvent(stream, 'presence', 5000, 'initial presence')

  const committedAt = Date.now()
  const send = await alice.send(alice.broadcastRoomId, 'viewer-fresh-1', 'Hello from inside the room')
  assert.equal(send.status, 200, send.text)
  assert.equal(send.json().result.status, 'committed')

  const messageEvent = await waitForMatchingEvent(
    stream,
    'message',
    event => {
      try { return JSON.parse(event.data).client_message_id === 'viewer-fresh-1' } catch { return false }
    },
    VIEWER_FRESHNESS_SECONDS * 1000,
    'the committed message should arrive on the stream',
  )
  const elapsed = Date.now() - committedAt
  assert.ok(elapsed < VIEWER_FRESHNESS_SECONDS * 1000, `message took ${elapsed} ms`)
  const message = JSON.parse(messageEvent.data)
  assert.equal(message.seq, 1)
  assert.equal(message.room_id, alice.broadcastRoomId)
  assert.equal(message.chat_id, 'Alice')
  assert.equal(message.text, 'Hello from inside the room')
  assert.equal(messageEvent.id, String(message.seq))
})

test('all text renders inert: the strict CSP is on every viewer response and hostile text arrives only as data', async t => {
  const dataDir = makeDataDir(t)
  const viewerToken = loadOrCreateViewerToken(dataDir)
  const server = await startTestServer(t, dataDir)
  const alice = await connectSession(server.port, dataDir, 'Alice')
  const mint = await mintViewerCookie(server.port, viewerToken)
  const cookie = cookieHeaderOf(mint.headers['set-cookie'][0])

  const hostile = '<script>window.__viewerPwned = true</script> and <img src=x onerror="window.__pwned()"> & "quotes"'
  const send = await alice.send(alice.broadcastRoomId, 'hostile-1', hostile)
  assert.equal(send.status, 200, send.text)

  // The page read: hostile text is a JSON string value — DATA, never markup.
  const page = await request(server.port, 'GET', `/viewer/api/rooms/${alice.broadcastRoomId}/messages`, { headers: cookie })
  assert.equal(page.status, 200)
  assert.equal(page.json().result.messages[0].text, hostile)
  // The served HTML carries the one external script and no inline script
  // content, and no event-handler attribute the body could ever flow into.
  const html = await request(server.port, 'GET', '/viewer/', { headers: cookie })
  assert.match(html.text, /<script src="\/viewer\/app\.js" defer><\/script>/)
  assert.doesNotMatch(html.text, /<script>[^<]*\S/)
  assert.doesNotMatch(html.text, /\son[a-z]+=/)

  // The stream: the same bytes arrive as SSE data, and the CSP that renders
  // them inert is on the stream response itself (no unsafe-inline anywhere).
  const stream = await openEventStream(
    t,
    server.port,
    `/viewer/api/rooms/${alice.broadcastRoomId}/events`,
    cookie,
  )
  const hostileEvent = await waitForMatchingEvent(
    stream,
    'message',
    event => {
      try { return JSON.parse(event.data).client_message_id === 'hostile-1' } catch { return false }
    },
    5000,
    'the hostile message should arrive as data',
  )
  assert.equal(JSON.parse(hostileEvent.data).text, hostile)
  const csp = stream.responseHeaders['content-security-policy']
  assert.equal(csp, VIEWER_CSP)
  assert.equal(csp.includes('unsafe-inline'), false)
})

test('Direct Rooms never appear in the viewer: the refusal is the same room_not_found a nonexistent id answers', async t => {
  const dataDir = makeDataDir(t)
  const viewerToken = loadOrCreateViewerToken(dataDir)
  const server = await startTestServer(t, dataDir)
  const alice = await connectSession(server.port, dataDir, 'Alice')
  // A peer with a durable claim so the DM opens.
  const peer = await connectSession(server.port, dataDir, 'Peer')
  const direct = await alice.openDirect(peer.fingerprint)
  assert.equal(direct.status, 200, direct.text)
  const dmRoomId = direct.json().result.room_id
  assert.notEqual(dmRoomId, alice.broadcastRoomId)
  const dmSend = await peer.send(dmRoomId, 'dm-1', 'a private line that must never reach the viewer')
  assert.equal(dmSend.status, 200, dmSend.text)
  // A broadcast message for contrast: the viewer CAN see this one.
  const broadcastSend = await alice.send(alice.broadcastRoomId, 'bc-1', 'a public line the viewer may see')
  assert.equal(broadcastSend.status, 200, broadcastSend.text)

  const mint = await mintViewerCookie(server.port, viewerToken)
  const cookie = cookieHeaderOf(mint.headers['set-cookie'][0])

  // The broadcast-kind gate is the store's read itself: the DM id answers
  // the SAME coded refusal a fabricated id answers — existence and kind
  // leak nothing.
  const dmPage = await request(server.port, 'GET', `/viewer/api/rooms/${dmRoomId}/messages`, { headers: cookie })
  assert.equal(dmPage.status, 404)
  assert.equal(dmPage.json().error.code, 'room_not_found')
  const fakePage = await request(server.port, 'GET', '/viewer/api/rooms/does-not-exist/messages', { headers: cookie })
  assert.equal(fakePage.status, 404)
  assert.equal(fakePage.json().error.code, 'room_not_found')

  // The stream refuses the DM before any byte of event-stream exists.
  const dmStream = await request(server.port, 'GET', `/viewer/api/rooms/${dmRoomId}/events`, { headers: cookie })
  assert.equal(dmStream.status, 404)
  assert.equal(dmStream.json().error.code, 'room_not_found')

  // There is no viewer enumeration: /viewer/api/rooms falls to the wildcard
  // and refuses, and the boot descriptor names the Broadcast Room only.
  const enumeration = await request(server.port, 'GET', '/viewer/api/rooms', { headers: cookie })
  assert.equal(enumeration.status, 404)
  const boot = await request(server.port, 'GET', '/viewer/boot.json', { headers: cookie })
  assert.deepEqual(Object.keys(boot.json().result).sort(), ['broadcast_room_id', 'realm_id', 'version'])

  // And the private line never rides the broadcast stream.
  const stream = await openEventStream(
    t,
    server.port,
    `/viewer/api/rooms/${alice.broadcastRoomId}/events`,
    cookie,
  )
  await waitForEvent(stream, 'presence', 5000, 'initial presence')
  await SLEEP(600)
  for (const event of stream.events) {
    if (event.event === 'message') {
      assert.notEqual(JSON.parse(event.data).text, 'a private line that must never reach the viewer')
    }
  }

  // The store-level shape of the gate (the mechanism under the route).
  const store = openRoomLog({ dataDir })
  try {
    const directRefusal = store.readBroadcastPage({ roomId: dmRoomId, afterSeq: 0, limit: 10 })
    void directRefusal
    assert.fail('expected readBroadcastPage to refuse a direct room')
  } catch (error) {
    assert.equal(error.code, 'room_not_found')
  }
  assert.deepEqual(store.readBroadcastPage({ roomId: alice.broadcastRoomId, afterSeq: 0, limit: 10 }).map(row => row.text), ['a public line the viewer may see'])
  store.close()
})

test('unreachable, reconnecting, and replay: a dropped stream resumes by Last-Event-ID without losing a message', async t => {
  const dataDir = makeDataDir(t)
  const viewerToken = loadOrCreateViewerToken(dataDir)
  const server = await startTestServer(t, dataDir)
  const alice = await connectSession(server.port, dataDir, 'Alice')
  const mint = await mintViewerCookie(server.port, viewerToken)
  const cookie = cookieHeaderOf(mint.headers['set-cookie'][0])
  const eventsPath = `/viewer/api/rooms/${alice.broadcastRoomId}/events`

  const first = await openEventStream(t, server.port, eventsPath, cookie)
  await waitForEvent(first, 'presence', 5000, 'initial presence')
  const firstSend = await alice.send(alice.broadcastRoomId, 'replay-1', 'seen before the drop')
  assert.equal(firstSend.status, 200)
  const firstMessage = await waitForMatchingEvent(
    first,
    'message',
    event => { try { return JSON.parse(event.data).client_message_id === 'replay-1' } catch { return false } },
    5000,
    'the first message should arrive',
  )
  const lastSeq = Number(firstMessage.id)

  // The drop: the viewer's connection dies (a browser would reconnect on
  // its own — the retry hint is on the wire).
  first.req.destroy()
  await SLEEP(100)

  // While disconnected, the room keeps working.
  await alice.send(alice.broadcastRoomId, 'replay-2', 'sent while the viewer was away')
  await alice.send(alice.broadcastRoomId, 'replay-3', 'and this one too')

  // RECONNECTING → the resumed stream carries exactly the missed messages,
  // in order, from the Last-Event-ID cursor.
  const resumed = await openEventStream(t, server.port, eventsPath, {
    ...cookie,
    'last-event-id': String(lastSeq),
  })
  assert.equal(resumed.status, 200)
  await waitForEvent(resumed, 'presence', 5000, 'resumed stream presence')
  const resumedMessages = resumed.events
    .filter(event => event.event === 'message')
    .map(event => JSON.parse(event.data))
  assert.deepEqual(
    resumedMessages.map(row => row.client_message_id),
    ['replay-2', 'replay-3'],
  )

  // A junk resume cursor is the API's coded cursor refusal, not a stream.
  const junkCursor = await request(server.port, 'GET', eventsPath, {
    headers: { ...cookie, 'last-event-id': 'banana' },
  })
  assert.equal(junkCursor.status, 400)
  assert.equal(junkCursor.json().error.code, 'invalid_cursor')

  // UNREACHABLE: with the server stopped, the viewer's endpoint refuses at
  // the connection — unreachable is observed, never rendered as "everyone
  // offline".
  const port = server.port
  await server.close()
  const failure = await new Promise(resolvePromise => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path: '/viewer/boot.json', agent: false }, () => {
      resolvePromise('answered')
    })
    req.on('error', error => resolvePromise(error.code))
    req.end()
  })
  assert.equal(failure, 'ECONNREFUSED')
})

test('token-rotation: the old cookie cannot open anything after rotation, and the new token reopens the room', async t => {
  const dataDir = makeDataDir(t)
  const viewerToken = loadOrCreateViewerToken(dataDir)
  const server = await startTestServer(t, dataDir)
  const alice = await connectSession(server.port, dataDir, 'Alice')

  const mint = await mintViewerCookie(server.port, viewerToken)
  const oldCookie = cookieHeaderOf(mint.headers['set-cookie'][0])
  const live = await openEventStream(
    t,
    server.port,
    `/viewer/api/rooms/${alice.broadcastRoomId}/events`,
    oldCookie,
  )
  assert.equal(live.status, 200)
  await waitForEvent(live, 'presence', 5000, 'the pre-rotation stream opens')
  live.req.destroy()

  await rotateViewerToken(dataDir)

  // The post-rotation world, on every viewer surface: 401 — the observed
  // cause the viewer maps to its token-rotation state.
  for (const path of ['/viewer/boot.json', `/viewer/api/rooms/${alice.broadcastRoomId}/events`, '/viewer/']) {
    const refusal = await request(server.port, 'GET', path, { headers: oldCookie })
    assert.equal(refusal.status, 401, path)
    assert.equal(refusal.json().error.code, 'unauthorized', path)
  }

  // The operator re-mints from the rotated token; the room streams again.
  const rotatedToken = readFileSync(join(dataDir, 'viewer-token'), 'utf8').trim()
  const reMint = await mintViewerCookie(server.port, rotatedToken)
  assert.equal(reMint.status, 200)
  const reopened = await openEventStream(
    t,
    server.port,
    `/viewer/api/rooms/${alice.broadcastRoomId}/events`,
    cookieHeaderOf(reMint.headers['set-cookie'][0]),
  )
  assert.equal(reopened.status, 200)
  await waitForEvent(reopened, 'presence', 5000, 'the reopened stream answers')
})
