// The one-shot send/read commands — the non-MCP on-ramp (v0.8.0, the codex
// round-table's "every tool" item). A tool with no MCP client and no long-
// lived process can still be a sender and a reader over the same HTTPS wire
// the MCP adapter uses, through the same authentication (local token lane or
// the challenge-answer lane against a configured remote origin) and the same
// receiver-side trust matrix.
//
// THE CONTRACT, stated in every receipt so a script never has to guess:
//   - `send` reports the transport's own statuses — accepted (the log commit;
//     NOT a wake receipt), duplicate_dropped (the content gate, not the
//     idempotency key — the caller chose a fresh client_message_id), and
//     storage_low (the store refused below the reserve; nothing was written).
//     The client_message_id is printed on every receipt so a lost response
//     can be retried with the identical id.
//   - `read` applies this installation's trust matrix before printing (held
//     rows keep metadata, never a body, exactly like message_read) and NEVER
//     writes state: no cursor advance, no held registration. Resuming a
//     one-shot reader is the caller's job — pass --after-seq from the
//     previous page's next_after_seq; replays are possible, dedup on (room,
//     seq). The MCP session's cursor belongs to the MCP adapter alone.
//
// Receiver lifecycle is deliberately out of scope here: a one-shot process
// cannot be a receiver owner. For wake coverage, run the MCP adapter (the
// always-on notifier) or `agent-room wait` (the armed watcher).

import { randomUUID } from 'node:crypto'

import {
  CHAT_ID_INVALID_MESSAGE,
  CHAT_ID_PATTERN,
  CLIENT_MESSAGE_ID_MAX,
  CLIENT_REQUEST_TIMEOUT_MS,
  CLI_ERROR_PEER_AMBIGUOUS,
  MESSAGE_TEXT_MAX,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  READ_HOLD_MAX_MS,
  READ_PAGE_DEFAULT,
  READ_PAGE_MAX,
  SESSION_ADDRESS_INVALID_MESSAGE,
  SESSION_ADDRESS_MAX_CHARS,
  chatIdForms,
  sessionAddressForms,
} from '../constants.mjs'
import { AgentRoomRuntimeError, assertSafePathKey } from '../runtime.mjs'
import {
  CONNECTION_MODE_ENV,
  applyUntrustedEnvelope,
  loadChatIdConfig,
  resolveOrMintSessionPrincipal,
} from '../client/api-client.mjs'
import {
  machineLabel,
  sessionScopeKey,
} from '../client/session-state.mjs'
import { advanceCursor, loadCursors } from '../client/cursors.mjs'
import { LOCAL_TRANSPORT, REMOTE_TRANSPORT, applyTrustMatrix, loadAllowlist } from '../client/trust.mjs'
import { ensureServer, readRuntimeRecord } from '../client/ensure-server.mjs'
import { loadRemoteConfig } from '../client/remote-config.mjs'
import { authenticate, protocolHeaders, roundTrip } from './session-commands.mjs'

const usage = (command, message) => ({
  status: 'usage',
  command,
  code: 'usage',
  message,
})

const refusal = (command, error, extra) => ({
  status: 'refusal',
  command,
  code: error?.code ?? 'request_failed',
  message: error?.message ?? String(error),
  ...(extra === undefined ? {} : { extra }),
})

function parseFlags(tokens, spec) {
  const flags = {}
  const rest = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.startsWith('--')) {
      rest.push(token)
      continue
    }
    const name = token.slice(2)
    const rule = spec.get(name)
    if (rule === undefined) return { error: `unknown option "--${name}"` }
    const value = tokens[index + 1]
    if (value === undefined || value.startsWith('--')) return { error: `--${name} needs a value` }
    index += 1
    flags[name] = value
  }
  return { flags, rest }
}

// The same target resolution the wait family uses: a configured remote origin
// is the remote lane; otherwise the shared local server (booted if not
// running). The origin label rides every receipt so an operator can see WHICH
// server a command answered from.
async function resolveTarget({ pluginDataDir, sharedDataDir, env }) {
  const remote = loadRemoteConfig(pluginDataDir)
  if (remote !== null) {
    return { target: { kind: 'remote', serverUrl: remote.serverUrl }, origin: remote.serverUrl, remote: true }
  }
  const server = await ensureServer({
    dataDir: sharedDataDir,
    ...(env[CONNECTION_MODE_ENV] === REMOTE_TRANSPORT ? { connectionMode: REMOTE_TRANSPORT } : {}),
  })
  return { target: { kind: 'local', port: server.port }, origin: `local:${server.port}`, remote: false }
}

async function realmIdOf(target, token) {
  const status = await roundTrip(target, 'GET', '/api/status', protocolHeaders(token), undefined, CLIENT_REQUEST_TIMEOUT_MS)
  const realmId = status.body?.result?.realm_id
  if (status.status !== 200 || typeof realmId !== 'string' || realmId.length === 0) {
    throw new AgentRoomRuntimeError(
      status.body?.error?.code ?? 'request_failed',
      status.body?.error?.message ?? `the agent-room server answered ${status.status}`,
    )
  }
  return assertSafePathKey(realmId, { label: 'realm id' })
}

// The send failure receipt: a refusal that still names the attempted
// idempotency key, and — when the outcome is genuinely unknowable (the
// request timed out, the response aborted, the stream died mid-flight) —
// the outcome_unknown mark that tells the caller a retry with the SAME id
// is safe: the server resolves the duplicate.
// The send's retry decision, as one exported seam (the round-7 evidence
// condition): the test drives THIS function with a scripted sendOnce to
// prove the exact trace — first attempt refused, retry accepted-then-lost
// — without depending on network timing. The attempt record carries the
// id and every post-send fact the receipt needs; sendOnce receives the
// identical closure state on both calls.
export async function sendWithRetry(sendOnce, attempt) {
  attempt.postSend = true
  const refused = error => error?.transportCode === 'ECONNREFUSED' || error?.code === 'ECONNREFUSED'
  try {
    return await sendOnce()
  } catch (error) {
    if (refused(error)) {
      // The FIRST connection itself was refused: that attempt provably
      // never reached a server. The retry must prove ITSELF before it
      // inherits that proof (the round-6 trigger): a retry that is also
      // refused keeps the known outcome; a retry that died any other way
      // (reset, timeout, 5xx) may have committed, so its receipt is
      // outcome_unknown with the same id and the SAME payload.
      try {
        return await sendOnce()
      } catch (retryError) {
        attempt.provablyNotSent = refused(retryError)
        return sendFailureReceipt(attempt.command, retryError, attempt)
      }
    }
    return sendFailureReceipt(attempt.command, error, attempt)
  }
}

function sendFailureReceipt(command, error, { clientMessageId, room, realmId, origin, transport, provablyNotSent = false }) {
  const message = String(error?.message ?? error)
  // The round-5 rule: a failure AFTER the request was written is
  // outcome-unknown UNLESS the transport proves the request never left
  // (ECONNREFUSED — the connection itself was refused). Shape-regexes are
  // a hint, never the authority.
  const outcomeUnknown = provablyNotSent !== true
  return {
    status: 'refusal',
    command,
    code: error?.code ?? 'request_failed',
    message: outcomeUnknown
      ? `${message}; the outcome is UNKNOWN — the message may have committed. Retry with the SAME --id ${clientMessageId} (the server resolves the duplicate; a changed id would double-post)`
      : message,
    extra: {
      client_message_id: clientMessageId,
      room_id: room,
      ...(realmId === undefined ? {} : { realm_id: realmId }),
      ...(origin === undefined ? {} : { origin }),
      ...(transport === undefined ? {} : { transport }),
      outcome_unknown: outcomeUnknown,
    },
  }
}

// `agent-room send --room <room_id> --text <text> [--reply-to <seq>] [--id <client_message_id>]`
// `agent-room send --to <session-address> --text <text> [--reply-to <seq>] [--id <client_message_id>]`
export async function runSendFamilyCommand(tokens, { pluginDataDir, sharedDataDir, env = process.env }) {
  const command = 'send'
  // The attempt record (the round-5 gate): every failure AFTER the request
  // was written routes through the failure receipt — the attempted
  // idempotency key NEVER disappears, whatever threw (non-200, a malformed
  // 200, a transport death). Pre-send failures have no attempt to name.
  const attempt = { clientMessageId: null, room: null, realmId: null, origin: null, transport: null, postSend: false, provablyNotSent: false }
  try {
    const parsed = parseFlags(tokens, new Map([
      ['room', 'string'], ['to', 'string'], ['text', 'string'], ['reply-to', 'integer'], ['id', 'string'], ['name', 'string'], ['role', 'string'],
    ]))
    if (parsed.error !== undefined) return usage(command, parsed.error)
    const { flags } = parsed
    if (parsed.rest.length > 0) return usage(command, `unexpected argument "${parsed.rest[0]}"; agent-room send takes options only`)
    if (flags.room !== undefined && flags.to !== undefined) {
      return usage(command, '--room and --to are mutually exclusive: address a room OR a peer session, never both')
    }
    if (flags.to !== undefined) {
      return runAddressedSend({
        command, to: flags.to, text: flags.text, clientMessageId: flags.id, replyToFlag: flags['reply-to'],
        agentName: flags.name, agentRole: flags.role,
        attempt, deps: { pluginDataDir, sharedDataDir, env },
      })
    }
    if (flags.name !== undefined || flags.role !== undefined) {
      return usage(command, '--name and --role apply only with --to')
    }
    if (flags.room === undefined) return usage(command, '--room is required: agent-room send --room <room_id> --text <text>')
    if (flags.text === undefined) return usage(command, '--text is required: agent-room send --room <room_id> --text <text>')
    if (flags.room.length < 1 || flags.room.length > 200) return usage(command, '--room must be 1 to 200 characters')
    if (flags.text.trim().length < 1 || flags.text.length > MESSAGE_TEXT_MAX) {
      return usage(command, `--text must contain 1 to ${MESSAGE_TEXT_MAX} characters`)
    }
    let replyToSeq
    if (flags['reply-to'] !== undefined) {
      if (!/^[0-9]+$/.test(flags['reply-to']) || Number(flags['reply-to']) < 1) {
        return usage(command, '--reply-to must be a positive integer sequence number')
      }
      replyToSeq = Number(flags['reply-to'])
    }
    let clientMessageId = flags.id
    if (clientMessageId !== undefined && (clientMessageId.length < 1 || clientMessageId.length > CLIENT_MESSAGE_ID_MAX)) {
      return usage(command, `--id must contain 1 to ${CLIENT_MESSAGE_ID_MAX} characters`)
    }
    if (clientMessageId === undefined) clientMessageId = randomUUID()
    attempt.clientMessageId = clientMessageId
    attempt.room = flags.room

    // Identity discipline: the send is this installation's own words — the
    // Chat ID comes from the config file, never from an argument.
    if (!env) return usage(command, 'environment unavailable')
    let config
    try {
      config = loadChatIdConfig(pluginDataDir)
    } catch (error) {
      return refusal(command, error)
    }

    const { target, origin } = await resolveTarget({ pluginDataDir, sharedDataDir, env })
    const { token, transport } = await authenticate(target, { pluginDataDir, sharedDataDir, env, sessionKind: 'cli_oneshot' })
    const realmId = await realmIdOf(target, token)
    attempt.origin = origin
    attempt.transport = transport
    attempt.realmId = realmId
    const sendBody = {
      chat_id: config.chatId,
      client_message_id: clientMessageId,
      text: flags.text,
      ...(replyToSeq === undefined ? {} : { reply_to_seq: replyToSeq }),
    }
    const sendPath = `/api/rooms/${encodeURIComponent(flags.room)}/messages`
    // The outcome-unknown discipline (the round-4 gate): a transport failure
    // AFTER the request may have reached the server leaves the outcome
    // unknowable, so the failure receipt ALWAYS carries the attempted id and
    // the unknown-outcome mark — a retry is the SAME id, and the server
    // resolves the duplicate. A connection the server never accepted
    // (ECONNREFUSED) gets the api-client's one immediate retry with the
    // identical tuple before surfacing.
    const sendOnce = () => roundTrip(target, 'POST', sendPath, protocolHeaders(token), sendBody, CLIENT_REQUEST_TIMEOUT_MS)
    const sent = await sendWithRetry(sendOnce, attempt)
    if (sent.status === 'refusal') return sent // the failure receipt, attempt metadata intact
    const response = sent
    if (response.status !== 200) {
      throw new AgentRoomRuntimeError(
        response.body?.error?.code ?? 'request_failed',
        response.body?.error?.message ?? `the agent-room server answered ${response.status}`,
      )
    }
    const result = response.body?.result
    if (result?.status === 'storage_low') {
      // The store rolled back having written nothing — the report IS the
      // answer, and the exit code is the severity a script keys on.
      return {
        status: 'ok',
        command,
        exitCode: 1,
        lines: [JSON.stringify({
          ok: true,
          command,
          status: 'storage_low',
          client_message_id: clientMessageId,
          room_id: flags.room,
          realm_id: realmId,
          origin,
          transport,
          message: 'the store refused below its free-space reserve; nothing was committed — retry the SAME client_message_id after freeing space',
        })],
      }
    }
    if (result?.status === 'duplicate_dropped') {
      return {
        status: 'ok',
        command,
        lines: [JSON.stringify({
          ok: true,
          command,
          status: 'duplicate_dropped',
          room_id: flags.room,
          original_seq: result.original_seq,
          client_message_id: clientMessageId,
          realm_id: realmId,
          origin,
          transport,
          message: 'the content duplicate gate dropped this send; the original row is intact — a retry that must post needs a NEW client_message_id AND changed content',
        })],
      }
    }
    if (result?.status !== 'committed') {
      throw new AgentRoomRuntimeError('request_failed', `the agent-room server answered an unreadable send result: ${JSON.stringify(result)}`)
    }
    return {
      status: 'ok',
      command,
      lines: [JSON.stringify({
        ok: true,
        command,
        status: 'accepted',
        room_id: result.room_id,
        seq: result.seq,
        client_message_id: clientMessageId,
        realm_id: realmId,
        origin,
        transport,
        message: 'accepted = the durable log committed; this is NOT a wake receipt — the receiver learns of it through its own notifier or wait',
      })],
    }
  } catch (error) {
    // Post-send failures keep the attempt metadata and the honest unknown
    // mark; pre-send failures have nothing to name.
    if (attempt.postSend) return sendFailureReceipt(command, error, attempt)
    return refusal(command, error)
  }
}

// `agent-room read --peer <address|agent-id> | --room <room_id> [--after-seq <n>] [--limit <n>] [--wait-ms <ms>]`
//
// Story 2.1: the reader is a SESSION, not an installation. It authenticates,
// ensures (or reuses) its own session principal, and then reads through that
// session's capability — so a pair room is readable exactly when THIS session
// is one of its two members, and the cursor it advances belongs to this
// session's scope (AD-4: the client owns the position, the server never
// stores one).
//
// SELECTOR: exactly one of --peer / --room. There is no aggregate mode: a
// room-local `seq` only means something against one room, so "read
// everything" is not a thing the grammar offers (operator decision
// 2026-11-16).
//   --room <room_id>   read that room, as given.
//   --peer <selector>  resolve the peer first (a full address when it carries
//                      `~`, else a bare base name against the principal
//                      listing), then read the pair room the two sessions
//                      share. No shared room is an EMPTY page at exit 0 — a
//                      read never creates a room.
//
// OUTPUT: one JSON receipt line. Each row is exactly
// {seq, from_address, trusted, text} — or, for a sender this installation's
// trust matrix holds, {seq, from_address, trusted:false, held:true} with NO
// text key at all: a held body must not exist in the output, not even as an
// empty string (AC4).
//
// CURSOR: read_seq advances to next_after_seq ONLY AFTER the receipt is
// flushed to stdout. A failed flush (EPIPE and friends) leaves the cursor
// untouched and exits 1 — the page is not consumed, so the caller may retry.
// notified_seq is never written here; the wake paths own it (Story 3.2).
export async function runReadFamilyCommand(tokens, { pluginDataDir, sharedDataDir, env = process.env }) {
  const command = 'read'
  try {
    const parsed = parseFlags(tokens, new Map([
      ['peer', 'string'], ['room', 'string'], ['after-seq', 'integer'], ['limit', 'integer'], ['wait-ms', 'integer'],
    ]))
    if (parsed.error !== undefined) return usage(command, parsed.error)
    const { flags } = parsed
    if (parsed.rest.length > 0) return usage(command, `unexpected argument "${parsed.rest[0]}"; agent-room read takes options only`)
    if (flags.peer !== undefined && flags.room !== undefined) {
      return usage(command, '--peer and --room are mutually exclusive: name the peer, or name the room')
    }
    if (flags.peer === undefined && flags.room === undefined) {
      return usage(command, 'a selector is required: agent-room read --peer <address|agent-id> OR --room <room_id>')
    }
    if (flags.room !== undefined && (flags.room.length < 1 || flags.room.length > 200)) {
      return usage(command, '--room must be 1 to 200 characters')
    }
    if (flags.peer !== undefined) {
      if (flags.peer.length < 1 || flags.peer.length > SESSION_ADDRESS_MAX_CHARS) {
        return usage(command, `--peer must be 1 to ${SESSION_ADDRESS_MAX_CHARS} characters`)
      }
      // `~` marks a full address (the same discriminator Story 2.2's send
      // grammar uses); without it the selector is a bare base name.
      if (flags.peer.includes('~') && sessionAddressForms(flags.peer) === null) {
        return usage(command, `--peer "${flags.peer.slice(0, 96)}" is not a valid session address: ${SESSION_ADDRESS_INVALID_MESSAGE}`)
      }
      if (!flags.peer.includes('~') && !CHAT_ID_PATTERN.test(flags.peer)) {
        return usage(command, `--peer: ${CHAT_ID_INVALID_MESSAGE}`)
      }
    }
    let afterSeq = null
    if (flags['after-seq'] !== undefined) {
      if (!/^[0-9]+$/.test(flags['after-seq'])) return usage(command, '--after-seq must be a non-negative integer')
      afterSeq = Number(flags['after-seq'])
    }
    let limit = READ_PAGE_DEFAULT
    if (flags.limit !== undefined) {
      if (!/^[0-9]+$/.test(flags.limit) || Number(flags.limit) < 1 || Number(flags.limit) > READ_PAGE_MAX) {
        return usage(command, `--limit must be between 1 and ${READ_PAGE_MAX}`)
      }
      limit = Number(flags.limit)
    }
    let waitMs = 0
    if (flags['wait-ms'] !== undefined) {
      if (!/^[0-9]+$/.test(flags['wait-ms']) || Number(flags['wait-ms']) > READ_HOLD_MAX_MS) {
        return usage(command, `--wait-ms must be between 0 and ${READ_HOLD_MAX_MS}`)
      }
      waitMs = Number(flags['wait-ms'])
    }

    const { target, origin } = await resolveTarget({ pluginDataDir, sharedDataDir, env })
    const { token, fingerprint, transport } = await authenticate(target, { pluginDataDir, sharedDataDir, env, sessionKind: 'cli_oneshot' })
    const realmId = await realmIdOf(target, token)
    const roundTripOrThrow = async (method, path, headers, body) => {
      const response = await roundTrip(target, method, path, headers, body, CLIENT_REQUEST_TIMEOUT_MS)
      if (response.status !== 200) {
        throw new AgentRoomRuntimeError(
          response.body?.error?.code ?? 'request_failed',
          response.body?.error?.message ?? `the agent-room server answered ${response.status}`,
        )
      }
      return response.body.result
    }
    // Reuse a live lease with no network call; otherwise resume, or mint. The
    // lease is NOT released on the way out (Story 2.1, retro F-10): a read
    // must not knock its own session offline.
    const principal = await resolveOrMintSessionPrincipal({
      pluginDataDir,
      sessionScope: sessionScopeKey({ env, pluginDataDir }),
      requestedName: null,
      requestedRole: 'agent',
      resumePrincipal: ({ sessionId, generation, capability: sessionCapability }) => roundTripOrThrow(
        'POST',
        '/api/session-principals/resume',
        sessionHeadersOf(sessionCapability),
        { session_id: sessionId, generation },
      ),
      allocatePrincipal: baseChatId => roundTripOrThrow(
        'POST',
        '/api/session-principals',
        protocolHeaders(token),
        { base_chat_id: baseChatId, machine: machineLabel({ env }), client_type: 'cli' },
      ),
    })
    const capability = principal.capability

    let roomId = flags.room
    let peerSessionId = null
    if (flags.peer !== undefined) {
      const resolved = await resolvePeerSession({
        selector: flags.peer,
        target,
        token,
        roundTripOrThrow,
      })
      if (resolved.status !== 'ok') return resolved.outcome(command)
      const rooms = await roundTripOrThrow('GET', '/api/rooms', sessionHeadersOf(capability))
      const pairRoom = (Array.isArray(rooms?.rooms) ? rooms.rooms : [])
        .find(room => room?.peer_session_id === resolved.session.session_id)
      peerSessionId = resolved.session.session_id
      if (pairRoom === undefined) {
        // PEER_NO_ROOM: the two sessions have never exchanged a message, so
        // there is no pair room to read. An empty page at exit 0, and
        // nothing was created — a read is not an open.
        return {
          status: 'ok',
          command,
          lines: [JSON.stringify({
            ok: true,
            command,
            peer_session_id: peerSessionId,
            peer_address: resolved.session.address,
            room_id: null,
            realm_id: realmId,
            origin,
            transport,
            messages: [],
            next_after_seq: 0,
            head_seq: 0,
            read_seq: null,
            cursor_written: false,
            message: 'this session and the named peer share no room yet; a read never creates one — send the first message to open the pair',
          })],
        }
      }
      roomId = pairRoom.room_id
    }

    // An explicit --after-seq wins; otherwise the session's own stored
    // read_seq is the resume point (0 when this scope has never read the
    // room). This is what makes a second `read` a continuation rather than a
    // replay.
    const stored = afterSeq === null
      ? (loadCursors(pluginDataDir, realmId, { env }).get(roomId)?.read_seq ?? 0)
      : afterSeq
    const params = new URLSearchParams({
      after_seq: String(stored),
      limit: String(limit),
      wait_ms: String(waitMs),
    })
    const page = await roundTrip(
      target,
      'GET',
      `/api/rooms/${encodeURIComponent(roomId)}/messages?${params}`,
      sessionHeadersOf(capability),
      undefined,
      waitMs + CLIENT_REQUEST_TIMEOUT_MS,
    )
    if (page.status !== 200) {
      throw new AgentRoomRuntimeError(
        page.body?.error?.code ?? 'request_failed',
        page.body?.error?.message ?? `the agent-room server answered ${page.status}`,
      )
    }
    // The receiver-side trust matrix, exactly as the MCP adapter applies it:
    // foreign bodies wrapped (data, never instructions), held rows keep their
    // metadata with the body withheld and the reason recorded. The projection
    // below then DROPS the withheld marker text — a held row carries no text
    // key at all, so no caller can mistake the marker for the body.
    const raw = page.body?.result ?? {}
    const wrapped = applyUntrustedEnvelope(raw, fingerprint)
    const judged = applyTrustMatrix(
      { messages: wrapped.messages, next_after_seq: wrapped.next_after_seq, head_seq: wrapped.head_seq },
      {
        ownFingerprint: fingerprint,
        transport,
        allowlist: loadAllowlist(pluginDataDir, realmId),
      },
    )
    const rows = judged.messages.map(message => (message.held === true
      ? { seq: message.seq, from_address: message.chat_id ?? null, trusted: false, held: true }
      : { seq: message.seq, from_address: message.chat_id ?? null, trusted: true, text: message.text }))
    const nextAfterSeq = judged.next_after_seq
    const receipt = {
      ok: true,
      command,
      room_id: roomId,
      ...(peerSessionId === null ? {} : { peer_session_id: peerSessionId }),
      realm_id: realmId,
      origin,
      transport,
      messages: rows,
      next_after_seq: nextAfterSeq,
      head_seq: judged.head_seq,
      read_seq: nextAfterSeq,
      cursor_written: true,
      message: 'read_seq advanced to next_after_seq after this receipt was flushed; notify (Story 3.2) tracks its own position and was not moved',
    }
    // The advance is deferred to the dispatcher: it writes this line and
    // awaits the flush callback, then calls afterFlush. A failed flush means
    // the caller never saw the page, so the cursor must not move.
    const advance = async () => {
      await advanceCursor(
        pluginDataDir,
        { realmId, roomId, seq: nextAfterSeq, field: 'read_seq' },
        { env },
      )
    }
    return { status: 'ok', command, lines: [JSON.stringify(receipt)], afterFlush: advance }
  } catch (error) {
    return refusal(command, error)
  }
}

// Resolve --peer's selector to one session principal. A full address is
// matched exactly against the principal listing; a bare name is matched
// case-insensitively (DR-1) and must resolve to EXACTLY one principal — a name
// two live sessions share is `peer_ambiguous`, never a guess. Both misses are
// CLI-local codes (they never cross the wire).
async function resolvePeerSession({ selector, token, roundTripOrThrow }) {
  const result = await roundTripOrThrow('GET', '/api/session-principals', protocolHeaders(token))
  const principals = Array.isArray(result?.sessions) ? result.sessions : []
  const wantsAddress = selector.includes('~')
  const matches = principals.filter(row => (wantsAddress
    ? row?.address === selector
    : typeof row?.base_name === 'string' && row.base_name.toLowerCase() === selector.toLowerCase()))
  if (matches.length === 0) {
    return {
      status: 'refusal',
      outcome: command => ({
        status: 'refusal',
        command,
        code: 'peer_not_found',
        message: `no session principal resolves to "${selector.slice(0, 96)}"; run "agent-room sessions" to see the live ones`,
      }),
    }
  }
  if (matches.length > 1) {
    const addresses = matches.map(row => row.address).sort()
    return {
      status: 'refusal',
      outcome: command => ({
        status: 'refusal',
        command,
        code: CLI_ERROR_PEER_AMBIGUOUS,
        message: `"${selector.slice(0, 96)}" names ${matches.length} sessions; pass the full address instead — ${addresses.join(', ')}`,
      }),
    }
  }
  return { status: 'ok', session: matches[0] }
}

// `agent-room session verify <chat-id>` — the availability PROBE (v0.8.0,
// the round-4 gate): presence is a transport snapshot, not an occupancy
// authority — an idle same-key holder drops out of the online group, an
// offline claim lingers after release, and neither answers "can I bind this
// name NOW". The probe answers by doing the only authoritative thing: it
// BINDS the name and, on success, releases it again immediately (the receipt
// says so — like setup's probe, this is not a side-effect-free read). The
// refusals carry the verdict: chat_id_taken WITH a conflict ticket is a live
// same-key holder; chat_id_taken WITHOUT one is a foreign key (whose name is
// never displacable). This is a moment-in-time answer, never a reservation.
export async function runSessionVerify(deps, rawChatId) {
  const command = 'session verify'
  try {
    if (rawChatId === undefined) return usage(command, 'one Chat ID is required: agent-room session verify <chat-id>')
    const forms = chatIdForms(rawChatId)
    if (forms === null) {
      return usage(command, `"${String(rawChatId).slice(0, 64)}" is not a valid Chat ID: ${CHAT_ID_INVALID_MESSAGE}`)
    }
    const { target, origin } = await resolveTarget(deps)
    const { token, fingerprint } = await authenticate(target, {
      pluginDataDir: deps.pluginDataDir,
      sharedDataDir: deps.sharedDataDir,
      env: deps.env,
      sessionKind: 'cli_oneshot',
    })
    const realmId = await realmIdOf(target, token)
    // The probe's cleanup, bounded and verified (the round-5 gate): a bind
    // that MAY have succeeded always attempts the release with THIS probe's
    // own token, and the verdict reports the release OUTCOME — "free" is
    // said only when the release is confirmed. A probe whose bind reply was
    // lost, or whose release failed, answers honestly that the name may now
    // be held by the probe's own session until its lease expires.
    let bound = null
    let bindUnknown = false
    try {
      bound = await roundTrip(target, 'POST', '/api/session', protocolHeaders(token), {
        chat_id: forms.display,
      }, CLIENT_REQUEST_TIMEOUT_MS)
    } catch (error) {
      bindUnknown = /timed out|aborted|stream failed|hang up|ECONNRESET|EPIPE/.test(String(error?.message ?? error)) || error?.code === 'ECONNRESET'
      if (!bindUnknown) throw error
    }
    if (bindUnknown) {
      // The bind may have committed: attempt the bounded cleanup, and report
      // the release outcome instead of pretending the name is free.
      const release = await roundTrip(target, 'DELETE', '/api/session', protocolHeaders(token), undefined, CLIENT_REQUEST_TIMEOUT_MS).catch(error => ({ status: 0, error }))
      const released = release.status === 200
      return {
        status: 'ok',
        command,
        lines: [JSON.stringify({
          ok: true,
          command,
          chat_id: forms.display,
          verdict: released ? 'unknown_bind_released' : 'release_failed',
          probe: released ? 'cleanup-confirmed' : 'cleanup-unconfirmed',
          realm_id: realmId,
          origin,
          message: released
            ? 'the probe’s bind reply was lost; the cleanup release is confirmed — the name is most likely free, but this check proved nothing about a concurrent binder'
            : `the probe’s bind reply was lost AND the cleanup release did not confirm (status ${release.status}); the probe’s own session may hold "${forms.display}" until its lease expires — recover with "agent-room session replace --yes"`,
        })],
      }
    }
    if (bound.status === 200) {
      // The name is free: release it again immediately — and say "free"
      // only when that release is confirmed.
      const release = await roundTrip(target, 'DELETE', '/api/session', protocolHeaders(token), undefined, CLIENT_REQUEST_TIMEOUT_MS).catch(error => ({ status: 0, error }))
      const released = release.status === 200
      return {
        status: 'ok',
        command,
        lines: [JSON.stringify({
          ok: true,
          command,
          chat_id: forms.display,
          verdict: released ? 'unclaimed' : 'release_failed',
          probe: released ? 'claimed-and-released' : 'claimed-release-failed',
          realm_id: realmId,
          origin,
          message: released
            ? 'the name bound successfully and was released again — free as of this instant, but this probe is not a reservation: a concurrent bind can still win the race. The probe is not read-only: it bound this name once, so the durable claim’s last_seen advanced'
            : `the name bound, but the cleanup release did not confirm (status ${release.status}); the probe’s own session may hold "${forms.display}" until its lease expires — recover with "agent-room session replace --yes"`,
        })],
      }
    }
    const code = bound.body?.error?.code
    if (bound.status === 409 && code === 'chat_id_taken') {
      const ticket = bound.body?.error?.extra?.conflict_ticket ?? bound.body?.error?.conflict_ticket
      if (ticket !== undefined && ticket !== null) {
        return {
          status: 'ok',
          command,
          lines: [JSON.stringify({
            ok: true,
            command,
            chat_id: forms.display,
            verdict: 'claimed_by_self',
            probe: 'refused-live-holder',
            realm_id: realmId,
            origin,
            message: 'this installation\u2019s own key holds the name in a live session — a fresh bound client will collide with it (chat_id_taken): reuse that session, release it first, or run "agent-room session replace --yes" only when the holding process is confirmed dead',
          })],
        }
      }
      return {
        status: 'ok',
        command,
        lines: [JSON.stringify({
          ok: true,
          command,
          chat_id: forms.display,
          verdict: 'claimed_by_other',
          probe: 'refused-live-holder',
          realm_id: realmId,
          origin,
          message: 'another key holds the name in a live session — a different key\u2019s name is never displaced by a bind or a replace; choose another name',
        })],
      }
    }
    // The trusted no-bind refusals: these codes answer from admission and
    // validation gates that run BEFORE the bind mutates anything, so they
    // prove no bind happened and need no cleanup (the round-6 gate).
    const TRUSTED_NO_BIND_CODES = new Set(['invalid_request', 'invalid_chat_id', 'banned', 'not_enrolled', 'rate_limited'])
    if (TRUSTED_NO_BIND_CODES.has(code)) {
      throw new AgentRoomRuntimeError(
        code,
        bound.body?.error?.message ?? `the agent-room server answered ${bound.status}`,
      )
    }
    // An ambiguous bind outcome (a gateway 5xx, an unreadable response —
    // anything that is neither a confirmed 200 nor a trusted pre-bind
    // refusal): the bind MAY have committed, so the bounded cleanup runs
    // with the probe's own token and the receipt reports the release
    // outcome — never a fabricated "free".
    const release = await roundTrip(target, 'DELETE', '/api/session', protocolHeaders(token), undefined, CLIENT_REQUEST_TIMEOUT_MS).catch(error => ({ status: 0, error }))
    const released = release.status === 200
    return {
      status: 'ok',
      command,
      lines: [JSON.stringify({
        ok: true,
        command,
        chat_id: forms.display,
        verdict: released ? 'unknown_bind_released' : 'release_failed',
        probe: released ? 'cleanup-confirmed' : 'cleanup-unconfirmed',
        realm_id: realmId,
        origin,
        message: released
          ? `the bind's outcome was ambiguous (the server answered ${bound.status}); the cleanup release IS confirmed — the name is most likely free, but this check proved nothing about a concurrent binder`
          : `the bind's outcome was ambiguous (the server answered ${bound.status}) AND the cleanup release did not confirm (status ${release.status}); the probe\u2019s own session may hold "${forms.display}" until its lease expires — recover with "agent-room session replace --yes"`,
      })],
    }
  } catch (error) {
    return refusal(command, error)
  }
}

// --- v0.9.0: the session-addressed one-shot family ------------------------------
//
// `agent-room dm --to <address> --text <text> [--id <cmid>] [--reply-to <seq>]`
// `agent-room send --to <address> --text <text>` (the same addressed wire,
// reported under the send command's name) · `agent-room sessions` (the
// explicit realm listing — CAP-3: enumeration lives here, never piggybacked
// on a send refusal).
//
// The one-shot lifecycle (session-principals.md §1/§4): allocate an EPHEMERAL
// session principal by the installation bearer, act with its Session
// capability, then release the base lease best-effort (bounded) so the
// process does not squat liveness it will never use — the durable principal
// and its mailbox persist regardless, which is exactly the design: the
// addressed peer can keep writing to this address while it is offline.

function sessionHeadersOf(capability) {
  return {
    [PROTOCOL_HEADER]: PROTOCOL_VERSION,
    authorization: `Session ${capability}`,
    'content-type': 'application/json; charset=utf-8',
  }
}

function addressedResultReceipt({ command, to, result, clientMessageId, realmId, origin, transport }) {
  const base = {
    ok: true,
    command,
    to,
    client_message_id: clientMessageId,
    room_id: result.room_id,
    realm_id: realmId,
    origin,
    transport,
    ...(result.route_fallback === true ? { route_fallback: true } : {}),
    ...(result.peer === undefined ? {} : { peer: result.peer }),
  }
  if (result.status === 'storage_low') {
    return {
      status: 'ok',
      command,
      exitCode: 1,
      lines: [JSON.stringify({
        ...base,
        status: 'storage_low',
        message: 'the store refused below its free-space reserve; nothing was committed — retry the SAME client_message_id after freeing space',
      })],
    }
  }
  if (result.status === 'duplicate_dropped') {
    return {
      status: 'ok',
      command,
      lines: [JSON.stringify({
        ...base,
        status: 'duplicate_dropped',
        original_seq: result.original_seq,
        message: 'the content duplicate gate dropped this send; the original row is intact — a retry that must post needs a NEW client_message_id AND changed content',
      })],
    }
  }
  if (result.status !== 'committed') {
    throw new AgentRoomRuntimeError('request_failed', `the agent-room server answered an unreadable addressed-send result: ${JSON.stringify(result)}`)
  }
  const presence = result.peer?.presence
  return {
    status: 'ok',
    command,
    lines: [JSON.stringify({
      ...base,
      status: 'committed',
      committed_seq: result.seq,
      peer_presence: presence,
      message: `committed seq=${result.seq}; the peer's process is ${presence === 'online' ? 'online' : 'offline'} — this is NOT a delivery, read, or wake receipt; the peer learns of it through its own read`,
    })],
  }
}

// The addressed send core, shared by `dm` and `send --to`: allocate the
// ephemeral principal, POST /api/messages once with the Session capability
// (the outcome-unknown discipline: one identical-id retry when the FIRST
// connection itself was refused), then release the base lease.
async function runAddressedSend({
  command,
  to,
  text,
  clientMessageId: clientMessageIdFlag,
  replyToFlag,
  agentName,
  agentRole,
  deps,
  attempt,
}) {
  const { pluginDataDir, sharedDataDir, env } = deps
  try {
    if (to === undefined) return usage(command, '--to is required: the peer session\u0027s full address (base~locator-token@machine); see "agent-room sessions"')
    const address = sessionAddressForms(to)
    if (address === null) return usage(command, `"${String(to).slice(0, 96)}" is not a valid session address: ${SESSION_ADDRESS_INVALID_MESSAGE}`)
    if (agentName !== undefined && !CHAT_ID_PATTERN.test(agentName)) {
      return usage(command, `--name: ${CHAT_ID_INVALID_MESSAGE}`)
    }
    if (text === undefined) return usage(command, '--text is required')
    if (text.trim().length < 1 || text.length > MESSAGE_TEXT_MAX) {
      return usage(command, `--text must contain 1 to ${MESSAGE_TEXT_MAX} characters`)
    }
    if (clientMessageIdFlag !== undefined && (clientMessageIdFlag.length < 1 || clientMessageIdFlag.length > CLIENT_MESSAGE_ID_MAX)) {
      return usage(command, `--id must contain 1 to ${CLIENT_MESSAGE_ID_MAX} characters`)
    }
    let replyToSeq
    if (replyToFlag !== undefined) {
      if (!/^[0-9]+$/.test(replyToFlag) || Number(replyToFlag) < 1) {
        return usage(command, '--reply-to must be a positive integer sequence number')
      }
      replyToSeq = Number(replyToFlag)
    }
    const clientMessageId = clientMessageIdFlag ?? randomUUID()
    attempt.clientMessageId = clientMessageId

    const { target, origin } = await resolveTarget({ pluginDataDir, sharedDataDir, env })
    const { token, transport } = await authenticate(target, { pluginDataDir, sharedDataDir, env, sessionKind: 'cli_oneshot' })
    const realmId = await realmIdOf(target, token)
    attempt.origin = origin
    attempt.transport = transport
    attempt.realmId = realmId

    // Resolve the session principal for this process scope: REUSE a live lease
    // with no network call, else resume a stored principal, else allocate
    // --name once or auto-mint <role>-<shortToken> up to 3 attempts. The lease
    // is never released here (Story 2.1, retro F-10).
    const sessionScope = sessionScopeKey({ env, pluginDataDir })
    const machine = machineLabel({ env })
    const roundTripOrThrow = async (method, path, headers, body) => {
      const response = await roundTrip(target, method, path, headers, body, CLIENT_REQUEST_TIMEOUT_MS)
      if (response.status !== 200) {
        throw new AgentRoomRuntimeError(
          response.body?.error?.code ?? 'request_failed',
          response.body?.error?.message ?? `the agent-room server answered ${response.status}`,
        )
      }
      return response.body.result
    }
    const principal = await resolveOrMintSessionPrincipal({
      pluginDataDir,
      sessionScope,
      requestedName: agentName ?? null,
      requestedRole: agentRole ?? 'agent',
      resumePrincipal: ({ sessionId, generation, capability: sessionCapability }) => roundTripOrThrow(
        'POST',
        '/api/session-principals/resume',
        sessionHeadersOf(sessionCapability),
        { session_id: sessionId, generation },
      ),
      allocatePrincipal: baseChatId => roundTripOrThrow(
        'POST',
        '/api/session-principals',
        protocolHeaders(token),
        { base_chat_id: baseChatId, machine, client_type: 'cli' },
      ),
    })
    const capability = principal.capability
    {
      const sendBody = {
        to: address.address,
        client_message_id: clientMessageId,
        text,
        ...(replyToSeq === undefined ? {} : { reply_to_seq: replyToSeq }),
      }
      const sendOnce = () => roundTrip(target, 'POST', '/api/messages', sessionHeadersOf(capability), sendBody, CLIENT_REQUEST_TIMEOUT_MS)
      attempt.postSend = true
      const sent = await sendWithRetry(sendOnce, attempt)
      if (sent.status === 'refusal') return sent
      if (sent.status !== 200) {
        throw new AgentRoomRuntimeError(
          sent.body?.error?.code ?? 'request_failed',
          sent.body?.error?.message ?? `the agent-room server answered ${sent.status}`,
        )
      }
      return addressedResultReceipt({
        command, to: address.address, result: sent.body.result, clientMessageId, realmId, origin, transport,
      })
    }
    // Story 2.1 (retro F-10): no `finally` release. This command used to
    // DELETE /api/session-principals/current on the way out, which dropped the
    // session's own base lease — the session went online -> offline on every
    // single `dm`, and any live watch on it was cut. The lease is now reused
    // while live (resolveOrMintSessionPrincipal returns {reuse:true} without a
    // /resume call) and lapses on its own 45 s timer when nobody renews it.
  } catch (error) {
    if (attempt.postSend) return sendFailureReceipt(command, error, attempt)
    return refusal(command, error)
  }
}

// `agent-room dm --to <address> --text <text> [--id <client_message_id>] [--reply-to <seq>]`
export async function runDmCommand(tokens, deps) {
  const command = 'dm'
  const attempt = { clientMessageId: null, room: null, realmId: null, origin: null, transport: null, postSend: false, provablyNotSent: false }
  try {
    const parsed = parseFlags(tokens, new Map([
      ['to', 'string'], ['text', 'string'], ['id', 'string'], ['reply-to', 'integer'], ['name', 'string'], ['role', 'string'],
    ]))
    if (parsed.error !== undefined) return usage(command, parsed.error)
    const { flags } = parsed
    if (parsed.rest.length > 0) return usage(command, `unexpected argument "${parsed.rest[0]}"; agent-room dm takes options only`)
    return await runAddressedSend({
      command, to: flags.to, text: flags.text, clientMessageId: flags.id, replyToFlag: flags['reply-to'],
      agentName: flags.name, agentRole: flags.role,
      attempt, deps,
    })
  } catch (error) {
    if (attempt.postSend) return sendFailureReceipt(command, error, attempt)
    return refusal(command, error)
  }
}

function formatSessionsTable(rows, truncated) {
  const headers = ['AGENT_ID', 'ADDRESS', 'MACHINE', 'LOCALITY', 'PRESENCE', 'LAST_SEEN']
  const data = rows.map(row => [
    String(row.base_name ?? ''),
    String(row.address ?? ''),
    String(row.machine ?? ''),
    String(row.locality ?? 'remote'),
    String(row.presence ?? 'offline'),
    String(row.last_heartbeat_at ?? ''),
  ])
  const widths = headers.map((header, index) => Math.max(
    header.length,
    ...data.map(cells => cells[index].length),
  ))
  const formatRow = cells => cells.map((cell, index) => cell.padEnd(widths[index])).join('  ').trimEnd()
  const lines = [formatRow(headers), ...data.map(formatRow)]
  if (truncated) {
    lines.push(`... output truncated (showing ${rows.length} entries)`)
  }
  return lines
}

// `agent-room sessions [--json]` — the explicit realm listing (CAP-3).
export async function runSessionsCommand(tokens, deps) {
  const command = 'sessions'
  try {
    let jsonMode = false
    for (const token of tokens) {
      if (token === '--json') jsonMode = true
      else return usage(command, `unknown option "${token}"; expected: agent-room sessions [--json]`)
    }
    const { pluginDataDir, sharedDataDir, env } = deps
    const { target, origin } = await resolveTarget({ pluginDataDir, sharedDataDir, env })
    const { token, fingerprint, transport } = await authenticate(target, {
      pluginDataDir,
      sharedDataDir,
      env,
      sessionKind: 'cli_oneshot',
    })
    const realmId = await realmIdOf(target, token)
    const list = await roundTrip(target, 'GET', '/api/session-principals', protocolHeaders(token), undefined, CLIENT_REQUEST_TIMEOUT_MS)
    if (list.status !== 200) {
      throw new AgentRoomRuntimeError(
        list.body?.error?.code ?? 'request_failed',
        list.body?.error?.message ?? `the agent-room server answered ${list.status}`,
      )
    }
    const runtimeRecord = transport === LOCAL_TRANSPORT ? readRuntimeRecord(sharedDataDir) : null
    const sameRealm = Boolean(runtimeRecord?.realm_id && runtimeRecord.realm_id === realmId)
    const rawSessions = Array.isArray(list.body?.result?.sessions) ? list.body.result.sessions : []
    const truncated = Boolean(list.body?.result?.truncated)
    const sessions = rawSessions.map(row => {
      const isLocal = transport === LOCAL_TRANSPORT
        && sameRealm
        && (row.enrolled_via === 'local' || row.fingerprint === fingerprint)
      return {
        ...row,
        locality: isLocal ? 'local' : 'remote',
      }
    })
    if (jsonMode) {
      return {
        status: 'ok',
        command,
        lines: [JSON.stringify({
          ok: true,
          command,
          realm_id: realmId,
          origin,
          transport,
          truncated,
          sessions,
        })],
      }
    }
    return {
      status: 'ok',
      command,
      lines: formatSessionsTable(sessions, truncated),
    }
  } catch (error) {
    return refusal(command, error)
  }
}
