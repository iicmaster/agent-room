// Story 6.2 — the QUIET-HOST ELIGIBILITY SCORER's own tests.
//
// `scripts/rel3-soak-eligibility.mjs` is the named adjudication step of the
// REL-3 soak's quiet-host contract: it decides whether the host's measured
// window is admissible, and it is the only thing standing between a broken
// telemetry log and a night's work being read as a quiet host.
//
// These tests drive the REAL scorer as a child process against SYNTHETIC
// observer logs, and most of them are REJECTIONS. The interesting failures of
// a scorer like this are not the clean case; they are the logs that are one
// defect away from clean — an empty field, a repeated timestamp, a sample
// whose accounting failed, a log that simply stops before the window ends —
// and every one of them must come back INCOMPLETE rather than ELIGIBLE.
//
// Every test builds its own log in a temporary directory and asserts the
// verdict, the exit code and — where the defect is otherwise silent — the
// reason the scorer gave.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(HERE, '..', '..')
const SCORER = join(ROOT, 'scripts', 'rel3-soak-eligibility.mjs')
const THRESHOLDS = join(ROOT, 'docs', 'implementation', 'rel3-quiet-host-thresholds.json')

// The synthetic run: twelve hours, as the amendment pre-registers, with the
// measured window in its last four.
const RUN_START = '2026-10-22T06:00:00Z'
const RUN_END = '2026-10-22T18:00:00Z'
const TAIL_HOURS = 4
const WINDOW_START_MS = Date.parse(RUN_END) - TAIL_HOURS * 3600 * 1000

// One line of the observer's log, in the exact format
// `scripts/rel1-soak-telemetry.sh` writes: the timestamp first and bare, then
// the fields.
const sampleLine = ({
  at,
  ownProcs = 0,
  foreignProcs = 4,
  foreignCores = 0.2,
  memAvailable = 8_500_000,
  interval = 1,
  gapSec = 60,
  deltaValid = 1,
  obsCgroupOk = 1,
  obsReadOk = 1,
  runCgroupOk = 0,
  busyJiffies = 971547507,
  runCpuUs = 0,
  obsCpuUs = 87396,
  foreignUs = 0,
  stealCores = 0,
  nodeProcs = null
}) => {
  const stamp = new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z')
  return `${stamp} load=0.87 1.07 1.25 memAvailable_kB=${memAvailable} nodeProcs=${nodeProcs ?? ownProcs + foreignProcs} ownProcs=${ownProcs} foreignProcs=${foreignProcs} foreignCores=${foreignCores} stealCores=${stealCores} serverRss_kB=0 pgmajfault=1006176 runCpuSec=0.0 gapSec=${gapSec} busyJiffies=${busyJiffies} runCpuUs=${runCpuUs} obsCpuUs=${obsCpuUs} foreignUs=${foreignUs} interval=${interval} obsCgroupOk=${obsCgroupOk} obsReadOk=${obsReadOk} runCgroupOk=${runCgroupOk} deltaValid=${deltaValid}`
}

// A synthetic log: the baseline before the run, the run's own samples, and
// the measured window at the end of the run.
const buildLog = ({
  runStart = RUN_START,
  runEnd = RUN_END,
  baselineCount = 20,
  baselineCores = 0.8,
  baselineOverrides = {},
  windowCores = 0.2,
  windowOverrides = {},
  windowOffsets = null,
  windowDurations = null,
  windowIntervalValues = null,
  windowSamplesEnd = null,
  runOwnProcs = 5,
  runForeignProcs = 4,
  memAvailable = 8_500_000,
  runOverrides = {},
  runSamples = true,
  declareGapSec = null
} = {}) => {
  const start = Date.parse(runStart)
  const windowEndMs = Date.parse(runEnd)
  const windowStartMs = windowEndMs - TAIL_HOURS * 3600 * 1000
  const lines = []

  // The baseline: one sample a minute, ending the minute before the run
  // starts. The host's foreign state, with no run in it.
  for (let index = 0; index < baselineCount; index += 1) {
    lines.push(sampleLine({
      at: start - (baselineCount - index) * 60_000,
      ownProcs: 0,
      foreignProcs: runForeignProcs,
      foreignCores: baselineCores,
      memAvailable,
      interval: index === 0 ? 0 : 1,
      gapSec: index === 0 ? 0 : 60,
      runCgroupOk: 0,
      ...baselineOverrides
    }))
  }

  // The run's own samples, from the run's start up to the window. These are
  // neither baseline nor window: they are the run, observed.
  if (runSamples) {
    for (let at = start; at < windowStartMs; at += 60_000) {
      lines.push(sampleLine({
        at,
        ownProcs: runOwnProcs,
        foreignProcs: runForeignProcs,
        foreignCores: windowCores,
        memAvailable,
        runCgroupOk: 1,
        ...runOverrides
      }))
    }
  }

  // The window's samples.
  const times = []
  if (windowOffsets) {
    for (const offset of windowOffsets) times.push(windowStartMs + offset * 1000)
  } else if (windowDurations) {
    let at = windowStartMs
    times.push(at)
    for (const seconds of windowDurations) {
      at += seconds * 1000
      times.push(at)
    }
  } else {
    const stop = windowSamplesEnd === null ? windowEndMs : Date.parse(windowSamplesEnd)
    for (let at = windowStartMs; at <= stop; at += 60_000) times.push(at)
  }
  times.forEach((at, index) => {
    const elapsed = index === 0 ? 60 : (at - times[index - 1]) / 1000
    const value = windowDurations && windowIntervalValues
      ? (index === 0 ? windowCores : windowIntervalValues[index - 1])
      : windowCores
    lines.push(sampleLine({
      at,
      ownProcs: runOwnProcs,
      foreignProcs: runForeignProcs,
      foreignCores: value,
      memAvailable,
      runCgroupOk: 1,
      gapSec: declareGapSec ?? elapsed,
      ...windowOverrides
    }))
  })

  return lines
}

const runScorer = args => {
  const result = spawnSync(process.execPath, [SCORER, ...args], { encoding: 'utf8' })
  let document = null
  try {
    document = JSON.parse(result.stdout)
  } catch {
    document = null
  }
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, document }
}

const withWorkspace = fn => {
  const directory = mkdtempSync(join(tmpdir(), 'agent-room-rel3-eligibility-'))
  try {
    return fn(directory)
  } finally {
    rmSync(directory, { recursive: true, force: true })
  }
}

const writeLog = (directory, lines) => {
  const path = join(directory, 'telemetry.log')
  writeFileSync(path, `${(Array.isArray(lines) ? lines : [lines]).join('\n')}\n`)
  return path
}

// A temporary copy of the frozen thresholds, with the given change applied.
// The registered file itself is never touched: it is the contract.
const thresholdsVariant = (directory, mutate, name = 'thresholds.json') => {
  const thresholds = JSON.parse(readFileSync(THRESHOLDS, 'utf8'))
  mutate(thresholds)
  const path = join(directory, name)
  writeFileSync(path, `${JSON.stringify(thresholds, null, 2)}\n`)
  return path
}

const digestOf = path => `sha256:${createHash('sha256').update(readFileSync(path)).digest('hex')}`

const assertVerdict = (result, expected, context) => {
  assert.ok(result.document !== null, `${context}: the scorer must print a verdict document; stdout=${result.stdout} stderr=${result.stderr}`)
  assert.equal(result.document.verdict, expected, `${context}: the verdict must be ${expected}; reasons=${JSON.stringify(result.document.reasons)}`)
  assert.equal(result.status, expected === 'eligible' ? 0 : 1, `${context}: the exit code must be ${expected === 'eligible' ? 0 : 1}`)
}

const assertReasoned = (result, needle, context) => {
  const reasons = [...(result.document?.dataProblems ?? []), ...(result.document?.thresholdBreaches ?? [])]
  assert.ok(
    reasons.some(reason => reason.includes(needle)),
    `${context}: a reason must name ${JSON.stringify(needle)}; reasons=${JSON.stringify(reasons)}`
  )
}

// The standard invocation: the log, the run's bounds, and the repository's
// frozen thresholds.
const score = (directory, { lines, args = [], thresholds = THRESHOLDS, out = null } = {}) => {
  const telemetry = writeLog(directory, lines)
  const argv = ['--telemetry', telemetry, '--thresholds', thresholds]
  if (out !== null) argv.push('--out', out)
  return runScorer([...argv, ...args])
}

test('the quiet-host scorer: a clean log on a quiet host is ELIGIBLE, and it says why it is clean', () => {
  withWorkspace(directory => {
    const result = score(directory, {
      lines: buildLog(),
      args: ['--run-start', RUN_START, '--run-end', RUN_END]
    })
    assertVerdict(result, 'eligible', 'a quiet window on a quiet host')
    assert.deepEqual(result.document.dataProblems, [], 'a clean log holds no data problems')
    assert.deepEqual(result.document.thresholdBreaches, [], 'a clean log breaches nothing')
    const metrics = result.document.metrics
    assert.equal(metrics.windowSamples, 241, 'the window holds every minute of the four hours')
    assert.equal(metrics.baselineSamples, 20, 'the baseline holds its twenty pre-run samples')
    assert.equal(metrics.coverage, 1, 'the coverage is the whole window, measured in elapsed time')
    assert.equal(metrics.gapCount, 0, 'a log that arrives on the cadence holds no gaps')
    assert.equal(metrics.limits.source, 'absolute', 'the limits are the REGISTERED numbers, not computed from the files the scorer is handed')
    assert.equal(metrics.limits.medianMax, 1.345, 'the registered median limit is the one in use')
    assert.equal(metrics.limits.meanMax, 1.576, 'the registered mean limit is the one in use')
    assert.equal(metrics.limits.computed.medianMax, 1.3, 'the relative form is still computed and reported, as a diagnostic of this host now')
    assert.equal(metrics.limits.computed.meanMax, 1.55, 'the relative form is still computed and reported, as a diagnostic of this host now')
    assert.equal(metrics.foreignCoresMean, 0.2, 'the window is quiet')
    assert.equal(metrics.memAvailableFloorBytes, 8_704_000_000, 'the memory floor is measured, not assumed')
    assert.equal(result.document.runStart, '2026-10-22T06:00:00.000Z', 'the run\'s start is recorded')
    assert.equal(result.document.runEnd, '2026-10-22T18:00:00.000Z', 'the run\'s end is recorded')
    assert.equal(result.document.metrics.windowStart, '2026-10-22T14:00:00.000Z', 'the window is the run\'s last four hours')
  })
})

test('the quiet-host scorer: a window whose foreign CPU breaches the registered limits is CONFOUNDED, not failed', () => {
  withWorkspace(directory => {
    const result = score(directory, {
      lines: buildLog({ windowCores: 2.0 }),
      args: ['--run-start', RUN_START, '--run-end', RUN_END]
    })
    assertVerdict(result, 'confounded', 'a window whose median and mean foreign CPU are above the limits')
    assert.deepEqual(result.document.dataProblems, [], 'a breached threshold is not a data problem')
    assert.ok(result.document.thresholdBreaches.length >= 1, 'the breach is named')
    assertReasoned(result, 'median foreign CPU', 'the median breach')
    assertReasoned(result, 'mean foreign CPU', 'the mean breach')
    assert.equal(result.document.dispositions.breach, 'confounded', 'the breach disposition comes from the frozen thresholds')
  })
})

test('the quiet-host scorer: a log in which the run\'s own processes were never observed is INCOMPLETE', () => {
  withWorkspace(directory => {
    const result = score(directory, {
      lines: buildLog({ runOwnProcs: 0, runOverrides: { ownProcs: 0 }, windowOverrides: { ownProcs: 0 } }),
      args: ['--run-start', RUN_START, '--run-end', RUN_END]
    })
    assertVerdict(result, 'incomplete', 'a log that never shows the run\'s own processes')
    assertReasoned(result, 'the run\'s own processes were never observed', 'the run\'s identity could not be established')
  })
})

test('the quiet-host scorer: a log whose samples are ALL inside the window is INCOMPLETE, not a log-sized baseline', () => {
  withWorkspace(directory => {
    // The trap: every sample sits inside the window, so the whole log could
    // be read as "the host before the run" and used to justify the window.
    // It is not: the run's identity was never established.
    const result = score(directory, {
      lines: buildLog({ baselineCount: 0, runSamples: false, runOwnProcs: 0, windowOverrides: { ownProcs: 0 } }),
      args: ['--run-start', RUN_START, '--run-end', RUN_END]
    })
    assertVerdict(result, 'incomplete', 'a log that is all window and no run')
    assertReasoned(result, 'the run\'s own processes were never observed', 'the whole log must not become the baseline')
    assert.equal(result.document.metrics.baselineSamples, 0, 'the window does not become its own justification')
  })
})

test('the quiet-host scorer: an empty field is INCOMPLETE, and it names the field', () => {
  withWorkspace(directory => {
    const lines = buildLog()
    lines[lines.length - 1] = lines[lines.length - 1].replace('foreignCores=0.2', 'foreignCores=')
    const result = score(directory, {
      lines,
      args: ['--run-start', RUN_START, '--run-end', RUN_END]
    })
    assertVerdict(result, 'incomplete', 'a sample with an empty field')
    assertReasoned(result, 'foreignCores is empty', 'the empty field is named')
  })
})

test('the quiet-host scorer: a negative foreign CPU is INCOMPLETE', () => {
  withWorkspace(directory => {
    const lines = buildLog()
    lines[lines.length - 1] = lines[lines.length - 1].replace('foreignCores=0.2', 'foreignCores=-0.500')
    const result = score(directory, {
      lines,
      args: ['--run-start', RUN_START, '--run-end', RUN_END]
    })
    assertVerdict(result, 'incomplete', 'a sample with a negative foreign CPU')
    assertReasoned(result, 'foreignCores is negative', 'the negative field is named')
  })
})

test('the quiet-host scorer: a non-integer process count is INCOMPLETE', () => {
  withWorkspace(directory => {
    const lines = buildLog()
    lines[lines.length - 1] = lines[lines.length - 1].replace('foreignProcs=4', 'foreignProcs=3.5')
    const result = score(directory, {
      lines,
      args: ['--run-start', RUN_START, '--run-end', RUN_END]
    })
    assertVerdict(result, 'incomplete', 'a sample with a fractional process count')
    assertReasoned(result, 'foreignProcs is not an integer', 'the non-integer field is named')
  })
})

test('the quiet-host scorer: a window sample whose delta did not validate is INCOMPLETE', () => {
  withWorkspace(directory => {
    const lines = buildLog()
    lines[lines.length - 1] = lines[lines.length - 1].replace('deltaValid=1', 'deltaValid=0')
    const result = score(directory, {
      lines,
      args: ['--run-start', RUN_START, '--run-end', RUN_END]
    })
    assertVerdict(result, 'incomplete', 'a window sample whose counters were inconsistent')
    assertReasoned(result, 'deltaValid=0', 'the failed signal is named')
  })
})

test('the quiet-host scorer: a window sample whose run cgroup was unreadable is INCOMPLETE', () => {
  withWorkspace(directory => {
    const lines = buildLog()
    lines[lines.length - 1] = lines[lines.length - 1].replace('runCgroupOk=1', 'runCgroupOk=0')
    const result = score(directory, {
      lines,
      args: ['--run-start', RUN_START, '--run-end', RUN_END]
    })
    assertVerdict(result, 'incomplete', 'a window sample with no readable run cgroup')
    assertReasoned(result, 'runCgroupOk=0', 'the failed signal is named')
  })
})

test('the quiet-host scorer: a window sample whose observer cgroup was unusable is INCOMPLETE', () => {
  withWorkspace(directory => {
    const lines = buildLog()
    lines[lines.length - 1] = lines[lines.length - 1].replace('obsCgroupOk=1', 'obsCgroupOk=0')
    const result = score(directory, {
      lines,
      args: ['--run-start', RUN_START, '--run-end', RUN_END]
    })
    assertVerdict(result, 'incomplete', 'a window sample whose observer could not account for itself')
    assertReasoned(result, 'obsCgroupOk=0', 'the failed signal is named')
  })
})

test('the quiet-host scorer: 240 samples carrying one timestamp are INCOMPLETE, whatever gapSec they declare', () => {
  withWorkspace(directory => {
    // The declared gap says a minute; the timestamps say no time passed at
    // all. The scorer must believe the timestamps.
    const result = score(directory, {
      lines: buildLog({ windowOffsets: Array.from({ length: 240 }, () => 0), declareGapSec: 60 }),
      args: ['--run-start', RUN_START, '--run-end', RUN_END]
    })
    assertVerdict(result, 'incomplete', 'a window whose samples all carry one timestamp')
    assertReasoned(result, 'not strictly increasing in time', 'the chronology is broken')
    assert.ok(result.document.metrics.coverage < 0.8, `the elapsed-time coverage must collapse; coverage=${result.document.metrics.coverage}`)
  })
})

test('the quiet-host scorer: a window whose last 48 minutes are absent is INCOMPLETE, not a quiet window', () => {
  withWorkspace(directory => {
    const result = score(directory, {
      lines: buildLog({ windowSamplesEnd: '2026-10-22T17:12:00Z' }),
      args: ['--run-start', RUN_START, '--run-end', RUN_END]
    })
    assertVerdict(result, 'incomplete', 'a window whose log ends early')
    assertReasoned(result, 'the log ends before the window does', 'the missing tail is named')
    assert.ok(
      result.document.metrics.gaps.some(gap => gap.kind === 'tail'),
      'the tail gap is recorded'
    )
  })
})

test('the quiet-host scorer: a run that starts after it ends is INCOMPLETE', () => {
  withWorkspace(directory => {
    const result = score(directory, {
      lines: buildLog(),
      args: ['--run-start', '2027-10-22T06:00:00Z', '--run-end', '2026-10-22T18:00:00Z']
    })
    assertVerdict(result, 'incomplete', 'a run whose bounds are reversed')
    assertReasoned(result, 'is not before its end', 'the reversed span is named')
  })
})

test('the quiet-host scorer: an extra baseline source holding a sample from after the run started is INCOMPLETE', () => {
  withWorkspace(directory => {
    const extra = join(directory, 'extra-baseline.log')
    const lines = []
    for (let index = 0; index < 15; index += 1) {
      lines.push(sampleLine({
        at: Date.parse('2026-10-22T05:00:00Z') + index * 60_000,
        ownProcs: 0,
        foreignCores: 0.8,
        interval: index === 0 ? 0 : 1,
        gapSec: index === 0 ? 0 : 60
      }))
    }
    // One sample from AFTER the run started: it is not the host's state
    // before the run, whatever else it is.
    lines.push(sampleLine({ at: Date.parse('2026-10-22T07:00:00Z'), ownProcs: 0, foreignCores: 0.8 }))
    writeFileSync(extra, `${lines.join('\n')}\n`)
    const result = score(directory, {
      lines: buildLog(),
      args: ['--run-start', RUN_START, '--run-end', RUN_END, '--baseline-extra', extra]
    })
    assertVerdict(result, 'incomplete', 'an extra baseline source that reaches past the run\'s start')
    assertReasoned(result, 'is not before the run\'s start', 'the late baseline sample is named')
  })
})

test('the quiet-host scorer: an extra baseline source holding a corrupt line is INCOMPLETE, not a dropped line', () => {
  withWorkspace(directory => {
    const extra = join(directory, 'extra-baseline.log')
    const lines = []
    for (let index = 0; index < 15; index += 1) {
      lines.push(sampleLine({
        at: Date.parse('2026-10-22T05:00:00Z') + index * 60_000,
        ownProcs: 0,
        foreignCores: 0.8,
        interval: index === 0 ? 0 : 1,
        gapSec: index === 0 ? 0 : 60
      }))
    }
    lines.push('2026-10-22T05:15:00Z this line is not a sample at all')
    writeFileSync(extra, `${lines.join('\n')}\n`)
    const result = score(directory, {
      lines: buildLog(),
      args: ['--run-start', RUN_START, '--run-end', RUN_END, '--baseline-extra', extra]
    })
    assertVerdict(result, 'incomplete', 'an extra baseline source with a corrupt line')
    assertReasoned(result, 'line 16', 'the corrupt line is named by its line number')
  })
})

test('the quiet-host scorer: a baseline that has moved since the registration is INCOMPLETE', () => {
  withWorkspace(directory => {
    const thresholds = thresholdsVariant(directory, registered => {
      registered.baselineExpectation = {
        median: 0.4,
        mean: 0.45,
        tolerance: { median: 0.15, mean: 0.25 }
      }
    })
    const result = score(directory, {
      lines: buildLog({ baselineCores: 0.8 }),
      args: ['--run-start', RUN_START, '--run-end', RUN_END],
      thresholds
    })
    assertVerdict(result, 'incomplete', 'a baseline that no longer matches the registered expectation')
    assertReasoned(result, 'the host\'s baseline has moved since the registration', 'the moved baseline is named')
    assert.ok(
      result.document.metrics.baselineExpectation.medianDrift > 0.15,
      `the drift is measured; drift=${result.document.metrics.baselineExpectation.medianDrift}`
    )
  })
})

test('the quiet-host scorer: a valid extra baseline source is used, and does not condemn the run', () => {
  withWorkspace(directory => {
    const extra = join(directory, 'extra-baseline.log')
    const lines = []
    for (let index = 0; index < 15; index += 1) {
      lines.push(sampleLine({
        at: Date.parse('2026-10-22T05:00:00Z') + index * 60_000,
        ownProcs: 0,
        foreignCores: 0.8,
        interval: index === 0 ? 0 : 1,
        gapSec: index === 0 ? 0 : 60
      }))
    }
    writeFileSync(extra, `${lines.join('\n')}\n`)
    const result = score(directory, {
      lines: buildLog(),
      args: ['--run-start', RUN_START, '--run-end', RUN_END, '--baseline-extra', extra]
    })
    assertVerdict(result, 'eligible', 'a run with an extra, valid baseline source')
    assert.equal(result.document.metrics.baselineSamples, 35, 'the baseline is the union of the two sources')
    assert.equal(result.document.metrics.baselineSources[0].usable, 15, 'the extra source contributed its samples')
    assert.equal(result.document.metrics.limits.medianMax, 1.345, 'the limits are still the REGISTERED ones, whatever the operator hands the scorer')
  })
})

test('the quiet-host scorer: a window whose available memory falls below the floor is CONFOUNDED', () => {
  withWorkspace(directory => {
    const lines = buildLog()
    lines[lines.length - 1] = lines[lines.length - 1].replace('memAvailable_kB=8500000', 'memAvailable_kB=1000000')
    const result = score(directory, {
      lines,
      args: ['--run-start', RUN_START, '--run-end', RUN_END]
    })
    assertVerdict(result, 'confounded', 'a window whose available memory fell below the floor')
    assertReasoned(result, 'below the 4 GiB floor', 'the memory breach is named')
  })
})

test('the quiet-host scorer: a window whose foreign process count exceeds the baseline + headroom is CONFOUNDED', () => {
  withWorkspace(directory => {
    const lines = buildLog()
    lines[lines.length - 1] = lines[lines.length - 1].replace('foreignProcs=4', 'foreignProcs=9')
    const result = score(directory, {
      lines,
      args: ['--run-start', RUN_START, '--run-end', RUN_END]
    })
    assertVerdict(result, 'confounded', 'a window with nine foreign node processes against a baseline of four')
    assertReasoned(result, 'the foreign process count reached 9', 'the process-count breach is named')
    assert.equal(result.document.metrics.foreignProcessAllowance, 7, 'the allowance is the measured baseline + the registered headroom')
  })
})

test('the quiet-host scorer: absolute limits in the thresholds file are the ones the window is judged against', () => {
  withWorkspace(directory => {
    // The absolute numbers the thresholds file's note advertises for this
    // host's measured baseline: 0.862 + 0.5 and 0.8307 + 0.75.
    const thresholds = thresholdsVariant(directory, registered => {
      registered.foreignCores.medianMax = 1.3
      registered.foreignCores.meanMax = 1.55
    })
    const result = score(directory, {
      lines: buildLog({ baselineCores: 0.8 }),
      args: ['--run-start', RUN_START, '--run-end', RUN_END],
      thresholds
    })
    assertVerdict(result, 'eligible', 'a window judged against absolute limits that agree with the baseline')
    const limits = result.document.metrics.limits
    assert.equal(limits.source, 'absolute', 'the absolute limits are used when the file registers them')
    assert.equal(limits.medianMax, 1.3, 'the registered absolute median limit is used')
    assert.equal(limits.advertised.medianMax, 1.3, 'the advertised limits are reported')
    assert.equal(limits.computed.medianMax, 1.3, 'the relative limits are computed and reported too')
  })
})

test('the quiet-host scorer: a thresholds file with the absolute limits alone is a complete registration', () => {
  withWorkspace(directory => {
    const thresholds = thresholdsVariant(directory, registered => {
      registered.foreignCores.medianMax = 1.3
      registered.foreignCores.meanMax = 1.55
      delete registered.foreignCores.medianAllowanceCores
      delete registered.foreignCores.meanAllowanceCores
    })
    const result = score(directory, {
      lines: buildLog({ baselineCores: 0.8 }),
      args: ['--run-start', RUN_START, '--run-end', RUN_END],
      thresholds
    })
    assertVerdict(result, 'eligible', 'a window judged against a complete absolute registration')
    assert.equal(result.document.metrics.limits.source, 'absolute', 'the absolute limits are the ones in use')
    assert.equal(result.document.metrics.limits.meanMax, 1.55, 'the registered absolute mean limit is used')
  })
})

test('the quiet-host scorer: the registered limits govern even when the measured baseline would give different ones, and the difference is REPORTED', () => {
  withWorkspace(directory => {
    // The thresholds file registers absolute limits. The relative form — the
    // measured baseline plus the allowance — is a DIAGNOSTIC of the host as
    // it measures now: it is reported, and it does not re-define the rule.
    // (The check that the host has not MOVED is the baseline expectation,
    // which compares the measured baseline with the registered one.)
    const thresholds = thresholdsVariant(directory, registered => {
      registered.foreignCores.medianMax = 1.362
      registered.foreignCores.meanMax = 1.581
    })
    const result = score(directory, {
      lines: buildLog({ baselineCores: 0.8 }),
      args: ['--run-start', RUN_START, '--run-end', RUN_END],
      thresholds
    })
    assertVerdict(result, 'eligible', 'registered limits that disagree with the measured baseline')
    assert.equal(result.document.metrics.limits.medianMax, 1.362, 'the registered limit is the one in use')
    assert.equal(result.document.metrics.limits.computed.medianMax, 1.3, 'the relative form is reported beside it')
    assert.ok(
      result.document.metrics.limits.advertisedVsComputed.medianDrift > 0,
      'the difference between the registered limit and the relative one is reported'
    )
  })
})

test('the quiet-host scorer: a thresholds file with no ABSOLUTE CPU limits is INCOMPLETE, never a silent ELIGIBLE', () => {
  withWorkspace(directory => {
    // A file that registers only the ALLOWANCES would leave the night's
    // limits to be computed from whatever baseline the operator hands the
    // scorer. That is the hole the registration exists to close, so it is an
    // invalid configuration rather than a fallback.
    const thresholds = thresholdsVariant(directory, registered => {
      delete registered.foreignCores.medianMax
      delete registered.foreignCores.meanMax
      delete registered.foreignCores.medianAllowanceCores
      delete registered.foreignCores.meanAllowanceCores
    })
    const result = score(directory, {
      lines: buildLog(),
      args: ['--run-start', RUN_START, '--run-end', RUN_END],
      thresholds
    })
    assertVerdict(result, 'incomplete', 'a thresholds file that registers no absolute CPU limits')
    assertReasoned(result, 'registers no ABSOLUTE foreign-CPU limits', 'the missing limits are named')
  })
})

test('the quiet-host scorer: a thresholds digest that does not match the launch record is INCOMPLETE', () => {
  withWorkspace(directory => {
    const result = score(directory, {
      lines: buildLog(),
      args: ['--run-start', RUN_START, '--run-end', RUN_END, '--expect-thresholds-digest', `sha256:${'0'.repeat(64)}`]
    })
    assertVerdict(result, 'incomplete', 'a thresholds file that is not the registered one')
    assertReasoned(result, 'the launch record registered', 'the digest mismatch is named')
    // The same invocation with the REAL digest is clean: the check binds the
    // file, it does not condemn it.
    const matched = score(directory, {
      lines: buildLog(),
      args: ['--run-start', RUN_START, '--run-end', RUN_END, '--expect-thresholds-digest', digestOf(THRESHOLDS)]
    })
    assertVerdict(matched, 'eligible', 'the registered thresholds file, with its registered digest')
  })
})

test('the quiet-host scorer: a hole in the middle of the window is INCOMPLETE', () => {
  withWorkspace(directory => {
    const offsets = []
    for (let seconds = 0; seconds <= 3600; seconds += 60) offsets.push(seconds)
    for (let seconds = 4200; seconds <= 14400; seconds += 60) offsets.push(seconds)
    const result = score(directory, {
      lines: buildLog({ windowOffsets: offsets }),
      args: ['--run-start', RUN_START, '--run-end', RUN_END]
    })
    assertVerdict(result, 'incomplete', 'a window with a five-minute hole')
    assertReasoned(result, 'not at the registered 60s cadence', 'the hole is named')
    assert.ok(
      result.document.metrics.gaps.some(gap => gap.kind === 'interval' && gap.seconds === 600),
      'the hole is recorded as a gap'
    )
  })
})

test('the quiet-host scorer: the foreign CPU mean is weighted by ELAPSED TIME, not by rows', () => {
  withWorkspace(directory => {
    // 255 short (45 s) quiet intervals and 39 long (75 s) hot ones, spread
    // evenly across the window. The row mean of that window is 0.53 cores —
    // under the 0.75 limit. The elapsed-time mean is 0.8125 cores — over it.
    // A scorer that averages rows lets the hot stretches hide behind the long
    // quiet ones.
    const durations = []
    const values = []
    const totalIntervals = 294
    const longCount = 39
    for (let index = 0; index < totalIntervals; index += 1) {
      const isLong = Math.floor((index + 1) * longCount / totalIntervals) > Math.floor(index * longCount / totalIntervals)
      durations.push(isLong ? 75 : 45)
      values.push(isLong ? 4 : 0)
    }
    assert.equal(durations.filter(seconds => seconds === 75).length, 39, 'the fixture holds 39 long intervals')
    assert.equal(durations.reduce((sum, seconds) => sum + seconds, 0), 14400, 'the fixture spans exactly the window')
    // The registered mean limit is 0.75 in this fixture's registration, so
    // the elapsed-time mean breaches it and the row mean does not.
    const thresholds = thresholdsVariant(directory, registered => {
      registered.foreignCores.meanMax = 0.75
      // This fixture's synthetic baseline is silent, so its registration
      // expects a silent baseline: otherwise the baseline-drift check would
      // (rightly) report that the host had moved, and the fixture would be
      // about two things at once.
      registered.baselineExpectation.median = 0
      registered.baselineExpectation.mean = 0
    })
    const result = score(directory, {
      lines: buildLog({ baselineCores: 0, windowDurations: durations, windowIntervalValues: values }),
      args: ['--run-start', RUN_START, '--run-end', RUN_END],
      thresholds
    })
    const metrics = result.document.metrics
    assert.equal(metrics.foreignCoresMean, 0.8125, 'the reported mean is the elapsed-time weighted mean')
    assert.ok(metrics.foreignCoresRowMean < 0.75, `the row mean would have passed; rowMean=${metrics.foreignCoresRowMean}`)
    assert.ok(metrics.foreignCoresMean > metrics.foreignCoresRowMean, 'the elapsed-time mean is the larger, stricter number')
    assertVerdict(result, 'confounded', 'a window that only fails on the elapsed-time mean')
    assertReasoned(result, 'elapsed-time mean foreign CPU', 'the breach names the elapsed-time mean')
  })
})

test('the quiet-host scorer: --report-baseline prints the distribution and judges nothing', () => {
  withWorkspace(directory => {
    const telemetry = writeLog(directory, buildLog())
    const result = runScorer([
      '--telemetry', telemetry,
      '--thresholds', THRESHOLDS,
      '--run-start', RUN_START,
      '--run-end', RUN_END,
      '--report-baseline'
    ])
    assert.equal(result.status, 0, `the baseline report exits 0 when the baseline is usable; stdout=${result.stdout}`)
    assert.equal(result.document.report.startsWith('baseline distribution'), true, 'the report says what it is')
    assert.equal(result.document.samples, 20, 'the report counts the baseline\'s samples')
    assert.equal(result.document.foreignCores.median, 0.8, 'the report carries the baseline\'s median')
    assert.equal(result.document.foreignCores.mean, 0.8, 'the report carries the baseline\'s mean')
    assert.equal(result.document.foreignProcessMax, 4, 'the report carries the baseline\'s foreign process maximum')

    // The same mode, with a broken extra source, is still INCOMPLETE.
    const extra = join(directory, 'broken-extra.log')
    writeFileSync(extra, 'not a sample\n')
    const broken = runScorer([
      '--telemetry', telemetry,
      '--thresholds', THRESHOLDS,
      '--run-start', RUN_START,
      '--run-end', RUN_END,
      '--baseline-extra', extra,
      '--report-baseline'
    ])
    assert.equal(broken.status, 1, 'a broken extra source fails the report mode too')
    assert.equal(broken.document.verdict, 'incomplete', 'a broken extra source is INCOMPLETE in the report mode too')
  })
})

test('the quiet-host scorer: --out writes the verdict, and the window may end at the harness\'s RSS window', () => {
  withWorkspace(directory => {
    const out = join(directory, 'verdict.json')
    const result = score(directory, {
      lines: buildLog(),
      args: ['--run-start', RUN_START, '--rss-window-end', RUN_END],
      out
    })
    assert.equal(result.status, 0, `a clean window exits 0; stdout=${result.stdout} stderr=${result.stderr}`)
    const written = JSON.parse(readFileSync(out, 'utf8'))
    assert.equal(written.verdict, 'eligible', 'the written verdict is the verdict')
    assert.equal(written.runEndSource, 'rss-window-end', 'the document says which end was used')
    assert.equal(written.thresholdsDigest, digestOf(THRESHOLDS), 'the written verdict binds the thresholds file it was scored against')
  })
})

test('the quiet-host scorer: a window sample that shows NONE of the run\'s own processes is INCOMPLETE', () => {
  withWorkspace(directory => {
    // The run's processes must be present in EVERY sample of the measured
    // window. If they are not, the window is not a window of a run — the run
    // died, or its identity was lost — and the numbers in it cannot be
    // attributed to a run at all.
    const lines = buildLog()
    const target = lines.length - 5
    lines[target] = lines[target].replace(/ownProcs=\d+/, 'ownProcs=0')
    const result = score(directory, {
      lines,
      args: ['--run-start', RUN_START, '--run-end', RUN_END]
    })
    assertVerdict(result, 'incomplete', 'a window sample with no own processes')
    assertReasoned(result, 'none of the run\'s own processes inside the measured window', 'the window is not a window of a run')
  })
})

test('the quiet-host scorer: the baseline\'s statistics exclude the observer\'s synthetic first sample', () => {
  withWorkspace(directory => {
    // The observer's FIRST sample of a log has no previous sample to
    // difference against, so its foreign CPU is a synthetic zero. Including
    // it in the baseline's mean would depress the mean by a number that was
    // never observed — in the wrong direction for a limit.
    const lines = buildLog({ baselineCount: 20, baselineCores: 0.8 })
    const first = lines.findIndex(line => line.includes('interval=0'))
    assert.notEqual(first, -1, 'the log has a synthetic first sample')
    const result = score(directory, {
      lines,
      args: ['--run-start', RUN_START, '--run-end', RUN_END]
    })
    const mean = result.document.metrics.baselineForeignCoresMean
    assert.equal(result.document.metrics.baselineSyntheticSamples, 1, 'the synthetic sample is counted and reported')
    assert.ok(
      Math.abs(mean - 0.8) < 0.0001,
      `the baseline mean is the mean of the MEASURED samples (${mean}), not depressed by the synthetic zero`
    )
  })
})
