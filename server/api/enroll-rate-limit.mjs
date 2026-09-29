// The enroll route's minimal fixed-window rate limiter (Story 4.2) and the
// client-identity rule that governs forwarded addresses (AD-7: "pre-auth
// budgeted per IP with forwarded addresses trusted only from a configured
// proxy").
//
// This is deliberately the minimal counter the enroll route needs until the
// full budget stage lands (Story 4.4 owns the four gates): one fixed window
// of ENROLLMENT_WINDOW_MS per client identity, admitting at most
// ENROLLMENT_PER_MINUTE checks per window — which for the ratified 5/min
// burst-5 pair is exactly the declared burst, since all five admits can be
// spent instantly inside one window. In-process by design: admission control
// for one server process, like every other budget gate.
//
// Identity: the socket's remote address is the client IP UNLESS the operator
// explicitly configured a trusted proxy (startServer({ trustedProxy: true })),
// in which case the leftmost X-Forwarded-For entry is honored — the one hop
// this deployment model (a reverse proxy terminating TLS on the same host,
// FR-4) actually has. Without that configuration the header is IGNORED
// entirely: a client cannot mint fresh rate buckets by spoofing
// X-Forwarded-For, it only ever fills the bucket its socket already owns.

import { ENROLLMENT_PER_MINUTE, ENROLLMENT_WINDOW_MS } from '../constants.mjs'
import { AgentRoomRuntimeError } from '../runtime.mjs'

export const FORWARDED_FOR_HEADER = 'x-forwarded-for'

// The rate bucket's key. `forwardedFor` is the raw header value (string or
// undefined); it is honored only when trustedProxy is exactly true, and only
// its first (leftmost) comma-separated entry counts — the original client of
// a single configured proxy hop. A malformed or empty header falls back to
// the socket address; there is no configuration in which a request with no
// trustworthy identity is uncounted.
export function enrollClientIdentity({ remoteAddress, forwardedFor, trustedProxy }) {
  const remote = typeof remoteAddress === 'string' && remoteAddress.length > 0
    ? remoteAddress
    : 'unknown'
  if (trustedProxy === true && typeof forwardedFor === 'string') {
    const first = forwardedFor.split(',')[0]?.trim() ?? ''
    if (first.length > 0) return `forwarded:${first}`
  }
  return `remote:${remote}`
}

// One fixed-window counter per identity. `now` is injectable so tests can
// roll the window without waiting on the wall clock. Expired windows are
// swept lazily at each check — no timer, and the map holds at most the
// identities seen within the live window.
export function createEnrollRateLimiter({
  limit = ENROLLMENT_PER_MINUTE,
  windowMs = ENROLLMENT_WINDOW_MS,
  now = Date.now,
} = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new AgentRoomRuntimeError('invalid_argument', 'enroll rate limit must be a positive safe integer')
  }
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new AgentRoomRuntimeError('invalid_argument', 'enroll rate windowMs must be a positive safe integer')
  }
  if (typeof now !== 'function') {
    throw new AgentRoomRuntimeError('invalid_argument', 'enroll rate limiter now must be a function')
  }
  // identity → { window, count }
  const buckets = new Map()

  // Take one slot for the identity: true admits the request, false refuses
  // (the caller answers the coded rate_limited). The count increments on
  // every check — failed and refused enroll attempts count, exactly like
  // the budget stage's eventual per-request accounting.
  function check(identity) {
    if (typeof identity !== 'string' || identity.length === 0) {
      throw new AgentRoomRuntimeError('invalid_argument', 'enroll rate check requires a non-empty identity key')
    }
    const timestamp = now()
    const window = Math.floor(timestamp / windowMs)
    for (const [key, entry] of buckets) {
      if (entry.window !== window) buckets.delete(key)
    }
    const entry = buckets.get(identity)
    if (entry && entry.window === window) {
      if (entry.count >= limit) return false
      entry.count += 1
      return true
    }
    buckets.set(identity, { window, count: 1 })
    return true
  }

  return { check }
}
