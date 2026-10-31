// The `wait` command family — the companion notifier v1 (Epic 8, 2026-10-31).
//
// THE PROBLEM IT SOLVES. An agent-room agent had no way to KNOW a new
// message arrived: MCP is pull, the host owns the agent's wake cycle, and
// MCP notifications never reach model context. The design history deferred
// this as the "companion notifier" (PRD Non-Goals; the addendum names why:
// push-based delivery is impossible from a plugin). Two advisor round-tables
// (codex, agy — both archived beside the decision record) independently
// ratified the same answer: do not fight the harness — USE it. A blocking
// Node CLI is the one surface that may wait as long as it likes; the hosts'
// background-task machinery (`run_in_background`) notifies the live agent
// session when the process exits. The agent launches `agent-room wait`,
// ends its turn, and the completion notification carries the hint back into
// the model's context. Honest scope, stated everywhere it matters: this
// wakes a LIVE host session; an agent with no live session is woken by
// nothing in this architecture (the durable log makes the catch-up exact
// when it returns), and the operator trigger stays the documented fallback
// for that case.
//
// THE CONTRACT (docs/implementation/reviews/epic-8-companion-notifier-party.md):
//   agent-room wait [--room <room_id>]... [--timeout <seconds>]
// - Watches ALL rooms of this Actor by default (a peer's new DM is the
//   primary user journey — a per-room watcher never wakes for a room it
//   cannot know about); `--room` narrows the watch. Rooms are re-enumerated
//   every cycle in all-rooms mode, so a DM opened mid-wait is discovered.
// - Baseline per room = the MCP adapter's stored cursor for that room
//   (read-only; a room the agent never read starts at 0 — an unread room
//   hints immediately, which is the DM-discovery case).
// - Loop: enumerate → hold long-polls (≤ WAIT_CONCURRENCY_MAX concurrently,
//   hold ≤ READ_HOLD_MAX_MS; the overflow rooms get wait_ms=0 head-checks
//   every cycle) → the FIRST room with a new message wins, the process
//   prints the hint and exits; quiet cycles repeat until the deadline.
//   Requests ≈ 3R/min at R rooms — far inside the 120/min/key gate.
// - Hint-ONLY output (never message bodies): trust matrix, cursor
//   advancement, and the held pipeline stay single-path inside the MCP
//   message_read. One JSON line on stdout:
//   {ok:true, command:'wait', status:'new_messages', room_id, seq, elapsed_ms}
//   or {ok:true, command:'wait', status:'timeout', elapsed_ms, watched, unwatched}.
// - Creates NOTHING: the wait reuses the existing installation (config,
//   keypair, origin) and never writes config, cursor, held, or trust state —
//   its only disk writes are the wait.lock below. Missing pieces refuse;
//   they are never silently created by a background process.
// - One wait process per installation: PLUGIN_DATA/wait.lock (0600,
//   pid-liveness reclaim — a crashed waiter's lock is reclaimed, a live
//   one refuses with wait_already_active).
// - Grammar (the machine-readable families'): success prints the hint on
//   stdout and exits 0 (a clean timeout is a HINT, not a failure — the
//   re-arm is the agent's ordinary next action); a refusal prints ONE JSON
//   object on stderr and exits 1; usage exits 2.

import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { performance } from 'node:perf_hooks'

import {
  READ_HOLD_MAX_MS,
  REALM_KEY_PATTERN,
} from '../constants.mjs'
import { AgentRoomRuntimeError, atomicWriteJson, readJsonFile } from '../runtime.mjs'
import { loadChatIdConfig } from '../client/api-client.mjs'
import { ensureServer } from '../client/ensure-server.mjs'
import { loadRemoteConfig } from '../client/remote-config.mjs'
import { authenticate, protocolHeaders, roundTrip } from './session-commands.mjs'

// The concurrency fence: at most six held long-polls at once. With the 20 s
// hold that is ≈3 requests/min per watched room — 18/min at the fence —
// against the 120/min/key budget, leaving the burst untouched.
const WAIT_CONCURRENCY_MAX = 6
// The outer deadline: default and hard maximum in seconds. The deadline is
// monotonic (performance.now) and covers auth, discovery, and holds — it
// never resets mid-wait.
const WAIT_DEFAULT_TIMEOUT_S = 300
const WAIT_MAX_TIMEOUT_S = 600
// The wait reads full pages so own-fingerprint rows (issue #4) can be skipped
// inside one response instead of one request per row.
const WAIT_PAGE_LIMIT = 200
// Every hold request's HTTP timeout must exceed its server hold, or the
// request dies before the server answers (the default CLIENT_REQUEST_TIMEOUT_MS
// of 10 s is SHORTER than the 20 s hold — the margin below is what keeps a
// quiet hold from surfacing as a request failure).
const WAIT_HOLD_TIMEOUT_MARGIN_MS = 5_000

const usageMessage = message => ({
  status: 'usage',
  command: 'wait',
  code: 'usage',
  message,
})

// First-hit race: resolve with the first attempt that returns a hit, or null
// once every attempt has settled quiet. Any attempt's error rejects the whole
// cycle — a waiter never loops silently against a failing server; it exits
// with the coded refusal and the agent re-arms.
function firstHit(attempts) {
  return new Promise((resolvePromise, rejectPromise) => {
    let pending = attempts.length
    if (pending === 0) {
      resolvePromise(null)
      return
    }
    let settled = false
    const settleQuiet = () => {
      if (settled) return
      pending -= 1
      if (pending === 0) {
        settled = true
        resolvePromise(null)
      }
    }
    for (const attempt of attempts) {
      attempt.then(value => {
        if (settled) return
        if (value !== null) {
          settled = true
          resolvePromise(value)
          return
        }
        settleQuiet()
      }, error => {
        if (settled) return
        settled = true
        rejectPromise(error)
      })
    }
  })
}

// One long-poll read of one room. Resolves a hit {room_id, seq} when the
// page carries messages beyond the baseline, or null on a quiet page. The
// request timeout is the hold plus margin — see WAIT_HOLD_TIMEOUT_MARGIN_MS.
// Issue #4 (v0.5.0, found live by the mcop-coo installation): this
// installation's OWN sends also allocate rows, and `message_send` never
// advances the MCP read cursor — so the first read after any own send saw
// the installation's own message and the wait woke on itself. The fix reads
// a full page, skips every row whose actor_fingerprint is THIS
// installation's (advancing an in-memory per-room baseline past them, so a
// skipped row never re-fires), and re-holds with the advanced cursor when a
// page was all-own. The hint's seq is the FIRST unread sequence from
// SOMEONE ELSE; an unread backlog of any size fires the same way — the full
// catch-up read is message_read's job, not the hint's.
async function holdForRoom({ target, token, roomId, afterSeq, holdMs, ownFingerprint, baselines }) {
  const holdDeadline = performance.now() + holdMs
  let cursor = Math.max(afterSeq, baselines.get(roomId) ?? 0)
  for (;;) {
    const remaining = holdDeadline - performance.now()
    if (remaining <= 0) return null
    const hold = Math.min(READ_HOLD_MAX_MS, Math.floor(remaining))
    const response = await roundTrip(
      target,
      'GET',
      `/api/rooms/${encodeURIComponent(roomId)}/messages?after_seq=${cursor}&limit=${WAIT_PAGE_LIMIT}&wait_ms=${hold}`,
      protocolHeaders(token),
      undefined,
      hold + WAIT_HOLD_TIMEOUT_MARGIN_MS,
    )
    if (response.status !== 200) {
      throw new AgentRoomRuntimeError(
        response.body?.error?.code ?? 'request_failed',
        response.body?.error?.message ?? `the agent-room server answered ${response.status}`,
      )
    }
    const messages = response.body?.result?.messages
    if (!Array.isArray(messages) || messages.length === 0) return null
    const foreign = messages.filter(row => row?.actor_fingerprint !== ownFingerprint)
    if (foreign.length > 0) {
      baselines.set(roomId, Math.max(cursor, messages[messages.length - 1].seq))
      return { room_id: roomId, seq: foreign[0].seq }
    }
    // All-own page: advance past it and re-hold within the same hold window.
    cursor = messages[messages.length - 1].seq
  }
}

// pid-liveness: ESRCH means the process is gone; EPERM means it lives (and
// belongs to someone else — unreachable under one PLUGIN_DATA, treated as
// alive to stay on the safe side).
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

// The one-per-installation fence. The lock is the wait's ONLY disk write
// (plus its removal). A crashed waiter's lock is reclaimed through pid
// liveness; a live waiter refuses the newcomer — two waiters on one
// installation would double the request budget and race each other's hints.
function acquireWaitLock(pluginDataDir, timeoutMs) {
  const path = join(pluginDataDir, 'wait.lock')
  if (existsSync(path)) {
    let existing = null
    try {
      existing = readJsonFile(path)
    } catch {
      existing = null
    }
    const pid = typeof existing?.pid === 'number' && Number.isSafeInteger(existing.pid) && existing.pid > 0
      ? existing.pid
      : null
    if (pid !== null && pid !== process.pid && pidAlive(pid)) {
      return { acquired: false, path }
    }
  }
  atomicWriteJson(path, {
    pid: process.pid,
    started_at: new Date().toISOString(),
    timeout_ms: timeoutMs,
  })
  return { acquired: true, path }
}

function releaseWaitLock(path) {
  try {
    unlinkSync(path)
  } catch {
    /* already gone */
  }
}

// The MCP adapter's stored cursor for a room, READ-ONLY (the wait never
// advances it — message_read stays the single writer). A missing or unusable
// file means "no cursor yet": the room starts at 0, so an unread room —
// including a brand-new DM — hints immediately.
function loadBaselineCursors(pluginDataDir, realmId) {
  if (typeof realmId !== 'string' || !REALM_KEY_PATTERN.test(realmId)) {
    throw new AgentRoomRuntimeError(
      'invalid_request',
      'the agent-room realm id is not a safe cursor key; refusing to build a cursor path from it',
    )
  }
  const path = join(pluginDataDir, 'realms', realmId, 'cursors.json')
  if (!existsSync(path)) return new Map()
  try {
    const value = readJsonFile(path)
    const cursors = value && typeof value === 'object' && value.cursors && typeof value.cursors === 'object'
      ? value.cursors
      : {}
    const baselines = new Map()
    for (const [roomId, entry] of Object.entries(cursors)) {
      const afterSeq = entry?.after_seq
      if (typeof afterSeq === 'number' && Number.isSafeInteger(afterSeq) && afterSeq >= 0) {
        baselines.set(roomId, afterSeq)
      }
    }
    return baselines
  } catch {
    return new Map()
  }
}

async function enumerateRooms({ target, token }) {
  const response = await roundTrip(target, 'GET', '/api/rooms', protocolHeaders(token), undefined)
  if (response.status !== 200) {
    throw new AgentRoomRuntimeError(
      response.body?.error?.code ?? 'request_failed',
      response.body?.error?.message ?? `the agent-room server answered ${response.status}`,
    )
  }
  const rooms = response.body?.result?.rooms
  if (!Array.isArray(rooms)) {
    throw new AgentRoomRuntimeError('request_failed', 'the agent-room server answered an unreadable room list')
  }
  return rooms
    .filter(room => typeof room?.room_id === 'string' && room.room_id.length > 0)
    .map(room => room.room_id)
}

// `agent-room wait [--room <room_id>]... [--timeout <seconds>]` — the
// companion notifier. Repeated --room narrows the watch; the default watches
// every room of this Actor.
export async function runWaitFamilyCommand(tokens, { sharedDataDir, pluginDataDir }) {
  const rooms = []
  let timeoutSeconds
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--room') {
      const value = tokens[index + 1]
      if (value === undefined || value.startsWith('--')) {
        return usageMessage('--room needs a room id: agent-room wait [--room <room_id>]... [--timeout <seconds>]')
      }
      rooms.push(value)
      index += 1
      continue
    }
    if (token === '--timeout') {
      const value = tokens[index + 1]
      if (value === undefined || value.startsWith('--') || !/^[0-9]+$/.test(value)) {
        return usageMessage('--timeout needs an integer number of seconds (1 to 600)')
      }
      timeoutSeconds = Number(value)
      index += 1
      continue
    }
    if (token.startsWith('--')) {
      return usageMessage(`unknown option "${token}"; see "agent-room help"`)
    }
    return usageMessage(`unexpected argument "${token}"; agent-room wait takes options only`)
  }
  if (timeoutSeconds === undefined) timeoutSeconds = WAIT_DEFAULT_TIMEOUT_S
  if (!Number.isSafeInteger(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > WAIT_MAX_TIMEOUT_S) {
    return usageMessage(`--timeout must be an integer from 1 to ${WAIT_MAX_TIMEOUT_S}`)
  }
  if (rooms.length !== new Set(rooms).size) {
    return usageMessage('--room repeats a room id; each room may be named once')
  }

  // Identity discipline: the wait reuses the existing installation and
  // creates nothing. No configured Chat ID → a coded refusal, before any
  // server is booted or any key is materialized.
  const configPath = join(pluginDataDir, 'config.json')
  if (!existsSync(configPath)) {
    return {
      status: 'refusal',
      command: 'wait',
      code: 'not_set_up',
      message: 'No Chat ID is configured for this installation. Run "agent-room setup --chat-id <chat-id>" first (it never needs a terminal), then start the wait again.',
    }
  }
  let config
  try {
    config = loadChatIdConfig(pluginDataDir)
  } catch (error) {
    return {
      status: 'refusal',
      command: 'wait',
      code: error?.code ?? 'request_failed',
      message: error?.message ?? String(error),
    }
  }

  const startedMs = performance.now()
  const deadlineAt = startedMs + timeoutSeconds * 1000
  const lock = acquireWaitLock(pluginDataDir, timeoutSeconds * 1000)
  if (!lock.acquired) {
    return {
      status: 'refusal',
      command: 'wait',
      code: 'wait_already_active',
      message: `Another agent-room wait is already running for this installation (its pid is recorded in ${lock.path}). One wait process per installation: consume its hint, then start the next wait.`,
    }
  }
  try {
    // The transport: a configured remote origin is the remote lane; otherwise
    // the shared local server (which the wait boots if it is not running).
    const remote = loadRemoteConfig(pluginDataDir)
    const target = remote !== null
      ? { kind: 'remote', serverUrl: remote.serverUrl }
      : { kind: 'local', port: (await ensureServer({ dataDir: sharedDataDir })).port }
    // An UNBOUND CLI session — the wait never claims the Chat ID; the live
    // MCP client keeps it. Same identity, no occupancy.
    const { token, fingerprint: ownFingerprint } = await authenticate(target, { pluginDataDir, sharedDataDir })
    const status = await roundTrip(target, 'GET', '/api/status', protocolHeaders(token), undefined)
    const realmId = status.body?.result?.realm_id
    if (status.status !== 200 || typeof realmId !== 'string') {
      throw new AgentRoomRuntimeError(
        status.body?.error?.code ?? 'request_failed',
        status.body?.error?.message ?? 'the agent-room server answered an unreadable status',
      )
    }
    const baselines = loadBaselineCursors(pluginDataDir, realmId)

    // Fixed rooms (--room) are validated against the enumeration once; the
    // all-rooms default re-enumerates every cycle so a DM opened mid-wait is
    // discovered (an unknown --room is a coded refusal, never a silent
    // watch of nothing).
    const firstRooms = await enumerateRooms({ target, token })
    let fixedRooms = null
    if (rooms.length > 0) {
      const known = new Set(firstRooms)
      const unknownRoom = rooms.find(room => !known.has(room))
      if (unknownRoom !== undefined) {
        return {
          status: 'refusal',
          command: 'wait',
          code: 'room_not_found',
          message: `Room "${unknownRoom}" is not among the rooms of this Actor (chat id "${config.chatId}"); the wait watches existing rooms only. Open or discover the room first, then wait again.`,
        }
      }
      fixedRooms = rooms
    }

    let watched = fixedRooms ?? firstRooms
    for (;;) {
      const remainingMs = deadlineAt - performance.now()
      if (remainingMs <= 0) break
      if (fixedRooms === null) {
        watched = await enumerateRooms({ target, token })
      }
      const holdMs = Math.min(READ_HOLD_MAX_MS, Math.floor(remainingMs))
      const held = watched.slice(0, WAIT_CONCURRENCY_MAX)
      const overflow = watched.slice(WAIT_CONCURRENCY_MAX)
      const attempts = []
      for (const roomId of held) {
        attempts.push(holdForRoom({
          target, token, roomId, holdMs, ownFingerprint, baselines,
          afterSeq: baselines.get(roomId) ?? 0,
        }))
      }
      // The fence's overflow: beyond six rooms the extras are head-checked
      // (wait_ms=0) once per cycle — discovered late by at most one cycle,
      // never unwatched.
      for (const roomId of overflow) {
        attempts.push(holdForRoom({
          target, token, roomId, holdMs: 0, ownFingerprint, baselines,
          afterSeq: baselines.get(roomId) ?? 0,
        }))
      }
      const hit = await firstHit(attempts)
      if (hit !== null) {
        return {
          status: 'ok',
          command: 'wait',
          lines: [JSON.stringify({
            ok: true,
            command: 'wait',
            status: 'new_messages',
            room_id: hit.room_id,
            seq: hit.seq,
            elapsed_ms: Math.round(performance.now() - startedMs),
          })],
        }
      }
    }
    // A clean timeout is a hint, not a failure: the agent re-arms by
    // launching the next wait as its ordinary next action.
    return {
      status: 'ok',
      command: 'wait',
      lines: [JSON.stringify({
        ok: true,
        command: 'wait',
        status: 'timeout',
        elapsed_ms: Math.round(performance.now() - startedMs),
        watched,
        unwatched: [],
      })],
    }
  } catch (error) {
    return {
      status: 'refusal',
      command: 'wait',
      code: error?.code ?? 'request_failed',
      message: error?.message ?? String(error),
    }
  } finally {
    releaseWaitLock(lock.path)
  }
}
