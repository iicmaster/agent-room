// The calibration for the amended REL-3 rule (Story 6.2; the 2026-10-22 ruling
// and pre-registration in
// docs/implementation/spec-6-2-rel-3-the-formal-soak.md.amendment-2026-10-22.md).
//
// WHAT THIS FILE IS FOR. A rule that is amended after three red runs can only be
// trusted if it is validated on traces whose ground truth is KNOWN — never on the
// run it was written about. So this suite drives the REAL evaluator (imported
// from the harness, not copied) over synthetic traces with injected growth around
// the bound, and it replays the ARCHIVED runs as DIAGNOSTICS. The archived
// replays are labelled as such in their own output: they are history, not
// calibration targets, and the amendment must not be fitted to them.
//
// THE PROPERTIES THE PRE-REGISTRATION FIXES, one test each:
//   1. the gate is FR-13's single band (the slope), and the endpoint growth is
//      reported, never gated;
//   2. a STATIONARY sawtooth (the GC cycle's shape) passes at EVERY phase —
//      the phase-sensitivity that made the old endpoint term unusable is gone;
//   3. real, sustained growth FAILS — the rule still detects a leak;
//   4. the measured window is the final FOUR HOURS, whatever the run's length;
//   5. the archived runs, replayed, keep their own verdicts — attempt 4 still
//      FAILS under the amended rule, so the amendment rescues nothing;
//   6. the retained-state diagnostic reads INCONCLUSIVE when the coverage is
//      thin and reports (never gates) a trend when it is not.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  FOUR_HOURS_MS,
  MAJOR_GC_MIN_EVENTS_IN_WINDOW,
  deriveSchedule,
  evaluateFinalWindowRss,
  evaluateRetainedState,
  parseMajorGcUsedHeapMiB,
} from './rel3-soak.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const BOUND = 0.02
const SAMPLE_MS = 60_000
const WINDOW_SAMPLES = FOUR_HOURS_MS / SAMPLE_MS

// A trace over the measured window: 240 one-minute samples, the shape of the
// server's GC sawtooth (a 25-minute cycle), optionally with a linear growth
// term of `growthPerHour` (a fraction of the starting RSS per hour).
function sawtoothTrace({
  startRssMiB = 100,
  amplitudeMiB = 7,
  cycleSamples = 25,
  growthPerHour = 0,
  samples = WINDOW_SAMPLES,
  phase = 0,
} = {}) {
  const base = startRssMiB * 1024 * 1024
  return Array.from({ length: samples }, (_, index) => {
    const cycle = ((index + phase) % cycleSamples) / (cycleSamples - 1)
    const growth = base * (growthPerHour / 100) * ((index * (SAMPLE_MS / 3_600_000)))
    return {
      atMs: index * SAMPLE_MS,
      rssBytes: Math.round(base * (1 + (amplitudeMiB / startRssMiB) * cycle) + growth),
    }
  })
}

function evaluate(samples, schedule = { finalWindowMs: FOUR_HOURS_MS }) {
  return evaluateFinalWindowRss(samples, schedule, true)
}

test('the gate is FR-13\'s single band: the slope decides, and the endpoint is reported only', () => {
  const stationary = evaluate(sawtoothTrace({ phase: 0 }))
  assert.equal(stationary.gatedTerm, 'slope_implied_growth')
  assert.equal(stationary.reportedOnly.endpoint_growthRatio, stationary.growthRatio)
  assert.equal(typeof stationary.reportedOnly.endpoint_pass, 'boolean')

  // A trace whose ENDPOINT grows but whose SLOPE does not: the old rule failed
  // it (the endpoint term), the ratified rule passes it. This is the
  // phase-sensitivity the demotion removes — a single late spike (the drain's
  // reading, for instance) cannot fail a stability rule.
  const spiked = sawtoothTrace({ phase: 0 })
  spiked[spiked.length - 1] = { ...spiked[spiked.length - 1], rssBytes: spiked[0].rssBytes * 1.08 }
  const verdict = evaluate(spiked)
  assert.equal(verdict.pass, true, 'the spike is reported, not gated')
  assert.equal(verdict.reportedOnly.endpoint_pass, false, 'and the report still shows the endpoint growth')
})

test('a stationary sawtooth passes at EVERY phase — the rule is phase-robust', () => {
  const verdicts = []
  for (let phase = 0; phase < 25; phase += 1) {
    const verdict = evaluate(sawtoothTrace({ phase }))
    verdicts.push({ phase, pass: verdict.pass, endpoint: verdict.growthRatio, slope: verdict.impliedGrowthRatio })
  }
  assert.equal(
    verdicts.every(entry => entry.pass === true),
    true,
    `the slope band must clear a stationary sawtooth at every phase: ${JSON.stringify(verdicts)}`,
  )
  // The endpoint term — now reported only — still swings across the phases:
  // that is the property the demotion removes, and it is what the report
  // exists to show.
  const endpoints = verdicts.map(entry => entry.endpoint)
  assert.ok(Math.max(...endpoints) - Math.min(...endpoints) > 0.02, 'the endpoint term really is phase-sensitive')
})

test('sustained growth is still detected: the rule does not become blind', () => {
  // A retainer at 1%/hour over the four-hour window is well past the 2% band
  // and must fail the gate.
  const leaking = evaluate(sawtoothTrace({ growthPerHour: 1 }))
  assert.equal(leaking.pass, false, 'a 1%/hour retainer must fail the ratified band')
  assert.ok(leaking.impliedGrowthRatio > BOUND, `the slope must carry the growth: ${leaking.impliedGrowthRatio}`)

  // And a growth rate comfortably INSIDE the band must pass: the rule is not
  // simply stricter now, it is measuring the right thing.
  const settled = evaluate(sawtoothTrace({ growthPerHour: 0.2 }))
  assert.equal(settled.pass, true, 'a 0.2%/hour drift is inside the band and must pass')
})

test('the measured window is the final FOUR HOURS at any run length', () => {
  const twelveHours = deriveSchedule(12 * 3_600_000)
  assert.equal(twelveHours.finalWindowMs, FOUR_HOURS_MS, 'a 12-hour run still measures the final four hours')
  assert.equal(twelveHours.rampMs, FOUR_HOURS_MS, 'the payload ramp is bounded to four hours')
  const eightHours = deriveSchedule(8 * 3_600_000)
  assert.equal(eightHours.finalWindowMs, FOUR_HOURS_MS, 'the 8-hour default is unchanged')
  assert.equal(eightHours.rampMs, FOUR_HOURS_MS, 'and so is its ramp')
  const compressed = deriveSchedule(5 * 60_000)
  assert.equal(compressed.finalWindowMs, 150_000, 'the compressed validation keeps its proportional window')
  assert.equal(compressed.rampMs, 150_000, 'and its proportional ramp')
})

test('the archived runs keep their own verdicts — the amendment rescues nothing', () => {
  const archived = [
    ['docs/release-evidence/v0.2.0-soak-results.json', 'attempt 1 (7dc980f)'],
    ['docs/release-evidence/v0.2.0-soak-attempts/attempt2-89c8477.json', 'attempt 2 (89c8477)'],
    ['docs/release-evidence/v0.2.0-soak-attempts/attempt4-3929cc7.json', 'attempt 4 (3929cc7)'],
  ]
  const verdicts = []
  for (const [relative, label] of archived) {
    const stored = JSON.parse(readFileSync(join(ROOT, relative), 'utf8'))
    const schedule = stored.schedule
    const replayed = evaluateFinalWindowRss(stored.samples.data, schedule, true)
    verdicts.push({ label, stored: stored.rules.finalWindowRss, replayed })
    // The replay is an exact replay of the stored rule on the stored samples.
    assert.equal(replayed.growthRatio, stored.rules.finalWindowRss.growthRatio, `${label}: the endpoint replay`)
    assert.equal(replayed.impliedGrowthRatio, stored.rules.finalWindowRss.impliedGrowthRatio, `${label}: the slope replay`)
  }
  // Attempt 4 — the run the amendment was written after — still fails the
  // ratified band. If this ever stops being true, the amendment has been
  // fitted to the run and the calibration has stopped meaning anything.
  const attempt4 = verdicts.find(entry => entry.label.startsWith('attempt 4'))
  assert.equal(attempt4.replayed.pass, false, 'attempt 4 still fails the amended rule')
  assert.ok(
    attempt4.replayed.impliedGrowthRatio > BOUND,
    `attempt 4's slope-implied growth must still exceed the band: ${attempt4.replayed.impliedGrowthRatio}`,
  )
})

test('the retained-state diagnostic reports a trend when the coverage is there and is inconclusive when it is not', () => {
  const samples = sawtoothTrace({ samples: WINDOW_SAMPLES }).map(sample => ({ atMs: sample.atMs, rssBytes: sample.rssBytes }))
  const schedule = { finalWindowMs: FOUR_HOURS_MS }

  // A trace with confirmed natural major collections: the used heap after them
  // is flat — REPORTED, never gated.
  const flat = []
  for (let index = 0; index < 12; index += 1) {
    flat.push({ childAtMs: index * 10 * 60_000, usedHeapMiB: 40 })
  }
  const reported = evaluateRetainedState(flat, schedule, samples, 0)
  assert.equal(reported.status, 'reported')
  assert.equal(reported.gated, false, 'the diagnostic never gates')
  assert.equal(reported.growthRatio, 0)

  // The same diagnostic with a growing live set: the trend is visible.
  const growing = flat.map((event, index) => ({ ...event, usedHeapMiB: 40 + index * 0.5 }))
  const growingVerdict = evaluateRetainedState(growing, schedule, samples, 0)
  assert.ok(growingVerdict.growthRatio > 0, 'a growing live set shows up in the diagnostic')

  // Too few collections inside the window: INCONCLUSIVE, never PASS.
  const thin = evaluateRetainedState(flat.slice(0, MAJOR_GC_MIN_EVENTS_IN_WINDOW - 1), schedule, samples, 0)
  assert.equal(thin.status, 'inconclusive')
})

test('the GC trace parser reads V8\'s major-collection lines', () => {
  const trace = [
    '[1234:0x7f9c2a1b3d40]     42 ms: Scavenge 10.2 (12.0) -> 9.8 (12.0) MB, 1.2 / 0.0 ms  (average mu = 1.000, current mu = 1.000) allocation failure',
    '[1234:0x7f9c2a1b3d40]   1104 ms: Mark-Compact 12.4 (14.0) -> 9.6 (13.2) MB, 3.1 / 0.0 ms  (average mu = 1.000, current mu = 1.000) allocation failure',
    '[1234:0x7f9c2a1b3d40]   2104 ms: Mark-Sweep 13.1 (14.0) -> 9.9 (13.4) MB, 2.4 / 0.0 ms  (average mu = 1.000, current mu = 1.000) allocation failure',
  ].join('\n')
  const events = parseMajorGcUsedHeapMiB(trace)
  assert.equal(events.length, 2, 'only the major collections are read')
  assert.equal(events[0].childAtMs, 1104)
  assert.equal(events[0].usedHeapMiB, 9.6, 'the used heap AFTER the collection')
  assert.equal(events[1].childAtMs, 2104)
  assert.equal(events[1].usedHeapMiB, 9.9)
})
