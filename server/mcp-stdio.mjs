#!/usr/bin/env node

// The MCP stdio adapter (Story 1.7): five tools over the HTTP api-client —
// room_presence, room_direct_open, message_send, message_read, room_status.
// The v0.1 unix-socket daemon surface (with its create/join verbs, retired
// per AD-14) is gone; nothing here spawns or speaks to it.
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
  CLIENT_MESSAGE_ID_MAX,
  FRAME_MAX_BYTES,
  IDENTIFIER_MAX,
  MESSAGE_TEXT_MAX,
  READ_HOLD_MAX_MS,
  READ_PAGE_DEFAULT,
  READ_PAGE_MAX,
} from './constants.mjs'
import {
  APP_VERSION,
  assertSupportedRuntime,
  atomicWriteJson,
  instanceDataDirectory,
  readJsonFile,
  sharedDataDirectory,
} from './runtime.mjs'
import { createAgentRoomClient } from './client/api-client.mjs'

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

const FINGERPRINT_SCHEMA_PATTERN = '^sha256:[0-9a-f]{64}$'

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
        chat_id: { type: 'string', minLength: 1, maxLength: CHAT_ID_MAX, description: 'The Chat ID of the agent to open a pair room with.' },
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
        after_seq: { type: 'integer', minimum: 0, default: 0, description: 'Resume strictly after this sequence; omitted means the stored cursor.' },
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
    if (args.target_fingerprint !== undefined) {
      if (typeof args.target_fingerprint !== 'string') return 'target_fingerprint must be a string'
      if (!/^sha256:[0-9a-f]{64}$/.test(args.target_fingerprint)) return 'target_fingerprint must be sha256: followed by 64 lowercase hex characters'
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
  return null
}

// --- Client-owned cursors -----------------------------------------------------

// Cursor state lives per (installation, realm, room) under
// PLUGIN_DATA/realms/<realm_id>/cursors.json — one bounded, atomically
// rewritten 0600 file per realm. A missing or unusable file means "no cursor
// yet"; a corrupt file never blocks a read (it falls back to the beginning
// and is overwritten on the next advance).
function cursorFilePath(pluginData, realmId) {
  return join(pluginData, 'realms', realmId, 'cursors.json')
}

function loadCursors(pluginData, realmId) {
  const path = cursorFilePath(pluginData, realmId)
  if (!existsSync(path)) return {}
  try {
    const value = readJsonFile(path)
    return plainObject(value) && plainObject(value.cursors) ? value.cursors : {}
  } catch {
    return {}
  }
}

function persistCursor(pluginData, realmId, roomId, afterSeq) {
  const cursors = loadCursors(pluginData, realmId)
  cursors[roomId] = { after_seq: afterSeq, updated_at: new Date().toISOString() }
  atomicWriteJson(cursorFilePath(pluginData, realmId), { version: 1, cursors })
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

  // The api-client (and through it the local server) boots lazily on the
  // first tool call. Construction itself only reads local state (the setup
  // config, the keypair), so a synchronous failure — the first-run guidance
  // for a missing Chat ID — surfaces per call and never poisons the client.
  let clientPromise = null
  let realmId = null
  function getClient() {
    clientPromise ??= createAgentRoomClient({ dataDir, pluginDataDir: pluginData })
    return clientPromise
  }

  const realmIdOf = async () => {
    if (realmId !== null) return realmId
    const readyClient = await getClient()
    const status = await readyClient.status()
    realmId = status.realm_id
    return realmId
  }

  const callTool = async (name, args) => {
    const invalid = validateArguments(name, args)
    if (invalid) return toolResult({ code: 'invalid_arguments', message: invalid }, true)
    try {
      const readyClient = await getClient()
      if (name === 'room_presence') {
        return toolResult(await readyClient.presence({ includeOffline: args.include_offline ?? false }))
      }
      if (name === 'room_direct_open') {
        return toolResult(await readyClient.directOpen({
          chatId: args.chat_id,
          ...(args.target_fingerprint === undefined ? {} : { targetFingerprint: args.target_fingerprint }),
        }))
      }
      if (name === 'message_send') {
        return toolResult(await readyClient.sendMessage({
          roomId: args.room_id,
          clientMessageId: args.client_message_id,
          text: args.text,
          ...(args.reply_to_seq === undefined ? {} : { replyToSeq: args.reply_to_seq }),
        }))
      }
      if (name === 'message_read') {
        // Cursor discipline: an omitted after_seq resumes from the persisted
        // cursor (0 on first read); every successful read advances it to the
        // response's next_after_seq, durably, before the result is returned.
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
        })
        persistCursor(pluginData, realm, args.room_id, result.next_after_seq)
        return toolResult({
          messages: result.messages,
          next_after_seq: result.next_after_seq,
          head_seq: result.head_seq,
        })
      }
      if (name === 'room_status') {
        const status = await readyClient.status()
        return toolResult({
          realm_id: status.realm_id,
          broadcast_room_id: status.broadcast_room_id,
          version: status.version,
          chat_id: readyClient.chatId,
          fingerprint: readyClient.fingerprint,
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
      // Notifications need no response; cancellation is advisory here (each
      // tool call is one bounded HTTP round trip on the api-client).
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
      write(rpcResult(id, await callTool(message.params.name, message.params.arguments ?? {})))
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
    // Nothing in-flight to unwind: tool calls are bounded HTTP round trips.
  })

  return {
    close() {
      input.removeListener('data', onStdinData)
      input.removeListener('error', onStdinError)
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
