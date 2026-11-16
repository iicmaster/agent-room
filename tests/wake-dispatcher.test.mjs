// Two-phase wake dispatcher: trust-first ordering, success CAS to both stores,
// Phase B failure lease rollback, Held isolation, out-of-order Held/Trusted.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { createScopeLedger } from '../server/client/scope-ledger.mjs'
import { createWakeDispatcher, pauseHint } from '../server/notification/wake-dispatcher.mjs'
import { loadCursors } from '../server/client/cursors.mjs'

function world(t, { heldVerdict = false } = {}) {
  const plugin = mkdtempSync(join(tmpdir(), 'wake-dispatch-'))
  t.after(() => rmSync(plugin, { recursive: true, force: true }))
  const NOW = 1_700_000_000_000
  const ledger = createScopeLedger(plugin, 'scope-a', { now: () => NOW })
  const events = []
  const dispatcher = createWakeDispatcher({
    ledger, pluginDataDir: plugin, realmId: 'realm', scope: 'scope-a',
    classifyRow: row => {
      events.push('trust')
      return { held: heldVerdict, actor_fingerprint: row.actor_fingerprint }
    },
    decideHeld: () => { events.push('held'); return true },
    now: () => NOW,
  })
  t.after(() => ledger.close())
  return { plugin, ledger, dispatcher, events, NOW }
}

const trustedRow = seq => ({ room_id: 'room-a', seq, actor_fingerprint: 'sha256:peer' })

test('trust gate runs BEFORE ledger reserve', async t => {
  const w = world(t)
  const result = await w.dispatcher.evaluate(trustedRow(9), {
    dispatch: () => { w.events.push('dispatch'); return true }, local: 'A', peer: 'B',
  })
  assert.equal(result.ok, true)
  assert.equal(w.events[0], 'trust')
  assert.ok(w.events.includes('dispatch'))
})

test('Phase A→C success: dispatch runs, notified_seq written to cursor v2', async t => {
  const w = world(t)
  let dispatched = null
  const result = await w.dispatcher.evaluate(trustedRow(9), {
    dispatch: async ({ candidate }) => { dispatched = candidate.seq; return true },
    local: 'A', peer: 'B',
  })
  assert.equal(result.ok, true)
  assert.equal(result.action, 'woke')
  assert.equal(dispatched, 9)
  const cursors = loadCursors(w.plugin, 'realm', { scope: 'scope-a' })
  assert.equal(cursors.get('room-a').notified_seq, 9)
})

test('Phase B failure: lease released, notified_seq unmoved, one retry allowed', async t => {
  const w = world(t)
  let attempts = 0
  const options = {
    dispatch: () => { attempts += 1; throw new Error('boom') },
    local: 'A', peer: 'B',
  }
  const first = await w.dispatcher.evaluate(trustedRow(9), options)
  assert.equal(first.ok, false)
  assert.equal(first.action, 'released')
  assert.equal(loadCursors(w.plugin, 'realm', { scope: 'scope-a' }).get('room-a')?.notified_seq ?? 0, 0)
  // Retry the same seq once: it passes Phase A again (attempts=2).
  const retry = await w.dispatcher.evaluate(trustedRow(9), options)
  assert.equal(retry.ok, false)
  assert.equal(attempts, 2)
  // Third attempt: attempt budget exhausted, no dispatch.
  const third = await w.dispatcher.evaluate(trustedRow(9), options)
  assert.equal(third.action, 'skipped')
  assert.equal(third.reason, 'attempts_exhausted')
  assert.equal(attempts, 2)
})

test('Held 10 then Trusted 9: Held never blocks the trusted wake', async t => {
  const w = world(t)
  w.ledger.suppressHeld({ roomId: 'room-a', seq: 10 })
  const heldResult = w.dispatcher.dispatchHeld({ room_id: 'room-a', seq: 10, actor_fingerprint: 'sha256:peer' })
  assert.equal(heldResult.action, 'woke_held')
  const counters = w.ledger.readCounters({ realmId: 'realm', roomId: 'room-a', nowMs: w.NOW })
  assert.equal(counters.suppressedHeldSeq, 10)
  assert.equal(counters.notifiedSeq, 0)
  // Trusted 9 still dispatches: gate reads notified_seq alone, not max().
  const trusted = await w.dispatcher.evaluate(trustedRow(9), {
    dispatch: () => true, local: 'A', peer: 'B',
  })
  assert.equal(trusted.ok, true)
  assert.equal(loadCursors(w.plugin, 'realm', { scope: 'scope-a' }).get('room-a').notified_seq, 9)
})

test('pauseHint text names wake-reset, pair and global', () => {
  assert.match(pauseHint('pair_limit', 'peer-xyz'), /paused: pair limit 8 reached; run agent-room wake-reset --peer peer-xyz/)
  assert.match(pauseHint('global_limit'), /paused: global limit 25 reached; run agent-room wake-reset --all/)
})
