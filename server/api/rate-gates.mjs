// The per-key rate gates (Story 4.4, FR-16): one token-bucket mechanism, two
// declared budgets. The send bucket (SEND_TOKEN_REFILL_PER_SECOND refill,
// SEND_TOKEN_CAPACITY capacity, per Actor, on the send route) and the request
// budget (REQUEST_BUDGET_PER_MINUTE sustained, REQUEST_BUDGET_BURST burst, per
// Actor, on every authenticated request — failed, replayed, and long-polls
// counted once at admission) are the same arithmetic over different constants,
// all imported by name from the constants module (AD-9 — no restated numbers
// anywhere in this module).
//
// In-process by design, like every other admission gate in this server (the
// 4.2 enroll limiter precedent): one server process owns one realm's budget
// state. State is per-key lazily-created buckets, swept lazily on each check —
// a bucket idle for a full refill horizon is provably full again, so dropping
// it is exactly equivalent to refilling it, and the map never holds more than
// the keys active within one horizon.
//
// The values are operator-tunable abuse FLOORS (startServer overrides, env
// surface for the direct launch), never a volumetric-DoS guarantee — FR-16's
// own words for an invite-only realm.
//
// `now` is injectable so tests can roll time without waiting on the wall
// clock. A refusal verdict carries retryAfterMs — the ceil of the time one
// token needs to refill — which the budgets stage answers as the rate_limited
// envelope's retry_after_ms extra (the rate_limited refusal always names its
// delay, FR-17).

import {
  REQUEST_BUDGET_BURST,
  REQUEST_BUDGET_PER_MINUTE,
  SEND_TOKEN_CAPACITY,
  SEND_TOKEN_REFILL_PER_SECOND,
} from '../constants.mjs'
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

// One token bucket per key. A verdict is {ok: true} or
// {ok: false, retryAfterMs}: the caller answers refusals as the coded
// rate_limited with the delay attached, and consumed tokens stay consumed —
// the gate counts admitted attempts, whatever the handler later answers
// (FR-16: failed and replayed attempts count).
export function createTokenBucketGate({
  refillPerSecond = SEND_TOKEN_REFILL_PER_SECOND,
  capacity = SEND_TOKEN_CAPACITY,
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

// The named pair the budgets stage consumes (Story 4.4): the send bucket on
// the send route and the request budget over every authenticated request.
// Both default to the declared constants; startServer passes operator floors
// through. `now` threads to both gates so a test drives them on one clock.
export function createRateGates({
  sendTokenRefillPerSecond = SEND_TOKEN_REFILL_PER_SECOND,
  sendTokenCapacity = SEND_TOKEN_CAPACITY,
  requestBudgetPerMinute = REQUEST_BUDGET_PER_MINUTE,
  requestBudgetBurst = REQUEST_BUDGET_BURST,
  now = Date.now,
} = {}) {
  return {
    sendBucketGate: createTokenBucketGate({
      refillPerSecond: sendTokenRefillPerSecond,
      capacity: sendTokenCapacity,
      now,
    }),
    // The sustained rate is declared per minute; the bucket consumes per
    // request, so the refill converts exactly once, here.
    requestBudgetGate: createTokenBucketGate({
      refillPerSecond: requestBudgetPerMinute / 60,
      capacity: requestBudgetBurst,
      now,
    }),
  }
}
