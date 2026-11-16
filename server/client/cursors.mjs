// Story 2.1 — the per-session cursor file, schema v2.
//
// One file per Session Scope at PLUGIN_DATA/sessions/<scope>/cursors.json,
// keyed by realm and then by room:
//
//   { version: 2,
//     realms: { <realm_id>: { rooms: { <room_id>: {
//       read_seq, notified_seq, updated_at } } } } }
//
// TWO positions, deliberately separated:
//   read_seq     — how far this session has DELIVERED to a reader. Advanced
//                  by `agent-room read` after its stdout flush, and by the
//                  MCP adapter after a successful message_read.
//   notified_seq — how far this session has WOKEN or NOTIFIED on. Owned by
//                  the wake/notification paths (Stories 3.2+). A read never
//                  moves it: having seen a message is not the same as having
//                  been notified about it, and conflating the two is how a
//                  woken agent silently loses its pending wake.
//
// CONCURRENCY: two processes of one scope (the MCP adapter and a one-shot
// CLI) both read-modify-write this file. Every write takes
// sessions/<scope>/cursors.lock (O_CREAT|O_EXCL, 0600) and does
// reload -> merge with Math.max -> atomic write -> unlock, so a slower writer
// can never move a position backwards or drop another's rooms.
//
// MIGRATION: a v1 file ({realm_id, cursors: {room: {after_seq}}}) migrates
// once to v2 with read_seq = after_seq, notified_seq = 0. A CORRUPT v1 file
// is moved aside to cursors.v1.corrupt-<ts>.json (0600) and the scope starts
// with an empty v2 — a reader is never stopped by a file it can repair
// around. A v2 file with the wrong version is this module's own format, so it
// refuses loudly instead of silently resetting a live position.

import {
  closeSync,
  existsSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { join } from 'node:path'

import { CURSOR_FILE_MAX_BYTES, CURSOR_LOCK_STALE_MS, CURSOR_LOCK_WAIT_MS } from '../constants.mjs'
import { AgentRoomRuntimeError, assertSafePathKey, atomicWriteJson, isPidAlive, readJsonFile } from '../runtime.mjs'
import { sessionScopeFilePath, sessionScopeKey } from './session-state.mjs'

export const CURSORS_SCHEMA_VERSION = 2
export const CURSORS_FILENAME = 'cursors.json'
export const CURSOR_LOCK_FILENAME = 'cursors.lock'

const ROOM_KEY_MAX = 200

function assertRealmKey(realmId) {
  return assertSafePathKey(realmId, { label: 'realm id' })
}

function assertRoomKey(roomId) {
  return assertSafePathKey(roomId, { maxLength: ROOM_KEY_MAX, label: 'room id' })
}

const isSeq = value => Number.isSafeInteger(value) && value >= 0

const sleepMs = ms => new Promise(resolve => { setTimeout(resolve, ms) })

export function scopeCursorsPath(pluginDataDir, { env = process.env } = {}) {
  return sessionScopeFilePath(pluginDataDir, sessionScopeKey({ env, pluginDataDir }), CURSORS_FILENAME)
}

export function cursorLockPath(pluginDataDir, { env = process.env } = {}) {
  return sessionScopeFilePath(pluginDataDir, sessionScopeKey({ env, pluginDataDir }), CURSOR_LOCK_FILENAME)
}

// The legacy installation-wide file, still read ONLY as a first-session seed.
export function persistedCursorPath(pluginDataDir, realmId) {
  return join(pluginDataDir, 'realms', assertRealmKey(realmId), 'cursors.json')
}

// --- lock -------------------------------------------------------------------

function lockIsStale(lockPath) {
  let info
  try {
    info = statSync(lockPath)
  } catch {
    return false
  }
  const ageMs = Date.now() - info.mtimeMs
  if (ageMs < CURSOR_LOCK_STALE_MS) return false
  let holderPid = null
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf8'))
    if (Number.isSafeInteger(parsed?.pid)) holderPid = parsed.pid
  } catch { /* unreadable: reclaimable once past the stale age */ }
  return holderPid === null || !isPidAlive(holderPid)
}

function reclaimLock(lockPath) {
  const stalePath = `${lockPath}.stale-${process.pid}-${Date.now()}`
  try {
    renameSync(lockPath, stalePath)
  } catch {
    return false
  }
  try { unlinkSync(stalePath) } catch { /* best-effort */ }
  return true
}

// Acquire the scope's cursor lock. Waits up to CURSOR_LOCK_WAIT_MS, then
// refuses loudly: a caller that cannot take the lock must not write a
// position on top of another process's.
export async function withCursorLock(pluginDataDir, fn, { env = process.env } = {}) {
  const lockPath = cursorLockPath(pluginDataDir, { env })
  const deadline = Date.now() + CURSOR_LOCK_WAIT_MS
  for (;;) {
    let descriptor
    try {
      descriptor = openSync(lockPath, 'wx', 0o600)
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      if (lockIsStale(lockPath)) reclaimLock(lockPath)
      if (Date.now() >= deadline) {
        throw new AgentRoomRuntimeError('cursors_lock_busy', 'cursors.lock busy')
      }
      await sleepMs(10)
      continue
    }
    try {
      writeSync(descriptor, `${JSON.stringify({ pid: process.pid, created_at: new Date().toISOString() })}\n`)
    } finally {
      closeSync(descriptor)
    }
    break
  }
  try {
    return await fn()
  } finally {
    try { unlinkSync(lockPath) } catch { /* another process reclaimed it */ }
  }
}

// --- read -------------------------------------------------------------------

const emptyDocument = () => ({ version: CURSORS_SCHEMA_VERSION, realms: {} })

function normalizeV2(value) {
  const realms = {}
  const storedRealms = value.realms && typeof value.realms === 'object' ? value.realms : {}
  for (const [realmId, realmEntry] of Object.entries(storedRealms)) {
    if (!realmEntry || typeof realmEntry !== 'object') continue
    const storedRooms = realmEntry.rooms && typeof realmEntry.rooms === 'object' ? realmEntry.rooms : {}
    const rooms = {}
    for (const [roomId, entry] of Object.entries(storedRooms)) {
      if (!entry || typeof entry !== 'object') continue
      if (!isSeq(entry.read_seq) && !isSeq(entry.notified_seq)) continue
      rooms[roomId] = {
        read_seq: isSeq(entry.read_seq) ? entry.read_seq : 0,
        notified_seq: isSeq(entry.notified_seq) ? entry.notified_seq : 0,
        updated_at: typeof entry.updated_at === 'string' ? entry.updated_at : null,
      }
    }
    realms[realmId] = { rooms }
  }
  return { version: CURSORS_SCHEMA_VERSION, realms }
}

// v1 -> v2 in memory: after_seq becomes read_seq, notified_seq starts at 0.
export function migrateV1Cursors(value, realmId) {
  const realms = {}
  const stored = value && typeof value === 'object' && value.cursors && typeof value.cursors === 'object'
    ? value.cursors
    : {}
  const rooms = {}
  for (const [roomId, entry] of Object.entries(stored)) {
    if (!isSeq(entry?.after_seq)) continue
    rooms[roomId] = { read_seq: entry.after_seq, notified_seq: 0, updated_at: null }
  }
  if (typeof realmId === 'string' && realmId.length > 0) realms[realmId] = { rooms }
  return { version: CURSORS_SCHEMA_VERSION, realms }
}

// Read the scope's cursor document, migrating or quarantining a v1 file.
// A MISSING file is an empty document and is never written here — a cursor
// file appears only through an actual position.
export function readCursorsDocument(pluginDataDir, { realmId = null, env = process.env } = {}) {
  const path = scopeCursorsPath(pluginDataDir, { env })
  if (!existsSync(path)) return { document: emptyDocument(), path, migrated: false }
  let raw
  try {
    raw = readJsonFile(path, { maxBytes: CURSOR_FILE_MAX_BYTES })
  } catch {
    // Unparsable: a corrupt v1 file is repaired around, never a stopped
    // reader. Move it aside and start clean.
    const backup = `${path}.v1.corrupt-${Date.now()}.json`
    try { renameSync(path, backup) } catch { /* best-effort */ }
    return { document: emptyDocument(), path, migrated: false, quarantined: backup }
  }
  if (raw && typeof raw === 'object' && raw.version === CURSORS_SCHEMA_VERSION) {
    return { document: normalizeV2(raw), path, migrated: false }
  }
  if (raw && typeof raw === 'object' && raw.cursors && typeof raw.cursors === 'object') {
    const sourceRealm = typeof raw.realm_id === 'string' ? raw.realm_id : realmId
    return { document: migrateV1Cursors(raw, sourceRealm), path, migrated: true }
  }
  throw new AgentRoomRuntimeError(
    'cursors_schema_invalid',
    `cursors.json version ${raw?.version ?? 'unknown'} is not supported (expected ${CURSORS_SCHEMA_VERSION})`,
  )
}

// roomId -> {read_seq, notified_seq} for one realm, read-only.
export function loadCursors(pluginDataDir, realmId, { env = process.env } = {}) {
  const { document } = readCursorsDocument(pluginDataDir, { realmId, env })
  const rooms = document.realms[assertRealmKey(realmId)]?.rooms ?? {}
  const cursors = new Map()
  for (const [roomId, entry] of Object.entries(rooms)) cursors.set(roomId, { ...entry })
  return cursors
}

// Back-compatible reader: roomId -> read_seq. The notifier's startup
// catch-up and the `wait` baselines both want exactly this shape, and both
// must never advance it. Reads the v2 document (migrating v1 on the way).
export function loadPersistedCursors(pluginDataDir, realmId, { env = process.env } = {}) {
  const positions = new Map()
  for (const [roomId, entry] of loadCursors(pluginDataDir, realmId, { env })) {
    positions.set(roomId, entry.read_seq)
  }
  return positions
}

// The path the MCP adapter and the CLI both key on for this process.
export const sessionCursorPath = scopeCursorsPath

// --- write ------------------------------------------------------------------

// Advance one position. `field` is 'read_seq' or 'notified_seq'; the write is
// reload-modify-Math.max-atomic under the scope lock, so concurrent writers
// converge on the highest position and neither loses the other's rooms.
export async function advanceCursor(
  pluginDataDir,
  { realmId, roomId, seq, field = 'read_seq' },
  { env = process.env } = {},
) {
  const validRealm = assertRealmKey(realmId)
  const validRoom = assertRoomKey(roomId)
  if (field !== 'read_seq' && field !== 'notified_seq') {
    throw new AgentRoomRuntimeError('invalid_request', `unknown cursor field ${field}`)
  }
  if (!isSeq(seq)) {
    throw new AgentRoomRuntimeError('invalid_request', 'seq must be a non-negative safe integer')
  }
  return withCursorLock(pluginDataDir, () => {
    const { document, path } = readCursorsDocument(pluginDataDir, { realmId: validRealm, env })
    const realm = document.realms[validRealm] ?? { rooms: {} }
    const entry = realm.rooms[validRoom] ?? { read_seq: 0, notified_seq: 0, updated_at: null }
    const updated = { ...entry, [field]: Math.max(entry[field], seq), updated_at: new Date().toISOString() }
    realm.rooms[validRoom] = updated
    document.realms[validRealm] = realm
    atomicWriteJson(path, document)
    return updated
  }, { env })
}
