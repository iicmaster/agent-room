// Story 2.4 — endurance in daily development: the connection-churn regression
// and the memory pass rule, both over REAL processes with zero mocks.
//
// The churn row is the numeric oracle the criterion demands (review M4: never
// "stable"): one real spawned server child, then 100 full connect →
// authenticate → bind → send → disconnect cycles over real loopback HTTP
// (every request its own socket, Connection: close), each cycle asserting its
// wire answers — including, since Story 4.4, one uniquely-identified
// Broadcast Room send per cycle through the real rate gates, sampled for the
// send-latency tripwire. The server's file-descriptor count is sampled FROM
// OUTSIDE through the leak-tracker harness (ps/lsof on macOS, /proc on Linux)
// before, during, and after the churn, and every sample must sit within ±5 of
// the post-warmup baseline; a TCP-socket inventory of the server process must
// then show exactly one socket — the listener — proving zero leaked sockets,
// and a presence probe must show zero leaked live sessions.
//
// The memory row runs a bounded churn workload under the tracker's timed
// sampling and asserts the single memory pass rule: the least-squares slope of
// the server's RSS, as a percent of starting RSS per second, at or below 2%.
// The workload warms up HARD first (unpaced churn to drive the runtime's
// allocator to its steady-state working set) and only then measures a
// time-bounded paced window — the slope must read retained growth (leaks),
// never allocator ramp-up. Time is compressed by the tracker's interval (the
// rule is a RATE, so the wall duration carries no weight); this proves the
// short-horizon leak discipline, not a multi-hour soak — that is Story 6.3's
// REL-3.
//
// The server is never stubbed: a real child of server/api/server.mjs on a
// fresh 0700 data dir, a real 0600 local-token file and a real Ed25519
// installation keypair drive the exact credential exchange the shipped client
// uses. The harness (tests/harness/leak-tracker.mjs) supplies every RSS/FD
// number; its own unit suite proves the sampling and regression mechanics.

import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  assertMemoryPass,
  createLeakTracker,
} from './harness/leak-tracker.mjs'
import { loadOrCreateLocalToken } from '../server/api/local-token.mjs'
import { loadOrCreateKeypair } from '../server/keys.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = join(ROOT, 'server', 'api', 'server.mjs')
const RUNTIME_RECORD_FILENAME = 'runtime.json'
const DATABASE_FILENAME = 'agent-room.sqlite'

// Story 4.4: this harness is its server child's operator. The four gates'
// documented env floors are raised so the harness's point — hundreds of
// full connect/authenticate/bind/send/disconnect cycles from ONE
// installation key — is the churn it drives, not throttling; the gates still
// run on every request, and their refusal behavior is exercised for its own
// sake by tests/rate-gates.test.mjs at the declared defaults.
const OPERATOR_RATE_FLOOR_ENV = Object.freeze({
  AGENT_ROOM_SEND_TOKEN_REFILL_PER_SECOND: '2000',
  AGENT_ROOM_SEND_TOKEN_CAPACITY: '100000',
  AGENT_ROOM_REQUEST_BUDGET_PER_MINUTE: '120000',
  AGENT_ROOM_REQUEST_BUDGET_BURST: '100000',
})

// Wire vocabulary as literals of this file (the oracle discipline: expected
// values are built here, never imported).
const PROTOCOL_KEY = 'agent-room-protocol'
const PROTOCOL_VERSION = '1'

// Harness budgets (local constants, never production modules).
const STARTUP_DEADLINE_MS = 10_000
const REQUEST_DEADLINE_MS = 10_000
const CHILD_REAP_GRACE_MS = 2_000
const READY_POLL_INTERVAL_MS = 25
const TEARDOWN_SETTLE_MS = 100

// The churn row: 100 cycles per the criterion, warmup first, FD sampling
// through the tracker every 10 cycles plus a baseline and a final sample.
const CHURN_WARMUP_CYCLES = 10
const CHURN_CYCLES = 100
const CHURN_SAMPLE_EVERY_CYCLES = 10
const FD_DRIFT_TOLERANCE = 5

// The memory row: the warmup drives the runtime's allocator to the steady-
// state working set this workload's allocation rate demands (the same reason
// soaks warm up before measuring), then a time-bounded PACED window runs
// under the tracker's timed sampling, so the least-squares slope reads
// retained growth — leaks — not allocator ramp-up. Since Story 4.4 each
// cycle also carries a status read and a Broadcast Room send through the
// real gates (six requests), so the warmup grew from 2500 to 4500 cycles to
// reach the heavier workload's plateau.
const MEMORY_WARMUP_CYCLES = 4500
const MEMORY_SETTLE_MS = 500
const MEMORY_WINDOW_MS = 10_000
const MEMORY_WINDOW_HARD_CAP_MS = 25_000
const MEMORY_MAX_CYCLES = 6000
const MEMORY_CYCLE_PACE_MS = 2
const MEMORY_MIN_CYCLES = 200
const MEMORY_MIN_WORK_CYCLES = 100
const MEMORY_MIN_SAMPLES = 30
const MEMORY_SAMPLE_INTERVAL_MS = 20
const MEMORY_TOLERANCE_PCT = 2
const FD_DRIFT_TOLERANCE_SUSTAINED = 5

const CHAT_ID = 'churn'
const PROBE_CHAT_ID = 'churnprobe'

const sleep = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })

// --- Real HTTP client (no agent, no keep-alive: one socket per request) ---------

function request(port, method, path, { headers = {}, body } = {}) {
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

async function withDeadline(promise, label, budgetMs = REQUEST_DEADLINE_MS) {
  let timer = null
  try {
    return await Promise.race([
      promise,
      new Promise((_, rejectPromise) => {
        timer = setTimeout(() => rejectPromise(new Error(`${label} exceeded its ${budgetMs}ms deadline`)), budgetMs)
      }),
    ])
  } finally {
    if (timer !== null) clearTimeout(timer)
  }
}

// One full connect → authenticate → bind → use → disconnect cycle, every step
// asserted on the wire. agent:false pins Connection: close, so a cycle drives
// five fresh real sockets through the server. Story 4.4 adds the SEND half:
// each cycle reads the realm status and appends one uniquely-identified
// message to the Broadcast Room through the real rate gates (at the raised
// operator floors), timing the send end-to-end for the latency sample — the
// binding p95 ≤ 150 ms oracle lives in tests/rate-gates.test.mjs, measured
// server-side; here it is a pathology tripwire only.
async function churnCycle(port, credentials, cycleNumber) {
  const label = `cycle ${cycleNumber}`
  const auth = await withDeadline(request(port, 'POST', '/api/auth/local', {
    headers: {
      [PROTOCOL_KEY]: PROTOCOL_VERSION,
      authorization: `Bearer ${credentials.localToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ public_key: credentials.publicKey }),
  }), `${label}: authenticate`)
  assert.equal(auth.status, 200, `${label}: the credential exchange answered ${auth.status}: ${auth.text}`)
  const sessionToken = auth.json().result.session_token
  assert.equal(typeof sessionToken === 'string' && sessionToken.length > 0, true, `${label}: a session token was issued`)

  const bind = await withDeadline(request(port, 'POST', '/api/session', {
    headers: {
      [PROTOCOL_KEY]: PROTOCOL_VERSION,
      authorization: `Bearer ${sessionToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ chat_id: CHAT_ID }),
  }), `${label}: bind`)
  assert.equal(bind.status, 200, `${label}: the bind answered ${bind.status}: ${bind.text}`)
  assert.equal(bind.json().result.chat_id, CHAT_ID, `${label}: the session bound "${CHAT_ID}"`)

  const presence = await withDeadline(request(port, 'GET', '/api/presence', {
    headers: { [PROTOCOL_KEY]: PROTOCOL_VERSION, authorization: `Bearer ${sessionToken}` },
  }), `${label}: presence read`)
  assert.equal(presence.status, 200, `${label}: the presence read answered ${presence.status}: ${presence.text}`)
  assert.equal(Array.isArray(presence.json().result.online), true, `${label}: the presence read returned the online group`)

  const status = await withDeadline(request(port, 'GET', '/api/status', {
    headers: { [PROTOCOL_KEY]: PROTOCOL_VERSION, authorization: `Bearer ${sessionToken}` },
  }), `${label}: status read`)
  assert.equal(status.status, 200, `${label}: the status read answered ${status.status}: ${status.text}`)
  const broadcastRoomId = status.json().result.broadcast_room_id
  assert.equal(typeof broadcastRoomId === 'string' && broadcastRoomId.length > 0, true, `${label}: the status read named the Broadcast Room`)

  const clientMessageId = `churn-${String(cycleNumber).replace(/[^A-Za-z0-9_.:-]+/g, '-')}`
  const sendStartedAt = Date.now()
  const sent = await withDeadline(request(port, 'POST', `/api/rooms/${broadcastRoomId}/messages`, {
    headers: {
      [PROTOCOL_KEY]: PROTOCOL_VERSION,
      authorization: `Bearer ${sessionToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ chat_id: CHAT_ID, client_message_id: clientMessageId, text: `churn cycle ${cycleNumber}` }),
  }), `${label}: send`)
  const sendLatencyMs = Date.now() - sendStartedAt
  assert.equal(sent.status, 200, `${label}: the send answered ${sent.status}: ${sent.text}`)
  const sendResult = sent.json().result
  assert.equal(sendResult.status, 'committed', `${label}: the send is committed`)
  assert.equal(typeof sendResult.seq === 'number' && sendResult.seq >= 1, true, `${label}: the send acked at a positive sequence`)
  assert.deepEqual(Object.keys(sendResult).sort(), ['room_id', 'seq', 'status'], `${label}: the committed send carries exactly the frozen result keys`)

  const release = await withDeadline(request(port, 'DELETE', '/api/session', {
    headers: { [PROTOCOL_KEY]: PROTOCOL_VERSION, authorization: `Bearer ${sessionToken}` },
  }), `${label}: disconnect`)
  assert.equal(release.status, 200, `${label}: the disconnect answered ${release.status}: ${release.text}`)

  return { cycle: cycleNumber, chat_id: bind.json().result.chat_id, sendLatencyMs, seq: sendResult.seq }
}

// --- Server TCP-socket inventory (the zero-leaked-sockets oracle) -----------------

function commandOutput(file, args, timeoutMs = REQUEST_DEADLINE_MS) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(file, args, { encoding: 'utf8', timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        error.stdout = stdout
        error.stderr = stderr
        rejectPromise(error)
        return
      }
      resolvePromise({ stdout, stderr })
    })
  })
}

function parseLsofFds(stdout) {
  return stdout.split('\n')
    .map(line => /^f(\d+)$/.exec(line))
    .filter(Boolean)
    .map(match => Number(match[1]))
    .sort((left, right) => left - right)
}

async function darwinTcpFds(pid, extraArgs) {
  try {
    const { stdout } = await commandOutput('lsof', ['-a', '-p', String(pid), ...extraArgs, '-F', 'f'])
    return parseLsofFds(stdout)
  } catch (error) {
    if (error?.code === 1) return [] // lsof exit 1: no objects matched — zero sockets
    throw error
  }
}

function linuxTcpSocketInodes({ listeningPort = null } = {}) {
  const wantedPortHex = listeningPort === null
    ? null
    : listeningPort.toString(16).toUpperCase().padStart(4, '0')
  const inodes = new Set()
  for (const table of ['/proc/net/tcp', '/proc/net/tcp6']) {
    if (!existsSync(table)) continue
    for (const line of readFileSync(table, 'utf8').split('\n').slice(1)) {
      const columns = line.trim().split(/\s+/)
      if (columns.length < 10) continue
      if (listeningPort !== null && (columns[3] !== '0A' || columns[1]?.split(':')[1] !== wantedPortHex)) continue
      inodes.add(columns[9])
    }
  }
  return inodes
}

function linuxTcpFds(pid, { listeningPort = null } = {}) {
  const inodes = linuxTcpSocketInodes({ listeningPort })
  if (inodes.size === 0) return []
  const descriptors = []
  for (const entry of readdirSync(`/proc/${pid}/fd`)) {
    let target
    try {
      target = readlinkSync(`/proc/${pid}/fd/${entry}`)
    } catch {
      continue // the descriptor closed mid-scan
    }
    const match = /^socket:\[(\d+)\]$/.exec(target)
    if (match && inodes.has(match[1])) descriptors.push(Number(entry))
  }
  return descriptors.sort((left, right) => left - right)
}

// Every TCP socket the server process currently holds, and the LISTEN subset.
// After full churn the two lists must be EQUAL — every connection socket closed.
async function tcpSocketFds(pid) {
  return process.platform === 'darwin'
    ? darwinTcpFds(pid, ['-iTCP'])
    : process.platform === 'linux'
      ? linuxTcpFds(pid)
      : assert.fail(`unsupported TCP-inventory platform: ${process.platform}`)
}

async function tcpListeningFds(pid, port) {
  return process.platform === 'darwin'
    ? darwinTcpFds(pid, ['-iTCP', '-sTCP:LISTEN'])
    : process.platform === 'linux'
      ? linuxTcpFds(pid, { listeningPort: port })
      : assert.fail(`unsupported TCP-inventory platform: ${process.platform}`)
}

// --- The isolated world: one real server child per test ---------------------------

function modeOf(path, kind) {
  const info = lstatSync(path)
  assert.equal(info.isSymbolicLink(), false, `${path}: state path must not be a symlink`)
  if (kind === 'file') assert.equal(info.isFile(), true, `${path}: state path must be a regular file`)
  if (kind === 'directory') assert.equal(info.isDirectory(), true, `${path}: state path must be a directory`)
  return info.mode & 0o777
}

function makeWorld(t) {
  const parent = mkdtempSync(join(tmpdir(), 'agent-room-churn-'))
  chmodSync(parent, 0o700)
  const sharedData = join(parent, 'shared')
  const pluginData = join(parent, 'client')
  mkdirSync(sharedData, { mode: 0o700 })
  mkdirSync(pluginData, { mode: 0o700 })
  const configPath = join(pluginData, 'config.json')
  writeFileSync(configPath, `${JSON.stringify({ chat_id: CHAT_ID }, null, 2)}\n`, { mode: 0o600 })

  const runtimePath = join(sharedData, RUNTIME_RECORD_FILENAME)
  const databasePath = join(sharedData, DATABASE_FILENAME)
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, AGENT_ROOM_DATA_DIR: sharedData, ...OPERATOR_RATE_FLOOR_ENV },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdout.resume()

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGTERM')
      const raced = await Promise.race([
        once(child, 'exit'),
        sleep(CHILD_REAP_GRACE_MS).then(() => 'timeout'),
      ])
      if (raced === 'timeout' && child.exitCode === null && child.signalCode === null) {
        child.kill('SIGKILL')
        await once(child, 'exit').catch(() => {})
      }
    }
    rmSync(parent, { recursive: true, force: true })
  })

  // Readiness is declared ONLY by a runtime record naming THIS child's pid
  // with a valid port (the stale-record discipline of the restart-survival
  // harness, so the port below is provably this child's).
  const waitReady = async () => {
    const deadline = Date.now() + STARTUP_DEADLINE_MS
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`the server child exited early (code=${child.exitCode} signal=${child.signalCode}); stderr=${stderr}`)
      }
      if (existsSync(runtimePath)) {
        try {
          const record = JSON.parse(readFileSync(runtimePath, 'utf8'))
          if (
            record && typeof record === 'object'
            && record.pid === child.pid
            && Number.isInteger(record.port) && record.port > 0 && record.port <= 65535
            && typeof record.version === 'string' && record.version.length > 0
          ) {
            return record
          }
        } catch { /* atomic rename: readers retry */ }
      }
      if (Date.now() > deadline) {
        throw new Error(`runtime.json never named pid ${child.pid} within ${STARTUP_DEADLINE_MS} ms; stderr=${stderr}`)
      }
      await sleep(READY_POLL_INTERVAL_MS)
    }
  }

  // The real credentials the shipped client would hold: the shared data dir's
  // 0600 local token and the installation's Ed25519 keypair.
  const localToken = loadOrCreateLocalToken(sharedData)
  const keypair = loadOrCreateKeypair(pluginData)
  const credentials = {
    localToken,
    publicKey: keypair.publicKey.toString('base64url'),
    fingerprint: keypair.fingerprint,
  }

  return {
    parent,
    sharedData,
    pluginData,
    databasePath,
    runtimePath,
    child,
    credentials,
    waitReady,
    get serverPid() { return child.pid },
    get stderrText() { return stderr },
  }
}

function assertWorldPermissions(world) {
  assert.equal(modeOf(world.parent, 'directory'), 0o700, 'the temporary parent is 0700')
  assert.equal(modeOf(world.sharedData, 'directory'), 0o700, 'the shared data directory is 0700')
  assert.equal(modeOf(world.pluginData, 'directory'), 0o700, 'PLUGIN_DATA is 0700')
  assert.equal(modeOf(join(world.pluginData, 'config.json'), 'file'), 0o600, 'config.json is 0600')
  assert.equal(modeOf(join(world.sharedData, 'local-token'), 'file'), 0o600, 'the local token file is 0600')
}

// --- The churn regression -----------------------------------------------------------

test('connection churn: 100 connect/authenticate/bind/send/disconnect cycles all succeed, hold the server at its post-warmup FD baseline (±5), and leak zero sockets', async t => {
  const world = makeWorld(t)
  assertWorldPermissions(world)
  const runtimeRecord = await world.waitReady()
  assert.deepEqual(Object.keys(runtimeRecord).sort(), ['pid', 'port', 'version'], 'runtime.json is exactly {pid, port, version}')
  assert.equal(modeOf(world.runtimePath, 'file'), 0o600, 'runtime.json is 0600')
  const port = runtimeRecord.port

  const tracker = createLeakTracker({ pid: world.serverPid, intervalMs: 50, tolerancePct: MEMORY_TOLERANCE_PCT })

  // The send log is append-only and this installation is its only sender, so
  // every cycle's Broadcast Room send acks at exactly lastSeq + 1 — a
  // monotonic counter across warmup and measured churn — and every send's
  // end-to-end latency is sampled for the Story 4.4 tripwire.
  let lastSeq = 0
  const sendLatencySamples = []

  // Warmup absorbs boot-adjacent growth so the baseline below is the
  // steady-state server, not a half-warm one.
  for (let cycle = 1; cycle <= CHURN_WARMUP_CYCLES; cycle += 1) {
    const warmed = await churnCycle(port, world.credentials, `warmup ${cycle}`)
    assert.equal(warmed.seq, lastSeq + 1, `warmup ${cycle}: the send acked at the next sequence`)
    lastSeq = warmed.seq
    sendLatencySamples.push(warmed.sendLatencyMs)
  }
  await sleep(TEARDOWN_SETTLE_MS)

  // The post-warmup baseline, taken through the harness like every later
  // number in this test.
  const baseline = await tracker.sampleNow()
  assert.ok(baseline.fdCount >= 6, `the warm server holds at least stdio + listener + sqlite descriptors, received ${baseline.fdCount}`)
  assert.ok(baseline.rssBytes > 1_000_000, `the warm server's RSS is plausible, received ${baseline.rssBytes}`)

  // The 100 cycles: every one asserted on the wire; the server's FD count is
  // sampled through the tracker every CHURN_SAMPLE_EVERY_CYCLES cycles.
  const completed = []
  for (let cycle = 1; cycle <= CHURN_CYCLES; cycle += 1) {
    const done = await churnCycle(port, world.credentials, cycle)
    assert.equal(done.seq, lastSeq + 1, `cycle ${cycle}: the send acked at the next sequence`)
    lastSeq = done.seq
    sendLatencySamples.push(done.sendLatencyMs)
    completed.push(done)
    if (cycle % CHURN_SAMPLE_EVERY_CYCLES === 0) await tracker.sampleNow()
  }
  await sleep(TEARDOWN_SETTLE_MS)
  const final = await tracker.sampleNow()

  // Oracle 1 — all 100 cycles succeeded, in order, each having bound the Chat ID.
  assert.equal(completed.length, CHURN_CYCLES, `all ${CHURN_CYCLES} cycles completed`)
  assert.deepEqual(
    completed.map(entry => entry.cycle),
    Array.from({ length: CHURN_CYCLES }, (_, index) => index + 1),
    `the completed cycles are exactly 1..${CHURN_CYCLES}`,
  )
  assert.equal(
    new Set(completed.map(entry => entry.chat_id)).size,
    1,
    `every cycle bound "${CHAT_ID}"`,
  )

  // Oracle 2 — every FD sample sits within ±5 of the post-warmup baseline
  // (the numeric churn oracle; a leaked handle per cycle would drift +300).
  const observed = [baseline, ...tracker.samples, final]
  const drifts = observed.map(sample => Math.abs(sample.fdCount - baseline.fdCount))
  const worstDrift = Math.max(...drifts)
  assert.ok(
    worstDrift <= FD_DRIFT_TOLERANCE,
    `the server's FD count left the ±${FD_DRIFT_TOLERANCE} corridor around the post-warmup baseline ${baseline.fdCount}: ` +
    `worst drift ${worstDrift} across ${observed.length} samples ` +
    `(samples: ${observed.map(sample => sample.fdCount).join(', ')})`,
  )

  // Oracle 3 — zero leaked sockets: the server now holds exactly one TCP
  // socket, the listener, and nothing else.
  const listening = await tcpListeningFds(world.serverPid, port)
  assert.equal(listening.length, 1, `the server holds exactly one LISTEN socket, received ${listening.length}`)
  const allTcp = await tcpSocketFds(world.serverPid)
  assert.deepEqual(allTcp, listening, `every connection socket closed: the server's TCP FDs ${JSON.stringify(allTcp)} must equal the listener ${JSON.stringify(listening)}`)

  // Oracle 4 — the server survived the churn and answers with the same version.
  const health = await withDeadline(request(port, 'GET', '/health'), 'post-churn health')
  assert.equal(health.status, 200, `the server answers /health after the churn: ${health.text}`)
  assert.equal(health.json().result.version, runtimeRecord.version, 'the post-churn version matches the runtime record')
  assert.equal(world.child.exitCode === null && world.child.signalCode === null, true, 'the server process is still alive')

  // Oracle 5 — zero leaked live sessions: a fresh probe session reads a
  // presence view containing exactly itself, so none of the 100 disconnects
  // left a name online.
  const probeAuth = await withDeadline(request(port, 'POST', '/api/auth/local', {
    headers: {
      [PROTOCOL_KEY]: PROTOCOL_VERSION,
      authorization: `Bearer ${world.credentials.localToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ public_key: world.credentials.publicKey }),
  }), 'probe authenticate')
  assert.equal(probeAuth.status, 200, `the probe session authenticated: ${probeAuth.text}`)
  const probeToken = probeAuth.json().result.session_token
  const probeBind = await withDeadline(request(port, 'POST', '/api/session', {
    headers: {
      [PROTOCOL_KEY]: PROTOCOL_VERSION,
      authorization: `Bearer ${probeToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ chat_id: PROBE_CHAT_ID }),
  }), 'probe bind')
  assert.equal(probeBind.status, 200, `the probe session bound: ${probeBind.text}`)
  const probePresence = await withDeadline(request(port, 'GET', '/api/presence', {
    headers: { [PROTOCOL_KEY]: PROTOCOL_VERSION, authorization: `Bearer ${probeToken}` },
  }), 'probe presence')
  assert.equal(probePresence.status, 200, `the probe presence read answered: ${probePresence.text}`)
  const online = probePresence.json().result.online
  assert.equal(online.length, 1, `exactly one live session remains (the probe itself), received ${online.length}: ${JSON.stringify(online)}`)
  assert.equal(online[0].chat_id, PROBE_CHAT_ID, 'the one live session is the probe')
  assert.equal(online[0].fingerprint, world.credentials.fingerprint, 'the probe session carries the installation fingerprint')
  const probeRelease = await withDeadline(request(port, 'DELETE', '/api/session', {
    headers: { [PROTOCOL_KEY]: PROTOCOL_VERSION, authorization: `Bearer ${probeToken}` },
  }), 'probe disconnect')
  assert.equal(probeRelease.status, 200, 'the probe session disconnected')

  // Oracle 6 — Story 4.4's churn send sampling: over warmup + the 100 cycles,
  // every send completed through the real gates and the end-to-end p95 stays
  // inside this harness's generous tripwire. The BINDING p95 ≤ 150 ms oracle
  // lives in tests/rate-gates.test.mjs, measured server-side; this row only
  // catches pathological regressions while real churn traffic flows.
  sendLatencySamples.sort((left, right) => left - right)
  const p95 = sendLatencySamples[Math.ceil(0.95 * sendLatencySamples.length) - 1]
  t.diagnostic(`send latency across ${sendLatencySamples.length} churn sends: p95=${p95}ms max=${sendLatencySamples[sendLatencySamples.length - 1]}ms`)
  assert.ok(p95 <= 1000, `the churn send p95 ${p95}ms must stay inside the 1000 ms pathology tripwire (the binding 150 ms oracle is server-side in tests/rate-gates.test.mjs)`)
})

// --- The memory pass rule ------------------------------------------------------------

test('memory pass: a bounded churn workload under the leak tracker holds the least-squares RSS slope at or below 2% of starting RSS', async t => {
  const world = makeWorld(t)
  assertWorldPermissions(world)
  const runtimeRecord = await world.waitReady()
  const port = runtimeRecord.port

  // Warmup: hard, unpaced churn long enough to drive the runtime's allocator
  // (V8 heap sizing, SQLite page cache) to the steady-state working set this
  // workload's allocation rate demands — the same reason a soak warms up
  // before measuring. Without it the measured slope would read allocator
  // ramp-up (measured: several %/s for the first seconds of hot traffic),
  // not the retained growth the rule exists to catch.
  for (let cycle = 1; cycle <= MEMORY_WARMUP_CYCLES; cycle += 1) {
    await churnCycle(port, world.credentials, `warmup ${cycle}`)
  }
  await sleep(MEMORY_SETTLE_MS)

  // The measured window: time-bounded paced churn under the tracker's timed
  // sampling. The window ends when it has run its nominal length AND done its
  // minimum real work — so a slow machine (or a loaded suite) stretches the
  // window instead of shrinking the evidence — and never runs past the hard
  // caps. The pace keeps the allocation rate at the level the warmup already
  // sized the heap for; the tracker samples straight through it.
  const tracker = createLeakTracker({ pid: world.serverPid, intervalMs: MEMORY_SAMPLE_INTERVAL_MS, tolerancePct: MEMORY_TOLERANCE_PCT })
  tracker.start()
  const windowStartedAt = Date.now()
  let cycles = 0
  while (
    cycles < MEMORY_MAX_CYCLES
    && Date.now() - windowStartedAt < MEMORY_WINDOW_HARD_CAP_MS
    && !(Date.now() - windowStartedAt >= MEMORY_WINDOW_MS && cycles >= MEMORY_MIN_CYCLES)
  ) {
    await churnCycle(port, world.credentials, cycles + 1)
    cycles += 1
    await sleep(MEMORY_CYCLE_PACE_MS)
  }
  await tracker.stop()

  const evaluation = assertMemoryPass(tracker, { label: 'churn memory pass' })
  assert.ok(cycles >= MEMORY_MIN_WORK_CYCLES, `the measured window ran real work (${MEMORY_MIN_WORK_CYCLES}+ cycles), ran ${cycles}`)
  assert.ok(evaluation.sampleCount >= MEMORY_MIN_SAMPLES, `the regression had at least ${MEMORY_MIN_SAMPLES} samples, received ${evaluation.sampleCount}`)
  assert.ok(evaluation.elapsedMs > 0, 'the sampled window has real duration')
  assert.equal(evaluation.tolerancePct, MEMORY_TOLERANCE_PCT)

  // The sustained window doubles as an FD observation: even under this much
  // churn the server's descriptor count never left the corridor.
  assert.ok(
    evaluation.fdMaxAbsDriftFromStart <= FD_DRIFT_TOLERANCE_SUSTAINED,
    `the FD count drifted ${evaluation.fdMaxAbsDriftFromStart} from its window start ${evaluation.fdStart} across ${evaluation.sampleCount} samples (tolerance ±${FD_DRIFT_TOLERANCE_SUSTAINED})`,
  )

  // The server survived the whole measured window.
  const health = await withDeadline(request(port, 'GET', '/health'), 'post-window health')
  assert.equal(health.status, 200, `the server answers /health after the measured window: ${health.text}`)
  assert.equal(world.child.exitCode === null && world.child.signalCode === null, true, 'the server process is still alive')
})
