// HTTP API host (Story 1.3): the one versioned door for Stories 1.4-1.8.
// Binds loopback only (AD-10: Local Mode is configuration), bootstraps the
// realm on open (AD-14), dispatches every request through the one fixed
// middleware pipeline by route class (AD-7), serves the unauthenticated
// GET /health liveness route, and records {pid, port, version} in runtime.json
// atomically at 0600 after the listener is live (the loser-attach contract
// Story 1.4's ensureServer builds on).
//
// Dispatch rules: the protocol gate covers the whole /api/ prefix BEFORE route
// matching, and every /api/* response — including gate rejections and
// internal-fallback errors — echoes Agent-Room-Protocol: 1; viewer and health
// responses carry no echo (protocol-exempt classes). Unknown paths answer 404
// route_not_found. Statuses are never hard-coded: every error status derives
// from reject()/PUBLIC_ERROR_STATUS. Handlers live here: GET /health; the
// Story 1.4 local credential path — POST /api/auth/local exchanges the
// shared-data-dir local token (Bearer) plus the installation's public key
// (Local Mode auto-enrollment, additive AD-8 amendment) for a session bound
// to that key's fingerprint; the Story 1.5 session connect surface —
// POST/PATCH/DELETE /api/session bind, rename, and release the session's
// Chat ID against the live-session registry (server/core/session-registry.mjs)
// and the durable chat_id_claims index in the store; the Story 1.6
// presence surface — GET /api/presence assembles the online and
// offline-recently groups over the live registry and the claims index, and
// GET /api/status answers {realm_id, version, broadcast_room_id} for FR-21
// and the Story 1.8 checkpoint; and the Story 1.7 conversation surface —
// POST /api/rooms/direct resolves a chat id through the durable claims index
// (zero claims answer chat_id_not_found; several answer ambiguous_chat_id
// with the candidates list riding the error envelope; target_fingerprint
// completes disambiguation — never a guess; self-DM is refused) and opens
// the idempotent pair room, GET /api/rooms/:id/messages long-polls the
// durable log (a bounded in-process wait loop re-polling the store — no open
// read transaction while waiting; a deadline return is a normal
// possibly-empty page carrying next_after_seq and head_seq), and
// POST /api/rooms/:id/messages appends idempotently (status committed, or
// the coded client_message_id_conflict; the sender attribution always comes
// from the session token's live Chat ID, never from the caller's hands).
// Liveness is one mechanism: the actor-class
// auth stage's sliding TTL refresh and the presence touch are the same event
// (touch with the 1.5 persist pattern on every authenticated request) — no
// dedicated heartbeat surface exists server-side; the 60 s client heartbeat
// cadence belongs to the Story 1.7 adapter and is only a constant here. The
// sliding 12 h session TTL is provisional per DR-2 (ratified at Story 4.1).
// The actor-class auth stage runs the real session verifier from session.mjs
// (the 1.3 reject-all default remains only as the pipeline's structural
// fallback). Every other frozen AD-8 route stays unregistered (404
// route_not_found behind the gates).

import { createServer } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import { readFileSync, realpathSync, unlinkSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  APP_VERSION,
  AgentRoomRuntimeError,
  assertSupportedRuntime,
  atomicWriteJson,
  runtimeRecordPath,
  sharedDataDirectory,
} from '../runtime.mjs'
import {
  CHAT_ID_INVALID_MESSAGE,
  CLAIMS_TTL_MS,
  CLIENT_TYPES,
  LONGPOLL_POLL_INTERVAL_MS,
  PRESENCE_TTL_MS,
  PRUNE_INTERVAL_MS,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  PUBLIC_ERROR_STATUS,
  READ_HOLD_MAX_MS,
  READ_PAGE_DEFAULT,
  READ_PAGE_MAX,
  chatIdForms,
} from '../constants.mjs'
import { openRoomLog } from '../store/room-log.mjs'
import { bootstrapRealm } from '../core/realm.mjs'
import { createLiveSessionRegistry } from '../core/session-registry.mjs'
import { fingerprintFromPublicKey } from '../keys.mjs'
import { ROUTE_TABLE, matchRoute, routeKey as routeKeyOf } from './routes.mjs'
import {
  ProtocolStage,
  assemblePipeline,
  errorEnvelope,
  internalDetailOf,
  reject,
  runPipeline,
} from './pipeline.mjs'
import { bearerTokenFromHeaders, createSessionRegistry, createSessionVerifier } from './session.mjs'
import { readLocalToken } from './local-token.mjs'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1'])
const API_PREFIX = '/api/'
const SUCCESS_STATUS = 200

// Canonical Actor fingerprint shape (see ../keys.mjs): `sha256:` plus 64
// lowercase hex characters over the raw 32-byte public key. The same shape
// every module that handles fingerprints cites; target_fingerprint on the
// direct-open route must arrive in this form or the request is a shape
// rejection.
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/

const REGISTERED_HANDLERS = new Map()

// Story 1.4: one session registry per server process. The local credential
// path (auth/local) is the issuer; the actor-class auth stage is the
// verifier. In-memory by design — a restart clears sessions (Epic 2 owns
// continuity) — and the default for every startServer instance in this
// process, which is exactly the local-mode topology: one host process, one
// OS user. startServer({sessionRegistry}) overrides it so an injected
// verifier and its registry stay one coherent pair.
const SESSION_REGISTRY = createSessionRegistry()

// Story 1.5: one live Chat ID registry per server process, mirroring the
// session registry's default-plus-override pattern. Ephemeral by design — a
// restart clears it and it rebuilds as sessions reconnect; the durable
// (chat_id, actor_fingerprint, last_seen_at) ambiguity data lives in the
// store's chat_id_claims index. startServer({liveSessionRegistry}) overrides
// it so tests can isolate each server instance.
const LIVE_SESSION_REGISTRY = createLiveSessionRegistry()

// Constant-time credential comparison; an equal-length dummy compare keeps
// the timing profile uniform across mismatched lengths.
function credentialsMatch(presented, expected) {
  const left = Buffer.from(presented, 'utf8')
  const right = Buffer.from(expected, 'utf8')
  if (left.length !== right.length) {
    timingSafeEqual(right, right)
    return false
  }
  return timingSafeEqual(left, right)
}

// The installation's public key arrives as 32 raw bytes base64url-encoded —
// exactly the 43-character unpadded form. Shape only: presentation is NOT
// possession proof on the local path (no signature check under the OS-user
// boundary; challenge-response is Epic 4's remote path). Anything else is a
// request-shape rejection.
function rawInstallationPublicKey(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(value)) return null
  const raw = Buffer.from(value, 'base64url')
  return raw.length === 32 ? raw : null
}

// Register a handler for a frozen route. The key must exist in the route
// table exactly (method + path); the optional expectedClass must match the
// table's class for that route. Mistyped keys fail here, at registration
// time — never as a silent 404 at request time. Returns a deregister function.
export function registerHandler(key, handler, expectedClass) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new AgentRoomRuntimeError('invalid_argument', 'route key must be a non-empty string')
  }
  if (typeof handler !== 'function') {
    throw new AgentRoomRuntimeError('invalid_argument', 'handler must be a function')
  }
  const route = ROUTE_TABLE.find(entry => routeKeyOf(entry) === key)
  if (!route) {
    throw new AgentRoomRuntimeError('invalid_argument', `route key "${key}" is not in the frozen route table`)
  }
  if (expectedClass !== undefined && route.class !== expectedClass) {
    throw new AgentRoomRuntimeError(
      'invalid_argument',
      `route ${key} is class "${route.class}", not "${String(expectedClass)}"`,
    )
  }
  REGISTERED_HANDLERS.set(key, handler)
  return () => {
    if (REGISTERED_HANDLERS.get(key) === handler) REGISTERED_HANDLERS.delete(key)
  }
}

// Handlers contain no gate logic — every gate already ran in the pipeline — so
// a handler only computes its result.
registerHandler('GET /health', function health() {
  return { version: APP_VERSION }
})

// Story 1.4 local credential path (pre-auth class): the 0600 shared-data-dir
// local token, presented as a Bearer credential, plus the installation's
// public key are exchanged for a session bound to that key's fingerprint —
// Local Mode auto-enrollment under the OS-user boundary (AD-5: one session
// mechanism; the local token remains the bootstrap credential and is never a
// credential on any other route — it is not a session registry entry, and no
// other handler reads it).
//
// Zero state change on rejection, in both directions: the credential file is
// NEVER created or rewritten here (ensureServer guarantees it on the client
// side) — a missing or unusable file is a 401 local_token_invalid with the
// filesystem untouched — and issuance happens only after both the key shape
// and the constant-time token compare succeed. The auth stage passes pre-auth
// requests through, so this handler performs the one credential check it
// exists for.
registerHandler('POST /api/auth/local', function localAuth(context) {
  const presented = bearerTokenFromHeaders(context.headers)
  if (presented === null) return reject('unauthorized')
  const publicKey = rawInstallationPublicKey(context.body?.public_key)
  if (publicKey === null) {
    return reject('invalid_request', 'public_key is required: the raw 32-byte Ed25519 public key as base64url')
  }
  const localToken = readLocalToken(context.dataDir)
  if (!credentialsMatch(presented, localToken)) return reject('unauthorized')
  const registry = context.sessionRegistry ?? SESSION_REGISTRY
  const sessionToken = registry.issue(fingerprintFromPublicKey(publicKey))
  return { session_token: sessionToken }
})

// Story 1.5 session connect surface. The auth stage has already resolved the
// bearer token, so the principal carries the actor fingerprint (identity —
// always from the token, never the body) and the session token digest (the
// live registry's key; raw tokens never leave the session module).
function sessionPrincipalOf(context) {
  const session = context.session
  if (
    session
    && typeof session === 'object'
    && typeof session.sessionKey === 'string' && session.sessionKey.length > 0
    && typeof session.actorFingerprint === 'string' && session.actorFingerprint.length > 0
  ) {
    return session
  }
  return reject('unauthorized')
}

// POST /api/session and PATCH /api/session share one atomic bind (the
// registry's claim): collision check, then the durable claim write, then the
// memory commit — a refusal changes no state anywhere. POST is the connect
// verb: it binds the session's Chat ID for the session's lifetime, treats an
// exact re-bind as an idempotent refresh, and swaps immediately when the
// session re-binds to a different free name — rename-equivalence, documented
// and pinned by tests. PATCH is the rename verb: immediate, the old name
// freed in the same instant, refused with the original retained on a live
// collision. Neither verb ever rewrites history: messages keep their
// send-time chat ids in the store. Both echo the accepted chat_id (display
// form) alongside the session timestamps.
function bindSession(context) {
  const principal = sessionPrincipalOf(context)
  if (principal.ok === false) return principal
  // Field-reporting convention (matching 1.4's public_key): an absent or
  // empty chat_id is a request-shape rejection naming the missing field; a
  // malformed value falls through to the registry's DR-1 grammar gate.
  const chatId = context.body?.chat_id
  if (chatId === undefined || chatId === null || chatId === '') {
    return reject('invalid_request', 'chat_id is required: the Chat ID to claim for this session')
  }
  // Story 1.6 (additive spine amendment): the bind may declare the session's
  // client type from the closed set in the constants module. An omitted
  // declaration — or an explicit null, the chat_id convention for "not
  // provided" — keeps the row's existing type (a fresh row stays null: the
  // server never derives one; v0.1's MCP-derived naming is retired); a
  // present-but-invalid value is a request-shape refusal before any state
  // changes.
  const declaredRaw = context.body?.client_type
  const declaredType = declaredRaw === null ? undefined : declaredRaw
  if (declaredType !== undefined
    && (typeof declaredType !== 'string' || !CLIENT_TYPES.includes(declaredType))) {
    return reject('invalid_request', `client_type must be one of: ${CLIENT_TYPES.join(', ')}`)
  }
  const registry = context.liveSessionRegistry ?? LIVE_SESSION_REGISTRY
  const state = registry.claim({
    sessionKey: principal.sessionKey,
    chatId,
    actorFingerprint: principal.actorFingerprint,
    clientType: declaredType,
    // The durable claim write runs inside the registry's atomic claim step —
    // after the collision check, before the memory commit — timestamped by
    // the registry's own clock (one clock for live and durable recency), so
    // a refused claim never touches the store and a failed write never
    // leaves a phantom live row behind.
    persist: claimPayload => context.store.upsertChatIdClaim(claimPayload),
  })
  return {
    chat_id: state.chatId,
    connected_since: new Date(state.connectedSince).toISOString(),
    last_seen: new Date(state.lastSeen).toISOString(),
  }
}

registerHandler('POST /api/session', bindSession, 'actor')
registerHandler('PATCH /api/session', bindSession, 'actor')

// DELETE /api/session ends the session's live presence: the registry row is
// removed and the name is free for the next claimer immediately. The durable
// claim row stays — the (name, actor) pair remains the ambiguity data offline
// discovery resolves. Token invalidation is deliberately not performed
// (documented choice): the session registry entry is left to expire naturally
// (12 h sliding, DR-2) — the token re-authenticates to a nameless session,
// and connecting again re-claims.
registerHandler('DELETE /api/session', function disconnectSession(context) {
  const principal = sessionPrincipalOf(context)
  if (principal.ok === false) return principal
  const registry = context.liveSessionRegistry ?? LIVE_SESSION_REGISTRY
  registry.release(principal.sessionKey)
  return null
}, 'actor')

// Story 1.6 presence read (actor class, frozen route). The query allowlist
// already rejected everything but include_offline (a misspelling is
// unknown_field, an extra body invalid_request); the flag's value parses
// strictly: absent, bare (?include_offline), "true", or "false" — anything
// else throws a coded rejection, so the helper's answer is always a genuine
// boolean and can never be mistaken for one. The snapshot comes from the
// registry's one pure assembly: online rows within the presence TTL (stale
// rows are hidden from the view — a read never frees a name), and, when the
// flag is set, the separately-labeled offline_recently group from the durable
// claims index (most recent claim per Actor, online Actors and the reading
// session's own Actor excluded — no double-listing, no self-listing; claims
// hold no client type, so offline rows carry none). The reader's fingerprint
// is the token-derived principal, never a request field; the window and TTL
// constants live in the registry and store, never here.
function includeOfflineFlag(rawValue) {
  if (rawValue === undefined) return false
  if (rawValue === '' || rawValue === 'true') return true
  if (rawValue === 'false') return false
  throw new AgentRoomRuntimeError('invalid_request', 'include_offline must be true or false')
}

registerHandler('GET /api/presence', function presence(context) {
  const principal = sessionPrincipalOf(context)
  if (principal.ok === false) return principal
  const registry = context.liveSessionRegistry ?? LIVE_SESSION_REGISTRY
  return registry.presenceSnapshot({
    includeOffline: includeOfflineFlag(context.query?.include_offline),
    claimsReader: (windowMs, nowMs) => context.store.recentClaims(windowMs, nowMs),
    readerFingerprint: principal.actorFingerprint,
  })
}, 'actor')

// Story 1.6 registers the frozen GET /api/status (actor class): the stable
// realm id (AD-14, minted at first boot and converged by this store's
// bootstrap), the server version, and the implicit Broadcast Room's id —
// FR-21 needs them and the Story 1.8 checkpoint consumes them. The id is
// minted, never fabricated: a store without its Broadcast Room is a bootstrap
// invariant failure answered as a coded 500 (request_failed on the wire, one
// diagnosable stderr line), never a silent null.
registerHandler('GET /api/status', function status(context) {
  const broadcastRoom = context.store.findBroadcastRoom()
  if (broadcastRoom === null) {
    throw new AgentRoomRuntimeError('realm_bootstrap_incomplete', 'the realm Broadcast Room is missing from the store')
  }
  return {
    realm_id: context.store.getRealmId(),
    version: APP_VERSION,
    broadcast_room_id: broadcastRoom.id,
  }
}, 'actor')

// Story 1.7 conversation surface. Identity discipline (NFR-3) holds across
// all three handlers: the caller's Actor fingerprint and Chat ID come only
// from the session token (the principal and the session's live row) — no
// request field carries sender identity or authority.

// POST /api/rooms/direct: open (or reuse) the pair room with the agent whose
// Chat ID is chat_id. Resolution runs over the durable claims index
// (listClaimsForChatId, most recent first), deduplicated to the most recent
// claim per Actor:
//   0 claims (or none matching a supplied target_fingerprint)
//         → 404 chat_id_not_found — the miss is named, never guessed past;
//   several Actors (and no target_fingerprint)
//         → 409 ambiguous_chat_id whose error envelope carries candidates
//           [{fingerprint, last_seen}] — the caller picks one and retries
//           with target_fingerprint, which completes resolution;
//   exactly one resolved Actor
//         → the canonical pair room via the store's pair-key idempotency, so
//           concurrent opens (either argument order) converge on one room.
// The pair is computed with the CALLER's token-derived fingerprint; a
// resolved target equal to the caller is a self-DM, refused (v0.2 refuses
// self-DM per D13) with a distinct message on the invalid_request family.
// The response is deliberately minimal: room_id and kind — the pair room's
// full shape is the store's, not the wire's.
registerHandler('POST /api/rooms/direct', function directOpen(context) {
  const principal = sessionPrincipalOf(context)
  if (principal.ok === false) return principal
  const chatId = context.body?.chat_id
  if (chatId === undefined || chatId === null || chatId === '') {
    return reject('invalid_request', 'chat_id is required: the Chat ID of the agent to open a pair room with')
  }
  const forms = chatIdForms(chatId)
  if (forms === null) return reject('invalid_chat_id', CHAT_ID_INVALID_MESSAGE)
  const targetFingerprint = context.body?.target_fingerprint
  if (targetFingerprint !== undefined && targetFingerprint !== null
    && (typeof targetFingerprint !== 'string' || !FINGERPRINT_PATTERN.test(targetFingerprint))) {
    return reject('invalid_actor_id', 'target_fingerprint must be sha256: followed by 64 lowercase hex characters')
  }

  const claims = context.store.listClaimsForChatId(forms.display)
  const mostRecentPerActor = new Map()
  for (const claim of claims) {
    if (!mostRecentPerActor.has(claim.actor_fingerprint)) {
      mostRecentPerActor.set(claim.actor_fingerprint, claim)
    }
  }
  let candidates = [...mostRecentPerActor.values()]
  if (targetFingerprint !== undefined && targetFingerprint !== null) {
    candidates = candidates.filter(claim => claim.actor_fingerprint === targetFingerprint)
  }
  if (candidates.length === 0) {
    return reject(
      'chat_id_not_found',
      targetFingerprint !== undefined && targetFingerprint !== null
        ? `no claim by the requested fingerprint exists for the chat id "${forms.display}"`
        : `no actor has claimed the chat id "${forms.display}"`,
    )
  }
  if (candidates.length > 1) {
    return reject(
      'ambiguous_chat_id',
      `the chat id "${forms.display}" is claimed by ${candidates.length} actors; retry with one candidate fingerprint as target_fingerprint`,
      {
        candidates: candidates.map(claim => ({
          fingerprint: claim.actor_fingerprint,
          last_seen: claim.last_seen_at,
        })),
      },
    )
  }
  const target = candidates[0].actor_fingerprint
  if (target === principal.actorFingerprint) {
    return reject('invalid_request', 'opening a pair room with your own chat id is refused (self-DM)')
  }
  const room = context.store.openDirectRoom({
    actorFingerprints: [principal.actorFingerprint, target],
  })
  return { room_id: room.id, kind: room.kind }
}, 'actor')

// GET /api/rooms/:id/messages: the long-poll read. The page semantics are
// the frozen read contract: after_seq strictly-greater, page ≤ READ_PAGE_MAX,
// wait_ms a server hold capped at READ_HOLD_MAX_MS (anything above is refused
// 400 before any waiting). The wait is a bounded in-process loop that
// re-polls the store every LONGPOLL_POLL_INTERVAL_MS and sleeps between polls
// — the store read is a short statement-level read, never a held read
// transaction, so a held response holds no store lock. A message arriving at
// any point returns immediately; silence runs out to the deadline and returns
// a normal possibly-empty page — never 204, never an error. Every response
// carries next_after_seq (the cursor to resume from: the last message's seq,
// or the requested after_seq when the page is empty) and head_seq (the
// room's largest allocated seq). Member ACL reuses the store: readPage (and
// headSeq, ordered after it) enforce room_not_found / actor_not_member.
function integerQuery(value, name, { min, max, code }) {
  if (value === undefined || value === null || value === '') return { default: true, value: null }
  if (typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
    return { error: reject(code, `${name} must be an integer`) }
  }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
    return { error: reject(code, `${name} must be an integer from ${min} to ${max}`) }
  }
  return { value: parsed }
}

registerHandler('GET /api/rooms/:id/messages', async function readMessages(context) {
  const principal = sessionPrincipalOf(context)
  if (principal.ok === false) return principal

  const afterSeqQuery = integerQuery(context.query?.after_seq, 'after_seq', {
    min: 0, max: Number.MAX_SAFE_INTEGER, code: 'invalid_cursor',
  })
  if (afterSeqQuery.error) return afterSeqQuery.error
  const limitQuery = integerQuery(context.query?.limit, 'limit', {
    min: 1, max: READ_PAGE_MAX, code: 'invalid_limit',
  })
  if (limitQuery.error) return limitQuery.error
  const waitMsQuery = integerQuery(context.query?.wait_ms, 'wait_ms', {
    min: 0, max: READ_HOLD_MAX_MS, code: 'invalid_request',
  })
  if (waitMsQuery.error) return waitMsQuery.error

  const roomId = context.params?.id
  const afterSeq = afterSeqQuery.value ?? 0
  const limit = limitQuery.value ?? READ_PAGE_DEFAULT
  const waitMs = waitMsQuery.value ?? 0
  const deadline = Date.now() + waitMs

  for (;;) {
    const messages = context.store.readPage({
      roomId,
      actorFingerprint: principal.actorFingerprint,
      afterSeq,
      limit,
    })
    if (messages.length > 0 || Date.now() >= deadline) {
      const headSeq = context.store.headSeq(roomId, { actorFingerprint: principal.actorFingerprint })
      return {
        messages,
        next_after_seq: messages.length > 0 ? messages[messages.length - 1].seq : afterSeq,
        head_seq: headSeq,
      }
    }
    await new Promise(resolvePromise => { setTimeout(resolvePromise, LONGPOLL_POLL_INTERVAL_MS) })
  }
}, 'actor')

// POST /api/rooms/:id/messages: the idempotent append. The idempotency tuple
// (Actor fingerprint, room, client_message_id) lives in the store: a matching
// resend returns the original committed message (status committed, same seq —
// the outcome_unknown resolution), a conflicting payload surfaces the coded
// client_message_id_conflict. The attribution Chat ID is declared in the body
// (the frozen route vocabulary) but holds no authority: it must match the
// session's CURRENT live Chat ID — the name bound from the token side — and
// the value attributed to the message is always the live row's display form,
// so a session can never attribute a message to a name it does not hold.
function requiredString(value, name, detail) {
  if (value === undefined || value === null || value === '') {
    return { error: reject('invalid_request', detail ?? `${name} is required`) }
  }
  if (typeof value !== 'string') {
    return { error: reject('invalid_request', `${name} must be a string`) }
  }
  return { value }
}

registerHandler('POST /api/rooms/:id/messages', function appendMessageRoute(context) {
  const principal = sessionPrincipalOf(context)
  if (principal.ok === false) return principal

  const chatIdField = requiredString(context.body?.chat_id, 'chat_id',
    'chat_id is required: this session\'s connected Chat ID')
  if (chatIdField.error) return chatIdField.error
  const liveRegistry = context.liveSessionRegistry ?? LIVE_SESSION_REGISTRY
  const live = liveRegistry.lookup(principal.sessionKey)
  if (live === null) {
    return reject('invalid_request', 'the session has no connected Chat ID; connect before sending')
  }
  const forms = chatIdForms(chatIdField.value)
  if (forms === null) return reject('invalid_chat_id', CHAT_ID_INVALID_MESSAGE)
  if (forms.normalized !== live.chatIdNormalized) {
    return reject('invalid_request', 'chat_id does not match this session\'s connected Chat ID; the sender identity always comes from the session token')
  }

  const clientMessageIdField = requiredString(context.body?.client_message_id, 'client_message_id')
  if (clientMessageIdField.error) return clientMessageIdField.error
  const textField = requiredString(context.body?.text, 'text')
  if (textField.error) return textField.error
  const replyToSeq = context.body?.reply_to_seq

  const { message } = context.store.appendMessage({
    roomId: context.params?.id,
    actorFingerprint: principal.actorFingerprint,
    chatId: live.chatId,
    clientMessageId: clientMessageIdField.value,
    text: textField.value,
    replyToSeq,
  })
  return { status: 'committed', seq: message.seq, room_id: message.room_id }
}, 'actor')

const UNREGISTERED_ROUTE_HANDLER = () => reject('route_not_found')

function respondJson(response, status, payload, extraHeaders = {}) {
  const body = `${JSON.stringify(payload)}\n`
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...extraHeaders,
    'Content-Length': Buffer.byteLength(body),
  })
  response.end(body)
}

// Failure responses always take their status from the rejection outcome
// (derived from PUBLIC_ERROR_STATUS inside reject()) — never a literal here.
// Internal-fallback failures (undeclared codes, handler crashes) additionally
// write one bounded diagnosable stderr line; the wire body keeps the
// canonical fallback message, so internal detail and secrets never leak.
function respondFailure(response, failure, echo) {
  if (failure.code === 'request_failed') {
    const detail = typeof failure.internalDetail === 'string' && failure.internalDetail.length > 0
      ? failure.internalDetail
      : 'unclassified internal failure'
    process.stderr.write(`agent-room-server: ${detail}\n`)
  }
  respondJson(response, failure.status, errorEnvelope(failure), echo)
}

async function handleRequest(request, response, options) {
  let pathname = null
  let query = {}
  let queryKeys = []
  try {
    const url = new URL(request.url, 'http://agent-room.invalid')
    pathname = url.pathname
    query = Object.fromEntries(url.searchParams)
    queryKeys = [...url.searchParams.keys()]
  } catch {
    pathname = null
  }

  const isApiPath = pathname !== null && (pathname === '/api' || pathname.startsWith(API_PREFIX))
  const echo = isApiPath ? { [PROTOCOL_HEADER]: PROTOCOL_VERSION } : {}
  const context = {
    method: request.method,
    path: pathname,
    route: null,
    params: null,
    query,
    queryKeys,
    headers: request.headers,
    remoteAddress: request.socket.remoteAddress,
    encrypted: Boolean(request.socket.encrypted),
    bodyStream: request,
    dataDir: options.dataDir,
    sessionRegistry: options.sessionRegistry,
    liveSessionRegistry: options.liveSessionRegistry,
    store: options.store,
  }

  try {
    if (pathname === null) {
      respondFailure(response, reject('route_not_found'), {})
      return
    }

    // Protocol gate before route matching: any /api/* request without (or
    // with a mangled) Agent-Room-Protocol header is rejected before the route
    // table is consulted — with zero state change and the version echo.
    if (isApiPath) {
      const gateOutcome = await new ProtocolStage().process(context)
      if (gateOutcome) {
        respondFailure(response, gateOutcome, echo)
        return
      }
    }

    const matched = matchRoute(request.method, pathname)
    if (!matched) {
      respondFailure(response, reject('route_not_found'), echo)
      return
    }
    const { route, params } = matched
    context.route = route
    context.params = params

    const stages = assemblePipeline(route.class, {
      sessionVerifier: options.sessionVerifier,
      viewerVerifier: options.viewerVerifier,
    })
    const handler = REGISTERED_HANDLERS.get(routeKeyOf(route)) ?? UNREGISTERED_ROUTE_HANDLER
    const outcome = await runPipeline(stages, context, handler)

    if (outcome.refusal === true) {
      // Transport refusal (AD-7): refused at the connection, no envelope.
      response.destroy()
      return
    }
    if (outcome.ok) {
      respondJson(response, SUCCESS_STATUS, outcome, echo)
    } else {
      respondFailure(response, outcome, echo)
    }
  } catch (error) {
    // Internal fallback: undeclared error codes and handler crashes surface
    // as request_failed (500) with one diagnosable stderr line — the /api/*
    // echo and the canonical wire message survive every failure path.
    const failure = reject(error?.code, error?.message)
    failure.internalDetail = internalDetailOf(error)
    try {
      respondFailure(response, failure, echo)
    } catch {
      response.destroy()
    }
  }
}

export async function startServer({
  dataDir,
  host = '127.0.0.1',
  port = 0,
  sessionVerifier,
  viewerVerifier,
  sessionRegistry,
  liveSessionRegistry,
  claimsTtlMs = CLAIMS_TTL_MS,
  pruneIntervalMs,
  pruneClaims,
  presenceTtlMs = PRESENCE_TTL_MS,
} = {}) {
  // Runtime gate first: Node >= 24.15 / SQLite >= 3.51.3, diagnosable error.
  assertSupportedRuntime()
  if (typeof dataDir !== 'string' || dataDir.trim().length === 0) {
    throw new AgentRoomRuntimeError('data_directory_invalid', 'dataDir must be a non-empty path')
  }
  if (!LOOPBACK_HOSTS.has(host)) {
    throw new AgentRoomRuntimeError('invalid_argument', 'the agent-room server binds loopback only')
  }
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new AgentRoomRuntimeError('invalid_argument', 'port must be an integer from 0-65535')
  }
  // Malformed verifier or registry wiring fails at startup, never
  // per-request. When no session verifier is injected, the real Story 1.4
  // bearer-token check runs against the effective registry (the process
  // default, or the caller's sessionRegistry) so an injected verifier and
  // its registry stay one coherent pair (Story 1.3's reject-all default
  // remains the pipeline's structural fallback).
  if (sessionVerifier !== undefined && typeof sessionVerifier !== 'function') {
    throw new AgentRoomRuntimeError('invalid_argument', 'sessionVerifier must be a function when provided')
  }
  if (viewerVerifier !== undefined && typeof viewerVerifier !== 'function') {
    throw new AgentRoomRuntimeError('invalid_argument', 'viewerVerifier must be a function when provided')
  }
  if (sessionRegistry !== undefined
    && (typeof sessionRegistry !== 'object' || sessionRegistry === null
      || typeof sessionRegistry.issue !== 'function' || typeof sessionRegistry.verify !== 'function')) {
    throw new AgentRoomRuntimeError('invalid_argument', 'sessionRegistry must be a session registry (issue/verify) when provided')
  }
  if (liveSessionRegistry !== undefined
    && (typeof liveSessionRegistry !== 'object' || liveSessionRegistry === null
      || typeof liveSessionRegistry.claim !== 'function'
      || typeof liveSessionRegistry.release !== 'function'
      || typeof liveSessionRegistry.rename !== 'function'
      || typeof liveSessionRegistry.touch !== 'function'
      || typeof liveSessionRegistry.lookup !== 'function'
      || typeof liveSessionRegistry.presenceSnapshot !== 'function'
      || typeof liveSessionRegistry.clear !== 'function')) {
    throw new AgentRoomRuntimeError(
      'invalid_argument',
      'liveSessionRegistry must be a live-session registry (claim/release/rename/touch/lookup/presenceSnapshot/clear) when provided',
    )
  }
  if (!Number.isSafeInteger(claimsTtlMs) || claimsTtlMs <= 0) {
    throw new AgentRoomRuntimeError('invalid_argument', 'claimsTtlMs must be a positive safe integer')
  }
  if (pruneIntervalMs !== undefined && (!Number.isSafeInteger(pruneIntervalMs) || pruneIntervalMs <= 0)) {
    throw new AgentRoomRuntimeError('invalid_argument', 'pruneIntervalMs must be a positive safe integer when provided')
  }
  if (pruneClaims !== undefined && typeof pruneClaims !== 'function') {
    throw new AgentRoomRuntimeError('invalid_argument', 'pruneClaims must be a function when provided')
  }
  // The presence TTL tunes the online-visibility window of the process-default
  // live registry (an injected registry owns its own). It narrows or widens
  // the VIEW only — the claim lease stays the auth session TTL, so a tuned
  // presence TTL can never free a name.
  if (!Number.isSafeInteger(presenceTtlMs) || presenceTtlMs <= 0) {
    throw new AgentRoomRuntimeError('invalid_argument', 'presenceTtlMs must be a positive safe integer')
  }
  // implemented-flag enforcement: every frozen route marked implemented must
  // have a registered handler, and every registered handler must belong to a
  // marked route — a mismatch fails startup instead of silently 404ing a
  // route the wire contract promises.
  for (const route of ROUTE_TABLE) {
    const key = routeKeyOf(route)
    if (route.implemented === true && !REGISTERED_HANDLERS.has(key)) {
      throw new AgentRoomRuntimeError('invalid_argument', `route ${key} is marked implemented but has no registered handler`)
    }
    if (route.implemented !== true && REGISTERED_HANDLERS.has(key)) {
      throw new AgentRoomRuntimeError('invalid_argument', `route ${key} has a registered handler but is not marked implemented`)
    }
  }
  const effectiveRegistry = sessionRegistry ?? SESSION_REGISTRY
  // Story 1.6: the process-default live registry receives the operator-tuned
  // presence TTL; an injected registry is the caller's to configure.
  const effectiveLiveRegistry = liveSessionRegistry ?? createLiveSessionRegistry({ presenceTtlMs })

  const store = openRoomLog({ dataDir })

  // Story 1.6: one liveness mechanism. The actor-class auth stage already
  // slides the 12 h auth TTL on every successful verify (the documented
  // zero-state boundary exception); the same event now refreshes presence
  // liveness too — registry.touch with the 1.5 persist pattern, so the
  // durable claim row's last_seen_at advances with the in-memory row and no
  // dedicated heartbeat surface exists server-side (the 60 s ±10% client
  // heartbeat cadence belongs to the 1.7 adapter; its requests are simply
  // authenticated requests here). The touch fires only for a resolved
  // principal carrying the session key: a 401, a pre-auth/viewer/health
  // route (the session slot never runs there), and an unbound session (no
  // live row — touch returns null) all leave presence untouched, so viewer
  // and daemon activity can never create or refresh presence. A touch
  // failure propagates as the coded internal-fault fallback: the store is
  // the server's own state, and a failed liveness write must not silently
  // masquerade as freshness.
  const baseSessionVerifier = sessionVerifier ?? createSessionVerifier({ registry: effectiveRegistry })
  const effectiveSessionVerifier = context => {
    const outcome = baseSessionVerifier(context)
    if (
      outcome
      && typeof outcome === 'object'
      && !Array.isArray(outcome)
      && outcome.ok !== false
      && typeof outcome.sessionKey === 'string'
      && outcome.sessionKey.length > 0
    ) {
      effectiveLiveRegistry.touch(outcome.sessionKey, {
        persist: claimPayload => store.upsertChatIdClaim(claimPayload),
      })
    }
    return outcome
  }
  let httpServer = null
  let pruneTimer = null
  try {
    // First boot mints the realm id and the implicit Broadcast Room; restarts
    // and racing bootstraps on the same data dir converge on both (AD-14).
    bootstrapRealm(store)

    // Story 1.5 claims maintenance: prune the durable chat_id_claims index
    // once on boot, then lazily on the (overridable) interval. A tuned TTL
    // below the interval clamps the interval to half the TTL — pruning must
    // keep pace with expiry or rows would outlive their window for a full
    // cycle. The timer never holds the process open (unref) and is cleared on
    // close; a failed cycle is one bounded stderr line — the next interval
    // retries, the server keeps serving. `pruneClaims` is the injectable
    // seam (default: the store's prune at the tuned TTL) used by tests to
    // prove that containment.
    const effectivePruneIntervalMs = Math.min(
      pruneIntervalMs ?? PRUNE_INTERVAL_MS,
      Math.floor(claimsTtlMs / 2),
    )
    const pruneStep = pruneClaims ?? (() => store.pruneChatIdClaims(claimsTtlMs))
    const pruneSafely = () => {
      try {
        pruneStep()
      } catch (error) {
        process.stderr.write(`agent-room-server: chat id claims prune failed: ${internalDetailOf(error)}\n`)
      }
    }
    pruneSafely()
    pruneTimer = setInterval(pruneSafely, effectivePruneIntervalMs)
    pruneTimer.unref()

    httpServer = createServer((request, response) => {
      // handleRequest maps its own failures; this guard only contains a
      // failure of the failure path itself.
      handleRequest(request, response, {
        sessionVerifier: effectiveSessionVerifier,
        viewerVerifier,
        dataDir,
        sessionRegistry: effectiveRegistry,
        liveSessionRegistry: effectiveLiveRegistry,
        store,
      }).catch(() => {
        response.destroy()
      })
    })
    httpServer.on('clientError', (_error, socket) => socket.destroy())

    await new Promise((resolvePromise, rejectPromise) => {
      const onError = error => rejectPromise(error)
      httpServer.once('error', onError)
      httpServer.listen(port, host, () => {
        httpServer.removeListener('error', onError)
        resolvePromise()
      })
    })

    // Written only after the listener is live, so a reader of runtime.json can
    // attach to a server that already answers. A failure here (and any other
    // post-listen failure) must not leak the live listener: the catch below
    // closes it and releases the port before rejecting.
    const address = httpServer.address()
    const runtimeRecord = Object.freeze({
      pid: process.pid,
      port: address.port,
      version: APP_VERSION,
    })
    atomicWriteJson(runtimeRecordPath(dataDir), runtimeRecord)

    let closePromise = null
    const closeServerAndStore = async () => {
      if (pruneTimer !== null) clearInterval(pruneTimer)
      // A restart-within-process must find no stale names: when this server
      // owns the process-default live registry, its close drops every live
      // row (an injected registry is the caller's to manage).
      if (effectiveLiveRegistry === LIVE_SESSION_REGISTRY) LIVE_SESSION_REGISTRY.clear()
      await new Promise(resolvePromise => {
        httpServer.close(() => resolvePromise())
        httpServer.closeAllConnections?.()
      })
      store.close()
    }

    return Object.freeze({
      port: address.port,
      runtimeRecord,
      // Story 1.5/1.6 touch seam: one operation refreshing a live session's
      // in-memory recency AND its durable claim row's last_seen_at — the
      // same persist-callback pattern the connect/rename bind uses and the
      // actor-class post-auth path drives on every authenticated request
      // (one liveness mechanism). Exposed for callers that must advance a
      // session outside the request path, and for tests.
      touchSession(sessionKey) {
        return effectiveLiveRegistry.touch(sessionKey, {
          persist: claimPayload => store.upsertChatIdClaim(claimPayload),
        })
      },
      close() {
        if (!closePromise) {
          closePromise = (async () => {
            await closeServerAndStore()
            try {
              // Re-read the record and unlink only when this process owns it.
              const record = JSON.parse(readFileSync(runtimeRecordPath(dataDir), 'utf8'))
              if (record.pid === process.pid) unlinkSync(runtimeRecordPath(dataDir))
            } catch {
              // No owned runtime record (already gone, or another process owns it).
            }
          })()
        }
        return closePromise
      },
    })
  } catch (error) {
    if (pruneTimer !== null) clearInterval(pruneTimer)
    if (httpServer !== null) {
      try {
        await new Promise(resolvePromise => {
          httpServer.close(() => resolvePromise())
          httpServer.closeAllConnections?.()
        })
      } catch {
        // Preserve the startup error below.
      }
    }
    try {
      store.close()
    } catch {
      // Preserve the startup error.
    }
    throw error
  }
}

function launchedDirectly() {
  if (!process.argv[1]) return false
  try {
    return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
  } catch {
    return false
  }
}

// Direct-launch operator surface for the durable claim TTL: the same knob as
// startServer({claimsTtlMs}), read from the environment so a real operator
// can tune the 7-day window without code. Strictly validated — a positive
// finite integer in digits — and a present-but-invalid value never blocks a
// boot: one stderr warning line and the declared default.
export function claimsTtlMsFromEnv(env = process.env) {
  const raw = env?.AGENT_ROOM_CLAIMS_TTL_MS
  if (raw === undefined || String(raw).trim() === '') {
    return { claimsTtlMs: CLAIMS_TTL_MS }
  }
  const trimmed = String(raw).trim()
  if (!/^[0-9]+$/.test(trimmed)) {
    return {
      claimsTtlMs: CLAIMS_TTL_MS,
      warning: `ignoring invalid AGENT_ROOM_CLAIMS_TTL_MS "${raw}": must be a positive integer number of milliseconds; using the default ${CLAIMS_TTL_MS} ms`,
    }
  }
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value) || value <= 0) {
    return {
      claimsTtlMs: CLAIMS_TTL_MS,
      warning: `ignoring invalid AGENT_ROOM_CLAIMS_TTL_MS "${raw}": must be a positive integer number of milliseconds; using the default ${CLAIMS_TTL_MS} ms`,
    }
  }
  return { claimsTtlMs: value }
}

// Story 1.6 review: the same operator surface for the presence TTL —
// startServer({presenceTtlMs}) via AGENT_ROOM_PRESENCE_TTL_MS, identical
// strict validation and warning-fallback shape. (The 60 s client heartbeat
// cadence is the Story 1.7 adapter's surface — deliberately not tunable here.)
export function presenceTtlMsFromEnv(env = process.env) {
  const raw = env?.AGENT_ROOM_PRESENCE_TTL_MS
  if (raw === undefined || String(raw).trim() === '') {
    return { presenceTtlMs: PRESENCE_TTL_MS }
  }
  const trimmed = String(raw).trim()
  if (!/^[0-9]+$/.test(trimmed)) {
    return {
      presenceTtlMs: PRESENCE_TTL_MS,
      warning: `ignoring invalid AGENT_ROOM_PRESENCE_TTL_MS "${raw}": must be a positive integer number of milliseconds; using the default ${PRESENCE_TTL_MS} ms`,
    }
  }
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value) || value <= 0) {
    return {
      presenceTtlMs: PRESENCE_TTL_MS,
      warning: `ignoring invalid AGENT_ROOM_PRESENCE_TTL_MS "${raw}": must be a positive integer number of milliseconds; using the default ${PRESENCE_TTL_MS} ms`,
    }
  }
  return { presenceTtlMs: value }
}

// Run the runtime gate before any other work. Direct launches report one
// diagnosable line and exit 1 with no stack trace; importers get a catchable
// rejection so harnesses (tests/runtime.test.mjs entrypoint gates) can assert
// on the failure.
try {
  assertSupportedRuntime()
} catch (error) {
  if (launchedDirectly()) {
    process.stderr.write(`agent-room-server: ${error?.code ?? 'startup_failed'}: ${error?.message}\n`)
    process.exit(1)
  }
  throw error
}

// Direct launch: bind loopback with the shared data dir (Local Mode is
// configuration, AD-10) and stay up until signaled. Startup failures —
// including the runtime gate — report one diagnosable stderr line and exit 1.
if (launchedDirectly()) {
  const { claimsTtlMs, warning } = claimsTtlMsFromEnv()
  if (warning) process.stderr.write(`agent-room-server: ${warning}\n`)
  const { presenceTtlMs, warning: presenceWarning } = presenceTtlMsFromEnv()
  if (presenceWarning) process.stderr.write(`agent-room-server: ${presenceWarning}\n`)
  startServer({ dataDir: sharedDataDirectory(), claimsTtlMs, presenceTtlMs })
    .then(server => {
      let shuttingDown = false
      const shutdown = () => {
        if (shuttingDown) return
        shuttingDown = true
        server.close().then(
          () => process.exit(0),
          () => process.exit(1),
        )
      }
      process.on('SIGTERM', shutdown)
      process.on('SIGINT', shutdown)
    })
    .catch(error => {
      process.stderr.write(`agent-room-server: ${error?.code ?? 'startup_failed'}: ${error?.message}\n`)
      process.exit(1)
    })
}
