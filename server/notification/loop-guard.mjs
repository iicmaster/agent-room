// Story 3.2 — the PURE wake loop guard. No filesystem, no SQLite, no clock
// reads beyond the injected `now`: every decision is a function of its inputs
// so the G1/G2 boundaries and the G3 timing are testable in isolation.
//
// The guard has no idea what a trust matrix or a cursor is. It is handed the
// CURRENT counters (the number of wakes already CHARGED in the live TTL window,
// each with its `expires_at`) and decides about the NEXT wake:
//   - G1 per (local, peer, room): warn at wake 6, allow through wake 8, block
//     from wake 9. The counter reaches LOOP_PAIR_LIMIT (8) after the 8th wake;
//     a 9th is the first one refused.
//   - G2 per Session Scope across all rooms: block once the global counter has
//     reached LOOP_GLOBAL_LIMIT (25), i.e. from the 26th wake.
//   - Both counters are silent once `expires_at <= now` (30 min TTL) — an
//     expired window is a fresh window with count 0.
// A `pause` verdict is local-only: the caller prints a wake-reset hint and
// posts NOTHING to chat. A `warn` verdict STILL wakes (it is a signal, not a
// block); `reasons` carries the warning text for diagnostics.
//
// coalesce() implements G3: a leading-edge wake at 0 ms when the guard is
// idle, and a trailing 150 ms window that folds a burst of many peers into a
// SINGLE wake cycle (the caller charges +1 per G2 and +1 per distinct pair in
// the returned batch). Candidates dedupe by `key` (default room_id:peer), so
// 50 arrivals of the same pair collapse to one.

import {
  LOOP_GLOBAL_LIMIT,
  LOOP_PAIR_LIMIT,
  LOOP_WARN_AT,
  TRAILING_COALESCE_MS,
} from '../constants.mjs'

// A counter is live only while its expiry is in the future. A missing or
// malformed counter is an empty window (count 0) — fail-closed toward waking.
function liveCount(counter, now) {
  if (!counter || !Number.isFinite(counter.expires_at)) return 0
  if (counter.expires_at <= now) return 0
  return Number.isSafeInteger(counter.count) && counter.count > 0 ? counter.count : 0
}

// Decide about the next wake. `pair` = {count, expires_at} for this
// (local_session_id, peer_session_id, room_id); `globalCounter` = the scope's
// shared budget; `now` = the decision time (epoch ms).
export function classifyWake({ pair, globalCounter, now = Date.now() } = {}) {
  const pairCount = liveCount(pair, now)
  const globalCount = liveCount(globalCounter, now)
  const reasons = []

  // The next wake's ordinal is count + 1. Pause from wake 9 (pairCount >= 8)
  // or wake 26 (globalCount >= 25). Pause wins over warn and wake.
  if (pairCount >= LOOP_PAIR_LIMIT) {
    reasons.push('pair_limit')
    return { action: 'pause', reasons, pairCount, globalCount }
  }
  if (globalCount >= LOOP_GLOBAL_LIMIT) {
    reasons.push('global_limit')
    return { action: 'pause', reasons, pairCount, globalCount }
  }
  const nextOrdinal = pairCount + 1
  if (nextOrdinal >= LOOP_WARN_AT) reasons.push('pair_warn')
  return { action: reasons.length > 0 ? 'warn' : 'wake', reasons, pairCount, globalCount }
}

// G3 coalescing. `candidates` is an array of {key?, room_id?, peer?, at?}.
// `lastWakeAt` is the epoch ms of the last fired cycle, or null when idle.
// Returns { fire, delayMs, batch }:
//   fire    — whether this batch should be woken (false only for empty input)
//   delayMs — 0 on the leading edge (idle) or an elapsed window; otherwise the
//             remaining trailing-coalesce time before the batch should fire
//   batch   — the deduplicated candidate list, one wake cycle
export function coalesce(candidates, { now = Date.now(), trailingMs = TRAILING_COALESCE_MS, lastWakeAt = null } = {}) {
  if (!Array.isArray(candidates) || candidates.length === 0) return { fire: false, delayMs: 0, batch: [] }
  const seen = new Set()
  const batch = []
  for (const candidate of candidates) {
    const key = typeof candidate?.key === 'string'
      ? candidate.key
      : `${candidate?.room_id ?? ''}:${candidate?.peer ?? candidate?.peer_session_id ?? ''}`
    if (seen.has(key)) continue
    seen.add(key)
    batch.push(candidate)
  }
  if (batch.length === 0) return { fire: false, delayMs: 0, batch: [] }
  const idle = lastWakeAt === null || !Number.isFinite(lastWakeAt) || now - lastWakeAt >= trailingMs
  if (idle) return { fire: true, delayMs: 0, batch }
  const elapsed = now - lastWakeAt
  return { fire: true, delayMs: Math.max(0, trailingMs - elapsed), batch }
}
