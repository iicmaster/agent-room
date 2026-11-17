// Focused tests for the advisor-lane health canary: snapshot schema, the
// >=2-families gate, outbox-based classification via a stubbed dispatcher, the
// realistic bounded timeout constants, fast-fail refusal handling, and cwd
// resolution for inspectable runner logs.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CANARY_BOOT_SEC, CANARY_PROFILE_TIMEOUT_MS, CANARY_WAIT_SEC, classifyLane, collect,
  makeSnapshot, main, NPM_GLOBAL_CODEX, passes, resolveCanaryCwd, resolveDispatchPath,
  SEATS, selectCodexPath,
} from '../scripts/advisor-canary.mjs'

const LANES = Object.keys(SEATS)

test('snapshot has the required schema: date, four lanes, families_ok', () => {
  const snap = makeSnapshot({ codex: 'ok', claude: 'down', agy: 'down', oc: 'down' }, '2026-11-17T00:00:00.000Z')
  assert.deepEqual(Object.keys(snap).sort(), ['date', 'families_ok', 'lanes'])
  assert.equal(snap.date, '2026-11-17T00:00:00.000Z')
  assert.deepEqual(Object.keys(snap.lanes).sort(), ['agy', 'claude', 'codex', 'oc'])
  assert.equal(snap.families_ok, 1)
  for (const v of Object.values(snap.lanes)) assert.ok(['ok', 'down'].includes(v))
})

test('gate passes only at >=2 distinct families ok', () => {
  assert.equal(passes(makeSnapshot({ codex: 'ok', claude: 'ok', agy: 'down', oc: 'down' })), true)
  assert.equal(passes(makeSnapshot({ codex: 'ok', claude: 'down', agy: 'down', oc: 'down' })), false)
  assert.equal(passes(makeSnapshot({ codex: 'down', claude: 'down', agy: 'down', oc: 'down' })), false)
})

test('collect classifies every lane with a stubbed dispatcher, no real spawn', async () => {
  const seen = []
  const snap = await collect(async (name) => {
    seen.push(name)
    return name === 'agy' ? 'ok' : 'down'
  }, LANES, '2026-11-17T00:00:00.000Z')
  assert.deepEqual(seen, LANES)
  assert.equal(snap.lanes.agy, 'ok')
  assert.equal(snap.lanes.codex, 'down')
  assert.equal(snap.families_ok, 1)
})

test('main writes advisor-canary.json with the schema and returns the gate exit code', async () => {
  const outDir = mkdtempSync(join(tmpdir(), 'advisor-canary-test-'))
  const probe = async (name) => (name === 'codex' || name === 'claude' ? 'ok' : 'down')
  const code = await main({ outDir, date: '2026-11-17T00:00:00.000Z', probe })
  assert.equal(code, 0)
  const snap = JSON.parse(readFileSync(join(outDir, 'advisor-canary.json'), 'utf8'))
  assert.equal(snap.families_ok, 2)
  assert.deepEqual(Object.keys(snap.lanes).sort(), ['agy', 'claude', 'codex', 'oc'])
})

test('timeouts are realistic bounded budgets, not the old 3s/2s values', () => {
  assert.equal(CANARY_BOOT_SEC, 120)
  assert.equal(CANARY_WAIT_SEC, 180)
  assert.ok(CANARY_BOOT_SEC >= 120, 'boot must accommodate a slow AGY adapter')
  assert.ok(CANARY_WAIT_SEC >= 180, 'wait must accommodate a full prompt round')
})

test('oc profile producer timeout is raised to 30s (cold runs exceed 5s)', () => {
  assert.equal(CANARY_PROFILE_TIMEOUT_MS, 30_000)
})

test('codex selector prefers the npm-global binary and realpaths it', () => {
  const rp = (p) => `/real${p}`
  assert.equal(selectCodexPath(NPM_GLOBAL_CODEX, '/stale/.local/bin/codex', rp), `/real${NPM_GLOBAL_CODEX}`)
  assert.equal(selectCodexPath(null, '/stale/.local/bin/codex', rp), '/real/stale/.local/bin/codex')
})

test('classifyLane: outbox present is ok; a still-running wait is NOT down until budget elapses', () => {
  assert.equal(classifyLane(0, 0), 'ok')      // dispatch acked, outbox + terminal state
  assert.equal(classifyLane(1, 0), 'ok')      // still booting at dispatch cap, then outbox landed
  assert.equal(classifyLane(0, 1), 'down')    // full wait budget elapsed, still running
  assert.equal(classifyLane(0, 2), 'down')    // ended without an outbox
  assert.equal(classifyLane(0, null), 'down') // bounded spawn wait timed out
})

test('classifyLane: an explicit dispatch refusal is a fast-fail down', () => {
  // config-option-invalid / identity mismatch / no executable all surface as
  // dispatch exit 2. Even a hypothetical wait 0 must not rescue a refusal.
  assert.equal(classifyLane(2, null), 'down')
  assert.equal(classifyLane(2, 0), 'down')
})

test('resolveCanaryCwd defaults to the repo and honours CANARY_CWD', () => {
  assert.equal(resolveCanaryCwd({}), resolve(fileURLToPath(new URL('..', import.meta.url))))
  assert.equal(resolveCanaryCwd({ CANARY_CWD: '/tmp/canary-logs' }), '/tmp/canary-logs')
})

test('resolveDispatchPath reads the installed tmux-teams 0.51.0 path from config', () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'advisor-canary-cfg-'))
  const cfgPath = join(cfgDir, 'installed_plugins.json')
  writeFileSync(cfgPath, JSON.stringify({ plugins: [{ name: 'tmux-teams', version: '0.51.0', installPath: '/x/tmux-teams' }] }))
  assert.equal(resolveDispatchPath(cfgPath),
    '/x/tmux-teams/skills/tmux-teams/scripts/acp-dispatch.mjs')
})
