// Story 7.5 acceptance — instruments that recompute (retro actions A4 +
// A10): the flight-kit freshness observer (one shared arithmetic module for
// capture AND verification) and the evidence verifier's recomputation of
// the shipped REL-1 bundle. The rows pin the two properties the story
// names: the verifier RECOMPUTES the freshness arithmetic instead of
// grepping for it, and the recording's own container metadata is parsed.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { buildFreshnessDocument, recomputeFreshnessDocument } from '../scripts/rel1-freshness.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const NODE = process.execPath
const OBSERVER = join(ROOT, 'scripts', 'rel1-freshness-observe.mjs')
const VERIFIER = join(ROOT, 'scripts', 'rel1-verify-evidence.mjs')
const SHIPPED_BUNDLE = join(ROOT, 'docs', 'release-evidence', 'v0.2.0-rel1')

test('the shipped REL-1 freshness document recomputes exactly, from its own raw epochs', () => {
  const document = JSON.parse(readFileSync(join(SHIPPED_BUNDLE, 'freshness.json'), 'utf8'))
  assert.deepEqual(recomputeFreshnessDocument(document), [])
  // The two authoritative figures of record (the release-gate erratum).
  assert.equal(document.same_clock_measurement.freshness_seconds, 0.15)
  assert.equal(document.cross_machine_measurement.corrected_freshness_seconds, 0.276)
})

test('a tampered derived number fails the recomputation — the verifier judges arithmetic, not prose', () => {
  const document = JSON.parse(readFileSync(join(SHIPPED_BUNDLE, 'freshness.json'), 'utf8'))
  const tampered = structuredClone(document)
  tampered.cross_machine_measurement.corrected_freshness_ms = 1
  const mismatches = recomputeFreshnessDocument(tampered)
  assert.ok(mismatches.length > 0, 'the tampered document must not recompute clean')
  assert.ok(mismatches.some(entry => entry.includes('corrected_freshness_ms')))

  const tamperedBound = structuredClone(document)
  tamperedBound.same_clock_measurement.freshness_seconds = 9
  const boundFailures = recomputeFreshnessDocument(tamperedBound)
  assert.ok(boundFailures.some(entry => entry.includes('exceeds the 5 s bound')))
})

test('the flight-kit observer computes a document from raw numbers, 0600, exact arithmetic', async t => {
  const parent = mkdtempSync(join(tmpdir(), 'agent-room-freshness-observe-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const input = join(parent, 'measurement.json')
  const out = join(parent, 'freshness.json')
  writeFileSync(input, `${JSON.stringify({
    same_clock_measurement: {
      sendAckedEpochMs: 1_792_587_163_320,
      domArrivalEpochMs: 1_792_587_163_470,
      seq: 3,
      text: 'REL1-FRESH-MAC-test',
      sender: 'CLAUDE-MAC-1 (test)',
      senderClock: 'NSG-Mac-mini.local',
    },
    cross_machine_measurement: {
      sendAckedEpochMs: 1_792_587_178_123,
      domArrivalEpochMs: 1_792_587_178_295,
      viewerClock: 'NSG-Mac-mini.local',
      sender: 'CLAUDE-STAGING-1 (test)',
      senderClock: 'ngs-staging',
      macOffsetMs: 485,
      stagingOffsetMs: 589,
      offsetSamplesPerClient: 9,
      seq: 4,
      text: 'REL1-FRESH-STAGING-test',
    },
  })}\n`)
  execFileSync(NODE, [OBSERVER, 'compute', '--input', input, '--out', out], { encoding: 'utf8' })
  assert.equal(statSync(out).mode & 0o777, 0o600, 'the evidence file is owner-only')
  const document = JSON.parse(readFileSync(out, 'utf8'))
  assert.equal(document.same_clock_measurement.freshness_ms, 150)
  assert.equal(document.same_clock_measurement.freshness_seconds, 0.15)
  assert.equal(document.cross_machine_measurement.raw_difference_ms, 172)
  assert.equal(document.cross_machine_measurement.offset_staging_minus_mac_ms, 104)
  assert.equal(document.cross_machine_measurement.corrected_freshness_ms, 276)
  // The writer and the verifier share ONE arithmetic: the produced document
  // recomputes clean through the shared module.
  assert.deepEqual(recomputeFreshnessDocument(document), [])
})

test('the observer refuses to bless a bound violation (exit 1, failing verdicts recorded)', async t => {
  const parent = mkdtempSync(join(tmpdir(), 'agent-room-freshness-bad-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const input = join(parent, 'measurement.json')
  const out = join(parent, 'freshness.json')
  writeFileSync(input, `${JSON.stringify({
    same_clock_measurement: {
      sendAckedEpochMs: 1_000_000,
      domArrivalEpochMs: 8_000_000,
      seq: 3,
      text: 'slow-canary',
      sender: 'a',
      senderClock: 'a',
    },
    cross_machine_measurement: {
      sendAckedEpochMs: 1_000_000,
      domArrivalEpochMs: 2_000_000,
      viewerClock: 'a',
      sender: 'b',
      senderClock: 'b',
      macOffsetMs: 0,
      stagingOffsetMs: 0,
      offsetSamplesPerClient: 9,
      seq: 4,
      text: 'cross-canary',
    },
  })}\n`)
  let exitStatus = 0
  try {
    execFileSync(NODE, [OBSERVER, 'compute', '--input', input, '--out', out], { encoding: 'utf8' })
  } catch (error) {
    exitStatus = error.status ?? 1
  }
  assert.equal(exitStatus, 1, 'a bound violation exits non-zero')
  const failed = (() => { try { return JSON.parse(readFileSync(out, 'utf8')) } catch { return null } })()
  assert.ok(failed, 'the failing evidence file was still written (honest record, failing verdicts)')
  assert.ok(failed.same_clock_measurement.verdict.startsWith('fail'))
})

test('the evidence verifier recomputes the shipped REL-1 bundle green, with the FR rows present', () => {
  const output = execFileSync(NODE, [VERIFIER, '--dir', SHIPPED_BUNDLE], { encoding: 'utf8' })
  assert.match(output, /\[PASS\] FR:freshness .*recomputed from its raw epochs/)
  assert.match(output, /\[PASS\] FR:recording .*webm \(EBML\)/)
  assert.match(output, /RESULT: EVIDENCE VERIFIED/)
})

test('the observer snippet is the flight-kit browser instrumentation (A4)', () => {
  const snippet = execFileSync(NODE, [OBSERVER, 'snippet'], { encoding: 'utf8' })
  assert.match(snippet, /MutationObserver/)
  assert.match(snippet, /dom_arrival_epoch_ms/)
})
