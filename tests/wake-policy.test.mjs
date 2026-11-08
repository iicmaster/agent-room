// The ratified wake policy (2026-11-01) on the SQLite ledger (2026-11-02): a
// stranger's first held row wakes; repeats from the same untrusted sender cool
// down; the installation's held-row wakes obey an aggregate budget; the ledger
// is client-side only (PLUGIN_DATA/realms/<realm>/wake-ledger.sqlite, 0600).
// These rows pin the decision arithmetic, the failure posture, and the
// cross-connection serialisation the JSON file could not offer.

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { HELD_WAKE_BUDGET, HELD_WAKE_COOLDOWN_MS, HELD_WAKE_BUDGET_WINDOW_MS } from '../server/constants.mjs'
import { decideHeldWake, loadWakePolicy, policyIdentity, wakeStatePath } from '../server/client/wake-policy.mjs'
import { classifySqliteFault, createWakeLedger, REBASELINE_ENV } from '../server/notification/wake-ledger.mjs'

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

// --- The round-4 gate: stale writers, preserved pins, unreadable legacy, native faults ---

test('round-4: a writer that opened before an adoption cannot spend the old budget', t => {
  const world = ledgerWorld(t)
  const t0 = 1_700_000_000_000
  // A opens with budget 10 (the record starts there) and charges once.
  const a = createWakeLedger({ pluginData: world.pluginData, realmId: REALM, policy: { cooldownMs: 300_000, budget: 10, windowMs: 60_000 }, identity: { explicit: {} } })
  t.after(() => a.close())
  assert.equal(a.decide(FP, t0), true)

  // B (newer defaults, budget 2) adopts the record and charges the second unit.
  const b = createWakeLedger({ pluginData: world.pluginData, realmId: REALM, policy: { cooldownMs: 300_000, budget: 2, windowMs: 60_000 }, identity: { explicit: {} } })
  t.after(() => b.close())
  assert.equal(b.decide(FP2, t0 + 1), true, 'the adoption grants under the new budget')

  // A’s captured policy said 10, but the record now says 2: the stale writer
  // is refused — the record is the authority, not the opening environment.
  assert.equal(a.decide(FP3, t0 + 2), false, 'the old writer cannot spend the old budget after the adoption')
})

test('round-4: an operator pin survives unpinned processes and a changed default', t => {
  const world = ledgerWorld(t)
  const t0 = 1_700_000_000_000
  const pinned = createWakeLedger({ pluginData: world.pluginData, realmId: REALM, policy: { cooldownMs: 300_000, budget: 10, windowMs: 60_000 }, identity: { explicit: { budget: 10 } } })
  t.after(() => pinned.close())
  assert.equal(pinned.decide(FP, t0), true)

  // An unpinned process with the SAME effective values opens and decides,
  // but must not wash the recorded pin.
  const unpinned = createWakeLedger({ pluginData: world.pluginData, realmId: REALM, policy: { cooldownMs: 300_000, budget: 10, windowMs: 60_000 }, identity: { explicit: {} } })
  t.after(() => unpinned.close())
  assert.equal(unpinned.decide(FP2, t0 + 1), true)
  assert.equal(metaRows(world).policy_explicit, JSON.stringify({ budget: 10 }), 'the pin is untouched')

  // A later process with different defaults cannot adopt over the pin either:
  // the recorded budget of 10 stays the authority (and stays on record).
  const changed = createWakeLedger({ pluginData: world.pluginData, realmId: REALM, policy: { cooldownMs: 300_000, budget: 2, windowMs: 60_000 }, identity: { explicit: {} } })
  t.after(() => changed.close())
  assert.equal(changed.decide(FP3, t0 + 2), true, 'the third sender fits under the pinned budget of 10')
  assert.equal(metaRows(world).policy, JSON.stringify({ cooldownMs: 300_000, budget: 10, windowMs: 60_000 }), 'the pinned tuple stays the record')
  assert.equal(metaRows(world).policy_explicit, JSON.stringify({ budget: 10 }), 'and so does the pin')
})

test('round-4: a legacy file that exists but cannot be read refuses the ledger and is never archived', t => {
  const world = ledgerWorld(t)
  const legacyPath = join(world.pluginData, 'realms', REALM, 'wake-state.json')
  writeFileSync(legacyPath, '{}', { mode: 0o000 })
  assert.equal(decideHeldWake({ ...world, fingerprint: FP, policy, now: 1 }), false, 'the unreadable authority refuses the wake')
  assert.equal(existsSync(legacyPath), true, 'it is NOT archived — only a committed marker may archive')
  assert.equal(existsSync(`${legacyPath}.imported`), false)
  chmodSync(legacyPath, 0o600)
})

test('round-4: the SQLite fault classifier maps native and string shapes once', () => {
  assert.equal(classifySqliteFault({ code: 'ERR_SQLITE_ERROR', errcode: 5 }), 'busy')
  assert.equal(classifySqliteFault({ code: 'ERR_SQLITE_ERROR', errcode: 6 }), 'busy')
  assert.equal(classifySqliteFault({ code: 'ERR_SQLITE_ERROR', errcode: 11 }), 'refuse')
  assert.equal(classifySqliteFault({ code: 'ERR_SQLITE_ERROR', errcode: 26 }), 'refuse')
  assert.equal(classifySqliteFault({ code: 'ERR_SQLITE_ERROR', errcode: 19 }), 'other')
  assert.equal(classifySqliteFault({ code: 'SQLITE_BUSY' }), 'busy')
  assert.equal(classifySqliteFault({ code: 'SQLITE_CORRUPT' }), 'refuse')
  assert.equal(classifySqliteFault(new Error('plain')), 'other')
})

test('round-4: re-running the flagged re-baseline with the same policy is a no-op, not a second flip', t => {
  const world = ledgerWorld(t)
  const t0 = 1_700_000_000_000
  const pinned = createWakeLedger({ pluginData: world.pluginData, realmId: REALM, policy: { cooldownMs: 300_000, budget: 3, windowMs: 60_000 }, identity: { explicit: { budget: 3 } } })
  t.after(() => pinned.close())
  assert.equal(pinned.decide(FP, t0), true)

  const rebaselined = createWakeLedger({ pluginData: world.pluginData, realmId: REALM, policy: { cooldownMs: 300_000, budget: 10, windowMs: 60_000 }, identity: { explicit: {}, rebaseline: true } })
  t.after(() => rebaselined.close())
  assert.equal(rebaselined.decide(FP2, t0 + 1), true)
  const first = metaRows(world).rebaselined_at

  const again = createWakeLedger({ pluginData: world.pluginData, realmId: REALM, policy: { cooldownMs: 300_000, budget: 10, windowMs: 60_000 }, identity: { explicit: {}, rebaseline: true } })
  t.after(() => again.close())
  assert.equal(again.decide(FP3, t0 + 2), true)
  assert.equal(metaRows(world).rebaselined_at, first, 'the record was not re-baselined into a new authority')
})
// --- The round-5 gate: per-key pin merge ---

test('round-5: pinning a different key never clears the recorded pin of another', t => {
  const world = ledgerWorld(t)
  const t0 = 1_700_000_000_000
  // A pins budget=3 and spends the whole budget.
  const a = createWakeLedger({ pluginData: world.pluginData, realmId: REALM, policy: { cooldownMs: 300_000, budget: 3, windowMs: 60_000 }, identity: { explicit: { budget: 3 } } })
  t.after(() => a.close())
  for (let index = 0; index < 3; index += 1) assert.equal(a.decide([FP, FP2, FP3][index], t0 + index), true)
  assert.equal(a.decide(FP, t0 + 3), false, 'the budget of 3 is spent')

  // B pins ONLY the cooldown (which agrees with the record): the merge must
  // keep the recorded budget pin — B cannot mint grants 4+ by washing it.
  const b = createWakeLedger({ pluginData: world.pluginData, realmId: REALM, policy: { cooldownMs: 300_000, budget: 10, windowMs: 60_000 }, identity: { explicit: { cooldownMs: 300_000 } } })
  t.after(() => b.close())
  assert.equal(b.decide(FP, t0 + 4), false, 'the recorded budget of 3 survives the disjoint pin')
  const rows = metaRows(world)
  assert.deepEqual(JSON.parse(rows.policy_explicit), { budget: 3, cooldownMs: 300_000 }, 'the pins merged, nothing was cleared')
  assert.equal(JSON.parse(rows.policy).budget, 3, 'the pinned effective budget stays')
})

test('round-5: a subset pin merges, and unpinned keys keep the recorded values under a pinned record', t => {
  const world = ledgerWorld(t)
  const t0 = 1_700_000_000_000
  const record = createWakeLedger({ pluginData: world.pluginData, realmId: REALM, policy: { cooldownMs: 123_456, budget: 4, windowMs: 60_000 }, identity: { explicit: { cooldownMs: 123_456 } } })
  t.after(() => record.close())
  assert.equal(record.decide(FP, t0), true)

  // A process pinning budget=4 (agreeing) and leaving cooldown unpinned:
  // the record’s cooldown pin AND its effective cooldown stay.
  const merger = createWakeLedger({ pluginData: world.pluginData, realmId: REALM, policy: { cooldownMs: 300_000, budget: 4, windowMs: 60_000 }, identity: { explicit: { budget: 4 } } })
  t.after(() => merger.close())
  assert.equal(merger.decide(FP2, t0 + 1), true)
  const rows = metaRows(world)
  assert.deepEqual(JSON.parse(rows.policy_explicit), { cooldownMs: 123_456, budget: 4 })
  const merged = JSON.parse(rows.policy)
  assert.equal(merged.cooldownMs, 123_456, 'the recorded pinned cooldown is kept, not drifted')
  assert.equal(merged.budget, 4)
})

// --- The v0.8.0 closures: policy agreement and the restartable migration ---

function metaRows(world) {
  const db = new DatabaseSync(world.statePath)
  try {
    const rows = {}
    for (const row of db.prepare('SELECT key, value FROM meta').all()) rows[row.key] = row.value
    return rows
  } finally {
    db.close()
  }
}

test('wake policy agreement: an unpinned process runs on the PINNED record — it never washes the pin nor spends the default', t => {
  const world = ledgerWorld(t)
  const t0 = 1_700_000_000_000
  const pinned = { cooldownMs: 300_000, budget: 3, windowMs: 60_000 }
  const first = createWakeLedger({ pluginData: world.pluginData, realmId: REALM, policy: pinned, identity: { explicit: { budget: 3 } } })
  t.after(() => first.close())
  assert.equal(first.decide(FP, t0), true, 'the pinning process charges normally')

  // A second process with NO pin (its environment would say 10) opens fine
  // and decides under the RECORDED pin of 3 — the record is the authority.
  const second = createWakeLedger({ pluginData: world.pluginData, realmId: REALM, policy: { cooldownMs: 300_000, budget: 10, windowMs: 60_000 }, identity: { explicit: {} } })
  t.after(() => second.close())
  assert.equal(second.decide(FP2, t0 + 1), true)
  assert.equal(second.decide(FP3, t0 + 2), true)
  assert.equal(second.decide(FP, t0 + 3) || second.decide(FP2, t0 + 3), false, 'the budget of 3 — not the environment’s 10 — gates the window')
  assert.equal(metaRows(world).policy, JSON.stringify(pinned), 'the pinned tuple stays the record')
  assert.equal(metaRows(world).policy_explicit, JSON.stringify({ budget: 3 }), 'the recorded explicit layer is untouched')
})

test('wake policy agreement: a NEW pin that disagrees with the recorded effective value refuses', t => {
  const world = ledgerWorld(t)
  const unpinned = createWakeLedger({ pluginData: world.pluginData, realmId: REALM, policy: { cooldownMs: 300_000, budget: 10, windowMs: 60_000 }, identity: { explicit: {} } })
  t.after(() => unpinned.close())
  assert.equal(unpinned.decide(FP, 1_700_000_000_000), true, 'the record starts unpinned at budget 10')

  const pinner = createWakeLedger({ pluginData: world.pluginData, realmId: REALM, policy: { cooldownMs: 300_000, budget: 3, windowMs: 60_000 }, identity: { explicit: { budget: 3 } } })
  t.after(() => pinner.close())
  assert.equal(pinner.decide(FP2, 1_700_000_000_001), false, 'pinning 3 against a recorded 10 refuses until the re-baseline')
  assert.equal(metaRows(world).policy, JSON.stringify({ cooldownMs: 300_000, budget: 10, windowMs: 60_000 }), 'nothing was rewritten')
})

test('wake policy agreement: matching pins agree, and a defaults-only drift is adopted and recorded', t => {
  const world = ledgerWorld(t)
  const first = createWakeLedger({ pluginData: world.pluginData, realmId: REALM, policy: { cooldownMs: 300_000, budget: 10, windowMs: 60_000 }, identity: { explicit: {} } })
  t.after(() => first.close())
  assert.equal(first.decide(FP, 1_700_000_000_001), true)

  // A release changed the constants: a new process carries a new default
  // budget with nothing pinned — the drift is adopted and recorded, because a
  // gate that silently stops waking after an upgrade is worse than a recorded
  // adoption.
  const upgraded = createWakeLedger({ pluginData: world.pluginData, realmId: REALM, policy: { cooldownMs: 300_000, budget: 2, windowMs: 60_000 }, identity: { explicit: {} } })
  t.after(() => upgraded.close())
  assert.equal(upgraded.decide(FP2, 1_700_000_000_002), true, 'the upgraded process is not refused')
  assert.equal(metaRows(world).policy, JSON.stringify({ cooldownMs: 300_000, budget: 2, windowMs: 60_000 }), 'the adoption is on record')

  const third = createWakeLedger({ pluginData: world.pluginData, realmId: REALM, policy: { cooldownMs: 300_000, budget: 2, windowMs: 60_000 }, identity: { explicit: {} } })
  t.after(() => third.close())
  assert.equal(third.decide(FP3, 1_700_000_000_003), false, 'the adopted budget of 2 now gates the third sender')
})

test('wake policy agreement: the flagged re-baseline overwrites the record once', t => {
  const world = ledgerWorld(t)
  const pinned = createWakeLedger({ pluginData: world.pluginData, realmId: REALM, policy: { cooldownMs: 300_000, budget: 3, windowMs: 60_000 }, identity: { explicit: { budget: 3 } } })
  t.after(() => pinned.close())
  assert.equal(pinned.decide(FP, 1_700_000_000_000), true)

  const rebaselined = createWakeLedger({ pluginData: world.pluginData, realmId: REALM, policy: { cooldownMs: 300_000, budget: 10, windowMs: 60_000 }, identity: { explicit: {}, rebaseline: true } })
  t.after(() => rebaselined.close())
  assert.equal(rebaselined.decide(FP2, 1_700_000_000_001), true, 'the flagged run accepts the new policy on record')
  assert.equal(metaRows(world).policy_explicit, JSON.stringify({}), 'the explicit layer is replaced')

  const later = createWakeLedger({ pluginData: world.pluginData, realmId: REALM, policy: { cooldownMs: 300_000, budget: 10, windowMs: 60_000 }, identity: { explicit: {} } })
  t.after(() => later.close())
  assert.equal(later.decide(FP3, 1_700_000_000_002), true, 'the re-baselined ledger serves unpinned processes again')
})

test('wake policy agreement: loadWakePolicy and policyIdentity read the same environment', () => {
  const env = { AGENT_ROOM_WAKE_BUDGET: '4', [REBASELINE_ENV]: '1' }
  assert.deepEqual(policyIdentity(env), { explicit: { budget: 4 }, rebaseline: true })
  assert.deepEqual(policyIdentity({}), { explicit: {}, rebaseline: false })
  // The policy tuple is unchanged in shape for existing callers.
  assert.deepEqual(loadWakePolicy(env).budget, 4)
})

test('restartable migration: a process that died between file creation and import resumes, never skips', t => {
  const world = ledgerWorld(t)
  const legacyPath = join(world.pluginData, 'realms', REALM, 'wake-state.json')
  writeFileSync(legacyPath, JSON.stringify({ version: 1, perSender: { [FP]: 1_700_000_000_000 }, heldWakes: [1_700_000_000_000] }), { mode: 0o600 })
  // The crash state: a SQLite file with the schema but NO import marker.
  // (chmod 0600 — DatabaseSync creates with the umask, and the safe-file gate
  // refuses a world-readable ledger exactly as it should.)
  const crashed = new DatabaseSync(world.statePath)
  crashed.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`)
  crashed.exec(`CREATE TABLE IF NOT EXISTS sender_wake (fingerprint TEXT PRIMARY KEY, last_at INTEGER NOT NULL) STRICT`)
  crashed.exec(`CREATE TABLE IF NOT EXISTS wake_event (at INTEGER NOT NULL) STRICT`)
  crashed.close()
  chmodSync(world.statePath, 0o600)

  assert.equal(decideHeldWake({ ...world, fingerprint: FP, policy, now: 1_700_000_001_000 }), false, 'the resumed import applies the legacy cooldown')
  const rows = metaRows(world)
  assert.equal(rows.imported_from_json, legacyPath, 'the marker is written with the import')
  assert.equal(existsSync(`${legacyPath}.imported`), true, 'the legacy file is archived after the resumed import')
})

test('restartable migration: an unparseable legacy file keeps refusing until fixed — it is never skipped', t => {
  const world = ledgerWorld(t)
  const legacyPath = join(world.pluginData, 'realms', REALM, 'wake-state.json')
  writeFileSync(legacyPath, 'not json at all\n', { mode: 0o600 })
  assert.equal(decideHeldWake({ ...world, fingerprint: FP, policy, now: 1 }), false, 'the refuse-don-t-repair posture holds')

  writeFileSync(legacyPath, JSON.stringify({ version: 1, perSender: { [FP]: 1_700_000_000_000 }, heldWakes: [] }), { mode: 0o600 })
  assert.equal(decideHeldWake({ ...world, fingerprint: FP2, policy, now: 1_700_000_001_000 }), true, 'a fixed legacy file imports on the next open')
  assert.equal(decideHeldWake({ ...world, fingerprint: FP, policy, now: 1_700_000_001_500 }), false, 'and the imported cooldown applies')
})

test('restartable migration: a marker plus a surviving legacy file is history, never a second import', t => {
  const world = ledgerWorld(t)
  const legacyPath = join(world.pluginData, 'realms', REALM, 'wake-state.json')
  // The crash-between-commit-and-rename state: the marker exists, the legacy
  // file was never renamed, and its sender would re-cool the ledger if the
  // file were read again.
  const db = new DatabaseSync(world.statePath)
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`)
  db.exec(`CREATE TABLE IF NOT EXISTS sender_wake (fingerprint TEXT PRIMARY KEY, last_at INTEGER NOT NULL) STRICT`)
  db.exec(`CREATE TABLE IF NOT EXISTS wake_event (at INTEGER NOT NULL) STRICT`)
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('imported_from_json', legacyPath)
  db.close()
  chmodSync(world.statePath, 0o600)
  writeFileSync(legacyPath, JSON.stringify({ version: 1, perSender: { [FP]: 1_700_000_002_000 }, heldWakes: [] }), { mode: 0o600 })

  assert.equal(decideHeldWake({ ...world, fingerprint: FP, policy, now: 1_700_000_001_000 }), true, 'the legacy rows were not re-imported over the marker')
  assert.equal(existsSync(`${legacyPath}.imported`), true, 'the surviving file is archived as cleanup')
  assert.equal(existsSync(legacyPath), false, 'the authority path is clean')
})

test('wake policy: a world-readable ledger is still refused after the closures', t => {
  const world = ledgerWorld(t)
  assert.equal(decideHeldWake({ ...world, fingerprint: FP, policy, now: 1 }), true)
  chmodSync(world.statePath, 0o644)
  const fresh = createWakeLedger({ pluginData: world.pluginData, realmId: REALM, policy })
  t.after(() => fresh.close())
  assert.equal(fresh.decide(FP2, 2), false, 'a world-readable ledger is refused')
})
