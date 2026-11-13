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

import { existsSync, rmSync } from 'node:fs'
import { hostname } from 'node:os'
import { join } from 'node:path'

import {
  CLIENT_CONFIG_MAX_BYTES,
  SESSION_ADDRESS_PATTERN,
  SESSION_CAPABILITY_PATTERN,
  SESSION_CURSOR_SEED_MARKER_FILENAME,
  SESSION_MACHINE_MAX,
  SESSION_MACHINE_PATTERN,
  SESSION_SCOPE_MAX,
  SESSION_SCOPE_PATTERN,
} from '../constants.mjs'
import {
  AgentRoomRuntimeError,
  atomicWriteJson,
  ensurePrivateDirectory,
  readJsonFile,
} from '../runtime.mjs'

export const SESSIONS_DIRECTORY_NAME = 'sessions'
export const SESSION_STATE_FILENAME = 'session.json'

// The derived per-process scope key: parent pid + own pid. Both are plain
// integers, so the key always satisfies the safe-key grammar; the harness
// scope (when provided) is validated before any path is built from it.
export function sessionScopeKey({ env = process.env, ppid = process.ppid, pid = process.pid } = {}) {
  const declared = env?.AGENT_ROOM_SESSION_SCOPE
  if (typeof declared === 'string' && declared.length > 0) {
    return assertSafeSessionScope(declared)
  }
  return `p${Number(ppid)}.${Number(pid)}`
}

// The path-escape guard behind every scope-keyed path: the grammar allows
// '.'/'..', which as directory segments would escape sessions/ — a '.' or
// '..' scope (a malformed AGENT_ROOM_SESSION_SCOPE) is a coded refusal before
// any path is built, never a traversal.
export function assertSafeSessionScope(scope) {
  if (typeof scope !== 'string' || scope === '.' || scope === '..' || !SESSION_SCOPE_PATTERN.test(scope)) {
    throw new AgentRoomRuntimeError(
      'invalid_request',
      `the agent-room session scope must be 1-${SESSION_SCOPE_MAX} safe characters (letters, numbers, dot, underscore, hyphen; never "." or "..")`,
    )
  }
  return scope
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
    savedAt: typeof value.saved_at === 'string' ? value.saved_at : null,
  }
}

// Atomic 0600 save (atomicWriteJson keeps the file at 0600 whatever the
// umask and creates the 0700 directory). Called only after a successful
// allocate/resume; a failed save surfaces to the caller — an unrecorded
// capability would make the next start allocate a fresh principal while the
// old one stays retained, which is safe but must not pass silently.
export function saveSessionState(pluginDataDir, scope, state) {
  atomicWriteJson(sessionStatePath(pluginDataDir, scope), {
    version: 1,
    session_id: state.sessionId,
    generation: state.generation,
    address: state.address,
    base_name: state.baseName,
    machine: state.machine,
    capability: state.capability,
    saved_at: new Date().toISOString(),
  })
}

// Best-effort removal (resume-fenced state is cleared before a fresh
// allocation). The scope is the same guarded key the paths use, so the
// recursive remove can never escape sessions/. Never throws for a missing
// file.
export function clearSessionState(pluginDataDir, scope) {
  try {
    rmSync(join(pluginDataDir, SESSIONS_DIRECTORY_NAME, assertSafeSessionScope(scope)), { recursive: true, force: true })
  } catch (error) {
    if (error instanceof AgentRoomRuntimeError) throw error
    // A directory that cannot be removed leaves a stale credential file;
    // the next load treats a malformed state as absent, so this is never
    // a correctness problem — only disk residue.
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
