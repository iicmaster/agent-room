// Story 4.3 acceptance: the remote client & transport policy. The unit rows
// run the real config module and the real client factory in-process; the
// transport rows run real TLS servers in this process; the journey row runs a
// real child process (tests/remote-client-driver.mjs) over the real server
// code, a real TLS front, the real enrollment route, and the real api-client.
//
// HONEST SCOPE, stated up front: the happy-path journey needs a certificate
// the client's DEFAULT TLS verification trusts — no certificate-verification
// override exists anywhere in this tree, and tls.rootCertificates is frozen
// by design. The driver child is therefore spawned with NODE_EXTRA_CA_CERTS
// pointing at the test CA: Node's own documented mechanism for adding a
// private root WITHOUT touching verification strictness (chain and hostname
// checks stay fully on). The self-signed row proves the other half: a
// certificate OUTSIDE the trust store is refused by the same client code,
// no request is ever answered, and the source contains no bypass flag. The
// challenge/auth mechanics themselves are already proven over the loopback
// by tests/challenge-auth.test.mjs (4.1) and tests/invites.test.mjs (4.2);
// what this file adds is the configured-URL seam, the https-only policy, and
// the enrolled-reconnect property over real TLS.
//
// Matrix row → test map:
//    AC-1 'configured URL, https required, one server active' →
//         'the transport policy: https with a hostname is required...',
//         'the persisted config is one active server...',
//         'a self-signed certificate is refused by default verification...',
//         'remote set/show/clear: JSON lines, coded plaintext refusal...'
//    AC-2 'an enrolled key reconnects with no invite' →
//         'an enrolled key reconnects with no invite over verified TLS...'
//    (plus the Local-Mode-default guard and the option-over-config seam)

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto'
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import https from 'node:https'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { AgentRoomRuntimeError, atomicWriteJson } from '../server/runtime.mjs'
import {
  clearRemoteConfig,
  loadRemoteConfig,
  remoteConfigPath,
  saveRemoteConfig,
  validateRemoteServerUrl,
} from '../server/client/remote-config.mjs'
import { createAgentRoomClient } from '../server/client/api-client.mjs'
import { main } from '../server/cli/agent-room.mjs'
import { fingerprintFromPublicKey } from '../server/keys.mjs'
import { localTokenPath } from '../server/api/local-token.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RUNTIME_RECORD_FILENAME = 'runtime.json'

const sleep = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })

// --- Test-only PKI material ----------------------------------------------------
//
// Generated once with openssl for this suite (EC P-256, valid to 2126): a
// CA, a leaf with IP:127.0.0.1/DNS:localhost SANs (the driver's TLS front),
// and a standalone SELF-SIGNED certificate (the refusal row's front). All of
// it is throwaway test material — nothing here approaches production trust;
// the self-signed pair in particular exists to be refused.

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

function makeDirs(t, prefix = 'agent-room-remote-') {
  const parent = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const sharedData = join(parent, 'shared')
  const pluginData = join(parent, 'plugin-data')
  mkdirSync(sharedData, { recursive: true, mode: 0o700 })
  mkdirSync(pluginData, { recursive: true, mode: 0o700 })
  return { parent, sharedData, pluginData }
}

// One installation identity under its own plugin dir (the challenge-auth
// harness's shape): config.json plus a real 0600 keypair.
function makeInstallation(parent, name, chatId) {
  const pluginData = join(parent, name)
  mkdirSync(pluginData, { recursive: true, mode: 0o700 })
  atomicWriteJson(join(pluginData, 'config.json'), { chat_id: chatId })
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  writeFileSync(join(pluginData, 'identity.key'), pem, { mode: 0o600 })
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const raw = spki.subarray(spki.length - 32)
  return {
    pluginData,
    chatId,
    raw,
    publicKey: raw.toString('base64url'),
    fingerprint: fingerprintFromPublicKey(raw),
    keyPath: join(pluginData, 'identity.key'),
  }
}

// A real agent-room server child on the shared data dir (the Local-Mode
// default row attaches to it; no client ever boots its own server here).
function spawnServerChild(t, dataDir) {
  const SERVER_ENTRY = join(ROOT, 'server', 'api', 'server.mjs')
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, AGENT_ROOM_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const runtimePath = join(dataDir, RUNTIME_RECORD_FILENAME)
  const waitReady = async () => {
    const deadline = Date.now() + 10 * 1000
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('server child exited early')
      if (existsSync(runtimePath)) {
        try {
          const record = JSON.parse(readFileSync(runtimePath, 'utf8'))
          if (Number.isInteger(record.port) && record.port > 0) return record
        } catch { /* atomic rename: readers retry */ }
      }
      if (Date.now() > deadline) throw new Error('server child never became ready')
      await sleep(25)
    }
  }
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit').catch(() => {})
    }
  })
  return { waitReady }
}

// A real TLS server presenting the given certificate. Counts HANDSHAKE
// ATTEMPTS (tlsClientError — a refusal reaches the socket layer even though
// no HTTP request completes) and completed HTTP requests (expected: zero
// when the client refuses the certificate).
async function startTlsFront(t, certPem, keyPem) {
  const state = { handshakeAttempts: 0, completedRequests: 0 }
  const server = https.createServer({ cert: certPem, key: keyPem }, (request, response) => {
    state.completedRequests += 1
    request.resume()
    response.destroy()
  })
  server.on('tlsClientError', () => { state.handshakeAttempts += 1 })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise(resolve => server.close(() => resolve())))
  return { server, state, port: server.address().port }
}

// The CLI runs IN-PROCESS through the real dispatch with injected streams
// and directories (the cli-surface harness, reduced to what this file needs).
async function runCli({ sharedData, pluginData }, argv) {
  const input = new PassThrough()
  const output = new PassThrough()
  const errorOutput = new PassThrough()
  output.setEncoding('utf8')
  errorOutput.setEncoding('utf8')
  let stdout = ''
  let stderr = ''
  output.on('data', chunk => { stdout += chunk })
  errorOutput.on('data', chunk => { stderr += chunk })
  const previousExitCode = process.exitCode
  process.exitCode = undefined
  try {
    const outcome = await main(argv, { input, output, errorOutput, sharedDataDir: sharedData, pluginDataDir: pluginData })
    await sleep(10)
    return { outcome, stdout, stderr, exitCode: process.exitCode ?? 0 }
  } finally {
    process.exitCode = previousExitCode
  }
}

const jsonLines = text => text.trim().split('\n').filter(line => line.length > 0).map(line => JSON.parse(line))

// --- The transport policy (AC-1) ------------------------------------------------

test('the transport policy: https with a hostname is required, plaintext and non-origin URLs are refused naming the scheme', () => {
  // The validator: every refusal is a coded invalid_request; a scheme
  // violation NAMES the refused scheme; https origins pass and normalize.
  assert.equal(validateRemoteServerUrl('https://room.example.com'), 'https://room.example.com')
  assert.equal(validateRemoteServerUrl('https://EXAMPLE.com:8443/'), 'https://example.com:8443')
  assert.equal(validateRemoteServerUrl('  https://room.example.com  '), 'https://room.example.com')

  const refusals = [
    ['http://room.example.com', /http/],
    ['ftp://files.example.com', /ftp/],
    ['ws://socket.example.com', /ws/],
    ['//room.example.com', null],
    ['room.example.com', null],
    ['garbage', null],
    ['', null],
    ['   ', null],
    ['https:///', null],
    ['https://room.example.com/subpath', /no path|subpath|origin/],
    ['https://room.example.com/?x=1', /query/],
    ['https://room.example.com/#frag', /fragment/],
    ['https://user:pass@room.example.com', /credentials/],
  ]
  for (const [input, expectedPattern] of refusals) {
    try {
      validateRemoteServerUrl(input)
      assert.fail(`expected a coded refusal for ${JSON.stringify(input)}`)
    } catch (error) {
      assert.ok(error instanceof AgentRoomRuntimeError, String(input))
      assert.equal(error.code, 'invalid_request', String(input))
      if (expectedPattern !== null) assert.match(error.message, expectedPattern, String(input))
    }
  }
  // The plaintext refusal names the scheme explicitly — the AC's letter.
  assert.throws(() => validateRemoteServerUrl('http://room.example.com'),
    error => error.code === 'invalid_request' && error.message.includes('http'))
})

test('the persisted config is one active server: atomic 0600 file, replacement, re-validation on read, and inert realm state', t => {
  const { pluginData } = makeDirs(t)

  // Unset: null — the Local Mode default (FR-1), never a guess.
  assert.equal(loadRemoteConfig(pluginData), null)

  const first = saveRemoteConfig(pluginData, { serverUrl: 'https://room.example.com' })
  assert.equal(first.serverUrl, 'https://room.example.com')
  const info = lstatSync(first.path)
  assert.ok(info.isFile() && !info.isSymbolicLink(), 'the config is a regular file, never a symlink')
  assert.equal(info.mode & 0o777, 0o600, 'the config file is 0600')
  const loaded = loadRemoteConfig(pluginData)
  assert.equal(loaded.serverUrl, 'https://room.example.com')
  assert.ok(typeof loaded.setAt === 'string' && Number.isFinite(Date.parse(loaded.setAt)))

  // The stored shape carries exactly one server origin.
  const onDisk = JSON.parse(readFileSync(first.path, 'utf8'))
  assert.deepEqual(Object.keys(onDisk).sort(), ['server_url', 'set_at'])
  assert.equal(onDisk.server_url, 'https://room.example.com')

  // Per-realm state from a previous server is deliberately untouched by a
  // replacement: it stays on disk under its realm id, inert (AD-14/D13 — a
  // different server is a different realm with fresh trust).
  const realmDir = join(pluginData, 'realms', '01234567-89ab-cdef-0123-456789abcdef')
  mkdirSync(realmDir, { recursive: true, mode: 0o700 })
  atomicWriteJson(join(realmDir, 'allowlist.json'), { version: 1, accept_all: false, entries: [{ fingerprint: `sha256:${'ab'.repeat(32)}`, added_at: '2026-09-29T00:00:00.000Z' }] })
  const realmBefore = readFileSync(join(realmDir, 'allowlist.json'))

  // Setting again REPLACES: one active server at a time, and the old origin
  // is gone from the file.
  const second = saveRemoteConfig(pluginData, { serverUrl: 'https://other.example.com:8443' })
  assert.equal(second.serverUrl, 'https://other.example.com:8443')
  const replaced = JSON.parse(readFileSync(second.path, 'utf8'))
  assert.deepEqual(Object.keys(replaced).sort(), ['server_url', 'set_at'])
  assert.equal(replaced.server_url, 'https://other.example.com:8443')
  assert.equal(loadRemoteConfig(pluginData).serverUrl, 'https://other.example.com:8443')
  assert.ok(readFileSync(join(realmDir, 'allowlist.json')).equals(realmBefore), 'the old realm state is untouched (inert, not deleted)')

  // A read NEVER trusts a hand-edited file: plaintext stored by hand refuses
  // exactly like a freshly typed one — before any client can act on it.
  const configPath = remoteConfigPath(pluginData)
  atomicWriteJson(configPath, { server_url: 'http://sneaky.example.com', set_at: new Date().toISOString() })
  assert.throws(() => loadRemoteConfig(pluginData),
    error => error.code === 'invalid_request' && error.message.includes('http://sneaky.example.com') === false && /https/.test(error.message))
  // A corrupt file refuses instead of silently falling back to local.
  writeFileSync(configPath, '{not json', { mode: 0o600 })
  assert.throws(() => loadRemoteConfig(pluginData), error => error.code === 'invalid_request' && /unusable/.test(error.message))
  atomicWriteJson(configPath, { set_at: new Date().toISOString() })
  assert.throws(() => loadRemoteConfig(pluginData), error => error.code === 'invalid_request' && /server_url/.test(error.message))

  // Clear is idempotent and reports what happened.
  assert.equal(clearRemoteConfig(pluginData), true)
  assert.equal(clearRemoteConfig(pluginData), false)
  assert.equal(loadRemoteConfig(pluginData), null)
})

test('a self-signed certificate is refused by default verification: no request is ever answered and no bypass flag exists', async t => {
  const parent = makeDirs(t, 'agent-room-remote-tls-')
  const identity = makeInstallation(parent.parent, 'inst', 'Refused')
  const front = await startTlsFront(t, TEST_SELF_SIGNED_CERT, TEST_SELF_SIGNED_KEY)

  // The configured origin is https and the hostname matches the certificate's
  // SAN — the ONLY thing wrong is that the certificate is self-signed and
  // therefore outside Node's default trust store.
  saveRemoteConfig(identity.pluginData, { serverUrl: `https://127.0.0.1:${front.port}` })
  const client = createAgentRoomClient({ dataDir: parent.sharedData, pluginDataDir: identity.pluginData })
  assert.equal(client.transport, 'remote', 'a configured remote origin pins the fail-closed pre-auth mark')

  await assert.rejects(
    () => client.presence(),
    error => {
      assert.ok(error instanceof AgentRoomRuntimeError)
      assert.equal(error.code, 'request_failed')
      assert.equal(error.outcomeUnknown, true, 'no response ever arrived')
      assert.match(String(error.transportCode ?? ''), /CERT|TLS/, `a TLS refusal code travels: ${error.transportCode}`)
      assert.match(error.message, /cert/i, error.message)
      return true
    },
  )
  // The refusal is terminal, not a reconnect trigger: the tool call ended
  // (this assertion having returned) and the server answered NOTHING — a
  // client with a verification bypass would have completed a request here.
  // The handshake-attempt count settles after the client's own rejection
  // (the server learns of the aborted handshake a beat later).
  await sleep(100)
  assert.equal(front.state.completedRequests, 0)
  assert.ok(front.state.handshakeAttempts >= 1, 'the TLS handshake was attempted and refused')
  assert.notEqual(client.transport, 'local', 'a failed remote client never reads as local')

  // The direct-option form refuses identically.
  const optionClient = createAgentRoomClient({
    dataDir: parent.sharedData,
    pluginDataDir: identity.pluginData,
    serverUrl: `https://127.0.0.1:${front.port}`,
  })
  await assert.rejects(() => optionClient.presence(), error => error.outcomeUnknown === true && /CERT|TLS/.test(String(error.transportCode)))
  await sleep(100)
  assert.equal(front.state.completedRequests, 0, 'still zero answered requests')

  // Structural pin: the transport policy has no escape hatch anywhere in the
  // client tree — no verification override, no env opt-out honored by our code.
  for (const source of ['server/client/api-client.mjs', 'server/client/remote-config.mjs']) {
    const text = readFileSync(join(ROOT, source), 'utf8')
    assert.equal(text.includes('rejectUnauthorized'), false, `${source} must not contain rejectUnauthorized`)
    assert.equal(text.includes('NODE_TLS_REJECT_UNAUTHORIZED'), false, `${source} must not touch NODE_TLS_REJECT_UNAUTHORIZED`)
    assert.equal(text.includes('checkServerIdentity'), false, `${source} must not replace the hostname check`)
  }
})

test('plaintext remote is refused before any wire work: the option form throws and a hand-set http config refuses the client', async t => {
  const parent = makeDirs(t, 'agent-room-remote-plain-')
  const identity = makeInstallation(parent.parent, 'inst', 'Plaintext')

  // Option form: the refusal happens at construction — before any request
  // can exist — naming the refused scheme.
  assert.throws(
    () => createAgentRoomClient({ pluginDataDir: identity.pluginData, serverUrl: 'http://room.example.com' }),
    error => error instanceof AgentRoomRuntimeError && error.code === 'invalid_request' && error.message.includes('http'),
  )
  assert.throws(
    () => createAgentRoomClient({ pluginDataDir: identity.pluginData, serverUrl: 'ftp://room.example.com' }),
    error => error.code === 'invalid_request' && error.message.includes('ftp'),
  )

  // Config form: a hand-written plaintext file refuses the client's
  // construction too — the stored URL is re-validated on every load.
  atomicWriteJson(remoteConfigPath(identity.pluginData), { server_url: 'http://room.example.com', set_at: new Date().toISOString() })
  assert.throws(
    () => createAgentRoomClient({ dataDir: parent.sharedData, pluginDataDir: identity.pluginData }),
    error => error instanceof AgentRoomRuntimeError && error.code === 'invalid_request' && error.message.includes('http'),
  )
})

test('an explicit serverUrl option wins over a persisted config for that instance', async t => {
  const parent = makeDirs(t, 'agent-room-remote-opt-')
  const identity = makeInstallation(parent.parent, 'inst', 'OptionWins')
  // Two refused fronts: the persisted config points at front A, the explicit
  // option at front B. The option must win — observable by WHICH front sees
  // the (refused) handshake attempt.
  const frontA = await startTlsFront(t, TEST_SELF_SIGNED_CERT, TEST_SELF_SIGNED_KEY)
  const frontB = await startTlsFront(t, TEST_SELF_SIGNED_CERT, TEST_SELF_SIGNED_KEY)
  saveRemoteConfig(identity.pluginData, { serverUrl: `https://127.0.0.1:${frontA.port}` })

  const client = createAgentRoomClient({
    dataDir: parent.sharedData,
    pluginDataDir: identity.pluginData,
    serverUrl: `https://127.0.0.1:${frontB.port}`,
  })
  await assert.rejects(() => client.presence(), error => error.outcomeUnknown === true && /CERT|TLS/.test(String(error.transportCode)))
  await sleep(100)
  assert.ok(frontB.state.handshakeAttempts >= 1, 'the option origin was the one contacted')
  assert.equal(frontA.state.handshakeAttempts, 0, 'the persisted config was not consulted for this instance')
})

// --- The CLI family (AC-1's human surface) ---------------------------------------

test('remote set/show/clear: JSON lines, coded plaintext refusal, usage arity, and the help grammar', async t => {
  const world = makeDirs(t, 'agent-room-remote-cli-')

  const unset = await runCli(world, ['remote', 'show'])
  assert.equal(unset.exitCode, 0, unset.stderr)
  assert.deepEqual(jsonLines(unset.stdout), [{ ok: true, command: 'remote show', mode: 'local', server_url: null }])

  const set = await runCli(world, ['remote', 'set', 'https://room.example.com'])
  assert.equal(set.exitCode, 0, set.stderr)
  const [setLine] = jsonLines(set.stdout)
  assert.equal(setLine.ok, true)
  assert.equal(setLine.command, 'remote set')
  assert.equal(setLine.mode, 'remote')
  assert.equal(setLine.server_url, 'https://room.example.com')
  assert.equal(setLine.previous_server_url, null)
  assert.equal(lstatSync(remoteConfigPath(world.pluginData)).mode & 0o777, 0o600)

  const shown = await runCli(world, ['remote', 'show'])
  assert.equal(shown.exitCode, 0, shown.stderr)
  assert.deepEqual(jsonLines(shown.stdout), [{ ok: true, command: 'remote show', mode: 'remote', server_url: 'https://room.example.com', set_at: setLine.set_at }])

  // One active server: the replacement is reported, the file holds one origin.
  const replaced = await runCli(world, ['remote', 'set', 'https://other.example.com:8443'])
  assert.equal(replaced.exitCode, 0, replaced.stderr)
  assert.equal(jsonLines(replaced.stdout)[0].previous_server_url, 'https://room.example.com')
  assert.equal(loadRemoteConfig(world.pluginData).serverUrl, 'https://other.example.com:8443')

  // The transport-policy refusal: exit 1, ONE coded JSON line on stderr,
  // naming the refused scheme — and nothing stored.
  for (const [url, scheme] of [['http://plain.example.com', 'http'], ['ftp://plain.example.com', 'ftp']]) {
    const refused = await runCli(world, ['remote', 'set', url])
    assert.equal(refused.exitCode, 1, refused.stderr)
    assert.equal(refused.stdout, '')
    const [errorLine] = jsonLines(refused.stderr)
    assert.equal(errorLine.ok, false)
    assert.equal(errorLine.code, 'invalid_request')
    assert.match(errorLine.message, new RegExp(scheme))
    assert.equal(jsonLines(refused.stderr).length, 1, 'exactly one refusal line')
  }
  assert.equal(loadRemoteConfig(world.pluginData).serverUrl, 'https://other.example.com:8443', 'the refusals changed nothing')

  // Usage grammar: missing argument, extra argument, unknown flag, unknown
  // subcommand — exit 2, one JSON usage line.
  for (const argv of [
    ['remote', 'set'],
    ['remote', 'set', 'https://a.example.com', 'extra'],
    ['remote', 'set', '--junk'],
    ['remote', 'show', 'extra'],
    ['remote', 'clear', 'extra'],
    ['remote', 'bogus'],
  ]) {
    const usage = await runCli(world, argv)
    assert.equal(usage.exitCode, 2, `${JSON.stringify(argv)}: ${usage.stderr}`)
    const [usageLine] = jsonLines(usage.stderr)
    assert.equal(usageLine.ok, false)
    assert.equal(usageLine.code, 'usage', JSON.stringify(argv))
  }

  const cleared = await runCli(world, ['remote', 'clear'])
  assert.equal(cleared.exitCode, 0, cleared.stderr)
  assert.deepEqual(jsonLines(cleared.stdout), [{ ok: true, command: 'remote clear', mode: 'local', removed: true }])
  const clearedAgain = await runCli(world, ['remote', 'clear'])
  assert.equal(clearedAgain.exitCode, 0, clearedAgain.stderr)
  assert.equal(jsonLines(clearedAgain.stdout)[0].removed, false, 'clearing an unset configuration is a successful no-op')
  assert.deepEqual(jsonLines((await runCli(world, ['remote', 'show'])).stdout), [{ ok: true, command: 'remote show', mode: 'local', server_url: null }])

  // The help carries the remote grammar.
  const help = await runCli(world, ['help'])
  assert.equal(help.exitCode, 0, help.stderr)
  for (const fragment of ['agent-room remote set <https-url>', 'agent-room remote show', 'agent-room remote clear']) {
    assert.ok(help.stdout.replace(/\s+/g, ' ').includes(fragment), fragment)
  }
})

// --- The journey (AC-2): enrolled reconnect needs no invite, over real TLS -------

test('an enrolled key reconnects with no invite over verified TLS: client restarts and a server restart behind the same URL both re-auth through the challenge lane', async t => {
  const parent = makeDirs(t, 'agent-room-remote-journey-')
  const dataDir = parent.sharedData
  const pluginData = join(parent.parent, 'journey-plugin')
  const certsDir = join(parent.parent, 'certs')
  mkdirSync(certsDir, { recursive: true, mode: 0o700 })
  const caPath = join(certsDir, 'test-ca.pem')
  const certPath = join(certsDir, 'leaf-cert.pem')
  const keyPath = join(certsDir, 'leaf-key.pem')
  writeFileSync(caPath, TEST_CA_CERT, { mode: 0o600 })
  writeFileSync(certPath, TEST_LEAF_CERT, { mode: 0o600 })
  writeFileSync(keyPath, TEST_LEAF_KEY, { mode: 0o600 })

  // The driver child: NODE_EXTRA_CA_CERTS adds the test root through Node's
  // own mechanism — chain and hostname verification stay fully on (see the
  // file header's honest-scope note and the self-signed refusal row).
  const child = spawn(process.execPath, [join(ROOT, 'tests', 'remote-client-driver.mjs')], {
    env: {
      PATH: process.env.PATH || '',
      LANG: process.env.LANG || 'C.UTF-8',
      NODE_EXTRA_CA_CERTS: caPath,
      AGENT_ROOM_DRIVER_DATA_DIR: dataDir,
      AGENT_ROOM_DRIVER_PLUGIN_DATA: pluginData,
      AGENT_ROOM_DRIVER_CERT: certPath,
      AGENT_ROOM_DRIVER_KEY: keyPath,
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

  const reportLine = stdout.split('\n').find(line => line.startsWith('REPORT:'))
  assert.ok(reportLine, `no REPORT line in the driver stdout:\n${stdout}`)
  const report = JSON.parse(reportLine.slice('REPORT:'.length))

  // The journey itself: three authentications (first connect, fresh-client
  // reconnect after a restart, 401 re-auth when the server restarts behind
  // the same URL), each through the challenge lane.
  assert.deepEqual(report.transports, ['remote', 'remote', 'remote'])
  assert.equal(report.realmId1, report.realmId2, 'the restarted backend is the same realm (durable enrollment)')
  assert.equal(report.onlineMcpRow, true, 'the enrolled key is present with the closed-set mcp client type')
  assert.equal(report.presence2bSelfRow, true, 'the re-authenticated session re-bound its Chat ID')
  assert.equal(report.fingerprint, fingerprintFromPublicKey(makeInstallationKeyRaw(pluginData)), 'the journey ran under the journey installation key')

  // AC-2's letter: the enrollment happened ONCE (before the client phase);
  // across every subsequent reconnect — on the full path, client leg AND
  // loopback proxy hop — no invite token and no enrollment request ever
  // appeared, and the local token was never presented either.
  assert.equal(report.counts.enrollRequests, 0)
  assert.equal(report.counts.localAuthRequests, 0)
  assert.equal(report.counts.inviteTokenFieldOccurrences, 0)
  assert.equal(report.counts.rawTokenOccurrences, 0)
  assert.equal(report.counts.challengeRequests, 4, 'three authentications plus the stranger gate: one challenge each')
  assert.equal(report.counts.answerRequests, 4)

  // The stranger gate, over the same configured origin: a never-enrolled
  // installation surfaces the coded, actionable refusal — the invite flow is
  // the operator's; the client never enrolls itself.
  assert.equal(report.notEnrolled.code, 'not_enrolled')
  assert.equal(report.notEnrolled.actionable, true, 'the refusal tells the human how to enroll')
})

// The journey's key material lives in the driver-created plugin dir; the raw
// public key is recovered from the key file the same way the keys module does.
function makeInstallationKeyRaw(pluginData) {
  const spki = createPublicKey(createPrivateKey(readFileSync(join(pluginData, 'identity.key'), 'utf8'))).export({ type: 'spki', format: 'der' })
  return spki.subarray(spki.length - 32)
}

// --- The default stays Local Mode (FR-1) ------------------------------------------

test('without a remote config the client stays on the Local Mode loopback path', async t => {
  const { parent, sharedData } = makeDirs(t, 'agent-room-remote-local-default-')
  const identity = makeInstallation(parent, 'local-default', 'LocalDefault')
  const { waitReady } = spawnServerChild(t, sharedData)
  await waitReady()
  assert.equal(existsSync(remoteConfigPath(identity.pluginData)), false)

  const client = createAgentRoomClient({ dataDir: sharedData, pluginDataDir: identity.pluginData })
  const presence = await client.presence()
  assert.equal(client.transport, 'local', 'the earned local mark — the bootstrap path is unchanged')
  assert.ok(Array.isArray(presence.online))
  // And the Local Mode credential machinery is intact: the local token file
  // exists beside the runtime record where the local exchange needs it.
  assert.equal(existsSync(localTokenPath(sharedData)), true)
})
