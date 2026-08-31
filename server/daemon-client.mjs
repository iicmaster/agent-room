import { spawn } from 'node:child_process'
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  linkSync,
  openSync,
  readSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { createConnection } from 'node:net'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

import {
  APP_VERSION,
  DAEMON_PROTOCOL_VERSION,
  MAX_FRAME_BYTES,
  AgentRoomRuntimeError,
  daemonSocketPath,
  ensurePrivateDirectory,
  startupLockPath,
} from './runtime.mjs'

const STARTUP_WAIT_MS = 5_000
const STARTUP_LOCK_STALE_MS = 15_000
const MAX_STARTUP_LOCK_BYTES = 512

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

export class DaemonRequestError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'DaemonRequestError'
    this.code = code
  }
}

export function requestDaemon({
  socketPath,
  method,
  params = {},
  timeoutMs = 25_000,
  signal,
}) {
  return new Promise((resolve, reject) => {
    const id = randomUUID()
    let settled = false
    let buffer = ''
    const socket = createConnection(socketPath)
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      socket.destroy()
      if (error) reject(error)
      else resolve(value)
    }
    const onAbort = () => finish(new DaemonRequestError('request_cancelled', 'agent-room request was cancelled'))
    const timer = setTimeout(
      () => finish(new DaemonRequestError('daemon_timeout', 'agent-room daemon did not answer in time')),
      timeoutMs,
    )
    timer.unref?.()
    if (signal?.aborted) return onAbort()
    signal?.addEventListener('abort', onAbort, { once: true })

    socket.setEncoding('utf8')
    socket.once('connect', () => {
      socket.write(`${JSON.stringify({ id, method, params })}\n`)
    })
    socket.on('data', chunk => {
      buffer += chunk
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) {
        finish(new DaemonRequestError('daemon_frame_too_large', 'agent-room daemon returned an oversized frame'))
        return
      }
      const newline = buffer.indexOf('\n')
      if (newline === -1) return
      let response
      try {
        response = JSON.parse(buffer.slice(0, newline))
      } catch {
        finish(new DaemonRequestError('daemon_protocol_error', 'agent-room daemon returned invalid JSON'))
        return
      }
      if (response?.id !== id) {
        finish(new DaemonRequestError('daemon_protocol_error', 'agent-room daemon returned the wrong request id'))
      } else if (response.error) {
        finish(new DaemonRequestError(response.error.code || 'daemon_request_failed', response.error.message || 'agent-room request failed'))
      } else {
        finish(null, response.result)
      }
    })
    socket.once('error', error => {
      const code = ['ENOENT', 'ECONNREFUSED', 'EPIPE'].includes(error?.code)
        ? 'daemon_unavailable'
        : 'daemon_connection_failed'
      finish(new DaemonRequestError(code, 'agent-room daemon is unavailable'))
    })
    socket.once('end', () => {
      if (!settled) finish(new DaemonRequestError('daemon_protocol_error', 'agent-room daemon closed without a response'))
    })
  })
}

async function probe(socketPath) {
  try {
    const status = await requestDaemon({ socketPath, method: 'status', timeoutMs: 750 })
    if (status?.protocolVersion !== DAEMON_PROTOCOL_VERSION) {
      throw new DaemonRequestError(
        'daemon_protocol_mismatch',
        `agent-room daemon protocol ${status?.protocolVersion ?? 'unknown'} is incompatible`,
      )
    }
    if (status?.version !== APP_VERSION) {
      throw new DaemonRequestError(
        'daemon_version_mismatch',
        `agent-room daemon ${status?.version ?? 'unknown'} must be restarted for client ${APP_VERSION}`,
      )
    }
    return status
  } catch (error) {
    if (error?.code === 'daemon_protocol_mismatch' || error?.code === 'daemon_version_mismatch') throw error
    return null
  }
}

function acquireStartupLock(path) {
  const token = `${process.pid}:${randomUUID()}`
  if (claimStartupLock(path, token)) return token

  try {
    const observed = readStartupLock(path)
    if (Date.now() - statSync(path).mtimeMs <= STARTUP_LOCK_STALE_MS) return null
    if (readStartupLock(path) !== observed) return null
    unlinkSync(path)
  } catch (error) {
    if (error instanceof AgentRoomRuntimeError) {
      throw error
    } else {
      return null
    }
  }

  return claimStartupLock(path, token) ? token : null
}

function claimStartupLock(path, token) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  let descriptor
  try {
    descriptor = openSync(temporary, 'wx', 0o600)
    const bytes = Buffer.from(token)
    let offset = 0
    while (offset < bytes.length) offset += writeSync(descriptor, bytes, offset, bytes.length - offset)
    closeSync(descriptor)
    descriptor = undefined
    try {
      linkSync(temporary, path)
      return true
    } catch (error) {
      if (error?.code === 'EEXIST') return false
      throw error
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
    try { unlinkSync(temporary) } catch { /* linked or never created */ }
  }
}

function releaseStartupLock(path, token) {
  if (!token) return
  try {
    if (readStartupLock(path) !== token) return
    unlinkSync(path)
  } catch {
    // Another starter already cleared or replaced it.
  }
}

function readStartupLock(path) {
  let descriptor
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    )
    const info = fstatSync(descriptor)
    if (!info.isFile() || info.size < 1 || info.size > MAX_STARTUP_LOCK_BYTES) {
      throw new AgentRoomRuntimeError(
        'daemon_start_lock_invalid',
        'agent-room daemon start lock is not a bounded regular file',
      )
    }
    const buffer = Buffer.alloc(info.size)
    let offset = 0
    while (offset < buffer.length) {
      const count = readSync(descriptor, buffer, offset, buffer.length - offset, offset)
      if (count === 0) break
      offset += count
    }
    if (offset !== buffer.length) {
      throw new AgentRoomRuntimeError('daemon_start_lock_invalid', 'agent-room daemon start lock changed while reading')
    }
    return buffer.toString('utf8')
  } catch (error) {
    if (error instanceof AgentRoomRuntimeError) throw error
    throw new AgentRoomRuntimeError('daemon_start_lock_invalid', 'agent-room daemon start lock is unreadable')
  } finally {
    if (descriptor !== undefined) closeSync(descriptor)
  }
}

export async function ensureDaemon({
  dataDir,
  roomdPath = fileURLToPath(new URL('./roomd.mjs', import.meta.url)),
} = {}) {
  const directory = ensurePrivateDirectory(dataDir)
  const socketPath = daemonSocketPath(directory)
  const existing = await probe(socketPath)
  if (existing) return existing

  const lockPath = startupLockPath(directory)
  const lockDeadline = Date.now() + STARTUP_WAIT_MS
  let lockToken = acquireStartupLock(lockPath)
  while (!lockToken && Date.now() < lockDeadline) {
    await delay(50)
    const ready = await probe(socketPath)
    if (ready) return ready
    lockToken = acquireStartupLock(lockPath)
  }
  if (!lockToken) {
    throw new AgentRoomRuntimeError('daemon_start_busy', 'another agent-room daemon start did not finish')
  }

  try {
    const ready = await probe(socketPath)
    if (ready) return ready
    const child = spawn(process.execPath, [roomdPath, '--data-dir', directory], {
      detached: true,
      stdio: 'ignore',
      env: {
        PATH: process.env.PATH || '',
        LANG: process.env.LANG || 'C.UTF-8',
      },
    })
    child.unref()

    const startupDeadline = Date.now() + STARTUP_WAIT_MS
    while (Date.now() < startupDeadline) {
      await delay(50)
      const status = await probe(socketPath)
      if (status) return status
    }
    throw new AgentRoomRuntimeError('daemon_start_failed', 'agent-room daemon did not become ready')
  } finally {
    releaseStartupLock(lockPath, lockToken)
  }
}

export async function daemonStatus(dataDir) {
  return probe(daemonSocketPath(resolveDataDir(dataDir)))
}

function resolveDataDir(dataDir) {
  if (!dataDir) throw new AgentRoomRuntimeError('data_directory_missing', 'agent-room data directory is required')
  return dataDir
}

export const DAEMON_CLIENT_VERSION = APP_VERSION
