#!/usr/bin/env node
// The REL-3 soak's QUIET-HOST ELIGIBILITY SCORER (Story 6.2; the 2026-10-22
// amendment).
//
// WHY IT EXISTS. The amendment pre-registered a quiet-host contract and an
// outcome shape: a window that breaches the contract is CONFOUNDED — the
// attempt is recorded under its own name as incomplete, never scored, never
// re-scored. A rule with no scorer is an awk somebody improvises at hour
// twelve, with the result already half-known. This script is that scorer: it
// reads the frozen thresholds and the observer's log, and it produces a
// verdict.
//
// WHAT IT DOES NOT DO. It does not judge the soak. It answers one question —
// was the host's measured window admissible under the contract? — and it can
// only ever say ELIGIBLE, CONFOUNDED or INCOMPLETE. A valid host window
// permits the unchanged memory and other gates to be scored; it does not
// confer a PASS.
//
// THE THRESHOLDS COME FROM A FILE, not from here. `docs/implementation/
// rel3-quiet-host-thresholds.json` was registered before the run and is never
// adjusted afterwards, so the contract and the scorer cannot drift apart.
//
// USAGE:
//   node scripts/rel3-soak-eligibility.mjs --telemetry <log> --run-start <ISO>
//        [--run-end <ISO>] [--thresholds <json>] [--out <json>]
//
//   --telemetry   the observer's log (one line per sample)
//   --run-start   when the run started (ISO 8601)
//   --run-end     when the run ended (ISO 8601); defaults to run-start +
//                 the duration implied by the registered window
//   --out         where to write the verdict (default: stdout)
//
// Exit 0 = ELIGIBLE. Exit 1 = CONFOUNDED or INCOMPLETE (the verdict says
// which, and why). A missing or unreadable input is INCOMPLETE, never
// eligible.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

function parseArgs(argv) {
  const options = {
    telemetry: null,
    runStart: null,
    runEnd: null,
    thresholds: join(ROOT, 'docs', 'implementation', 'rel3-quiet-host-thresholds.json'),
    out: null,
    reportBaseline: false
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--telemetry') options.telemetry = argv[++index]
    else if (arg === '--run-start') options.runStart = argv[++index]
    else if (arg === '--run-end') options.runEnd = argv[++index]
    else if (arg === '--thresholds') options.thresholds = argv[++index]
    else if (arg === '--out') options.out = argv[++index]
    else if (arg === '--report-baseline') options.reportBaseline = true
    else throw new Error(`usage: node scripts/rel3-soak-eligibility.mjs --telemetry <log> --run-start <ISO> [--run-end <ISO>] [--thresholds <json>] [--out <json>] — unknown argument ${arg}`)
  }
  if (!options.telemetry) throw new Error('usage: --telemetry is required')
  if (!options.runStart) throw new Error('usage: --run-start is required')
  return options
}

const fieldsOf = line => {
  const fields = {}
  for (const token of line.trim().split(/\s+/)) {
    const index = token.indexOf('=')
    if (index > 0) fields[token.slice(0, index)] = token.slice(index + 1)
  }
  return fields
}

const numeric = value => {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

const parseSamples = log => {
  const samples = []
  const problems = []
  const lines = log.split('\n')
  lines.forEach((line, index) => {
    if (!line.trim()) return
    const fields = fieldsOf(line)
    const at = Date.parse(fields.ts ?? '')
    if (!Number.isFinite(at)) {
      problems.push(`line ${index + 1}: no parsable timestamp`)
      return
    }
    const foreignCores = numeric(fields.foreignCores)
    const foreignProcs = numeric(fields.foreignProcs)
    const ownProcs = numeric(fields.ownProcs)
    const memAvailable = numeric(fields.memAvailable_kB)
    const gap = numeric(fields.gapSec)
    if (foreignCores === null || foreignProcs === null || ownProcs === null || memAvailable === null) {
      problems.push(`line ${index + 1}: a required field is missing or not a number`)
      return
    }
    samples.push({
      at,
      ts: fields.ts,
      foreignCores,
      foreignProcs,
      ownProcs,
      memAvailableBytes: memAvailable * 1024,
      gapSec: gap
    })
  })
  return { samples, problems }
}

// The nearest-rank percentile: the smallest value at or above which at least
// the requested fraction of the samples fall. Registered as the method so
// that no interpolation choice can change a verdict.
const nearestRank = (values, fraction) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil(fraction * sorted.length)
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]
}

const rollingMeanMax = (values, windowSize) => {
  if (values.length < windowSize) return null
  let worst = 0
  for (let index = windowSize - 1; index < values.length; index += 1) {
    let sum = 0
    for (let back = 0; back < windowSize; back += 1) sum += values[index - back]
    const mean = sum / windowSize
    if (mean > worst) worst = mean
  }
  return worst
}

const main = argv => {
  const options = parseArgs(argv)
  const thresholdsRaw = readFileSync(options.thresholds, 'utf8')
  const thresholds = JSON.parse(thresholdsRaw)
  const thresholdsDigest = `sha256:${createHash('sha256').update(thresholdsRaw).digest('hex')}`

  const runStart = Date.parse(options.runStart)
  if (!Number.isFinite(runStart)) throw new Error(`--run-start is not a parsable timestamp: ${options.runStart}`)

  // --report-baseline prints the DISTRIBUTION of the baseline window — the
  // host's foreign state before the run — so the thresholds can be calibrated
  // against a measurement of this host rather than against an invented number.
  // It judges nothing.
  const reportBaseline = (baseline, baselineForeignProcs, thresholdsDigest, options) => {
    const cores = baseline.map(sample => sample.foreignCores)
    const mean = cores.length ? cores.reduce((sum, value) => sum + value, 0) / cores.length : null
    const document = {
      report: 'baseline distribution — the host\'s foreign state before the run',
      thresholdsDigest,
      samples: baseline.length,
      firstSample: baseline.length ? baseline[0].ts : null,
      lastSample: baseline.length ? baseline[baseline.length - 1].ts : null,
      foreignProcessMax: baselineForeignProcs,
      foreignCores: {
        mean: mean === null ? null : Number(mean.toFixed(4)),
        median: cores.length ? nearestRank(cores, 0.5) : null,
        p95: cores.length ? nearestRank(cores, 0.95) : null,
        max: cores.length ? Math.max(...cores) : null,
        rolling5mMax: cores.length ? rollingMeanMax(cores, thresholds.foreignCores.rollingMinutes) : null
      },
      memAvailableFloorBytes: baseline.length ? Math.min(...baseline.map(sample => sample.memAvailableBytes)) : null
    }
    const text = `${JSON.stringify(document, null, 2)}\n`
    if (options.out) writeFileSync(options.out, text)
    else process.stdout.write(text)
  }

  const reasons = []
  let telemetry = ''
  try {
    telemetry = readFileSync(options.telemetry, 'utf8')
  } catch (error) {
    reasons.push(`the telemetry log could not be read: ${error.message}`)
  }

  const { samples, problems } = parseSamples(telemetry)
  reasons.push(...problems)

  // The baseline is the samples BEFORE the run's first own process: the
  // host's foreign state with no run present. It is measured, not asserted.
  const firstOwnIndex = samples.findIndex(sample => sample.ownProcs > 0)
  // With no run present at all (a host characterization window), every sample
  // is baseline.
  const baseline = firstOwnIndex === -1 ? samples : samples.slice(0, firstOwnIndex)
  const baselineForeignProcs = baseline.length
    ? Math.max(...baseline.map(sample => sample.foreignProcs))
    : null
  const baselineForeignCoresMean = baseline.length
    ? baseline.reduce((sum, sample) => sum + sample.foreignCores, 0) / baseline.length
    : null

  if (options.reportBaseline) {
    reportBaseline(baseline, baselineForeignProcs, thresholdsDigest, options)
    return 0
  }

  // The measured window: the final `tailHours` of the run. The window's end is
  // the run's end — the same instant the harness's final-window RSS rule uses
  // — so the host window and the memory window are the same four hours. When
  // --run-end is not given, the last telemetry sample stands in for it, and
  // the document says which was used.
  const tailMs = thresholds.window.tailHours * 3600 * 1000
  const parsedRunEnd = options.runEnd ? Date.parse(options.runEnd) : null
  const windowEndSource = options.runEnd
    ? 'run-end'
    : samples.length > 0
      ? 'last-sample'
      : 'none'
  const windowEnd = options.runEnd
    ? parsedRunEnd
    : samples.length > 0
      ? samples[samples.length - 1].at
      : runStart + tailMs
  const windowStart = windowEnd - tailMs
  const window = samples.filter(sample => sample.at >= windowStart && sample.at <= windowEnd)

  const expectedSamples = Math.round(tailMs / (thresholds.cadenceSeconds * 1000))
  const coverage = expectedSamples > 0 ? window.length / expectedSamples : 0

  // --- the gates -------------------------------------------------------------------------------
  const metrics = {
    windowStart: new Date(windowStart).toISOString(),
    windowEnd: new Date(windowEnd).toISOString(),
    windowEndSource,
    windowSamples: window.length,
    expectedSamples,
    coverage: Number(coverage.toFixed(4)),
    baselineSamples: baseline.length,
    baselineForeignProcessMax: baselineForeignProcs,
    baselineForeignCoresMean: baselineForeignCoresMean === null ? null : Number(baselineForeignCoresMean.toFixed(4))
  }

  if (baseline.length === 0) {
    reasons.push('the baseline is missing: no sample precedes the run\'s first own process')
  }
  if (window.length === 0) {
    reasons.push('the measured window holds no samples')
  }
  if (window.length > 0 && coverage < thresholds.coverage.minimumSampleFraction) {
    reasons.push(`coverage ${coverage.toFixed(3)} is below the registered minimum ${thresholds.coverage.minimumSampleFraction}`)
  }
  const badGaps = window.filter(sample => sample.gapSec === null || Math.abs(sample.gapSec - thresholds.cadenceSeconds) > thresholds.cadenceToleranceSeconds)
  if (badGaps.length > 0) {
    reasons.push(`${badGaps.length} sample(s) are not at the registered ${thresholds.cadenceSeconds}s cadence`)
  }

  let memFloor = Infinity
  let maxForeignProcs = 0
  let meanForeignCores = 0
  let p95ForeignCores = null
  let rollingMax = null
  if (window.length > 0) {
    memFloor = Math.min(...window.map(sample => sample.memAvailableBytes))
    maxForeignProcs = Math.max(...window.map(sample => sample.foreignProcs))
    const cores = window.map(sample => sample.foreignCores)
    meanForeignCores = cores.reduce((sum, value) => sum + value, 0) / cores.length
    p95ForeignCores = nearestRank(cores, 0.95)
    rollingMax = rollingMeanMax(cores, thresholds.foreignCores.rollingMinutes)
  }

  metrics.memAvailableFloorBytes = memFloor === Infinity ? null : memFloor
  metrics.maxForeignProcesses = maxForeignProcs
  metrics.foreignCoresMean = Number(meanForeignCores.toFixed(4))
  metrics.foreignCoresP95 = p95ForeignCores
  metrics.foreignCoresRolling5mMax = rollingMax === null ? null : Number(rollingMax.toFixed(4))

  // (a) the available-memory floor
  if (metrics.memAvailableFloorBytes !== null && metrics.memAvailableFloorBytes < thresholds.memAvailableFloorBytes) {
    reasons.push(`the available memory fell to ${(metrics.memAvailableFloorBytes / 1073741824).toFixed(2)} GiB, below the ${(thresholds.memAvailableFloorBytes / 1073741824).toFixed(0)} GiB floor`)
  }
  // (b) the foreign process count, against the MEASURED baseline
  if (baselineForeignProcs !== null) {
    const allowance = baselineForeignProcs + thresholds.foreignProcessHeadroom
    metrics.foreignProcessAllowance = allowance
    if (maxForeignProcs > allowance) {
      reasons.push(`the foreign process count reached ${maxForeignProcs}, above the measured baseline ${baselineForeignProcs} + ${thresholds.foreignProcessHeadroom}`)
    }
  }
  // (c) the foreign CPU, in three shapes
  if (window.length > 0) {
    if (meanForeignCores > thresholds.foreignCores.windowMeanMax) {
      reasons.push(`the window mean foreign CPU was ${meanForeignCores.toFixed(3)} cores, above the ${thresholds.foreignCores.windowMeanMax}`)
    }
    if (p95ForeignCores !== null && p95ForeignCores > thresholds.foreignCores.p95Max) {
      reasons.push(`the nearest-rank p95 foreign CPU was ${p95ForeignCores.toFixed(3)} cores, above the ${thresholds.foreignCores.p95Max}`)
    }
    if (rollingMax !== null && rollingMax > thresholds.foreignCores.rollingMeanMax) {
      reasons.push(`the worst rolling ${thresholds.foreignCores.rollingMinutes}-minute foreign CPU mean was ${rollingMax.toFixed(3)} cores, above the ${thresholds.foreignCores.rollingMeanMax}`)
    }
  }

  // The disposition: data problems make the attempt INCOMPLETE; a breached
  // threshold makes it CONFOUNDED. Neither is a FAIL and neither is a PASS.
  const dataProblems = reasons.filter(reason =>
    reason.includes('could not be read') ||
    reason.includes('no parsable timestamp') ||
    reason.includes('required field is missing') ||
    reason.includes('the baseline is missing') ||
    reason.includes('the measured window holds no samples') ||
    reason.includes('coverage') ||
    reason.includes('cadence'))
  const thresholdBreaches = reasons.filter(reason => !dataProblems.includes(reason))
  const verdict = dataProblems.length > 0
    ? thresholds.dispositions.missingOrInvalidTelemetry
    : thresholdBreaches.length > 0
      ? thresholds.dispositions.breach
      : 'eligible'

  const document = {
    verdict,
    scope: 'quiet-host eligibility only — this does not judge the soak, and it does not confer a PASS',
    thresholdsFile: options.thresholds,
    thresholdsDigest,
    runStart: new Date(runStart).toISOString(),
    runEnd: new Date(windowEnd).toISOString(),
    runEndSource: windowEndSource,
    metrics,
    reasons,
    dataProblems,
    thresholdBreaches,
    dispositions: thresholds.dispositions
  }

  const text = `${JSON.stringify(document, null, 2)}\n`
  if (options.out) writeFileSync(options.out, text)
  else process.stdout.write(text)
  return verdict === 'eligible' ? 0 : 1
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (error) {
  process.stdout.write(`${JSON.stringify({ verdict: 'incomplete', reason: error.message }, null, 2)}\n`)
  process.exitCode = 1
}
