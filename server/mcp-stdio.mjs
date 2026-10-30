#!/usr/bin/env node

// The MCP stdio adapter (Story 1.7): five conversation tools over the HTTP
// api-client — room_presence, room_direct_open, message_send, message_read,
// room_status — plus Story 3.2's two trust tools (room_trust_list,
// room_trust_set) over the per-realm allowlist and Story 3.3's two held tools
// (room_held_list, room_held_count) over the per-realm held pipeline. The
// v0.1 unix-socket daemon surface (with its create/join verbs, retired per
// AD-14) is gone; nothing here spawns or speaks to it.
//
// Identity discipline (NFR-3): the session is bound from this installation's
// own state — the local token file, the installation keypair, and the Chat ID
// stored by the one-time `agent-room setup` command. No tool argument carries
// sender identity or authority; every schema closes with
// additionalProperties: false, and unknown (including identity-shaped)
// arguments are rejected before any call.
//
// Cursor discipline: cursors are client-owned. message_read defaults
// after_seq to this installation's persisted cursor for (realm, room) and
// advances it to the response's next_after_seq on every successful read,
// durably stored at PLUGIN_DATA/realms/<realm_id>/cursors.json (0600, atomic
// writes). The server holds no per-client delivery state.
//
// Trust discipline (Story 3.2, FR-10, AD-12): every message row of a
// message_read result is evaluated by the client-side trust matrix before the
// tool result is built — own-Actor and local-transport (Local Mode's OS-user
// boundary) senders deliver, allowlisted remote senders deliver, every other
// remote sender is HELD: its row keeps the metadata, its text becomes the
// held marker (no body), and the matrix reason is recorded. Allowlist state
// lives beside the cursors at PLUGIN_DATA/realms/<realm_id>/allowlist.json
// (0600, atomic writes) and binds key fingerprints, never Chat IDs. The
// accept-all flag exists in that file but is settable only by a human through
// the CLI (Story 3.4) — no tool below can set it.
//
// Held discipline (Story 3.3, FR-10/FR-20): every held row a read produces
// registers into the per-realm held pipeline at
// PLUGIN_DATA/realms/<realm_id>/held.json (0600, atomic) — metadata (realm,
// sender Chat ID, fingerprint, room, seq, time, size, reason) plus a bounded
// body cache (HELD_CACHE_MAX, drop-oldest) whose copies serve only the HUMAN
// approval surface; recovery after eviction is a point read through the
// api-client (after_seq = seq − 1, limit = 1). Registration happens AFTER the
// cursor persists: the held seqs were consumed by the cursor like any other
// (FR-20 — held state is separate, keyed (realm, room, seq)), so a held
// message never stalls the cursor and a cursor failure never loses the held
// record. Two additive tools join the surface — room_held_list (metadata
// only, never a body) and room_held_count — and the held pipeline's
// body-recovery and release functions are human-surface code the tool layer
// never imports or calls: the agent can never retrieve or release a held
// body; that is the human CLI's surface (Story 3.4).
//
// Outcome discipline: message_send relies on the api-client's
// outcome_unknown retry (one immediate resend with the identical
// client_message_id), so a lost reply can never duplicate a message.
//
// stdin purity: stdin carries only the MCP JSON-RPC channel. Lines are read
// directly from the stream; the adapter never asks the human anything here,
// and no byte is ever written to stdin. The one-time human interaction (Chat
// ID choice) belongs to the separate `agent-room setup` command.

import { realpathSync } from 'node:fs'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CHAT_ID_MAX,
  CHAT_ID_PATTERN,
  CLIENT_MESSAGE_ID_MAX,
  FINGERPRINT_PATTERN,
  FRAME_MAX_BYTES,
  IDENTIFIER_MAX,
  MESSAGE_TEXT_MAX,
  READ_HOLD_MAX_MS,
  READ_PAGE_DEFAULT,
  READ_PAGE_MAX,
  REALM_KEY_PATTERN,
} from './constants.mjs'
import {
  APP_VERSION,
  AgentRoomRuntimeError,
  assertSupportedRuntime,
  atomicWriteJson,
  instanceDataDirectory,
  readJsonFile,
  sharedDataDirectory,
} from './runtime.mjs'
import { createAgentRoomClient } from './client/api-client.mjs'
import { CLIENT_RELEASE_TIMEOUT_MS } from './constants.mjs'

// One wall-clock pause (the shutdown budget's timer).
const delay = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })
import {
  applyTrustMatrix,
  loadAllowlist,
  setAllowlistEntry,
} from './client/trust.mjs'
import {
  heldCount,
  heldList,
  registerHeldMessages,
} from './client/held.mjs'
import { notifierEnabled, startNotifier } from './client/notifier.mjs'

// Run the runtime gate before any other work. Direct launches report one
// diagnosable line and exit 1 with no stack trace; importers get a catchable
// rejection so harnesses can assert on the failure.
try {
  assertSupportedRuntime()
} catch (error) {
  if (launchedDirectly()) {
    process.stderr.write(`agent-room MCP failed: ${error?.code ?? 'startup_failed'}: ${error?.message}\n`)
    process.exit(1)
  }
  throw error
}

const JSONRPC_VERSION = '2.0'
const SUPPORTED_PROTOCOLS = Object.freeze(['2025-06-18'])
const DEFAULT_PROTOCOL = '2025-06-18'

// Schema patterns derive from the constants module (each shape declared once);
// the JSON-schema form anchors the shared source expression.
// JSON Schema `pattern` is already anchored, so the shared pattern is reused as-is
// (prefixing another ^ here would produce a doubled anchor).
const FINGERPRINT_SCHEMA_PATTERN = FINGERPRINT_PATTERN.source

// The five tools. Descriptions carry the "list agents" phrasing and the Agent
// Room identity; there are no native-named aliases and no join verbs. The
// schemas are the schema-level half of the NFR-3 negatives: every one closes
// with additionalProperties: false and no property carries identity.
const TOOL_DESCRIPTORS = Object.freeze([
  {
    name: 'room_presence',
    description: 'List agents in the local Agent Room: who is online right now (chat id, client type, connected since, last seen, fingerprint), and, when include_offline is true, who was seen in the last day. Use it to list agents before opening a DM. Identity comes only from this installation\'s session — no tool argument carries identity.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        include_offline: { type: 'boolean', default: false, description: 'Also list agents seen within the last day who are not online now.' },
      },
    },
  },
  {
    name: 'room_direct_open',
    description: 'Open (or reuse) the private pair room with the agent whose Chat ID is chat_id in the Agent Room — list agents with room_presence first. Never guesses: when several agents have claimed the name the ambiguous_chat_id error lists candidates (fingerprint + last seen); retry with one candidate\'s fingerprint as target_fingerprint. Concurrent opens converge on the same room.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['chat_id'],
      properties: {
        chat_id: { type: 'string', minLength: 1, maxLength: CHAT_ID_MAX, pattern: CHAT_ID_PATTERN.source, description: 'The Chat ID of the agent to open a pair room with.' },
        target_fingerprint: { type: 'string', pattern: FINGERPRINT_SCHEMA_PATTERN, description: 'Disambiguator: the fingerprint of the candidate to resolve to when the chat id is ambiguous.' },
      },
    },
  },
  {
    name: 'message_send',
    description: 'Send one plain-text message to an Agent Room you are a member of (the Broadcast Room, or a pair room room_direct_open returned). Retries with the identical client_message_id when the outcome is unknown, so a lost reply can never duplicate the message. Your identity comes from this installation\'s session — never from arguments.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['room_id', 'client_message_id', 'text'],
      properties: {
        room_id: { type: 'string', minLength: 1, maxLength: IDENTIFIER_MAX },
        client_message_id: { type: 'string', minLength: 1, maxLength: CLIENT_MESSAGE_ID_MAX },
        text: { type: 'string', minLength: 1, maxLength: MESSAGE_TEXT_MAX },
        reply_to_seq: { type: 'integer', minimum: 1 },
      },
    },
  },
  {
    name: 'message_read',
    description: `Read ordered messages from an Agent Room after after_seq — when omitted, this installation's persisted cursor for the room is used — optionally waiting up to ${READ_HOLD_MAX_MS / 1000} seconds for new messages. Every response carries next_after_seq and head_seq, and the cursor is durably advanced per realm and room, surviving restarts.`,
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['room_id'],
      properties: {
        room_id: { type: 'string', minLength: 1, maxLength: IDENTIFIER_MAX },
        after_seq: { type: 'integer', minimum: 0, description: 'Resume strictly after this sequence; omitted means the stored cursor.' },
        limit: { type: 'integer', minimum: 1, maximum: READ_PAGE_MAX, default: READ_PAGE_DEFAULT },
        wait_ms: { type: 'integer', minimum: 0, maximum: READ_HOLD_MAX_MS, default: 0 },
      },
    },
  },
  {
    name: 'room_status',
    description: 'Return the local Agent Room status: the stable realm_id, the implicit Broadcast Room id, the server version, and this installation\'s identity (chat_id and fingerprint). Takes no arguments — identity comes only from the session.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'room_trust_list',
    description: 'List this installation\'s trust state for the current Agent Room realm: the per-realm allowlist of sender key fingerprints whose messages deliver directly, and whether the human has set accept-all. Trust binds key fingerprints, never Chat IDs. Use it to inspect this Agent Room realm\'s trust state — for example to see why a sender\'s messages arrive held (metadata only, body withheld).',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
  {
    name: 'room_trust_set',
    description: 'Allow or disallow one sender key fingerprint on this installation\'s per-realm allowlist for the current Agent Room realm. allowed=true adds the fingerprint, so that sender\'s future messages in this Agent Room realm deliver; allowed=false removes it, so they are held again (metadata only, body withheld) — already-read messages are not withdrawn. Trust binds key fingerprints, never Chat ID names: a reused name or a replaced key inherits nothing. Accept-all is a human CLI decision and cannot be set here.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['target_fingerprint', 'allowed'],
      properties: {
        target_fingerprint: { type: 'string', pattern: FINGERPRINT_SCHEMA_PATTERN, description: 'The sender key fingerprint to allow or disallow for this realm — never a Chat ID.' },
        allowed: { type: 'boolean', description: 'true adds the fingerprint to the realm allowlist; false removes it.' },
      },
    },
  },
  {
    name: 'room_held_list',
    description: 'List the messages this installation has HELD in the current Agent Room realm — senders the trust matrix does not deliver. Metadata only, never body text: sender chat id, key fingerprint, room, sequence, time, byte size, and the realm\'s held count. Bodies stay withheld until a human releases the sender with the agent-room CLI; list agents with room_presence, then use this to tell the human what awaits their trust decision.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        room_id: { type: 'string', minLength: 1, maxLength: IDENTIFIER_MAX, description: 'Only list held messages for this room; omit for every room in the realm.' },
      },
    },
  },
  {
    name: 'room_held_count',
    description: 'Count the messages this installation has HELD in the current Agent Room realm, waiting for a human trust decision. Metadata only — no held body text exists on any tool; use room_held_list for the per-message metadata.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
])
const TOOL_NAMES = new Set(TOOL_DESCRIPTORS.map(tool => tool.name))

// The per-tool argument allowlists mirror the schemas exactly (the schema-
// level NFR-3 negatives assert the mirror); anything else — including
// identity-shaped fields — is rejected before any call.
export const TOOL_ARGUMENT_FIELDS = Object.freeze(new Map([
  ['room_presence', Object.freeze(new Set(['include_offline']))],
  ['room_direct_open', Object.freeze(new Set(['chat_id', 'target_fingerprint']))],
  ['message_send', Object.freeze(new Set(['room_id', 'client_message_id', 'text', 'reply_to_seq']))],
  ['message_read', Object.freeze(new Set(['room_id', 'after_seq', 'limit', 'wait_ms']))],
  ['room_status', Object.freeze(new Set([]))],
  ['room_trust_list', Object.freeze(new Set([]))],
  ['room_trust_set', Object.freeze(new Set(['target_fingerprint', 'allowed']))],
  ['room_held_list', Object.freeze(new Set(['room_id']))],
  ['room_held_count', Object.freeze(new Set([]))],
]))

function rpcError(id, code, message, data) {
  return {
    jsonrpc: JSONRPC_VERSION,
    id: id ?? null,
    error: { code, message, ...(data === undefined ? {} : { data }) },
  }
}

function rpcResult(id, result) {
  return { jsonrpc: JSONRPC_VERSION, id, result }
}

function toolResult(value, isError = false) {
  const structuredContent = isError
    ? { ok: false, error: value }
    : value && typeof value === 'object'
      ? value
      : { value }
  return {
    content: [{ type: 'text', text: JSON.stringify(structuredContent) }],
    structuredContent,
    ...(isError ? { isError: true } : {}),
  }
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Argument validation mirrors each tool's JSON schema. Unknown fields are
// rejected, never ignored — that is the schema-level NFR-3 negative: an
// argument carrying actor/fingerprint authority has no allowed name.
function validateArguments(name, args) {
  if (!plainObject(args)) return 'tool arguments must be an object'
  const allowed = TOOL_ARGUMENT_FIELDS.get(name)
  if (!allowed) return 'unknown tool'
  if (Object.keys(args).some(key => !allowed.has(key))) return 'tool arguments contain an unknown field'
  if (name === 'room_presence') {
    if (args.include_offline !== undefined && typeof args.include_offline !== 'boolean') {
      return 'include_offline must be a boolean'
    }
  }
  if (name === 'room_direct_open') {
    if (typeof args.chat_id !== 'string') return 'chat_id must be a string'
    if (args.chat_id.length < 1 || args.chat_id.length > CHAT_ID_MAX) return `chat_id must contain 1 to ${CHAT_ID_MAX} characters`
    if (!CHAT_ID_PATTERN.test(args.chat_id)) return `chat_id must be 1 to ${CHAT_ID_MAX} characters using letters, numbers, dot, underscore, or hyphen`
    if (args.target_fingerprint !== undefined) {
      if (typeof args.target_fingerprint !== 'string') return 'target_fingerprint must be a string'
      if (!FINGERPRINT_PATTERN.test(args.target_fingerprint)) return 'target_fingerprint must be sha256: followed by 64 lowercase hex characters'
    }
  }
  if (['message_send', 'message_read'].includes(name) && typeof args.room_id !== 'string') return 'room_id must be a string'
  if (name === 'message_send') {
    if (typeof args.client_message_id !== 'string') return 'client_message_id must be a string'
    if (typeof args.text !== 'string') return 'text must be a string'
    if (args.client_message_id.length < 1 || args.client_message_id.length > CLIENT_MESSAGE_ID_MAX) return `client_message_id must contain 1 to ${CLIENT_MESSAGE_ID_MAX} characters`
    if (args.text.trim().length < 1 || args.text.length > MESSAGE_TEXT_MAX) return `text must contain 1 to ${MESSAGE_TEXT_MAX} characters`
    if (args.reply_to_seq !== undefined && (!Number.isSafeInteger(args.reply_to_seq) || args.reply_to_seq < 1)) return 'reply_to_seq must be a positive integer'
  }
  if (name === 'message_read') {
    if (args.after_seq !== undefined && (!Number.isSafeInteger(args.after_seq) || args.after_seq < 0)) return 'after_seq must be a non-negative integer'
    if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > READ_PAGE_MAX)) return `limit must be between 1 and ${READ_PAGE_MAX}`
    if (args.wait_ms !== undefined && (!Number.isSafeInteger(args.wait_ms) || args.wait_ms < 0 || args.wait_ms > READ_HOLD_MAX_MS)) return `wait_ms must be between 0 and ${READ_HOLD_MAX_MS}`
  }
  if (name === 'room_trust_set') {
    if (typeof args.target_fingerprint !== 'string') return 'target_fingerprint must be a string'
    if (!FINGERPRINT_PATTERN.test(args.target_fingerprint)) return 'target_fingerprint must be sha256: followed by 64 lowercase hex characters'
    if (typeof args.allowed !== 'boolean') return 'allowed must be a boolean'
  }
  if (name === 'room_held_list') {
    if (args.room_id !== undefined) {
      if (typeof args.room_id !== 'string') return 'room_id must be a string'
      if (args.room_id.length < 1 || args.room_id.length > IDENTIFIER_MAX) return `room_id must contain 1 to ${IDENTIFIER_MAX} characters`
    }
  }
  return null
}

// --- Client-owned cursors -----------------------------------------------------

// Cursor state lives per (installation, realm, room) under
// PLUGIN_DATA/realms/<realm_id>/cursors.json — one bounded, atomically
// rewritten 0600 file per realm. A missing or unusable file means "no cursor
// yet"; a corrupt file never blocks a read (it falls back to the beginning
// and is overwritten on the next advance).
//
// Discipline:
//   - The realm id is validated against a safe-key shape before any path is
//     built from it — a malformed realm id is a coded refusal, never a path
//     escape.
//   - A write never moves a room's cursor backwards: the persisted value is
//     max(existing, next_after_seq), so an explicit low after_seq read
//     re-consumes history without regressing the durable cursor.
//   - Read-modify-write cycles are serialized through a per-realm promise
//     chain, so concurrent reads of different rooms can never lose each
//     other's updates.
//   - A failed cursor write is reported back on the read result
//     (cursor_persisted: false plus a coded note) — the consumed page is
//     never discarded because the disk write failed.

// Safe cursor-key shape for a realm id (shared with the allowlist paths):
// REALM_KEY_PATTERN from the constants module is the only shape allowed into
// a path segment under PLUGIN_DATA/realms/.

function assertCursorKeyRealm(realmId) {
  if (typeof realmId !== 'string' || !REALM_KEY_PATTERN.test(realmId)) {
    throw new AgentRoomRuntimeError(
      'invalid_request',
      'the agent-room realm id is not a safe cursor key; refusing to build a cursor path from it',
    )
  }
  return realmId
}

function cursorFilePath(pluginData, realmId) {
  return join(pluginData, 'realms', assertCursorKeyRealm(realmId), 'cursors.json')
}

// In-process cursor memory: the durable file is the source of truth across
// restarts, but a file that cannot be read (or a write that failed) must
// never rewind THIS process's read position — doing so re-delivers messages
// the caller already consumed. Memory is merged OVER the file's values.
const cursorMemory = new Map()

function cursorMemoryKey(realmId, roomId) {
  return `${realmId}\u0000${roomId}`
}

function loadCursors(pluginData, realmId) {
  const path = cursorFilePath(pluginData, realmId)
  let stored = {}
  if (existsSync(path)) {
    try {
      const value = readJsonFile(path)
      stored = plainObject(value) && plainObject(value.cursors) ? value.cursors : {}
    } catch {
      stored = {}
    }
  }
  const merged = { ...stored }
  const prefix = `${realmId}\u0000`
  for (const [key, entry] of cursorMemory) {
    if (key.startsWith(prefix) && plainObject(entry) && typeof entry.after_seq === 'number') {
      merged[key.slice(prefix.length)] = entry
    }
  }
  return merged
}

function writeCursors(pluginData, realmId, roomId, afterSeq) {
  const cursors = loadCursors(pluginData, realmId)
  const previous = cursors[roomId]?.after_seq
  // A cursor is monotonic per room: an explicit low after_seq read must
  // never move the durable cursor backwards.
  const next = typeof previous === 'number'
    && Number.isSafeInteger(previous)
    && previous >= 0
    && previous > afterSeq
    ? previous
    : afterSeq
  const entry = { after_seq: next, updated_at: new Date().toISOString() }
  cursors[roomId] = entry
  // Memory is updated FIRST: even if the durable write throws, this process
  // keeps the advanced position and the read result is returned with
  // cursor_persisted: false rather than re-delivering the consumed page.
  cursorMemory.set(cursorMemoryKey(realmId, roomId), entry)
  atomicWriteJson(cursorFilePath(pluginData, realmId), { version: 1, cursors })
  return next
}

// One serialized read-modify-write chain per realm: cursor writes across
// concurrent reads (different rooms, one realm) queue behind each other in
// arrival order, so a later write never races an earlier one's read.
const cursorChains = new Map()

function queueCursorPersist(pluginData, realmId, roomId, afterSeq) {
  assertCursorKeyRealm(realmId)
  const previous = cursorChains.get(realmId) ?? Promise.resolve()
  const next = previous
    .catch(() => { /* a failed write must not poison the chain */ })
    .then(() => writeCursors(pluginData, realmId, roomId, afterSeq))
  cursorChains.set(realmId, next)
  return next
}

// --- The MCP server -------------------------------------------------------------

export function createMcpServer({
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  env = process.env,
  cwd = process.cwd(),
} = {}) {
  assertSupportedRuntime()
  const dataDir = sharedDataDirectory(env)
  const pluginData = instanceDataDirectory(env, cwd)
  let negotiatedProtocol = DEFAULT_PROTOCOL

  const write = message => output.write(`${JSON.stringify(message)}\n`)
  // In-flight tool calls, keyed by their MCP request id: a cancelled
  // notification (or stdin closing) aborts the call's HTTP round trip through
  // the signal the api-client threads into every request.
  const pending = new Map()

  // The api-client (and through it the local server) boots lazily on the
  // first tool call. Construction itself only reads local state (the setup
  // config, the keypair), so a synchronous failure — the first-run guidance
  // for a missing Chat ID — surfaces per call and never poisons the client.
  let clientPromise = null
  let realmId = null
  // The companion notifier (server/client/notifier.mjs): started after the
  // first successful tool call — the first bind — never before, and stopped
  // by the shared shutdown. A notifier that stopped on a session-level
  // refusal clears itself, so the next successful call starts a fresh one.
  let notifier = null
  function getClient() {
    clientPromise ??= createAgentRoomClient({ dataDir, pluginDataDir: pluginData })
    return clientPromise
  }

  // The shared, bounded shutdown operation (Story 7.3, A8). EVERY teardown
  // trigger joins the first invocation: stdin closing, SIGTERM, SIGINT, and
  // the returned close(). It aborts every in-flight call (admission stops —
  // the process never lingers on a held long-poll with no host attached),
  // then awaits the client's release — which first lets a pending first
  // bind settle so its rollback is coordinated (A9) — under a TOTAL budget:
  // the declared CLIENT_RELEASE_TIMEOUT_MS bounds the whole operation by
  // wall clock (the socket idle timeout inside the release alone is not a
  // total bound — a trickle can starve it), and a budget overrun is
  // recorded as 'timeout'. The outcome is recorded on the adapter's own
  // stderr; the signal path exits as soon as the operation settles (always
  // inside the budget), and the stdin-close path forces the exit when the
  // budget was overrun (a held socket would otherwise outlive the bound).
  let shutdownPromise = null
  const shutdown = () => {
    if (shutdownPromise !== null) return shutdownPromise
    shutdownPromise = (async () => {
      notifier?.stop()
      for (const controller of pending.values()) controller.abort()
      pending.clear()
      let outcome = 'no_session'
      if (clientPromise !== null) {
        try {
          const readyClient = await clientPromise
          outcome = await Promise.race([
            readyClient.release().then(result => {
              if (result.released === true) return result.rolled_back === true ? 'released' : 'released'
              return result.reason ?? 'unknown'
            }),
            delay(CLIENT_RELEASE_TIMEOUT_MS).then(() => 'timeout'),
          ])
        } catch {
          outcome = 'unknown'
        }
      }
      if (outcome !== 'released' && outcome !== 'no_session') {
        errorOutput.write(`agent-room MCP shutdown release: ${outcome} (a lease may remain until it expires)\n`)
      }
      return outcome
    })()
    return shutdownPromise
  }

  // The polite-kill path (Story 7.3, A8): a host that SIGTERM/SIGINTs the
  // child — what a one-shot vendor CLI does on exit — now runs the same
  // bounded shutdown before exiting, so the orderly release no longer loses
  // the race against the kill. The handlers stay registered for the WHOLE
  // shutdown (a repeated signal while the release is still crossing the
  // wire re-enters this guard instead of falling through to the default
  // kill) and are removed only when the exit runs. SIGKILL, OOM kills,
  // power loss, and a dead remote peer are outside any teardown path's
  // reach (Story 7.4's subject).
  let signalExit = false
  const exitAfterShutdown = () => {
    if (signalExit) return
    signalExit = true
    shutdown().finally(() => {
      process.removeListener('SIGTERM', exitAfterShutdown)
      process.removeListener('SIGINT', exitAfterShutdown)
      process.exit()
    })
  }
  process.on('SIGTERM', exitAfterShutdown)
  process.on('SIGINT', exitAfterShutdown)

  const realmIdOf = async () => {
    if (realmId !== null) return realmId
    const readyClient = await getClient()
    const status = await readyClient.status()
    // Path-escape guard: the realm id keys directories under PLUGIN_DATA, so
    // its shape is verified before any cursor path is built from it.
    if (typeof status.realm_id !== 'string' || !REALM_KEY_PATTERN.test(status.realm_id)) {
      throw new AgentRoomRuntimeError(
        'invalid_request',
        'the agent-room realm id is not a safe cursor key; refusing to build a cursor path from it',
      )
    }
    realmId = status.realm_id
    return realmId
  }

  const startNotifierOnce = () => {
    if (notifier !== null || shutdownPromise !== null || clientPromise === null || !notifierEnabled(env)) return
    const started = startNotifier({
      client: clientPromise,
      pluginDataDir: pluginData,
      realmIdOf,
      env,
      errorOutput,
      onStop: () => { if (notifier === started) notifier = null },
    })
    notifier = started
  }

  const callTool = async (name, args, signal) => {
    const invalid = validateArguments(name, args)
    if (invalid) return toolResult({ code: 'invalid_arguments', message: invalid }, true)
    try {
      const readyClient = await getClient()
      if (name === 'room_presence') {
        return toolResult(await readyClient.presence({ includeOffline: args.include_offline ?? false, signal }))
      }
      if (name === 'room_direct_open') {
        const opened = await readyClient.directOpen({
          chatId: args.chat_id,
          ...(args.target_fingerprint === undefined ? {} : { targetFingerprint: args.target_fingerprint }),
          signal,
        })
        notifier?.kick()
        return toolResult(opened)
      }
      if (name === 'message_send') {
        return toolResult(await readyClient.sendMessage({
          roomId: args.room_id,
          clientMessageId: args.client_message_id,
          text: args.text,
          ...(args.reply_to_seq === undefined ? {} : { replyToSeq: args.reply_to_seq }),
          signal,
        }))
      }
      if (name === 'message_read') {
        // Cursor discipline: an omitted after_seq resumes from the persisted
        // cursor (0 on first read); the durable cursor is advanced to
        // max(existing, next_after_seq) — monotonic, serialized per realm —
        // and a failed write is reported on the result instead of discarding
        // the consumed page.
        const realm = await realmIdOf()
        const stored = loadCursors(pluginData, realm)[args.room_id]?.after_seq
        const afterSeq = args.after_seq !== undefined
          ? args.after_seq
          : (typeof stored === 'number' && Number.isSafeInteger(stored) && stored >= 0 ? stored : 0)
        const result = await readyClient.readMessage({
          roomId: args.room_id,
          afterSeq,
          limit: args.limit ?? READ_PAGE_DEFAULT,
          waitMs: args.wait_ms ?? 0,
          signal,
        })
        // Trust discipline (Story 3.2): every row is evaluated by the
        // client-side trust matrix against this realm's allowlist before the
        // tool result exists. Delivered rows pass through (the untrusted
        // envelope already applied client-side for foreign senders); held
        // rows keep their metadata but their text becomes the held marker —
        // the body never reaches the tool result — with the matrix reason
        // recorded.
        const page = applyTrustMatrix(
          {
            messages: result.messages,
            next_after_seq: result.next_after_seq,
            head_seq: result.head_seq,
          },
          {
            ownFingerprint: readyClient.fingerprint,
            transport: readyClient.transport,
            allowlist: loadAllowlist(pluginData, realm),
          },
        )
        // Held discipline (Story 3.3): collect this page's held rows for the
        // held pipeline. The matrix output is index-aligned with the raw read
        // result, so a held row's RAW text is exactly the body artifact the
        // tool result withheld — the only form the pipeline caches and the
        // recovery point read re-serves.
        const heldRows = []
        for (let index = 0; index < page.messages.length; index += 1) {
          const row = page.messages[index]
          if (row && typeof row === 'object' && row.held === true) {
            const raw = result.messages[index]
            if (raw && typeof raw === 'object' && typeof raw.text === 'string') {
              heldRows.push({ ...raw, held_reason: row.held_reason })
            }
          }
        }
        // Cursor discipline (FR-20): the cursor advances FIRST and
        // independently of ingestion — a held message's seq is consumed like
        // any other (held-ness only changes what the agent SEES). Held
        // registration happens after persistence, into separate state keyed
        // (realm, room, seq), so a held message never stalls the cursor, a
        // registration failure can never block the consumed page, and a
        // cursor failure can never lose the held record.
        let cursorPersisted = true
        const notes = []
        try {
          await queueCursorPersist(pluginData, realm, args.room_id, result.next_after_seq)
        } catch (error) {
          cursorPersisted = false
          notes.push(`cursor not persisted: ${error?.code ?? 'write_failed'}`)
        }
        if (heldRows.length > 0) {
          try {
            await registerHeldMessages(pluginData, realm, args.room_id, heldRows)
          } catch (error) {
            notes.push(`held registration failed: ${error?.code ?? 'write_failed'}`)
          }
        }
        const resultPage = notes.length === 0
          ? page
          : { ...page, note: notes.join('; ') }
        if (!cursorPersisted) resultPage.cursor_persisted = false
        return toolResult(resultPage)
      }
      if (name === 'room_status') {
        const status = await readyClient.status({ signal })
        return toolResult({
          realm_id: status.realm_id,
          broadcast_room_id: status.broadcast_room_id,
          version: status.version,
          chat_id: readyClient.chatId,
          fingerprint: readyClient.fingerprint,
        })
      }
      if (name === 'room_trust_list') {
        // Plugin-local state only: the realm keys the allowlist file, and the
        // result is read straight from this installation's own PLUGIN_DATA.
        const realm = await realmIdOf()
        const state = loadAllowlist(pluginData, realm)
        return toolResult({
          realm_id: realm,
          accept_all: state.accept_all,
          entries: state.entries,
        })
      }
      if (name === 'room_trust_set') {
        // Add or remove one fingerprint entry on this realm's allowlist.
        // Accept-all is deliberately unreachable from here: the schema closes
        // without it, and the storage API that flips it belongs to the human
        // CLI (Story 3.4). Removal affects future delivery only — already-
        // ingested text is never retroactively withdrawn.
        const realm = await realmIdOf()
        const state = setAllowlistEntry(pluginData, realm, args.target_fingerprint, args.allowed)
        const entry = state.entries.find(item => item.fingerprint === args.target_fingerprint) ?? null
        return toolResult({
          realm_id: realm,
          target_fingerprint: args.target_fingerprint,
          allowed: args.allowed,
          entry,
        })
      }
      if (name === 'room_held_list') {
        // Plugin-local state only, and METADATA ONLY: heldList projects every
        // row through a fixed whitelist (realm, sender chat id, fingerprint,
        // room, seq, time, size, reason), so no body byte can reach this
        // result — the pipeline's body-recovery and release functions are
        // human-surface code this adapter never imports. held_count is the
        // realm-wide total, independent of the room filter.
        const realm = await realmIdOf()
        const messages = heldList(pluginData, realm, args.room_id === undefined ? {} : { roomId: args.room_id })
        return toolResult({
          realm_id: realm,
          held_count: heldCount(pluginData, realm),
          messages,
        })
      }
      if (name === 'room_held_count') {
        const realm = await realmIdOf()
        return toolResult({
          realm_id: realm,
          held_count: heldCount(pluginData, realm),
        })
      }
      return toolResult({ code: 'tool_not_found', message: 'tool was not found' }, true)
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'tool_failed'
      return toolResult({
        code,
        message: error?.message || 'agent-room tool failed',
        ...(error?.candidates === undefined ? {} : { candidates: error.candidates }),
      }, true)
    }
  }

  const handle = async message => {
    if (!plainObject(message) || message.jsonrpc !== JSONRPC_VERSION || typeof message.method !== 'string') {
      if (message?.id !== undefined) write(rpcError(message.id, -32600, 'invalid request'))
      return
    }
    const hasId = Object.hasOwn(message, 'id')
    const id = message.id
    if (!hasId) {
      if (message.method === 'notifications/cancelled') {
        // An MCP host may cancel any in-flight call: the tool's HTTP round
        // trip is aborted through its signal and the tool result answers
        // right away with a cancelled-call failure.
        const requestId = message.params?.requestId
        pending.get(String(requestId))?.abort()
      }
      return
    }
    if (message.method === 'initialize') {
      const requested = message.params?.protocolVersion
      negotiatedProtocol = SUPPORTED_PROTOCOLS.includes(requested) ? requested : DEFAULT_PROTOCOL
      write(rpcResult(id, {
        protocolVersion: negotiatedProtocol,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'agent-room', version: APP_VERSION },
      }))
      return
    }
    if (message.method === 'ping') {
      write(rpcResult(id, {}))
      return
    }
    if (message.method === 'tools/list') {
      write(rpcResult(id, { tools: TOOL_DESCRIPTORS }))
      return
    }
    if (message.method === 'tools/call') {
      if (!plainObject(message.params) || typeof message.params.name !== 'string') {
        write(rpcError(id, -32602, 'tools/call params are invalid'))
        return
      }
      if (!TOOL_NAMES.has(message.params.name)) {
        write(rpcError(id, -32602, 'unknown tool'))
        return
      }
      const controller = new AbortController()
      pending.set(String(id), controller)
      try {
        const result = await callTool(message.params.name, message.params.arguments ?? {}, controller.signal)
        if (result.isError !== true) startNotifierOnce()
        write(rpcResult(id, result))
      } finally {
        pending.delete(String(id))
      }
      return
    }
    write(rpcError(id, -32601, 'method not found'))
  }

  // stdin carries JSON-RPC only: one line-delimited frame per message, read
  // straight off the stream. The adapter never asks the human anything (the
  // setup command owns that) and never writes a single byte to stdin.
  let buffer = ''
  input.setEncoding('utf8')
  const onStdinData = chunk => {
    buffer += chunk
    for (;;) {
      const newline = buffer.indexOf('\n')
      if (newline === -1) break
      const line = buffer.slice(0, newline)
      buffer = buffer.slice(newline + 1)
      if (line.length === 0) continue
      if (Buffer.byteLength(line) > FRAME_MAX_BYTES) {
        write(rpcError(null, -32600, 'request is too large'))
        continue
      }
      let message
      try {
        message = JSON.parse(line)
      } catch {
        write(rpcError(null, -32700, 'parse error'))
        continue
      }
      Promise.resolve(handle(message)).catch(() => write(rpcError(message?.id, -32603, 'internal error')))
    }
  }
  input.on('data', onStdinData)
  const onStdinError = error => errorOutput.write(`agent-room MCP input failed: ${error.message}\n`)
  input.on('error', onStdinError)
  input.once('close', () => {
    // The JSON-RPC channel is gone: the shared shutdown aborts every
    // in-flight call, hands the Chat ID back so a clean exit does not squat
    // the name (Story 6.4), and records the release outcome (Story 7.3).
    // A budget overrun forces the exit — a held socket must not outlive
    // the declared deadline.
    void shutdown().then(outcome => {
      if (outcome === 'timeout') process.exit()
    })
  })

  return {
    close() {
      input.removeListener('data', onStdinData)
      input.removeListener('error', onStdinError)
      // Awaitable since Story 7.3: joins the shared shutdown operation, so a
      // programmatic host can wait for the release to settle.
      return shutdown()
    },
    get protocolVersion() { return negotiatedProtocol },
    tools: TOOL_DESCRIPTORS,
  }
}

function launchedDirectly() {
  if (!process.argv[1]) return false
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}

if (launchedDirectly()) {
  try {
    createMcpServer()
  } catch (error) {
    process.stderr.write(`agent-room MCP failed: ${error.message}\n`)
    process.exitCode = 1
  }
}

export { TOOL_DESCRIPTORS }
