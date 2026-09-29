// The per-realm held pipeline (Story 3.3, FR-10/FR-20/AR-12): the durable,
// metadata-only record of the messages Story 3.2's trust matrix held, plus a
// bounded body cache so the human approval surface (Story 3.4's CLI) can show
// a full preview without immediately re-reading the log.
//
// The two halves of every held record:
//
//   1. THE RECORD (metadata) — realm, sender Chat ID, Actor key fingerprint,
//      room, sequence, time, byte size, and the matrix reason. This is the
//      only half any AGENT-visible surface shows. It survives everything:
//      eviction, restarts, cursor movement. Eviction never deletes, approves,
//      or skips a held message — the record is never removed except by an
//      explicit human release (heldClear). There is no auto-approve anywhere.
//   2. THE BODY CACHE (a copy of the body artifact the delivery pipeline
//      withheld) — bounded at HELD_CACHE_MAX entries, drop-oldest by caching
//      time. When the copy is gone (evicted), heldBody recovers the body by a
//      point read against the room log (after_seq = seq − 1, limit = 1) —
//      recovery never depends on the cache, because the durable log is the
//      protocol. The body copy and the recovery result are FOR THE HUMAN
//      SURFACE ONLY: no MCP tool reaches into this module's body paths, so
//      no agent-visible result can ever carry a held body byte.
//
// Why the cached copy is the delivery pipeline's body artifact (for a held
// foreign sender, the untrusted-envelope-wrapped text) rather than the raw
// log text: the pipeline holds exactly that artifact back from the agent, and
// the recovery point read goes through the same api-client read path, so the
// cached and recovered forms are byte-identical by construction — the preview
// shows the same honest framing whichever path served it.
//
// Cursor independence (FR-20's invariant, this module's structural half): the
// held state is a SEPARATE file from the cursors, keyed (realm, room, seq).
// Nothing here reads or writes a cursor, and the cursor machinery never reads
// this file — a held message never stalls the cursor, and advancing the
// cursor never loses held state. The MCP adapter registers held rows AFTER
// the cursor persists, so a registration failure can never block a consumed
// page and the cursor advance can never be blamed on held state.
//
// Storage mirrors the cursor and allowlist machinery exactly: one bounded,
// atomically rewritten 0600 JSON file per realm at
// PLUGIN_DATA/realms/<realm_id>/held.json inside the 0700 realm directory. A
// missing or corrupt file is the default state (no held records) and never
// blocks a read. Read-modify-write cycles are serialized through a per-realm
// promise chain — the cursor chain's discipline — so concurrent registrations
// and releases can never lose each other's writes; reads (list, count, body)
// stay off the chain because atomic renames give them a whole old-or-new file.

import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  HELD_CACHE_MAX,
  HELD_STATE_MAX_BYTES,
  IDENTIFIER_MAX,
  REALM_KEY_PATTERN,
} from '../constants.mjs'
import { AgentRoomRuntimeError, atomicWriteJson, readJsonFile } from '../runtime.mjs'

// --- State shape ----------------------------------------------------------------
//
// {
//   version: 1,
//   entries: [                     // registration order; heldList sorts
//     {
//       room_id, seq,              // the (realm, room, seq) key — seq unique per room
//       chat_id,                   // sender Chat ID at send time (label, never trust)
//       actor_fingerprint,         // sender Actor key fingerprint (why it was held)
//       created_at,                // the message's send time
//       size,                      // byte length of the withheld body artifact
//       held_reason,               // the trust matrix's recorded reason
//       registered_at,             // the record's original registration moment
//       body,                      // cached body copy — present ONLY while cached
//       cached_at,                 // present iff body is (eviction's ordering clock)
//     },
//   ],
// }

function assertRealmKey(realmId) {
  if (typeof realmId !== 'string' || !REALM_KEY_PATTERN.test(realmId)) {
    throw new AgentRoomRuntimeError(
      'invalid_request',
      'the agent-room realm id is not a safe state key; refusing to build a held-state path from it',
    )
  }
  return realmId
}

function assertRoomId(roomId) {
  if (typeof roomId !== 'string' || roomId.length < 1 || roomId.length > IDENTIFIER_MAX) {
    throw new AgentRoomRuntimeError('invalid_request', 'a held record keys on a room id (1-128 characters)')
  }
  return roomId
}

function assertSeq(seq) {
  if (!Number.isSafeInteger(seq) || seq < 1) {
    throw new AgentRoomRuntimeError('invalid_request', 'a held record keys on a positive message sequence')
  }
  return seq
}

export function heldFilePath(pluginData, realmId) {
  return join(pluginData, 'realms', assertRealmKey(realmId), 'held.json')
}

// The default realm state: no held records. Like the allowlist, "never a
// default entry" is the point — records exist only because the matrix held a
// real delivery-time row.
export function emptyHeldState() {
  return Object.freeze({ version: 1, entries: Object.freeze([]) })
}

// Normalize one stored row. Malformed rows are dropped, never surfaced: a
// hand-mangled file degrades toward the default, and a row without its
// (room_id, seq) key is inert anyway. The body copy survives normalization
// only together with its caching time, so eviction always has a clock to
// read; an orphaned body (cached_at lost to mangling) is dropped — a safe
// degradation, because the durable log can always serve recovery.
function normalizeEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  if (typeof value.room_id !== 'string' || value.room_id.length === 0) return null
  if (!Number.isSafeInteger(value.seq) || value.seq < 1) return null
  const entry = {
    room_id: value.room_id,
    seq: value.seq,
    chat_id: typeof value.chat_id === 'string' ? value.chat_id : null,
    actor_fingerprint: typeof value.actor_fingerprint === 'string' ? value.actor_fingerprint : null,
    created_at: typeof value.created_at === 'string' ? value.created_at : null,
    size: Number.isSafeInteger(value.size) && value.size >= 0 ? value.size : null,
    held_reason: typeof value.held_reason === 'string' ? value.held_reason : null,
    registered_at: typeof value.registered_at === 'string' ? value.registered_at : null,
  }
  if (typeof value.body === 'string' && typeof value.cached_at === 'string') {
    entry.body = value.body
    entry.cached_at = value.cached_at
  }
  return entry
}

// Load one realm's held state. A missing file is the default (and a read
// never creates the file); a corrupt or over-bound file degrades to the
// default and is replaced by the next write — a broken state file never
// blocks a read, exactly like cursors and the allowlist.
export function loadHeldState(pluginData, realmId) {
  const path = heldFilePath(pluginData, realmId)
  if (!existsSync(path)) return emptyHeldState()
  try {
    const value = readJsonFile(path, { maxBytes: HELD_STATE_MAX_BYTES })
    if (!value || typeof value !== 'object' || Array.isArray(value)) return emptyHeldState()
    const rawEntries = Array.isArray(value.entries) ? value.entries : []
    const entries = []
    for (const raw of rawEntries) {
      const entry = normalizeEntry(raw)
      if (entry !== null) entries.push(entry)
    }
    return { version: 1, entries }
  } catch {
    return emptyHeldState()
  }
}

// --- The metadata-only projection -------------------------------------------------
//
// The whitelist that makes "metadata only" structural rather than policed:
// an agent-visible held row is BUILT from this field list, so the body copy,
// its caching time, and the registration bookkeeping are absent by
// construction — there is no downstream filter that could regress.

export function heldMetadataRow(realmId, entry) {
  return {
    realm_id: realmId,
    room_id: entry.room_id,
    seq: entry.seq,
    chat_id: entry.chat_id,
    actor_fingerprint: entry.actor_fingerprint,
    created_at: entry.created_at,
    size: entry.size,
    held_reason: entry.held_reason,
  }
}

function compareEntries(left, right) {
  if (left.room_id !== right.room_id) return left.room_id < right.room_id ? -1 : 1
  return left.seq - right.seq
}

function assertRoomFilter(roomId) {
  if (roomId === undefined) return undefined
  if (typeof roomId !== 'string' || roomId.length < 1 || roomId.length > IDENTIFIER_MAX) {
    throw new AgentRoomRuntimeError('invalid_request', 'the held room filter must be a room id (1-128 characters)')
  }
  return roomId
}

// The metadata-only list (the tool surface's source): every held record of the
// realm — or of one room when filtered — projected through
// heldMetadataRow and sorted by (room_id, seq) for a deterministic listing.
// The list is NOT bounded by the body cache's cap: eviction drops only the
// cached body copies, so the listing shows every unreleased held message.
export function heldList(pluginData, realmId, { roomId } = {}) {
  assertRoomFilter(roomId)
  const state = loadHeldState(pluginData, realmId)
  return state.entries
    .filter(entry => roomId === undefined || entry.room_id === roomId)
    .sort(compareEntries)
    .map(entry => heldMetadataRow(realmId, entry))
}

// The held count for the realm (or one room when filtered) — the FR-10
// metadata field shared by every held surface.
export function heldCount(pluginData, realmId, { roomId } = {}) {
  assertRoomFilter(roomId)
  const state = loadHeldState(pluginData, realmId)
  return state.entries.filter(entry => roomId === undefined || entry.room_id === roomId).length
}

// --- Registration (the MCP adapter's message_read is the only writer) -------------

function prepareHeldRows(roomId, rows) {
  if (!Array.isArray(rows)) {
    throw new AgentRoomRuntimeError('invalid_request', 'held registration takes an array of message rows')
  }
  const prepared = []
  for (const row of rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) {
      throw new AgentRoomRuntimeError('invalid_request', 'a held row must be a message-shaped object')
    }
    assertSeq(row.seq)
    if (typeof row.text !== 'string') {
      throw new AgentRoomRuntimeError(
        'invalid_request',
        'a held record caches the exact body artifact the pipeline withheld; refusing to register a row without it',
      )
    }
    if (typeof row.room_id === 'string' && row.room_id !== roomId) {
      throw new AgentRoomRuntimeError('invalid_request', 'a held row cannot register into a different room')
    }
    prepared.push({
      room_id: roomId,
      seq: row.seq,
      chat_id: typeof row.chat_id === 'string' ? row.chat_id : null,
      actor_fingerprint: typeof row.actor_fingerprint === 'string' ? row.actor_fingerprint : null,
      created_at: typeof row.created_at === 'string' ? row.created_at : null,
      size: Buffer.byteLength(row.text, 'utf8'),
      held_reason: typeof row.held_reason === 'string' ? row.held_reason : 'unspecified',
      body: row.text,
    })
  }
  return prepared
}

// Evict cached body copies past HELD_CACHE_MAX, oldest cached_at first (list
// position breaks same-millisecond ties). Only the BODY COPY is dropped: the
// record's metadata, marker provenance, and key all survive, so eviction
// never deletes, approves, or skips a held message — it only bounds how much
// of the log the local cache remembers before recovery must point-read.
function evictBodiesPastCap(entries) {
  const cached = entries
    .map((entry, index) => ({ entry, index }))
    .filter(item => typeof item.entry.body === 'string')
    .sort((left, right) => {
      if (left.entry.cached_at !== right.entry.cached_at) {
        return left.entry.cached_at < right.entry.cached_at ? -1 : 1
      }
      return left.index - right.index
    })
  for (let position = 0; position < cached.length - HELD_CACHE_MAX; position += 1) {
    delete cached[position].entry.body
    delete cached[position].entry.cached_at
  }
  return entries
}

// One serialized read-modify-write chain per realm (the cursor chain's
// discipline): concurrent registrations and releases of the same realm queue
// behind each other in arrival order, so a later write never races an
// earlier one's read. Reads stay off the chain — atomic renames hand them a
// whole old-or-new file.
const heldChains = new Map()

function queueHeldWrite(realmId, operation) {
  const previous = heldChains.get(realmId) ?? Promise.resolve()
  const next = previous.catch(() => { /* a failed write must not poison the chain */ }).then(operation)
  heldChains.set(realmId, next)
  return next
}

// Register the held rows of one read page. `rows` are the RAW (pre-matrix)
// message rows whose matrix evaluation came back held, each carrying its
// matrix reason — the adapter pairs them index-for-index with the matrix
// output, so row.text is exactly the body artifact the tool result withheld.
// Idempotent per (room, seq): a re-delivered held message refreshes its
// cached copy in place and keeps the record's original registered_at.
// Returns { registered, held_count } — new records added and the realm's
// current total (which the read result's consumers may compare against
// heldCount, never against the body cache's cap). Every refusal (unsafe
// realm key, bad room, malformed row) surfaces as a REJECTED promise: the
// adapter awaits this function, and a refusal must never escape as a
// synchronous throw past the consumed page's error handling.
export function registerHeldMessages(pluginData, realmId, roomId, rows) {
  return queueHeldWrite(realmId, () => {
    assertRealmKey(realmId)
    assertRoomId(roomId)
    const prepared = prepareHeldRows(roomId, rows)
    if (prepared.length === 0) {
      return { registered: 0, held_count: heldCount(pluginData, realmId) }
    }
    const state = loadHeldState(pluginData, realmId)
    const entries = state.entries.map(entry => ({ ...entry }))
    const now = new Date().toISOString()
    let registered = 0
    for (const row of prepared) {
      const existing = entries.findIndex(entry => entry.room_id === row.room_id && entry.seq === row.seq)
      if (existing >= 0) {
        entries[existing] = {
          ...entries[existing],
          chat_id: row.chat_id,
          actor_fingerprint: row.actor_fingerprint,
          created_at: row.created_at,
          size: row.size,
          held_reason: row.held_reason,
          body: row.body,
          cached_at: now,
        }
      } else {
        entries.push({
          room_id: row.room_id,
          seq: row.seq,
          chat_id: row.chat_id,
          actor_fingerprint: row.actor_fingerprint,
          created_at: row.created_at,
          size: row.size,
          held_reason: row.held_reason,
          registered_at: now,
          body: row.body,
          cached_at: now,
        })
        registered += 1
      }
    }
    atomicWriteJson(heldFilePath(pluginData, realmId), {
      version: 1,
      entries: evictBodiesPastCap(entries),
    })
    return { registered, held_count: entries.length }
  })
}

// --- Release (the human CLI's writer; no tool reaches this) ------------------------

// Remove one held record — the approve/release action. The record (and with
// it the cached body copy and every future recovery of that preview) goes
// away: a released message is never held again at its seq, and its body is
// never shown again. Returns whether a record was removed (idempotent).
// This is deliberately reachable from NO agent tool: release is the human's
// one-step decision (Story 3.4's CLI), and no auto-approve exists anywhere.
// Refusals surface as rejected promises, like registration's.
export function heldClear(pluginData, realmId, roomId, seq) {
  return queueHeldWrite(realmId, () => {
    assertRealmKey(realmId)
    assertRoomId(roomId)
    assertSeq(seq)
    const state = loadHeldState(pluginData, realmId)
    const entries = state.entries.filter(entry => !(entry.room_id === roomId && entry.seq === seq))
    const removed = entries.length !== state.entries.length
    if (removed) {
      atomicWriteJson(heldFilePath(pluginData, realmId), { version: 1, entries })
    }
    return removed
  })
}

// --- Recovery (the human preview surface's reader; no tool reaches this) -----------

// The held body for one record: the cached copy when it survives, otherwise a
// point read against the room log (after_seq = seq − 1, limit = 1) through
// the injected `pointRead` seam — the api-client's read path, so the
// recovered artifact byte-matches what the pipeline withheld. Returns
// { body?, evicted }: `evicted` is true exactly when the cached copy was
// absent and recovery ran; a record that is not held (unknown or already
// released) returns no body and never triggers a read — releasing a message
// removes its preview reference for good. The result is for the HUMAN
// approval surface (Story 3.4's `held show`); the MCP tool layer never calls
// this, so no agent-visible result can carry a recovered body either.
export async function heldBody(pluginData, realmId, roomId, seq, { pointRead } = {}) {
  assertRealmKey(realmId)
  assertRoomId(roomId)
  assertSeq(seq)
  const state = loadHeldState(pluginData, realmId)
  const entry = state.entries.find(candidate => candidate.room_id === roomId && candidate.seq === seq)
  if (!entry) return { body: undefined, evicted: false }
  if (typeof entry.body === 'string') return { body: entry.body, evicted: false }
  if (typeof pointRead !== 'function') {
    throw new AgentRoomRuntimeError(
      'invalid_argument',
      'the held body cache copy was evicted; recovery needs a point read against the room log',
    )
  }
  const page = await pointRead({ roomId, afterSeq: seq - 1, limit: 1 })
  const row = page && typeof page === 'object' && Array.isArray(page.messages)
    ? page.messages.find(message => message && typeof message === 'object' && message.seq === seq)
    : null
  if (!row || typeof row.text !== 'string') return { body: undefined, evicted: true }
  return { body: row.text, evicted: true }
}
