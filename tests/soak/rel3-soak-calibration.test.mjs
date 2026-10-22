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
// An hour in milliseconds — the unit the growth rates are expressed in.
const MS_PER_HOUR = 3_600_000
const SAMPLE_MS = 60_000
const WINDOW_SAMPLES = FOUR_HOURS_MS / SAMPLE_MS

// A trace over the measured window: 240 one-minute samples, the shape of the
// server's GC sawtooth (a 25-minute cycle), optionally with a linear growth
// term of `growthPerHour` (a fraction of the starting RSS per hour).
// The synthetic traces are built in MiB: every quantity the evaluator
// derives is a RATIO (growth per unit), so the unit cancels and no byte
// conversion — and no restated limit — appears in this file.
function sawtoothTrace({
  startRssMiB = 100,
  amplitudeMiB = 7,
  cycleSamples = 25,
  growthPerHour = 0,
  samples = WINDOW_SAMPLES,
  phase = 0,
} = {}) {
  const base = startRssMiB
  return Array.from({ length: samples }, (_, index) => {
    const cycle = ((index + phase) % cycleSamples) / (cycleSamples - 1)
    const growth = base * (growthPerHour / 100) * ((index * (SAMPLE_MS / MS_PER_HOUR)))
    return {
      atMs: index * SAMPLE_MS,
      rssBytes: base * (1 + (amplitudeMiB / startRssMiB) * cycle) + growth,
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

test('KNOWN LIMITATION: a persistent step at the tail passes the band', () => {
  // The release-gate review of the amendment produced this counterexample
  // itself, and it is PINNED here as a limitation of the ratified band
  // rather than left undiscovered: a retained step that persists through the
  // observed tail (100 MiB for 235 samples, then 110 MiB) is reported by
  // the regression as about +1.2% — inside the 2% band — and therefore
  // PASSES.
  //
  // The rule is FR-13's band, not a universal leak detector, and the
  // amendment says so. This row exists so the limitation can never be
  // rediscovered as a surprise, and so nobody can claim the band proves the
  // absence of a late step.
  const samples = sawtoothTrace({ phase: 0, amplitudeMiB: 0 })
  const stepAt = samples.length - 5
  for (let index = stepAt; index < samples.length; index += 1) {
    samples[index] = { ...samples[index], rssBytes: Math.round(samples[index].rssBytes * 1.1) }
  }
  const verdict = evaluate(samples)
  assert.equal(verdict.pass, true, 'the pinned limitation: a persistent tail step passes the band')
  assert.ok(
    verdict.impliedGrowthRatio > 0 && verdict.impliedGrowthRatio < BOUND,
    `the step is reported as a positive but sub-bound growth: ${verdict.impliedGrowthRatio}`,
  )
})

test('KNOWN LIMITATION: near the bound the band is still phase-sensitive', () => {
  // The same review's second counterexample, pinned: a growth rate just
  // under the band is read differently depending on where the GC cycle sits
  // in the window — some phases pass, some fail. The band is a finite noise
  // band, and this is what that means.
  const outcomes = []
  for (let phase = 0; phase < 25; phase += 1) {
    const verdict = evaluate(sawtoothTrace({ phase, growthPerHour: 0.55 }))
    outcomes.push(verdict.pass)
  }
  const passes = outcomes.filter(Boolean).length
  assert.ok(passes > 0 && passes < outcomes.length,
    `the pinned limitation: the band is phase-sensitive near the bound (${passes}/${outcomes.length} phases passed)`)
})

test('KNOWN LIMITATION: a DECELERATING leak looks like equilibration and passes', () => {
  // The fourth limit, from the gate review: a leak whose rate decays
  // (logarithmic, 1/t) has exactly the shape of a process approaching its
  // asymptote, so at hours 8-12 the band cannot tell them apart. This is why
  // the retained-state diagnostic exists - and why no four-hour band can make
  // that distinction. It is pinned so it is never rediscovered as a surprise.
  const base = 100
  const samples = Array.from({ length: WINDOW_SAMPLES }, (_, index) => {
    const fraction = (index + 1) / WINDOW_SAMPLES
    // a 1/t decay: steep at first, then flat - the shape equilibration makes
    const decay = 12 * (1 / fraction - 1) / (WINDOW_SAMPLES - 1)
    return { atMs: index * SAMPLE_MS, rssBytes: Math.round(base + decay) }
  })
  const verdict = evaluate(samples)
  assert.equal(verdict.pass, true, 'the pinned limitation: a decelerating leak passes the band')
})

test('KNOWN LIMITATION: the retained-state diagnostic needs temporal coverage, not a count', () => {
  // Four confirmed collections inside a few milliseconds are four
  // observations, not a four-hour trend: the diagnostic must read
  // INCONCLUSIVE, never PASS, and never a flat verdict.
  const samples = sawtoothTrace({ samples: WINDOW_SAMPLES })
  const schedule = { finalWindowMs: FOUR_HOURS_MS, rampMs: 0 }
  const clustered = Array.from({ length: 8 }, (_, index) => ({ childAtMs: index, usedHeapMiB: 40 }))
  const verdict = evaluateRetainedState(clustered, schedule, samples, 0)
  assert.equal(verdict.status, 'inconclusive', 'a clustered set of collections is not a trend')
  assert.equal(verdict.gated, false)
  assert.ok(verdict.windowSpanFraction < 0.5, 'the coverage shortfall is reported, not hidden')

  // And an excursion that hides between two equal endpoints must not read as
  // "no change": the trend is FITTED over the observations.
  const excursion = [
    { childAtMs: 0, usedHeapMiB: 40 },
    { childAtMs: 60 * 60_000, usedHeapMiB: 80 },
    { childAtMs: 120 * 60_000, usedHeapMiB: 90 },
    { childAtMs: 180 * 60_000, usedHeapMiB: 40 },
  ]
  const fitted = evaluateRetainedState(excursion, schedule, samples, 0)
  assert.equal(fitted.status, 'reported')
  assert.notEqual(fitted.classification, 'flat', 'the fitted trend sees the excursion')
  assert.ok(fitted.observations.length >= 4, 'the observations are retained with the verdict')
})

test('the phase lottery is replayed on attempt 1\'s OWN residuals — the run that PASSED', () => {
  // The gate review's second calibration gap: the synthetic sawtooth (7 MiB
  // amplitude, a 25-minute cycle) is gentler than the real traces, so the
  // phase-sensitivity row understates the real lottery. The fix is to replay
  // the phase sweep on the residuals of attempt 1's window - the run that
  // PASSED, so this cannot be fitting to the run under dispute.
  const stored = JSON.parse(readFileSync(
    join(ROOT, 'docs/release-evidence/v0.2.0-soak-results.json'),
    'utf8',
  ))
  const windowSamples = stored.samples.data.filter(
    sample => sample.atMs >= stored.samples.data[stored.samples.data.length - 1].atMs - stored.schedule.finalWindowMs,
  )
  assert.ok(windowSamples.length >= 100, `attempt 1's window holds ${windowSamples.length} samples`)
  const outcomes = []
  for (let phase = 0; phase < 25; phase += 1) {
    const shifted = windowSamples.map((sample, index) => ({
      ...sample,
      rssBytes: sample.rssBytes + Math.round(6 * Math.sin(((index + phase) / 25) * 2 * Math.PI)),
    }))
    outcomes.push(evaluateFinalWindowRss(shifted, stored.schedule, true).pass)
  }
  const passes = outcomes.filter(Boolean).length
  // The pinned property, on the run that PASSED (so this is not fitting to
  // the run under dispute): the band is phase-ROBUST on a real trace that
  // carries headroom - attempt 1's window declined, so every phase passes.
  // Together with the near-bound row above, the band's character is precise:
  // robust when there is headroom, phase-sensitive when the verdict sits
  // near the bound.
  assert.equal(passes, outcomes.length,
    `the band must pass at every phase on attempt 1's own residuals (${passes}/${outcomes.length} phases passed)`)
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

  // A trace with confirmed natural major collections spread across the
  // window: the used heap after them is flat — REPORTED, never gated. The
  // collections must span at least half the window (the temporal coverage
  // the trend needs) and come from one load phase.
  const flat = []
  for (let index = 0; index < 12; index += 1) {
    flat.push({ childAtMs: index * 20 * 60_000, usedHeapMiB: 40 })
  }
  const reported = evaluateRetainedState(flat, schedule, samples, 0)
  assert.equal(reported.status, 'reported')
  assert.equal(reported.gated, false, 'the diagnostic never gates')
  assert.equal(reported.classification, 'flat', 'a flat used heap reads flat')
  assert.equal(reported.slopePctPerHour, 0)

  // The same diagnostic with a growing live set: the trend is visible.
  const growing = flat.map((event, index) => ({ ...event, usedHeapMiB: 40 + index * 0.5 }))
  const growingVerdict = evaluateRetainedState(growing, schedule, samples, 0)
  assert.equal(growingVerdict.classification, 'rising', 'a growing live set reads rising')
  assert.ok(growingVerdict.slopePctPerHour > 0, 'and the fitted trend is positive')

  // Too few collections inside the window: INCONCLUSIVE, never PASS.
  const thin = evaluateRetainedState(flat.slice(0, MAJOR_GC_MIN_EVENTS_IN_WINDOW - 1), schedule, samples, 0)
  assert.equal(thin.status, 'inconclusive')
  assert.equal(thin.gated, false, 'an inadequate coverage never becomes a diagnostic PASS')
})

test('the GC trace parser reads V8\'s major-collection lines', () => {
  const trace = [
    '[1234:0x7f9c2a1b3d40]     42 ms: Scavenge 10.2 (12.0) -> 9.8 (12.0) MB, 1.2 / 0.0 ms  (average mu = 1.000, current mu = 1.000) allocation failure',
    '[1234:0x7f9c2a1b3d40]   1104 ms: Mark-Compact 12.4 (14.0) -> 9.6 (13.2) MB, 3.1 / 0.0 ms  (average mu = 1.000, current mu = 1.000) allocation failure',
    '[1234:0x7f9c2a1b3d40]   2104 ms: Mark-Sweep 13.1 (14.0) -> 9.9 (13.4) MB, 2.4 / 0.0 ms  (average mu = 1.000, current mu = 1.000) allocation failure',
    // A scavenge - including the "(reduce)" spelling - is a YOUNG-generation
    // collection: the used heap after it still carries uncollected
    // old-generation garbage, so it is NOT the reachable set. Counting it
    // would inflate the coverage and contaminate the fitted trend.
    '[1234:0x7f9c2a1b3d40]   2204 ms: Scavenge (reduce) 13.4 (14.0) -> 12.9 (14.2) MB, 0.6 / 0.0 ms  (average mu = 1.000, current mu = 1.000) allocation failure',
  ].join('\n')
  const events = parseMajorGcUsedHeapMiB(trace)
  assert.equal(events.length, 2, 'only the major collections are read')
  assert.equal(events[0].childAtMs, 1104)
  assert.equal(events[0].usedHeapMiB, 9.6, 'the used heap AFTER the collection')
  assert.equal(events[1].childAtMs, 2104)
  assert.equal(events[1].usedHeapMiB, 9.9)
})
