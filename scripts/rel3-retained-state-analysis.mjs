#!/usr/bin/env node
// Story 7.6 — the retained-state disposition analysis (retro action A11's
// open part). Recomputes, from the ARCHIVED --trace-gc capture of a soak
// attempt, everything the disposition rests on — nothing is hand-waved:
//
//   node scripts/rel3-retained-state-analysis.mjs --trace <gc-trace.log> [--window-hours 4]
//
// It prints (and, with --json, emits) the same family of numbers the soak's
// recorded retainedState diagnostic used, PLUS the robustness views that
// decide the disposition:
//   - the OLS slope over the final window (the recorded rule's shape) and
//     the same slope with reconnect-window TRANSIENTS excluded (majors
//     whose after-heap is an outlier against the window's mode),
//   - the window's mode and how many observations sit exactly on it,
//   - the endpoint movement in DISPLAY BUCKETS (V8 prints 0.1 MiB), and
//     the instrument's own resolution floor in %/hour at that heap size,
//   - the whole-run shape (first-hour warmup vs the plateau that follows).
//
// Exit 0 always unless the inputs are unreadable — this is an analysis, not
// a gate (the ratified amendment keeps the retained-state diagnostic
// reported, never gated).

import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

const args = process.argv.slice(2)
const flag = name => {
  const at = args.indexOf(name)
  return at === -1 ? undefined : args[at + 1]
}
const tracePath = flag('--trace')
const windowHours = Number(flag('--window-hours') ?? 4)
const asJson = args.includes('--json')
if (!tracePath) {
  process.stderr.write('usage: node scripts/rel3-retained-state-analysis.mjs --trace <gc-trace.log> [--window-hours 4] [--json]\n')
  process.exit(2)
}

const MAJOR_PATTERN = /^\[\d+:[^\]]+\]\s+(\d+) ms: (?:Mark-Compact|Mark-sweep).*-> ([\d.]+) \(([\d.]+)\) MB/
const BUCKET = 0.1

const majors = []
for (const line of readFileSync(resolve(process.cwd(), tracePath), 'utf8').split('\n')) {
  const match = MAJOR_PATTERN.exec(line)
  // Groups: 1 = timestamp, 2 = used-after MiB, 3 = total-after MiB.
  if (match) majors.push({ atMs: Number(match[1]), usedAfterMiB: Number(match[2]) })
}
if (majors.length === 0) {
  process.stderr.write('rel3-retained-state-analysis: no major collections parsed from the trace\n')
  process.exit(2)
}

const spanMs = majors[majors.length - 1].atMs - majors[0].atMs
const windowStart = majors[majors.length - 1].atMs - windowHours * 3_600_000
const window = majors.filter(entry => entry.atMs >= windowStart)

const mode = counts => {
  const histogram = new Map()
  for (const value of counts) {
    const rounded = Math.round(value * 10) / 10
    histogram.set(rounded, (histogram.get(rounded) ?? 0) + 1)
  }
  let best = null
  let bestCount = -1
  for (const [value, count] of histogram) {
    if (count > bestCount || (count === bestCount && value < best)) {
      best = value
      bestCount = count
    }
  }
  return { mode: best, modeCount: bestCount }
}

const olsSlopePerHour = entries => {
  if (entries.length < 2) return 0
  const n = entries.length
  const meanX = entries.reduce((sum, e) => sum + e.atMs, 0) / n
  const meanY = entries.reduce((sum, e) => sum + e.usedAfterMiB, 0) / n
  const numerator = entries.reduce((sum, e) => sum + (e.atMs - meanX) * (e.usedAfterMiB - meanY), 0)
  const denominator = entries.reduce((sum, e) => sum + (e.atMs - meanX) ** 2, 0)
  return denominator === 0 ? 0 : (numerator / denominator) * 3_600_000
}

const pctPerHour = (miBPerHour, meanMiB) => (miBPerHour / meanMiB) * 100

const windowMode = mode(window.map(entry => Math.round(entry.usedAfterMiB / BUCKET) * BUCKET))
const core = window.filter(entry => Math.abs(entry.usedAfterMiB - windowMode.mode) <= BUCKET)
const transients = window.length - core.length
const meanWindow = window.reduce((sum, e) => sum + e.usedAfterMiB, 0) / window.length
const slopeAll = olsSlopePerHour(window)
const slopeCore = olsSlopePerHour(core)
const endpointBuckets = Math.round((window[window.length - 1].usedAfterMiB - window[0].usedAfterMiB) / BUCKET)
// The instrument's resolution floor: one display bucket of endpoint
// movement over the window, expressed in %/hour of the mean heap.
const resolutionFloorPctPerHour = (BUCKET / meanWindow) * 100 / (windowHours * 0.99)

const firstHour = majors.filter(entry => entry.atMs < majors[0].atMs + 3_600_000)
const firstHourMode = mode(firstHour.map(entry => Math.round(entry.usedAfterMiB / BUCKET) * BUCKET))

const report = {
  trace: tracePath,
  majorsParsed: majors.length,
  runSpanHours: Number((spanMs / 3_600_000).toFixed(2)),
  window: {
    hours: windowHours,
    observations: window.length,
    modeMiB: windowMode.mode,
    modeShare: Number((windowMode.modeCount / window.length).toFixed(3)),
    transientMajors: transients,
    olsPctPerHour_all: Number(pctPerHour(slopeAll, meanWindow).toFixed(4)),
    olsPctPerHour_coreNoTransients: Number(pctPerHour(slopeCore, meanWindow).toFixed(4)),
    endpointMovementBuckets: endpointBuckets,
    instrumentResolutionPctPerHour: Number(resolutionFloorPctPerHour.toFixed(4)),
  },
  wholeRun: {
    firstHourModeMiB: firstHourMode.mode,
    plateauMiB: windowMode.mode,
    plateauHours: Number(((majors[majors.length - 1].atMs - (majors.find(e => Math.abs(e.usedAfterMiB - windowMode.mode) <= BUCKET)?.atMs ?? majors[0].atMs)) / 3_600_000).toFixed(2)),
  },
}

if (asJson) {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
} else {
  process.stdout.write([
    `majors parsed: ${report.majorsParsed} over ${report.runSpanHours} h`,
    `final ${windowHours} h window: ${report.window.observations} majors; mode ${report.window.modeMiB} MiB holds ${report.window.modeShare} of them (${report.window.transientMajors} transients)`,
    `  OLS (recorded rule shape): ${report.window.olsPctPerHour_all} %/h`,
    `  OLS (transients excluded):  ${report.window.olsPctPerHour_coreNoTransients} %/h`,
    `  endpoint movement: ${report.window.endpointMovementBuckets} display bucket(s); instrument resolution ~${report.window.instrumentResolutionPctPerHour} %/h`,
    `whole run: first-hour mode ${report.wholeRun.firstHourModeMiB} MiB (warmup) -> plateau ${report.wholeRun.plateauMiB} MiB held for the last ${report.wholeRun.plateauHours} h`,
  ].join('\n'))
  process.stdout.write('\n')
}
