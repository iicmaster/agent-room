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
// - Hint-ONLY output (never message bodies): the same client-side trust
//   matrix classifies raw server rows before wake policy; a hint never advances
//   the consumed cursor or reads/exports held bodies. One JSON line on stdout:
//   {ok:true, command:'wait', status:'new_messages', room_id, seq, elapsed_ms}
//   or {ok:true, command:'wait', status:'timeout', elapsed_ms, watched, unwatched}.
// - Creates NOTHING: the wait reuses the existing installation (config,
//   keypair, origin) and never writes config, consumed cursor, held cache, or
//   allowlist — it may write Notification's shared wake ledger plus wait.lock.
//   Missing pieces refuse;
//   they are never silently created by a background process.
// - One wait process per installation: PLUGIN_DATA/wait.lock (0600).
//   The fence FAILS CLOSED on existing and stale locks alike (the auto
//   path never takes a lock aside); the explicit `--reclaim` force reset
//   — used only with every waiter/launcher quiesced — is the recovery.
// - Grammar (the machine-readable families'): success prints the hint on
//   stdout and exits 0 (a clean timeout is a HINT, not a failure — the
//   re-arm is the agent's ordinary next action); a refusal prints ONE JSON
//   object on stderr and exits 1; usage exits 2.

import { existsSync, linkSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { performance } from 'node:perf_hooks'

import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  READ_HOLD_MAX_MS,
  SESSION_SCOPE_PATTERN,
  TRAILING_COALESCE_MS,
  WAIT_DEFAULT_TIMEOUT_S,
  WAIT_MAX_TIMEOUT_S,
  WATCH_CURSOR_ROOM_MAX,
  WATCH_CURSORS_PARAM_MAX_BYTES,
  WATCH_RECONNECT_BASE_MS,
  WATCH_RECONNECT_MAX_MS,
} from '../constants.mjs'
// Story 3.2: the two-phase wake guard rides this long-poll. The transport
// stays the v0.9 long-poll in this story (3.3 swaps it for /api/watch).
import { createScopeLedger } from '../client/scope-ledger.mjs'
import { coalesce } from '../notification/loop-guard.mjs'
import { createWakeDispatcher, pauseHint } from '../notification/wake-dispatcher.mjs'
// Story 3.3: watches via the 3.1 client (already on Session capability), and
// appends each wake to the bounded, allowlisted inbox under inbox.lock. Both
// reuse existing primitives — no fourth lock, no fourth path builder.
import { openWatchStream, watchBackoffMs } from '../client/watch-client.mjs'
import { appendInboxEntry, readLastInboxWakeAtMs } from '../client/inbox.mjs'
import { AgentRoomRuntimeError, assertSafePathKey, ensurePrivateDirectory, isPidAlive, readJsonFile } from '../runtime.mjs'
import { CURSORS_FILENAME, cursorLockPath, persistedCursorPath, readCursorsDocument, withCursorLock } from '../client/cursors.mjs'
import { CONNECTION_MODE_ENV, loadChatIdConfig } from '../client/api-client.mjs'
import { REMOTE_TRANSPORT } from '../client/trust.mjs'
import { createDeliveryClassifier } from '../notification/delivery.mjs'
import { ensureServer } from '../client/ensure-server.mjs'
import { loadRemoteConfig } from '../client/remote-config.mjs'
import { sessionScopeKey, sessionsDirectoryPath, sessionScopeFilePath, loadSessionState } from '../client/session-state.mjs'
import { authenticate, protocolHeaders, roundTrip } from './session-commands.mjs'
import { decideHeldWake, loadWakePolicy, policyIdentity } from '../notification/wake-policy.mjs'

// The concurrency fence: at most six held long-polls at once. With the 20 s
// hold that is ≈3 requests/min per watched room — 18/min at the fence —
// against the 120/min/key budget, leaving the burst untouched.
const WAIT_CONCURRENCY_MAX = 6
// The outer deadline: default and hard maximum in seconds now come from the
// single AD-9 source (server/constants.mjs). The deadline is monotonic
// (performance.now) and covers auth, discovery, watch and every reconnect —
// it never resets mid-wait.
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

// First candidate wins the host wake. Probes are pure (no ledger grant); on
// the first candidate the shared signal aborts losing HTTP holds, and the
// caller drains every attempt before deciding/granting/outputting. Thus a
// losing room can never consume a cooldown or aggregate budget after the
// winning hint.
function firstCandidate(attempts, controller) {
  return new Promise((resolvePromise, rejectPromise) => {
    let pending = attempts.length
    if (pending === 0) return resolvePromise(null)
    let settled = false
    const quiet = () => {
      pending -= 1
      if (!settled && pending === 0) {
        settled = true
        resolvePromise(null)
      }
    }
    for (const attempt of attempts) {
      attempt.then(candidates => {
        if (settled) return
        if (Array.isArray(candidates) && candidates.length > 0) {
          settled = true
          controller.abort(new AgentRoomRuntimeError('request_cancelled', 'another room produced the wait candidate'))
          resolvePromise(candidates[0])
        } else quiet()
      }, error => {
        if (settled || controller.signal.aborted) { quiet(); return }
        settled = true
        controller.abort(error)
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
// page was all-own. The ratified wake policy (2026-11-01) extends the skip
// to HELD rows whose sender is within its wake cooldown or whose wake would
// breach the installation's held-wake budget — a suppressed row is skipped
// here, never consumed; the next wait re-decides it. The hint's seq is the
// FIRST wakeable unread sequence from someone else; an unread backlog of
// any size fires the same way — the full catch-up read is message_read's
// job, not the hint's.
async function holdForRoom({ target, token, capability, roomId, afterSeq, holdMs, ownFingerprint, baselines, classifyRow, decideHeld, suppressedSenders, signal }) {
  const holdDeadline = performance.now() + holdMs
  let cursor = Math.max(afterSeq, baselines.get(roomId) ?? 0)
  for (;;) {
    const remaining = holdDeadline - performance.now()
    // A timed hold stops at its deadline; a holdMs=0 HEAD-CHECK (the fence's
    // overflow path) always issues its one immediate read — the advisory
    // review (2026-11-01) found this gate returning null before any request,
    // so rooms beyond the six held ones were never checked at all while the
    // timeout hint claimed unwatched: [].
    if (remaining <= 0 && holdMs > 0) return null
    const hold = Math.min(READ_HOLD_MAX_MS, Math.max(0, Math.floor(remaining)))
    const response = await roundTrip(
      target,
      'GET',
      `/api/rooms/${encodeURIComponent(roomId)}/messages?after_seq=${cursor}&limit=${WAIT_PAGE_LIMIT}&wait_ms=${hold}`,
      roomHeaders({ token, capability }),
      undefined,
      hold + WAIT_HOLD_TIMEOUT_MARGIN_MS,
      { signal },
    ).catch(error => {
      if (signal?.aborted) return null
      throw error
    })
    if (response === null) return null
    if (response.status !== 200) {
      throw new AgentRoomRuntimeError(
        response.body?.error?.code ?? 'request_failed',
        response.body?.error?.message ?? `the agent-room server answered ${response.status}`,
      )
    }
    const messages = response.body?.result?.messages
    if (!Array.isArray(messages) || messages.length === 0) return null
    const candidates = []
    let allRowsOwn = true
    for (const row of messages) {
      if (row?.actor_fingerprint === ownFingerprint) continue
      allRowsOwn = false
      const verdict = classifyRow(row)
      if (verdict?.held === true) {
        if (suppressedSenders.has(verdict.actor_fingerprint)) continue
        // Do not reserve a cooldown/budget grant in a room probe. The outer
        // wait selects one deterministic winner, then requests exactly one
        // grant; losing room attempts can never burn policy state.
        candidates.push({ room_id: roomId, seq: row.seq, verdict })
      } else {
        candidates.push({ room_id: roomId, seq: row.seq, verdict })
      }
    }
    if (candidates.length > 0) return candidates
    if (allRowsOwn) {
      cursor = messages[messages.length - 1].seq
      continue
    }
    // Rows were held but already suppressed during this process. Keep them
    // unconsumed in durable state, avoid a hot loop, then let another cycle
    // observe other rooms. The next wait process re-evaluates the ledger.
    const pauseMs = Math.min(READ_HOLD_MAX_MS, Math.max(0, Math.floor(holdDeadline - performance.now())))
    if (pauseMs > 0) await new Promise(resolvePromise => setTimeout(resolvePromise, pauseMs))
    if (performance.now() >= holdDeadline) return null
    cursor = baselines.get(roomId) ?? afterSeq
  }
}

// The one-per-installation fence, FAIL-CLOSED on stale locks (the round-5
// gate): acquisition is the atomic create-only-if-absent link(2) — the
// loser's link fails EEXIST instead of replacing the winner's file — and a
// lock whose recorded pid is dead is NOT auto-reclaimed, because no
// rename-based take-over can be a compare-and-swap: a stale reader's rename
// would move WHATEVER the path holds by then, including a fresh winner's
// lock (the interleaving rename(2) cannot prove away). The auto path
// therefore refuses with the lock's location and the recorded pid; the
// EXPLICIT `--reclaim` flag is the operator's FORCE RESET \u2014 it takes
// whatever the path holds, INCLUDING a live waiter's lock, and is safe only
// when every waiter, launcher and competing reclaim is quiesced. It is a
// manual recovery contract, not a concurrency-safe protocol: one operator,
// by decision, after confirming nobody else holds the fence. A crash between the rename and the cleanup can
// leave a `wait.lock.reclaimed.<uuid>` file behind: debris beside the
// authority path, never re-imported, harmless to delete. A live waiter
// refuses the newcomer — two waiters on one installation would double the
// request budget and race each other's hints. Release is owner-checked: a
// lock whose recorded token is not ours is never removed.
function acquireWaitLock(pluginDataDir, timeoutMs, { scope = null, reclaim = false } = {}) {
  // Story 3.3: the fence is per SESSION SCOPE, built by the one path builder —
  // never at pluginDataDir root. O_CREAT|O_EXCL is enforced by linkSync's
  // hard-link creation (atomic: exactly one contender wins the name).
  const key = scope ?? sessionScopeKey({ pluginDataDir })
  const path = sessionScopeFilePath(pluginDataDir, key, 'wait.lock')
  ensurePrivateDirectory(dirname(path))
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const token = randomUUID()
    const temporary = join(dirname(path), `.wait.lock.${randomUUID()}.tmp`)
    writeFileSync(temporary, `${JSON.stringify({
      pid: process.pid,
      token,
      started_at: new Date().toISOString(),
      scope: key,
      timeout_ms: timeoutMs,
    }, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    try {
      linkSync(temporary, path)
      try { unlinkSync(temporary) } catch { /* already unlinked */ }
      return { acquired: true, path, token, scope: key }
    } catch (error) {
      try { unlinkSync(temporary) } catch { /* nothing to clean */ }
      if (error?.code !== 'EEXIST') throw error
    }
    // Read the incumbent. A LIVE pid refuses; a DEAD pid is reclaimed in
    // place (rename is the atomic steal), which is the frozen 3.3 behavior —
    // no operator --reclaim needed for a crashed waiter.
    let existing = null
    try { existing = readJsonFile(path) } catch { existing = null }
    const pid = Number.isSafeInteger(existing?.pid) && existing.pid > 1 ? existing.pid : null
    const live = pid !== null && isPidAlive(pid)
    if (live && !reclaim) {
      return {
        acquired: false, path, token: null, scope: key,
        holder: `another agent-room wait holds this session scope (pid ${pid})`,
        code: 'wait_already_active', reclaimable: false,
      }
    }
    // Dead pid (or explicit force): atomic steal via rename, then unlink.
    const reclaimed = `${path}.reclaimed.${randomUUID()}`
    try {
      renameSync(path, reclaimed)
    } catch (error) {
      if (error?.code === 'ENOENT') continue // someone else took it first
      throw error
    }
    try { unlinkSync(reclaimed) } catch { /* debris beside the authority path */ }
  }
  return {
    acquired: false, path, token: null, scope: key,
    holder: 'another process won the take-over race', code: 'wait_already_active', reclaimable: false,
  }
}

function releaseWaitLock(path, token) {
  if (token === null) return
  try {
    const existing = readJsonFile(path)
    if (existing?.token !== token) return
  } catch {
    return
  }
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
//
// v0.9.0 namespace resolution: the adapter writes per-session cursor files
// under sessions/<scope>/, and the wait process cannot know which scope is
// the live adapter's (scopes are per process), so the baseline resolves the
// NEWEST cursor file across namespaces — the per-session files first, the
// legacy realms/<realm>/ file as a candidate too. The most recently written
// position is the one actually consumed, so already-read history stays quiet
// instead of re-hinting forever.
async function loadBaselineCursors(pluginDataDir, realmId, env) {
  assertSafePathKey(realmId, { label: 'realm id' })
  // Story 2.1: v2 is the only schema, and read_seq is the only position a
  // delivered message advances (notified_seq belongs to Story 3.2's wake
  // paths — a baseline that read it would be looking at a number nothing in
  // this story writes). The newest readable document wins, exactly as before:
  // the most recently written position is the one actually consumed, so
  // already-read history stays quiet instead of re-hinting forever.
  const candidates = []
  // E2/P13: use the one sessions-directory builder (Epic 1 retro F-4). The
  // candidate's `scope` is only ever a lock key, never a stored field.
  const sessionsDir = sessionsDirectoryPath(pluginDataDir)
  if (existsSync(sessionsDir)) {
    for (const scope of readdirSync(sessionsDir)) {
      if (scope === '.' || scope === '..' || scope.startsWith('.') || !SESSION_SCOPE_PATTERN.test(scope)) continue
      const path = sessionScopeFilePath(pluginDataDir, scope, CURSORS_FILENAME)
      if (existsSync(path)) candidates.push({ path, scope, mtimeMs: statSync(path).mtimeMs })
    }
  }
  const legacyPath = persistedCursorPath(pluginDataDir, realmId)
  if (existsSync(legacyPath)) candidates.push({ path: legacyPath, scope: null, mtimeMs: statSync(legacyPath).mtimeMs })
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs)
  // E2: a candidate with no scope (legacy realms/<realm>/ path) locks under
  // this process's derived scope — the same key cursorLockPath would pick.
  const processScope = sessionScopeKey({ env, pluginDataDir })
  for (const candidate of candidates) {
    // P8: re-throw the LOUD refusals (oversize, invalid schema, lock busy) —
    // they are never "this candidate is unreadable, try the next". Only a
    // genuine shape/realm miss advances to the next candidate.
    // E2: readCursorsDocument can quarantine a corrupt v1 file WITHOUT the
    // lock; taking the SAME lock as the adapter's writer first closes the race
    // where a "read-only" baseline resets positions behind a live writer.
    const lockScope = candidate.scope ?? processScope
    // The lock file lives under sessions/<scope>/; that directory may not
    // exist yet for a process-derived scope with no stored session state.
    // Create it owner-only before openSync('wx') (the cursor writer's own
    // discipline) so a legacy/foreign baseline never dies with ENOENT.
    ensurePrivateDirectory(dirname(cursorLockPath(pluginDataDir, { scope: lockScope })))
    const { document } = await withCursorLock(
      pluginDataDir,
      () => readCursorsDocument(pluginDataDir, { realmId, path: candidate.path, scope: candidate.scope }),
      { scope: lockScope },
    )
    const rooms = document.realms[realmId]?.rooms ?? {}
    const baselines = new Map()
    for (const [roomId, entry] of Object.entries(rooms)) {
      if (Number.isSafeInteger(entry?.read_seq) && entry.read_seq >= 0) baselines.set(roomId, entry.read_seq)
    }
    return baselines
  }
  return new Map()
}

// Gap 2.1: Bearer no longer sees `ssession:` pair rooms. When this scope has a
// stored Session capability, use `Authorization: Session <capability>` for room
// enumeration and long-polls; otherwise keep the Bearer path (a setup-less
// waiter has no capability to use). Stored capability is client-side state; no
// new session is minted here, so this adds no presence/lease footprint.
function roomHeaders({ token, capability }) {
  if (typeof capability === 'string' && capability.length > 0) {
    return { [PROTOCOL_HEADER]: PROTOCOL_VERSION, authorization: `Session ${capability}` }
  }
  return protocolHeaders(token)
}

async function enumerateRooms({ target, token, capability }) {
  const response = await roundTrip(target, 'GET', '/api/rooms', roomHeaders({ token, capability }), undefined)
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

// Story 3.3: wait over /api/watch. One unpooled stream (3.1 client) carries
// every message event; a dropped stream reconnects with the SAME jittered
// backoff (250/500/1000/2000 ms ±20%) until the ONE monotonic deadline. Each
// event runs through the 3.2 dispatcher (trust gate, two-phase guard) and the
// bounded inbox writer; a write failure makes dispatch return false so Phase C
// never commits notified_seq. Self-skip uses ownSessionId/ownSessionAddress
// ONLY — a sibling session on this installation still wakes us. Ban/revoke /
// superseded are terminal: stop reconnecting at once.
function buildWatchCursorsParam(baselinesMap, preferredRooms = []) {
  const orderedRooms = []
  const inserted = new Set()
  for (const roomId of preferredRooms) {
    if (typeof roomId === 'string' && roomId.length > 0 && !inserted.has(roomId)) {
      inserted.add(roomId)
      orderedRooms.push(roomId)
    }
  }
  for (const roomId of baselinesMap.keys()) {
    if (typeof roomId === 'string' && roomId.length > 0 && !inserted.has(roomId)) {
      inserted.add(roomId)
      orderedRooms.push(roomId)
    }
  }
  const payload = {}
  let count = 0
  for (const roomId of orderedRooms) {
    if (count >= WATCH_CURSOR_ROOM_MAX) break
    const rawSeq = baselinesMap.get(roomId)
    const seq = Number.isSafeInteger(rawSeq) && rawSeq >= 0 ? rawSeq : 0
    payload[roomId] = seq
    if (Buffer.byteLength(JSON.stringify(payload), 'utf8') > WATCH_CURSORS_PARAM_MAX_BYTES) {
      delete payload[roomId]
      break
    }
    count += 1
  }
  return JSON.stringify(payload)
}

export async function waitOverWatch({
  target, capability, scope, rooms, roomFilter, ownSessionId, ownSessionAddress,
  wakeDispatcher, decideHeld, decideDelivery, ledger, policy, config, startedMs, deadlineAt,
  signal, appendEntry, nowMs = () => performance.now(), connect: connectOverride = null,
  backoffMs = watchBackoffMs, sleepFn = null, baselines = null, pluginDataDir = null,
  lastWakeAt = undefined, onRescanCatchup = null,
}) {
  let trustedCount = 0
  let heldCount = 0
  let retry = 0
  let lastConnectError = null
  const terminalEvents = new Set(['session_superseded', 'actor_banned', 'session_revoked'])
  const roomBaselines = new Map(baselines instanceof Map ? baselines : [])
  for (const roomId of rooms ?? []) {
    if (!roomBaselines.has(roomId)) roomBaselines.set(roomId, 0)
  }
  const seenFrames = new Set()
  const resolvedLastWakeAt = lastWakeAt !== undefined
    ? lastWakeAt
    : readLastInboxWakeAtMs(pluginDataDir, scope)
  const wallSignal = new AbortController()
  const relayAbort = () => wallSignal.abort()
  signal.addEventListener('abort', relayAbort, { once: true })
  // A watchdog aborts the current stream exactly at the outer deadline, so a
  // dropped stream's backoff never extends past --timeout and does not reset.
  const remainingWallMs = Math.max(0, deadlineAt - nowMs())
  const deadlineTimer = setTimeout(() => wallSignal.abort(), remainingWallMs)
  deadlineTimer.unref()

  const connect = connectOverride ?? (({ signal: connectSignal }) => openWatchStream({
    ...(target.kind === 'remote' ? { url: target.serverUrl } : { port: target.port }),
    path: `/api/watch?cursors=${encodeURIComponent(buildWatchCursorsParam(roomBaselines, rooms))}`,
    headers: {
      [PROTOCOL_HEADER]: PROTOCOL_VERSION,
      authorization: `Session ${capability}`,
      accept: 'application/x-ndjson',
    },
    signal: connectSignal,
  }))
  const backoff = delay => sleepFn
    ? sleepFn(delay)
    : new Promise(resolvePromise => {
      const timer = setTimeout(resolvePromise, delay)
      wallSignal.signal.addEventListener('abort', () => { clearTimeout(timer); resolvePromise() }, { once: true })
    })

  const markSeenAndAdvance = (roomId, seq) => {
    seenFrames.add(`${roomId}:${seq}`)
    roomBaselines.set(roomId, Math.max(roomBaselines.get(roomId) ?? 0, seq))
  }

  let firstWoken = null
  let lastWoken = null
  let coalesceUntil = null

  const processMessageEvent = async event => {
    const frameKey = `${event.room_id}:${event.seq}`
    if (seenFrames.has(frameKey)) return null
    const own = (typeof event.chat_id === 'string' && event.chat_id === ownSessionAddress)
      || (typeof event.session_id === 'string' && event.session_id === ownSessionId)
    if (own) {
      markSeenAndAdvance(event.room_id, event.seq)
      return null
    }
    if (roomFilter !== null && !roomFilter.has(event.room_id)) return null

    const classified = decideDelivery
      ? decideDelivery({
        room_id: event.room_id, seq: event.seq, chat_id: event.chat_id,
        text: event.text, actor_fingerprint: event.fingerprint, created_at: event.created_at,
      })
      : null
    const row = classified ?? {
      room_id: event.room_id, seq: event.seq, chat_id: event.chat_id,
      text: event.text, actor_fingerprint: event.fingerprint, created_at: event.created_at,
    }
    const candidate = wakeDispatcher.gate({
      ...row,
      held: classified?.held === true,
      actor_fingerprint: row.actor_fingerprint,
    })
    if (candidate.held) {
      const hit = decideHeldWake({
        pluginData: ledger.pluginData, realmId: ledger.realmId,
        identity: ledger.identity, fingerprint: candidate.actor_fingerprint, policy,
      })
      if (hit === false) {
        markSeenAndAdvance(event.room_id, event.seq)
        return null
      }
      const { text: _heldText, ...heldMeta } = row
      let written = true
      try { await appendEntry({ ...heldMeta, trusted: false, held: true }) } catch { written = false }
      if (!written) return null
      wakeDispatcher.dispatchHeld({
        room_id: candidate.room_id, seq: candidate.seq, actor_fingerprint: candidate.actor_fingerprint,
      })
      markSeenAndAdvance(event.room_id, event.seq)
      heldCount += 1
    } else {
      const local = config?.chat_id ?? scope
      const peer = candidate.actor_fingerprint ?? 'unknown'
      const dispatch = async () => {
        try {
          await appendEntry({ ...row, trusted: true })
          return true
        } catch {
          return false
        }
      }
      const result = await wakeDispatcher.dispatchTrusted(
        { room_id: candidate.room_id, seq: candidate.seq, actor_fingerprint: peer, held: false },
        { local, peer, dispatch },
      )
      if (result.action === 'paused') {
        return {
          status: 'ok', command: 'wait',
          lines: [JSON.stringify({
            ok: true, command: 'wait', status: 'paused',
            message: pauseHint(result.reason, peer), room_id: candidate.room_id,
            seq: candidate.seq, elapsed_ms: Math.round(nowMs() - startedMs),
          })],
        }
      }
      markSeenAndAdvance(event.room_id, event.seq)
      if (result.ok === true) trustedCount += 1
    }

    lastWoken = {
      room_id: candidate.room_id,
      seq: candidate.seq,
      peer: candidate.actor_fingerprint ?? 'unknown',
    }
    firstWoken ??= lastWoken
    return { woke: true }
  }

  const wakeEnvelope = () => ({
    status: 'ok', command: 'wait',
    lines: [JSON.stringify({
      ok: true, command: 'wait', status: 'new_messages',
      message: `woke: ${trustedCount} trusted, ${heldCount} held`,
      room_id: (lastWoken ?? firstWoken).room_id,
      seq: (lastWoken ?? firstWoken).seq,
      ...(trustedCount + heldCount > 1 ? { coalesced: trustedCount + heldCount } : {}),
      elapsed_ms: Math.round(nowMs() - startedMs),
    })],
  })

  try {
    while (!wallSignal.signal.aborted) {
      const attemptController = new AbortController()
      const relayWall = () => attemptController.abort()
      wallSignal.signal.addEventListener('abort', relayWall, { once: true })
      let coalesceTimer = null
      let coalesceElapsed = false
      let stream
      try {
        stream = await connect({ signal: attemptController.signal })
      } catch (error) {
        wallSignal.signal.removeEventListener('abort', relayWall)
        if (wallSignal.signal.aborted) break
        lastConnectError = error
        retry += 1
        const delay = Math.min(backoffMs(retry), Math.max(0, deadlineAt - nowMs()))
        if (delay <= 0) break
        await backoff(delay)
        continue
      }
      retry = 0
      let terminal = false
      let rescanEvent = null
      try {
        for await (const event of stream.frames) {
          if (wallSignal.signal.aborted || terminal || coalesceElapsed) break
          if (event && typeof event === 'object') lastConnectError = null
          if (event?.event === 'message') {
            const processed = await processMessageEvent(event)
            if (processed?.status === 'ok') return processed
            if (processed?.woke && coalesceUntil === null) {
              const burst = coalesce(
                [{ room_id: lastWoken.room_id, peer: lastWoken.peer, seq: lastWoken.seq }],
                { now: Date.now(), lastWakeAt: resolvedLastWakeAt },
              )
              const boundedDelay = Math.min(burst.delayMs, Math.max(0, Math.floor(deadlineAt - nowMs())))
              if (boundedDelay <= 0) return wakeEnvelope()
              coalesceUntil = nowMs() + boundedDelay
              coalesceTimer = setTimeout(() => {
                coalesceElapsed = true
                attemptController.abort()
              }, boundedDelay)
              coalesceTimer.unref()
            } else if (coalesceUntil !== null && nowMs() >= coalesceUntil) {
              return wakeEnvelope()
            }
          } else if (event?.event === 'rescan_required') {
            rescanEvent = event
            break
          } else if (terminalEvents.has(event?.event)) {
            terminal = true
          }
        }
      } catch (error) {
        if (!wallSignal.signal.aborted && !coalesceElapsed) lastConnectError = error
      } finally {
        attemptController.abort()
        if (coalesceTimer !== null) clearTimeout(coalesceTimer)
        wallSignal.signal.removeEventListener('abort', relayWall)
      }
      if (firstWoken !== null) return wakeEnvelope()
      if (rescanEvent !== null) {
        if (rescanEvent.reason === 'catchup_limit' && typeof onRescanCatchup === 'function') {
          try {
            const catchupRows = await onRescanCatchup(roomBaselines, wallSignal.signal)
            for (const row of catchupRows ?? []) {
              const processed = await processMessageEvent(row)
              if (processed?.status === 'ok') return processed
            }
            if (firstWoken !== null) return wakeEnvelope()
          } catch (error) {
            if (!wallSignal.signal.aborted) lastConnectError = error
          }
        }
        if (wallSignal.signal.aborted) break
        continue
      }
      if (terminal || wallSignal.signal.aborted) break
      retry += 1
      const delay = Math.min(backoffMs(retry), Math.max(0, deadlineAt - nowMs()))
      if (delay <= 0) break
      await backoff(delay)
    }
    if (firstWoken !== null) return wakeEnvelope()
    let lastErrorDetail
    if (lastConnectError !== null) {
      const code = typeof lastConnectError?.code === 'string' && lastConnectError.code.length > 0
        ? lastConnectError.code
        : 'watch_connect_failed'
      const message = String(lastConnectError?.message ?? lastConnectError)
      lastErrorDetail = { code, message }
      process.stderr.write(`[agent-room wait] watch stream fault (${code}): ${message}\n`)
    }
    return {
      status: 'ok', command: 'wait',
      lines: [JSON.stringify({
        ok: true, command: 'wait', status: 'timeout',
        message: 'timeout: no new messages',
        ...(lastErrorDetail === undefined ? {} : { last_error: lastErrorDetail }),
        elapsed_ms: Math.round(nowMs() - startedMs), watched: rooms,
      })],
    }
  } finally {
    clearTimeout(deadlineTimer)
    // Destroy the open watch socket on EVERY exit path (wake/pause/timeout) —
    // an un-aborted stream is a live handle that keeps the CLI process alive.
    wallSignal.abort()
    signal.removeEventListener('abort', relayAbort)
  }
}

// `agent-room wait [--room <room_id>]... [--timeout <seconds>]` — the
// companion notifier. Repeated --room narrows the watch; the default watches
// every room of this Actor.
export async function runWaitFamilyCommand(tokens, { sharedDataDir, pluginDataDir, env = process.env }) {
  const rooms = []
  let timeoutSeconds
  let reclaim = false
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
        return usageMessage(`--timeout needs an integer number of seconds (1 to ${WAIT_MAX_TIMEOUT_S})`)
      }
      timeoutSeconds = Number(value)
      index += 1
      continue
    }
    if (token === '--reclaim') {
      reclaim = true
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
  // creates nothing. Accept either a v1.0 scope session.json (created by
  // `agent-room bootstrap`) or a legacy config.json (`agent-room setup`). No
  // configured identity -> coded refusal before any server boot or wait.lock.
  const scope = sessionScopeKey({ env, pluginDataDir })
  const configPath = join(pluginDataDir, 'config.json')
  let precheckSession = null
  try { precheckSession = loadSessionState(pluginDataDir, scope) } catch { /* handled cleanly if config absent */ }
  let config
  if (existsSync(configPath)) {
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
  } else if (precheckSession !== null) {
    config = { chatId: precheckSession.baseName }
  } else {
    return {
      status: 'refusal',
      command: 'wait',
      code: 'not_set_up',
      message: 'No Chat ID is configured for this installation. Run "agent-room bootstrap" (or legacy "agent-room setup --chat-id <chat-id>") first, then start the wait again.',
    }
  }

  const declaredRemote = env[CONNECTION_MODE_ENV] === REMOTE_TRANSPORT
  const startedMs = performance.now()
  const deadlineAt = startedMs + timeoutSeconds * 1000
  const lock = acquireWaitLock(pluginDataDir, timeoutSeconds * 1000, { scope, reclaim })
  if (!lock.acquired) {
    const guidance = lock.reclaimable === true
      ? ` The lock is held by ${lock.holder}. If you have confirmed no wait is running, take the fence with the force reset: agent-room wait --reclaim (it removes whatever holds the fence and starts — run it only with every waiter and competing launcher quiesced).`
      : ` The lock is held by ${lock.holder}. One wait process per installation: consume its hint, then start the next wait.`
    return {
      status: 'refusal',
      command: 'wait',
      code: 'wait_already_active',
      message: `agent-room wait did not start: the fence at ${lock.path} did not open.${guidance}`,
    }
  }
  // SIGINT/SIGTERM: abort every in-flight hold/watch and let the `finally`
  // release wait.lock cleanly. A repeated signal escalates to the default
  // termination, so a stuck process can still be killed by an operator.
  const signalController = new AbortController()
  const installSignalRelease = () => {
    let interrupted = false
    const handler = () => {
      signalController.abort(new AgentRoomRuntimeError('request_cancelled', 'wait interrupted by signal'))
      releaseWaitLock(lock.path, lock.token)
      if (interrupted) process.exit(130)
      interrupted = true
    }
    process.once('SIGINT', handler)
    process.once('SIGTERM', handler)
    return () => {
      process.removeListener('SIGINT', handler)
      process.removeListener('SIGTERM', handler)
    }
  }
  let removeSignalRelease = () => {}
  try {
    removeSignalRelease = installSignalRelease()
    // The transport: a configured remote origin is the remote lane; otherwise
    // the shared local server (which the wait boots if it is not running).
    const remote = loadRemoteConfig(pluginDataDir)
    const target = remote !== null
      ? { kind: 'remote', serverUrl: remote.serverUrl }
      : { kind: 'local', port: (await ensureServer({
        dataDir: sharedDataDir,
        ...(declaredRemote ? { connectionMode: REMOTE_TRANSPORT } : {}),
      })).port }
    // An UNBOUND CLI session — the wait never claims the Chat ID; the live
    // MCP client keeps it. Same identity, no occupancy. The credential lane
    // and trust transport are returned by authentication, not inferred from
    // whether the HTTP target is loopback or HTTPS.
    const { token, fingerprint: ownFingerprint, transport } = await authenticate(
      target,
      { pluginDataDir, sharedDataDir, env },
    )
    // Gap 2.1: a stored Session capability (if this installation has one) sees
    // `ssession:` pair rooms; the unbound Bearer token alone does not. Missing
    // or unusable state simply keeps the Bearer path.
    const waitScope = sessionScopeKey({ env, pluginDataDir })
    let storedSession = null
    try { storedSession = loadSessionState(pluginDataDir, waitScope) } catch { /* Bearer fallback */ }
    const capability = storedSession?.capability ?? null
    // Self-skip identity: ONLY this session's own id/address. A sibling session
    // of this installation is a different principal and is never skipped.
    const ownSessionId = storedSession?.sessionId ?? null
    const ownSessionAddress = storedSession?.address ?? null
    const status = await roundTrip(target, 'GET', '/api/status', protocolHeaders(token), undefined)
    const realmId = status.body?.result?.realm_id
    if (status.status !== 200 || typeof realmId !== 'string') {
      throw new AgentRoomRuntimeError(
        status.body?.error?.code ?? 'request_failed',
        status.body?.error?.message ?? 'the agent-room server answered an unreadable status',
      )
    }
    const baselines = await loadBaselineCursors(pluginDataDir, realmId, env)
    // The wait reads raw HTTP rows. Apply this receiving installation's local
    // trust matrix before wake policy; row.held is not present on server rows.
    // A fresh allowlist read per row observes an allow/revoke while the wait
    // is active. Transport is the mode earned by this credential exchange,
    // not guessed from the HTTP endpoint (declared-remote loopback is remote).
    const delivery = createDeliveryClassifier({ pluginDataDir, realmId, ownFingerprint, transport })
    const decideDelivery = row => delivery.classifyRow(row)
    // The ratified wake policy: the same ledger the always-on notifier uses
    // gates the wait's held-row hints (server/notification/wake-policy.mjs).
    // The identity (explicit env layer + re-baseline flag) rides along so the
    // shared ledger can verify policy agreement across both substrates.
    const policy = loadWakePolicy(env)
    const identity = policyIdentity(env)
    const ledger = { pluginData: pluginDataDir, realmId, identity }
    const decideHeld = row => decideHeldWake({ ...ledger, fingerprint: row.actor_fingerprint, policy })
    // A held sender denied during this wait stays in the log but is quiet for
    // this process lifetime. This prevents repeat reads from busy-looping; a
    // newly armed wait re-evaluates against the persistent cooldown/allowlist.
    const suppressedSenders = new Set()

    // Story 3.2: one loop ledger for this session scope, one dispatcher. The
    // trust matrix above has ALREADY run (delivery.classifyRow); the dispatcher
    // routes the winning candidate through Phase A reserve → Phase B (this wake
    // IS the dispatch — the wait returning to its caller) → Phase C CAS to both
    // the ledger and cursors.json v2. A hard pause returns exit 0 with a LOCAL
    // message and posts nothing to chat. The guard is client-side state only.
    const loopLedger = createScopeLedger(pluginDataDir, waitScope)
    const wakeDispatcher = createWakeDispatcher({
      ledger: loopLedger,
      pluginDataDir,
      realmId,
      scope: waitScope,
      // The trust matrix has ALREADY run via decideDelivery (gate before
      // ledger). The candidate arrives classified; these seams exist so the
      // dispatcher owns the two-phase protocol without re-classifying. Held
      // rows never reach dispatchTrusted — they keep the wake-ledger cooldown.
      classifyRow: row => ({ held: row?.held === true, actor_fingerprint: row?.actor_fingerprint }),
      decideHeld: () => true,
    })

    // Fixed rooms (--room) are validated against the enumeration once; the
    // all-rooms default re-enumerates every cycle so a DM opened mid-wait is
    // discovered (an unknown --room is a coded refusal, never a silent
    // watch of nothing).
    const firstRooms = await enumerateRooms({ target, token, capability })
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

    // Story 3.3: when this scope holds a Session capability, wait over the
    // single /api/watch stream (fast, idle-query-free, sees `ssession:` pair
    // rooms — closing the Bearer gap). Without a capability (setup-less or an
    // installation that never allocated a session) keep the v0.9 long-poll;
    // the two share the SAME 3.2 guard and the same exit/envelope contract.
    if (capability !== null) {
      const roomFilter = fixedRooms === null ? null : new Set(fixedRooms)
      const appendEntry = row => appendInboxEntry(pluginDataDir, waitScope, row)
      const onRescanCatchup = async (roomBaselinesMap, catchupSignal) => {
        const candidateRooms = fixedRooms ?? await enumerateRooms({ target, token, capability })
        const rows = []
        for (const roomId of candidateRooms) {
          if (catchupSignal?.aborted) break
          const afterSeq = roomBaselinesMap.get(roomId) ?? 0
          const res = await roundTrip(
            target,
            'GET',
            `/api/rooms/${encodeURIComponent(roomId)}/messages?after_seq=${afterSeq}&limit=${WAIT_PAGE_LIMIT}&wait_ms=0`,
            roomHeaders({ token, capability }),
            undefined,
            WAIT_HOLD_TIMEOUT_MARGIN_MS,
            { signal: catchupSignal },
          )
          if (res.status !== 200) continue
          const messages = res.body?.result?.messages
          if (!Array.isArray(messages)) continue
          for (const msg of messages) {
            rows.push({
              event: 'message',
              room_id: roomId,
              seq: msg.seq,
              chat_id: msg.chat_id,
              fingerprint: msg.actor_fingerprint,
              text: msg.text,
              created_at: msg.created_at,
            })
          }
          if (rows.length > 0) break
        }
        return rows
      }
      const watchOutcome = await waitOverWatch({
        target, capability, scope: waitScope,
        rooms: fixedRooms ?? firstRooms, roomFilter, ownSessionId, ownSessionAddress,
        wakeDispatcher, decideHeld, decideDelivery, ledger, policy, config,
        startedMs, deadlineAt, signal: signalController.signal, appendEntry,
        baselines, pluginDataDir, onRescanCatchup,
      })
      loopLedger.close()
      return watchOutcome
    }

    let watched = fixedRooms ?? firstRooms
    for (;;) {
      const remainingMs = deadlineAt - performance.now()
      if (remainingMs <= 0) break
      if (fixedRooms === null) {
        watched = await enumerateRooms({ target, token, capability })
      }
      const holdMs = Math.min(READ_HOLD_MAX_MS, Math.floor(remainingMs))
      const held = watched.slice(0, WAIT_CONCURRENCY_MAX)
      const overflow = watched.slice(WAIT_CONCURRENCY_MAX)
      const cycleController = new AbortController()
      const attempts = []
      for (const roomId of held) {
        attempts.push(holdForRoom({
          target, token, capability, roomId, holdMs, ownFingerprint, baselines,
          classifyRow: decideDelivery, decideHeld, suppressedSenders,
          signal: cycleController.signal,
          afterSeq: baselines.get(roomId) ?? 0,
        }))
      }
      // Beyond six held rooms, issue one immediate head-check each cycle.
      for (const roomId of overflow) {
        attempts.push(holdForRoom({
          target, token, roomId, holdMs: 0, ownFingerprint, baselines,
          classifyRow: decideDelivery, decideHeld, suppressedSenders,
          signal: cycleController.signal,
          afterSeq: baselines.get(roomId) ?? 0,
        }))
      }
      const candidate = await firstCandidate(attempts, cycleController)
      // Wait for every aborted loser to settle before reserving a grant,
      // returning output, or releasing wait.lock. Losers never run policy.
      await Promise.allSettled(attempts)
      if (candidate === null) continue
      const isHeld = candidate.verdict?.held === true
      if (isHeld) {
        // Held: keep the existing 300 s / 10-per-60 s wake-ledger cooldown.
        // No loop-ledger reserve, no G1/G2, no notified_seq; the dispatcher
        // records a SEPARATE suppressed_held_seq so a later Trusted row is
        // never hidden (Held 10 cannot mask Trusted 9).
        const hit = decideHeldWake({ ...ledger, fingerprint: candidate.verdict.actor_fingerprint, policy })
        if (hit === false) {
          suppressedSenders.add(candidate.verdict.actor_fingerprint)
          continue
        }
        wakeDispatcher.dispatchHeld({
          room_id: candidate.room_id,
          seq: candidate.seq,
          actor_fingerprint: candidate.verdict.actor_fingerprint,
        })
        baselines.set(candidate.room_id, Math.max(baselines.get(candidate.room_id) ?? 0, candidate.seq))
        return {
          status: 'ok',
          command: 'wait',
          lines: [JSON.stringify({
            ok: true,
            command: 'wait',
            status: 'new_messages',
            room_id: candidate.room_id,
            seq: candidate.seq,
            elapsed_ms: Math.round(performance.now() - startedMs),
          })],
        }
      }

      // Trusted: the two-phase guard. Phase B is the wait itself returning to
      // its caller — dispatch() succeeds only when we actually emit the wake.
      const local = config?.chat_id ?? waitScope
      const peer = candidate.verdict?.actor_fingerprint ?? 'unknown'
      const wakeResult = await wakeDispatcher.dispatchTrusted(
        { room_id: candidate.room_id, seq: candidate.seq, actor_fingerprint: peer, held: false },
        { local, peer, dispatch: () => true },
      )
      loopLedger.drainDiagnostics().forEach(line => process.stderr.write(`${line}\n`))
      if (wakeResult.action === 'paused') {
        // Hard Pause: exit 0, LOCAL message only, NOTHING posted to chat.
        return {
          status: 'ok',
          command: 'wait',
          lines: [JSON.stringify({
            ok: true,
            command: 'wait',
            status: 'paused',
            message: pauseHint(wakeResult.reason, peer),
            room_id: candidate.room_id,
            seq: candidate.seq,
            elapsed_ms: Math.round(performance.now() - startedMs),
          })],
        }
      }
      if (wakeResult.action === 'skipped' && wakeResult.reason === 'ledger_busy') {
        // SQLITE_BUSY > 5 s: skip this wake round with diagnostics, never crash.
        continue
      }
      baselines.set(candidate.room_id, Math.max(baselines.get(candidate.room_id) ?? 0, candidate.seq))
      return {
        status: 'ok',
        command: 'wait',
        lines: [JSON.stringify({
          ok: true,
          command: 'wait',
          status: 'new_messages',
          room_id: candidate.room_id,
          seq: candidate.seq,
          elapsed_ms: Math.round(performance.now() - startedMs),
        })],
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
    removeSignalRelease()
    releaseWaitLock(lock.path, lock.token)
  }
}
