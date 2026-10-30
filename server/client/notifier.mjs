// The companion notifier: the last hop that lets an idle host learn a message
// arrived. MCP is pull — a host such as Claude Code only calls tools during a
// model turn — and the server allows one session per Chat ID, so no sidecar
// can watch on this installation's behalf. The watcher therefore lives inside
// the MCP process, on the session it already holds:
//
//   - started by the adapter after the first successful tool call (the first
//     bind), never before: the client stays lazy;
//   - long-polls every room listRooms() returns (the room list is re-read
//     once per hold, and at once after room_direct_open). A room present at
//     the first listing starts at its head (history is never replayed); a
//     room first listed later was created after that listing, so it starts
//     at 0 and its very first message is news;
//   - skips this installation's own messages, judges every other row with the
//     real trust matrix, and appends one JSON line per message to
//     PLUGIN_DATA/inbox.jsonl (0600, O_APPEND, no symlink follow): ts,
//     room_id, seq, chat_id, fingerprint, held, preview. A held row carries an
//     empty preview — never a body. No token or secret is ever written;
//   - optionally runs AGENT_ROOM_NOTIFY_CMD (execFile, no shell, one hook at a
//     time) with that line on stdin;
//   - writes nothing to cursors.json or held.json: message_read remains the
//     authoritative read path, the inbox is only the wake signal;
//   - is silent on stderr except when the inbox write or the hook fails;
//   - stops on the adapter's teardown (every held long-poll is aborted), and
//     on a session-level refusal (banned / chat_id_taken / not_enrolled) —
//     the next successful tool call starts it again.

import { execFile } from 'node:child_process'
import { closeSync, constants as fsConstants, fchmodSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'

import {
  NOTIFIER_ACTIVE_WINDOW_MS,
  NOTIFIER_PREVIEW_MAX,
  NOTIFIER_REQUEST_SPACING_MS,
  NOTIFIER_ROOM_LIMIT,
  NOTIFIER_ROOM_REFRESH_MS,
  NOTIFY_CMD_TIMEOUT_MS,
  READ_HOLD_MAX_MS,
  READ_PAGE_MAX,
} from '../constants.mjs'
import { reconnectDelayMs } from './api-client.mjs'
import { applyTrustMatrix, loadAllowlist } from './trust.mjs'

export const INBOX_FILENAME = 'inbox.jsonl'
export const NOTIFIER_ENV = 'AGENT_ROOM_NOTIFIER'
export const NOTIFY_CMD_ENV = 'AGENT_ROOM_NOTIFY_CMD'

const STOP_CODES = new Set(['banned', 'chat_id_taken', 'not_enrolled'])
const INBOX_OPEN_FLAGS = fsConstants.O_WRONLY | fsConstants.O_APPEND | fsConstants.O_CREAT | fsConstants.O_NOFOLLOW

export function notifierEnabled(env = process.env) {
  return env[NOTIFIER_ENV] !== 'off'
}

// One inbox line for one judged row. Foreign rows always arrive wrapped in the
// untrusted envelope (open tag, warning line, body, close tag), so the body is
// the lines between the first two and the last; whitespace folds to single
// spaces and the preview is cut by code point.
export function inboxEntry(roomId, row) {
  const held = row.held === true
  let body = ''
  if (!held && typeof row.text === 'string') {
    body = row.text.startsWith('<untrusted_message ') ? row.text.split('\n').slice(2, -1).join('\n') : row.text
  }
  return {
    ts: typeof row.created_at === 'string' ? row.created_at : new Date().toISOString(),
    room_id: roomId,
    seq: row.seq,
    chat_id: row.chat_id,
    fingerprint: row.actor_fingerprint,
    held,
    preview: Array.from(body.replace(/\s+/g, ' ').trim()).slice(0, NOTIFIER_PREVIEW_MAX).join(''),
  }
}

// Up to NOTIFIER_ROOM_LIMIT rooms every room is watched. Past it, three
// long-polls a minute per room would crowd the Actor's FR-16 budget (shared
// with the agent's own tool calls), so only the Broadcast Room plus the DMs
// active inside NOTIFIER_ACTIVE_WINDOW_MS are watched, most recent first,
// capped at the limit. Rooms carry {roomId, kind, lastActivityMs}.
export function selectWatchedRooms(rooms, nowMs) {
  if (rooms.length <= NOTIFIER_ROOM_LIMIT) return rooms.map(room => room.roomId)
  const recent = rooms
    .filter(room => room.kind !== 'broadcast' && nowMs - room.lastActivityMs <= NOTIFIER_ACTIVE_WINDOW_MS)
    .sort((left, right) => right.lastActivityMs - left.lastActivityMs)
  return [...rooms.filter(room => room.kind === 'broadcast'), ...recent]
    .slice(0, NOTIFIER_ROOM_LIMIT)
    .map(room => room.roomId)
}

export function startNotifier({
  client,
  pluginDataDir,
  realmIdOf,
  env = process.env,
  errorOutput = process.stderr,
  onStop = () => {},
}) {
  const controller = new AbortController()
  const { signal } = controller
  const inboxPath = join(pluginDataDir, INBOX_FILENAME)
  const notifyCmd = env[NOTIFY_CMD_ENV] || null
  const rooms = new Map()
  let firstListing = null
  let ready = false
  let nextStartAt = 0
  let refreshWake = new AbortController()
  let hookChain = Promise.resolve()

  const stop = () => {
    if (signal.aborted) return
    controller.abort()
    onStop()
  }

  // An abortable pause: resolves on its timer or its signal, never rejects.
  const pause = (ms, pauseSignal) => new Promise(resolvePromise => {
    if (pauseSignal.aborted) {
      resolvePromise()
      return
    }
    const done = () => {
      clearTimeout(timer)
      pauseSignal.removeEventListener('abort', done)
      resolvePromise()
    }
    const timer = setTimeout(done, ms)
    pauseSignal.addEventListener('abort', done, { once: true })
  })

  // Every request start is spaced: a startup over many rooms never drains the
  // request burst the agent's own tool calls draw from.
  const paced = async (callSignal, call) => {
    const now = Date.now()
    const at = Math.max(now, nextStartAt)
    nextStartAt = at + NOTIFIER_REQUEST_SPACING_MS
    if (at > now) await pause(at - now, callSignal)
    if (callSignal.aborted) throw callSignal.reason
    return call()
  }

  const read = (roomId, afterSeq, waitMs, callSignal, limit = READ_PAGE_MAX) =>
    paced(callSignal, () => client.readMessage({ roomId, afterSeq, limit, waitMs, signal: callSignal }))

  const appendInbox = text => {
    const fd = openSync(inboxPath, INBOX_OPEN_FLAGS, 0o600)
    try {
      fchmodSync(fd, 0o600)
      writeSync(fd, text)
    } finally {
      closeSync(fd)
    }
  }

  const runHook = line => new Promise(resolvePromise => {
    const child = execFile(notifyCmd, [], { timeout: NOTIFY_CMD_TIMEOUT_MS, signal }, error => {
      if (error && !signal.aborted) {
        errorOutput.write(`agent-room notifier: ${NOTIFY_CMD_ENV} failed: ${error.code ?? error.signal ?? 'error'}\n`)
      }
      resolvePromise()
    })
    child.stdin.on('error', () => { /* a hook that ignores its stdin may close it first */ })
    child.stdin.end(line)
  })

  const deliver = async (roomId, messages) => {
    const foreign = messages.filter(row => row?.actor_fingerprint !== client.fingerprint)
    if (foreign.length === 0) return
    const judged = applyTrustMatrix({ messages: foreign }, {
      ownFingerprint: client.fingerprint,
      transport: client.transport,
      allowlist: loadAllowlist(pluginDataDir, await realmIdOf()),
    }).messages
    for (const row of judged) {
      const line = `${JSON.stringify(inboxEntry(roomId, row))}\n`
      try {
        appendInbox(line)
      } catch (error) {
        errorOutput.write(`agent-room notifier: inbox write failed: ${error?.code ?? 'error'}\n`)
      }
      if (notifyCmd !== null) hookChain = hookChain.then(() => runHook(line))
    }
  }

  const watchRoom = async (entry, roomSignal) => {
    for (let failures = 0; !roomSignal.aborted;) {
      try {
        const page = await read(entry.roomId, entry.cursor, READ_HOLD_MAX_MS, roomSignal)
        failures = 0
        if (page.messages.length > 0) {
          entry.lastActivityMs = Date.now()
          await deliver(entry.roomId, page.messages)
        }
        entry.cursor = Math.max(entry.cursor, page.next_after_seq)
      } catch (error) {
        if (roomSignal.aborted) return
        if (STOP_CODES.has(error?.code)) {
          stop()
          return
        }
        failures += 1
        await pause(reconnectDelayMs(failures), roomSignal)
      }
    }
  }

  const refresh = async () => {
    const listed = (await paced(signal, () => client.listRooms({ signal }))).rooms
    firstListing ??= new Set(listed.map(room => room.room_id))
    const many = listed.length > NOTIFIER_ROOM_LIMIT
    for (const { room_id: roomId, kind } of listed) {
      if (rooms.has(roomId)) continue
      const entry = { roomId, kind, cursor: 0, lastActivityMs: Date.now(), watcher: null }
      if (firstListing.has(roomId)) {
        // Present from the start: begin at the head (no history replay) and,
        // past the room limit, date the last message for the active window.
        entry.cursor = (await read(roomId, Number.MAX_SAFE_INTEGER, 0, signal, 1)).head_seq
        entry.lastActivityMs = 0
        if (many && entry.cursor > 0) {
          const [last] = (await read(roomId, entry.cursor - 1, 0, signal, 1)).messages
          entry.lastActivityMs = Date.parse(last?.created_at) || 0
        }
      }
      rooms.set(roomId, entry)
    }
    const present = new Set(listed.map(room => room.room_id))
    const watched = new Set(selectWatchedRooms([...rooms.values()].filter(entry => present.has(entry.roomId)), Date.now()))
    for (const entry of rooms.values()) {
      if (watched.has(entry.roomId) && entry.watcher === null) {
        entry.watcher = new AbortController()
        watchRoom(entry, AbortSignal.any([signal, entry.watcher.signal])).catch(error => {
          errorOutput.write(`agent-room notifier: room watch failed: ${error?.message ?? 'error'}\n`)
        })
      } else if (!watched.has(entry.roomId) && entry.watcher !== null) {
        entry.watcher.abort()
        entry.watcher = null
      }
    }
    if (!ready) {
      // The (empty) inbox appears once the starting rooms are watched: the
      // file a host arms `tail -f` on.
      appendInbox('')
      ready = true
    }
  }

  const refreshLoop = async () => {
    for (let failures = 0; !signal.aborted;) {
      try {
        refreshWake = new AbortController()
        await refresh()
        failures = 0
        await pause(NOTIFIER_ROOM_REFRESH_MS, AbortSignal.any([signal, refreshWake.signal]))
      } catch (error) {
        if (signal.aborted) return
        if (STOP_CODES.has(error?.code)) {
          stop()
          return
        }
        failures += 1
        await pause(reconnectDelayMs(failures), signal)
      }
    }
  }
  refreshLoop().catch(error => {
    errorOutput.write(`agent-room notifier: room refresh failed: ${error?.message ?? 'error'}\n`)
  })

  return {
    stop,
    // Re-read the room list now (after room_direct_open succeeds).
    kick() { refreshWake.abort() },
  }
}
