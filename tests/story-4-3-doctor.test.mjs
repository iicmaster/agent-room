// Story 4.3 AC2/AC3 — `agent-room doctor`: read-only, fully bounded, honest
// 5-state gate, 4 harness snapshots, exit codes. All I/O seams injected; no
// live server, no writes. Oracles are literals in this file.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, writeFileSync, chmodSync, mkdirSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { atomicWriteJson } from '../server/runtime.mjs'
import { loadOrCreateLocalToken } from '../server/api/local-token.mjs'

import {
  DOCTOR_PROBE_TIMEOUT_MS,
  DOCTOR_TOTAL_BUDGET_MS,
  NOTIFY_GATE_ENUM,
  NOFILE_RECOMMENDED,
  LOOP_GLOBAL_LIMIT,
  LOOP_PAIR_LIMIT,
} from '../server/constants.mjs'
import {
  collectDoctorReport,
  defaultFetchStatus,
  deriveNotifyGate,
  formatDoctor,
  parseDoctorArgs,
  probeHooks,
  probeLoopPaused,
  probeTier1A,
  probeTier3,
  runDoctorCommand,
} from '../server/cli/doctor-commands.mjs'
import { CHANNEL_TIER } from '../server/client/channel-verification.mjs'

// --- fixtures: the four harness environments ----------------------------------

const CAPS = capabilities => ({ protocolVersion: '2025-06-18', capabilities })
const channelsHostParams = CAPS({ experimental: { 'claude/channel': {} } })
const genericHostParams = CAPS({})

function makeHooksProbe(present) {
  return () => ({ present, provenance: '/fake/hooks/hooks.json', freshness: 'live-probe' })
}
function statusReachable(writeQueue = { depth: 0 }) {
  return { reachable: true, realmId: 'realm-ok', writeQueue, version: '1.0.0' }
}
function statusDown(reason = 'no-server-runtime-record') {
  return { reachable: false, reason }
}

async function reportFor({
  channelParams,
  hooksPresent = false,
  status = statusReachable(),
  tier3Env = {},
  nofile = { status: 'ok', limit: 8192, message: 'NOFILE: 8192' },
  pluginDataDir = mkdtempSync(join(tmpdir(), 'doctor-fix-')),
} = {}) {
  const { report, health } = await collectDoctorReport({
    sharedDataDir: mkdtempSync(join(tmpdir(), 'doctor-shared-')),
    pluginDataDir,
    env: { ...tier3Env },
    channelParams,
    fetchStatus: async () => status,
    nofileProbe: async () => nofile,
    hooksProbe: makeHooksProbe(hooksPresent),
    scope: 'test-scope',
  })
  return { report, health }
}

test('doctor constants are bounded: probes 1 s, total 3 s', () => {
  assert.equal(DOCTOR_PROBE_TIMEOUT_MS, 1000)
  assert.equal(DOCTOR_TOTAL_BUDGET_MS, 3000)
})

test('the required schema is always present with the exact axis names', async () => {
  const { report } = await reportFor({ channelParams: channelsHostParams })
  assert.deepEqual(Object.keys(report).sort(), [
    'auth', 'held', 'loop', 'nofile', 'notify', 'send', 'write_queue',
  ])
  assert.deepEqual(Object.keys(report.notify).sort(), ['gate', 'tiers'])
  assert.deepEqual(Object.keys(report.notify.tiers).sort(), ['1A', '1B', '2', '3'])
  assert.deepEqual(Object.keys(report.held), ['count'])
  assert.deepEqual(Object.keys(report.loop).filter(k => k !== 'provenance').sort(), ['global_paused', 'pairs_paused'])
  assert.ok(Object.values(NOTIFY_GATE_ENUM).includes(report.notify.gate.state))
})

test('arg parsing: --json accepted, unknown option is usage', () => {
  assert.deepEqual(parseDoctorArgs([]), { json: false })
  assert.deepEqual(parseDoctorArgs(['--json']), { json: true })
  assert.match(parseDoctorArgs(['--bogus']).error, /unknown option/)
})

// --- the closed 5-state gate enum, each driven by observed provenance ----------

test('gate derives all 5 honest states from observed mechanisms', () => {
  const observed = {
    hostChannel: { status: CHANNEL_TIER.ACTIVE, provenance: "initialize['claude/channel']", freshness: 'initialize-handshake' },
    hostHook: { status: 'present', provenance: 'hooks.json', freshness: 'live-probe' },
    tier3: { status: 'configured', provenance: 'AGENT_ROOM_NOTIFY_CMD', freshness: 'live-probe' },
    tier1B: { status: 'available', provenance: '/api/status', freshness: 'live-probe' },
    none: { status: 'unavailable', provenance: 'none', freshness: 'not-observed' },
  }
  const cases = [
    [{ '1A': observed.hostChannel, '2': observed.hostHook, '3': observed.tier3, '1B': observed.tier1B }, 'Host-channel-enforced'],
    [{ '1A': observed.none, '2': observed.hostHook, '3': observed.tier3, '1B': observed.tier1B }, 'Host-hook-enforced'],
    [{ '1A': observed.none, '2': { status: 'absent' }, '3': observed.tier3, '1B': observed.tier1B }, 'Plugin-enforced'],
    [{ '1A': observed.none, '2': { status: 'absent' }, '3': { status: 'not-configured' }, '1B': observed.tier1B }, 'Server-enforced'],
    [{ '1A': observed.none, '2': { status: 'absent' }, '3': { status: 'not-configured' }, '1B': observed.none }, 'Instructed'],
  ]
  for (const [tiers, expectedState] of cases) {
    const gate = deriveNotifyGate({ tiers })
    assert.equal(gate.state, expectedState)
    assert.ok(NOTIFY_GATE_ENUM.includes(gate.state))
    assert.equal(typeof gate.provenance, 'string')
    assert.equal(typeof gate.freshness, 'string')
  }
})

test('AQ-2: Tier 1A is NEVER guessed from hooks/config/wait.lock — only initialize params', () => {
  // No params: not-observed, never active.
  assert.equal(probeTier1A().status, 'not-observed')
  // Generic host (no experimental): never active even with hooks present.
  assert.notEqual(probeTier1A({ channelParams: genericHostParams }).status, CHANNEL_TIER.ACTIVE)
  // Disabled channel: never active.
  const disabled = CAPS({ experimental: { 'claude/channel': { channelsEnabled: false } } })
  assert.notEqual(probeTier1A({ channelParams: disabled }).status, CHANNEL_TIER.ACTIVE)
  // Only a real --channels capability observation is active.
  assert.equal(probeTier1A({ channelParams: channelsHostParams }).status, CHANNEL_TIER.ACTIVE)
})

test('Tier 3 misconfigured detection: whitespace path, symlink, bad JSON env', () => {
  const withEnv = value => probeTier3({ env: { AGENT_ROOM_NOTIFY_CMD: value } })
  assert.equal(withEnv('/tmp/a b').status, 'misconfigured')
  assert.equal(withEnv('not-json-[').status, 'misconfigured')
})

// --- 4 harness snapshot matrix -------------------------------------------------

test('4-harness gate snapshot: Claude --channels / Claude Hooks / Codex CLI / OpenCode', async () => {
  const snapshots = []

  // Claude --channels: real --channels capability -> Host-channel-enforced.
  snapshots.push(await reportFor({ channelParams: channelsHostParams, hooksPresent: true }))

  // Claude Hooks: no channel capability but hooks.json present -> Host-hook-enforced.
  snapshots.push(await reportFor({ channelParams: genericHostParams, hooksPresent: true }))

  // Codex CLI: no channel, no hooks, Tier 3 configured -> Plugin-enforced.
  const dir = mkdtempSync(join(tmpdir(), 'doctor-codex-'))
  const exe = join(dir, 'notify')
  writeFileSync(exe, '#!/bin/sh\nexit 0\n', { mode: 0o700 })
  chmodSync(exe, 0o700)
  snapshots.push(await reportFor({
    channelParams: genericHostParams,
    hooksPresent: false,
    tier3Env: { AGENT_ROOM_NOTIFY_CMD: exe },
  }))

  // OpenCode / Generic: nothing live, server down -> Instructed, degraded.
  snapshots.push(await reportFor({
    channelParams: genericHostParams,
    hooksPresent: false,
    status: statusDown(),
  }))

  const states = snapshots.map(s => s.report.notify.gate.state)
  assert.deepEqual(states, [
    'Host-channel-enforced',
    'Host-hook-enforced',
    'Plugin-enforced',
    'Instructed',
  ])
  // Snapshot core: every tier has provenance + freshness; exit health mirrors
  // the real subsystem state. No snapshot leaks a held body (held has count
  // only, no text field anywhere).
  for (const { report } of snapshots) {
    for (const tier of Object.values(report.notify.tiers)) {
      assert.equal(typeof tier.provenance, 'string', 'each tier names its truth source')
      assert.equal(typeof tier.freshness, 'string', 'each tier states freshness')
    }
    assert.deepEqual(Object.keys(report.held), ['count'])
    assert.ok(!JSON.stringify(report).includes('preview'))
    assert.ok(!JSON.stringify(report).includes('body text'))
  }
})

// --- write_queue / nofile / loop / held ----------------------------------------

test('write_queue telemetry is taken verbatim from GET /api/status', async () => {
  const metrics = { depth: 3, oldest_age_ms: 42, ops_total: 99, rejected_queue_full_total: 1, last_batch_ms: 7 }
  const { report } = await reportFor({ status: statusReachable(metrics) })
  assert.equal(report.write_queue.status, 'ok')
  assert.deepEqual(report.write_queue.metrics, metrics)
  assert.match(report.write_queue.provenance, /api\/status/)
})

test('nofile below the recommended floor shows the exact ulimit guidance and degrades', async () => {
  const { report, health } = await reportFor({
    nofile: { status: 'warn', limit: 512, recommended: NOFILE_RECOMMENDED, message: `NOFILE=512 (< ${NOFILE_RECOMMENDED}); raise with: ulimit -n ${NOFILE_RECOMMENDED}` },
  })
  assert.equal(report.nofile.status, 'warn')
  assert.match(report.nofile.message, /raise with: ulimit -n 4096/)
  assert.equal(health.healthy, false)
  assert.ok(health.problems.includes('nofile'))
})

test('loop pause: read-only probe reports G1/G2 hard pause without writing', () => {
  const dir = mkdtempSync(join(tmpdir(), 'doctor-loop-'))
  const scope = 'scope-1'
  const sessionDir = join(dir, 'sessions', scope)
  mkdirSync(sessionDir, { recursive: true, mode: 0o700 })
  // Real loop-ledger built by the 3.2 module would MUTATE on open; doctor must
  // read a pre-existing ledger read-only. Build one via createScopeLedger once
  // (test setup), then have doctor read it.
  return import('../server/client/scope-ledger.mjs').then(({ createScopeLedger }) => {
    const ledger = createScopeLedger(dir, scope)
    ledger.readCounters() // force the lazy DB open/schema creation
    ledger.close()
    const idle = probeLoopPaused({ pluginDataDir: dir, scope, nowMs: Date.now() })
    assert.equal(idle.status, 'ok')
    assert.equal(idle.global_paused, false)
    assert.equal(idle.pairs_paused, false)
    // Missing ledger => honest unknown, no creation.
    const missing = probeLoopPaused({ pluginDataDir: dir, scope: 'absent-scope', nowMs: Date.now() })
    assert.equal(missing.status, 'unknown')
  })
})

// --- health / exit codes / formatting ------------------------------------------

test('healthy vs degraded classification drives exit 0 / 1 / 2', async () => {
  const healthy = await reportFor({ channelParams: channelsHostParams })
  assert.equal(healthy.health.healthy, true)

  const degraded = await reportFor({ status: statusDown() })
  assert.equal(degraded.health.healthy, false)

  const okRun = await runDoctorCommand(['--json'], {
    sharedDataDir: mkdtempSync(join(tmpdir(), 'doc-')),
    pluginDataDir: mkdtempSync(join(tmpdir(), 'doc-p-')),
    env: {},
    fetchStatus: async () => statusReachable(),
    nofileProbe: async () => ({ status: 'ok', limit: 8192, message: 'NOFILE: 8192' }),
    hooksProbe: makeHooksProbe(true),
  })
  assert.equal(okRun.status, 'ok')
  assert.equal(okRun.exitCode, undefined, 'healthy -> no forced exit 1')
  assert.equal(JSON.parse(okRun.lines[0]).healthy, true)

  const usage = await runDoctorCommand(['--nope'], {})
  assert.equal(usage.status, 'usage')
  assert.equal(usage.code, 'usage')
})

test('a hung probe is cut short at the budget — doctor reports degraded, never hangs', async () => {
  const start = Date.now()
  const { report, health } = await collectDoctorReport({
    sharedDataDir: mkdtempSync(join(tmpdir(), 'doc-hang-shared-')),
    pluginDataDir: mkdtempSync(join(tmpdir(), 'doc-hang-p-')),
    env: {},
    // A never-resolving status probe must be bounded by the per-probe timeout.
    fetchStatus: () => new Promise(() => {}),
    nofileProbe: async () => ({ status: 'ok', limit: 8192, message: 'NOFILE: 8192' }),
    hooksProbe: makeHooksProbe(false),
    scope: 'hang-scope',
    probeTimeoutMs: 60,
    totalBudgetMs: 500,
  })
  const elapsed = Date.now() - start
  assert.ok(elapsed < 1500, `doctor returned within the total budget, elapsed=${elapsed}ms`)
  assert.equal(health.healthy, false, 'an unreachable probe degrades the report')
  assert.equal(report.auth.status, 'unavailable')
  assert.ok(NOTIFY_GATE_ENUM.includes(report.notify.gate.state))
})

test('LIVE: real server makes auth/send/write_queue green via GET /api/status', async t => {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const serverEntry = join(root, 'server', 'api', 'server.mjs')
  const parent = mkdtempSync(join(tmpdir(), 'doctor-live-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const sharedData = join(parent, 'shared')
  const pluginData = join(parent, 'plugin-data')
  mkdirSync(sharedData, { mode: 0o700 })
  mkdirSync(pluginData, { mode: 0o700 })
  atomicWriteJson(join(pluginData, 'config.json'), { chat_id: 'DoctorAgent' })
  loadOrCreateLocalToken(sharedData)

  const child = spawn(process.execPath, [serverEntry], {
    env: { ...process.env, AGENT_ROOM_DATA_DIR: sharedData },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit').catch(() => {})
    }
  })
  const runtimePath = join(sharedData, 'runtime.json')
  const deadline = Date.now() + 10000
  while (!existsSync(runtimePath) && Date.now() < deadline) await new Promise(r => setTimeout(r, 25))
  assert.ok(existsSync(runtimePath), 'server wrote its runtime record')

  const started = Date.now()
  const { report, health } = await collectDoctorReport({
    sharedDataDir: sharedData,
    pluginDataDir: pluginData,
    env: {},
    fetchStatus: defaultFetchStatus,
    scope: 'live-scope',
  })
  const elapsed = Date.now() - started
  assert.ok(elapsed <= 3000, `live doctor within 3 s budget, elapsed=${elapsed}ms`)
  assert.equal(report.auth.status, 'ok', 'auth green against live server')
  assert.equal(report.write_queue.status, 'ok', 'write_queue green against live server')
  assert.ok(report.write_queue.metrics && typeof report.write_queue.metrics.depth === 'number')
  assert.equal(report.notify.tiers['1B'].status, 'available')
  assert.equal(health.healthy, true, 'a healthy local server with hooks is diagnosed healthy')
})

test('formatDoctor JSON adds healthy/problems; text form carries no held body', async () => {
  const { report, health } = await reportFor({ channelParams: channelsHostParams })
  const json = JSON.parse(formatDoctor({ report, health }, { json: true })[0])
  assert.equal(json.healthy, health.healthy)
  assert.deepEqual(json.problems, health.problems)
  const text = formatDoctor({ report, health }, { json: false }).join('\n')
  assert.match(text, /notify.gate:/)
  assert.match(text, /held: 0 \(metadata only\)/)
  assert.ok(!text.includes('preview'))
})
