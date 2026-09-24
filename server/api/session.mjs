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
  SESSIONS_MAX,
  SESSION_TOKEN_BYTES,
  SESSION_TOKEN_MAX_CHARS,
  SESSION_TTL_MS,
} from '../constants.mjs'
import { AgentRoomRuntimeError } from '../runtime.mjs'
import { reject } from './pipeline.mjs'

// Canonical Actor fingerprint shape (see ../keys.mjs): `sha256:` plus
// lowercase hex over 32 raw bytes.
const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/

function sessionDigest(token) {
  return createHash('sha256').update(token, 'utf8').digest('hex')
}

// Issuer/verifier pair over one in-memory session set. `now` is injectable so
// tests can exercise the sliding TTL without waiting on the wall clock;
// `maxSessions` exists for capacity tests and defaults to SESSIONS_MAX.
export function createSessionRegistry({
  ttlMs = SESSION_TTL_MS,
  now = Date.now,
  maxSessions = SESSIONS_MAX,
} = {}) {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new AgentRoomRuntimeError('invalid_argument', 'session ttlMs must be a positive integer')
  }
  if (typeof now !== 'function') {
    throw new AgentRoomRuntimeError('invalid_argument', 'session now must be a function')
  }
  if (!Number.isInteger(maxSessions) || maxSessions <= 0) {
    throw new AgentRoomRuntimeError('invalid_argument', 'session maxSessions must be a positive integer')
  }
  // sha256(token) hex → { actorFingerprint, digest, expiresAt }.
  const sessions = new Map()

  function issue(actorFingerprint) {
    if (typeof actorFingerprint !== 'string' || !FINGERPRINT_PATTERN.test(actorFingerprint)) {
      throw new AgentRoomRuntimeError(
        'invalid_argument',
        'session issue requires a canonical actor fingerprint (sha256:<64 hex>)',
      )
    }
    const timestamp = now()
    // Lazy sweep: expired entries leave the Map at the next issue, not on a
    // timer — no unbounded growth from idle expirations.
    for (const [digest, entry] of sessions) {
      if (entry.expiresAt <= timestamp) sessions.delete(digest)
    }
    // Capacity: oldest-expired-then-oldest. The sweep above already removed
    // every expired entry, so this evicts the oldest live session when the
    // realm is at capacity — the bound holds under sustained issuance.
    while (sessions.size >= maxSessions) {
      const oldestExpired = [...sessions.entries()].find(([, entry]) => entry.expiresAt <= timestamp)
      sessions.delete(oldestExpired ? oldestExpired[0] : sessions.keys().next().value)
    }
    const token = randomBytes(SESSION_TOKEN_BYTES).toString('base64url')
    const digest = sessionDigest(token)
    sessions.set(digest, { actorFingerprint, digest, expiresAt: timestamp + ttlMs })
    return token
  }

  function verify(token) {
    if (typeof token !== 'string' || token.length === 0 || token.length > SESSION_TOKEN_MAX_CHARS) {
      return reject('unauthorized')
    }
    const digest = sessionDigest(token)
    const entry = sessions.get(digest)
    if (!entry) return reject('unauthorized')
    const timestamp = now()
    if (timestamp >= entry.expiresAt) {
      sessions.delete(digest)
      return reject('unauthorized')
    }
    // Sliding TTL: activity refreshes the expiry.
    entry.expiresAt = timestamp + ttlMs
    return { actorFingerprint: entry.actorFingerprint }
  }

  return { issue, verify }
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
// to the pipeline as the session principal. The local token file is never a
// session: it is not a registry entry, so presenting it on an actor route is
// rejected here like any other unknown credential.
export function createSessionVerifier({ registry } = {}) {
  if (!registry || typeof registry.issue !== 'function' || typeof registry.verify !== 'function') {
    throw new AgentRoomRuntimeError('invalid_argument', 'createSessionVerifier requires a session registry')
  }
  return context => {
    const token = bearerTokenFromHeaders(context?.headers)
    if (token === null) return reject('unauthorized')
    return registry.verify(token)
  }
}
