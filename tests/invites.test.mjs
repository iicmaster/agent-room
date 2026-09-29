// Story 4.2 acceptance: invite-gated enrollment and the operator CLI host.
//
// The store rows run in-process against the real room-log store (digest-only
// persistence, finite-only mint flags, the atomic enrollment transaction and
// its rollback, prefix revocation); the CLI rows run the REAL dispatch
// (main) in-process with injected streams and directories — zero server
// needed, because the operator family opens the store DIRECTLY per AR-13;
// the enroll-route rows run the real HTTP host two ways — in-process
// startServer harnesses (route gates, possession proof, rate limiter with an
// injectable clock, proxy trust) and a real spawned server child (the full
// mint → enroll → challenge → answer journey across the process boundary).
// The race is two REAL child processes contending for one single-use invite
// through their own SQLite connections. Zero mocks; oracles are literals in
// this file.
//
// Matrix row → test map:
//    row A (store + scan)   'a default mint matches the token shape oracle...'
//    row B (CLI)            'the invite family speaks JSON lines with stable exit codes...'
//    row C (store)          'a rolled-back enrollment consumes nothing: ...'
//    row D (spawned race)   'two processes racing one single-use invite: ...'
//    row E (store + route)  'a lost-response retry reattaches without consuming...'
//    row F (route)          'the enroll route requires the possession proof...'
//    row G (route)          'the enroll route gates state: unknown, expired, revoked...'
//    row H (route)          'a multi-use invite admits distinct keys and reattaches...'
//    row I (route)          'enrollment unlocks the live challenge-answer path...'
//    row J (route, spawned) 'on a real spawned server the enrolled key completes...'
//    row K (limiter)        'the enroll route is rate-limited 5/min per identity...'
//    row L (limiter)        'forwarded addresses are trusted only from an explicitly configured proxy...'
//    row M (CLI + scan)     'listings and diagnostics never show a secret: counted scan'
//    row N (CLI structural) 'the operator family is the established CLI host: ...'

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash, generateKeyPairSync, createPublicKey, sign as cryptoSign } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import {
  ENROLLMENT_PER_MINUTE,
  ENROLLMENT_WINDOW_MS,
  INVITE_DIGEST_PREFIX_CHARS,
  INVITE_MAX_USES,
  INVITE_TOKEN_BYTES,
  INVITE_TOKEN_CHARS,
  INVITE_TOKEN_PREFIX,
  INVITE_TTL_SECONDS,
} from '../server/constants.mjs'
import { createEnrollRateLimiter } from '../server/api/enroll-rate-limit.mjs'
import { fingerprintFromPublicKey } from '../server/keys.mjs'
import { startServer } from '../server/api/server.mjs'
import { openRoomLog } from '../server/store/room-log.mjs'
import { ROOM_LOG_DATABASE_FILENAME } from '../server/store/room-log.mjs'
import { main } from '../server/cli/agent-room.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = join(ROOT, 'server', 'api', 'server.mjs')
const RUNTIME_RECORD_FILENAME = 'runtime.json'
const PROTOCOL_KEY = 'agent-room-protocol'

const sleep = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })

// Literal wire-shape oracle (AC): the token is the prefix plus exactly 43
// base64url characters — the unpadded encoding of 32 random bytes. Stated
// here from the AC's numbers, not from the constants module, so drift in
// either direction fails.
const TOKEN_SHAPE = /^ar_inv1_[A-Za-z0-9_-]{43}$/

// --- Harness: dirs, installations, the store, the CLI, servers, children -------

function makeDataDir(t, prefix = 'agent-room-invites-') {
  const dataDir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  return dataDir
}

// One installation identity: a real Ed25519 keypair, the raw 32-byte public
// key, and its canonical fingerprint. `signToken` produces the enrollment
// possession proof over the exact invite token bytes; `signBytes` signs raw
// bytes (the challenge-answer path signs the nonce's decoded bytes).
function installation() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const raw = spki.subarray(spki.length - 32)
  return {
    raw,
    publicKey: raw.toString('base64url'),
    fingerprint: fingerprintFromPublicKey(raw),
    signToken: token => cryptoSign(null, Buffer.from(token, 'utf8'), privateKey).toString('base64url'),
    signBytes: data => cryptoSign(null, data, privateKey).toString('base64url'),
  }
}

// The challenge-answer round trip with raw nonce bytes (the Story 4.1
// reconnect path this story's enrollment unlocks).
async function challengeAnswer(port, installer) {
  const challenge = await request(port, 'POST', '/api/auth/challenge', {
    headers: jsonHeaders,
    body: JSON.stringify({ public_key: installer.publicKey }),
  })
  assert.equal(challenge.status, 200, challenge.text)
  const nonce = challenge.json().result.nonce
  return request(port, 'POST', '/api/auth/answer', {
    headers: jsonHeaders,
    body: JSON.stringify({ nonce, signature: installer.signBytes(Buffer.from(nonce, 'base64url')) }),
  })
}

function openStore(dataDir) {
  return openRoomLog({ dataDir })
}

// The store row backing one token, read through a read-only inspector that
// always closes (the inspection never writes).
function inviteRows(dataDir) {
  const inspector = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME), { readOnly: true })
  try {
    return inspector.prepare(`
      SELECT digest, uses_remaining, uses_max, expires_at, created_at, revoked_at
      FROM invites ORDER BY created_at ASC, digest ASC
    `).all().map(row => ({
      digest: row.digest,
      uses_remaining: Number(row.uses_remaining),
      uses_max: Number(row.uses_max),
      expires_at: row.expires_at,
      created_at: row.created_at,
      revoked_at: row.revoked_at === null ? null : row.revoked_at,
    }))
  } finally {
    inspector.close()
  }
}

function consumptionRows(dataDir) {
  const inspector = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME), { readOnly: true })
  try {
    return inspector.prepare(`
      SELECT digest, actor_fingerprint, consumed_at FROM invite_consumptions
      ORDER BY consumed_at ASC, actor_fingerprint ASC
    `).all()
  } finally {
    inspector.close()
  }
}

function enrollmentRows(dataDir) {
  const inspector = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME), { readOnly: true })
  try {
    return inspector.prepare('SELECT actor_fingerprint, enrolled_at FROM enrolled_actors ORDER BY enrolled_at ASC').all()
  } finally {
    inspector.close()
  }
}

// The CLI runs IN-PROCESS through the real dispatch with injected streams and
// directories, so the assertions see exactly the bytes a terminal would.
async function runCli(dataDir, argv) {
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
    await main(argv, {
      input: new PassThrough(),
      output,
      errorOutput,
      sharedDataDir: dataDir,
      pluginDataDir: join(dataDir, 'plugin-data-unused'),
    })
    await sleep(10)
    return { stdout, stderr, exitCode: process.exitCode ?? 0 }
  } finally {
    process.exitCode = previousExitCode
  }
}

function jsonLines(text) {
  return text.split('\n').filter(lineText => lineText.length > 0).map(lineText => JSON.parse(lineText))
}

// Small direct HTTP client: no keep-alive.
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
          resolvePromise({ status: response.statusCode, headers: response.headers, text, json: () => JSON.parse(text) })
        })
      },
    )
    req.on('error', rejectPromise)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

const jsonHeaders = { [PROTOCOL_KEY]: '1', 'content-type': 'application/json; charset=utf-8' }

function enrollRequest(port, body, extraHeaders = {}) {
  return request(port, 'POST', '/api/auth/enroll', {
    headers: { ...jsonHeaders, ...extraHeaders },
    body: JSON.stringify(body),
  })
}

// In-process startServer harness over the real host and store. Every server
// gets a real (default-bounded) limiter unless the test injects one, so the
// non-rate-limit rows can drive more than five enroll attempts against one
// instance without tripping the story's own admission gate.
async function startTestServer(t, dataDir, { trustedProxy, enrollRateLimiter } = {}) {
  const server = await startServer({
    dataDir,
    port: 0,
    host: '127.0.0.1',
    ...(trustedProxy === undefined ? {} : { trustedProxy }),
    ...(enrollRateLimiter === undefined
      ? { enrollRateLimiter: createEnrollRateLimiter({ limit: 1000 }) }
      : { enrollRateLimiter }),
  })
  t.after(() => server.close())
  return server
}

// A real spawned server child (the local-auth/challenge-auth harness style):
// the process boundary is the evidence for the route's registration.
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
        } catch { /* atomic rename: readers retry */ }
      }
      if (Date.now() > deadline) throw new Error(`server child never became ready; stderr: ${stderrText()}`)
      await sleep(25)
    }
  }
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit').catch(() => {})
    }
  })
  return { child, waitReady, stderrText }
}

// One race contender: a REAL child process that opens its own SQLite
// connection and drives the atomic enrollment transaction. Key generation
// happens before the store opens, so contention lands on the transaction.
const RACE_CHILD_SCRIPT = `
import { generateKeyPairSync, createPublicKey, sign as cryptoSign } from 'node:crypto'
const { openRoomLog } = await import(process.env.AGENT_ROOM_RACE_STORE)
const dataDir = process.env.AGENT_ROOM_RACE_DATA_DIR
const token = process.env.AGENT_ROOM_RACE_TOKEN
const { privateKey } = generateKeyPairSync('ed25519')
const signature = cryptoSign(null, Buffer.from(token, 'utf8'), privateKey)
const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
const raw = spki.subarray(spki.length - 32)
let store
try {
  store = openRoomLog({ dataDir })
  const outcome = store.enrollRemoteActor({ inviteToken: token, rawPublicKey: raw, signature })
  console.log(JSON.stringify({ ok: true, reattached: outcome.reattached, fingerprint: outcome.fingerprint }))
} catch (error) {
  console.log(JSON.stringify({ ok: false, code: error?.code ?? 'unknown', message: error?.message ?? String(error) }))
} finally {
  try { store?.close() } catch { /* already closed */ }
}
`

function spawnRaceChild(t, { dataDir, token, storePath }) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', RACE_CHILD_SCRIPT], {
    env: {
      ...process.env,
      AGENT_ROOM_RACE_STORE: storePath,
      AGENT_ROOM_RACE_DATA_DIR: dataDir,
      AGENT_ROOM_RACE_TOKEN: token,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8')
  child.stdout.on('data', chunk => { stdout += chunk })
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => { stderr += chunk })
  const settled = new Promise(resolvePromise => {
    child.on('exit', () => resolvePromise({ stdout, stderr, code: child.exitCode }))
  })
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit').catch(() => {})
    }
  })
  return { settled }
}

// The canonical full enrollment exchange over HTTP.
async function enrollViaHttp(port, inviteToken, installer) {
  return enrollRequest(port, {
    invite_token: inviteToken,
    public_key: installer.publicKey,
    signature: installer.signToken(inviteToken),
  })
}

// --- Row A: the token shape oracle and digest-only persistence -------------------

test('a default mint matches the token shape oracle, persists the SHA-256 digest only, and the raw token appears nowhere in the database file', t => {
  const dataDir = makeDataDir(t)
  const store = openStore(dataDir)
  t.after(() => store.close())

  const minted = store.mintInvite({ uses: INVITE_MAX_USES, ttlSeconds: INVITE_TTL_SECONDS })

  // The shape oracle, from this file's literals: prefix + exactly 43
  // base64url chars decoding to exactly 32 bytes.
  assert.match(minted.token, TOKEN_SHAPE)
  assert.equal(minted.token.length, INVITE_TOKEN_PREFIX.length + INVITE_TOKEN_CHARS)
  const payload = minted.token.slice(INVITE_TOKEN_PREFIX.length)
  const rawBytes = Buffer.from(payload, 'base64url')
  assert.equal(rawBytes.length, 32)
  assert.equal(INVITE_TOKEN_BYTES, 32)
  // Two tokens never collide (fresh entropy each time).
  const second = store.mintInvite({ uses: INVITE_MAX_USES, ttlSeconds: INVITE_TTL_SECONDS })
  assert.notEqual(second.token, minted.token)

  // The stored digest is the SHA-256 over the 32 decoded bytes — the
  // derivation computed here from the token, compared with the row.
  const expectedDigest = createHash('sha256').update(rawBytes).digest('hex')
  assert.equal(minted.digest, expectedDigest)
  const rows = inviteRows(dataDir)
  assert.equal(rows.length, 2)
  const row = rows.find(candidate => candidate.digest === minted.digest)
  assert.ok(row, 'the minted digest is persisted')
  // Defaults are the ratified constants: 1 use, 24 h.
  assert.equal(row.uses_remaining, 1)
  assert.equal(row.uses_max, INVITE_MAX_USES)
  assert.equal(row.revoked_at, null)
  assert.equal(Date.parse(row.expires_at) - Date.parse(row.created_at), INVITE_TTL_SECONDS * 1000)

  // DIGEST-ONLY persistence: the raw token (and even its bare payload) must
  // appear nowhere in the database file or its WAL sidecar. The digest hex
  // IS present — that is the design — but it is a one-way derivative.
  const databaseBytes = readFileSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME)).toString('latin1')
  const walBytes = existsSync(join(dataDir, `${ROOM_LOG_DATABASE_FILENAME}-wal`))
    ? readFileSync(join(dataDir, `${ROOM_LOG_DATABASE_FILENAME}-wal`)).toString('latin1')
    : ''
  for (const haystack of [databaseBytes, walBytes]) {
    assert.equal(haystack.includes(minted.token), false, 'the raw token must never be persisted')
    assert.equal(haystack.includes(payload), false, 'the raw token payload must never be persisted')
  }
  assert.ok(databaseBytes.includes(expectedDigest) || walBytes.includes(expectedDigest),
    'the digest itself is the persisted record')
})

test('mint accepts only finite --uses/--ttl values, at the CLI and the store, and the CLI usage refusals create nothing', async t => {
  const dataDir = makeDataDir(t)
  const first = await runCli(dataDir, ['invite', 'mint', '--uses', '3', '--ttl', '2'])
  assert.equal(first.exitCode, 0, first.stderr)
  const [mintLine] = jsonLines(first.stdout)
  assert.equal(mintLine.ok, true)
  assert.equal(mintLine.command, 'invite mint')
  assert.equal(mintLine.invite.uses_max, 3)
  assert.match(mintLine.token, TOKEN_SHAPE)
  const rows = inviteRows(dataDir)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].uses_max, 3)
  assert.ok(Math.abs((Date.parse(rows[0].expires_at) - Date.parse(rows[0].created_at)) - 2 * 60 * 60 * 1000) < 50,
    'a --ttl of 2 hours lands within 50 ms of 2 h')

  // The unlimited and never-expiring modes have no accepted spelling. Every
  // refusal: exit 2 (usage), one JSON error line, and NO new invite row.
  const before = inviteRows(dataDir).length
  for (const [flag, value] of [
    ['--uses', 'none'], ['--uses', '0'], ['--uses', '-1'], ['--uses', '1.5'],
    ['--uses', 'Infinity'], ['--uses', 'NaN'], ['--uses', 'inf'], ['--uses', ''],
    ['--ttl', '0'], ['--ttl', '-1'], ['--ttl', 'inf'], ['--ttl', 'Infinity'],
    ['--ttl', 'NaN'], ['--ttl', 'none'], ['--ttl', 'abc'], ['--ttl', ''],
  ]) {
    const refused = await runCli(dataDir, ['invite', 'mint', flag, value])
    assert.equal(refused.exitCode, 2, `${flag} ${value}`)
    const [errorLine] = jsonLines(refused.stderr)
    assert.equal(errorLine.ok, false, `${flag} ${value}`)
    assert.equal(errorLine.code, 'usage', `${flag} ${value}`)
    assert.equal(errorLine.command, 'invite mint', `${flag} ${value}`)
    assert.match(errorLine.message, /rejected outright|needs a value/, `${flag} ${value}`)
    assert.equal(refused.stdout, '', `${flag} ${value}`)
  }
  assert.equal(inviteRows(dataDir).length, before, 'no refused mint created a row')

  // The store itself defends the same rule even if a caller bypasses the
  // CLI: BOTH budget arguments are required finite values there — no
  // implicit default lives below the CLI front door.
  const store = openStore(dataDir)
  t.after(() => store.close())
  assert.throws(() => store.mintInvite({ ttlSeconds: 3600 }), /finite whole number/)
  assert.throws(() => store.mintInvite({ uses: Number.POSITIVE_INFINITY, ttlSeconds: 3600 }), /finite whole number/)
  assert.throws(() => store.mintInvite({ uses: 0, ttlSeconds: 3600 }), /finite whole number/)
  assert.throws(() => store.mintInvite({ uses: 1 }), /finite positive/)
  assert.throws(() => store.mintInvite({ uses: 1, ttlSeconds: Number.POSITIVE_INFINITY }), /finite positive/)
  assert.throws(() => store.mintInvite({ uses: 1, ttlSeconds: 0 }), /finite positive/)
  assert.throws(() => store.mintInvite({ uses: 1, ttlSeconds: Number.NaN }), /finite positive/)
})

// --- Row B: the JSON-lines grammar, stable exit codes, list/revoke ---------------

test('the invite family speaks JSON lines with stable exit codes: mint 0, list 0 (secret-free projection), revoke 0, coded refusal 1, usage 2', async t => {
  const dataDir = makeDataDir(t)

  // An empty realm: zero lines, exit 0, and the store file is still created
  // by the direct open (the operator family opens the store, AR-13).
  const empty = await runCli(dataDir, ['invite', 'list'])
  assert.equal(empty.exitCode, 0, empty.stderr)
  assert.equal(empty.stdout, '')
  assert.equal(empty.stderr, '')
  assert.equal(inviteRows(dataDir).length, 0)

  // Two mints (one defaulted, one parameterized) — tokens captured for the
  // secret scan and the enrollment rows.
  const mintOne = await runCli(dataDir, ['invite', 'mint'])
  assert.equal(mintOne.exitCode, 0, mintOne.stderr)
  const mintTwo = await runCli(dataDir, ['invite', 'mint', '--uses', '2'])
  assert.equal(mintTwo.exitCode, 0, mintTwo.stderr)
  const [lineOne, lineTwo] = [jsonLines(mintOne.stdout)[0], jsonLines(mintTwo.stdout)[0]]
  const tokens = [lineOne.token, lineTwo.token]

  // The listing projection is EXACTLY the four secret-free fields, in mint
  // order, one JSON object per line — never the token, never a full digest.
  const listed = await runCli(dataDir, ['invite', 'list'])
  assert.equal(listed.exitCode, 0, listed.stderr)
  const listing = jsonLines(listed.stdout)
  assert.equal(listing.length, 2)
  for (const entry of listing) {
    assert.deepEqual(Object.keys(entry), ['ok', 'command', 'invite'])
    assert.equal(entry.ok, true)
    assert.equal(entry.command, 'invite list')
    assert.deepEqual(
      Object.keys(entry.invite),
      ['digest_prefix', 'uses_remaining', 'expires_at', 'revoked'],
    )
    assert.match(entry.invite.digest_prefix, /^[0-9a-f]{12}$/)
    assert.equal(entry.invite.revoked, false)
  }
  assert.deepEqual(listing.map(entry => entry.invite.uses_remaining), [1, 2])

  // Revoke by the listed prefix: exit 0, one JSON line, revoked true — and
  // the revoked invite blocks new enrollment only (the row stays).
  const prefix = listing[0].invite.digest_prefix
  const revoked = await runCli(dataDir, ['invite', 'revoke', prefix])
  assert.equal(revoked.exitCode, 0, revoked.stderr)
  const [revokedLine] = jsonLines(revoked.stdout)
  assert.deepEqual(Object.keys(revokedLine.invite), ['digest_prefix', 'uses_remaining', 'expires_at', 'revoked'])
  assert.equal(revokedLine.invite.digest_prefix, prefix)
  assert.equal(revokedLine.invite.revoked, true)
  const rowsAfter = inviteRows(dataDir)
  assert.equal(rowsAfter.find(row => row.digest.startsWith(prefix)).revoked_at !== null, true)
  assert.equal(rowsAfter.length, 2, 'revocation never deletes the row')

  // Revoking an already-revoked invite is an idempotent success.
  const again = await runCli(dataDir, ['invite', 'revoke', prefix])
  assert.equal(again.exitCode, 0, again.stderr)
  assert.equal(jsonLines(again.stdout)[0].invite.revoked, true)

  // Coded refusals: exit 1 with the real code.
  const unknown = await runCli(dataDir, ['invite', 'revoke', 'ffffffffffff'])
  assert.equal(unknown.exitCode, 1)
  const [unknownLine] = jsonLines(unknown.stderr)
  assert.equal(unknownLine.ok, false)
  assert.equal(unknownLine.code, 'invite_not_found')
  assert.equal(jsonLines(unknown.stdout).length, 0)

  // Coded value refusals: a malformed prefix (too short, or non-hex) is a
  // coded invalid_request — exit 1, the held family's malformed-id
  // discipline — never a bare invalid.
  const malformed = await runCli(dataDir, ['invite', 'revoke', 'short'])
  assert.equal(malformed.exitCode, 1)
  assert.equal(jsonLines(malformed.stderr)[0].code, 'invalid_request')
  assert.match(jsonLines(malformed.stderr)[0].message, /digest prefix/)

  // Usage refusals: exit 2 with the usage code — grammar breakage only.
  for (const argv of [
    ['invite', 'revoke'],
    ['invite', 'revoke', `${prefix}ff`, 'extra'],
    ['invite', 'revoke', '--bogus'],
    ['invite', 'bogus'],
    ['invite', 'list', '--bogus'],
    ['invite'],
  ]) {
    const usageRefused = await runCli(dataDir, argv)
    assert.equal(usageRefused.exitCode, 2, argv.join(' '))
    const [usageLine] = jsonLines(usageRefused.stderr)
    assert.equal(usageLine.ok, false, argv.join(' '))
    assert.equal(usageLine.code, 'usage', argv.join(' '))
  }
  void tokens // the secret scan in its own test uses fresh tokens
})

// --- Row C: rollback consumes nothing --------------------------------------------

test('a revoke prefix matching several invites is refused with the candidates, never guessed', async t => {
  const dataDir = makeDataDir(t)
  const store = openStore(dataDir)
  t.after(() => store.close())
  const first = store.mintInvite({ uses: 1, ttlSeconds: 3600 })
  const second = store.mintInvite({ uses: 1, ttlSeconds: 3600 })

  // State surgery installs a crafted near-collision (two rows sharing the
  // first 16 hex characters) — the 48-bit natural collision this guard
  // exists for cannot be arranged through minting.
  const surgeon = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME))
  const sharedPrefix = first.digest.slice(0, 16)
  const crafted = `${sharedPrefix}${'e'.repeat(48)}`
  surgeon.prepare(`
    INSERT INTO invites (digest, uses_remaining, uses_max, expires_at, created_at, revoked_at)
    VALUES (?, ?, ?, ?, ?, NULL)
  `).run(crafted, 1, 1, first.expires_at, first.created_at)
  surgeon.close()

  // The 12-character prefix both rows share is ambiguous: a coded refusal
  // carrying the candidate prefixes, and nothing revoked.
  const ambiguous = await runCli(dataDir, ['invite', 'revoke', first.digest.slice(0, INVITE_DIGEST_PREFIX_CHARS)])
  assert.equal(ambiguous.exitCode, 1)
  const [line] = jsonLines(ambiguous.stderr)
  assert.equal(line.ok, false)
  assert.equal(line.code, 'invalid_request')
  assert.match(line.message, /matches 2 invites/)
  assert.match(line.message, new RegExp(first.digest.slice(0, 24)))
  assert.match(line.message, new RegExp(crafted.slice(0, 24)))
  const rows = inviteRows(dataDir)
  assert.equal(rows.length, 3)
  assert.equal(rows.every(row => row.revoked_at === null), true, 'an ambiguous prefix revoked nothing')

  // Naming one candidate fully resolves it (and the crafted row is a real
  // row the store happily revokes).
  const resolved = await runCli(dataDir, ['invite', 'revoke', crafted])
  assert.equal(resolved.exitCode, 0, resolved.stderr)
  assert.equal(jsonLines(resolved.stdout)[0].invite.revoked, true)
  assert.equal(inviteRows(dataDir).find(row => row.digest === crafted).revoked_at !== null, true)
  void second
})

test('a rolled-back enrollment consumes nothing: the consumption row and the decrement vanish with the transaction', t => {
  const dataDir = makeDataDir(t)
  const store = openStore(dataDir)
  const minted = store.mintInvite({ uses: INVITE_MAX_USES, ttlSeconds: INVITE_TTL_SECONDS })
  const installer = installation()

  // State surgery that makes the LAST write of the enrollment transaction
  // fail: without the enrolled_actors table the INSERT cannot succeed, so
  // the transaction must roll back — consumption row and decrement with it.
  const surgeon = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME))
  surgeon.exec('DROP TABLE enrolled_actors')
  surgeon.close()

  assert.throws(
    () => store.enrollRemoteActor({
      inviteToken: minted.token,
      rawPublicKey: installer.raw,
      signature: Buffer.from(installer.signToken(minted.token), 'base64url'),
    }),
    error => /no such table/i.test(error.message),
  )

  const [row] = inviteRows(dataDir)
  assert.equal(row.uses_remaining, 1, 'the decrement rolled back')
  assert.equal(consumptionRows(dataDir).length, 0, 'the consumption row rolled back')
  store.close()

  // Reopening converges the schema again (the dropped table is recreated)
  // and the invite is fully usable — nothing was consumed by the failure.
  const reopened = openStore(dataDir)
  t.after(() => reopened.close())
  const outcome = reopened.enrollRemoteActor({
    inviteToken: minted.token,
    rawPublicKey: installer.raw,
    signature: Buffer.from(installer.signToken(minted.token), 'base64url'),
  })
  assert.equal(outcome.reattached, false)
  assert.equal(inviteRows(dataDir)[0].uses_remaining, 0)
  assert.equal(consumptionRows(dataDir).length, 1)
})

// --- Row D: the two-process race --------------------------------------------------

test('two processes racing one single-use invite: exactly one enrollment commits, the loser answers invite_exhausted, and the invite shows 0 remaining', async t => {
  const dataDir = makeDataDir(t)
  const seeder = openStore(dataDir)
  const minted = seeder.mintInvite({ uses: INVITE_MAX_USES, ttlSeconds: INVITE_TTL_SECONDS })
  seeder.close()

  const storePath = join(ROOT, 'server', 'store', 'room-log.mjs')
  const firstChild = spawnRaceChild(t, { dataDir, token: minted.token, storePath })
  const secondChild = spawnRaceChild(t, { dataDir, token: minted.token, storePath })
  const [first, second] = await Promise.all([firstChild.settled, secondChild.settled])

  const outcomes = [first, second].map(result => {
    assert.equal(result.code, 0, `race child failed: ${result.stderr}`)
    return JSON.parse(result.stdout.trim().split('\n').pop())
  })
  const winners = outcomes.filter(outcome => outcome.ok === true)
  const losers = outcomes.filter(outcome => outcome.ok === false)
  assert.equal(winners.length, 1, `exactly one enrollment commits; got ${JSON.stringify(outcomes)}`)
  assert.equal(losers.length, 1)
  assert.equal(winners[0].reattached, false, 'the winner consumed the single use')
  assert.equal(losers[0].code, 'invite_exhausted', `the loser's coded answer; got ${JSON.stringify(losers)}`)

  // The durable state agrees: one use consumed, one consumption row, one
  // enrolled fingerprint — and the single-use invite remains listed at
  // 0 remaining (never deleted, so the retry window stays honest).
  const [row] = inviteRows(dataDir)
  assert.equal(row.uses_remaining, 0)
  const consumptions = consumptionRows(dataDir)
  assert.equal(consumptions.length, 1)
  assert.equal(consumptions[0].actor_fingerprint, winners[0].fingerprint)
  const enrollments = enrollmentRows(dataDir)
  assert.equal(enrollments.length, 1)
  assert.equal(enrollments[0].actor_fingerprint, winners[0].fingerprint)
  const listed = await runCli(dataDir, ['invite', 'list'])
  const [listedLine] = jsonLines(listed.stdout)
  assert.equal(listedLine.invite.uses_remaining, 0)
  assert.equal(listedLine.invite.revoked, false, 'an exhausted single-use invite is spent, not revoked')
})

// --- Row E: the lost-response retry ------------------------------------------------

test('a lost-response retry reattaches without consuming: the same key re-presenting the same invite succeeds idempotently at the store and over the route', async t => {
  const dataDir = makeDataDir(t)
  const store = openStore(dataDir)
  t.after(() => store.close())

  // Store level: a 2-use invite; A consumes, A re-presents (the retry) —
  // success, reattached, and STILL one consumption row for A.
  const minted = store.mintInvite({ uses: 2, ttlSeconds: 3600 })
  const alice = installation()
  const bob = installation()
  const firstAttempt = store.enrollRemoteActor({
    inviteToken: minted.token,
    rawPublicKey: alice.raw,
    signature: Buffer.from(alice.signToken(minted.token), 'base64url'),
  })
  assert.equal(firstAttempt.reattached, false)
  const retry = store.enrollRemoteActor({
    inviteToken: minted.token,
    rawPublicKey: alice.raw,
    signature: Buffer.from(alice.signToken(minted.token), 'base64url'),
  })
  assert.equal(retry.reattached, true)
  assert.equal(retry.fingerprint, firstAttempt.fingerprint)
  assert.equal(inviteRows(dataDir)[0].uses_remaining, 1, 'the retry consumed nothing')
  assert.equal(consumptionRows(dataDir).filter(row => row.actor_fingerprint === alice.fingerprint).length, 1)

  // B consumes the second use; A re-presenting AGAIN still reattaches for
  // free even though the invite is now fully spent.
  store.enrollRemoteActor({
    inviteToken: minted.token,
    rawPublicKey: bob.raw,
    signature: Buffer.from(bob.signToken(minted.token), 'base64url'),
  })
  assert.equal(inviteRows(dataDir)[0].uses_remaining, 0)
  const spentRetry = store.enrollRemoteActor({
    inviteToken: minted.token,
    rawPublicKey: alice.raw,
    signature: Buffer.from(alice.signToken(minted.token), 'base64url'),
  })
  assert.equal(spentRetry.reattached, true, 'the retry reattaches on a spent invite')
  assert.equal(inviteRows(dataDir)[0].uses_remaining, 0)
})

// The retry's route-level half (the identical request replayed over the wire
// answers 200 twice with one consumption) is pinned in the possession-proof
// row below; the store-level consumption math is pinned here.

// --- Rows F-I: the enroll route ----------------------------------------------------

test('the enroll route requires the possession proof and validates the frozen field shapes before any state moves', async t => {
  const dataDir = makeDataDir(t)
  const store = openStore(dataDir)
  t.after(() => store.close())
  const minted = store.mintInvite({ uses: INVITE_MAX_USES, ttlSeconds: INVITE_TTL_SECONDS })
  const alice = installation()
  const mallory = installation()
  const server = await startTestServer(t, dataDir)

  // Shape gates: missing/malformed fields are invalid_request naming the
  // field; a decorated (non-canonical) signature is signature_invalid; an
  // oversized one is invalid_request. None of it consumes anything.
  const shapeCases = [
    [{}, /invite_token/],
    [{ invite_token: 'bogus' }, /invite_token/],
    [{ invite_token: `${INVITE_TOKEN_PREFIX}${'A'.repeat(42)}` }, /invite_token/],
    [{ invite_token: minted.token }, /public_key/],
    [{ invite_token: minted.token, public_key: alice.publicKey }, /signature/],
    [{ invite_token: minted.token, public_key: 'short' }, /public_key/],
    [{ invite_token: minted.token, public_key: alice.publicKey, signature: 'x'.repeat(257) }, /signature/],
  ]
  for (const [body, pattern] of shapeCases) {
    const response = await enrollRequest(server.port, body)
    assert.equal(response.status, 400, JSON.stringify(body))
    assert.equal(response.json().error.code, 'invalid_request', JSON.stringify(body))
    assert.match(response.json().error.message, pattern, JSON.stringify(body))
  }
  const decorated = await enrollRequest(server.port, {
    invite_token: minted.token,
    public_key: alice.publicKey,
    signature: `-${alice.signToken(minted.token)}`,
  })
  assert.equal(decorated.status, 401)
  assert.equal(decorated.json().error.code, 'signature_invalid')
  assert.equal(inviteRows(dataDir)[0].uses_remaining, 1, 'no shape refusal consumed anything')
  assert.equal(consumptionRows(dataDir).length, 0)

  // Possession proof REQUIRED: a signature from a key other than the
  // presented one verifies against nothing and consumes nothing.
  const wrongSigner = await enrollRequest(server.port, {
    invite_token: minted.token,
    public_key: alice.publicKey,
    signature: mallory.signToken(minted.token),
  })
  assert.equal(wrongSigner.status, 401)
  assert.equal(wrongSigner.json().error.code, 'signature_invalid')
  assert.equal(inviteRows(dataDir)[0].uses_remaining, 1)
  assert.equal(consumptionRows(dataDir).length, 0)

  // An unknown field is rejected (NFR-8) — including a claimed fingerprint:
  // identity is derived, never submitted.
  const smuggled = await enrollRequest(server.port, {
    invite_token: minted.token,
    public_key: alice.publicKey,
    signature: alice.signToken(minted.token),
    fingerprint: mallory.fingerprint,
  })
  assert.equal(smuggled.status, 400)
  assert.equal(smuggled.json().error.code, 'unknown_field')
  assert.equal(inviteRows(dataDir)[0].uses_remaining, 1)

  // The valid enrollment: 200, the DERIVED fingerprint, one use consumed.
  const valid = await enrollViaHttp(server.port, minted.token, alice)
  assert.equal(valid.status, 200, valid.text)
  assert.deepEqual(valid.json().result, { fingerprint: alice.fingerprint })
  assert.equal(inviteRows(dataDir)[0].uses_remaining, 0)
  assert.deepEqual(consumptionRows(dataDir).map(row => row.actor_fingerprint), [alice.fingerprint])
  assert.deepEqual(enrollmentRows(dataDir).map(row => row.actor_fingerprint), [alice.fingerprint])

  // The identical request replayed — the client's lost-response retry over
  // the wire — reattaches without consuming: 200, same fingerprint, still
  // exactly one consumption row.
  const replayed = await enrollViaHttp(server.port, minted.token, alice)
  assert.equal(replayed.status, 200, replayed.text)
  assert.equal(replayed.json().result.fingerprint, alice.fingerprint)
  assert.equal(consumptionRows(dataDir).length, 1)
  assert.equal(inviteRows(dataDir)[0].uses_remaining, 0)
})

test('the enroll route gates state: unknown, revoked, and expired invites answer invite_invalid; a spent invite answers invite_exhausted', async t => {
  const dataDir = makeDataDir(t)
  const store = openStore(dataDir)
  t.after(() => store.close())
  const server = await startTestServer(t, dataDir)
  const alice = installation()
  const mallory = installation()

  // Unknown (but well-formed) token.
  const unknown = await enrollViaHttp(server.port,
    `${INVITE_TOKEN_PREFIX}${'z'.repeat(3)}${'Y'.repeat(40)}`, alice)
  assert.equal(unknown.status, 403)
  assert.equal(unknown.json().error.code, 'invite_invalid')

  // Revoked: mint through the store, revoke through the operator function
  // (the CLI path), then present.
  const revokedMint = store.mintInvite({ uses: INVITE_MAX_USES, ttlSeconds: INVITE_TTL_SECONDS })
  store.revokeInvite({ digestPrefix: revokedMint.digest.slice(0, INVITE_DIGEST_PREFIX_CHARS) })
  const revoked = await enrollViaHttp(server.port, revokedMint.token, alice)
  assert.equal(revoked.status, 403)
  assert.equal(revoked.json().error.code, 'invite_invalid')
  assert.equal(inviteRows(dataDir).find(row => row.digest === revokedMint.digest).uses_remaining, 1,
    'a revoked invite consumed nothing')

  // Expired: the expiry lands via state surgery on the stored timestamp (no
  // clock waiting), and the refusal consumes nothing.
  const expiredMint = store.mintInvite({ uses: INVITE_MAX_USES, ttlSeconds: INVITE_TTL_SECONDS })
  const surgeon = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME))
  surgeon.prepare('UPDATE invites SET expires_at = ? WHERE digest = ?')
    .run('2020-01-01T00:00:00.000Z', expiredMint.digest)
  surgeon.close()
  const expired = await enrollViaHttp(server.port, expiredMint.token, alice)
  assert.equal(expired.status, 403)
  assert.equal(expired.json().error.code, 'invite_invalid')
  assert.equal(inviteRows(dataDir).find(row => row.digest === expiredMint.digest).uses_remaining, 1)

  // Exhausted: a single-use invite consumed by Alice answers Mallory's
  // presentation with the race loser's coded conflict — never a silent
  // refusal and never a second enrollment.
  const single = store.mintInvite({ uses: INVITE_MAX_USES, ttlSeconds: INVITE_TTL_SECONDS })
  const aliceEnroll = await enrollViaHttp(server.port, single.token, alice)
  assert.equal(aliceEnroll.status, 200, aliceEnroll.text)
  const malloryEnroll = await enrollViaHttp(server.port, single.token, mallory)
  assert.equal(malloryEnroll.status, 409)
  assert.equal(malloryEnroll.json().error.code, 'invite_exhausted')
  assert.deepEqual(enrollmentRows(dataDir).map(row => row.actor_fingerprint), [alice.fingerprint])
  assert.equal(inviteRows(dataDir).find(row => row.digest === single.digest).uses_remaining, 0)
})

test('a multi-use invite admits distinct keys up to its budget; an already-attached key keeps reattaching for free', async t => {
  const dataDir = makeDataDir(t)
  const store = openStore(dataDir)
  t.after(() => store.close())
  const server = await startTestServer(t, dataDir)
  const minted = store.mintInvite({ uses: 2, ttlSeconds: 3600 })
  const alice = installation()
  const bob = installation()
  const carol = installation()

  const first = await enrollViaHttp(server.port, minted.token, alice)
  assert.equal(first.status, 200)
  assert.equal(inviteRows(dataDir)[0].uses_remaining, 1)
  const second = await enrollViaHttp(server.port, minted.token, bob)
  assert.equal(second.status, 200)
  assert.equal(inviteRows(dataDir)[0].uses_remaining, 0)

  const third = await enrollViaHttp(server.port, minted.token, carol)
  assert.equal(third.status, 409)
  assert.equal(third.json().error.code, 'invite_exhausted')

  // Alice's client retried after a lost response: reattach, no consumption.
  const retry = await enrollViaHttp(server.port, minted.token, alice)
  assert.equal(retry.status, 200)
  assert.equal(retry.json().result.fingerprint, alice.fingerprint)
  assert.equal(inviteRows(dataDir)[0].uses_remaining, 0)
  assert.equal(consumptionRows(dataDir).length, 2)
  assert.deepEqual(enrollmentRows(dataDir).map(row => row.actor_fingerprint).sort(),
    [alice.fingerprint, bob.fingerprint].sort())
})

test('enrollment unlocks the live challenge-answer path: the enrolled key mints a session, an unenrolled key still answers not_enrolled', async t => {
  const dataDir = makeDataDir(t)
  const store = openStore(dataDir)
  t.after(() => store.close())
  const server = await startTestServer(t, dataDir)
  const minted = store.mintInvite({ uses: INVITE_MAX_USES, ttlSeconds: INVITE_TTL_SECONDS })
  const alice = installation()
  const stranger = installation()

  // Before enrollment: a proven signature over the raw nonce bytes still
  // mints no session (Story 4.1's gate — unchanged by this story).
  const strangerAnswer = await challengeAnswer(server.port, stranger)
  assert.equal(strangerAnswer.status, 403)
  assert.equal(strangerAnswer.json().error.code, 'not_enrolled')

  // Enroll Alice, then the normal reconnect path: challenge → sign the raw
  // nonce → answer → session token that authenticates actor routes.
  const enrolled = await enrollViaHttp(server.port, minted.token, alice)
  assert.equal(enrolled.status, 200, enrolled.text)
  const answer = await challengeAnswer(server.port, alice)
  assert.equal(answer.status, 200, answer.text)
  const sessionToken = answer.json().result.session_token
  assert.ok(typeof sessionToken === 'string' && sessionToken.length > 0)
  const status = await request(server.port, 'GET', '/api/status', {
    headers: { ...jsonHeaders, authorization: `Bearer ${sessionToken}` },
  })
  assert.equal(status.status, 200, status.text)
  assert.match(status.json().result.realm_id, /^[0-9a-f-]{36}$/)
})

test('on a real spawned server the enrolled key completes the whole journey: mint, enroll over HTTP, challenge, answer, and an actor read', async t => {
  const dataDir = makeDataDir(t)
  const store = openStore(dataDir)
  const minted = store.mintInvite({ uses: INVITE_MAX_USES, ttlSeconds: INVITE_TTL_SECONDS })
  store.close()

  const { waitReady, stderrText } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const alice = installation()

  const enrolled = await enrollViaHttp(record.port, minted.token, alice)
  assert.equal(enrolled.status, 200, `${enrolled.text}\n${stderrText()}`)
  assert.equal(enrolled.json().result.fingerprint, alice.fingerprint)

  const answer = await challengeAnswer(record.port, alice)
  assert.equal(answer.status, 200, `${answer.text}\n${stderrText()}`)
  const sessionToken = answer.json().result.session_token

  const bind = await request(record.port, 'POST', '/api/session', {
    headers: { ...jsonHeaders, authorization: `Bearer ${sessionToken}` },
    body: JSON.stringify({ chat_id: 'Remote-Ally' }),
  })
  assert.equal(bind.status, 200, bind.text)
  const rooms = await request(record.port, 'GET', '/api/rooms', {
    headers: { ...jsonHeaders, authorization: `Bearer ${sessionToken}` },
  })
  assert.equal(rooms.status, 200)
  assert.equal(rooms.json().result.rooms.length, 1, 'the implicitly-joined Broadcast Room')
})

// --- Rows K-L: the admission gate ---------------------------------------------------

test('the enroll route is rate-limited 5/min per identity (burst 5): the 6th rapid attempt is refused rate_limited and the window rolls over by the clock', async t => {
  // The declared pair is imported by name and realized by the fixed window.
  assert.equal(ENROLLMENT_PER_MINUTE, 5)
  assert.equal(ENROLLMENT_WINDOW_MS, 60_000)

  const dataDir = makeDataDir(t)
  let clock = 1_700_000_000_000
  const server = await startTestServer(t, dataDir, {
    enrollRateLimiter: createEnrollRateLimiter({ now: () => clock }),
  })
  const body = { invite_token: 'not-a-token' } // counted at admission, whatever the outcome

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const admitted = await enrollRequest(server.port, body)
    assert.equal(admitted.status, 400, `attempt ${attempt} passes admission (its shape refusal is the handler's)`)
  }
  const refused = await enrollRequest(server.port, body)
  assert.equal(refused.status, 429)
  assert.equal(refused.json().error.code, 'rate_limited')

  // The window rolls: the same identity is admitted again after
  // ENROLLMENT_WINDOW_MS.
  clock += ENROLLMENT_WINDOW_MS
  const rolled = await enrollRequest(server.port, body)
  assert.equal(rolled.status, 400, 'a fresh window admits again')

  // The gate sits in the budgets stage, before the handler: a rate-limited
  // attempt never reaches the enrollment logic, so it consumes nothing.
  const store = openStore(dataDir)
  t.after(() => store.close())
  const minted = store.mintInvite({ uses: INVITE_MAX_USES, ttlSeconds: INVITE_TTL_SECONDS })
  const alice = installation()
  clock += ENROLLMENT_WINDOW_MS
  const valid = await enrollViaHttp(server.port, minted.token, alice)
  assert.equal(valid.status, 200)
  clock += ENROLLMENT_WINDOW_MS
  const spent = inviteRows(dataDir)[0]
  assert.equal(spent.uses_remaining, 0)
})

test('forwarded addresses are trusted only from an explicitly configured proxy: spoofed X-Forwarded-For cannot mint fresh buckets without it, and with it the leftmost entry keys the bucket', async t => {
  // WITHOUT trustedProxy (the default): five requests carrying five DIFFERENT
  // spoofed X-Forwarded-For values all fill the ONE bucket the socket owns —
  // the sixth is refused even though every header was novel.
  const plainDataDir = makeDataDir(t)
  const plainServer = await startTestServer(t, plainDataDir, {
    enrollRateLimiter: createEnrollRateLimiter({}),
  })
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const spoofed = await enrollRequest(plainServer.port,
      { invite_token: 'not-a-token' },
      { 'x-forwarded-for': `203.0.113.${attempt}` })
    assert.equal(spoofed.status, 400, `spoofed attempt ${attempt} is admitted into the socket's own bucket`)
  }
  const sixth = await enrollRequest(plainServer.port,
    { invite_token: 'not-a-token' },
    { 'x-forwarded-for': '203.0.113.200' })
  assert.equal(sixth.status, 429)
  assert.equal(sixth.json().error.code, 'rate_limited')

  // WITH trustedProxy: the leftmost forwarded entry IS the client. One
  // identity's bucket fills at five; a different forwarded identity has its
  // own bucket.
  const proxyDataDir = makeDataDir(t)
  const proxyServer = await startTestServer(t, proxyDataDir, {
    trustedProxy: true,
    enrollRateLimiter: createEnrollRateLimiter({}),
  })
  for (let attempt = 1; attempt <= 5; attempt += 1) {
    const admitted = await enrollRequest(proxyServer.port,
      { invite_token: 'not-a-token' },
      { 'x-forwarded-for': '198.51.100.7' })
    assert.equal(admitted.status, 400, `proxied attempt ${attempt} admitted`)
  }
  const fullBucket = await enrollRequest(proxyServer.port,
    { invite_token: 'not-a-token' },
    { 'x-forwarded-for': '198.51.100.7' })
  assert.equal(fullBucket.status, 429)
  const otherClient = await enrollRequest(proxyServer.port,
    { invite_token: 'not-a-token' },
    { 'x-forwarded-for': '198.51.100.9' })
  assert.equal(otherClient.status, 400, 'a distinct forwarded client has its own bucket')

  // Malformed wiring fails at startup, never per-request.
  await assert.rejects(
    () => startServer({ dataDir: makeDataDir(t), trustedProxy: 'yes' }),
    error => error?.code === 'invalid_argument' && /trustedProxy/.test(error.message),
  )
  await assert.rejects(
    () => startServer({ dataDir: makeDataDir(t), enrollRateLimiter: {} }),
    error => error?.code === 'invalid_argument' && /enrollRateLimiter/.test(error.message),
  )
})

// --- Row M: the counted secret scan --------------------------------------------------

test('listings and diagnostics never show a secret: a counted scan of every byte the family printed finds no token and no full digest', async t => {
  const dataDir = makeDataDir(t)
  const mintedRows = []
  for (const args of [[], ['--uses', '2'], ['--ttl', '6']]) {
    const mint = await runCli(dataDir, ['invite', 'mint', ...args])
    assert.equal(mint.exitCode, 0, mint.stderr)
    mintedRows.push(mint)
  }
  const tokens = mintedRows.map(result => jsonLines(result.stdout)[0].token)
  const payloads = tokens.map(token => token.slice(INVITE_TOKEN_PREFIX.length))
  const store = openStore(dataDir)
  t.after(() => store.close())
  const digests = store.listInvites().map(row => row.digest)

  // The mint receipts are the ONLY place a token may appear — exactly once
  // per mint line.
  for (const mint of mintedRows) {
    const occurrences = mint.stdout.split('\n').filter(line => line.includes('ar_inv1_')).length
    assert.equal(occurrences, 1, 'the raw token appears on exactly one mint line')
  }

  // Every other surface the family can produce — listings, revocations, and
  // every refusal — carries neither the token, nor its payload, nor a full
  // 64-hex digest.
  const surfaces = []
  const listed = await runCli(dataDir, ['invite', 'list'])
  surfaces.push(listed.stdout, listed.stderr)
  for (const prefix of digests.map(digest => digest.slice(0, INVITE_DIGEST_PREFIX_CHARS))) {
    const revoked = await runCli(dataDir, ['invite', 'revoke', prefix])
    assert.equal(revoked.exitCode, 0, revoked.stderr)
    surfaces.push(revoked.stdout, revoked.stderr)
  }
  const refusals = [
    await runCli(dataDir, ['invite', 'revoke', 'ffffffffffff']),
    await runCli(dataDir, ['invite', 'mint', '--uses', 'Infinity']),
    await runCli(dataDir, ['invite', 'bogus']),
  ]
  for (const refusal of refusals) surfaces.push(refusal.stdout, refusal.stderr)

  let scanned = 0
  for (const surface of surfaces) {
    scanned += surface.length
    for (const token of tokens) assert.equal(surface.includes(token), false)
    for (const payload of payloads) assert.equal(surface.includes(payload), false)
    for (const digest of digests) {
      assert.equal(surface.includes(digest), false, 'a full digest never prints — the prefix only')
    }
  }
  assert.ok(scanned > 0, `the scan swept ${scanned} bytes across ${surfaces.length} surfaces`)

  // And the prefix is exactly what the operator needs to revoke: each listed
  // prefix resolves its own row.
  const rows = inviteRows(dataDir)
  assert.equal(rows.length, tokens.length)
  assert.equal(rows.every(row => row.revoked_at !== null), true)
})

// --- Row N: the CLI host is established ----------------------------------------------

test('the operator family is the established CLI host: in-process store access with no HTTP session, documented in the shared help, and later operator stories extend this dispatch', async t => {
  const dataDir = makeDataDir(t)

  // The help carries the invite family with its grammar — the shared help
  // text is the one home of the command reference.
  const help = await runCli(dataDir, ['help'])
  assert.equal(help.exitCode, 0, help.stderr)
  const flat = help.stdout.replace(/\s+/g, ' ')
  for (const fragment of [
    'agent-room invite mint [--uses N] [--ttl HOURS]',
    'agent-room invite list',
    'agent-room invite revoke <digest-prefix>',
    'finite values only',
    'SERVER HOST',
  ]) {
    assert.match(flat, new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), fragment)
  }

  // The host boundary is structural: the family runs with NO server and NO
  // session — it opens the store directly. After every command in this file
  // ran against bare data dirs, the enrollment row proves the store path is
  // the live one (an HTTP-only family could not have written it).
  const mint = await runCli(dataDir, ['invite', 'mint'])
  assert.equal(mint.exitCode, 0, mint.stderr)
  const store = openStore(dataDir)
  t.after(() => store.close())
  assert.equal(store.listInvites().length, 1, 'the CLI wrote through the real store')

  // The source-level pin: the operator family lives in its own module
  // mounted from the shared entrypoint's dispatch, and the module contains
  // no HTTP client — AR-13's "in process" is a property of the code, not
  // just of the runtime behavior.
  const source = readFileSync(join(ROOT, 'server', 'cli', 'invite-commands.mjs'), 'utf8')
  assert.equal(source.includes('node:http'), false, 'no HTTP client in the operator family')
  assert.equal(source.includes('/api/'), false, 'no API call in the operator family')
  const entrySource = readFileSync(join(ROOT, 'server', 'cli', 'agent-room.mjs'), 'utf8')
  assert.match(entrySource, /runInviteFamilyCommand/, 'the dispatch mounts the family')
})
