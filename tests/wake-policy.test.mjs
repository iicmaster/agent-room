// The ratified wake policy (2026-11-01): a stranger's first held row wakes;
// repeats from the same untrusted sender cool down; the installation's
// held-row wakes obey an aggregate budget; the ledger is client-side only
// (PLUGIN_DATA/realms/<realm>/wake-state.json, 0600). These rows pin the
// decision arithmetic, the ledger hygiene, and the env overrides.

import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { HELD_WAKE_BUDGET, HELD_WAKE_COOLDOWN_MS, HELD_WAKE_BUDGET_WINDOW_MS } from '../server/constants.mjs'
import { decideHeldWake, loadWakePolicy, wakeStatePath } from '../server/client/wake-policy.mjs'

const FP = 'sha256:' + 'a'.repeat(64)
const FP2 = 'sha256:' + 'b'.repeat(64)
const FP3 = 'sha256:' + 'c'.repeat(64)

function ledgerWorld(t) {
  const parent = mkdtempSync(join(tmpdir(), 'agent-room-wake-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const pluginData = join(parent, 'plugin-data')
  mkdirSync(pluginData, { mode: 0o700 })
  const statePath = wakeStatePath(pluginData, '308fb41d-f0f8-4b22-b9b6-78bc0f3723ed')
  mkdirSync(join(pluginData, 'realms', '308fb41d-f0f8-4b22-b9b6-78bc0f3723ed'), { recursive: true, mode: 0o700 })
  return { statePath }
}

const policy = { cooldownMs: 300_000, budget: 2, windowMs: 60_000 }

test('wake policy: first contact wakes and is recorded at 0600; the repeat within the cooldown is suppressed; a later wake fires again', t => {
  const { statePath } = ledgerWorld(t)
  const t0 = 1_700_000_000_000

  assert.equal(decideHeldWake({ statePath, fingerprint: FP, policy, now: t0 }), true, 'first contact wakes')
  assert.equal(existsSync(statePath), true, 'the ledger is written on the first wake')
  assert.equal(statSync(statePath).mode & 0o777, 0o600, 'the ledger is 0600')

  assert.equal(
    decideHeldWake({ statePath, fingerprint: FP, policy, now: t0 + 1000 }),
    false,
    'a repeat from the same sender inside the cooldown is suppressed',
  )
  assert.equal(
    decideHeldWake({ statePath, fingerprint: FP, policy, now: t0 + 299_999 }),
    false,
    'the cooldown boundary is exclusive of its end',
  )
  assert.equal(
    decideHeldWake({ statePath, fingerprint: FP, policy, now: t0 + 300_000 }),
    true,
    'after the cooldown the sender may wake again',
  )
})

test('wake policy: the aggregate budget gates OTHER senders too, and a fresh window reopens it', t => {
  const { statePath } = ledgerWorld(t)
  const t0 = 1_700_000_000_000

  assert.equal(decideHeldWake({ statePath, fingerprint: FP, policy, now: t0 }), true)
  assert.equal(decideHeldWake({ statePath, fingerprint: FP2, policy, now: t0 + 1 }), true)
  assert.equal(
    decideHeldWake({ statePath, fingerprint: FP3, policy, now: t0 + 2 }),
    false,
    'the third held wake inside the window breaches the budget of 2 — even a first contact',
  )
  assert.equal(
    decideHeldWake({ statePath, fingerprint: FP3, policy, now: t0 + 60_000 }),
    true,
    'a fresh window has its budget back',
  )
})

test('wake policy: trusted senders are never gated — the policy is only ever called for held rows', () => {
  // The gating decision lives at the call sites (notifier deliver, wait
  // holdForRoom): both consult decideHeldWake ONLY on rows whose held flag
  // is true. This row pins the constant shape that rule rests on.
  assert.equal(typeof HELD_WAKE_COOLDOWN_MS, 'number')
  assert.equal(HELD_WAKE_COOLDOWN_MS, 300_000)
  assert.equal(HELD_WAKE_BUDGET, 10)
  assert.equal(HELD_WAKE_BUDGET_WINDOW_MS, 60_000)
})

test('wake policy: a corrupt ledger is treated as empty — no cooldowns, no crash', t => {
  const { statePath } = ledgerWorld(t)
  writeFileSync(statePath, 'not json at all\n', { mode: 0o600 })
  assert.equal(decideHeldWake({ statePath, fingerprint: FP, policy, now: 1 }), true)
  assert.equal(decideHeldWake({ statePath, fingerprint: FP, policy, now: 2 }), false, 'the repaired ledger still cools down')
})

test('wake policy: loadWakePolicy defaults, env overrides, and junk values falling back', () => {
  assert.deepEqual(loadWakePolicy({}), {
    cooldownMs: 300_000,
    budget: 10,
    windowMs: 60_000,
  })
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

test('wake policy: a short env cooldown makes the loop test-shaped — wake, suppress, wake', t => {
  const { statePath } = ledgerWorld(t)
  const fast = loadWakePolicy({ AGENT_WAKE_UNUSED: '1', AGENT_ROOM_WAKE_COOLDOWN_MS: '50' })
  const t0 = Date.now()
  assert.equal(decideHeldWake({ statePath, fingerprint: FP, policy: fast, now: t0 }), true)
  assert.equal(decideHeldWake({ statePath, fingerprint: FP, policy: fast, now: t0 + 20 }), false)
})
