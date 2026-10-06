// The remote dress rehearsal driver (Story 4.8): a real child process spawned
// by tests/drills/remote-dress-rehearsal.test.mjs that walks Epic 4's
// BLOCKING exit gate (ruling Q3) — the full remote governance flow over real
// TLS, then multi-client connection churn over the TLS front, both held to
// the Story 2.4 leak oracles.
//
// TOPOLOGY (the Story 4.7 harness's proven proxy shape, reused here): one
// real direct-launch server child (server/api/server.mjs) binding its
// loopback PLAINTEXT backend, and a real TLS front in this process
// terminating certificates signed by the test CA and proxying to that
// backend — the Caddy recipe's shape, the harder of the two topologies (two
// hops per request). The driver is spawned with NODE_EXTRA_CA_CERTS pointing
// at the test CA (the same throwaway material tests/self-hosting-deployment
// .test.mjs generated), so Node's own DEFAULT verification — chain and
// hostname checks fully on, no override anywhere in this tree — trusts the
// private root through Node's documented mechanism.
//
// THE OPERATOR SIDE IS THE CLI HOST (AR-13): every operator action —
// `invite mint`, `invite list`, `ban` — and every enrollment (`remote
// enroll`) runs through the real `agent-room` bin dispatch (cliMain, in
// process, streams captured), never through direct store calls and never
// through any HTTP route. The REMOTE clients use only the wire: the shipped
// api-client (createAgentRoomClient) rides the challenge lane for the
// governance actors, and the churn cycles speak the raw frozen protocol
// (challenge → answer → bind → release) over https, mirroring Story 2.4's
// churnCycle with the Story 4.1 credential lane in place of the local token.
//
// THE RATE GATES ARE EXERCISED HONESTLY: the server child runs the send
// bucket, duplicate gate, and enrollment limiter at their DECLARED defaults
// (only the request budget is raised by this harness-operator — the same
// authority tests/churn.test.mjs's OPERATOR_RATE_FLOOR_ENV exercises —
// because the declared 120/min budget would throttle the drill's own mixed
// read/write journey and its churn row; the send bucket is deliberately left
// alone because feeling it is the point). The DM/broadcast exchange paces at
// 2 sends/s so the 0.5/s bucket drains visibly and never empties, and one
// explicit probe fires a burst larger than the declared capacity from one
// client, asserts the rate_limited refusals and their retry_after_ms on the
// wire, backs off, and succeeds.
//
// THE WIRE IS COUNTED: every request on both legs (the clients' https legs
// and the front's loopback plaintext hops) is captured with method, path,
// authorization header, request body, and response body. The counted scan
// proves zero `/api/auth/local` requests and zero local-token bytes
// anywhere; that invite tokens ride enroll requests and nothing else; and
// that every rate_limited response carries its retry delay.
//
// The driver prints one line `REPORT:{...json}` on success; anything else is
// a failure the parent surfaces with the driver's stderr. The drill is fully
// deterministic — every timing and count is a constant of this file; nothing
// is randomized, so there is no seed. The minted invite tokens NEVER appear
// in the report: they are used in-process and scanned against, never
// printed.

import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { createPrivateKey, generateKeyPairSync, sign as cryptoSign } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, readlinkSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import https from 'node:https'
import { once } from 'node:events'
import { dirname, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'

import { READ_HOLD_MAX_MS } from '../../server/constants.mjs'
import { createAgentRoomClient } from '../../server/client/api-client.mjs'
import { saveRemoteConfig } from '../../server/client/remote-config.mjs'
import { main as cliMain } from '../../server/cli/agent-room.mjs'
import { fingerprintFromPublicKey } from '../../server/keys.mjs'
import { createLeakTracker } from '../harness/leak-tracker.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const SERVER_ENTRY = join(ROOT, 'server', 'api', 'server.mjs')

const root = process.env.AGENT_ROOM_DRESS_ROOT
const certPath = process.env.AGENT_ROOM_DRESS_CERT
const keyPath = process.env.AGENT_ROOM_DRESS_KEY

if (!root || !certPath || !keyPath) {
  console.error('driver misconfigured: AGENT_ROOM_DRESS_ROOT/CERT/KEY are required')
  process.exit(3)
}
const leafCert = readFileSync(certPath, 'utf8')
const leafKey = readFileSync(keyPath, 'utf8')

// --- Harness budgets and drill shape (local constants, never product limits) ---

// The four identity sandboxes: dressA and dressB are the governance actors
// (the criterion's two, distinct keypairs); dressC and dressD are the churn
// pair — the churn clients must be enrolled keys whose Chat IDs are not
// already bound by the governance actors' live sessions.
const CHAT_IDS = Object.freeze(['dressA', 'dressB', 'dressC', 'dressD'])

// The paced exchange: 2 sends/s — the declared 0.5/s bucket visibly drains
// (capacity 10) and never empties, so the paced rows never stall.
const PACE_MS = 500
const DM_COUNT_PER_SIDE = 5
const BROADCAST_COUNT_PER_SIDE = 4
const PHASE_SETTLE_MS = 4_000

// The rate-gate probe: settle the bucket back toward capacity, then fire a
// burst larger than the declared capacity 10. The wall bound is what makes
// the refusal floor arithmetic, not hope: within 4 s at most 2 tokens refill
// (0.5/s), so at least 14 - 10 - 2 = 2 of the burst's sends are refused.
// PROBE_BACKOFF_MS exceeds one full token's refill (2000 ms), so the backoff
// send succeeds.
const PROBE_SETTLE_MS = 10_000
const PROBE_BURST = 14
const PROBE_BURST_WALL_LIMIT_MS = 4_000
const PROBE_BACKOFF_MS = 2_600

// The pipeline order is Transport → Auth → Budget → Authz: an empty send
// bucket answers rate_limited BEFORE the ban check is ever reached (the
// Story 4.5 wire test's post-ban send rode a non-empty bucket). The drill's
// probe empties B's bucket by design, so the post-ban send waits out one
// full token refill (2000 ms at the declared 0.5/s) first — then the send
// reaches the authz stage and answers the coded `banned` the criterion
// demands. A settle, never a weakened oracle.
const BUCKET_REFILL_SETTLE_MS = 2_400

// The ban row: the ban lands mid-hold; the poll must answer `banned` at its
// NEXT WAKE — within the 20 s window it was held under, and well before it
// (the ban-at-next-request precedent answers in single-digit seconds).
const BAN_MIDHOLD_DELAY_MS = 300
const LONGPOLL_WINDOW_MS = READ_HOLD_MAX_MS
const NEXT_WAKE_BOUND_MS = 10_000
const ADMISSION_REFUSAL_BOUND_MS = 5_000

// The churn row: Story 2.4's numbers, reused by name — warmup first, 100
// cycles, FD sampling every 10 cycles plus a baseline and a final sample,
// every sample within ±5 of the baseline.
const CHURN_WARMUP_CYCLES = 10
const CHURN_CYCLES = 100
const CHURN_SAMPLE_EVERY_CYCLES = 10
const FD_DRIFT_TOLERANCE = 5
const CHURN_SETTLE_MS = 500

// Harness budgets.
const STARTUP_DEADLINE_MS = 25_000
const READY_POLL_INTERVAL_MS = 25
const CHILD_REAP_GRACE_MS = 2_000
const RAW_REQUEST_TIMEOUT_MS = 15_000
const RUNTIME_RECORD_FILENAME = 'runtime.json'

// Wire vocabulary as literals of this file (the oracle discipline: expected
// values are built here, never imported).
const PROTOCOL_KEY = 'agent-room-protocol'
const PROTOCOL_VERSION = '1'

// The harness-operator's floor raise, limited to the ONE gate whose declared
// default would throttle the drill itself (the request budget counts every
// authenticated request, including every churn bind and release). The send
// bucket and duplicate gate stay at their declared defaults on purpose.
const OPERATOR_REQUEST_BUDGET_FLOOR_ENV = Object.freeze({
  AGENT_ROOM_REQUEST_BUDGET_PER_MINUTE: '120000',
  AGENT_ROOM_REQUEST_BUDGET_BURST: '100000',
})

const sleep = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })

const jsonLines = text => text.trim().split('\n').filter(lineText => lineText.length > 0).map(lineText => JSON.parse(lineText))

function modeOf(path, kind) {
  const info = lstatSync(path)
  assert.equal(info.isSymbolicLink(), false, `${path}: state path must not be a symlink`)
  if (kind === 'file') assert.equal(info.isFile(), true, `${path}: state path must be a regular file`)
  if (kind === 'directory') assert.equal(info.isDirectory(), true, `${path}: state path must be a directory`)
  return info.mode & 0o777
}

// --- The wire capture: both legs, request AND response bodies -----------------
//
// The Story 4.7 driver's mechanism, extended with the request method, the
// authorization header, and the response body — the response capture is what
// lets the drill assert rate_limited's retry_after_ms ON THE WIRE (the
// api-client's thrown coded error carries the code but not the envelope's
// extras). The same varargs warning applies: the wrapper forwards EVERY
// argument, because requests arrive in both the (options[, callback]) shape
// (the front's loopback hop) and the (url, options[, callback]) shape (the
// clients' https legs); a fixed-signature wrapper silently drops the URL
// form's callback and the request hangs forever.

const captures = []
function captureWire() {
  for (const [mod, proto] of [[http, 'http'], [https, 'https']]) {
    const original = mod.request
    mod.request = (...args) => {
      const options = args.find(arg => arg !== null && typeof arg === 'object' && !(arg instanceof URL))
      const record = {
        proto,
        method: options?.method,
        authorization: typeof options?.headers?.authorization === 'string' ? options.headers.authorization : null,
        path: typeof args[0] === 'string'
          ? new URL(args[0]).pathname
          : args[0] instanceof URL
            ? args[0].pathname
            : args[0]?.path,
        requestBody: [],
      }
      const settle = response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => captures.push({
          ...record,
          requestBody: Buffer.concat(record.requestBody).toString('utf8'),
          responseBody: Buffer.concat(chunks).toString('utf8'),
        }))
      }
      let request
      if (args.some(arg => typeof arg === 'function')) {
        const patched = args.map(arg => (typeof arg === 'function'
          ? response => { settle(response); return arg(response) }
          : arg))
        request = original.call(mod, ...patched)
      } else {
        request = original.call(mod, ...args)
        request.on('response', settle)
      }
      const originalWrite = request.write.bind(request)
      request.write = (chunk, ...rest) => {
        if (chunk !== undefined) record.requestBody.push(Buffer.from(chunk))
        return originalWrite(chunk, ...rest)
      }
      const originalEnd = request.end.bind(request)
      request.end = (chunk, ...rest) => {
        if (chunk === undefined) return originalEnd()
        record.requestBody.push(Buffer.from(chunk))
        return originalEnd(chunk, ...rest)
      }
      return request
    }
  }
}

// --- The TLS front: terminate TLS, proxy to the loopback plaintext backend ----
//
// The Story 4.7 harness's front, reused unchanged: hop-by-hop headers are
// stripped in both directions — the Caddy recipe's documented hygiene.

const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authenticate', 'proxy-authorization']

function stripHopByHop(headers) {
  const clean = { ...headers }
  for (const name of HOP_BY_HOP) delete clean[name]
  return clean
}

function startTlsFront(certPem, keyPem) {
  let backendPort = null
  const front = https.createServer({ cert: certPem, key: keyPem }, (req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const headers = stripHopByHop(req.headers)
      headers['content-length'] = body.length
      // The backend hop is LOOPBACK PLAINTEXT ONLY — the recipe's one rule.
      const upstream = http.request(
        { host: '127.0.0.1', port: backendPort, path: req.url, method: req.method, headers, agent: false },
        response => {
          res.writeHead(response.statusCode ?? 502, stripHopByHop(response.headers))
          response.pipe(res)
        },
      )
      upstream.on('error', () => {
        if (res.headersSent) return res.destroy()
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: { code: 'backend_unreachable', message: 'the loopback backend is not answering' } }))
      })
      if (body.length > 0) upstream.write(body)
      upstream.end()
    })
  })
  return {
    setBackend: port => { backendPort = port },
    listen: () => new Promise(resolvePromise => front.listen(0, '127.0.0.1', () => resolvePromise(front.address().port))),
    close: () => new Promise(resolvePromise => front.close(() => resolvePromise())),
  }
}

// One installation under its own plugin dir: config.json plus a real 0600
// keypair (the Story 4.7 driver's makeInstallation, keeping the private-key
// PEM so the raw churn cycles can sign their own challenge answers).
function makeInstallation(parent, name, chatId) {
  const pluginData = join(parent, name)
  mkdirSync(pluginData, { recursive: true, mode: 0o700 })
  writeFileSync(join(pluginData, 'config.json'), `${JSON.stringify({ chat_id: chatId })}\n`, { mode: 0o600 })
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  writeFileSync(join(pluginData, 'identity.key'), privateKeyPem, { mode: 0o600 })
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const raw = spki.subarray(spki.length - 32)
  return {
    pluginData,
    chatId,
    fingerprint: fingerprintFromPublicKey(raw),
    publicKeyBase64url: raw.toString('base64url'),
    privateKeyPem,
  }
}

// --- The operator CLI host (AR-13), in process with captured streams ----------

async function runCli({ sharedDataDir, pluginDataDir }, argv) {
  const output = new PassThrough()
  const errorOutput = new PassThrough()
  let stdout = ''
  let stderr = ''
  output.setEncoding('utf8')
  errorOutput.setEncoding('utf8')
  output.on('data', chunk => { stdout += chunk })
  errorOutput.on('data', chunk => { stderr += chunk })
  const previousExitCode = process.exitCode
  process.exitCode = undefined
  try {
    const outcome = await cliMain(argv, {
      input: new PassThrough(),
      output,
      errorOutput,
      sharedDataDir,
      pluginDataDir,
    })
    await sleep(10)
    return { outcome, stdout, stderr, exitCode: process.exitCode ?? 0 }
  } finally {
    process.exitCode = previousExitCode
  }
}

// --- The real server child (the direct launch, plaintext loopback backend) ----

function spawnServerChild(dataDir) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: {
      PATH: process.env.PATH ?? '',
      LANG: process.env.LANG ?? 'C.UTF-8',
      AGENT_ROOM_DATA_DIR: dataDir,
      ...OPERATOR_REQUEST_BUDGET_FLOOR_ENV,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  child.stdout.resume()
  return {
    child,
    get stderrText() { return stderr },
  }
}

// Readiness is declared ONLY by a runtime record naming THIS child's pid
// with a valid port (the restart-survival discipline).
async function waitReady(serverState, dataDir) {
  const runtimePath = join(dataDir, RUNTIME_RECORD_FILENAME)
  const deadline = Date.now() + STARTUP_DEADLINE_MS
  for (;;) {
    if (serverState.child.exitCode !== null || serverState.child.signalCode !== null) {
      throw new Error(`the server child exited early (code=${serverState.child.exitCode} signal=${serverState.child.signalCode}); stderr=${serverState.stderrText}`)
    }
    if (existsSync(runtimePath)) {
      try {
        const record = JSON.parse(readFileSync(runtimePath, 'utf8'))
        if (
          record && typeof record === 'object'
          && record.pid === serverState.child.pid
          && Number.isInteger(record.port) && record.port > 0 && record.port <= 65535
          && typeof record.version === 'string' && record.version.length > 0
        ) {
          return record
        }
      } catch { /* atomic rename: readers retry */ }
    }
    if (Date.now() > deadline) {
      throw new Error(`runtime.json never named pid ${serverState.child.pid} within ${STARTUP_DEADLINE_MS} ms; stderr=${serverState.stderrText}`)
    }
    await sleep(READY_POLL_INTERVAL_MS)
  }
}

async function stopServerChild(serverState) {
  const { child } = serverState
  if (child.exitCode !== null || child.signalCode !== null) return
  try { child.kill('SIGTERM') } catch { /* the bounded wait below is authoritative */ }
  const raced = await Promise.race([
    once(child, 'exit'),
    sleep(CHILD_REAP_GRACE_MS).then(() => 'timeout'),
  ])
  if (raced === 'timeout' && child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL') } catch { /* reported by the exit await */ }
    await once(child, 'exit').catch(() => {})
  }
}

// --- The raw remote protocol (the churn cycles' connect/auth/bind/release) ----

function httpsJson(url, method, body, bearer) {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = https.request(url, {
      method,
      agent: false,
      headers: {
        [PROTOCOL_KEY]: PROTOCOL_VERSION,
        ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
        ...(body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }),
      },
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('error', rejectPromise)
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed = null
        try { parsed = JSON.parse(text) } catch { parsed = null }
        resolvePromise({ status: response.statusCode, text, json: parsed })
      })
    })
    request.setTimeout(RAW_REQUEST_TIMEOUT_MS, () => request.destroy(new Error(`${method} ${url.pathname} timed out`)))
    request.on('error', rejectPromise)
    if (body !== undefined) request.write(JSON.stringify(body))
    request.end()
  })
}

// One full connect → authenticate → bind → (read) → disconnect cycle over the
// TLS front, every step asserted on the wire — Story 2.4's churnCycle with
// the Story 4.1 challenge lane in place of the local-token exchange.
// agent:false keeps every request on its own socket.
async function churnCycle(origin, installation, label, { withPresence = false } = {}) {
  const challenge = await httpsJson(new URL('/api/auth/challenge', origin), 'POST', {
    public_key: installation.publicKeyBase64url,
  })
  assert.equal(challenge.status, 200, `${label}: the challenge answered ${challenge.status}: ${challenge.text}`)
  const nonce = challenge.json?.result?.nonce
  assert.equal(typeof nonce === 'string' && nonce.length > 0, true, `${label}: a nonce was issued`)

  const signature = cryptoSign(null, Buffer.from(nonce, 'base64url'), createPrivateKey(installation.privateKeyPem)).toString('base64url')
  const answer = await httpsJson(new URL('/api/auth/answer', origin), 'POST', { nonce, signature })
  assert.equal(answer.status, 200, `${label}: the answer ${answer.status}: ${answer.text}`)
  const sessionToken = answer.json?.result?.session_token
  assert.equal(typeof sessionToken === 'string' && sessionToken.length > 0, true, `${label}: a session token was issued`)

  const bind = await httpsJson(new URL('/api/session', origin), 'POST', {
    chat_id: installation.chatId,
    client_type: 'mcp',
  }, sessionToken)
  assert.equal(bind.status, 200, `${label}: the bind answered ${bind.status}: ${bind.text}`)
  assert.equal(bind.json?.result?.chat_id, installation.chatId, `${label}: the session bound "${installation.chatId}"`)

  let online = null
  if (withPresence) {
    const presence = await httpsJson(new URL('/api/presence', origin), 'GET', undefined, sessionToken)
    assert.equal(presence.status, 200, `${label}: the presence read answered ${presence.status}: ${presence.text}`)
    online = presence.json?.result?.online
    assert.equal(Array.isArray(online), true, `${label}: the presence read returned the online group`)
  }

  const release = await httpsJson(new URL('/api/session', origin), 'DELETE', undefined, sessionToken)
  assert.equal(release.status, 200, `${label}: the disconnect answered ${release.status}: ${release.text}`)

  return { label, chatId: installation.chatId, online }
}

// The paced exchange: one paced send at a time, 2/s, the declared-default
// bucket visibly draining and never emptying.
async function pacedSends(client, roomId, label, count) {
  const sent = []
  for (let index = 0; index < count; index += 1) {
    const result = await client.sendMessage({
      roomId,
      clientMessageId: `dress-${label}-${index}`,
      text: `dress rehearsal ${label} ${index}`,
    })
    assert.equal(result.status, 'committed', `${label} ${index}: the paced send is committed (${JSON.stringify(result)})`)
    assert.deepEqual(Object.keys(result).sort(), ['room_id', 'seq', 'status'], `${label} ${index}: the committed send carries exactly the frozen result keys`)
    assert.ok(Number.isSafeInteger(result.seq) && result.seq >= 1, `${label} ${index}: the send acked at a positive sequence`)
    sent.push(result)
    if (index < count - 1) await sleep(PACE_MS)
  }
  return sent
}

async function refusedCoded(promise, code, label) {
  try {
    await promise
  } catch (error) {
    assert.equal(error?.code, code, `${label}: expected the coded ${code} refusal, got ${error?.code}: ${error?.message}`)
    return error
  }
  assert.fail(`${label}: expected the coded ${code} refusal, but the call succeeded`)
}

// --- The server's TCP-socket inventory (the zero-leaked-sockets oracle) --------
//
// The Story 2.4 churn inventory, verbatim in mechanism: after the churn the
// server process holds exactly one TCP socket — its listener — and nothing
// else. (The server child's listener is its loopback plaintext backend; the
// TLS listener lives in this process and is covered by the self-FD oracle.)

function parseLsofFds(stdout) {
  return stdout.split('\n')
    .map(line => /^f(\d+)$/.exec(line))
    .filter(Boolean)
    .map(match => Number(match[1]))
    .sort((left, right) => left - right)
}

function execFilePromise(file, args) {
  return new Promise((resolvePromise, rejectPromise) => {
    execFile(file, args, { encoding: 'utf8', timeout: 10_000 }, (error, stdout, stderr) => {
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

async function darwinTcpFds(pid, extraArgs) {
  try {
    const { stdout } = await execFilePromise('lsof', ['-a', '-p', String(pid), ...extraArgs, '-F', 'f'])
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

// --- The governance journey ------------------------------------------------------

async function governanceJourney({ rootDir, dataDir, origin, installations }) {
  // Permission hygiene on every sandbox (the state-permission policy).
  for (const chatId of CHAT_IDS) {
    const installation = installations[chatId]
    assert.equal(modeOf(installation.pluginData, 'directory'), 0o700, `${chatId}: the plugin dir is 0700`)
    assert.equal(modeOf(join(installation.pluginData, 'config.json'), 'file'), 0o600, `${chatId}: config.json is 0600`)
    assert.equal(modeOf(join(installation.pluginData, 'identity.key'), 'file'), 0o600, `${chatId}: identity.key is 0600`)
  }
  const fingerprints = CHAT_IDS.map(chatId => installations[chatId].fingerprint)
  assert.equal(new Set(fingerprints).size, CHAT_IDS.length, 'the identity sandboxes carry distinct keypairs')

  const mintedTokens = []

  // One single-use invite minted through the CLI host. Returns the token and
  // its digest prefix; the token is added to the wire-scan's watch list.
  const mintInvite = async label => {
    const mint = await runCli({ sharedDataDir: dataDir, pluginDataDir: rootDir }, ['invite', 'mint', '--uses', '1', '--ttl', '1'])
    assert.equal(mint.exitCode, 0, `invite mint (${label}) succeeded: ${mint.stderr}`)
    const line = jsonLines(mint.stdout)[0]
    assert.equal(line?.ok, true, `the mint receipt (${label}) is ok`)
    assert.equal(line.command, 'invite mint')
    assert.equal(line.invite.uses_max, 1, `the invite (${label}) is single-use`)
    assert.equal(mint.stdout.split(line.token).length - 1, 1, `the raw token (${label}) is shown exactly once`)
    assert.equal(mint.stderr.includes(line.token), false, `the token (${label}) never appears on stderr`)
    mintedTokens.push(line.token)
    return { token: line.token, digestPrefix: line.invite.digest_prefix }
  }

  const enroll = async (chatId, invite, { expectRefusal = false } = {}) => {
    saveRemoteConfig(installations[chatId].pluginData, { serverUrl: origin })
    const attempt = await runCli(
      { sharedDataDir: dataDir, pluginDataDir: installations[chatId].pluginData },
      ['remote', 'enroll', invite.token],
    )
    if (expectRefusal) {
      assert.equal(attempt.exitCode, 1, `the second use of the spent invite is refused: ${attempt.stdout}`)
      assert.equal(attempt.outcome?.code, 'invite_exhausted', `the refusal is coded invite_exhausted: ${JSON.stringify(attempt.outcome)}`)
      assert.equal(attempt.stdout.includes(invite.token), false, 'the refusal never echoes the token')
      assert.equal(attempt.stderr.includes(invite.token), false, 'the refusal line never echoes the token')
      return { refused: true, code: attempt.outcome?.code ?? null }
    }
    assert.equal(attempt.exitCode, 0, `remote enroll ${chatId} succeeded: ${attempt.stderr}`)
    const line = jsonLines(attempt.stdout)[0]
    assert.equal(line?.ok, true, `the enroll receipt (${chatId}) is ok`)
    assert.equal(line.command, 'remote enroll')
    assert.equal(line.enrolled, true, `${chatId} is enrolled`)
    assert.equal(line.server_url, origin, `${chatId}: the receipt names the origin`)
    assert.equal(line.fingerprint, installations[chatId].fingerprint, `${chatId}: the receipt fingerprint is the installation's own key`)
    assert.equal(attempt.stdout.includes(invite.token), false, `the enroll receipt (${chatId}) never echoes the token`)
    return { refused: false, enrolled: line.enrolled, fingerprintMatches: line.fingerprint === installations[chatId].fingerprint, serverUrl: line.server_url }
  }

  // --- The operator mints invite #1; enroll A; the SAME invite is spent -------
  const invite1 = await mintInvite('for dressA')
  const enrollA = await enroll('dressA', invite1)

  saveRemoteConfig(installations.dressB.pluginData, { serverUrl: origin })
  const secondUse = await runCli(
    { sharedDataDir: dataDir, pluginDataDir: installations.dressB.pluginData },
    ['remote', 'enroll', invite1.token],
  )
  assert.equal(secondUse.exitCode, 1, `the second use of the spent invite is refused: ${secondUse.stdout}`)
  assert.equal(secondUse.outcome?.code, 'invite_exhausted', `the refusal is coded invite_exhausted: ${JSON.stringify(secondUse.outcome)}`)
  assert.equal(secondUse.stdout.includes(invite1.token), false, 'the refusal never echoes the token')
  assert.equal(secondUse.stderr.includes(invite1.token), false, 'the refusal line never echoes the token')

  // The CLI listing shows the spent invite: zero uses remaining, no secrets.
  const listing = await runCli({ sharedDataDir: dataDir, pluginDataDir: rootDir }, ['invite', 'list'])
  assert.equal(listing.exitCode, 0, listing.stderr)
  const invite1Row = jsonLines(listing.stdout).map(entry => entry.invite).find(row => row.digest_prefix === invite1.digestPrefix)
  assert.ok(invite1Row, 'the listing names invite #1 by its digest prefix')
  assert.equal(invite1Row.uses_remaining, 0, 'the spent invite shows zero uses remaining')
  assert.equal(listing.stdout.includes(invite1.token), false, 'the listing never shows the token')

  // --- Enroll B with a SECOND invite; then the churn sandboxes C and D ---------
  const invite2 = await mintInvite('for dressB')
  const enrollB = await enroll('dressB', invite2)
  const enrollReceipts = { dressA: enrollA, dressB: enrollB }
  for (const chatId of ['dressC', 'dressD']) {
    const invite = await mintInvite(`for ${chatId}`)
    enrollReceipts[chatId] = await enroll(chatId, invite)
  }

  // --- A and B connect over HTTPS through the challenge lane --------------------
  const clientA = createAgentRoomClient({ dataDir, pluginDataDir: installations.dressA.pluginData })
  const presenceA = await clientA.presence()
  assert.equal(Array.isArray(presenceA.online), true, 'A\u2019s presence read returned the online group')
  assert.equal(clientA.transport, 'remote', 'A\u2019s transport is the earned remote mark')
  const selfRow = presenceA.online.find(row => row.chat_id === 'dressA')
  assert.ok(selfRow, 'A\u2019s own presence row is online')
  assert.equal(selfRow.fingerprint, installations.dressA.fingerprint, 'the server sees A under its own key')
  const statusA = await clientA.status()
  assert.equal(typeof statusA.realm_id === 'string' && statusA.realm_id.length > 0, true, 'A read the realm status')
  assert.equal(typeof statusA.broadcast_room_id === 'string' && statusA.broadcast_room_id.length > 0, true, 'A read the Broadcast Room id')

  const clientB = createAgentRoomClient({ dataDir, pluginDataDir: installations.dressB.pluginData })
  const statusB = await clientB.status()
  assert.equal(clientB.transport, 'remote', 'B\u2019s transport is the earned remote mark')
  assert.equal(statusB.realm_id, statusA.realm_id, 'A and B joined the same realm')
  const presenceBoth = await clientA.presence()
  assert.equal(presenceBoth.online.some(row => row.chat_id === 'dressA'), true, 'A is online')
  assert.equal(presenceBoth.online.some(row => row.chat_id === 'dressB'), true, 'B is online')

  // --- A/B exchange DMs through the rate gates ----------------------------------
  const dmRoomIdA = (await clientA.directOpen({ chatId: 'dressB' })).room_id
  const dmRoomIdB = (await clientB.directOpen({ chatId: 'dressA' })).room_id
  assert.equal(dmRoomIdA, dmRoomIdB, 'both sides converge on one pair room')
  await pacedSends(clientA, dmRoomIdA, 'dm-a', DM_COUNT_PER_SIDE)
  await pacedSends(clientB, dmRoomIdA, 'dm-b', DM_COUNT_PER_SIDE)

  // Delivery, in each reader's own view: the foreign side rides the frozen v1
  // untrusted envelope; a reader's own messages return plain. (The drill
  // rides the api-client — the MCP adapter's own transport — so this is the
  // wire-level delivery; the tool-boundary trust matrix is Story 3.2/3.5's.)
  const dmPageForB = await clientB.readMessage({ roomId: dmRoomIdA, afterSeq: 0 })
  assert.equal(dmPageForB.messages.length, DM_COUNT_PER_SIDE * 2, 'B reads the whole DM exchange')
  const aInView = dmPageForB.messages.filter(message => message.chat_id === 'dressA')
  const bInView = dmPageForB.messages.filter(message => message.chat_id === 'dressB')
  assert.equal(aInView.length, DM_COUNT_PER_SIDE, 'B sees all five of A\u2019s DMs')
  assert.equal(
    aInView.every(message => message.text.startsWith('<untrusted_message version="1"')),
    true,
    'A\u2019s messages arrive in B\u2019s view inside the untrusted envelope',
  )
  assert.equal(
    aInView.every(message => message.text.includes(`sender_fingerprint="${installations.dressA.fingerprint}"`)),
    true,
    'the envelope names A\u2019s fingerprint',
  )
  assert.equal(
    bInView.every(message => !message.text.startsWith('<untrusted_message')),
    true,
    'B\u2019s own messages return plain to B',
  )
  const dmPageForA = await clientA.readMessage({ roomId: dmRoomIdA, afterSeq: 0 })
  const bInViewForA = dmPageForA.messages.filter(message => message.chat_id === 'dressB')
  assert.equal(
    bInViewForA.every(message => message.text.startsWith('<untrusted_message version="1"')),
    true,
    'B\u2019s messages arrive in A\u2019s view inside the untrusted envelope',
  )

  // --- A/B exchange broadcasts through the rate gates ----------------------------
  await sleep(PHASE_SETTLE_MS)
  const broadcastRoomId = statusA.broadcast_room_id
  await pacedSends(clientA, broadcastRoomId, 'bc-a', BROADCAST_COUNT_PER_SIDE)
  await pacedSends(clientB, broadcastRoomId, 'bc-b', BROADCAST_COUNT_PER_SIDE)
  const broadcastBeforeProbe = await clientA.readMessage({ roomId: broadcastRoomId, afterSeq: 0 })
  assert.equal(broadcastBeforeProbe.messages.length, BROADCAST_COUNT_PER_SIDE * 2, 'the broadcast exchange is fully committed')
  const dmDrain = await clientA.readMessage({ roomId: dmRoomIdA, afterSeq: 0 })
  assert.equal(dmDrain.messages.length, DM_COUNT_PER_SIDE * 2, 'the DM exchange is fully committed')

  // --- The explicit rate-gate probe: a burst > capacity trips rate_limited ------
  await sleep(PROBE_SETTLE_MS)
  const probeStartedAt = Date.now()
  const probeResults = []
  for (let index = 0; index < PROBE_BURST; index += 1) {
    try {
      const sent = await clientB.sendMessage({
        roomId: broadcastRoomId,
        clientMessageId: `dress-probe-b-${index}`,
        text: `dress rehearsal probe send ${index}`,
      })
      probeResults.push({ ok: true, seq: sent.seq })
    } catch (error) {
      probeResults.push({ ok: false, code: error?.code ?? String(error) })
    }
  }
  const probeWallMs = Date.now() - probeStartedAt
  const probeCommitted = probeResults.filter(result => result.ok).length
  const probeRefusedResults = probeResults.filter(result => !result.ok)
  const probeRefused = probeRefusedResults.length
  assert.ok(probeWallMs < PROBE_BURST_WALL_LIMIT_MS, `the probe burst was rapid (${probeWallMs} ms, bound ${PROBE_BURST_WALL_LIMIT_MS} ms)`)
  assert.ok(probeCommitted >= 8, `the burst committed against a settled bucket (committed ${probeCommitted})`)
  assert.ok(probeRefused >= 2, `the burst tripped the send bucket (refused ${probeRefused} of ${PROBE_BURST})`)
  assert.equal(
    probeRefusedResults.every(result => result.code === 'rate_limited'),
    true,
    `every refusal is the coded rate_limited: ${JSON.stringify(probeRefusedResults)}`,
  )

  // Back off past one full token refill, then succeed.
  await sleep(PROBE_BACKOFF_MS)
  const backoff = await clientB.sendMessage({
    roomId: broadcastRoomId,
    clientMessageId: 'dress-backoff-b',
    text: 'dress rehearsal: after the backoff',
  })
  assert.equal(backoff.status, 'committed', 'the backoff send succeeds')

  // --- The operator bans B (by fingerprint, via the CLI host) --------------------
  const headBeforeHold = (await clientB.readMessage({ roomId: broadcastRoomId, afterSeq: 0 })).head_seq
  const holdStartedAt = Date.now()
  const holdPromise = clientB.readMessage({ roomId: broadcastRoomId, afterSeq: headBeforeHold, waitMs: LONGPOLL_WINDOW_MS })
    .then(page => ({ page, error: null }), error => ({ page: null, error }))
  await sleep(BAN_MIDHOLD_DELAY_MS)
  const ban = await runCli({ sharedDataDir: dataDir, pluginDataDir: rootDir }, ['ban', installations.dressB.fingerprint, '--reason', 'dress rehearsal ban'])
  assert.equal(ban.exitCode, 0, `the ban succeeded: ${ban.stderr}`)
  const banLine = jsonLines(ban.stdout)[0]
  assert.equal(banLine?.ok, true, 'the ban receipt is ok')
  assert.equal(banLine.command, 'ban')
  assert.equal(banLine.ban.fingerprint, installations.dressB.fingerprint, 'the ban names B\u2019s fingerprint')
  assert.equal(banLine.ban.banned, true, 'the ban is recorded')
  assert.equal(banLine.ban.reason, 'dress rehearsal ban', 'the ban carries the operator\u2019s reason')

  // B's in-flight long-poll terminates at the next poll wake with `banned`.
  const hold = await holdPromise
  const holdElapsedMs = Date.now() - holdStartedAt
  assert.equal(hold.error?.code, 'banned', `the mid-hold poll answered banned: ${JSON.stringify(hold.error ?? hold.page)}`)
  assert.ok(holdElapsedMs < LONGPOLL_WINDOW_MS, `the poll terminated within its ${LONGPOLL_WINDOW_MS} ms window (${holdElapsedMs} ms)`)
  assert.ok(holdElapsedMs < NEXT_WAKE_BOUND_MS, `the poll terminated at the next wake, not the deadline (${holdElapsedMs} ms)`)

  // B's send is refused banned at next request (after one token refills, so
  // the send reaches the authz stage — see BUCKET_REFILL_SETTLE_MS); so is a
  // fresh long-poll, at admission, immediately.
  await sleep(BUCKET_REFILL_SETTLE_MS)
  await refusedCoded(
    clientB.sendMessage({ roomId: broadcastRoomId, clientMessageId: 'dress-banned-b', text: 'this must never commit' }),
    'banned',
    'B\u2019s post-ban send',
  )
  const admissionStartedAt = Date.now()
  await refusedCoded(
    clientB.readMessage({ roomId: broadcastRoomId, afterSeq: 0, waitMs: LONGPOLL_WINDOW_MS }),
    'banned',
    'B\u2019s post-ban long-poll',
  )
  const admissionMs = Date.now() - admissionStartedAt
  assert.ok(admissionMs < ADMISSION_REFUSAL_BOUND_MS, `the admission refusal is immediate (${admissionMs} ms)`)

  // A is untouched and history is kept: A sends, and the pre-ban messages
  // (including B's probe sends) are all still readable.
  const postBan = await clientA.sendMessage({
    roomId: broadcastRoomId,
    clientMessageId: 'dress-postban-a',
    text: 'dress rehearsal: A is still here',
  })
  assert.equal(postBan.status, 'committed', 'A is unaffected by B\u2019s ban')
  const finalBroadcast = await clientA.readMessage({ roomId: broadcastRoomId, afterSeq: 0 })
  const expectedBroadcast = BROADCAST_COUNT_PER_SIDE * 2 + probeCommitted + 1 + 1
  assert.equal(finalBroadcast.messages.length, expectedBroadcast, `the broadcast log holds every committed message (${finalBroadcast.messages.length} of ${expectedBroadcast})`)
  assert.equal(
    finalBroadcast.messages.some(message => message.client_message_id === 'dress-probe-b-0'),
    true,
    'B\u2019s pre-ban messages stay readable (a ban never touches history)',
  )
  assert.equal(
    finalBroadcast.messages.some(message => message.client_message_id === 'dress-banned-b'),
    false,
    'the refused post-ban send never committed',
  )

  return {
    scanTokens: mintedTokens,
    origin,
    fingerprintsDistinct: true,
    enrollReceipts,
    secondUse: { refused: true, code: 'invite_exhausted' },
    spentInviteUsesRemaining: invite1Row.uses_remaining,
    transports: [clientA.transport, clientB.transport],
    realmId: statusA.realm_id,
    dm: { roomConverged: dmRoomIdA === dmRoomIdB, count: DM_COUNT_PER_SIDE * 2, envelopeOnForeign: true },
    broadcast: { beforeProbe: BROADCAST_COUNT_PER_SIDE * 2 },
    probe: { burst: PROBE_BURST, committed: probeCommitted, refused: probeRefused, wallMs: probeWallMs, backoffCommitted: backoff.status === 'committed' },
    ban: {
      receiptOk: banLine?.ok === true,
      fingerprint: banLine?.ban?.fingerprint ?? null,
      longPollRefused: hold.error?.code ?? null,
      longPollElapsedMs: holdElapsedMs,
      longPollWindowMs: LONGPOLL_WINDOW_MS,
      sendRefused: 'banned',
      admissionRefused: 'banned',
      admissionMs,
      aUnaffected: postBan.status,
      broadcastFinal: finalBroadcast.messages.length,
      historyKept: true,
    },
  }
}

// --- The churn journey (Epic 4's churn extension over the TLS front) -----------

async function churnJourney({ origin, serverPid, runtimeRecord, installations }) {
  // Warmup absorbs boot-adjacent growth so the baseline below is the
  // steady-state server (the Story 2.4 discipline).
  for (let cycle = 1; cycle <= CHURN_WARMUP_CYCLES; cycle += 1) {
    await churnCycle(origin, installations.dressC, `warmup ${cycle} dressC`)
    await churnCycle(origin, installations.dressD, `warmup ${cycle} dressD`)
  }
  await sleep(CHURN_SETTLE_MS)

  const tracker = createLeakTracker({ pid: serverPid, intervalMs: 100, tolerancePct: 2 })
  const baseline = await tracker.sampleNow()
  assert.ok(baseline.fdCount >= 6, `the warm server holds at least stdio + listener + sqlite descriptors, received ${baseline.fdCount}`)
  assert.ok(baseline.rssBytes > 1_000_000, `the warm server's RSS is plausible, received ${baseline.rssBytes}`)

  // The front's own descriptor corridor: the same leak-tracker harness
  // sampling THIS process (which holds the TLS listener and every captured
  // request's sockets), so the churn proves the front leaks nothing either.
  const selfTracker = createLeakTracker({ pid: process.pid, intervalMs: 100, tolerancePct: 2 })
  const selfBaseline = await selfTracker.sampleNow()

  const completed = []
  for (let cycle = 1; cycle <= CHURN_CYCLES; cycle += 1) {
    completed.push(await churnCycle(origin, installations.dressC, `cycle ${cycle} dressC`))
    completed.push(await churnCycle(origin, installations.dressD, `cycle ${cycle} dressD`))
    if (cycle % CHURN_SAMPLE_EVERY_CYCLES === 0) await tracker.sampleNow()
  }
  await sleep(CHURN_SETTLE_MS)
  const final = await tracker.sampleNow()
  const selfFinal = await selfTracker.sampleNow()

  // Oracle 1 — every cycle completed, each having bound its Chat ID.
  assert.equal(completed.length, CHURN_CYCLES * 2, `all ${CHURN_CYCLES} cycles for both clients completed`)
  assert.equal(new Set(completed.map(entry => entry.chatId)).size, 2, 'both churn clients bound their own Chat ID')

  // Oracle 2 — every FD sample sits within ±5 of the post-warmup baseline.
  const observed = [baseline, ...tracker.samples, final]
  const worstDrift = Math.max(...observed.map(sample => Math.abs(sample.fdCount - baseline.fdCount)))
  assert.ok(
    worstDrift <= FD_DRIFT_TOLERANCE,
    `the server's FD count left the ±${FD_DRIFT_TOLERANCE} corridor around the post-warmup baseline ${baseline.fdCount}: ` +
    `worst drift ${worstDrift} across ${observed.length} samples ` +
    `(samples: ${observed.map(sample => sample.fdCount).join(', ')})`,
  )
  const selfDrift = Math.abs(selfFinal.fdCount - selfBaseline.fdCount)
  assert.ok(
    selfDrift <= FD_DRIFT_TOLERANCE,
    `the front's FD count left the ±${FD_DRIFT_TOLERANCE} corridor around its baseline ${selfBaseline.fdCount}: drift ${selfDrift}`,
  )

  // Oracle 3 — zero leaked sockets: the server now holds exactly one TCP
  // socket, its listener, and nothing else.
  const listening = await tcpListeningFds(serverPid, runtimeRecord.port)
  assert.equal(listening.length, 1, `the server holds exactly one LISTEN socket, received ${listening.length}`)
  const allTcp = await tcpSocketFds(serverPid)
  assert.deepEqual(allTcp, listening, `every connection socket closed: the server's TCP FDs ${JSON.stringify(allTcp)} must equal the listener ${JSON.stringify(listening)}`)

  // Oracle 4 — the server survived the churn and answers through the front.
  const health = await httpsJson(new URL('/health', origin), 'GET')
  assert.equal(health.status, 200, `the server answers /health through the front after the churn: ${health.text}`)
  assert.equal(health.json?.result?.version, runtimeRecord.version, 'the post-churn version matches the runtime record')

  // Oracle 5 — zero leaked live sessions: one final probe cycle reads
  // presence and finds exactly the three genuinely live sessions (the two
  // governance Actors — one of them banned but still bound — and the probe
  // itself); none of the churn disconnects left a name online.
  const probe = await churnCycle(origin, installations.dressC, 'presence probe dressC', { withPresence: true })
  const onlineIds = probe.online.map(row => row.chat_id).sort()
  assert.deepEqual(onlineIds, ['dressA', 'dressB', 'dressC'], `exactly the live sessions remain: ${JSON.stringify(onlineIds)}`)

  return {
    warmupCycles: CHURN_WARMUP_CYCLES,
    cycles: CHURN_CYCLES,
    clientsPerCycle: 2,
    completed: completed.length,
    fdBaseline: baseline.fdCount,
    fdWorstDrift: worstDrift,
    fdSamples: observed.length,
    selfFdBaseline: selfBaseline.fdCount,
    selfFdDrift: selfDrift,
    tcpListeningCount: listening.length,
    tcpAllEqualsListener: JSON.stringify(allTcp) === JSON.stringify(listening),
    healthVersion: runtimeRecord.version,
    presenceOnline: onlineIds,
  }
}

// --- The counted wire scan --------------------------------------------------------

function wireScan({ dataDir, inviteTokens, probeRefused }) {
  // AC 1's counted scan: zero local-token authentication requests on the
  // wire — either leg, either proto. Stronger still: the local-token file is
  // created only by the LOCAL path's client side (ensureServer /
  // loadOrCreateLocalToken), and this drill never runs that path — so a
  // pure-remote deployment holds NO local credential at all. When the file
  // exists (any other topology), its bytes are scanned against every
  // captured credential header and body.
  const localTokenPath = join(dataDir, 'local-token')
  const localTokenExists = existsSync(localTokenPath)
  assert.equal(localTokenExists, false, 'the pure-remote drill never materialized a local-token credential')
  const localAuthRequests = captures.filter(entry => entry.path === '/api/auth/local').length
  assert.equal(localAuthRequests, 0, 'zero /api/auth/local requests appear on the wire')
  let localTokenOnWire = false
  if (localTokenExists) {
    const localToken = readFileSync(localTokenPath, 'utf8').trim()
    assert.ok(localToken.length > 0, 'the server\u2019s local token exists to scan against')
    localTokenOnWire = captures.some(entry =>
      entry.requestBody.includes(localToken)
      || (typeof entry.authorization === 'string' && entry.authorization.includes(localToken)))
    assert.equal(localTokenOnWire, false, 'the local token appears in no request body or credential header')
  }

  // Invite tokens ride enroll requests and nothing else.
  const tokenBearing = captures.filter(entry => inviteTokens.some(token => entry.requestBody.includes(token)))
  assert.equal(
    tokenBearing.every(entry => entry.path === '/api/auth/enroll'),
    true,
    `invite tokens appear only on enroll requests: ${JSON.stringify(tokenBearing.map(entry => entry.path))}`,
  )

  // The enroll requests: exactly the five presentations this drill makes
  // (A, B's exhausted second use, B, C, D), each visible on both legs.
  const enrollHttps = captures.filter(entry => entry.proto === 'https' && entry.path === '/api/auth/enroll').length
  const enrollHttp = captures.filter(entry => entry.proto === 'http' && entry.path === '/api/auth/enroll').length
  assert.equal(enrollHttps, 5, `exactly five enroll presentations rode the clients\u2019 https legs, received ${enrollHttps}`)
  assert.equal(enrollHttp, 5, 'the front replayed each enroll onto the backend hop')

  // The challenge lane: one exchange per client instance — 2 governance
  // clients + 10 warmup cycles x 2 clients + 100 churn cycles x 2 clients
  // + 1 presence probe = 223.
  const challengeHttps = captures.filter(entry => entry.proto === 'https' && entry.path === '/api/auth/challenge').length
  const answerHttps = captures.filter(entry => entry.proto === 'https' && entry.path === '/api/auth/answer').length
  assert.equal(challengeHttps, 223, `exactly 223 challenges rode the https legs, received ${challengeHttps}`)
  assert.equal(answerHttps, 223, `exactly 223 answers rode the https legs, received ${answerHttps}`)

  // The binds ride the same instances (223); the releases are the churn
  // cycles' alone (the api-client has no logout): 20 warmup + 200 churn
  // + 1 probe = 221.
  const bindHttps = captures.filter(entry => entry.proto === 'https' && entry.path === '/api/session' && entry.method === 'POST').length
  const releaseHttps = captures.filter(entry => entry.proto === 'https' && entry.path === '/api/session' && entry.method === 'DELETE').length
  assert.equal(bindHttps, 223, `exactly 223 binds rode the https legs, received ${bindHttps}`)
  assert.equal(releaseHttps, 221, `exactly 221 releases rode the https legs, received ${releaseHttps}`)

  // Every rate_limited response on the wire — both legs see each refusal —
  // carries its retry delay, and there are exactly the probe's refusals.
  const rateLimitedResponses = captures.filter(entry => {
    try {
      return JSON.parse(entry.responseBody)?.error?.code === 'rate_limited'
    } catch {
      return false
    }
  })
  assert.equal(rateLimitedResponses.length, probeRefused * 2, `every probe refusal appears on both legs: ${rateLimitedResponses.length} responses for ${probeRefused} refusals`)
  for (const entry of rateLimitedResponses) {
    const extra = JSON.parse(entry.responseBody)?.error?.retry_after_ms
    assert.equal(Number.isSafeInteger(extra) && extra >= 1, true, `the rate_limited refusal carries a positive retry_after_ms: ${entry.responseBody}`)
  }

  const httpsHops = captures.filter(entry => entry.proto === 'https').length
  const httpHops = captures.filter(entry => entry.proto === 'http').length
  assert.ok(httpsHops > 0, 'the clients\u2019 https legs happened')
  assert.ok(httpHops > 0, 'the front\u2019s loopback plaintext backend hops happened')

  return {
    captures: captures.length,
    localAuthRequests,
    localTokenExists,
    localTokenOnWire,
    enrollHttps,
    challengeHttps,
    answerHttps,
    bindHttps,
    releaseHttps,
    rateLimitedResponses: rateLimitedResponses.length,
    retryAfterMsSample: rateLimitedResponses.length > 0 ? JSON.parse(rateLimitedResponses[0].responseBody)?.error?.retry_after_ms : null,
    httpsHops,
    httpHops,
  }
}

// --- The drill ---------------------------------------------------------------------

async function run() {
  captureWire()

  const dataDir = join(root, 'shared')
  const serverState = spawnServerChild(dataDir)
  let front = null
  try {
    const runtimeRecord = await waitReady(serverState, dataDir)
    assert.deepEqual(Object.keys(runtimeRecord).sort(), ['pid', 'port', 'version'], 'runtime.json is exactly {pid, port, version}')
    assert.equal(modeOf(join(dataDir, RUNTIME_RECORD_FILENAME), 'file'), 0o600, 'runtime.json is 0600')

    const installations = {}
    for (const chatId of CHAT_IDS) {
      installations[chatId] = makeInstallation(root, `plugin-${chatId.toLowerCase()}`, chatId)
    }

    front = startTlsFront(leafCert, leafKey)
    front.setBackend(runtimeRecord.port)
    const frontPort = await front.listen()
    const origin = `https://127.0.0.1:${frontPort}`

    const governance = await governanceJourney({ rootDir: root, dataDir, origin, installations })
    const churn = await churnJourney({ origin, serverPid: serverState.child.pid, runtimeRecord, installations })
    const wire = wireScan({
      dataDir,
      inviteTokens: governance.scanTokens,
      probeRefused: governance.probe.refused,
    })
    // The minted invite tokens stay out of the report: they were scanned
    // against, never printed.
    const { scanTokens, ...governanceReport } = governance
    assert.equal(scanTokens.length, 4, 'the drill minted exactly four invites')
    const report = { governance: governanceReport, churn, wire }
    console.log(`REPORT:${JSON.stringify(report)}`)
  } finally {
    if (front !== null) {
      try { await front.close() } catch { /* the exit below reports the failure */ }
    }
    await stopServerChild(serverState)
    try { rmSync(dataDir, { recursive: true, force: true }) } catch { /* the parent removes its temp tree */ }
  }
  process.exit(0)
}

run().catch(error => {
  console.error(`driver failed: ${error?.stack ?? String(error)}`)
  process.exit(1)
})
