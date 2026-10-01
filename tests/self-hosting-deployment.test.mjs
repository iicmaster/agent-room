// Story 4.7 acceptance: the self-hosting deployment story — the native
// node:https transport, the strict topology env, `remote enroll`, the guide,
// and the README pins. The matrix rows run against REAL surfaces with zero
// mocks: the journey rows run one real spawned driver child
// (tests/self-hosting-deployment-driver.mjs) over real TLS with real
// certificates, real servers, the real CLI dispatch, and the real api-client;
// the operator rows spawn the real direct-launch server child and the real
// `agent-room` CLI child.
//
// HONEST SCOPE (spec-4-3's recorded precedent, restated in the guide): the
// automated proof is loopback through real TLS. The driver child is spawned
// with NODE_EXTRA_CA_CERTS pointing at the test CA — Node's own documented
// mechanism for adding a private root WITHOUT touching verification
// strictness — and every new server-side source is structurally scanned for
// verification escape hatches. The literal cross-machine walkthrough is
// Story 4.8's dress rehearsal; the operator's own run is evidenced by the
// guide's per-path checklist, not by this suite.
//
// Matrix row → test map:
//    1  native TLS journey            → 'the native node:https path serves the same handler…'
//    2  proxy-path journey            → 'the proxy path serves the same handler…'
//    3  bind rule                     → 'the bind rule survives…'
//    4  TLS material matrix           → 'the TLS material matrix fails startup coded…'
//    5  topology strictness           → 'the topology env is strict…'
//    6+7 start boundary               → 'absent topology env is today's launch…' / 'a port already bound…'
//    8  data-dir advisory             → 'a non-loopback bind on the default data dir draws exactly one advisory line…'
//    9  enroll unconfigured           → 'remote enroll without a configured origin…'
//    10 enroll happy path             → 'remote enroll rides the frozen route over real TLS…'
//    11 enroll gate matrix            → 'the enroll gate matrix through the real CLI…'
//    12 held read + the bound         → 'the 20-second read capture…'
//    13 guide pin                     → 'the deployment guide exists and names its required sections…'
//    14 README pins                   → 'README carries the MCP spec-revision pin…'
//    (plus the usage-grammar, transport-refusal, and structural-scan rows)

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as cryptoSign,
} from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import http from 'node:http'
import https from 'node:https'
import net from 'node:net'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { AgentRoomRuntimeError } from '../server/runtime.mjs'
import {
  INVITE_DIGEST_PREFIX_CHARS,
  INVITE_MAX_USES,
  INVITE_TOKEN_PREFIX,
  INVITE_TTL_SECONDS,
  READ_HOLD_MAX_MS,
} from '../server/constants.mjs'
import { startServer, tlsMaterialFromPaths, topologyFromEnv } from '../server/api/server.mjs'
import { openRoomLog } from '../server/store/room-log.mjs'
import { fingerprintFromPublicKey } from '../server/keys.mjs'
import { saveRemoteConfig } from '../server/client/remote-config.mjs'
import { main as cliMain } from '../server/cli/agent-room.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = join(ROOT, 'server', 'api', 'server.mjs')
const CLI_ENTRY = join(ROOT, 'server', 'cli', 'agent-room.mjs')
const RUNTIME_RECORD_FILENAME = 'runtime.json'
const DATABASE_FILENAME = 'agent-room.sqlite'

const sleep = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })

// --- Test-only PKI material ----------------------------------------------------
//
// The SAME throwaway material tests/remote-client.test.mjs generated once
// with openssl for its suite (EC P-256, valid to 2126): a CA, a leaf with
// IP:127.0.0.1/DNS:localhost SANs, and a standalone self-signed pair (the
// mismatch row's second pair). Reused here so the deployment story proves
// itself against the same certificates the client-side TLS proof used —
// zero new crypto, zero deps.

const TEST_CA_CERT = `-----BEGIN CERTIFICATE-----
MIIBojCCAUegAwIBAgIUD2mVO92poUKwIEasdTszkKpozkwwCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwSYWdlbnQtcm9vbSB0ZXN0IENBMCAXDTI2MDkyOTEzNDIyNVoY
DzIxMjYwOTA1MTM0MjI1WjAdMRswGQYDVQQDDBJhZ2VudC1yb29tIHRlc3QgQ0Ew
WTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAASgVzvUD5OUUZeLFAjEheROAdVeglM2
HvD9nLsxO1McBPUgcY7+kMUVUaj3UfDVyXCFehWBSv/ceYqJAUgLP6iBo2MwYTAd
BgNVHQ4EFgQUH6+1soSK0M6O3+mzCYboePFUIUAwHwYDVR0jBBgwFoAUH6+1soSK
0M6O3+mzCYboePFUIUAwDwYDVR0TAQH/BAUwAwEB/zAOBgNVHQ8BAf8EBAMCAgQw
CgYIKoZIzj0EAwIDSQAwRgIhAO/BNPj39MSrRZ/TPU6YL2Ut7fm4F22j8b0tFvlp
Ea8tAiEAu6u1cVyOYtS1C2CzvREWDgzPRNwJecRiZisNCClyqOM=
-----END CERTIFICATE-----
`

const TEST_LEAF_CERT = `-----BEGIN CERTIFICATE-----
MIIBbDCCAROgAwIBAgIUXOwXSVxeSh+6HT1h+2+z0KpY+UgwCgYIKoZIzj0EAwIw
HTEbMBkGA1UEAwwSYWdlbnQtcm9vbSB0ZXN0IENBMCAXDTI2MDkyOTEzNDIyNVoY
DzIxMjYwOTA1MTM0MjI1WjAjMSEwHwYDVQQDDBhhZ2VudC1yb29tIGxvb3BiYWNr
IGxlYWYwWTATBgcqhkjOPQIBBggqhkjOPQMBBwNCAATQ3AsMwxRYz5RKY0951dBd
DCWFfG4LU6FnsBFhZhXHe9ZpvFylTFzxlI0xurS71FzDc93/mK8C4j1Bq5Sihntb
oykwJzAaBgNVHREEEzARhwR/AAABgglsb2NhbGhvc3QwCQYDVR0TBAIwADAKBggq
hkjOPQQDAgNHADBEAiAk0GyO4d1Z3YrxFL0IaOUJSfIQZMQGG9l9IEm+F57BrwIg
bCzW4Rc1O/JuhIqlQuVX+OdtS0+XREGjSBhl2pMOL+M=
-----END CERTIFICATE-----
`

const TEST_LEAF_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgNYZzhGf/0QoEHqrZ
XPcK/H+WmhZJVCi7p6sof36zyq2hRANCAATQ3AsMwxRYz5RKY0951dBdDCWFfG4L
U6FnsBFhZhXHe9ZpvFylTFzxlI0xurS71FzDc93/mK8C4j1Bq5Sihntb
-----END PRIVATE KEY-----
`

const TEST_SELF_SIGNED_CERT = `-----BEGIN CERTIFICATE-----
MIIBZDCCAQqgAwIBAgIUP4US9tfzG4XwKQqBPcj9CTnrZPQwCgYIKoZIzj0EAwIw
ITEfMB0GA1UEAwwWYWdlbnQtcm9vbSBzZWxmLXNpZ25lZDAgFw0yNjA5MjkxMzQy
MjVaGA8yMTI2MDkwNTEzNDIyNVowITEfMB0GA1UEAwwWYWdlbnQtcm9vbSBzZWxm
LXNpZ25lZDBZMBMGByqGSM49AgEGCCqGSM49AwEHA0IABI0zRGCc9u2X39Ch0taM
AZwANxKYKF6wssmeu6BwDu34ikeAiC98ycAE4blwkR/xHMsg4ubfBrwGzM8EpI4V
f/ejHjAcMBoGA1UdEQQTMBGHBH8AAAGCCWxvY2FsaG9zdDAKBggqhkjOPQQDAgNI
ADBFAiEAjDqOLknwt2U6bfKCIOVqurBSTLKjlpfcldF0scvyducCIBl58sNzYWL5
Nc2/COTLKhMPhfggUDm3D1HqZMYBT7nY
-----END CERTIFICATE-----
`

const TEST_SELF_SIGNED_KEY = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgx7dIB6mpWaucNH/o
FpqjmrlSvgdZQgU4mOggwiGtrk6hRANCAASNM0RgnPbtl9/QodLWjAGcADcSmChe
sLLJnrugcA7t+IpHgIgvfMnABOG5cJEf8RzLIOLm3wa8BszPBKSOFX/3
-----END PRIVATE KEY-----
`

// --- Harness -------------------------------------------------------------------

function makeDirs(t, prefix = 'agent-room-selfhost-') {
  const parent = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  return parent
}

// A real direct-launch server child with the given env. The failure rows
// await waitExit(); the success rows waitRuntimeRecord() and kill() explicitly
// (pass dataDir to register the safety kill).
function spawnServerChild(t, { env, dataDir }) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { PATH: process.env.PATH ?? '', LANG: process.env.LANG ?? 'C.UTF-8', ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdoutChunks = []
  const stderrChunks = []
  child.stdout.on('data', chunk => stdoutChunks.push(chunk))
  child.stderr.on('data', chunk => stderrChunks.push(chunk))
  if (dataDir !== undefined) {
    t.after(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    })
  }
  return {
    child,
    waitExit: async () => {
      const [code] = await once(child, 'exit')
      return {
        code,
        stdout: Buffer.concat(stdoutChunks).toString('utf8'),
        stderr: Buffer.concat(stderrChunks).toString('utf8'),
      }
    },
  }
}

// The post-listen runtime record: a record that exists was written AFTER the
// listener went live, so its port answers.
async function waitRuntimeRecord(dataDir, { timeoutMs = 10_000 } = {}) {
  const runtimePath = join(dataDir, RUNTIME_RECORD_FILENAME)
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (existsSync(runtimePath)) {
      try {
        const record = JSON.parse(readFileSync(runtimePath, 'utf8'))
        if (Number.isInteger(record.port) && record.port > 0) return record
      } catch { /* atomic rename: readers retry */ }
    }
    if (Date.now() > deadline) throw new Error('the server child never became ready')
    await sleep(25)
  }
}

function httpGetJson(port, path = '/health') {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = http.request(
      { host: '127.0.0.1', port, path, method: 'GET', agent: false },
      response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => {
          resolvePromise({ status: response.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        })
      },
    )
    request.setTimeout(2000, () => request.destroy(new Error('health probe timed out')))
    request.on('error', rejectPromise)
    request.end()
  })
}

// One ephemeral port, released for the caller to hand to a child.
async function reserveEphemeralPort() {
  const placeholder = net.createServer()
  await new Promise(resolvePromise => { placeholder.listen(0, '127.0.0.1', () => resolvePromise()) })
  const port = placeholder.address().port
  await new Promise(resolvePromise => { placeholder.close(() => resolvePromise()) })
  return port
}

// A real `agent-room remote enroll` CLI child: the shipped bin's dispatch,
// with PLUGIN_DATA pointed at a fresh installation dir and the test root
// added through NODE_EXTRA_CA_CERTS (no verification override anywhere).
function spawnCliChild(t, { pluginData, token, caPath }) {
  const child = spawn(process.execPath, [CLI_ENTRY, 'remote', 'enroll', token], {
    env: {
      PATH: process.env.PATH ?? '',
      LANG: process.env.LANG ?? 'C.UTF-8',
      HOME: pluginData,
      NODE_EXTRA_CA_CERTS: caPath,
      PLUGIN_DATA: pluginData,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdoutChunks = []
  const stderrChunks = []
  child.stdout.on('data', chunk => stdoutChunks.push(chunk))
  child.stderr.on('data', chunk => stderrChunks.push(chunk))
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  return async () => {
    const [code] = await once(child, 'exit')
    return {
      code,
      stdout: Buffer.concat(stdoutChunks).toString('utf8'),
      stderr: Buffer.concat(stderrChunks).toString('utf8'),
    }
  }
}

// The wrong-signing-key probe (the one gate row the honest CLI face cannot
// produce — the CLI always signs with its own presented key): a real https
// POST through the real TLS server with a real signature from key A
// presented beside key B's public key. Same trust mechanism as the journeys
// (NODE_EXTRA_CA_CERTS, zero verification overrides).
function spawnSignatureProbe(t, { caPath, origin, body }) {
  const script = `
    const https = require('node:https')
    const request = https.request(new URL('/api/auth/enroll', process.env.PROBE_ORIGIN), {
      method: 'POST',
      headers: { 'Agent-Room-Protocol': '1', 'content-type': 'application/json; charset=utf-8' },
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'))
        console.log('RESULT:' + JSON.stringify({ status: response.statusCode, code: (parsed && parsed.error && parsed.error.code) || null }))
      })
    })
    request.on('error', error => { console.log('RESULT:' + JSON.stringify({ status: 0, code: (error && error.code) || String(error) })) })
    request.end(process.env.PROBE_BODY)
  `
  const child = spawn(process.execPath, ['-e', script], {
    env: {
      PATH: process.env.PATH ?? '',
      NODE_EXTRA_CA_CERTS: caPath,
      PROBE_ORIGIN: origin,
      PROBE_BODY: JSON.stringify(body),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const chunks = []
  child.stdout.on('data', chunk => chunks.push(chunk))
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  return async () => {
    const [code] = await once(child, 'exit')
    assert.equal(code, 0)
    const line = Buffer.concat(chunks).toString('utf8').split('\n').find(text => text.startsWith('RESULT:'))
    return JSON.parse(line.slice('RESULT:'.length))
  }
}

const jsonLines = text => text.trim().split('\n').filter(lineText => lineText.length > 0).map(lineText => JSON.parse(lineText))

// The CLI dispatch in-process (the in-process rows' real surface).
async function runCli(t, { pluginData }, argv) {
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
      sharedDataDir: join(pluginData, 'unused-shared'),
      pluginDataDir: pluginData,
    })
    await sleep(10)
    return { outcome, stdout, stderr, exitCode: process.exitCode ?? 0 }
  } finally {
    process.exitCode = previousExitCode
  }
}

// One fresh native-TLS server in this process (Path B's face for the enroll
// rows) plus the test CA on disk for the CLI children.
async function startNativeTlsServer(t, parent) {
  const dataDir = join(parent, `data-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  const certsDir = join(parent, `certs-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  mkdirSync(certsDir, { recursive: true, mode: 0o700 })
  const caPath = join(certsDir, 'ca.pem')
  const certPath = join(certsDir, 'leaf-cert.pem')
  const keyPath = join(certsDir, 'leaf-key.pem')
  writeFileSync(caPath, TEST_CA_CERT, { mode: 0o600 })
  writeFileSync(certPath, TEST_LEAF_CERT, { mode: 0o600 })
  writeFileSync(keyPath, TEST_LEAF_KEY, { mode: 0o600 })
  const server = await startServer({ dataDir, host: '127.0.0.1', tls: { cert: TEST_LEAF_CERT, key: TEST_LEAF_KEY } })
  t.after(() => server.close())
  return { server, dataDir, caPath, origin: `https://127.0.0.1:${server.port}` }
}

// One installation dir (config-free: remote enroll needs only the origin and
// the keypair) with its remote origin already configured through the shipped
// config module.
function makeInstallation(t, parent, name, origin) {
  const pluginData = join(parent, `${name}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`)
  mkdirSync(pluginData, { recursive: true, mode: 0o700 })
  if (origin !== undefined) saveRemoteConfig(pluginData, { serverUrl: origin })
  return pluginData
}

const wellFormedUnknownToken = `${INVITE_TOKEN_PREFIX}${'z'.repeat(3)}${'Y'.repeat(40)}`

function mintViaStore(dataDir, { uses = INVITE_MAX_USES, ttlSeconds = INVITE_TTL_SECONDS } = {}) {
  const store = openRoomLog({ dataDir })
  try {
    return store.mintInvite({ uses, ttlSeconds })
  } finally {
    store.close()
  }
}

function inviteUsesRemaining(dataDir, digest) {
  const store = openRoomLog({ dataDir })
  try {
    return store.listInvites().find(row => row.digest === digest)?.uses_remaining
  } finally {
    store.close()
  }
}

function installationFingerprint(pluginData) {
  const pem = readFileSync(join(pluginData, 'identity.key'), 'utf8')
  const spki = createPublicKey(createPrivateKey(pem)).export({ type: 'spki', format: 'der' })
  return fingerprintFromPublicKey(spki.subarray(spki.length - 32))
}

// --- The two journeys (matrix rows 1, 2, 12; the AC's "both paths reach
// --- enrollment + a 20-second read through the same handler") ------------------
//
// One driver run serves all three rows (the run costs a real 20-second hold).

let journeyReportPromise = null

function journeyReport(t) {
  if (journeyReportPromise === null) journeyReportPromise = runDriver(t)
  return journeyReportPromise
}

async function runDriver(t) {
  const parent = makeDirs(t, 'agent-room-selfhost-journey-')
  const certsDir = join(parent, 'certs')
  mkdirSync(certsDir, { recursive: true, mode: 0o700 })
  const caPath = join(certsDir, 'ca.pem')
  const certPath = join(certsDir, 'leaf-cert.pem')
  const keyPath = join(certsDir, 'leaf-key.pem')
  writeFileSync(caPath, TEST_CA_CERT, { mode: 0o600 })
  writeFileSync(certPath, TEST_LEAF_CERT, { mode: 0o600 })
  writeFileSync(keyPath, TEST_LEAF_KEY, { mode: 0o600 })

  const child = spawn(process.execPath, [join(ROOT, 'tests', 'self-hosting-deployment-driver.mjs')], {
    env: {
      PATH: process.env.PATH ?? '',
      LANG: process.env.LANG ?? 'C.UTF-8',
      NODE_EXTRA_CA_CERTS: caPath,
      AGENT_ROOM_SELFHOST_ROOT: parent,
      AGENT_ROOM_SELFHOST_CERT: certPath,
      AGENT_ROOM_SELFHOST_KEY: keyPath,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdoutChunks = []
  const stderrChunks = []
  child.stdout.on('data', chunk => stdoutChunks.push(chunk))
  child.stderr.on('data', chunk => stderrChunks.push(chunk))
  const [code] = await once(child, 'exit')
  const stdout = Buffer.concat(stdoutChunks).toString('utf8')
  const stderr = Buffer.concat(stderrChunks).toString('utf8')
  assert.equal(code, 0, `the driver child failed (exit ${code}):\n${stderr}`)
  const reportLine = stdout.split('\n').find(lineText => lineText.startsWith('REPORT:'))
  assert.ok(reportLine, `no REPORT line in the driver stdout:\n${stdout}`)
  return JSON.parse(reportLine.slice('REPORT:'.length))
}

function assertJourney(leg, { expectBoundRows, expectFrontHops }) {
  const label = leg.label
  assert.equal(leg.receiptOk, true, `${label}: the enroll receipt shape`)
  assert.equal(leg.receiptServerUrl, leg.origin, `${label}: the receipt names the server origin`)
  assert.equal(leg.fingerprintMatches, true, `${label}: the journey ran under the installation key`)
  assert.equal(leg.receiptFingerprintMatches, true, `${label}: the returned fingerprint equals the installation fingerprint`)
  assert.equal(leg.tokenLeaked, false, `${label}: the full token appears nowhere — not in the receipt, not on the wire`)
  assert.match(leg.receiptDigestPrefix ?? '', /^[0-9a-f]{12}$/, `${label}: the receipt carries the 12-hex digest prefix`)
  assert.deepEqual(leg.transports, ['remote', 'remote'], `${label}: both client instances ride the challenge lane`)
  assert.equal(leg.selfRow, true, `${label}: the enrolled key is present (not_enrolled never seen)`)
  assert.equal(leg.holdEngaged, true, `${label}: the held read held`)
  assert.equal(leg.holdReleasedOnArrival, true, `${label}: the hold released on the mid-hold arrival`)
  assert.equal(leg.counts.enrollRequests, 0, `${label}: zero enroll requests after the one enrollment`)
  assert.equal(leg.counts.localAuthRequests, 0, `${label}: zero local-token requests`)
  assert.equal(leg.counts.inviteTokenFieldOccurrences, 0, `${label}: zero invite_token bytes after enrollment`)
  assert.equal(leg.counts.rawTokenOccurrences, 0, `${label}: zero raw-token bytes after enrollment`)
  assert.equal(leg.counts.challengeRequests, 2, `${label}: two client instances, one challenge each`)
  assert.equal(leg.counts.answerRequests, 2, `${label}: two answers`)
  if (expectBoundRows) {
    assert.equal(leg.boundHold.waitMs, READ_HOLD_MAX_MS, `${label}: the capture is at the declared bound`)
    assert.ok(leg.boundHold.elapsedMs >= READ_HOLD_MAX_MS - 500, `${label}: the quiet-room hold ran to the bound (${leg.boundHold.elapsedMs} ms)`)
    assert.equal(leg.boundHold.empty, true, `${label}: the bound hold answers the normal possibly-empty page`)
    assert.equal(leg.boundHold.hasNextAfterSeq, true, `${label}: next_after_seq rides the page`)
    assert.equal(leg.boundHold.hasHeadSeq, true, `${label}: head_seq rides the page`)
    assert.equal(leg.overBound, 'invalid_wait_ms', `${label}: beyond the bound is the coded refusal`)
    assert.equal(leg.counts.httpHops, 0, `${label}: the native leg is https end to end`)
    assert.ok(leg.counts.httpsHops > 0)
  }
  if (expectFrontHops) {
    assert.ok(leg.counts.httpHops > 0, `${label}: the front's loopback PLAINTEXT backend hop happened`)
    assert.ok(leg.counts.httpsHops > 0, `${label}: the client's https leg happened`)
  }
}

test('the native node:https path serves the same handler: enrollment through the real CLI, the challenge lane, a send, and a held read over real TLS', async t => {
  const report = await journeyReport(t)
  assertJourney(report.native, { expectBoundRows: true, expectFrontHops: false })
})

test('the proxy path serves the same handler: the same journey through a real TLS front terminating to the loopback plaintext backend', async t => {
  const report = await journeyReport(t)
  assertJourney(report.front, { expectBoundRows: false, expectFrontHops: true })
})

test('the 20-second read capture: a quiet-room hold at the declared bound answers the normal empty page and beyond the bound is the coded invalid_wait_ms', async t => {
  const report = await journeyReport(t)
  const { boundHold, overBound } = report.native
  assert.equal(boundHold.waitMs, READ_HOLD_MAX_MS)
  assert.ok(boundHold.elapsedMs >= READ_HOLD_MAX_MS - 500, `the hold ran ${boundHold.elapsedMs} ms`)
  assert.equal(boundHold.empty, true)
  assert.equal(boundHold.hasNextAfterSeq, true)
  assert.equal(boundHold.hasHeadSeq, true)
  assert.equal(overBound, 'invalid_wait_ms')
})

// --- The bind rule (row 3) -------------------------------------------------------

test('the bind rule survives: plaintext refuses a non-loopback host byte-identically; TLS material may bind any host', async t => {
  const parent = makeDirs(t)

  // WITHOUT tls: the pre-4.7 refusal, message byte-for-byte, no listener.
  await assert.rejects(
    () => startServer({ dataDir: join(parent, 'd1'), host: '0.0.0.0' }),
    error => error instanceof AgentRoomRuntimeError
      && error.code === 'invalid_argument'
      && error.message === 'the agent-room server binds loopback only',
  )
  await assert.rejects(
    () => startServer({ dataDir: join(parent, 'd2'), host: 'localhost' }),
    error => error.code === 'invalid_argument' && error.message === 'the agent-room server binds loopback only',
  )
  // And the refusal is structural, not a warning: the default loopback bind
  // still boots beside it (the unchanged face).
  const loopback = await startServer({ dataDir: join(parent, 'd3') })
  t.after(() => loopback.close())
  assert.ok(Number.isInteger(loopback.port) && loopback.port > 0)

  // WITH valid tls: the same refused host binds and serves TLS.
  const publicServer = await startServer({
    dataDir: join(parent, 'd4'),
    host: '0.0.0.0',
    tls: { cert: TEST_LEAF_CERT, key: TEST_LEAF_KEY },
  })
  t.after(() => publicServer.close())
  assert.ok(Number.isInteger(publicServer.port) && publicServer.port > 0)
  // The listener answers with TLS: an in-process client whose default
  // verification does not trust the test leaf is refused AT CERTIFICATE
  // VERIFICATION — proof the socket speaks TLS (a plaintext socket would
  // answer, with no certificate error at all). No bypass anywhere.
  await assert.rejects(
    () => new Promise((resolvePromise, rejectPromise) => {
      const request = https.request(
        { host: '127.0.0.1', port: publicServer.port, path: '/health', method: 'GET', agent: false },
        () => resolvePromise(),
      )
      request.on('error', rejectPromise)
      request.end()
    }),
    error => /CERT|TLS|SIG/i.test(String(error?.code ?? error?.message ?? '')),
  )
})

// --- The TLS material matrix (row 4) ----------------------------------------------

test('the TLS material matrix fails startup coded invalid_argument before any listener exists', async t => {
  const parent = makeDirs(t)

  // Option-shape rows: a missing half, a non-object, non-string fields —
  // every malformed tls option is a coded startup failure, never a boot.
  for (const tls of [null, {}, { cert: TEST_LEAF_CERT }, { key: TEST_LEAF_KEY }, { cert: 5, key: 5 }, 'pem']) {
    await assert.rejects(
      () => startServer({ dataDir: join(parent, `shape-${JSON.stringify(tls).length}-${String(tls).length}`), tls }),
      error => error.code === 'invalid_argument',
      JSON.stringify(tls),
    )
  }

  // Content rows: malformed PEM either side, and well-formed MISMATCHED pairs.
  await assert.rejects(
    () => startServer({ dataDir: join(parent, 'dm1'), tls: { cert: 'this is not pem', key: TEST_LEAF_KEY } }),
    error => error.code === 'invalid_argument' && /tls\.cert/.test(error.message),
  )
  await assert.rejects(
    () => startServer({ dataDir: join(parent, 'dm2'), tls: { cert: TEST_LEAF_CERT, key: 'also not pem' } }),
    error => error.code === 'invalid_argument' && /tls\.key/.test(error.message),
  )
  await assert.rejects(
    () => startServer({ dataDir: join(parent, 'dm3'), tls: { cert: TEST_LEAF_CERT, key: TEST_SELF_SIGNED_KEY } }),
    error => error.code === 'invalid_argument' && /do not match/.test(error.message),
  )
  await assert.rejects(
    () => startServer({ dataDir: join(parent, 'dm4'), tls: { cert: TEST_SELF_SIGNED_CERT, key: TEST_LEAF_KEY } }),
    error => error.code === 'invalid_argument' && /do not match/.test(error.message),
  )
  // A valid pair passes validation exactly at the same option surface.
  const ok = await startServer({ dataDir: join(parent, 'dm5'), tls: { cert: TEST_LEAF_CERT, key: TEST_LEAF_KEY } })
  t.after(() => ok.close())

  // The direct launch's path reader: a missing file and a symlinked path are
  // coded invalid_argument naming the env knob, before any listener exists.
  assert.throws(
    () => tlsMaterialFromPaths({ certPath: join(parent, 'absent-cert.pem'), keyPath: join(parent, 'absent-key.pem') }),
    error => error.code === 'invalid_argument' && error.message.includes('AGENT_ROOM_TLS_CERT'),
  )
  writeFileSync(join(parent, 'real.pem'), TEST_LEAF_CERT, { mode: 0o600 })
  writeFileSync(join(parent, 'real.key'), TEST_LEAF_KEY, { mode: 0o600 })
  symlinkSync(join(parent, 'real.pem'), join(parent, 'link.pem'))
  assert.throws(
    () => tlsMaterialFromPaths({ certPath: join(parent, 'link.pem'), keyPath: join(parent, 'real.key') }),
    error => error.code === 'invalid_argument' && error.message.includes('AGENT_ROOM_TLS_CERT'),
  )
  const material = tlsMaterialFromPaths({ certPath: join(parent, 'real.pem'), keyPath: join(parent, 'real.key') })
  assert.equal(material.cert, TEST_LEAF_CERT)
  assert.equal(material.key, TEST_LEAF_KEY)
})

// --- The strict topology env (row 5) ----------------------------------------------

test('the topology env is strict: junk port, junk host, an absent cert file, and one knob without its sibling each die with one coded line, exit 1, and no boot', async t => {
  // The parser's unit face: absent env is today's defaults; junk is a coded
  // problem; there is no fallback shape.
  const absent = topologyFromEnv({})
  assert.deepEqual(absent, { host: '127.0.0.1', port: 0, tlsCertPath: undefined, tlsKeyPath: undefined, problems: [] })
  assert.match(topologyFromEnv({ AGENT_ROOM_PORT: 'junk' }).problems[0], /AGENT_ROOM_PORT/)
  assert.match(topologyFromEnv({ AGENT_ROOM_PORT: '-1' }).problems[0], /AGENT_ROOM_PORT/)
  assert.match(topologyFromEnv({ AGENT_ROOM_PORT: '65536' }).problems[0], /AGENT_ROOM_PORT/)
  assert.match(topologyFromEnv({ AGENT_ROOM_HOST: 'a b c' }).problems[0], /AGENT_ROOM_HOST/)
  assert.match(topologyFromEnv({ AGENT_ROOM_TLS_CERT: '/a.pem' }).problems[0], /AGENT_ROOM_TLS_KEY is missing/)
  assert.match(topologyFromEnv({ AGENT_ROOM_TLS_KEY: '/b.pem' }).problems[0], /AGENT_ROOM_TLS_CERT is missing/)
  assert.match(topologyFromEnv({ AGENT_ROOM_TLS_CERT: 'rel.pem', AGENT_ROOM_TLS_KEY: '/b.pem' }).problems[0], /absolute path/)
  const strict = topologyFromEnv({ AGENT_ROOM_HOST: '0.0.0.0', AGENT_ROOM_PORT: '8443', AGENT_ROOM_TLS_CERT: '/a.pem', AGENT_ROOM_TLS_KEY: '/b.pem' })
  assert.deepEqual(strict.problems, [])
  assert.equal(strict.host, '0.0.0.0')
  assert.equal(strict.port, 8443)

  // The spawned face: each junk row dies before boot with exactly one
  // diagnosable line and no runtime record.
  const parent = makeDirs(t)
  const certPath = join(parent, 'cert.pem')
  writeFileSync(certPath, TEST_LEAF_CERT, { mode: 0o600 })
  const rows = [
    ['junk port', { AGENT_ROOM_DATA_DIR: join(parent, 'p1'), AGENT_ROOM_PORT: 'junk' }, /AGENT_ROOM_PORT/],
    ['public bind without tls is the bind refusal', { AGENT_ROOM_DATA_DIR: join(parent, 'p2'), AGENT_ROOM_HOST: '0.0.0.0' }, /binds loopback only/],
    ['absent cert file', { AGENT_ROOM_DATA_DIR: join(parent, 'p3'), AGENT_ROOM_TLS_CERT: join(parent, 'absent.pem'), AGENT_ROOM_TLS_KEY: join(parent, 'absent.key') }, /AGENT_ROOM_TLS_CERT/],
    ['one knob without its sibling', { AGENT_ROOM_DATA_DIR: join(parent, 'p4'), AGENT_ROOM_TLS_CERT: certPath }, /AGENT_ROOM_TLS_KEY is missing/],
  ]
  for (const [name, env, pattern] of rows) {
    const { waitExit } = spawnServerChild(t, { env })
    const outcome = await waitExit()
    assert.equal(outcome.code, 1, `${name}: exit 1`)
    assert.equal(outcome.stdout, '', `${name}: nothing on stdout`)
    const lines = outcome.stderr.split('\n').filter(lineText => lineText.length > 0)
    assert.equal(lines.length, 1, `${name}: exactly one diagnosable line, got ${JSON.stringify(outcome.stderr)}`)
    assert.match(lines[0], /^agent-room-server: /, `${name}: the diagnosable prefix`)
    assert.match(lines[0], pattern, `${name}: the coded cause`)
    assert.equal(existsSync(join(env.AGENT_ROOM_DATA_DIR, RUNTIME_RECORD_FILENAME)), false, `${name}: no runtime record for a failed boot`)
  }
})

// --- The start boundary's success face + byte-identical absent env (rows 5, 7) ----

test("absent topology env is today's launch: loopback, ephemeral port, health answering, runtime.json written post-listen", async t => {
  const parent = makeDirs(t)
  const dataDir = join(parent, 'data')
  const { child, waitExit } = spawnServerChild(t, { env: { AGENT_ROOM_DATA_DIR: dataDir }, dataDir })
  const record = await waitRuntimeRecord(dataDir)
  assert.ok(Number.isInteger(record.port) && record.port > 0, 'the record carries a real bound port')
  assert.equal(record.pid, child.pid)
  const health = await httpGetJson(record.port)
  assert.equal(health.status, 200)
  assert.equal(health.body?.ok, true)
  assert.equal(typeof health.body?.result?.version, 'string')
  child.kill('SIGTERM')
  const outcome = await waitExit()
  assert.equal(outcome.code, 0, `a clean SIGTERM shutdown exits 0 (got ${outcome.code}): ${outcome.stderr}`)
  assert.equal(outcome.stderr, '', `no noise on the happy launch: ${JSON.stringify(outcome.stderr)}`)
})

// --- Port already bound (row 6) ---------------------------------------------------

test('a port already bound fails the second boot diagnosably and leaves the first unaffected', async t => {
  const parent = makeDirs(t)
  const port = await reserveEphemeralPort()

  const first = spawnServerChild(t, { env: { AGENT_ROOM_DATA_DIR: join(parent, 'a'), AGENT_ROOM_PORT: String(port) }, dataDir: join(parent, 'a') })
  const record = await waitRuntimeRecord(join(parent, 'a'))
  assert.equal(record.port, port, 'the first child bound the named port')

  const second = spawnServerChild(t, { env: { AGENT_ROOM_DATA_DIR: join(parent, 'b'), AGENT_ROOM_PORT: String(port) } })
  const failed = await second.waitExit()
  assert.equal(failed.code, 1)
  const lines = failed.stderr.split('\n').filter(lineText => lineText.length > 0)
  assert.equal(lines.length, 1, `exactly one diagnosable line: ${JSON.stringify(failed.stderr)}`)
  assert.match(lines[0], /^agent-room-server: /)
  assert.match(lines[0], /EADDRINUSE/, 'the coded cause names the held port')
  assert.equal(existsSync(join(parent, 'b', RUNTIME_RECORD_FILENAME)), false, 'the failed boot wrote no runtime record')
  const health = await httpGetJson(record.port)
  assert.equal(health.status, 200, 'the first child is unaffected and still answers')
  first.child.kill('SIGTERM')
  await first.waitExit()
})

// --- The data-dir advisory (row 8) -------------------------------------------------

test('a non-loopback bind on the default data dir draws exactly one advisory line; a dedicated data dir stays silent', async t => {
  const parent = makeDirs(t)
  const certsDir = join(parent, 'certs')
  mkdirSync(certsDir, { recursive: true, mode: 0o700 })
  const certPath = join(certsDir, 'cert.pem')
  const keyPath = join(certsDir, 'key.pem')
  writeFileSync(certPath, TEST_LEAF_CERT, { mode: 0o600 })
  writeFileSync(keyPath, TEST_LEAF_KEY, { mode: 0o600 })
  // HOME is redirected so the DEFAULT shared data dir resolves inside the
  // sandbox — the advisory keys on AGENT_ROOM_DATA_DIR being unset, and this
  // row must never touch a real home directory.
  const fakeHome = join(parent, 'home')
  const tlsEnv = {
    AGENT_ROOM_HOST: '0.0.0.0',
    AGENT_ROOM_TLS_CERT: certPath,
    AGENT_ROOM_TLS_KEY: keyPath,
    HOME: fakeHome,
  }

  const advised = spawnServerChild(t, { env: tlsEnv, dataDir: join(fakeHome, '.agent-room') })
  await waitRuntimeRecord(join(fakeHome, '.agent-room'))
  advised.child.kill('SIGTERM')
  const advisedOutcome = await advised.waitExit()
  const advisoryLines = advisedOutcome.stderr.split('\n').filter(lineText => lineText.includes('advisory'))
  assert.equal(advisoryLines.length, 1, `exactly one advisory line: ${JSON.stringify(advisedOutcome.stderr)}`)
  assert.match(advisoryLines[0], /AGENT_ROOM_DATA_DIR/)
  assert.match(advisoryLines[0], /one process, one realm, one data dir/)
  assert.equal(advisedOutcome.stderr.includes('invalid_argument'), false, 'the advisory is not a refusal')

  const dedicated = join(parent, 'dedicated')
  const silent = spawnServerChild(t, { env: { ...tlsEnv, AGENT_ROOM_DATA_DIR: dedicated }, dataDir: dedicated })
  await waitRuntimeRecord(dedicated)
  silent.child.kill('SIGTERM')
  const silentOutcome = await silent.waitExit()
  assert.equal(silentOutcome.stderr.includes('advisory'), false, `no advisory with a dedicated dir: ${JSON.stringify(silentOutcome.stderr)}`)
  assert.equal(silentOutcome.stderr, '')
})

// --- `remote enroll`: the family rows (rows 9, 10, 11) -----------------------------

test('remote enroll without a configured origin refuses coded naming remote set and sends nothing', async t => {
  const parent = makeDirs(t)
  const pluginData = makeInstallation(t, parent, 'unset', undefined)
  const refused = await runCli(t, { pluginData }, ['remote', 'enroll', wellFormedUnknownToken])
  assert.equal(refused.exitCode, 1, refused.stderr)
  assert.equal(refused.stdout, '', 'nothing is printed on stdout')
  const [line] = jsonLines(refused.stderr)
  assert.equal(line.ok, false)
  assert.equal(line.command, 'remote enroll')
  assert.equal(line.code, 'invalid_request')
  assert.match(line.message, /remote set/)
  assert.equal(jsonLines(refused.stderr).length, 1, 'exactly one refusal line')
})

test('remote enroll usage: arity, flags, and a malformed token exit 2 without echoing the token', async t => {
  const parent = makeDirs(t)
  const pluginData = makeInstallation(t, parent, 'usage', 'https://room.example.com')
  const secretish = `${INVITE_TOKEN_PREFIX}${'S'.repeat(43)}`
  for (const [argv, messagePattern] of [
    [['remote', 'enroll'], /expected exactly one invite token/],
    [['remote', 'enroll', secretish, 'extra'], /unexpected extra argument/],
    [['remote', 'enroll', '--junk'], /unknown option/],
    [['remote', 'enroll', 'not-a-token'], /expected exactly one invite token/],
    [['remote', 'enrollx'], /is not a remote command/],
  ]) {
    const usage = await runCli(t, { pluginData }, argv)
    assert.equal(usage.exitCode, 2, `${JSON.stringify(argv)}: exit 2 (${usage.stderr})`)
    assert.equal(usage.stdout, '')
    const [line] = jsonLines(usage.stderr)
    assert.equal(line.ok, false)
    assert.equal(line.code, 'usage', JSON.stringify(argv))
    if (messagePattern) assert.match(line.message, messagePattern)
    assert.equal(usage.stderr.includes(secretish), false, 'the malformed-token row never echoes the argument')
  }
  const help = await runCli(t, { pluginData }, ['help'])
  assert.match(help.stdout.replace(/\s+/g, ' '), /agent-room remote enroll <invite-token>/, 'the help carries the enroll grammar')
})

test('remote enroll against an unreachable origin surfaces the coded transport refusal', async t => {
  const parent = makeDirs(t)
  const closedPort = await reserveEphemeralPort()
  const pluginData = makeInstallation(t, parent, 'unreachable', `https://127.0.0.1:${closedPort}`)
  const refused = await runCli(t, { pluginData }, ['remote', 'enroll', wellFormedUnknownToken])
  assert.equal(refused.exitCode, 1, refused.stderr)
  const [line] = jsonLines(refused.stderr)
  assert.equal(line.ok, false)
  assert.equal(line.code, 'request_failed')
  assert.match(line.message, /enrollment request failed/)
})

test('remote enroll rides the frozen route over real TLS: one redacted receipt, the matching fingerprint, and a failed attempt is retryable with the same token', async t => {
  const parent = makeDirs(t)
  const { server, dataDir, caPath, origin } = await startNativeTlsServer(t, parent)
  const minted = mintViaStore(dataDir)

  // The gate row the honest CLI face cannot produce: a real Ed25519
  // signature from key A presented beside key B's public key answers the
  // coded signature_invalid over the deployed TLS path and consumes NOTHING.
  const keyA = generateKeyPairSync('ed25519')
  const keyB = generateKeyPairSync('ed25519')
  const rawOf = pair => pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  const signature = cryptoSign(null, Buffer.from(minted.token, 'utf8'), keyA.privateKey).toString('base64url')
  const probe = spawnSignatureProbe(t, {
    caPath,
    origin,
    body: {
      invite_token: minted.token,
      public_key: Buffer.from(rawOf(keyB)).toString('base64url'),
      signature,
    },
  })
  const probeResult = await probe()
  assert.equal(probeResult.status, 401)
  assert.equal(probeResult.code, 'signature_invalid')
  assert.equal(inviteUsesRemaining(dataDir, minted.digest), 1, 'a refused attempt consumed nothing')

  // The route's durability rule, through the deployed path: the SAME token
  // then enrolls the real CLI child, whose receipt is redacted and whose
  // fingerprint is the installation's own.
  const pluginData = makeInstallation(t, parent, 'happy', origin)
  const enroll = await spawnCliChild(t, { pluginData, token: minted.token, caPath })()
  assert.equal(enroll.code, 0, `the CLI child succeeded: ${enroll.stderr}`)
  assert.equal(enroll.stderr, '', `no stderr on success: ${JSON.stringify(enroll.stderr)}`)
  const [receipt] = jsonLines(enroll.stdout)
  assert.equal(receipt.ok, true)
  assert.equal(receipt.command, 'remote enroll')
  assert.equal(receipt.mode, 'remote')
  assert.equal(receipt.server_url, origin)
  assert.equal(receipt.enrolled, true)
  assert.equal(receipt.fingerprint, installationFingerprint(pluginData), 'the returned fingerprint is the installation keypair\'s')
  const expectedPrefix = createHash('sha256')
    .update(Buffer.from(minted.token.slice(INVITE_TOKEN_PREFIX.length), 'base64url'))
    .digest('hex')
    .slice(0, INVITE_DIGEST_PREFIX_CHARS)
  assert.match(receipt.token_digest_prefix, new RegExp(`^[0-9a-f]{${INVITE_DIGEST_PREFIX_CHARS}}$`))
  assert.equal(receipt.token_digest_prefix, expectedPrefix, 'the receipt prefix is the store registry\'s own derivation')
  assert.equal(enroll.stdout.includes(minted.token), false, 'the full token appears nowhere in the child output')
  assert.equal(enroll.stderr.includes(minted.token), false)
  assert.ok(server.port > 0)
})

test('the enroll gate matrix through the real CLI: unknown, revoked, expired, spent, and rate-limited each answer their coded refusal exit 1', async t => {
  const parent = makeDirs(t)

  // One server for the credential rows (unknown / revoked / expired): three
  // CLI children, three coded refusals, every invite's use untouched.
  const first = await startNativeTlsServer(t, parent)
  const unknown = await spawnCliChild(t, {
    pluginData: makeInstallation(t, parent, 'unknown', first.origin),
    token: wellFormedUnknownToken,
    caPath: first.caPath,
  })()
  assert.equal(unknown.code, 1, unknown.stderr)
  assert.equal(jsonLines(unknown.stderr)[0].code, 'invite_invalid')
  assert.equal(jsonLines(unknown.stderr)[0].ok, false)
  assert.equal(jsonLines(unknown.stderr)[0].command, 'remote enroll')

  const revokedMint = mintViaStore(first.dataDir)
  {
    const store = openRoomLog({ dataDir: first.dataDir })
    try { store.revokeInvite({ digestPrefix: revokedMint.digest.slice(0, INVITE_DIGEST_PREFIX_CHARS) }) } finally { store.close() }
  }
  const revoked = await spawnCliChild(t, {
    pluginData: makeInstallation(t, parent, 'revoked', first.origin),
    token: revokedMint.token,
    caPath: first.caPath,
  })()
  assert.equal(revoked.code, 1)
  assert.equal(jsonLines(revoked.stderr)[0].code, 'invite_invalid')
  assert.equal(inviteUsesRemaining(first.dataDir, revokedMint.digest), 1, 'a refused enrollment consumes nothing')

  const expiredMint = mintViaStore(first.dataDir)
  {
    const { DatabaseSync } = await import('node:sqlite')
    const surgeon = new DatabaseSync(join(first.dataDir, DATABASE_FILENAME))
    surgeon.prepare('UPDATE invites SET expires_at = ? WHERE digest = ?').run('2020-01-01T00:00:00.000Z', expiredMint.digest)
    surgeon.close()
  }
  const expired = await spawnCliChild(t, {
    pluginData: makeInstallation(t, parent, 'expired', first.origin),
    token: expiredMint.token,
    caPath: first.caPath,
  })()
  assert.equal(expired.code, 1)
  assert.equal(jsonLines(expired.stderr)[0].code, 'invite_invalid')
  assert.equal(inviteUsesRemaining(first.dataDir, expiredMint.digest), 1)

  // A second server for the spent row: the first key's committed enrollment
  // answers the second key's presentation with the race loser's conflict.
  const second = await startNativeTlsServer(t, parent)
  const spentMint = mintViaStore(second.dataDir)
  const firstKey = await spawnCliChild(t, {
    pluginData: makeInstallation(t, parent, 'spent-first', second.origin),
    token: spentMint.token,
    caPath: second.caPath,
  })()
  assert.equal(firstKey.code, 0, firstKey.stderr)
  const spentRefusal = await spawnCliChild(t, {
    pluginData: makeInstallation(t, parent, 'spent-second', second.origin),
    token: spentMint.token,
    caPath: second.caPath,
  })()
  assert.equal(spentRefusal.code, 1)
  assert.equal(jsonLines(spentRefusal.stderr)[0].code, 'invite_exhausted')

  // A third server for the burst row: the sixth rapid attempt from one
  // address answers the admission gate's coded refusal.
  const third = await startNativeTlsServer(t, parent)
  const burstPlugin = makeInstallation(t, parent, 'burst', third.origin)
  let lastBurst = null
  for (let attempt = 0; attempt < 6; attempt += 1) {
    lastBurst = await spawnCliChild(t, { pluginData: burstPlugin, token: wellFormedUnknownToken, caPath: third.caPath })()
    assert.equal(lastBurst.code, 1, lastBurst.stderr)
  }
  assert.equal(jsonLines(lastBurst.stderr)[0].code, 'rate_limited', 'the sixth rapid attempt is rate-limited')
})

// --- The structural scan (the 4.3 policy extends to the new surface) ---------------

test('no TLS-verification escape hatch exists in the new server-side surface', () => {
  for (const source of ['server/api/server.mjs', 'server/cli/remote-commands.mjs', 'server/cli/agent-room.mjs']) {
    const text = readFileSync(join(ROOT, source), 'utf8')
    assert.equal(text.includes('rejectUnauthorized'), false, `${source} must not contain rejectUnauthorized`)
    assert.equal(text.includes('NODE_TLS_REJECT_UNAUTHORIZED'), false, `${source} must not touch NODE_TLS_REJECT_UNAUTHORIZED`)
    assert.equal(text.includes('checkServerIdentity'), false, `${source} must not replace the hostname check`)
  }
})

// --- The guide pin (row 13; the 4.6 precedent) --------------------------------------

test('the deployment guide exists and names its required sections, pins, and shipped surface names', () => {
  const guidePath = join(ROOT, 'docs', 'self-hosting-deployment.md')
  assert.equal(existsSync(guidePath), true, 'docs/self-hosting-deployment.md is the AC deliverable')
  const guide = readFileSync(guidePath, 'utf8')
  for (const [name, pattern] of [
    ['Path A: the Caddy recipe', /## 3\. Path A — Caddy/],
    ['the Caddy 2.11.x series pin', /v2\.11\.x/],
    ['the concrete Caddy release pin', /v2\.11\.0/],
    ['the loopback-only plaintext rule', /only on loopback/],
    ['the MCP stdio spec revision pin (verbatim)', /2026-07-28/],
    ['the start boundary', /## 6\. The start boundary/],
    ['the start boundary success face', /runtime\.json/],
    ['certificate acquisition responsibility', /acquire the chain/],
    ['certificate renewal responsibility', /renew/],
    ['key permissions 0600', /0600/],
    ['restart with preserved enrollment', /## 7\. Restart with preserved enrollment/],
    ['proxy dial timeout ≥ 30 s', /dial_timeout 30s/],
    ['proxy response-header timeout ≥ 30 s', /response_header_timeout 60s/],
    ['the ≥ 30 s rule over the 20 s hold', /≥ 30 s/],
    ['no-secrets-in-logging', /## 10\. No secrets in logging/],
    ['the failure-mode appendix', /## 8\. Failure modes and recovery/],
    ['the failure-mode table shape', /Symptom \| Likely cause \| Recovery/],
    ['failure row: certificate issuance fails', /\*\*Certificate issuance fails\*\*/],
    ['failure row: port already bound', /Port already bound/],
    ['failure row: proxy unreachable', /\*\*Proxy unreachable\*\*/],
    ['failure row: enrollment rejected', /\*\*Enrollment rejected\*\*/],
    ['failure row: TLS handshake mismatch', /TLS handshake mismatch/],
    ['failure row: the data-dir advisory', /advisory: this server is about to bind a non-loopback host/],
    ['the per-path evidence checklist', /## 9\. The per-path evidence checklist/],
    ['the enrollment receipt artifact', /enrollment receipt/],
    ['the 20-second read capture artifact', /20-second read capture/],
    ['the dedicated data-dir rule', /one process, one realm, one data dir/],
    ['the AGENT_ROOM_HOST knob', /AGENT_ROOM_HOST/],
    ['the AGENT_ROOM_PORT knob', /AGENT_ROOM_PORT/],
    ['the AGENT_ROOM_TLS_CERT knob', /AGENT_ROOM_TLS_CERT/],
    ['the AGENT_ROOM_TLS_KEY knob', /AGENT_ROOM_TLS_KEY/],
    ['the AGENT_ROOM_DATA_DIR knob', /AGENT_ROOM_DATA_DIR/],
    ['the invite mint command', /agent-room invite mint/],
    ['the setup command', /agent-room setup/],
    ['the remote set command', /agent-room remote set/],
    ['the remote enroll command', /agent-room remote enroll/],
    ['the message_read tool', /message_read/],
    ['the read hold bound cited by name', /READ_HOLD_MAX_MS/],
    ['the honest automated-proof scope', /real TLS on loopback/],
  ]) {
    assert.match(guide, pattern, `the guide must name: ${name}`)
  }
})

// --- The README pins (row 14; AR-15) --------------------------------------------------

test('README carries the MCP spec-revision pin, the corrected Remote Mode reality, and the deployment-guide pointer', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8')
  // AR-15: wherever the MCP surface is described, the revision pin travels.
  assert.match(readme, /## Tools[\s\S]*?2026-07-28/, 'the MCP tool section carries the 2026-07-28 spec-revision pin')
  // The stale line is gone, corrected to the shipped Remote Mode reality.
  assert.equal(readme.includes('Remote and multi-host rooms'), false, 'the stale "not part of version 0.2" line is gone')
  assert.match(readme, /Remote Mode \(shipped, epic 4\)/)
  assert.match(readme, /agent-room remote set/)
  assert.match(readme, /agent-room remote enroll/)
  // The deployment guide is linked where an operator would look.
  assert.match(readme, /docs\/self-hosting-deployment\.md/)
  // The Caddy pin is made explicit beside the guide pointer too.
  assert.match(readme, /Caddy v2\.11\.x/)
})
