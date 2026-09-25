// Story 1.4 acceptance: the local credential path. Registry rows run
// in-process (issuer/verifier pair, sliding TTL with an injected clock — the
// 12 h duration is provisional per DR-2, ratified at Story 4.1); the matrix
// rows spawn the real server child (node:test with real child processes) and
// exercise POST /api/auth/local and the class boundaries end to end: the
// 0600 token file exchange bound to the installation's public key, the
// HTTP path's read-only file discipline, rejections with zero state change,
// restart invalidation, and the credential-class separations (the local
// token is never a session; session tokens never cross to viewer routes; no
// credential ever reaches logs or stderr).

import assert from 'node:assert/strict'
import { createHash, generateKeyPairSync } from 'node:crypto'
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  LOCAL_TOKEN_MAX_BYTES,
  PUBLIC_ERRORS,
  SESSION_TOKEN_MAX_CHARS,
  SESSION_TTL_MS,
} from '../server/constants.mjs'
import { loadOrCreateLocalToken, readLocalToken, localTokenPath } from '../server/api/local-token.mjs'
import {
  bearerTokenFromHeaders,
  createSessionRegistry,
  createSessionVerifier,
} from '../server/api/session.mjs'
import { fingerprintFromPublicKey } from '../server/keys.mjs'
import { startServer, registerHandler } from '../server/api/server.mjs'
import { ROOM_LOG_DATABASE_FILENAME } from '../server/store/room-log.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = join(ROOT, 'server', 'api', 'server.mjs')
const RUNTIME_RECORD_FILENAME = 'runtime.json'
const PROTOCOL_KEY = 'agent-room-protocol'
const LOCAL_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/

const sleep = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })

// One installation identity: a real Ed25519 keypair, presented the way the
// 1.1-born client presents it — the raw 32-byte public key, base64url.
function installation() {
  const { publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const raw = spki.subarray(spki.length - 32)
  return {
    raw,
    publicKey: raw.toString('base64url'),
    fingerprint: fingerprintFromPublicKey(raw),
  }
}

function makeDataDir(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-local-auth-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  return dataDir
}

function spawnServerChild(t, dataDir) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, AGENT_ROOM_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stderrChunks = []
  child.stderr.on('data', chunk => stderrChunks.push(chunk))
  const stderrText = () => Buffer.concat(stderrChunks).toString('utf8')
  const runtimePath = join(dataDir, RUNTIME_RECORD_FILENAME)

  const waitReady = async () => {
    const deadline = Date.now() + 10 * 1000
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`server child exited early (code=${child.exitCode}); stderr: ${stderrText()}`)
      }
      if (existsSync(runtimePath)) {
        try {
          const record = JSON.parse(readFileSync(runtimePath, 'utf8'))
          if (Number.isInteger(record.port) && record.port > 0) return record
        } catch {
          // Atomic rename means readers never see partial files; retry anyway.
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`server child never wrote runtime.json; stderr: ${stderrText()}`)
      }
      await sleep(25)
    }
  }

  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    await once(child, 'exit')
  }

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit').catch(() => {})
    }
  })

  return { child, waitReady, stop, stderrText }
}

// Small direct HTTP client: no keep-alive, so killed children never leave
// pooled sockets behind between tests.
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
          resolvePromise({
            status: response.statusCode,
            headers: response.headers,
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

// State fingerprint across every file the local path owns: the store, the
// token file, and the runtime record. Rejections must leave all three
// byte-identical.
function hashState(dataDir) {
  return [
    join(dataDir, ROOM_LOG_DATABASE_FILENAME),
    join(dataDir, `${ROOM_LOG_DATABASE_FILENAME}-wal`),
    localTokenPath(dataDir),
    join(dataDir, RUNTIME_RECORD_FILENAME),
  ]
    .filter(existsSync)
    .map(path => `${path}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`)
    .join(',')
}

// Captures process.stderr writes around an async body.
async function captureStderr(body) {
  const original = process.stderr.write.bind(process.stderr)
  const chunks = []
  process.stderr.write = (chunk, ...rest) => {
    chunks.push(String(chunk))
    return original(chunk, ...rest)
  }
  try {
    return { result: await body(), chunks }
  } finally {
    process.stderr.write = original
  }
}

// The canonical exchange against a running server.
function exchange(port, installation_, localToken) {
  return request(port, 'POST', '/api/auth/local', {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${localToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ public_key: installation_.publicKey }),
  })
}

// --- Session registry rows (in-process) ----------------------------------------

test('the registry issues 256-bit base64url tokens and resolves them to the actor fingerprint', () => {
  const fingerprint = `sha256:${'a'.repeat(64)}`
  const registry = createSessionRegistry({ ttlMs: 60_000 })
  const first = registry.issue(fingerprint)
  const second = registry.issue(fingerprint)
  assert.match(first, SESSION_TOKEN_PATTERN)
  assert.match(second, SESSION_TOKEN_PATTERN)
  assert.notEqual(first, second, 'every issue mints a fresh token')
  assert.deepEqual(registry.verify(first), { actorFingerprint: fingerprint })
  assert.deepEqual(registry.verify(second), { actorFingerprint: fingerprint })
  // A principal is a plain object, never a rejection envelope.
  assert.equal(registry.verify(first).ok, undefined)
  // The local token file is never a session: an unknown credential is refused.
  const rejection = registry.verify('not-a-session-token')
  assert.equal(rejection.ok, false)
  assert.equal(rejection.code, 'unauthorized')
})

test('the registry rejects malformed and oversized presented credentials', () => {
  const registry = createSessionRegistry({ ttlMs: 60_000 })
  for (const bad of ['', '   ', 'x'.repeat(SESSION_TOKEN_MAX_CHARS + 1), null, 42, {}, ['array']]) {
    const outcome = registry.verify(bad)
    assert.equal(outcome.ok, false, String(bad))
    assert.equal(outcome.code, 'unauthorized')
    assert.equal(outcome.status, 401)
  }
})

test('registry issue requires a canonical actor fingerprint', () => {
  const registry = createSessionRegistry({ ttlMs: 60_000 })
  for (const bad of ['', 'not-a-fingerprint', 'sha256:xyz', `sha256:${'A'.repeat(64)}`, `sha256:${'a'.repeat(63)}`, 42, null]) {
    assert.throws(() => registry.issue(bad), error => error?.code === 'invalid_argument', String(bad))
  }
})

test('issue lazily sweeps expired sessions so idle expiry never grows the map', () => {
  let now = 1_000_000
  const clock = () => now
  const registry = createSessionRegistry({ ttlMs: 1_000, now: clock, maxSessions: 5 })
  const shortLived = registry.issue(`sha256:${'1'.repeat(64)}`)
  const survivor = registry.issue(`sha256:${'2'.repeat(64)}`)
  now += 2_000 // both expired
  registry.issue(`sha256:${'3'.repeat(64)}`) // sweep runs here
  assert.equal(registry.verify(shortLived).ok, false, 'the expired session was swept')
  assert.equal(registry.verify(survivor).ok, false, 'the expired session was swept')
  assert.equal(registry.verify(registry.issue(`sha256:${'4'.repeat(64)}`)).ok, undefined)
})

test('capacity evicts oldest-expired-then-oldest and keeps live sessions bounded', () => {
  let now = 1_000_000
  const clock = () => now
  const registry = createSessionRegistry({ ttlMs: 1_000, now: clock, maxSessions: 2 })
  const first = registry.issue(`sha256:${'1'.repeat(64)}`) // expires at 1_001_000

  now += 500
  const second = registry.issue(`sha256:${'2'.repeat(64)}`) // expires at 1_001_500

  // first is expired, second is live: a third issue sweeps first and must
  // NOT evict the live older session second.
  now += 600
  const third = registry.issue(`sha256:${'3'.repeat(64)}`)
  assert.equal(registry.verify(first).ok, false, 'the expired session was swept')
  assert.ok(registry.verify(second).actorFingerprint, 'the older live session survived')
  assert.ok(registry.verify(third).actorFingerprint)

  // All live at capacity: the oldest (insertion order) is evicted.
  const fourth = registry.issue(`sha256:${'4'.repeat(64)}`)
  assert.equal(registry.verify(second).ok, false, 'the oldest live session was evicted')
  assert.ok(registry.verify(third).actorFingerprint)
  assert.ok(registry.verify(fourth).actorFingerprint)
})

test('the session TTL is sliding: activity refreshes, idleness expires and clears', () => {
  const ttlMs = 1_000
  let now = 1_000_000
  const clock = () => now
  const registry = createSessionRegistry({ ttlMs, now: clock })
  const token = registry.issue(`sha256:${'b'.repeat(64)}`)

  now += 600
  assert.ok(registry.verify(token).actorFingerprint, 'inside the first window')
  // Without the refresh this verify would be past the original expiry.
  now += 800
  assert.ok(registry.verify(token).actorFingerprint, 'activity slid the expiry')

  now += ttlMs
  const expired = registry.verify(token)
  assert.equal(expired.ok, false)
  assert.equal(expired.code, 'unauthorized')
  assert.equal(registry.verify(token).ok, false, 'the expired session was removed')
})

test('the default TTL is the 12 h sliding window (provisional per DR-2, ratified at Story 4.1)', () => {
  let now = 0
  const registry = createSessionRegistry({ now: () => now })
  const token = registry.issue(`sha256:${'c'.repeat(64)}`)
  now = SESSION_TTL_MS - 1
  assert.ok(registry.verify(token).actorFingerprint, 'valid to the last millisecond')
  // The verify above slid the expiry one full default window forward.
  now = (SESSION_TTL_MS - 1) + SESSION_TTL_MS
  assert.equal(registry.verify(token).ok, false)
  assert.equal(registry.verify(token).ok, false, 'the expired session was removed')
})

test('createSessionRegistry and createSessionVerifier validate their wiring', () => {
  assert.throws(() => createSessionRegistry({ ttlMs: 0 }), /ttlMs/)
  assert.throws(() => createSessionRegistry({ ttlMs: -1 }), /ttlMs/)
  assert.throws(() => createSessionRegistry({ now: 'nope' }), /now/)
  assert.throws(() => createSessionRegistry({ maxSessions: 0 }), /maxSessions/)
  assert.throws(() => createSessionVerifier({}), /registry/)
  assert.throws(() => createSessionVerifier({ registry: { issue: () => {} } }), /registry/)
})

test('bearer parsing is strict about scheme, credential, and length cap', () => {
  assert.equal(bearerTokenFromHeaders({ authorization: 'Bearer abc-1_2' }), 'abc-1_2')
  assert.equal(bearerTokenFromHeaders({ authorization: 'bearer abc' }), 'abc')
  assert.equal(bearerTokenFromHeaders({ authorization: 'Bearer  spaced  ' }), 'spaced')
  assert.equal(bearerTokenFromHeaders({ authorization: 'Basic abc' }), null)
  assert.equal(bearerTokenFromHeaders({ authorization: 'Bearer' }), null)
  assert.equal(bearerTokenFromHeaders({ authorization: '' }), null)
  assert.equal(bearerTokenFromHeaders({}), null)
  assert.equal(bearerTokenFromHeaders({ authorization: ['Bearer first', 'Bearer second'] }), 'first')
  // Over the token bound: rejected before any comparison work.
  assert.equal(bearerTokenFromHeaders({ authorization: `Bearer ${'x'.repeat(SESSION_TOKEN_MAX_CHARS + 1)}` }), null)
  assert.equal(bearerTokenFromHeaders({ authorization: `Bearer ${'x'.repeat(SESSION_TOKEN_MAX_CHARS)}` }), 'x'.repeat(SESSION_TOKEN_MAX_CHARS))
})

// --- Live server matrix rows (real child processes) ------------------------------

test('POST /api/auth/local binds the session to the installation public key', async t => {
  const dataDir = makeDataDir(t)
  const { child, waitReady, stop, stderrText } = spawnServerChild(t, dataDir)
  const record = await waitReady()

  // The client side of the local path: the 0600 shared token file.
  const localToken = loadOrCreateLocalToken(dataDir)
  assert.match(localToken, LOCAL_TOKEN_PATTERN)
  assert.equal(lstatSync(localTokenPath(dataDir)).mode & 0o777, 0o600)

  const identity = installation()
  const auth = await exchange(record.port, identity, localToken)
  assert.equal(auth.status, 200)
  assert.equal(auth.json().ok, true)
  assert.deepEqual(Object.keys(auth.json().result), ['session_token'])
  const sessionToken = auth.json().result.session_token
  assert.match(sessionToken, SESSION_TOKEN_PATTERN)
  assert.equal(auth.headers[PROTOCOL_KEY], '1')

  // The session resolves only inside the server's own registry; a fresh
  // registry knows nothing of it.
  assert.equal(createSessionRegistry({ ttlMs: 60_000 }).verify(sessionToken).ok, false)

  // Every exchange mints a fresh session for the same key.
  const again = await exchange(record.port, identity, localToken)
  assert.equal(again.status, 200)
  assert.notEqual(again.json().result.session_token, sessionToken)

  // No credential ever reaches logs or stderr.
  const stderr = stderrText()
  assert.equal(stderr.includes(localToken), false)
  assert.equal(stderr.includes(sessionToken), false)
  assert.equal(stderr.includes(identity.publicKey), false)

  await stop()
  assert.equal(child.exitCode, 0)
})

test('sessions bind the installation key: distinct keys, distinct simultaneous actors', async t => {
  const dataDir = makeDataDir(t)
  const registry = createSessionRegistry()
  const server = await startServer({ dataDir, sessionRegistry: registry })
  try {
    const localToken = loadOrCreateLocalToken(dataDir)
    const alice = installation()
    const bob = installation()

    const aliceAuth = await exchange(server.port, alice, localToken)
    const bobAuth = await exchange(server.port, bob, localToken)
    assert.equal(aliceAuth.status, 200)
    assert.equal(bobAuth.status, 200)

    const alicePrincipal = registry.verify(aliceAuth.json().result.session_token)
    const bobPrincipal = registry.verify(bobAuth.json().result.session_token)
    assert.deepEqual(alicePrincipal, { actorFingerprint: alice.fingerprint })
    assert.deepEqual(bobPrincipal, { actorFingerprint: bob.fingerprint })
    assert.notEqual(alicePrincipal.actorFingerprint, bobPrincipal.actorFingerprint)

    // Multi-Session-per-Actor is legal: a re-exchange with the same keypair
    // yields the same fingerprint and an additional distinct session; Chat
    // IDs differentiate the sessions from Story 1.5 on.
    const aliceAgain = await exchange(server.port, alice, localToken)
    assert.equal(aliceAgain.status, 200)
    const secondToken = aliceAgain.json().result.session_token
    assert.notEqual(secondToken, aliceAuth.json().result.session_token)
    assert.deepEqual(registry.verify(secondToken), { actorFingerprint: alice.fingerprint })
    assert.ok(registry.verify(aliceAuth.json().result.session_token).actorFingerprint, 'the first session still verifies')
  } finally {
    await server.close()
  }
})

test('a server restart invalidates every issued session', async t => {
  const dataDir = makeDataDir(t)
  const identity = installation()

  const first = spawnServerChild(t, dataDir)
  const firstRecord = await first.waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const auth = await exchange(firstRecord.port, identity, localToken)
  const sessionToken = auth.json().result.session_token
  assert.equal(auth.status, 200)
  await first.stop()

  const second = spawnServerChild(t, dataDir)
  const secondRecord = await second.waitReady()
  const invalid = await request(secondRecord.port, 'GET', '/api/status', {
    headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${sessionToken}` },
  })
  assert.equal(invalid.status, 401, 'the in-memory registry died with the process')
  assert.equal(invalid.json().error.code, 'unauthorized')

  // The same credentials still bootstrap a fresh session after restart.
  const reauth = await exchange(secondRecord.port, identity, localToken)
  assert.equal(reauth.status, 200)
  await second.stop()
})

test('public_key is required and shape-checked: 32 raw bytes as base64url', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const headers = {
    [PROTOCOL_KEY]: '1',
    authorization: `Bearer ${localToken}`,
    'content-type': 'application/json; charset=utf-8',
  }

  const before = hashState(dataDir)

  // Missing field entirely (empty body).
  const missing = await request(record.port, 'POST', '/api/auth/local', { headers })
  assert.equal(missing.status, 400)
  assert.equal(missing.json().error.code, 'invalid_request')

  for (const bad of ['short', '', `${'x'.repeat(42)}`, `${'x'.repeat(44)}`, 'not+base64+url/', 42, null]) {
    const wrong = await request(record.port, 'POST', '/api/auth/local', {
      headers,
      body: JSON.stringify({ public_key: bad }),
    })
    assert.equal(wrong.status, 400, String(bad))
    assert.equal(wrong.json().error.code, 'invalid_request', String(bad))
  }

  assert.equal(hashState(dataDir), before, 'shape rejections change no state')
  await stop()
})

test('missing and wrong local credentials answer 401 with zero state change', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop, stderrText } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const identity = installation()

  const before = hashState(dataDir)

  const missing = await request(record.port, 'POST', '/api/auth/local', {
    headers: { [PROTOCOL_KEY]: '1' },
  })
  assert.equal(missing.status, 401)
  assert.equal(missing.json().error.code, 'unauthorized')
  assert.equal(missing.json().error.message, PUBLIC_ERRORS.unauthorized)

  // Over the presented-credential bound: rejected before any comparison work.
  const oversized = await request(record.port, 'POST', '/api/auth/local', {
    headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${'x'.repeat(SESSION_TOKEN_MAX_CHARS + 1)}` },
  })
  assert.equal(oversized.status, 401)
  assert.equal(oversized.json().error.code, 'unauthorized')

  // Equal-length wrong token: exercises the live constant-time compare branch.
  const wrong = await request(record.port, 'POST', '/api/auth/local', {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${'w'.repeat(localToken.length)}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ public_key: identity.publicKey }),
  })
  assert.equal(wrong.status, 401)
  assert.equal(wrong.json().error.code, 'unauthorized')
  assert.equal(hashState(dataDir), before, 'rejections never touch the store, the token file, or the record')

  // The registry is untouched: a valid exchange still works afterwards.
  const valid = await exchange(record.port, identity, localToken)
  assert.equal(valid.status, 200)
  assert.equal(stderrText().includes('w'.repeat(43)), false)

  await stop()
})

test('the token file is never created or rewritten by the HTTP path', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const tokenPath = localTokenPath(dataDir)
  const identity = installation()

  // No token file exists (only ensureServer guarantees one): the first auth
  // attempt must refuse with local_token_invalid and create nothing.
  assert.equal(existsSync(tokenPath), false)
  const missing = await request(record.port, 'POST', '/api/auth/local', {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${'a'.repeat(43)}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ public_key: identity.publicKey }),
  })
  assert.equal(missing.status, 401)
  assert.equal(missing.json().error.code, 'local_token_invalid')
  assert.equal(existsSync(tokenPath), false, 'zero creation from the HTTP path')

  // An unusable file is refused the same way and never rewritten.
  writeFileSync(tokenPath, 'not-a-token\n', 'utf8')
  const broken = await request(record.port, 'POST', '/api/auth/local', {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${'a'.repeat(43)}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ public_key: identity.publicKey }),
  })
  assert.equal(broken.status, 401)
  assert.equal(broken.json().error.code, 'local_token_invalid')
  assert.equal(readFileSync(tokenPath, 'utf8'), 'not-a-token\n', 'the file was never rewritten')

  await stop()
})

test('concurrent token-file creators converge on one credential', async t => {
  const dataDir = makeDataDir(t)
  const [first, second] = await Promise.all([
    loadOrCreateLocalToken(dataDir),
    loadOrCreateLocalToken(dataDir),
  ])
  assert.match(first, LOCAL_TOKEN_PATTERN)
  assert.equal(second, first, 'the loser read the winner\'s file')
  assert.equal(lstatSync(localTokenPath(dataDir)).mode & 0o777, 0o600)
})

test('readLocalToken maps every file failure to local_token_invalid and re-tightens 0600', t => {
  const dataDir = makeDataDir(t)
  mkdirSync(dataDir, { recursive: true })
  const path = localTokenPath(dataDir)

  assert.throws(
    () => readLocalToken(dataDir),
    error => error?.code === 'local_token_invalid',
    'missing file',
  )

  writeFileSync(path, `${'x'.repeat(LOCAL_TOKEN_MAX_BYTES + 1)}\n`, 'utf8')
  assert.throws(() => readLocalToken(dataDir), error => error?.code === 'local_token_invalid', 'oversized')

  writeFileSync(path, 'short\n', 'utf8')
  assert.throws(() => readLocalToken(dataDir), error => error?.code === 'local_token_invalid', 'malformed content')
  assert.equal(readFileSync(path, 'utf8'), 'short\n', 'the file is never rewritten')

  // An accepted read re-tightens a loosened mode through the descriptor.
  rmSync(path)
  const token = loadOrCreateLocalToken(dataDir)
  assert.match(token, LOCAL_TOKEN_PATTERN)
  writeFileSync(path, `${token}\n`, 'utf8')
  chmodSync(path, 0o644)
  assert.equal(readLocalToken(dataDir), token)
  assert.equal(lstatSync(path).mode & 0o777, 0o600, 'the mode was re-tightened on the accepted read')
})

test('a session token authenticates actor routes; unregistered routes 404 after the gate', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const auth = await exchange(record.port, installation(), localToken)
  const sessionToken = auth.json().result.session_token

  // The real verifier accepts: the request passes the auth stage and reaches
  // the (still unregistered) route position — 404 route_not_found, never 401.
  // (GET /api/status went live in Story 1.6; the probe uses GET /api/rooms
  // until its story lands.)
  const status = await request(record.port, 'GET', '/api/rooms', {
    headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${sessionToken}` },
  })
  assert.equal(status.status, 404)
  assert.equal(status.json().error.code, 'route_not_found')

  // Contrast: without a credential the same route answers 401.
  const anonymous = await request(record.port, 'GET', '/api/rooms', {
    headers: { [PROTOCOL_KEY]: '1' },
  })
  assert.equal(anonymous.status, 401)
  assert.equal(anonymous.json().error.code, 'unauthorized')

  await stop()
})

test('the local token file is never a per-request credential on actor routes', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)

  const response = await request(record.port, 'GET', '/api/status', {
    headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${localToken}` },
  })
  assert.equal(response.status, 401)
  assert.equal(response.json().error.code, 'unauthorized')

  await stop()
})

test('session tokens never authenticate viewer routes', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const auth = await exchange(record.port, installation(), localToken)
  const sessionToken = auth.json().result.session_token

  const viewer = await request(record.port, 'GET', '/viewer/auth', {
    headers: { authorization: `Bearer ${sessionToken}` },
  })
  assert.equal(viewer.status, 401)
  assert.equal(viewer.json().error.code, 'unauthorized')
  assert.equal(viewer.headers[PROTOCOL_KEY], undefined, 'viewer routes do not echo the protocol')

  await stop()
})

test('the auth/local route runs behind the pre-auth gates with no other credential input', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()

  // The protocol gate applies to the pre-auth class.
  const ungated = await request(record.port, 'POST', '/api/auth/local')
  assert.equal(ungated.status, 400)
  assert.equal(ungated.json().error.code, 'protocol_required')

  // FR-1 negative: no token, room id, or any other request field is accepted
  // — credentials travel only in the Authorization header and the public_key
  // field.
  const fielded = await request(record.port, 'POST', '/api/auth/local', {
    headers: { [PROTOCOL_KEY]: '1' },
    body: '{"token":"whatever","room_id":"r1"}',
  })
  assert.equal(fielded.status, 400)
  const fieldPayload = fielded.json()
  assert.equal(fieldPayload.error.code, 'unknown_field')
  assert.match(fieldPayload.error.message, /"(token|room_id)"/)

  await stop()
})

test('an injected sessionRegistry and the default verifier stay one coherent pair', async t => {
  const dataDir = makeDataDir(t)
  const registry = createSessionRegistry()
  const server = await startServer({ dataDir, sessionRegistry: registry })
  try {
    const localToken = loadOrCreateLocalToken(dataDir)
    const identity = installation()
    const auth = await exchange(server.port, identity, localToken)
    assert.equal(auth.status, 200)
    const sessionToken = auth.json().result.session_token

    // The handler issued into the injected registry...
    assert.deepEqual(registry.verify(sessionToken), { actorFingerprint: identity.fingerprint })

    // ...and the default session verifier reads the same registry: the
    // session authenticates an actor route (404 after the gate, never 401;
    // GET /api/rooms is still unregistered — /api/status went live in 1.6).
    const { result: outcome, chunks } = await captureStderr(() => request(server.port, 'GET', '/api/rooms', {
      headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${sessionToken}` },
    }))
    assert.equal(outcome.status, 404)
    assert.equal(outcome.json().error.code, 'route_not_found')

    // Nothing on stderr carries any credential.
    const stderr = chunks.join('')
    assert.equal(stderr.includes(localToken), false)
    assert.equal(stderr.includes(sessionToken), false)
  } finally {
    await server.close()
  }
})
