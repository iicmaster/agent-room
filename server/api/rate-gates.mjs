// Generic in-process token-bucket utility retained for unit testing and custom
// gates. Post-auth per-Actor request/send token buckets were retired in Story 1.1
// in favor of the bounded write queue and pre-auth enrollment limiter.

import { AgentRoomRuntimeError } from '../runtime.mjs'

function requirePositiveNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new AgentRoomRuntimeError('invalid_argument', `${name} must be a positive finite number`)
  }
  return value
}

function requirePositiveInteger(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new AgentRoomRuntimeError('invalid_argument', `${name} must be a positive safe integer`)
  }
  return value
}

export function createTokenBucketGate({
  refillPerSecond = 0.5,
  capacity = 10,
  now = Date.now,
} = {}) {
  requirePositiveNumber(refillPerSecond, 'refillPerSecond')
  requirePositiveInteger(capacity, 'capacity')
  if (typeof now !== 'function') {
    throw new AgentRoomRuntimeError('invalid_argument', 'token bucket now must be a function')
  }
  // Refill carried as tokens-per-millisecond; a full refill horizon is how
  // long an idle bucket needs to reach capacity — the sweep's expiry age.
  const refillPerMs = refillPerSecond / 1000
  const fullRefillMs = capacity / refillPerMs
  const buckets = new Map()

  function check(key) {
    if (typeof key !== 'string' || key.length === 0) {
      throw new AgentRoomRuntimeError('invalid_argument', 'token bucket check requires a non-empty key')
    }
    const timestamp = now()
    // Lazy sweep: an entry idle past the full-refill horizon is provably at
    // capacity again; dropping it equals refilling it.
    for (const [entryKey, entry] of buckets) {
      if (timestamp - entry.lastMs >= fullRefillMs) buckets.delete(entryKey)
    }
    const entry = buckets.get(key)
    let tokens
    if (entry) {
      tokens = Math.min(capacity, entry.tokens + (timestamp - entry.lastMs) * refillPerMs)
    } else {
      tokens = capacity
    }
    if (tokens < 1) {
      buckets.set(key, { tokens, lastMs: timestamp })
      return {
        ok: false,
        retryAfterMs: Math.max(1, Math.ceil((1 - tokens) / refillPerMs)),
      }
    }
    buckets.set(key, { tokens: tokens - 1, lastMs: timestamp })
    return { ok: true }
  }

  return { check }
}
