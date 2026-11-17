// Focused tests for the advisor-lane health canary: snapshot schema, the
// >=2-families gate, and outbox-based classification via a stubbed dispatcher.
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { collect, makeSnapshot, main, passes, resolveDispatchPath, SEATS } from '../scripts/advisor-canary.mjs'

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

test('resolveDispatchPath reads the installed tmux-teams 0.51.0 path from config', () => {
  const cfgDir = mkdtempSync(join(tmpdir(), 'advisor-canary-cfg-'))
  const cfgPath = join(cfgDir, 'installed_plugins.json')
  writeFileSync(cfgPath, JSON.stringify({ plugins: [{ name: 'tmux-teams', version: '0.51.0', installPath: '/x/tmux-teams' }] }))
  assert.equal(resolveDispatchPath(cfgPath),
    '/x/tmux-teams/skills/tmux-teams/scripts/acp-dispatch.mjs')
})
