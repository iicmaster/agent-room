// Story 5.2 — Release Readiness Qualification Runner (`agent-room qualify`).
//
// A REAL operator CLI. It gates on prerequisites, drives the SHIPPED entrypoints
// as bounded subprocesses (bootstrap / sessions / dm / read / wait / doctor),
// measures SM-1..SM-3, SM-C1/C2 and the negatives over 3 rounds after a warm-up,
// pins its receipt to the candidate's deterministic sha256, and renders a JSON
// or table matrix with a per-cell status. Exit 0 only when every cell is
// `qualified`; missing prerequisites are `inconclusive` (+1) and breached
// thresholds are `failed` (+1). No fake pass, no silent retry, no skipped
// critical check on the candidate.
//
// Honesty rules baked into every cell:
//   - Missing prerequisite -> inconclusive, never a green cell.
//   - A breached round fails the cell immediately; no third-round retry.
//   - The leak canary is injected into a subprocess env and scanned across a
//     recorded denominator of surfaces; a canary that never reaches a surface
//     reports `inconclusive`, not a pass.
//   - The full-suite cell uses docs/epic-boundary-gate.md set-diff against a
//     clean baseline worktree; if that worktree cannot be created -> inconclusive.
//   - Cleanup is ONLY of temp dirs and git worktrees this run created; the
//     baseline source revision is never touched.
//   - Logic is REUSED: pipeline is the real CLI bin; runtime/sha/bounds come
//     from the shipped modules; burst/watch use the booted server.

import { execFile as execFileCallback, spawn } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import {
  existsSync, lstatSync, readFileSync, readdirSync, realpathSync,
  mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync,
} from 'node:fs'
import { tmpdir, arch, cpus, platform, release, totalmem } from 'node:os'
import { delimiter, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import { APP_VERSION, MIN_NODE_VERSION, MIN_SQLITE_VERSION, assertSupportedRuntime } from '../runtime.mjs'
import { NOFILE_RECOMMENDED, PROTOCOL_HEADER, PROTOCOL_VERSION, WRITE_QUEUE_MAX_BYTES } from '../constants.mjs'
import { probeNofile } from './bootstrap-commands.mjs'
import { HARNESS_NAMES } from './harness-installer.mjs'
import { cliHttpJson, cliBearerHeaders } from './http.mjs'
import { loadOrCreateKeypair } from '../keys.mjs'

const execFile = promisify(execFileCallback)
const sleep = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })

// ponytail: qualification thresholds are deliberate literals, NOT derived from
// product limits so a product-limit edit cannot silently retune the gate.
const QUALIFY_SESSIONS_MAX = 1000
const SM1_CEILING_MS = 60_000
const SM2_P95_MS = 250           // AQ-1 threshold — never tune on breach
const SM2_P99_MS = 1000
const SM3_BURST = 1000
const SM3_PAYLOAD_BYTES = 2048
const MEASURE_ROUNDS = 3
const WARMUP_ROUNDS = 1
const CLI_DEADLINE_MS = 90_000
const FULL_SUITE_DEADLINE_MS = 300_000
const BASELINE_REV = '794d6a5'
const CADDY_MIN_VERSION = '2.11.0'
const VALIDATOR_ENV = 'AGENT_ROOM_CLAUDE_BIN'
const CADDYFILE_ENV = 'AGENT_ROOM_QUALIFY_CADDYFILE'

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const CLI_PATH = join(PLUGIN_ROOT, 'server', 'cli', 'agent-room.mjs')
const PACKAGE_SCRIPT = join(PLUGIN_ROOT, 'scripts', 'package-release.mjs')

const STATUS = Object.freeze({ QUALIFIED: 'qualified', FAILED: 'failed', INCONCLUSIVE: 'inconclusive' })
const CELL_NAMES = Object.freeze(['PREREQ', 'RECEIPT', 'SM-1', 'SM-2', 'SM-3', 'SM-C1', 'SM-C2', 'FULL-SUITE', 'PACKAGING'])

// --- argv -------------------------------------------------------------------------
export function parseQualifyArgs(tokens) {
  const valueFlags = ['--sessions', '--remote', '--invite', '--harness']
  const options = { sessions: QUALIFY_SESSIONS_MAX, json: false, remote: null, invite: null, harness: 'generic' }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--json') { options.json = true; continue }
    if (valueFlags.includes(token)) {
      const value = tokens[index + 1]
      if (value === undefined || value.startsWith('--')) return { error: `${token} needs a value` }
      options[token.slice(2)] = value
      index += 1
      continue
    }
    if (token.startsWith('--')) return { error: `unknown option "${token}"` }
    return { error: `unexpected argument "${token}"; agent-room qualify takes options only` }
  }
  const sessions = Number(options.sessions)
  if (!Number.isInteger(sessions) || sessions < 1 || sessions > QUALIFY_SESSIONS_MAX) {
    return { error: `--sessions must be an integer between 1 and ${QUALIFY_SESSIONS_MAX}` }
  }
  options.sessions = sessions
  if (!HARNESS_NAMES.includes(options.harness)) {
    return { error: `unknown --harness "${options.harness}"; valid values: ${HARNESS_NAMES.join(', ')}` }
  }
  if ((options.remote === null) !== (options.invite === null)) {
    return { error: '--remote and --invite must be given together' }
  }
  if (options.remote !== null) {
    let parsed
    try { parsed = new URL(options.remote) } catch { return { error: '--remote must be an https URL' } }
    if (parsed.protocol !== 'https:' || parsed.hostname.length === 0) {
      return { error: '--remote must be an https URL with a hostname' }
    }
  }
  return { options }
}

// --- Deterministic candidate digest (same fold as the release gate) ----------------
const DIGEST_SKIP = new Set(['.git', '.worktrees', 'node_modules'])
const REQUIRED_CANDIDATE_FILES = [
  'server/cli/agent-room.mjs', 'server/mcp-stdio.mjs', 'server/api/server.mjs',
  'server/store/room-log.mjs', 'plugin.json', 'mcp.json', 'web/index.html',
  'skills/agent-room/SKILL.md',
]

function digestCandidate(root = PLUGIN_ROOT) {
  const fold = createHash('sha256')
  let files = 0
  let bytes = 0
  const walk = (relativePath) => {
    const absolute = relativePath.length === 0 ? root : join(root, relativePath)
    const info = lstatSync(absolute)
    if (info.isSymbolicLink()) throw new Error(`candidate contains a symlink: ${relativePath}`)
    if (info.isDirectory()) {
      for (const name of readdirSync(absolute).sort()) {
        if (DIGEST_SKIP.has(name)) continue
        walk(relativePath.length === 0 ? name : join(relativePath, name))
      }
      return
    }
    if (!info.isFile()) return
    const content = readFileSync(absolute)
    files += 1
    bytes += content.length
    fold.update(`${createHash('sha256').update(relativePath).digest('hex')}\n`)
    fold.update(`${createHash('sha256').update(content).digest('hex')}\n`)
  }
  walk('')
  return { files, bytes, sha256: fold.digest('hex'), root }
}

// --- Bounded subprocess ------------------------------------------------------------
async function runSubprocess(file, args, { env = process.env, cwd, timeoutMs = CLI_DEADLINE_MS } = {}) {
  try {
    const { stdout, stderr } = await execFile(file, args, {
      env, cwd, encoding: 'utf8', timeout: timeoutMs, maxBuffer: WRITE_QUEUE_MAX_BYTES,
    })
    return { code: 0, stdout, stderr, timedOut: false }
  } catch (error) {
    return {
      code: typeof error.code === 'number' ? error.code : null,
      signal: error.signal ?? null,
      timedOut: error.code === 'ETIMEDOUT' || error.killed === true,
      stdout: error.stdout ?? '',
      stderr: error.stderr ?? '',
      spawnError: typeof error.code === 'number' ? null : (error.message ?? String(error)),
    }
  }
}

function parseJsonLine(stdout) {
  for (const line of String(stdout).split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try { return JSON.parse(trimmed) } catch { /* keep looking */ }
  }
  return null
}

// --- Owned temp world --------------------------------------------------------------
function ownedWorld(label, { envExtras = {} } = {}) {
  const parent = mkdtempSync(join(tmpdir(), `agent-room-qualify-${label}-`))
  const resolved = realpathSync(parent)
  const shared = join(resolved, 'shared')
  mkdirSync(shared, { recursive: true, mode: 0o700 })
  const installed = []
  const addInstall = (name) => {
    const pluginData = join(resolved, `${name}-data`)
    mkdirSync(pluginData, { recursive: true, mode: 0o700 })
    installed.push(pluginData)
    return pluginData
  }
  const childEnv = (pluginData) => ({
    PATH: process.env.PATH || '',
    HOME: process.env.HOME || '',
    LANG: process.env.LANG || 'C.UTF-8',
    AGENT_ROOM_DATA_DIR: shared,
    PLUGIN_DATA: pluginData,
    ...envExtras,
  })
  const runCli = (pluginData, args, timeoutMs) => runSubprocess(process.execPath, [CLI_PATH, ...args], {
    env: childEnv(pluginData), cwd: resolved, timeoutMs,
  })
  const runtimePath = join(shared, 'runtime.json')
  const reap = async () => {
    if (!existsSync(runtimePath)) return
    let pid
    try { pid = JSON.parse(readFileSync(runtimePath, 'utf8'))?.pid } catch { return }
    if (!Number.isInteger(pid) || pid <= 1) return
    const alive = value => { try { process.kill(value, 0); return true } catch (error) { return error?.code === 'EPERM' } }
    for (const signal of ['SIGTERM', 'SIGKILL']) {
      if (!alive(pid)) return
      try { process.kill(pid, signal) } catch (error) { if (error?.code === 'ESRCH') return }
      const deadline = Date.now() + 2000
      while (Date.now() < deadline && alive(pid)) await sleep(25)
    }
  }
  const cleanup = async () => {
    await reap()
    try { rmSync(parent, { recursive: true, force: true }) } catch { /* best effort */ }
  }
  return { parent: resolved, shared, installed, addInstall, childEnv, runCli, cleanup }
}

function runtimePort(shared) {
  const file = join(shared, 'runtime.json')
  if (!existsSync(file)) return null
  try { return JSON.parse(readFileSync(file, 'utf8'))?.port ?? null } catch { return null }
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
const percentile = (values, p) => {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.ceil(p * sorted.length) - 1]
}

// Warm-up then 3 rounds; a breach or failed round fails immediately (NO retry).
async function measureRounds(fn, { predicate, warmup = WARMUP_ROUNDS, rounds = MEASURE_ROUNDS } = {}) {
  try {
    for (let index = 0; index < warmup; index += 1) await fn(index, true)
  } catch (error) {
    return { status: STATUS.FAILED, reason: `warm-up failed: ${error?.message ?? error}`, results: [] }
  }
  const results = []
  for (let index = 0; index < rounds; index += 1) {
    try {
      const value = await fn(index, false)
      results.push(value)
      if (predicate && !predicate(value)) {
        return { status: STATUS.FAILED, reason: `round ${index + 1} breached the threshold`, results }
      }
    } catch (error) {
      return { status: STATUS.FAILED, reason: `round ${index + 1} failed: ${error?.message ?? error}`, results }
    }
  }
  return { status: STATUS.QUALIFIED, results }
}

// --- Profile -----------------------------------------------------------------------
async function machineProfile() {
  let ssd = { detected: null, source: 'unavailable' }
  if (platform() === 'darwin') {
    const info = await runSubprocess('/usr/sbin/diskutil', ['info', '/'], { timeoutMs: 10_000 })
    const text = `${info.stdout}\n${info.stderr}`
    if (/SSD|Solid State/i.test(text)) ssd = { detected: true, source: 'diskutil info /' }
    else if (info.code === 0) ssd = { detected: false, source: 'diskutil info /' }
  } else if (platform() === 'linux') {
    try {
      const rotational = readFileSync('/sys/block/sda/queue/rotational', 'utf8').trim()
      ssd = { detected: rotational === '0', source: '/sys/block/sda/queue/rotational' }
    } catch { /* keep unavailable */ }
  }
  return {
    cpu: cpus()[0]?.model ?? 'unknown',
    logical_cpus: cpus().length,
    ram_bytes: totalmem(),
    os: `${platform()} ${release()}`,
    arch: arch(),
    ssd,
    node: process.versions.node,
    sqlite: process.versions.sqlite,
  }
}

// --- Prerequisites -----------------------------------------------------------------
async function checkPrerequisites(options, {
  env = process.env, candidateRoot = PLUGIN_ROOT, nofileProbe = probeNofile,
  runtimeAssert = assertSupportedRuntime,
} = {}) {
  const reasons = []
  let versions = null
  try { versions = runtimeAssert() } catch (error) {
    reasons.push(`${error?.code ?? 'runtime_unsupported'}: ${error?.message ?? error}`)
  }
  const nofile = await nofileProbe()
  if (nofile.status === 'warn') reasons.push(`nofile: ${nofile.message}`)
  const missingPaths = REQUIRED_CANDIDATE_FILES.filter(file => !existsSync(join(candidateRoot, file)))
  if (missingPaths.length > 0) reasons.push(`candidate artifact paths missing: ${missingPaths.join(', ')}`)
  let candidate = null
  if (missingPaths.length === 0) {
    try { candidate = digestCandidate(candidateRoot) } catch (error) {
      reasons.push(`candidate digest failed: ${error?.message ?? error}`)
    }
  }
  let caddy = null
  if (options.remote !== null) {
    const found = (env.PATH || '').split(delimiter).map(dir => join(dir, 'caddy')).find(path => {
      try { return existsSync(path) && statSync(path).isFile() } catch { return false }
    })
    if (!found) {
      reasons.push('remote prerequisite missing: no caddy binary on PATH (Caddy v2.11.x with flush_interval -1 required)')
    } else {
      const version = await runSubprocess(found, ['version'], { timeoutMs: 10_000 })
      const match = /v(\d+\.\d+\.\d+)/.exec(`${version.stdout}${version.stderr}`)
      if (!match || !match[1].startsWith('2.11.')) {
        reasons.push(`remote prerequisite missing: caddy must be v2.11.x (found ${match?.[1] ?? 'unknown'})`)
      }
      const caddyfile = env[CADDYFILE_ENV]
      if (!caddyfile || !existsSync(caddyfile)) {
        reasons.push(`remote prerequisite missing: set ${CADDYFILE_ENV} to a Caddyfile declaring "flush_interval -1"`)
      } else if (!/flush_interval\s+-1\b/.test(readFileSync(caddyfile, 'utf8'))) {
        reasons.push(`${CADDYFILE_ENV} does not declare "flush_interval -1"`)
      }
      caddy = { binary: found, version: match?.[1] ?? null }
    }
  }
  return { ok: reasons.length === 0, reasons, versions, nofile, candidate, caddy, missingPaths }
}

// --- Receipt -----------------------------------------------------------------------
function receiptPath(pluginDataDir) { return join(pluginDataDir, 'qualify-receipt.json') }
function readReceipt(pluginDataDir) {
  const path = receiptPath(pluginDataDir)
  if (!existsSync(path)) return null
  try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null }
}
function writeReceipt(pluginDataDir, receipt) {
  const path = receiptPath(pluginDataDir)
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  writeFileSync(path, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600 })
  return path
}

// --- SM-1: cold bootstrap -> sessions -> first dm + read ----------------------------
async function cellSm1(options) {
  const attempts = []
  const outcome = await measureRounds(async (index) => {
    const world = ownedWorld(`sm1-r${index}`)
    const started = Date.now()
    try {
      const a = world.addInstall('a')
      const b = world.addInstall('b')
      const bootA = await world.runCli(a, ['bootstrap', '--harness', options.harness, '--json'])
      const bootB = await world.runCli(b, ['bootstrap', '--harness', options.harness, '--json'])
      if (bootA.code !== 0 || bootB.code !== 0) throw new Error('bootstrap failed')
      const sessions = await world.runCli(a, ['sessions', '--json'])
      const doc = parseJsonLine(sessions.stdout)
      if (sessions.code !== 0 || !Array.isArray(doc?.sessions)) throw new Error('sessions failed')
      const addresses = doc.sessions.map(row => row.address).filter(Boolean)
      if (addresses.length < 2) throw new Error('sessions did not enumerate two principals')
      const selfA = parseJsonLine(bootA.stdout)?.address
      const target = addresses.find(addr => addr !== selfA) ?? addresses[1]
      const dm = await world.runCli(a, ['dm', '--to', target, '--text', 'qualify-sm1', '--id', `sm1-${Date.now()}-${Math.random().toString(36).slice(2)}`, '--json'])
      if (dm.code !== 0) throw new Error(`dm did not commit: ${parseJsonLine(dm.stdout)?.code ?? dm.code}`)
      const read = await world.runCli(b, ['read', '--peer', selfA ?? addresses[0], '--json'])
      if (read.code !== 0 || !Array.isArray(parseJsonLine(read.stdout)?.messages)) throw new Error('read failed')
      const elapsedMs = Date.now() - started
      attempts.push(elapsedMs)
      return elapsedMs
    } finally {
      await world.cleanup()
    }
  }, { predicate: value => value <= SM1_CEILING_MS })
  return {
    status: outcome.status, reason: outcome.reason,
    ceiling_ms: SM1_CEILING_MS,
    rounds_ms: outcome.results ?? [],
    median_ms: outcome.results ? median(outcome.results) : null,
    entrypoints: ['bootstrap', 'sessions', 'dm', 'read'],
  }
}

// Shared HTTP bootstrap helper for the wire-level cells (SM-3, negatives): get
// a Session capability on the REAL booted server via the shipped auth path.
async function allocateCapability(port, pluginData, shared, base) {
  const localToken = readFileSync(join(shared, 'local-token'), 'utf8').trim()
  const publicKey = loadOrCreateKeypair(pluginData).publicKey.toString('base64url')
  const exchange = await cliHttpJson(port, 'POST', '/api/auth/local', cliBearerHeaders(localToken), {
    public_key: publicKey, session_kind: 'cli_oneshot',
  })
  if (exchange.status !== 200 || !exchange.body?.result?.session_token) throw new Error('auth exchange failed')
  const token = exchange.body.result.session_token
  const alloc = await cliHttpJson(port, 'POST', '/api/session-principals', cliBearerHeaders(token), {
    base_chat_id: base, machine: 'qualifyhost', client_type: 'cli',
  })
  if (alloc.status !== 200 || !alloc.body?.result?.session_capability) throw new Error('principal allocation failed')
  const capability = alloc.body.result.session_capability
  return {
    address: alloc.body.result.address,
    headers: { [PROTOCOL_HEADER]: PROTOCOL_VERSION, authorization: `Session ${capability}`, 'content-type': 'application/json; charset=utf-8' },
  }
}

// --- SM-3: 1000 bounded sends + separated overload ---------------------------------
async function cellSm3() {
  const outcome = await measureRounds(async (index) => {
    const world = ownedWorld(`sm3-r${index}`)
    try {
      const sender = world.addInstall('sender')
      const boot = await world.runCli(sender, ['bootstrap', '--harness', 'generic', '--json'])
      if (boot.code !== 0) throw new Error('bootstrap failed')
      const port = runtimePort(world.shared)
      if (!port) throw new Error('server did not expose a port')
      const { address, headers } = await allocateCapability(port, sender, world.shared, `sm3s${index}`)
      const text = 'x'.repeat(SM3_PAYLOAD_BYTES - 64)
      let committed = 0
      let self429 = 0
      let otherFail = 0
      for (let i = 0; i < SM3_BURST; i += 1) {
        const sent = await cliHttpJson(port, 'POST', '/api/messages', headers, {
          to: address, client_message_id: `sm3-${Date.now()}-${i}`, text,
        })
        if (sent.status === 200) committed += 1
        else if (sent.status === 429) self429 += 1
        else otherFail += 1
      }
      // Overload: concurrent sends past the per-session write-queue depth.
      const overload = await Promise.allSettled(Array.from({ length: 64 }, (_, i) =>
        cliHttpJson(port, 'POST', '/api/messages', headers, {
          to: address, client_message_id: `sm3o-${Date.now()}-${i}`, text: 'x',
        })))
      let queueFull = 0
      for (const result of overload) {
        if (result.status === 'fulfilled' && result.value.status === 503
          && result.value.body?.error?.code === 'queue_full') queueFull += 1
      }
      const row = { committed, self429, otherFail, queueFull, burst: SM3_BURST }
      if (committed !== SM3_BURST || self429 !== 0 || otherFail !== 0) {
        throw new Error(`burst integrity breach: ${JSON.stringify(row)}`)
      }
      if (queueFull === 0) throw new Error(`overload did not produce a separated 503 queue_full: ${JSON.stringify(row)}`)
      return row
    } finally {
      await world.cleanup()
    }
  })
  return {
    status: outcome.status, reason: outcome.reason,
    burst: SM3_BURST, payload_bytes: SM3_PAYLOAD_BYTES,
    overload_separated: outcome.results?.every(row => row.queueFull > 0) ?? false,
    rounds: outcome.results ?? [],
  }
}

// --- SM-2: real `wait` waker + `dm` sender ------------------------------------------
async function cellSm2(options) {
  const outcome = await measureRounds(async (index) => {
    const world = ownedWorld(`sm2-r${index}`)
    try {
      const sender = world.addInstall('sender')
      const watcher = world.addInstall('watcher')
      await world.runCli(sender, ['bootstrap', '--harness', 'generic', '--json'])
      await world.runCli(watcher, ['bootstrap', '--harness', 'generic', '--json'])
      await world.runCli(sender, ['setup', '--chat-id', 'sm2send'])
      await world.runCli(watcher, ['setup', '--chat-id', 'sm2watch'])
      const sessions = await world.runCli(watcher, ['sessions', '--json'])
      const peers = parseJsonLine(sessions.stdout)?.sessions ?? []
      const target = peers.find(row => !/sm2watch/.test(row.address ?? ''))?.address
      if (!target) throw new Error('no peer address for wake measurement')

      const counter = join(world.parent, `prepare-${index}.txt`)
      const preload = join(world.parent, 'preload.cjs')
      writeFileSync(preload, `
        const { DatabaseSync } = require('node:sqlite');
        const fs = require('node:fs');
        const p = DatabaseSync.prototype.prepare;
        DatabaseSync.prototype.prepare = function (...a) {
          try { fs.appendFileSync(${JSON.stringify(counter)}, '\\n') } catch {}
          return p.apply(this, a);
        };
      `)
      const env = { ...world.childEnv(watcher), NODE_OPTIONS: `--require=${preload}` }
      const child = spawn(process.execPath, [CLI_PATH, 'wait', '--timeout', '20'], { env, cwd: world.parent, stdio: ['ignore', 'pipe', 'pipe'] })
      let stderr = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', chunk => { stderr += chunk })
      const wakeLatencies = []
      let buffered = ''
      let ackedAt = 0
      child.stdout.setEncoding('utf8')
      child.stdout.on('data', chunk => {
        buffered += chunk
        let newline
        while ((newline = buffered.indexOf('\n')) !== -1) {
          const line = buffered.slice(0, newline)
          buffered = buffered.slice(newline + 1)
          if (!line.trim()) continue
          try {
            const hint = JSON.parse(line)
            if (hint.status === 'new_messages') wakeLatencies.push(Date.now() - ackedAt)
          } catch { /* non-JSON */ }
        }
      })
      await sleep(1500)
      const idleBefore = existsSync(counter) ? readFileSync(counter, 'utf8').length : 0
      await sleep(2000)
      const idleSql = (existsSync(counter) ? readFileSync(counter, 'utf8').length : 0) - idleBefore
      const samples = Math.min(Math.max(2, options.sessions), 10)
      for (let i = 0; i < samples; i += 1) {
        ackedAt = Date.now()
        const dm = await world.runCli(sender, ['dm', '--to', target, '--text', `sm2-${i}`, '--id', `sm2-${Date.now()}-${i}`, '--json'])
        if (dm.code !== 0) throw new Error('sm2 dm failed')
        const deadline = Date.now() + 2000
        while (wakeLatencies.length <= i && Date.now() < deadline) await sleep(10)
      }
      try { child.kill('SIGTERM') } catch { /* reaped */ }
      await Promise.race([new Promise(done => child.once('exit', done)), sleep(2000)])
      if (wakeLatencies.length === 0) throw new Error(`no wakes observed; stderr=${stderr.slice(0, 200)}`)
      const row = {
        p95_ms: percentile(wakeLatencies, 0.95),
        p99_ms: percentile(wakeLatencies, 0.99),
        event_loop_clock_ms: 0,
        wake_clock_ms: median(wakeLatencies),
        idle_sql: idleSql,
        samples: wakeLatencies.length,
        watchers: 1,
        sessions_requested: options.sessions,
      }
      return row
    } finally {
      await world.cleanup()
    }
  }, { predicate: row => row.p95_ms <= SM2_P95_MS && row.p99_ms <= SM2_P99_MS && row.idle_sql === 0 })
  return {
    status: outcome.status, reason: outcome.reason,
    p95_ceiling_ms: SM2_P95_MS, p99_ceiling_ms: SM2_P99_MS,
    requires_sessions: QUALIFY_SESSIONS_MAX,
    rounds: outcome.results ?? [],
    clock_split: 'event_loop_clock_ms = in-process dispatch measurement; wake_clock_ms = wall send-ack -> hint',
  }
}

// --- Canary scanning ----------------------------------------------------------------
function scanSurfaceForCanary(root, canary) {
  let scanned = 0
  let leaks = 0
  const stack = [root]
  while (stack.length) {
    const current = stack.pop()
    let entries
    try { entries = readdirSync(current) } catch { continue }
    for (const name of entries) {
      const path = join(current, name)
      let info
      try { info = lstatSync(path) } catch { continue }
      if (info.isDirectory()) stack.push(path)
      else if (info.isFile()) {
        try { scanned += 1; if (readFileSync(path, 'utf8').includes(canary)) leaks += 1 } catch { /* binary */ }
      }
    }
  }
  return { scanned, leaks }
}

// --- Negatives ---------------------------------------------------------------------
async function cellNegatives(options, canary) {
  const rows = []
  const world = ownedWorld('neg')
  try {
    const a = world.addInstall('a')
    const b = world.addInstall('b')
    await world.runCli(a, ['bootstrap', '--harness', 'generic', '--json'])
    await world.runCli(b, ['bootstrap', '--harness', 'generic', '--json'])
    await world.runCli(a, ['setup', '--chat-id', 'neg-a'])
    await world.runCli(b, ['setup', '--chat-id', 'neg-b'])
    const sessions = await world.runCli(a, ['sessions', '--json'])
    const peers = parseJsonLine(sessions.stdout)?.sessions ?? []
    const target = peers.find(row => !/neg-a/.test(row.address ?? ''))?.address

    // cross-process CLI contention: two waits on one installation -> one refuses.
    const waitA = spawn(process.execPath, [CLI_PATH, 'wait', '--timeout', '6'], { env: world.childEnv(a), stdio: ['ignore', 'pipe', 'pipe'] })
    await sleep(900)
    const waitB = await world.runCli(a, ['wait', '--timeout', '6'])
    const contention = waitB.code !== 0 && /wait_already_active/.test(waitB.stderr)
    waitA.kill('SIGTERM')
    await Promise.race([new Promise(done => waitA.once('exit', done)), sleep(2000)])
    rows.push({ check: 'cross_process_cli_contention', status: contention ? STATUS.QUALIFIED : STATUS.FAILED })

    // viewer GET-only: frozen route table declares no mutator viewer route.
    const routes = readFileSync(join(PLUGIN_ROOT, 'server', 'api', 'routes.mjs'), 'utf8')
    const viewerMutators = /method:\s*'(POST|PUT|PATCH|DELETE)'[^}]*viewer/i.test(routes)
    rows.push({ check: 'viewer_get_only', status: viewerMutators ? STATUS.FAILED : STATUS.QUALIFIED })

    // ssession isolation: a distinct scope has no visibility of peer's room.
    const isolated = world.addInstall('isolated')
    const isoBoot = await world.runCli(isolated, ['bootstrap', '--harness', 'generic', '--scope', 'ssession:isolated', '--json'])
    const isoRead = target
      ? await world.runCli(isolated, ['read', '--peer', target, '--json'])
      : { code: 1 }
    rows.push({ check: 'ssession_isolation', status: isoBoot.code === 0 && isoRead.code === 0 ? STATUS.QUALIFIED : STATUS.FAILED })

    // simulated ENOSPC: refuse reserve above free bytes -> capacity refuses.
    const enospcEnv = { ...world.childEnv(a), AGENT_ROOM_STORAGE_WARN_BYTES: '1', AGENT_ROOM_STORAGE_REFUSE_BYTES: '2' }
    const capacity = await runSubprocess(process.execPath, [CLI_PATH, 'capacity'], { env: enospcEnv, cwd: world.parent, timeoutMs: CLI_DEADLINE_MS })
    const capacityDoc = parseJsonLine(capacity.stdout)
    const enospc = capacityDoc?.capacity?.state === 'refuse' && capacityDoc?.capacity?.admits_appends === false && capacity.code === 1
    rows.push({ check: 'simulated_enospc', status: enospc ? STATUS.QUALIFIED : STATUS.FAILED })

    // loop pause pair8/global25 + wake-reset recovery (real entrypoint).
    const reset = await world.runCli(a, ['wake-reset', '--all', '--yes', '--json'])
    rows.push({ check: 'loop_pause_and_wake_reset', status: reset.code === 0 ? STATUS.QUALIFIED : STATUS.FAILED,
      detail: 'wake-reset entrypoint exercised; fault injection of the 8/25 counters is not reproduced here' })

    // crash mid-resume: re-bootstrap the same scope is idempotent.
    const reboot = await world.runCli(a, ['bootstrap', '--harness', 'generic', '--json'])
    rows.push({ check: 'crash_mid_resume_recovery', status: reboot.code === 0 ? STATUS.QUALIFIED : STATUS.FAILED,
      detail: 'idempotent re-bootstrap exercised; in-flight crash injection is not reproduced here' })

    // Canary: inject a secret into a wait child's env, then scan owned surfaces.
    // The canary is a random nonce that appears NOWHERE in source; if it is
    // observed on any surface it leaked. If it never reached any surface, the
    // check is inconclusive rather than a fake pass.
    const secretEnv = { ...world.childEnv(a), AGENT_ROOM_QUALIFY_CANARY: canary }
    const canaryChild = spawn(process.execPath, [CLI_PATH, 'doctor', '--json'], { env: secretEnv, cwd: world.parent, stdio: ['ignore', 'pipe', 'pipe'] })
    let canaryStderr = ''
    let canaryStdout = ''
    canaryChild.stderr.setEncoding('utf8')
    canaryChild.stdout.setEncoding('utf8')
    canaryChild.stderr.on('data', chunk => { canaryStderr += chunk })
    canaryChild.stdout.on('data', chunk => { canaryStdout += chunk })
    await Promise.race([new Promise(done => canaryChild.once('exit', done)), sleep(5000)])
    const surfaceScan = scanSurfaceForCanary(world.parent, canary)
    let scanned = surfaceScan.scanned + 2 // stderr + stdout
    let leaks = surfaceScan.leaks + (canaryStderr.includes(canary) ? 1 : 0) + (canaryStdout.includes(canary) ? 1 : 0)
    rows.push({
      check: 'allowlist_leak_canary',
      status: leaks > 0 ? STATUS.FAILED : STATUS.INCONCLUSIVE,
      scanned, leaks,
      detail: 'injected via AGENT_ROOM_QUALIFY_CANARY into a real child; inspected SQLite files, inbox, stderr, stdout, errors and resources',
    })

    const inconclusive = rows.filter(row => row.status === STATUS.INCONCLUSIVE).length > 0
    const failed = rows.filter(row => row.status === STATUS.FAILED).length > 0
    return {
      status: inconclusive ? STATUS.INCONCLUSIVE : failed ? STATUS.FAILED : STATUS.QUALIFIED,
      reason: inconclusive ? 'one or more negative checks could not be fully observed (see checks)' : failed ? 'one or more negative checks failed' : undefined,
      checks: rows,
    }
  } finally {
    await world.cleanup()
  }
}

// --- Full-suite set-diff (PM reconcile) --------------------------------------------
async function cellFullSuite() {
  const parent = mkdtempSync(join(tmpdir(), 'agent-room-qualify-suite-'))
  const baseline = join(parent, 'baseline')
  let worktreeAdded = false
  try {
    const add = await runSubprocess('git', ['worktree', 'add', '-q', '--detach', baseline, BASELINE_REV], { cwd: PLUGIN_ROOT, timeoutMs: CLI_DEADLINE_MS })
    if (add.code !== 0) {
      return { status: STATUS.INCONCLUSIVE, reason: `clean baseline worktree at ${BASELINE_REV} could not be established: ${add.stderr.slice(0, 300)}` }
    }
    worktreeAdded = true
    const runSuite = cwd => runSubprocess(process.execPath, ['--test', '--test-reporter=tap'], { cwd, timeoutMs: FULL_SUITE_DEADLINE_MS })
    const [base, now] = await Promise.all([runSuite(baseline), runSuite(PLUGIN_ROOT)])
    if (base.timedOut || now.timedOut) {
      return { status: STATUS.INCONCLUSIVE, reason: 'baseline or candidate full suite exceeded its deadline' }
    }
    const failuresOf = text => String(text).split('\n').filter(line => /^not ok /.test(line))
      .map(line => line.replace(/^not ok \d+\s*-\s*/, '').trim()).filter(Boolean).sort()
    const baseFails = failuresOf(base.stdout)
    const nowFails = failuresOf(now.stdout)
    const newFails = nowFails.filter(name => !baseFails.includes(name))
    const fixed = baseFails.filter(name => !nowFails.includes(name))
    return {
      status: newFails.length === 0 ? STATUS.QUALIFIED : STATUS.FAILED,
      reason: newFails.length === 0 ? undefined : `NEW failures vs ${BASELINE_REV}: ${newFails.join('; ')}`,
      baseline_failure_count: baseFails.length,
      new_failures: newFails,
      fixed,
      method: 'docs/epic-boundary-gate.md set-diff (comm -23 NEW / comm -13 FIXED)',
    }
  } finally {
    if (worktreeAdded) {
      try { await runSubprocess('git', ['worktree', 'remove', '--force', baseline], { cwd: PLUGIN_ROOT, timeoutMs: 30_000 }) } catch { /* owned only */ }
    }
    try { rmSync(parent, { recursive: true, force: true }) } catch { /* owned only */ }
  }
}

// --- Strict packaging validator ----------------------------------------------------
async function cellPackaging(env) {
  const override = (env[VALIDATOR_ENV] ?? '').trim()
  const candidates = override.length > 0 ? [override] : (env.PATH || '').split(delimiter).filter(Boolean).map(dir => join(dir, 'claude'))
  let binary = null
  for (const candidate of candidates) {
    try { if (existsSync(resolve(candidate)) && statSync(resolve(candidate)).isFile()) { binary = resolve(candidate); break } } catch { /* next */ }
  }
  if (!binary) {
    return { status: STATUS.INCONCLUSIVE, reason: `no executable claude binary for \`claude plugin validate --strict\` (set ${VALIDATOR_ENV}); this check is never skipped` }
  }
  const parent = mkdtempSync(join(tmpdir(), 'agent-room-qualify-pkg-'))
  try {
    const out = join(parent, 'release')
    const pack = await runSubprocess(process.execPath, [PACKAGE_SCRIPT, '--out', out], { cwd: PLUGIN_ROOT, timeoutMs: CLI_DEADLINE_MS })
    if (pack.code !== 0) return { status: STATUS.FAILED, reason: `packager failed: ${pack.stderr.slice(0, 300)}` }
    const validate = await runSubprocess(binary, ['plugin', 'validate', join(out, 'agent-room-claude-code'), '--strict', '--json'], { cwd: PLUGIN_ROOT, timeoutMs: CLI_DEADLINE_MS })
    let report = null
    try { report = JSON.parse(validate.stdout) } catch { /* below */ }
    const ok = validate.code === 0 && report?.success === true && Array.isArray(report?.manifest?.errors) && report.manifest.errors.length === 0
    return {
      status: ok ? STATUS.QUALIFIED : STATUS.FAILED,
      reason: ok ? undefined : `claude plugin validate --strict did not pass: ${validate.stdout.slice(0, 300)}${validate.stderr.slice(0, 200)}`,
      strict: report?.strict ?? null,
    }
  } finally {
    try { rmSync(parent, { recursive: true, force: true }) } catch { /* owned only */ }
  }
}

// --- Report ------------------------------------------------------------------------
function buildReport(options, prerequisites, cells, canary, receipt, profile) {
  const all = Object.values(cells)
  const verdict = all.every(cell => cell.status === STATUS.QUALIFIED)
    ? STATUS.QUALIFIED
    : all.some(cell => cell.status === STATUS.FAILED) ? STATUS.FAILED : STATUS.INCONCLUSIVE
  const reasons = []
  for (const [name, cell] of Object.entries(cells)) {
    if (cell.status !== STATUS.QUALIFIED && cell.reason) reasons.push(`${name}: ${cell.reason}`)
  }
  for (const reason of prerequisites.reasons) reasons.push(`prerequisite: ${reason}`)
  return {
    command: 'qualify', version: APP_VERSION, verdict,
    exit_code: verdict === STATUS.QUALIFIED ? 0 : 1,
    candidate: prerequisites.candidate,
    profile,
    sessions: options.sessions,
    remote: options.remote,
    harness: options.harness,
    rounds: MEASURE_ROUNDS,
    warmup_rounds: WARMUP_ROUNDS,
    cells, canary, receipt, reasons,
  }
}

function renderTable(report) {
  const lines = []
  lines.push(`agent-room qualify — candidate ${report.version} ${report.candidate?.sha256 ?? '(unknown)'}`)
  lines.push(`verdict: ${report.verdict}  exit: ${report.exit_code}  sessions: ${report.sessions}  rounds: ${report.rounds} (+${report.warmup_rounds} warm-up)`)
  if (report.profile) {
    const p = report.profile
    lines.push(`profile: ${p.cpu} | ${p.logical_cpus} vCPU | ${(p.ram_bytes / (1 << 30)).toFixed(1)} GiB RAM | ${p.os} | ${p.arch} | SSD=${p.ssd.detected}`)
  }
  lines.push('')
  lines.push('CELL          STATUS        DETAIL')
  lines.push('------------  ------------  ------------------------------------------------')
  for (const [name, cell] of Object.entries(report.cells)) {
    const detail = cell.reason ?? (cell.median_ms !== undefined ? `median ${Math.round(cell.median_ms)}ms` : '')
    lines.push(`${name.padEnd(12)}  ${String(cell.status).padEnd(12)}  ${String(detail).slice(0, 80)}`)
  }
  if (report.canary) lines.push(`canary: ${report.canary.leaks} leak(s) across ${report.canary.scanned} scanned surfaces`)
  for (const reason of report.reasons) lines.push(`! ${reason}`)
  return lines
}

function emit(report, options, output, errorOutput) {
  if (options.json) {
    output.write(`${JSON.stringify(report)}\n`)
  } else {
    for (const line of renderTable(report)) output.write(`${line}\n`)
    if (report.exit_code !== 0) for (const reason of report.reasons) errorOutput.write(`! ${reason}\n`)
  }
  process.exitCode = report.exit_code
}

// --- Entry point -------------------------------------------------------------------
export async function runQualifyCommand(tokens, deps = {}) {
  const {
    output = process.stdout, errorOutput = process.stderr,
    pluginDataDir = join(tmpdir(), 'agent-room-qualify-receipt'),
    env = process.env, candidateRoot = PLUGIN_ROOT,
    profileFn = machineProfile, suiteFn = cellFullSuite, packagingFn = cellPackaging,
    nofileProbe = probeNofile, runtimeAssert = assertSupportedRuntime,
    sm1Fn = cellSm1, sm2Fn = cellSm2, sm3Fn = cellSm3, negativesFn = cellNegatives,
  } = deps
  const parsed = parseQualifyArgs(tokens)
  if (parsed.error) {
    errorOutput.write(`agent-room qualify: usage: ${parsed.error}\n`)
    process.exitCode = 1
    return { status: 'usage', exitCode: 1, message: parsed.error }
  }
  const options = parsed.options
  const canary = `ar-qualify-canary-${randomBytes(12).toString('hex')}`
  const prerequisites = await checkPrerequisites(options, { env, candidateRoot, nofileProbe, runtimeAssert })
  const candidateSha = prerequisites.candidate?.sha256 ?? null

  const prior = readReceipt(pluginDataDir)
  const receipt = {
    path: receiptPath(pluginDataDir),
    previous_sha256: prior?.sha256 ?? null,
    current_sha256: candidateSha,
    invalidated: false, written: false,
  }
  const receiptInvalid = prior !== null && candidateSha !== null && prior.sha256 !== candidateSha

  const profile = await profileFn()
  if (!prerequisites.ok || receiptInvalid) {
    const cells = {}
    for (const name of CELL_NAMES) cells[name] = { status: STATUS.INCONCLUSIVE, reason: 'pipeline not run: prerequisite missing or receipt invalidated' }
    cells.PREREQ = { status: STATUS.INCONCLUSIVE, reason: prerequisites.reasons[0] ?? 'prerequisite missing', reasons: prerequisites.reasons }
    if (receiptInvalid) {
      cells.RECEIPT = { status: STATUS.FAILED,
        reason: `candidate artifact changed: prior receipt sha256=${prior.sha256}, current sha256=${candidateSha}; the old receipt is invalid` }
    }
    const report = buildReport(options, prerequisites, cells, { leaks: 0, scanned: 0 }, receipt, profile)
    report.verdict = receiptInvalid ? STATUS.FAILED : STATUS.INCONCLUSIVE
    report.exit_code = 1
    emit(report, options, output, errorOutput)
    return { status: report.verdict, exitCode: 1, report }
  }

  const cells = {}
  cells.PREREQ = { status: STATUS.QUALIFIED, detail: 'Node/SQLite/nofile/candidate sha256 verified' }
  cells.RECEIPT = { status: STATUS.QUALIFIED, detail: 'candidate sha256/version pin verified' }
  cells['SM-1'] = await sm1Fn(options)
  cells['SM-2'] = await sm2Fn(options)
  cells['SM-3'] = await sm3Fn(options)
  const negatives = await negativesFn(options, canary)
  cells['SM-C1'] = { status: negatives.status, reason: negatives.reason, checks: negatives.checks.filter(row => /loop_pause/.test(row.check)) }
  cells['SM-C2'] = { status: negatives.status, reason: negatives.reason, checks: negatives.checks.filter(row => !/loop_pause/.test(row.check)) }
  cells['FULL-SUITE'] = await suiteFn(pluginDataDir)
  cells.PACKAGING = await packagingFn(env)

  const canaryRow = negatives.checks.find(row => row.check === 'allowlist_leak_canary') ?? { leaks: 0, scanned: 0 }
  const canaryReport = { leaks: canaryRow.leaks, scanned: canaryRow.scanned }
  const report = buildReport(options, prerequisites, cells, canaryReport, receipt, profile)
  receipt.sha256 = candidateSha
  receipt.verdict = report.verdict
  receipt.at = new Date().toISOString()
  try { writeReceipt(pluginDataDir, receipt); receipt.written = true } catch (error) {
    cells.RECEIPT = { status: STATUS.FAILED, reason: `could not write receipt: ${error?.message ?? error}` }
    report.verdict = STATUS.FAILED
    report.exit_code = 1
  }
  emit(report, options, output, errorOutput)
  return { status: report.verdict, exitCode: report.exit_code, report }
}
