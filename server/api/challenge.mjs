// Challenge nonces (Story 4.1, spine AD-5/AD-7): the single-use possession-
// proof primitive the remote credential path is built from. issue(rawKey)
// mints a nonce bound to the presented raw 32-byte public key — identity
// binds at challenge time, and the answer route's frozen field set
// (nonce + signature) admits no public_key to substitute with. consume(nonce)
// deletes-then-checks: the entry leaves the map BEFORE any outcome is
// computed, so a nonce is single-use unconditionally — the first answer
// attempt kills it whether the signature verifies or not (no grinding against
// one challenge), which also makes replay resistance trivial.
//
// The registry is an in-memory Map — connection-time state by design (AD-6's
// ephemeral/durable split on the auth surface): a server restart invalidates
// every outstanding challenge while the durable enrollment record survives,
// and persisting a 60-second nonce would buy nothing but survive exactly the
// crashes it should not. The TTL is CHALLENGE_NONCE_TTL_MS from issue.
// Capacity is bounded by CHALLENGE_NONCES_MAX: issue() lazily sweeps expired
// entries and, when still full, evicts oldest-pending — the session
// registry's sweep-then-evict discipline mirrored.

import { randomBytes } from 'node:crypto'

import { CHALLENGE_NONCE_BYTES, CHALLENGE_NONCES_MAX, CHALLENGE_NONCE_TTL_MS } from '../constants.mjs'
import { AgentRoomRuntimeError } from '../runtime.mjs'

// Issuer/consumer pair over one in-memory pending set. `now` is injectable so
// tests can exercise the 60 s expiry without waiting on the wall clock;
// `maxPending` exists for capacity tests and defaults to CHALLENGE_NONCES_MAX.
export function createChallengeRegistry({
  ttlMs = CHALLENGE_NONCE_TTL_MS,
  now = Date.now,
  maxPending = CHALLENGE_NONCES_MAX,
} = {}) {
  if (!Number.isInteger(ttlMs) || ttlMs <= 0) {
    throw new AgentRoomRuntimeError('invalid_argument', 'challenge ttlMs must be a positive integer')
  }
  if (typeof now !== 'function') {
    throw new AgentRoomRuntimeError('invalid_argument', 'challenge now must be a function')
  }
  if (!Number.isInteger(maxPending) || maxPending <= 0) {
    throw new AgentRoomRuntimeError('invalid_argument', 'challenge maxPending must be a positive integer')
  }
  // base64url nonce string → { rawKey, expiresAt }. The raw key is copied at
  // issue: the entry, not the caller's buffer, is the recorded identity.
  const pending = new Map()

  // Issue a fresh single-use nonce bound to the presented raw key. The key
  // shape gate belongs to the route's handler (it owns the wire-field
  // rejection); the registry defends its own invariant — a recorded
  // identity that is not a raw 32-byte key could never verify an answer.
  function issue(rawKey) {
    if (!(rawKey instanceof Uint8Array) || rawKey.length !== CHALLENGE_NONCE_BYTES) {
      throw new AgentRoomRuntimeError(
        'invalid_argument',
        `challenge issue requires the raw ${CHALLENGE_NONCE_BYTES}-byte Ed25519 public key as a Buffer or Uint8Array`,
      )
    }
    const timestamp = now()
    // Lazy sweep: expired entries leave the Map at the next issue, not on a
    // timer — no unbounded growth from idle expirations.
    for (const [nonce, entry] of pending) {
      if (entry.expiresAt <= timestamp) pending.delete(nonce)
    }
    // Capacity: oldest-pending (insertion order) after the sweep — the bound
    // holds under sustained issuance, mirroring the session registry's
    // oldest-expired-then-oldest eviction.
    while (pending.size >= maxPending) {
      pending.delete(pending.keys().next().value)
    }
    const nonce = randomBytes(CHALLENGE_NONCE_BYTES).toString('base64url')
    pending.set(nonce, { rawKey: Buffer.from(rawKey), expiresAt: timestamp + ttlMs })
    return nonce
  }

  // Spend a nonce: the delete happens FIRST, so whatever this call returns —
  // a recorded key, expiry, or nothing — the nonce is gone and a replayed or
  // corrected answer finds an empty slot. Returns the recorded raw key while
  // it is still alive, null otherwise.
  function consume(nonce) {
    if (typeof nonce !== 'string' || nonce.length === 0) return null
    const entry = pending.get(nonce)
    if (!entry) return null
    pending.delete(nonce)
    if (now() >= entry.expiresAt) return null
    return entry.rawKey
  }

  // The pending count, for tests and diagnostics. Read-only: a copy of the
  // size, never the entries.
  function pendingCount() {
    return pending.size
  }

  return { issue, consume, pendingCount }
}
