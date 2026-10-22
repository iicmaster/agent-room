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
// `--expect-thresholds-digest` binds a verdict to the exact file that was
// registered, so a file edited after the fact cannot quietly re-define the
// contract a run was judged under.
//
// THE TWO FAILURE SHAPES ARE KEPT APART, because they are different claims.
// A DATA problem — the telemetry or the configuration is missing, invalid or
// unusable — makes the attempt INCOMPLETE: the window was never measured, so
// it cannot be a quiet host. A THRESHOLD breach — the host's measured window
// violated the contract — makes it CONFOUNDED: the window WAS measured, and
// the host was not quiet. Neither is a FAIL and neither is a PASS, and a data
// problem outranks a breach, because a number that cannot be trusted cannot
// be compared with a limit.
//
// EVERY READING IS A MEASUREMENT OR IT IS NOTHING. A sample that cannot be
// parsed is never skipped: it makes the verdict INCOMPLETE, with the line and
// the field named. A minute that was not measured is not a quiet minute.
//
// THE WINDOW IS A STRETCH OF TIME, NOT A SET OF ROWS. The observer's sample
// grid and the harness's tracker boundary are DIFFERENT clocks — the
// observer samples on the minute, the tracker anchors the final window to
// its own last sample — so the two do not have to coincide. The window is
// therefore judged by the INTERVALS THAT OVERLAP it, each clipped to the
// window's bounds: a sample just after the window's end still closes an
// interval that starts inside the window, and that interval's seconds are
// the window's. An unmeasured PREFIX of the window is a data problem exactly
// like an unmeasured tail. The window is never moved to fit the samples, and
// its end is never chosen after seeing the night.
//
// EVERY LINE IS CHECKED AGAINST ITSELF. The observer's flags are its word
// about itself, and a broken observer cannot be trusted to report that it is
// broken. So the raw accounting — the monotonic counters, the elapsed time,
// the process census, the foreign CPU against its own microseconds — is
// verified independently, and a disagreement is a DATA problem naming the
// sample and the field.
//
// USAGE:
//   node scripts/rel3-soak-eligibility.mjs --telemetry <log> --run-start <ISO>
//        [--run-end <ISO>] [--rss-window-end <ISO>] [--thresholds <json>]
//        [--baseline-extra <log>]... --expect-thresholds-digest <sha256:...>
//        [--report-baseline] [--out <json>]
//
//   --telemetry               the observer's log (one line per sample)
//   --run-start               when the run started (ISO 8601) — REQUIRED
//   --run-end                 when the run ended (ISO 8601) — REQUIRED unless
//                             --rss-window-end is given; when both are given
//                             --run-end wins, because it is the run's own end
//   --rss-window-end          the harness's final-window end, used as the
//                             window's end when --run-end is not given
//   --thresholds              the frozen thresholds (default: the repository's)
//   --baseline-extra          an earlier measurement of the same host with the
//                             same observer (repeatable); every line of it is
//                             held to the same rules as the run's own log
//   --expect-thresholds-digest  the digest the launch record registered; a
//                             mismatch is INCOMPLETE. It is REQUIRED for a
//                             scoring run: a verdict that is not bound to a
//                             thresholds file is a verdict against whatever
//                             file happened to be on disk, so without it the
//                             scorer scores nothing and exits 2. The
//                             baseline REPORT judges nothing and may go
//                             without one — and says so in its output.
//   --report-baseline         print the baseline's distribution and judge
//                             nothing (exit 0 when the baseline is usable)
//   --out                     where to write the verdict (default: stdout)
//
// Exit 0 = ELIGIBLE. Exit 1 = CONFOUNDED or INCOMPLETE (the verdict says
// which, and why). Exit 2 = a USAGE error: the invocation was malformed, so
// NOTHING was scored. A missing or unreadable input is INCOMPLETE, never
// eligible.

import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const DEFAULT_THRESHOLDS = join(ROOT, 'docs', 'implementation', 'rel3-quiet-host-thresholds.json')
const USAGE = 'usage: node scripts/rel3-soak-eligibility.mjs --telemetry <log> --run-start <ISO> --expect-thresholds-digest <sha256:...> [--run-end <ISO>] [--rss-window-end <ISO>] [--thresholds <json>] [--baseline-extra <log>]... [--report-baseline] [--out <json>]'

// The observer's timestamp is the first, BARE token of the line — not a
// key=value pair. Anything else is not this observer's format.
const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/
// A strict decimal number: no hex, no "Infinity", no "NaN", no thousands
// separators, no empty string. Number('') is 0, and a field that reads as
// zero because it was EMPTY is a field that was not measured.
const DECIMAL = /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/

// The fields a sample must carry, and the shape each one has. The observer
// writes every one of them on every line, so a line that lacks one is not a
// measurement this observer made.
const REQUIRED_NUMBERS = ['memAvailable_kB', 'foreignCores', 'foreignUs', 'gapSec']
const REQUIRED_COUNTS = ['nodeProcs', 'ownProcs', 'foreignProcs', 'busyJiffies', 'runCpuUs', 'obsCpuUs']
// The observer's own validity signals: 1 = the accounting held, 0 = it did
// not. A sample whose accounting failed is not a measurement, whatever its
// numbers say.
const REQUIRED_FLAGS = ['interval', 'deltaValid', 'obsCgroupOk', 'obsReadOk', 'runCgroupOk']
// Reported, never gated.
const REPORTED_NUMBERS = ['stealCores', 'serverRss_kB', 'pgmajfault', 'runCpuSec']

const strictNumber = raw => {
  if (typeof raw !== 'string' || raw === '' || !DECIMAL.test(raw)) return null
  const value = Number(raw)
  return Number.isFinite(value) ? value : null
}

const parseArgs = argv => {
  const options = {
    telemetry: null,
    runStart: null,
    runEnd: null,
    rssWindowEnd: null,
    thresholds: DEFAULT_THRESHOLDS,
    out: null,
    reportBaseline: false,
    baselineExtra: [],
    expectThresholdsDigest: null
  }
  const errors = []
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    const value = () => {
      const next = argv[index + 1]
      if (next === undefined) {
        errors.push(`${arg} needs a value`)
        return null
      }
      index += 1
      return next
    }
    if (arg === '--telemetry') options.telemetry = value()
    else if (arg === '--run-start') options.runStart = value()
    else if (arg === '--run-end') options.runEnd = value()
    else if (arg === '--rss-window-end') options.rssWindowEnd = value()
    else if (arg === '--thresholds') options.thresholds = value()
    else if (arg === '--out') options.out = value()
    else if (arg === '--expect-thresholds-digest') options.expectThresholdsDigest = value()
    else if (arg === '--report-baseline') options.reportBaseline = true
    else if (arg === '--baseline-extra') {
      const extra = value()
      if (extra !== null) options.baselineExtra.push(extra)
    } else errors.push(`unknown argument ${arg} — ${USAGE}`)
  }
  if (!options.telemetry) errors.push('--telemetry is required — the observer\'s log')
  if (!options.runStart) errors.push('--run-start is required — when the run started')
  if (!options.runEnd && !options.rssWindowEnd) {
    errors.push('--run-end is required — when the run ended (or --rss-window-end, the harness\'s final-window end)')
  }
  return { options, errors }
}

// One line of the observer's log, parsed strictly.
//
// The rules are strict because a line that half-parsed is a line whose
// accounting cannot be trusted, and a half-parsed line that is SKIPPED would
// turn into a minute of the window that was never measured. A minute that was
// never measured is not a quiet minute, so an unparsable line makes the whole
// attempt INCOMPLETE and names the line and the field.
const parseLine = (line, lineNumber, source) => {
  const tokens = line.trim().split(/\s+/).filter(token => token.length > 0)
  if (tokens.length === 0) return { blank: true }

  // The timestamp is the FIRST, BARE token.
  const first = tokens[0]
  if (first.includes('=')) {
    return { error: `line ${lineNumber}: the timestamp is the first, bare token — this line starts with a field` }
  }
  if (!ISO_INSTANT.test(first)) {
    return { error: `line ${lineNumber}: the timestamp ${JSON.stringify(first)} is not an ISO-8601 instant` }
  }
  const at = Date.parse(first)
  if (!Number.isFinite(at)) {
    return { error: `line ${lineNumber}: the timestamp ${JSON.stringify(first)} does not parse to an instant` }
  }

  const fields = {}
  let load = null
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    const equals = token.indexOf('=')
    if (equals <= 0) continue
    const key = token.slice(0, equals)
    if (key === 'load') {
      // The 5- and 15-minute load averages follow the 1-minute one as bare
      // numbers. The load average is REPORTED and never gated: it counts the
      // run's own uninterruptible waits.
      const values = [token.slice(equals + 1)]
      for (let ahead = index + 1; ahead < tokens.length && values.length < 3; ahead += 1) {
        if (tokens[ahead].includes('=')) break
        values.push(tokens[ahead])
      }
      load = values.map(strictNumber)
      continue
    }
    fields[key] = token.slice(equals + 1)
  }

  const sample = { at, ts: first, line: lineNumber, source, load }
  const problems = []

  for (const key of REQUIRED_NUMBERS) {
    const raw = fields[key]
    if (raw === undefined) {
      problems.push(`line ${lineNumber}: ${key} is missing`)
      continue
    }
    if (raw === '') {
      problems.push(`line ${lineNumber}: ${key} is empty`)
      continue
    }
    const value = strictNumber(raw)
    if (value === null) {
      problems.push(`line ${lineNumber}: ${key} is not a finite number (${JSON.stringify(raw)})`)
      continue
    }
    if (value < 0) {
      problems.push(`line ${lineNumber}: ${key} is negative (${raw})`)
      continue
    }
    sample[key] = value
  }

  for (const key of REQUIRED_COUNTS) {
    const raw = fields[key]
    if (raw === undefined) {
      problems.push(`line ${lineNumber}: ${key} is missing`)
      continue
    }
    if (raw === '') {
      problems.push(`line ${lineNumber}: ${key} is empty`)
      continue
    }
    const value = strictNumber(raw)
    if (value === null) {
      problems.push(`line ${lineNumber}: ${key} is not a finite number (${JSON.stringify(raw)})`)
      continue
    }
    if (!Number.isInteger(value)) {
      problems.push(`line ${lineNumber}: ${key} is not an integer (${raw})`)
      continue
    }
    if (value < 0) {
      problems.push(`line ${lineNumber}: ${key} is negative (${raw})`)
      continue
    }
    sample[key] = value
  }

  for (const key of REQUIRED_FLAGS) {
    const raw = fields[key]
    if (raw === undefined) {
      problems.push(`line ${lineNumber}: ${key} is missing`)
      continue
    }
    if (raw === '') {
      problems.push(`line ${lineNumber}: ${key} is empty`)
      continue
    }
    const value = strictNumber(raw)
    if (value === null || !Number.isInteger(value)) {
      problems.push(`line ${lineNumber}: ${key} is not an integer (${raw})`)
      continue
    }
    if (value !== 0 && value !== 1) {
      problems.push(`line ${lineNumber}: ${key} is neither 0 nor 1 (${raw})`)
      continue
    }
    sample[key] = value
  }

  // The reported-only numbers: read defensively, because a diagnostic that
  // fails to parse must not take the measurement down with it.
  for (const key of REPORTED_NUMBERS) {
    const value = strictNumber(fields[key])
    if (value !== null) sample[key] = value
  }

  if (problems.length > 0) return { error: problems.join('; ') }
  return { sample }
}

// The RAW ACCOUNTING of a source, checked against ITSELF and independently
// of the observer's own flags.
//
// WHY. The flags are the observer's word about itself, and the word of
// something that mis-read a counter is exactly what cannot be trusted: the
// observer that read a counter wrong is the observer that reports
// "deltaValid=1" while the counter went backwards. So the numbers in a
// line are checked against each other, and a disagreement is a DATA
// problem naming the sample and the field — never a silent pass.
//
// The checks are the ones the observer's own arithmetic rests on:
//   * the raw counters are MONOTONIC. A cgroup's usage_usec and the host's
//     busy jiffies only grow; a decrease is a failed read;
//   * `interval=1` claims an interval, so it must have elapsed time, and
//     `interval=0` claims the log's first sample, so it must have none;
//   * the process census must ADD UP: nodeProcs is ownProcs + foreignProcs;
//   * the derived foreignCores must be the raw foreignUs over the elapsed
//     gap, to within the rounding the observer applies.
const FOREIGN_CORES_TOLERANCE = 0.002

const verifyAccounting = (samples, source) => {
  const problems = []
  const MONOTONIC = ['busyJiffies', 'runCpuUs', 'obsCpuUs']
  samples.forEach((sample, index) => {
    const previous = index === 0 ? null : samples[index - 1]
    for (const field of MONOTONIC) {
      if (previous !== null && sample[field] < previous[field]) {
        problems.push(`${source}: line ${sample.line}: ${field} went backwards (${previous[field]} at line ${previous.line}, then ${sample[field]}) — a counter that decreases is a failed read, not a measurement`)
      }
    }
    if (sample.interval === 1 && !(sample.gapSec > 0)) {
      problems.push(`${source}: line ${sample.line}: interval=1 with gapSec=${sample.gapSec} — an interval with no elapsed time is not an interval`)
    }
    if (sample.interval === 0 && sample.gapSec !== 0) {
      problems.push(`${source}: line ${sample.line}: interval=0 with gapSec=${sample.gapSec} — only the first sample of a log has no previous sample to difference against, and no elapsed time`)
    }
    if (sample.nodeProcs !== sample.ownProcs + sample.foreignProcs) {
      problems.push(`${source}: line ${sample.line}: nodeProcs=${sample.nodeProcs} does not equal ownProcs+foreignProcs (${sample.ownProcs}+${sample.foreignProcs}) — the process census does not add up`)
    }
    if (sample.gapSec > 0) {
      const rate = sample.foreignUs / 1e6 / sample.gapSec
      if (Math.abs(rate - sample.foreignCores) > FOREIGN_CORES_TOLERANCE) {
        problems.push(`${source}: line ${sample.line}: foreignUs=${sample.foreignUs} over gapSec=${sample.gapSec} is ${rate.toFixed(4)} cores, but foreignCores says ${sample.foreignCores} — the derived figure and the raw accounting disagree`)
      }
    }
  })
  return problems
}

// A whole source (the run's log, or an extra baseline source), parsed with
// the same rules. A parse problem is NOT discarded: it is returned, and the
// caller makes the verdict INCOMPLETE.
const parseSource = (text, source) => {
  const samples = []
  const problems = []
  let comments = 0
  const lines = text.split('\n')
  lines.forEach((line, index) => {
    if (!line.trim()) return
    if (line.trim().startsWith('#')) {
      comments += 1
      return
    }
    const parsed = parseLine(line, index + 1, source)
    if (parsed.error) {
      problems.push(`${source}: ${parsed.error}`)
      return
    }
    if (parsed.blank) return
    samples.push(parsed.sample)
  })

  // An interval=0 sample is the observer's FIRST sample — it has no previous
  // sample to difference against. Anywhere else it means the series is not
  // the series the observer writes, and the difference it carries is fiction.
  samples.forEach((sample, index) => {
    if (sample.interval === 0 && index > 0) {
      problems.push(`${source}: line ${sample.line}: interval=0 — only the first sample of a log has no previous sample to difference against`)
    }
  })

  // The samples must be strictly increasing in time. A series that goes
  // backwards or repeats an instant has no usable intervals.
  for (let index = 1; index < samples.length; index += 1) {
    if (samples[index].at <= samples[index - 1].at) {
      problems.push(`${source}: line ${samples[index].line}: the sample's timestamp (${samples[index].ts}) is not after the previous sample's (${samples[index - 1].ts}) — the samples are not strictly increasing in time`)
    }
  }

  // The raw accounting, checked against itself.
  problems.push(...verifyAccounting(samples, source))

  return { samples, problems, comments }
}

// The nearest-rank percentile: the smallest value at or above which at least
// the requested fraction of the samples fall. Registered as the method so
// that no interpolation choice can change a verdict.
//
// CONVENTION, stated because it is a choice: for an EVEN number of samples
// the rank is ceil(0.5 * n), which selects the LOWER of the two middle
// observations. The upper middle would be selected by ceil(0.5 * n) + 1; it
// is not, and the difference is a half-observation of the median.
const nearestRank = (values, fraction) => {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.ceil(fraction * sorted.length)
  return sorted[Math.min(Math.max(rank, 1), sorted.length) - 1]
}

// The ELAPSED-TIME-weighted mean of a series of intervals.
//
// Each interval contributes its sample's value for the interval's own
// duration: the observer writes the residual for the interval that ENDED at
// that sample, so the value and the duration belong together. A ROW mean
// would weight a 45-second interval and a 75-second interval the same, which
// is how a short, hot interval could hide behind a long, quiet one — and how
// a host that was busy for six minutes and idle for three would read as
// quiet.
const weightedMean = intervals => {
  let weighted = 0
  let seconds = 0
  for (const interval of intervals) {
    weighted += interval.value * interval.seconds
    seconds += interval.seconds
  }
  if (seconds <= 0) return { mean: null, seconds: 0 }
  return { mean: weighted / seconds, seconds }
}

// The worst rolling window of the registered length, measured in ELAPSED
// TIME: a window of five minutes of the run's own clock, not five rows. A
// series that drifts off the cadence would otherwise have its rolling figure
// silently lengthened or shortened. When the intervals do not cover the
// rolling length at all, the figure is null — there is nothing to report.
const rollingMeanMax = (intervals, rollingSeconds) => {
  if (intervals.length === 0) return null
  let worst = null
  let weighted = 0
  let seconds = 0
  let start = 0
  for (let index = 0; index < intervals.length; index += 1) {
    weighted += intervals[index].value * intervals[index].seconds
    seconds += intervals[index].seconds
    while (start < index && seconds - intervals[start].seconds >= rollingSeconds) {
      weighted -= intervals[start].value * intervals[start].seconds
      seconds -= intervals[start].seconds
      start += 1
    }
    if (seconds >= rollingSeconds) {
      const mean = weighted / seconds
      if (worst === null || mean > worst) worst = mean
    }
  }
  return worst
}

const rounded = (value, digits = 4) => (value === null || value === undefined ? null : Number(value.toFixed(digits)))

// The dispositions the thresholds file may register. A verdict is one of
// three things — ELIGIBLE, CONFOUNDED or INCOMPLETE — and a disposition that
// is not one of the two the contract knows would let a breached window be
// recorded as something the contract never named ('eligible' being the
// worst case). So an unrecognised disposition is a DATA problem, not a
// disposition.
const RECOGNISED_DISPOSITIONS = ['confounded', 'incomplete']

const readConfiguration = (thresholds, addData) => {
  const config = {
    cadenceSeconds: null,
    cadenceToleranceSeconds: null,
    tailHours: null,
    minimumSampleFraction: null,
    memAvailableFloorBytes: null,
    foreignProcessHeadroom: null,
    foreignProcessLimit: null,
    rollingMinutes: 5,
    baselineMinimumSamples: 12,
    dispositions: { breach: 'confounded', incomplete: 'incomplete' }
  }

  const number = (value, label, { min = null, max = null, required = true } = {}) => {
    if (value === undefined || value === null) {
      if (required) addData('configuration-invalid', `the thresholds file is missing ${label}`)
      return null
    }
    const parsed = strictNumber(String(value))
    if (parsed === null) {
      addData('configuration-invalid', `the thresholds file's ${label} is not a finite number (${JSON.stringify(value)})`)
      return null
    }
    if (min !== null && parsed < min) {
      addData('configuration-invalid', `the thresholds file's ${label} is ${parsed}, which is below ${min}`)
      return null
    }
    if (max !== null && parsed > max) {
      addData('configuration-invalid', `the thresholds file's ${label} is ${parsed}, which is above ${max}`)
      return null
    }
    return parsed
  }

  config.cadenceSeconds = number(thresholds.cadenceSeconds, 'cadenceSeconds', { min: 1 })
  config.cadenceToleranceSeconds = number(thresholds.cadenceToleranceSeconds, 'cadenceToleranceSeconds', { min: 0 })
  config.tailHours = number(thresholds.window?.tailHours, 'window.tailHours', { min: 0 })
  config.minimumSampleFraction = number(thresholds.coverage?.minimumSampleFraction, 'coverage.minimumSampleFraction', { min: 0, max: 1 })
  config.memAvailableFloorBytes = number(thresholds.memAvailableFloorBytes, 'memAvailableFloorBytes', { min: 0 })
  config.foreignProcessHeadroom = number(thresholds.foreignProcessHeadroom, 'foreignProcessHeadroom', { min: 0 })
  // An absolute foreign-process limit, when the thresholds register one.
  config.foreignProcessLimit = thresholds.foreignProcessLimit ?? thresholds.foreignProcs?.limit ?? null
  if (config.foreignProcessLimit !== null) {
    const parsed = number(config.foreignProcessLimit, 'foreignProcessLimit', { min: 0 })
    if (parsed === null) config.foreignProcessLimit = null
    else config.foreignProcessLimit = parsed
  }
  if (thresholds.foreignCores?.rollingMinutes !== undefined) {
    const rolling = number(thresholds.foreignCores.rollingMinutes, 'foreignCores.rollingMinutes', { min: 1 })
    if (rolling !== null) config.rollingMinutes = rolling
  }
  // The baseline's minimum size. The thresholds file does not register one, so
  // the default stands until it does.
  if (thresholds.baseline?.minimumSamples !== undefined) {
    const minimum = number(thresholds.baseline.minimumSamples, 'baseline.minimumSamples', { min: 1 })
    if (minimum !== null) config.baselineMinimumSamples = minimum
  }
  // A disposition that this scorer does not know is not a disposition. It
  // is a broken registration, and it is a broken registration that would
  // otherwise decide the verdict — so it is a DATA problem.
  const disposition = (value, label, fallback) => {
    if (value === undefined || value === null) return fallback
    if (!RECOGNISED_DISPOSITIONS.includes(value)) {
      addData('configuration-invalid', `the thresholds file's dispositions.${label} is ${JSON.stringify(value)}, which is not a disposition this scorer knows (${RECOGNISED_DISPOSITIONS.join(', ')})`)
      return fallback
    }
    return value
  }
  config.dispositions.breach = disposition(thresholds.dispositions?.breach, 'breach', config.dispositions.breach)
  config.dispositions.incomplete = disposition(thresholds.dispositions?.missingOrInvalidTelemetry, 'missingOrInvalidTelemetry', config.dispositions.incomplete)

  return config
}

// The CPU limits, read from the thresholds file.
//
// The file registers the limits RELATIVE to the measured baseline (an
// allowance on top of this host's own measured median and mean), and it MAY
// also register ABSOLUTE limits. The absolute form wins when it is there,
// because a registered number is a contract and a computed one is a
// consequence. The relative limits are computed either way and REPORTED, so
// that a drift between what was registered and what this host now measures is
// visible rather than silently absorbed.
const readCpuLimits = (thresholds, addData) => {
  const foreignCores = thresholds.foreignCores ?? {}
  const advertisedMedian = foreignCores.medianMax ?? null
  const advertisedMean = foreignCores.meanMax ?? null
  const hasAdvertisedMedian = advertisedMedian !== null && advertisedMedian !== undefined
  const hasAdvertisedMean = advertisedMean !== null && advertisedMean !== undefined

  const limits = {
    source: 'none',
    advertisedMedianMax: null,
    advertisedMeanMax: null,
    medianAllowanceCores: null,
    meanAllowanceCores: null,
    computedMedianMax: null,
    computedMeanMax: null,
    medianMax: null,
    meanMax: null
  }

  if (hasAdvertisedMedian !== hasAdvertisedMean) {
    addData('configuration-invalid', 'the thresholds file registers only one of foreignCores.medianMax and foreignCores.meanMax — a half-registered limit set is not a limit set')
    return limits
  }
  if (hasAdvertisedMedian) {
    const median = strictNumber(String(advertisedMedian))
    const mean = strictNumber(String(advertisedMean))
    if (median === null || mean === null) {
      addData('configuration-invalid', 'the thresholds file\'s foreignCores.medianMax / meanMax are not finite numbers')
      return limits
    }
    if (median < 0 || mean < 0) {
      addData('configuration-invalid', 'the thresholds file\'s foreignCores.medianMax / meanMax are negative')
      return limits
    }
    limits.source = 'absolute'
    limits.advertisedMedianMax = median
    limits.advertisedMeanMax = mean
    limits.medianMax = median
    limits.meanMax = mean
  }

  const allowance = (value, label, { required }) => {
    if (value === undefined || value === null) {
      if (required) addData('configuration-invalid', `the thresholds file is missing foreignCores.${label}`)
      return null
    }
    const parsed = strictNumber(String(value))
    if (parsed === null || parsed < 0) {
      addData('configuration-invalid', `the thresholds file's foreignCores.${label} is not a finite, non-negative number (${JSON.stringify(value)})`)
      return null
    }
    return parsed
  }
  // The allowances are only REQUIRED when the relative form is the form in
  // use: a file that registers the absolute limits alone has registered its
  // limits. A file that registers both must register both correctly.
  limits.medianAllowanceCores = allowance(foreignCores.medianAllowanceCores, 'medianAllowanceCores', { required: limits.source !== 'absolute' })
  limits.meanAllowanceCores = allowance(foreignCores.meanAllowanceCores, 'meanAllowanceCores', { required: limits.source !== 'absolute' })

  return limits
}

// The registered expectation of this host's baseline, when the thresholds
// file carries one. Read defensively: the block may live at the top level or
// inside `baseline`, and it may name the numbers under either a plain or a
// "measured" key.
//
// FAIL-CLOSED. The block is the cross-check that this host has not MOVED
// since the registration. A block that cannot be read — absent, not an
// object, a non-numeric number, a negative tolerance, a missing tolerance —
// must not quietly DISABLE that cross-check: a scorer that skips the check
// it could not parse is a scorer judging under a rule nobody registered.
// So a malformed block is a DATA problem, and the attempt is INCOMPLETE.
// The observer's RAW accounting is verified, not taken on trust. The flags
// say whether the observer believed its own numbers; these checks say whether
// the numbers are consistent with each other. A log whose counters go
// backwards, whose totals do not add up, or whose residual disagrees with
// its own cores is not a measurement, whatever its flags say.
const verifyRawAccounting = (samples, label, addData) => {
  const counters = ['busyJiffies', 'runCpuUs', 'obsCpuUs']
  let previous = null
  for (const sample of samples) {
    for (const counter of counters) {
      if (previous !== null && sample[counter] < previous[counter]) {
        addData('accounting-counter-went-backwards', `${label}: the sample at ${sample.ts} reports ${counter}=${sample[counter]}, which is BELOW the previous sample's ${previous[counter]} — a counter that goes backwards is a failed read, not a measurement`)
      }
    }
    if (sample.interval === 1 && !(sample.gapSec > 0)) {
      addData('accounting-interval-without-duration', `${label}: the sample at ${sample.ts} says interval=1 with gapSec=${sample.gapSec} — an interval with no duration is not an interval`)
    }
    if (sample.interval === 0 && sample.gapSec !== 0) {
      addData('accounting-synthetic-sample-with-duration', `${label}: the sample at ${sample.ts} says interval=0 with gapSec=${sample.gapSec} — the first sample of a log has no previous sample to difference against, so it can carry no duration`)
    }
    if (sample.nodeProcs !== sample.ownProcs + sample.foreignProcs) {
      addData('accounting-totals-disagree', `${label}: the sample at ${sample.ts} reports nodeProcs=${sample.nodeProcs} but ownProcs=${sample.ownProcs} + foreignProcs=${sample.foreignProcs} = ${sample.ownProcs + sample.foreignProcs} — the process counts do not add up`)
    }
    if (sample.interval === 1 && sample.gapSec > 0) {
      const implied = sample.foreignUs / 1_000_000 / sample.gapSec
      if (Math.abs(implied - sample.foreignCores) > 0.002) {
        addData('accounting-residual-disagrees-with-cores', `${label}: the sample at ${sample.ts} reports foreignCores=${sample.foreignCores} but foreignUs=${sample.foreignUs} over gapSec=${sample.gapSec} implies ${implied.toFixed(4)} — the residual and the cores disagree`)
      }
    }
    previous = sample
  }
}

const readBaselineExpectation = (thresholds, addData) => {
  const block = thresholds.baselineExpectation ?? thresholds.baseline?.baselineExpectation ?? null
  if (block === null || block === undefined) {
    addData('configuration-invalid', 'the thresholds file registers no baseline expectation — the cross-check that this host has not moved since the registration cannot be skipped')
    return null
  }
  if (typeof block !== 'object' || Array.isArray(block)) {
    addData('configuration-invalid', `the thresholds file's baselineExpectation is not an object (${JSON.stringify(block)})`)
    return null
  }
  const number = (value, label) => {
    if (value === undefined || value === null) return null
    const parsed = strictNumber(String(value))
    if (parsed === null || parsed < 0) {
      addData('configuration-invalid', `the thresholds file's baselineExpectation.${label} is not a finite, non-negative number (${JSON.stringify(value)})`)
      return null
    }
    return parsed
  }
  const toleranceBlock = block.tolerance ?? {}
  const median = number(block.median ?? block.medianCores ?? block.measuredMedian, 'median')
  const mean = number(block.mean ?? block.meanCores ?? block.measuredMean, 'mean')
  const toleranceMedian = number(block.toleranceMedian ?? toleranceBlock.median, 'tolerance.median')
  const toleranceMean = number(block.toleranceMean ?? toleranceBlock.mean, 'tolerance.mean')
  if (median === null && mean === null) {
    addData('configuration-invalid', 'the thresholds file\'s baselineExpectation registers neither a median nor a mean — there is nothing to compare the measured baseline with')
    return null
  }
  // A tolerance is not the scorer's to invent: it is registered with the
  // number it forgives.
  if (median !== null && toleranceMedian === null) {
    addData('configuration-invalid', 'the thresholds file\'s baselineExpectation registers a median with no tolerance — the scorer does not invent one')
  }
  if (mean !== null && toleranceMean === null) {
    addData('configuration-invalid', 'the thresholds file\'s baselineExpectation registers a mean with no tolerance — the scorer does not invent one')
  }
  return {
    median,
    mean,
    tolerance: {
      median: toleranceMedian,
      mean: toleranceMean
    },
    source: thresholds.baselineExpectation ? 'baselineExpectation' : 'baseline.baselineExpectation'
  }
}

const main = argv => {
  const { options, errors } = parseArgs(argv)

  // The thresholds digest is REQUIRED for a scoring run.
  //
  // WHY. The scorer is the named adjudication step, and the verdict it
  // writes is what the attempt's own record is built on. A verdict that is
  // not bound to a thresholds file is a verdict against WHATEVER file was on
  // disk when the scorer ran — and the whole point of freezing the
  // thresholds in a digested file is that a file edited after the launch
  // cannot re-define the contract a night is judged under. So a scoring
  // invocation without the registered digest is a USAGE error: nothing is
  // scored, nothing is written, and the exit code says so. The baseline
  // REPORT judges nothing, so it may go without one — and says so in its
  // output.
  if (!options.reportBaseline && options.expectThresholdsDigest === null) {
    const problems = ['--expect-thresholds-digest is required — the digest the launch record registered for the thresholds file', ...errors]
    process.stderr.write(`rel3-soak-eligibility: ${problems.join('\n  ')}\n${USAGE}\n`)
    return 2
  }

  const findings = []
  const addData = (code, detail) => findings.push({ kind: 'data', code, detail })
  const addBreach = (code, detail) => findings.push({ kind: 'breach', code, detail })
  for (const error of errors) addData('usage', error)

  // --- the thresholds: the contract, and the digest that binds it -----------
  const thresholdsPath = resolve(options.thresholds)
  let thresholdsRaw = ''
  let thresholds = {}
  let thresholdsDigest = null
  try {
    thresholdsRaw = readFileSync(thresholdsPath, 'utf8')
    thresholdsDigest = `sha256:${createHash('sha256').update(thresholdsRaw).digest('hex')}`
  } catch (error) {
    addData('thresholds-unreadable', `the thresholds file could not be read: ${thresholdsPath} (${error.message})`)
  }
  if (thresholdsDigest !== null) {
    try {
      thresholds = JSON.parse(thresholdsRaw)
    } catch (error) {
      thresholds = {}
      addData('thresholds-invalid', `the thresholds file is not valid JSON: ${thresholdsPath} (${error.message})`)
    }
  }
  // The digest comparison is against the file ACTUALLY READ: the bytes the
  // scorer opened, not a path it was told about and not a copy of the
  // registered numbers. A file that changed between the launch and the
  // scoring is a different rule, and the scorer refuses it.
  if (options.expectThresholdsDigest !== null && thresholdsDigest !== null && options.expectThresholdsDigest !== thresholdsDigest) {
    addData('thresholds-digest-mismatch', `the thresholds file's digest is ${thresholdsDigest}, but the launch record registered ${options.expectThresholdsDigest}`)
  }

  const config = readConfiguration(thresholds, addData)
  const limits = readCpuLimits(thresholds, addData)
  const baselineExpectation = readBaselineExpectation(thresholds, addData)

  // --- the run's own bounds -------------------------------------------------
  const runStart = options.runStart === null ? NaN : Date.parse(options.runStart)
  if (options.runStart !== null && !Number.isFinite(runStart)) {
    addData('run-start-unparsable', `--run-start is not a parsable timestamp: ${options.runStart}`)
  }
  const runEndSource = options.runEnd !== null ? 'run-end' : options.rssWindowEnd !== null ? 'rss-window-end' : null
  const runEndRaw = options.runEnd ?? options.rssWindowEnd
  const runEnd = runEndRaw === null ? NaN : Date.parse(runEndRaw)
  if (runEndRaw !== null && !Number.isFinite(runEnd)) {
    addData('run-end-unparsable', `--${runEndSource} is not a parsable timestamp: ${runEndRaw}`)
  }
  if (Number.isFinite(runStart) && Number.isFinite(runEnd)) {
    if (runStart >= runEnd) {
      addData('run-bounds-reversed', `the run's start (${new Date(runStart).toISOString()}) is not before its end (${new Date(runEnd).toISOString()})`)
    } else if (config.tailHours !== null) {
      const spanSeconds = (runEnd - runStart) / 1000
      const tailSeconds = config.tailHours * 3600
      if (spanSeconds < tailSeconds) {
        addData('run-span-too-short', `the run's span is ${Math.round(spanSeconds)} s, which is shorter than the registered ${config.tailHours} h window`)
      }
    }
  }

  // --- the telemetry --------------------------------------------------------
  const runLog = { samples: [], problems: [], comments: 0 }
  if (options.telemetry !== null) {
    let text = ''
    try {
      text = readFileSync(options.telemetry, 'utf8')
    } catch (error) {
      addData('telemetry-unreadable', `the telemetry log could not be read: ${options.telemetry} (${error.message})`)
    }
    if (text !== '') {
      const parsed = parseSource(text, 'the telemetry log')
      runLog.samples = parsed.samples
      runLog.problems = parsed.problems
      runLog.comments = parsed.comments
      for (const problem of parsed.problems) addData('sample-invalid', problem)
      verifyRawAccounting(runLog.samples, 'the telemetry log', addData)
    }
  }

  // --- the extra baseline sources ------------------------------------------
  // Every extra source is held to the SAME rules as the run's own log. A
  // source that cannot be read, or that contains a line that does not parse,
  // is NOT discarded: it makes the verdict INCOMPLETE, because a baseline
  // that is quietly half-parsed is a baseline nobody can defend.
  const extraSources = []
  for (const extraPath of options.baselineExtra) {
    let text = ''
    let readable = true
    try {
      text = readFileSync(extraPath, 'utf8')
    } catch (error) {
      readable = false
      addData('baseline-unreadable', `the extra baseline source could not be read: ${extraPath} (${error.message})`)
    }
    if (!readable) {
      extraSources.push({ path: extraPath, samples: [], problems: [] })
      continue
    }
    const parsed = parseSource(text, `the extra baseline source ${extraPath}`)
    for (const problem of parsed.problems) addData('sample-invalid', problem)
    verifyRawAccounting(parsed.samples, `the extra baseline source ${extraPath}`, addData)
    extraSources.push({ path: extraPath, samples: parsed.samples, problems: parsed.problems, comments: parsed.comments })
  }

  // --- the run's identity ---------------------------------------------------
  // The run's own processes must be OBSERVED. A log in which no sample ever
  // shows ownProcs > 0 is not a quiet host — it is a log in which the run
  // could not be identified, and the whole log must not be read as
  // "baseline" and used to justify the window.
  const firstOwn = runLog.samples.find(sample => sample.ownProcs > 0) ?? null
  if (firstOwn === null) {
    addData('run-identity-unestablished', 'the run\'s own processes were never observed — the run\'s identity could not be established')
  }

  // --- the baseline ---------------------------------------------------------
  // The baseline is the union of the extra sources and the run log's own
  // samples that precede BOTH the run's start and the first sample with the
  // run's own processes present: the host's foreign state with no run in it.
  const RUN_LOG_SOURCE = 'the telemetry log'
  const baselineCandidates = []
  for (const source of extraSources) {
    for (const sample of source.samples) baselineCandidates.push({ sample, path: source.path })
  }
  for (const sample of runLog.samples) {
    const beforeRun = Number.isFinite(runStart) ? sample.at < runStart : false
    const beforeFirstOwn = firstOwn === null ? false : sample.at < firstOwn.at
    if (beforeRun && beforeFirstOwn) baselineCandidates.push({ sample, path: RUN_LOG_SOURCE })
  }

  const baselineEntries = []
  for (const candidate of baselineCandidates) {
    const sample = candidate.sample
    if (Number.isFinite(runStart) && sample.at >= runStart) {
      addData('baseline-after-run-start', `${candidate.path}: the baseline sample at ${sample.ts} is not before the run's start (${new Date(runStart).toISOString()})`)
      continue
    }
    if (sample.ownProcs !== 0) {
      addData('baseline-has-own-processes', `${candidate.path}: the baseline sample at ${sample.ts} carries ${sample.ownProcs} of the run's own processes — a baseline is the host's state with no run in it`)
      continue
    }
    // The baseline is a measurement too: a sample whose accounting failed is
    // not a number, and the limits are computed from these numbers.
    for (const signal of ['deltaValid', 'obsCgroupOk', 'obsReadOk']) {
      if (sample[signal] !== 1) {
        addData('baseline-signal-failed', `${candidate.path}: the baseline sample at ${sample.ts} has ${signal}=${sample[signal]} — its accounting is not trustworthy`)
      }
    }
    baselineEntries.push(candidate)
  }
  const baseline = baselineEntries.map(entry => entry.sample)

  // The observer's FIRST sample of a log has no previous sample to difference
  // against: its foreign CPU is a synthetic zero, not a measurement. It is
  // excluded from every statistic, and the count of the excluded samples is
  // reported — otherwise a baseline's mean is depressed by a number that was
  // never observed.
  const baselineMeasured = baseline.filter(sample => sample.interval === 1)
  const baselineSynthetic = baseline.length - baselineMeasured.length
  const baselineCores = baselineMeasured.map(sample => sample.foreignCores)
  const baselineMedian = baselineCores.length ? nearestRank(baselineCores, 0.5) : null
  const baselineMean = baselineCores.length ? baselineCores.reduce((sum, value) => sum + value, 0) / baselineCores.length : null
  const baselineP95 = baselineCores.length ? nearestRank(baselineCores, 0.95) : null
  const baselineMax = baselineCores.length ? Math.max(...baselineCores) : null
  const baselineForeignProcessMax = baselineMeasured.length ? Math.max(...baselineMeasured.map(sample => sample.foreignProcs)) : null

  if (baseline.length === 0) {
    addData('baseline-missing', 'the baseline is missing: no sample precedes the run\'s first own process')
  } else if (baselineMeasured.length < config.baselineMinimumSamples) {
    addData('baseline-too-small', `the baseline holds ${baselineMeasured.length} measured sample(s) (${baseline.length} sample(s) in all, ${baselineSynthetic} of them without a previous sample to difference against), below the registered minimum of ${config.baselineMinimumSamples}`)
  }
  // An extra source that contributes nothing is a source that was named and
  // did not deliver: the baseline would then be thinner than the launch
  // record says it is.
  for (const source of extraSources) {
    const contributed = baselineEntries.filter(entry => entry.path === source.path).length
    if (contributed === 0) {
      addData('baseline-source-empty', `the extra baseline source ${source.path} contributed no usable sample`)
    }
  }

  // The baseline's own intervals, for the rolling figure. Only intervals
  // inside one source are real intervals.
  const baselineIntervals = []
  {
    const bySource = new Map()
    for (const entry of baselineEntries) {
      if (!bySource.has(entry.path)) bySource.set(entry.path, [])
      bySource.get(entry.path).push(entry.sample)
    }
    for (const samples of bySource.values()) {
      const ordered = [...samples].sort((a, b) => a.at - b.at)
      for (let index = 1; index < ordered.length; index += 1) {
        const seconds = (ordered[index].at - ordered[index - 1].at) / 1000
        if (seconds > 0) baselineIntervals.push({ value: ordered[index].foreignCores, seconds })
      }
    }
  }

  // --- the measured window --------------------------------------------------
  const tailMs = config.tailHours === null ? 0 : config.tailHours * 3600 * 1000
  const windowEnd = Number.isFinite(runEnd) ? runEnd : null
  const windowStart = windowEnd === null ? null : windowEnd - tailMs
  const windowSeconds = windowStart === null ? 0 : tailMs / 1000

  const window = windowStart === null
    ? []
    : runLog.samples.filter(sample => sample.at >= windowStart && sample.at <= windowEnd)

  // The window's INTERVALS.
  //
  // The window is a stretch of TIME, not a set of rows. The observer's
  // sample grid and the harness's tracker boundary are different clocks —
  // the observer samples on the minute, the tracker anchors the final
  // window to its own last sample — so the two do not have to coincide, and
  // the contract does not ask them to. So the window is judged by the
  // intervals that OVERLAP it, each clipped to the window's bounds: a
  // sample just AFTER the window's end still closes an interval that
  // starts inside the window, and that interval's seconds are the window's.
  //
  // The window's bounds come from the run's end and are never moved to fit
  // the samples, and the end is never chosen after seeing the night.
  const intervals = []
  if (windowStart !== null) {
    // A cadence that is not registered cannot be claimed: the configuration
    // is already invalid, and inventing a tolerance here would invent a
    // measurement too.
    const minInterval = config.cadenceSeconds === null ? null : config.cadenceSeconds - config.cadenceToleranceSeconds
    const maxInterval = config.cadenceSeconds === null ? null : config.cadenceSeconds + config.cadenceToleranceSeconds
    for (let index = 1; index < runLog.samples.length; index += 1) {
      const previous = runLog.samples[index - 1]
      const current = runLog.samples[index]
      const duration = (current.at - previous.at) / 1000
      if (!(duration > 0)) continue
      const overlapStart = Math.max(previous.at, windowStart)
      const overlapEnd = Math.min(current.at, windowEnd)
      const overlap = Math.max(0, (overlapEnd - overlapStart) / 1000)
      const inCadence = minInterval === null ? true : duration >= minInterval && duration <= maxInterval
      intervals.push({
        from: previous.ts,
        to: current.ts,
        fromMs: previous.at,
        toMs: current.at,
        fromTs: previous.ts,
        toTs: current.ts,
        previousSample: previous,
        currentSample: current,
        // The observer writes the residual for the interval that ENDED at a
        // sample, so the value and the duration belong together.
        value: current.foreignCores,
        duration,
        overlap,
        overlapStart,
        overlapEnd,
        inCadence
      })
    }
  }

  // The intervals that overlap the window, and the ones among them that
  // arrived at the registered cadence. An interval that overlaps the
  // window by nothing is not part of the window at all.
  const overlapping = intervals.filter(interval => interval.overlap > 0)
  const validIntervals = overlapping.filter(interval => interval.inCadence)

  const gaps = []
  for (const interval of overlapping) {
    if (!interval.inCadence) {
      gaps.push({
        kind: 'interval',
        from: interval.from,
        to: interval.to,
        seconds: interval.duration,
        expectedSeconds: config.cadenceSeconds,
        toleranceSeconds: config.cadenceToleranceSeconds
      })
    }
  }

  // --- coverage, in ELAPSED TIME --------------------------------------------
  // The covered seconds are the sum of the VALID intervals' time INSIDE the
  // window: a gap is a gap, and an absent minute contributes no coverage at
  // all. The coverage is therefore a statement about TIME, not about rows.
  const coveredSeconds = validIntervals.reduce((sum, interval) => sum + interval.overlap, 0)
  const tolerance = config.cadenceToleranceSeconds ?? 0
  const coverage = windowSeconds > 0 ? coveredSeconds / windowSeconds : 0

  // --- the window's HEAD and TAIL --------------------------------------------
  // The window is covered at its head when the first interval that overlaps
  // it reaches back to the window's start, and at its tail when the last
  // interval that overlaps it reaches forward to the window's end.
  //
  // An UNMEASURED PREFIX is a data problem exactly like an unmeasured tail:
  // a minute of the window that was not measured is not a quiet minute, and
  // the head is where a log that starts late — or that skipped the first
  // part of the window — hides. The window's bounds are not moved to fit the
  // samples; the gap is reported and the attempt is INCOMPLETE.
  const firstCovered = validIntervals.length > 0 ? validIntervals[0] : null
  const lastCovered = validIntervals.length > 0 ? validIntervals[validIntervals.length - 1] : null
  // The head and the tail are judged by the intervals' RAW bounds, not by
  // their CLIPPED overlap with the window. The clipped overlap starts at the
  // window's start whenever any interval reaches it, which hides exactly
  // the case this check exists for: a window whose first forty-eight minutes
  // were never measured. The raw bound says where the measurement actually
  // began.
  //
  // And because the bounds are the raw ones, a window whose end falls
  // BETWEEN two samples is not a failure: the interval that spans the end
  // covers it, and the observer's clock and the harness's tracker clock do
  // not have to coincide.
  const headSeconds = firstCovered === null
    ? windowSeconds
    : Math.max(0, (firstCovered.fromMs - windowStart) / 1000)
  const tailSeconds = lastCovered === null
    ? windowSeconds
    : Math.max(0, (windowEnd - lastCovered.toMs) / 1000)
  if (headSeconds > tolerance) {
    gaps.push({
      kind: 'head',
      from: new Date(windowStart).toISOString(),
      to: firstCovered === null ? null : new Date(firstCovered.fromMs).toISOString(),
      seconds: headSeconds,
      expectedSeconds: config.cadenceSeconds,
      toleranceSeconds: config.cadenceToleranceSeconds
    })
  }
  // The window's TAIL: a log that simply STOPS before the window does is not
  // a window that happened to be quiet — it is a window that was never
  // measured to its end. This is the case the coverage check exists to
  // catch.
  if (tailSeconds > tolerance) {
    gaps.push({
      kind: 'tail',
      from: lastCovered === null ? null : new Date(lastCovered.toMs).toISOString(),
      to: new Date(windowEnd).toISOString(),
      seconds: tailSeconds,
      expectedSeconds: config.cadenceSeconds,
      toleranceSeconds: config.cadenceToleranceSeconds
    })
  }

  // The intervals the window's own statistics are computed over: the valid
  // ones, with the seconds that fall inside the window.
  const coveredIntervals = validIntervals.map(interval => ({ value: interval.value, seconds: interval.overlap }))

  if (window.length === 0) {
    addData('window-empty', 'the measured window holds no samples')
  }
  if (window.length > 0 && window[0].interval === 0) {
    addData('window-first-sample-not-an-interval', `the window's first sample (${window[0].ts}) is not an interval — only the first sample of a log has no previous sample to difference against`)
  }
  if (window.length > 0 && config.cadenceSeconds !== null) {
    const outOfCadence = gaps.filter(gap => gap.kind === 'interval')
    if (outOfCadence.length > 0) {
      const first = outOfCadence[0]
      addData('window-cadence-violation', `${outOfCadence.length} interval(s) in the window are not at the registered ${config.cadenceSeconds}s cadence (the first: ${first.from} to ${first.to}, ${first.seconds}s) — a window whose samples did not arrive on the registered cadence is not the registered measurement`)
    }
    if (validIntervals.length === 0) {
      addData('window-not-covered', 'no interval of the measured window was measured at the registered cadence — the window was never covered')
    }
  }
  // The window's HEAD and TAIL are checked UNCONDITIONALLY. They used to sit
  // inside the block above, which meant that a thresholds file without a
  // registered cadence silently switched the boundary checks OFF: a window
  // whose first forty-eight minutes were never measured then came back
  // ELIGIBLE with its head gap visible in the metrics and no finding at all.
  // A missing cadence is an invalid configuration (reported below), and a
  // boundary that was not measured is a finding either way.
  if (headSeconds > tolerance) {
    addData('window-starts-late', `the window's HEAD is not covered: the first measured interval begins ${Math.round(headSeconds)}s after the window's start (${new Date(windowStart).toISOString()}), more than the registered ${config.cadenceToleranceSeconds ?? 0}s tolerance allows — an unmeasured prefix of the window is not a quiet prefix`)
  }
  if (tailSeconds > tolerance) {
    addData('window-ends-early', `the window's last measured interval ends ${Math.round(tailSeconds)}s before the window's end (${new Date(windowEnd).toISOString()}), more than the registered ${config.cadenceToleranceSeconds ?? 0}s tolerance allows — the log ends before the window does`)
  }
  if (window.length > 0 && config.minimumSampleFraction !== null && coverage < config.minimumSampleFraction) {
    addData('coverage-too-low', `the window's elapsed-time coverage is ${(coverage * 100).toFixed(1)}%, below the registered minimum of ${(config.minimumSampleFraction * 100).toFixed(1)}%`)
  }

  // --- the validity signals, of every measurement the window consumes -------
  // The run IS present in the window, so the run's cgroup must have been
  // readable; the observer's own cgroup must have held; and the interval's
  // counters must have been consistent. A sample whose accounting failed
  // cannot be scored, and it is named.
  //
  // The samples that are checked are every one an OVERLAPPING interval
  // consumes — including the closing sample that falls AFTER the window's
  // end. The intervals are built from the whole log, so an interval that
  // spans the window's end is certified by the sample that closes it, and a
  // failing closing sample must not be able to certify the last seconds of
  // the window while its own flag says its accounting failed.
  const consumedSamples = new Map()
  for (const interval of overlapping) {
    consumedSamples.set(interval.fromTs, interval.previousSample)
    consumedSamples.set(interval.toTs, interval.currentSample)
  }
  const healthChecked = new Set()
  for (const sample of [...window, ...consumedSamples.values()]) {
    if (sample === undefined || healthChecked.has(sample)) continue
    healthChecked.add(sample)
    for (const signal of ['deltaValid', 'obsCgroupOk', 'obsReadOk', 'runCgroupOk']) {
      if (sample[signal] !== 1) {
        const inWindow = window.includes(sample)
        addData('window-signal-failed', `the sample at ${sample.ts} has ${signal}=${sample[signal]} — its accounting is not trustworthy${inWindow ? '' : ' (it closes an interval that overlaps the measured window)'}`)
      }
    }
  }

  // --- the window's metrics --------------------------------------------------
  const windowCores = window.map(sample => sample.foreignCores)
  const weighted = weightedMean(coveredIntervals)
  const rowMean = windowCores.length ? windowCores.reduce((sum, value) => sum + value, 0) / windowCores.length : null
  const windowMedian = nearestRank(windowCores, 0.5)
  const windowP95 = nearestRank(windowCores, 0.95)
  const windowMax = windowCores.length ? Math.max(...windowCores) : null
  const rollingMax = rollingMeanMax(coveredIntervals, config.rollingMinutes * 60)
  // The SAMPLES above one core: a count of rows, and it says so.
  const samplesAboveOneCore = windowCores.filter(value => value > 1).length
  // The MINUTES above one core: the same measurement in the unit the name
  // promises, computed from the intervals — each interval carries the value
  // of the sample that closed it, and the seconds of it that fell inside the
  // window. A row count is not minutes, and a minute is not a row.
  const minutesAboveOneCore = coveredIntervals.reduce((sum, interval) => sum + (interval.value > 1 ? interval.seconds : 0), 0) / 60
  const memFloor = window.length > 0 ? Math.min(...window.map(sample => sample.memAvailable_kB * 1024)) : null
  const maxForeignProcs = window.length > 0 ? Math.max(...window.map(sample => sample.foreignProcs)) : null

  // --- the limits ------------------------------------------------------------
  // The relative limits are computed from the MEASURED baseline, and are
  // reported whether or not they are the ones the window is judged against.
  if (baselineMedian !== null && baselineMean !== null && limits.medianAllowanceCores !== null && limits.meanAllowanceCores !== null) {
    limits.computedMedianMax = baselineMedian + limits.medianAllowanceCores
    limits.computedMeanMax = baselineMean + limits.meanAllowanceCores
    // The REGISTERED limits are the ones that gate. The relative form — the
    // measured baseline plus the registered allowance — is a DIAGNOSTIC: it
    // shows what the limits would be for the host as it measures now, and it
    // is REPORTED so that a drift between the two is visible. It is not a
    // veto: the registered numbers are absolute, so they cannot be
    // redefined by whatever files an operator hands the scorer. The check
    // that the host has not MOVED is the baseline expectation below, which
    // compares the measured baseline with the one the registration was made
    // against.
    if (limits.source === 'absolute' && (limits.advertisedMedianMax !== null || limits.advertisedMeanMax !== null)) {
      const medianDrift = Math.abs(limits.advertisedMedianMax - limits.computedMedianMax)
      const meanDrift = Math.abs(limits.advertisedMeanMax - limits.computedMeanMax)
      limits.advertisedVsComputed = {
        medianDrift: rounded(medianDrift),
        meanDrift: rounded(meanDrift),
        note: 'the registered limits are the ones that gate; the relative computation is a diagnostic of this host now'
      }
    }
  }
  if (limits.source !== 'absolute') {
    // The rule is ABSOLUTE: the registered numbers are the limits. A file
    // that registers only allowances would leave the night's limits to be
    // computed from whatever baseline the operator hands the scorer — which
    // is the hole the registration exists to close. So a file without the
    // absolute limits is an INCOMPLETE configuration, not a fallback.
    addData('configuration-invalid', 'the thresholds file registers no ABSOLUTE foreign-CPU limits (foreignCores.medianMax and foreignCores.meanMax) — the limits are the registered numbers, never computed from the files the scorer is handed')
  }

  // The run's own processes must be PRESENT in every sample of the measured
  // window. If they are not, the window is not a window of a run: either the
  // run died, or its identity was lost, and in both cases the numbers in it
  // cannot be attributed — the honest answer is INCOMPLETE, not a verdict
  // computed from unattributed data.
  for (const sample of window) {
    if (sample.ownProcs < 1) {
      addData('window-has-no-own-processes', `the sample at ${sample.ts} shows none of the run's own processes inside the measured window — the window is not a window of a run`)
    }
  }

  // --- the gates -------------------------------------------------------------
  // (a) the available-memory floor.
  if (memFloor !== null && config.memAvailableFloorBytes !== null && memFloor < config.memAvailableFloorBytes) {
    addBreach('memory-floor', `the available memory fell to ${(memFloor / 1073741824).toFixed(2)} GiB, below the ${(config.memAvailableFloorBytes / 1073741824).toFixed(0)} GiB floor`)
  }
  // (b) the foreign process count, against the measured baseline unless an
  // absolute limit is registered.
  let foreignProcessAllowance = null
  if (config.foreignProcessLimit !== null) {
    foreignProcessAllowance = config.foreignProcessLimit
  } else if (baselineForeignProcessMax !== null && config.foreignProcessHeadroom !== null) {
    foreignProcessAllowance = baselineForeignProcessMax + config.foreignProcessHeadroom
  }
  if (maxForeignProcs !== null && foreignProcessAllowance !== null && maxForeignProcs > foreignProcessAllowance) {
    addBreach('foreign-process-count', `the foreign process count reached ${maxForeignProcs}, above the ${config.foreignProcessLimit !== null ? 'registered' : 'measured-baseline + headroom'} limit of ${foreignProcessAllowance}`)
  }
  // (c) the foreign CPU.
  //
  // The MEDIAN is the sustained-interference detector: a neighbour that keeps
  // the box busy moves it; the host's own episodic PHP-build bursts do not.
  // The MEAN bounds the total interference, with an allowance that absorbs a
  // burst or two of the host's own doing — and it is the ELAPSED-TIME mean,
  // so a busy stretch cannot hide behind a long quiet one. The p95, the
  // maximum, the worst rolling five-minute mean and the count of samples
  // above one core are REPORTED and never gated: this host's build bursts
  // reach ~4 cores, so gating a tail statistic on a baseline that may not
  // contain a burst would void a clean night for the host's own behaviour.
  if (window.length > 0) {
    if (windowMedian !== null && limits.medianMax !== null && !(windowMedian <= limits.medianMax)) {
      addBreach('foreign-cores-median', `the window's median foreign CPU was ${windowMedian.toFixed(3)} cores, above the ${limits.source} limit of ${rounded(limits.medianMax)}`)
    }
    if (weighted.mean !== null && limits.meanMax !== null && !(weighted.mean <= limits.meanMax)) {
      addBreach('foreign-cores-mean', `the window's elapsed-time mean foreign CPU was ${weighted.mean.toFixed(3)} cores, above the ${limits.source} limit of ${rounded(limits.meanMax)}`)
    }
  }

  // --- the registered baseline expectation -----------------------------------
  let baselineExpectationResult = null
  if (baselineExpectation !== null) {
    baselineExpectationResult = {
      source: baselineExpectation.source,
      expectedMedian: baselineExpectation.median,
      expectedMean: baselineExpectation.mean,
      tolerance: baselineExpectation.tolerance,
      medianDrift: null,
      meanDrift: null,
      checked: []
    }
    if (baselineExpectation.median !== null && baselineExpectation.tolerance.median !== null) {
      baselineExpectationResult.medianDrift = baselineMedian === null ? null : Math.abs(baselineMedian - baselineExpectation.median)
      baselineExpectationResult.checked.push('median')
      // The check is ONE-SIDED, and the side is not arbitrary. The
      // registered limits are UPPER BOUNDS: they were derived from the
      // busiest state this host was MEASURED in (the window that included
      // its PHP-build burst), so a host that is merely QUIETER now still
      // fits inside them — and a quieter host is not a changed host, it is
      // the same host with less to do. A host that is BUSIER than the
      // registration is a different host: its own normal behaviour may no
      // longer fit inside the limits, and that is worth knowing before the
      // night rather than after it.
      if (baselineExpectationResult.medianDrift !== null && baselineMedian > baselineExpectation.median + baselineExpectation.tolerance.median) {
        addData('baseline-moved', `the host's baseline is BUSIER than the registration: the measured median is ${baselineMedian.toFixed(3)} cores against a registered ${baselineExpectation.median} (tolerance ${baselineExpectation.tolerance.median}) — the registered limits were derived from the host's busiest measured state, so a busier host may no longer fit inside them`)
      }
    }
    if (baselineExpectation.mean !== null && baselineExpectation.tolerance.mean !== null) {
      baselineExpectationResult.meanDrift = baselineMean === null ? null : Math.abs(baselineMean - baselineExpectation.mean)
      baselineExpectationResult.checked.push('mean')
      if (baselineExpectationResult.meanDrift !== null && baselineMean > baselineExpectation.mean + baselineExpectation.tolerance.mean) {
        addData('baseline-moved', `the host's baseline is BUSIER than the registration: the measured mean is ${baselineMean.toFixed(3)} cores against a registered ${baselineExpectation.mean} (tolerance ${baselineExpectation.tolerance.mean}) — the registered limits were derived from the host's busiest measured state, so a busier host may no longer fit inside them`)
      }
    }
  }

  // --- the verdict ------------------------------------------------------------
  const dataProblems = findings.filter(finding => finding.kind === 'data').map(finding => finding.detail)
  const thresholdBreaches = findings.filter(finding => finding.kind === 'breach').map(finding => finding.detail)
  const reasons = findings.map(finding => finding.detail)
  const verdict = dataProblems.length > 0
    ? config.dispositions.incomplete
    : thresholdBreaches.length > 0
      ? config.dispositions.breach
      : 'eligible'

  const metrics = {
    windowStart: windowStart === null ? null : new Date(windowStart).toISOString(),
    windowEnd: windowEnd === null ? null : new Date(windowEnd).toISOString(),
    windowSeconds,
    windowEndSource: runEndSource,
    windowSamples: window.length,
    expectedSamples: config.cadenceSeconds ? Math.round(windowSeconds / config.cadenceSeconds) : null,
    coverage: rounded(coverage),
    coverageDetail: {
      fraction: rounded(coverage),
      coveredSeconds: Math.round(coveredSeconds),
      windowSeconds,
      minimumSampleFraction: config.minimumSampleFraction,
      validIntervals: validIntervals.length,
      intervalsInsideWindow: overlapping.length,
      headSeconds: Math.round(headSeconds),
      tailSeconds: Math.round(tailSeconds),
      outOfCadenceIntervals: gaps.filter(gap => gap.kind === 'interval').length
    },
    gaps,
    gapCount: gaps.length,
    baselineSamples: baseline.length,
    baselineMeasuredSamples: baselineMeasured.length,
    baselineSyntheticSamples: baselineSynthetic,
    // The comment lines a source carried, reported so that a reader can see
    // they were skipped as comments and not dropped as unreadable samples.
    telemetryCommentLines: runLog.comments,
    baselineSources: options.baselineExtra.map(path => ({
      path,
      samples: extraSources.find(source => source.path === path)?.samples.length ?? 0,
      usable: baselineEntries.filter(entry => entry.path === path).length,
      commentLines: extraSources.find(source => source.path === path)?.comments ?? 0
    })),
    baselineForeignProcessMax,
    baselineForeignCoresMean: rounded(baselineMean),
    baselineForeignCores: {
      median: baselineMedian,
      mean: rounded(baselineMean),
      p95: baselineP95,
      max: baselineMax,
      rolling5mMax: rounded(rollingMeanMax(baselineIntervals, config.rollingMinutes * 60))
    },
    baselineExpectation: baselineExpectationResult,
    limits: {
      source: limits.source,
      medianMax: rounded(limits.medianMax),
      meanMax: rounded(limits.meanMax),
      computed: {
        medianMax: rounded(limits.computedMedianMax),
        meanMax: rounded(limits.computedMeanMax),
        baselineMedian,
        baselineMean,
        medianAllowanceCores: limits.medianAllowanceCores,
        meanAllowanceCores: limits.meanAllowanceCores
      },
      advertised: {
        medianMax: limits.advertisedMedianMax,
        meanMax: limits.advertisedMeanMax
      },
      advertisedVsComputed: limits.advertisedVsComputed ?? null
    },
    memAvailableFloorBytes: memFloor,
    maxForeignProcesses: maxForeignProcs,
    foreignProcessAllowance,
    foreignCoresMean: rounded(weighted.mean),
    foreignCoresRowMean: rounded(rowMean),
    foreignCoresMedian: windowMedian,
    foreignCoresP95: windowP95,
    foreignCoresMax: windowMax,
    foreignCoresRolling5mMax: rounded(rollingMax),
    foreignCoresSamplesAboveOneCore: samplesAboveOneCore,
    foreignCoresMinutesAboveOneCore: rounded(minutesAboveOneCore, 2),
    loadAverageMax: (() => {
      const values = window.flatMap(sample => (sample.load ?? []).filter(value => value !== null))
      return values.length ? Math.max(...values) : null
    })(),
    stealCoresMax: (() => {
      const values = window.map(sample => sample.stealCores).filter(value => typeof value === 'number')
      return values.length ? Math.max(...values) : null
    })()
  }

  const document = {
    verdict,
    scope: 'quiet-host eligibility only — this does not judge the soak, and it does not confer a PASS',
    thresholdsFile: thresholdsPath,
    thresholdsDigest,
    expectedThresholdsDigest: options.expectThresholdsDigest,
    runStart: Number.isFinite(runStart) ? new Date(runStart).toISOString() : options.runStart,
    runEnd: Number.isFinite(runEnd) ? new Date(runEnd).toISOString() : runEndRaw,
    runEndSource,
    metrics,
    reasons,
    dataProblems,
    thresholdBreaches,
    findings,
    dispositions: {
      breach: config.dispositions.breach,
      missingOrInvalidTelemetry: config.dispositions.incomplete
    }
  }

  // --- the baseline report ----------------------------------------------------
  // --report-baseline prints the DISTRIBUTION of the baseline — the host's
  // foreign state before the run — so the thresholds can be calibrated
  // against a measurement of this host rather than against an invented
  // number. It judges nothing, but it is held to the same parsing and the
  // same baseline rules: a bad extra source is still INCOMPLETE.
  if (options.reportBaseline) {
    const report = {
      report: 'baseline distribution — the host\'s foreign state before the run',
      scored: false,
      thresholdsDigestRegistered: options.expectThresholdsDigest !== null,
      notes: [
        'this report judges nothing: it prints the baseline distribution and scores no window',
        options.expectThresholdsDigest === null
          ? 'no thresholds digest was registered for this report — nothing here is bound to a contract, because nothing here is a verdict'
          : `the thresholds digest was checked against the file that was read: ${thresholdsPath}`
      ],
      verdict: dataProblems.length > 0 ? config.dispositions.incomplete : 'reported',
      scope: 'baseline distribution only — this judges nothing',
      thresholdsFile: thresholdsPath,
      thresholdsDigest,
      expectedThresholdsDigest: options.expectThresholdsDigest,
      runStart: document.runStart,
      runEnd: document.runEnd,
      samples: baseline.length,
      firstSample: baseline.length ? baseline[0].ts : null,
      lastSample: baseline.length ? baseline[baseline.length - 1].ts : null,
      foreignProcessMax: baselineForeignProcessMax,
      foreignCores: {
        mean: rounded(baselineMean),
        median: baselineMedian,
        p95: baselineP95,
        max: baselineMax,
        rolling5mMax: rounded(rollingMeanMax(baselineIntervals, config.rollingMinutes * 60))
      },
      memAvailableFloorBytes: baseline.length ? Math.min(...baseline.map(sample => sample.memAvailable_kB * 1024)) : null,
      baselineExpectation: baselineExpectationResult,
      metrics,
      reasons,
      dataProblems,
      thresholdBreaches,
      dispositions: {
        breach: config.dispositions.breach,
        missingOrInvalidTelemetry: config.dispositions.incomplete
      }
    }
    const text = `${JSON.stringify(report, null, 2)}\n`
    if (options.out) writeFileSync(options.out, text, { mode: 0o600 })
    else process.stdout.write(text)
    return dataProblems.length > 0 ? 1 : 0
  }

  const text = `${JSON.stringify(document, null, 2)}\n`
  if (options.out) writeFileSync(options.out, text, { mode: 0o600 })
  else process.stdout.write(text)
  return verdict === 'eligible' ? 0 : 1
}

try {
  process.exitCode = main(process.argv.slice(2))
} catch (error) {
  process.stdout.write(`${JSON.stringify({ verdict: 'incomplete', reason: error.message }, null, 2)}\n`)
  process.exitCode = 1
}
