// The client-side session-principal state (v0.9.0): the process-scope storage
// for the server-issued session credential — session id, generation, full
// address, machine, and the RAW capability — under
// PLUGIN_DATA/sessions/<scope>/ (0700 directory, 0600 file, atomic replace).
// The capability authenticates this one process's session-scoped operations
// (heartbeat, addressed send, base-lease release); it must never appear in a
// log, a receipt, or a tool result, so nothing here prints it.
//
// Scope semantics (spec session-principals.md, "Local process-scope resume"):
//   - A harness-provided stable conversation scope (AGENT_ROOM_SESSION_SCOPE)
//     selects a STABLE credential file: a process restart under the same
//     scope finds its stored capability and requests resume.
//   - The DEFAULT is one process start = one addressable session: the scope
//     key derives from the parent pid and this process's pid, so ten
//     harnesses sharing one PLUGIN_DATA each get their own directory, and a
//     respawn is a NEW session (the old principal stays retained/offline —
//     never merged, never displaced).
//   - The scope selects the LOCAL credential file only. It is never an
//     identity: authority always comes from the capability the SERVER issued.
//
// The machine label is captured once here too: hostname-derived by default,
// AGENT_ROOM_MACHINE-overridable, sanitized to the session address's machine
// grammar. A hostname change mid-session never relocates an address — the
// label was captured at allocation and rides the principal.

import { createHash, randomBytes, randomUUID } from 'node:crypto'
import {
  closeSync,
  existsSync,
  openSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { hostname } from 'node:os'
import { join, resolve } from 'node:path'

import {
  CLIENT_CONFIG_MAX_BYTES,
  SESSION_ADDRESS_PATTERN,
  SESSION_CAPABILITY_PATTERN,
  SESSION_CURSOR_SEED_MARKER_FILENAME,
  SESSION_MACHINE_MAX,
  SESSION_MACHINE_PATTERN,
  SESSION_RECOVERY_ID_PATTERN,
  SESSION_SCOPE_BINDINGS_MAX_BYTES,
  SESSION_SCOPE_BINDINGS_MAX_ENTRIES,
  SESSION_SCOPE_BINDING_LOCK_HARD_STALE_MS,
  SESSION_SCOPE_BINDING_LOCK_STALE_MS,
  SESSION_SCOPE_MAX,
  SESSION_SCOPE_PATTERN,
} from '../constants.mjs'
import {
  AgentRoomRuntimeError,
  assertSafePathKey,
  atomicWriteJson,
  ensurePrivateDirectory,
  isPidAlive,
  readJsonFile,
} from '../runtime.mjs'

export const SESSIONS_DIRECTORY_NAME = 'sessions'
export const SESSION_STATE_FILENAME = 'session.json'
export const SESSION_PRINCIPAL_ENV = 'AGENT_ROOM_SESSION_PRINCIPAL'

// The adapter's session-principal arming gate (CAP-1 receive-ready). Default
// ON: one process start = one addressable session. `AGENT_ROOM_SESSION_
// PRINCIPAL=off` restores the pull-only profile for measurement corridors
// calibrated without the session machinery (the REL-3 soak children) — an
// honest opt-out, not a silent downgrade: the addressed send answers
// session_capability_required while disabled.
export function sessionPrincipalEnabled(env = process.env) {
  return env?.[SESSION_PRINCIPAL_ENV] !== 'off'
}

export const SCOPE_BINDINGS_FILENAME = 'scope-bindings.json'
export const SCOPE_BINDINGS_LOCK_FILENAME = 'scope-bindings.lock'

export function hashHostSessionId(prefix, rawId) {
  const digest = createHash('sha256').update(String(rawId)).digest('hex').slice(0, 16)
  return `${prefix}-${digest}`
}

function safeRealpath(target) {
  try {
    return realpathSync(target)
  } catch {
    return resolve(target)
  }
}

export function resolveHostPid(env = process.env, ppid = process.ppid) {
  const rawClaudePid = env?.CLAUDE_PID
  if (typeof rawClaudePid === 'string' && /^\d+$/.test(rawClaudePid.trim())) {
    const parsed = Number(rawClaudePid.trim())
    if (Number.isSafeInteger(parsed) && parsed > 1) return parsed
  }
  return Number(ppid)
}

function readScopeBindingsRaw(pluginDataDir) {
  const path = join(pluginDataDir, SCOPE_BINDINGS_FILENAME)
  if (!existsSync(path)) return { version: 1, bindings: [] }
  try {
    const value = readJsonFile(path, { maxBytes: SESSION_SCOPE_BINDINGS_MAX_BYTES })
    if (value && typeof value === 'object' && value.version === 1 && Array.isArray(value.bindings)) {
      return {
        version: 1,
        bindings: value.bindings.filter(entry =>
          entry
          && typeof entry === 'object'
          && typeof entry.scope === 'string'
          && Number.isSafeInteger(entry.parent_host_pid)
          && typeof entry.realpath_cwd === 'string'
        ),
      }
    }
  } catch {
    // fall through to corrupt backup
  }
  try {
    renameSync(path, join(pluginDataDir, `scope-bindings.corrupt-${Date.now()}.json`))
  } catch { /* best-effort */ }
  return { version: 1, bindings: [] }
}

function tryReclaimStaleScopeLock(lockPath, nowMs) {
  let info
  try {
    info = statSync(lockPath)
  } catch {
    return false
  }
  const ageMs = nowMs() - info.mtimeMs
  if (ageMs < SESSION_SCOPE_BINDING_LOCK_STALE_MS) return false
  let lockPid = null
  try {
    const parsed = readJsonFile(lockPath, { maxBytes: 4096 })
    if (Number.isSafeInteger(parsed?.pid)) lockPid = parsed.pid
  } catch { /* treat unreadable stale lock as reclaimable after hard stale */ }
  const canReclaim = (lockPid !== null && !isPidAlive(lockPid)) || ageMs >= SESSION_SCOPE_BINDING_LOCK_HARD_STALE_MS
  if (!canReclaim) return false
  const stalePath = `${lockPath}.stale-${randomUUID()}`
  try {
    renameSync(lockPath, stalePath)
    unlinkSync(stalePath)
    return true
  } catch {
    return false
  }
}

export function writeScopeBinding({
  pluginDataDir,
  scope,
  env = process.env,
  ppid = process.ppid,
  cwd = process.cwd(),
  nowMs = () => Date.now(),
}) {
  const safeScope = assertSafeSessionScope(scope)
  const dir = ensurePrivateDirectory(pluginDataDir)
  const lockPath = join(dir, SCOPE_BINDINGS_LOCK_FILENAME)
  const bindingsPath = join(dir, SCOPE_BINDINGS_FILENAME)
  const hostPid = resolveHostPid(env, ppid)
  const realCwd = safeRealpath(cwd)

  let locked = false
  for (let attempt = 0; attempt < 5; attempt += 1) {
    let fd
    try {
      fd = openSync(lockPath, 'wx', 0o600)
      writeSync(fd, `${JSON.stringify({ pid: process.pid, created_at: new Date(nowMs()).toISOString() })}\n`)
      closeSync(fd)
      fd = undefined
      locked = true
      break
    } catch (error) {
      if (fd !== undefined) {
        try { closeSync(fd) } catch { /* ignore */ }
      }
      if (error?.code !== 'EEXIST') throw error
      tryReclaimStaleScopeLock(lockPath, nowMs)
    }
  }
  if (!locked) {
    throw new AgentRoomRuntimeError('state_locked', 'scope-bindings.lock is held by another process')
  }

  try {
    const current = readScopeBindingsRaw(dir)
    const nowIso = new Date(nowMs()).toISOString()
    const filtered = current.bindings.filter(entry =>
      isPidAlive(entry.parent_host_pid)
      && !(entry.parent_host_pid === hostPid && entry.realpath_cwd === realCwd)
    )
    filtered.unshift({
      scope: safeScope,
      parent_host_pid: hostPid,
      realpath_cwd: realCwd,
      updated_at: nowIso,
    })
    atomicWriteJson(bindingsPath, {
      version: 1,
      bindings: filtered.slice(0, SESSION_SCOPE_BINDINGS_MAX_ENTRIES),
    })
  } finally {
    try { unlinkSync(lockPath) } catch { /* ignore */ }
  }
}

export function lookupScopeBinding({
  pluginDataDir,
  env = process.env,
  ppid = process.ppid,
  cwd = process.cwd(),
}) {
  if (!pluginDataDir) return null
  const dir = resolve(pluginDataDir)
  const path = join(dir, SCOPE_BINDINGS_FILENAME)
  if (!existsSync(path)) return null
  const hostPid = resolveHostPid(env, ppid)
  if (!isPidAlive(hostPid)) return null
  const realCwd = safeRealpath(cwd)
  const realPluginData = safeRealpath(dir)
  const data = readScopeBindingsRaw(dir)
  const exact = data.bindings.find(entry =>
    entry.parent_host_pid === hostPid && entry.realpath_cwd === realCwd
  )
  if (exact) {
    try { return assertSafeSessionScope(exact.scope) } catch { return null }
  }
  if (realCwd === realPluginData) {
    const byHost = data.bindings.find(entry => entry.parent_host_pid === hostPid)
    if (byHost) {
      try { return assertSafeSessionScope(byHost.scope) } catch { return null }
    }
  }
  return null
}

// 5-step Session Scope resolution:
// (1) explicit --scope / hook mapping
// (2) AGENT_ROOM_SESSION_SCOPE
// (3) hashed host ID (CLAUDE_CODE_SESSION_ID | CLAUDE_SESSION_ID | ANTIGRAVITY_CONVERSATION_ID | CODEX_THREAD_ID)
// (4) PLUGIN_DATA/scope-bindings.json (parent_host_pid, realpath_cwd)
// (5) fallback p<ppid>.<pid>
export function sessionScopeKey({
  explicitScope,
  env = process.env,
  pluginDataDir,
  cwd = process.cwd(),
  ppid = process.ppid,
  pid = process.pid,
} = {}) {
  if (typeof explicitScope === 'string' && explicitScope.length > 0) {
    return assertSafeSessionScope(explicitScope)
  }
  const declared = env?.AGENT_ROOM_SESSION_SCOPE
  if (typeof declared === 'string' && declared.length > 0) {
    return assertSafeSessionScope(declared)
  }
  const claudeId = env?.CLAUDE_CODE_SESSION_ID || env?.CLAUDE_SESSION_ID
  if (typeof claudeId === 'string' && claudeId.length > 0) {
    return hashHostSessionId('claude', claudeId)
  }
  const agyId = env?.ANTIGRAVITY_CONVERSATION_ID
  if (typeof agyId === 'string' && agyId.length > 0) {
    return hashHostSessionId('agy', agyId)
  }
  const codexId = env?.CODEX_THREAD_ID
  if (typeof codexId === 'string' && codexId.length > 0) {
    return hashHostSessionId('codex', codexId)
  }
  if (pluginDataDir) {
    const bound = lookupScopeBinding({ pluginDataDir, env, ppid, cwd })
    if (bound !== null) return bound
  }
  return `p${Number(ppid)}.${Number(pid)}`
}

// The path-escape guard behind every scope-keyed path: the grammar allows
// '.'/'..', which as directory segments would escape sessions/ — a '.' or
// '..' scope (a malformed AGENT_ROOM_SESSION_SCOPE) is a coded refusal before
// any path is built, never a traversal.
export function assertSafeSessionScope(scope) {
  return assertSafePathKey(scope, {
    maxLength: SESSION_SCOPE_MAX,
    pattern: SESSION_SCOPE_PATTERN,
    label: 'session scope',
  })
}

export function sessionsDirectoryPath(pluginDataDir) {
  return join(pluginDataDir, SESSIONS_DIRECTORY_NAME)
}

// Path-escape guard: the scope keys directories under PLUGIN_DATA/sessions/,
// so its shape is verified before any path is built from it — the same
// discipline as the realm key under realms/.
export function sessionStatePath(pluginDataDir, scope) {
  return join(pluginDataDir, SESSIONS_DIRECTORY_NAME, assertSafeSessionScope(scope), SESSION_STATE_FILENAME)
}

// Load this scope's stored session principal, or null when there is none.
// A file that exists but is unusable (unreadable, malformed, wrong shapes —
// including a capability-shaped string that is not canonical) is a LOUD
// refusal via the injected onError seam (default: one bounded stderr line):
// the old address remains until its lease expires (failure-modes I8), and
// the caller proceeds to a fresh authenticated allocation — it never
// silently ignores credential state it cannot read.
export function loadSessionState(pluginDataDir, scope, { onError = defaultOnSessionStateError } = {}) {
  const path = sessionStatePath(pluginDataDir, scope)
  if (!existsSync(path)) return null
  let value
  try {
    value = readJsonFile(path, { maxBytes: CLIENT_CONFIG_MAX_BYTES })
  } catch (error) {
    onError('session state unreadable', path, error)
    return null
  }
  const sessionId = value?.session_id
  const generation = value?.generation
  const address = value?.address
  const machine = value?.machine
  const baseName = value?.base_name
  const capability = value?.capability
  if (
    typeof sessionId !== 'string' || sessionId.length === 0
    || !Number.isSafeInteger(generation) || generation < 1
    || typeof address !== 'string' || !SESSION_ADDRESS_PATTERN.test(address)
    || typeof machine !== 'string' || machine.length === 0
    || typeof baseName !== 'string' || baseName.length === 0
    || typeof capability !== 'string' || !SESSION_CAPABILITY_PATTERN.test(capability)
  ) {
    onError('session state malformed', path, null)
    return null
  }
  return {
    sessionId,
    generation,
    address,
    baseName,
    machine,
    capability,
    recoveryId: typeof value.recovery_id === 'string' && SESSION_RECOVERY_ID_PATTERN.test(value.recovery_id)
      ? value.recovery_id
      : null,
    savedAt: typeof value.saved_at === 'string' ? value.saved_at : null,
  }
}

export function newRecoveryId() {
  return randomBytes(24).toString('base64url')
}

// Atomic 0600 save (atomicWriteJson keeps the file at 0600 whatever the
// umask and creates the 0700 directory). Called only after a successful
// allocate/resume (or pre-flight to persist recovery_id); a failed save
// surfaces to the caller.
export function saveSessionState(pluginDataDir, scope, state) {
  const payload = {
    version: 1,
    session_id: state.sessionId,
    generation: state.generation,
    address: state.address,
    base_name: state.baseName,
    machine: state.machine,
    capability: state.capability,
    saved_at: new Date().toISOString(),
  }
  if (typeof state.recoveryId === 'string' && SESSION_RECOVERY_ID_PATTERN.test(state.recoveryId)) {
    payload.recovery_id = state.recoveryId
  }
  atomicWriteJson(sessionStatePath(pluginDataDir, scope), payload)
}

// Best-effort removal of ONLY session.json (never rm -rf the scope directory,
// so cursors.json, inbox.jsonl, loop-ledger.sqlite, and wait.lock persist
// byte-identically). Never throws for a missing file.
export function clearSessionState(pluginDataDir, scope) {
  const target = sessionStatePath(pluginDataDir, scope)
  try {
    unlinkSync(target)
  } catch (error) {
    if (error instanceof AgentRoomRuntimeError) throw error
    if (error?.code === 'ENOENT') return
  }
}

function defaultOnSessionStateError(reason, path, error) {
  process.stderr.write(
    `agent-room session state: ${reason} (${path}): ${error?.code ?? error?.message ?? 'unusable'}\n`,
  )
}

// The machine label source (SPEC open question, resolved for this release):
// AGENT_ROOM_MACHINE when set, else the OS hostname — sanitized to the
// session address's machine grammar (invalid characters fold to '-'), capped
// at the grammar's bound, and never empty ('localhost' as the floor).
export function machineLabel({ env = process.env, host = hostname() } = {}) {
  const source = typeof env?.AGENT_ROOM_MACHINE === 'string' && env.AGENT_ROOM_MACHINE.trim() !== ''
    ? env.AGENT_ROOM_MACHINE.trim()
    : String(host)
  const sanitized = source.replace(/[^A-Za-z0-9_.-]/g, '-').replace(/^[^A-Za-z0-9]+/, '')
  const bounded = sanitized.slice(0, SESSION_MACHINE_MAX).replace(/[^A-Za-z0-9_.-]$/g, '')
  return bounded.length > 0 && SESSION_MACHINE_PATTERN.test(bounded) ? bounded : 'localhost'
}

// The v0.8 → v0.9 per-session cursor migration (CAP-7, cursor-only seed).
// The FIRST v0.9 session of an installation seeds its cursor file from the
// legacy realms/<realm>/cursors.json; every later session starts at 0; a
// re-run is a no-op. A legacy file that exists but cannot be read refuses
// LOUDLY with the coded migration_source_unreadable — a corrupt cursor
// position is never silently reset (failure-modes U2).
export function sessionCursorSeedState({
  pluginDataDir,
  realmId,
  scope,
  legacyCursorsReader = defaultLegacyCursorsReader,
  now = () => new Date().toISOString(),
}) {
  assertSafePathKey(realmId, { label: 'realm id' })
  assertSafeSessionScope(scope)
  const sessionsDir = ensurePrivateDirectory(sessionsDirectoryPath(pluginDataDir))
  const cursorPath = join(sessionsDir, assertSafeSessionScope(scope), 'cursors.json')
  const markerPath = join(sessionsDir, SESSION_CURSOR_SEED_MARKER_FILENAME)
  if (existsSync(cursorPath)) {
    let stored = {}
    try {
      const value = readJsonFile(cursorPath)
      if (value && typeof value === 'object' && value.realm_id === realmId
        && value.cursors && typeof value.cursors === 'object') {
        stored = value.cursors
      }
    } catch {
      stored = {}
    }
    return { cursorPath, cursors: stored, seeded: false }
  }
  let cursors = {}
  let seeded = false
  if (!existsSync(markerPath)) {
    const legacyPath = join(pluginDataDir, 'realms', realmId, 'cursors.json')
    if (existsSync(legacyPath)) {
      let legacy
      try {
        legacy = legacyCursorsReader(legacyPath)
      } catch (error) {
        throw new AgentRoomRuntimeError(
          'migration_source_unreadable',
          `the v0.8 cursor state at ${legacyPath} exists but cannot be read: ${error?.code ?? error?.message ?? 'unusable'} — fix or remove it; the session cursor was not reset`,
        )
      }
      if (legacy && typeof legacy.cursors === 'object' && legacy.cursors !== null) {
        cursors = legacy.cursors
      }
      seeded = true
      atomicWriteJson(markerPath, { seeded_at: now(), realm_id: realmId, from: 'realms/<realm>/cursors.json' })
    }
  }
  return { cursorPath, cursors, seeded }
}

function defaultLegacyCursorsReader(path) {
  return readJsonFile(path, { maxBytes: CLIENT_CONFIG_MAX_BYTES })
}
