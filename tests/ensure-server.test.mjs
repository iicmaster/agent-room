// Story 1.4 acceptance: the local bootstrap engine. Every row spawns or
// probes real processes (node:test with real child processes): first boot and
// live attach, the two-starter race resolving to exactly one server, stale
// lock and stale runtime-record reclamation (dead pid, and for the record
// also unreachable health), the half-stale credential proof and the
// foreign-process refusal, owned-child reaping on failed boots, and the
// binding checks (loopback only, no room socket file anywhere). The static
// rows pin FR-1's negative: the local path accepts no URL, credential, or
// room-name configuration anywhere.

import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { APP_VERSION, serverStartupLockPath } from '../server/runtime.mjs'
import { SERVER_STARTUP_LOCK_STALE_MS } from '../server/constants.mjs'
import { ensureServer, autoStartChildEnv } from '../server/client/ensure-server.mjs'
import { loadOrCreateLocalToken, localTokenPath } from '../server/api/local-token.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ENSURE_SERVER_MODULE = join(ROOT, 'server', 'client', 'ensure-server.mjs')
const RUNTIME_RECORD_FILENAME = 'runtime.json'

const sleep = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })

// Backdating offsets for staleness fixtures: 20 s and 60 s past — both beyond
// the ratified 15 s lock staleness window.
const STALE_PAST_OFFSET_MS = 20 * 1000
const VERY_STALE_PAST_OFFSET_MS = 60 * 1000

function makeDataDir(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-ensure-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  return dataDir
}

// Stops a (possibly detached) server child: SIGTERM first, SIGKILL past the
// deadline. Safe to call twice and for pids that are already gone.
async function stopServer(pid, { timeoutMs = 5000 } = {}) {
  try {
    process.kill(pid, 0)
  } catch {
    return
  }
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    return
  }
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await sleep(25)
  }
  try { process.kill(pid, 'SIGKILL') } catch { /* already gone */ }
  await sleep(100)
}

// A pid proven dead: spawn a child that exits immediately and reap it.
async function deadPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
  await once(child, 'exit')
  return child.pid
}

async function waitGone(pid, { timeoutMs = 5000 } = {}) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0)
    } catch {
      return
    }
    await sleep(25)
  }
  throw new Error(`pid ${pid} never exited`)
}

function assertRecordShape(result, { spawned }) {
  assert.equal(result.spawned, spawned)
  assert.ok(Number.isInteger(result.port) && result.port > 0)
  assert.deepEqual(Object.keys(result.record).sort(), ['pid', 'port', 'version'])
  assert.equal(result.record.port, result.port)
  assert.equal(result.record.version, APP_VERSION)
  assert.ok(Number.isInteger(result.record.pid) && result.record.pid > 0)
}

// ensureServer with automatic cleanup of the spawned/attached server.
async function ensureForTest(t, options) {
  const result = await ensureServer(options)
  t.after(() => stopServer(result.record.pid))
  return result
}

function healthRequest(port) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: '/health', method: 'GET', agent: false },
      response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('error', rejectPromise)
        response.on('end', () => resolvePromise({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.on('error', rejectPromise)
    req.end()
  })
}

// A plain HTTP responder that is not agent-room: clean responses prove a
// foreign occupant of the recorded port.
async function foreignServer(t) {
  const server = http.createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' })
    response.end('definitely not agent-room')
  })
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise))
  t.after(() => new Promise(resolvePromise => {
    server.closeAllConnections?.()
    server.close(() => resolvePromise())
  }))
  return server
}

// --- Boot, attach, and binding rows ---------------------------------------------

test('first ensureServer spawns one server and leaves the shared dir bootstrapped', async t => {
  const dataDir = makeDataDir(t)
  const result = await ensureForTest(t, { dataDir })
  assertRecordShape(result, { spawned: true })

  // The spawned server answers on the returned port.
  const health = await healthRequest(result.port)
  assert.equal(health.status, 200)
  assert.equal(JSON.parse(health.text).result.version, APP_VERSION)

  // Boot verification contract: runtime.json plus the 0600 token file; the
  // startup lock is released; no room socket file exists anywhere in the dir.
  const recordPath = join(dataDir, RUNTIME_RECORD_FILENAME)
  assert.ok(existsSync(recordPath))
  assert.equal(statSync(recordPath).mode & 0o777, 0o600)
  assert.ok(existsSync(localTokenPath(dataDir)))
  assert.equal(lstatSync(localTokenPath(dataDir)).mode & 0o777, 0o600)
  assert.equal(existsSync(serverStartupLockPath(dataDir)), false, 'the startup lock is released after boot')
  const socketFiles = readdirSync(dataDir).filter(name => name.endsWith('.sock'))
  assert.deepEqual(socketFiles, [])
  assert.equal(statSync(dataDir).mode & 0o777, 0o700)
})

test('a second ensureServer attaches to the live server without spawning', async t => {
  const dataDir = makeDataDir(t)
  const first = await ensureForTest(t, { dataDir })
  const second = await ensureServer({ dataDir })
  assertRecordShape(second, { spawned: false })
  assert.equal(second.record.pid, first.record.pid)
  assert.equal(second.port, first.port)
})

// A JSON-lines HTTP request against the auto-started server (the local-mode
// journey this suite's rows need; one socket, no keep-alive).
function jsonRequest(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers, agent: false },
      response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('error', rejectPromise)
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolvePromise({ status: response.statusCode, text, json: () => JSON.parse(text) })
        })
      },
    )
    req.on('error', rejectPromise)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

test('the auto-start child inherits the AGENT_ROOM_STORAGE_* operator knobs from the starting process', async t => {
  const dataDir = makeDataDir(t)
  // Set in THIS process's environment: the spawn whitelist passes the two
  // operator storage reserves through to the detached child when set (they
  // are validated inputs, never secrets — the child's own startup re-validates
  // them), so a plugin-managed auto-start tunes the reserves like any direct
  // launch. The refuse reserve tuned far above any real free space (and the
  // warn reserve above it, the pair being validated together) refuses sends
  // where the DEFAULT reserves would admit — the passthrough, proven on the
  // wire.
  const previousWarn = process.env.AGENT_ROOM_STORAGE_WARN_BYTES
  const previousRefuse = process.env.AGENT_ROOM_STORAGE_REFUSE_BYTES
  process.env.AGENT_ROOM_STORAGE_WARN_BYTES = String(2 ** 50)
  process.env.AGENT_ROOM_STORAGE_REFUSE_BYTES = String(2 ** 49)
  try {
    const result = await ensureForTest(t, { dataDir })
    const token = loadOrCreateLocalToken(dataDir)
    const installationKey = (await import('node:crypto'))
      .generateKeyPairSync('ed25519')
    const spki = installationKey.publicKey.export({ type: 'spki', format: 'der' })
    const publicKey = spki.subarray(spki.length - 32).toString('base64url')

    const auth = await jsonRequest(result.port, 'POST', '/api/auth/local', {
      headers: {
        'agent-room-protocol': '1',
        authorization: `Bearer ${token}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ public_key: publicKey }),
    })
    assert.equal(auth.status, 200, auth.text)
    const sessionToken = auth.json().result.session_token
    const bound = await jsonRequest(result.port, 'POST', '/api/session', {
      headers: {
        'agent-room-protocol': '1',
        authorization: `Bearer ${sessionToken}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ chat_id: 'AutoStart' }),
    })
    assert.equal(bound.status, 200, bound.text)
    const status = await jsonRequest(result.port, 'GET', '/api/status', {
      headers: { 'agent-room-protocol': '1', authorization: `Bearer ${sessionToken}` },
    })
    assert.equal(status.status, 200, status.text)
    const roomId = status.json().result.broadcast_room_id

    const sent = await jsonRequest(result.port, 'POST', `/api/rooms/${roomId}/messages`, {
      headers: {
        'agent-room-protocol': '1',
        authorization: `Bearer ${sessionToken}`,
        'content-type': 'application/json; charset=utf-8',
      },
      body: JSON.stringify({ chat_id: 'AutoStart', client_message_id: 'auto-start-1', text: 'refused through the inherited reserve' }),
    })
    assert.equal(sent.status, 200, sent.text)
    assert.equal(sent.json().ok, true)
    assert.deepEqual(sent.json().result, { status: 'storage_low' })
  } finally {
    if (previousWarn === undefined) delete process.env.AGENT_ROOM_STORAGE_WARN_BYTES
    else process.env.AGENT_ROOM_STORAGE_WARN_BYTES = previousWarn
    if (previousRefuse === undefined) delete process.env.AGENT_ROOM_STORAGE_REFUSE_BYTES
    else process.env.AGENT_ROOM_STORAGE_REFUSE_BYTES = previousRefuse
  }
})

test('the server binds loopback only: no other local address answers', async t => {
  const dataDir = makeDataDir(t)
  const result = await ensureForTest(t, { dataDir })

  let lanAddress = null
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const info of entries ?? []) {
      if (!info.internal && info.family === 'IPv4') lanAddress = lanAddress ?? info.address
    }
  }
  if (lanAddress === null) return // no non-loopback address on this host

  const dialLan = new Promise((resolvePromise, rejectPromise) => {
    const socket = net.connect({ host: lanAddress, port: result.port })
    socket.once('connect', () => { socket.destroy(); rejectPromise(new Error('the server answered off loopback')) })
    socket.once('error', resolvePromise)
    socket.setTimeout(2000, () => { socket.destroy(); resolvePromise() })
  })
  await dialLan
})

// --- Race rows -------------------------------------------------------------------

test('two concurrent ensureServer calls on a fresh dir spawn exactly one server', async t => {
  const dataDir = makeDataDir(t)
  const [first, second] = await Promise.all([
    ensureServer({ dataDir }),
    ensureServer({ dataDir }),
  ])
  // Order-tolerant: exactly one caller wins the boot, the other attaches —
  // never two servers.
  const spawned = [first, second].filter(result => result.spawned === true)
  const attached = [first, second].filter(result => result.spawned === false)
  assert.equal(spawned.length, 1, 'exactly one winner')
  assert.equal(attached.length, 1, 'exactly one loser attaching')
  assert.equal(first.record.pid, second.record.pid, 'both callers attach to the same server')
  assert.equal(first.port, second.port)
  t.after(() => stopServer(first.record.pid))

  const health = await healthRequest(first.port)
  assert.equal(health.status, 200)
})

// --- Stale lock rows --------------------------------------------------------------

test('a stale lock (dead owner, age over 15 s) is reclaimed and boot proceeds', async t => {
  const dataDir = makeDataDir(t)
  const lockPath = serverStartupLockPath(dataDir)
  const dead = await deadPid()
  writeFileSync(lockPath, `${dead}:${randomUUID()}`)
  const past = new Date(Date.now() - STALE_PAST_OFFSET_MS)
  utimesSync(lockPath, past, past)

  const result = await ensureForTest(t, { dataDir })
  assertRecordShape(result, { spawned: true })
  assert.equal(existsSync(lockPath), false, 'the reclaimed lock is released after boot')
})

test('a lock gone stale mid-wait is reclaimed within one invocation', async t => {
  const dataDir = makeDataDir(t)
  const lockPath = serverStartupLockPath(dataDir)
  const dead = await deadPid()
  // Fresh mtime: the lock is NOT stale when the invocation starts. The
  // default wait (20 s) deliberately exceeds the 15 s staleness window, so
  // the waiter reclaims it in the same invocation instead of giving up.
  const writtenAt = Date.now()
  writeFileSync(lockPath, `${dead}:${randomUUID()}`)

  const result = await ensureForTest(t, { dataDir })
  assertRecordShape(result, { spawned: true })
  assert.ok(Date.now() - writtenAt >= SERVER_STARTUP_LOCK_STALE_MS, 'the reclaim waited out the staleness window')
  assert.equal(existsSync(lockPath), false)
})

test('a lock whose owning pid is alive is never reclaimed, however old it is', async t => {
  const dataDir = makeDataDir(t)
  const lockPath = serverStartupLockPath(dataDir)
  writeFileSync(lockPath, `${process.pid}:${randomUUID()}`)
  const past = new Date(Date.now() - VERY_STALE_PAST_OFFSET_MS)
  utimesSync(lockPath, past, past)

  await assert.rejects(
    () => ensureServer({ dataDir, waitMs: 400 }),
    error => error?.code === 'server_start_busy',
  )
  // The live holder's lock survived, and no server was started.
  assert.ok(existsSync(lockPath))
  assert.equal(existsSync(join(dataDir, RUNTIME_RECORD_FILENAME)), false)
})

test('an unreadable startup lock fails closed, fast', { skip: process.platform === 'win32' }, async t => {
  const dataDir = makeDataDir(t)
  writeFileSync(serverStartupLockPath(dataDir), Buffer.alloc(4096, 0x61))
  const started = Date.now()
  await assert.rejects(
    () => ensureServer({ dataDir, waitMs: 1000 }),
    error => error?.code === 'server_start_lock_invalid',
  )
  assert.ok(Date.now() - started < 1000, 'a malformed lock must not block for the whole window')

  const fifoDir = makeDataDir(t)
  const fifo = spawnSync('mkfifo', [serverStartupLockPath(fifoDir)], { encoding: 'utf8' })
  assert.equal(fifo.status, 0, fifo.stderr)
  await assert.rejects(
    () => ensureServer({ dataDir: fifoDir, waitMs: 1000 }),
    error => error?.code === 'server_start_lock_invalid',
  )
})

// --- Runtime record rows -----------------------------------------------------------

test('a stale runtime record (dead pid, unreachable health) is reclaimed and a server spawns', async t => {
  const dataDir = makeDataDir(t)
  const crashed = await ensureForTest(t, { dataDir })

  // Simulate a crash: SIGKILL skips the graceful runtime-record cleanup.
  process.kill(crashed.record.pid, 'SIGKILL')
  await waitGone(crashed.record.pid)
  assert.ok(existsSync(join(dataDir, RUNTIME_RECORD_FILENAME)), 'the crashed server left its record')

  const result = await ensureServer({ dataDir })
  assertRecordShape(result, { spawned: true })
  assert.notEqual(result.record.pid, crashed.record.pid)
  t.after(() => stopServer(result.record.pid))

  const health = await healthRequest(result.port)
  assert.equal(health.status, 200)
})

test('a half-stale record reuses the answering server after a real credential exchange', async t => {
  const dataDir = makeDataDir(t)
  const live = await ensureForTest(t, { dataDir })

  // Hand-write a half-stale record: dead pid, but the port still serves the
  // SAME realm's server (it accepts this data dir's token and keypair).
  const dead = await deadPid()
  writeFileSync(join(dataDir, RUNTIME_RECORD_FILENAME), JSON.stringify({
    pid: dead,
    port: live.record.port,
    version: live.record.version,
  }))

  const reused = await ensureServer({ dataDir })
  assertRecordShape(reused, { spawned: false })
  assert.equal(reused.port, live.record.port, 'the credential-proofed server is reused')
  assert.equal(reused.record.pid, dead, 'the half-stale record was not rewritten or reclaimed')

  // The answering server was never signalled.
  const health = await healthRequest(live.record.port)
  assert.equal(health.status, 200)
})

test('a half-stale record pointing at another realm\'s server fails the credential proof', async t => {
  const dirA = makeDataDir(t)
  const dirB = makeDataDir(t)
  const gone = await ensureForTest(t, { dataDir: dirA })
  const foreign = await ensureForTest(t, { dataDir: dirB })

  process.kill(gone.record.pid, 'SIGKILL')
  await waitGone(gone.record.pid)

  // dirA's record now points at dirB's live server: the health probe answers
  // agent-room, but dirB rejects dirA's credentials — reuse must fail.
  const dead = await deadPid()
  writeFileSync(join(dirA, RUNTIME_RECORD_FILENAME), JSON.stringify({
    pid: dead,
    port: foreign.record.port,
    version: foreign.record.version,
  }))

  await assert.rejects(
    () => ensureServer({ dataDir: dirA, waitMs: 5000 }),
    error => error?.code === 'server_start_failed' && /credentials/.test(error.message),
  )

  // The foreign server was never signalled and still answers.
  const health = await healthRequest(foreign.record.port)
  assert.equal(health.status, 200)
})

test('a foreign responder on the recorded port is refused immediately, dead or live pid', async t => {
  const dataDir = makeDataDir(t)
  const server = await foreignServer(t)
  const foreignPort = server.address().port

  // Dead recorded pid (the original half-stale row).
  const dead = await deadPid()
  writeFileSync(join(dataDir, RUNTIME_RECORD_FILENAME), JSON.stringify({
    pid: dead,
    port: foreignPort,
    version: APP_VERSION,
  }))
  await assert.rejects(
    () => ensureServer({ dataDir, waitMs: 3000 }),
    error => error?.code === 'server_port_conflict',
  )
  assert.equal(existsSync(join(dataDir, RUNTIME_RECORD_FILENAME)), true, 'the entry was not reclaimed')

  // Classification consistency: the same refusal with a live recorded pid,
  // immediately rather than after a deadline.
  const liveDir = makeDataDir(t)
  writeFileSync(join(liveDir, RUNTIME_RECORD_FILENAME), JSON.stringify({
    pid: process.pid,
    port: foreignPort,
    version: APP_VERSION,
  }))
  const started = Date.now()
  await assert.rejects(
    () => ensureServer({ dataDir: liveDir, waitMs: 3000 }),
    error => error?.code === 'server_port_conflict',
  )
  assert.ok(Date.now() - started < 2000, 'the refusal is immediate')

  // The foreign process still answers — nothing was ever signalled.
  const stillThere = await new Promise((resolvePromise, rejectPromise) => {
    const req = http.request({ host: '127.0.0.1', port: foreignPort, path: '/', agent: false }, response => {
      response.resume()
      response.on('end', () => resolvePromise(response.statusCode))
    })
    req.on('error', rejectPromise)
    req.end()
  })
  assert.equal(stillThere, 200)
})

test('a live recorded pid with unreachable health is awaited, never shadowed by a sibling boot', async t => {
  const dataDir = makeDataDir(t)
  // Bind and release a port so the record points somewhere health cannot answer.
  const probe = net.createServer()
  await new Promise((resolvePromise, rejectPromise) => {
    probe.once('error', rejectPromise)
    probe.listen(0, '127.0.0.1', () => resolvePromise())
  })
  const freePort = probe.address().port
  await new Promise(resolvePromise => probe.close(resolvePromise))

  writeFileSync(join(dataDir, RUNTIME_RECORD_FILENAME), JSON.stringify({
    pid: process.pid, // provably alive
    port: freePort,
    version: APP_VERSION,
  }))

  await assert.rejects(
    () => ensureServer({ dataDir, waitMs: 500 }),
    error => error?.code === 'server_start_failed',
  )
  assert.equal(existsSync(join(dataDir, RUNTIME_RECORD_FILENAME)), true, 'a live pid is never reclaimed')
})

test('attach refuses a major-version-incompatible record and names both versions', async t => {
  const dataDir = makeDataDir(t)
  const live = await ensureForTest(t, { dataDir })

  writeFileSync(join(dataDir, RUNTIME_RECORD_FILENAME), JSON.stringify({
    pid: live.record.pid, // alive
    port: live.record.port, // healthy
    version: '1.2.3', // incompatible major
  }))

  await assert.rejects(
    () => ensureServer({ dataDir, waitMs: 2000 }),
    error => error?.code === 'server_start_failed'
      && error.message.includes('1.2.3')
      && error.message.includes(APP_VERSION),
  )

  // The healthy server was never signalled.
  const health = await healthRequest(live.record.port)
  assert.equal(health.status, 200)
})

// --- Boot failure rows --------------------------------------------------------------

test('a boot that never becomes ready reaps the child it owns before releasing the lock', async t => {
  const dataDir = makeDataDir(t)
  const stubPath = join(dataDir, 'stub-server.mjs')
  writeFileSync(stubPath, [
    "import { writeFileSync } from 'node:fs'",
    "import { join } from 'node:path'",
    "writeFileSync(join(process.env.AGENT_ROOM_DATA_DIR, 'stub.pid'), String(process.pid))",
    'setInterval(() => {}, 1000)',
  ].join('\n'))

  await assert.rejects(
    () => ensureServer({ dataDir, serverPath: stubPath, waitMs: 600 }),
    error => error?.code === 'server_start_failed',
  )

  // No orphan: the stub child reported its pid and is gone.
  const stubPid = Number(readFileSync(join(dataDir, 'stub.pid'), 'utf8'))
  assert.ok(Number.isInteger(stubPid) && stubPid > 0)
  await waitGone(stubPid)
  assert.equal(existsSync(serverStartupLockPath(dataDir)), false, 'the lock was released after the reap')

  // The data dir is bootable again immediately.
  const retry = await ensureForTest(t, { dataDir })
  assertRecordShape(retry, { spawned: true })
})

test('a spawn failure is a coded error and releases the lock', async t => {
  const dataDir = makeDataDir(t)
  await assert.rejects(
    () => ensureServer({ dataDir, serverPath: join(dataDir, 'does-not-exist.mjs'), waitMs: 2000 }),
    error => error?.code === 'server_start_failed',
  )
  assert.equal(existsSync(serverStartupLockPath(dataDir)), false)
})

test('a directory squatting the runtime record path refuses to bootstrap', async t => {
  const dataDir = makeDataDir(t)
  mkdirSync(join(dataDir, RUNTIME_RECORD_FILENAME))
  await assert.rejects(
    () => ensureServer({ dataDir, waitMs: 500 }),
    error => error?.code === 'server_start_failed' && /directory/.test(error.message),
  )
})

// --- Option validation and the FR-1 negative ---------------------------------------

test('ensureServer validates its options', async t => {
  const dataDir = makeDataDir(t)
  await assert.rejects(() => ensureServer({ dataDir, waitMs: 0 }), /waitMs/)
  await assert.rejects(() => ensureServer({ dataDir, waitMs: -5 }), /waitMs/)
  await assert.rejects(() => ensureServer({ dataDir, serverPath: '' }), /serverPath/)
})

test('the auto-start child environment is a closed whitelist: exact keys, knobs only when set', () => {
  // The whitelist's hygiene is the claim: PATH/LANG/AGENT_ROOM_DATA_DIR
  // always, the two storage knobs ONLY when set, and nothing else — a
  // canary in the starting process's environment must not pass.
  const env = {
    PATH: '/usr/bin:/bin',
    LANG: 'C.UTF-8',
    HOME: '/home/you',
    TMPDIR: '/tmp',
    AGENT_ROOM_DATA_DIR: '/somewhere/else-ignored',
    AGENT_ROOM_SECRET: 'canary-must-not-pass',
    AGENT_ROOM_STORAGE_WARN_BYTES: '2147483648',
    AGENT_ROOM_STORAGE_REFUSE_BYTES: '536870912',
    PLUGIN_DATA: '/plugin-side-state',
  }
  const child = autoStartChildEnv({ env, dataDir: '/data' })
  assert.deepEqual(
    Object.keys(child).sort(),
    ['AGENT_ROOM_DATA_DIR', 'AGENT_ROOM_STORAGE_REFUSE_BYTES', 'AGENT_ROOM_STORAGE_WARN_BYTES', 'LANG', 'PATH'],
    'the exact key set: PATH, LANG, the data dir, and the two knobs',
  )
  assert.equal(child.AGENT_ROOM_DATA_DIR, '/data', 'the data dir is the canonical name, never the parent env\'s')
  assert.equal(child.AGENT_ROOM_STORAGE_WARN_BYTES, '2147483648')
  assert.equal(child.AGENT_ROOM_STORAGE_REFUSE_BYTES, '536870912')
  assert.equal(child.AGENT_ROOM_SECRET, undefined, 'the canary stays behind')
  assert.equal(child.HOME, undefined)
  assert.equal(child.PLUGIN_DATA, undefined)

  // Knobs absent: the exact three-key base set.
  const quiet = autoStartChildEnv({ env: { PATH: '/bin', LANG: 'C' }, dataDir: '/data' })
  assert.deepEqual(Object.keys(quiet).sort(), ['AGENT_ROOM_DATA_DIR', 'LANG', 'PATH'])
  assert.equal(quiet.PATH, '/bin')
  assert.equal(quiet.LANG, 'C')

  // Missing PATH/LANG fall back to the spawn-safe defaults.
  const bare = autoStartChildEnv({ env: {}, dataDir: '/data' })
  assert.equal(bare.PATH, '')
  assert.equal(bare.LANG, 'C.UTF-8')
  assert.throws(() => autoStartChildEnv({ env: {}, dataDir: '' }), error => error.code === 'invalid_argument')
})

test('the local path takes no URL, credential, or room-name configuration anywhere', () => {
  const source = readFileSync(ENSURE_SERVER_MODULE, 'utf8')
  // No room-socket reference of any kind, no per-client identity source, no
  // configured endpoints, and none of the frozen request vocabulary as input.
  assert.equal(/roomd\.sock/.test(source), false)
  assert.equal(/\bunix\b/i.test(source), false)
  assert.equal(/PLUGIN_DATA/.test(source), false)
  assert.equal(/https?:\/\//.test(source), false)
  assert.equal(/invite_token|chat_id|room_id|server_url|base_url/i.test(source), false)
})
