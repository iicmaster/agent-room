// Story 3.2 — the per-Session-Scope wake loop ledger. The ONE durable guard
// store: `sessions/<scope>/loop-ledger.sqlite`, STRICT tables, WAL, synchronous
// FULL, file 0o600, SCHEMA_VERSION = 1. Its path goes through the one per-scope
// builder (sessionScopeFilePath) — no fourth path builder, no fourth lock.
//
// WHAT IS STORED (metadata only — never a byte of message text):
//   inflight          the Phase A lease (room, seq, until, attempts, owner)
//   pair_counter      G1 count for (local, peer, room) + 30-min expiry
//   global_counter    G2 count for the whole scope + 30-min expiry
//   notified          mirror of cursors.json v2's notified_seq (diagnostics)
//   suppressed_held_seq  the Held-only watermark, KEPT SEPARATE from notified
//
// THE TWO INVARIANTS THIS MODULE EXISTS TO PROTECT:
//   1. G2 no-TOCTOU. `reserve` does the read (count) and the write (count+1) in
//      ONE BEGIN IMMEDIATE. Two rooms that both read 24 cannot both spend the
//      25th; the second blocks, then sees 25 and pauses. The G1/G2 counters are
//      therefore CHARGED IN PHASE A atomically with the lease, not in Phase C.
//      (Spec Change Log: the "bump G1/G2 in Phase C" phrase is subordinate to
//      the hard "no TOCTOU / shared reservation" constraint — you cannot charge
//      G2 after dispatch without reopening the race. Charging in Phase A also
//      counts crash-loop ATTEMPTS, the fail-closed direction.)
//   2. Held isolation. `suppressed_held_seq` is written only by the Held path
//      and is READ ONLY by the Held gate. It is never max()-ed with notified.
//
// FAILURE POSTURE: a corrupt / wrong-schema file is renamed to
// `loop-ledger.sqlite.corrupt-<ts>` and rebuilt fail-closed: the `notified`
// mirror is re-seeded from the monotonic max of notified_seq in cursors.json v2
// (the authoritative position store), while G1/G2 counters start at 0. A
// SQLITE_BUSY that persists past LEDGER_BUSY_MAX_MS returns {status:'busy'}
// with a diagnostic — it never throws into `wait`.

import { randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  LEDGER_BUSY_MAX_MS,
  LOOP_TTL_MS,
  SESSION_SCOPE_PATTERN,
  WAKE_INFLIGHT_MS,
} from '../constants.mjs'
import { AgentRoomRuntimeError, ensurePrivateDirectory, readJsonFile } from '../runtime.mjs'
import { sessionScopeFilePath } from './session-state.mjs'
import { CURSORS_FILENAME } from './cursors.mjs'
import { classifySqliteFault } from '../notification/wake-ledger.mjs'
import { classifyWake } from '../notification/loop-guard.mjs'

const SCHEMA_VERSION = 1
const MAX_ATTEMPTS = 2 // initial wake + exactly one retry of the same seq

const TABLE_COLUMNS = Object.freeze({
  meta: ['key', 'value'],
  inflight: ['room_id', 'inflight_seq', 'inflight_until_ms', 'attempts', 'owner'],
  pair_counter: ['local', 'peer', 'room', 'count', 'expires_at'],
  global_counter: ['scope', 'count', 'expires_at'],
  notified: ['room_id', 'seq'],
  suppressed_held_seq: ['room_id', 'seq'],
})

const busy = detail => ({ status: 'busy', detail })
const isSafeInteger = value => Number.isSafeInteger(value)

function ledgerPathFor(pluginDataDir, scope) {
  return sessionScopeFilePath(pluginDataDir, scope, 'loop-ledger.sqlite')
}

// Validate the existing file is a plain, owner-only, non-hardlinked regular
// file before SQLite ever opens it (same discipline as the wake ledger).
function assertSafeFile(path) {
  let info
  try {
    info = lstatSync(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw new AgentRoomRuntimeError('ledger_refused', `loop ledger cannot be inspected (${error?.code ?? 'error'})`)
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new AgentRoomRuntimeError('ledger_refused', 'loop ledger is not a plain file')
  }
  if (info.uid !== process.getuid() || info.nlink > 1 || (info.mode & 0o077) !== 0) {
    throw new AgentRoomRuntimeError('ledger_refused', 'loop ledger has unsafe ownership or permissions')
  }
  return true
}

// Every known SQLite fault maps through the ONE classifier. BUSY/LOCKED that
// outlives its bounded wait is a `busy` result (skip the round); corrupt/notadb
// and wrong schema are `corrupt` (quarantine + rebuild); anything else is a
// refusal we surface as diagnostics rather than crashing the caller.
function mapOpenFault(error) {
  const verdict = classifySqliteFault(error)
  if (verdict === 'busy') return { kind: 'busy', detail: 'loop ledger is busy' }
  if (verdict === 'refuse') return { kind: 'corrupt', detail: 'loop ledger is corrupt' }
  return { kind: 'corrupt', detail: `loop ledger unreadable (${error?.code ?? 'error'})` }
}

function createSchema(db) {
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = FULL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT')
  db.exec('CREATE TABLE IF NOT EXISTS inflight (room_id TEXT PRIMARY KEY, inflight_seq INTEGER NOT NULL, inflight_until_ms INTEGER NOT NULL, attempts INTEGER NOT NULL, owner TEXT NOT NULL) STRICT')
  db.exec('CREATE TABLE IF NOT EXISTS pair_counter (local TEXT NOT NULL, peer TEXT NOT NULL, room TEXT NOT NULL, count INTEGER NOT NULL, expires_at INTEGER NOT NULL, PRIMARY KEY (local, peer, room)) STRICT')
  db.exec('CREATE TABLE IF NOT EXISTS global_counter (scope TEXT PRIMARY KEY, count INTEGER NOT NULL, expires_at INTEGER NOT NULL) STRICT')
  db.exec('CREATE TABLE IF NOT EXISTS notified (room_id TEXT PRIMARY KEY, seq INTEGER NOT NULL) STRICT')
  db.exec('CREATE TABLE IF NOT EXISTS suppressed_held_seq (room_id TEXT PRIMARY KEY, seq INTEGER NOT NULL) STRICT')
  db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
}

// A wrong schema (missing table, extra/renamed columns, wrong version) is a
// corruption signal, not something to migrate. Returns a reason or null.
function schemaFault(db) {
  let versionRow
  try {
    versionRow = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
  } catch {
    return 'meta table missing'
  }
  if (versionRow?.value !== String(SCHEMA_VERSION)) return `unsupported schema ${versionRow?.value ?? 'unknown'}`
  for (const [table, expected] of Object.entries(TABLE_COLUMNS)) {
    let columns
    try {
      columns = db.prepare(`PRAGMA table_info(${table})`).all().map(row => row.name)
    } catch {
      return `${table} table missing`
    }
    if (columns.length !== expected.length || expected.some((name, index) => columns[index] !== name)) {
      return `${table} schema drifted`
    }
  }
  return null
}

// Monotonic max of notified_seq across ALL realms of the scope's cursors.json
// v2, keyed by room. This is the single authoritative position store; the
// ledger only mirrors it, so a rebuilt guard never moves a position backwards.
function seedNotifiedFromCursors(pluginDataDir, scope) {
  const path = sessionScopeFilePath(pluginDataDir, scope, CURSORS_FILENAME)
  if (!existsSync(path)) return new Map()
  let document
  try {
    document = readJsonFile(path)
  } catch {
    return new Map()
  }
  const seeded = new Map()
  const realms = document?.realms && typeof document.realms === 'object' ? document.realms : {}
  for (const realm of Object.values(realms)) {
    const rooms = realm?.rooms && typeof realm.rooms === 'object' ? realm.rooms : {}
    for (const [roomId, entry] of Object.entries(rooms)) {
      const seq = entry?.notified_seq
      if (isSafeInteger(seq) && seq >= 0) seeded.set(roomId, Math.max(seeded.get(roomId) ?? 0, seq))
    }
  }
  return seeded
}

// Move a bad file aside and rebuild. Returns {corruptBackup, seeded} for a
// diagnostic line. Best-effort rename: a racing process may have moved it.
function quarantineAndRebuild(db, pluginDataDir, scope, path) {
  try { db.close() } catch { /* already closed */ }
  const backup = `${path}.corrupt-${Date.now()}-${randomUUID().slice(0, 8)}`
  let moved = false
  try {
    renameSync(path, backup)
    chmodSync(backup, 0o600)
    moved = true
  } catch { /* another process quarantined first, or file vanished */ }
  // WAL/SHM sidecars of the corrupt file must not be reused by the fresh db.
  for (const suffix of ['-wal', '-shm']) {
    try { chmodSync(`${path}${suffix}`, 0o600); renameSync(`${path}${suffix}`, `${backup}${suffix}`) } catch { /* absent */ }
  }
  const seeded = seedNotifiedFromCursors(pluginDataDir, scope)
  const fresh = new DatabaseSync(path)
  chmodSync(path, 0o600)
  createSchema(fresh)
  const insert = fresh.prepare('INSERT OR REPLACE INTO notified (room_id, seq) VALUES (?, ?)')
  for (const [roomId, seq] of seeded) insert.run(roomId, seq)
  fresh.close()
  return { corruptBackup: moved ? backup : null, seeded: seeded.size }
}

/**
 * Open (or lazily open) one scope's loop ledger. Runtime assertion helpers are
 * injected via the database object's methods so the whole surface is testable
 * with a real temp directory and no server.
 */
export function createScopeLedger(pluginDataDir, scope, { now = () => Date.now() } = {}) {
  const path = ledgerPathFor(pluginDataDir, scope)
  let db = null
  let diagnostics = []

  const note = detail => { diagnostics.push(detail) }
  const drainDiagnostics = () => { const copy = diagnostics; diagnostics = []; return copy }

  function open() {
    if (db) return db
    ensurePrivateDirectory(dirname(path))
    const exists = assertSafeFile(path)
    if (!exists) {
      const fresh = new DatabaseSync(path)
      chmodSync(path, 0o600)
      createSchema(fresh)
      db = fresh
      return db
    }
    let candidate
    try {
      candidate = new DatabaseSync(path)
    } catch (error) {
      const fault = mapOpenFault(error)
      if (fault.kind === 'busy') throw new AgentRoomRuntimeError('ledger_busy', fault.detail)
      const result = quarantineAndRebuild(null, pluginDataDir, scope, path)
      note(`quarantined corrupt loop ledger to ${result.corruptBackup ?? path}; rebuilt fail-closed from ${result.seeded} cursor positions`)
      candidate = null
    }
    if (candidate !== null) {
      try {
        const fault = schemaFault(candidate)
        if (fault !== null) throw new AgentRoomRuntimeError('ledger_schema_invalid', fault)
        candidate.exec(`PRAGMA busy_timeout = ${LEDGER_BUSY_MAX_MS}`)
        db = candidate
        return db
      } catch (error) {
        if (error?.code === 'ledger_busy') throw error
        const result = quarantineAndRebuild(candidate, pluginDataDir, scope, path)
        note(`quarantined wrong-schema loop ledger to ${result.corruptBackup ?? path} (${error?.message ?? 'schema'}); rebuilt fail-closed from ${result.seeded} cursor positions`)
      }
    }
    const fresh = new DatabaseSync(path)
    chmodSync(path, 0o600)
    createSchema(fresh)
    fresh.exec(`PRAGMA busy_timeout = ${LEDGER_BUSY_MAX_MS}`)
    db = fresh
    return db
  }

  // Run `body` inside BEGIN IMMEDIATE with a single BUSY verdict. Any BUSY
  // that outlives busy_timeout becomes {status:'busy'} — never a thrown
  // exception into wait. `body` returns a plain result object.
  function immediate(body) {
    let active
    try {
      active = open()
    } catch (error) {
      if (error?.code === 'ledger_busy') return busy(error.message)
      note(`loop ledger unavailable: ${error?.message ?? error}`)
      return busy(error?.message ?? 'loop ledger unavailable')
    }
    try {
      active.exec('BEGIN IMMEDIATE')
    } catch (error) {
      const verdict = classifySqliteFault(error)
      try { active.exec('ROLLBACK') } catch { /* no tx */ }
      if (verdict === 'busy') {
        note('loop ledger SQLITE_BUSY past 5000 ms; skipped wake round')
        return busy('loop ledger busy past 5000 ms')
      }
      note(`loop ledger transaction refused: ${error?.message ?? error}`)
      return { status: 'busy', detail: `loop ledger transaction failed (${error?.code ?? 'error'})` }
    }
    try {
      const result = body(active)
      active.exec('COMMIT')
      return result
    } catch (error) {
      try { active.exec('ROLLBACK') } catch { /* torn down */ }
      const verdict = classifySqliteFault(error)
      if (verdict === 'busy') {
        note('loop ledger SQLITE_BUSY past 5000 ms; skipped wake round')
        return busy('loop ledger busy past 5000 ms')
      }
      note(`loop ledger operation failed: ${error?.message ?? error}`)
      return { status: 'busy', detail: `loop ledger operation failed (${error?.code ?? 'error'})` }
    }
  }

  function readCounter(db_, table, keyColumn, keyValue) {
    const row = db_.prepare(`SELECT count, expires_at FROM ${table} WHERE ${keyColumn} = ?`).get(keyValue)
    if (!row) return null
    return { count: Number(row.count), expires_at: Number(row.expires_at) }
  }

  function readPairCounter(db_, local, peer, room) {
    const row = db_.prepare('SELECT count, expires_at FROM pair_counter WHERE local = ? AND peer = ? AND room = ?')
      .get(local ?? '', peer ?? '', room)
    if (!row) return null
    return { count: Number(row.count), expires_at: Number(row.expires_at) }
  }

  function authoritativeNotified(realmId, roomId, db_) {
    // cursors.json v2 is the position authority. The ledger mirror is a
    // redundant read for diagnostics; the max of the two is monotonic-safe.
    let fromCursor = 0
    try {
      const doc = readJsonFile(sessionScopeFilePath(pluginDataDir, scope, CURSORS_FILENAME))
      fromCursor = Number(doc?.realms?.[realmId]?.rooms?.[roomId]?.notified_seq ?? 0)
    } catch { /* missing cursor: position 0 */ }
    let fromMirror = 0
    try {
      fromMirror = Number(db_.prepare('SELECT seq FROM notified WHERE room_id = ?').get(roomId)?.seq ?? 0)
    } catch { /* fresh ledger */ }
    return Number.isSafeInteger(fromCursor) && fromCursor >= 0 ? Math.max(fromCursor, fromMirror > 0 ? fromMirror : 0) : 0
  }

  return {
    path,

    // Read-only view of the current counters/watermarks (no transaction needed
    // for a diagnostic read; reserve/commit remain the atomic writers).
    readCounters({ realmId, roomId, local, peer, nowMs = now() } = {}) {
      return immediate(db_ => ({
        status: 'ok',
        pair: local !== undefined && peer !== undefined && roomId !== undefined
          ? readPairCounter(db_, local, peer, roomId)
          : null,
        globalCounter: readCounter(db_, 'global_counter', 'scope', scope),
        notifiedSeq: roomId !== undefined && realmId !== undefined ? authoritativeNotified(realmId, roomId, db_) : 0,
        suppressedHeldSeq: roomId !== undefined
          ? Number(db_.prepare('SELECT seq FROM suppressed_held_seq WHERE room_id = ?').get(roomId)?.seq ?? 0)
          : 0,
      }))
    },

    // Phase A. Atomically: position check, lease check, guard classification,
    // lease reservation, and G1/G2 charge. Trust was applied by the caller
    // BEFORE this call. Returns the verdict the caller must honor.
    reserve({ realmId, roomId, seq, local, peer, owner = randomUUID(), nowMs = now() } = {}) {
      if (!roomId || !isSafeInteger(seq)) return { status: 'skip', reason: 'invalid_request', owner }
      return immediate(db_ => {
        const notified = authoritativeNotified(realmId, roomId, db_)
        if (seq <= notified) return { status: 'skip', reason: 'already_notified', owner, notified }

        const existing = db_.prepare('SELECT * FROM inflight WHERE room_id = ?').get(roomId)
        if (existing && Number(existing.inflight_until_ms) > nowMs) {
          return { status: 'skip', reason: 'lease_live', owner, leaseOwner: existing.owner }
        }
        let attempts = 1
        if (existing && Number(existing.inflight_seq) === seq) {
          attempts = Number(existing.attempts) + 1
          if (attempts > MAX_ATTEMPTS) return { status: 'skip', reason: 'attempts_exhausted', owner }
        }

        const pair = readPairCounter(db_, local, peer, roomId)
        const globalCounter = readCounter(db_, 'global_counter', 'scope', scope)
        const verdict = classifyWake({ pair, globalCounter, now: nowMs })
        if (verdict.action === 'pause') {
          return { status: 'paused', reason: verdict.reasons[0], owner, verdict }
        }

        const until = nowMs + WAKE_INFLIGHT_MS
        db_.prepare('INSERT OR REPLACE INTO inflight (room_id, inflight_seq, inflight_until_ms, attempts, owner) VALUES (?, ?, ?, ?, ?)')
          .run(roomId, seq, until, attempts, owner)

        // Charge G1 and G2 INSIDE this transaction — the shared reservation
        // that closes the cross-room TOCTOU. A fresh 30-min window starts when
        // an expired counter is recharged.
        const expiresAt = nowMs + LOOP_TTL_MS
        const nextPair = (pair && pair.expires_at > nowMs ? pair.count : 0) + 1
        const nextGlobal = (globalCounter && globalCounter.expires_at > nowMs ? globalCounter.count : 0) + 1
        db_.prepare('INSERT OR REPLACE INTO pair_counter (local, peer, room, count, expires_at) VALUES (?, ?, ?, ?, ?)')
          .run(local ?? '', peer ?? '', roomId, nextPair, expiresAt)
        db_.prepare('INSERT OR REPLACE INTO global_counter (scope, count, expires_at) VALUES (?, ?, ?)')
          .run(scope, nextGlobal, expiresAt)

        return { status: 'reserved', owner, verdict, attempts, inflight_until_ms: until }
      })
    },

    // Phase C CAS. Ownership + seq must still match the lease, else this is a
    // stale owner and must NOT move any position. Writes the ledger mirror and
    // releases the lease atomically. The caller then advances cursors.json v2
    // via advanceCursor({field:'notified_seq'}) — the CAS here is precisely the
    // ownership guard that keeps a stale owner from reaching that writer.
    commit({ roomId, seq, owner, nowMs = now() } = {}) {
      return immediate(db_ => {
        const row = db_.prepare('SELECT inflight_seq, owner FROM inflight WHERE room_id = ?').get(roomId)
        if (!row || row.owner !== owner || Number(row.inflight_seq) !== seq) {
          return { status: 'stale', reason: 'owner_mismatch' }
        }
        const current = Number(db_.prepare('SELECT seq FROM notified WHERE room_id = ?').get(roomId)?.seq ?? 0)
        db_.prepare('INSERT OR REPLACE INTO notified (room_id, seq) VALUES (?, ?)').run(roomId, Math.max(current, seq))
        db_.prepare('DELETE FROM inflight WHERE room_id = ?').run(roomId)
        return { status: 'committed', seq }
      })
    },

    // Phase B failure/crash recovery: release the lease ONLY if we still own
    // it. notified_seq and G1/G2 are untouched — the seq may be retried once.
    release({ roomId, seq, owner } = {}) {
      return immediate(db_ => {
        const row = db_.prepare('SELECT inflight_seq, owner FROM inflight WHERE room_id = ?').get(roomId)
        if (!row || row.owner !== owner || (seq !== undefined && Number(row.inflight_seq) !== seq)) {
          return { status: 'stale' }
        }
        // Keep the lease ROW (with its attempt count) but expire it immediately
        // and rotate its owner: the seq is retryable at once, but a stale owner
        // can no longer CAS-commit, and the retry budget of exactly one survives.
        db_.prepare('UPDATE inflight SET inflight_until_ms = 0, owner = ? WHERE room_id = ?')
          .run(`released:${owner}`, roomId)
        return { status: 'released' }
      })
    },

    // Held path: record a SUPPRESSED watermark, separate from notified_seq.
    // Never touched by the trusted gate; no G1/G2 charge.
    suppressHeld({ roomId, seq } = {}) {
      if (!roomId || !isSafeInteger(seq)) return { status: 'skip' }
      return immediate(db_ => {
        const current = Number(db_.prepare('SELECT seq FROM suppressed_held_seq WHERE room_id = ?').get(roomId)?.seq ?? 0)
        db_.prepare('INSERT OR REPLACE INTO suppressed_held_seq (room_id, seq) VALUES (?, ?)').run(roomId, Math.max(current, seq))
        return { status: 'ok', seq }
      })
    },

    // wake-reset: clear G1 (all pairs, or every pair whose peer matches
    // `peerSessionId`) and G2. NEVER deletes notified_seq or suppressed_held_seq.
    reset({ peerSessionId = null } = {}) {
      return immediate(db_ => {
        if (peerSessionId === null) {
          db_.exec('DELETE FROM pair_counter')
        } else {
          db_.prepare('DELETE FROM pair_counter WHERE peer = ?').run(peerSessionId)
        }
        db_.prepare('DELETE FROM global_counter WHERE scope = ?').run(scope)
        return { status: 'ok', peerSessionId }
      })
    },

    quarantineCorrupt() {
      const exists = assertSafeFile(path)
      if (!exists) return { status: 'absent' }
      const result = quarantineAndRebuild(db, pluginDataDir, scope, path)
      db = null
      note(`operator quarantine to ${result.corruptBackup ?? path}; rebuilt from ${result.seeded} cursor positions`)
      return { status: 'ok', ...result }
    },

    drainDiagnostics,
    close() {
      if (db) { try { db.close() } catch { /* already closed */ } db = null }
    },
  }
}

// Enumerate scope keys under PLUGIN_DATA/sessions for `wake-reset --all
// --scope` validation and diagnostics. Uses the same grammar guard as the path
// builder so a stray directory can never key a reset.
export function listScopes(pluginDataDir) {
  const sessionsDir = join(pluginDataDir, 'sessions')
  if (!existsSync(sessionsDir)) return []
  try {
    return readdirSync(sessionsDir).filter(name => SESSION_SCOPE_PATTERN.test(name) && name !== '.' && name !== '..')
  } catch {
    return []
  }
}
