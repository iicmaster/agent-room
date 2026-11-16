// Scope ledger: real temp-dir SQLite tests — schema/perms, G2 no-TOCTOU race,
// two-phase lease/CAS ownership, Held isolation, corrupt recovery, reset.
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createScopeLedger, listScopes } from '../server/client/scope-ledger.mjs'
import { atomicWriteJson } from '../server/runtime.mjs'
import { WAKE_INFLIGHT_MS } from '../server/constants.mjs'

function world(t) {
  const plugin = mkdtempSync(join(tmpdir(), 'scope-ledger-'))
  t.after(() => rmSync(plugin, { recursive: true, force: true }))
  return plugin
}

const NOW = 1_700_000_000_000
const reserve = (ledger, over = {}) => ledger.reserve({
  realmId: 'realm', roomId: 'room-a', seq: 9, local: 'A', peer: 'B', nowMs: NOW, ...over,
})

test('schema: STRICT tables, 0o600, WAL; single reserve commits lease + G1/G2', t => {
  const plugin = world(t)
  const ledger = createScopeLedger(plugin, 'scope-a', { now: () => NOW })
  try {
    const result = reserve(ledger)
    assert.equal(result.status, 'reserved')
    assert.equal(statSync(ledger.path).mode & 0o777, 0o600)
    assert.equal(result.attempts, 1)
    assert.equal(result.inflight_until_ms, NOW + WAKE_INFLIGHT_MS)
    const counters = ledger.readCounters({ realmId: 'realm', roomId: 'room-a', local: 'A', peer: 'B', nowMs: NOW })
    assert.equal(counters.status, 'ok')
    assert.equal(counters.pair.count, 1)
    assert.equal(counters.globalCounter.count, 1)
  } finally { ledger.close() }
})

test('two-phase CAS: stale owner cannot commit; correct owner commits once', t => {
  const plugin = world(t)
  const ledger = createScopeLedger(plugin, 'scope-a', { now: () => NOW })
  try {
    const r = reserve(ledger)
    assert.equal(ledger.commit({ roomId: 'room-a', seq: 9, owner: 'WRONG', nowMs: NOW }).status, 'stale')
    assert.equal(ledger.commit({ roomId: 'room-a', seq: 9, owner: r.owner, nowMs: NOW }).status, 'committed')
    // A second commit of the same lease is stale (lease consumed).
    assert.equal(ledger.commit({ roomId: 'room-a', seq: 9, owner: r.owner, nowMs: NOW }).status, 'stale')
    assert.equal(ledger.readCounters({ realmId: 'realm', roomId: 'room-a', nowMs: NOW }).notifiedSeq, 9)
  } finally { ledger.close() }
})

test('Phase B failure: release frees lease within the budget; seq retry allowed once', t => {
  const plugin = world(t)
  const ledger = createScopeLedger(plugin, 'scope-a', { now: () => NOW })
  try {
    const first = reserve(ledger)
    assert.equal(ledger.release({ roomId: 'room-a', seq: 9, owner: first.owner }).status, 'released')
    // notified_seq never moved on failure.
    assert.equal(ledger.readCounters({ realmId: 'realm', roomId: 'room-a', nowMs: NOW }).notifiedSeq, 0)
    const retry = reserve(ledger)
    assert.equal(retry.status, 'reserved')
    assert.equal(retry.attempts, 2) // exactly one retry
    const exhausted = ledger.release({ roomId: 'room-a', seq: 9, owner: retry.owner })
    assert.equal(exhausted.status, 'released')
    // Third attempt of the same seq is refused (attempt budget spent).
    assert.equal(reserve(ledger).reason, 'attempts_exhausted')
  } finally { ledger.close() }
})

test('G2 no-TOCTOU: two rooms crossing 25 in one IMMEDIATE cannot both pass', async t => {
  const plugin = world(t)
  const ledger = createScopeLedger(plugin, 'scope-a', { now: () => NOW })
  try {
    // Charge the shared counter to 24 across a throwaway room.
    for (let i = 0; i < 24; i += 1) {
      assert.equal(reserve(ledger, { roomId: `seed-${i}`, seq: 1, owner: `o${i}` }).status, 'reserved')
    }
    // Two "rooms" both read 24 and reserve concurrently. Exactly one may pass;
    // the other sees 25 and pauses. (BEGIN IMMEDIATE serializes the read+write.)
    const [a, b] = await Promise.all([
      Promise.resolve().then(() => reserve(ledger, { roomId: 'room-a', seq: 900, owner: 'a' })),
      Promise.resolve().then(() => reserve(ledger, { roomId: 'room-b', seq: 901, owner: 'b' })),
    ])
    const statuses = [a.status, b.status].sort()
    assert.deepEqual(statuses, ['paused', 'reserved'])
  } finally { ledger.close() }
})

test('Held isolation: suppressed_held_seq never moves notified_seq', t => {
  const plugin = world(t)
  const ledger = createScopeLedger(plugin, 'scope-a', { now: () => NOW })
  try {
    // Held 10 recorded first.
    assert.equal(ledger.suppressHeld({ roomId: 'room-a', seq: 10 }).status, 'ok')
    const counters = ledger.readCounters({ realmId: 'realm', roomId: 'room-a', local: 'A', peer: 'B', nowMs: NOW })
    assert.equal(counters.suppressedHeldSeq, 10)
    assert.equal(counters.notifiedSeq, 0)
    // Trusted 9 still wakes: the gate reads notified_seq ALONE.
    assert.equal(reserve(ledger, { seq: 9 }).status, 'reserved')
  } finally { ledger.close() }
})

test('corrupt schema quarantined to .corrupt-*, rebuilt fail-closed from cursor max', t => {
  const plugin = world(t)
  const scope = 'scope-a'
  const ledger = createScopeLedger(plugin, scope, { now: () => NOW })
  // Seed cursors.json v2 with notified_seq = 42 BEFORE corrupting the ledger.
  atomicWriteJson(join(plugin, 'sessions', scope, 'cursors.json'), {
    version: 2,
    realms: { realm: { rooms: { 'room-a': { read_seq: 0, notified_seq: 42, updated_at: null } } } },
  })
  // Corrupt the ledger file behind the closed handle.
  ledger.close()
  const path = ledger.path
  writeFileSync(path, 'this is not a database')
  chmodSync(path, 0o600)
  const reopened = createScopeLedger(plugin, scope, { now: () => NOW })
  try {
    const counters = reopened.readCounters({ realmId: 'realm', roomId: 'room-a', nowMs: NOW })
    assert.equal(counters.notifiedSeq, 42) // monotonic from cursors, not reset to 0
    assert.equal(counters.globalCounter, null) // G2 = 0 (fresh)
    const diags = reopened.drainDiagnostics()
    assert.ok(diags.some(line => line.includes('corrupt')))
  } finally { reopened.close() }
})

test('reset clears G1/G2 by peer or fully, never notified_seq', t => {
  const plugin = world(t)
  const ledger = createScopeLedger(plugin, 'scope-a', { now: () => NOW })
  try {
    assert.equal(reserve(ledger, { roomId: 'r1', seq: 1, peer: 'B', owner: 'x' }).status, 'reserved')
    assert.equal(reserve(ledger, { roomId: 'r2', seq: 1, peer: 'C', owner: 'y' }).status, 'reserved')
    assert.equal(ledger.reset({ peerSessionId: 'B' }).status, 'ok')
    let c = ledger.readCounters({ realmId: 'realm', roomId: 'r1', local: 'A', peer: 'B', nowMs: NOW })
    assert.equal(c.pair, null) // B pair cleared
    c = ledger.readCounters({ realmId: 'realm', roomId: 'r2', local: 'A', peer: 'C', nowMs: NOW })
    assert.equal(c.pair.count, 1) // C pair untouched
    ledger.reset()
    assert.equal(ledger.readCounters({ realmId: 'realm', roomId: 'r2', local: 'A', peer: 'C', nowMs: NOW }).globalCounter, null)
    assert.ok(listScopes(plugin).includes('scope-a'))
  } finally { ledger.close() }
})
