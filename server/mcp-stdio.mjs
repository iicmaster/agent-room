#!/usr/bin/env node

import { createInterface } from 'node:readline'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import { ensureDaemon, requestDaemon } from './daemon-client.mjs'
import {
  APP_VERSION,
  MAX_FRAME_BYTES,
  assertSupportedRuntime,
  daemonSocketPath,
  instanceDataDirectory,
  loadOrCreateIdentity,
  sanitizeDisplayName,
  sharedDataDirectory,
} from './runtime.mjs'

const JSONRPC_VERSION = '2.0'
const SUPPORTED_PROTOCOLS = Object.freeze(['2025-06-18'])
const DEFAULT_PROTOCOL = '2025-06-18'
const MAX_TOOL_TEXT = 32 * 1024

const TOOL_DESCRIPTORS = Object.freeze([
  {
    name: 'room_create',
    description: 'Create a local agent chat room and join it as this plugin installation identity.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['title'],
      properties: {
        title: { type: 'string', minLength: 1, maxLength: 120 },
      },
    },
  },
  {
    name: 'room_join',
    description: 'Join an existing room as this plugin installation identity. actor_id is never accepted from tool input.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['room_id'],
      properties: {
        room_id: { type: 'string', minLength: 1, maxLength: 128 },
        display_name: { type: 'string', minLength: 1, maxLength: 80 },
      },
    },
  },
  {
    name: 'message_send',
    description: 'Send one plain-text message. Reuse client_message_id when retrying so a lost reply cannot duplicate the message.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['room_id', 'client_message_id', 'text'],
      properties: {
        room_id: { type: 'string', minLength: 1, maxLength: 128 },
        client_message_id: { type: 'string', minLength: 1, maxLength: 128 },
        text: { type: 'string', minLength: 1, maxLength: MAX_TOOL_TEXT },
        reply_to_seq: { type: 'integer', minimum: 1 },
      },
    },
  },
  {
    name: 'message_read',
    description: 'Read ordered messages after a durable sequence cursor, optionally waiting up to 20 seconds for a new message.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['room_id'],
      properties: {
        room_id: { type: 'string', minLength: 1, maxLength: 128 },
        after_seq: { type: 'integer', minimum: 0, default: 0 },
        limit: { type: 'integer', minimum: 1, maximum: 200, default: 50 },
        wait_ms: { type: 'integer', minimum: 0, maximum: 20000, default: 0 },
      },
    },
  },
  {
    name: 'room_status',
    description: 'Return the shared daemon status, this installation identity, and the authenticated read-only web viewer URL.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {},
    },
  },
])
const TOOL_NAMES = new Set(TOOL_DESCRIPTORS.map(tool => tool.name))

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

function validateArguments(name, args) {
  if (!plainObject(args)) return 'tool arguments must be an object'
  const allowed = {
    room_create: new Set(['title']),
    room_join: new Set(['room_id', 'display_name']),
    message_send: new Set(['room_id', 'client_message_id', 'text', 'reply_to_seq']),
    message_read: new Set(['room_id', 'after_seq', 'limit', 'wait_ms']),
    room_status: new Set(),
  }[name]
  if (!allowed) return 'unknown tool'
  if (Object.keys(args).some(key => !allowed.has(key))) return 'tool arguments contain an unknown field'
  if (name === 'room_create') {
    if (typeof args.title !== 'string') return 'title must be a string'
    if (args.title.trim().length < 1 || args.title.trim().length > 120) return 'title must contain 1 to 120 characters'
  }
  if (['room_join', 'message_send', 'message_read'].includes(name) && typeof args.room_id !== 'string') return 'room_id must be a string'
  if (name === 'room_join' && args.display_name !== undefined) {
    if (typeof args.display_name !== 'string') return 'display_name must be a string'
    if (args.display_name.trim().length < 1 || args.display_name.trim().length > 80) return 'display_name must contain 1 to 80 characters'
  }
  if (name === 'message_send') {
    if (typeof args.client_message_id !== 'string') return 'client_message_id must be a string'
    if (typeof args.text !== 'string') return 'text must be a string'
    if (args.client_message_id.length < 1 || args.client_message_id.length > 128) return 'client_message_id must contain 1 to 128 characters'
    if (args.text.trim().length < 1 || args.text.length > MAX_TOOL_TEXT) return `text must contain 1 to ${MAX_TOOL_TEXT} characters`
    if (args.reply_to_seq !== undefined && (!Number.isSafeInteger(args.reply_to_seq) || args.reply_to_seq < 1)) return 'reply_to_seq must be a positive integer'
  }
  if (name === 'message_read') {
    if (args.after_seq !== undefined && (!Number.isSafeInteger(args.after_seq) || args.after_seq < 0)) return 'after_seq must be a non-negative integer'
    if (args.limit !== undefined && (!Number.isSafeInteger(args.limit) || args.limit < 1 || args.limit > 200)) return 'limit must be between 1 and 200'
    if (args.wait_ms !== undefined && (!Number.isSafeInteger(args.wait_ms) || args.wait_ms < 0 || args.wait_ms > 20_000)) return 'wait_ms must be between 0 and 20000'
  }
  return null
}

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
  const identity = loadOrCreateIdentity(pluginData)
  const socketPath = daemonSocketPath(dataDir)
  const pending = new Map()
  let displayName = identity.displayName
  let negotiatedProtocol = DEFAULT_PROTOCOL

  const write = message => output.write(`${JSON.stringify(message)}\n`)

  const daemonCall = async (method, params, requestId, waitMs = 0) => {
    await ensureDaemon({ dataDir })
    const controller = new AbortController()
    pending.set(String(requestId), controller)
    try {
      return await requestDaemon({
        socketPath,
        method,
        params: {
          ...params,
          actor: { id: identity.id, displayName },
        },
        timeoutMs: Math.max(5_000, waitMs + 3_000),
        signal: controller.signal,
      })
    } finally {
      pending.delete(String(requestId))
    }
  }

  const callTool = async (name, args, id) => {
    const invalid = validateArguments(name, args)
    if (invalid) return toolResult({ code: 'invalid_arguments', message: invalid }, true)
    try {
      if (name === 'room_create') {
        return toolResult(await daemonCall('room.create', { title: args.title }, id))
      }
      if (name === 'room_join') {
        if (args.display_name) displayName = sanitizeDisplayName(args.display_name)
        return toolResult(await daemonCall('room.join', {
          roomId: args.room_id,
          displayName,
        }, id))
      }
      if (name === 'message_send') {
        return toolResult(await daemonCall('message.send', {
          roomId: args.room_id,
          clientMessageId: args.client_message_id,
          text: args.text,
          replyToSeq: args.reply_to_seq,
        }, id))
      }
      if (name === 'message_read') {
        const waitMs = args.wait_ms ?? 0
        return toolResult(await daemonCall('message.read', {
          roomId: args.room_id,
          afterSeq: args.after_seq ?? 0,
          limit: args.limit ?? 50,
          waitMs,
        }, id, waitMs))
      }
      if (name === 'room_status') {
        const status = await daemonCall('status', {}, id)
        return toolResult({ ...status, actor: { id: identity.id, display_name: displayName } })
      }
      return toolResult({ code: 'tool_not_found', message: 'tool was not found' }, true)
    } catch (error) {
      const code = typeof error?.code === 'string' ? error.code : 'tool_failed'
      return toolResult({ code, message: error?.message || 'agent-room tool failed' }, true)
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
        const requestId = message.params?.requestId
        pending.get(String(requestId))?.abort()
      }
      return
    }
    if (message.method === 'initialize') {
      const requested = message.params?.protocolVersion
      negotiatedProtocol = SUPPORTED_PROTOCOLS.includes(requested) ? requested : DEFAULT_PROTOCOL
      const clientName = message.params?.clientInfo?.name
      if (typeof clientName === 'string' && identity.displayName === 'agent') displayName = sanitizeDisplayName(clientName)
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
      write(rpcResult(id, await callTool(message.params.name, message.params.arguments ?? {}, id)))
      return
    }
    write(rpcError(id, -32601, 'method not found'))
  }

  const lines = createInterface({ input, crlfDelay: Infinity, terminal: false })
  lines.on('line', line => {
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES) {
      write(rpcError(null, -32600, 'request is too large'))
      return
    }
    let message
    try { message = JSON.parse(line) } catch {
      write(rpcError(null, -32700, 'parse error'))
      return
    }
    Promise.resolve(handle(message)).catch(() => write(rpcError(message?.id, -32603, 'internal error')))
  })
  lines.once('error', error => errorOutput.write(`agent-room MCP input failed: ${error.message}\n`))
  lines.once('close', () => {
    for (const controller of pending.values()) controller.abort()
    pending.clear()
  })

  return {
    close() {
      lines.close()
      for (const controller of pending.values()) controller.abort()
      pending.clear()
    },
    get protocolVersion() { return negotiatedProtocol },
    identity,
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
