// Story 4.1 — the Tier 1A channel bridge, held out of the adapter so the wire
// safety rules are testable in isolation. This module provides:
//   - XML escaping (attribute + content) and the <channel> frame builder — a
//     peer's `<channel`/`<`/`&` can never forge a new tag;
//   - a backpressure-aware outbound writer: a frame past the 64 KiB backlog,
//     a closed stream, a throwing write, or a `write()` that returns false is
//     a Phase B failure (the caller releases the lease, keeps notified_seq);
//   - the wait.lock handoff probe (reuses isPidAlive + sessionScopeFilePath);
//   - agent-room://rooms/<room_id> URI validation + a capped subscription set.
//
// It owns NO wake guard: the two-phase lease stays in wake-dispatcher.mjs, and
// this module only decides whether the Phase B channel write succeeded.

import { Buffer } from 'node:buffer'
import { existsSync, lstatSync, readFileSync } from 'node:fs'

import {
  IDENTIFIER_MAX,
  MCP_CHANNEL_OUTBOUND_MAX_BYTES,
  MCP_CHANNEL_SOURCE,
  MCP_RESOURCE_SUBSCRIPTIONS_MAX,
  MCP_RESOURCE_URI_PREFIX,
} from '../constants.mjs'
import { AgentRoomRuntimeError, isPidAlive } from '../runtime.mjs'
import { assertSafeSessionScope, sessionScopeFilePath } from './session-state.mjs'

// --- XML escaping (tag-forgery defense) --------------------------------------

// Content escaping: `&` first so the entities introduced below are not
// double-escaped. Every `<` becomes &lt;, so a body containing `</channel>` or
// `<channel source=...>` can never terminate or open a tag.
export function escapeXmlText(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

// Attribute escaping additionally guards both quote styles, so a value can
// never break out of its quoted attribute.
export function escapeXmlAttr(value) {
  return escapeXmlText(value)
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// Build the exact Tier 1A frame. Held rows are refused outright: no held body
// may ever enter channel text. Only trusted rows reach this builder.
export function buildChannelXml({ from, roomId, seq, text, at = new Date().toISOString() } = {}) {
  if (text === undefined || text === null) return null
  // The caller must not route a held row here; defense in depth against a
  // misclassified row carrying a held marker.
  if (text && typeof text === 'object' && text.held === true) return null
  const attrs = [
    `source="${escapeXmlAttr(MCP_CHANNEL_SOURCE)}"`,
    `at="${escapeXmlAttr(at)}"`,
  ]
  if (from !== undefined && from !== null) attrs.push(`from="${escapeXmlAttr(from)}"`)
  if (roomId !== undefined && roomId !== null) attrs.push(`room="${escapeXmlAttr(roomId)}"`)
  if (seq !== undefined && seq !== null) attrs.push(`seq="${escapeXmlAttr(seq)}"`)
  return `<channel ${attrs.join(' ')}>${escapeXmlText(text)}</channel>`
}

// The MCP notification method + params for a Claude channel wake. `content`
// carries the escaped XML; no body field is added anywhere else.
export const CHANNEL_NOTIFICATION_METHOD = 'notifications/claude/channel'

export function channelNotification(xml) {
  return { jsonrpc: '2.0', method: CHANNEL_NOTIFICATION_METHOD, params: { content: xml } }
}

// --- Backpressure-aware outbound writer --------------------------------------

// `write(message)` is the adapter's injected output.write (a Node stream returns
// false when its internal buffer is at/over the high-water mark). `output` is
// optional and used only for a `destroyed` pre-check and a `drain` subscription.
// `send()` returns {ok:true, bytes} or {ok:false, reason}; the wake dispatcher
// treats false as a Phase B failure and releases the lease.
export function createChannelWriter({ write, output = null, maxBufferBytes = MCP_CHANNEL_OUTBOUND_MAX_BYTES, now = () => Date.now() } = {}) {
  if (typeof write !== 'function') throw new AgentRoomRuntimeError('invalid_argument', 'channel writer needs a write function')
  let pendingBytes = 0
  if (output && typeof output.on === 'function') {
    output.on('drain', () => { pendingBytes = 0 })
  }
  const closed = () => output?.destroyed === true || output?.writableEnded === true
  return {
    get pendingBytes() { return pendingBytes },
    send(message) {
      if (closed()) return { ok: false, reason: 'output_closed' }
      let bytes
      try {
        bytes = Buffer.byteLength(`${JSON.stringify(message)}\n`, 'utf8')
      } catch {
        return { ok: false, reason: 'encode_failed' }
      }
      if (pendingBytes + bytes > maxBufferBytes) {
        return { ok: false, reason: 'backpressure', pendingBytes, bytes }
      }
      let accepted
      try {
        accepted = write(message)
      } catch {
        return { ok: false, reason: 'write_failed' }
      }
      if (accepted === false) return { ok: false, reason: 'backpressure', pendingBytes, bytes }
      pendingBytes += bytes
      return { ok: true, bytes, atMs: now() }
    },
    // Test seam / drain handler: acknowledge that buffered bytes flushed.
    acknowledge() { pendingBytes = 0 },
  }
}

// --- wait.lock handoff --------------------------------------------------------

// Reuses sessionScopeFilePath + isPidAlive. A wait.lock whose recorded pid is
// dead is NOT held (a crashed waiter's fence is reclaimable). Returns
// {held, pid, path}; never creates or mutates the lock.
export function waitLockHeld(pluginDataDir, scope, { alive = isPidAlive, path: explicitPath = null } = {}) {
  assertSafeSessionScope(scope)
  const path = explicitPath ?? sessionScopeFilePath(pluginDataDir, scope, 'wait.lock')
  if (!existsSync(path)) return { held: false, pid: null, path }
  let info
  try { info = lstatSync(path) } catch { return { held: false, pid: null, path } }
  if (!info.isFile() || info.isSymbolicLink()) return { held: false, pid: null, path }
  let pid = null
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'))
    if (Number.isSafeInteger(parsed?.pid) && parsed.pid > 1) pid = parsed.pid
  } catch { /* unreadable lock: not a live holder */ }
  return { held: pid !== null && alive(pid) === true, pid, path }
}

// --- resource URI validation + capped subscriptions --------------------------

const ROOM_ID_PATTERN = new RegExp(`^[A-Za-z0-9_-]{1,${IDENTIFIER_MAX}}$`)

// Parse `agent-room://rooms/<room_id>`. Returns { roomId } or null for any
// foreign scheme/host, traversal, malformed, or oversized room id. A foreign
// room (one outside this realm's membership) is rejected by the caller against
// the client's room list; this helper owns only the shape.
export function parseRoomResourceUri(uri) {
  if (typeof uri !== 'string' || !uri.startsWith(MCP_RESOURCE_URI_PREFIX)) return null
  const roomId = uri.slice(MCP_RESOURCE_URI_PREFIX.length)
  if (!ROOM_ID_PATTERN.test(roomId)) return null
  return { roomId }
}

export function roomResourceUri(roomId) {
  if (!ROOM_ID_PATTERN.test(String(roomId))) return null
  return `${MCP_RESOURCE_URI_PREFIX}${roomId}`
}

// One client's subscription set, capped at MCP_RESOURCE_SUBSCRIPTIONS_MAX.
// subscribe is idempotent (re-subscribing an owned URI is a no-op success); a
// new URI past the cap is refused. unsubscribe reports whether it existed.
export function createSubscriptionRegistry(max = MCP_RESOURCE_SUBSCRIPTIONS_MAX) {
  const uris = new Map() // uri -> roomId
  return {
    get size() { return uris.size },
    has(uri) { return uris.has(uri) },
    subscribe(uri) {
      const parsed = parseRoomResourceUri(uri)
      if (parsed === null) return { ok: false, reason: 'invalid_uri' }
      if (uris.has(uri)) return { ok: true, roomId: parsed.roomId, idempotent: true }
      if (uris.size >= max) return { ok: false, reason: 'subscription_limit' }
      uris.set(uri, parsed.roomId)
      return { ok: true, roomId: parsed.roomId }
    },
    unsubscribe(uri) { return { ok: uris.delete(uri) } },
    list() { return [...uris.keys()] },
    roomIds() { return [...new Set(uris.values())] },
  }
}
