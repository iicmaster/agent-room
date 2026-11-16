// Story 1.2 — Realm-unique Agent ID, atomic v0.9 live migration,
// rollback-safe WriteQueue staging, digest-only conflict_ticket,
// zero-config auto-mint, and notifier resilience.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import { createConflictTicketStore } from '../server/api/conflict-tickets.mjs'
import { loadOrCreateLocalToken } from '../server/api/local-token.mjs'
import { startServer } from '../server/api/server.mjs'
import { runDmCommand, runSendFamilyCommand } from '../server/cli/message-commands.mjs'
import {
  AGENT_ID_MINT_ATTEMPTS,
  CONFLICT_TICKET_MAX_PER_ACTOR,
  CONFLICT_TICKET_TTL_MS,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  PUBLIC_ERROR_STATUS,
  SESSION_BASE_LEASE_MS,
} from '../server/constants.mjs'
import { createLiveSessionRegistry } from '../server/core/session-registry.mjs'
import { SESSION_PRINCIPALS_LIVE_BASE_INDEX_NAME } from '../server/identity/session-principals.mjs'
import { fingerprintFromPublicKey } from '../server/keys.mjs'
import { startNotifier } from '../server/notification/notifier.mjs'
import { ROOM_LOG_DATABASE_FILENAME, openRoomLog } from '../server/store/room-log.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MCP_ENTRY = join(ROOT, 'server', 'mcp-stdio.mjs')
const CLI_ENTRY = join(ROOT, 'server', 'cli', 'agent-room.mjs')
const RUNTIME_RECORD_FILENAME = 'runtime.json'
const SERVER_PID_FILENAME = 'server.pid'
const WRITE_SQL_PATTERN = /\b(INSERT|UPDATE|DELETE|CREATE|ALTER|DROP|REPLACE|BEGIN\s+IMMEDIATE)\b|PRAGMA\s+journal_mode\s*=/i

const sleep = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })

function makeDir(t, prefix = 'agent-room-s12-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => {
    try {
      const pidFile = join(dir, SERVER_PID_FILENAME)
      if (existsSync(pidFile)) {
        const pid = Number.parseInt(readFileSync(pidFile, 'utf8').trim(), 10)
        if (Number.isInteger(pid) && pid > 1) {
          try { process.kill(pid, 'SIGTERM') } catch { /* already dead */ }
        }
      }
    } catch { /* ignore */ }
    rmSync(dir, { recursive: true, force: true })
  })
  return dir
}

function makeServer(t, dataDir, options = {}) {
  return startServer({ dataDir, ...options }).then(server => {
    t.after(async () => {
      await server.close().catch(() => {})
    })
    return server
  })
}

function newInstallation() {
  const { publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const raw = spki.subarray(spki.length - 32)
  return {
    publicKey: raw.toString('base64url'),
    fingerprint: fingerprintFromPublicKey(raw),
  }
}

function httpJson(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers, agent: false },
      res => {
        const chunks = []
        res.on('data', chunk => chunks.push(chunk))
        res.on('error', rejectPromise)
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolvePromise({
            status: res.statusCode,
            text,
            json: () => JSON.parse(text),
          })
        })
      },
    )
    req.on('error', rejectPromise)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

async function authLocal(port, dataDir, installation) {
  const localToken = loadOrCreateLocalToken(dataDir)
  const res = await httpJson(port, 'POST', '/api/auth/local', {
    headers: {
      [PROTOCOL_HEADER]: PROTOCOL_VERSION,
      authorization: `Bearer ${localToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ public_key: installation.publicKey }),
  })
  assert.equal(res.status, 200, res.text)
  return res.json().result.session_token
}

function bearerHeaders(token) {
  return {
    [PROTOCOL_HEADER]: PROTOCOL_VERSION,
    authorization: `Bearer ${token}`,
    'content-type': 'application/json; charset=utf-8',
  }
}

function insertRawPrincipalRow(db, row) {
  db.prepare(`
    INSERT INTO session_principals (
      session_id, installation_fingerprint, capability_digest, generation,
      base_name, address, machine, client_type,
      created_at, last_heartbeat_at, base_lease_expires_at, base_lease_status,
      principal_retention_expires_at, principal_status
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    row.session_id,
    row.installation_fingerprint,
    row.capability_digest,
    row.generation ?? 1,
    row.base_name,
    row.address,
    row.machine ?? 'box',
    row.client_type ?? 'mcp',
    row.created_at,
    row.last_heartbeat_at,
    row.base_lease_expires_at,
    row.base_lease_status,
    row.principal_retention_expires_at,
    row.principal_status ?? 'retained',
  )
}

function createPreMigrationDatabase(dataDir) {
  const seedStore = openRoomLog({ dataDir, role: 'server' })
  seedStore.close()
  const dbPath = join(dataDir, ROOM_LOG_DATABASE_FILENAME)
  const db = new DatabaseSync(dbPath)
  db.exec(`DROP INDEX IF EXISTS ${SESSION_PRINCIPALS_LIVE_BASE_INDEX_NAME}`)
  return db
}

async function withSessionPrincipals409Proxy(t, serverPort) {
  const seenBaseNames = []
  const proxy = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks)
      if (req.method === 'POST' && req.url === '/api/session-principals') {
        try {
          const parsed = JSON.parse(rawBody.toString('utf8'))
          seenBaseNames.push(parsed.base_chat_id)
        } catch {
          seenBaseNames.push(null)
        }
        const payload = JSON.stringify({
          ok: false,
          error: {
            code: 'agent_id_taken',
            message: 'Agent ID is currently occupied by another live session',
          },
        })
        res.writeHead(409, { 'content-type': 'application/json; charset=utf-8' })
        res.end(payload)
        return
      }
      const upstream = http.request(
        { host: '127.0.0.1', port: serverPort, method: req.method, path: req.url, headers: req.headers, agent: false },
        up => {
          const upChunks = []
          up.on('data', chunk => upChunks.push(chunk))
          up.on('end', () => {
            res.writeHead(up.statusCode, up.headers)
            res.end(Buffer.concat(upChunks))
          })
        },
      )
      upstream.on('error', () => { try { res.destroy() } catch { /* ignore */ } })
      upstream.end(rawBody)
    })
  })
  const proxyPort = await new Promise(resolvePromise => {
    proxy.listen(0, '127.0.0.1', () => resolvePromise(proxy.address().port))
  })
  t.after(() => new Promise(resolvePromise => proxy.close(resolvePromise)))
  return { proxyPort, seenBaseNames }
}

function spawnMcpChild(t, { pluginData, sharedData, extraArgs = [] }) {
  const child = spawn(process.execPath, [MCP_ENTRY, ...extraArgs], {
    cwd: pluginData,
    env: {
      PATH: process.env.PATH || '',
      LANG: process.env.LANG || 'C.UTF-8',
      PLUGIN_DATA: pluginData,
      AGENT_ROOM_DATA_DIR: sharedData,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let stdout = ''
  let stderr = ''
  let nextId = 1
  const pending = new Map()

  child.stdout.on('data', chunk => {
    stdout += chunk
    for (;;) {
      const nl = stdout.indexOf('\n')
      if (nl === -1) break
      const line = stdout.slice(0, nl)
      stdout = stdout.slice(nl + 1)
      if (!line.trim()) continue
      const msg = JSON.parse(line)
      if (msg.id !== undefined && pending.has(msg.id)) {
        const entry = pending.get(msg.id)
        pending.delete(msg.id)
        entry.resolve(msg)
      }
    }
  })
  child.stderr.on('data', chunk => { stderr += chunk })

  const close = async () => {
    for (const [, entry] of pending) entry.reject(new Error('MCP child closed'))
    pending.clear()
    if (child.exitCode !== null || child.signalCode !== null) return
    child.stdin.end()
    child.kill('SIGTERM')
    await new Promise(resolveClose => {
      const timer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
        resolveClose()
      }, 2000)
      child.once('exit', () => {
        clearTimeout(timer)
        resolveClose()
      })
    })
  }
  t.after(close)

  const request = (method, params = {}, timeoutMs = 8000) => {
    const id = nextId++
    return new Promise((resolveReq, rejectReq) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectReq(new Error(`MCP request ${method} timed out; stderr=${stderr}`))
      }, timeoutMs)
      pending.set(id, {
        resolve: msg => {
          clearTimeout(timer)
          resolveReq(msg)
        },
        reject: err => {
          clearTimeout(timer)
          rejectReq(err)
        },
      })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    })
  }

  return {
    child,
    stderrText: () => stderr,
    async initialize() {
      const res = await request('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'UniqueAgentIdTest', version: '1.0.0' },
      })
      assert.equal(res.result.protocolVersion, '2025-06-18')
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
    },
    async tool(name, argumentsValue = {}) {
      const res = await request('tools/call', { name, arguments: argumentsValue })
      assert.equal(res.error, undefined, JSON.stringify(res.error))
      return JSON.parse(res.result.content[0].text)
    },
    close,
  }
}

test('AC1_MIGRATION_TIEBREAK_AND_STDERR: converges duplicate live Agent IDs by heartbeat/created/rowid, expires stale leases, logs PII-free count, ignores cli role', t => {
  const dataDir = makeDir(t)
  const db = createPreMigrationDatabase(dataDir)

  const nowMs = Date.now()
  const futureLease = new Date(nowMs + 60_000).toISOString()
  const pastLease = new Date(nowMs - 60_000).toISOString()
  const retention = new Date(nowMs + 30 * 86_400_000).toISOString()
  const fp1 = `sha256:${'1'.repeat(64)}`
  const fp2 = `sha256:${'2'.repeat(64)}`

  const digest = tag => createHash('sha256').update(tag).digest('hex')

  // Group 1 ("Alpha" case-insensitive): winner by latest last_heartbeat_at
  insertRawPrincipalRow(db, {
    session_id: 'alpha-old-hb', installation_fingerprint: fp1, capability_digest: digest('c1'),
    base_name: 'alpha', locator_token: 'aaaaaaaaaa', address: 'alpha~aaaaaaaaaa@box',
    created_at: '2026-10-01T00:00:00.000Z', last_heartbeat_at: '2026-10-01T00:00:10.000Z',
    base_lease_expires_at: futureLease, base_lease_status: 'occupied', principal_retention_expires_at: retention,
  })
  insertRawPrincipalRow(db, {
    session_id: 'alpha-winner', installation_fingerprint: fp2, capability_digest: digest('c2'),
    base_name: 'ALPHA', locator_token: 'bbbbbbbbbb', address: 'ALPHA~bbbbbbbbbb@box',
    created_at: '2026-10-01T00:00:00.000Z', last_heartbeat_at: '2026-10-01T00:00:20.000Z',
    base_lease_expires_at: futureLease, base_lease_status: 'occupied', principal_retention_expires_at: retention,
  })

  // Group 2 ("beta"): equal last_heartbeat_at -> tie broken by created_at DESC
  insertRawPrincipalRow(db, {
    session_id: 'beta-old-created', installation_fingerprint: fp1, capability_digest: digest('c3'),
    base_name: 'beta', locator_token: 'cccccccccc', address: 'beta~cccccccccc@box',
    created_at: '2026-10-01T00:00:01.000Z', last_heartbeat_at: '2026-10-01T00:00:30.000Z',
    base_lease_expires_at: futureLease, base_lease_status: 'occupied', principal_retention_expires_at: retention,
  })
  insertRawPrincipalRow(db, {
    session_id: 'beta-winner', installation_fingerprint: fp2, capability_digest: digest('c4'),
    base_name: 'Beta', locator_token: 'dddddddddd', address: 'Beta~dddddddddd@box',
    created_at: '2026-10-01T00:00:02.000Z', last_heartbeat_at: '2026-10-01T00:00:30.000Z',
    base_lease_expires_at: futureLease, base_lease_status: 'occupied', principal_retention_expires_at: retention,
  })

  // Group 3 ("gamma"): equal heartbeat + created_at -> tie broken by rowid DESC
  insertRawPrincipalRow(db, {
    session_id: 'gamma-older-rowid', installation_fingerprint: fp1, capability_digest: digest('c5'),
    base_name: 'gamma', locator_token: 'eeeeeeeeee', address: 'gamma~eeeeeeeeee@box',
    created_at: '2026-10-01T00:00:05.000Z', last_heartbeat_at: '2026-10-01T00:00:40.000Z',
    base_lease_expires_at: futureLease, base_lease_status: 'occupied', principal_retention_expires_at: retention,
  })
  insertRawPrincipalRow(db, {
    session_id: 'gamma-winner', installation_fingerprint: fp2, capability_digest: digest('c6'),
    base_name: 'GAMMA', locator_token: 'ffffffffff', address: 'GAMMA~ffffffffff@box',
    created_at: '2026-10-01T00:00:05.000Z', last_heartbeat_at: '2026-10-01T00:00:40.000Z',
    base_lease_expires_at: futureLease, base_lease_status: 'occupied', principal_retention_expires_at: retention,
  })

  // Group 4 ("delta"): one expired 'occupied' lease + one valid 'occupied' lease (not counted as duplicate!)
  insertRawPrincipalRow(db, {
    session_id: 'delta-stale-lease', installation_fingerprint: fp1, capability_digest: digest('c7'),
    base_name: 'delta', locator_token: 'gggggggggg', address: 'delta~gggggggggg@box',
    created_at: '2026-10-01T00:00:05.000Z', last_heartbeat_at: '2026-10-01T00:00:50.000Z',
    base_lease_expires_at: pastLease, base_lease_status: 'occupied', principal_retention_expires_at: retention,
  })
  insertRawPrincipalRow(db, {
    session_id: 'delta-winner', installation_fingerprint: fp2, capability_digest: digest('c8'),
    base_name: 'Delta', locator_token: 'hhhhhhhhhh', address: 'Delta~hhhhhhhhhh@box',
    created_at: '2026-10-01T00:00:01.000Z', last_heartbeat_at: '2026-10-01T00:00:10.000Z',
    base_lease_expires_at: futureLease, base_lease_status: 'occupied', principal_retention_expires_at: retention,
  })
  db.close()

  // role: 'cli' must NOT run migration or create the index.
  const cliStore = openRoomLog({ dataDir, role: 'cli' })
  cliStore.close()
  const inspectBefore = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME), { readOnly: true })
  assert.equal(
    inspectBefore.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`).get(SESSION_PRINCIPALS_LIVE_BASE_INDEX_NAME),
    undefined,
  )
  inspectBefore.close()

  // Capture stderr written during server migration.
  const stderrChunks = []
  const origWrite = process.stderr.write.bind(process.stderr)
  process.stderr.write = (chunk, encoding, callback) => {
    stderrChunks.push(typeof chunk === 'string' ? chunk : chunk.toString('utf8'))
    if (typeof encoding === 'function') encoding()
    else if (typeof callback === 'function') callback()
    return true
  }
  let serverStore
  try {
    serverStore = openRoomLog({ dataDir, role: 'server' })
  } finally {
    process.stderr.write = origWrite
  }
  t.after(() => serverStore?.close())

  const stderrText = stderrChunks.join('')
  assert.equal(stderrText, 'agent-room: converged 3 duplicate live Agent IDs before indexing\n')
  assert.doesNotMatch(stderrText, /alpha|beta|gamma|delta|sha256:/i)

  const inspectAfter = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME), { readOnly: true })
  t.after(() => inspectAfter.close())
  const statusById = new Map(
    inspectAfter.prepare('SELECT session_id, base_lease_status FROM session_principals').all()
      .map(r => [r.session_id, r.base_lease_status]),
  )
  assert.equal(statusById.get('alpha-winner'), 'occupied')
  assert.equal(statusById.get('alpha-old-hb'), 'expired')
  assert.equal(statusById.get('beta-winner'), 'occupied')
  assert.equal(statusById.get('beta-old-created'), 'expired')
  assert.equal(statusById.get('gamma-winner'), 'occupied')
  assert.equal(statusById.get('gamma-older-rowid'), 'expired')
  assert.equal(statusById.get('delta-winner'), 'occupied')
  assert.equal(statusById.get('delta-stale-lease'), 'expired')
  assert.ok(
    inspectAfter.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`).get(SESSION_PRINCIPALS_LIVE_BASE_INDEX_NAME),
  )
})

test('AC1_MIGRATION_FAULT_ROLLBACK: mid-migration SQL fault rolls back atomically and throws database_configuration_failed', t => {
  const dataDir = makeDir(t)
  const db = createPreMigrationDatabase(dataDir)
  const futureLease = new Date(Date.now() + 60_000).toISOString()
  const retention = new Date(Date.now() + 30 * 86_400_000).toISOString()
  const fp = `sha256:${'a'.repeat(64)}`
  const digest = tag => createHash('sha256').update(tag).digest('hex')

  insertRawPrincipalRow(db, {
    session_id: 'loser-row', installation_fingerprint: fp, capability_digest: digest('r1'),
    base_name: 'dup', locator_token: '1111111111', address: 'dup~1111111111@box',
    created_at: '2026-10-01T00:00:00.000Z', last_heartbeat_at: '2026-10-01T00:00:01.000Z',
    base_lease_expires_at: futureLease, base_lease_status: 'occupied', principal_retention_expires_at: retention,
  })
  insertRawPrincipalRow(db, {
    session_id: 'winner-row', installation_fingerprint: fp, capability_digest: digest('r2'),
    base_name: 'dup', locator_token: '2222222222', address: 'dup~2222222222@box',
    created_at: '2026-10-01T00:00:00.000Z', last_heartbeat_at: '2026-10-01T00:00:02.000Z',
    base_lease_expires_at: futureLease, base_lease_status: 'occupied', principal_retention_expires_at: retention,
  })
  db.exec(`
    CREATE TRIGGER fail_mid_migration
    BEFORE UPDATE ON session_principals
    WHEN NEW.session_id = 'loser-row'
    BEGIN
      SELECT RAISE(ABORT, 'injected migration fault');
    END;
  `)
  db.close()

  assert.throws(
    () => openRoomLog({ dataDir, role: 'server' }),
    error => error?.code === 'database_configuration_failed',
  )

  const checkDb = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME))
  const rows = checkDb.prepare('SELECT session_id, base_lease_status FROM session_principals').all()
  assert.deepEqual(rows.map(r => r.base_lease_status), ['occupied', 'occupied'])
  assert.equal(
    checkDb.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`).get(SESSION_PRINCIPALS_LIVE_BASE_INDEX_NAME),
    undefined,
  )
  checkDb.exec('DROP TRIGGER fail_mid_migration;')
  checkDb.close()

  const recovered = openRoomLog({ dataDir, role: 'server' })
  recovered.close()
})

test('AC1_MIGRATION_100K_LATENCY: 100,000-row convergence and partial unique index creation completes within 2,000 ms', t => {
  const dataDir = makeDir(t)
  const db = createPreMigrationDatabase(dataDir)
  const futureLease = new Date(Date.now() + SESSION_BASE_LEASE_MS * 4).toISOString()
  const retention = new Date(Date.now() + 30 * 86_400_000).toISOString()
  const fp = `sha256:${'b'.repeat(64)}`
  const totalRows = 100_000

  db.exec('BEGIN IMMEDIATE')
  const stmt = db.prepare(`
    INSERT INTO session_principals (
      session_id, installation_fingerprint, capability_digest, generation,
      base_name, address, machine, client_type,
      created_at, last_heartbeat_at, base_lease_expires_at, base_lease_status,
      principal_retention_expires_at, principal_status
    ) VALUES (?, ?, ?, 1, ?, ?, 'box', 'cli', ?, ?, ?, 'occupied', ?, 'retained')
  `)
  for (let i = 0; i < totalRows; i += 1) {
    const sid = `sid-${i}`
    const cap = createHash('sha256').update(sid).digest('hex')
    // Inject duplicates across every 5th base name while keeping 100k rows.
    const base = i % 5 === 0 ? `dup-${Math.floor(i / 10)}` : `uniq-${i}`
    const tok = `t${String(i).padStart(9, '0')}`
    const hb = `2026-10-01T00:${String(Math.floor(i / 6000) % 60).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}.000Z`
    stmt.run(sid, fp, cap, base, `${base}~${tok}@box`, hb, hb, futureLease, retention)
  }
  db.exec('COMMIT')
  db.close()

  const startedAt = performance.now()
  const store = openRoomLog({ dataDir, role: 'server' })
  const elapsedMs = performance.now() - startedAt
  t.after(() => store.close())

  assert.ok(elapsedMs <= 2000, `expected 100k migration <= 2000ms, got ${elapsedMs.toFixed(1)}ms`)
})

test('AC1_SECOND_BOOT_ZERO_WRITES: 2nd boot of openRoomLog and startServer plus GET /api/session-principals performs 0 SQLite writes', async t => {
  const dataDir = makeDir(t)
  const server1 = await makeServer(t, dataDir)
  const inst = newInstallation()
  const token = await authLocal(server1.port, dataDir, inst)
  const alloc = await httpJson(server1.port, 'POST', '/api/session-principals', {
    headers: bearerHeaders(token),
    body: JSON.stringify({ base_chat_id: 'boot-agent', machine: 'box', client_type: 'cli' }),
  })
  assert.equal(alloc.status, 200, alloc.text)
  await server1.close()

  const roDb = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME), { readOnly: true })
  t.after(() => roDb.close())
  const versionBefore = roDb.prepare('PRAGMA data_version').get().data_version

  const writeSql = []
  const origExec = DatabaseSync.prototype.exec
  const origPrepare = DatabaseSync.prototype.prepare
  DatabaseSync.prototype.exec = function spiedExec(sql, ...rest) {
    if (WRITE_SQL_PATTERN.test(String(sql))) writeSql.push(String(sql))
    return origExec.call(this, sql, ...rest)
  }
  DatabaseSync.prototype.prepare = function spiedPrepare(sql, ...rest) {
    if (WRITE_SQL_PATTERN.test(String(sql))) writeSql.push(String(sql))
    return origPrepare.call(this, sql, ...rest)
  }

  let server2
  let versionDuring
  try {
    server2 = await makeServer(t, dataDir)
    const token2 = await authLocal(server2.port, dataDir, inst)
    const listed = await httpJson(server2.port, 'GET', '/api/session-principals', {
      headers: bearerHeaders(token2),
    })
    assert.equal(listed.status, 200, listed.text)
    versionDuring = roDb.prepare('PRAGMA data_version').get().data_version
    await server2.close()
  } finally {
    DatabaseSync.prototype.exec = origExec
    DatabaseSync.prototype.prepare = origPrepare
  }

  assert.deepEqual(writeSql, [])
  assert.equal(versionDuring, versionBefore)
})

test('AC2_50_WAY_RACE_AND_BEARER_EXEMPTION: 50-way cross-namespace concurrency race allows 1 winner, exempts exact Bearer only, omits conflict_ticket cross-installation', async t => {
  const dataDir = makeDir(t)
  const server = await makeServer(t, dataDir)

  const instA = newInstallation()
  const instB = newInstallation()
  const tokenA = await authLocal(server.port, dataDir, instA)
  const tokenASibling = await authLocal(server.port, dataDir, instA)
  const tokenB = await authLocal(server.port, dataDir, instB)

  // Same Bearer exempt cross-namespace: /api/session + /api/session-principals with tokenA succeed.
  const bindA = await httpJson(server.port, 'POST', '/api/session', {
    headers: bearerHeaders(tokenA),
    body: JSON.stringify({ chat_id: 'SharedAgent', client_type: 'cli' }),
  })
  assert.equal(bindA.status, 200, bindA.text)
  const allocSameBearer = await httpJson(server.port, 'POST', '/api/session-principals', {
    headers: bearerHeaders(tokenA),
    body: JSON.stringify({ base_chat_id: 'sharedagent', machine: 'box', client_type: 'cli' }),
  })
  assert.equal(allocSameBearer.status, 200, allocSameBearer.text)

  // Sibling Bearer under the SAME actorFingerprint MUST refuse 409 agent_id_taken WITH conflict_ticket.
  const siblingAttempt = await httpJson(server.port, 'POST', '/api/session-principals', {
    headers: bearerHeaders(tokenASibling),
    body: JSON.stringify({ base_chat_id: 'SharedAgent', machine: 'box', client_type: 'cli' }),
  })
  assert.equal(siblingAttempt.status, 409, siblingAttempt.text)
  assert.equal(siblingAttempt.json().error.code, 'agent_id_taken')
  assert.ok(typeof siblingAttempt.json().error.conflict_ticket === 'string' && siblingAttempt.json().error.conflict_ticket.length >= 22)

  // Foreign installation MUST refuse 409 agent_id_taken WITHOUT conflict_ticket.
  const foreignAttempt = await httpJson(server.port, 'POST', '/api/session-principals', {
    headers: bearerHeaders(tokenB),
    body: JSON.stringify({ base_chat_id: 'sharedagent', machine: 'box', client_type: 'cli' }),
  })
  assert.equal(foreignAttempt.status, 409, foreignAttempt.text)
  assert.equal(foreignAttempt.json().error.code, 'agent_id_taken')
  assert.equal(foreignAttempt.json().error.conflict_ticket, undefined)

  // 50-way cross-namespace concurrency race for 'Race-Base' across /api/session
  // and /api/session-principals: strictly 1 winner across all 50 claimers.
  const racers = await Promise.all(
    Array.from({ length: 50 }, async () => authLocal(server.port, dataDir, newInstallation())),
  )
  const attempts = racers.map((tok, index) => {
    if (index % 2 === 0) {
      return httpJson(server.port, 'POST', '/api/session-principals', {
        headers: bearerHeaders(tok),
        body: JSON.stringify({ base_chat_id: index % 4 === 0 ? 'Race-Base' : 'race-base', machine: 'box', client_type: 'cli' }),
      })
    }
    return httpJson(server.port, 'POST', '/api/session', {
      headers: bearerHeaders(tok),
      body: JSON.stringify({ chat_id: index % 4 === 1 ? 'Race-Base' : 'race-base', client_type: 'cli' }),
    })
  })
  const responses = await Promise.all(attempts)
  const winners = responses.filter(r => r.status === 200)
  const refused = responses.filter(r => r.status === 409)
  assert.equal(winners.length, 1, `expected exactly 1 race winner, got ${winners.length}`)
  assert.equal(refused.length, 49)
  for (const r of refused) {
    const code = r.json().error.code
    assert.ok(code === 'agent_id_taken' || code === 'chat_id_taken', `unexpected 409 code ${code}`)
  }

  // Verify UNBOUND-SEND collides inside WriteQueue against both namespaces:
  // (a) held in session_principals -> 409 agent_id_taken (no conflict_ticket cross-installation)
  // (b) held in liveSessionRegistry  -> 409 chat_id_taken
  const statusRes = await httpJson(server.port, 'GET', '/api/status', { headers: bearerHeaders(tokenA) })
  const roomId = statusRes.json().result.broadcast_room_id

  const unboundToken1 = await authLocal(server.port, dataDir, newInstallation())
  await httpJson(server.port, 'POST', '/api/session', {
    headers: bearerHeaders(unboundToken1),
    body: JSON.stringify({ chat_id: 'HeldByPrincipal', client_type: 'cli' }),
  })
  await httpJson(server.port, 'DELETE', '/api/session', { headers: bearerHeaders(unboundToken1) })
  const holdPrincipal = await httpJson(server.port, 'POST', '/api/session-principals', {
    headers: bearerHeaders(tokenA),
    body: JSON.stringify({ base_chat_id: 'heldbyprincipal', machine: 'box', client_type: 'cli' }),
  })
  assert.equal(holdPrincipal.status, 200, holdPrincipal.text)
  const unboundVsPrincipal = await httpJson(server.port, 'POST', `/api/rooms/${encodeURIComponent(roomId)}/messages`, {
    headers: bearerHeaders(unboundToken1),
    body: JSON.stringify({ chat_id: 'HeldByPrincipal', client_message_id: 'ub-p-1', text: 'hi' }),
  })
  assert.equal(unboundVsPrincipal.status, 409, unboundVsPrincipal.text)
  assert.equal(unboundVsPrincipal.json().error.code, 'agent_id_taken')
  assert.equal(unboundVsPrincipal.json().error.conflict_ticket, undefined)

  const unboundToken2 = await authLocal(server.port, dataDir, newInstallation())
  await httpJson(server.port, 'POST', '/api/session', {
    headers: bearerHeaders(unboundToken2),
    body: JSON.stringify({ chat_id: 'HeldByLegacy', client_type: 'cli' }),
  })
  await httpJson(server.port, 'DELETE', '/api/session', { headers: bearerHeaders(unboundToken2) })
  const holdLegacy = await httpJson(server.port, 'POST', '/api/session', {
    headers: bearerHeaders(tokenB),
    body: JSON.stringify({ chat_id: 'heldbylegacy', client_type: 'cli' }),
  })
  assert.equal(holdLegacy.status, 200, holdLegacy.text)
  const unboundVsLegacy = await httpJson(server.port, 'POST', `/api/rooms/${encodeURIComponent(roomId)}/messages`, {
    headers: bearerHeaders(unboundToken2),
    body: JSON.stringify({ chat_id: 'HeldByLegacy', client_message_id: 'ub-l-1', text: 'hi' }),
  })
  assert.equal(unboundVsLegacy.status, 409, unboundVsLegacy.text)
  assert.equal(unboundVsLegacy.json().error.code, 'chat_id_taken')

  // Verify invalid base_chat_id fails 400 invalid_request with declared shape message.
  const badBase = await httpJson(server.port, 'POST', '/api/session-principals', {
    headers: bearerHeaders(tokenA),
    body: JSON.stringify({ base_chat_id: 'bad base!', machine: 'box', client_type: 'cli' }),
  })
  assert.equal(badBase.status, 400, badBase.text)
  assert.equal(badBase.json().error.code, 'invalid_request')
  assert.match(badBase.json().error.message, /base_chat_id: 1-32 chars of \[A-Za-z0-9_.-\]/)

  // Verify /resume and /heartbeat re-occupy collide cross-namespace with liveSessionRegistry -> 409 agent_id_taken.
  const tokenC = await authLocal(server.port, dataDir, newInstallation())
  const allocReclaim = await httpJson(server.port, 'POST', '/api/session-principals', {
    headers: bearerHeaders(tokenC),
    body: JSON.stringify({ base_chat_id: 'ReclaimBase', machine: 'box', client_type: 'cli' }),
  })
  assert.equal(allocReclaim.status, 200, allocReclaim.text)
  const reclaim = allocReclaim.json().result
  const sessionHeaders = {
    [PROTOCOL_HEADER]: PROTOCOL_VERSION,
    authorization: `Session ${reclaim.session_capability}`,
    'content-type': 'application/json; charset=utf-8',
  }
  const relRes = await httpJson(server.port, 'DELETE', '/api/session-principals/current', {
    headers: {
      [PROTOCOL_HEADER]: PROTOCOL_VERSION,
      authorization: `Session ${reclaim.session_capability}`,
    },
  })
  assert.equal(relRes.status, 200, relRes.text)

  // Foreign installation takes 'reclaimbase' in legacy /api/session while principal is released.
  const holdReclaimLegacy = await httpJson(server.port, 'POST', '/api/session', {
    headers: bearerHeaders(tokenASibling),
    body: JSON.stringify({ chat_id: 'reclaimbase', client_type: 'cli' }),
  })
  assert.equal(holdReclaimLegacy.status, 200, holdReclaimLegacy.text)

  const resumeCollision = await httpJson(server.port, 'POST', '/api/session-principals/resume', {
    headers: sessionHeaders,
    body: JSON.stringify({ session_id: reclaim.session_id, generation: reclaim.generation }),
  })
  assert.equal(resumeCollision.status, 409, resumeCollision.text)
  assert.equal(resumeCollision.json().error.code, 'agent_id_taken')
  assert.equal(resumeCollision.json().error.conflict_ticket, undefined)

  const hbCollision = await httpJson(server.port, 'POST', '/api/session-principals/heartbeat', {
    headers: sessionHeaders,
    body: JSON.stringify({ session_id: reclaim.session_id, generation: reclaim.generation }),
  })
  assert.equal(hbCollision.status, 409, hbCollision.text)
  assert.equal(hbCollision.json().error.code, 'agent_id_taken')
  assert.equal(hbCollision.json().error.conflict_ticket, undefined)
})

test('AC2_WRITE_QUEUE_ROLLBACK_MEMORY_RESTORE: savepoint failure and outer COMMIT failure restore liveSessionRegistry and conflictTickets', async t => {
  const dataDir = makeDir(t)
  const store = openRoomLog({ dataDir, role: 'server' })
  t.after(() => store.close())

  const liveRegistry = createLiveSessionRegistry()
  const conflictTickets = createConflictTicketStore()
  const fp = `sha256:${'c'.repeat(64)}`

  // (a) Op-level SAVEPOINT failure rolls back memory state cleanly.
  await assert.rejects(
    () => store.enqueueWrite({
      sessionKey: 'sk-1',
      bytes: 0,
      payload: { test: 'savepoint-fail' },
      captureMemoryUndo() {
        const regSnap = liveRegistry.snapshot()
        const tktSnap = conflictTickets.snapshot()
        return () => {
          liveRegistry.restore(regSnap)
          conflictTickets.restore(tktSnap)
        }
      },
      execute(tx) {
        liveRegistry.bind({ sessionKey: 'sk-1', actorFingerprint: fp, chatId: 'GhostSavepoint', clientType: 'cli' })
        conflictTickets.mint({
          actorFingerprint: fp,
          chatId: 'GhostSavepoint',
          observerSessionKey: 'sk-2',
          incumbentSessionKey: 'sk-1',
          observedGeneration: 1,
        })
        // Force SQLITE_CONSTRAINT inside tx using invalid claim shape via direct store error or bad room insert
        tx.enrollActor({ actorFingerprint: 'invalid-not-sha256', enrolledAt: 'bad' })
        return null
      },
    }),
  )
  assert.equal(liveRegistry.holderOf('GhostSavepoint'), null)
  assert.equal(conflictTickets.size(), 0)

  // (b) Outer COMMIT failure (DEFERRABLE INITIALLY DEFERRED FK violated only at COMMIT time)
  // succeeds past RELEASE SAVEPOINT, fails COMMIT, and still restores memory snapshots.
  const rawDb = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME))
  t.after(() => { try { rawDb.close() } catch {} })
  rawDb.exec(`
    CREATE TABLE _test_defer_parent (id INTEGER PRIMARY KEY) STRICT;
    CREATE TABLE _test_defer_child (
      id INTEGER PRIMARY KEY,
      parent_id INTEGER REFERENCES _test_defer_parent(id) DEFERRABLE INITIALLY DEFERRED
    ) STRICT;
    CREATE TRIGGER _test_defer_trigger AFTER INSERT ON session_principals
    BEGIN
      INSERT INTO _test_defer_child (parent_id) VALUES (999999);
    END;
  `)
  rawDb.close()

  await assert.rejects(
    () => store.enqueueWrite({
      sessionKey: 'sk-outer',
      bytes: 0,
      payload: { test: 'outer-commit-fail' },
      captureMemoryUndo() {
        const regSnap = liveRegistry.snapshot()
        const tktSnap = conflictTickets.snapshot()
        return () => {
          liveRegistry.restore(regSnap)
          conflictTickets.restore(tktSnap)
        }
      },
      execute(tx) {
        liveRegistry.bind({ sessionKey: 'sk-outer', actorFingerprint: fp, chatId: 'OuterGhost', clientType: 'cli' })
        tx.allocateSessionPrincipalInTx({
          installationFingerprint: fp,
          baseName: 'OuterGhost',
          machine: 'box',
          clientType: 'cli',
          nowMs: Date.now(),
        })
        return { ok: true }
      },
    }),
  )
  assert.equal(liveRegistry.holderOf('OuterGhost'), null)
})

test('AC2_DIGEST_ONLY_CONFLICT_TICKET_STORE: stores sha256 digests only, enforces 60s TTL and 1024 per-actor cap with expired sweep', () => {
  let nowMs = 1_000_000
  const tickets = createConflictTicketStore({ now: () => nowMs })
  const fpA = `sha256:${'d'.repeat(64)}`
  const fpB = `sha256:${'e'.repeat(64)}`

  const minted = tickets.mint({
    actorFingerprint: fpA,
    chatId: 'TicketName',
    observerSessionKey: 'obs-0',
    incumbentSessionKey: 'inc-0',
    observedGeneration: 1,
  })
  assert.ok(typeof minted.ticket === 'string' && minted.ticket.length >= 22)
  const snap = tickets.snapshot()
  const serializedSnap = JSON.stringify({
    tickets: Array.from(snap.tickets.entries()),
    slots: Array.from(snap.slots.entries()),
  })
  assert.equal(serializedSnap.includes(minted.ticket), false, 'raw ticket must never be stored in Map keys or values')
  const expectedDigest = createHash('sha256').update(minted.ticket, 'utf8').digest('hex')
  assert.equal(snap.tickets.has(expectedDigest), true)

  // Cross-actor redeem fails without consuming; valid same-actor redeem succeeds once.
  assert.equal(tickets.redeem({ ticket: minted.ticket, actorFingerprint: fpB, chatId: 'TicketName' }), null)
  const redeemed = tickets.redeem({ ticket: minted.ticket, actorFingerprint: fpA, chatId: 'TicketName' })
  assert.equal(redeemed.incumbentSessionKey, 'inc-0')
  assert.equal(tickets.redeem({ ticket: minted.ticket, actorFingerprint: fpA, chatId: 'TicketName' }), null)

  // TTL expiration check (CONFLICT_TICKET_TTL_MS = 60_000)
  const ttlMinted = tickets.mint({
    actorFingerprint: fpA,
    chatId: 'TtlName',
    observerSessionKey: 'obs-ttl',
    incumbentSessionKey: 'inc-ttl',
    observedGeneration: 1,
  })
  nowMs += CONFLICT_TICKET_TTL_MS
  assert.equal(tickets.redeem({ ticket: ttlMinted.ticket, actorFingerprint: fpA, chatId: 'TtlName' }), null)

  // Per-actor cap (1024) + expired-entry sweep on next mint
  for (let i = 0; i < CONFLICT_TICKET_MAX_PER_ACTOR; i += 1) {
    const r = tickets.mint({
      actorFingerprint: fpA,
      chatId: `cap-${i}`,
      observerSessionKey: `obs-${i}`,
      incumbentSessionKey: `inc-${i}`,
      observedGeneration: 1,
    })
    assert.ok(typeof r.ticket === 'string')
  }
  assert.equal(tickets.size(), CONFLICT_TICKET_MAX_PER_ACTOR)
  // Story 1.1 AC4 retired post-auth 429s (Epic 1 retro F-8): a full ticket
  // map EVICTS its oldest entry instead of refusing the mint, so the bound
  // still holds and no caller is ever rate-limited on an authenticated bind.
  const capped = tickets.mint({
    actorFingerprint: fpA,
    chatId: 'over-cap',
    observerSessionKey: 'obs-over',
    incumbentSessionKey: 'inc-over',
    observedGeneration: 1,
  })
  assert.ok(typeof capped.ticket === 'string', 'the mint succeeds at the cap')
  assert.equal(capped.rateLimited, undefined, 'never a rate_limited refusal')
  assert.equal(tickets.size(), CONFLICT_TICKET_MAX_PER_ACTOR, 'eviction keeps the map bounded')

  nowMs += CONFLICT_TICKET_TTL_MS + 1
  const afterSweep = tickets.mint({
    actorFingerprint: fpA,
    chatId: 'after-sweep',
    observerSessionKey: 'obs-after',
    incumbentSessionKey: 'inc-after',
    observedGeneration: 1,
  })
  assert.ok(typeof afterSweep.ticket === 'string')
  assert.equal(tickets.size(), 1)
})

test('AC3_AUTO_MINT_EXHAUSTION_AND_ZERO_CONFIG_CLI_MCP: CLI & MCP auto-mint zero-config, exhaust 3 attempts with exit 1, explicit --name 1 attempt, 2 MCPs share config.json', async t => {
  const dataDir = makeDir(t)
  const server = await makeServer(t, dataDir)
  const instPeer = newInstallation()
  const peerToken = await authLocal(server.port, dataDir, instPeer)
  const peerAlloc = await httpJson(server.port, 'POST', '/api/session-principals', {
    headers: bearerHeaders(peerToken),
    body: JSON.stringify({ base_chat_id: 'peer-bot', machine: 'box', client_type: 'cli' }),
  })
  assert.equal(peerAlloc.status, 200, peerAlloc.text)
  const peerAddress = peerAlloc.json().result.address

  // (a) Zero-config CLI dm without config.json or --name succeeds via auto-mint.
  const cliPluginData = makeDir(t, 'agent-room-cli-zero-')
  const dmOk = await runDmCommand(['--to', peerAddress, '--text', 'zero-config hello'], {
    pluginDataDir: cliPluginData,
    sharedDataDir: dataDir,
    env: { ...process.env, AGENT_ROOM_SESSION_SCOPE: 'cli-zero-ok' },
  })
  assert.equal(dmOk.status, 'ok', JSON.stringify(dmOk))

  // (b) Two MCP processes sharing the SAME pluginData with an existing config.json stay alive with distinct auto-minted Agent IDs.
  const sharedPluginData = makeDir(t, 'agent-room-mcp-shared-')
  writeFileSync(join(sharedPluginData, 'config.json'), `${JSON.stringify({ chat_id: 'SharedLegacyName' })}\n`)
  const mcp1 = spawnMcpChild(t, { pluginData: sharedPluginData, sharedData: dataDir })
  const mcp2 = spawnMcpChild(t, { pluginData: sharedPluginData, sharedData: dataDir })
  await Promise.all([mcp1.initialize(), mcp2.initialize()])
  const [st1, st2] = await Promise.all([mcp1.tool('room_status'), mcp2.tool('room_status')])
  assert.equal(st1.chat_id, 'SharedLegacyName')
  assert.equal(st2.chat_id, 'SharedLegacyName')
  assert.match(st1.session_address, /^agent-[a-z0-9]{8}~[A-Za-z0-9_-]{10}@/)
  assert.match(st2.session_address, /^agent-[a-z0-9]{8}~[A-Za-z0-9_-]{10}@/)
  assert.notEqual(st1.session_address.split('~')[0], st2.session_address.split('~')[0])
  await Promise.all([mcp1.close(), mcp2.close()])

  // (c) Proxy simulating persistent 409 agent_id_taken to test 3-attempt exhaustion and explicit 1-attempt fail-closed.
  const { proxyPort, seenBaseNames } = await withSessionPrincipals409Proxy(t, server.port)
  const runtimePath = join(dataDir, RUNTIME_RECORD_FILENAME)
  const origRecord = JSON.parse(readFileSync(runtimePath, 'utf8'))
  writeFileSync(runtimePath, `${JSON.stringify({ ...origRecord, port: proxyPort })}\n`)

  // CLI real child process exhaustion -> 3 attempts, exit 1.
  const cliExhaustPlugin = makeDir(t, 'agent-room-cli-exhaust-')
  const cliChild = spawn(process.execPath, [CLI_ENTRY, 'dm', '--to', peerAddress, '--text', 'exhaust', '--role', 'worker'], {
    env: {
      PATH: process.env.PATH || '',
      LANG: process.env.LANG || 'C.UTF-8',
      PLUGIN_DATA: cliExhaustPlugin,
      AGENT_ROOM_DATA_DIR: dataDir,
      AGENT_ROOM_SESSION_SCOPE: 'cli-exhaust',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let cliStderr = ''
  let cliStdout = ''
  cliChild.stderr.setEncoding('utf8')
  cliChild.stdout.setEncoding('utf8')
  cliChild.stderr.on('data', d => { cliStderr += d })
  cliChild.stdout.on('data', d => { cliStdout += d })
  const [cliExitCode] = await once(cliChild, 'exit')
  assert.equal(cliExitCode, 1)
  assert.equal(seenBaseNames.length, AGENT_ID_MINT_ATTEMPTS)
  assert.ok(seenBaseNames.every(n => /^worker-[a-z0-9]{8}$/.test(n)))
  assert.match(cliStdout + cliStderr, /could not mint a unique Agent ID after 3 attempts; pass --name/)

  // MCP child process exhaustion -> 3 attempts, exit 1.
  seenBaseNames.length = 0
  const mcpExhaustPlugin = makeDir(t, 'agent-room-mcp-exhaust-')
  const mcpExhaust = spawnMcpChild(t, { pluginData: mcpExhaustPlugin, sharedData: dataDir })
  const [mcpExitCode] = await Promise.all([
    once(mcpExhaust.child, 'exit'),
    mcpExhaust.initialize().catch(() => {}),
  ])
  assert.equal(mcpExitCode[0], 1)
  assert.equal(seenBaseNames.length, AGENT_ID_MINT_ATTEMPTS)
  assert.match(mcpExhaust.stderrText(), /could not mint a unique Agent ID after 3 attempts; pass --name/)

  // Explicit --name on MCP child -> 1 attempt only, exit 1.
  seenBaseNames.length = 0
  const mcpNamedPlugin = makeDir(t, 'agent-room-mcp-named-')
  const mcpNamed = spawnMcpChild(t, {
    pluginData: mcpNamedPlugin,
    sharedData: dataDir,
    extraArgs: ['--name', 'taken-explicit'],
  })
  const [mcpNamedCode] = await Promise.all([
    once(mcpNamed.child, 'exit'),
    mcpNamed.initialize().catch(() => {}),
  ])
  assert.equal(mcpNamedCode[0], 1)
  assert.deepEqual(seenBaseNames, ['taken-explicit'])

  // Restore real runtime port before any server/other cleanups.
  writeFileSync(runtimePath, `${JSON.stringify(origRecord)}\n`)

  // (d) Verify `send --to` flag validation also fails closed on bad --name.
  const badSend = await runSendFamilyCommand(['--to', peerAddress, '--text', 'hi', '--name', 'invalid name!'], {
    pluginDataDir: cliPluginData,
    sharedDataDir: dataDir,
    env: process.env,
  })
  assert.equal(badSend.status, 'usage')
  assert.equal(PUBLIC_ERROR_STATUS.agent_id_taken, 409)
  assert.equal(SESSION_BASE_LEASE_MS > 0, true)
})

test('AC4_NOTIFIER_DOES_NOT_SELF_HALT_ON_CHAT_ID_TAKEN: notifier survives chat_id_taken errors and never triggers STOP_CODES halt', async t => {
  const pluginData = makeDir(t, 'agent-room-notifier-s12-')
  let stopped = false
  let listCalls = 0
  const client = {
    transport: 'local',
    fingerprint: `sha256:${'f'.repeat(64)}`,
    async listRooms() {
      listCalls += 1
      const err = new Error('held by another connected session')
      err.code = 'chat_id_taken'
      throw err
    },
    async readMessage() {
      return { messages: [], next_after_seq: 0, head_seq: 0 }
    },
  }
  const notifier = startNotifier({
    client,
    pluginDataDir: pluginData,
    realmIdOf: async () => 'r1',
    env: {},
    errorOutput: { write() {} },
    onStop: () => { stopped = true },
    refreshMs: 25,
    spacingMs: 2,
  })
  t.after(() => notifier.stop())

  const deadline = Date.now() + 2000
  while (listCalls < 2 && Date.now() < deadline) {
    await sleep(50)
  }
  assert.ok(listCalls >= 2, `expected notifier to keep polling after chat_id_taken, got ${listCalls} calls`)
  assert.equal(stopped, false, 'notifier must never self-halt on chat_id_taken')
})
