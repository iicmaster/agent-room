// The ratified wake policy (2026-11-01) on the SQLite ledger (2026-11-02): a
// stranger's first held row wakes; repeats from the same untrusted sender cool
// down; the installation's held-row wakes obey an aggregate budget; the ledger
// is client-side only (PLUGIN_DATA/realms/<realm>/wake-ledger.sqlite, 0600).
// These rows pin the decision arithmetic, the failure posture, and the
// cross-connection serialisation the JSON file could not offer.

import assert from 'node:assert/strict'
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { HELD_WAKE_BUDGET, HELD_WAKE_COOLDOWN_MS, HELD_WAKE_BUDGET_WINDOW_MS } from '../server/constants.mjs'
import { decideHeldWake, loadWakePolicy, wakeStatePath } from '../server/client/wake-policy.mjs'
import { createWakeLedger } from '../server/notification/wake-ledger.mjs'

const FP = 'sha256:' + 'a'.repeat(64)
const FP2 = 'sha256:' + 'b'.repeat(64)
const FP3 = 'sha256:' + 'c'.repeat(64)
const REALM = '308fb41d-f0f8-4b22-b9b6-78bc0f3723ed'

function ledgerWorld(t) {
  const parent = mkdtempSync(join(tmpdir(), 'agent-room-wake-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const pluginData = join(parent, 'plugin-data')
  mkdirSync(pluginData, { mode: 0o700 })
  mkdirSync(join(pluginData, 'realms', REALM), { recursive: true, mode: 0o700 })
  return { pluginData, realmId: REALM, statePath: wakeStatePath(pluginData, REALM) }
}

const policy = { cooldownMs: 300_000, budget: 2, windowMs: 60_000 }

test('wake policy: first contact wakes and is recorded at 0600; the repeat within the cooldown is suppressed; a later wake fires again', t => {
  const world = ledgerWorld(t)
  const t0 = 1_700_000_000_000

  assert.equal(decideHeldWake({ ...world, fingerprint: FP, policy, now: t0 }), true, 'first contact wakes')
  assert.equal(statSync(world.statePath).mode & 0o777, 0o600, 'the ledger is 0600')

  assert.equal(decideHeldWake({ ...world, fingerprint: FP, policy, now: t0 + 1000 }), false, 'a repeat inside the cooldown is suppressed')
  assert.equal(decideHeldWake({ ...world, fingerprint: FP, policy, now: t0 + 299_999 }), false, 'the cooldown boundary is exclusive of its end')
  assert.equal(decideHeldWake({ ...world, fingerprint: FP, policy, now: t0 + 300_000 }), true, 'after the cooldown the sender may wake again')
})

test('wake policy: the aggregate budget gates OTHER senders too, and a fresh window reopens it', t => {
  const world = ledgerWorld(t)
  const t0 = 1_700_000_000_000

  assert.equal(decideHeldWake({ ...world, fingerprint: FP, policy, now: t0 }), true)
  assert.equal(decideHeldWake({ ...world, fingerprint: FP2, policy, now: t0 + 1 }), true)
  assert.equal(decideHeldWake({ ...world, fingerprint: FP3, policy, now: t0 + 2 }), false, 'the third held wake inside the window breaches the budget of 2')
  assert.equal(decideHeldWake({ ...world, fingerprint: FP3, policy, now: t0 + 60_001 }), true, 'a fresh window has its budget back')
})

test('wake policy: two connections cannot both spend the last unit of budget (the JSON race this replaced)', t => {
  const world = ledgerWorld(t)
  const t0 = 1_700_000_000_000
  const a = createWakeLedger({ pluginData: world.pluginData, realmId: REALM, policy })
  const b = createWakeLedger({ pluginData: world.pluginData, realmId: REALM, policy })
  t.after(() => { a.close(); b.close() })

  // Budget of one, two independent connections, same instant: the ledger hands
  // the unit to exactly one of them.
  const one = { ...policy, budget: 1 }
  const first = createWakeLedger({ pluginData: world.pluginData, realmId: REALM, policy: one })
  const second = createWakeLedger({ pluginData: world.pluginData, realmId: REALM, policy: one })
  t.after(() => { first.close(); second.close() })
  const grants = [first.decide(FP, t0), second.decide(FP2, t0)].filter(Boolean)
  assert.equal(grants.length, 1, 'exactly one connection may spend the last unit')

  assert.equal(a.decide(FP3, t0) || b.decide(FP3, t0), true)
})

test('wake policy: an unreadable ledger is refused, never repaired — the wake is suppressed and nothing is rewritten', t => {
  const world = ledgerWorld(t)
  writeFileSync(world.statePath, 'not a database at all\n', { mode: 0o600 })
  assert.equal(decideHeldWake({ ...world, fingerprint: FP, policy, now: 1 }), false, 'CORRUPT/NOTADB refuses the wake')
  assert.equal(readFileSync(world.statePath, 'utf8'), 'not a database at all\n', 'the refused ledger is left untouched')
})

test('wake policy: a world-readable ledger is refused rather than trusted', t => {
  const world = ledgerWorld(t)
  assert.equal(decideHeldWake({ ...world, fingerprint: FP, policy, now: 1 }), true)
  chmodSync(world.statePath, 0o644)
  const fresh = createWakeLedger({ pluginData: world.pluginData, realmId: REALM, policy })
  t.after(() => fresh.close())
  assert.equal(fresh.decide(FP2, 2), false, 'a world-readable ledger is refused')
})

test('wake policy: trusted senders are never gated — the policy is only ever called for held rows', () => {
  assert.equal(typeof HELD_WAKE_COOLDOWN_MS, 'number')
  assert.equal(HELD_WAKE_COOLDOWN_MS, 300_000)
  assert.equal(HELD_WAKE_BUDGET, 10)
  assert.equal(HELD_WAKE_BUDGET_WINDOW_MS, 60_000)
})

test('wake policy: loadWakePolicy defaults, env overrides, and junk values falling back', () => {
  assert.deepEqual(loadWakePolicy({}), { cooldownMs: 300_000, budget: 10, windowMs: 60_000 })
  assert.deepEqual(
    loadWakePolicy({ AGENT_ROOM_WAKE_COOLDOWN_MS: '5000', AGENT_ROOM_WAKE_BUDGET: '3', AGENT_ROOM_WAKE_BUDGET_WINDOW_MS: '1000' }),
    { cooldownMs: 5000, budget: 3, windowMs: 1000 },
  )
  assert.deepEqual(
    loadWakePolicy({ AGENT_ROOM_WAKE_COOLDOWN_MS: 'off', AGENT_ROOM_WAKE_BUDGET: '-1', AGENT_ROOM_WAKE_BUDGET_WINDOW_MS: '0' }),
    { cooldownMs: 300_000, budget: 10, windowMs: 60_000 },
    'a junk override falls back to the default — the gate never silently disables itself',
  )
})

test('wake policy: the v1 JSON ledger is imported once and then moved aside', t => {
  const world = ledgerWorld(t)
  const legacyPath = join(world.pluginData, 'realms', REALM, 'wake-state.json')
  writeFileSync(legacyPath, JSON.stringify({ version: 1, perSender: { [FP]: 1_700_000_000_000 }, heldWakes: [1_700_000_000_000] }), { mode: 0o600 })
  assert.equal(decideHeldWake({ ...world, fingerprint: FP, policy, now: 1_700_000_001_000 }), false, 'the imported cooldown applies')
  assert.equal(statSync(`${legacyPath}.imported`).isFile(), true, 'the legacy file is archived out of the authority path')
})
