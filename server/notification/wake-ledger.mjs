// The held-row wake ledger, SQLite-backed (policy closed 2026-11-02:
// docs/implementation/reviews/wake-ledger-policy-closure.md; the policy-agreement
// and migration-marker closures below are the v0.8.0 review round).
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
// POLICY AGREEMENT (the v0.7 gap this closes): the policy arrived from each
// process's own environment, and the ledger never recorded it — two processes
// with different AGENT_ROOM_WAKE_* settings managed one shared history under
// two rules. The ledger now records the effective policy tuple and the
// EXPLICIT layer (which values were pinned through the environment) at first
// use, and verifies them under the same BEGIN IMMEDIATE section. The check is
// deliberately on the explicit layer only: keys pinned by either side must
// agree, or the open refuses with the stored and current values named — that
// is a configuration disagreement the operator has to resolve. Defaults that
// drifted across a release are adopted and recorded (an unattended gate that
// silently stops waking after an upgrade is worse than a recorded adoption),
// and AGENT_ROOM_WAKE_POLICY_REBASELINE=1 overwrites the record once — a
// deliberate, flagged re-baseline, not a silent one; remove the flag after it
// has taken effect.
//
// RESTARTABLE MIGRATION (the v0.7 gap this closes): the v1 JSON import was
// decided by whether the SQLite file existed — a process that died between
// file creation and import left the next open skipping the legacy file
// forever. The import decision now lives in a `meta` marker written in the
// SAME transaction as the imported rows: no marker plus a legacy file means
// import; a marker means never again (and the rename that archives the legacy
// file is the idempotent cleanup that follows the commit). A legacy file the
// parser refuses keeps refusing on every open — the ledger stays unusable
// until the operator fixes or removes it — which is the same REFUSE-don't-repair
// posture the failure section below already pins.
//
// FAILURE POSTURE (closure D1/D3), in one place so it cannot drift:
//   - no ledger yet            -> healthy, create it, charge normally
//   - readable but unusable    -> REFUSE the wake, never mutate the file
//     (bad schema, unsupported version, unsafe path, CORRUPT/NOTADB, a
//     policy disagreement, an unparseable legacy state)
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

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
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

// The keys of a policy tuple, in the order they are compared and recorded.
const POLICY_KEYS = Object.freeze(['cooldownMs', 'budget', 'windowMs'])
const REBASELINE_ENV = 'AGENT_ROOM_WAKE_POLICY_REBASELINE'

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
  return db
}

// Read and validate the legacy v1 JSON state. Throwing here refuses the open
// (never repairs it) on every subsequent open until the file is fixed or
// removed — an unparseable authority must not be skipped.
function legacyRows(statePath) {
  let raw
  try {
    raw = readFileSync(statePath, 'utf8')
  } catch {
    return null
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
  return { senders, events }
}

// The policy agreement, decided inside the same critical section as the
// import. `explicit` maps POLICY_KEYS to the values THIS process pinned via
// the environment ({ key: effectiveValue } — a junk override's effective
// value, since that is what its decisions actually use); `rebaseline` is the
// flagged overwrite. Only the explicit layer conflicts: a key pinned by
// either the ledger's record or this process must carry the same value on
// both sides, otherwise the open refuses with both values named.
function verifyPolicyAgreement(db, { policy, explicit, rebaseline }) {
  const getMeta = db.prepare('SELECT value FROM meta WHERE key = ?')
  const storedRow = getMeta.get('policy')
  const explicitRow = getMeta.get('policy_explicit')

  const putMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
  const record = () => {
    putMeta.run('policy', JSON.stringify(policy))
    putMeta.run('policy_explicit', JSON.stringify(explicit))
  }

  if (storedRow === undefined) {
    record()
    return
  }
  let stored
  let storedExplicit
  try {
    stored = JSON.parse(storedRow.value)
    storedExplicit = explicitRow === undefined ? {} : JSON.parse(explicitRow.value)
  } catch {
    throw refuse('the recorded wake policy is not usable JSON')
  }
  if (!POLICY_KEYS.every(key => Number.isSafeInteger(stored?.[key]) && stored[key] > 0)
    || storedExplicit === null || typeof storedExplicit !== 'object' || Array.isArray(storedExplicit)) {
    throw refuse('the recorded wake policy does not have the recorded shape')
  }
  if (rebaseline) {
    record()
    return
  }
  for (const key of POLICY_KEYS) {
    const pinnedBefore = storedExplicit[key]
    const pinnedNow = explicit[key]
    if (pinnedBefore === undefined && pinnedNow === undefined) continue
    const thenValue = pinnedBefore ?? stored[key]
    const nowValue = pinnedNow ?? policy[key]
    if (thenValue !== nowValue) {
      throw refuse(
        `wake ledger policy disagreement on ${key}: the ledger was written with ${key}=${thenValue}`
        + ` and this process carries ${key}=${nowValue}`
        + ` — align the AGENT_ROOM_WAKE_* environment across every process using this installation`
        + `, or set ${REBASELINE_ENV}=1 for one run to accept the new policy on record`,
      )
    }
  }
  if (JSON.stringify(stored) !== JSON.stringify(policy) || JSON.stringify(storedExplicit) !== JSON.stringify(explicit)) {
    record()
  }
}

// One init pass under BEGIN IMMEDIATE: stamp the schema version, import the
// legacy JSON exactly once (decided by the marker, never by file existence),
// and verify the policy agreement. Every open runs it; every step inside is
// idempotent, so a process that died mid-flight resumes rather than skips.
function initLedger(db, { legacyPath, policy, explicit, rebaseline }) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const versionRow = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
    if (!versionRow) {
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
    } else if (versionRow.value !== String(SCHEMA_VERSION)) {
      throw refuse(`unsupported wake ledger schema ${versionRow.value}`)
    }
    const markerRow = db.prepare('SELECT value FROM meta WHERE key = ?').get('imported_from_json')
    const legacyNeeded = markerRow === undefined && existsSync(legacyPath)
    if (legacyNeeded) {
      const rows = legacyRows(legacyPath)
      if (rows !== null) {
        for (const [fingerprint, at] of Object.entries(rows.senders)) {
          if (typeof fingerprint !== 'string' || !fingerprint || !Number.isFinite(at)) continue
          db.prepare('INSERT OR REPLACE INTO sender_wake (fingerprint, last_at) VALUES (?, ?)').run(fingerprint, Math.trunc(at))
        }
        for (const at of rows.events) {
          if (!Number.isFinite(at)) continue
          db.prepare('INSERT INTO wake_event (at) VALUES (?)').run(Math.trunc(at))
        }
        db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run('imported_from_json', legacyPath)
      }
    }
    verifyPolicyAgreement(db, { policy, explicit, rebaseline })
    db.exec('COMMIT')
    return legacyNeeded
  } catch (error) {
    try { db.exec('ROLLBACK') } catch { /* the failure may have torn the tx down already */ }
    throw error
  }
}

function openLedger({ pluginData, realmId, policy, explicit, rebaseline }) {
  const path = wakeLedgerPath(pluginData, realmId)
  assertSafeDirectory(dirname(path))
  assertSafeFile(path)
  const db = openDatabase(path)
  try {
    const legacyPath = join(dirname(path), 'wake-state.json')
    const imported = initLedger(db, { legacyPath, policy, explicit, rebaseline })
    // The rename is the commit's idempotent cleanup: a process that died
    // between COMMIT and rename re-lands here, sees the marker, and archives
    // the file; a legacy file that survives alongside a marker is history,
    // never a second import.
    if (imported || (existsSync(legacyPath) && !existsSync(`${legacyPath}.imported`))) {
      try { renameSync(legacyPath, `${legacyPath}.imported`) } catch { /* raced with the other process's rename */ }
    }
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

// One held-row wake decision. `true` means the wake may fire and the ledger has
// already been charged for it; `false` means this sender is cooling down, the
// budget is spent, or the ledger could not be trusted — and in the last case
// nothing was written.
export function createWakeLedger({ pluginData, realmId, policy, identity = {} }) {
  const explicit = identity.explicit && typeof identity.explicit === 'object' ? identity.explicit : {}
  const rebaseline = identity.rebaseline === true
  let db = null
  let degradedFired = false

  const close = () => {
    if (db) db.close()
    db = null
  }

  const handle = () => {
    if (!db) db = openLedger({ pluginData, realmId, policy, explicit, rebaseline })
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

export { REBASELINE_ENV, POLICY_KEYS }
