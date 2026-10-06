// The viewer surface (Stories 5.1 + 5.2, FR-18/HCI-5): the cookie-minting
// auth bridge, the real viewer-class verifier for the pipeline's viewer slot,
// the Broadcast-Room reads, and the one SSE stream carrying room + presence
// events. This module owns the viewer's mechanisms; server.mjs registers the
// four frozen routes and wires the pieces per server instance.
//
// THE AUTH BRIDGE (5.1): the viewer token — the 0600 `viewer-token` file in
// the shared data dir — is presented as a Bearer credential to exactly one
// route, GET /viewer/auth, which mints an HttpOnly, SameSite=Strict,
// Path=/viewer session cookie in exchange. EventSource cannot set custom
// headers, so the cookie bridge is the load-bearing step (FR-18: "never
// revert to query-string tokens"): the browser carries the cookie on every
// subsequent viewer request automatically, and the credential never rides a
// URL. The cookie value is an independent 256-bit random value — never the
// token itself — and the registry holds only its SHA-256 digest.
//
// THE VERIFIER (5.1): the pipeline's viewer class runs this module's verifier
// in the viewer slot Story 1.3 reserved; the session verifier slot never sees
// a viewer request and vice versa, so viewer credentials are structurally
// invalid on every other route class and session credentials on every viewer
// route. The one exception is /viewer/auth itself: the auth stage passes it
// through (the verifier returns undefined for it) and the handler performs
// the one Bearer check it exists for — the same discipline as the pre-auth
// class, whose credential routes perform their own checks inside the handler.
//
// ROTATION (5.1): both the mint and every cookie verification re-read the
// token file per request (the read-only reader below — the HTTP surface never
// creates or rewrites the file), and every cookie remembers the token digest
// it was minted under. A rotation — `agent-room viewer rotate`, the operator
// CLI on the server host (AR-13, no operator HTTP route) — replaces the file
// atomically, so the old token refuses at its next mint and every
// outstanding cookie is invalid at its next presentation: the per-request
// read is the mechanism, exactly as the ban gate's per-request store read is,
// and no credential state in memory can go stale against the file.
//
// THE LIVE VIEW (5.2): DR-3 is resolved as ONE SSE stream per viewer session
// carrying both room-message events and presence snapshots — the browser
// opens a single EventSource and never polls. The stream is as gated as any
// route (cookie auth at the stage, broadcast-kind validation before the first
// byte) and extends the server's established bounded re-poll pattern: the
// handler wakes at LONGPOLL_POLL_INTERVAL_MS, reads the store for new
// messages (a short statement-level read, never a held read transaction),
// recomputes the live presence snapshot, and writes an SSE frame only when
// something changed — a committed message renders within
// VIEWER_FRESHNESS_SECONDS with room to spare, and the wake loop exits the
// moment the request closes. Direct Rooms are excluded by construction: the
// only read the viewer can name is the store's readBroadcastPage, which
// refuses every non-broadcast room with the same room_not_found a
// nonexistent id answers, and there is no fingerprint argument to widen it.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { openSync, readSync, closeSync, fstatSync, constants as fsConstants, lstatSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  APP_VERSION,
} from '../runtime.mjs'
import {
  LONGPOLL_POLL_INTERVAL_MS,
  SSE_BACKLOG_MAX_MESSAGES,
  SSE_KEEP_ALIVE_SECONDS,
  VIEWER_COOKIE_BYTES,
  VIEWER_COOKIE_NAME,
  VIEWER_COOKIE_PATH,
  VIEWER_SESSIONS_MAX,
  VIEWER_TOKEN_MAX_CHARS,
  VIEWER_TOKEN_PATTERN,
  WEB_ASSET_MAX_BYTES,
} from '../constants.mjs'
import { AgentRoomRuntimeError } from '../runtime.mjs'
import { HANDLER_STREAMED, reject } from './pipeline.mjs'
import { bearerTokenFromHeaders } from './session.mjs'

// The digest the cookie registry keys on (and the token digest a mint is
// remembered under): hashing the presented value and matching the digest has
// no byte-dependent early exit, the session registry's discipline.
function viewerDigest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex')
}

// Constant-time credential comparison; an equal-length dummy compare keeps
// the timing profile uniform across mismatched lengths (the local-token
// exchange's helper shape).
function credentialsMatch(presented, expected) {
  const left = Buffer.from(presented, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  if (left.length !== right.length) {
    timingSafeEqual(right, right)
    return false
  }
  return timingSafeEqual(left, right)
}

// The read-only viewer-token reader. The HTTP surface NEVER creates or
// rewrites the file (loadOrCreateViewerToken/rotateViewerToken are the
// operator-side paths): a missing or unusable file answers null, which both
// consumers map to the canonical unauthorized rejection with zero state
// change. One bounded, descriptor-validated read with O_NOFOLLOW, the
// local-token reader's discipline: symlinked, oversized, or mid-read-changed
// files refuse.
export function readViewerToken(dataDir) {
  const path = join(dataDir, 'viewer-token')
  let descriptor
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0))
  } catch {
    return null
  }
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile() || info.size < 1 || info.size > 4096) return null
    const bytes = Buffer.alloc(info.size)
    let offset = 0
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, offset)
      if (count === 0) break
      offset += count
    }
    if (offset !== bytes.length) return null
    const token = bytes.toString('utf8').trim()
    return VIEWER_TOKEN_PATTERN.test(token) ? token : null
  } catch {
    return null
  } finally {
    try { closeSync(descriptor) } catch { /* already closed */ }
  }
}

// The in-memory cookie registry: cookie-value digest → the viewer-token
// digest the cookie was minted under. No TTL of its own — the cookie is a
// browser session cookie, and its validity is exactly "still in the registry
// AND minted under the CURRENT token digest", so rotation and restart are
// wholesale invalidations by construction. Capacity is
// VIEWER_SESSIONS_MAX with oldest-inserted eviction (insertion-order Map,
// the session registry's sweep-then-evict discipline reduced to what a
// no-expiry registry needs).
export function createViewerSessionRegistry({ maxSessions = VIEWER_SESSIONS_MAX } = {}) {
  if (!Number.isSafeInteger(maxSessions) || maxSessions < 1) {
    throw new AgentRoomRuntimeError('invalid_argument', 'viewer maxSessions must be a positive safe integer')
  }
  const cookies = new Map()

  function issue(currentTokenDigest) {
    if (typeof currentTokenDigest !== 'string' || currentTokenDigest.length === 0) {
      throw new AgentRoomRuntimeError('invalid_argument', 'viewer issue requires the current token digest')
    }
    while (cookies.size >= maxSessions) {
      cookies.delete(cookies.keys().next().value)
    }
    const value = randomBytes(VIEWER_COOKIE_BYTES).toString('base64url')
    cookies.set(viewerDigest(value), { mintedFor: currentTokenDigest })
    return value
  }

  function verify(cookieValue, currentTokenDigest) {
    if (typeof cookieValue !== 'string' || cookieValue.length === 0 || cookieValue.length > VIEWER_TOKEN_MAX_CHARS) {
      return reject('unauthorized')
    }
    const digest = viewerDigest(cookieValue)
    const entry = cookies.get(digest)
    if (!entry) return reject('unauthorized')
    if (entry.mintedFor !== currentTokenDigest) {
      // The token rotated under this cookie: the entry is dead weight now.
      cookies.delete(digest)
      return reject('unauthorized')
    }
    return { viewer: true }
  }

  return { issue, verify }
}

// The Set-Cookie wire form: HttpOnly (no script access), SameSite=Strict (no
// cross-site carry), Path-scoped to the viewer surface (the browser never
// presents it on any other path of this host). Deliberately a session cookie
// — no Expires/Max-Age — so closing the browser drops the credential; the
// rotation path invalidates it server-side regardless.
export function viewerCookieHeader(value) {
  return `${VIEWER_COOKIE_NAME}=${value}; Path=${VIEWER_COOKIE_PATH}; HttpOnly; SameSite=Strict`
}

// Parse the presented cookie jar down to the viewer cookie's value, or null.
// Only the exact name is read; everything else in the jar is ignored.
export function viewerCookieFromHeaders(headers) {
  const raw = headers?.cookie ?? headers?.Cookie
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') return null
  for (const pair of value.split(';')) {
    const separator = pair.indexOf('=')
    if (separator === -1) continue
    const name = pair.slice(0, separator).trim()
    if (name === VIEWER_COOKIE_NAME) {
      const cookieValue = pair.slice(separator + 1).trim()
      return cookieValue.length > 0 ? cookieValue : null
    }
  }
  return null
}

// The real viewer-class verifier (the default for the viewer slot once Story
// 5.1 lands; an injected verifier still overrides it, the session slot's
// default-plus-override pattern). /viewer/auth passes through so the bridge
// route can perform its own Bearer check; every other viewer route demands
// the cookie, resolved against the CURRENT token digest — which is why a
// rotation invalidates outstanding cookies at their next presentation.
export function createViewerVerifier({ registry, readToken } = {}) {
  if (!registry || typeof registry.issue !== 'function' || typeof registry.verify !== 'function') {
    throw new AgentRoomRuntimeError('invalid_argument', 'createViewerVerifier requires a viewer session registry')
  }
  if (typeof readToken !== 'function') {
    throw new AgentRoomRuntimeError('invalid_argument', 'createViewerVerifier requires a readToken function')
  }
  return context => {
    if (context?.route?.path === '/viewer/auth') return undefined
    const cookie = viewerCookieFromHeaders(context?.headers)
    if (cookie === null) return reject('unauthorized')
    const current = readToken()
    if (current === null) return reject('unauthorized')
    return registry.verify(cookie, viewerDigest(current))
  }
}

// Security headers on EVERY viewer response — HTML, JSON, and the SSE stream
// alike. The CSP is the retired v0.1 daemon's strict profile (default-src
// 'self', no inline script, no remote origins, no framing): all text renders
// inert because nothing but same-origin static assets can execute and the
// app builds its DOM exclusively through createElement/textContent. The
// Referrer-Policy is the negative AC's third leg: no viewer page can leak a
// credential-bearing URL to anyone because (a) no credential ever travels in
// a URL and (b) no referrer ever leaves the page.
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

export function applyViewerSecurityHeaders(response) {
  response.setHeader('Content-Security-Policy', VIEWER_CSP)
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('X-Frame-Options', 'DENY')
}

// The bridge route's credential check + mint (the handler performs the one
// check the pass-through exists for). Bearer only — a credential in the
// query string is structurally impossible here: the route's frozen field set
// is empty, so ?token=… is an unknown_field rejection in the field gate long
// before this handler. On success the cookie rides Set-Cookie via the
// context's response headers; the result body is deliberately empty (the
// cookie IS the result).
export function mintViewerSession(context) {
  const presented = bearerTokenFromHeaders(context.headers)
  if (presented === null) return reject('unauthorized')
  if (presented.length > VIEWER_TOKEN_MAX_CHARS || !VIEWER_TOKEN_PATTERN.test(presented)) {
    return reject('unauthorized')
  }
  const current = readViewerToken(context.dataDir)
  if (current === null || !credentialsMatch(presented, current)) return reject('unauthorized')
  const registry = context.viewerSessions
  const cookie = registry.issue(viewerDigest(current))
  context.responseHeaders = { 'Set-Cookie': viewerCookieHeader(cookie) }
  return null
}

// The static viewer surface: exact-name whitelist over the web root, the
// retired daemon's serving discipline (bounded regular non-symlink files
// only). /viewer/boot.json is generated, not a file: the one descriptor a
// cookie-authenticated viewer needs (realm id + Broadcast Room id + version,
// the GET /api/status projection) — the viewer surface has no enumeration
// route and never learns a Direct Room id from anything.
const VIEWER_ASSET_TYPES = Object.freeze({
  'index.html': 'text/html; charset=utf-8',
  'app.js': 'text/javascript; charset=utf-8',
  'styles.css': 'text/css; charset=utf-8',
})

export function serveViewerSurface(context) {
  const pathname = context.path
  if (pathname === '/viewer/boot.json') {
    const broadcastRoom = context.store.findBroadcastRoom()
    if (broadcastRoom === null) {
      throw new AgentRoomRuntimeError('realm_bootstrap_incomplete', 'the realm Broadcast Room is missing from the store')
    }
    return {
      realm_id: context.store.getRealmId(),
      version: APP_VERSION,
      broadcast_room_id: broadcastRoom.id,
    }
  }
  const assetName = pathname === '/viewer/' ? 'index.html' : pathname.slice('/viewer/'.length)
  const contentType = VIEWER_ASSET_TYPES[assetName]
  if (contentType === undefined) return reject('route_not_found')
  const path = join(context.webRoot, assetName)
  const info = lstatSync(path, { throwIfNoEntry: false })
  if (!info || info.isSymbolicLink() || !info.isFile() || info.size > WEB_ASSET_MAX_BYTES) {
    return reject('route_not_found')
  }
  // The asset response is written here (the envelope stands down): the
  // security headers are already set on the response object by the dispatch;
  // Content-Type and the no-store discipline join them before the body.
  context.response.setHeader('Content-Type', contentType)
  context.response.setHeader('Cache-Control', 'no-store')
  context.response.end(readFileSync(path))
  return HANDLER_STREAMED
}

// Strict non-negative integer for the SSE cursor header; junk is a coded
// invalid_cursor, the API's cursor discipline.
function lastEventIdHeader(headers) {
  const raw = headers?.['last-event-id']
  const value = Array.isArray(raw) ? raw[0] : raw
  if (value === undefined || value === null || value === '') return { value: 0 }
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    return { error: reject('invalid_cursor', 'last-event-id must be an integer') }
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return { error: reject('invalid_cursor', 'last-event-id must be an integer') }
  }
  return { value: parsed }
}

function sleep(ms) {
  return new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })
}

// The one SSE stream (Story 5.2, DR-3): room-message events (`event: message`
// with `id: <seq>`) and presence snapshots (`event: presence`) over a single
// text/event-stream response. Validations that must answer as JSON errors
// (room_not_found for a Direct Room, invalid_cursor for junk Last-Event-ID)
// run BEFORE the first byte; from the 200 on, the response is an event
// stream. The loop wakes at LONGPOLL_POLL_INTERVAL_MS — the long-poll read's
// own bounded re-poll pattern, no held read transaction — writes each new
// broadcast message, writes a presence snapshot whenever it changed, and
// emits a keep-alive comment at the SSE cadence. The stream ends when the
// client disconnects, the response faults, or the store closes.
export async function streamBroadcastEvents(context) {
  const cursorHeader = lastEventIdHeader(context.headers)
  if (cursorHeader.error) return cursorHeader.error

  const roomId = context.params?.id
  // The broadcast-kind validation MUST precede the stream headers: a Direct
  // Room answers the same coded room_not_found a nonexistent id answers, as
  // a normal JSON refusal (DM exclusion by construction, and no existence
  // leak either — the refusal never names the room's kind).
  context.store.readBroadcastPage({ roomId, afterSeq: 0, limit: 1 })

  const response = context.response
  const request = context.request
  const store = context.store
  const liveRegistry = context.liveSessionRegistry

  const state = { closed: false, lastWriteAt: Date.now() }
  const markClosed = () => { state.closed = true }
  request.once('close', markClosed)
  response.once('close', markClosed)
  response.once('error', markClosed)

  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    Connection: 'keep-alive',
    'Cache-Control': 'no-store',
  })

  // The reconnect hint: an EventSource that loses the stream reconnects on
  // its own and carries the last `id:` back as Last-Event-ID, which the
  // header parse above turns into the resume cursor — replay, not loss. The
  // three-second hint is the EventSource reconnect suggestion (the retired
  // v0.1 daemon wrote one the same way), not a bound: reconnect pacing
  // bounds live in the constants module, and the browser may reconnect
  // sooner or later without violating anything.
  response.write('retry: 3000\n\n')

  async function writeFrame(frame) {
    if (state.closed || response.destroyed || response.writableEnded) {
      state.closed = true
      return
    }
    if (response.write(frame)) {
      state.lastWriteAt = Date.now()
      return
    }
    // Backpressure: wait for the socket to drain (or close) before the
    // loop's next write — a slow viewer delays only itself.
    await new Promise(resolvePromise => {
      const onDrain = () => {
        response.off('close', onClose)
        state.lastWriteAt = Date.now()
        resolvePromise()
      }
      const onClose = () => {
        response.off('drain', onDrain)
        state.closed = true
        resolvePromise()
      }
      response.once('drain', onDrain)
      response.once('close', onClose)
    })
  }

  let cursor = cursorHeader.value
  let lastPresenceJson = null
  const keepAliveMs = SSE_KEEP_ALIVE_SECONDS * 1000

  try {
    // The initial presence snapshot: the viewer renders the presence list the
    // moment the stream opens (the loading state ends here), before any
    // message exists.
    await writePresence()

    while (!state.closed) {
      // Catch up fully each wake (bounded page reads, cursor advances until
      // the log is drained), then re-check presence and liveness.
      for (;;) {
        const page = store.readBroadcastPage({ roomId, afterSeq: cursor, limit: SSE_BACKLOG_MAX_MESSAGES })
        if (page.length === 0) break
        for (const message of page) {
          await writeFrame(`id: ${message.seq}\nevent: message\ndata: ${JSON.stringify(message)}\n\n`)
          cursor = message.seq
        }
        if (state.closed) break
      }
      if (state.closed) break
      await writePresence()
      if (state.closed) break
      const keepAliveDue = state.lastWriteAt + keepAliveMs - Date.now()
      if (keepAliveDue <= 0) {
        await writeFrame(': keepalive\n\n')
        if (state.closed) break
      }
      await sleep(Math.max(1, Math.min(LONGPOLL_POLL_INTERVAL_MS, keepAliveDue)))
    }
  } catch (error) {
    // A store closing under the stream (or any other internal fault) ends the
    // stream: one bounded stderr line, the socket closed. Nothing is written
    // as a JSON envelope here — the response is already an event stream.
    state.closed = true
    const detail = error instanceof AgentRoomRuntimeError
      ? `${error.code}: ${error.message}`
      : 'unclassified internal failure'
    process.stderr.write(`agent-room-server: viewer stream ended: ${detail.slice(0, 300)}\n`)
  } finally {
    if (!response.writableEnded && !response.destroyed) response.end()
  }

  async function writePresence() {
    const presence = liveRegistry.presenceSnapshot({
      includeOffline: true,
      claimsReader: (windowMs, nowMs) => store.recentClaims(windowMs, nowMs),
    })
    const presenceJson = JSON.stringify(presence)
    if (presenceJson === lastPresenceJson) return
    lastPresenceJson = presenceJson
    await writeFrame(`event: presence\ndata: ${presenceJson}\n\n`)
  }

  return HANDLER_STREAMED
}
