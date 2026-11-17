// Story 3.1: the multiplexed watch stream — one long-lived SSE/NDJSON
// response per session, fed by the PostCommitBus and driven by a single
// central reconciler. This module owns no SQL of its own: every read goes
// through the store facade. The reconciler's idle path does a filesystem stat
// only (no db.prepare), so 1,000 idle streams cost 0 SQL statements.
//
// Atomicity of catch-up vs subscribe: bus.subscribe() and the store's page
// reads are BOTH synchronous, and this handler runs them with no await in
// between. Node's single thread cannot interleave a publish in that window,
// so a message is either in the catch-up page or delivered live — never lost,
// and dedup'd by (room, seq) if it appears in both.

import { statSync } from 'node:fs'
import {
  WATCH_BAN_RECONCILE_MS,
  WATCH_CATCHUP_MAX,
  WATCH_CONCURRENT_MAX,
  WATCH_CURSORS_PARAM_MAX_BYTES,
  WATCH_KEEPALIVE_MS,
  WATCH_OUTBOUND_BUFFER_MAX_BYTES,
  WATCH_TIMEOUT_MS,
  IDENTIFIER_MAX,
  READ_PAGE_MAX,
} from '../constants.mjs'
import { HANDLER_STREAMED, reject } from './pipeline.mjs'

const CURSORS_INVALID_MESSAGE = 'cursors: expected JSON object {room_id: non-negative integer}, <=4096 bytes'
const ROOM_ID_PATTERN = new RegExp(`^[A-Za-z0-9_-]{1,${IDENTIFIER_MAX}}$`)
const STOP_EVENTS = new Set(['session_superseded', 'actor_banned', 'session_revoked'])

function nowIso() {
  return new Date().toISOString()
}

// Parse + validate the raw ?cursors= value. Returns { error } or { cursors:
// Map<roomId, seq> }. Duplicate JSON keys are caught in the parse reviver;
// duplicate QUERY keys are caught by the pipeline's field gate before here.
export function parseCursors(raw) {
  if (raw === undefined) return { cursors: new Map() }
  if (typeof raw !== 'string') return { error: reject('invalid_request', CURSORS_INVALID_MESSAGE) }
  if (Buffer.byteLength(raw, 'utf8') > WATCH_CURSORS_PARAM_MAX_BYTES) {
    return { error: reject('invalid_request', CURSORS_INVALID_MESSAGE) }
  }
  // JSON.parse silently collapses duplicate keys before a reviver runs, so
  // detect them on the raw text: top-level "key": tokens at depth 1.
  const topLevelKeys = []
  let depth = 0
  let inString = false
  let escaped = false
  let keyStart = -1
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]
    if (inString) {
      if (escaped) { escaped = false; continue }
      if (ch === '\\') { escaped = true; continue }
      if (ch === '"') {
        inString = false
        if (depth === 1 && keyStart !== -1) {
          const candidate = raw.slice(keyStart, i)
          let j = i + 1
          while (raw[j] === ' ' || raw[j] === '\t') j += 1
          if (raw[j] === ':') topLevelKeys.push(candidate)
          keyStart = -1
        }
      }
      continue
    }
    if (ch === '"') { inString = true; keyStart = i + 1; continue }
    if (ch === '{' || ch === '[') depth += 1
    else if (ch === '}' || ch === ']') depth -= 1
  }
  if (new Set(topLevelKeys).size !== topLevelKeys.length) {
    return { error: reject('invalid_request', CURSORS_INVALID_MESSAGE) }
  }
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { error: reject('invalid_request', CURSORS_INVALID_MESSAGE) }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { error: reject('invalid_request', CURSORS_INVALID_MESSAGE) }
  }
  const keys = Object.keys(parsed)
  if (keys.length > 200) {
    return { error: reject('invalid_request', CURSORS_INVALID_MESSAGE) }
  }
  const cursors = new Map()
  for (const key of keys) {
    if (!ROOM_ID_PATTERN.test(key)) {
      return { error: reject('invalid_request', CURSORS_INVALID_MESSAGE) }
    }
    const value = parsed[key]
    if (!Number.isSafeInteger(value) || value < 0) {
      return { error: reject('invalid_request', CURSORS_INVALID_MESSAGE) }
    }
    cursors.set(key, value)
  }
  return { cursors }
}

// The stream registry + the ONE reconciler timer. All mutation is synchronous
// (no awaits), so capacity admission and per-session replacement are atomic
// with respect to each other on Node's single thread.
export function createWatchManager({ bus, store, databasePath, sessionRegistry, shutdownSignal }) {
  const streams = new Map() // sessionId -> stream
  let reconciler = null
  let closed = false
  let lastDbMtime = -1
  let lastWalMtime = -1

  function frameFor(stream, event) {
    const json = JSON.stringify(event)
    return stream.format === 'ndjson' ? `${json}\n` : `data: ${json}\n\n`
  }

  function closeStream(stream, terminalEvent = null) {
    if (stream.closed) return
    stream.closed = true
    if (stream.unsubscribe) {
      try { stream.unsubscribe() } catch { /* teardown never throws */ }
      stream.unsubscribe = null
    }
    if (stream.keepaliveTimer) { clearInterval(stream.keepaliveTimer); stream.keepaliveTimer = null }
    if (stream.lifetimeTimer) { clearTimeout(stream.lifetimeTimer); stream.lifetimeTimer = null }
    if (terminalEvent) {
      try {
        if (!stream.response.destroyed && !stream.response.writableEnded) {
          stream.response.write(frameFor(stream, terminalEvent))
        }
      } catch { /* socket already gone */ }
    }
    try {
      if (!stream.response.writableEnded) stream.response.end()
    } catch { /* socket already gone */ }
    if (streams.get(stream.sessionId) === stream) streams.delete(stream.sessionId)
  }

  // Called by the bus listener. Writes low-latency; a slow consumer (buffer
  // over the cap) gets rescan_required and is closed within this cycle.
  function onBusEvent(stream, event, control) {
    if (stream.closed) return
    if (event?.event === 'rescan_required') {
      closeStream(stream, { event: 'rescan_required', reason: event.reason ?? 'slow_consumer', ts: nowIso() })
      return
    }
    if (STOP_EVENTS.has(event?.event)) {
      closeStream(stream, { ...event, ts: event.ts ?? nowIso() })
      return
    }
    // Catch-up filters non-member rooms at subscribe time; the live bus fans
    // every event to every subscriber, so the SAME membership check must run
    // here before a live 'message' frame is buffered or written. Otherwise a
    // session watching room A also sees live events for room B. Control events
    // above are about the stream itself and are never filtered.
    if (event?.event === 'message') {
      let member = false
      try {
        member = !!store.sessionPairMembership({ roomId: event.room_id, sessionId: stream.sessionId })
      } catch { /* a failed membership read fails closed: ignore the event */ }
      if (!member) {
        if (control) control.drain()
        return
      }
    }
    if (!stream.flushed) {
      // Catch-up still in progress: buffer + dedup, flush after catch-up.
      const key = `${event.room_id}:${event.seq}`
      if (!stream.seen.has(key)) {
        stream.seen.add(key)
        stream.buffer.push(event)
      }
      if (control) control.drain()
      return
    }
    const key = `${event.room_id}:${event.seq}`
    if (stream.seen.has(key)) {
      if (control) control.drain()
      return
    }
    stream.seen.add(key)
    writeEvent(stream, event, control)
  }

  function writeEvent(stream, event, control) {
    if (stream.closed) return
    let frame
    try {
      frame = frameFor(stream, { ...event, ts: event.ts ?? nowIso() })
    } catch {
      if (control) control.drain()
      return
    }
    let ok = true
    try {
      ok = stream.response.write(frame)
    } catch {
      closeStream(stream)
      return
    }
    if (ok) {
      if (control) control.drain()
      return
    }
    // Backpressure: keep the entry queued in the bus (do not drain) so the
    // bus's bounded queue counts it. If the socket itself is over the cap,
    // rescan and close within this keepalive cycle.
    if (stream.response.writableLength > WATCH_OUTBOUND_BUFFER_MAX_BYTES) {
      closeStream(stream, { event: 'rescan_required', reason: 'slow_consumer', ts: nowIso() })
    }
  }

  function reconcile() {
    if (closed) return
    // Idle path: stat only. No store read / db.prepare unless the DB or WAL
    // actually changed since the last tick.
    let dbMtime = -1
    let walMtime = -1
    try { dbMtime = statSync(databasePath).mtimeMs } catch { /* file gone: skip */ }
    try { walMtime = statSync(`${databasePath}-wal`).mtimeMs } catch { /* no WAL */ }
    const changed = dbMtime !== lastDbMtime || walMtime !== lastWalMtime
    lastDbMtime = dbMtime
    lastWalMtime = walMtime
    if (shutdownSignal?.aborted) {
      for (const stream of [...streams.values()]) closeStream(stream)
      return
    }
    if (!changed) return
    // The durable state moved: re-check each live stream's authority. Reads
    // here are bounded by the number of streams and only happen on change.
    for (const stream of [...streams.values()]) {
      if (stream.closed) continue
      try {
        if (store.isActorBanned(stream.actorFingerprint)) {
          closeStream(stream, { event: 'actor_banned', ts: nowIso() })
          continue
        }
        const status = store.getSessionPrincipalStatus(stream.sessionId)
        if (status === null || status.principal_status === 'revoked') {
          closeStream(stream, { event: 'session_revoked', ts: nowIso() })
          continue
        }
        if (status.generation !== stream.generation) {
          closeStream(stream, { event: 'session_revoked', reason: 'generation_advanced', ts: nowIso() })
        }
      } catch {
        closeStream(stream)
      }
    }
  }

  function ensureReconciler() {
    if (reconciler === null && !closed) {
      reconciler = setInterval(reconcile, WATCH_BAN_RECONCILE_MS)
      reconciler.unref()
    }
  }

  function handleWatch(context) {
    // Identity strictly from the credential (the capability verifier resolved
    // context.session.principal). No actor_id is ever read from the query.
    const session = context.session
    if (!session || typeof session !== 'object' || !session.sessionPrincipal) {
      return reject('unauthorized')
    }
    const principal = session.sessionPrincipal
    const sessionId = principal.session_id
    const actorFingerprint = principal.installation_fingerprint
    const generation = principal.generation

    const parsed = parseCursors(context.query?.cursors)
    if (parsed.error) return parsed.error
    const requested = parsed.cursors

    // Atomic admission. A NEW session when already at capacity is refused
    // 503 without touching any incumbent. A same-session replacement is
    // allowed at capacity (the count does not grow).
    const incumbent = streams.get(sessionId)
    if (!incumbent && streams.size >= WATCH_CONCURRENT_MAX) {
      return reject('queue_full')
    }

    // Filter non-member rooms silently (no existence probing): a grammar-
    // valid key that this session has no membership row for is dropped.
    const memberCursors = new Map()
    for (const [roomId, seq] of requested) {
      if (store.sessionPairMembership({ roomId, sessionId })) memberCursors.set(roomId, seq)
    }

    const accept = context.headers?.accept ?? context.headers?.Accept ?? ''
    const format = /application\/x-ndjson/.test(accept) ? 'ndjson' : 'sse'
    const response = context.response
    const request = context.request

    // Supersede AFTER admission passes, before installing the new stream:
    // the old stream gets session_superseded, then closes.
    if (incumbent) {
      closeStream(incumbent, { event: 'session_superseded', ts: nowIso() })
    }

    const stream = {
      sessionId,
      actorFingerprint,
      generation,
      format,
      response,
      request,
      closed: false,
      flushed: false,
      seen: new Set(),
      buffer: [],
      unsubscribe: null,
      keepaliveTimer: null,
      lifetimeTimer: null,
    }

    // Subscribe BEFORE catch-up; events buffer (dedup) until the catch-up
    // flush. No await between subscribe and the synchronous page reads.
    stream.unsubscribe = bus.subscribe(sessionId, (event, control) => onBusEvent(stream, event, control))

    // Catch-up: bounded total across all member rooms. Page each room with a
    // budget-aware limit; over-budget asks the client to rescan. Every read is
    // a SYNCHRONOUS store call — no await between subscribe and catch-up.
    let collected = 0
    let overflow = false
    outer: for (const [roomId, seq] of memberCursors) {
      let afterSeq = seq
      for (;;) {
        const remaining = WATCH_CATCHUP_MAX - collected
        // Read one over the remaining budget to detect overflow; clamp to the
        // store's page cap so a >200 request never raises invalid_limit.
        const limit = Math.min(remaining + 1, READ_PAGE_MAX)
        const page = store.readSessionPairPage({ roomId, sessionId, afterSeq, limit })
        if (page.length === 0) break
        for (const message of page) {
          const key = `${message.room_id}:${message.seq}`
          if (!stream.seen.has(key)) {
            stream.seen.add(key)
            stream.buffer.push({
              event: 'message',
              room_id: message.room_id,
              seq: message.seq,
              chat_id: message.chat_id,
              fingerprint: message.actor_fingerprint,
              text: message.text,
              reply_to_seq: message.reply_to_seq,
              created_at: message.created_at,
            })
          }
          collected += 1
          if (collected > WATCH_CATCHUP_MAX) { overflow = true; break outer }
        }
        afterSeq = page[page.length - 1].seq
      }
    }

    // Install in the registry before any frame is written so a concurrent
    // replace sees this stream. All synchronous.
    streams.set(sessionId, stream)
    ensureReconciler()

    // Hold this connection open for the full timeout without the default
    // server idle timeout; keepalive is a heartbeat, NOT the timeout itself.
    if (typeof request.setTimeout === 'function') request.setTimeout(0)
    if (typeof response.setTimeout === 'function') response.setTimeout(0)
    request.once('close', () => closeStream(stream))
    response.once('close', () => closeStream(stream))
    response.once('error', () => closeStream(stream))

    response.writeHead(200, format === 'ndjson'
      ? {
        'Content-Type': 'application/x-ndjson; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Accel-Buffering': 'no',
      }
      : {
        'Content-Type': 'text/event-stream; charset=utf-8',
        Connection: 'keep-alive',
        'Cache-Control': 'no-store',
      })

    if (overflow) {
      closeStream(stream, { event: 'rescan_required', reason: 'catchup_limit', ts: nowIso() })
      return HANDLER_STREAMED
    }

    // Flush catch-up + any buffered live events (dedup already applied).
    for (const event of stream.buffer) writeEvent(stream, event, null)
    stream.buffer.length = 0
    stream.flushed = true

    stream.keepaliveTimer = setInterval(() => {
      if (stream.closed) return
      writeEvent(stream, { event: 'keepalive', ts: nowIso() }, null)
    }, WATCH_KEEPALIVE_MS)
    stream.keepaliveTimer.unref()

    stream.lifetimeTimer = setTimeout(() => {
      closeStream(stream)
    }, WATCH_TIMEOUT_MS)
    stream.lifetimeTimer.unref()

    return HANDLER_STREAMED
  }

  function close() {
    closed = true
    if (reconciler !== null) { clearInterval(reconciler); reconciler = null }
    for (const stream of [...streams.values()]) closeStream(stream)
  }

  return Object.freeze({ handleWatch, close, streamCount: () => streams.size })
}
