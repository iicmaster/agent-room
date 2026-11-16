// Pure loop-guard boundary tests — no filesystem, no SQLite, no server.
import assert from 'node:assert/strict'
import test from 'node:test'

import { classifyWake, coalesce } from '../server/notification/loop-guard.mjs'
import {
  LOOP_GLOBAL_LIMIT,
  LOOP_PAIR_LIMIT,
  LOOP_WARN_AT,
  TRAILING_COALESCE_MS,
} from '../server/constants.mjs'

const NOW = 1_700_000_000_000
const counter = (count, expiresAt = NOW + 1000) => ({ count, expires_at: expiresAt })

test('G1 boundaries: warn at 6, allow through 8, pause from 9', () => {
  const global = counter(0)
  // Ordinals 1-5 wake quietly.
  for (let charged = 0; charged < LOOP_WARN_AT - 1; charged += 1) {
    const verdict = classifyWake({ pair: counter(charged), globalCounter: global, now: NOW })
    assert.equal(verdict.action, 'wake', `charged=${charged}`)
  }
  // 6th, 7th, 8th warn but still wake.
  for (let charged = LOOP_WARN_AT - 1; charged < LOOP_PAIR_LIMIT; charged += 1) {
    const verdict = classifyWake({ pair: counter(charged), globalCounter: global, now: NOW })
    assert.equal(verdict.action, 'warn', `charged=${charged}`)
    assert.ok(verdict.reasons.includes('pair_warn'))
  }
  // 9th (pairCount = 8) hard-pauses; local-only, no dispatch.
  const paused = classifyWake({ pair: counter(LOOP_PAIR_LIMIT), globalCounter: global, now: NOW })
  assert.equal(paused.action, 'pause')
  assert.ok(paused.reasons.includes('pair_limit'))
})

test('G2: shared budget pauses from the 26th wake', () => {
  const pair0 = counter(0)
  for (let charged = 0; charged < LOOP_GLOBAL_LIMIT; charged += 1) {
    assert.notEqual(classifyWake({ pair: pair0, globalCounter: counter(charged), now: NOW }).action, 'pause')
  }
  const paused = classifyWake({ pair: pair0, globalCounter: counter(LOOP_GLOBAL_LIMIT), now: NOW })
  assert.equal(paused.action, 'pause')
  assert.ok(paused.reasons.includes('global_limit'))
})

test('G1/G2 TTL: expired counters are fresh windows (count 0)', () => {
  const expired = counter(LOOP_PAIR_LIMIT, NOW - 1)
  assert.equal(classifyWake({ pair: expired, globalCounter: expired, now: NOW }).action, 'wake')
})

test('G3: leading edge is 0 ms; burst coalesces by key; trailing within window delays', () => {
  const candidates = Array.from({ length: 50 }, (_, index) => ({ room_id: 'r', peer: `p${index % 7}` }))
  const leading = coalesce(candidates, { now: NOW, lastWakeAt: null })
  assert.equal(leading.fire, true)
  assert.equal(leading.delayMs, 0)
  assert.equal(leading.batch.length, 7) // 50 arrivals, 7 distinct pairs = 1 cycle (+1 per pair)

  const trailing = coalesce(candidates, { now: NOW + 20, lastWakeAt: NOW })
  assert.equal(trailing.fire, true)
  assert.equal(trailing.delayMs, TRAILING_COALESCE_MS - 20)
  assert.equal(trailing.batch.length, leading.batch.length)

  const settled = coalesce(candidates, { now: NOW + TRAILING_COALESCE_MS, lastWakeAt: NOW })
  assert.equal(settled.delayMs, 0)
  assert.equal(coalesce([], { now: NOW }).fire, false)
})
