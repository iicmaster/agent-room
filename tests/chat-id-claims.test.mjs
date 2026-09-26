// Story 1.5 unit rows: the durable chat_id_claims store ops and the
// in-memory live-session registry, in-process with injectable clocks — no
// spawned servers here (the end-to-end matrix over the real HTTP surface
// lives in session-routes.test.mjs). The store rows prove the additive
// schema convergence, the upsert/list/prune semantics (display form rides
// alongside the lowercase key; multiple Actors per name is the ambiguity
// data; prune at the TTL deletes only strictly older rows), and durability
// across close/reopen. The registry rows prove the DR-1 grammar gate,
// case-insensitive live uniqueness with explicit refusal (no suffixing),
// immediate rename, release semantics, and the persist-callback discipline
// that keeps a refusal or failed durable write from changing any state.

import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { CHAT_ID_MAX, CLAIMS_TTL_MS, SESSION_TTL_MS } from '../server/constants.mjs'
import { createLiveSessionRegistry } from '../server/core/session-registry.mjs'
import { openRoomLog, ROOM_LOG_DATABASE_FILENAME } from '../server/store/room-log.mjs'

const FINGERPRINT_A = `sha256:${'a'.repeat(64)}`
const FINGERPRINT_B = `sha256:${'b'.repeat(64)}`
const FINGERPRINT_C = `sha256:${'c'.repeat(64)}`

function makeStore(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-chat-id-claims-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  return { store: openRoomLog({ dataDir }), dataDir }
}

function rawDatabase(store) {
  return new DatabaseSync(store.databasePath)
}

// --- Durable chat_id_claims store ops --------------------------------------------

test('chat_id_claims joins the schema additively as a STRICT table and converges on reopen', t => {
  const { store, dataDir } = makeStore(t)
  const dbPath = store.databasePath
  store.close()

  const raw = new DatabaseSync(dbPath)
  const table = raw.prepare(`
    SELECT name, strict FROM pragma_table_list WHERE schema = 'main' AND name = 'chat_id_claims'
  `).get()
  assert.equal(Number(table.strict), 1, 'chat_id_claims must be STRICT')
  // Simulate a pre-1.5 v2 database file: the additive index is absent, and
  // the next open must converge on it without a version bump or migration.
  raw.exec('DROP TABLE chat_id_claims')
  raw.close()

  const reopened = openRoomLog({ dataDir })
  try {
    assert.deepEqual(reopened.listClaimsForChatId('anything'), [], 'the table exists again and is empty')
  } finally {
    reopened.close()
  }
})

test('the chat_id_claims last-seen index joins additively and converges on reopen', t => {
  // Story 1.6: the offline-recently read window-scans by last_seen_at, so
  // the index is part of the additive convergence like the table itself.
  const { store, dataDir } = makeStore(t)
  const dbPath = store.databasePath
  const indexNames = () => {
    const raw = new DatabaseSync(dbPath)
    try {
      return raw.prepare(`SELECT name FROM pragma_index_list('chat_id_claims')`).all().map(row => row.name)
    } finally {
      raw.close()
    }
  }
  assert.ok(indexNames().includes('idx_chat_id_claims_last_seen_at'), 'the index exists on a fresh store')
  store.close()

  // Simulate a pre-1.6 v2 file whose index was never created (or was
  // dropped): the next open converges without a version bump.
  const raw = new DatabaseSync(dbPath)
  raw.exec('DROP INDEX idx_chat_id_claims_last_seen_at')
  raw.close()
  assert.equal(indexNames().includes('idx_chat_id_claims_last_seen_at'), false)

  const reopened = openRoomLog({ dataDir })
  try {
    assert.ok(indexNames().includes('idx_chat_id_claims_last_seen_at'), 'the open recreated the index')
    // The offline source query works over the converged index.
    assert.deepEqual(reopened.recentClaims(1000, 1_000_000), [])
  } finally {
    reopened.close()
  }
})

test('upsertChatIdClaim keys the lowercase form and keeps the display form', t => {
  const { store } = makeStore(t)
  try {    const written = store.upsertChatIdClaim({
      chatId: 'Alice',
      actorFingerprint: FINGERPRINT_A,
      lastSeenAt: '2026-09-25T00:00:00.000Z',
    })
    assert.deepEqual(written, {
      chat_id: 'Alice',
      chat_id_normalized: 'alice',
      actor_fingerprint: FINGERPRINT_A,
      last_seen_at: '2026-09-25T00:00:00.000Z',
    })
    // Case-insensitive lookup in either casing; the display form survives.
    assert.deepEqual(store.listClaimsForChatId('alice'), [written])
    assert.deepEqual(store.listClaimsForChatId('ALICE'), [written])
    assert.deepEqual(store.listClaimsForChatId('Alice'), [written])
    assert.deepEqual(store.listClaimsForChatId('bob'), [])
  } finally {
    store.close()
  }
})

test('upsert keeps the latest claim per (name, actor) and historical pairs as ambiguity data', t => {
  const { store } = makeStore(t)
  try {
    store.upsertChatIdClaim({ chatId: 'Alice', actorFingerprint: FINGERPRINT_A, lastSeenAt: '2026-01-01T00:00:00.000Z' })
    // Same (name, actor), new display case and later timestamp: one row
    // updated in place — the index always holds the latest claim per pair.
    store.upsertChatIdClaim({ chatId: 'ALICE', actorFingerprint: FINGERPRINT_A, lastSeenAt: '2026-02-01T00:00:00.000Z' })
    // A second Actor claiming the same name: two durable rows — exactly the
    // ambiguity data room_direct_open resolves.
    store.upsertChatIdClaim({ chatId: 'alice', actorFingerprint: FINGERPRINT_B, lastSeenAt: '2026-03-01T00:00:00.000Z' })

    const claims = store.listClaimsForChatId('alice')
    assert.equal(claims.length, 2)
    assert.deepEqual(claims.map(claim => claim.actor_fingerprint), [FINGERPRINT_B, FINGERPRINT_A], 'most recently seen first')
    assert.deepEqual(claims.map(claim => claim.chat_id), ['alice', 'ALICE'])
  } finally {
    store.close()
  }
})

test('recency is monotonic: a stale write refreshes the display form but never moves last_seen_at back', t => {
  const { store } = makeStore(t)
  try {
    const fresh = store.upsertChatIdClaim({ chatId: 'Alice', actorFingerprint: FINGERPRINT_A, lastSeenAt: '2026-06-01T00:00:00.000Z' })
    assert.equal(fresh.last_seen_at, '2026-06-01T00:00:00.000Z')
    // An attempted regression (older clock, new display case): recency stays,
    // the display form still follows the latest claim.
    const regressed = store.upsertChatIdClaim({ chatId: 'ALICE', actorFingerprint: FINGERPRINT_A, lastSeenAt: '2020-01-01T00:00:00.000Z' })
    assert.equal(regressed.chat_id, 'ALICE')
    assert.equal(regressed.last_seen_at, '2026-06-01T00:00:00.000Z', 'last_seen_at never regresses')
    const listed = store.listClaimsForChatId('alice')
    assert.equal(listed.length, 1)
    assert.equal(listed[0].chat_id, 'ALICE')
    assert.equal(listed[0].last_seen_at, '2026-06-01T00:00:00.000Z')
    // A newer write advances again.
    const advanced = store.upsertChatIdClaim({ chatId: 'alice', actorFingerprint: FINGERPRINT_A, lastSeenAt: '2026-07-01T00:00:00.000Z' })
    assert.equal(advanced.last_seen_at, '2026-07-01T00:00:00.000Z')
  } finally {
    store.close()
  }
})

test('upsertChatIdClaim validates grammar, fingerprint, and timestamp before writing', t => {
  const { store } = makeStore(t)
  try {
    for (const bad of ['', 'x'.repeat(CHAT_ID_MAX + 1), 'bad name', 'bad!', 'ünicode', 42, null, undefined]) {
      assert.throws(
        () => store.upsertChatIdClaim({ chatId: bad, actorFingerprint: FINGERPRINT_A }),
        error => error?.code === 'invalid_chat_id',
        String(bad),
      )
    }
    for (const bad of ['nope', `sha256:${'A'.repeat(64)}`, 42]) {
      assert.throws(
        () => store.upsertChatIdClaim({ chatId: 'alice', actorFingerprint: bad }),
        error => error?.code === 'invalid_actor_id',
        String(bad),
      )
    }
    for (const bad of ['not-a-date', '2026-13-99T00:00:00.000Z', 42]) {
      assert.throws(
        () => store.upsertChatIdClaim({ chatId: 'alice', actorFingerprint: FINGERPRINT_A, lastSeenAt: bad }),
        error => error?.code === 'invalid_argument',
        String(bad),
      )
    }
    assert.deepEqual(store.listClaimsForChatId('alice'), [], 'no rejected write ever landed')
    // Default timestamp: now, normalized to the canonical ISO form.
    const written = store.upsertChatIdClaim({ chatId: 'alice', actorFingerprint: FINGERPRINT_A })
    assert.equal(written.last_seen_at, new Date(Date.parse(written.last_seen_at)).toISOString())
  } finally {
    store.close()
  }
})

test('claims are durable across close and reopen (WAL SQLite)', t => {
  const { store, dataDir } = makeStore(t)
  store.upsertChatIdClaim({ chatId: 'Alice', actorFingerprint: FINGERPRINT_A, lastSeenAt: '2026-09-25T00:00:00.000Z' })
  store.close()

  const reopened = openRoomLog({ dataDir })
  try {
    assert.deepEqual(reopened.listClaimsForChatId('alice'), [{
      chat_id: 'Alice',
      chat_id_normalized: 'alice',
      actor_fingerprint: FINGERPRINT_A,
      last_seen_at: '2026-09-25T00:00:00.000Z',
    }])
  } finally {
    reopened.close()
  }
})

test('pruneChatIdClaims deletes strictly older rows at the injectable clock and keeps recent ones', t => {
  const { store } = makeStore(t)
  try {
    store.upsertChatIdClaim({ chatId: 'old-1', actorFingerprint: FINGERPRINT_A, lastSeenAt: '2020-01-01T00:00:00.000Z' })
    store.upsertChatIdClaim({ chatId: 'old-2', actorFingerprint: FINGERPRINT_B, lastSeenAt: '2020-06-01T00:00:00.000Z' })
    store.upsertChatIdClaim({ chatId: 'fresh', actorFingerprint: FINGERPRINT_C, lastSeenAt: '2030-01-01T00:00:00.000Z' })

    const now = Date.parse('2026-09-25T00:00:00.000Z')
    const pruned = store.pruneChatIdClaims(CLAIMS_TTL_MS, now)
    assert.equal(pruned, 2)
    assert.deepEqual(store.listClaimsForChatId('old-1'), [])
    assert.deepEqual(store.listClaimsForChatId('old-2'), [])
    assert.equal(store.listClaimsForChatId('fresh').length, 1, 'recent rows are kept')

    // The clock is injectable as a function too.
    store.pruneChatIdClaims(1000, () => Date.parse('2031-01-01T00:00:00.000Z'))
    assert.deepEqual(store.listClaimsForChatId('fresh'), [], 'the once-fresh row aged out under the moved clock')
  } finally {
    store.close()
  }
})

test('a row exactly at the prune cutoff is kept; only strictly older rows go', t => {
  const { store } = makeStore(t)
  try {
    const now = Date.parse('2026-09-25T00:00:00.000Z')
    const exactlyAtCutoff = new Date(now - CLAIMS_TTL_MS).toISOString()
    store.upsertChatIdClaim({ chatId: 'edge', actorFingerprint: FINGERPRINT_A, lastSeenAt: exactlyAtCutoff })
    store.upsertChatIdClaim({ chatId: 'older', actorFingerprint: FINGERPRINT_B, lastSeenAt: '2019-01-01T00:00:00.000Z' })
    assert.equal(store.pruneChatIdClaims(CLAIMS_TTL_MS, now), 1)
    assert.equal(store.listClaimsForChatId('edge').length, 1)
    assert.deepEqual(store.listClaimsForChatId('older'), [])
  } finally {
    store.close()
  }
})

test('pruneChatIdClaims validates its arguments', t => {
  const { store } = makeStore(t)
  try {
    for (const bad of [0, -1, 1.5, 'week', null]) {
      assert.throws(
        () => store.pruneChatIdClaims(bad),
        error => error?.code === 'invalid_argument',
        String(bad),
      )
    }
    // Non-finite clocks and cutoffs are coded rejections, never RangeErrors
    // from formatting a non-finite date.
    assert.throws(() => store.pruneChatIdClaims(1000, Number.NaN), error => error?.code === 'invalid_argument')
    assert.throws(() => store.pruneChatIdClaims(1000, Number.POSITIVE_INFINITY), error => error?.code === 'invalid_argument')
    assert.throws(() => store.pruneChatIdClaims(1000, 'nope'), error => error?.code === 'invalid_argument')
  } finally {
    store.close()
  }
})

test('a divergent pre-existing chat_id_claims table is refused with a coded schema error', t => {
  const { store, dataDir } = makeStore(t)
  store.close()
  const raw = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME))
  raw.exec('DROP TABLE chat_id_claims')
  raw.exec('CREATE TABLE chat_id_claims (chat_id_normalized TEXT PRIMARY KEY) STRICT')
  raw.close()
  assert.throws(
    () => openRoomLog({ dataDir }),
    error => error?.code === 'database_schema_invalid' && /chat_id_claims/.test(error.message),
    'the divergent column set is a coded open-time failure',
  )
})

// --- Live-session registry (core) --------------------------------------------------

function makeRegistry() {
  let now = 1_000_000
  const clock = () => now
  return {
    registry: createLiveSessionRegistry({ now: clock }),
    advance: ms => { now += ms },
  }
}

test('the live registry binds a session to a chat id and reports the snapshot', () => {
  const { registry } = makeRegistry()
  const state = registry.claim({ sessionKey: 'k1', chatId: 'Alice', actorFingerprint: FINGERPRINT_A })
  // Story 1.6: the bind may declare a client type; an undeclared one stays
  // null on the row (the server never derives one).
  assert.deepEqual(state, {
    chatId: 'Alice',
    chatIdNormalized: 'alice',
    actorFingerprint: FINGERPRINT_A,
    clientType: null,
    connectedSince: 1_000_000,
    lastSeen: 1_000_000,
  })
  assert.deepEqual(registry.lookup('k1'), state)
  assert.equal(registry.lookup('unknown'), null)
})

test('the live registry refuses a non-canonical actor fingerprint, not just an empty one', () => {
  // The registry is the last layer before the durable claims table, whose own
  // CHECK enforces the fingerprint shape. A malformed value must be refused
  // here as a clean coded rejection, never surface later as a store
  // constraint failure.
  const { registry } = makeRegistry()
  for (const bad of ['', 'agent:1', 'sha256:', 'sha256:' + 'A'.repeat(64), 'sha256:' + 'g'.repeat(64), 'x'.repeat(71), 42, null]) {
    assert.throws(
      () => registry.claim({ sessionKey: 'k1', chatId: 'alice', actorFingerprint: bad }),
      error => error?.code === 'invalid_argument',
      String(bad),
    )
  }
  assert.equal(registry.lookup('k1'), null, 'a refused fingerprint claims nothing')
  // The canonical shape still binds.
  registry.claim({ sessionKey: 'k1', chatId: 'alice', actorFingerprint: FINGERPRINT_A })
  assert.equal(registry.lookup('k1').actorFingerprint, FINGERPRINT_A)
})

test('holderOf reports the live holder of a name and nothing else', () => {
  const { registry } = makeRegistry()
  assert.equal(registry.holderOf('alice'), null, 'an unclaimed name has no holder')
  registry.claim({ sessionKey: 'k1', chatId: 'Alice', actorFingerprint: FINGERPRINT_A })
  const holder = registry.holderOf('alice')
  assert.equal(holder.sessionKey, 'k1')
  assert.equal(holder.actorFingerprint, FINGERPRINT_A)
  assert.equal(holder.chatId, 'Alice', 'the display form is the holder\'s own')
  assert.equal(registry.holderOf('bob'), null)
  assert.equal(registry.holderOf('not a name'), null, 'a malformed name has no holder')
  // Read-only: asking never displaces the holder.
  assert.equal(registry.lookup('k1').chatId, 'Alice')
})

test('a live collision is refused explicitly in any casing; the first holder is unaffected', () => {
  const { registry } = makeRegistry()
  registry.claim({ sessionKey: 'k1', chatId: 'Alice', actorFingerprint: FINGERPRINT_A })
  for (const attempt of ['alice', 'ALICE', 'aLiCe']) {
    assert.throws(
      () => registry.claim({ sessionKey: 'k2', chatId: attempt, actorFingerprint: FINGERPRINT_B }),
      error => error?.code === 'chat_id_taken',
      attempt,
    )
    assert.equal(registry.lookup('k2'), null, 'the refused claimant holds nothing')
  }
  assert.equal(registry.lookup('k1').chatId, 'Alice', 'the first holder is unaffected')
  // Same Actor, second session, same name: still a live collision.
  assert.throws(
    () => registry.claim({ sessionKey: 'k2', chatId: 'alice', actorFingerprint: FINGERPRINT_A }),
    error => error?.code === 'chat_id_taken',
  )
})

test('the DR-1 grammar gate refuses every malformed chat id with no state change', () => {
  const { registry } = makeRegistry()
  for (const bad of ['', 'x'.repeat(CHAT_ID_MAX + 1), 'bad name', 'bad!', 'ünicode', 42, null, undefined]) {
    assert.throws(
      () => registry.claim({ sessionKey: 'k1', chatId: bad, actorFingerprint: FINGERPRINT_A }),
      error => error?.code === 'invalid_chat_id',
      String(bad),
    )
  }
  assert.equal(registry.lookup('k1'), null)
  // Malformed arguments to the registry itself are internal failures.
  assert.throws(() => registry.claim({ chatId: 'alice', actorFingerprint: FINGERPRINT_A }), /sessionKey/)
  assert.throws(() => registry.claim({ sessionKey: 'k1', chatId: 'alice' }), /actorFingerprint/)
  assert.throws(() => registry.claim({ sessionKey: 'k1', chatId: 'alice', actorFingerprint: FINGERPRINT_A, persist: 'nope' }), /persist/)
})

test('rename is immediate: the old name is claimable by the next session in the same instant', () => {
  const { registry, advance } = makeRegistry()
  registry.claim({ sessionKey: 'k1', chatId: 'Alice', actorFingerprint: FINGERPRINT_A })
  advance(100)
  const renamed = registry.rename({ sessionKey: 'k1', chatId: 'Bob', actorFingerprint: FINGERPRINT_A })
  assert.equal(renamed.chatId, 'Bob')
  assert.equal(renamed.connectedSince, 1_000_000, 'the session lifetime did not reset')
  assert.equal(renamed.lastSeen, 1_000_100)
  assert.equal(registry.lookup('k1').chatIdNormalized, 'bob')

  // The old name is freed: the very next session claims it.
  const next = registry.claim({ sessionKey: 'k2', chatId: 'alice', actorFingerprint: FINGERPRINT_B })
  assert.equal(next.chatIdNormalized, 'alice')
})

test('rename onto a live-colliding name is refused and the original name is retained', () => {
  const { registry } = makeRegistry()
  registry.claim({ sessionKey: 'k1', chatId: 'Alice', actorFingerprint: FINGERPRINT_A })
  registry.claim({ sessionKey: 'k2', chatId: 'Bob', actorFingerprint: FINGERPRINT_B })

  assert.throws(
    () => registry.rename({ sessionKey: 'k1', chatId: 'bob', actorFingerprint: FINGERPRINT_A }),
    error => error?.code === 'chat_id_taken',
  )
  assert.equal(registry.lookup('k1').chatIdNormalized, 'alice', 'the original name is retained')
  assert.equal(registry.lookup('k2').chatIdNormalized, 'bob', 'the holder is unaffected')
  // Proof the retention is real: a third session cannot claim the held name.
  assert.throws(
    () => registry.claim({ sessionKey: 'k3', chatId: 'alice', actorFingerprint: FINGERPRINT_C }),
    error => error?.code === 'chat_id_taken',
  )
})

test('an idempotent re-bind of the held name refreshes without resetting connectedSince', () => {
  const { registry, advance } = makeRegistry()
  registry.claim({ sessionKey: 'k1', chatId: 'Alice', actorFingerprint: FINGERPRINT_A })
  advance(500)
  const again = registry.claim({ sessionKey: 'k1', chatId: 'ALICE', actorFingerprint: FINGERPRINT_A })
  assert.equal(again.connectedSince, 1_000_000)
  assert.equal(again.lastSeen, 1_000_500)
  assert.equal(again.chatId, 'ALICE', 'the display form follows the latest claim')
})

test('release frees the name for the next claimer immediately and reports what it did', () => {
  const { registry } = makeRegistry()
  registry.claim({ sessionKey: 'k1', chatId: 'Alice', actorFingerprint: FINGERPRINT_A })
  assert.equal(registry.release('k1'), true)
  assert.equal(registry.lookup('k1'), null)
  assert.equal(registry.release('k1'), false, 'a second release has nothing to free')
  const next = registry.claim({ sessionKey: 'k2', chatId: 'ALICE', actorFingerprint: FINGERPRINT_B })
  assert.equal(next.chatIdNormalized, 'alice')
})

test('the persist callback receives the durable-write payload stamped by the registry clock', () => {
  const { registry } = makeRegistry()
  const payloads = []
  const persist = payload => payloads.push(payload)
  registry.claim({ sessionKey: 'k1', chatId: 'Alice', actorFingerprint: FINGERPRINT_A, persist })
  assert.equal(payloads.length, 1, 'accepted bind persists')
  assert.deepEqual(payloads[0], {
    chatId: 'Alice',
    actorFingerprint: FINGERPRINT_A,
    lastSeenAt: '1970-01-01T00:16:40.000Z',
  }, 'one clock: the payload carries the registry now() timestamp')
  registry.claim({ sessionKey: 'k1', chatId: 'Alice', actorFingerprint: FINGERPRINT_A, persist })
  assert.equal(payloads.length, 2, 'idempotent re-bind refreshes the durable claim too')
  assert.throws(
    () => registry.claim({ sessionKey: 'k2', chatId: 'alice', actorFingerprint: FINGERPRINT_B, persist }),
    error => error?.code === 'chat_id_taken',
  )
  assert.equal(payloads.length, 2, 'the refused claim never persisted')
  assert.throws(
    () => registry.claim({ sessionKey: 'k2', chatId: 'bad name', actorFingerprint: FINGERPRINT_B, persist }),
    error => error?.code === 'invalid_chat_id',
  )
  assert.equal(payloads.length, 2, 'the grammar refusal never persisted')
})

test('a persist failure leaves the memory side untouched', () => {
  const { registry } = makeRegistry()
  registry.claim({ sessionKey: 'k1', chatId: 'Alice', actorFingerprint: FINGERPRINT_A })

  const boom = () => { throw new Error('store unavailable') }
  assert.throws(
    () => registry.claim({ sessionKey: 'k2', chatId: 'Bob', actorFingerprint: FINGERPRINT_B, persist: boom }),
    /store unavailable/,
  )
  assert.equal(registry.lookup('k2'), null, 'no phantom live row')
  // The name is still free; a healthy bind succeeds afterwards.
  const retry = registry.claim({ sessionKey: 'k2', chatId: 'Bob', actorFingerprint: FINGERPRINT_B })
  assert.equal(retry.chatIdNormalized, 'bob')
  // A failing rename keeps the original binding.
  assert.throws(
    () => registry.rename({ sessionKey: 'k1', chatId: 'Carol', actorFingerprint: FINGERPRINT_A, persist: boom }),
    /store unavailable/,
  )
  assert.equal(registry.lookup('k1').chatIdNormalized, 'alice')
})

test('touch refreshes lastSeen for the live row and answers null for unknown keys', () => {
  const { registry, advance } = makeRegistry()
  assert.equal(registry.touch('k1'), null, 'nothing live yet')
  registry.claim({ sessionKey: 'k1', chatId: 'Alice', actorFingerprint: FINGERPRINT_A })
  advance(500)
  const touched = registry.touch('k1')
  assert.equal(touched.lastSeen, 1_000_500)
  assert.equal(touched.connectedSince, 1_000_000)
  registry.release('k1')
  assert.equal(registry.touch('k1'), null, 'nothing live after release')
})

test('touch wired with persist refreshes the durable recency in the same operation and clock tick', () => {
  const { registry, advance } = makeRegistry()
  registry.claim({ sessionKey: 'k1', chatId: 'Alice', actorFingerprint: FINGERPRINT_A })
  advance(500)
  const payloads = []
  const touched = registry.touch('k1', { persist: payload => payloads.push(payload) })
  assert.equal(touched.lastSeen, 1_000_500)
  assert.deepEqual(payloads, [{
    chatId: 'Alice',
    actorFingerprint: FINGERPRINT_A,
    lastSeenAt: '1970-01-01T00:16:40.500Z',
  }], 'the heartbeat payload is the durable write, stamped by the same clock tick')
  // A failed durable write leaves the memory side untouched (same discipline
  // as claim).
  assert.throws(
    () => registry.touch('k1', { persist: () => { throw new Error('store unavailable') } }),
    /store unavailable/,
  )
  assert.equal(registry.lookup('k1').lastSeen, 1_000_500, 'no in-memory refresh on a failed persist')
})

test('live rows older than the lease are swept on the next claim and the name is freed', () => {
  const { registry, advance } = makeRegistry()
  const persisted = []
  registry.claim({
    sessionKey: 'k1',
    chatId: 'bob',
    actorFingerprint: FINGERPRINT_A,
    persist: payload => persisted.push(payload),
  })
  // Exactly at the lease: still held.
  advance(SESSION_TTL_MS)
  assert.throws(
    () => registry.claim({ sessionKey: 'k2', chatId: 'bob', actorFingerprint: FINGERPRINT_B }),
    error => error?.code === 'chat_id_taken',
  )
  // Past the lease: the dead session's name is freed without any release.
  advance(1)
  const claimed = registry.claim({ sessionKey: 'k2', chatId: 'BOB', actorFingerprint: FINGERPRINT_B })
  assert.equal(claimed.chatIdNormalized, 'bob')
  assert.equal(registry.lookup('k1'), null, 'the abandoned row was swept')
  assert.equal(persisted.length, 1, 'the sweep is memory-only: no durable write, no delete')
})

test('a swept session re-claiming its own name starts a fresh bind', () => {
  const { registry, advance } = makeRegistry()
  registry.claim({ sessionKey: 'k1', chatId: 'bob', actorFingerprint: FINGERPRINT_A })
  advance(SESSION_TTL_MS + 1)
  const again = registry.claim({ sessionKey: 'k1', chatId: 'bob', actorFingerprint: FINGERPRINT_A })
  assert.equal(again.chatIdNormalized, 'bob')
  assert.equal(again.connectedSince, 1_000_000 + SESSION_TTL_MS + 1, 'the lease expiry reset the session lifetime')
})

test('clear drops every live row; construction and clock are validated', () => {
  const { registry, advance } = makeRegistry()
  registry.claim({ sessionKey: 'k1', chatId: 'bob', actorFingerprint: FINGERPRINT_A })
  advance(10)
  registry.claim({ sessionKey: 'k2', chatId: 'alice', actorFingerprint: FINGERPRINT_B })
  registry.clear()
  assert.equal(registry.lookup('k1'), null)
  assert.equal(registry.lookup('k2'), null)
  // The names are free again.
  const next = registry.claim({ sessionKey: 'k3', chatId: 'BOB', actorFingerprint: FINGERPRINT_C })
  assert.equal(next.chatIdNormalized, 'bob')

  assert.throws(() => createLiveSessionRegistry({ now: 'nope' }), /now/)
  assert.throws(() => createLiveSessionRegistry({ leaseMs: 0 }), /leaseMs/)
  assert.throws(() => createLiveSessionRegistry({ leaseMs: 1.5 }), /leaseMs/)
  // A non-finite clock tick is a coded internal failure, never a NaN row.
  let now = 1_000_000
  const flaky = createLiveSessionRegistry({ now: () => now })
  flaky.claim({ sessionKey: 'k1', chatId: 'bob', actorFingerprint: FINGERPRINT_A })
  now = Number.NaN
  assert.throws(
    () => flaky.claim({ sessionKey: 'k2', chatId: 'alice', actorFingerprint: FINGERPRINT_B }),
    error => error?.code === 'invalid_argument',
  )
  assert.throws(
    () => flaky.touch('k1'),
    error => error?.code === 'invalid_argument',
  )
  assert.equal(flaky.lookup('k1').lastSeen, 1_000_000, 'the non-finite tick changed nothing')
})

test('the registry validates its construction and freezes its surface', () => {
  assert.throws(() => createLiveSessionRegistry({ now: 'nope' }), /now/)
  const registry = createLiveSessionRegistry()
  assert.ok(Object.isFrozen(registry))
})
