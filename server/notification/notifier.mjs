// The companion notifier — Layer 2 (always-on): the last hop that lets an
// idle host learn a message arrived. MCP is pull — a host such as Claude Code
// only calls tools during a model turn — and the server allows one session per
// Chat ID, so no sidecar can watch on this installation's behalf. The watcher
// therefore lives inside the MCP process, on the session it already holds.
//
// PROVENANCE: this module is adopted from the companion-notifier PR #3
// (ngs-th, branch feat/companion-notifier, opened 2026-10-30, closed as
// superseded when v0.5.0 shipped the agent-armed `agent-room wait`). The
// operator's product bar — real-time conversation, not an armed watcher —
// brought it back as the always-on layer on top of that CLI primitive
// (docs/implementation/reviews/epic-8-companion-notifier-party.md, the
// Layer-2 amendment). The implementation below is the PR's own work; the
// receiver-correctness contract below is the v0.8.0 review round (the codex
// round-table's receiver findings, both rounds).
//
//   - started by the adapter as soon as the host connects (on `initialize`),
//     not on the first tool call — receive-ready must not depend on the model
//     remembering to call a tool first; the client boots lazily underneath.
//     A start that fails (nothing set up, not enrolled) stays off and the
//     next successful tool call retries it;
//   - long-polls every room listRooms() returns (the room list is re-read
//     once per hold, and at once after room_direct_open). Room-start
//     discipline, the v0.8.0 catch-up:
//       * a room present at the first listing begins its WATCH at the head
//         (history is never replayed), but the unread window between this
//         installation's persisted message_read cursor and that head is
//         summarized as ONE bounded `unread_backlog` hint line — a message
//         that arrived while the installation was down is announced, and the
//         hint repeats on the next start until the model actually reads the
//         room (the cursor only advances through message_read);
//       * a room first listed later was created after that listing, so it
//         starts at 0 and its very first message is news;
//   - past NOTIFIER_ROOM_LIMIT rooms, only the Broadcast Room plus the DMs
//     active inside NOTIFIER_ACTIVE_WINDOW_MS are long-polled — and every
//     refresh cycle additionally probes up to NOTIFIER_UNWATCHED_PROBE_LIMIT
//     unwatched rooms round-robin (one head read each): a cold DM that fell
//     out of the watch cap is discovered within roughly (rooms / limit)
//     cycles, its new rows delivered and dated so the next selection can
//     return it to the watch set. This sweep is what keeps `sent to X`
//     true for rooms no watcher currently holds;
//   - skips this installation's own messages, judges every other row with the
//     real trust matrix, and appends one JSON line per message to
//     PLUGIN_DATA/inbox.jsonl (0600, O_APPEND, no symlink follow): ts,
//     room_id, seq, chat_id, fingerprint, held, preview. A held row carries an
//     empty preview — never a body. No token or secret is ever written;
//   - status lines share the inbox under a `kind: 'notifier_status'` marker
//     (message lines never carry `kind`): one `started` line when the watch
//     set is armed (what a host tails), and one `hook_error` line per
//     AGENT_ROOM_NOTIFY_CMD failure naming the message keys whose poke was
//     lost — the inbox line itself was already written, so nothing is lost,
//     but the wake did not reach the hook and this says so where a host
//     actually looks;
//   - optionally runs AGENT_ROOM_NOTIFY_CMD (execFile, no shell) with that
//     line on stdin — the host-native wake (a tmux send-keys waker, a lane
//     poker, a desktop notification). The hook queue is BOUNDED (one in
//     flight, NOTIFIER_HOOK_QUEUE_MAX waiting, drop-oldest) — an unread
//     burst never grows unbounded pending work, and every line is in the
//     inbox regardless;
//   - writes nothing to cursors.json or held.json: message_read remains the
//     authoritative read path, the inbox is only the wake signal (the
//     persisted cursor is read read-only, for the catch-up baseline);
//   - is silent on stderr except when the inbox write fails;
//   - stops on the adapter's teardown (every held long-poll is aborted), and
//     on a session-level refusal (banned / chat_id_taken / not_enrolled) —
//     the next successful tool call starts it again.

import { execFile } from 'node:child_process'
import { closeSync, constants as fsConstants, fchmodSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'

import {
  NOTIFIER_ACTIVE_WINDOW_MS,
  NOTIFIER_BACKLOG_SCAN_MAX,
  NOTIFIER_HOOK_QUEUE_MAX,
  NOTIFIER_PREVIEW_MAX,
  NOTIFIER_REQUEST_SPACING_MS,
  NOTIFIER_ROOM_LIMIT,
  NOTIFIER_ROOM_REFRESH_MS,
  NOTIFIER_UNWATCHED_PROBE_LIMIT,
  NOTIFY_CMD_TIMEOUT_MS,
  READ_HOLD_MAX_MS,
  READ_PAGE_MAX,
} from '../constants.mjs'
import { reconnectDelayMs } from '../client/api-client.mjs'
import { loadPersistedCursors } from '../client/cursors.mjs'
import { createDeliveryClassifier } from './delivery.mjs'
import { decideHeldWake, loadWakePolicy, policyIdentity } from './wake-policy.mjs'

export const INBOX_FILENAME = 'inbox.jsonl'
export const NOTIFIER_ENV = 'AGENT_ROOM_NOTIFIER'
export const NOTIFY_CMD_ENV = 'AGENT_ROOM_NOTIFY_CMD'
// Inbox line markers: message lines never carry `kind`; everything the
// notifier says about ITSELF does.
export const STATUS_KIND = 'notifier_status'

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
  // Harness seams (product callers use the constants): the refresh period and
  // the request spacing are injectable so tests can run the real loop fast.
  refreshMs = NOTIFIER_ROOM_REFRESH_MS,
  spacingMs = NOTIFIER_REQUEST_SPACING_MS,
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
  let probeIndex = 0
  const pendingBacklogs = []
  const queuedBacklogRooms = new Set()
  const anomalyRooms = new Set()
  // The catch-up baseline is read once and retried on the next refresh when
  // it cannot be resolved (no realm yet) — a partial startup must never turn
  // into a silent skip.
  let startupCursors = null
  // Sink-loss accounting: the wake signal is best-effort, and the losses are
  // counted and reported when the sink recovers — never claimed as zero-loss.
  let sinkLost = 0

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
    nextStartAt = at + spacingMs
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

  const appendStatusLine = payload => {
    const line = `${JSON.stringify({ ts: new Date().toISOString(), kind: STATUS_KIND, ...payload })}\n`
    try {
      appendInbox(line)
    } catch (error) {
      // A status line is best-effort; the wake path's failures are the ones
      // that must surface, and the next one will.
      errorOutput.write(`agent-room notifier: status write failed: ${error?.code ?? 'error'}\n`)
    }
  }

  // One wake line to the sink, with loss accounting: a failed write counts
  // as lost (it is reported on stderr immediately), and the recovery is
  // announced with the lost estimate — the sink is best-effort, never
  // claimed zero-loss.
  const deliverWakeLine = line => {
    try {
      appendInbox(line)
    } catch (error) {
      sinkLost += 1
      errorOutput.write(`agent-room notifier: inbox write failed (${sinkLost} lost since the last success): ${error?.code ?? 'error'}\n`)
      return false
    }
    if (sinkLost > 0) {
      const lost = sinkLost
      sinkLost = 0
      try {
        appendInbox(`${JSON.stringify({ ts: new Date().toISOString(), kind: STATUS_KIND, event: 'sink_recovered', lost_estimate: lost })}\n`)
      } catch {
        sinkLost = lost // the recovery announcement itself failed: keep counting
      }
    }
    return true
  }

  const messageKeyOf = line => {
    try {
      const parsed = JSON.parse(line)
      return parsed?.room_id !== undefined && parsed?.seq !== undefined ? `${parsed.room_id}:${parsed.seq}` : null
    } catch {
      return null
    }
  }

  // Hooks are bounded, not unbounded: one run in flight, up to
  // NOTIFIER_HOOK_QUEUE_MAX lines queued behind it (drop-oldest). Under
  // normal traffic every line is poked; under a flood the pending work stays
  // bounded while the inbox itself still carries every line — the hook is
  // the poke, not the delivery.
  let hookInFlight = false
  const hookQueue = []

  const runHook = line => new Promise(resolvePromise => {
    const child = execFile(notifyCmd, [], { timeout: NOTIFY_CMD_TIMEOUT_MS, signal }, error => {
      if (error && !signal.aborted) {
        errorOutput.write(`agent-room notifier: ${NOTIFY_CMD_ENV} failed: ${error.code ?? error.signal ?? 'error'}\n`)
        // The poke was lost: say so in the inbox (the line itself was already
        // delivered there), naming the message key the hook missed.
        const key = messageKeyOf(line)
        appendStatusLine({
          event: 'hook_error',
          error: error.code ?? error.signal ?? 'error',
          ...(key === null ? {} : { message_key: key }),
        })
      }
      resolvePromise()
    })
    child.stdin.on('error', () => { /* a hook that ignores its stdin may close it first */ })
    child.stdin.end(line)
  })

  const scheduleHook = line => {
    if (hookInFlight) {
      if (hookQueue.length >= NOTIFIER_HOOK_QUEUE_MAX) {
        // Drop-oldest is an intentional, REPORTED loss: the dropped poke is
        // named where the host looks, and the inbox always carried the line.
        const dropped = hookQueue.shift()
        const key = messageKeyOf(dropped)
        appendStatusLine({
          event: 'hook_dropped',
          ...(key === null ? {} : { message_key: key }),
        })
      }
      hookQueue.push(line)
      return
    }
    hookInFlight = true
    Promise.resolve(runHook(line)).catch(() => { /* runHook never rejects */ }).finally(() => {
      hookInFlight = false
      if (hookQueue.length > 0 && !signal.aborted) {
        scheduleHook(hookQueue.shift())
      }
    })
  }

  const deliver = async (roomId, messages) => {
    const foreign = messages.filter(row => row?.actor_fingerprint !== client.fingerprint)
    if (foreign.length === 0) return
    const realmId = await realmIdOf()
    const delivery = createDeliveryClassifier({
      pluginDataDir,
      realmId,
      ownFingerprint: client.fingerprint,
      transport: client.transport,
    })
    const judged = delivery.classify(foreign)
    // The ratified wake policy: a held row wakes on FIRST contact from its
    // sender; repeats cool down, and the installation's held-row wakes obey
    // an aggregate budget (server/notification/wake-policy.mjs). Trusted rows are
    // never gated; a suppressed row is skipped — never consumed, never
    // acknowledged. The identity (explicit env layer + re-baseline flag)
    // rides along so the shared ledger can verify policy agreement.
    const policy = loadWakePolicy(env)
    const identity = policyIdentity(env)
    const ledger = { pluginData: pluginDataDir, realmId, identity }
    for (const row of judged) {
      if (row.held === true && decideHeldWake({ ...ledger, fingerprint: row.actor_fingerprint, policy }) === false) continue
      const line = `${JSON.stringify(inboxEntry(roomId, row))}\n`
      deliverWakeLine(line)
      if (notifyCmd !== null) scheduleHook(line)
    }
  }

  // The startup catch-up: summarize the unread window between this
  // installation's persisted message_read cursor and the room's head as ONE
  // hint line. The scan is bounded (NOTIFIER_BACKLOG_SCAN_MAX rows, newest
  // first): the estimate counts foreign rows inside the scanned window and
  // reports its exact bounds — an honest at-least, never a body, never a
  // replay. Held rows count (their metadata is in the log); own rows do not.
  const emitBacklogHint = async (roomId, storedCursor, head) => {
    const fromSeq = Math.max(storedCursor, head - NOTIFIER_BACKLOG_SCAN_MAX)
    const page = await read(roomId, fromSeq, 0, signal)
    // The window is clipped to the CAPTURED head: rows that landed after the
    // snapshot belong to the live watcher's future, not to this estimate.
    const fresh = page.messages.filter(row => row?.seq > storedCursor && row?.seq <= head && row?.actor_fingerprint !== client.fingerprint)
    const line = `${JSON.stringify({ ts: new Date().toISOString(), kind: STATUS_KIND, event: 'unread_backlog', room_id: roomId, unread_from: storedCursor, head_seq: head, foreign_in_window: fresh.length, window_from_seq: fromSeq })}\n`
    // The hint is a wake, not just a note: a hook-only host must be poked by
    // the backlog too. The inbox line and the hook share the same payload.
    if (deliverWakeLine(line) && notifyCmd !== null) scheduleHook(line)
  }

  // The unwatched-room probe: one bounded page read for one room past the
  // watch cap. New rows since the last probe are delivered (wake policy and
  // trust matrix as always) and the room is dated active, so the next
  // selection can return it to the watch set. Rooms discovered after the
  // first listing carry probedSeq 0 — their very first message is news,
  // exactly as when they were watched.
  const probeRoom = async entry => {
    const page = await read(entry.roomId, entry.probedSeq, 0, signal)
    if (page.messages.length > 0) {
      entry.lastActivityMs = Date.now()
      await deliver(entry.roomId, page.messages)
    }
    if (page.next_after_seq > entry.probedSeq) {
      entry.probedSeq = page.next_after_seq
      if (page.next_after_seq > entry.cursor) entry.cursor = page.next_after_seq
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
        // One observed position per room: the watcher's progress advances the
        // probe's too, so watch -> evict -> probe never replays delivered rows.
        entry.probedSeq = Math.max(entry.probedSeq, page.next_after_seq)
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
    const firstRun = firstListing === null
    firstListing ??= new Set(listed.map(room => room.room_id))
    // The catch-up baseline: what the model has already FETCHED (the MCP
    // adapter's persisted cursor), read read-only. Unresolvable here (no
    // realm yet) leaves the cache empty and RETRIES next refresh — a partial
    // startup must never silently skip its catch-up.
    if (startupCursors === null) {
      try {
        startupCursors = loadPersistedCursors(pluginDataDir, await realmIdOf())
      } catch {
        startupCursors = null
      }
    }
    const cursors = startupCursors ?? new Map()
    const many = listed.length > NOTIFIER_ROOM_LIMIT
    for (const { room_id: roomId, kind } of listed) {
      if (rooms.has(roomId)) continue
      const entry = { roomId, kind, cursor: 0, lastActivityMs: Date.now(), watcher: null, probedSeq: 0 }
      if (firstListing.has(roomId)) {
        // Present from the start: the watch begins at the head (no replay);
        // the unread window from the persisted cursor is summarized below.
        const head = (await read(roomId, Number.MAX_SAFE_INTEGER, 0, signal, 1)).head_seq
        entry.cursor = head
        entry.probedSeq = head
        entry.lastActivityMs = 0
        if (many && head > 0) {
          const [last] = (await read(roomId, head - 1, 0, signal, 1)).messages
          entry.lastActivityMs = Date.parse(last?.created_at) || 0
        }
        // Missing cursor means the room was NEVER read by the model — the
        // announced unread baseline for it is 0, not read-to-head: a DM a
        // peer opened while this installation was offline is news.
        const stored = cursors.get(roomId)
        const baseline = typeof stored === 'number' && stored >= 0 ? stored : 0
        if (typeof stored === 'number' && stored > head && !anomalyRooms.has(roomId)) {
          anomalyRooms.add(roomId)
          appendStatusLine({
            event: 'cursor_ahead',
            room_id: roomId,
            stored_cursor: stored,
            head_seq: head,
          })
        }
        if (head > baseline && !queuedBacklogRooms.has(roomId)) {
          // Queue immediately, per room: a head-read failure later in the
          // loop must not lose the candidates already earned.
          queuedBacklogRooms.add(roomId)
          pendingBacklogs.push({ roomId, storedCursor: baseline, head })
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
    // The bounded sweep of the rooms no watcher holds: round-robin, at most
    // NOTIFIER_UNWATCHED_PROBE_LIMIT probes per cycle, spaced by the same
    // pacing as every other notifier request.
    const unwatched = [...rooms.values()].filter(entry => present.has(entry.roomId) && !watched.has(entry.roomId))
    if (unwatched.length > 0 && !signal.aborted) {
      const probed = Math.min(NOTIFIER_UNWATCHED_PROBE_LIMIT, unwatched.length)
      for (let index = 0; index < probed; index += 1) {
        const entry = unwatched[(probeIndex + index) % unwatched.length]
        try {
          await probeRoom(entry)
        } catch (error) {
          if (signal.aborted) break
          if (STOP_CODES.has(error?.code)) {
            stop()
            break
          }
          // A failed probe is next cycle's problem; the room stays in the
          // sweep queue.
        }
      }
      probeIndex = (probeIndex + probed) % unwatched.length
    }
    while (pendingBacklogs.length > 0 && !signal.aborted) {
      const backlog = pendingBacklogs[0]
      try {
        await emitBacklogHint(backlog.roomId, backlog.storedCursor, backlog.head)
        pendingBacklogs.shift()
      } catch (error) {
        if (signal.aborted || STOP_CODES.has(error?.code)) break
        break
      }
    }
    if (!ready) {
      // The inbox appears once the starting rooms are watched: the file a
      // host arms `tail -f` on. The first line says what was armed — an
      // honest start, not an empty one.
      appendStatusLine({
        event: 'started',
        watched: [...rooms.values()].filter(entry => entry.watcher !== null).length,
        rooms_total: rooms.size,
        backlog_hints: pendingBacklogs.length,
        hook: notifyCmd === null ? 'none' : 'configured',
      })
      ready = true
    }
  }

  const refreshLoop = async () => {
    for (let failures = 0; !signal.aborted;) {
      try {
        refreshWake = new AbortController()
        await refresh()
        failures = 0
        await pause(refreshMs, AbortSignal.any([signal, refreshWake.signal]))
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
