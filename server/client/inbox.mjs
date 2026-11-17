// Story 3.3 — the bounded, allowlisted inbox writer.
//
// One JSON line per wake under sessions/<scope>/inbox.jsonl, written INSIDE
// the one cursor-lock primitive (withCursorLock, now parameterized by lock
// filename) with inbox.lock. Fields are an allowlist; a Held row never carries
// `text` — only trusted rows do. Trusted bodies above INBOX_TEXT_MAX_BYTES are
// replaced by a summary + a read pointer, so no single line can blow the
// rotation bound. ANSI/control sequences in any string are stripped before
// serialization (a hostile sender cannot paint a host's tail).
//
// Rotation happens BEFORE append when the active file would exceed either
// INBOX_MAX_BYTES or INBOX_MAX_LINES. Files rotate active -> .1 -> .2; .2 is
// dropped, so at most INBOX_MAX_FILES files ever exist. Rotation is done by
// rename inside the lock; a partial/crashed state (a truncated last line) is
// recovered by dropping that last incomplete line on the next append rather
// than failing forever.
//
// WRITE FAILURE IS LOUD: append/rotate errors propagate. The wait's two-phase
// dispatcher treats a thrown write as a failed Phase B dispatch, so Phase C
// never CAS-commits notified_seq (the seq stays retryable). This module never
// touches cursors.json itself.

import { constants as fsConstants, closeSync, existsSync, openSync, renameSync, statSync, unlinkSync, writeSync, readFileSync } from 'node:fs'

import {
  INBOX_LOCK_FILENAME,
  withCursorLock,
} from './cursors.mjs'
import {
  INBOX_MAX_BYTES,
  INBOX_MAX_FILES,
  INBOX_MAX_LINES,
  INBOX_TEXT_MAX_BYTES,
} from '../constants.mjs'
import { sessionScopeFilePath } from './session-state.mjs'

export const INBOX_FILENAME = 'inbox.jsonl'

// The only fields that may appear on an inbox line. `text` is added only for
// trusted rows; everything else is projected from this allowlist.
const FIELD_ALLOWLIST = Object.freeze([
  'ts', 'room_id', 'seq', 'from_address', 'fingerprint', 'trusted', 'held', 'summary', 'text',
])

// Strip ANSI escape sequences and C0/C1 control characters (except tab and
// newline folded to a space) so a sender cannot inject terminal control codes
// into a host that tails the inbox. Bounded by the caller before serialization.
export function sanitizeInboxText(value) {
  if (typeof value !== 'string') return ''
  return value
    // eslint-disable-next-line no-control-regex
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '') // CSI
    .replace(/\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g, '') // OSC
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g, '')
    .replace(/\r/g, '')
}

// Build one allowlisted line. `from_address` is the sender's attributed chat
// id; `fingerprint` is its actor fingerprint. A Held verdict forces text out
// entirely and exposes only a metadata summary. A trusted body over the cap
// becomes a bounded summary plus a read pointer (the full body stays in the
// durable log, to be fetched through message_read).
export function inboxEntry(row, { now = () => new Date().toISOString() } = {}) {
  const trusted = row?.trusted === true
  const raw = sanitizeInboxText(typeof row?.text === 'string' ? row.text : '')
  const entry = {
    ts: typeof row?.ts === 'string' && row.ts.length > 0 ? sanitizeInboxText(row.ts) : now(),
    room_id: sanitizeInboxText(typeof row?.room_id === 'string' ? row.room_id : ''),
    seq: Number.isSafeInteger(row?.seq) && row.seq >= 0 ? row.seq : 0,
    from_address: sanitizeInboxText(typeof (row?.from_address ?? row?.chat_id) === 'string' ? (row.from_address ?? row.chat_id) : ''),
    fingerprint: sanitizeInboxText(typeof (row?.fingerprint ?? row?.actor_fingerprint) === 'string' ? (row.fingerprint ?? row.actor_fingerprint) : ''),
    trusted,
    ...(row?.held === true ? { held: true } : {}),
    summary: sanitizeInboxText(typeof row?.summary === 'string' ? row.summary : ''),
  }
  if (trusted) {
    if (Buffer.byteLength(raw, 'utf8') > INBOX_TEXT_MAX_BYTES) {
      // Summary WITH a read pointer, both folded into the one allowlisted
      // `summary` string; the oversized body itself never enters the inbox.
      entry.summary = `${entry.summary || 'large message'} (${Buffer.byteLength(raw, 'utf8')} bytes; read room ${entry.room_id} seq ${entry.seq} for the full body)`.slice(0, 4096)
    } else {
      entry.text = raw
    }
  }
  // Final projection through the allowlist — a future field can never leak by
  // accident.
  const projected = {}
  for (const key of FIELD_ALLOWLIST) {
    if (key in entry) projected[key] = entry[key]
  }
  return projected
}

function countLines(text) {
  if (text.length === 0) return 0
  let count = 0
  for (let i = 0; i < text.length; i += 1) if (text[i] === '\n') count += 1
  // Trailing content without a newline is a partial line: count it so an
  // append after a crash never treats it as complete.
  if (text[text.length - 1] !== '\n') count += 1
  return count
}

function readActive(path) {
  if (!existsSync(path)) return ''
  return readFileSync(path, 'utf8')
}

// Recover a partial last line: drop everything after the final newline. A
// complete file (ends in \n) is untouched.
function truncatePartial(path, text) {
  if (text.length === 0 || text.endsWith('\n')) return text
  const cut = text.lastIndexOf('\n') + 1
  const recovered = text.slice(0, cut)
  const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_TRUNC)
  try { writeSync(fd, recovered) } finally { closeSync(fd) }
  return recovered
}

// Rotate while the ACTIVE file is at either bound, before appending. Drop the
// oldest (.2); shift .1 -> .2 and active -> .1. Absent files are fine.
function rotate(path) {
  const oldest = `${path}.${INBOX_MAX_FILES - 1}`
  for (let index = INBOX_MAX_FILES - 1; index >= 2; index -= 1) {
    const from = `${path}.${index - 1}`
    if (existsSync(from)) renameSync(from, `${path}.${index}`)
  }
  try { unlinkSync(oldest) } catch { /* nothing to drop */ }
  if (existsSync(path)) renameSync(path, `${path}.1`)
}

// Append one entry under the ONE lock primitive. The caller receives `true`
// only after the bytes are on disk; any write/rotation failure propagates so
// the wake dispatcher can withhold the notified_seq commit.
export async function appendInboxEntry(pluginDataDir, scope, row, { now } = {}) {
  const path = sessionScopeFilePath(pluginDataDir, scope, INBOX_FILENAME)
  return withCursorLock(pluginDataDir, () => {
    let active = truncatePartial(path, readActive(path))
    const line = `${JSON.stringify(inboxEntry(row, { now }))}\n`
    if (statSafeBytes(path) + Buffer.byteLength(line, 'utf8') > INBOX_MAX_BYTES
      || countLines(active) + 1 > INBOX_MAX_LINES) {
      rotate(path)
      active = ''
    }
    const fd = openSync(path, fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW, 0o600)
    try {
      writeSync(fd, line)
    } finally {
      closeSync(fd)
    }
    return true
  }, { scope, lockFilename: INBOX_LOCK_FILENAME })
}

function statSafeBytes(path) {
  try { return statSync(path).size } catch { return 0 }
}

export { FIELD_ALLOWLIST as INBOX_FIELD_ALLOWLIST }
