// Story 3.3 — `agent-room gc`: bounded, safe collection of stale per-scope
// state under PLUGIN_DATA/sessions/. `doctor` stays strictly read-only (Story
// 4.3); GC is its own mutating subcommand.
//
// SAFETY, IN ORDER (each is a hard gate, never a heuristic to skip):
//   1. Target must be a real directory via lstat — a symlink is NEVER followed
//      or deleted through (a planted symlink must not turn GC into an arbitrary
//      filesystem deleter). Non-matching grammar is ignored.
//   2. The CURRENT scope is never collected.
//   3. wait.lock / cursors.lock / inbox.lock with a LIVE pid are never
//      collected. Liveness is isPidAlive(); a lock whose recorded pid predates
//      this process boot cannot be the current process, but it is still
//      skipped — the mtime/boot comparison only ADDS conservatism (it can
//      never turn a live-PID scope into a deletion).
//   4. Deletion needs positive evidence:
//        - the server confirms the principal revoked, or a successful listing
//          no longer retains it AND the scope is past GC_RETENTION_MS (30 d);
//          OFFLINE / 401 / any unauth responses are NOT evidence — skip; or
//        - a `p<ppid>.<pid>` scope whose pid is dead AND whose mtime is older
//          than GC_PID_GRACE_MS (24 h).
//   5. Throughput is capped: at most GC_SCOPE_BATCH scopes per
//      GC_SCOPE_WINDOW_MS window; the rest carry to the next window.
//
// All runtime facts (now, pid liveness, boot time, sleep, server confirmation)
// are injectable seams so the whole matrix runs in a temp dir with no server.

import { lstatSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

import {
  GC_PID_GRACE_MS,
  GC_RETENTION_MS,
  GC_SCOPE_BATCH,
  GC_SCOPE_WINDOW_MS,
  SESSION_SCOPE_PATTERN,
} from '../constants.mjs'
import { isPidAlive } from '../runtime.mjs'
import { sessionsDirectoryPath, sessionScopeFilePath, sessionScopeKey } from '../client/session-state.mjs'

export const GC_LOCK_FILENAMES = Object.freeze(['wait.lock', 'cursors.lock', 'inbox.lock'])
const P_SCOPE_PATTERN = /^p(\d+)\.(\d+)$/

const usage = (command, message) => ({ status: 'usage', command, code: 'usage', message })
const refusal = (command, error, extra) => ({
  status: 'refusal', command, code: error?.code ?? 'request_failed',
  message: error?.message ?? String(error), ...(extra === undefined ? {} : { extra }),
})

function readLockPid(path, readFile) {
  try {
    const parsed = JSON.parse(readFile(path, 'utf8'))
    return Number.isSafeInteger(parsed?.pid) ? parsed.pid : null
  } catch {
    return null
  }
}

function readSessionId(pluginDataDir, scope, readFile) {
  try {
    const parsed = JSON.parse(readFile(sessionScopeFilePath(pluginDataDir, scope, 'session.json'), 'utf8'))
    return typeof parsed?.session_id === 'string' ? parsed.session_id : null
  } catch {
    return null
  }
}

// The one classification: reason is a diagnostic code, never a body/text.
export function classifyScope({
  scope,
  pluginDataDir,
  currentScope,
  nowMs,
  bootTimeMs,
  stat,
  lstat,
  readFile,
  alive,
  server, // { available, revoked:Set, retained:Set } — unavailable => no evidence
}) {
  if (scope === currentScope) return { collect: false, reason: 'current_scope' }
  if (!SESSION_SCOPE_PATTERN.test(scope)) return { collect: false, reason: 'invalid_scope' }
  let info
  try { info = lstat(sessionScopeFilePath(pluginDataDir, scope, 'session.json')) } catch { info = null }
  // A symlink ANYWHERE in the target path is refused; we only ever trust a
  // real directory entry named by the scope.
  try {
    const dir = lstat(join(sessionsDirectoryPath(pluginDataDir), scope))
    if (dir.isSymbolicLink() || !dir.isDirectory()) return { collect: false, reason: 'not_a_directory' }
  } catch {
    return { collect: false, reason: 'not_a_directory' }
  }
  // Live-lock gate. A lock's mtime older than boot cannot belong to this
  // process; a live pid is skipped either way (never delete a live scope).
  for (const lockName of GC_LOCK_FILENAMES) {
    const lockPath = sessionScopeFilePath(pluginDataDir, scope, lockName)
    let lockStat = null
    try { lockStat = lstat(lockPath) } catch { /* absent */ }
    if (lockStat === null || lockStat.isSymbolicLink()) continue
    const pid = readLockPid(lockPath, readFile)
    if (pid === null) continue
    if (alive(pid)) {
      const reused = lockStat.mtimeMs < bootTimeMs
      return { collect: false, reason: reused ? 'lock_live_pid_reused' : 'lock_live_pid' }
    }
  }

  const dirMtimeMs = info?.mtimeMs ?? stat(join(sessionsDirectoryPath(pluginDataDir), scope)).mtimeMs
  const ageMs = nowMs - dirMtimeMs
  // Positive server evidence: an explicit revoke, or a successful snapshot
  // that no longer retains this session AND the scope is past 30 days.
  // A snapshot that RETAINS the session is positive evidence of life — it
  // suppresses every local fallback (never delete a scope the server says is
  // still held).
  const sessionId = readSessionId(pluginDataDir, scope, readFile)
  if (server.available) {
    if (sessionId !== null && server.revoked.has(sessionId)) {
      return { collect: true, reason: 'server_revoked' }
    }
    if (sessionId !== null && server.retained.has(sessionId)) {
      return { collect: false, reason: 'server_retained' }
    }
    if (ageMs >= GC_RETENTION_MS) {
      return { collect: true, reason: 'server_expired' }
    }
  }
  // Local fallback: a derived p<ppid>.<pid> scope whose own pid is dead and
  // which has been silent past the 24 h grace.
  const match = P_SCOPE_PATTERN.exec(scope)
  if (match !== null) {
    const pid = Number(match[2])
    if (!alive(pid) && ageMs >= GC_PID_GRACE_MS) {
      return { collect: true, reason: 'dead_pid_grace' }
    }
  }
  return { collect: false, reason: 'no_evidence' }
}

// The server snapshot. Offline (transport error) or 401 yields
// { available:false } — NEVER a revoke verdict. Only a successful, complete
// listing produces sets. The optional `probe` seam returns
// { ok, sessions:[{session_id, principal_status, principal_retention_expires_at}] }.
async function loadServerSnapshot(probe) {
  if (probe === null) return { available: false, revoked: new Set(), retained: new Set() }
  try {
    const result = await probe()
    if (result?.ok !== true || !Array.isArray(result.sessions)) {
      return { available: false, revoked: new Set(), retained: new Set() }
    }
    const revoked = new Set()
    const retained = new Set()
    for (const row of result.sessions) {
      if (typeof row?.session_id !== 'string') continue
      if (row.principal_status === 'revoked' || row.principal_status === 'retention_expired') {
        revoked.add(row.session_id)
      } else {
        retained.add(row.session_id)
      }
    }
    return { available: true, revoked, retained }
  } catch {
    // Offline / 401 / malformed: no evidence, not a revoke.
    return { available: false, revoked: new Set(), retained: new Set() }
  }
}

export async function runGcCommand(tokens, {
  pluginDataDir,
  env = process.env,
  now = () => Date.now(),
  bootTimeMs = 0,
  alive = isPidAlive,
  lstat = lstatSync,
  stat = statSync,
  readFile = readFileSync,
  remove = path => rmSync(path, { recursive: true, force: true }),
  sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms)),
  probe = null,
} = {}) {
  const command = 'gc'
  for (const token of tokens) {
    if (token === '--json') continue
    return usage(command, `unexpected argument "${token}"; gc takes no options`)
  }
  const sessionsDir = sessionsDirectoryPath(pluginDataDir)
  let scopes
  try {
    scopes = lstat(sessionsDir).isDirectory() ? readdirSync(sessionsDir) : []
  } catch {
    scopes = []
  }
  const currentScope = sessionScopeKey({ env, pluginDataDir })
  const nowMs = now()
  const server = await loadServerSnapshot(probe)

  const collected = []
  const kept = []
  let processed = 0
  let windowStart = nowMs
  for (const scope of scopes) {
    // Rate cap: at most GC_SCOPE_BATCH classifications per window; the rest
    // carry to the next window instead of being dropped.
    if (processed > 0 && processed % GC_SCOPE_BATCH === 0) {
      const elapsed = now() - windowStart
      if (elapsed < GC_SCOPE_WINDOW_MS) await sleep(GC_SCOPE_WINDOW_MS - elapsed)
      windowStart = now()
    }
    processed += 1
    let verdict
    try {
      verdict = classifyScope({
        scope, pluginDataDir, currentScope, nowMs, bootTimeMs, stat, lstat, readFile, alive, server,
      })
    } catch {
      verdict = { collect: false, reason: 'inspection_failed' }
    }
    if (verdict.collect === true) {
      try {
        // Re-check lstat immediately before removal: no TOCTOU symlink swap.
        const target = join(sessionsDir, scope)
        const fresh = lstat(target)
        if (fresh.isSymbolicLink() || !fresh.isDirectory()) {
          kept.push({ scope, reason: 'target_changed' })
          continue
        }
        remove(target)
        collected.push({ scope, reason: verdict.reason })
      } catch (error) {
        kept.push({ scope, reason: error?.code ?? 'remove_failed' })
      }
    } else {
      kept.push({ scope, reason: verdict.reason })
    }
  }
  return {
    status: 'ok',
    command,
    lines: [JSON.stringify({
      ok: true,
      command,
      scanned: processed,
      collected,
      kept: kept.length,
      server_confirmed: server.available,
      elapsed_ms: Math.round(now() - nowMs),
    })],
  }
}

export { refusal as gcRefusal, usage as gcUsage }
