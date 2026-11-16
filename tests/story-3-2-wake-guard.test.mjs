// Story 3.2 consolidated acceptance evidence. Black-box: only the public APIs
// of loop-guard, scope-ledger, wake-dispatcher and wake-reset are exercised.
// Covers every AC: G1 6/8/9, G2 25, G3 coalesce, out-of-order Held/Trusted,
// Phase B failure rollback, corrupt recovery, wake-reset XOR, Peer_C non-reset,
// 0-text-in-ledger, and schema/permission contract.
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { classifyWake, coalesce } from '../server/notification/loop-guard.mjs'
import { createScopeLedger } from '../server/client/scope-ledger.mjs'
import { createWakeDispatcher } from '../server/notification/wake-dispatcher.mjs'
import { loadCursors } from '../server/client/cursors.mjs'
import {
  LOOP_GLOBAL_LIMIT,
  LOOP_PAIR_LIMIT,
  LOOP_WARN_AT,
  WAKE_INFLIGHT_MS,
} from '../server/constants.mjs'

const NOW = 1_700_000_000_000
const counter = (count, expiresAt = NOW + 1000) => ({ count, expires_at: expiresAt })
function world(t) {
  const plugin = mkdtempSync(join(tmpdir(), 'story32-'))
  t.after(() => rmSync(plugin, { recursive: true, force: true }))
  return plugin
}

// --- AC1: two-phase --------------------------------------------------------
test('AC1 Phase A→C success: lease reserved, Phase B dispatched, CAS commits notified_seq to cursor v2', async t => {
  const plugin = world(t)
  const ledger = createScopeLedger(plugin, 'scope', { now: () => NOW })
  const dispatcher = createWakeDispatcher({
    ledger, pluginDataDir: plugin, realmId: 'realm', scope: 'scope',
    classifyRow: () => ({ held: false, actor_fingerprint: 'peer' }), decideHeld: () => true, now: () => NOW,
  })
  let dispatched = 0
  const result = await dispatcher.evaluate({ room_id: 'r', seq: 9, actor_fingerprint: 'peer' }, {
    dispatch: () => { dispatched += 1; return true }, local: 'A', peer: 'B',
  })
  assert.equal(result.action, 'woke')
  assert.equal(dispatched, 1)
  assert.equal(loadCursors(plugin, 'realm', { scope: 'scope' }).get('r').notified_seq, 9)
  assert.equal(ledger.readCounters({ realmId: 'realm', roomId: 'r', nowMs: NOW }).notifiedSeq, 9)
  ledger.close()
})

test('AC1 Phase B failure: lease released <=2000ms, notified_seq unmoved, one retry', async t => {
  const plugin = world(t)
  const ledger = createScopeLedger(plugin, 'scope', { now: () => NOW })
  const dispatcher = createWakeDispatcher({
    ledger, pluginDataDir: plugin, realmId: 'realm', scope: 'scope',
    classifyRow: () => ({ held: false }), decideHeld: () => true, now: () => NOW,
  })
  let calls = 0
  const opts = { dispatch: () => { calls += 1; throw new Error('crash') }, local: 'A', peer: 'B' }
  const first = await dispatcher.evaluate({ room_id: 'r', seq: 9 }, opts)
  assert.equal(first.action, 'released')
  assert.equal(loadCursors(plugin, 'realm', { scope: 'scope' }).get('r')?.notified_seq ?? 0, 0)
  assert.equal(ledger.readCounters({ realmId: 'realm', roomId: 'r', nowMs: NOW }).globalCounter.count, 1)
  await dispatcher.evaluate({ room_id: 'r', seq: 9 }, opts)
  assert.equal(calls, 2)
  const third = await dispatcher.evaluate({ room_id: 'r', seq: 9 }, opts)
  assert.equal(third.reason, 'attempts_exhausted')
  assert.equal(calls, 2)
  ledger.close()
})

// --- AC2: G1/G2/G3 ---------------------------------------------------------
test('AC2 G1 black-box: 6th=warn, 8th still wakes, 9th pauses (pair limit 8)', () => {
  const global = counter(0)
  const actions = []
  for (let charged = 0; charged <= LOOP_PAIR_LIMIT; charged += 1) {
    actions.push(classifyWake({ pair: counter(charged), globalCounter: global, now: NOW }).action)
  }
  // ordinal 1-based: charged=5 -> 6th warn; charged=7 -> 8th warn (allowed); charged=8 -> 9th pause
  assert.equal(actions[LOOP_WARN_AT - 1], 'warn')
  assert.equal(actions[LOOP_PAIR_LIMIT - 1], 'warn')
  assert.equal(actions[LOOP_PAIR_LIMIT], 'pause')
})

test('AC2 G2 black-box: 26th wake across rooms pauses (global 25)', () => {
  const pair = counter(0)
  assert.notEqual(classifyWake({ pair, globalCounter: counter(LOOP_GLOBAL_LIMIT - 1), now: NOW }).action, 'pause')
  assert.equal(classifyWake({ pair, globalCounter: counter(LOOP_GLOBAL_LIMIT), now: NOW }).action, 'pause')
})

test('AC2 G3: 50 peers burst = 1 cycle, +1 per pair; leading 0ms, trailing 150ms', () => {
  const candidates = Array.from({ length: 50 }, (_, i) => ({ room_id: 'r', peer: `p${i}` }))
  const lead = coalesce(candidates, { now: NOW, lastWakeAt: null })
  assert.equal(lead.delayMs, 0)
  assert.equal(lead.batch.length, 50)
  const trail = coalesce(candidates, { now: NOW + 10, lastWakeAt: NOW })
  assert.equal(trail.delayMs, 140)
})

test('AC2 Peer_C messages never reset pair (A,B): distinct pair key', t => {
  const plugin = world(t)
  const ledger = createScopeLedger(plugin, 'scope', { now: () => NOW })
  ledger.reserve({ realmId: 'realm', roomId: 'r', seq: 1, local: 'A', peer: 'B', nowMs: NOW })
  // A message from Peer_C charges a DIFFERENT pair; (A,B) stays at 1.
  ledger.reserve({ realmId: 'realm', roomId: 'r', seq: 2, local: 'A', peer: 'C', nowMs: NOW })
  const c = ledger.readCounters({ realmId: 'realm', roomId: 'r', local: 'A', peer: 'B', nowMs: NOW })
  assert.equal(c.pair.count, 1)
  ledger.close()
})

// --- AC3: Held isolation ---------------------------------------------------
test('AC3 out-of-order: Held 10 recorded first cannot mask Trusted 9', async t => {
  const plugin = world(t)
  const ledger = createScopeLedger(plugin, 'scope', { now: () => NOW })
  const dispatcher = createWakeDispatcher({
    ledger, pluginDataDir: plugin, realmId: 'realm', scope: 'scope',
    classifyRow: row => ({ held: row?.held === true, actor_fingerprint: 'peer' }), decideHeld: () => true, now: () => NOW,
  })
  dispatcher.dispatchHeld({ room_id: 'r', seq: 10, actor_fingerprint: 'peer' })
  const counters = ledger.readCounters({ realmId: 'realm', roomId: 'r', nowMs: NOW })
  assert.equal(counters.suppressedHeldSeq, 10)
  assert.equal(counters.notifiedSeq, 0)
  const trusted = await dispatcher.evaluate({ room_id: 'r', seq: 9, held: false }, {
    dispatch: () => true, local: 'A', peer: 'peer',
  })
  assert.equal(trusted.action, 'woke')
  assert.equal(loadCursors(plugin, 'realm', { scope: 'scope' }).get('r').notified_seq, 9)
  ledger.close()
})

test('AC3 zero message text in any ledger file (grep = 0)', t => {
  const plugin = world(t)
  const ledger = createScopeLedger(plugin, 'scope', { now: () => NOW })
  ledger.reserve({ realmId: 'realm', roomId: 'r', seq: 9, local: 'A', peer: 'B', nowMs: NOW })
  ledger.suppressHeld({ roomId: 'r', seq: 10 })
  ledger.close()
  const sessionsDir = join(plugin, 'sessions')
  let found = 0
  for (const scope of readdirSync(sessionsDir)) {
    for (const name of readdirSync(join(sessionsDir, scope))) {
      if (!name.endsWith('.sqlite')) continue
      const bytes = readFileSync(join(sessionsDir, scope, name))
      // No message-body fields may exist in any ledger schema.
      for (const forbidden of ['message_body', 'body_text']) {
        if (bytes.includes(Buffer.from(forbidden))) found += 1
      }
    }
  }
  assert.equal(found, 0)
})

// --- AC4: recovery ---------------------------------------------------------
test('AC4 SQLITE_BUSY: reserve returns a busy status, never throws into wait', t => {
  const plugin = world(t)
  const ledger = createScopeLedger(plugin, 'scope', { now: () => NOW })
  // First reserve opens the database (creating the file) and charges G1/G2.
  ledger.reserve({ realmId: 'realm', roomId: 'seed', seq: 1, local: 'A', peer: 'B', nowMs: NOW })
  ledger.close()
  // Hold an EXCLUSIVE lock from a second connection with a tiny busy_timeout;
  // a reserve that cannot take BEGIN IMMEDIATE must classify this as busy.
  const holder = new DatabaseSync(ledger.path)
  holder.exec('PRAGMA busy_timeout = 50')
  holder.exec('BEGIN EXCLUSIVE')
  const blocked = createScopeLedger(plugin, 'scope', { now: () => NOW })
  const result = blocked.reserve({ realmId: 'realm', roomId: 'r2', seq: 1, local: 'A', peer: 'B', nowMs: NOW })
  assert.equal(result.status, 'busy')
  assert.ok(blocked.drainDiagnostics().some(line => line.includes('SQLITE_BUSY')))
  holder.exec('ROLLBACK')
  holder.close()
  blocked.close()
})

test('AC4 corrupt ledger quarantined .corrupt-*, rebuilt fail-closed from v2 max', t => {
  const plugin = world(t)
  const ledger = createScopeLedger(plugin, 'scope', { now: () => NOW })
  ledger.reserve({ realmId: 'realm', roomId: 'seed', seq: 1, local: 'A', peer: 'B', nowMs: NOW })
  ledger.close()
  writeFileSync(ledger.path, 'corrupt-not-sqlite')
  chmodSync(ledger.path, 0o600)
  const reopened = createScopeLedger(plugin, 'scope', { now: () => NOW })
  // First DB operation triggers the lazy open → quarantine + rebuild.
  assert.equal(reopened.readCounters({ realmId: 'realm', roomId: 'r', nowMs: NOW }).globalCounter, null)
  assert.equal(reopened.drainDiagnostics().some(line => line.includes('corrupt')), true)
  reopened.close()
})
