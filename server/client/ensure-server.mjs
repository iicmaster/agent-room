// Local bootstrap engine (Story 1.4, FR-1): the zero-config path that makes
// the loopback API host start on demand. It mirrors the ratified v0.1
// ensureDaemon pattern in server/daemon-client.mjs (which stays untouched)
// for the HTTP world: probe for a live server, claim a hardlink startup lock,
// spawn the same server/api/server.mjs binary detached, poll readiness, and
// let the race loser attach through runtime.json — no second server, ever.
//
// Staleness contract: a startup lock is stale after 15 s and reclaimed only
// when its owning pid is dead (via a rename fence, so two reclaimers can
// never both win); a runtime record is reclaimed only when its pid is dead
// AND GET /health against its port is unreachable. A live-but-unhealthy
// server is never killed and never shadowed by a sibling boot. Attach
// requires major-version compatibility. A half-stale record (dead pid,
// agent-room health answering) is reused only after one real end-to-end
// credential exchange against this data dir's local token and keypair — a
// foreign realm's server can never attach — and a port that cleanly answers
// non-agent-room is refused immediately, never signalled.
//
// Declared-remote bootstrap (Story 4.1 review triage): a caller that passes
// connectionMode 'remote' — the api-client's declared
// AGENT_ROOM_CONNECTION_MODE installation — attaches under a different
// credential discipline. The declaration means exactly that the OS-user
// boundary (and its shared local token file) is not this installation's own,
// so this engine never reads or creates the local token file on its behalf,
// and the half-stale reuse proof is the health+version check alone. Every
// credential is presented after attach, on the challenge lane, where the
// answer route gates on the durable enrollment record — a foreign realm's
// server surfaces its refusal there as a coded error instead of being
// screened with a credential this installation must never present.
//
// Failure discipline: a boot that fails after spawning (spawn error, early
// exit, readiness timeout) terminates and reaps the child it owns before the
// lock is released — a failed boot never orphans a half-started server.
//
// The shared data dir is the realm's home (AD-10): the default resolves
// AGENT_ROOM_DATA_DIR or ~/.agent-room and the per-client instance directory
// is never consulted. Every successful return also guarantees the 0600 local
// credential file exists beside runtime.json — after a boot both are present,
// and nothing anywhere creates a room socket file.

import { spawn } from 'node:child_process'
import http from 'node:http'
import {
  closeSync,
  constants,
  fstatSync,
  linkSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

import {
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  SERVER_ATTACH_POLL_MS,
  SERVER_CHILD_REAP_TIMEOUT_MS,
  SERVER_HEALTH_PROBE_MAX_BYTES,
  SERVER_HEALTH_PROBE_TIMEOUT_MS,
  SERVER_STARTUP_LOCK_MAX_BYTES,
  SERVER_STARTUP_LOCK_STALE_MS,
  SERVER_STARTUP_WAIT_MS,
} from '../constants.mjs'
import {
  APP_VERSION,
  AgentRoomRuntimeError,
  ensurePrivateDirectory,
  readJsonFile,
  runtimeRecordPath,
  serverStartupLockPath,
  sharedDataDirectory,
} from '../runtime.mjs'
import { loadOrCreateKeypair } from '../keys.mjs'
import { loadOrCreateLocalToken, readLocalToken } from '../api/local-token.mjs'
import { REMOTE_TRANSPORT } from './trust.mjs'

const DEFAULT_SERVER_PATH = fileURLToPath(new URL('../api/server.mjs', import.meta.url))
const OK_STATUS = 200

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))

// ESRCH means the pid is gone; EPERM means a live process owned by another
// user — either way the holder is not this user's dead record.
function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

// Read and shape-validate the runtime record. An absent, unreadable, or
// malformed record is treated as absent: the boot path overwrites the file
// atomically, so bootstrap self-heals from tampered state.
function readRuntimeRecord(directory) {
  let value
  try {
    value = readJsonFile(runtimeRecordPath(directory))
  } catch {
    return null
  }
  if (
    !value || typeof value !== 'object' ||
    !Number.isInteger(value.pid) || value.pid <= 0 ||
    !Number.isInteger(value.port) || value.port <= 0 || value.port > 65535 ||
    typeof value.version !== 'string' || value.version.length === 0
  ) {
    return null
  }
  return { pid: value.pid, port: value.port, version: value.version }
}

// Attach requires major-version compatibility (no new error code): a record
// from an incompatible server is refused, naming both versions.
function majorOf(version) {
  return Number.parseInt(String(version).split('.')[0], 10)
}

function assertAttachableVersion(record) {
  if (majorOf(record.version) !== majorOf(APP_VERSION)) {
    throw new AgentRoomRuntimeError(
      'server_start_failed',
      `agent-room server ${record.version} is incompatible with client ${APP_VERSION}`,
    )
  }
}

// One GET /health probe against the recorded port, under an overall timeout
// (a trickle responder cannot hang it). The outcome separates unreachable
// (nothing answered cleanly) from reachable-but-not-agent-room — only a
// complete, valid, non-agent-room response proves the latter; mid-response
// socket errors are unreachable (retryable), never proof of foreign.
// Story 2.2: exported for the api-client's reconnect wait — recovery
// detection reuses the exact bounded probe the staleness rules trust,
// read-only (the record plus GET /health, never a boot or a write).
export function probeHealth(port) {
  return new Promise(resolve => {
    let settled = false
    let overall = null
    const finish = outcome => {
      if (settled) return
      settled = true
      clearTimeout(overall)
      resolve(outcome)
    }
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/health',
        method: 'GET',
        timeout: SERVER_HEALTH_PROBE_TIMEOUT_MS,
        agent: false,
      },
      response => {
        const chunks = []
        let total = 0
        response.on('data', chunk => {
          total += chunk.length
          if (total > SERVER_HEALTH_PROBE_MAX_BYTES) {
            response.destroy()
            finish({ reachable: false, agentRoom: false })
            return
          }
          chunks.push(chunk)
        })
        response.on('end', () => {
          let agentRoom = false
          if (response.statusCode === OK_STATUS) {
            try {
              const payload = JSON.parse(Buffer.concat(chunks).toString('utf8'))
              agentRoom = payload?.ok === true && typeof payload?.result?.version === 'string'
            } catch {
              agentRoom = false
            }
          }
          finish({ reachable: true, agentRoom })
        })
        response.on('aborted', () => finish({ reachable: false, agentRoom: false }))
        response.on('error', () => finish({ reachable: false, agentRoom: false }))
      },
    )
    overall = setTimeout(() => request.destroy(), SERVER_HEALTH_PROBE_TIMEOUT_MS)
    request.on('timeout', () => request.destroy())
    request.on('error', () => finish({ reachable: false, agentRoom: false }))
    request.end()
  })
}

// One real credential exchange against the answering server: this data dir's
// local token and installation keypair must authenticate. A successful
// exchange issues a throwaway session in the attached server's registry
// (harmless: it is this dir's own actor credential). Any other answer — 401,
// a different status, a transport failure — is a refusal.
function exchangeLocalCredential(port, localToken, publicKey) {
  return new Promise(resolve => {
    const body = JSON.stringify({ public_key: publicKey })
    const request = http.request(
      {
        host: '127.0.0.1',
        port,
        path: '/api/auth/local',
        method: 'POST',
        agent: false,
        timeout: SERVER_HEALTH_PROBE_TIMEOUT_MS,
        headers: {
          [PROTOCOL_HEADER]: PROTOCOL_VERSION,
          authorization: `Bearer ${localToken}`,
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(body),
        },
      },
      response => {
        response.resume()
        response.on('aborted', () => resolve({ status: 0 }))
        response.on('error', () => resolve({ status: 0 }))
        response.on('end', () => resolve({ status: response.statusCode }))
      },
    )
    request.on('timeout', () => request.destroy())
    request.on('error', () => resolve({ status: 0 }))
    request.end(body)
  })
}

// The half-stale reuse proof: without this dir's credentials being accepted,
// the answering server belongs to another realm — refuse, never attach.
async function proveReuse(directory, port) {
  try {
    const localToken = readLocalToken(directory)
    const { publicKey } = loadOrCreateKeypair(directory)
    const exchange = await exchangeLocalCredential(port, localToken, Buffer.from(publicKey).toString('base64url'))
    if (exchange.status !== OK_STATUS) {
      throw new Error(`the credential exchange answered ${exchange.status || 'no status'}`)
    }
  } catch (error) {
    throw new AgentRoomRuntimeError(
      'server_start_failed',
      `the answering server rejected this data dir's credentials (${error?.message ?? 'exchange failed'})`,
    )
  }
}

// Attach-or-reclaim decision for the current runtime record:
//   absent  — no usable record; a boot may proceed.
//   ready   — a healthy, version-compatible agent-room server answers (a
//             live attach, or the half-stale reuse after the credential
//             proof below).
//   pending — the recorded pid is alive but health is not answering yet;
//             the entry is not stale (staleness needs a dead pid), so the
//             caller waits and never boots a sibling.
//   stale   — dead pid and unreachable health: the record is reclaimed.
// A port that cleanly answers non-agent-room refuses with a coded error
// regardless of the recorded pid's liveness — the foreign process is never
// signalled.
async function inspectRuntimeRecord(directory, { connectionMode } = {}) {
  for (;;) {
    const record = readRuntimeRecord(directory)
    if (!record) return { state: 'absent' }
    const probe = await probeHealth(record.port)
    if (probe.agentRoom) {
      assertAttachableVersion(record)
      if (pidAlive(record.pid)) return { state: 'ready', record }
      // Declared-remote: the reuse proof stops at the health+version check —
      // the credential proof happens after attach, on the challenge lane.
      // proveReuse below would present the shared local token, which a
      // declared-remote installation must never do (the declaration means
      // the OS-user boundary is not its own); a foreign realm's server is
      // refused there instead, as the challenge path's coded error.
      if (connectionMode === REMOTE_TRANSPORT) return { state: 'ready', record }
      await proveReuse(directory, record.port)
      return { state: 'ready', record }
    }
    if (probe.reachable) {
      throw new AgentRoomRuntimeError(
        'server_port_conflict',
        'the recorded server port is held by a process that is not agent-room',
      )
    }
    if (pidAlive(record.pid)) return { state: 'pending' }
    // Fenced reclaim: unlink only when the file still holds exactly the
    // record just judged stale; otherwise re-read and re-evaluate.
    if (runtimeRecordUnchanged(directory, record)) {
      try {
        unlinkSync(runtimeRecordPath(directory))
      } catch {
        // A racing reclaimer won; either way the record is gone or about to be.
      }
      return { state: 'stale' }
    }
  }
}

function runtimeRecordUnchanged(directory, record) {
  const fresh = readRuntimeRecord(directory)
  return fresh !== null
    && fresh.pid === record.pid
    && fresh.port === record.port
    && fresh.version === record.version
}

// Hardlink startup lock, mirrored from the v0.1 pattern: an exclusive-create
// temporary file linked into place (link is atomic), a bounded non-following
// read, and release only by the token that claimed the lock.
function claimServerLock(path, token) {
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

function readServerLock(path) {
  let descriptor
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0),
    )
  } catch (error) {
    if (error?.code === 'ENOENT') throw error // transient mid-race: retry, not fatal
    throw new AgentRoomRuntimeError('server_start_lock_invalid', 'agent-room server start lock is unreadable')
  }
  try {
    const info = fstatSync(descriptor)
    if (!info.isFile() || info.size < 1 || info.size > SERVER_STARTUP_LOCK_MAX_BYTES) {
      throw new AgentRoomRuntimeError(
        'server_start_lock_invalid',
        'agent-room server start lock is not a bounded regular file',
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
      throw new AgentRoomRuntimeError('server_start_lock_invalid', 'agent-room server start lock changed while reading')
    }
    return buffer.toString('utf8')
  } finally {
    closeSync(descriptor)
  }
}

function releaseServerLock(path, token) {
  if (!token) return
  try {
    if (readServerLock(path) !== token) return
    unlinkSync(path)
  } catch {
    // Another starter already cleared or replaced it.
  }
}

function acquireServerLock(path) {
  const token = `${process.pid}:${randomUUID()}`
  if (claimServerLock(path, token)) return token

  let observed
  try {
    observed = readServerLock(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return null // the lock vanished mid-race — retry
    if (error instanceof AgentRoomRuntimeError) throw error
    return null
  }
  try {
    if (Date.now() - statSync(path).mtimeMs <= SERVER_STARTUP_LOCK_STALE_MS) return null
    // Age alone never reclaims: a lock whose owning pid is alive is a live
    // starter no matter how old it looks, so the waiter falls through to the
    // runtime-record attach path instead.
    const separator = observed.indexOf(':')
    const ownerPid = separator > 0 ? Number.parseInt(observed.slice(0, separator), 10) : Number.NaN
    if (Number.isInteger(ownerPid) && ownerPid > 0 && pidAlive(ownerPid)) return null
  } catch {
    return null // the lock vanished mid-decision — retry
  }

  // Rename-fence the reclaim: take the file away atomically, re-verify its
  // contents, and put it back when a newer claim appeared meanwhile — two
  // reclaimers can never both win.
  const fenced = `${path}.${process.pid}.${randomUUID()}.reclaim`
  try {
    renameSync(path, fenced)
  } catch {
    return null // another reclaimer or the owner moved it first — retry
  }
  try {
    if (readServerLock(fenced) !== observed) {
      try { renameSync(fenced, path) } catch { /* its owner already replaced it */ }
      return null
    }
    unlinkSync(fenced)
  } catch (error) {
    try { renameSync(fenced, path) } catch { /* best effort */ }
    if (error instanceof AgentRoomRuntimeError) throw error
    return null
  }
  return claimServerLock(path, token) ? token : null
}

// Every successful return guarantees the local credential exists beside the
// record (boot verification contract: runtime.json plus the 0600 token file).
// A tampered credential file surfaces here as a coded error even though the
// server itself is up — the local path cannot proceed without it. The
// declared-remote mode is the exception by contract: the shared local token
// is not that installation's credential, so nothing is read or created here
// and the challenge lane owns every credential from attach onward.
function returnRecord(directory, record, spawned, { connectionMode } = {}) {
  if (connectionMode !== REMOTE_TRANSPORT) loadOrCreateLocalToken(directory)
  return Object.freeze({
    port: record.port,
    record: Object.freeze({ pid: record.pid, port: record.port, version: record.version }),
    spawned,
  })
}

// The auto-start child's exact environment — the closed whitelist, built by
// this exported pure helper so a test can pin its exact key set: the process
// basics a spawned server needs (PATH, LANG), the data dir under its
// canonical name, and the two operator storage reserves ONLY when set. Every
// other name in the starting process's environment — secrets, unrelated
// AGENT_ROOM_ variables, anything else — stays behind.
export function autoStartChildEnv({ env = process.env, dataDir } = {}) {
  if (typeof dataDir !== 'string' || dataDir.trim().length === 0) {
    throw new AgentRoomRuntimeError('invalid_argument', 'dataDir must be a non-empty path')
  }
  const childEnv = {
    PATH: env?.PATH || '',
    LANG: env?.LANG || 'C.UTF-8',
    AGENT_ROOM_DATA_DIR: dataDir,
  }
  for (const knob of ['AGENT_ROOM_STORAGE_WARN_BYTES', 'AGENT_ROOM_STORAGE_REFUSE_BYTES']) {
    if (env?.[knob] !== undefined) childEnv[knob] = env[knob]
  }
  return childEnv
}

// Race-safe auto-start + attach. Returns { port, record, spawned } — spawned
// tells the adapter which path happened (boot vs attach). Options exist for
// harnesses: dataDir overrides the shared dir (tests), serverPath overrides
// the spawned binary (tests), waitMs bounds every wait, and connectionMode
// ('remote', Story 4.1) attaches under the declared-remote credential
// discipline described in the header — no local-token read or creation, and
// a health+version-only half-stale reuse proof. No caller input ever
// carries a server location, a credential, or a room name — the local path
// discovers everything from the shared data dir.
export async function ensureServer({
  dataDir = sharedDataDirectory(),
  serverPath = DEFAULT_SERVER_PATH,
  waitMs = SERVER_STARTUP_WAIT_MS,
  connectionMode,
} = {}) {
  if (typeof serverPath !== 'string' || serverPath.length === 0) {
    throw new AgentRoomRuntimeError('invalid_argument', 'serverPath must be a non-empty path')
  }
  if (connectionMode !== undefined && connectionMode !== REMOTE_TRANSPORT) {
    throw new AgentRoomRuntimeError(
      'invalid_argument',
      "connectionMode must be undefined or 'remote': 'local' is earned by the local token exchange, never declared",
    )
  }
  if (!Number.isInteger(waitMs) || waitMs <= 0) {
    throw new AgentRoomRuntimeError('invalid_argument', 'waitMs must be a positive integer')
  }
  const directory = ensurePrivateDirectory(dataDir)

  // A directory squatting the runtime-record path can never be bootstrapped
  // over (the atomic rename would fail) — refuse immediately, coded.
  try {
    if (lstatSync(runtimeRecordPath(directory)).isDirectory()) {
      throw new AgentRoomRuntimeError('server_start_failed', 'agent-room runtime record path is a directory')
    }
  } catch (error) {
    if (error instanceof AgentRoomRuntimeError) throw error
    // Absent (or a symlink/other file shape) falls through to the record
    // reader: boot overwrites those safely.
  }

  const deadline = Date.now() + waitMs

  // Phase 1: attach to a healthy recorded server, or prove the record stale.
  let inspection = await inspectRuntimeRecord(directory, { connectionMode })
  if (inspection.state === 'ready') return returnRecord(directory, inspection.record, false, { connectionMode })
  if (inspection.state === 'pending') {
    while (Date.now() < deadline) {
      await delay(SERVER_ATTACH_POLL_MS)
      inspection = await inspectRuntimeRecord(directory, { connectionMode })
      if (inspection.state === 'ready') return returnRecord(directory, inspection.record, false, { connectionMode })
      if (inspection.state !== 'pending') break
    }
    if (inspection.state === 'pending') {
      throw new AgentRoomRuntimeError('server_start_failed', 'agent-room server did not become ready')
    }
  }

  // Phase 2: the hardlink startup lock serializes spawning. The loser waits,
  // polling for the winner's record to attach to, and only times out when no
  // start ever finishes.
  const lockPath = serverStartupLockPath(directory)
  let lockToken = null
  while (Date.now() < deadline) {
    lockToken = acquireServerLock(lockPath)
    if (lockToken) break
    await delay(SERVER_ATTACH_POLL_MS)
    inspection = await inspectRuntimeRecord(directory, { connectionMode })
    if (inspection.state === 'ready') return returnRecord(directory, inspection.record, false, { connectionMode })
  }
  if (!lockToken) {
    throw new AgentRoomRuntimeError('server_start_busy', 'another agent-room server start did not finish')
  }

  try {
    // Lock granted: one final re-check, because a previous starter may have
    // published a healthy record between our last probe and the grant.
    inspection = await inspectRuntimeRecord(directory, { connectionMode })
    if (inspection.state === 'ready') return returnRecord(directory, inspection.record, false, { connectionMode })
    if (inspection.state === 'pending') {
      // A live recorded server owns this realm; it is never shadowed.
      throw new AgentRoomRuntimeError('server_start_failed', 'agent-room server did not become ready')
    }

    // The auto-start child is a direct launch of the same server, so the
    // direct launch's documented AGENT_ROOM_ surfaces ride the whitelist:
    // the data dir always, and the two operator storage reserves (Story 4.6)
    // when set — the starting process's tuning reaches a plugin-managed
    // server exactly as it would a hand-launched one. The knobs are validated
    // inputs, never secret material: the child's own startup re-validates
    // them (a junk value warns once and falls back to the declared default),
    // so nothing a hostile environment puts here can disable the whitelist's
    // hygiene — only these two names pass, and only as opaque strings the
    // child parses strictly. The exact key set is pinned by test through the
    // exported pure helper below.
    const child = spawn(process.execPath, [serverPath], {
      detached: true,
      stdio: 'ignore',
      env: autoStartChildEnv({ env: process.env, dataDir: directory }),
    })
    child.unref()
    let spawnError = null
    child.on('error', error => {
      spawnError = error ?? new Error('spawn failed')
    })

    // Any post-spawn failure terminates and reaps the child this invocation
    // owns before the lock is released — a failed boot never orphans a
    // half-started server.
    const stopOwnedChild = async () => {
      if (!child.pid || child.exitCode !== null || child.signalCode !== null) return
      for (const signal of ['SIGTERM', 'SIGKILL']) {
        try {
          child.kill(signal)
        } catch {
          return
        }
        const giveUpAt = Date.now() + SERVER_CHILD_REAP_TIMEOUT_MS
        while (Date.now() < giveUpAt) {
          try {
            process.kill(child.pid, 0)
          } catch {
            return // gone and reaped
          }
          await delay(SERVER_ATTACH_POLL_MS)
        }
      }
    }

    try {
      while (Date.now() < deadline) {
        if (spawnError) {
          throw new AgentRoomRuntimeError(
            'server_start_failed',
            `agent-room server failed to start (${spawnError.code ?? 'unknown error'})`,
          )
        }
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new AgentRoomRuntimeError('server_start_failed', 'agent-room server exited during startup')
        }
        await delay(SERVER_ATTACH_POLL_MS)
        const record = readRuntimeRecord(directory)
        if (record && record.pid === child.pid) {
          const probe = await probeHealth(record.port)
          if (probe.agentRoom) return returnRecord(directory, record, true, { connectionMode })
        }
      }
      throw new AgentRoomRuntimeError('server_start_failed', 'agent-room server did not become ready')
    } catch (error) {
      await stopOwnedChild()
      throw error
    }
  } finally {
    releaseServerLock(lockPath, lockToken)
  }
}
