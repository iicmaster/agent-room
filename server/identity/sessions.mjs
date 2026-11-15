// Session auth (Story 1.4, spine AD-5): one token mechanism, of which the
// local token file exchange is the first issuance path (the Ed25519
// challenge-response path is Epic 4's remote mode). The registry is the
// issuer/verifier pair the API host wires into the actor-class auth stage:
// issue(actorFingerprint) mints a 256-bit random base64url bearer token bound
// to that fingerprint; verify(token) resolves it back. Sessions are keyed by
// the installation's Actor fingerprint (the SHA-256 of its raw 32-byte public
// key, computed by ../keys.mjs at the exchange), and one Actor may hold many
// sessions at once — Chat IDs differentiate them from Story 1.5 on.
//
// The registry is an in-memory Map — restart clears it by design (Story 1.4
// scope; durable continuity is Epic 2). The TTL is the 12 h sliding window
// (provisional per DR-2, ratified at Story 4.1): every successful verify
// refreshes the expiry, so active sessions live as long as they are used.
// Capacity is bounded by SESSIONS_MAX: issue() lazily sweeps expired entries
// and, when still full, evicts oldest-expired-then-oldest.
//
// Secret handling: tokens are never logged — nothing here writes anywhere —
// and the Map is keyed by the SHA-256 digest of the token, never the raw
// value. That digest lookup IS the comparison: hashing the presented
// credential and matching the digest has no byte-dependent early exit, so no
// additional self-compare is performed here. Constant-time discipline applies
// where a real comparison happens (the token-file compare in server.mjs).

import { createHash, randomBytes } from 'node:crypto'

import {
  CLI_SESSIONS_MAX,
  CLI_SESSION_TTL_MS,
  FINGERPRINT_PATTERN,
  POOL_QUEUE_FULL_RETRY_AFTER_MS,
  PUBLIC_ERROR_STATUS,
  REMOTE_BEARER_SESSIONS_PER_ACTOR_MAX,
  SESSIONS_MAX,
  SESSION_KINDS,
  SESSION_TOKEN_BYTES,
  SESSION_TOKEN_MAX_CHARS,
  SESSION_TTL_MS,
} from '../constants.mjs'
import { AgentRoomRuntimeError } from '../runtime.mjs'

function unauthorized() {
  return { ok: false, code: 'unauthorized', status: PUBLIC_ERROR_STATUS.unauthorized }
}

function sessionDigest(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

// Issuer/verifier pair over one in-memory session set. `now` is injectable so
// tests can exercise the sliding TTL without waiting on the wall clock;
// `maxSessions` exists for capacity tests and defaults to SESSIONS_MAX.
export function createSessionRegistry({
  ttlMs = SESSION_TTL_MS,
  cliTtlMs = CLI_SESSION_TTL_MS,
  now = Date.now,
  maxSessions = SESSIONS_MAX,
  maxCliSessions = CLI_SESSIONS_MAX,
  remotePerActorMax = REMOTE_BEARER_SESSIONS_PER_ACTOR_MAX,
} = {}) {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new AgentRoomRuntimeError('invalid_argument', 'session ttlMs must be a positive integer')
  }
  if (!Number.isInteger(cliTtlMs) || cliTtlMs <= 0) {
    throw new AgentRoomRuntimeError('invalid_argument', 'session cliTtlMs must be a positive integer')
  }
  if (typeof now !== 'function') {
    throw new AgentRoomRuntimeError('invalid_argument', 'session now must be a function')
  }
  if (!Number.isInteger(maxSessions) || maxSessions <= 0) {
    throw new AgentRoomRuntimeError('invalid_argument', 'session maxSessions must be a positive integer')
  }
  if (!Number.isInteger(maxCliSessions) || maxCliSessions <= 0) {
    throw new AgentRoomRuntimeError('invalid_argument', 'session maxCliSessions must be a positive integer')
  }
  if (!Number.isInteger(remotePerActorMax) || remotePerActorMax <= 0) {
    throw new AgentRoomRuntimeError('invalid_argument', 'session remotePerActorMax must be a positive integer')
  }
  // sha256(token) hex → { actorFingerprint, digest, expiresAt, kind, via }.
  const longLivedSessions = new Map()
  const cliOneshotSessions = new Map()
  // Active challenge-origin (`via: 'answer'`) token count per actorFingerprint
  // across BOTH pools.
  const remoteCounts = new Map()

  const poolFor = kind => (kind === 'cli_oneshot' ? cliOneshotSessions : longLivedSessions)
  const capFor = kind => (kind === 'cli_oneshot' ? maxCliSessions : maxSessions)
  const ttlFor = kind => (kind === 'cli_oneshot' ? cliTtlMs : ttlMs)

  function deleteEntry(pool, digest, entry) {
    if (!pool.delete(digest)) return false
    if (entry?.via === 'answer') {
      const next = (remoteCounts.get(entry.actorFingerprint) ?? 0) - 1
      if (next > 0) remoteCounts.set(entry.actorFingerprint, next)
      else remoteCounts.delete(entry.actorFingerprint)
    }
    return true
  }

  function sweepExpired(timestamp) {
    for (const pool of [longLivedSessions, cliOneshotSessions]) {
      for (const [digest, entry] of pool) {
        if (entry.expiresAt <= timestamp) deleteEntry(pool, digest, entry)
      }
    }
  }

  function lookupEntry(digest) {
    const longEntry = longLivedSessions.get(digest)
    if (longEntry) return { pool: longLivedSessions, entry: longEntry }
    const cliEntry = cliOneshotSessions.get(digest)
    if (cliEntry) return { pool: cliOneshotSessions, entry: cliEntry }
    return null
  }
  // The fenced set: session keys displaced by an EXPLICIT same-Actor
  // replacement (the reconnect-recovery takeover). Displacing a session
  // revokes its token — it stops authenticating at once — and leaves its key
  // here so the pipeline can refuse every request the displaced session had
  // in flight: the authorization stage refuses it on the way in, and the
  // pipeline's post-input revalidation refuses it again directly before the
  // handler, after the request's body has fully arrived. RETENTION, exactly:
  // an entry leaves only when no request holding that key can still be
  // inside the admission→handler window — the pipeline pins each admitted
  // request's key (enterInFlight/leaveInFlight below) and a PINNED entry is
  // never evicted under any circumstance. The bound below gates only IDLE
  // tombstones (zero pins, evicted oldest-first), so the fence's size is
  // proportional to genuinely outstanding displaced requests — the guarantee
  // is about requests, not a claim of bounded memory independent of
  // concurrency. Entries hold digests only, never a token.
  const superseded = new Map()

  // The pipeline's in-flight pins: one increment per admitted request, one
  // decrement on every exit path (the finally in runPipeline). A key's pin
  // count is the number of requests whose post-input revalidation can still
  // consult the fence.
  const inFlight = new Map()

  function enterInFlight(sessionKey) {
    if (typeof sessionKey !== 'string' || sessionKey.length === 0) return
    inFlight.set(sessionKey, (inFlight.get(sessionKey) ?? 0) + 1)
  }

  function leaveInFlight(sessionKey) {
    if (typeof sessionKey !== 'string' || sessionKey.length === 0) return
    const count = (inFlight.get(sessionKey) ?? 0) - 1
    if (count > 0) {
      inFlight.set(sessionKey, count)
      return
    }
    inFlight.delete(sessionKey)
    // The key may just have become an idle tombstone while the fence sits
    // over its bound: drain it (and any other idle tombstones) now.
    evictIdleTombstones()
  }

  // Evict oldest-first, but ONLY entries no request can still be waiting on:
  // a pinned entry (in-flight count above zero) is never a candidate. Runs
  // whenever the fence sits over its idle-tombstone bound.
  function evictIdleTombstones() {
    while (superseded.size > maxSessions) {
      let evicted = false
      for (const key of superseded.keys()) {
        if ((inFlight.get(key) ?? 0) === 0) {
          superseded.delete(key)
          evicted = true
          break
        }
      }
      if (!evicted) break
    }
  }

  function issue(actorFingerprint, { kind = 'long_lived', via = 'local' } = {}) {
    if (typeof actorFingerprint !== 'string' || !FINGERPRINT_PATTERN.test(actorFingerprint)) {
      throw new AgentRoomRuntimeError(
        'invalid_argument',
        'session issue requires a canonical actor fingerprint (sha256:<64 hex>)',
      )
    }
    if (!SESSION_KINDS.includes(kind)) {
      throw new AgentRoomRuntimeError('invalid_request', "session_kind must be 'long_lived' or 'cli_oneshot'")
    }
    if (via !== 'local' && via !== 'answer') {
      throw new AgentRoomRuntimeError('invalid_argument', "session via must be 'local' or 'answer'")
    }
    const timestamp = now()
    // Lazy sweep: expired entries leave both pools before capacity checks.
    sweepExpired(timestamp)
    if (via === 'answer' && (remoteCounts.get(actorFingerprint) ?? 0) >= remotePerActorMax) {
      const error = new AgentRoomRuntimeError(
        'queue_full',
        `remote session limit (${remotePerActorMax}) reached for this actor; retry after backoff`,
      )
      error.retryAfterMs = POOL_QUEUE_FULL_RETRY_AFTER_MS
      throw error
    }
    const pool = poolFor(kind)
    const maxPool = capFor(kind)
    // Non-evicting pool: never evict a live session; refuse with 503 queue_full.
    if (pool.size >= maxPool) {
      const error = new AgentRoomRuntimeError(
        'queue_full',
        `session pool ${kind} is full (${maxPool}); retry after backoff`,
      )
      error.retryAfterMs = POOL_QUEUE_FULL_RETRY_AFTER_MS
      throw error
    }
    const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url')
    const digest = sessionDigest(token)
    pool.set(digest, {
      actorFingerprint,
      digest,
      expiresAt: timestamp + ttlFor(kind),
      kind,
      via,
    })
    if (via === 'answer') {
      remoteCounts.set(actorFingerprint, (remoteCounts.get(actorFingerprint) ?? 0) + 1)
    }
    return token
  }

  // Liveness by session KEY (the digest the live-session registry holds).
  // The api layer needs it to tell a DEAD session's stale Chat-ID row from a
  // live holder's during the re-auth recovery path. Read-only: verifying
  // nothing, it never slides the TTL and never creates an entry.
  function isLive(sessionKey) {
    if (typeof sessionKey !== 'string' || sessionKey.length === 0) return false
    const found = lookupEntry(sessionKey)
    if (!found) return false
    return now() < found.entry.expiresAt
  }

  function sessionKeys() {
    const timestamp = now()
    const keys = []
    for (const pool of [longLivedSessions, cliOneshotSessions]) {
      for (const [digest, entry] of pool) {
        if (timestamp < entry.expiresAt) keys.push(digest)
      }
    }
    return keys
  }

  function revoke(sessionKey) {
    if (typeof sessionKey !== 'string' || sessionKey.length === 0) return false
    const found = lookupEntry(sessionKey)
    if (!found) return false
    return deleteEntry(found.pool, sessionKey, found.entry)
  }

  function supersede(sessionKey) {
    if (typeof sessionKey !== 'string' || sessionKey.length === 0) return false
    const found = lookupEntry(sessionKey)
    const removed = found ? deleteEntry(found.pool, sessionKey, found.entry) : false
    superseded.set(sessionKey, now())
    evictIdleTombstones()
    return removed
  }

  // Read-only: is this session key fenced? THREE placements ask it, in
  // order: the authorization stage (so a displaced request is refused as
  // early as its stage sequence reaches — before the body for most routes),
  // the pipeline's post-input revalidation — run synchronously after the
  // request fields resolve and directly before the handler is invoked, with
  // no await between the check and the mutating handlers — and the long-poll
  // route's per-wake check. A pinned entry survives until its last in-flight
  // request has passed all of the checks it will reach.
  function isSuperseded(sessionKey) {
    if (typeof sessionKey !== 'string' || sessionKey.length === 0) return false
    return superseded.has(sessionKey)
  }

  function verify(token) {
    if (typeof token !== 'string' || token.length === 0 || token.length > SESSION_TOKEN_MAX_CHARS) {
      return unauthorized()
    }
    const digest = sessionDigest(token)
    const found = lookupEntry(digest)
    if (!found) return unauthorized()
    const { pool, entry } = found
    const timestamp = now()
    if (timestamp >= entry.expiresAt) {
      deleteEntry(pool, digest, entry)
      return unauthorized()
    }
    // Sliding TTL: activity refreshes the expiry.
    entry.expiresAt = timestamp + ttlFor(entry.kind)
    return { actorFingerprint: entry.actorFingerprint }
  }

  function snapshot() {
    return {
      longLivedSessions: new Map([...longLivedSessions].map(([k, v]) => [k, { ...v }])),
      cliOneshotSessions: new Map([...cliOneshotSessions].map(([k, v]) => [k, { ...v }])),
      remoteCounts: new Map(remoteCounts),
      superseded: new Map(superseded),
    }
  }

  function restore(saved) {
    longLivedSessions.clear()
    for (const [k, v] of saved.longLivedSessions) longLivedSessions.set(k, { ...v })
    cliOneshotSessions.clear()
    for (const [k, v] of saved.cliOneshotSessions) cliOneshotSessions.set(k, { ...v })
    remoteCounts.clear()
    for (const [k, v] of saved.remoteCounts) remoteCounts.set(k, v)
    superseded.clear()
    for (const [k, v] of saved.superseded) superseded.set(k, v)
  }

  return { issue, verify, isLive, revoke, supersede, isSuperseded, enterInFlight, leaveInFlight, sessionKeys, snapshot, restore }
}

// Extract the Bearer credential from request headers. The scheme is
// case-insensitive; anything missing, mangled, empty, or longer than the
// token bound yields null so the caller answers a single canonical
// unauthorized rejection before any comparison work.
export function bearerTokenFromHeaders(headers) {
  const raw = headers?.authorization ?? headers?.['Authorization']
  const value = Array.isArray(raw) ? raw[0] : raw
  if (typeof value !== 'string') return null
  const match = /^Bearer\s+(\S+)\s*$/i.exec(value)
  if (!match) return null
  if (match[1].length > SESSION_TOKEN_MAX_CHARS) return null
  return match[1]
}

// The real actor-class session check that replaces Story 1.3's reject-all
// default: a missing Bearer credential and an unresolvable token both answer
// the canonical 401 unauthorized; a valid token passes its actor fingerprint
// to the pipeline as the session principal. The principal also carries the
// session key — the SHA-256 digest of the presented token, the same key the
// registry stored the session under — so Story 1.5's live-session registry
// keys its rows without ever seeing a raw token (the digest never leaves this
// module's hashing). The registry's own verify() contract stays exactly
// {actorFingerprint}; this wrapper is where the session key joins. The local
// token file is never a session: it is not a registry entry, so presenting it
// on an actor route is rejected here like any other unknown credential.
export function createSessionVerifier({ registry } = {}) {
  if (!registry || typeof registry.issue !== 'function' || typeof registry.verify !== 'function') {
    throw new AgentRoomRuntimeError('invalid_argument', 'createSessionVerifier requires a session registry')
  }
  return context => {
    const token = bearerTokenFromHeaders(context?.headers)
    if (token === null) return unauthorized()
    const outcome = registry.verify(token)
    // Pass rejections and non-principal outcomes through untouched — the
    // pipeline's normalizer owns malformed-verifier classification.
    if (outcome === undefined || outcome === null || typeof outcome !== 'object' || Array.isArray(outcome) || outcome.ok === false) {
      return outcome
    }
    return { ...outcome, sessionKey: sessionKeyFromToken(token) }
  }
}

// The live-session registry's key for a session token: the SHA-256 digest the
// registry itself stores the session under. The verifier attaches it to the
// principal; the server handle's touch wiring and Story 1.6's heartbeat path
// derive the same key from a held token with this helper.
export function sessionKeyFromToken(token) {
  return sessionDigest(token)
}
