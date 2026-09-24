#!/usr/bin/env node

import {
  chmodSync,
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
  unlinkSync,
} from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { createConnection, createServer as createSocketServer } from 'node:net'
import { timingSafeEqual } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  APP_VERSION,
  DAEMON_PROTOCOL_VERSION,
  assertSupportedRuntime,
  atomicWriteJson,
  daemonSocketPath,
  ensurePrivateDirectory,
  loadOrCreateViewerToken,
  runtimeRecordPath,
} from './runtime.mjs'
import {
  FRAME_MAX_BYTES,
  PUBLIC_ERRORS,
  READ_HOLD_MAX_MS,
  READ_PAGE_MAX,
  SSE_BACKLOG_MAX_BYTES,
  SSE_BACKLOG_MAX_MESSAGES,
  WEB_ASSET_MAX_BYTES,
} from './constants.mjs'

// Run the runtime gate before any other work. Direct launches report one
// diagnosable line and exit 1 with no stack trace; importers get a catchable
// rejection so harnesses can assert on the failure.
try {
  assertSupportedRuntime()
} catch (error) {
  if (launchedDirectly()) {
    process.stderr.write(`agent-roomd: ${error?.code ?? 'startup_failed'}: ${error?.message}\n`)
    process.exit(1)
  }
  throw error
}

const HERE = dirname(fileURLToPath(import.meta.url))
const DEFAULT_WEB_ROOT = resolve(HERE, '..', 'web')

function publicFailure(error) {
  const code = typeof error?.code === 'string' && /^[a-z0-9_]{1,64}$/.test(error.code)
    ? error.code
    : 'request_failed'
  return {
    code,
    message: PUBLIC_ERRORS[code] || 'agent-room request failed',
  }
}

const writeJson = (response, status, value) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' })
  response.end(`${JSON.stringify(value)}\n`)
}

function setSecurityHeaders(response) {
  response.setHeader('Cache-Control', 'no-store')
  response.setHeader('Content-Security-Policy', "default-src 'self'; connect-src 'self'; script-src 'self'; style-src 'self'; img-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'")
  response.setHeader('Referrer-Policy', 'no-referrer')
  response.setHeader('X-Content-Type-Options', 'nosniff')
  response.setHeader('X-Frame-Options', 'DENY')
}

function constantTimeTokenEqual(left, right) {
  const a = Buffer.from(String(left ?? ''))
  const b = Buffer.from(String(right ?? ''))
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b)
}

function parseNonNegative(value, fallback = 0) {
  if (value === null || value === undefined || value === '') return fallback
  const number = Number(value)
  return Number.isSafeInteger(number) && number >= 0 ? number : null
}

function isLoopbackHost(host, port) {
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`
}

function inspectSocket(socketPath) {
  return new Promise(resolvePromise => {
    const socket = createConnection(socketPath)
    let settled = false
    const finish = state => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolvePromise(state)
    }
    const timer = setTimeout(() => finish('indeterminate'), 250)
    socket.once('connect', () => finish('live'))
    socket.once('error', error => {
      if (error?.code === 'ECONNREFUSED') finish('stale')
      else if (error?.code === 'ENOENT') finish('missing')
      else finish('indeterminate')
    })
  })
}

function listen(server, ...args) {
  return new Promise((resolvePromise, reject) => {
    const onError = error => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = () => {
      server.off('error', onError)
      resolvePromise()
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(...args)
  })
}

function closeServer(server) {
  return new Promise(resolvePromise => {
    if (!server.listening) return resolvePromise()
    server.close(() => resolvePromise())
  })
}

export async function startRoomDaemon({
  dataDir,
  socketPath = daemonSocketPath(dataDir),
  webRoot = DEFAULT_WEB_ROOT,
  httpPort = 0,
} = {}) {
  const runtime = assertSupportedRuntime()
  const directory = ensurePrivateDirectory(dataDir)
  const token = loadOrCreateViewerToken(directory)

  if (process.platform !== 'win32' && existsSync(socketPath)) {
    const firstState = await inspectSocket(socketPath)
    if (firstState === 'live') {
      throw Object.assign(new Error('agent-room daemon is already running'), { code: 'daemon_already_running' })
    }
    if (firstState === 'indeterminate') {
      throw Object.assign(new Error('agent-room daemon socket state is indeterminate'), { code: 'daemon_socket_indeterminate' })
    }
    if (firstState === 'missing') {
      // The socket disappeared after existsSync; another starter owns the decision now.
    } else {
      const info = lstatSync(socketPath)
      if (!info.isSocket() || info.isSymbolicLink()) {
        throw Object.assign(new Error('agent-room socket path is not a stale socket'), { code: 'daemon_socket_invalid' })
      }
      await new Promise(resolveDelay => setTimeout(resolveDelay, 100))
      const confirmedState = await inspectSocket(socketPath)
      if (confirmedState === 'live') {
        throw Object.assign(new Error('agent-room daemon is already running'), { code: 'daemon_already_running' })
      }
      if (confirmedState === 'missing') {
        // Another starter already removed the stale path.
      } else if (confirmedState !== 'stale') {
        throw Object.assign(new Error('agent-room daemon socket state is indeterminate'), { code: 'daemon_socket_indeterminate' })
      } else {
        const current = lstatSync(socketPath)
        if (!current.isSocket() || current.isSymbolicLink() || current.dev !== info.dev || current.ino !== info.ino) {
          throw Object.assign(new Error('agent-room daemon socket changed during stale check'), { code: 'daemon_socket_indeterminate' })
        }
        unlinkSync(socketPath)
      }
    }
  }

  const { openRoomDatabase } = await import('./database.mjs')
  const database = openRoomDatabase({ dataDir: directory })
  const subscribers = new Map()
  const roomWaiters = new Map()
  const controlSockets = new Set()
  let closePromise = null
  let httpOrigin = null

  const notifyRoom = roomId => {
    const waiters = roomWaiters.get(roomId)
    if (!waiters) return
    roomWaiters.delete(roomId)
    for (const resolveWaiter of waiters) resolveWaiter()
  }

  const broadcast = message => {
    const clients = subscribers.get(message.room_id)
    if (!clients) return
    const frame = `id: ${message.seq}\nevent: message\ndata: ${JSON.stringify(message)}\n\n`
    for (const client of clients) {
      if (message.seq <= client.lastSeq) continue
      client.lastSeq = message.seq
      if (client.response.writableEnded || client.response.destroyed || !client.response.write(frame)) {
        client.cleanup({ end: true })
      }
    }
    if (clients.size === 0) subscribers.delete(message.room_id)
  }

  const waitForRoom = (roomId, waitMs, signal) => new Promise(resolvePromise => {
    let settled = false
    let timeout
    const waiters = roomWaiters.get(roomId) || new Set()
    const done = () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      signal?.removeEventListener('abort', done)
      waiters.delete(done)
      if (waiters.size === 0) roomWaiters.delete(roomId)
      resolvePromise()
    }
    if (signal?.aborted) return done()
    waiters.add(done)
    roomWaiters.set(roomId, waiters)
    signal?.addEventListener('abort', done, { once: true })
    timeout = setTimeout(done, waitMs)
  })

  const boundedMessageResult = (messages, afterSeq, moreInDatabase = false) => {
    const selected = []
    let nextSeq = afterSeq
    for (const message of messages) {
      const candidate = { messages: [...selected, message], next_seq: message.seq, has_more: false }
      const envelope = { id: '00000000-0000-0000-0000-000000000000', result: candidate }
      if (Buffer.byteLength(JSON.stringify(envelope)) + 1 > FRAME_MAX_BYTES) {
        if (selected.length === 0) {
          throw Object.assign(new Error('message cannot fit the daemon frame'), { code: 'message_frame_too_large' })
        }
        break
      }
      selected.push(message)
      nextSeq = message.seq
    }
    return {
      messages: selected,
      next_seq: nextSeq,
      has_more: selected.length < messages.length || moreInDatabase,
    }
  }

  const httpServer = createHttpServer((request, response) => {
    setSecurityHeaders(response)
    const address = httpServer.address()
    const port = typeof address === 'object' && address ? address.port : httpPort
    if (!isLoopbackHost(request.headers.host, port)) {
      writeJson(response, 403, { error: { code: 'host_forbidden', message: 'host is forbidden' } })
      return
    }
    const origin = request.headers.origin
    if (origin && origin !== `http://127.0.0.1:${port}` && origin !== `http://localhost:${port}`) {
      writeJson(response, 403, { error: { code: 'origin_forbidden', message: 'origin is forbidden' } })
      return
    }

    let url
    try {
      url = new URL(request.url || '/', `http://127.0.0.1:${port}`)
    } catch {
      writeJson(response, 400, { error: { code: 'invalid_request_target', message: 'request target is invalid' } })
      return
    }
    if (request.method !== 'GET') {
      response.setHeader('Allow', 'GET')
      writeJson(response, 405, { error: { code: 'method_not_allowed', message: 'viewer is read-only' } })
      return
    }
    if (url.pathname === '/health') {
      writeJson(response, 200, { ok: true, version: APP_VERSION, protocolVersion: DAEMON_PROTOCOL_VERSION })
      return
    }

    const authorization = /^Bearer\s+(.+)$/i.exec(request.headers.authorization || '')?.[1]
    const presentedToken = url.searchParams.get('token') || authorization
    const staticAsset = url.pathname === '/' || url.pathname === '/app.js' || url.pathname === '/styles.css'
    if (!staticAsset && !constantTimeTokenEqual(presentedToken, token)) {
      writeJson(response, 401, { error: { code: 'viewer_unauthorized', message: 'viewer token is required' } })
      return
    }

    if (url.pathname === '/' || staticAsset) {
      const name = url.pathname === '/' ? 'index.html' : url.pathname.slice(1)
      const contentType = name.endsWith('.js')
        ? 'text/javascript; charset=utf-8'
        : name.endsWith('.css')
          ? 'text/css; charset=utf-8'
          : 'text/html; charset=utf-8'
      try {
        const path = join(webRoot, name)
        const info = lstatSync(path)
        if (info.isSymbolicLink() || !info.isFile() || info.size > WEB_ASSET_MAX_BYTES) throw new Error('invalid asset')
        response.writeHead(200, { 'Content-Type': contentType })
        response.end(readFileSync(path))
      } catch {
        writeJson(response, 404, { error: { code: 'asset_not_found', message: 'viewer asset was not found' } })
      }
      return
    }

    try {
      if (url.pathname === '/api/rooms') {
        writeJson(response, 200, { rooms: database.listRooms() })
        return
      }
      const messagesMatch = /^\/api\/rooms\/([^/]+)\/messages$/.exec(url.pathname)
      if (messagesMatch) {
        const afterSeq = parseNonNegative(url.searchParams.get('after'), 0)
        const requestedLimit = parseNonNegative(url.searchParams.get('limit'), 100)
        if (afterSeq === null || requestedLimit === null) throw Object.assign(new Error(), { code: 'invalid_cursor' })
        const messages = database.readRoomMessages({
          roomId: decodeURIComponent(messagesMatch[1]),
          afterSeq,
          limit: Math.min(requestedLimit, READ_PAGE_MAX),
        })
        writeJson(response, 200, { messages, next_seq: messages.at(-1)?.seq ?? afterSeq })
        return
      }
      const eventsMatch = /^\/api\/rooms\/([^/]+)\/events$/.exec(url.pathname)
      if (eventsMatch) {
        const roomId = decodeURIComponent(eventsMatch[1])
        const queryAfter = parseNonNegative(url.searchParams.get('after'), 0)
        const headerAfter = parseNonNegative(request.headers['last-event-id'], 0)
        if (queryAfter === null || headerAfter === null) throw Object.assign(new Error(), { code: 'invalid_cursor' })
        const afterSeq = Math.max(queryAfter, headerAfter)
        const backlog = database.readRoomMessages({
          roomId,
          afterSeq,
          limit: SSE_BACKLOG_MAX_MESSAGES,
        })
        const lastBacklogSeq = backlog.at(-1)?.seq ?? afterSeq
        const hasMore = backlog.length === SSE_BACKLOG_MAX_MESSAGES
          && database.readRoomMessages({ roomId, afterSeq: lastBacklogSeq, limit: 1 }).length > 0
        const backlogBytes = backlog.reduce(
          (total, message) => total + Buffer.byteLength(JSON.stringify(message)) + 64,
          0,
        )
        response.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          Connection: 'keep-alive',
          'Cache-Control': 'no-store',
        })
        response.write('retry: 1000\n\n')
        if (hasMore || backlogBytes > SSE_BACKLOG_MAX_BYTES) {
          response.end(`event: catchup_required\ndata: ${JSON.stringify({ after: afterSeq })}\n\n`)
          return
        }
        const client = {
          response,
          lastSeq: afterSeq,
          heartbeat: null,
          closed: false,
          cleanup: null,
        }
        const clients = subscribers.get(roomId) || new Set()
        client.cleanup = ({ end = false, destroy = false } = {}) => {
          if (client.closed) return
          client.closed = true
          if (client.heartbeat) clearInterval(client.heartbeat)
          clients.delete(client)
          if (clients.size === 0) subscribers.delete(roomId)
          if (destroy) response.destroy()
          else if (end && !response.writableEnded) response.end()
        }
        clients.add(client)
        subscribers.set(roomId, clients)
        client.heartbeat = setInterval(() => {
          if (response.writableEnded || response.destroyed || !response.write(': keepalive\n\n')) {
            client.cleanup({ end: true })
          }
        }, 15_000)
        response.once('error', () => client.cleanup({ destroy: true }))
        request.once('close', () => client.cleanup())
        for (const message of backlog) {
          client.lastSeq = message.seq
          if (response.writableEnded || response.destroyed
            || !response.write(`id: ${message.seq}\nevent: message\ndata: ${JSON.stringify(message)}\n\n`)) {
            client.cleanup({ end: true })
            break
          }
        }
        return
      }
      writeJson(response, 404, { error: { code: 'not_found', message: 'viewer route was not found' } })
    } catch (error) {
      writeJson(response, 400, { error: publicFailure(error) })
    }
  })

  try {
    await listen(httpServer, httpPort, '127.0.0.1')
  } catch (error) {
    database.close()
    throw error
  }
  const httpAddress = httpServer.address()
  const boundPort = typeof httpAddress === 'object' && httpAddress ? httpAddress.port : httpPort
  httpOrigin = `http://127.0.0.1:${boundPort}`

  const dispatch = async (method, params = {}, { signal } = {}) => {
    const actor = params.actor
    if (method === 'status') {
      return {
        ok: true,
        version: APP_VERSION,
        protocolVersion: DAEMON_PROTOCOL_VERSION,
        pid: process.pid,
        sqliteVersion: database.sqliteVersion || runtime.sqliteVersion,
        journalMode: database.journalMode || 'wal',
        pendingWaiters: [...roomWaiters.values()].reduce((total, waiters) => total + waiters.size, 0),
        viewerUrl: `${httpOrigin}/?token=${encodeURIComponent(token)}`,
      }
    }
    if (method === 'room.create') {
      return database.createRoom({ actorId: actor?.id, displayName: actor?.displayName, title: params.title })
    }
    if (method === 'room.join') {
      return database.joinRoom({ roomId: params.roomId, actorId: actor?.id, displayName: params.displayName || actor?.displayName })
    }
    if (method === 'message.send') {
      const result = database.sendMessage({
        roomId: params.roomId,
        actorId: actor?.id,
        clientMessageId: params.clientMessageId,
        text: params.text,
        replyToSeq: params.replyToSeq,
      })
      const message = result.message || result
      if (!result.duplicate) {
        broadcast(message)
        notifyRoom(params.roomId)
      }
      return result
    }
    if (method === 'message.read') {
      const afterSeq = params.afterSeq ?? 0
      const limit = params.limit ?? 50
      let messages = database.readMessages({ roomId: params.roomId, actorId: actor?.id, afterSeq, limit })
      const waitMs = Math.min(Math.max(Number(params.waitMs) || 0, 0), READ_HOLD_MAX_MS)
      if (messages.length === 0 && waitMs > 0) {
        await waitForRoom(params.roomId, waitMs, signal)
        if (signal?.aborted) throw Object.assign(new Error('request was cancelled'), { code: 'request_cancelled' })
        messages = database.readMessages({ roomId: params.roomId, actorId: actor?.id, afterSeq, limit })
      }
      const moreInDatabase = messages.length === limit
        && database.readMessages({
          roomId: params.roomId,
          actorId: actor?.id,
          afterSeq: messages.at(-1).seq,
          limit: 1,
        }).length > 0
      return boundedMessageResult(messages, afterSeq, moreInDatabase)
    }
    throw Object.assign(new Error('unknown method'), { code: 'method_not_found' })
  }

  const socketServer = createSocketServer(socket => {
    controlSockets.add(socket)
    const controller = new AbortController()
    socket.setTimeout(30_000, () => socket.destroy())
    socket.setEncoding('utf8')
    let buffer = ''
    let answered = false
    let processing = false
    const answer = value => {
      if (answered) return
      answered = true
      socket.end(`${JSON.stringify(value)}\n`)
    }
    socket.on('data', chunk => {
      if (answered || processing) return
      buffer += chunk
      if (Buffer.byteLength(buffer) > FRAME_MAX_BYTES) {
        answer({ id: null, error: { code: 'request_too_large', message: 'request is too large' } })
        return
      }
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      processing = true
      let request
      try {
        request = JSON.parse(buffer.slice(0, newline))
      } catch {
        answer({ id: null, error: { code: 'invalid_json', message: 'request is not valid JSON' } })
        return
      }
      if (!request || typeof request !== 'object' || typeof request.id !== 'string' || typeof request.method !== 'string') {
        answer({ id: request?.id ?? null, error: { code: 'invalid_request', message: 'request shape is invalid' } })
        return
      }
      Promise.resolve(dispatch(request.method, request.params, { signal: controller.signal }))
        .then(result => answer({ id: request.id, result }))
        .catch(error => answer({ id: request.id, error: publicFailure(error) }))
    })
    socket.once('error', () => socket.destroy())
    socket.once('close', () => {
      controller.abort()
      controlSockets.delete(socket)
    })
  })

  let status
  try {
    await listen(socketServer, socketPath)
    if (process.platform !== 'win32') chmodSync(socketPath, 0o600)
    status = await dispatch('status')
    atomicWriteJson(runtimeRecordPath(directory), {
      pid: process.pid,
      version: APP_VERSION,
      protocolVersion: DAEMON_PROTOCOL_VERSION,
      socketPath,
      httpOrigin,
      startedAt: new Date().toISOString(),
    })
  } catch (error) {
    for (const socket of controlSockets) socket.destroy()
    const socketClose = closeServer(socketServer)
    const httpClose = closeServer(httpServer)
    httpServer.closeAllConnections?.()
    await Promise.all([socketClose, httpClose])
    database.close()
    throw error
  }

  const close = () => {
    if (closePromise) return closePromise
    closePromise = (async () => {
      for (const clients of subscribers.values()) {
        for (const client of [...clients]) client.cleanup({ end: true })
      }
      subscribers.clear()
      for (const waiters of roomWaiters.values()) for (const done of waiters) done()
      roomWaiters.clear()
      for (const socket of controlSockets) socket.destroy()
      controlSockets.clear()
      const socketClose = closeServer(socketServer)
      const httpClose = closeServer(httpServer)
      httpServer.closeAllConnections?.()
      await Promise.all([socketClose, httpClose])
      database.close()
      try {
        const record = JSON.parse(readFileSync(runtimeRecordPath(directory), 'utf8'))
        if (record.pid === process.pid) unlinkSync(runtimeRecordPath(directory))
      } catch { /* no owned runtime record */ }
    })()
    return closePromise
  }

  return { close, database, httpOrigin, socketPath, status }
}

function parseDataDir(argv) {
  const index = argv.indexOf('--data-dir')
  if (index === -1 || !argv[index + 1]) return null
  return resolve(argv[index + 1])
}

function launchedDirectly() {
  if (!process.argv[1]) return false
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}

if (launchedDirectly()) {
  const dataDir = parseDataDir(process.argv.slice(2))
  if (!dataDir) {
    process.stderr.write('agent-roomd: --data-dir <absolute-path> is required\n')
    process.exitCode = 2
  } else {
    startRoomDaemon({ dataDir }).then(roomd => {
      const stop = () => roomd.close().finally(() => process.exit(0))
      process.once('SIGINT', stop)
      process.once('SIGTERM', stop)
    }).catch(error => {
      process.stderr.write(`agent-roomd: ${publicFailure(error).message}\n`)
      process.exitCode = 1
    })
  }
}
