// Story 7.6 acceptance — the retained-state disposition is recomputed from
// the archived attempt-6 trace and cannot drift from its evidence (retro
// action A11's open part: the provisional threshold is calibrated by this
// first trace; the diagnostic itself stays reported, never gated).

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TRACE = join(ROOT, 'docs', 'release-evidence', 'v0.2.0-soak-attempts', 'attempt6-3929cc7-server-gc-trace.log')

test('the attempt-6 retained-state disposition: below instrument resolution, no repair', () => {
  const report = JSON.parse(execFileSync(process.execPath, [
    join(ROOT, 'scripts', 'rel3-retained-state-analysis.mjs'),
    '--trace', TRACE,
    '--json',
  ], { encoding: 'utf8' }))

  // The trace parses completely and the window is the ratified final four
  // hours of a twelve-hour run.
  assert.equal(report.majorsParsed, 142)
  assert.ok(report.runSpanHours > 12 && report.runSpanHours < 12.2)
  assert.equal(report.window.observations, 57)

  // The robust core is exactly flat: the mode holds ~90% of the window, the
  // transient-excluded slope is zero, and the endpoint never moved a single
  // display bucket.
  assert.equal(report.window.modeMiB, 9.2)
  assert.ok(report.window.modeShare > 0.85, `the window's mode share: ${report.window.modeShare}`)
  assert.equal(report.window.olsPctPerHour_coreNoTransients, 0)
  assert.equal(report.window.endpointMovementBuckets, 0)

  // The instrument's own resolution floor at this heap size exceeds the
  // recorded "rising" claim's endpoint signal — the classification cannot
  // be distinguished from quantization noise, which IS the disposition.
  assert.ok(report.window.instrumentResolutionPctPerHour > 0.25)
  assert.ok(Math.abs(report.window.olsPctPerHour_all) < 0.5, `the all-points OLS stays inside the flat tolerance: ${report.window.olsPctPerHour_all}`)

  // The whole-run shape is warmup-then-plateau, not a leak's creeping mode:
  // the plateau holds for the last nine-plus hours.
  assert.equal(report.wholeRun.firstHourModeMiB, 8.5)
  assert.equal(report.wholeRun.plateauMiB, 9.2)
  assert.ok(report.wholeRun.plateauHours > 9)
})

test('the shipped results file keeps its recorded diagnostic untouched (reported, never gated)', () => {
  const results = JSON.parse(readFileSync(join(ROOT, 'docs', 'release-evidence', 'v0.2.0-soak-results.json'), 'utf8'))
  const retained = results.retainedState
  assert.equal(retained.status, 'reported')
  assert.equal(retained.gated, false)
  assert.equal(retained.classification, 'rising')
  assert.equal(retained.slopePctPerHour, 0.6538)
  assert.equal(retained.usedHeapMiB_first, 9.2)
  // The disposition record sits beside it, and the evidence stands as
  // captured — the two coexist by design.
  const disposition = readFileSync(join(ROOT, 'docs', 'implementation', 'rel3-retained-state-disposition-2026-10-29.md'), 'utf8')
  assert.match(disposition, /RECORDED NON-DEFECT/)
  assert.match(disposition, /below the instrument's own resolution/)
  assert.match(disposition, /never edited/)
})
