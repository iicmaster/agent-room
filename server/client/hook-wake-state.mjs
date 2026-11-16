// Story 4.2 — the ONE shared wake-state reader for the lifecycle hooks.
// It reads EXISTING durable state and decides eligibility WITHOUT writing any
// new state: cursors.json v2 for the authoritative notified_seq, the scope's
// loop-ledger for suppressed_held_seq, and the notifier's bounded inbox for
// wake candidates plus the human-reset grace clock.
//
// THREE hooks (UserPromptSubmit, PostToolUse, Stop) call here. Eligibility is
// decided ONCE, here — never re-implemented in a hook. The only writers are the
// 3.2 owners called directly by hook-commands: scope-ledger.reserve/suppressHeld
// and the wake-dispatcher's notified_seq advance. No fourth lock, path builder,
// or ledger is introduced.
//
// No message body leaves this module as text for a HELD row; held rows are
// reduced to metadata (seq, room, sender) and a fixed "body withheld" marker.
// ANSI/control characters are stripped from every string that can reach a
// hook's stdout. 0 npm dependencies.

import { readFileSync, statSync } from 'node:fs'

import {
  AUTO_WAKE_MARKERS,
  HOOK_SUMMARY_MAX_BYTES,
  HOOK_SUMMARY_MAX_MSGS,
  USER_PROMPT_WAKE_GRACE_MS,
} from '../constants.mjs'
import { sanitizeInboxText } from './inbox.mjs'
import { createScopeLedger } from './scope-ledger.mjs'
import { readCursorsDocument } from './cursors.mjs'
import { assertSafeSessionScope } from './session-state.mjs'

// The notifier owns PLUGIN_DATA/inbox.jsonl (installation-wide wake signal).
export function notifierInboxPath(pluginDataDir) {
  return `${String(pluginDataDir).replace(/\/$/, '')}/inbox.jsonl`
}

const isSeq = value => Number.isSafeInteger(value) && value >= 0
const finiteMs = value => typeof value === 'number' && Number.isFinite(value) && value >= 0
const INBOX_READ_MAX_BYTES = 256 * 1024
const INBOX_READ_MAX_LINES = 2000

// --- human-vs-auto-wake decision (PURE — the 5000 vs 5001 boundary) -----------

export function hasAutoWakeMarker(prompt) {
  if (typeof prompt !== 'string') return false
  return AUTO_WAKE_MARKERS.some(marker => prompt.includes(marker))
}

// Reset G1/G2 ONLY for a genuine human prompt: a non-empty prompt with no
// auto-wake marker whose arrival is strictly MORE than the grace after the last
// wake. `=== 5000` never resets (strict >); no recorded wake means the grace
// cannot apply, so a first human prompt is allowed to reset.
export function shouldResetOnHumanPrompt({ prompt, lastWakeAtMs, nowMs, graceMs = USER_PROMPT_WAKE_GRACE_MS } = {}) {
  if (typeof prompt !== 'string' || prompt.length === 0) return false
  if (hasAutoWakeMarker(prompt)) return false
  if (!finiteMs(lastWakeAtMs)) return true
  if (!finiteMs(nowMs)) return false
  return nowMs - lastWakeAtMs > graceMs
}

// --- bounded notifier inbox reader -------------------------------------------

// Parse the installation-wide notifier inbox. Only message lines (no `kind`)
// are wake candidates; notifier status lines are ignored. Held rows carry no
// body preview; trusted rows carry only a short, sanitized preview.
export function readNotifierInbox(pluginDataDir, { path: explicitPath = null, maxBytes = INBOX_READ_MAX_BYTES } = {}) {
  const target = explicitPath ?? notifierInboxPath(pluginDataDir)
  let text
  try {
    // Bound the read: a hostile/large file can never cost more than a few KiB.
    const size = statSync(target).size
    if (size > maxBytes) {
      const fd = readFileSync(target)
      text = fd.subarray(fd.length - maxBytes).toString('utf8')
      const nl = text.indexOf('\n')
      text = nl === -1 ? '' : text.slice(nl + 1)
    } else {
      text = readFileSync(target, 'utf8')
    }
  } catch {
    return []
  }
  const entries = []
  for (const line of text.split('\n')) {
    if (entries.length >= INBOX_READ_MAX_LINES) break
    if (line.length === 0) continue
    let row
    try { row = JSON.parse(line) } catch { continue }
    if (!row || typeof row !== 'object' || 'kind' in row) continue
    const roomId = sanitizeInboxText(typeof row.room_id === 'string' ? row.room_id : '')
    const seq = row.seq
    if (!roomId || !isSeq(seq)) continue
    const ts = typeof row.ts === 'string' ? Date.parse(row.ts) : NaN
    entries.push({
      room_id: roomId,
      seq,
      held: row.held === true,
      from: sanitizeInboxText(typeof (row.chat_id ?? row.from_address) === 'string' ? (row.chat_id ?? row.from_address) : ''),
      preview: row.held === true ? '' : sanitizeInboxText(typeof row.preview === 'string' ? row.preview : ''),
      tsMs: Number.isFinite(ts) && ts >= 0 ? ts : null,
    })
  }
  return entries
}

// --- the shared eligibility read ---------------------------------------------

// notified_seq, authoritative (cursors.json v2), max per room across all realms
// of this scope. Monotonic-safe across realms.
function notifiedByRoom(pluginDataDir, scope) {
  const map = new Map()
  const realmByRoom = new Map()
  try {
    const { document } = readCursorsDocument(pluginDataDir, { scope })
    for (const [realmId, realm] of Object.entries(document.realms ?? {})) {
      for (const [roomId, entry] of Object.entries(realm?.rooms ?? {})) {
        const seq = entry?.notified_seq
        if (isSeq(seq)) {
          map.set(roomId, Math.max(map.get(roomId) ?? 0, seq))
          // Keep the realm holding the highest notified position so the 2-phase
          // reserve checks the same authoritative cursor this read did.
          if ((map.get(roomId) ?? 0) === seq) realmByRoom.set(roomId, realmId)
        }
      }
    }
  } catch { /* absent/unreadable cursor file: position 0 everywhere */ }
  return { positions: map, realmByRoom }
}

function suppressedByRoom(pluginDataDir, scope, rooms) {
  const map = new Map()
  if (rooms.size === 0) return map
  let ledger
  try { ledger = createScopeLedger(pluginDataDir, scope) } catch { return map }
  try {
    for (const roomId of rooms) {
      try {
        const counters = ledger.readCounters({ roomId })
        const seq = counters?.suppressedHeldSeq ?? 0
        if (isSeq(seq)) map.set(roomId, seq)
      } catch { /* room read fails: treat as unsuppressed */ }
    }
  } finally {
    try { ledger.close() } catch { /* ignore */ }
  }
  return map
}

// Single source of truth for "is there anything to wake about?" Plain, bounded,
// read-only. `nowMs` is injectable for tests. The grace clock `lastWakeAtMs` is
// the newest inbox message time (the wake signal), with no new state file.
export function readHookWakeState({ pluginDataDir, scope, nowMs = Date.now(), inboxPath = null } = {}) {
  assertSafeSessionScope(scope)
  const entries = readNotifierInbox(pluginDataDir, { path: inboxPath })
  const { positions: notified, realmByRoom } = notifiedByRoom(pluginDataDir, scope)
  const rooms = new Set(entries.map(entry => entry.room_id))
  const suppressed = suppressedByRoom(pluginDataDir, scope, rooms)

  let lastWakeAtMs = null
  for (const entry of entries) {
    if (entry.tsMs !== null) lastWakeAtMs = Math.max(lastWakeAtMs ?? 0, entry.tsMs)
  }

  const eligibleTrusted = []
  const heldEligible = []
  let maxNotified = 0
  for (const [roomId, seq] of notified) maxNotified = Math.max(maxNotified, seq)
  for (const entry of entries) {
    if (entry.held) {
      if (entry.seq > (suppressed.get(entry.room_id) ?? 0)) heldEligible.push(entry)
    } else if (entry.seq > (notified.get(entry.room_id) ?? 0)) {
      eligibleTrusted.push({ ...entry, realmId: realmByRoom.get(entry.room_id) ?? null })
    }
  }
  eligibleTrusted.sort((a, b) => a.seq - b.seq)
  heldEligible.sort((a, b) => a.seq - b.seq)
  return { maxNotified, eligibleTrusted, heldEligible, lastWakeAtMs, nowMs, totalCandidates: entries.length }
}

// --- bounded, body-free summary for PostToolUse / Stop stdout -----------------

// One line per message, bounded to HOOK_SUMMARY_MAX_BYTES total and MAX_MSGS.
// Held rows contribute metadata only — never a body, preview, or token.
export function buildHookSummary(state, {
  maxBytes = HOOK_SUMMARY_MAX_BYTES,
  maxMsgs = HOOK_SUMMARY_MAX_MSGS,
} = {}) {
  const lines = []
  for (const entry of state.heldEligible) {
    lines.push(`held room ${entry.room_id} seq ${entry.seq} from ${entry.from || 'unknown'} (body withheld)`)
  }
  for (const entry of state.eligibleTrusted) {
    const preview = entry.preview ? ` — ${entry.preview}` : ''
    lines.push(`room ${entry.room_id} seq ${entry.seq} from ${entry.from || 'unknown'}${preview}`)
  }
  const out = []
  let total = 0
  for (const line of lines.slice(0, maxMsgs)) {
    const safe = sanitizeInboxText(line)
    const budget = maxBytes - total
    if (budget <= 0) break
    // AC 4.2-3 budgets BYTES, not UTF-16 code units. `slice(0, budget)` can
    // emit `budget` multibyte characters = up to 4x the allowed bytes (Epic 4
    // retro E4-A1: 4218 bytes measured against a 2048 ceiling). Clip on the
    // UTF-8 byte length instead, and never split a multibyte sequence.
    const bytes = Buffer.from(safe, 'utf8')
    let clipped = safe
    if (bytes.length > budget) {
      let end = budget
      // A byte budget may land inside a multibyte sequence; back off to the
      // nearest UTF-8 boundary rather than emitting a replacement character
      // (which itself costs bytes and broke the 2048 ceiling by 1).
      while (end > 0 && (bytes[end] & 0b11000000) === 0b10000000) end -= 1
      clipped = bytes.subarray(0, end).toString('utf8')
    }
    out.push(clipped)
    total += Buffer.byteLength(clipped, 'utf8')
  }
  return out
}
