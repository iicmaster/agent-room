import {
  chmodSync,
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from 'node:fs'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { homedir, platform } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'

import { DISPLAY_NAME_MAX, IDENTIFIER_MAX } from './constants.mjs'

export const APP_VERSION = '0.1.0'
export const DAEMON_PROTOCOL_VERSION = 1
export const MIN_NODE_VERSION = '24.15'
export const MIN_SQLITE_VERSION = '3.51.3'

export { FRAME_MAX_BYTES as MAX_FRAME_BYTES } from './constants.mjs'

// Bounds are owned by constants.mjs (AD-9); the pattern only derives from them.
const IDENTIFIER_PATTERN = new RegExp(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,${IDENTIFIER_MAX - 1}}$`)

export class AgentRoomRuntimeError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'AgentRoomRuntimeError'
    this.code = code
  }
}

export function compareVersions(left, right) {
  const parse = value => String(value ?? '').split('.').map(part => {
    const match = /^\d+/.exec(part)
    return match ? Number(match[0]) : 0
  })
  const a = parse(left)
  const b = parse(right)
  const width = Math.max(a.length, b.length)
  for (let index = 0; index < width; index += 1) {
    const delta = (a[index] ?? 0) - (b[index] ?? 0)
    if (delta !== 0) return delta < 0 ? -1 : 1
  }
  return 0
}

export function assertSupportedRuntime({
  nodeVersion = process.versions.node,
  sqliteVersion = process.versions.sqlite,
} = {}) {
  if (!nodeVersion || compareVersions(nodeVersion, MIN_NODE_VERSION) < 0) {
    throw new AgentRoomRuntimeError(
      'node_version_unsupported',
      `agent-room requires Node ${MIN_NODE_VERSION} or newer; found ${nodeVersion || 'unknown'}`,
    )
  }
  if (!sqliteVersion || compareVersions(sqliteVersion, MIN_SQLITE_VERSION) < 0) {
    throw new AgentRoomRuntimeError(
      'sqlite_version_unsupported',
      `agent-room requires SQLite ${MIN_SQLITE_VERSION} or newer; found ${sqliteVersion || 'unknown'}`,
    )
  }
  return { nodeVersion: String(nodeVersion), sqliteVersion: String(sqliteVersion) }
}

export function ensurePrivateDirectory(path) {
  const absolute = resolve(path)
  if (existsSync(absolute)) {
    const info = lstatSync(absolute)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new AgentRoomRuntimeError('data_directory_invalid', 'agent-room data path must be a real directory')
    }
  } else {
    mkdirSync(absolute, { recursive: true, mode: 0o700 })
  }
  chmodSync(absolute, 0o700)
  return absolute
}

function explicitAbsolutePath(value, name) {
  if (!isAbsolute(value)) {
    throw new AgentRoomRuntimeError(`${name}_not_absolute`, `${name} must be an absolute path`)
  }
  return resolve(value)
}

export function sharedDataDirectory(env = process.env) {
  if (env.AGENT_ROOM_DATA_DIR) {
    return explicitAbsolutePath(env.AGENT_ROOM_DATA_DIR, 'AGENT_ROOM_DATA_DIR')
  }
  return join(homedir(), '.agent-room')
}

export function instanceDataDirectory(env = process.env, cwd = process.cwd()) {
  const configured = env.PLUGIN_DATA || env.CLAUDE_PLUGIN_DATA
  return configured
    ? explicitAbsolutePath(configured, configured === env.PLUGIN_DATA ? 'PLUGIN_DATA' : 'CLAUDE_PLUGIN_DATA')
    : join(homedir(), '.agent-room', 'client-data', 'manual')
}

export function daemonSocketPath(dataDir) {
  const absolute = resolve(dataDir)
  if (platform() === 'win32') {
    const digest = createHash('sha256').update(absolute).digest('hex').slice(0, 24)
    return `\\\\.\\pipe\\agent-room-${digest}`
  }
  return join(absolute, 'roomd.sock')
}

export function runtimeRecordPath(dataDir) {
  return join(resolve(dataDir), 'runtime.json')
}

export function startupLockPath(dataDir) {
  return join(resolve(dataDir), 'roomd.start.lock')
}

export function regularPrivateFile(path, maxBytes = 64 * 1024) {
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isFile() || info.size > maxBytes) {
    throw new AgentRoomRuntimeError('state_file_invalid', 'agent-room state file is not a bounded regular file')
  }
  return info
}

export function readJsonFile(path, { maxBytes = 64 * 1024 } = {}) {
  regularPrivateFile(path, maxBytes)
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    throw new AgentRoomRuntimeError('state_file_invalid', 'agent-room state file is not valid JSON')
  }
}

export function atomicWriteJson(path, value, mode = 0o600) {
  const directory = ensurePrivateDirectory(dirname(path))
  const temporary = join(directory, `.${randomUUID()}.tmp`)
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode })
    chmodSync(temporary, mode)
    renameSync(temporary, path)
    chmodSync(path, mode)
  } finally {
    try { unlinkSync(temporary) } catch { /* renamed or never created */ }
  }
}

function cleanDisplayName(value) {
  const text = String(value ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().replace(/\s+/g, ' ')
  return text.slice(0, DISPLAY_NAME_MAX) || 'agent'
}

export function loadOrCreateIdentity(dataDir, suggestedName = 'agent') {
  const directory = ensurePrivateDirectory(dataDir)
  const path = join(directory, 'identity.json')
  const read = () => {
    const value = readJsonFile(path, { maxBytes: 4096 })
    if (typeof value.id !== 'string' || !IDENTIFIER_PATTERN.test(value.id)) {
      throw new AgentRoomRuntimeError('identity_invalid', 'agent-room identity has an invalid id')
    }
    return { id: value.id, displayName: cleanDisplayName(value.displayName), path }
  }
  if (existsSync(path)) return read()

  const identity = {
    id: `agent:${randomUUID()}`,
    displayName: cleanDisplayName(suggestedName),
    createdAt: new Date().toISOString(),
  }
  let descriptor
  try {
    descriptor = openSync(path, 'wx', 0o600)
    writeSync(descriptor, `${JSON.stringify(identity, null, 2)}\n`)
    closeSync(descriptor)
    descriptor = undefined
    chmodSync(path, 0o600)
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    if (error?.code !== 'EEXIST') throw error
  }
  return read()
}

export function loadOrCreateViewerToken(dataDir) {
  const directory = ensurePrivateDirectory(dataDir)
  const path = join(directory, 'viewer-token')
  const read = () => {
    regularPrivateFile(path, 4096)
    const token = readFileSync(path, 'utf8').trim()
    if (!/^[A-Za-z0-9_-]{32,256}$/.test(token)) {
      throw new AgentRoomRuntimeError('viewer_token_invalid', 'agent-room viewer token is invalid')
    }
    return token
  }
  if (existsSync(path)) return read()
  let descriptor
  try {
    descriptor = openSync(path, 'wx', 0o600)
    writeSync(descriptor, `${randomBytes(32).toString('base64url')}\n`)
    closeSync(descriptor)
    descriptor = undefined
    chmodSync(path, 0o600)
  } catch (error) {
    if (descriptor !== undefined) closeSync(descriptor)
    if (error?.code !== 'EEXIST') throw error
  }
  return read()
}

export function sanitizeDisplayName(value) {
  return cleanDisplayName(value)
}
