// Story 1.5 acceptance: the session connect surface over the real HTTP path.
// Every matrix row runs against real spawned server children (node:test with
// real child processes) with real keypairs and sessions from the Story 1.4
// path: the 0600 local token file exchanged at POST /api/auth/local for a
// session token, the token then authenticating the actor-class session
// routes. The rows cover the connect happy path, live collisions in any
// casing (explicit refusal, no suffixing, no state change), the DR-1 grammar
// gate, immediate rename (old name freed in the same instant, original
// retained on refusal), disconnect freeing the name while the durable claim
// row stays, restart durability of the claims index against the ephemeral
// live registry, multiple Actors holding one name, boot-time and
// operator-tuned pruning, credential-less refusals, and unknown-field
// rejection.
//
// Durable claim rows are inspected directly on the WAL SQLite file (a second
// connection reading committed rows while the server holds the writer — the
// same inspection style tests/store.test.mjs uses).

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import http from 'node:http'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { DatabaseSync } from 'node:sqlite'

import {
  CHAT_ID_INVALID_MESSAGE,
  CHAT_ID_MAX,
  CLAIMS_TTL_MS,
  PUBLIC_ERRORS,
  SESSION_TTL_MS,
} from '../server/constants.mjs'
import { loadOrCreateLocalToken } from '../server/api/local-token.mjs'
import { createLiveSessionRegistry } from '../server/core/session-registry.mjs'
import { createSessionRegistry, sessionKeyFromToken } from '../server/api/session.mjs'
import { fingerprintFromPublicKey } from '../server/keys.mjs'
import { claimsTtlMsFromEnv, startServer } from '../server/api/server.mjs'
import { openRoomLog, ROOM_LOG_DATABASE_FILENAME } from '../server/store/room-log.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = join(ROOT, 'server', 'api', 'server.mjs')
const RUNTIME_RECORD_FILENAME = 'runtime.json'
const PROTOCOL_KEY = 'agent-room-protocol'
const DB_PATH_NAME = ROOM_LOG_DATABASE_FILENAME

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
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-session-routes-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  return dataDir
}

function spawnServerChild(t, dataDir, extraEnv = {}) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, AGENT_ROOM_DATA_DIR: dataDir, ...extraEnv },
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

// The Story 1.4 credential exchange against a running server.
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

// The session surface under test: POST/PATCH/DELETE /api/session.
function sessionRequest(port, method, sessionToken, body) {
  return request(port, method, '/api/session', {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${sessionToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

// Full client path for one installation: exchange + connect.
async function connectInstallation(port, localToken, installation_, chatId) {
  const auth = await exchange(port, installation_, localToken)
  assert.equal(auth.status, 200, auth.text)
  const sessionToken = auth.json().result.session_token
  const connected = await sessionRequest(port, 'POST', sessionToken, { chat_id: chatId })
  assert.equal(connected.status, 200, connected.text)
  return { sessionToken, fingerprint: installation_.fingerprint }
}

// Durable claim rows, read straight from the store's SQLite file — the same
// second-connection inspection style tests/store.test.mjs uses. Rows are
// ordered by display form (then fingerprint) so deep-equal on the whole set
// is stable regardless of the random key material.
function claimRows(dataDir) {
  const db = new DatabaseSync(join(dataDir, DB_PATH_NAME))
  try {
    return db.prepare(`
      SELECT chat_id_normalized, actor_fingerprint, chat_id_display, last_seen_at
      FROM chat_id_claims
      ORDER BY chat_id_display, actor_fingerprint
    `).all()
  } finally {
    db.close()
  }
}

function backdateClaims(dataDir, iso) {
  const db = new DatabaseSync(join(dataDir, DB_PATH_NAME))
  try {
    db.prepare('UPDATE chat_id_claims SET last_seen_at = ?').run(iso)
  } finally {
    db.close()
  }
}

// Captures process.stderr writes around an async body (the local-auth
// pattern) for the prune-containment and env-warning rows.
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

// --- Matrix rows (real child processes) -------------------------------------------

test('connect happy path: a session binds a chat id and the durable claim row lands', async t => {
  const dataDir = makeDataDir(t)
  const { child, waitReady, stop, stderrText } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()

  const auth = await exchange(record.port, alice, localToken)
  assert.equal(auth.status, 200)
  const sessionToken = auth.json().result.session_token

  const connect = await sessionRequest(record.port, 'POST', sessionToken, { chat_id: 'Alice' })
  assert.equal(connect.status, 200, connect.text)
  assert.equal(connect.json().ok, true)
  assert.equal(connect.headers[PROTOCOL_KEY], '1')
  // The response echoes the accepted chat_id (display form) alongside when
  // the session connected and when it was last seen — frozen vocabulary
  // names only, no invented fields.
  const result = connect.json().result
  assert.deepEqual(Object.keys(result).sort(), ['chat_id', 'connected_since', 'last_seen'])
  assert.equal(result.chat_id, 'Alice', 'the display form is echoed, never the lowercase key')
  assert.ok(!Number.isNaN(Date.parse(result.connected_since)), 'connected_since is a timestamp')
  assert.ok(!Number.isNaN(Date.parse(result.last_seen)), 'last_seen is a timestamp')

  const rows = claimRows(dataDir)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].chat_id_normalized, 'alice', 'the lowercase form keys the index')
  assert.equal(rows[0].chat_id_display, 'Alice', 'the display form preserves case')
  assert.equal(rows[0].actor_fingerprint, alice.fingerprint, 'the claim binds the token-derived actor')

  // An exact re-bind by the same session is an idempotent refresh: 200, one
  // row, and a case-only re-bind re-echoes the new display form.
  const again = await sessionRequest(record.port, 'POST', sessionToken, { chat_id: 'Alice' })
  assert.equal(again.status, 200, again.text)
  assert.equal(again.json().result.chat_id, 'Alice')
  const recased = await sessionRequest(record.port, 'POST', sessionToken, { chat_id: 'ALICE' })
  assert.equal(recased.status, 200, recased.text)
  assert.equal(recased.json().result.chat_id, 'ALICE', 'the latest claim display form wins')
  assert.equal(claimRows(dataDir).length, 1)
  assert.equal(claimRows(dataDir)[0].chat_id_display, 'ALICE')

  // No chat id or credential ever reaches stderr.
  const stderr = stderrText()
  assert.equal(stderr.includes('Alice'), false)
  assert.equal(stderr.includes(sessionToken), false)

  await stop()
  assert.equal(child.exitCode, 0, 'the server shuts down gracefully with the prune timer live')
})

test('a live collision is refused in any casing; the first holder is unaffected; nothing is written', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const bob = installation()

  const aliceSession = await connectInstallation(record.port, localToken, alice, 'Alice')
  const bobSession = await connectInstallation(record.port, localToken, bob, 'Bob')

  // Second live session claims the same name in any casing: explicit coded
  // refusal — never a suffixed alternative name, never a silent takeover.
  for (const attempt of ['alice', 'ALICE', 'aLiCe']) {
    const refused = await sessionRequest(record.port, 'POST', bobSession.sessionToken, { chat_id: attempt })
    assert.equal(refused.status, 409, attempt)
    assert.equal(refused.json().error.code, 'chat_id_taken')
    assert.equal(refused.json().error.message, PUBLIC_ERRORS.chat_id_taken)
    assert.equal(refused.json().result, undefined, 'no result body carries a substitute name')
  }

  // The refusal wrote no claim row: only the two accepted binds exist.
  const rows = claimRows(dataDir)
  assert.deepEqual(
    rows.map(row => row.chat_id_display),
    ['Alice', 'Bob'],
  )

  // The first holder is unaffected: Alice's session still re-binds fine.
  const stillHeld = await sessionRequest(record.port, 'POST', aliceSession.sessionToken, { chat_id: 'Alice' })
  assert.equal(stillHeld.status, 200, stillHeld.text)
  assert.equal(claimRows(dataDir).length, 2)

  await stop()
})

test('the grammar gate refuses malformed chat ids with coded 400s and zero state change', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const auth = await exchange(record.port, alice, localToken)
  const sessionToken = auth.json().result.session_token

  // Absent or empty: a request-shape rejection naming the missing field
  // (the 1.4 public_key convention), on both bind verbs.
  for (const body of [{}, { chat_id: '' }, { chat_id: null }]) {
    for (const method of ['POST', 'PATCH']) {
      const missing = await sessionRequest(record.port, method, sessionToken, body)
      assert.equal(missing.status, 400, `${method} ${JSON.stringify(body)}`)
      assert.equal(missing.json().error.code, 'invalid_request', `${method} ${JSON.stringify(body)}`)
      assert.match(missing.json().error.message, /chat_id is required/)
    }
  }

  // Present but malformed: the DR-1 grammar gate answers invalid_chat_id
  // with the one shared detail message (the registry and the store cite the
  // same constant — nothing restates the grammar or its message).
  for (const chat_id of ['bad name!', 'bad!', 'x'.repeat(CHAT_ID_MAX + 1), 'ünicode', 42]) {
    const refused = await sessionRequest(record.port, 'POST', sessionToken, { chat_id })
    assert.equal(refused.status, 400, String(chat_id))
    assert.equal(refused.json().error.code, 'invalid_chat_id', String(chat_id))
    assert.equal(refused.json().error.message, CHAT_ID_INVALID_MESSAGE, String(chat_id))
  }

  assert.deepEqual(claimRows(dataDir), [], 'grammar rejections never touch the claims index')
  await stop()
})

test('rename is immediate: the old name is freed in the same instant and the historical pair persists', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const bob = installation()

  const aliceSession = await connectInstallation(record.port, localToken, alice, 'Alice')
  const connectedSince = JSON.parse(
    (await sessionRequest(record.port, 'POST', aliceSession.sessionToken, { chat_id: 'Alice' })).text,
  ).result.connected_since

  const renamed = await sessionRequest(record.port, 'PATCH', aliceSession.sessionToken, { chat_id: 'Bob' })
  assert.equal(renamed.status, 200, renamed.text)
  const renameResult = renamed.json().result
  assert.deepEqual(Object.keys(renameResult).sort(), ['chat_id', 'connected_since', 'last_seen'])
  assert.equal(renameResult.chat_id, 'Bob', 'the rename echoes the accepted display form')
  assert.equal(renameResult.connected_since, connectedSince, 'the session lifetime did not reset')

  // The old name is claimable by the very next session — no TTL, no grace.
  const bobSession = await connectInstallation(record.port, localToken, bob, 'alice')
  assert.ok(bobSession.sessionToken)

  // Durable index: the latest claim per (name, actor) plus the historical
  // (name, actor) pair from before the rename.
  const rows = claimRows(dataDir)
  assert.deepEqual(
    rows.map(row => `${row.chat_id_display}:${row.actor_fingerprint.slice(0, 12)}`),
    [
      `Alice:${alice.fingerprint.slice(0, 12)}`,
      `Bob:${alice.fingerprint.slice(0, 12)}`,
      `alice:${bob.fingerprint.slice(0, 12)}`,
    ],
  )

  await stop()
})

test('rename onto a live-colliding name is refused and the original name is retained', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const bob = installation()
  const carol = installation()

  const aliceSession = await connectInstallation(record.port, localToken, alice, 'Alice')
  await connectInstallation(record.port, localToken, bob, 'Bob')

  const refused = await sessionRequest(record.port, 'PATCH', aliceSession.sessionToken, { chat_id: 'bob' })
  assert.equal(refused.status, 409)
  assert.equal(refused.json().error.code, 'chat_id_taken')

  // Original retained: a third session cannot claim the name Alice still holds.
  const carolAuth = await exchange(record.port, carol, localToken)
  const carolSession = carolAuth.json().result.session_token
  const probe = await sessionRequest(record.port, 'POST', carolSession, { chat_id: 'alice' })
  assert.equal(probe.status, 409)
  assert.equal(probe.json().error.code, 'chat_id_taken')

  // Alice can still rename to a free name: the refusal changed nothing.
  const freed = await sessionRequest(record.port, 'PATCH', aliceSession.sessionToken, { chat_id: 'Carol' })
  assert.equal(freed.status, 200, freed.text)

  await stop()
})

test('disconnect frees the name immediately while the durable claim row stays', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const bob = installation()

  const aliceSession = await connectInstallation(record.port, localToken, alice, 'Alice')
  const before = claimRows(dataDir)
  assert.equal(before.length, 1)

  const disconnect = await sessionRequest(record.port, 'DELETE', aliceSession.sessionToken)
  assert.equal(disconnect.status, 200, disconnect.text)
  assert.equal(disconnect.json().ok, true)
  assert.equal(disconnect.json().result, null)

  // The name is claimable immediately by another session.
  const bobSession = await connectInstallation(record.port, localToken, bob, 'alice')
  assert.ok(bobSession.sessionToken)

  // The durable (name, actor) pair stayed — exactly the ambiguity data.
  const after = claimRows(dataDir)
  assert.equal(after.length, 2)
  assert.deepEqual(
    after.map(row => `${row.chat_id_display}:${row.actor_fingerprint.slice(0, 12)}`),
    [
      `Alice:${alice.fingerprint.slice(0, 12)}`,
      `alice:${bob.fingerprint.slice(0, 12)}`,
    ],
  )

  // Documented choice: the token is left to expire naturally — it still
  // authenticates (reaching an unregistered actor route — /api/rooms until
  // its story lands — 404 after the auth gate, never 401; /api/status itself
  // went live in Story 1.6), and connecting again re-claims a name.
  const stillAuthenticates = await request(record.port, 'GET', '/api/rooms', {
    headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${aliceSession.sessionToken}` },
  })
  assert.equal(stillAuthenticates.status, 404)
  assert.equal(stillAuthenticates.json().error.code, 'route_not_found')
  const reconnect = await sessionRequest(record.port, 'POST', aliceSession.sessionToken, { chat_id: 'bob' })
  assert.equal(reconnect.status, 200, reconnect.text)

  await stop()
})

test('claims are durable across restart; the live registry is not', async t => {
  const dataDir = makeDataDir(t)
  const first = spawnServerChild(t, dataDir)
  const firstRecord = await first.waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const bob = installation()
  await connectInstallation(firstRecord.port, localToken, alice, 'Alice')
  await first.stop()

  // The claim row survived the restart; the session registry did not (the
  // old token is invalid on the new process).
  const rows = claimRows(dataDir)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].chat_id_display, 'Alice')
  assert.equal(rows[0].actor_fingerprint, alice.fingerprint)

  const second = spawnServerChild(t, dataDir)
  const secondRecord = await second.waitReady()
  // The old session token died with the process...
  const stale = await sessionRequest(secondRecord.port, 'POST', 'not-a-token-anywhere', { chat_id: 'alice' })
  assert.equal(stale.status, 401)
  // ...and the live registry is empty: a fresh session claims the name that
  // would have collided before the restart.
  const bobSession = await connectInstallation(secondRecord.port, localToken, bob, 'Alice')
  assert.ok(bobSession.sessionToken)
  assert.equal(claimRows(dataDir).length, 2, 'both Actors now hold durable claims on the name')

  await second.stop()
})

test('multiple Actors may hold durable claims on one name; live uniqueness still applies', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const bob = installation()
  const carol = installation()

  const aliceSession = await connectInstallation(record.port, localToken, alice, 'bob')
  await sessionRequest(record.port, 'DELETE', aliceSession.sessionToken)
  await connectInstallation(record.port, localToken, bob, 'bob')

  const rows = claimRows(dataDir)
  assert.equal(rows.length, 2, 'two durable claim rows on "bob" (ambiguity data)')
  assert.deepEqual(
    rows.map(row => row.actor_fingerprint),
    [alice.fingerprint, bob.fingerprint].sort(),
  )

  // Live: only Bob holds "bob" right now — Carol is refused.
  const carolAuth = await exchange(record.port, carol, localToken)
  const probe = await sessionRequest(record.port, 'POST', carolAuth.json().result.session_token, { chat_id: 'BOB' })
  assert.equal(probe.status, 409)
  assert.equal(probe.json().error.code, 'chat_id_taken')

  await stop()
})

test('the boot prune deletes claim rows older than the TTL and keeps recent ones', async t => {
  const dataDir = makeDataDir(t)
  const first = spawnServerChild(t, dataDir)
  const firstRecord = await first.waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const bob = installation()
  await connectInstallation(firstRecord.port, localToken, alice, 'Alice')
  await connectInstallation(firstRecord.port, localToken, bob, 'Bob')
  await first.stop()

  // Backdate Alice's claim past the 7 day TTL; Bob's stays recent.
  const raw = new DatabaseSync(join(dataDir, DB_PATH_NAME))
  raw.exec("UPDATE chat_id_claims SET last_seen_at = '2020-01-01T00:00:00.000Z' WHERE chat_id_normalized = 'alice'")
  raw.close()

  const second = spawnServerChild(t, dataDir)
  await second.waitReady()
  const rows = claimRows(dataDir)
  assert.deepEqual(rows.map(row => row.chat_id_display), ['Bob'], 'the stale claim was pruned on boot; the recent one stayed')
  await second.stop()
})

test('claimsTtlMs is operator-tunable via startServer', async t => {
  const dataDir = makeDataDir(t)

  const firstRegistry = createSessionRegistry()
  const firstServer = await startServer({
    dataDir,
    sessionRegistry: firstRegistry,
    liveSessionRegistry: createLiveSessionRegistry(),
  })
  try {
    const localToken = loadOrCreateLocalToken(dataDir)
    const alice = installation()
    await connectInstallation(firstServer.port, localToken, alice, 'Alice')
  } finally {
    await firstServer.close()
  }

  // Backdate just past a one-second TTL: the boot prune under the tuned
  // constant deletes the row the 7-day default would have kept.
  const raw = new DatabaseSync(join(dataDir, DB_PATH_NAME))
  raw.exec(`UPDATE chat_id_claims SET last_seen_at = '${new Date(Date.now() - 2 * 1000).toISOString()}'`)
  raw.close()

  const secondServer = await startServer({
    dataDir,
    sessionRegistry: createSessionRegistry(),
    liveSessionRegistry: createLiveSessionRegistry(),
    claimsTtlMs: 1000,
  })
  try {
    assert.deepEqual(claimRows(dataDir), [], 'the tuned TTL pruned at boot')
  } finally {
    await secondServer.close()
  }
})

test('no session, no state change: the session surface answers 401 and writes nothing', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()

  const anonymous = { [PROTOCOL_KEY]: '1' }
  const missing = await request(record.port, 'POST', '/api/session', { headers: anonymous, body: JSON.stringify({ chat_id: 'Alice' }) })
  assert.equal(missing.status, 401)
  assert.equal(missing.json().error.code, 'unauthorized')
  const missingPatch = await request(record.port, 'PATCH', '/api/session', { headers: anonymous, body: JSON.stringify({ chat_id: 'Bob' }) })
  assert.equal(missingPatch.status, 401)
  const missingDelete = await request(record.port, 'DELETE', '/api/session', { headers: anonymous })
  assert.equal(missingDelete.status, 401)

  // A wrong credential is the same refusal.
  const wrong = await request(record.port, 'POST', '/api/session', {
    headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${'w'.repeat(43)}` },
    body: JSON.stringify({ chat_id: 'Alice' }),
  })
  assert.equal(wrong.status, 401)
  assert.equal(wrong.json().error.code, 'unauthorized')

  assert.deepEqual(claimRows(dataDir), [], 'credential-less rejections never touch the claims index')
  await stop()
})

test('unknown fields are rejected, not ignored, on the session surface', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const auth = await exchange(record.port, alice, localToken)
  const sessionToken = auth.json().result.session_token

  const extra = await request(record.port, 'POST', '/api/session', {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${sessionToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ chat_id: 'Alice', room_id: 'r1' }),
  })
  assert.equal(extra.status, 400)
  assert.equal(extra.json().error.code, 'unknown_field')
  assert.match(extra.json().error.message, /"room_id"/)

  // DELETE carries no body on this API: a declared body is malformed.
  const deleteBody = await request(record.port, 'DELETE', '/api/session', {
    headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${sessionToken}`, 'content-length': '2' },
  })
  assert.equal(deleteBody.status, 400)
  assert.equal(deleteBody.json().error.code, 'invalid_request')

  assert.deepEqual(claimRows(dataDir), [], 'field rejections never touch the claims index')
  await stop()
})

// --- Review-hardening rows (touch wiring, lease eviction, prune surface) ----

test('POST with a different free name swaps immediately: rename-equivalence at the wire', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const bob = installation()

  const aliceSession = await connectInstallation(record.port, localToken, alice, 'Alice')
  // POST — not PATCH — to a different free name: the swap is immediate and
  // the response echoes the newly accepted name.
  const swapped = await sessionRequest(record.port, 'POST', aliceSession.sessionToken, { chat_id: 'Bob' })
  assert.equal(swapped.status, 200, swapped.text)
  assert.equal(swapped.json().result.chat_id, 'Bob')

  // The old name was freed by the POST swap itself: the very next session
  // claims it without any DELETE.
  const bobSession = await connectInstallation(record.port, localToken, bob, 'alice')
  assert.ok(bobSession.sessionToken)

  const rows = claimRows(dataDir)
  assert.deepEqual(
    rows.map(row => `${row.chat_id_display}:${row.actor_fingerprint.slice(0, 12)}`),
    [
      `Alice:${alice.fingerprint.slice(0, 12)}`,
      `Bob:${alice.fingerprint.slice(0, 12)}`,
      `alice:${bob.fingerprint.slice(0, 12)}`,
    ],
  )

  await stop()
})

test('PATCH as the first verb claims a session that never connected, with a fresh lifetime', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()

  const auth = await exchange(record.port, alice, localToken)
  const sessionToken = auth.json().result.session_token
  const renamed = await sessionRequest(record.port, 'PATCH', sessionToken, { chat_id: 'Dora' })
  assert.equal(renamed.status, 200, renamed.text)
  const result = renamed.json().result
  assert.equal(result.chat_id, 'Dora')
  assert.ok(!Number.isNaN(Date.parse(result.connected_since)), 'a fresh bind stamps connected_since')

  const rows = claimRows(dataDir)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].chat_id_display, 'Dora')

  await stop()
})

test('the server touch wiring refreshes durable recency in one operation and clock', async t => {
  const dataDir = makeDataDir(t)
  let now = Date.now()
  const live = createLiveSessionRegistry({ now: () => now })
  const server = await startServer({
    dataDir,
    sessionRegistry: createSessionRegistry(),
    liveSessionRegistry: live,
  })
  try {
    const localToken = loadOrCreateLocalToken(dataDir)
    const alice = installation()
    const bob = installation()
    const aliceSession = await connectInstallation(server.port, localToken, alice, 'Alice')
    await connectInstallation(server.port, localToken, bob, 'Bob')
    assert.deepEqual(
      claimRows(dataDir).map(row => row.last_seen_at),
      [new Date(now).toISOString(), new Date(now).toISOString()],
      'connect wrote the registry clock time durably',
    )

    // Advance six days and touch Alice's session only: the in-memory row and
    // the durable claim row advance together, in one operation.
    now += 6 * 24 * 60 * 60 * 1000
    const touched = server.touchSession(sessionKeyFromToken(aliceSession.sessionToken))
    assert.ok(touched, 'the live session was touched')
    assert.equal(touched.lastSeen, now)

    // Defensive recency: two days later, a prune at the 7-day TTL keeps the
    // touched claim fresh and deletes the untouched one.
    now += 2 * 24 * 60 * 60 * 1000
    const pruner = openRoomLog({ dataDir })
    let pruned
    try {
      pruned = pruner.pruneChatIdClaims(CLAIMS_TTL_MS, now)
    } finally {
      pruner.close()
    }
    assert.equal(pruned, 1, 'the untouched stale claim was pruned')
    assert.deepEqual(
      claimRows(dataDir).map(row => row.chat_id_display),
      ['Alice'],
      'the live-touched claim stayed fresh against the 7-day window',
    )
  } finally {
    await server.close()
  }
})

test('an abandoned live lease is swept on the next claim; the durable claim row stays', async t => {
  const dataDir = makeDataDir(t)
  let now = Date.now()
  const live = createLiveSessionRegistry({ now: () => now })
  const server = await startServer({
    dataDir,
    sessionRegistry: createSessionRegistry(),
    liveSessionRegistry: live,
  })
  try {
    const localToken = loadOrCreateLocalToken(dataDir)
    const alice = installation()
    const bob = installation()
    await connectInstallation(server.port, localToken, alice, 'bob')
    assert.equal(claimRows(dataDir).length, 1)

    // The lease is the auth session TTL: past it without any DELETE, the
    // session is dead (crash, kill, expired token) and its name is freed by
    // the next claim's lazy sweep — no restart required.
    now += SESSION_TTL_MS + 1
    const bobSession = await connectInstallation(server.port, localToken, bob, 'bob')
    assert.ok(bobSession.sessionToken, 'the abandoned name was claimable')

    const rows = claimRows(dataDir)
    assert.equal(rows.length, 2, 'the swept session kept its durable claim row for ambiguity')
    assert.deepEqual(
      rows.map(row => row.actor_fingerprint).sort(),
      [alice.fingerprint, bob.fingerprint].sort(),
    )
  } finally {
    await server.close()
  }
})

test('a backdated row disappears mid-run on the tiny override interval while /health answers', async t => {
  const dataDir = makeDataDir(t)
  const server = await startServer({
    dataDir,
    sessionRegistry: createSessionRegistry(),
    liveSessionRegistry: createLiveSessionRegistry(),
    pruneIntervalMs: 50,
  })
  try {
    const localToken = loadOrCreateLocalToken(dataDir)
    await connectInstallation(server.port, localToken, installation(), 'Alice')
    assert.equal(claimRows(dataDir).length, 1, 'the row is live at boot (the boot prune kept it)')

    // Backdate after boot: only the interval prune can remove it now.
    backdateClaims(dataDir, '2020-01-01T00:00:00.000Z')
    const deadline = Date.now() + 3 * 1000
    while (claimRows(dataDir).length > 0 && Date.now() < deadline) await sleep(50)
    assert.equal(claimRows(dataDir).length, 0, 'the interval prune removed the stale row mid-run')

    const health = await request(server.port, 'GET', '/health')
    assert.equal(health.status, 200, 'the server kept serving')
  } finally {
    await server.close()
  }
})

test('a tuned claimsTtlMs clamps the prune interval to half the TTL', async t => {
  const dataDir = makeDataDir(t)
  const server = await startServer({
    dataDir,
    sessionRegistry: createSessionRegistry(),
    liveSessionRegistry: createLiveSessionRegistry(),
    claimsTtlMs: 1000,
  })
  try {
    const localToken = loadOrCreateLocalToken(dataDir)
    await connectInstallation(server.port, localToken, installation(), 'Alice')
    // Age the row past the tuned 1 s TTL; with the interval clamped to 500 ms
    // the row must go within a couple of seconds (an unclamped 1 h interval
    // would never reach it mid-run).
    await sleep(1200)
    const deadline = Date.now() + 4 * 1000
    while (claimRows(dataDir).length > 0 && Date.now() < deadline) await sleep(100)
    assert.equal(claimRows(dataDir).length, 0, 'the clamped interval pruned at the tuned pace')

    const health = await request(server.port, 'GET', '/health')
    assert.equal(health.status, 200)
  } finally {
    await server.close()
  }
})

test('a failing prune writes one stderr line and the next interval retries; the server keeps serving', async t => {
  const dataDir = makeDataDir(t)
  let calls = 0
  const seam = () => {
    calls += 1
    if (calls === 1) throw new Error('injected prune failure')
  }
  const { chunks } = await captureStderr(async () => {
    const server = await startServer({
      dataDir,
      sessionRegistry: createSessionRegistry(),
      liveSessionRegistry: createLiveSessionRegistry(),
      pruneIntervalMs: 25,
      pruneClaims: seam,
    })
    try {
      const deadline = Date.now() + 2 * 1000
      while (calls < 4 && Date.now() < deadline) await sleep(25)
      return await request(server.port, 'GET', '/health')
    } finally {
      await server.close()
    }
  })
  assert.ok(calls >= 4, 'the interval kept retrying after the failure')
  const failures = chunks.join('').split('\n').filter(line => line.includes('chat id claims prune failed'))
  assert.equal(failures.length, 1, 'exactly one bounded stderr line for the single failure')
  assert.match(failures[0], /injected prune failure/)
})

test('the direct-launch env override parses, validates, and falls back with one warning', () => {
  assert.deepEqual(claimsTtlMsFromEnv({}), { claimsTtlMs: CLAIMS_TTL_MS })
  assert.deepEqual(claimsTtlMsFromEnv({ AGENT_ROOM_CLAIMS_TTL_MS: '1000' }), { claimsTtlMs: 1000 })
  assert.deepEqual(claimsTtlMsFromEnv({ AGENT_ROOM_CLAIMS_TTL_MS: ' 2000 ' }), { claimsTtlMs: 2000 })
  assert.deepEqual(claimsTtlMsFromEnv({ AGENT_ROOM_CLAIMS_TTL_MS: '' }), { claimsTtlMs: CLAIMS_TTL_MS })
  for (const bad of ['banana', '0', '-5', '1.5', '1e9', `${Number.MAX_SAFE_INTEGER}0`]) {
    const outcome = claimsTtlMsFromEnv({ AGENT_ROOM_CLAIMS_TTL_MS: bad })
    assert.equal(outcome.claimsTtlMs, CLAIMS_TTL_MS, bad)
    assert.match(outcome.warning, /AGENT_ROOM_CLAIMS_TTL_MS/, bad)
  }
})

test('AGENT_ROOM_CLAIMS_TTL_MS tunes the boot prune of a spawned server', async t => {
  const dataDir = makeDataDir(t)
  // Produce one claim row, then backdate it just past a 1 s env-tuned TTL.
  const setup = await startServer({ dataDir })
  try {
    const localToken = loadOrCreateLocalToken(dataDir)
    await connectInstallation(setup.port, localToken, installation(), 'Alice')
  } finally {
    await setup.close()
  }
  backdateClaims(dataDir, new Date(Date.now() - 5 * 1000).toISOString())

  const { waitReady, stop } = spawnServerChild(t, dataDir, { AGENT_ROOM_CLAIMS_TTL_MS: '1000' })
  await waitReady()
  assert.deepEqual(claimRows(dataDir), [], 'the child boot-pruned at the env-tuned TTL')
  await stop()
})

test('an invalid AGENT_ROOM_CLAIMS_TTL_MS warns once and boots with the default', async t => {
  const dataDir = makeDataDir(t)
  const { child, waitReady, stop, stderrText } = spawnServerChild(t, dataDir, { AGENT_ROOM_CLAIMS_TTL_MS: 'banana' })
  const record = await waitReady()
  const health = await request(record.port, 'GET', '/health')
  assert.equal(health.status, 200, 'the invalid override never blocked the boot')

  const warnings = stderrText().split('\n').filter(line => line.includes('AGENT_ROOM_CLAIMS_TTL_MS'))
  assert.equal(warnings.length, 1, 'exactly one stderr warning line')
  assert.match(warnings[0], /positive integer/)

  await stop()
  assert.equal(child.exitCode, 0)
})

test('a rejected claim freezes chat-binding state but still slides the auth session (documented boundary)', async t => {
  const dataDir = makeDataDir(t)
  let now = Date.now()
  const auth = createSessionRegistry({ now: () => now })
  const server = await startServer({
    dataDir,
    sessionRegistry: auth,
    liveSessionRegistry: createLiveSessionRegistry(),
  })
  try {
    const localToken = loadOrCreateLocalToken(dataDir)
    const alice = installation()
    const bob = installation()
    await connectInstallation(server.port, localToken, alice, 'Alice')

    // Bob exchanges and attempts a colliding claim: the wire refusal writes
    // nothing anywhere in the chat-binding or store state.
    now += 1000
    const bobAuth = await exchange(server.port, bob, localToken)
    const bobToken = bobAuth.json().result.session_token
    const refused = await sessionRequest(server.port, 'POST', bobToken, { chat_id: 'alice' })
    assert.equal(refused.status, 409)
    assert.equal(refused.json().error.code, 'chat_id_taken')
    assert.equal(claimRows(dataDir).length, 1, 'the refused claim froze chat-binding and store state')

    // The zero-state boundary: the auth stage runs before the handler, so the
    // refused request still slid bob's 12 h session TTL. Past the original
    // expiry, the session is resolvable only because of that slide.
    now += SESSION_TTL_MS - 500
    const slid = await sessionRequest(server.port, 'POST', bobToken, { chat_id: 'Bob' })
    assert.equal(slid.status, 200, 'the rejected claim still slid the auth session TTL')
    assert.equal(claimRows(dataDir).length, 2)
  } finally {
    await server.close()
  }
})

test('closing a server that owns the default live registry leaves no stale names in-process', async t => {
  const dataDir = makeDataDir(t)
  const first = await startServer({ dataDir })
  try {
    const localToken = loadOrCreateLocalToken(dataDir)
    await connectInstallation(first.port, localToken, installation(), 'bob')
  } finally {
    await first.close()
  }

  // Same process, same module-default registry: the closed server's live row
  // must not squat the name for the next server.
  const second = await startServer({ dataDir })
  try {
    const localToken = loadOrCreateLocalToken(dataDir)
    const bob = installation()
    const again = await connectInstallation(second.port, localToken, bob, 'bob')
    assert.ok(again.sessionToken, 'the name was free after the owning server closed')
  } finally {
    await second.close()
  }
})
