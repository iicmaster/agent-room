// Story 4.1 acceptance: remote challenge authentication. Registry rows run
// in-process (issue/consume pair, 60 s expiry, bounded pending set — injectable
// clock); the live-server rows run the real HTTP host, the real SQLite store,
// and the real api-client two ways — spawned server children (node:test with
// real child processes) where the process boundary is the evidence, and
// in-process startServer harnesses (the same real server code in the test
// process) where a registry seam or client wiring is what's under test.
// Either way the suite exercises POST /api/auth/challenge and POST
// /api/auth/answer and the real api-client's declared-remote lane end to end:
// single-use nonces with identity bound at challenge time, consume-before-
// verify (no grinding), replay resistance, the durable enrolled_actors gate
// seeded by the local lane's success path, FR-3's deletion rule, NFR-3's
// negatives mirrored at the wire, and the private key never traveling.
//
// Matrix row → test map (the spec's I/O & Edge-Case Matrix; harness shown per
// row — registry = in-process registry unit, in-process = startServer harness
// over the real host and store, spawned = real server child):
//    row 1  (spawned)     'POST /api/auth/challenge issues a fresh single-use nonce...'
//    row 2  (in-process)  'POST /api/auth/answer commits a session for an enrolled key...'
//    row 3  (in-process)  'a replayed answer request yields no token and changes no state'
//    row 4  (in-process)  'identity binds at challenge: a foreign key cannot answer'
//    row 5  (registry)    'challenge expiry lands at the declared 60 s bound (injectable clock)'
//    row 6  (in-process)  'consume-before-verify: a failed answer burns the nonce'
//    row 7  (in-process)  'an unenrolled key is admitted at challenge, gated at answer'
//    row 8  (spawned)     'enrollment seeds durably from the local lane and survives restart'
//    row 9  (registry)    'the pending set is bounded: oldest-pending eviction at capacity'
//    row 10 (spawned)     'the declared-remote client runs the challenge lane end to end'
//    row 11 (scan)        'counted scans: zero key material anywhere on the wire or stderr'
//    row 12 (spawned)     'plugin-data deletion creates a new, unrelated Actor (FR-3)'
//    row 13 (in-process)  'NFR-3 mirrored at the wire: no identity field is honored'
//    row 14 (in-process)  'one mechanism, two issuance paths: sliding TTL, capacity, revoke'
//
// Post-implementation review tests (no matrix row; named for their triage
// source): the declared-remote attach wire-scan, the challengeRegistry
// injection seam, the canonical-signature gate, the four bounds' literal
// oracles, and the mid-flight identity replacement.

import assert from 'node:assert/strict'
import { createHash, createPublicKey, createPrivateKey, generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { once } from 'node:events'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { DatabaseSync } from 'node:sqlite'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  CHALLENGE_NONCE_BYTES,
  CHALLENGE_NONCES_MAX,
  CHALLENGE_NONCE_TTL_MS,
  CHALLENGE_SIGNATURE_MAX_CHARS,
  PUBLIC_ERRORS,
  SESSION_TOKEN_BYTES,
  SESSION_TTL_MS,
} from '../server/constants.mjs'
import {
  AgentRoomRuntimeError,
  atomicWriteJson,
} from '../server/runtime.mjs'
import { createChallengeRegistry } from '../server/api/challenge.mjs'
import { createSessionRegistry, sessionKeyFromToken } from '../server/api/session.mjs'
import { fingerprintFromPublicKey, signWithInstallationKey, verifyWithRawPublicKey } from '../server/keys.mjs'
import { loadOrCreateLocalToken, localTokenPath } from '../server/api/local-token.mjs'
import { startServer } from '../server/api/server.mjs'
import { ROOM_LOG_DATABASE_FILENAME } from '../server/store/room-log.mjs'
import { CONNECTION_MODE_ENV, createAgentRoomClient } from '../server/client/api-client.mjs'
import { ensureServer } from '../server/client/ensure-server.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = join(ROOT, 'server', 'api', 'server.mjs')
const RUNTIME_RECORD_FILENAME = 'runtime.json'
const PROTOCOL_KEY = 'agent-room-protocol'

const sleep = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })

// Wire shapes stated once, derived from the declared constants (AD-9): the
// base64url character counts of CHALLENGE_NONCE_BYTES and SESSION_TOKEN_BYTES.
const NONCE_CHARS = Buffer.alloc(CHALLENGE_NONCE_BYTES).toString('base64url').length
const TOKEN_CHARS = Buffer.alloc(SESSION_TOKEN_BYTES).toString('base64url').length

// --- Shared evidence accumulators (row 11's counted scans) ---------------------
//
// Every request/response body this file drives (through the direct request()
// helper or the real api-client via the captureRequests observation seam) and
// every spawned server's stderr accumulates here; the final test scans the
// whole accumulation for key material with counted numbers.

const wireCaptures = []
const stderrCaptures = []
const knownPrivatePems = []

function recordWire(method, path, requestHeaders, requestBodyChunks, responseBodyChunks) {
  wireCaptures.push({
    method,
    path,
    requestHeaders: requestHeaders ?? {},
    requestBody: Buffer.concat(requestBodyChunks).toString('utf8'),
    responseBody: Buffer.concat(responseBodyChunks).toString('utf8'),
  })
}

// In-process observation seam over the api-client's HTTP layer: the default
// node:http export is the shared CJS module object, so wrapping request()
// intercepts exactly what the shipped client puts on the wire while
// delegating the real bytes untouched. Observation only — no stub, no fake.
// The wire entry is recorded when the response ENDS, so both body snapshots
// are complete.
function captureRequests(t) {
  const original = http.request
  http.request = (options, callback) => {
    const record = { method: options.method, path: options.path, requestHeaders: options.headers, requestBody: [], responseBody: [] }
    const settle = response => {
      response.on('data', chunk => record.responseBody.push(Buffer.from(chunk)))
      response.on('end', () => recordWire(record.method, record.path, record.requestHeaders, record.requestBody, record.responseBody))
    }
    const wrappedCallback = callback
      ? response => {
          settle(response)
          callback(response)
        }
      : undefined
    const request = original.call(http, options, wrappedCallback)
    if (!wrappedCallback) request.on('response', settle)
    const originalWrite = request.write.bind(request)
    request.write = (chunk, ...rest) => {
      if (chunk !== undefined) record.requestBody.push(Buffer.from(chunk))
      return originalWrite(chunk, ...rest)
    }
    const originalEnd = request.end.bind(request)
    request.end = (chunk, ...rest) => {
      if (chunk !== undefined) record.requestBody.push(Buffer.from(chunk))
      return originalEnd(chunk, ...rest)
    }
    return request
  }
  t.after(() => { http.request = original })
}

// --- Harness: real server child (the local-auth style) ---------------------------

function makeDataDir(t, prefix = 'agent-room-challenge-auth-') {
  const dataDir = mkdtempSync(join(tmpdir(), prefix))
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

// A pid proven dead: spawn a child that exits immediately and reap it (the
// ensure-server harness's pattern) — the half-stale record fixtures below
// need one.
async function deadPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
  await once(child, 'exit')
  return child.pid
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
          recordWire(method, path, headers, body === undefined ? [] : [Buffer.from(body)], [Buffer.from(text)])
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

// One installation identity under its own plugin dir: the keypair file is
// born the way Story 1.1 births it (pkcs8 PEM at 0600), the shipped signer
// signs with it, and only the raw public key + fingerprint are ever held in
// the clear. The PEM's actual bytes join the row-11 scan needles.
function makeInstallation(parent, name, chatId) {
  const pluginData = join(parent, name)
  mkdirSync(pluginData, { recursive: true, mode: 0o700 })
  atomicWriteJson(join(pluginData, 'config.json'), { chat_id: chatId })
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  writeFileSync(join(pluginData, 'identity.key'), pem, { mode: 0o600 })
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const raw = spki.subarray(spki.length - 32)
  knownPrivatePems.push(pem)
  return {
    pluginData,
    chatId,
    raw,
    publicKey: raw.toString('base64url'),
    fingerprint: fingerprintFromPublicKey(raw),
    // The shipped signer: the private PEM never leaves the keys module.
    sign: data => signWithInstallationKey(pluginData, data).toString('base64url'),
    keyPath: join(pluginData, 'identity.key'),
  }
}

// State fingerprint across every file the auth surface owns: the store, the
// token file, and the runtime record. Rejections must leave all three
// byte-identical (the enrollment row is store state, so it is covered).
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

// Read-only SQLite inspection: opens the live store's own file read-only and
// always closes — the inspection never writes.
function sqlRows(dataDir, query) {
  const inspector = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME), { readOnly: true })
  try {
    return inspector.prepare(query).all()
  } finally {
    inspector.close()
  }
}

const enrollmentRows = dataDir => sqlRows(
  dataDir,
  'SELECT actor_fingerprint, enrolled_at FROM enrolled_actors ORDER BY enrolled_at ASC, actor_fingerprint ASC',
)

// The canonical exchanges and challenge steps against a running server.
function localExchange(port, dataDir, publicKey) {
  return request(port, 'POST', '/api/auth/local', {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${loadOrCreateLocalToken(dataDir)}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ public_key: publicKey }),
  })
}

function challenge(port, publicKeyBase64url) {
  return request(port, 'POST', '/api/auth/challenge', {
    headers: { [PROTOCOL_KEY]: '1', 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ public_key: publicKeyBase64url }),
  })
}

function answer(port, nonce, signature) {
  return request(port, 'POST', '/api/auth/answer', {
    headers: { [PROTOCOL_KEY]: '1', 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ nonce, signature }),
  })
}

// The full token-free challenge-answer round trip for an installation.
async function challengeAnswer(port, installation_) {
  const challengeResponse = await challenge(port, installation_.publicKey)
  assert.equal(challengeResponse.status, 200)
  const nonce = challengeResponse.json().result.nonce
  return answer(port, nonce, installation_.sign(Buffer.from(nonce, 'base64url')))
}

// --- Challenge registry rows (in-process, injectable clock) ----------------------

test('the challenge registry mints fresh single-use nonces bound to the presented raw key', () => {
  let now = 1_000_000
  const registry = createChallengeRegistry({ now: () => now })
  const rawKey = new Uint8Array(32).fill(7)

  const first = registry.issue(rawKey)
  const second = registry.issue(rawKey)
  assert.equal(first.length, NONCE_CHARS, 'the nonce is exactly CHALLENGE_NONCE_BYTES base64url characters')
  assert.equal(Buffer.from(first, 'base64url').length, CHALLENGE_NONCE_BYTES)
  assert.ok(CHALLENGE_NONCE_BYTES >= 16, 'AD-7: nonce entropy of at least 16 random bytes (32 declared)')
  assert.notEqual(first, second, 'every issue mints a fresh nonce')

  // consume deletes-then-checks: the recorded key comes back once, the slot
  // is empty forever after — replay and correction both find nothing.
  const consumed = registry.consume(first)
  assert.ok(consumed instanceof Uint8Array && consumed.length === CHALLENGE_NONCE_BYTES)
  assert.deepEqual(Buffer.from(consumed), Buffer.from(rawKey), 'the recorded key is the issued one')
  assert.equal(registry.consume(first), null, 'a consumed nonce is single-use')
  assert.equal(registry.consume('never-issued'), null)
  assert.equal(registry.consume(''), null)
  assert.equal(registry.consume(42), null)

  // The pending count tracks what is actually pending.
  assert.equal(registry.pendingCount(), 1, 'only the second nonce is still pending')
})

test('challenge expiry lands at the declared 60 s bound and sweeps lazily (row 5)', () => {
  let now = 1_000_000
  const registry = createChallengeRegistry({ now: () => now })
  const nonce = registry.issue(new Uint8Array(32).fill(1))
  now += CHALLENGE_NONCE_TTL_MS - 1
  assert.notEqual(registry.consume(nonce), null, 'valid to the last millisecond before the bound')

  // Exactly at the bound: two nonces minted at origin 0 expire at
  // CHALLENGE_NONCE_TTL_MS — the first answers one millisecond before the
  // bound, the second is expired exactly at it.
  let origin = 0
  const boundary = createChallengeRegistry({ now: () => origin })
  const beforeBound = boundary.issue(new Uint8Array(32).fill(2))
  const atBound = boundary.issue(new Uint8Array(32).fill(3))
  origin = CHALLENGE_NONCE_TTL_MS - 1
  assert.notEqual(boundary.consume(beforeBound), null, 'valid to the last millisecond before the bound')
  origin = CHALLENGE_NONCE_TTL_MS
  assert.equal(boundary.consume(atBound), null, 'at the 60 s bound the nonce is expired')

  // Lazy sweep: expired entries leave the map at the next issue.
  let sweepNow = 5_000_000
  const sweeper = createChallengeRegistry({ now: () => sweepNow, maxPending: 2 })
  sweeper.issue(new Uint8Array(32).fill(4))
  sweepNow += CHALLENGE_NONCE_TTL_MS + 1
  sweeper.issue(new Uint8Array(32).fill(5))
  assert.equal(sweeper.pendingCount(), 1, 'the expired entry was swept by the next issue')
})

test('the pending set is bounded: oldest-pending eviction at capacity (row 9)', () => {
  // The DEFAULT bound, imported by name: fill past CHALLENGE_NONCES_MAX and
  // the oldest pending nonces are gone while the newest survives.
  let now = 1_000_000
  const defaulted = createChallengeRegistry({ now: () => now })
  const nonces = []
  for (let index = 0; index < CHALLENGE_NONCES_MAX + 1; index += 1) {
    nonces.push(defaulted.issue(new Uint8Array(32).fill(index % 256)))
  }
  assert.equal(defaulted.pendingCount(), CHALLENGE_NONCES_MAX, 'the bound holds under sustained issuance')
  assert.equal(defaulted.consume(nonces[0]), null, 'the oldest pending nonce was evicted')
  assert.notEqual(defaulted.consume(nonces[1]), null, 'exactly the oldest was evicted: the second-oldest survives')
  assert.notEqual(defaulted.consume(nonces[nonces.length - 1]), null, 'the newest nonce survived')

  // Sweep-then-evict: expired entries are swept by the next issue BEFORE any
  // live entry is evicted (the session registry's discipline mirrored).
  now = 2_000_000
  const sweeper = createChallengeRegistry({ now: () => now, maxPending: 3 })
  sweeper.issue(new Uint8Array(32).fill(1)) // expires at 2_060_000
  now += CHALLENGE_NONCE_TTL_MS + 1
  const liveOld = sweeper.issue(new Uint8Array(32).fill(2)) // the sweep drops the expired one
  assert.equal(sweeper.pendingCount(), 1)
  assert.notEqual(sweeper.consume(liveOld), null, 'the freshly issued nonce survived the sweep')
  // All live at capacity: the next issue evicts the oldest live pending
  // nonce (insertion order), never a newer one.
  const oldestLive = sweeper.issue(new Uint8Array(32).fill(3))
  sweeper.issue(new Uint8Array(32).fill(4))
  sweeper.issue(new Uint8Array(32).fill(5))
  sweeper.issue(new Uint8Array(32).fill(6)) // at capacity: the oldest live is evicted
  assert.equal(sweeper.consume(oldestLive), null, 'the oldest live pending nonce was evicted')
  assert.equal(sweeper.pendingCount(), 3, 'the bound holds')
})

test('createChallengeRegistry validates its wiring and its recorded identities', () => {
  assert.throws(() => createChallengeRegistry({ ttlMs: 0 }), /ttlMs/)
  assert.throws(() => createChallengeRegistry({ ttlMs: -1 }), /ttlMs/)
  assert.throws(() => createChallengeRegistry({ now: 'nope' }), /now/)
  assert.throws(() => createChallengeRegistry({ maxPending: 0 }), /maxPending/)
  const registry = createChallengeRegistry({ now: () => 0 })
  assert.throws(() => registry.issue('not-bytes'), /32-byte/)
  assert.throws(() => registry.issue(new Uint8Array(31)), /32-byte/)
})

test('the four challenge bounds hold at their literal values (independent oracles, review triage)', () => {
  // The suites above derive their expectations from the imported constants,
  // so they would adapt silently to a drifted bound. These oracles check the
  // LITERAL values instead: a bound that moves fails here.

  // Bound 1 — nonce width, literal: 32 random bytes mint exactly 43
  // base64url characters; AD-7's floor of 16 bytes is asserted literally too.
  let now = 0
  const registry = createChallengeRegistry({ now: () => now })
  const nonce = registry.issue(new Uint8Array(32).fill(9))
  assert.equal(nonce.length, 43, 'literal: 32 random bytes are exactly 43 base64url characters')
  assert.equal(Buffer.from(nonce, 'base64url').length, 32, 'literal: the nonce carries 32 bytes (AD-7 floor: 16)')
  registry.consume(nonce)

  // Bound 2 — the 60 s life, literal clock offsets against the injected
  // clock: alive at 59_999 ms, expired at exactly 60_000 ms.
  let clock = 0
  const literal = createChallengeRegistry({ now: () => clock })
  const alive = literal.issue(new Uint8Array(32).fill(3))
  const expired = literal.issue(new Uint8Array(32).fill(4))
  clock = 59_999
  assert.notEqual(literal.consume(alive), null, 'alive at 59_999 ms — one millisecond inside the literal 60_000 ms bound')
  clock = 60_000
  assert.equal(literal.consume(expired), null, 'expired at exactly 60_000 ms')

  // Bound 3 — single use, unconditional: the slot empties on the first
  // consume and never resurrects.
  const singleUse = createChallengeRegistry({ now: () => 0 })
  const once = singleUse.issue(new Uint8Array(32).fill(5))
  assert.notEqual(singleUse.consume(once), null)
  assert.equal(singleUse.consume(once), null, 'the second consume finds nothing')
  assert.equal(singleUse.consume(once), null, 'nor the third')

  // Bound 4 — the canonical signature shape, literal: a 64-byte Ed25519
  // signature is exactly 86 base64url characters.
  const canonicalForm = Buffer.alloc(64, 7).toString('base64url')
  assert.equal(canonicalForm.length, 86, 'literal: 64 bytes are exactly 86 base64url characters')
})

test('the keys helpers sign with the installation key and verify against a raw key', t => {
  const directory = makeDataDir(t, 'agent-room-challenge-keys-')
  const { publicKey, privateKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const raw = spki.subarray(spki.length - 32)
  writeFileSync(join(directory, 'identity.key'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })

  const data = Buffer.from('a raw nonce payload', 'utf8')
  const signature = signWithInstallationKey(directory, data)
  assert.equal(signature.length, 64, 'an Ed25519 signature is 64 bytes')
  assert.equal(verifyWithRawPublicKey(raw, data, signature), true)
  // The constructed SPKI DER is the exact inverse of the raw extraction: the
  // fixed 12-byte prefix plus the raw key equals the key's own SPKI encoding.
  assert.deepEqual(
    Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), Buffer.from(raw)]),
    createPublicKey(createPrivateKey(readFileSync(join(directory, 'identity.key'), 'utf8')))
      .export({ type: 'spki', format: 'der' }),
    'the raw key wraps back into its own SPKI DER encoding',
  )

  // Anything malformed is false, never a throw.
  assert.equal(verifyWithRawPublicKey(raw, Buffer.from('other payload'), signature), false, 'a different payload fails')
  const foreign = generateKeyPairSync('ed25519')
  const foreignRaw = foreign.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32)
  assert.equal(verifyWithRawPublicKey(foreignRaw, data, signature), false, 'a foreign key fails')
  assert.equal(verifyWithRawPublicKey(raw, data, Buffer.concat([signature, Buffer.from([0])])), false, 'wrong signature length fails')
  assert.equal(verifyWithRawPublicKey(new Uint8Array(31), data, signature), false)
  assert.equal(verifyWithRawPublicKey('not-bytes', data, signature), false)
  assert.equal(verifyWithRawPublicKey(raw, 'not-bytes', signature), false)
  assert.equal(verifyWithRawPublicKey(raw, data, 'not-bytes'), false)
  assert.equal(verifyWithRawPublicKey(raw, data, Buffer.alloc(64)), false, 'a zero signature fails')
  assert.throws(() => signWithInstallationKey(directory, 'not-bytes'), error => error?.code === 'identity_key_invalid')
})

// --- Live server matrix rows (real children and the in-process host) -------------

test('POST /api/auth/challenge issues a fresh single-use nonce; shape rejections change no state (row 1)', async t => {
  const home = makeDataDir(t)
  const dataDir = makeDataDir(t)
  const { child, waitReady, stop, stderrText } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const identity = makeInstallation(home, 'inst', 'Challenger')

  const before = hashState(dataDir)

  const first = await challenge(record.port, identity.publicKey)
  assert.equal(first.status, 200)
  assert.equal(first.json().ok, true)
  assert.deepEqual(Object.keys(first.json().result), ['nonce'])
  const nonce = first.json().result.nonce
  assert.equal(nonce.length, NONCE_CHARS, 'the nonce is exactly CHALLENGE_NONCE_BYTES base64url characters')
  assert.equal(Buffer.from(nonce, 'base64url').length, CHALLENGE_NONCE_BYTES)
  assert.ok(CHALLENGE_NONCE_BYTES >= 16, 'AD-7: at least 16 random bytes (the constant declares 32)')
  assert.equal(first.headers[PROTOCOL_KEY], '1')

  // Two challenges for the same key return different nonces.
  const second = await challenge(record.port, identity.publicKey)
  assert.equal(second.status, 200)
  assert.notEqual(second.json().result.nonce, nonce, 'every challenge mints a fresh nonce')

  // Non-32-byte or non-base64url public_key → 400 invalid_request naming the
  // field; zero state change across the whole row.
  for (const bad of ['short', '', `${'x'.repeat(42)}`, `${'x'.repeat(44)}`, 'not+base64+url/', Buffer.alloc(31).toString('base64url'), 42, null]) {
    const wrong = await challenge(record.port, bad)
    assert.equal(wrong.status, 400, String(bad))
    assert.equal(wrong.json().error.code, 'invalid_request', String(bad))
    assert.match(wrong.json().error.message, /public_key/, String(bad))
  }

  assert.equal(hashState(dataDir), before, 'shape rejections change no state')
  stderrCaptures.push(stderrText())
  await stop()
  assert.equal(child.exitCode, 0)
})

test('POST /api/auth/answer commits a session for an enrolled key into the SAME registry (row 2)', async t => {
  const home = makeDataDir(t)
  const dataDir = makeDataDir(t)
  const sessionRegistry = createSessionRegistry()
  const server = await startServer({ dataDir, sessionRegistry })
  try {
    const identity = makeInstallation(home, 'inst', 'Answerer')
    // Enrollment seeds from the local lane's success path (row 8 proves it in
    // depth); this row needs the gate open.
    const enrolled = await localExchange(server.port, dataDir, identity.publicKey)
    assert.equal(enrolled.status, 200)

    const answered = await challengeAnswer(server.port, identity)
    assert.equal(answered.status, 200)
    assert.equal(answered.json().ok, true)
    assert.deepEqual(Object.keys(answered.json().result), ['session_token'])
    const token = answered.json().result.session_token
    assert.equal(token.length, TOKEN_CHARS, 'SESSION_TOKEN_BYTES entropy — the same token shape as the local path')

    // The token authenticates actor routes as that fingerprint: it resolves
    // in the SAME registry the local path issues into (one mechanism, AD-5),
    // POST /api/session binds, and the presence row carries the fingerprint.
    assert.deepEqual(sessionRegistry.verify(token), { actorFingerprint: identity.fingerprint })
    const bound = await request(server.port, 'POST', '/api/session', {
      headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ chat_id: identity.chatId }),
    })
    assert.equal(bound.status, 200)
    const presence = await request(server.port, 'GET', '/api/presence', {
      headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${token}` },
    })
    assert.equal(presence.status, 200)
    const online = presence.json().result.online
    assert.equal(online.length, 1, 'only the bound session is present')
    assert.equal(online[0].fingerprint, identity.fingerprint)
    assert.equal(online[0].chat_id, identity.chatId)

    stderrCaptures.push('')
  } finally {
    await server.close()
  }
})

test('a replayed answer yields no second token and zero state; a failed answer burns the nonce (rows 3 and 6)', async t => {
  const home = makeDataDir(t)
  const dataDir = makeDataDir(t)
  const sessionRegistry = createSessionRegistry()
  const server = await startServer({ dataDir, sessionRegistry })
  try {
    const identity = makeInstallation(home, 'inst', 'Replayer')
    const enrolled = await localExchange(server.port, dataDir, identity.publicKey)
    assert.equal(enrolled.status, 200)

    const challengeResponse = await challenge(server.port, identity.publicKey)
    const nonce = challengeResponse.json().result.nonce
    const signature = identity.sign(Buffer.from(nonce, 'base64url'))

    const firstAnswer = await answer(server.port, nonce, signature)
    assert.equal(firstAnswer.status, 200)
    const firstToken = firstAnswer.json().result.session_token
    // One session from the enrolling local exchange, one from this answer.
    const sessionsAfterFirstAnswer = sessionRegistry.sessionKeys().length
    assert.equal(sessionsAfterFirstAnswer, 2)

    const before = hashState(dataDir)
    const replay = await answer(server.port, nonce, signature)
    assert.equal(replay.status, 401)
    assert.equal(replay.json().error.code, 'challenge_invalid')
    assert.equal(replay.json().error.message, PUBLIC_ERRORS.challenge_invalid)
    assert.equal(sessionRegistry.sessionKeys().length, sessionsAfterFirstAnswer, 'the replay minted no second session')
    assert.equal(hashState(dataDir), before, 'the replay changed no enrollment, claim, or store state')

    // Row 6, consume-before-verify: a WRONG signature burns the nonce, so the
    // follow-up CORRECT signature finds an empty slot — no grinding against
    // one challenge.
    const fresh = await challenge(server.port, identity.publicKey)
    const freshNonce = fresh.json().result.nonce
    const wrongSignature = Buffer.from(signWithInstallationKey(home, Buffer.from('wrong payload bytes for the grinder', 'utf8'))).toString('base64url')
    const wrong = await answer(server.port, freshNonce, wrongSignature)
    assert.equal(wrong.status, 401)
    assert.equal(wrong.json().error.code, 'signature_invalid')
    const corrected = await answer(server.port, freshNonce, identity.sign(Buffer.from(freshNonce, 'base64url')))
    assert.equal(corrected.status, 401, 'the nonce was burned by the failed attempt')
    assert.equal(corrected.json().error.code, 'challenge_invalid')
    assert.equal(sessionRegistry.sessionKeys().length, sessionsAfterFirstAnswer, 'the burned answers minted no session either')

    // The first session is untouched by both refusals.
    assert.ok(sessionRegistry.verify(firstToken).actorFingerprint)

    stderrCaptures.push('')
  } finally {
    await server.close()
  }
})

test('identity binds at challenge: a foreign key signing the same nonce is refused (row 4)', async t => {
  const home = makeDataDir(t)
  const dataDir = makeDataDir(t)
  const server = await startServer({ dataDir })
  try {
    const enrolled = makeInstallation(home, 'enrolled', 'Keyholder')
    const foreign = makeInstallation(home, 'foreign', 'Impostor')
    assert.equal((await localExchange(server.port, dataDir, enrolled.publicKey)).status, 200)

    const challengeResponse = await challenge(server.port, enrolled.publicKey)
    assert.equal(challengeResponse.status, 200)
    const nonce = challengeResponse.json().result.nonce

    // A CORRECT Ed25519 signature over the same nonce — by the WRONG key.
    // The answer route carries no public_key to substitute with, so the
    // verification runs against the challenge-recorded key and fails.
    const before = hashState(dataDir)
    const foreignSigned = await answer(server.port, nonce, foreign.sign(Buffer.from(nonce, 'base64url')))
    assert.equal(foreignSigned.status, 401)
    assert.equal(foreignSigned.json().error.code, 'signature_invalid')
    assert.equal(hashState(dataDir), before, 'the refusal changed no state')

    // The nonce is still spent by the attempt: the true holder cannot answer
    // it either — consume happens before verification, whatever the outcome.
    const trueHolder = await answer(server.port, nonce, enrolled.sign(Buffer.from(nonce, 'base64url')))
    assert.equal(trueHolder.status, 401)
    assert.equal(trueHolder.json().error.code, 'challenge_invalid')

    stderrCaptures.push('')
  } finally {
    await server.close()
  }
})

test('an unenrolled key is admitted at challenge and gated at answer (row 7)', async t => {
  const home = makeDataDir(t)
  const dataDir = makeDataDir(t)
  const sessionRegistry = createSessionRegistry()
  const server = await startServer({ dataDir, sessionRegistry })
  try {
    const stranger = makeInstallation(home, 'stranger', 'Stranger')
    // No enrollment record exists for this key anywhere.
    assert.equal(enrollmentRows(dataDir).length, 0)

    const challengeResponse = await challenge(server.port, stranger.publicKey)
    assert.equal(challengeResponse.status, 200, 'the challenge stays open to unenrolled keys')
    const nonce = challengeResponse.json().result.nonce

    const before = hashState(dataDir)
    const answered = await answer(server.port, nonce, stranger.sign(Buffer.from(nonce, 'base64url')))
    assert.equal(answered.status, 403)
    assert.equal(answered.json().error.code, 'not_enrolled')
    assert.equal(answered.json().error.message, PUBLIC_ERRORS.not_enrolled)
    assert.equal(sessionRegistry.sessionKeys().length, 0, 'no session was minted')
    assert.equal(hashState(dataDir), before, 'no enrollment, no claim, no store state from the refusal')

    // The nonce was consumed by the gated attempt, too.
    const replay = await answer(server.port, nonce, stranger.sign(Buffer.from(nonce, 'base64url')))
    assert.equal(replay.status, 401)
    assert.equal(replay.json().error.code, 'challenge_invalid')

    stderrCaptures.push('')
  } finally {
    await server.close()
  }
})

test('missing and malformed answer fields are shape rejections naming the field', async t => {
  const home = makeDataDir(t)
  const dataDir = makeDataDir(t)
  const server = await startServer({ dataDir })
  try {
    const identity = makeInstallation(home, 'inst', 'Shaper')
    assert.equal((await localExchange(server.port, dataDir, identity.publicKey)).status, 200)

    const before = hashState(dataDir)
    const headers = { [PROTOCOL_KEY]: '1', 'content-type': 'application/json; charset=utf-8' }
    for (const body of ['', '{}', '{"signature":"x"}', '{"nonce":"y"}', JSON.stringify({ nonce: '', signature: 'x' }), JSON.stringify({ nonce: 'y', signature: '' })]) {
      const wrong = await request(server.port, 'POST', '/api/auth/answer', { headers, body })
      assert.equal(wrong.status, 400, body)
      assert.equal(wrong.json().error.code, 'invalid_request', body)
      if (body !== '' && body !== '{}') {
        assert.match(wrong.json().error.message, /nonce|signature/, body)
      }
    }
    // An over-bound signature can never be a valid Ed25519 signature; the
    // bound is imported by name on the server side.
    const oversized = await request(server.port, 'POST', '/api/auth/answer', {
      headers,
      body: JSON.stringify({ nonce: 'y', signature: 'x'.repeat(CHALLENGE_SIGNATURE_MAX_CHARS + 1) }),
    })
    assert.equal(oversized.status, 400)
    assert.equal(oversized.json().error.code, 'invalid_request')

    assert.equal(hashState(dataDir), before, 'shape rejections change no state')
    stderrCaptures.push('')
  } finally {
    await server.close()
  }
})

test('the answer route honors only the canonical signature form — decorated spellings are refused (review triage)', async t => {
  const home = makeDataDir(t)
  const dataDir = makeDataDir(t)
  const server = await startServer({ dataDir })
  try {
    const identity = makeInstallation(home, 'inst', 'Decorator')
    assert.equal((await localExchange(server.port, dataDir, identity.publicKey)).status, 200)

    const before = hashState(dataDir)
    // Every decorated spelling below decodes to the SAME 64 bytes the
    // canonical form carries — the base64url decoder skips every '#' — so
    // without the canonical-form gate these would verify and mint a session.
    const decorations = [
      canonical => `${canonical}###`,
      canonical => `${canonical.slice(0, 43)}###${canonical.slice(43)}`,
      canonical => `##${canonical}`,
    ]
    for (const decorate of decorations) {
      const nonce = (await challenge(server.port, identity.publicKey)).json().result.nonce
      const refused = await answer(server.port, nonce, decorate(identity.sign(Buffer.from(nonce, 'base64url'))))
      assert.equal(refused.status, 401, 'a non-canonical spelling is a signature refusal')
      assert.equal(refused.json().error.code, 'signature_invalid')
      // The refusal consumed the attempt (no grinding): the correct answer
      // finds an empty slot.
      const burned = await answer(server.port, nonce, identity.sign(Buffer.from(nonce, 'base64url')))
      assert.equal(burned.status, 401, 'the refused spelling burned the nonce')
      assert.equal(burned.json().error.code, 'challenge_invalid')
    }

    assert.equal(hashState(dataDir), before, 'the refusals wrote no durable state')
    stderrCaptures.push('')
  } finally {
    await server.close()
  }
})

test('enrollment seeds durably from the local lane and survives a restart while nonces do not (row 8)', async t => {
  const home = makeDataDir(t)
  const dataDir = makeDataDir(t)
  const identity = makeInstallation(home, 'inst', 'Reconnecter')

  const first = spawnServerChild(t, dataDir)
  const firstRecord = await first.waitReady()

  // The local exchange's success path records enrolled_actors(fingerprint,
  // enrolled_at); the first timestamp sticks on re-presentation.
  const exchangeOne = await localExchange(firstRecord.port, dataDir, identity.publicKey)
  assert.equal(exchangeOne.status, 200)
  let rows = enrollmentRows(dataDir)
  assert.deepEqual(rows.map(row => row.actor_fingerprint), [identity.fingerprint])
  const firstEnrolledAt = rows[0].enrolled_at
  assert.ok(Number.isFinite(Date.parse(firstEnrolledAt)))

  const exchangeTwo = await localExchange(firstRecord.port, dataDir, identity.publicKey)
  assert.equal(exchangeTwo.status, 200)
  rows = enrollmentRows(dataDir)
  assert.equal(rows.length, 1, 're-presentation adds no row')
  assert.equal(rows[0].enrolled_at, firstEnrolledAt, 'the first registration sticks')

  // A rejected local exchange writes no enrollment row — and the proof is
  // made with a key that has NO row yet: for an already-enrolled key the
  // idempotent INSERT would mask an enrollment that ran before the credential
  // check (review triage: the ordering assertion must be able to fail).
  // Credential validation strictly precedes any durable write.
  const stranger = makeInstallation(home, 'rejected-stranger', 'NeverEnrolled')
  const rejected = await request(firstRecord.port, 'POST', '/api/auth/local', {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${'w'.repeat(43)}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ public_key: stranger.publicKey }),
  })
  assert.equal(rejected.status, 401)
  assert.deepEqual(
    enrollmentRows(dataDir).map(row => row.actor_fingerprint),
    [identity.fingerprint],
    'the rejected exchange enrolled nothing: no row for the presented key, no extra row at all',
  )

  // The token-free challenge-answer authenticates — no Bearer header, no
  // local token anywhere in the exchange.
  const tokenFree = await challengeAnswer(firstRecord.port, identity)
  assert.equal(tokenFree.status, 200)

  // An outstanding challenge is connection-time state: mint one, then
  // restart, and the answer finds nothing.
  const outstanding = await challenge(firstRecord.port, identity.publicKey)
  const outstandingNonce = outstanding.json().result.nonce
  const outstandingSignature = identity.sign(Buffer.from(outstandingNonce, 'base64url'))

  await first.stop()
  assert.equal(first.child.exitCode, 0)

  const second = spawnServerChild(t, dataDir)
  const secondRecord = await second.waitReady()

  // Durable enrollment survives: the fresh challenge-answer authenticates
  // (FR-12's re-prove-without-re-enroll).
  const afterRestart = await challengeAnswer(secondRecord.port, identity)
  assert.equal(afterRestart.status, 200, 'the durable enrollment survived the restart')
  assert.equal(enrollmentRows(dataDir).length, 1, 'still exactly one enrollment row')
  assert.equal(enrollmentRows(dataDir)[0].enrolled_at, firstEnrolledAt)

  // The outstanding nonce died with the process.
  const stale = await answer(secondRecord.port, outstandingNonce, outstandingSignature)
  assert.equal(stale.status, 401)
  assert.equal(stale.json().error.code, 'challenge_invalid')

  stderrCaptures.push(first.stderrText(), second.stderrText())
  await second.stop()
})

test('one mechanism, two issuance paths: sliding TTL, capacity, and revoke behave identically (row 14, DR-2 ratified)', async t => {
  const home = makeDataDir(t)
  const dataDir = makeDataDir(t)
  let now = 10_000_000
  const clock = () => now
  // The default TTL (SESSION_TTL_MS — DR-2's 12 h sliding window, ratified as
  // declared) and the default capacity (SESSIONS_MAX), through the declared
  // registry factories; the challenge path adds no registry of its own.
  const sessionRegistry = createSessionRegistry({ now: clock })
  const challengeRegistry = createChallengeRegistry({ now: clock })
  const server = await startServer({ dataDir, sessionRegistry, challengeRegistry })
  try {
    const identity = makeInstallation(home, 'inst', 'Ratifier')
    const localAuth = await localExchange(server.port, dataDir, identity.publicKey)
    assert.equal(localAuth.status, 200)
    const localToken = localAuth.json().result.session_token

    const answered = await challengeAnswer(server.port, identity)
    assert.equal(answered.status, 200)
    const challengeToken = answered.json().result.session_token

    // Sliding TTL, identical for both paths: activity refreshes, so a token
    // verified within the window stays alive past its original expiry
    // (expiry = last use + SESSION_TTL_MS).
    now += SESSION_TTL_MS - 1_000
    assert.ok(sessionRegistry.verify(localToken).actorFingerprint, 'the local-issued token slides')
    assert.ok(sessionRegistry.verify(challengeToken).actorFingerprint, 'the challenge-issued token slides')
    now += SESSION_TTL_MS - 2_000
    assert.ok(sessionRegistry.verify(localToken).actorFingerprint, 'activity slid the local expiry again')
    assert.ok(sessionRegistry.verify(challengeToken).actorFingerprint, 'activity slid the challenge expiry again')
    now += SESSION_TTL_MS
    assert.equal(sessionRegistry.verify(localToken).ok, false, 'idle expiry ends the local session')
    assert.equal(sessionRegistry.verify(challengeToken).ok, false, 'idle expiry ends the challenge session identically')

    // Revoke, identical for both paths: the same registry key discipline.
    const freshLocal = (await localExchange(server.port, dataDir, identity.publicKey)).json().result.session_token
    const freshChallenge = (await challengeAnswer(server.port, identity)).json().result.session_token
    assert.equal(sessionRegistry.revoke(sessionKeyFromToken(freshLocal)), true)
    assert.equal(sessionRegistry.verify(freshLocal).ok, false)
    assert.ok(sessionRegistry.verify(freshChallenge).actorFingerprint, 'the sibling path is untouched')
    assert.equal(sessionRegistry.revoke(sessionKeyFromToken(freshChallenge)), true)
    assert.equal(sessionRegistry.verify(freshChallenge).ok, false)

    stderrCaptures.push('')
  } finally {
    await server.close()
  }

  // Capacity is shared, not duplicated: a bound of 3 fills from BOTH paths
  // and the next issue evicts the oldest regardless of which path issued it.
  const smallHome = makeDataDir(t)
  const smallDataDir = makeDataDir(t)
  let smallNow = 1_000_000
  const smallRegistry = createSessionRegistry({ now: () => smallNow, maxSessions: 3 })
  const smallChallenges = createChallengeRegistry({ now: () => smallNow })
  const smallServer = await startServer({
    dataDir: smallDataDir,
    sessionRegistry: smallRegistry,
    challengeRegistry: smallChallenges,
  })
  try {
    const identity = makeInstallation(smallHome, 'inst', 'Capacity')
    const issuedTokens = []
    issuedTokens.push((await localExchange(smallServer.port, smallDataDir, identity.publicKey)).json().result.session_token)
    issuedTokens.push((await challengeAnswer(smallServer.port, identity)).json().result.session_token)
    issuedTokens.push((await localExchange(smallServer.port, smallDataDir, identity.publicKey)).json().result.session_token)
    for (const token of issuedTokens) assert.ok(smallRegistry.verify(token).actorFingerprint)
    const fourth = (await challengeAnswer(smallServer.port, identity)).json().result.session_token
    assert.equal(smallRegistry.verify(issuedTokens[0]).ok, false, 'the oldest session was evicted')
    assert.ok(smallRegistry.verify(issuedTokens[1]).actorFingerprint, 'the challenge-issued middle session survived')
    assert.ok(smallRegistry.verify(issuedTokens[2]).actorFingerprint)
    assert.ok(smallRegistry.verify(fourth).actorFingerprint)
    stderrCaptures.push('')
  } finally {
    await smallServer.close()
  }
})

test('startServer honors the challengeRegistry injection and refuses a malformed one (review triage)', async t => {
  const home = makeDataDir(t)
  const dataDir = makeDataDir(t)
  // A distinguishable registry: capacity 1, so the SECOND live challenge
  // evicts the first — observable through the real wire. A severed injection
  // (the option falling back to the process default) would keep both
  // nonces answerable and fail this row.
  const challengeRegistry = createChallengeRegistry({ maxPending: 1 })
  const server = await startServer({ dataDir, challengeRegistry })
  try {
    const identity = makeInstallation(home, 'inst', 'Injector')
    assert.equal((await localExchange(server.port, dataDir, identity.publicKey)).status, 200)

    const first = (await challenge(server.port, identity.publicKey)).json().result.nonce
    const second = (await challenge(server.port, identity.publicKey)).json().result.nonce
    assert.notEqual(first, second)

    const evicted = await answer(server.port, first, identity.sign(Buffer.from(first, 'base64url')))
    assert.equal(evicted.status, 401, 'the injected bound evicted the oldest pending nonce')
    assert.equal(evicted.json().error.code, 'challenge_invalid')
    const survived = await answer(server.port, second, identity.sign(Buffer.from(second, 'base64url')))
    assert.equal(survived.status, 200, 'the second nonce answers: the injected registry is the live one')

    stderrCaptures.push('')
  } finally {
    await server.close()
  }

  // Malformed wiring fails at startup with the coded shape error, never
  // per-request.
  await assert.rejects(
    () => startServer({ dataDir: makeDataDir(t), challengeRegistry: {} }),
    error => error instanceof AgentRoomRuntimeError
      && error.code === 'invalid_argument'
      && /challengeRegistry/.test(error.message),
  )
})

test('the four bounds refuse on the wire at their literal values (independent oracles, review triage)', async t => {
  const home = makeDataDir(t)
  const dataDir = makeDataDir(t)
  // The challenge registry's clock is injectable through startServer, so the
  // 60 s bound is exercised against literal clock offsets over real HTTP.
  let clock = 0
  const challengeRegistry = createChallengeRegistry({ now: () => clock })
  const server = await startServer({ dataDir, challengeRegistry })
  try {
    const identity = makeInstallation(home, 'inst', 'Oracle')
    assert.equal((await localExchange(server.port, dataDir, identity.publicKey)).status, 200)

    // Bound 1 on the wire: the nonce is exactly 43 characters of exactly
    // 32 bytes.
    const issued = (await challenge(server.port, identity.publicKey)).json().result.nonce
    assert.equal(issued.length, 43)
    assert.equal(Buffer.from(issued, 'base64url').length, 32)

    // Bound 2 on the wire: at the literal 60_000 ms bound the answer is
    // refused, and 59_999 ms after issue it is still accepted.
    clock = 60_000
    const late = await answer(server.port, issued, identity.sign(Buffer.from(issued, 'base64url')))
    assert.equal(late.status, 401, 'expired at exactly the literal 60_000 ms bound')
    assert.equal(late.json().error.code, 'challenge_invalid')

    clock = 100_000
    const inside = (await challenge(server.port, identity.publicKey)).json().result.nonce
    clock = 159_999 // exactly 59_999 ms after issue
    const justInside = await answer(server.port, inside, identity.sign(Buffer.from(inside, 'base64url')))
    assert.equal(justInside.status, 200, 'a challenge answered 59_999 ms after issue is alive')

    // Bound 3 on the wire: the exact replay of a successful answer yields no
    // second token.
    const replayed = await answer(server.port, inside, identity.sign(Buffer.from(inside, 'base64url')))
    assert.equal(replayed.status, 401)
    assert.equal(replayed.json().error.code, 'challenge_invalid')

    // Bound 4 on the wire: a decorated spelling of a real signature is
    // refused as a signature failure.
    clock = 200_000
    const nonce = (await challenge(server.port, identity.publicKey)).json().result.nonce
    const canonical = identity.sign(Buffer.from(nonce, 'base64url'))
    assert.equal(canonical.length, 86, 'the shipped signer emits the canonical 86-character form')
    const decorated = await answer(server.port, nonce, `${canonical}###`)
    assert.equal(decorated.status, 401)
    assert.equal(decorated.json().error.code, 'signature_invalid')

    stderrCaptures.push('')
  } finally {
    await server.close()
  }
})

test('the declared-remote client runs the challenge lane end to end; the local lane is byte-identical (row 10)', async t => {
  const parent = makeDataDir(t, 'agent-room-challenge-client-')
  const sharedData = join(parent, 'shared')
  mkdirSync(sharedData, { recursive: true, mode: 0o700 })

  const remoteOption = makeInstallation(parent, 'remote-opt', 'RemoteOpt')
  const remoteEnv = makeInstallation(parent, 'remote-env', 'RemoteEnv')
  const localLane = makeInstallation(parent, 'local-lane', 'LocalLane')
  const ghost = makeInstallation(parent, 'ghost', 'Ghost')

  const { waitReady, stop, stderrText } = spawnServerChild(t, sharedData)
  const record = await waitReady()

  // The two declared-remote installations enroll ONCE through the shipped
  // local exchange (the story's only enrollment writer) before their clients
  // ever run; from then on they prove possession over the challenge lane.
  for (const installation_ of [remoteOption, remoteEnv]) {
    const enrolled = await localExchange(record.port, sharedData, installation_.publicKey)
    assert.equal(enrolled.status, 200, installation_.chatId)
  }

  captureRequests(t)
  // The client phase starts here: the pre-enrollment exchanges above used the
  // direct helper and are deliberately outside the client-truth scope.
  const clientPhaseStart = wireCaptures.length

  // The undeclared local lane keeps its byte-identical exchange.
  const localClient = createAgentRoomClient({ dataDir: sharedData, pluginDataDir: localLane.pluginData })
  const localPresence = await localClient.presence()
  assert.equal(localClient.transport, 'local', 'the earned local mark')

  // The declared-remote client (option form) authenticates through
  // challenge-answer only.
  const optionClient = createAgentRoomClient({
    dataDir: sharedData,
    pluginDataDir: remoteOption.pluginData,
    connectionMode: 'remote',
  })
  const optionPresence = await optionClient.presence()
  assert.equal(optionClient.transport, 'remote', 'the transport mark is earned by the challenge exchange')

  // The declared-remote client (env seam form) behaves identically.
  const previousEnv = process.env[CONNECTION_MODE_ENV]
  process.env[CONNECTION_MODE_ENV] = 'remote'
  let envClient
  try {
    envClient = createAgentRoomClient({ dataDir: sharedData, pluginDataDir: remoteEnv.pluginData })
  } finally {
    if (previousEnv === undefined) delete process.env[CONNECTION_MODE_ENV]
    else process.env[CONNECTION_MODE_ENV] = previousEnv
  }
  const envPresence = await envClient.presence()
  assert.equal(envClient.transport, 'remote')

  // All three sessions bound with the closed-set MCP client type and are
  // online, each carrying its own installation's fingerprint.
  const presenceRows = new Map(optionPresence.online.map(row => [row.chat_id, row]))
  assert.ok(presenceRows.get('RemoteOpt'))
  assert.equal(presenceRows.get('RemoteOpt').client_type, 'mcp')
  assert.equal(presenceRows.get('RemoteOpt').fingerprint, remoteOption.fingerprint)
  const envRows = new Map(envPresence.online.map(row => [row.chat_id, row]))
  assert.ok(envRows.get('RemoteEnv'))
  assert.equal(envRows.get('RemoteEnv').fingerprint, remoteEnv.fingerprint)
  const localRows = new Map(localPresence.online.map(row => [row.chat_id, row]))
  assert.ok(localRows.get('LocalLane'))
  assert.equal(localRows.get('LocalLane').fingerprint, localLane.fingerprint)

  // The wire truth, from the captured traffic: no declared-remote
  // installation ever presented the local token file, and the local lane's
  // own exchange is byte-identical to today's (Bearer credential + exactly
  // the public_key field). Assertions scope to the client phase — the
  // pre-enrollment exchanges above ran through the direct helper on purpose.
  const authTraffic = wireCaptures.slice(clientPhaseStart).filter(entry => entry.path.startsWith('/api/auth/'))
  const localCallsFor = publicKey => authTraffic.filter(entry =>
    entry.path === '/api/auth/local' && entry.requestBody.includes(publicKey))
  const laneLocal = localCallsFor(localLane.publicKey)
  assert.equal(laneLocal.length, 1, `the local-lane client exchanged exactly once (found ${laneLocal.length})`)
  assert.match(laneLocal[0].requestHeaders.authorization, /^Bearer /)
  assert.deepEqual(Object.keys(JSON.parse(laneLocal[0].requestBody)), ['public_key'])
  assert.deepEqual(JSON.parse(laneLocal[0].requestBody), { public_key: localLane.publicKey })
  assert.equal(localCallsFor(remoteOption.publicKey).length, 0, 'the option-declared client never sent a local exchange')
  assert.equal(localCallsFor(remoteEnv.publicKey).length, 0, 'the env-declared client never sent a local exchange')
  assert.equal(localCallsFor(ghost.publicKey).length, 0, 'the ghost installation never sent a local exchange')
  for (const lane of [remoteOption, remoteEnv]) {
    const laneChallenges = authTraffic.filter(entry =>
      entry.path === '/api/auth/challenge' && JSON.parse(entry.requestBody).public_key === lane.publicKey)
    assert.equal(laneChallenges.length, 1, `${lane.chatId}: exactly one challenge`)
    assert.deepEqual(Object.keys(JSON.parse(laneChallenges[0].requestBody)), ['public_key'])
    const laneNonce = JSON.parse(laneChallenges[0].responseBody).result.nonce
    const laneAnswer = authTraffic.find(entry =>
      entry.path === '/api/auth/answer' && JSON.parse(entry.requestBody).nonce === laneNonce)
    assert.ok(laneAnswer, `${lane.chatId}: the answer rode the challenge's nonce`)
    assert.deepEqual(Object.keys(JSON.parse(laneAnswer.requestBody)).sort(), ['nonce', 'signature'])
  }

  // Bind + send + read work over the earned session, and the two lanes
  // exchange DMs.
  const dm = await optionClient.directOpen({ chatId: 'LocalLane' })
  const sent = await optionClient.sendMessage({ roomId: dm.room_id, clientMessageId: 'remote-1', text: 'from the remote lane Ω' })
  assert.equal(sent.status, 'committed')
  const localRead = await localClient.readMessage({ roomId: dm.room_id })
  assert.equal(localRead.messages.length, 1)
  assert.match(localRead.messages[0].text, /from the remote lane Ω/, 'the local lane reads the remote sender inside the envelope')
  const reply = await localClient.sendMessage({ roomId: dm.room_id, clientMessageId: 'local-1', text: 'from the local lane β' })
  assert.equal(reply.status, 'committed')
  const remoteRead = await optionClient.readMessage({ roomId: dm.room_id, afterSeq: 0 })
  assert.equal(remoteRead.messages.length, 2)
  assert.match(remoteRead.messages[1].text, /from the local lane β/, 'the remote lane reads the local sender')

  // A declared-remote installation that was never enrolled surfaces the coded
  // gate on the tool path — never a silent fallback to the local token file.
  const ghostClient = createAgentRoomClient({
    dataDir: sharedData,
    pluginDataDir: ghost.pluginData,
    connectionMode: 'remote',
  })
  await assert.rejects(
    () => ghostClient.presence(),
    error => error instanceof AgentRoomRuntimeError && error.code === 'not_enrolled',
  )
  assert.equal(ghostClient.transport, 'remote', 'a failed challenge never reads as local')

  stderrCaptures.push(stderrText())
  await stop()
})

test('a declared-remote client attaches with no local-token request on any path, half-stale reuse included (row 10, review triage)', async t => {
  const parent = makeDataDir(t, 'agent-room-challenge-attach-')
  const sharedData = join(parent, 'shared')
  mkdirSync(sharedData, { recursive: true, mode: 0o700 })
  // Never enrolled: the attach itself must succeed on the health+version
  // proof alone, and the honest coded refusal proves the challenge lane ran
  // (an attach that fell back to a local exchange would 200 instead).
  const identity = makeInstallation(parent, 'remote', 'Attacher')

  const { waitReady, stop, stderrText } = spawnServerChild(t, sharedData)
  const record = await waitReady()
  // A fresh shared dir: no client has run here, so no local credential
  // exists — and none may appear from a declared-remote bootstrap.
  assert.equal(existsSync(localTokenPath(sharedData)), false)

  captureRequests(t)

  // Leg 1 — the healthy-record attach (live pid): no credential proof exists
  // on this path at all, and the bootstrap must not create the token file.
  const healthyLegStart = wireCaptures.length
  const healthyClient = createAgentRoomClient({
    dataDir: sharedData,
    pluginDataDir: identity.pluginData,
    connectionMode: 'remote',
  })
  await assert.rejects(
    () => healthyClient.presence(),
    error => error instanceof AgentRoomRuntimeError && error.code === 'not_enrolled',
  )
  assert.equal(healthyClient.transport, 'remote')
  let authTraffic = wireCaptures.slice(healthyLegStart).filter(entry => entry.path.startsWith('/api/auth/'))
  assert.equal(authTraffic.filter(entry => entry.path === '/api/auth/local').length, 0,
    'the healthy attach presented no local token')
  assert.equal(authTraffic.filter(entry => entry.path === '/api/auth/challenge').length, 1)
  assert.equal(authTraffic.filter(entry => entry.path === '/api/auth/answer').length, 1)
  assert.equal(existsSync(localTokenPath(sharedData)), false, 'no local token file was created')

  // Leg 2 — the half-stale reuse attach (dead pid, live port): the local-mode
  // bootstrap proves reuse with a POST /api/auth/local carrying the shared
  // token; the declared-remote bootstrap must skip it entirely — the reuse
  // proof is the health+version check only.
  const staleLegStart = wireCaptures.length
  atomicWriteJson(join(sharedData, RUNTIME_RECORD_FILENAME), {
    pid: await deadPid(),
    port: record.port,
    version: record.version,
  })
  const staleClient = createAgentRoomClient({
    dataDir: sharedData,
    pluginDataDir: identity.pluginData,
    connectionMode: 'remote',
  })
  await assert.rejects(
    () => staleClient.presence(),
    error => error instanceof AgentRoomRuntimeError && error.code === 'not_enrolled',
  )
  authTraffic = wireCaptures.slice(staleLegStart).filter(entry => entry.path.startsWith('/api/auth/'))
  assert.equal(authTraffic.filter(entry => entry.path === '/api/auth/local').length, 0,
    'the half-stale reuse presented no local token — no credential on any attach path')
  assert.equal(authTraffic.filter(entry => entry.path === '/api/auth/challenge').length, 1)
  assert.equal(authTraffic.filter(entry => entry.path === '/api/auth/answer').length, 1)
  assert.equal(existsSync(localTokenPath(sharedData)), false, 'still no local token file')

  // The bootstrap engine itself refuses a declared 'local': only 'remote' is
  // declarable — 'local' is earned by the local exchange, never declared.
  await assert.rejects(
    () => ensureServer({ dataDir: makeDataDir(t), connectionMode: 'local' }),
    error => error instanceof AgentRoomRuntimeError && error.code === 'invalid_argument',
  )

  stderrCaptures.push(stderrText())
  await stop()
})

test('a keypair replaced mid-flight recovers with the fresh identity instead of wedging (review triage)', async t => {
  const home = makeDataDir(t)
  const dataDir = makeDataDir(t)
  const identity = makeInstallation(home, 'inst', 'Replaced')
  let server = await startServer({ dataDir })
  // Whatever the assertions do from here, the running server must not keep
  // the event loop alive (close is idempotent; the test body also closes).
  t.after(async () => { try { await server.close() } catch { /* already closed */ } })
  assert.equal((await localExchange(server.port, dataDir, identity.publicKey)).status, 200)
  const client = createAgentRoomClient({
    dataDir,
    pluginDataDir: identity.pluginData,
    connectionMode: 'remote',
  })
  const first = await client.presence()
  assert.ok(Array.isArray(first.online), 'the client is live')

  // The identity key is replaced while the client is live, and the fresh key
  // enrolls: the client must recover as the NEW Actor. Before the review fix
  // this exact sequence wedged forever — the challenge rode the cached OLD
  // key while the signature came from the NEW key file, so every re-auth
  // failed signature_invalid.
  const replacement = generateKeyPairSync('ed25519')
  const replacementPem = replacement.privateKey.export({ type: 'pkcs8', format: 'pem' })
  writeFileSync(identity.keyPath, replacementPem, { mode: 0o600 })
  knownPrivatePems.push(replacementPem)
  const replacementSpki = replacement.publicKey.export({ type: 'spki', format: 'der' })
  const freshRaw = replacementSpki.subarray(replacementSpki.length - 32)
  const freshFingerprint = fingerprintFromPublicKey(freshRaw)
  assert.notEqual(freshFingerprint, identity.fingerprint, 'a genuinely new Actor')
  assert.equal((await localExchange(server.port, dataDir, freshRaw.toString('base64url'))).status, 200)

  // Every live session dies with the server process; the next client call
  // must re-authenticate — and recover on the fresh identity.
  await server.close()
  server = await startServer({ dataDir })
  try {
    const recovered = await client.presence()
    assert.ok(Array.isArray(recovered.online), 'the client recovered after the identity change')
    assert.equal(client.fingerprint, freshFingerprint, 'the client now carries the fresh identity')
    const online = recovered.online.find(row => row.chat_id === identity.chatId)
    assert.ok(online, 'the fresh Actor is present')
    assert.equal(online.fingerprint, freshFingerprint)
    stderrCaptures.push('')
  } finally {
    await server.close()
  }
})

test('a keypair replaced mid-flight without enrollment surfaces the coded gate and terminates (review triage)', async t => {
  const home = makeDataDir(t)
  const dataDir = makeDataDir(t)
  const identity = makeInstallation(home, 'inst', 'Unenrolled')
  let server = await startServer({ dataDir })
  // Whatever the assertions do from here, the running server must not keep
  // the event loop alive (close is idempotent; the test body also closes).
  t.after(async () => { try { await server.close() } catch { /* already closed */ } })
  assert.equal((await localExchange(server.port, dataDir, identity.publicKey)).status, 200)
  const client = createAgentRoomClient({
    dataDir,
    pluginDataDir: identity.pluginData,
    connectionMode: 'remote',
  })
  await client.presence()

  // Replace the identity and enroll NOTHING: the fresh Actor's honest coded
  // refusal must surface — and the call must terminate, never loop.
  const replacement = generateKeyPairSync('ed25519')
  const replacementPem = replacement.privateKey.export({ type: 'pkcs8', format: 'pem' })
  writeFileSync(identity.keyPath, replacementPem, { mode: 0o600 })
  knownPrivatePems.push(replacementPem)
  const replacementSpki = replacement.publicKey.export({ type: 'spki', format: 'der' })
  const freshFingerprint = fingerprintFromPublicKey(replacementSpki.subarray(replacementSpki.length - 32))

  await server.close()
  server = await startServer({ dataDir })
  try {
    await assert.rejects(
      () => client.presence(),
      error => error instanceof AgentRoomRuntimeError && error.code === 'not_enrolled',
    )
    assert.equal(client.fingerprint, freshFingerprint, 'the surfaced identity is the fresh one')
    stderrCaptures.push('')
  } finally {
    await server.close()
  }
})

test('plugin-data deletion creates a new, unrelated Actor with no inherited rooms or trust (row 12, FR-3)', async t => {
  const parent = makeDataDir(t, 'agent-room-challenge-fr3-')
  const sharedData = join(parent, 'shared')
  mkdirSync(sharedData, { recursive: true, mode: 0o700 })

  const oldInstall = makeInstallation(parent, 'old', 'Old')
  const peer = makeInstallation(parent, 'peer', 'Peer')

  const { waitReady, stop, stderrText } = spawnServerChild(t, sharedData)
  const record = await waitReady()

  // The old Actor enrolls, binds, holds a DM with Peer, and an allowlist
  // entry lives in its PLUGIN_DATA.
  assert.equal((await localExchange(record.port, sharedData, oldInstall.publicKey)).status, 200)
  assert.equal((await localExchange(record.port, sharedData, peer.publicKey)).status, 200)
  const oldToken = (await localExchange(record.port, sharedData, oldInstall.publicKey)).json().result.session_token
  const peerToken = (await localExchange(record.port, sharedData, peer.publicKey)).json().result.session_token
  const bind = async (token, chatId) => request(record.port, 'POST', '/api/session', {
    headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ chat_id: chatId }),
  })
  assert.equal((await bind(oldToken, 'Old')).status, 200)
  assert.equal((await bind(peerToken, 'Peer')).status, 200)
  const dm = await request(record.port, 'POST', '/api/rooms/direct', {
    headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${oldToken}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ chat_id: 'Peer' }),
  })
  assert.equal(dm.status, 200)
  const dmRoomId = dm.json().result.room_id
  const sent = await request(record.port, 'POST', `/api/rooms/${dmRoomId}/messages`, {
    headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${peerToken}`, 'content-type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ chat_id: 'Peer', client_message_id: 'fr3-1', text: 'a message the new Actor must never inherit' }),
  })
  assert.equal(sent.status, 200)
  const status = await request(record.port, 'GET', '/api/status', {
    headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${oldToken}` },
  })
  const realmId = status.json().result.realm_id
  const realmsDir = join(oldInstall.pluginData, 'realms', realmId)
  mkdirSync(realmsDir, { recursive: true, mode: 0o700 })
  atomicWriteJson(join(realmsDir, 'allowlist.json'), {
    version: 1,
    accept_all: false,
    entries: [{ fingerprint: peer.fingerprint, added_at: new Date().toISOString() }],
  })
  assert.equal(existsSync(join(realmsDir, 'allowlist.json')), true)

  // The installation deletes its PLUGIN_DATA: fresh dir, fresh keypair.
  rmSync(oldInstall.pluginData, { recursive: true, force: true })
  mkdirSync(oldInstall.pluginData, { recursive: true, mode: 0o700 })
  const fresh = makeInstallation(parent, 'old', 'Old') // same path, new identity
  assert.notEqual(fresh.fingerprint, oldInstall.fingerprint, 'the fresh keypair is a new, unrelated Actor')

  // The new fingerprint is not enrolled: the challenge path answers
  // not_enrolled until its own enrollment.
  const notYet = await challengeAnswer(record.port, fresh)
  assert.equal(notYet.status, 403)
  assert.equal(notYet.json().error.code, 'not_enrolled')

  // Once enrolled (the local exchange's success path), the new Actor's room
  // list carries ONLY the Broadcast Room — none of the old Actor's DMs.
  assert.equal((await localExchange(record.port, sharedData, fresh.publicKey)).status, 200)
  const freshToken = (await localExchange(record.port, sharedData, fresh.publicKey)).json().result.session_token
  const rooms = await request(record.port, 'GET', '/api/rooms', {
    headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${freshToken}` },
  })
  assert.equal(rooms.status, 200)
  const freshRooms = rooms.json().result.rooms
  assert.equal(freshRooms.length, 1, 'exactly the Broadcast Room')
  assert.equal(freshRooms[0].kind, 'broadcast')
  assert.notEqual(freshRooms[0].room_id, dmRoomId, 'none of the old Actor\'s DMs are inherited')

  // The fresh PLUGIN_DATA carries no realms/ trust state, and exactly one
  // keypair file exists at 0600 (the file-level invariants tests/keys.test.mjs
  // pins, proven here at the room/trust layer).
  assert.equal(existsSync(join(oldInstall.pluginData, 'realms')), false, 'no realms/ trust state in the fresh installation')
  assert.deepEqual(readdirSync(oldInstall.pluginData).sort(), ['config.json', 'identity.key'])
  assert.equal(statSync(fresh.keyPath).mode & 0o777, 0o600)

  stderrCaptures.push(stderrText())
  await stop()
})

test('NFR-3 mirrored at the wire: no body field asserts sender authority (row 13)', async t => {
  const home = makeDataDir(t)
  const dataDir = makeDataDir(t)
  const server = await startServer({ dataDir })
  try {
    const identity = makeInstallation(home, 'inst', 'Authority')
    const foreignFingerprint = `sha256:${'b'.repeat(64)}`
    assert.equal((await localExchange(server.port, dataDir, identity.publicKey)).status, 200)
    const token = (await localExchange(server.port, dataDir, identity.publicKey)).json().result.session_token
    assert.equal((await request(server.port, 'POST', '/api/session', {
      headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ chat_id: 'Authority' }),
    })).status, 200)

    const headers = { [PROTOCOL_KEY]: '1', authorization: `Bearer ${token}`, 'content-type': 'application/json; charset=utf-8' }

    // The session route admits no actor_fingerprint: identity derives from
    // the token.
    const sessionSmuggle = await request(server.port, 'POST', '/api/session', {
      headers,
      body: JSON.stringify({ chat_id: 'Authority', actor_fingerprint: foreignFingerprint }),
    })
    assert.equal(sessionSmuggle.status, 400)
    assert.equal(sessionSmuggle.json().error.code, 'unknown_field')
    assert.match(sessionSmuggle.json().error.message, /actor_fingerprint/)

    // The send route admits no sender_fingerprint, and still refuses a
    // chat_id that does not match the live session row.
    const rooms = await request(server.port, 'GET', '/api/rooms', { headers })
    const broadcastRoomId = rooms.json().result.rooms.find(room => room.kind === 'broadcast').room_id
    const sendSmuggle = await request(server.port, 'POST', `/api/rooms/${broadcastRoomId}/messages`, {
      headers,
      body: JSON.stringify({ chat_id: 'Authority', client_message_id: 'nfr3-1', text: 'honest body', sender_fingerprint: foreignFingerprint }),
    })
    assert.equal(sendSmuggle.status, 400)
    assert.equal(sendSmuggle.json().error.code, 'unknown_field')
    assert.match(sendSmuggle.json().error.message, /sender_fingerprint/)
    const wrongName = await request(server.port, 'POST', `/api/rooms/${broadcastRoomId}/messages`, {
      headers,
      body: JSON.stringify({ chat_id: 'NotMine', client_message_id: 'nfr3-2', text: 'attributed to another name' }),
    })
    assert.equal(wrongName.status, 400)
    assert.equal(wrongName.json().error.code, 'invalid_request')
    assert.match(wrongName.json().error.message, /does not match this session/)

    // The answer route's frozen field set admits no public_key: the
    // smuggling attempt is an unknown_field rejection before any consume —
    // the nonce is not even spent.
    const nonce = (await challenge(server.port, identity.publicKey)).json().result.nonce
    const before = hashState(dataDir)
    const answerSmuggle = await request(server.port, 'POST', '/api/auth/answer', {
      headers: { [PROTOCOL_KEY]: '1', 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ nonce, signature: identity.sign(Buffer.from(nonce, 'base64url')), public_key: identity.publicKey }),
    })
    assert.equal(answerSmuggle.status, 400)
    assert.equal(answerSmuggle.json().error.code, 'unknown_field')
    assert.match(answerSmuggle.json().error.message, /public_key/)
    assert.equal(hashState(dataDir), before, 'the smuggled answer changed no state — the nonce was never consumed')

    stderrCaptures.push('')
  } finally {
    await server.close()
  }
})

test('the private key never travels: counted scans of every captured body and every server stderr line (row 11)', async t => {
  t.diagnostic(`row 11 counted scans: ${wireCaptures.length} wire captures, ${stderrCaptures.length} stderr captures`)
  // The accumulators hold the whole story's traffic: every request/response
  // body this file drove (direct HTTP and the real api-client via the
  // observation seam) and every spawned server's stderr.
  assert.ok(wireCaptures.length >= 10, `expected real captured traffic, found ${wireCaptures.length} entries`)
  assert.ok(stderrCaptures.length >= 5, `expected server stderr from the spawned children, found ${stderrCaptures.length}`)
  assert.ok(knownPrivatePems.length >= 5, `expected the installations' real PEM bytes as needles, found ${knownPrivatePems.length}`)

  // Counted scans (the evidence note reports these numbers): PEM markers and
  // every actual base64 body line of every installation's real private key,
  // across every captured request body, response body, and stderr capture.
  const needles = ['PRIVATE KEY', 'BEGIN OPENSSH PRIVATE KEY', 'END PRIVATE KEY']
  for (const pem of knownPrivatePems) {
    for (const line of pem.split('\n')) {
      if (line.length >= 20 && !line.startsWith('-----')) needles.push(line)
    }
  }
  let countedOccurrences = 0
  for (const needle of needles) {
    for (const capture of wireCaptures) {
      if (capture.requestBody.includes(needle)) countedOccurrences += 1
      if (capture.responseBody.includes(needle)) countedOccurrences += 1
    }
    for (const stderr of stderrCaptures) {
      if (stderr.includes(needle)) countedOccurrences += 1
    }
  }
  assert.equal(
    countedOccurrences,
    0,
    `key material appeared ${countedOccurrences} times across ${wireCaptures.length} wire captures and ${stderrCaptures.length} stderr captures (${needles.length} needles)`,
  )

  // The auth wire carries exactly the frozen vocabulary — every field ever
  // seen on an auth request or response is one of public_key, nonce,
  // signature, session_token (row 13's smuggled attempt carries only those
  // too, and the server rejects it).
  const authCaptures = wireCaptures.filter(entry => entry.path.startsWith('/api/auth/'))
  assert.ok(authCaptures.length >= 10, `expected the auth exchanges in the capture, found ${authCaptures.length}`)
  const requestFieldSets = new Set()
  const responseFieldSets = new Set()
  for (const capture of authCaptures) {
    if (capture.requestBody.length > 0) {
      const keys = Object.keys(JSON.parse(capture.requestBody)).sort().join(',')
      if (keys !== '') requestFieldSets.add(keys)
    }
    let parsedResponse = null
    try { parsedResponse = JSON.parse(capture.responseBody) } catch { /* non-JSON body */ }
    if (parsedResponse?.ok === true && parsedResponse.result) {
      responseFieldSets.add(Object.keys(parsedResponse.result).sort().join(','))
    }
  }
  const wireFields = new Set()
  for (const fields of requestFieldSets) {
    for (const field of fields.split(',')) wireFields.add(field)
  }
  for (const fields of responseFieldSets) {
    for (const field of fields.split(',')) wireFields.add(field)
  }
  assert.deepEqual([...wireFields].sort(), ['nonce', 'public_key', 'session_token', 'signature'],
    'only the four frozen auth fields ever ride the auth wire')
})
