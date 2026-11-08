// The held-row wake ledger, SQLite-backed (policy closed 2026-11-02:
// docs/implementation/reviews/wake-ledger-policy-closure.md; the v0.8.0
// review-round closures below carry the codex gate's A1 findings).
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
// POLICY AUTHORITY (the round-4 closure): the RECORD is the authority. The
// effective tuple recorded in `meta` — not the caller's captured environment
// — drives every decision's arithmetic, re-read inside the same
// BEGIN IMMEDIATE section as the charge, so a process that opened before an
// adoption can never spend the old budget after the record changed. The
// caller's own policy matters only at open (the agreement check below) and
// as the EXPLICIT layer: values pinned through AGENT_ROOM_WAKE_* must agree
// with the record's pins, or the open AND every decision refuse until an
// explicit AGENT_ROOM_WAKE_POLICY_REBASELINE=1 run rewrites the record. An
// UNPINNED process never rewrites a record that carries pins (an operator's
// pin cannot be washed by a process that simply does not set the variable),
// and adoption of drifted defaults happens only when neither side pins
// anything. A rebaseline is recorded (`rebaselined_at`) and re-running it
// with the same policy is a no-op, not a second authority flip.
//
// RESTARTABLE MIGRATION: the v1 JSON import is decided by a `meta` marker
// written in the SAME transaction as the imported rows — a process that died
// between file creation and import resumes rather than skips. The archive
// rename is the idempotent cleanup that follows a COMMITTED marker, never
// an unreadability: a legacy file that exists but cannot be READ refuses the
// open (the REFUSE-don't-repair posture) and is left exactly where it is.
//
// FAILURE POSTURE (closure D1/D3), in one place so it cannot drift:
//   - no ledger yet            -> healthy, create it, charge normally
//   - readable but unusable    -> REFUSE the wake, never mutate the file
//     (bad schema, unsupported version, unsafe path, CORRUPT/NOTADB, a
//     policy disagreement, an unparseable OR unreadable legacy state)
//   - transient (busy/locked/  -> allow AT MOST ONE uncharged degraded hint
//     io error/disk full)         per process per episode, then suppress
// The alternative — failing open on an unreadable ledger — turns "someone
// tampered with my budget file" into "wake without limit".
//
// FAULT CLASSIFICATION: node:sqlite reports native errors as
// `code: 'ERR_SQLITE_ERROR'` with a NUMERIC `errcode` (5 BUSY, 6 LOCKED,
// 11 CORRUPT, 26 NOTADB); the string forms are kept as a fallback. The
// classifier below is the one mapping, and it is pinned by tests for both
// shapes — the release's fault contract rides on it.
//
// BOUNDED WAIT, HONESTLY STATED: with `busy_timeout = 50ms` and at most four
// BEGIN IMMEDIATE attempts the RETRY ARITHMETIC is bounded (~200ms of
// waiting), but that is not a measured hard disk-I/O deadline — a stalled
// disk can stall a decision longer. ponytail: revisit with a worker only if
// a measured p99 here ever crosses the 500ms decision budget.

import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, renameSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import { AgentRoomRuntimeError } from '../runtime.mjs'

const SCHEMA_VERSION = 1
const BUSY_TIMEOUT_MS = 50
const MAX_ATTEMPTS = 4
const SQLITE_BUSY = new Set(['SQLITE_BUSY', 'SQLITE_LOCKED'])
const SQLITE_REFUSE = new Set(['SQLITE_CORRUPT', 'SQLITE_NOTADB'])
// node:sqlite native errcodes (the strings ride error.code only in some
// builds; the numbers are the contract).
const ERR_BUSY = new Set([5, 6]) // SQLITE_BUSY, SQLITE_LOCKED
const ERR_REFUSE = new Set([11, 26]) // SQLITE_CORRUPT, SQLITE_NOTADB

const refuse = reason => new AgentRoomRuntimeError('ledger_refused', reason)
const transient = () => new AgentRoomRuntimeError('ledger_transient', 'the wake ledger is temporarily unavailable')

// One fault classifier for every SQLite error this ledger touches: 'busy'
// retries, 'refuse' suppresses without mutating, anything else falls into the
// transient/degraded lane. Pinned by tests for BOTH the native shape
// (ERR_SQLITE_ERROR + numeric errcode) and the legacy string shape.
export function classifySqliteFault(error) {
  if (error?.code === 'ERR_SQLITE_ERROR' || typeof error?.errcode === 'number') {
    if (ERR_BUSY.has(error.errcode)) return 'busy'
    if (ERR_REFUSE.has(error.errcode)) return 'refuse'
    return 'other'
  }
  const code = error?.code ?? error?.errcode ?? ''
  if (SQLITE_REFUSE.has(code)) return 'refuse'
  if (SQLITE_BUSY.has(code)) return 'busy'
  return 'other'
}

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

// Open the raw database. The schema-version check runs BEFORE any pragma or
// DDL — an unknown-schema ledger is refused with nothing written, not
// decorated first. A meta table that does not exist yet means "new ledger".
function openDatabase(path) {
  const db = new DatabaseSync(path)
  // SQLite creates with the process umask (0644 on most hosts). The directory
  // is 0700 already, but the closure requires the file itself to be 0600 and
  // `assertSafeFile` refuses it on the next open if it is not.
  chmodSync(path, 0o600)
  let version = null
  try {
    const row = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
    version = row?.value ?? null
  } catch {
    version = null // no meta table yet: a new ledger
  }
  if (version !== null && version !== String(SCHEMA_VERSION)) {
    db.close()
    throw refuse(`unsupported wake ledger schema ${version}`)
  }
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

// Read and validate the legacy v1 JSON state. ENOENT means "no legacy state"
// (null — nothing to import); ANY OTHER read failure refuses the open (an
// authority that cannot be read is not skipped and certainly not archived);
// an unparseable or wrong-version file refuses exactly as before. Throwing
// here refuses on every subsequent open until the file is fixed or removed.
function legacyRows(statePath) {
  let raw
  try {
    raw = readFileSync(statePath, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return null
    throw refuse(`the legacy wake state cannot be read (${error?.code ?? 'error'})`)
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
// import. Returns the AUTHORITATIVE tuple every decision must use (the
// record's), together with its recorded explicit layer. `explicit` maps
// POLICY_KEYS to the values THIS process pinned via the environment
// ({ key: effectiveValue } — a junk override's effective value, since that
// is what its candidate decisions actually use); `rebaseline` is the flagged
// overwrite, recorded so re-running it with the same policy is a no-op.
function verifyPolicyAgreement(db, { policy, explicit, rebaseline }) {
  const getMeta = db.prepare('SELECT value FROM meta WHERE key = ?')
  const storedRow = getMeta.get('policy')
  const explicitRow = getMeta.get('policy_explicit')

  const putMeta = db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)')
  const record = (effective, pinned) => {
    putMeta.run('policy', JSON.stringify(effective))
    putMeta.run('policy_explicit', JSON.stringify(pinned))
  }

  if (storedRow === undefined) {
    record(policy, explicit)
    return { tuple: { ...policy }, storedExplicit: { ...explicit } }
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
    // A re-baseline that changes nothing is a no-op — the flag stays safe to
    // leave set across restarts without the record flip-flopping.
    if (JSON.stringify(stored) !== JSON.stringify(policy) || JSON.stringify(storedExplicit) !== JSON.stringify(explicit)) {
      record(policy, explicit)
      putMeta.run('rebaselined_at', new Date().toISOString())
    }
    return { tuple: { ...policy }, storedExplicit: { ...explicit } }
  }
  // Only the explicit layer conflicts — and only pin against pin, or a NEW
  // pin against the recorded effective value: a process that pins nothing
  // never conflicts (it will simply run on the record's authoritative tuple).
  for (const key of POLICY_KEYS) {
    const pinnedNow = explicit[key]
    if (pinnedNow === undefined) continue
    const thenValue = storedExplicit[key] ?? stored[key]
    if (thenValue !== pinnedNow) {
      throw refuse(
        `wake ledger policy disagreement on ${key}: the ledger was written with ${key}=${thenValue}`
        + ` and this process pins ${key}=${pinnedNow}`
        + ` — align the AGENT_ROOM_WAKE_* environment across every process using this installation`
        + `, or set ${REBASELINE_ENV}=1 for one run to accept the new policy on record`,
      )
    }
  }
  const pinnedStored = POLICY_KEYS.some(key => storedExplicit[key] !== undefined)
  const pinnedNow = POLICY_KEYS.some(key => explicit[key] !== undefined)
  if (pinnedNow) {
    // A process that pins values re-asserts the record with its own pins
    // (the conflict check above passed). It becomes the recorded authority.
    if (JSON.stringify(stored) !== JSON.stringify(policy) || JSON.stringify(storedExplicit) !== JSON.stringify(explicit)) {
      record(policy, explicit)
    }
    return { tuple: { ...policy }, storedExplicit: { ...explicit } }
  }
  if (!pinnedStored) {
    // Neither side pins anything: a defaults-only drift is adopted and
    // recorded — an unattended gate that silently stops waking after an
    // upgrade is worse than a recorded adoption.
    if (JSON.stringify(stored) !== JSON.stringify(policy)) {
      record(policy, storedExplicit)
    }
    return { tuple: { ...policy }, storedExplicit: { ...storedExplicit } }
  }
  // The record carries pins and this process pins nothing: the pins — and
  // their effective tuple — stay the authority until an explicit re-baseline.
  // An unpinned process can never wash them.
  return { tuple: { ...stored }, storedExplicit: { ...storedExplicit } }
}

// One init pass under BEGIN IMMEDIATE: stamp the schema version, import the
// legacy JSON exactly once (decided by the marker, never by file existence),
// and settle the policy agreement. Every open runs it; every step inside is
// idempotent, so a process that died mid-flight resumes rather than skips.
// Returns whether a committed import marker is present — the ONLY state the
// archive cleanup may act on.
function initLedger(db, { legacyPath, policy, explicit, rebaseline }) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const versionRow = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version')
    if (!versionRow) {
      db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', String(SCHEMA_VERSION))
    } else if (versionRow.value !== String(SCHEMA_VERSION)) {
      throw refuse(`unsupported wake ledger schema ${versionRow.value}`)
    }
    let markerRow = db.prepare('SELECT value FROM meta WHERE key = ?').get('imported_from_json')
    if (markerRow === undefined && existsSync(legacyPath)) {
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
        markerRow = db.prepare('SELECT value FROM meta WHERE key = ?').get('imported_from_json')
      }
    }
    const agreement = verifyPolicyAgreement(db, { policy, explicit, rebaseline })
    db.exec('COMMIT')
    return { markerPresent: markerRow !== undefined, ...agreement }
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
    const { markerPresent, tuple, storedExplicit } = initLedger(db, { legacyPath, policy, explicit, rebaseline })
    // The rename is the commit's idempotent cleanup, guarded by the COMMITTED
    // marker: a process that died between COMMIT and rename re-lands here and
    // archives the file; a legacy file that exists WITHOUT a marker (for
    // example one that cannot be read) is never touched.
    if (markerPresent && existsSync(legacyPath) && !existsSync(`${legacyPath}.imported`)) {
      try { renameSync(legacyPath, `${legacyPath}.imported`) } catch { /* raced with the other process's rename */ }
    }
    return { db, tuple, storedExplicit }
  } catch (error) {
    db.close()
    throw error
  }
}

// One held-row wake decision. `true` means the wake may fire and the ledger has
// already been charged for it; `false` means this sender is cooling down, the
// budget is spent, or the ledger could not be trusted — and in the last case
// nothing was written. The ARITHMETIC always runs on the record's current
// tuple (re-read inside this transaction), so a process that opened before an
// adoption or re-baseline can never spend the old budget.
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
    if (!db) {
      const opened = openLedger({ pluginData, realmId, policy, explicit, rebaseline })
      db = opened.db
    }
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
        // The authoritative tuple, re-read per decision; an explicit-pin
        // disagreement refuses the charge rather than honoring stale state.
        let tuple
        try {
          const storedRow = active.prepare('SELECT value FROM meta WHERE key = ?').get('policy')
          const explicitRow = active.prepare('SELECT value FROM meta WHERE key = ?').get('policy_explicit')
          const stored = JSON.parse(storedRow.value)
          const storedExplicit = explicitRow === undefined ? {} : JSON.parse(explicitRow.value)
          if (!POLICY_KEYS.every(key => Number.isSafeInteger(stored?.[key]) && stored[key] > 0)
            || storedExplicit === null || typeof storedExplicit !== 'object' || Array.isArray(storedExplicit)) {
            active.exec('ROLLBACK')
            return false
          }
          for (const key of POLICY_KEYS) {
            const pinnedBefore = storedExplicit[key]
            const pinnedNow = explicit[key]
            if (pinnedBefore === undefined && pinnedNow === undefined) continue
            if ((pinnedBefore ?? stored[key]) !== (pinnedNow ?? stored[key])) {
              active.exec('ROLLBACK')
              return false
            }
          }
          tuple = stored
        } catch (error) {
          if (error?.code === 'ledger_refused') throw error
          active.exec('ROLLBACK')
          return false
        }
        const cutoff = now - tuple.windowMs
        // Bounded state: senders past their cooldown can never cool anything,
        // and events older than the window can never spend the budget.
        active.prepare('DELETE FROM wake_event WHERE at < ?').run(cutoff)
        active.prepare('DELETE FROM sender_wake WHERE last_at < ?').run(now - tuple.cooldownMs)
        const sender = active.prepare('SELECT last_at FROM sender_wake WHERE fingerprint = ?').get(fingerprint)
        const spent = active.prepare('SELECT COUNT(*) AS n FROM wake_event WHERE at >= ?').get(cutoff).n
        if (sender && now - sender.last_at < tuple.cooldownMs) {
          active.exec('ROLLBACK')
          degradedFired = false
          return false
        }
        if (spent >= tuple.budget) {
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
        const verdict = classifySqliteFault(error)
        if (verdict === 'refuse') {
          close()
          return false
        }
        if (verdict === 'busy' && attempt < MAX_ATTEMPTS) continue
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
