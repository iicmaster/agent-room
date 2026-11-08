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
  CLIENT_MESSAGE_ID_MAX,
  MESSAGE_TEXT_MAX,
  READ_HOLD_MAX_MS,
  READ_PAGE_DEFAULT,
  READ_PAGE_MAX,
  chatIdForms,
} from '../constants.mjs'
import { AgentRoomRuntimeError } from '../runtime.mjs'
import {
  CONNECTION_MODE_ENV,
  applyUntrustedEnvelope,
  loadChatIdConfig,
} from '../client/api-client.mjs'
import { REMOTE_TRANSPORT, applyTrustMatrix, loadAllowlist } from '../client/trust.mjs'
import { ensureServer } from '../client/ensure-server.mjs'
import { loadRemoteConfig } from '../client/remote-config.mjs'
import { authenticate, protocolHeaders, roundTrip } from './session-commands.mjs'

const CLIENT_REQUEST_TIMEOUT_MS = 10_000

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
  return realmId
}

// The send failure receipt: a refusal that still names the attempted
// idempotency key, and — when the outcome is genuinely unknowable (the
// request timed out, the response aborted, the stream died mid-flight) —
// the outcome_unknown mark that tells the caller a retry with the SAME id
// is safe: the server resolves the duplicate.
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
export async function runSendFamilyCommand(tokens, { pluginDataDir, sharedDataDir, env = process.env }) {
  const command = 'send'
  // The attempt record (the round-5 gate): every failure AFTER the request
  // was written routes through the failure receipt — the attempted
  // idempotency key NEVER disappears, whatever threw (non-200, a malformed
  // 200, a transport death). Pre-send failures have no attempt to name.
  const attempt = { clientMessageId: null, room: null, realmId: null, origin: null, transport: null, postSend: false, provablyNotSent: false }
  try {
    const parsed = parseFlags(tokens, new Map([
      ['room', 'string'], ['text', 'string'], ['reply-to', 'integer'], ['id', 'string'],
    ]))
    if (parsed.error !== undefined) return usage(command, parsed.error)
    const { flags } = parsed
    if (parsed.rest.length > 0) return usage(command, `unexpected argument "${parsed.rest[0]}"; agent-room send takes options only`)
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
    const { token, transport } = await authenticate(target, { pluginDataDir, sharedDataDir, env })
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
    let response
    attempt.postSend = true
    try {
      response = await sendOnce()
    } catch (error) {
      if (error?.transportCode === 'ECONNREFUSED' || error?.code === 'ECONNREFUSED') {
        // The connection itself was refused on both attempts: the request
        // provably never reached a server, so the outcome is KNOWN (nothing
        // committed) even though the flag rides post-send.
        attempt.provablyNotSent = true
        try {
          response = await sendOnce()
        } catch (retryError) {
          return sendFailureReceipt(command, retryError, attempt)
        }
        attempt.provablyNotSent = false
      } else {
        return sendFailureReceipt(command, error, attempt)
      }
    }
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

// `agent-room read --room <room_id> [--after-seq <n>] [--limit <n>] [--wait-ms <ms>]`
export async function runReadFamilyCommand(tokens, { pluginDataDir, sharedDataDir, env = process.env }) {
  const command = 'read'
  try {
    const parsed = parseFlags(tokens, new Map([
      ['room', 'string'], ['after-seq', 'integer'], ['limit', 'integer'], ['wait-ms', 'integer'],
    ]))
    if (parsed.error !== undefined) return usage(command, parsed.error)
    const { flags } = parsed
    if (parsed.rest.length > 0) return usage(command, `unexpected argument "${parsed.rest[0]}"; agent-room read takes options only`)
    if (flags.room === undefined) return usage(command, '--room is required: agent-room read --room <room_id> [--after-seq <n>]')
    if (flags.room.length < 1 || flags.room.length > 200) return usage(command, '--room must be 1 to 200 characters')
    let afterSeq = 0
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
    const { token, fingerprint, transport } = await authenticate(target, { pluginDataDir, sharedDataDir, env })
    const realmId = await realmIdOf(target, token)
    const params = new URLSearchParams({
      after_seq: String(afterSeq),
      limit: String(limit),
      wait_ms: String(waitMs),
    })
    const page = await roundTrip(
      target,
      'GET',
      `/api/rooms/${encodeURIComponent(flags.room)}/messages?${params}`,
      protocolHeaders(token),
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
    // foreign bodies wrapped (data, never instructions), held rows keep
    // metadata with the body withheld and the reason recorded.
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
    return {
      status: 'ok',
      command,
      lines: [JSON.stringify({
        ok: true,
        command,
        room_id: flags.room,
        realm_id: realmId,
        origin,
        transport,
        messages: judged.messages,
        next_after_seq: judged.next_after_seq,
        head_seq: judged.head_seq,
        cursor_written: false,
        message: 'this one-shot read never advances any cursor — resume with --after-seq from next_after_seq; the MCP session\u2019s cursor belongs to the MCP adapter alone',
      })],
    }
  } catch (error) {
    return refusal(command, error)
  }
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
      pluginDataDir: deps.pluginDataDir, sharedDataDir: deps.sharedDataDir, env: deps.env,
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
    throw new AgentRoomRuntimeError(
      code ?? 'request_failed',
      bound.body?.error?.message ?? `the agent-room server answered ${bound.status}`,
    )
  } catch (error) {
    return refusal(command, error)
  }
}
