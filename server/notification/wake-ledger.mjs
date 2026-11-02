// The held-row wake ledger, SQLite-backed (policy closed 2026-11-02:
// docs/implementation/reviews/wake-ledger-policy-closure.md).
//
// WHY THIS REPLACED THE JSON FILE: the v0.7 ledger was read-modify-write over
// `wake-state.json` — two processes (the always-on notifier and an `agent-room
// wait`) could both read "no cooldown", both decide to wake, and both write.
// The gate is a budget, and a budget two writers can spend twice is not a
// budget. `BEGIN IMMEDIATE` makes the read and the write one critical section
// across processes, which is the whole point of moving it into SQLite.
//
// WHAT DID NOT CHANGE: the policy itself. First contact from an untrusted
// sender still wakes; repeats cool down; the installation still obeys an
// aggregate budget per window; a suppressed row is still never consumed; and
// this file still knows nothing about message content.
//
// FAILURE POSTURE (closure D1/D3), in one place so it cannot drift:
//   - no ledger yet            -> healthy, create it, charge normally
//   - readable but unusable    -> REFUSE the wake, never mutate the file
//     (bad schema, unsupported version, unsafe path, CORRUPT/NOTADB)
//   - transient (busy/locked/  -> allow AT MOST ONE uncharged degraded hint
//     io error/disk full)         per process per episode, then suppress
// The alternative — failing open on an unreadable ledger — turns "someone
// tampered with my budget file" into "wake without limit".
//
// NOT IMPLEMENTED, DELIBERATELY: the worker thread the closure describes. With
// `busy_timeout = 50ms` and at most four `BEGIN IMMEDIATE` attempts the worst
// case is ~200ms of synchronous work, and the decision is then KNOWN in the
// same tick — which deletes the closure's `outcome_unknown` class outright
// instead of compensating for it. ponytail: revisit with a worker only if a
// measured p99 here ever crosses the 500ms decision budget.

import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { AgentRoomRuntimeError } from '../runtime.mjs'

const SCHEMA_VERSION = 1
const BUSY_TIMEOUT_MS = 50
const MAX_ATTEMPTS = 4
const SQLITE_BUSY = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED'])
const SQLITE_REFUSE = new Set(['SQLITE_CORRUPT', 'SQLITE_NOTADB'])

const refuse = reason => new AgentRoomRuntimeError('ledger_refused', reason)
const transient = () => new AgentRoomRuntimeError('ledger_transient', 'the wake ledger is temporarily unavailable')

const codeOf = error => error?.code ?? error?.errcode ?? ''

// A ledger path is built from three pieces this installation owns. Anything
// else — `.`/`..`, a symlink, a hardlink, a file owned by someone else, a
// world-readable file — is refused before SQLite ever opens it.
function assertSafeDirectory(directory) {
  let info
  try {
    info = lstatSync(directory)
  } catch (error) {
    if (error?.code !== 'ENOENT') throw transient()
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    info = lstatSync(directory)
  }
  if (info.isSymbolicLink() || !info.isDirectory()) throw refuse('wake ledger directory is not a plain directory')
  if (info.uid !== process.getuid()) throw refuse('wake ledger directory is not owned by this user')
  if ((info.mode & 0o077) !== 0) throw refuse('wake ledger directory is readable by another user')
}

function assertSafeFile(path) {
  let info
  try {
    info = lstatSync(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return false
    throw transient()
  }
  if (info.isSymbolicLink() || !info.isFile()) throw refuse('wake ledger is not a plain file')
  if (info.uid !== process.getuid()) throw refuse('wake ledger is not owned by this user')
  if (info.nlink > 1) throw refuse('wake ledger is hardlinked')
  if ((info.mode & 0o077) !== 0) throw refuse('wake ledger is readable by another user')
  return true
}

export function wakeLedgerPath(pluginData, realmId) {
  if (typeof realmId !== 'string' || realmId.length === 0 || realmId.length > 128 || !/^[A-Za-z0-9._-]+$/.test(realmId) || realmId === '.' || realmId === '..') {
    throw new AgentRoomRuntimeError('invalid_request', 'the agent-room realm id is not a safe key; refusing to build a wake-ledger path from it')
  }
  return join(pluginData, 'realms', realmId, 'wake-ledger.sqlite')
}

function openDatabase(path) {
  const db = new DatabaseSync(path)
  // SQLite creates with the process umask (0644 on most hosts). The directory
  // is 0700 already, but the closure requires the file itself to be 0600 and
  // `assertSafeFile` refuses it on the next open if it is not.
  chmodSync(path, 0o600)
  db.exec(`PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS}`)
  db.exec('PRAGMA journal_mode = WAL')
  db.exec('PRAGMA synchronous = FULL')
  db.exec('PRAGMA foreign_keys = ON')
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT`)
  db.exec(`CREATE TABLE IF NOT EXISTS sender_wake (fingerprint TEXT PRIMARY KEY, last_at INTEGER NOT NULL) STRICT`)
  db.exec(`CREATE TABLE IF NOT EXISTS wake_event (at INTEGER NOT NULL) STRICT`)
  db.exec('CREATE INDEX IF NOT EXISTS wake_event_at ON wake_event (at)')
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
  if (!row) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
  } else if (row.value !== String(SCHEMA_VERSION)) {
    db.close()
    throw refuse(`unsupported wake ledger schema ${row.value}`)
  }
  return db
}

// Closure D4: the v1 JSON ledger is imported exactly once, inside the same
// transaction that creates the SQLite state, and then moved aside so it can
// never be imported twice.
function importLegacyJson(db, statePath) {
  let raw
  try {
    raw = readFileSync(statePath, 'utf8')
  } catch {
    return false
  }
  let legacy
  try {
    legacy = JSON.parse(raw)
  } catch {
    throw refuse('the legacy wake state is not valid JSON')
  }
  if (legacy?.version !== 1) throw refuse('unsupported legacy wake state version')
  const senders = legacy.perSender && typeof legacy.perSender === 'object' ? legacy.perSender : {}
  const events = Array.isArray(legacy.heldWakes) ? legacy.heldWakes : []
  db.exec('BEGIN IMMEDIATE')
  try {
    for (const [fingerprint, at] of Object.entries(senders)) {
      if (typeof fingerprint !== 'string' || !fingerprint || !Number.isFinite(at)) continue
      db.prepare('INSERT OR REPLACE INTO sender_wake (fingerprint, last_at) VALUES (?, ?)').run(fingerprint, Math.trunc(at))
    }
    for (const at of events) {
      if (!Number.isFinite(at)) continue
      db.prepare('INSERT INTO wake_event (at) VALUES (?)').run(Math.trunc(at))
    }
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('imported_from_json', statePath)
    db.exec('COMMIT')
  } catch (error) {
    db.exec('ROLLBACK')
    throw error
  }
  renameSync(statePath, `${statePath}.imported`)
  return true
}

function openLedger({ pluginData, realmId }) {
  const path = wakeLedgerPath(pluginData, realmId)
  assertSafeDirectory(dirname(path))
  const existed = assertSafeFile(path)
  const db = openDatabase(path)
  if (!existed) importLegacyJson(db, join(dirname(path), 'wake-state.json'))
  return db
}

// One held-row wake decision. `true` means the wake may fire and the ledger has
// already been charged for it; `false` means this sender is cooling down, the
// budget is spent, or the ledger could not be trusted — and in the last case
// nothing was written.
export function createWakeLedger({ pluginData, realmId, policy }) {
  let db = null
  let degradedFired = false

  const close = () => {
    if (db) db.close()
    db = null
  }

  const handle = () => {
    if (!db) db = openLedger({ pluginData, realmId })
    return db
  }

  const decide = (fingerprint, now = Date.now()) => {
    if (typeof fingerprint !== 'string' || fingerprint.length === 0) return false
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      let active
      try {
        active = handle()
      } catch (error) {
        if (error?.code === 'ledger_transient' && !degradedFired) {
          // One uncharged hint per episode: a wake that cannot be counted is
          // still better than a silent one, but it does not recur.
          degradedFired = true
          return true
        }
        return false
      }
      try {
        active.exec('BEGIN IMMEDIATE')
        const cutoff = now - policy.windowMs
        // Bounded state: senders past their cooldown can never cool anything,
        // and events older than the window can never spend the budget.
        active.prepare('DELETE FROM wake_event WHERE at < ?').run(cutoff)
        active.prepare('DELETE FROM sender_wake WHERE last_at < ?').run(now - policy.cooldownMs)
        const sender = active.prepare('SELECT last_at FROM sender_wake WHERE fingerprint = ?').get(fingerprint)
        const spent = active.prepare('SELECT COUNT(*) AS n FROM wake_event WHERE at >= ?').get(cutoff).n
        if (sender && now - sender.last_at < policy.cooldownMs) {
          active.exec('ROLLBACK')
          degradedFired = false
          return false
        }
        if (spent >= policy.budget) {
          active.exec('ROLLBACK')
          degradedFired = false
          return false
        }
        active.prepare('INSERT OR REPLACE INTO sender_wake (fingerprint, last_at) VALUES (?, ?)').run(fingerprint, now)
        active.prepare('INSERT INTO wake_event (at) VALUES (?)').run(now)
        active.exec('COMMIT')
        degradedFired = false
        return true
      } catch (error) {
        try { active.exec('ROLLBACK') } catch { close() }
        const code = codeOf(error)
        if (SQLITE_REFUSE.has(code)) {
          close()
          return false
        }
        if (SQLITE_BUSY.has(code) && attempt < MAX_ATTEMPTS) continue
        close()
        if (!degradedFired) {
          degradedFired = true
          return true
        }
        return false
      }
    }
    return false
  }

  return { decide, close }
}
