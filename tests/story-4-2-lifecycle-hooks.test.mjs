// Story 4.2 — focused native node:test evidence for the 4 lifecycle hooks.
// Black-box: drives runHookCommand() with injected stdin/clock/state and reads
// the durable files the hooks are only allowed to touch. Covers every AC:
// stdin limits + fail-open + unknown exit 2, the exact 5000/5001 reset boundary,
// PostToolUse bounded Held-metadata-only stdout with no read_seq move, Stop exit
// 2 vs 0, and suppressed_held_seq (never notified_seq) after a Held block.
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import test from 'node:test'

import { runHookCommand, parseHookPayload, readBoundedStdin } from '../server/cli/hook-commands.mjs'
import {
  hasAutoWakeMarker,
  shouldResetOnHumanPrompt,
  readHookWakeState,
  buildHookSummary,
  notifierInboxPath,
} from '../server/client/hook-wake-state.mjs'
import { createScopeLedger } from '../server/client/scope-ledger.mjs'
import { loadCursors, advanceCursor } from '../server/client/cursors.mjs'
import {
  HOOK_SUMMARY_MAX_BYTES,
  HOOK_SUMMARY_MAX_MSGS,
  USER_PROMPT_WAKE_GRACE_MS,
  HOOK_STDIN_MAX_BYTES,
} from '../server/constants.mjs'

const NOW = 1_800_000_000_000
const SCOPE = 'claude_testscope'
const env = { AGENT_ROOM_SESSION_SCOPE: SCOPE }

function world(t) {
  const plugin = mkdtempSync(join(tmpdir(), 'story42-'))
  // The cursor writer expects the per-scope directory to exist (production
  // creates it via the session/ledger paths first).
  mkdirSync(join(plugin, 'sessions', SCOPE), { recursive: true })
  t.after(() => rmSync(plugin, { recursive: true, force: true }))
  return plugin
}

const stdin = text => Readable.from([text])

function writeInbox(plugin, rows) {
  writeFileSync(notifierInboxPath(plugin), rows.map(r => JSON.stringify(r)).join('\n') + '\n')
}

async function run(plugin, cmd, payload, { nowMs = NOW, envOverride = env } = {}) {
  return runHookCommand(cmd, {
    input: stdin(typeof payload === 'string' ? payload : JSON.stringify(payload)),
    env: envOverride,
    pluginDataDir: plugin,
    cwd: '/tmp/any cwd with spaces',
    now: () => nowMs,
  })
}

// --- AC1: stdin grammar, limits, fail-open, unknown ---------------------------

test('AC1 unknown subcommand exits 2 and names the four valid ones', async t => {
  const r = await run(world(t), 'bogus', {})
  assert.equal(r.exitCode, 2)
  assert.equal(r.status, 'usage')
  assert.match(r.stderr.join(' '), /session-start.*user-prompt-submit.*post-tool-use.*stop/)
})

test('AC1 malformed JSON / bad boolean / EOF / oversize all fail-open exit 0, zero diagnostic leak', async t => {
  const plugin = world(t)
  const cases = [
    ['malformed', '{not json'],
    ['bad-boolean', JSON.stringify({ event: 'Stop', stop_hook_active: 'yes' })],
    ['eof', ''],
    ['oversize', 'x'.repeat(HOOK_STDIN_MAX_BYTES + 1)],
  ]
  for (const [label, text] of cases) {
    const r = await run(plugin, 'stop', text)
    assert.equal(r.exitCode, 0, label)
    assert.equal(r.status, 'fail_open', label)
    assert.equal(r.stdout.length, 0, label)
    assert.equal(r.stderr.length, 1, label)
    // Fixed reason codes only: no stdin bytes, no secret, echoed.
    if (text.length > 0) assert.equal(r.stderr[0].includes(text.slice(0, 40)), false, label)
    assert.match(r.stderr[0], /fail-open/)
  }
})

test('AC1 schema gate: strict boolean only when present; absence is fine', () => {
  assert.deepEqual(parseHookPayload(JSON.stringify({ event: 'PostToolUse' })).ok, true)
  assert.deepEqual(parseHookPayload(JSON.stringify({ event: 'Stop', stop_hook_active: true })).ok, true)
  assert.deepEqual(parseHookPayload(JSON.stringify({ event: 'Stop', stop_hook_active: false })).ok, true)
  assert.equal(parseHookPayload(JSON.stringify({ event: 'Stop', stop_hook_active: 1 })).reason, 'invalid_stop_hook_active')
})

test('AC1 sensitive text in prompt never reaches diagnostics', async t => {
  const plugin = world(t)
  const marker = 's3ns1t1v3-mark3r-xyz987'
  const r = await run(plugin, 'user-prompt-submit', { event: 'UserPromptSubmit', prompt: marker })
  assert.equal(r.exitCode, 0)
  for (const line of [...r.stderr, ...r.stdout]) assert.equal(line.includes(marker), false)
})

// --- AC2: exact 5000 vs 5001 boundary; markers --------------------------------

test('AC2 pure boundary: === 5000 no reset, 5001 reset; markers never reset', () => {
  const base = { prompt: 'plain human prompt', lastWakeAtMs: NOW, graceMs: USER_PROMPT_WAKE_GRACE_MS }
  assert.equal(shouldResetOnHumanPrompt({ ...base, nowMs: NOW + 4999 }), false)
  assert.equal(shouldResetOnHumanPrompt({ ...base, nowMs: NOW + 5000 }), false)
  assert.equal(shouldResetOnHumanPrompt({ ...base, nowMs: NOW + 5001 }), true)
  assert.equal(shouldResetOnHumanPrompt({ ...base, nowMs: NOW + 6000, prompt: '<channel source="agent-room" x' }), false)
  assert.equal(shouldResetOnHumanPrompt({ ...base, nowMs: NOW + 6000, prompt: 'see [agent-room-wake] please' }), false)
  assert.equal(hasAutoWakeMarker('[agent-room-wake]'), true)
  assert.equal(hasAutoWakeMarker('<channel source="agent-room"'), true)
  assert.equal(hasAutoWakeMarker('just hello'), false)
})

test('AC2 full hook: charge G1/G2, 5000 no reset, 5001 resets via the 3.2 ledger', async t => {
  const plugin = world(t)
  writeInbox(plugin, [{ ts: new Date(NOW).toISOString(), room_id: 'r', seq: 1, chat_id: 'peer', held: false, preview: 'yo' }])
  const ledger = createScopeLedger(plugin, SCOPE)
  ledger.reserve({ realmId: 'realm', roomId: 'r', seq: 1, local: 'me', peer: 'peer', nowMs: NOW })
  assert.equal(ledger.readCounters({ roomId: 'r', nowMs: NOW }).globalCounter.count, 1)
  ledger.close()

  const at5000 = await run(plugin, 'user-prompt-submit', { event: 'UserPromptSubmit', prompt: 'hello' }, { nowMs: NOW + 5000 })
  assert.equal(at5000.exitCode, 0)
  assert.equal(at5000.reset, false)
  const check = createScopeLedger(plugin, SCOPE)
  assert.equal(check.readCounters({ roomId: 'r', nowMs: NOW }).globalCounter.count, 1, '===5000 kept G2')
  check.close()

  const at5001 = await run(plugin, 'user-prompt-submit', { event: 'UserPromptSubmit', prompt: 'hello' }, { nowMs: NOW + 5001 })
  assert.equal(at5001.exitCode, 0)
  assert.equal(at5001.reset, true)
  const after = createScopeLedger(plugin, SCOPE)
  assert.equal(after.readCounters({ roomId: 'r', nowMs: NOW }).globalCounter, null, '5001 cleared G2')
  after.close()
})

// --- AC3: PostToolUse bounded summary; Held metadata-only; no read_seq move ---

test('AC3 PostToolUse: <=5 msgs, <=2KiB each, Held body withheld, read_seq unmoved', async t => {
  const plugin = world(t)
  await advanceCursor(plugin, { realmId: 'realm', roomId: 'r', seq: 7, field: 'read_seq' }, { scope: SCOPE, env })
  const rows = []
  for (let i = 0; i < 8; i += 1) {
    rows.push({ ts: new Date(NOW + i).toISOString(), room_id: 'r', seq: 10 + i, chat_id: 'p' + i, held: false, preview: 'preview' })
  }
  rows.push({ ts: new Date(NOW + 99).toISOString(), room_id: 'heldroom', seq: 99, chat_id: 'evil', held: true, preview: 'THE_FORBIDDEN_HELD_BODY' })
  writeInbox(plugin, rows)
  const r = await run(plugin, 'post-tool-use', { event: 'PostToolUse' })
  assert.equal(r.exitCode, 0)
  assert.ok(r.stdout.length > 0)
  assert.ok(r.stdout.length <= HOOK_SUMMARY_MAX_MSGS)
  for (const line of r.stdout) assert.ok(Buffer.byteLength(line, 'utf8') <= HOOK_SUMMARY_MAX_BYTES)
  const joined = r.stdout.join('\n')
  assert.match(joined, /body withheld/)
  assert.equal(joined.includes('THE_FORBIDDEN_HELD_BODY'), false)
  assert.equal(loadCursors(plugin, 'realm', { scope: SCOPE, env }).get('r').read_seq, 7, 'read_seq untouched')
})

// --- AC3/Stop: exit 2 vs 0, suppressed_held_seq, notified_seq untouched -------

test('Stop: trusted eligible -> exit 2 with bounded stdout; stop_hook_active true -> exit 0', async t => {
  const plugin = world(t)
  writeInbox(plugin, [{ ts: new Date(NOW).toISOString(), room_id: 'r', seq: 5, chat_id: 'peer', held: false, preview: 'unread body preview' }])
  await advanceCursor(plugin, { realmId: 'realm', roomId: 'r', seq: 0, field: 'notified_seq' }, { scope: SCOPE, env })

  const blocked = await run(plugin, 'stop', { event: 'Stop', stop_hook_active: false })
  assert.equal(blocked.exitCode, 2)
  assert.equal(blocked.blocked, true)
  assert.ok(blocked.stdout.length > 0)

  // The block must NOT advance notified_seq.
  assert.equal(loadCursors(plugin, 'realm', { scope: SCOPE, env }).get('r').notified_seq, 0)

  const active = await run(plugin, 'stop', { event: 'Stop', stop_hook_active: true })
  assert.equal(active.exitCode, 0)
  assert.equal(active.blocked, false)
  assert.equal(active.reason, 'active')
  assert.equal(active.stdout.length, 0)
})

test('Stop: no eligible -> exit 0 immediately', async t => {
  const plugin = world(t)
  writeInbox(plugin, [])
  const r = await run(plugin, 'stop', { event: 'Stop', stop_hook_active: false })
  assert.equal(r.exitCode, 0)
  assert.equal(r.stdout.length, 0)
})

test('Stop Held: exit 2 metadata-only then suppressed_held_seq only; second Stop exits 0', async t => {
  const plugin = world(t)
  writeInbox(plugin, [
    { ts: new Date(NOW).toISOString(), room_id: 'hr', seq: 9, chat_id: 'evil', held: true, preview: 'MUST_NOT_APPEAR' },
  ])
  const first = await run(plugin, 'stop', { event: 'Stop', stop_hook_active: false })
  assert.equal(first.exitCode, 2)
  assert.equal(first.blocked, true)
  const out = first.stdout.join('\n')
  assert.match(out, /body withheld/)
  assert.equal(out.includes('MUST_NOT_APPEAR'), false)

  const ledger = createScopeLedger(plugin, SCOPE)
  const counters = ledger.readCounters({ roomId: 'hr', nowMs: NOW })
  assert.equal(counters.suppressedHeldSeq, 9)
  assert.equal(counters.notifiedSeq, 0, 'Held never moved notified')
  ledger.close()
  assert.equal(loadCursors(plugin, 'realm', { scope: SCOPE, env }).get('hr')?.notified_seq ?? 0, 0)

  const second = await run(plugin, 'stop', { event: 'Stop', stop_hook_active: false })
  assert.equal(second.exitCode, 0, 'repeated Held does not re-block')
  assert.equal(second.stdout.length, 0)
})

// --- reader contract ----------------------------------------------------------

test('shared reader: eligible = trusted seq>cursor or held seq>suppressed', async t => {
  const plugin = world(t)
  writeInbox(plugin, [
    { ts: new Date(NOW).toISOString(), room_id: 'r', seq: 3, chat_id: 'a', held: false, preview: 'x' },
    { ts: new Date(NOW).toISOString(), room_id: 'r', seq: 2, chat_id: 'b', held: false, preview: 'x' },
    { ts: new Date(NOW).toISOString(), room_id: 'h', seq: 8, chat_id: 'c', held: true, preview: 'hidden' },
  ])
  await advanceCursor(plugin, { realmId: 'realm', roomId: 'r', seq: 2, field: 'notified_seq' }, { scope: SCOPE, env })
  const state = readHookWakeState({ pluginDataDir: plugin, scope: SCOPE, nowMs: NOW })
  assert.deepEqual(state.eligibleTrusted.map(e => e.seq), [3])
  assert.deepEqual(state.heldEligible.map(e => e.seq), [8])
  assert.equal(state.lastWakeAtMs, NOW)
  const summary = buildHookSummary(state)
  assert.equal(summary.some(line => line.includes('hidden')), false)
})
