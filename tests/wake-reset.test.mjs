// wake-reset: XOR grammar (exit 2), scope reset (exit 0), notified_seq preserved.
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { runWakeResetCommand } from '../server/cli/wake-reset-commands.mjs'
import { createScopeLedger } from '../server/client/scope-ledger.mjs'

function world(t) {
  const plugin = mkdtempSync(join(tmpdir(), 'wake-reset-'))
  const shared = mkdtempSync(join(tmpdir(), 'wake-reset-shared-'))
  t.after(() => { rmSync(plugin, { recursive: true, force: true }); rmSync(shared, { recursive: true, force: true }) })
  return { plugin, shared }
}

test('XOR grammar: neither --peer nor --all, and both, are usage errors (exit 2)', async t => {
  const w = world(t)
  const neither = await runWakeResetCommand([], { pluginDataDir: w.plugin, sharedDataDir: w.shared })
  assert.equal(neither.status, 'usage')
  assert.equal(neither.code, 'usage')
  const both = await runWakeResetCommand(['--peer', 'x', '--all'], { pluginDataDir: w.plugin, sharedDataDir: w.shared })
  assert.equal(both.status, 'usage')
})

test('--all resets current scope G1/G2 and preserves notified_seq (exit 0)', async t => {
  const w = world(t)
  const env = { ...process.env, AGENT_ROOM_SESSION_SCOPE: 'scope-a' }
  // Seed a counter into scope-a's ledger.
  const ledger = createScopeLedger(w.plugin, 'scope-a')
  ledger.reserve({ realmId: 'realm', roomId: 'r', seq: 5, local: 'A', peer: 'B', nowMs: Date.now() })
  ledger.close()
  const result = await runWakeResetCommand(['--all', '--json'], { pluginDataDir: w.plugin, sharedDataDir: w.shared, env })
  assert.equal(result.status, 'ok')
  const receipt = JSON.parse(result.lines[0])
  assert.equal(receipt.scope, 'scope-a')
  assert.equal(receipt.all, true)
  assert.deepEqual(receipt.preserved, ['notified_seq', 'suppressed_held_seq'])
  // G2 cleared.
  const verify = createScopeLedger(w.plugin, 'scope-a')
  assert.equal(verify.readCounters({ realmId: 'realm', roomId: 'r', nowMs: Date.now() }).globalCounter, null)
  verify.close()
})

test('--all --scope targets the named scope, never another', async t => {
  const w = world(t)
  const a = createScopeLedger(w.plugin, 'scope-a')
  a.reserve({ realmId: 'realm', roomId: 'r', seq: 1, local: 'A', peer: 'B' })
  a.close()
  const b = createScopeLedger(w.plugin, 'scope-b')
  b.reserve({ realmId: 'realm', roomId: 'r', seq: 1, local: 'A', peer: 'B' })
  b.close()
  // Reset scope-a explicitly; scope-b must remain paused-charged.
  await runWakeResetCommand(['--all', '--scope', 'scope-a'], { pluginDataDir: w.plugin, sharedDataDir: w.shared })
  const verifyA = createScopeLedger(w.plugin, 'scope-a')
  const verifyB = createScopeLedger(w.plugin, 'scope-b')
  assert.equal(verifyA.readCounters({ realmId: 'realm', roomId: 'r' }).globalCounter, null)
  assert.equal(verifyB.readCounters({ realmId: 'realm', roomId: 'r' }).globalCounter.count, 1)
  verifyA.close(); verifyB.close()
})

test('unsafe --scope is a usage error', async t => {
  const w = world(t)
  const bad = await runWakeResetCommand(['--all', '--scope', '../escape'], { pluginDataDir: w.plugin, sharedDataDir: w.shared })
  assert.equal(bad.status, 'usage')
})
