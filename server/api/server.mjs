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
// to that key's fingerprint — which, since Story 4.1, also records the
// presented key's fingerprint in the durable enrolled_actors registry; the
// Story 4.1 remote credential path — POST /api/auth/challenge issues a
// single-use nonce bound to the presented raw key (open to any well-formed
// key: Story 4.2's invite enrollment is itself a challenge-response
// consumer), and POST /api/auth/answer consumes the nonce before verifying
// (a failed answer burns it), verifies the Ed25519 signature against the
// challenge-recorded key, gates on the enrollment record, and issues a
// session token from the SAME registry the local path issues from; the
// Story 1.5 session connect surface —
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
// completes disambiguation — never a guess; same-Actor direct rooms are
// supported with the caller's fingerprint twice) and opens
// the idempotent pair room, GET /api/rooms/:id/messages long-polls the
// durable log (a bounded in-process wait loop re-polling the store — no open
// read transaction while waiting; a deadline return is a normal
// possibly-empty page carrying next_after_seq and head_seq), and
// POST /api/rooms/:id/messages appends idempotently (status committed, or
// the coded client_message_id_conflict; the sender attribution always comes
// from the session token's live Chat ID, never from the caller's hands); and
// the Story 2.2 enumeration — GET /api/rooms answers {rooms: [{room_id,
// kind}]}: every room the reading Actor belongs to, the Broadcast Room
// through its implicit AD-14 membership plus every Direct Room whose
// direct_members row names the Actor, in the store's deterministic
// created-then-id order (identity from the token; pair keys embed member
// fingerprints and titles, creators, and timestamps serve no discovery
// purpose, so the projection never carries them), and the Story 2.3
// one-time upgrade — startServer runs migrateV1InPlace before the store
// opens: a live v0.1 daemon named by runtime.json is stopped first, then a
// single BEGIN IMMEDIATE transaction reshapes the v0.1 file to schema v2 in
// place (see server/store/migrate-v1.mjs for the full mapping decisions).
// Liveness is one mechanism: the actor-class
// auth stage's sliding TTL refresh and the presence touch are the same event
// (touch with the 1.5 persist pattern on every authenticated request) — no
// dedicated heartbeat surface exists server-side; the 60 s client heartbeat
// cadence belongs to the Story 1.7 adapter and is only a constant here. The
// sliding 12 h session TTL stands as declared — ratified at Story 4.1 (DR-2
// resolved; see the spine's AD-5 amendment and Open Question 1).
// The actor-class auth stage runs the real session verifier from session.mjs
// (the 1.3 reject-all default remains only as the pipeline's structural
// fallback). Story 4.2 completes the frozen pre-auth surface: POST
// /api/auth/enroll is the invite-gated enrollment route — the presented
// ar_inv1_ token's SHA-256 digest names a row the operator minted, the
// presented raw public key derives the enrolled fingerprint, and the Ed25519
// signature over the exact token bytes is the possession proof, validated
// inside the store's single BEGIN IMMEDIATE enrollment transaction before
// any use is consumed (atomic, race-safe, lost-response retries reattach
// without consuming). The budgets stage paces the route at 5/min per client
// identity (burst 5) through the minimal fixed-window limiter; forwarded
// addresses are trusted only when the operator configured trustedProxy.
// Story 4.4 completes the budget stage with the four rate gates (FR-16/
// FR-17): the per-Actor request budget (every authenticated request counts
// at admission — failed, replayed, and long-polls once) and the per-Actor
// send bucket on the send route (idempotency-aware: an exact retry — an
// existing (room, actor, client_message_id) tuple — is admitted free and
// consumes nothing, even from an empty bucket), both token buckets over
// operator-tunable floors (startServer overrides; the direct launch reads
// the AGENT_ROOM_SEND_TOKEN_* / AGENT_ROOM_REQUEST_BUDGET_* /
// AGENT_ROOM_DUPLICATE_WINDOW_MS env knobs), and the store's duplicate gate
// ordered after the idempotency lookup inside the same append transaction.
// Send answers now carry the full FR-17 status vocabulary: committed,
// duplicate_dropped (a 200 result naming original_seq), rate_limited (429 +
// retry_after_ms), client_message_id_conflict (the coded 409), with banned
// landed by Story 4.5 (the authz stage's per-request refusal of every
// session-authenticated request from a banned key, plus the enroll route's
// post-proof store gate; the long-poll loop re-checks the ban each poll
// iteration so an in-flight hold terminates within its window) and
// storage_low landed by Story 4.6 (the store's append-path admission gate —
// free space below the refuse reserve, or the disk-full write itself —
// answered by the send route as the 200 result {status:'storage_low'},
// never an acknowledgment; the operator reserves are startServer overrides
// plus the AGENT_ROOM_STORAGE_* env knobs for the direct launch, and the
// `agent-room capacity` command reports the filesystem against them).
// Story 4.7 completes FR-4's standalone transport half: startServer accepts
// tls: { cert, key } — the operator's PEM certificate chain and key as
// CONTENT strings, validated at startup (the certificate parses, the key
// parses, the pair matches — one coded invalid_argument before the listener
// exists, never a runtime handshake mystery) — and builds
// https.createServer({ cert, key }, handler) around the SAME handleRequest
// callback, so both TLS paths (this native face and an operator-managed
// reverse proxy) serve one handler structurally. The loopback-only bind
// refusal now applies exactly when no tls is given: plaintext remains
// loopback-only (AD-11); with operator TLS material the operator may bind
// any host, because nothing plaintext leaves the machine. The direct launch
// gains the strict topology env — AGENT_ROOM_HOST / AGENT_ROOM_PORT /
// AGENT_ROOM_TLS_CERT / AGENT_ROOM_TLS_KEY (paths to the PEM files, read
// through the bounded regular-file reader, both-or-neither): topology is
// STRICT where the tuning knobs warn-and-fall-back, because a junk value
// falling back would silently move where the server is reachable — junk
// fails startup with one coded stderr line, exit 1, and a non-loopback bind
// on the DEFAULT shared data dir draws one advisory line to use a dedicated
// AGENT_ROOM_DATA_DIR (one process, one realm, one data dir).

import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import {
  createPrivateKey,
  createPublicKey,
  timingSafeEqual,
  X509Certificate,
} from 'node:crypto'
import { readFileSync, realpathSync, unlinkSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  APP_VERSION,
  AgentRoomRuntimeError,
  assertSupportedRuntime,
  atomicWriteJson,
  regularPrivateFile,
  runtimeRecordPath,
  sharedDataDirectory,
} from '../runtime.mjs'
import {
  CHALLENGE_SIGNATURE_MAX_CHARS,
  CHALLENGE_SIGNATURE_PATTERN,
  CHAT_ID_INVALID_MESSAGE,
  CLAIMS_TTL_MS,
  CLIENT_TYPES,
  DUPLICATE_WINDOW_MS,
  FINGERPRINT_PATTERN,
  INVITE_TOKEN_CHARS,
  INVITE_TOKEN_PREFIX,
  INVITE_TOKEN_PATTERN,
  LONGPOLL_POLL_INTERVAL_MS,
  PRESENCE_TTL_MS,
  PRUNE_INTERVAL_MS,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  PUBLIC_ERROR_STATUS,
  READ_HOLD_MAX_MS,
  READ_PAGE_DEFAULT,
  READ_PAGE_MAX,
  REQUEST_BUDGET_BURST,
  REQUEST_BUDGET_PER_MINUTE,
  SEND_TOKEN_CAPACITY,
  SEND_TOKEN_REFILL_PER_SECOND,
  STORAGE_REFUSE_FREE_BYTES,
  STORAGE_WARN_FREE_BYTES,
  chatIdForms,
} from '../constants.mjs'
import { openRoomLog } from '../store/room-log.mjs'
import { resolveStorageThresholds, storageThresholdsFromEnv } from '../store/storage-gate.mjs'
import { migrateV1InPlace } from '../store/migrate-v1.mjs'
import { bootstrapRealm } from '../core/realm.mjs'
import { createLiveSessionRegistry } from '../core/session-registry.mjs'
import { fingerprintFromPublicKey, verifyWithRawPublicKey } from '../keys.mjs'
import { ROUTE_TABLE, matchRoute, routeKey as routeKeyOf } from './routes.mjs'
import {
  ProtocolStage,
  assemblePipeline,
  errorEnvelope,
  HANDLER_STREAMED,
  internalDetailOf,
  reject,
  runPipeline,
} from './pipeline.mjs'
import { bearerTokenFromHeaders, createSessionRegistry, createSessionVerifier } from './session.mjs'
import { createChallengeRegistry } from './challenge.mjs'
import { createEnrollRateLimiter } from './enroll-rate-limit.mjs'
import { createRateGates } from './rate-gates.mjs'
import { readLocalToken } from './local-token.mjs'
import {
  applyViewerSecurityHeaders,
  createViewerSessionRegistry,
  createViewerVerifier,
  mintViewerSession,
  readViewerToken,
  serveViewerSurface,
  streamBroadcastEvents,
} from './viewer.mjs'

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1'])
const API_PREFIX = '/api/'
const SUCCESS_STATUS = 200

// Story 5.2: the viewer's static assets (the v0.1 viewer shell, rebuilt for
// the cookie-authed live view) live at the plugin's web/ root beside the
// server tree. Serving stays whitelisted-name-only inside the viewer module;
// this is only where the directory resolves.
const DEFAULT_WEB_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'web')

const REGISTERED_HANDLERS = new Map()

// Story 1.4: one session registry per server process. The local credential
// path (auth/local) is the issuer; the actor-class auth stage is the
// verifier. In-memory by design — a restart clears sessions (Epic 2 owns
// continuity) — and the default for every startServer instance in this
// process, which is exactly the local-mode topology: one host process, one
// OS user. startServer({sessionRegistry}) overrides it so an injected
// verifier and its registry stay one coherent pair.
const SESSION_REGISTRY = createSessionRegistry()

// Story 4.1: one challenge registry per server process, mirroring the session
// registry's default-plus-override pattern. Both issuance paths — local and
// challenge — issue into the SAME session registry (AD-5: one mechanism, two
// paths); this registry holds only the pending nonces. In-memory by design —
// a restart invalidates every outstanding challenge while the durable
// enrollment record survives. startServer({challengeRegistry}) overrides it
// so tests can isolate each server instance.
const CHALLENGE_REGISTRY = createChallengeRegistry()

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
// boundary; possession is the challenge path's guarantee, Story 4.1). The
// same gate is the challenge route's key-shape check — issuing a nonce to a
// well-formed key is privilegeless. Anything else is a request-shape
// rejection.
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
//
// Story 4.1: the success path also records the presented key's fingerprint in
// the durable enrolled_actors registry — the record the challenge-answer
// route gates on. Zero wire change, zero new privilege: the local exchange
// already admitted the key under the OS-user boundary, and recording it turns
// that implicit fact into the durable registration reconnects re-prove
// against without re-enrolling (FR-3/FR-12; the INSERT ... DO NOTHING write
// keeps the first registration's timestamp). A rejected exchange still
// writes nothing.
registerHandler('POST /api/auth/local', function localAuth(context) {
  const presented = bearerTokenFromHeaders(context.headers)
  if (presented === null) return reject('unauthorized')
  const publicKey = rawInstallationPublicKey(context.body?.public_key)
  if (publicKey === null) {
    return reject('invalid_request', 'public_key is required: the raw 32-byte Ed25519 public key as base64url')
  }
  const localToken = readLocalToken(context.dataDir)
  if (!credentialsMatch(presented, localToken)) return reject('unauthorized')
  const fingerprint = fingerprintFromPublicKey(publicKey)
  context.store.enrollActor({ actorFingerprint: fingerprint, enrolledAt: new Date().toISOString() })
  const registry = context.sessionRegistry ?? SESSION_REGISTRY
  const sessionToken = registry.issue(fingerprint)
  return { session_token: sessionToken }
})

// Story 4.1 remote credential path (pre-auth class), the challenge half: a
// fresh single-use nonce bound to the presented raw key. Issuing a nonce is
// privilegeless — a random value bound to a key shape — so this route stays
// OPEN to any well-formed 32-byte public key, including keys no one has
// enrolled yet: Story 4.2's invite-gated enrollment is itself a
// challenge-response consumer (AD-5's "reconnects re-prove it" needs a
// possession-proof primitive that works for not-yet-enrolled keys). Minting
// a session is the privilege, and that is exactly where the answer route's
// enrollment gate sits. Shape only, same gate the local path uses; zero
// state change on rejection.
registerHandler('POST /api/auth/challenge', function challenge(context) {
  const publicKey = rawInstallationPublicKey(context.body?.public_key)
  if (publicKey === null) {
    return reject('invalid_request', 'public_key is required: the raw 32-byte Ed25519 public key as base64url')
  }
  const registry = context.challengeRegistry ?? CHALLENGE_REGISTRY
  return { nonce: registry.issue(publicKey) }
})

// Story 4.1 remote credential path (pre-auth class), the answer half: spend
// the nonce, verify possession against the CHALLENGE-RECORDED key (never a
// request field — the frozen field set carries no public_key to substitute
// with, so identity binds at challenge time), gate on the durable enrollment
// record, and only then issue a session from the SAME registry the local
// path issues from (AD-5: one session mechanism, two issuance paths — same
// sliding TTL, capacity, and revocation).
//
// The nonce is consumed BEFORE the signature is verified: the first answer
// attempt kills it whatever its outcome, so a failed answer cannot absorb
// signature guesses against one challenge and a replayed answer finds an
// empty slot. Every rejection here is zero-state: no session, no enrollment
// touch, no nonce resurrection.
registerHandler('POST /api/auth/answer', function answerChallenge(context) {
  const nonce = context.body?.nonce
  if (nonce === undefined || nonce === null || nonce === '') {
    return reject('invalid_request', 'nonce is required: the challenge nonce as issued')
  }
  if (typeof nonce !== 'string') {
    return reject('invalid_request', 'nonce must be a string')
  }
  const signature = context.body?.signature
  if (signature === undefined || signature === null || signature === '') {
    return reject('invalid_request', 'signature is required: the Ed25519 signature over the raw nonce bytes as base64url')
  }
  if (typeof signature !== 'string' || signature.length > CHALLENGE_SIGNATURE_MAX_CHARS) {
    return reject('invalid_request', `signature must be a base64url string of at most ${CHALLENGE_SIGNATURE_MAX_CHARS} characters`)
  }
  const registry = context.challengeRegistry ?? CHALLENGE_REGISTRY
  const rawKey = registry.consume(nonce)
  if (rawKey === null) return reject('challenge_invalid')
  // Canonical-form gate BEFORE decode (Story 4.1 review triage): the base64url
  // decoder silently skips interspersed invalid characters, so a decorated
  // spelling of the canonical 86 characters — which the length bound above
  // tolerates — would decode to the very bytes a canonical spelling carries
  // and verify. Only the exact canonical form is honored; anything else is a
  // signature rejection like any failed verification. The gate runs after the
  // consume (a presented answer burns its nonce whatever its outcome — the
  // no-grinding discipline), so a refused spelling cannot be retried against
  // the same challenge.
  if (!CHALLENGE_SIGNATURE_PATTERN.test(signature)) return reject('signature_invalid')
  // Verify over the raw nonce bytes — the decoded 32 random bytes the nonce
  // string carries — against the key the challenge was issued to.
  if (!verifyWithRawPublicKey(rawKey, Buffer.from(nonce, 'base64url'), Buffer.from(signature, 'base64url'))) {
    return reject('signature_invalid')
  }
  const fingerprint = fingerprintFromPublicKey(rawKey)
  if (!context.store.isActorEnrolled(fingerprint)) return reject('not_enrolled')
  const sessionRegistry = context.sessionRegistry ?? SESSION_REGISTRY
  return { session_token: sessionRegistry.issue(fingerprint) }
})

// Story 4.2 invite-gated enrollment (pre-auth class, the frozen route's last
// unimplemented row). The wire is three fields, none of them identity: the
// invite token (the operator's secret, shown to the invitee exactly once),
// the raw public key whose DERIVED fingerprint will be enrolled (identity is
// never claimed — there is no fingerprint field to forge), and the Ed25519
// signature over the exact token bytes — the possession proof. All gating is
// the store's ONE BEGIN IMMEDIATE transaction (unknown/revoked/expired →
// invite_invalid, proof failure → signature_invalid, spent invite →
// invite_exhausted, already-consumed pair → idempotent reattach), so a
// failed or raced attempt consumes nothing and exactly one contender
// commits. Success returns the derived fingerprint; the session itself is
// minted by the ALREADY-LIVE challenge→answer path, which this enrollment
// unlocks by writing the enrolled_actors row its gate reads (one session
// mechanism, two issuance paths — AD-5 unchanged).
//
// Shape gates mirror the answer route's discipline: a missing or malformed
// field is invalid_request naming the field; a present-but-non-canonical
// signature is signature_invalid (the base64url decoder must never fold a
// decorated spelling onto real signature bytes). Admission is paced by the
// budgets stage's fixed-window limiter — a rate_limited refusal happens
// before this handler and consumes nothing.
registerHandler('POST /api/auth/enroll', function enroll(context) {
  const inviteToken = context.body?.invite_token
  if (typeof inviteToken !== 'string' || !INVITE_TOKEN_PATTERN.test(inviteToken)) {
    return reject(
      'invalid_request',
      `invite_token is required: ${INVITE_TOKEN_PREFIX} followed by exactly ${INVITE_TOKEN_CHARS} base64url characters`,
    )
  }
  const publicKey = rawInstallationPublicKey(context.body?.public_key)
  if (publicKey === null) {
    return reject('invalid_request', 'public_key is required: the raw 32-byte Ed25519 public key as base64url')
  }
  const signature = context.body?.signature
  if (signature === undefined || signature === null || signature === '') {
    return reject('invalid_request', 'signature is required: the Ed25519 signature over the exact invite token bytes as base64url')
  }
  if (typeof signature !== 'string' || signature.length > CHALLENGE_SIGNATURE_MAX_CHARS) {
    return reject('invalid_request', `signature must be a base64url string of at most ${CHALLENGE_SIGNATURE_MAX_CHARS} characters`)
  }
  if (!CHALLENGE_SIGNATURE_PATTERN.test(signature)) return reject('signature_invalid')
  const outcome = context.store.enrollRemoteActor({
    inviteToken,
    rawPublicKey: publicKey,
    signature: Buffer.from(signature, 'base64url'),
  })
  return { fingerprint: outcome.fingerprint }
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
//
// POST alone accepts `replace_existing` (Story 6.4, the v0.2.0
// reconnect-recovery takeover): the ONE way a live holder's name is taken
// away, and only from the SAME Actor — the operator explicitly asks for the
// handoff, the server verifies the incumbent against its own rows, and the
// transfer is atomic (the durable write first, then the memory commit).
//
// The displaced session's authority ends WITH the handoff: its token stops
// authenticating (so it cannot take the name back by re-authenticating) and
// its key is fenced. Every request the displaced session had in flight is
// refused: the authorization stage refuses it before the server reads its
// body, and the pipeline's post-input revalidation refuses it directly
// before the handler, after the body has fully arrived — no handoff can
// interleave between that final check and the mutating handlers, which all
// commit synchronously (Story 7.1 closed the body-arrival window the
// release-gate review had executed).
//
// PATCH keeps the plain collision protection, and no automatic
// re-authentication ever carries the intent — a takeover is an explicit
// decision, never a side effect of a reconnect.
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
  // The takeover intent is a strict boolean: an absent field is false, a
  // present one must say exactly true or false. A malformed value is a
  // request-shape refusal BEFORE any state changes — never a truthy guess.
  const replaceRaw = context.body?.replace_existing
  let replaceExisting = false
  if (replaceRaw !== undefined && replaceRaw !== null) {
    if (typeof replaceRaw !== 'boolean') {
      return reject('invalid_request', 'replace_existing must be true or false')
    }
    replaceExisting = replaceRaw
  }
  const registry = context.liveSessionRegistry ?? LIVE_SESSION_REGISTRY
  // The incumbent: whoever holds this name right now (the live registry's
  // own answer, read before any change).
  const holder = typeof registry.holderOf === 'function' ? registry.holderOf(chatId) : null
  const heldByAnotherSession = holder !== null && holder.sessionKey !== principal.sessionKey
  let incumbent = null
  if (heldByAnotherSession) {
    const sameActor = holder.actorFingerprint === principal.actorFingerprint
    if (replaceExisting) {
      // The takeover. A session of a DIFFERENT Actor is never displaced —
      // and the refusal is the ordinary collision refusal, so the refused
      // caller learns nothing about who holds the name.
      if (!sameActor) return reject('chat_id_taken')
      if (typeof registry.transfer !== 'function') return reject('chat_id_taken')
      incumbent = holder.sessionKey
    } else if (
      sameActor
      && typeof context.sessionRegistry?.isLive === 'function'
      && context.sessionRegistry.isLive(holder.sessionKey) === false
    ) {
      // Re-auth recovery (Story 1.7): a client whose session token was
      // invalidated or expired re-authenticates and re-binds the SAME Chat
      // ID. The dead session's row still holds the name until its lease,
      // which would make the client permanently unrecoverable. When — and
      // only when — the current holder is the SAME Actor and that holder's
      // session token no longer authenticates, the row is released and the
      // name re-claimed. A live session (even of the same Actor) is never
      // displaced, and a different Actor never is.
      registry.release(holder.sessionKey)
    }
  }
  // The durable claim write runs inside the registry's atomic bind step —
  // after the collision check, before the memory commit — timestamped by
  // the registry's own clock (one clock for live and durable recency), so
  // a refused bind never touches the store and a failed write never
  // leaves a phantom live row behind.
  const persist = claimPayload => context.store.upsertChatIdClaim(claimPayload)
  const state = incumbent === null
    ? registry.claim({
      sessionKey: principal.sessionKey,
      chatId,
      actorFingerprint: principal.actorFingerprint,
      clientType: declaredType,
      persist,
    })
    : registry.transfer({
      sessionKey: principal.sessionKey,
      chatId,
      actorFingerprint: principal.actorFingerprint,
      clientType: declaredType,
      persist,
      incumbentSessionKey: incumbent,
    })
  // The handoff fence: the displaced session's authority ends HERE, not with
  // its next request. Its token stops authenticating (so it cannot re-bind
  // the name by re-authenticating) and its key is marked superseded. The
  // fence entry survives while any request of the displaced session is still
  // inside the admission→handler window (the pipeline pins each admitted
  // request's key), and every such request is refused — at the authorization
  // stage, or at the pipeline's post-input revalidation directly before the
  // handler. A registry without the fence primitive still performs the
  // transfer — the displaced session then simply loses its live row.
  const displaced = state.displacedSessionKey ?? null
  if (displaced !== null && typeof context.sessionRegistry?.supersede === 'function') {
    context.sessionRegistry.supersede(displaced)
  }
  return {
    chat_id: state.chatId,
    connected_since: new Date(state.connectedSince).toISOString(),
    last_seen: new Date(state.lastSeen).toISOString(),
    // True only when this bind displaced a live holder — the explicit
    // same-Actor takeover. It is a fact about THIS caller's own request
    // (the caller asked for the takeover and the server accepted it), never
    // information about anyone else's session.
    replaced: displaced !== null,
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

// Story 2.2 registers the frozen GET /api/rooms (actor class): the rooms the
// reading Actor belongs to. The store's membership query owns both halves of
// the truth — the Broadcast Room is listed for every Actor without consulting
// direct_members (implicit AD-14 membership; the review-adversarial H-fix
// pins that it is listed like any other room), and Direct Rooms appear only
// through the caller's own membership rows, so a room the Actor does not
// belong to can never answer. Identity comes only from the session token.
// The wire projection is deliberately minimal ({room_id, kind}, the same
// shape directOpen returns): pair_key embeds both member fingerprints, and
// title, created_by_fingerprint, and created_at serve no discovery purpose —
// they never leave the store layer.
registerHandler('GET /api/rooms', function listRooms(context) {
  const principal = sessionPrincipalOf(context)
  if (principal.ok === false) return principal
  const rooms = context.store.listRoomsForActor(principal.actorFingerprint)
  return {
    rooms: rooms.map(room => ({ room_id: room.id, kind: room.kind })),
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
// The pair is computed with the CALLER's token-derived fingerprint. A resolved
// target equal to the caller is a first-class same-Actor Direct Room (D14):
// the store keys it with the same fingerprint twice, so two local sessions can
// coordinate privately. The response is deliberately minimal: room_id and
// kind — the pair room's full shape is the store's, not the wire's.
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
  const room = context.store.openDirectRoom({
    // AD-6/D14: a same-Actor pair is represented by the same fingerprint
    // twice; the store's canonical pair key and membership insert converge it.
    actorFingerprints: target === principal.actorFingerprint
      ? [principal.actorFingerprint, principal.actorFingerprint]
      : [principal.actorFingerprint, target],
  })
  return { room_id: room.id, kind: room.kind }
}, 'actor')

// GET /api/rooms/:id/messages: the long-poll read. The page semantics are
// the frozen read contract: after_seq strictly-greater, page ≤ READ_PAGE_MAX,
// wait_ms a server hold capped at READ_HOLD_MAX_MS (anything above — or any
// non-integer junk, including an empty string — is refused before any
// waiting; the hold code is invalid_wait_ms). The wait is a bounded loop
// that re-polls the store and sleeps between polls, never past the deadline:
// the sleep clamps to the remaining time. The store read is a short
// statement-level read, never a held read transaction, so a held response
// holds no store lock. A message arriving at any point returns immediately;
// silence runs out to the deadline and returns a normal possibly-empty page —
// never 204, never an error. Every response carries next_after_seq (the
// cursor to resume from: the last message's seq, or the requested after_seq
// when the page is empty) and head_seq (the room's largest allocated seq).
// Member ACL reuses the store: readPage (and headSeq, ordered after it)
// enforce room_not_found / actor_not_member.
//
// Story 4.5: the ban gate is re-checked on EVERY poll iteration, not only
// at admission. The authz stage refuses an already-banned reader before the
// handler runs, but a ban that lands mid-hold must terminate the in-flight
// poll within its window — so the loop consults the same per-request store
// read each wake (one indexed lookup per iteration; the wake is never more
// than LONGPOLL_POLL_INTERVAL_MS away) and answers the coded `banned`
// refusal the moment the row appears. The termination rides the state the
// poll already checks — no connection is killed, and the poll never runs
// past its deadline.
function integerQuery(value, name, { min, max, code }) {
  if (value === undefined || value === null) return { default: true, value: null }
  if (value === '' || typeof value !== 'string' || !/^[0-9]+$/.test(value)) {
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
    min: 0, max: READ_HOLD_MAX_MS, code: 'invalid_wait_ms',
  })
  if (waitMsQuery.error) return waitMsQuery.error

  const roomId = context.params?.id
  const afterSeq = afterSeqQuery.value ?? 0
  const limit = limitQuery.value ?? READ_PAGE_DEFAULT
  const waitMs = waitMsQuery.value ?? 0
  const deadline = Date.now() + waitMs

  for (;;) {
    // Story 4.5: the per-iteration ban re-check (see the route comment). A
    // ban committed while this poll holds — by the operator CLI process,
    // visible here through the store on the very next wake — answers the
    // coded refusal instead of a page, within the hold window.
    // Story 7.1: the fence rides the same wake — a session displaced while
    // this poll held stops serving the displaced holder on the next wake,
    // instead of draining messages for a session whose authority ended.
    if (context.sessionRegistry?.isSuperseded?.(principal.sessionKey)) {
      return reject('unauthorized')
    }
    if (context.store.isActorBanned(principal.actorFingerprint)) {
      return reject('banned')
    }
    const messages = context.store.readPage({
      roomId,
      actorFingerprint: principal.actorFingerprint,
      afterSeq,
      limit,
    })
    const remainingMs = deadline - Date.now()
    if (messages.length > 0 || remainingMs <= 0) {
      const headSeq = context.store.headSeq(roomId, { actorFingerprint: principal.actorFingerprint })
      return {
        messages,
        next_after_seq: messages.length > 0 ? messages[messages.length - 1].seq : afterSeq,
        head_seq: headSeq,
      }
    }
    // The wake-up sleep never overshoots the deadline: it clamps to the
    // remaining hold time, so a response always lands within wait_ms.
    await new Promise(resolvePromise => {
      setTimeout(resolvePromise, Math.min(LONGPOLL_POLL_INTERVAL_MS, remainingMs))
    })
  }
}, 'actor')

// POST /api/rooms/:id/messages: the idempotent append. The idempotency tuple
// (Actor fingerprint, room, client_message_id) lives in the store, checked
// BEFORE the duplicate gate (Story 4.4's ordering, structural inside the
// store's single append transaction): a matching resend returns the original
// committed message (status committed, same seq — the outcome_unknown
// resolution), a conflicting payload surfaces the coded
// client_message_id_conflict. A NEW send whose byte-identical payload the
// same Actor repeated in the same room within the duplicate window is
// answered duplicate_dropped (a normal 200 result naming original_seq — an
// explicit notice, never an error, never a silent success; the store wrote
// nothing). The attribution Chat ID is declared in the body (the frozen route
// vocabulary) but holds no authority: it must match the session's CURRENT
// live Chat ID — the name bound from the token side — and the value
// attributed to the message is always the live row's display form, so a
// session can never attribute a message to a name it does not hold. The
// response status vocabulary is the FR-17 set in the constants module
// (SEND_STATUSES): committed and duplicate_dropped answer here as results;
// rate_limited answers from the budgets stage (429 + retry_after_ms);
// client_message_id_conflict answers as the coded 409; banned (Story 4.5's
// authz-stage refusal — a banned key's send never reaches this handler)
// answers as the coded 403; and storage_low (Story 4.6's append-gate
// refusal) answers here as the 200 result {status:'storage_low'} — the
// explicit, never-acknowledged notice that the store wrote nothing, mapped
// from the store's coded refusal in this handler because the condition
// belongs to the sender's actionable vocabulary (like duplicate_dropped),
// not to the error channel that would invite a retry against a full disk.
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

  // Story 4.6: the store's storage admission gate refuses below the refuse
  // reserve with the coded storage_low (or the disk-full write maps to the
  // same code). The route answers the FR-17 status as a 200 RESULT —
  // {status:'storage_low'} — never an error envelope and never an
  // acknowledgment: the store rolled back having written nothing, so there
  // is no seq to name and no commit to claim. The sender learns explicitly
  // that this exact attempt did not happen; a retry of the SAME
  // client_message_id after space returns commits normally, and a retry of
  // an ALREADY-committed message keeps resolving to its original below the
  // reserve (the store's idempotency lookup precedes the gate).
  let outcome
  try {
    outcome = context.store.appendMessage({
      roomId: context.params?.id,
      actorFingerprint: principal.actorFingerprint,
      chatId: live.chatId,
      clientMessageId: clientMessageIdField.value,
      text: textField.value,
      replyToSeq,
    })
  } catch (error) {
    if (error?.code === 'storage_low') {
      return { status: 'storage_low' }
    }
    throw error
  }
  if (outcome.duplicateDropped) {
    return {
      status: 'duplicate_dropped',
      original_seq: outcome.original.seq,
      room_id: outcome.original.room_id,
    }
  }
  return { status: 'committed', seq: outcome.message.seq, room_id: outcome.message.room_id }
}, 'actor')

// --- Story 5.1 + 5.2: the viewer surface (FR-18/HCI-5) --------------------------
//
// Four frozen routes, cookie-authenticated through the viewer verifier slot
// (the real cookie verifier is the slot's default once these routes land; an
// injected viewerVerifier still overrides it, the session slot's pattern).
// All are GET-only by the frozen table — there is no viewer write anywhere —
// and every response carries the viewer security headers (strict CSP,
// no-referrer, nosniff, DENY framing) applied at dispatch.

// GET /viewer/auth — the Bearer→cookie bridge. The auth stage passes this one
// route through the viewer verifier (the bridge is where the credential is
// PRESENTED), so the handler performs the one check it exists for: the
// presented Bearer must be the current viewer token, compared constant-time.
// Success mints an HttpOnly, SameSite=Strict, Path=/viewer session cookie
// whose value is an independent 256-bit random value (never the token); the
// result body is empty because the cookie IS the result. A credential in the
// query string is structurally impossible: the route's frozen field set is
// empty, so ?token=… dies in the field gate as unknown_field before this
// handler runs.
registerHandler('GET /viewer/auth', function viewerAuth(context) {
  return mintViewerSession(context)
}, 'viewer')

// GET /viewer/ (wildcard) — the static live view: the whitelisted assets
// (index.html, app.js, styles.css) from the plugin's web/ root plus the
// generated /viewer/boot.json descriptor (realm id + Broadcast Room id +
// version — the only discovery a cookie-authenticated viewer gets, and it
// names the Broadcast Room only). Any other path under /viewer/ is a coded
// route_not_found — no traversal, no listing, and Direct Room ids are
// learnable from nothing the viewer serves.
registerHandler('GET /viewer/', function viewerSurface(context) {
  return serveViewerSurface(context)
}, 'viewer')

// GET /viewer/api/rooms/:id/messages — the viewer's cursor page over the
// Broadcast Room log, the actor read contract's projection (messages,
// next_after_seq, head_seq) through the store's broadcast-only read: a
// Direct Room answers room_not_found exactly like a nonexistent id, and
// after_seq/limit keep the API's strict integer gates (bounded by
// READ_PAGE_MAX). No wait_ms — the live edge is the SSE stream's job.
registerHandler('GET /viewer/api/rooms/:id/messages', function viewerMessages(context) {
  const roomId = context.params?.id
  const afterSeqQuery = integerQuery(context.query?.after_seq, 'after_seq', {
    min: 0, max: Number.MAX_SAFE_INTEGER, code: 'invalid_cursor',
  })
  if (afterSeqQuery.error) return afterSeqQuery.error
  const limitQuery = integerQuery(context.query?.limit, 'limit', {
    min: 1, max: READ_PAGE_MAX, code: 'invalid_limit',
  })
  if (limitQuery.error) return limitQuery.error

  const afterSeq = afterSeqQuery.value ?? 0
  const limit = limitQuery.value ?? READ_PAGE_DEFAULT
  const messages = context.store.readBroadcastPage({ roomId, afterSeq, limit })
  return {
    messages,
    next_after_seq: messages.length > 0 ? messages[messages.length - 1].seq : afterSeq,
    head_seq: context.store.headSeq(roomId),
  }
}, 'viewer')

// GET /viewer/api/rooms/:id/events — THE one SSE stream (DR-3): room-message
// events and presence snapshots on a single text/event-stream response,
// cookie-gated at the stage like every viewer route. See
// server/api/viewer.mjs for the stream mechanics.
registerHandler('GET /viewer/api/rooms/:id/events', function viewerEvents(context) {
  return streamBroadcastEvents(context)
}, 'viewer')

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

async function handleRequest(request, response, options) {  let pathname = null
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
    request,
    response,
    dataDir: options.dataDir,
    webRoot: options.webRoot,
    sessionRegistry: options.sessionRegistry,
    liveSessionRegistry: options.liveSessionRegistry,
    challengeRegistry: options.challengeRegistry,
    viewerSessions: options.viewerSessions,
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
    // Story 5.1: every viewer response — HTML asset, JSON result, JSON
    // refusal, or SSE stream — carries the strict viewer security headers.
    if (route.class === 'viewer') applyViewerSecurityHeaders(response)

    const stages = assemblePipeline(route.class, {
      sessionVerifier: options.sessionVerifier,
      viewerVerifier: options.viewerVerifier,
      enrollRateLimiter: options.enrollRateLimiter,
      trustedProxy: options.trustedProxy,
      requestBudgetGate: options.requestBudgetGate,
      sendBucketGate: options.sendBucketGate,
    })
    const handler = REGISTERED_HANDLERS.get(routeKeyOf(route)) ?? UNREGISTERED_ROUTE_HANDLER
    const outcome = await runPipeline(stages, context, handler)

    if (outcome === HANDLER_STREAMED) {
      // The SSE handler (and only it) wrote the response itself; the JSON
      // envelope must stand down.
      return
    }
    if (outcome.refusal === true) {
      // Transport refusal (AD-7): refused at the connection, no envelope.
      response.destroy()
      return
    }
    if (outcome.ok) {
      // Handler-declared headers (the auth bridge's Set-Cookie) ride the
      // success response; a clobbering attempt on the echo or the fixed
      // no-store/Content-Type pair is impossible — these extras are written
      // only by viewer handlers on viewer routes, and last-writer-wins in
      // writeHead keeps the envelope's own fields authoritative.
      respondJson(response, SUCCESS_STATUS, outcome, { ...echo, ...(context.responseHeaders ?? {}) })
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

// Story 4.7: the operator's TLS material for FR-4's standalone path —
// validated ENTIRELY at startup, before any listener exists. https.createServer
// would otherwise accept malformed PEM silently and fail at the first
// handshake (a runtime mystery a VPS operator cannot diagnose), and a
// mismatched pair would surface as exactly that handshake mystery. Here:
// the certificate parses, the key parses, and the pair matches — one coded
// invalid_argument per failure, no key or certificate bytes in any message.
function validatedTlsMaterial(tls) {
  if (typeof tls !== 'object' || tls === null
    || typeof tls.cert !== 'string' || tls.cert.length === 0
    || typeof tls.key !== 'string' || tls.key.length === 0) {
    throw new AgentRoomRuntimeError(
      'invalid_argument',
      'tls must be { cert, key }: the PEM certificate chain and the matching private key as content strings, both required',
    )
  }
  let certificate
  try {
    certificate = new X509Certificate(tls.cert)
  } catch {
    throw new AgentRoomRuntimeError('invalid_argument', 'tls.cert is not parseable PEM certificate material')
  }
  let privateKey
  try {
    privateKey = createPrivateKey(tls.key)
  } catch {
    throw new AgentRoomRuntimeError('invalid_argument', 'tls.key is not parseable PEM private-key material')
  }
  let keyPublicKey
  try {
    keyPublicKey = createPublicKey(privateKey)
  } catch {
    throw new AgentRoomRuntimeError('invalid_argument', 'tls.key is not parseable PEM private-key material')
  }
  if (!certificate.publicKey.equals(keyPublicKey)) {
    throw new AgentRoomRuntimeError('invalid_argument', "tls.cert and tls.key do not match: the certificate is not this key's certificate")
  }
  return Object.freeze({ cert: tls.cert, key: tls.key })
}

export async function startServer({
  dataDir,
  host = '127.0.0.1',
  port = 0,
  tls,
  webRoot = DEFAULT_WEB_ROOT,
  sessionVerifier,
  viewerVerifier,
  viewerSessionRegistry,
  sessionRegistry,
  liveSessionRegistry,
  challengeRegistry,
  claimsTtlMs = CLAIMS_TTL_MS,
  pruneIntervalMs,
  pruneClaims,
  presenceTtlMs = PRESENCE_TTL_MS,
  trustedProxy = false,
  enrollRateLimiter,
  sendTokenRefillPerSecond = SEND_TOKEN_REFILL_PER_SECOND,
  sendTokenCapacity = SEND_TOKEN_CAPACITY,
  requestBudgetPerMinute = REQUEST_BUDGET_PER_MINUTE,
  requestBudgetBurst = REQUEST_BUDGET_BURST,
  duplicateWindowMs = DUPLICATE_WINDOW_MS,
  storageWarnFreeBytes = STORAGE_WARN_FREE_BYTES,
  storageRefuseFreeBytes = STORAGE_REFUSE_FREE_BYTES,
  storageFreeBytesFn,
  storageWarn,
  maxPageCount,
  storageNowMs,
} = {}) {
  // Runtime gate first: Node >= 24.15 / SQLite >= 3.51.3, diagnosable error.
  assertSupportedRuntime()
  if (typeof dataDir !== 'string' || dataDir.trim().length === 0) {
    throw new AgentRoomRuntimeError('data_directory_invalid', 'dataDir must be a non-empty path')
  }
  // Story 4.7: the TLS material validates FIRST — a malformed or mismatched
  // pair fails here, before the bind rule below is even consulted and long
  // before any listener exists.
  const effectiveTls = tls === undefined ? undefined : validatedTlsMaterial(tls)
  // The bind rule, sharpened (not loosened) by Story 4.7: PLAINTEXT is
  // permitted only on loopback (AD-11) — the refusal and its message are
  // byte-identical to the pre-4.7 rule whenever no tls is given. With
  // validated operator TLS material the operator may bind any host (0.0.0.0
  // on a VPS): nothing plaintext ever leaves the machine, because the
  // listener itself encrypts.
  if (!LOOPBACK_HOSTS.has(host) && effectiveTls === undefined) {
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
  // Story 5.1: the cookie registry is per server instance (like the rate
  // gates: admission state is never shared across instances — a cookie minted
  // on one server must never authenticate another), with an override for
  // callers that must own it.
  if (viewerSessionRegistry !== undefined
    && (typeof viewerSessionRegistry !== 'object' || viewerSessionRegistry === null
      || typeof viewerSessionRegistry.issue !== 'function'
      || typeof viewerSessionRegistry.verify !== 'function')) {
    throw new AgentRoomRuntimeError(
      'invalid_argument',
      'viewerSessionRegistry must be a viewer session registry (issue/verify) when provided',
    )
  }
  if (typeof webRoot !== 'string' || webRoot.trim().length === 0) {
    throw new AgentRoomRuntimeError('invalid_argument', 'webRoot must be a non-empty path')
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
  if (challengeRegistry !== undefined
    && (typeof challengeRegistry !== 'object' || challengeRegistry === null
      || typeof challengeRegistry.issue !== 'function'
      || typeof challengeRegistry.consume !== 'function')) {
    throw new AgentRoomRuntimeError(
      'invalid_argument',
      'challengeRegistry must be a challenge registry (issue/consume) when provided',
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
  // Story 4.2: the enroll route's admission control. trustedProxy is the
  // explicit operator configuration that turns X-Forwarded-For trust ON —
  // default OFF, so forwarded addresses are never trusted by default — and
  // the limiter defaults to a fresh fixed-window counter per server (a
  // process-shared counter would let two test servers, or two realms on one
  // host, fill each other's buckets; an injected limiter is the caller's to
  // share). Malformed wiring fails at startup, never per-request.
  if (trustedProxy !== true && trustedProxy !== false) {
    throw new AgentRoomRuntimeError('invalid_argument', 'trustedProxy must be a boolean when provided')
  }
  if (enrollRateLimiter !== undefined
    && (typeof enrollRateLimiter !== 'object' || enrollRateLimiter === null
      || typeof enrollRateLimiter.check !== 'function')) {
    throw new AgentRoomRuntimeError(
      'invalid_argument',
      'enrollRateLimiter must be an enroll rate limiter (check) when provided',
    )
  }
  // Story 4.4: the four gates' operator floors. All five tunables accept
  // startServer overrides — abuse floors for an invite-only realm (FR-16's
  // own qualification), never a volumetric-DoS guarantee; an operator raises
  // them for churn-like legitimate load or tightens them within what their
  // realm can bear. Malformed wiring fails at startup, never per-request.
  if (typeof sendTokenRefillPerSecond !== 'number'
    || !Number.isFinite(sendTokenRefillPerSecond)
    || sendTokenRefillPerSecond <= 0) {
    throw new AgentRoomRuntimeError('invalid_argument', 'sendTokenRefillPerSecond must be a positive finite number')
  }
  if (!Number.isSafeInteger(sendTokenCapacity) || sendTokenCapacity < 1) {
    throw new AgentRoomRuntimeError('invalid_argument', 'sendTokenCapacity must be a positive safe integer')
  }
  if (!Number.isSafeInteger(requestBudgetPerMinute) || requestBudgetPerMinute < 1) {
    throw new AgentRoomRuntimeError('invalid_argument', 'requestBudgetPerMinute must be a positive safe integer')
  }
  if (!Number.isSafeInteger(requestBudgetBurst) || requestBudgetBurst < 1) {
    throw new AgentRoomRuntimeError('invalid_argument', 'requestBudgetBurst must be a positive safe integer')
  }
  if (!Number.isSafeInteger(duplicateWindowMs) || duplicateWindowMs <= 0) {
    throw new AgentRoomRuntimeError('invalid_argument', 'duplicateWindowMs must be a positive safe integer')
  }
  // Story 4.6: the storage admission reserves — tunable capacity reserves
  // (never retention quotas), validated at startup like every other
  // operator override: both non-negative safe integers of bytes and the
  // refuse reserve not above the warn reserve. The free-space source and
  // warn sink are the test seams (injectable functions when provided).
  resolveStorageThresholds({ warnFreeBytes: storageWarnFreeBytes, refuseFreeBytes: storageRefuseFreeBytes })
  if (storageFreeBytesFn !== undefined && typeof storageFreeBytesFn !== 'function') {
    throw new AgentRoomRuntimeError('invalid_argument', 'storageFreeBytesFn must be a function when provided')
  }
  if (storageWarn !== undefined && typeof storageWarn !== 'function') {
    throw new AgentRoomRuntimeError('invalid_argument', 'storageWarn must be a function when provided')
  }
  // The disk-full simulation seam (a store-level test seam, like the
  // free-space source above — no operator surface reads it): validated at
  // startup so a malformed ceiling fails the boot, never the first send.
  if (maxPageCount !== undefined && (!Number.isSafeInteger(maxPageCount) || maxPageCount < 1)) {
    throw new AgentRoomRuntimeError('invalid_argument', 'maxPageCount must be a positive safe integer when provided')
  }
  // The storage gate's clock seam (injectable at the gate, the store, and
  // the server): the send route passes no nowMs, so this function — when
  // provided — answers the append clock for every server-driven send, and
  // the warn interval can be driven precisely in tests.
  if (storageNowMs !== undefined && typeof storageNowMs !== 'function') {
    throw new AgentRoomRuntimeError('invalid_argument', 'storageNowMs must be a function when provided')
  }
  const effectiveEnrollRateLimiter = enrollRateLimiter ?? createEnrollRateLimiter()
  // Story 4.4: the two per-Actor token buckets (request budget + send
  // bucket), one pair per server instance — per-realm admission state is
  // never shared across instances (the 4.2 limiter's default-plus-override
  // reasoning; here both gates are constructed fresh per server, and tests
  // inject clocks through createRateGates when they must drive them
  // directly).
  const rateGates = createRateGates({
    sendTokenRefillPerSecond,
    sendTokenCapacity,
    requestBudgetPerMinute,
    requestBudgetBurst,
  })
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
  // Story 4.1: the challenge nonces follow the same default-plus-override
  // pattern; issuance into the session registry always resolves through the
  // effective one so an injected pair stays coherent.
  const effectiveChallengeRegistry = challengeRegistry ?? CHALLENGE_REGISTRY

  // Story 2.3 (AR-4): the one-time v0.1→v0.2 migration is a startup step.
  // A v0.1 data file is migrated in place here — absorb-or-stop the live
  // v0.1 daemon named by runtime.json first, then one BEGIN IMMEDIATE
  // transaction (detect user_version → per-room re-sequencing + reply_to_seq
  // remap → stamp v2) — before the store opens. Anything that is not a v1
  // file is a quick no-op; openRoomLog's refusal paths still guard every
  // non-v1 foreign schema.
  await migrateV1InPlace({ dataDir })

  const store = openRoomLog({
    dataDir,
    duplicateWindowMs,
    // Story 4.6: the storage admission reserves and their seams ride through
    // (undefined triggers openRoomLog's declared defaults for the two
    // injectable functions).
    storageWarnFreeBytes,
    storageRefuseFreeBytes,
    storageFreeBytesFn,
    storageWarn,
    maxPageCount,
    storageNowMs,
  })

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
  // Story 5.1: the real cookie verifier is the viewer slot's default — the
  // Story 1.3 reject-all default remains only as the pipeline's structural
  // fallback, exactly as for the session slot. The registry and the token
  // reader are this instance's: an injected viewerVerifier overrides the
  // whole verifier, and an injected viewerSessionRegistry overrides the
  // registry the mint and this verifier share.
  const effectiveViewerSessions = viewerSessionRegistry ?? createViewerSessionRegistry()
  const effectiveViewerVerifier = viewerVerifier ?? createViewerVerifier({
    registry: effectiveViewerSessions,
    readToken: () => readViewerToken(dataDir),
  })
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

    // Story 4.7: ONE request callback, TWO transports. The callback body is
    // unchanged from the pre-4.7 inline form; only its name moved. With no
    // tls option this is byte-identical to today's node:http server; with
    // operator TLS material https.createServer wraps the SAME callback —
    // "both paths use the same request handler" is structural, never claimed.
    const requestHandler = (request, response) => {
      // handleRequest maps its own failures; this guard only contains a
      // failure of the failure path itself.
      handleRequest(request, response, {
        sessionVerifier: effectiveSessionVerifier,
        viewerVerifier: effectiveViewerVerifier,
        dataDir,
        webRoot,
        sessionRegistry: effectiveRegistry,
        liveSessionRegistry: effectiveLiveRegistry,
        challengeRegistry: effectiveChallengeRegistry,
        viewerSessions: effectiveViewerSessions,
        enrollRateLimiter: effectiveEnrollRateLimiter,
        trustedProxy,
        requestBudgetGate: rateGates.requestBudgetGate,
        sendBucketGate: rateGates.sendBucketGate,
        store,
      }).catch(() => {
        response.destroy()
      })
    }
    httpServer = effectiveTls === undefined
      ? createHttpServer(requestHandler)
      : createHttpsServer({ cert: effectiveTls.cert, key: effectiveTls.key }, requestHandler)
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

// Story 4.4 review of the direct-launch surface: the four gates' operator
// floors ride the same env convention as the claim and presence TTLs — five
// strictly-validated knobs, each falling back to its declared default with
// one warning line when its value is junk. A present-but-invalid value never
// blocks a boot.
export function gateLimitsFromEnv(env = process.env) {
  const warnings = []
  const readFraction = (key, fallback) => {
    const raw = env?.[key]
    if (raw === undefined || String(raw).trim() === '') return fallback
    const value = Number(String(raw).trim())
    if (!Number.isFinite(value) || value <= 0) {
      warnings.push(`ignoring invalid ${key} "${raw}": must be a positive finite number; using the default ${fallback}`)
      return fallback
    }
    return value
  }
  const readInteger = (key, fallback) => {
    const raw = env?.[key]
    if (raw === undefined || String(raw).trim() === '') return fallback
    const trimmed = String(raw).trim()
    if (!/^[0-9]+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed)) || Number(trimmed) < 1) {
      warnings.push(`ignoring invalid ${key} "${raw}": must be a positive integer; using the default ${fallback}`)
      return fallback
    }
    return Number(trimmed)
  }
  return {
    gateLimits: {
      sendTokenRefillPerSecond: readFraction('AGENT_ROOM_SEND_TOKEN_REFILL_PER_SECOND', SEND_TOKEN_REFILL_PER_SECOND),
      sendTokenCapacity: readInteger('AGENT_ROOM_SEND_TOKEN_CAPACITY', SEND_TOKEN_CAPACITY),
      requestBudgetPerMinute: readInteger('AGENT_ROOM_REQUEST_BUDGET_PER_MINUTE', REQUEST_BUDGET_PER_MINUTE),
      requestBudgetBurst: readInteger('AGENT_ROOM_REQUEST_BUDGET_BURST', REQUEST_BUDGET_BURST),
      duplicateWindowMs: readInteger('AGENT_ROOM_DUPLICATE_WINDOW_MS', DUPLICATE_WINDOW_MS),
    },
    warnings,
  }
}

// Story 4.7: the direct launch's TOPOLOGY surface — deliberately STRICT
// where every earlier *FromEnv knob warns-and-falls-back. The tuning knobs
// (TTLs, floors, reserves) tune LIMITS: a junk value falling back to its
// default still leaves the server behaving, just with defaults. HOST, PORT,
// and the TLS material are TOPOLOGY: a junk AGENT_ROOM_PORT falling back to
// ephemeral would change WHERE the server is reachable — exactly the failure
// the start boundary (health answers + bound ports vs non-zero exit with a
// diagnosable error) defines as not recoverable. So a junk value produces a
// coded problem line and exit 1, never a fallback, and the ABSENT env is
// byte-identical to today's loopback/ephemeral launch. The TLS knobs carry
// PATHS, never content (secrets stay out of environments and process
// listings), must be absolute, and must arrive together — one knob without
// its sibling is a problem, not a half-configured listener.
export function topologyFromEnv(env = process.env) {
  const problems = []
  let host = '127.0.0.1'
  let port = 0
  let tlsCertPath
  let tlsKeyPath

  const rawHost = env?.AGENT_ROOM_HOST
  if (rawHost !== undefined && String(rawHost).trim() !== '') {
    const candidate = String(rawHost).trim()
    if (/[\s/@#?]/.test(candidate)) {
      problems.push(`AGENT_ROOM_HOST "${rawHost}" is not a bindable host: name an interface address or a hostname (for example 127.0.0.1, 0.0.0.0, or room.example.com)`)
    } else {
      host = candidate
    }
  }
  const rawPort = env?.AGENT_ROOM_PORT
  if (rawPort !== undefined && String(rawPort).trim() !== '') {
    const trimmed = String(rawPort).trim()
    if (!/^[0-9]+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed)) || Number(trimmed) > 65535) {
      problems.push(`AGENT_ROOM_PORT "${rawPort}" must be an integer from 0-65535 (0 asks for an ephemeral port); there is no fallback — a wrong port silently moves where the server is reachable`)
    } else {
      port = Number(trimmed)
    }
  }
  const rawCert = env?.AGENT_ROOM_TLS_CERT
  const rawKey = env?.AGENT_ROOM_TLS_KEY
  const certPresent = rawCert !== undefined && String(rawCert).trim() !== ''
  const keyPresent = rawKey !== undefined && String(rawKey).trim() !== ''
  if (certPresent !== keyPresent) {
    problems.push(`AGENT_ROOM_TLS_CERT and AGENT_ROOM_TLS_KEY must be given together (both or neither); ${certPresent ? 'AGENT_ROOM_TLS_KEY is missing' : 'AGENT_ROOM_TLS_CERT is missing'}`)
  }
  if (certPresent && keyPresent) {
    for (const [name, raw] of [['AGENT_ROOM_TLS_CERT', rawCert], ['AGENT_ROOM_TLS_KEY', rawKey]]) {
      const candidate = String(raw).trim()
      if (!isAbsolute(candidate)) {
        problems.push(`${name} must be an absolute path to the PEM file`)
      } else if (name === 'AGENT_ROOM_TLS_CERT') {
        tlsCertPath = candidate
      } else {
        tlsKeyPath = candidate
      }
    }
  }
  return Object.freeze({
    host,
    port,
    tlsCertPath,
    tlsKeyPath,
    problems: Object.freeze(problems),
  })
}

// Story 4.7: the operator's TLS material read by PATH (the direct launch's
// env carries paths; the content strings startServer consumes are read here,
// through the bounded regular-file reader every private state file uses —
// never a symlink, never unbounded). Every failure maps to one coded
// invalid_argument naming the env knob, so the direct launch dies before any
// listener exists with exactly one diagnosable line. The FILES' permissions
// are the operator's responsibility (the guide documents 0600) — these are
// not agent-room state, so the runtime permission gates do not rewrite them;
// the bounded-regular-file check only refuses what it cannot read safely.
export function tlsMaterialFromPaths({ certPath, keyPath } = {}) {
  const read = (path, name) => {
    try {
      regularPrivateFile(path)
    } catch (error) {
      throw new AgentRoomRuntimeError(
        'invalid_argument',
        `${name} ("${path}") is not a readable bounded regular file: ${error?.message ?? error}`,
      )
    }
    try {
      return readFileSync(path, 'utf8')
    } catch (error) {
      throw new AgentRoomRuntimeError(
        'invalid_argument',
        `${name} ("${path}") could not be read: ${error?.message ?? error}`,
      )
    }
  }
  if (typeof certPath !== 'string' || typeof keyPath !== 'string') {
    throw new AgentRoomRuntimeError('invalid_argument', 'tlsMaterialFromPaths requires both certPath and keyPath')
  }
  return Object.freeze({
    cert: read(certPath, 'AGENT_ROOM_TLS_CERT'),
    key: read(keyPath, 'AGENT_ROOM_TLS_KEY'),
  })
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
  const { gateLimits, warnings: gateWarnings } = gateLimitsFromEnv()
  for (const gateWarning of gateWarnings) {
    process.stderr.write(`agent-room-server: ${gateWarning}\n`)
  }
  // Story 4.6: the storage admission reserves ride the same direct-launch
  // convention — AGENT_ROOM_STORAGE_WARN_BYTES / _REFUSE_BYTES, strictly
  // validated, junk warns once and falls back to the declared default.
  const { storageWarnFreeBytes, storageRefuseFreeBytes, warnings: storageWarnings } = storageThresholdsFromEnv()
  for (const storageWarning of storageWarnings) {
    process.stderr.write(`agent-room-server: ${storageWarning}\n`)
  }
  // Story 4.7: the STRICT topology surface — junk fails startup with one
  // coded line per problem, exit 1, no boot (see topologyFromEnv); absent
  // env keeps today's loopback/ephemeral launch byte-identically.
  const topology = topologyFromEnv()
  for (const problem of topology.problems) {
    process.stderr.write(`agent-room-server: invalid_argument: ${problem}\n`)
  }
  if (topology.problems.length > 0) process.exit(1)
  let tlsMaterial
  if (topology.tlsCertPath !== undefined) {
    try {
      tlsMaterial = tlsMaterialFromPaths({ certPath: topology.tlsCertPath, keyPath: topology.tlsKeyPath })
    } catch (error) {
      process.stderr.write(`agent-room-server: ${error?.code ?? 'startup_failed'}: ${error?.message}\n`)
      process.exit(1)
    }
  }
  // The public-realm advisory (one line, exactly): a non-loopback bind on
  // the DEFAULT shared data directory would make a public realm share one
  // store with the local auto-start server — one process, one realm, one
  // data dir. It is an advisory, not a refusal; a dedicated
  // AGENT_ROOM_DATA_DIR keeps the launch silent.
  if (!LOOPBACK_HOSTS.has(topology.host) && process.env.AGENT_ROOM_DATA_DIR === undefined) {
    process.stderr.write(
      'agent-room-server: advisory: this server is about to bind a non-loopback host (a public realm) on the default shared data directory;'
      + ' set AGENT_ROOM_DATA_DIR to a dedicated directory so the public realm never shares state with the local auto-start server (one process, one realm, one data dir)\n',
    )
  }
  startServer({
    dataDir: sharedDataDirectory(),
    host: topology.host,
    port: topology.port,
    ...(tlsMaterial === undefined ? {} : { tls: tlsMaterial }),
    claimsTtlMs,
    presenceTtlMs,
    ...gateLimits,
    storageWarnFreeBytes,
    storageRefuseFreeBytes,
  })
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
