// The human held/allow command bodies (Story 3.4, HCI-2/FR-10): the four
// `run*` functions behind `agent-room held list`, `held show`, `allow`, and
// `allow-all`, plus the shared substrate they stand on. One CLI slice over the
// finished pipeline — no pipeline, tool, or wire change: release goes through
// the pipeline's own `heldClear` per (room, seq), the allowlist through
// `setAllowlistEntry`, accept-all through `setAcceptAll`, and the preview
// through `heldBody` with the point-read seam exactly
// `after_seq = seq − 1, limit = 1`.
//
// THE UNBOUND-SESSION DISCIPLINE (this story's load-bearing choice): every
// command exchanges the shared data dir's local token plus the installation
// public key for a session token and NEVER claims a Chat ID — no chat-id bind
// request is ever sent. The exchange alone issues a token bound to the Actor
// fingerprint (server/api/server.mjs's local credential path), the post-auth
// presence touch no-ops for a session with no live row, and no durable claim
// row is written. The human runs these commands precisely while the MCP
// session is live, and a binding CLI could never do that: Story 1.5 refuses a
// second live claim of the same name (`chat_id_taken`). The commands
// therefore never read `config.json`, never learn a Chat ID of their own, and
// leave zero presence or claim footprint.
//
// THE ONLY BODY SURFACE: `held show` prints the record's metadata plus the
// exact artifact the delivery pipeline withheld — the cached copy, or the
// point-read recovery wrapped in the untrusted envelope exactly as the
// api-client wraps every foreign read, so the recovered preview byte-matches
// the cached artifact (spec-3-3's recorded decision, honored at this
// consumer). Every other command — the list, the allow report, the help, and
// every error message — carries metadata at most.
//
// RESOLUTION NEVER GUESSES: `allow` resolves a Chat ID from exactly two
// local-truth sources — this realm's held records (the senders actually
// awaiting a decision) and `GET /api/presence?include_offline=true` (online
// and offline-recently rows, both carrying chat id + fingerprint +
// last-seen) — compared case-insensitively per DR-1 and merged by
// fingerprint. Zero candidates refuses; several refuse with the candidate
// list; one proceeds; `--fingerprint` must be a well-formed fingerprint AND
// one of the name's candidates. Release matches held records by
// `actor_fingerprint ===` the resolved fingerprint (D13: a reused name
// inherits nothing, and a record with a null fingerprint is never matched by
// name).
//
// Shape discipline: the `run*` bodies take runSetup's injectable-deps shape
// (input/output/sharedDataDir/pluginDataDir) and return structured outcomes —
// `{ ok: true, lines, ... }` for the dispatch to print, `{ ok: false, code,
// message, lines? }` for the dispatch's one coded-error printer, or
// `{ ok: false, aborted: true, message }` for a declined interactive
// confirmation. Unexpected transport and state failures throw (or reject, for
// the queued mutators) and the dispatch surfaces them coded. Every write goes
// through the pipeline modules, which own the state-file discipline (0600,
// atomic writes, safe realm keys) — nothing here touches a state path
// directly.

import { createInterface } from 'node:readline'

import {
  CHAT_ID_INVALID_MESSAGE,
  FINGERPRINT_PATTERN,
  IDENTIFIER_MAX,
  REALM_KEY_PATTERN,
  chatIdForms,
} from '../constants.mjs'
import { AgentRoomRuntimeError } from '../runtime.mjs'
import { loadOrCreateKeypair } from '../keys.mjs'
import { loadOrCreateLocalToken } from '../api/local-token.mjs'
import { ensureServer } from '../client/ensure-server.mjs'
import { applyUntrustedEnvelope } from '../client/api-client.mjs'
import { cliHttpJson, cliBearerHeaders } from './http.mjs'
import { heldBody, heldClear, heldList } from '../client/held.mjs'
import { loadAllowlist, setAcceptAll, setAllowlistEntry } from '../client/trust.mjs'

const OK_STATUS = 200

export const ALLOW_ALL_REQUIRES_TTY_MESSAGE = 'agent-room allow-all grants blanket delivery for a realm without per-sender verification, so it asks a human to confirm and needs an interactive terminal (a TTY). Run it in your own terminal: agent-room allow-all'

// --- The unbound CLI session ------------------------------------------------------

// The credential exchange ONLY: the shared data dir's local token plus this
// installation's public key are exchanged for a session token bound to the
// Actor fingerprint. No Chat ID is involved anywhere — the session-bind route
// is never sent, so the session stays unbound: no live claim, no presence
// row, no durable claim row, and no `chat_id_taken` collision with the live
// MCP session whose name the human is trusting while these commands run.
export async function exchangeCliSession({ port, sharedDataDir, pluginDataDir }) {
  const localToken = loadOrCreateLocalToken(sharedDataDir)
  const keypair = loadOrCreateKeypair(pluginDataDir)
  const exchange = await cliHttpJson(port, 'POST', '/api/auth/local', cliBearerHeaders(localToken), {
    public_key: keypair.publicKey.toString('base64url'),
  })
  if (exchange.status !== OK_STATUS || exchange.body?.result?.session_token === undefined) {
    throw new AgentRoomRuntimeError(
      exchange.body?.error?.code ?? 'request_failed',
      exchange.body?.error?.message ?? `the agent-room credential exchange answered ${exchange.status}`,
    )
  }
  return { sessionToken: exchange.body.result.session_token, keypair }
}

// GET /api/status through the unbound session, guarded by the same
// REALM_KEY_PATTERN path-escape rule as the MCP adapter's realmIdOf: the
// realm id keys directories under PLUGIN_DATA, so its shape is verified
// before any realm state path is built from it.
export async function resolveRealmId({ port, sessionToken }) {
  const status = await cliHttpJson(port, 'GET', '/api/status', cliBearerHeaders(sessionToken))
  if (status.status !== OK_STATUS || status.body?.ok !== true) {
    throw new AgentRoomRuntimeError(
      status.body?.error?.code ?? 'request_failed',
      status.body?.error?.message ?? `the agent-room status call answered ${status.status}`,
    )
  }
  const realmId = status.body.result.realm_id
  if (typeof realmId !== 'string' || !REALM_KEY_PATTERN.test(realmId)) {
    throw new AgentRoomRuntimeError(
      'invalid_request',
      'the agent-room realm id is not a safe state key; refusing to build a realm state path from it',
    )
  }
  return realmId
}

// ensureServer (boot-or-attach) plus the unbound session plus the realm —
// the shared preamble of every command.
async function openCliSession({ sharedDataDir, pluginDataDir }) {
  const server = await ensureServer({ dataDir: sharedDataDir })
  const { sessionToken, keypair } = await exchangeCliSession({ port: server.port, sharedDataDir, pluginDataDir })
  const realmId = await resolveRealmId({ port: server.port, sessionToken })
  return { port: server.port, sessionToken, keypair, realmId }
}

// --- The held id and the listing ---------------------------------------------------

// The held id is `<room_id>:<seq>`, parsed at the LAST colon: the held
// record's key is (room, seq) — the only stable identity the pipeline offers
// — and room ids legitimately contain colons (`direct:sha256:…:sha256:…`),
// while the seq is always a colon-free positive integer. Anything else is a
// coded refusal naming the input and the expected form.
export function parseHeldId(rawId) {
  const malformed = () => new AgentRoomRuntimeError(
    'invalid_request',
    `"${String(rawId)}" is not a held-message id; expected <room_id>:<seq> — the id as printed by "agent-room held list" (a positive sequence number after the last colon)`,
  )
  if (typeof rawId !== 'string' || rawId.length === 0) throw malformed()
  const lastColon = rawId.lastIndexOf(':')
  if (lastColon <= 0 || lastColon === rawId.length - 1) throw malformed()
  const roomId = rawId.slice(0, lastColon)
  const seqText = rawId.slice(lastColon + 1)
  if (roomId.length > IDENTIFIER_MAX || !/^[0-9]+$/.test(seqText)) throw malformed()
  const seq = Number(seqText)
  if (!Number.isSafeInteger(seq) || seq < 1) throw malformed()
  return { roomId, seq }
}

// One metadata line per held record — the shape `held list` and `held show`
// share. Metadata at most: id, chat id, fingerprint, room, seq, time, size,
// reason. A body byte can never ride this line because the metadata
// projection it prints from is the whitelist heldList returns.
function metadataLine(row) {
  return `  ${row.room_id}:${row.seq}  chat_id=${row.chat_id} fingerprint=${row.actor_fingerprint} room=${row.room_id} seq=${row.seq} created_at=${row.created_at} size=${row.size}B reason=${row.held_reason}`
}

function heldListHeader(realmId, count) {
  if (count === 0) return `realm ${realmId}: no held messages`
  return `realm ${realmId}: ${count} held message${count === 1 ? '' : 's'}`
}

// The held list: realm-wide, or one room when filtered. The filter gate
// mirrors the pipeline's own room-filter shape (held.mjs's assertRoomFilter:
// 1..IDENTIFIER_MAX characters) and names the failing input.
export async function runHeldList({ sharedDataDir, pluginDataDir }, { roomId } = {}) {
  if (roomId !== undefined
    && (typeof roomId !== 'string' || roomId.length < 1 || roomId.length > IDENTIFIER_MAX)) {
    throw new AgentRoomRuntimeError(
      'invalid_request',
      `"${String(roomId)}" is not a room id (1-${IDENTIFIER_MAX} characters); the --room filter takes a room id as shown in the listing`,
    )
  }
  const session = await openCliSession({ sharedDataDir, pluginDataDir })
  const rows = heldList(pluginDataDir, session.realmId, { roomId })
  return {
    ok: true,
    command: 'held list',
    realmId: session.realmId,
    rows,
    lines: [heldListHeader(session.realmId, rows.length), ...rows.map(metadataLine)],
  }
}

// --- The point-read seam (the preview's recovery path) ------------------------------

// The api-client's read path, replayed for the CLI's unbound session: the raw
// page fetch wraps every row in the static untrusted envelope exactly as
// readMessage does, so the recovered preview byte-matches the cached artifact
// the delivery pipeline withheld — the same transform, never a downgrade of
// the framing. Shaped exactly as heldBody's injected seam.
export function pointReadViaHttp({ port, sessionToken, fingerprint }) {
  return async ({ roomId, afterSeq, limit }) => {
    const params = new URLSearchParams()
    params.set('after_seq', String(afterSeq))
    params.set('limit', String(limit))
    const response = await cliHttpJson(
      port,
      'GET',
      `/api/rooms/${encodeURIComponent(roomId)}/messages?${params.toString()}`,
      cliBearerHeaders(sessionToken),
    )
    if (response.status !== OK_STATUS || response.body?.ok !== true) {
      throw new AgentRoomRuntimeError(
        response.body?.error?.code ?? 'request_failed',
        response.body?.error?.message ?? `the agent-room point read answered ${response.status}`,
      )
    }
    return applyUntrustedEnvelope(response.body.result, fingerprint)
  }
}

// The full preview: the metadata block, the provenance line (which path
// served the body), and the body verbatim between delimiters — no re-wrapping,
// no unwrapping, no truncation. A record that is not held (never registered,
// or already released) refuses: a released record's body is never shown again.
export async function runHeldShow({ sharedDataDir, pluginDataDir }, rawId) {
  const { roomId, seq } = parseHeldId(rawId)
  const session = await openCliSession({ sharedDataDir, pluginDataDir })
  const row = heldList(pluginDataDir, session.realmId, { roomId }).find(candidate => candidate.seq === seq)
  if (!row) {
    throw new AgentRoomRuntimeError(
      'message_not_found',
      `held message "${roomId}:${seq}" is not held — never registered, or already released; a released record's body is never shown again`,
    )
  }
  const preview = await heldBody(pluginDataDir, session.realmId, roomId, seq, {
    pointRead: pointReadViaHttp({
      port: session.port,
      sessionToken: session.sessionToken,
      fingerprint: session.keypair.fingerprint,
    }),
  })
  if (typeof preview.body !== 'string') {
    // The record is held but neither the local cache nor the durable log
    // served the body — an honest refusal, never an empty preview.
    throw new AgentRoomRuntimeError(
      'request_failed',
      `held message "${roomId}:${seq}" is held but its body could not be recovered by point read from the durable log`,
    )
  }
  return {
    ok: true,
    command: 'held show',
    realmId: session.realmId,
    id: `${roomId}:${seq}`,
    row,
    body: preview.body,
    evicted: preview.evicted,
    lines: [
      `held ${roomId}:${seq}  (realm ${session.realmId})`,
      metadataLine(row),
      preview.evicted
        ? 'provenance: the preview was recovered by point read (after_seq = seq − 1, limit = 1) from the durable log'
        : 'provenance: the preview came from the local cache',
      '--- held body ---',
      preview.body,
      '--- end of held body ---',
    ],
  }
}

// --- Chat ID resolution (held records + presence, never a guess) --------------------

// One candidate per fingerprint, merged across both sources; sources keep the
// freshest presence last-seen. A row without a string fingerprint contributes
// nothing — a null fingerprint is never matched by name (D13).
export async function resolveChatIdCandidates({ port, sessionToken, pluginDataDir, realmId, chatName }) {
  const forms = chatIdForms(chatName)
  if (!forms) {
    throw new AgentRoomRuntimeError(
      'invalid_chat_id',
      `"${String(chatName)}" is not a valid Chat ID: ${CHAT_ID_INVALID_MESSAGE}`,
    )
  }
  const wanted = forms.normalized
  const byFingerprint = new Map()
  const candidateOf = fingerprint => {
    let candidate = byFingerprint.get(fingerprint)
    if (!candidate) {
      candidate = { fingerprint, sources: [] }
      byFingerprint.set(fingerprint, candidate)
    }
    return candidate
  }
  // Source 1: this realm's held records — the senders actually awaiting a
  // trust decision, each carrying its chat id and key fingerprint. One
  // candidate per fingerprint: several records of the same key add one source.
  for (const row of heldList(pluginDataDir, realmId)) {
    if (typeof row.chat_id === 'string'
      && row.chat_id.toLowerCase() === wanted
      && typeof row.actor_fingerprint === 'string'
      && row.actor_fingerprint.length > 0) {
      const candidate = candidateOf(row.actor_fingerprint)
      if (!candidate.sources.some(source => source.kind === 'held record')) {
        candidate.sources.push({ kind: 'held record' })
      }
    }
  }
  // Source 2: presence — the online group and the separately-labeled
  // offline-recently group, both carrying chat id + fingerprint + last-seen.
  const presence = await cliHttpJson(
    port,
    'GET',
    '/api/presence?include_offline=true',
    cliBearerHeaders(sessionToken),
  )
  if (presence.status !== OK_STATUS || presence.body?.ok !== true) {
    throw new AgentRoomRuntimeError(
      presence.body?.error?.code ?? 'request_failed',
      presence.body?.error?.message ?? `the agent-room presence call answered ${presence.status}`,
    )
  }
  const groups = presence.body.result ?? {}
  for (const group of [groups.online, groups.offline_recently]) {
    for (const row of Array.isArray(group) ? group : []) {
      if (typeof row.chat_id !== 'string' || row.chat_id.toLowerCase() !== wanted) continue
      if (typeof row.fingerprint !== 'string' || row.fingerprint.length === 0) continue
      const candidate = candidateOf(row.fingerprint)
      const existing = candidate.sources.find(source => source.kind === 'presence')
      if (existing === undefined) {
        candidate.sources.push({ kind: 'presence', ...(typeof row.last_seen === 'string' ? { lastSeen: row.last_seen } : {}) })
      } else if (typeof row.last_seen === 'string' && row.last_seen > (existing.lastSeen ?? '')) {
        existing.lastSeen = row.last_seen
      }
    }
  }
  return [...byFingerprint.values()]
}

// The candidate list is part of the refusal, one line per candidate with its
// fingerprint and where the CLI saw it — HCI-4's presentation rule.
function candidateLines(candidates) {
  return candidates.map(candidate => {
    const described = candidate.sources
      .map(source => source.kind === 'presence'
        ? `presence last-seen ${source.lastSeen ?? 'unknown'}`
        : source.kind)
      .join('; ')
    return `  candidate: fingerprint ${candidate.fingerprint} — ${described}`
  })
}

// --- allow: resolve, save, release ---------------------------------------------------

export async function runAllow(
  { sharedDataDir, pluginDataDir },
  rawName,
  { remove = false, fingerprint: fingerprintArg } = {},
) {
  const forms = chatIdForms(rawName)
  if (!forms) {
    throw new AgentRoomRuntimeError(
      'invalid_chat_id',
      `"${String(rawName)}" is not a valid Chat ID: ${CHAT_ID_INVALID_MESSAGE}`,
    )
  }
  let fingerprintFilter = null
  if (fingerprintArg !== undefined) {
    if (typeof fingerprintArg !== 'string' || !FINGERPRINT_PATTERN.test(fingerprintArg)) {
      throw new AgentRoomRuntimeError(
        'invalid_request',
        `"${String(fingerprintArg)}" is not a well-formed fingerprint (expected sha256: followed by 64 lowercase hex characters)`,
      )
    }
    fingerprintFilter = fingerprintArg
  }
  const session = await openCliSession({ sharedDataDir, pluginDataDir })
  const candidates = await resolveChatIdCandidates({
    port: session.port,
    sessionToken: session.sessionToken,
    pluginDataDir,
    realmId: session.realmId,
    chatName: forms.display,
  })
  if (candidates.length === 0) {
    return {
      ok: false,
      command: 'allow',
      code: 'chat_id_not_found',
      message: `no sender with chat id "${forms.display}" was found in this realm's held records or in presence (online and offline-recently were both searched); the name cannot be resolved to a key fingerprint, so nothing was changed`,
    }
  }
  if (fingerprintFilter !== null) {
    if (!candidates.some(candidate => candidate.fingerprint === fingerprintFilter)) {
      // A well-formed fingerprint that has nothing to do with the name the
      // human typed is refused with the candidate list — never a silent allow
      // of an unrelated key.
      return {
        ok: false,
        command: 'allow',
        code: 'invalid_request',
        message: `"${fingerprintFilter}" is not among the candidates for chat id "${forms.display}" in this realm's held records or presence; nothing was changed`,
        lines: candidateLines(candidates),
      }
    }
  } else if (candidates.length > 1) {
    return {
      ok: false,
      command: 'allow',
      code: 'ambiguous_chat_id',
      message: `the chat id "${forms.display}" is claimed by ${candidates.length} keys; nothing was changed — retry with one candidate's fingerprint as --fingerprint`,
      lines: candidateLines(candidates),
    }
  }
  const fingerprint = fingerprintFilter ?? candidates[0].fingerprint

  if (remove === true) {
    // Removal affects future ingestion only: the entry goes, the held records
    // of every key stay pending decisions, and the durable log is untouched.
    const had = loadAllowlist(pluginDataDir, session.realmId)
      .entries
      .some(entry => entry.fingerprint === fingerprint)
    setAllowlistEntry(pluginDataDir, session.realmId, fingerprint, false)
    return {
      ok: true,
      command: 'allow',
      realmId: session.realmId,
      fingerprint,
      chatId: forms.display,
      removed: true,
      lines: had
        ? [
            `realm ${session.realmId}: removed the allowlist entry for fingerprint ${fingerprint} (chat id "${forms.display}")`,
            'future messages from this sender are held again; already-ingested text and the durable log are untouched',
          ]
        : [
            `realm ${session.realmId}: no allowlist entry existed for fingerprint ${fingerprint} (chat id "${forms.display}"); nothing was changed`,
          ],
    }
  }

  // Persist the entry FIRST, then release: success is never reported without
  // the entry on disk, and the release runs through the pipeline's own
  // heldClear per (room, seq) — matched by actor_fingerprint === the resolved
  // fingerprint, never by name (D13).
  const allowlist = setAllowlistEntry(pluginDataDir, session.realmId, fingerprint, true)
  const matching = heldList(pluginDataDir, session.realmId)
    .filter(row => row.actor_fingerprint === fingerprint)
  let released = 0
  for (const row of matching) {
    const cleared = await heldClear(pluginDataDir, session.realmId, row.room_id, row.seq)
    if (cleared) released += 1
  }
  return {
    ok: true,
    command: 'allow',
    realmId: session.realmId,
    fingerprint,
    chatId: forms.display,
    released,
    allowlist,
    lines: [
      `realm ${session.realmId}: allowed fingerprint ${fingerprint} (chat id "${forms.display}")`,
      released === 0
        ? 'no held records carried this fingerprint; nothing to release'
        : `released ${released} held record(s) for this fingerprint`,
    ],
  }
}

// --- allow-all: the accept-all surface ------------------------------------------------

// One y/N ask on the injected streams; the input ending before an answer
// resolves null (the setup command's abort discipline).
function askConfirm({ input, output, question }) {
  return new Promise(resolvePromise => {
    const lines = createInterface({ input, output, terminal: false })
    let settled = false
    const settle = value => {
      if (settled) return
      settled = true
      resolvePromise(value)
    }
    lines.once('close', () => settle(null))
    lines.question(question, answer => {
      settle(/^(y|yes)$/i.test(String(answer ?? '').trim()))
      lines.close()
    })
  })
}

export async function runAllowAll({ input, output, sharedDataDir, pluginDataDir }, { remove = false } = {}) {
  const session = await openCliSession({ sharedDataDir, pluginDataDir })
  if (remove === true) {
    // The fail-safe direction: no confirmation, holding messages again.
    const allowlist = setAcceptAll(pluginDataDir, session.realmId, false)
    return {
      ok: true,
      command: 'allow-all',
      realmId: session.realmId,
      acceptAll: false,
      allowlist,
      lines: [
        `realm ${session.realmId}: accept-all is OFF — future senders without an allowlist entry are held again`,
      ],
    }
  }
  if (!input.isTTY) {
    // The blanket grant can never be driven programmatically: pipes, the MCP
    // host, and CI are refused with guidance before anything is touched.
    return { ok: false, command: 'allow-all', code: 'invalid_request', message: ALLOW_ALL_REQUIRES_TTY_MESSAGE }
  }
  const confirmed = await askConfirm({
    input,
    output,
    question: `agent-room allow-all delivers every future sender in realm ${session.realmId} without per-sender verification. The untrusted envelope stays on delivered bodies. Continue? [y/N] `,
  })
  if (confirmed === null) {
    return {
      ok: false,
      aborted: true,
      command: 'allow-all',
      message: 'agent-room allow-all ended before an answer was given; accept-all was not changed',
    }
  }
  if (!confirmed) {
    return {
      ok: false,
      aborted: true,
      command: 'allow-all',
      message: 'agent-room allow-all kept accept-all off; nothing was changed',
    }
  }
  const allowlist = setAcceptAll(pluginDataDir, session.realmId, true)
  return {
    ok: true,
    command: 'allow-all',
    realmId: session.realmId,
    acceptAll: true,
    allowlist,
    lines: [
      `realm ${session.realmId}: accept-all is ON — every future sender delivers without per-sender verification.`,
      'This approval is a human convention (Instructed): same-user processes are not cryptographically distinguishable.',
      'The untrusted envelope stays on delivered bodies.',
    ],
  }
}
