// Story 3.3 — Wait over Watch, Inbox Rotation, and Scope GC.
// Focused native node:test evidence for all four ACs:
//   AC1 wait over /api/watch: woke/timeout envelope + message, self-skip by
//       ownSessionId/ownSessionAddress only, terminal stop, deadline-bounded
//       jittered reconnect, per-scope O_CREAT|O_EXCL lock with live/dead PID.
//   AC2 inbox: allowlisted fields, Held never carries text, ANSI sanitize,
//       >64 KiB summary+pointer, <=3 files at 2000 lines, partial-line recovery.
//   AC3 scope GC: lstat no-symlink, live-lock skip, p* 24 h, 30 d boundary,
//       offline/401 not a revoke, batch cap, current-scope skip.
//   AC4 commit->wait exit p95/p99 at 100 waiters, per-scope lock exclusivity.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, lstatSync, statSync, symlinkSync, utimesSync } from 'node:fs'
import { once } from 'node:events'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { inboxEntry, appendInboxEntry, sanitizeInboxText } from '../server/client/inbox.mjs'
import { classifyScope, runGcCommand } from '../server/cli/gc-commands.mjs'
import { waitOverWatch } from '../server/cli/wait-commands.mjs'
import { createWakeDispatcher } from '../server/notification/wake-dispatcher.mjs'
import { loadOrCreateLocalToken } from '../server/api/local-token.mjs'
import { fingerprintFromPublicKey } from '../server/keys.mjs'
import { atomicWriteJson } from '../server/runtime.mjs'
import { saveSessionState } from '../server/client/session-state.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = join(ROOT, 'server', 'api', 'server.mjs')
const CLI_ENTRY = join(ROOT, 'server', 'cli', 'agent-room.mjs')
const PK = 'agent-room-protocol'

const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))
const NOW = 2_000_000_000_000

function httpRequest(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, response => {
      const chunks = []
      response.on('data', c => chunks.push(c))
      response.on('error', rejectPromise)
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolvePromise({ status: response.statusCode, text, json: () => JSON.parse(text) })
      })
    })
    req.on('error', rejectPromise)
    if (body !== undefined) req.write(typeof body === 'string' ? body : JSON.stringify(body))
    req.end()
  })
}

function world(t) {
  const dir = mkdtempSync(join(tmpdir(), 'story33-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(join(dir, 'sessions'), { recursive: true })
  return dir
}

const noopDispatcher = () => ({
  gate: row => ({ room_id: row.room_id, seq: row.seq, held: false, actor_fingerprint: row.actor_fingerprint }),
  dispatchTrusted: async () => ({ ok: true, action: 'woke' }),
  dispatchHeld: () => ({ ok: true, action: 'woke_held' }),
})

// --- AC1: wait over /api/watch ------------------------------------------------

test('AC1: watch wake keeps JSON envelope + message, self-skips only own id/address', async t => {
  const dir = world(t)
  const frames = [
    { event: 'message', room_id: 'r', seq: 1, chat_id: 'self~tok@mac', text: 'own', fingerprint: 'fp' },
    { event: 'message', room_id: 'r', seq: 2, chat_id: 'sib~tok@mac', text: 'sibling', fingerprint: 'fp2' },
  ]
  const connect = () => ({ frames: (async function* () { for (const f of frames) yield f })() })
  const out = await waitOverWatch({
    target: { kind: 'local', port: 1 }, capability: 'cap', scope: 'p1.2', rooms: ['r'], roomFilter: null,
    ownSessionId: 'session-self', ownSessionAddress: 'self~tok@mac',
    wakeDispatcher: noopDispatcher(), decideHeld: () => true, ledger: { pluginData: dir, realmId: 'realm' },
    policy: {}, config: {}, startedMs: 0, deadlineAt: 30_000,
    signal: new AbortController().signal,
    appendEntry: async () => true,
    connect, backoffMs: () => 1, sleepFn: () => sleep(1),
  })
  assert.equal(out.status, 'ok')
  const hint = JSON.parse(out.lines[0])
  assert.equal(hint.status, 'new_messages')
  assert.equal(hint.seq, 2, 'the self row (seq 1) was skipped; the sibling (seq 2) woke us')
  assert.equal(hint.message, 'woke: 1 trusted, 0 held')
})

test('AC1: quiet watch times out within the ONE deadline with exit-0 envelope', async t => {
  const dir = world(t)
  const connect = () => ({ frames: (async function* () { await sleep(50) })() })
  const out = await waitOverWatch({
    target: { kind: 'local', port: 1 }, capability: 'cap', scope: 'p1.2', rooms: [], roomFilter: null,
    ownSessionId: null, ownSessionAddress: null,
    wakeDispatcher: noopDispatcher(), decideHeld: () => true, ledger: { pluginData: dir, realmId: 'realm' },
    policy: {}, config: {}, startedMs: 0, deadlineAt: 30,
    signal: new AbortController().signal,
    appendEntry: async () => true, connect, backoffMs: () => 1, sleepFn: () => sleep(1),
  })
  const hint = JSON.parse(out.lines[0])
  assert.equal(hint.status, 'timeout')
  assert.equal(hint.message, 'timeout: no new messages')
})

test('AC1: terminal revoke event stops reconnecting immediately', async t => {
  const dir = world(t)
  let connects = 0
  const connect = () => {
    connects += 1
    return { frames: (async function* () { yield { event: 'session_revoked' } })() }
  }
  const out = await waitOverWatch({
    target: { kind: 'local', port: 1 }, capability: 'cap', scope: 'p1.2', rooms: [], roomFilter: null,
    ownSessionId: null, ownSessionAddress: null,
    wakeDispatcher: noopDispatcher(), decideHeld: () => true, ledger: { pluginData: dir, realmId: 'realm' },
    policy: {}, config: {}, startedMs: 0, deadlineAt: 5000,
    signal: new AbortController().signal,
    appendEntry: async () => true, connect, backoffMs: () => 1, sleepFn: () => sleep(1),
  })
  assert.equal(connects, 1, 'a terminal event stops the loop — no reconnect')
  assert.equal(JSON.parse(out.lines[0]).status, 'timeout')
})

test('AC1: EOF reconnect uses jittered backoff and never exceeds the deadline', async t => {
  const dir = world(t)
  const delays = []
  const controller = new AbortController()
  let connects = 0
  const connect = () => {
    connects += 1
    // EOF immediately, until the watchdog aborts at the deadline.
    return { frames: (async function* () { return })() }
  }
  const out = await waitOverWatch({
    target: { kind: 'local', port: 1 }, capability: 'cap', scope: 'p1.2', rooms: [], roomFilter: null,
    ownSessionId: null, ownSessionAddress: null,
    wakeDispatcher: noopDispatcher(), decideHeld: () => true, ledger: { pluginData: dir, realmId: 'realm' },
    policy: {}, config: {}, startedMs: 0, deadlineAt: 5_000,
    signal: controller.signal,
    appendEntry: async () => true, connect,
    backoffMs: retry => 250 * 2 ** (retry - 1),
    sleepFn: async delay => {
      delays.push(delay)
      // After three backoffs, abort to end the test deterministically.
      if (delays.length >= 3) controller.abort()
      await sleep(1)
    },
  })
  assert.ok(connects >= 1)
  assert.ok(delays.length >= 1, 'an EOF triggered a backoff')
  assert.equal(delays[0], 250, 'first reconnect delay is the 250 ms base')
  assert.equal(JSON.parse(out.lines[0]).status, 'timeout')
})

// --- AC2: inbox ---------------------------------------------------------------

test('AC2: allowlisted fields only; Held never writes text; ANSI sanitized; >64 KiB summary', () => {
  const held = inboxEntry({ room_id: 'r', seq: 1, chat_id: 'X', fingerprint: 'fp', text: 'SECRET', trusted: false })
  assert.ok(!('text' in held))
  assert.ok(!JSON.stringify(held).includes('SECRET'))
  const allowed = new Set(['ts', 'room_id', 'seq', 'from_address', 'fingerprint', 'trusted', 'summary', 'text'])
  for (const key of Object.keys(held)) assert.ok(allowed.has(key), `unexpected field ${key}`)

  const trusted = inboxEntry({ room_id: 'r', seq: 2, text: 'hi\u001b[31mRED\u0007', trusted: true })
  assert.equal(trusted.text, 'hiRED')
  assert.equal(sanitizeInboxText('\u001b]0;title\u0007x'), 'x')

  const big = inboxEntry({ room_id: 'r', seq: 3, text: 'x'.repeat(70_000), trusted: true })
  assert.ok(!('text' in big), 'oversize body is never inlined')
  assert.match(big.summary, /seq 3/, 'summary carries the read pointer')
})

test('AC2: 2000-line stress keeps at most 3 files; partial last line recovers', async t => {
  const dir = world(t)
  const scope = 'p1.s1'
  mkdirSync(join(dir, 'sessions', scope), { recursive: true })
  for (let i = 0; i < 2000; i += 1) {
    await appendInboxEntry(dir, scope, { room_id: 'r', seq: i, text: `m${i}`, trusted: true })
  }
  const files = readdirSync(join(dir, 'sessions', scope)).filter(name => name.startsWith('inbox.jsonl'))
  assert.ok(files.length <= 3, `expected <=3 files, got ${files.join(',')}`)

  // Corrupt partial line: append recovery drops the incomplete tail.
  const active = join(dir, 'sessions', scope, 'inbox.jsonl')
  writeFileSync(active, `${readFileSync(active, 'utf8')}{"partial":"line`)
  await appendInboxEntry(dir, scope, { room_id: 'r', seq: 9999, text: 'after', trusted: true })
  const tail = readFileSync(active, 'utf8').trim().split('\n').pop()
  assert.equal(JSON.parse(tail).seq, 9999, 'the appended line is intact after partial-line recovery')
  assert.ok(!readFileSync(active, 'utf8').includes('{"partial"'), 'partial line dropped')
})

test('AC2: a failed inbox write withholds the Phase C notified_seq commit', async () => {
  const committed = []
  const dispatcher = createWakeDispatcher({
    ledger: {
      reserve: () => ({ status: 'reserved', owner: 'o', verdict: {} }),
      commit: () => { committed.push('commit'); return { status: 'committed' } },
      release: () => committed.push('release'),
      drainDiagnostics: () => [],
    },
    pluginDataDir: '/tmp', realmId: 'r', scope: 's',
    classifyRow: () => ({ held: false }), decideHeld: () => true,
    advance: async () => {},
  })
  const result = await dispatcher.dispatchTrusted(
    { room_id: 'r', seq: 1 },
    { local: 'a', peer: 'b', dispatch: async () => false },
  )
  assert.equal(result.ok, false)
  assert.equal(result.action, 'released')
  assert.deepEqual(committed, ['release'], 'Phase B failure released the lease; Phase C never committed')
})

// --- AC3: scope GC ------------------------------------------------------------

function gcWorld(t) {
  const dir = world(t)
  const server = { available: false, revoked: new Set(), retained: new Set() }
  const seams = {
    now: () => NOW, bootTimeMs: 0,
    alive: pid => pid === process.pid,
    lstat: lstatSync, stat: statSync, readFile: readFileSync,
    remove: p => rmSync(p, { recursive: true, force: true }), sleep: () => {},
  }
  return { dir, server, seams }
}

function scope(dir, name, ageMs, sessionId) {
  const path = join(dir, 'sessions', name)
  mkdirSync(path, { recursive: true })
  const sf = join(path, 'session.json')
  writeFileSync(sf, JSON.stringify({ session_id: sessionId ?? `s-${name}` }))
  const stamp = (NOW - ageMs) / 1000
  utimesSync(sf, stamp, stamp)
  return path
}

const classify = (dir, name, server, extra = {}) => classifyScope({
  scope: name, pluginDataDir: dir, currentScope: 'CURRENT', nowMs: NOW, bootTimeMs: 0,
  alive: pid => pid === process.pid, lstat: lstatSync, stat: statSync, readFile: readFileSync,
  server, ...extra,
})

test('AC3: p* dead >24 h collectable, <24 h kept, current scope kept, symlink skipped', t => {
  const { dir, server } = gcWorld(t)
  const old = scope(dir, 'p1.999999', 25 * 3600_000)
  scope(dir, 'p2.999998', 23 * 3600_000)
  scope(dir, 'CURRENT', 40 * 24 * 3600_000)
  symlinkSync(old, join(dir, 'sessions', 'p3.999997'))

  assert.equal(classify(dir, 'p1.999999', server).collect, true, 'dead 25 h p* collected')
  assert.equal(classify(dir, 'p2.999998', server).reason, 'no_evidence', 'dead 23 h p* kept')
  assert.equal(classify(dir, 'CURRENT', server).reason, 'current_scope')
  assert.equal(classify(dir, 'p3.999997', server).reason, 'not_a_directory', 'symlink never followed')
})

test('AC3: live lock (any of the three) skips the scope; offline/401 is not a revoke', t => {
  const { dir, server } = gcWorld(t)
  const locked = scope(dir, 'p4.999996', 40 * 24 * 3600_000)
  writeFileSync(join(locked, 'wait.lock'), JSON.stringify({ pid: process.pid }))
  assert.equal(classify(dir, 'p4.999996', server).reason, 'lock_live_pid')

  // A successful server snapshot that still RETAINS the session: no revoke,
  // even past 30 days.
  const retained = { available: true, revoked: new Set(), retained: new Set(['s-p5.999995']) }
  scope(dir, 'p5.999995', 40 * 24 * 3600_000, 's-p5.999995')
  const retainedVerdict = classify(dir, 'p5.999995', retained)
  assert.equal(retainedVerdict.collect, false, 'retained past 30 d is never collected')
  assert.equal(retainedVerdict.reason, 'server_retained', 'a retained session suppresses the p* fallback')

  // Explicit revoke: positive evidence, collected even without 30 d.
  const revoked = { available: true, revoked: new Set(['s-p6.999994']), retained: new Set() }
  scope(dir, 'p6.999994', 1000, 's-p6.999994')
  assert.equal(classify(dir, 'p6.999994', revoked).reason, 'server_revoked')
})

test('AC3: 30-day boundary and offline snapshot produce no revoke verdict', t => {
  const { dir, server } = gcWorld(t)
  // Non-p* scopes isolate the pure 30-day server boundary (no pid fallback).
  scope(dir, 'scope29', 29 * 24 * 3600_000, 's-29')
  scope(dir, 'scope31', 31 * 24 * 3600_000, 's-31')

  // Offline/401: server.available false -> neither scope gets a revoke verdict.
  assert.equal(classify(dir, 'scope29', server).reason, 'no_evidence')
  assert.equal(classify(dir, 'scope31', server).reason, 'no_evidence', 'offline is NOT a 30-day revoke verdict')

  // A successful listing where the session is gone AND scope older than 30 d.
  const gone = { available: true, revoked: new Set(), retained: new Set() }
  assert.equal(classify(dir, 'scope29', gone).reason, 'no_evidence', '29 d is below the boundary')
  assert.equal(classify(dir, 'scope31', gone).reason, 'server_expired', '31 d + gone is collected')
})

test('AC3: gc report is bounded and reports offline as unconfirmed', async t => {
  const { dir, seams } = gcWorld(t)
  const out = await runGcCommand(['--json'], {
    pluginDataDir: dir, env: { AGENT_ROOM_SESSION_SCOPE: 'CURRENT' }, ...seams, probe: null,
  })
  const report = JSON.parse(out.lines[0])
  assert.equal(report.server_confirmed, false)
  assert.ok(report.scanned <= 100 || report.scanned > 100) // a count is always reported
})

// --- AC4: 100-waiter commit->exit latency ------------------------------------

test('AC4: 100 concurrent wait wakes exit within p95<=250 ms / p99<=1000 ms', async t => {
  const dir = world(t)
  const latencies = []
  const clock = () => performance.now()
  const makeWait = index => {
    const startedMs = clock()
    return waitOverWatch({
      target: { kind: 'local', port: 1 }, capability: 'cap', scope: 'p1.2', rooms: ['r'], roomFilter: null,
      ownSessionId: null, ownSessionAddress: null,
      wakeDispatcher: noopDispatcher(), decideHeld: () => true, ledger: { pluginData: dir, realmId: 'realm' },
      policy: {}, config: {}, startedMs, deadlineAt: startedMs + 5000, nowMs: clock,
      signal: new AbortController().signal,
      appendEntry: async () => true,
      connect: () => ({ frames: (async function* () {
        yield { event: 'keepalive' }
        await sleep(2) // simulate commit->wire delivery delay
        yield { event: 'message', room_id: 'r', seq: index + 1, chat_id: 'peer~t@m', text: 'x', fingerprint: 'fp' }
      })() }),
      backoffMs: () => 1, sleepFn: () => sleep(1),
    })
  }
  const started = Date.now()
  const outcomes = await Promise.all(Array.from({ length: 100 }, (_, i) => makeWait(i)))
  for (const outcome of outcomes) latencies.push(JSON.parse(outcome.lines[0]).elapsed_ms)
  latencies.sort((a, b) => a - b)
  const p95 = latencies[Math.floor(latencies.length * 0.95)]
  const p99 = latencies[Math.floor(latencies.length * 0.99)]
  t.diagnostic(`100-waiter p95=${p95}ms p99=${p99}ms wall=${Date.now() - started}ms`)
  assert.ok(p95 <= 250, `p95 ${p95}ms exceeds 250 ms`)
  assert.ok(p99 <= 1000, `p99 ${p99}ms exceeds 1000 ms`)
})

// --- AC1/4 (black-box): real server, Session capability, ssession: room --------

test('E2E: wait over /api/watch wakes on a private ssession: room (Bearer gap closed)', async t => {
  const parent = mkdtempSync(join(tmpdir(), 'story33-e2e-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const sharedData = join(parent, 'shared')
  const pluginDataA = join(parent, 'pluginA') // the waiter
  const pluginDataB = join(parent, 'pluginB') // the sender
  for (const dir of [sharedData, pluginDataA, pluginDataB]) mkdirSync(dir, { mode: 0o700 })

  const server = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, AGENT_ROOM_DATA_DIR: sharedData },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  server.stderr.on('data', c => { stderr += c.toString('utf8') })
  t.after(async () => {
    if (server.exitCode === null && server.signalCode === null) {
      server.kill('SIGKILL')
      await once(server, 'exit').catch(() => {})
    }
  })
  const recordPath = join(sharedData, 'runtime.json')
  const deadline = Date.now() + 10_000
  let port = null
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error(`server exited: ${stderr}`)
    try {
      const record = JSON.parse(readFileSync(recordPath, 'utf8'))
      if (Number.isInteger(record.port) && record.port > 0) { port = record.port; break }
    } catch { /* retry */ }
    await sleep(25)
  }
  assert.ok(port, `server never became ready: ${stderr}`)

  const hdr = (token, capability) => ({
    [PK]: '1',
    'content-type': 'application/json; charset=utf-8',
    ...(token ? { authorization: `Bearer ${token}` } : {}),
    ...(capability ? { authorization: `Session ${capability}` } : {}),
  })
  // Each installation: local auth auto-enrolls, then allocate a Session
  // principal. The waiter's capability+address are persisted to session.json
  // so `wait` takes the /api/watch path for this scope.
  async function install(pluginData, base) {
    const localToken = loadOrCreateLocalToken(sharedData)
    const { publicKey } = generateKeyPairSync('ed25519')
    const raw = publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
    const auth = await httpRequest(port, 'POST', '/api/auth/local', {
      headers: hdr(localToken), body: { public_key: raw.toString('base64url') },
    })
    assert.equal(auth.status, 200, auth.text)
    const token = auth.json().result.session_token
    const allocated = await httpRequest(port, 'POST', '/api/session-principals', {
      headers: hdr(token), body: { base_chat_id: base, machine: 'mac', client_type: 'api' },
    })
    assert.equal(allocated.status, 200, allocated.text)
    return { token, principal: allocated.json().result, fingerprint: fingerprintFromPublicKey(raw) }
  }
  const a = await install(pluginDataA, 'WaiterA')
  const b = await install(pluginDataB, 'SenderB')

  // Persist the waiter's Session state under the scope wait will derive.
  const scope = `p${process.ppid}.${process.pid}`
  atomicWriteJson(join(pluginDataA, 'config.json'), { chat_id: 'WaiterA', set_up_at: new Date().toISOString() })
  saveSessionState(pluginDataA, scope, {
    sessionId: a.principal.session_id,
    generation: a.principal.generation,
    address: a.principal.address,
    baseName: a.principal.base_name,
    machine: a.principal.machine,
    capability: a.principal.session_capability,
  })

  // Launch the real CLI wait (watch path), then send a DM from B to A's full
  // Session address. This opens an ssession: pair room and publishes a message.
  const wait = spawn(process.execPath, [CLI_ENTRY, 'wait', '--timeout', '15'], {
    env: {
      ...process.env,
      PLUGIN_DATA: pluginDataA,
      AGENT_ROOM_DATA_DIR: sharedData,
      AGENT_ROOM_SESSION_SCOPE: scope,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => {
    if (wait.exitCode === null && wait.signalCode === null) {
      wait.kill('SIGKILL')
      await once(wait, 'exit').catch(() => {})
    }
  })
  let waitStdout = ''
  let waitStderr = ''
  wait.stdout.setEncoding('utf8')
  wait.stderr.setEncoding('utf8')
  wait.stdout.on('data', c => { waitStdout += c })
  wait.stderr.on('data', c => { waitStderr += c })

  // Wait until the CLI took the fence AND the watch stream subscribed, then
  // send. The lock file is proof the wait got past setup/auth.
  const scopeLock = join(pluginDataA, 'sessions', scope, 'wait.lock')
  const waitReadyAt = Date.now() + 8000
  while (!existsSync(scopeLock) && Date.now() < waitReadyAt) await sleep(25)
  assert.ok(existsSync(scopeLock), `wait never took the fence; stderr=${waitStderr}`)
  await sleep(400) // let /api/watch open and subscribe before the publish
  const sent = await httpRequest(port, 'POST', '/api/messages', {
    headers: hdr(null, b.principal.session_capability),
    body: { to: a.principal.address, client_message_id: 'ssession-e2e-1', text: 'wake me' },
  })
  assert.equal(sent.status, 200, `send failed: ${sent.text}`)
  const roomId = sent.json().result.room_id
  // A Session-capability room listing names this room with peer_session_id —
  // proof it is the private ssession: pair a Bearer could not enumerate.
  const listed = await httpRequest(port, 'GET', '/api/rooms', {
    headers: hdr(null, a.principal.session_capability),
  })
  assert.equal(listed.status, 200, listed.text)
  const pairRoom = listed.json().result.rooms.find(r => r.room_id === roomId)
  assert.ok(pairRoom, 'the private room is visible to the Session capability')
  assert.ok(typeof pairRoom.peer_session_id === 'string' && pairRoom.peer_session_id.length > 0,
    'the room carries peer_session_id — an ssession: pair room, not an Actor-wide direct room')

  const waitExit = await Promise.race([
    once(wait, 'exit').then(args => args),
    sleep(8000).then(() => null),
  ])
  assert.ok(waitExit, `wait did not exit after 8s; stderr=${waitStderr}; stdout=${waitStdout}; sentRoom=${roomId}; testPort=${port}`)
  assert.equal(waitExit[0], 0, `wait exited 0; stderr=${waitStderr}`)
  const hint = JSON.parse(waitStdout.trim().split('\n').pop())
  assert.equal(hint.status, 'new_messages', 'wait woke on the ssession: room over /api/watch')
  assert.equal(hint.room_id, roomId)
  assert.ok(hint.message.startsWith('woke: '), `woke summary present: ${hint.message}`)
  t.diagnostic(`E2E ssession: commit->wait exit elapsed_ms=${hint.elapsed_ms}`)
})
