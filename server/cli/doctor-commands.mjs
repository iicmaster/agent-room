// Story 4.3 — `agent-room doctor [--json]`: a one-shot, strictly READ-ONLY
// health diagnosis of every notification axis. No GC, no writes, no mutator
// endpoints. Every probe is bounded to DOCTOR_PROBE_TIMEOUT_MS (1 s) and the
// whole report to DOCTOR_TOTAL_BUDGET_MS (3 s); a hung probe is cut short and
// reported honestly as degraded, never left hanging.
//
// AQ-2 dignity: notify.gate reports the STRONGEST mechanism actually observed
// — never guessed from config/plugin/wait.lock. Tier 1A is Active ONLY from a
// real initialize capability observation injected by the host (verifyClaudeChannel
// is the sole authority); a plain CLI doctor has no live handshake and says so.
//
// Reuses existing primitives only: verifyClaudeChannel (4.1), the Tier 3
// config/executable verification (this story), probeNofile (1.5), GET /api/status
// write_queue (1.1), heldCount (3.x), and the 3.2 loop-guard counters — read
// straight from loop-ledger.sqlite in readOnly mode (never createScopeLedger,
// which heals/quarantines — a mutation doctor must not perform). No new path
// builder (sessionScopeFilePath) and no new lock.
//
// Zero external dependencies.

import { lstatSync, readFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  DOCTOR_PROBE_TIMEOUT_MS,
  DOCTOR_TOTAL_BUDGET_MS,
  LOOP_GLOBAL_LIMIT,
  LOOP_PAIR_LIMIT,
  NOFILE_RECOMMENDED,
  NOTIFY_GATE_STATES,
} from '../constants.mjs'
import { verifyClaudeChannel, CHANNEL_TIER } from '../client/channel-verification.mjs'
import { resolveNotifyConfig, verifyExecutable } from '../notification/tier3-notify.mjs'
import { probeNofile } from './bootstrap-commands.mjs'
import { heldCount } from '../client/held.mjs'
import { sessionScopeFilePath, sessionScopeKey } from '../client/session-state.mjs'
import { exchangeCliSession } from './held-commands.mjs'
import { cliBearerHeaders, cliHttpJson } from './http.mjs'
import { readRuntimeRecord } from '../client/ensure-server.mjs'

const MODULE_DIR = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(MODULE_DIR, '..', '..')

const OK_STATUS = 200
const LOOP_LEDGER_FILENAME = 'loop-ledger.sqlite'
const HOOKS_RELATIVE = join('hooks', 'hooks.json')
const HOOK_ENTRY_RELATIVE = join('server', 'cli', 'hook-commands.mjs')
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PostToolUse', 'Stop']

// --- small pure utilities -------------------------------------------------------

function liveCount(counter, nowMs) {
  if (!counter || !Number.isFinite(counter.expires_at) || counter.expires_at <= nowMs) return 0
  return Number.isSafeInteger(counter.count) && counter.count > 0 ? counter.count : 0
}

// A probe that never hangs. A timeout (or a throw) yields `fallback`, tagged
// degraded by the caller via the probe's own shape.
function bounded(label, work, fallback, timeoutMs = DOCTOR_PROBE_TIMEOUT_MS, now = Date.now) {
  const started = now()
  let timer
  const timeout = new Promise(done => { timer = setTimeout(() => done({ __timedOut: label }), timeoutMs) })
  return Promise.race([
    Promise.resolve().then(work).catch(error => ({ __error: error?.code ?? error?.message ?? String(error) })),
    timeout,
  ]).then(value => {
    clearTimeout(timer)
    if (value && typeof value === 'object' && (value.__timedOut || value.__error)) {
      return { ...fallback, degraded: true, probe: label, detail: value.__error ?? 'timeout', elapsed_ms: Math.max(0, now() - started) }
    }
    return value
  })
}

// --- the write_queue / auth / send probe (GET /api/status, 1.1) ----------------

export async function defaultFetchStatus({ sharedDataDir, pluginDataDir, timeoutMs = DOCTOR_PROBE_TIMEOUT_MS }) {
  const record = readRuntimeRecord(sharedDataDir)
  if (record === null) return { reachable: false, reason: 'no-server-runtime-record' }
  const { sessionToken } = await exchangeCliSession({ port: record.port, sharedDataDir, pluginDataDir })
  const response = await cliHttpJson(
    record.port, 'GET', '/api/status', cliBearerHeaders(sessionToken), undefined, timeoutMs,
  )
  if (response.status !== OK_STATUS || response.body?.ok !== true) {
    return { reachable: false, reason: 'status-refused' }
  }
  const result = response.body.result ?? {}
  return {
    reachable: true,
    realmId: typeof result.realm_id === 'string' ? result.realm_id : null,
    writeQueue: result.write_queue ?? null,
    version: typeof result.version === 'string' ? result.version : null,
  }
}

// --- the loop pause probe (read-only loop-ledger, 3.2) --------------------------

export function probeLoopPaused({ pluginDataDir, scope, nowMs = Date.now() } = {}) {
  const empty = { pairs_paused: false, global_paused: false, provenance: 'no-ledger', status: 'unknown' }
  if (typeof pluginDataDir !== 'string' || typeof scope !== 'string') return empty
  let path
  try { path = sessionScopeFilePath(pluginDataDir, scope, LOOP_LEDGER_FILENAME) } catch { return empty }
  let info
  try { info = lstatSync(path) } catch { return empty }
  if (!info.isFile() || info.isSymbolicLink()) return { ...empty, provenance: path, status: 'refused' }
  let db
  try {
    db = new DatabaseSync(path, { readOnly: true })
    let globalCounter = null
    try { globalCounter = db.prepare('SELECT count, expires_at FROM global_counter WHERE scope = ?').get(scope) } catch { /* fresh */ }
    let pairRows = []
    try { pairRows = db.prepare('SELECT count, expires_at FROM pair_counter').all() } catch { /* fresh */ }
    const globalPaused = liveCount(globalCounter, nowMs) >= LOOP_GLOBAL_LIMIT
    const pairsPaused = pairRows.some(row => liveCount(row, nowMs) >= LOOP_PAIR_LIMIT)
    return {
      pairs_paused: pairsPaused,
      global_paused: globalPaused,
      provenance: path,
      status: 'ok',
    }
  } catch {
    return { ...empty, provenance: path, status: 'unreadable' }
  } finally {
    try { db?.close() } catch { /* already closed */ }
  }
}

// --- the Tier 2 hook probe (hooks.json + entrypoint, read-only) ----------------

export function probeHooks({ pluginRoot = PLUGIN_ROOT, fsStat = lstatSync, fsRead = readFileSync } = {}) {
  const hooksPath = join(pluginRoot, HOOKS_RELATIVE)
  const entryPath = join(pluginRoot, HOOK_ENTRY_RELATIVE)
  try {
    const hooksInfo = fsStat(hooksPath)
    const entryInfo = fsStat(entryPath)
    if (!hooksInfo.isFile() || !entryInfo.isFile()) return { present: false, provenance: hooksPath }
    // Confirm all four lifecycle events are registered. A present-but-partial
    // hooks.json is honestly reported as not fully wired — never an overclaim.
    const doc = JSON.parse(fsRead(hooksPath, 'utf8'))
    const registered = doc?.hooks ?? {}
    const events = HOOK_EVENTS.filter(event => Array.isArray(registered[event]) && registered[event].length > 0)
    return {
      present: events.length === HOOK_EVENTS.length,
      provenance: hooksPath,
      entry_provenance: entryPath,
      events,
    }
  } catch {
    return { present: false, provenance: hooksPath }
  }
}

// --- tier probes ---------------------------------------------------------------

// Tier 1A: the ONLY authority is verifyClaudeChannel on an OBSERVED initialize
// params object. No injected params => not observed => honest unverified.
export function probeTier1A({ channelParams } = {}) {
  if (channelParams === undefined || channelParams === null) {
    return {
      status: 'not-observed',
      provenance: 'initialize handshake not observed by this CLI process',
      freshness: 'not-observed',
    }
  }
  const verification = verifyClaudeChannel(channelParams)
  return {
    status: verification.tier,
    label: verification.label,
    provenance: verification.source,
    freshness: verification.freshness,
  }
}

export function probeTier1B({ status } = {}) {
  if (!status?.reachable) {
    return {
      status: 'unavailable',
      provenance: 'GET /api/status unreachable (passive watch cannot be confirmed)',
      freshness: 'not-observed',
    }
  }
  return {
    status: 'available',
    provenance: 'GET /api/status reachable — passive resources/watch declared by the server',
    freshness: 'live-probe',
  }
}

export function probeTier2({ hooks } = {}) {
  return {
    status: hooks?.present === true ? 'present' : 'absent',
    provenance: hooks?.provenance ?? 'hooks.json not found',
    freshness: 'live-probe',
    ...(hooks?.entry_provenance ? { entry_provenance: hooks.entry_provenance } : {}),
  }
}

export function probeTier3({ env = process.env, pluginDataDir } = {}) {
  const config = resolveNotifyConfig({ env, pluginDataDir })
  if (config.status === 'misconfigured') {
    return { status: 'misconfigured', provenance: config.provenance, reason: config.reason, freshness: 'live-probe' }
  }
  if (config.status === 'none') {
    return { status: 'not-configured', provenance: 'no local Tier 3 config', freshness: 'live-probe' }
  }
  const verified = verifyExecutable(config.argv[0], { mode: config.mode })
  return {
    status: verified.ok ? 'configured' : 'misconfigured',
    provenance: config.provenance,
    ...(verified.ok ? {} : { reason: verified.reason }),
    executable: verified.ok ? config.argv[0] : undefined,
    freshness: 'live-probe',
  }
}

// --- the honest 5-state gate derivation ---------------------------------------

/**
 * Derive the single enforced gate from the observed tiers. Priority is the
 * strength of the MECHANISM actually present — never an assumption:
 *   Tier 1A active  -> Host-channel-enforced
 *   Tier 2 hooks    -> Host-hook-enforced
 *   Tier 3 verified -> Plugin-enforced
 *   Tier 1B passive -> Server-enforced
 *   nothing live    -> Instructed (passive/doc convention only)
 * Every returned state is one of NOTIFY_GATE_STATES (closed enum).
 */
export function deriveNotifyGate({ tiers } = {}) {
  const oneA = tiers?.['1A']
  const two = tiers?.['2']
  const three = tiers?.['3']
  const oneB = tiers?.['1B']
  if (oneA?.status === CHANNEL_TIER.ACTIVE) {
    return {
      state: NOTIFY_GATE_STATES.HOST_CHANNEL,
      provenance: oneA.provenance,
      freshness: oneA.freshness,
    }
  }
  if (two?.status === 'present') {
    return {
      state: NOTIFY_GATE_STATES.HOST_HOOK,
      provenance: two.provenance,
      freshness: two.freshness,
    }
  }
  if (three?.status === 'configured') {
    return {
      state: NOTIFY_GATE_STATES.PLUGIN,
      provenance: three.provenance,
      freshness: three.freshness,
    }
  }
  if (oneB?.status === 'available') {
    return {
      state: NOTIFY_GATE_STATES.SERVER,
      provenance: oneB.provenance,
      freshness: oneB.freshness,
    }
  }
  return {
    state: NOTIFY_GATE_STATES.INSTRUCTED,
    provenance: 'no host channel, hook, verified Tier 3, or reachable passive watch observed',
    freshness: 'live-probe',
  }
}

// --- health / exit classification ---------------------------------------------

export function classifyDoctorHealth(report) {
  const problems = []
  if (report.auth?.status !== 'ok') problems.push('auth')
  if (report.send?.status !== 'ok') problems.push('send')
  if (report.write_queue?.status !== 'ok') problems.push('write_queue')
  if (report.nofile?.status === 'warn') problems.push('nofile')
  if (report.notify?.tiers?.['3']?.status === 'misconfigured') problems.push('tier3')
  if (report.loop?.pairs_paused === true || report.loop?.global_paused === true) problems.push('loop')
  return { healthy: problems.length === 0, problems }
}

// --- arg parsing ---------------------------------------------------------------

export function parseDoctorArgs(tokens = []) {
  let json = false
  for (const token of tokens) {
    if (token === '--json') { json = true; continue }
    return { error: `agent-room doctor: unknown option "${token}"` }
  }
  return { json }
}

// --- the full report -----------------------------------------------------------

/**
 * Run every read-only probe under budget and assemble the report. All I/O
 * seams are injectable so the whole matrix runs in a temp dir / with fixtures
 * and no live server. Returns { report, health }.
 */
export async function collectDoctorReport({
  sharedDataDir,
  pluginDataDir,
  env = process.env,
  pluginRoot = PLUGIN_ROOT,
  // injected seams (product defaults above)
  channelParams,
  fetchStatus = defaultFetchStatus,
  nofileProbe = probeNofile,
  hooksProbe = probeHooks,
  scope = undefined,
  now = Date.now,
  probeTimeoutMs = DOCTOR_PROBE_TIMEOUT_MS,
  totalBudgetMs = DOCTOR_TOTAL_BUDGET_MS,
} = {}) {
  const collect = async () => {
    // status / write_queue / auth / send share one bounded fetch.
    const statusResult = await bounded('status', () => fetchStatus({ sharedDataDir, pluginDataDir, timeoutMs: probeTimeoutMs }), { reachable: false, reason: 'probe-timeout' }, probeTimeoutMs, now)
    const status = statusResult.degraded ? { reachable: false, reason: statusResult.detail } : statusResult

    const tiers = {
      '1A': probeTier1A({ channelParams }),
      '1B': probeTier1B({ status }),
      '2': probeTier2({ hooks: hooksProbe({ pluginRoot }) }),
      '3': probeTier3({ env, pluginDataDir }),
    }
    const gate = deriveNotifyGate({ tiers })

    const nofileRaw = await bounded('nofile', () => nofileProbe(), { status: 'unknown', limit: null, message: 'NOFILE: unknown' }, probeTimeoutMs, now)
    const nofile = {
      status: nofileRaw.status ?? 'unknown',
      limit: nofileRaw.limit ?? null,
      recommended: NOFILE_RECOMMENDED,
      message: nofileRaw.message ?? 'NOFILE: unknown',
      provenance: 'ulimit -n',
    }

    const realmId = status.realmId ?? null
    const held = {
      count: realmId === null ? 0 : boundedCountHeld(pluginDataDir, realmId),
    }

    const effectiveScope = scope ?? sessionScopeKey({ env, pluginDataDir })
    const loopRaw = probeLoopPaused({ pluginDataDir, scope: effectiveScope, nowMs: now() })
    const loop = {
      pairs_paused: loopRaw.pairs_paused,
      global_paused: loopRaw.global_paused,
      provenance: loopRaw.provenance,
    }

    const auth = status.reachable
      ? { status: 'ok', provenance: 'GET /api/status via local unbound session', freshness: 'live-probe' }
      : { status: 'unavailable', provenance: status.reason ?? 'unreachable', freshness: 'live-probe' }
    const send = status.reachable && nofile.status !== 'warn'
      ? { status: 'ok', provenance: 'auth ok and NOFILE adequate', freshness: 'live-probe' }
      : { status: 'degraded', provenance: !status.reachable ? 'server unreachable' : 'NOFILE below recommended', freshness: 'live-probe' }
    const writeQueue = status.reachable
      ? { status: 'ok', metrics: status.writeQueue ?? null, provenance: 'GET /api/status write_queue', freshness: 'live-probe' }
      : { status: 'unavailable', metrics: null, provenance: status.reason ?? 'unreachable', freshness: 'live-probe' }

    const report = {
      auth,
      send,
      notify: { tiers, gate },
      write_queue: writeQueue,
      nofile,
      held,
      loop,
    }
    return report
  }

  const deadline = new Promise((_, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error('doctor deadline exceeded'), { code: 'doctor_deadline' })), totalBudgetMs)
    timer.unref?.()
  })
  let report
  try {
    report = await Promise.race([collect(), deadline])
  } catch {
    // Total-budget breach: a minimal honest degraded report, never a hang.
    report = {
      auth: { status: 'unavailable', provenance: 'deadline', freshness: 'live-probe' },
      send: { status: 'degraded', provenance: 'deadline', freshness: 'live-probe' },
      notify: {
        tiers: {
          '1A': { status: 'not-observed', provenance: 'deadline', freshness: 'not-observed' },
          '1B': { status: 'unavailable', provenance: 'deadline', freshness: 'not-observed' },
          '2': { status: 'absent', provenance: 'deadline', freshness: 'live-probe' },
          '3': { status: 'not-configured', provenance: 'deadline', freshness: 'live-probe' },
        },
        gate: { state: NOTIFY_GATE_STATES.INSTRUCTED, provenance: 'deadline', freshness: 'live-probe' },
      },
      write_queue: { status: 'unavailable', metrics: null, provenance: 'deadline', freshness: 'live-probe' },
      nofile: { status: 'unknown', limit: null, recommended: NOFILE_RECOMMENDED, message: 'NOFILE: unknown', provenance: 'deadline' },
      held: { count: 0 },
      loop: { pairs_paused: false, global_paused: false, provenance: 'deadline' },
    }
  }
  return { report, health: classifyDoctorHealth(report) }
}

function boundedCountHeld(pluginDataDir, realmId) {
  if (typeof pluginDataDir !== 'string') return 0
  try { return heldCount(pluginDataDir, realmId) } catch { return 0 }
}

// --- output formatting ---------------------------------------------------------

export function formatDoctor({ report, health }, { json = false } = {}) {
  if (json) return [JSON.stringify({ ...report, healthy: health.healthy, problems: health.problems })]
  const gate = report.notify.gate
  const lines = [
    `agent-room doctor: ${health.healthy ? 'healthy' : 'degraded'}`,
    `  auth: ${report.auth.status}`,
    `  send: ${report.send.status}`,
    `  notify.gate: ${gate.state} (${gate.provenance})`,
    `  tiers: 1A=${report.notify.tiers['1A'].status} 1B=${report.notify.tiers['1B'].status} 2=${report.notify.tiers['2'].status} 3=${report.notify.tiers['3'].status}`,
    `  write_queue: ${report.write_queue.status}`,
    `  nofile: ${report.nofile.message}`,
    `  held: ${report.held.count} (metadata only)`,
    `  loop: pairs_paused=${report.loop.pairs_paused} global_paused=${report.loop.global_paused}`,
  ]
  return lines
}

// --- CLI family entrypoint -----------------------------------------------------

export async function runDoctorCommand(tokens, deps) {
  const parsed = parseDoctorArgs(tokens)
  if (parsed.error !== undefined) {
    return { status: 'usage', command: 'doctor', code: 'usage', message: parsed.error }
  }
  try {
    const outcome = await collectDoctorReport(deps)
    const lines = formatDoctor(outcome, { json: parsed.json })
    return {
      status: 'ok',
      command: 'doctor',
      lines,
      ...(outcome.health.healthy ? {} : { exitCode: 1 }),
      doctor: outcome.report,
      health: outcome.health,
    }
  } catch (error) {
    return {
      status: 'refusal',
      command: 'doctor',
      code: error?.code ?? 'request_failed',
      message: error?.message ?? String(error),
    }
  }
}
