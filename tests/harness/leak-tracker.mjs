// Story 2.4 — the endurance harness: an opt-in leak tracker for daily
// development. Any test opts in by constructing a tracker (or calling the
// point samplers directly); nothing here runs unless a test asks for it.
//
// THE SINGLE MEMORY PASS RULE (the rule this harness pins — and the only
// thing it pins): least-squares linear regression of RSS over the sampled
// window yields a slope; that slope, expressed as a percentage of the
// window's STARTING RSS PER SECOND, must be at or below `tolerancePct`
// (default 2). A negative slope (RSS declining) always passes. This is a
// RATE rule, so it is independent of both the wall duration and the chosen
// sampling interval: a "5-minute-equivalent" soak is compressed by the test
// choosing its own `intervalMs` (e.g. 40 ms samples during a few seconds of
// real churn) — the RULE is what carries across stories, not the wall
// duration. Multi-hour soak endurance is Story 6.3's REL-3, not this rule's.
//
// What is sampled: `process.memoryUsage().rss` AND the process's open file
// descriptor count, every interval, with real timestamps — the regression
// runs against the ACTUAL sample times, never the nominal interval, so slow
// samplers stretch the window honestly instead of distorting the slope.
//
// Where the numbers come from (no mocks — OS inventories only):
//   pid === process.pid (default):
//     RSS  — process.memoryUsage().rss
//     FDs  — readdir of /dev/fd on macOS, /proc/self/fd on Linux
//   any other pid (sampling a spawned server FROM OUTSIDE):
//     RSS  — `ps -o rss=` on macOS; VmRSS in /proc/<pid>/status on Linux
//     FDs  — `lsof -a -p <pid> -F f` (numeric descriptors counted) on
//            macOS; readdir of /proc/<pid>/fd on Linux
// Each tracker instance samples through ONE mechanism for its whole life
// (self or external), so within a tracker the FD counts are like-for-like.
//
// Reuse contract (Stories 2.5, 4.8, 6.2): the exports are the API —
//   createLeakTracker({ intervalMs, tolerancePct, pid })
//   tracker.sampleNow() / start() / stop() / evaluate()
//   assertMemoryPass(tracker, { label })
//   sampleRssBytes(pid) / sampleFdCount(pid)          — point samples
//   leastSquaresSlopeBytesPerMs(samples)              — pure regression
//   evaluateRssSamples(samples, tolerancePct)         — pure pass rule
// No test-only seams, no globals, no state outside the returned tracker.

import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'

const SAMPLE_EXEC_TIMEOUT_MS = 10_000
const MIN_SAMPLES_FOR_REGRESSION = 3
const KIB = 1024
const MS_PER_SECOND = 1000
const PCT = 100

const sleep = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })

function execFilePromise(file, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(file, args, { encoding: 'utf8', timeout: SAMPLE_EXEC_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        rejectPromise(error)
        return
      }
      resolvePromise({ stdout, stderr })
    })
  })
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

function assertValidPid(pid) {
  assert.equal(Number.isInteger(pid), true, `pid must be an integer, received ${String(pid)}`)
  assert.ok(pid > 0, `pid must be positive, received ${String(pid)}`)
}

// --- RSS -------------------------------------------------------------------------

// Resident set size of `pid` in bytes. The current process reads its own
// counter; any other pid is measured from outside through the platform's
// process inventory (ps on macOS, /proc on Linux).
export async function sampleRssBytes(pid) {
  assertValidPid(pid)
  if (pid === process.pid) return process.memoryUsage().rss
  if (process.platform === 'darwin') {
    const { stdout } = await execFilePromise('ps', ['-o', 'rss=', '-p', String(pid)])
    const match = /^\s*(\d+)\s*$/.exec(stdout)
    if (!match) {
      throw new Error(`ps -o rss= -p ${pid} answered nothing parsable (${JSON.stringify(stdout)}) — the process may have exited`)
    }
    return Number(match[1]) * KIB
  }
  if (process.platform === 'linux') {
    let status
    try {
      status = readFileSync(`/proc/${pid}/status`, 'utf8')
    } catch (error) {
      throw new Error(`/proc/${pid}/status vanished while sampling RSS: ${error?.message ?? error}`)
    }
    const match = /^VmRSS:\s+(\d+)\s+kB$/m.exec(status)
    if (!match) {
      throw new Error(`/proc/${pid}/status carries no VmRSS line — cannot sample RSS`)
    }
    return Number(match[1]) * KIB
  }
  throw new Error(`unsupported RSS-sampling platform: ${process.platform}`)
}

// --- File descriptors --------------------------------------------------------------

// Count of open file descriptors of `pid`. The current process reads its own
// descriptor directory; any other pid is counted from outside (lsof on macOS,
// /proc on Linux). Only NUMERIC descriptors count: lsof's -F f output also
// carries non-fd entries (fcwd, ftxt) that /dev/fd never lists.
export async function sampleFdCount(pid) {
  assertValidPid(pid)
  if (pid === process.pid) {
    const directory = process.platform === 'darwin'
      ? '/dev/fd'
      : process.platform === 'linux'
        ? '/proc/self/fd'
        : null
    if (directory === null) {
      throw new Error(`unsupported FD-sampling platform: ${process.platform}`)
    }
    return readdirSync(directory).length
  }
  if (process.platform === 'darwin') {
    let outcome
    try {
      outcome = await execFilePromise('lsof', ['-a', '-p', String(pid), '-F', 'f'])
    } catch (error) {
      if (!pidAlive(pid)) {
        throw new Error(`lsof failed and pid ${pid} is gone — the process exited during FD sampling: ${error?.message ?? error}`)
      }
      throw new Error(`lsof -a -p ${pid} -F f failed while the process is alive: ${error?.message ?? error}; stderr=${error?.stderr ?? ''}`)
    }
    return outcome.stdout.split('\n').filter(line => /^f\d+$/.test(line)).length
  }
  if (process.platform === 'linux') {
    let descriptors
    try {
      descriptors = readdirSync(`/proc/${pid}/fd`)
    } catch (error) {
      if (!pidAlive(pid)) {
        throw new Error(`/proc/${pid}/fd vanished — the process exited during FD sampling: ${error?.message ?? error}`)
      }
      throw new Error(`readdir /proc/${pid}/fd failed while the process is alive: ${error?.message ?? error}`)
    }
    return descriptors.length
  }
  throw new Error(`unsupported FD-sampling platform: ${process.platform}`)
}

// --- The regression and the pass rule ----------------------------------------------

// Pure least-squares slope of rssBytes over atMs, in bytes per millisecond.
// Timestamps are centered internally so absolute epoch values cannot lose
// precision. Throws on fewer than MIN_SAMPLES_FOR_REGRESSION samples or a
// degenerate window (every sample at the same timestamp).
export function leastSquaresSlopeBytesPerMs(samples) {
  if (!Array.isArray(samples) || samples.length < MIN_SAMPLES_FOR_REGRESSION) {
    throw new Error(
      `the regression needs at least ${MIN_SAMPLES_FOR_REGRESSION} samples, received ${Array.isArray(samples) ? samples.length : String(samples)}`,
    )
  }
  const x0 = samples[0].atMs
  const xs = samples.map(sample => sample.atMs - x0)
  const ys = samples.map(sample => sample.rssBytes)
  const xMean = xs.reduce((sum, value) => sum + value, 0) / xs.length
  const yMean = ys.reduce((sum, value) => sum + value, 0) / ys.length
  let covariance = 0
  let variance = 0
  for (let index = 0; index < xs.length; index += 1) {
    covariance += (xs[index] - xMean) * (ys[index] - yMean)
    variance += (xs[index] - xMean) ** 2
  }
  if (variance === 0) {
    throw new Error('degenerate sampling window: every sample carries the same timestamp')
  }
  return covariance / variance
}

// Pure evaluator: the single memory pass rule applied to recorded samples.
// slopePctOfStart is the slope expressed as a percent of the window's
// starting RSS PER SECOND (a rate — duration- and interval-independent);
// pass = slopePctOfStart <= tolerancePct, so shrinking RSS always passes.
export function evaluateRssSamples(samples, tolerancePct) {
  assert.equal(Number.isFinite(tolerancePct), true, `tolerancePct must be a finite number, received ${String(tolerancePct)}`)
  assert.ok(tolerancePct >= 0, `tolerancePct must be non-negative, received ${String(tolerancePct)}`)
  const slopeBytesPerMs = leastSquaresSlopeBytesPerMs(samples)
  const startRssBytes = samples[0].rssBytes
  assert.ok(startRssBytes > 0, `the starting RSS sample must be positive, received ${String(startRssBytes)}`)
  const slopePctOfStart = (slopeBytesPerMs * MS_PER_SECOND / startRssBytes) * PCT
  const rssValues = samples.map(sample => sample.rssBytes)
  return {
    sampleCount: samples.length,
    elapsedMs: samples[samples.length - 1].atMs - samples[0].atMs,
    startRssBytes,
    endRssBytes: rssValues[rssValues.length - 1],
    minRssBytes: Math.min(...rssValues),
    maxRssBytes: Math.max(...rssValues),
    slopeBytesPerMs,
    slopePctOfStart,
    tolerancePct,
    pass: slopePctOfStart <= tolerancePct,
    samples: [...samples],
  }
}

// --- The tracker ----------------------------------------------------------------------

// The opt-in harness. Sampling starts only when the test calls start() and
// stops when it calls stop(); samples never overlap (the next sample is
// scheduled after the previous one completes, waiting out the remainder of
// the interval), so a slow sampler stretches the inter-sample gap instead of
// piling up. evaluate() applies the memory pass rule to everything sampled.
export function createLeakTracker({
  intervalMs = 50,
  tolerancePct = 2,
  pid = process.pid,
} = {}) {
  assert.equal(Number.isInteger(intervalMs), true, `intervalMs must be an integer, received ${String(intervalMs)}`)
  assert.ok(intervalMs > 0, `intervalMs must be positive, received ${String(intervalMs)}`)
  assert.equal(Number.isFinite(tolerancePct), true, `tolerancePct must be a finite number, received ${String(tolerancePct)}`)
  assert.ok(tolerancePct >= 0, `tolerancePct must be non-negative, received ${String(tolerancePct)}`)
  assertValidPid(pid)

  const samples = []
  let started = false
  let running = false
  let loopPromise = null

  const sampleNow = async () => {
    const atMs = Date.now()
    const rssBytes = await sampleRssBytes(pid)
    const fdCount = await sampleFdCount(pid)
    const sample = { atMs, rssBytes, fdCount }
    samples.push(sample)
    return sample
  }

  const loop = async () => {
    while (running) {
      const sampleStartedAt = Date.now()
      await sampleNow()
      const remainderMs = intervalMs - (Date.now() - sampleStartedAt)
      if (running && remainderMs > 0) await sleep(remainderMs)
    }
  }

  return {
    get pid() { return pid },
    get intervalMs() { return intervalMs },
    get tolerancePct() { return tolerancePct },
    get running() { return running },
    get samples() { return [...samples] },

    // One immediate sample, recorded into the tracker's history (and usable
    // standalone — the churn baseline is exactly this).
    sampleNow,

    start() {
      if (started) throw new Error('leak tracker already started')
      started = true
      running = true
      loopPromise = loop()
    },

    // Stops after the in-flight sample completes; start/stop pairs are
    // one-shot (build a fresh tracker to run again).
    async stop() {
      if (!started) throw new Error('leak tracker was never started')
      if (!running) throw new Error('leak tracker is already stopped')
      running = false
      await loopPromise
    },

    // The full evaluation: the memory pass rule plus the FD drift summary
    // (relative to the tracker's FIRST recorded sample).
    evaluate() {
      if (samples.length < MIN_SAMPLES_FOR_REGRESSION) {
        throw new Error(
          `the tracker recorded ${samples.length} sample(s); the memory pass rule needs at least ${MIN_SAMPLES_FOR_REGRESSION}`,
        )
      }
      const evaluation = evaluateRssSamples(samples, tolerancePct)
      const fdStart = samples[0].fdCount
      const fdDrifts = samples.map(sample => Math.abs(sample.fdCount - fdStart))
      return {
        ...evaluation,
        fdStart,
        fdMin: Math.min(...samples.map(sample => sample.fdCount)),
        fdMax: Math.max(...samples.map(sample => sample.fdCount)),
        fdMaxAbsDriftFromStart: Math.max(...fdDrifts),
      }
    },
  }
}

// node:test helper: evaluate and assert the memory pass rule, naming the
// numbers in the failure message so a red run is diagnosable without a rerun.
export function assertMemoryPass(tracker, { label = 'memory pass' } = {}) {
  const evaluation = tracker.evaluate()
  // MiB via shift arithmetic: the byte-size literal spellings the constants
  // scan pins belong to the constants module alone.
  const mib = bytes => (bytes / (1 << 20)).toFixed(2)
  assert.equal(
    evaluation.pass,
    true,
    `${label}: the memory pass rule failed — least-squares RSS slope is ` +
    `${evaluation.slopePctOfStart.toFixed(4)}% of starting RSS per second, above the ` +
    `${evaluation.tolerancePct}% tolerance (RSS ${mib(evaluation.startRssBytes)} → ${mib(evaluation.endRssBytes)} MiB, ` +
    `min ${mib(evaluation.minRssBytes)}, max ${mib(evaluation.maxRssBytes)}, ` +
    `${evaluation.sampleCount} samples over ${evaluation.elapsedMs} ms)`,
  )
  return evaluation
}
