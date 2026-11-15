#!/usr/bin/env node

import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from 'node:fs'
import { dirname, isAbsolute } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CLAUDE_ENV_FILE_MAX_BYTES,
  HOOK_STDIN_MAX_BYTES,
  HOOK_STDIN_TIMEOUT_MS,
} from '../constants.mjs'
import { instanceDataDirectory } from '../runtime.mjs'
import {
  assertSafeSessionScope,
  hashHostSessionId,
  sessionScopeKey,
  writeScopeBinding,
} from '../client/session-state.mjs'

function readBoundedStdin(input = process.stdin, {
  maxBytes = HOOK_STDIN_MAX_BYTES,
  timeoutMs = HOOK_STDIN_TIMEOUT_MS,
} = {}) {
  return new Promise((resolvePromise) => {
    if (!input || input.isTTY || input.readableEnded) {
      resolvePromise('')
      return
    }
    const chunks = []
    let totalBytes = 0
    let settled = false
    const finish = (text) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.removeListener('data', onData)
      input.removeListener('end', onEnd)
      input.removeListener('error', onError)
      resolvePromise(text)
    }
    const timer = setTimeout(() => {
      try { input.pause?.() } catch { /* ignore */ }
      finish(Buffer.concat(chunks).toString('utf8'))
    }, timeoutMs)
    timer.unref?.()

    const onData = (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
      if (totalBytes + buf.length > maxBytes) {
        finish('')
        return
      }
      totalBytes += buf.length
      chunks.push(buf)
    }
    const onEnd = () => finish(Buffer.concat(chunks).toString('utf8'))
    const onError = () => finish('')

    input.on('data', onData)
    input.on('end', onEnd)
    input.on('error', onError)
    input.resume?.()
  })
}

export function appendScopeToClaudeEnvFile(envFile, scope) {
  if (typeof envFile !== 'string' || envFile.length === 0) return { written: false, reason: 'missing' }
  const safeScope = assertSafeSessionScope(scope)
  if (!isAbsolute(envFile)) {
    return { written: false, reason: 'not_absolute' }
  }
  const parent = dirname(envFile)
  let parentInfo
  try {
    parentInfo = lstatSync(parent)
  } catch {
    return { written: false, reason: 'parent_missing' }
  }
  if (parentInfo.isSymbolicLink() || !parentInfo.isDirectory()) {
    return { written: false, reason: 'parent_invalid' }
  }
  try {
    const leafInfo = lstatSync(envFile)
    if (leafInfo.isSymbolicLink() || !leafInfo.isFile() || leafInfo.size > CLAUDE_ENV_FILE_MAX_BYTES) {
      return { written: false, reason: 'leaf_invalid' }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      return { written: false, reason: 'leaf_stat_failed' }
    }
  }

  const flags = constants.O_RDWR
    | constants.O_CREAT
    | constants.O_APPEND
    | (constants.O_NOFOLLOW ?? 0)
    | (constants.O_NONBLOCK ?? 0)
  let fd
  try {
    fd = openSync(envFile, flags, 0o600)
    const openedInfo = fstatSync(fd)
    if (!openedInfo.isFile() || openedInfo.size > CLAUDE_ENV_FILE_MAX_BYTES) {
      return { written: false, reason: 'opened_invalid' }
    }
    const existingBuf = Buffer.alloc(openedInfo.size)
    let offset = 0
    while (offset < openedInfo.size) {
      const n = readSync(fd, existingBuf, offset, openedInfo.size - offset, offset)
      if (n <= 0) break
      offset += n
    }
    const existingText = existingBuf.subarray(0, offset).toString('utf8')
    const exportLine = `export AGENT_ROOM_SESSION_SCOPE=${safeScope}`
    const lines = existingText.split(/\r?\n/)
    if (lines.some(line => line.trim() === exportLine)) {
      return { written: false, reason: 'already_present' }
    }
    const prefix = existingText.length > 0 && !existingText.endsWith('\n') ? '\n' : ''
    const payload = `${prefix}${exportLine}\n`
    if (openedInfo.size + Buffer.byteLength(payload, 'utf8') > CLAUDE_ENV_FILE_MAX_BYTES) {
      return { written: false, reason: 'max_bytes_exceeded' }
    }
    writeSync(fd, payload)
    return { written: true, reason: 'appended' }
  } catch {
    return { written: false, reason: 'io_error' }
  } finally {
    if (fd !== undefined) {
      try { closeSync(fd) } catch { /* ignore */ }
    }
  }
}

export async function runHookSessionStart({
  input = process.stdin,
  env = process.env,
  cwd = process.cwd(),
  pluginDataDir,
} = {}) {
  try {
    const rawStdin = await readBoundedStdin(input)
    let payload = null
    if (rawStdin.trim().length > 0) {
      try {
        payload = JSON.parse(rawStdin)
      } catch {
        payload = null
      }
    }
    const effectiveCwd = typeof payload?.cwd === 'string' && payload.cwd.length > 0 ? payload.cwd : cwd
    let effectivePluginData = pluginDataDir
    if (!effectivePluginData) {
      try {
        effectivePluginData = instanceDataDirectory(env, effectiveCwd)
      } catch {
        effectivePluginData = null
      }
    }

    let explicitScope
    if (
      !env?.AGENT_ROOM_SESSION_SCOPE
      && !env?.CLAUDE_CODE_SESSION_ID
      && !env?.CLAUDE_SESSION_ID
      && typeof payload?.session_id === 'string'
      && payload.session_id.length > 0
    ) {
      explicitScope = hashHostSessionId('claude', payload.session_id)
    }

    const scope = sessionScopeKey({
      explicitScope,
      env,
      pluginDataDir: effectivePluginData,
      cwd: effectiveCwd,
    })

    if (effectivePluginData) {
      try {
        writeScopeBinding({
          pluginDataDir: effectivePluginData,
          scope,
          env,
          cwd: effectiveCwd,
        })
      } catch {
        // fail-open
      }
    }

    if (typeof env?.CLAUDE_ENV_FILE === 'string' && env.CLAUDE_ENV_FILE.length > 0) {
      appendScopeToClaudeEnvFile(env.CLAUDE_ENV_FILE, scope)
    }

    return { ok: true, scope }
  } catch {
    return { ok: true, scope: null }
  }
}

function launchedDirectly() {
  if (!process.argv[1]) return false
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}

if (launchedDirectly()) {
  runHookSessionStart()
    .catch(() => {})
    .finally(() => {
      process.exitCode = 0
    })
}
