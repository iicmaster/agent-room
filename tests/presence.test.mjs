// Story 1.6 acceptance: presence — online & offline-recently — over the real
// HTTP path. Every matrix row runs against either a real spawned server child
// (node:test with real child processes) or an in-process startServer with
// injectable clocks for the TTL/window boundaries; sessions come from the
// Story 1.4 path (the 0600 local token file exchanged at POST /api/auth/local
// for a session token), with two+ distinct keypairs so Actor fingerprints
// differ. The rows cover the online row shape (one per Session, connect
// order, same-Actor multi-session), the closed-set client_type bind field
// (including null-as-absent and rename carry-over), liveness refreshed by any
// authenticated request (the one touch mechanism, including its failure
// path), TTL expiry as a pure view change (an idle session is hidden, never
// evicted — reads never free names; the 12 h claim-time lease sweep remains
// the only name-freeing path), the inclusive 24 h offline window with a
// future-dated rollback guard, no double-listing across groups, the
// most-recent-claim-per-Actor dedupe (within and across Actors), the reader's
// own Actor never listed offline, restart survival through the claims index
// after an explicit disconnect, viewer/health/pre-auth isolation, the
// unreachable-server dial (a connection error, never a 200), credential-less
// refusals with zero state change, the strict include_offline query
// allowlist, the operator-tunable presence TTL (option + env), and the
// payload-vocabulary contract (every presence/status payload key is a frozen
// AD-8 response name).
//
// Durable claim rows are inspected on the WAL SQLite file with a second
// connection while the server holds the writer (the session-routes style).

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import http from 'node:http'
import net from 'node:net'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import { APP_VERSION } from '../server/runtime.mjs'
import {
  CLAIMS_TTL_MS,
  OFFLINE_RECENTLY_WINDOW_MS,
  PRESENCE_TTL_MS,
  PUBLIC_ERRORS,
  SESSION_TTL_MS,
} from '../server/constants.mjs'
import { loadOrCreateLocalToken } from '../server/api/local-token.mjs'
import { createLiveSessionRegistry } from '../server/core/session-registry.mjs'
import { createSessionRegistry, sessionKeyFromToken } from '../server/api/session.mjs'
import { fingerprintFromPublicKey } from '../server/keys.mjs'
import { presenceTtlMsFromEnv, startServer } from '../server/api/server.mjs'
import { RESPONSE_FIELD_VOCABULARY } from '../server/api/routes.mjs'
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

function makeDataDir(t, prefix = 'agent-room-presence-') {
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

async function sessionTokenFor(port, localToken, installation_) {
  const auth = await exchange(port, installation_, localToken)
  assert.equal(auth.status, 200, auth.text)
  return auth.json().result.session_token
}

// Bind (or re-bind) a session to a chat id, optionally declaring the
// closed-set client type (null passes through as an explicit "no type").
async function bind(port, sessionToken, chatId, clientType, method = 'POST') {
  const body = { chat_id: chatId }
  if (clientType !== undefined) body.client_type = clientType
  return request(port, method, '/api/session', {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${sessionToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(body),
  })
}

async function disconnect(port, sessionToken) {
  return request(port, 'DELETE', '/api/session', {
    headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${sessionToken}` },
  })
}

function presenceGet(port, sessionToken, query = '') {
  return request(port, 'GET', `/api/presence${query}`, {
    headers: { [PROTOCOL_KEY]: '1', ...(sessionToken === undefined ? {} : { authorization: `Bearer ${sessionToken}` }) },
  })
}

function statusGet(port, sessionToken) {
  return request(port, 'GET', '/api/status', {
    headers: { [PROTOCOL_KEY]: '1', ...(sessionToken === undefined ? {} : { authorization: `Bearer ${sessionToken}` }) },
  })
}

// Durable claim rows, read straight from the store's SQLite file with a
// second connection (the session-routes inspection style).
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

function claimLastSeen(dataDir, chatIdNormalized) {
  const db = new DatabaseSync(join(dataDir, DB_PATH_NAME))
  try {
    const row = db.prepare(
      'SELECT last_seen_at FROM chat_id_claims WHERE chat_id_normalized = ?',
    ).get(chatIdNormalized)
    return row ? row.last_seen_at : null
  } finally {
    db.close()
  }
}

// An in-process server with ONE injectable clock driving both registries —
// the same clock source for auth TTL, presence liveness, and claim writes.
// Returns the registries so rows can assert liveness directly.
async function clockedServer(t, dataDir, nowRef) {
  const sessionRegistry = createSessionRegistry({ now: () => nowRef.now })
  const liveSessionRegistry = createLiveSessionRegistry({ now: () => nowRef.now })
  const server = await startServer({ dataDir, sessionRegistry, liveSessionRegistry })
  t.after(() => server.close())
  return { server, sessionRegistry, liveSessionRegistry }
}

// Captures process.stderr writes around an async body (the local-auth
// pattern) for the touch-failure and bootstrap-invariant rows.
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

// Contract helper: every object key in a payload (recursively) must be a
// frozen AD-8 response-vocabulary name — the drift class the review flagged
// must fail tests, not ship.
function assertVocabularyKeys(value, vocabulary, path = 'result') {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertVocabularyKeys(item, vocabulary, `${path}[${index}]`))
    return
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      assert.ok(
        vocabulary.includes(key),
        `${path}.${key} is outside the frozen response vocabulary`,
      )
      assertVocabularyKeys(child, vocabulary, `${path}.${key}`)
    }
  }
}

// --- Matrix rows: the online group ------------------------------------------------

test('online rows: one per live Session, in connect order, with the full row shape', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const bob = installation()

  const aliceToken = await sessionTokenFor(record.port, localToken, alice)
  const aliceBind = await bind(record.port, aliceToken, 'Alice', 'mcp')
  assert.equal(aliceBind.status, 200, aliceBind.text)
  const bobToken = await sessionTokenFor(record.port, localToken, bob)
  const bobBind = await bind(record.port, bobToken, 'Bob', 'cli')
  assert.equal(bobBind.status, 200, bobBind.text)

  const read = await presenceGet(record.port, bobToken)
  assert.equal(read.status, 200, read.text)
  assert.equal(read.headers[PROTOCOL_KEY], '1')
  const result = read.json().result
  // The response separates the two explicitly-labeled groups; without the
  // flag the offline group is empty.
  assert.deepEqual(Object.keys(result).sort(), ['offline_recently', 'online'])
  assert.deepEqual(result.offline_recently, [])
  assert.equal(result.online.length, 2, 'one row per live Session')
  // Connect order: the first-bound session is the first row.
  assert.deepEqual(
    result.online.map(row => row.fingerprint),
    [alice.fingerprint, bob.fingerprint],
  )

  const aliceRow = result.online[0]
  const bobRow = result.online[1]
  for (const row of [aliceRow, bobRow]) {
    assert.deepEqual(Object.keys(row).sort(), ['chat_id', 'client_type', 'connected_since', 'fingerprint', 'last_seen'])
    assert.ok(!Number.isNaN(Date.parse(row.connected_since)), 'connected_since is a timestamp')
    assert.ok(!Number.isNaN(Date.parse(row.last_seen)), 'last_seen is a timestamp')
  }
  assert.equal(aliceRow.chat_id, 'Alice', 'the display form, never the lowercase key')
  assert.equal(aliceRow.client_type, 'mcp')
  assert.equal(bobRow.chat_id, 'Bob')
  assert.equal(bobRow.client_type, 'cli')

  await stop()
})

test('one Actor holding two live sessions lists both rows in online', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()

  // One installation, two sessions (two tokens, one fingerprint): presence
  // is one row per SESSION, not per Actor.
  const firstToken = await sessionTokenFor(record.port, localToken, alice)
  const secondToken = await sessionTokenFor(record.port, localToken, alice)
  assert.equal((await bind(record.port, firstToken, 'One', 'mcp')).status, 200)
  assert.equal((await bind(record.port, secondToken, 'Two', 'cli')).status, 200)

  const result = (await presenceGet(record.port, firstToken)).json().result
  assert.equal(result.online.length, 2)
  assert.deepEqual(
    result.online.map(row => [row.chat_id, row.client_type, row.fingerprint]),
    [
      ['One', 'mcp', alice.fingerprint],
      ['Two', 'cli', alice.fingerprint],
    ],
  )

  await stop()
})

test('client_type: closed-set values bind; invalid refuses 400; null and omissions carry over', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const bob = installation()

  const aliceToken = await sessionTokenFor(record.port, localToken, alice)
  assert.equal((await bind(record.port, aliceToken, 'Alice', 'mcp')).status, 200)
  const bobToken = await sessionTokenFor(record.port, localToken, bob)
  // An omitted declaration is valid: the row's type stays null — the server
  // never derives one (v0.1's MCP-client-derived naming is retired).
  assert.equal((await bind(record.port, bobToken, 'Bob')).status, 200)

  const refused = await bind(record.port, aliceToken, 'Alice', 'bot')
  assert.equal(refused.status, 400, refused.text)
  assert.equal(refused.json().error.code, 'invalid_request')
  assert.match(refused.json().error.message, /client_type must be one of: mcp, cli, api/)
  const nonString = await bind(record.port, aliceToken, 'Alice', 42)
  assert.equal(nonString.status, 400)
  assert.equal(nonString.json().error.code, 'invalid_request')

  // An explicit null is treated as absent (the chat_id convention for "not
  // provided"): accepted, and the declared type is kept.
  const nulled = await bind(record.port, aliceToken, 'Alice', null)
  assert.equal(nulled.status, 200, nulled.text)

  // The refusals changed nothing: both rows intact with their declared types.
  const result = (await presenceGet(record.port, aliceToken)).json().result
  assert.equal(result.online.length, 2)
  assert.equal(result.online.find(row => row.fingerprint === alice.fingerprint).client_type, 'mcp')
  assert.equal(result.online.find(row => row.fingerprint === bob.fingerprint).client_type, null)
  assert.equal(claimRows(dataDir).length, 2)

  // A rename with a declared type updates it; a rename without one — same
  // name or different name — carries the row's type over, exactly like
  // connectedSince (a rename is not an undeclaration).
  const renamed = await bind(record.port, aliceToken, 'Alicia', 'cli', 'PATCH')
  assert.equal(renamed.status, 200, renamed.text)
  const afterRename = (await presenceGet(record.port, aliceToken)).json().result
  const aliciaRow = afterRename.online.find(row => row.fingerprint === alice.fingerprint)
  assert.equal(aliciaRow.chat_id, 'Alicia')
  assert.equal(aliciaRow.client_type, 'cli')
  const rebind = await bind(record.port, aliceToken, 'Alicia', undefined, 'PATCH')
  assert.equal(rebind.status, 200, rebind.text)
  const swapped = await bind(record.port, aliceToken, 'Alina', undefined, 'PATCH')
  assert.equal(swapped.status, 200, swapped.text)
  const afterSwap = (await presenceGet(record.port, aliceToken)).json().result
  assert.equal(
    afterSwap.online.find(row => row.fingerprint === alice.fingerprint).client_type,
    'cli',
    'the different-name rename carried the declared type over',
  )

  await stop()
})

// --- Matrix rows: liveness refresh and TTL expiry ---------------------------------

test('any authenticated request refreshes liveness: last_seen advances, connected_since holds', async t => {
  const dataDir = makeDataDir(t)
  const nowRef = { now: Date.now() }
  const { server } = await clockedServer(t, dataDir, nowRef)
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const aliceToken = await sessionTokenFor(server.port, localToken, alice)
  assert.equal((await bind(server.port, aliceToken, 'Alice', 'mcp')).status, 200)

  // A later authenticated request — GET /api/status, not a bind — is the
  // liveness surface: the touch advances the session's last_seen and the
  // durable claim row with it, in one mechanism.
  nowRef.now += 60 * 1000
  assert.equal((await statusGet(server.port, aliceToken)).status, 200)

  const result = (await presenceGet(server.port, aliceToken)).json().result
  const row = result.online.find(entry => entry.fingerprint === alice.fingerprint)
  assert.equal(row.last_seen, new Date(nowRef.now).toISOString(), 'last_seen advanced to the touch')
  assert.notEqual(row.connected_since, row.last_seen, 'the session lifetime did not reset')
  assert.equal(claimLastSeen(dataDir, 'alice'), new Date(nowRef.now).toISOString(), 'the durable claim advanced too')
})

test('TTL expiry is a pure view change: hidden past 180 s, alive underneath, name never freed by reads', async t => {
  const dataDir = makeDataDir(t)
  const nowRef = { now: Date.now() }
  const { server, liveSessionRegistry } = await clockedServer(t, dataDir, nowRef)
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const bob = installation()
  const aliceToken = await sessionTokenFor(server.port, localToken, alice)
  assert.equal((await bind(server.port, aliceToken, 'Alice')).status, 200)
  const aliceKey = sessionKeyFromToken(aliceToken)
  // Bob is the reader: authenticated, never bound — his requests touch
  // nothing and his fingerprint holds no claim.
  const bobToken = await sessionTokenFor(server.port, localToken, bob)

  // Exactly at the TTL: not strictly older, so still visible online.
  nowRef.now += PRESENCE_TTL_MS
  const atTtl = (await presenceGet(server.port, bobToken)).json().result
  assert.equal(atTtl.online.length, 1)
  assert.equal(atTtl.online[0].fingerprint, alice.fingerprint)

  // One millisecond past: the row is hidden from online and surfaces in the
  // separately-labeled offline group from the durable claim row — and
  // NOTHING was evicted: the live row is still there (a third party's read
  // never breaks the 12 h lease).
  nowRef.now += 1
  const past = (await presenceGet(server.port, bobToken, '?include_offline=true')).json().result
  assert.deepEqual(past.online, [])
  assert.equal(past.offline_recently.length, 1)
  assert.deepEqual(past.offline_recently[0], {
    chat_id: 'Alice',
    fingerprint: alice.fingerprint,
    last_seen: new Date(nowRef.now - 1 - PRESENCE_TTL_MS).toISOString(),
  })
  const hiddenRow = liveSessionRegistry.lookup(aliceKey)
  assert.ok(hiddenRow, 'the idle session is hidden, not evicted')
  assert.equal(hiddenRow.lastSeen, nowRef.now - 1 - PRESENCE_TTL_MS)

  // The name was never freed by the reads: a claimant is still refused.
  const carol = installation()
  const carolToken = await sessionTokenFor(server.port, localToken, carol)
  const stillTaken = await bind(server.port, carolToken, 'Alice')
  assert.equal(stillTaken.status, 409)
  assert.equal(stillTaken.json().error.code, 'chat_id_taken')
  assert.equal(claimRows(dataDir).length, 1, 'the refused claimant wrote nothing')

  // The claim-time lease sweep remains the only name-freeing path: past the
  // 12 h lease without any request, the next claim sweeps the dead session
  // and frees the name (carol re-exchanges — her earlier token aged out).
  nowRef.now += SESSION_TTL_MS + 1
  const freshCarol = await sessionTokenFor(server.port, localToken, carol)
  const reclaimed = await bind(server.port, freshCarol, 'Alice')
  assert.equal(reclaimed.status, 200, 'the lease sweep — not the read — freed the name')
  assert.equal(claimRows(dataDir).length, 2, 'the swept session kept its durable claim row')
})

test('an idle session past the TTL reappears online without re-binding after its next request', async t => {
  const dataDir = makeDataDir(t)
  const nowRef = { now: Date.now() }
  const { server } = await clockedServer(t, dataDir, nowRef)
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const bob = installation()
  const aliceToken = await sessionTokenFor(server.port, localToken, alice)
  assert.equal((await bind(server.port, aliceToken, 'Alice')).status, 200)
  const bobToken = await sessionTokenFor(server.port, localToken, bob)

  // 181 s of silence: hidden from online, listed offline from the claim.
  nowRef.now += 181 * 1000
  const hidden = (await presenceGet(server.port, bobToken, '?include_offline=true')).json().result
  assert.deepEqual(hidden.online, [])
  assert.deepEqual(hidden.offline_recently.map(row => row.fingerprint), [alice.fingerprint])

  // The SAME session token authenticates one request: the touch revives the
  // still-live row — no re-bind, no collision, lifetime preserved.
  assert.equal((await statusGet(server.port, aliceToken)).status, 200)
  const revived = (await presenceGet(server.port, bobToken, '?include_offline=true')).json().result
  assert.equal(revived.online.length, 1)
  assert.equal(revived.online[0].fingerprint, alice.fingerprint)
  assert.equal(revived.online[0].connected_since, new Date(nowRef.now - 181 * 1000).toISOString())
  assert.equal(revived.online[0].last_seen, new Date(nowRef.now).toISOString())
  assert.deepEqual(revived.offline_recently, [], 'the revived session never double-lists')
})

test('offline window boundary: exactly 24 h is in the group; 1 ms beyond is out', async t => {
  const dataDir = makeDataDir(t)
  const nowRef = { now: Date.now() }
  const { server } = await clockedServer(t, dataDir, nowRef)
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const bob = installation()
  const aliceToken = await sessionTokenFor(server.port, localToken, alice)
  assert.equal((await bind(server.port, aliceToken, 'Alice')).status, 200)

  // Jump the clock 24 h: bob's original token died with its sliding TTL, so
  // he re-exchanges (same installation, same fingerprint) at the new time.
  nowRef.now += OFFLINE_RECENTLY_WINDOW_MS
  const bobToken = await sessionTokenFor(server.port, localToken, bob)
  const atWindow = (await presenceGet(server.port, bobToken, '?include_offline=true')).json().result
  assert.deepEqual(atWindow.online, [], 'the idle session is hidden past the presence TTL')
  assert.equal(atWindow.offline_recently.length, 1, 'a claim seen exactly 24 h ago is still in the group')
  assert.equal(atWindow.offline_recently[0].fingerprint, alice.fingerprint)

  nowRef.now += 1
  const beyond = (await presenceGet(server.port, bobToken, '?include_offline=true')).json().result
  assert.deepEqual(beyond.offline_recently, [], 'a claim seen 24 h + 1 ms ago is out')
  // The durable row itself is untouched by the window — only the view moves.
  assert.ok(claimLastSeen(dataDir, 'alice'))
})

// --- Matrix rows: group discipline ------------------------------------------------

test('no double-listing: an online Actor with a durable claim appears in online only', async t => {
  const dataDir = makeDataDir(t)
  const nowRef = { now: Date.now() }
  const { server } = await clockedServer(t, dataDir, nowRef)
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const bob = installation()
  const aliceToken = await sessionTokenFor(server.port, localToken, alice)
  assert.equal((await bind(server.port, aliceToken, 'Alice')).status, 200)
  const bobToken = await sessionTokenFor(server.port, localToken, bob)

  const result = (await presenceGet(server.port, bobToken, '?include_offline=true')).json().result
  assert.equal(result.online.length, 1)
  assert.equal(result.online[0].fingerprint, alice.fingerprint)
  assert.deepEqual(result.offline_recently, [], 'the online Actor’s fresh claim never double-lists offline')
  assert.equal(claimRows(dataDir).length, 1, 'the durable claim exists')
})

test('offline dedupe: one row per Actor — the most recent claim wins', async t => {
  const dataDir = makeDataDir(t)
  const nowRef = { now: Date.now() }
  const { server } = await clockedServer(t, dataDir, nowRef)
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const bob = installation()
  const aliceToken = await sessionTokenFor(server.port, localToken, alice)
  // Three historical (name, actor) claims for one Actor, each fresher than
  // the last.
  assert.equal((await bind(server.port, aliceToken, 'Zeta')).status, 200)
  nowRef.now += 1000
  assert.equal((await bind(server.port, aliceToken, 'Yankee', undefined, 'PATCH')).status, 200)
  nowRef.now += 1000
  const xavierSeenAt = nowRef.now
  assert.equal((await bind(server.port, aliceToken, 'Xavier', undefined, 'PATCH')).status, 200)
  assert.equal(claimRows(dataDir).length, 3)
  const bobToken = await sessionTokenFor(server.port, localToken, bob)

  nowRef.now += 200 * 1000
  const result = (await presenceGet(server.port, bobToken, '?include_offline=true')).json().result
  assert.deepEqual(result.online, [])
  assert.equal(result.offline_recently.length, 1, 'one row per Actor, not one per claim')
  assert.deepEqual(result.offline_recently[0], {
    chat_id: 'Xavier',
    fingerprint: alice.fingerprint,
    last_seen: new Date(xavierSeenAt).toISOString(),
  })
})

test('offline rows are most-recent-first across Actors', async t => {
  const dataDir = makeDataDir(t)
  const nowRef = { now: Date.now() }
  const { server } = await clockedServer(t, dataDir, nowRef)
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const bob = installation()
  const carol = installation()
  const aliceToken = await sessionTokenFor(server.port, localToken, alice)
  assert.equal((await bind(server.port, aliceToken, 'Alice')).status, 200)
  nowRef.now += 1000
  const bobToken = await sessionTokenFor(server.port, localToken, bob)
  assert.equal((await bind(server.port, bobToken, 'Bob')).status, 200)
  // Carol reads: authenticated, never bound, no claim of her own.
  nowRef.now += 200 * 1000
  const carolToken = await sessionTokenFor(server.port, localToken, carol)

  const result = (await presenceGet(server.port, carolToken, '?include_offline=true')).json().result
  assert.deepEqual(result.online, [], 'both sessions are hidden past the presence TTL')
  assert.deepEqual(
    result.offline_recently.map(row => row.fingerprint),
    [bob.fingerprint, alice.fingerprint],
    'the group is ordered most-recently-seen first across Actors',
  )
})

test('the reading session’s own Actor never appears in the offline group', async t => {
  const dataDir = makeDataDir(t)
  const nowRef = { now: Date.now() }
  const { server } = await clockedServer(t, dataDir, nowRef)
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const bob = installation()
  const aliceToken = await sessionTokenFor(server.port, localToken, alice)
  assert.equal((await bind(server.port, aliceToken, 'Alice')).status, 200)
  // Alice disconnects: her live row is gone but her durable claim stays —
  // reading her own stale claim would be noise.
  assert.equal((await disconnect(server.port, aliceToken)).status, 200)
  const bobToken = await sessionTokenFor(server.port, localToken, bob)
  assert.equal((await bind(server.port, bobToken, 'Bob')).status, 200)

  nowRef.now += 200 * 1000
  // Alice reads: her own claim is suppressed; Bob's silent session is hidden
  // from online, so he is offline-recently.
  const aliceView = (await presenceGet(server.port, aliceToken, '?include_offline=true')).json().result
  assert.deepEqual(aliceView.online, [])
  assert.equal(aliceView.offline_recently.length, 1)
  assert.equal(aliceView.offline_recently[0].fingerprint, bob.fingerprint)
  assert.equal(
    aliceView.offline_recently.some(row => row.fingerprint === alice.fingerprint),
    false,
    'the reader’s own Actor is never listed offline',
  )

  // Bob reads: his own claim is suppressed; Alice is the offline-recently row.
  const bobView = (await presenceGet(server.port, bobToken, '?include_offline=true')).json().result
  assert.deepEqual(bobView.offline_recently.map(row => row.fingerprint), [alice.fingerprint])
})

test('presenceSnapshot is pure: the now override and window drive the view without touching rows', () => {
  const fingerprint = `sha256:${'a'.repeat(64)}`
  let now = 1_000_000
  const live = createLiveSessionRegistry({ now: () => now })
  live.claim({ sessionKey: 'k1', chatId: 'Alice', actorFingerprint: fingerprint, clientType: 'mcp' })
  const claims = [{
    chat_id: 'Alice',
    chat_id_normalized: 'alice',
    actor_fingerprint: fingerprint,
    last_seen_at: new Date(1_000_000).toISOString(),
  }]
  // The injected reader asserts the resolved clock and the registry-owned
  // window it was called with.
  let expectedWindowMs = null
  let expectedNowMs = null
  const readClaims = (windowMs, nowMs) => {
    assert.equal(windowMs, expectedWindowMs, 'the registry owns the window constant')
    assert.equal(nowMs, expectedNowMs, 'the read passes its resolved clock to the claims reader')
    return claims
  }

  // The now override wins over the registry's clock: the row is hidden at
  // the overridden read while the row itself stays untouched.
  const overriddenAt = 1_000_000 + 181_000
  expectedWindowMs = OFFLINE_RECENTLY_WINDOW_MS
  expectedNowMs = overriddenAt
  const overridden = live.presenceSnapshot({
    now: overriddenAt,
    includeOffline: true,
    claimsReader: readClaims,
    readerFingerprint: `sha256:${'b'.repeat(64)}`,
  })
  assert.deepEqual(overridden.online, [])
  assert.deepEqual(overridden.offline_recently.map(row => row.fingerprint), [fingerprint])
  assert.equal(live.lookup('k1').lastSeen, 1_000_000, 'the override mutated nothing')

  // The registry's own clock still sees the row as fresh.
  expectedNowMs = 1_000_000
  const fresh = live.presenceSnapshot({ includeOffline: true, claimsReader: readClaims })
  assert.equal(fresh.online.length, 1)
  assert.equal(fresh.online[0].connected_since, new Date(1_000_000).toISOString())
  assert.equal(fresh.online[0].client_type, 'mcp')

  // The override is validated: a non-finite resolution is a coded failure.
  assert.throws(() => live.presenceSnapshot({ now: Number.NaN }), /finite epoch-millisecond/)
  assert.throws(() => live.presenceSnapshot({ now: () => 'nope' }), /finite epoch-millisecond/)
})

// --- Matrix rows: restart, isolation, unreachability ------------------------------

test('offline-recently survives a restart through the durable claims index', async t => {
  const dataDir = makeDataDir(t)
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const bob = installation()

  const first = spawnServerChild(t, dataDir)
  const firstRecord = await first.waitReady()
  const aliceToken = await sessionTokenFor(firstRecord.port, localToken, alice)
  assert.equal((await bind(firstRecord.port, aliceToken, 'Alice', 'mcp')).status, 200)
  // The matrix row is explicit: connect, DISCONNECT, restart, include_offline.
  assert.equal((await disconnect(firstRecord.port, aliceToken)).status, 200)
  await first.stop()

  // The live registry died with the process; the claim row did not.
  const second = spawnServerChild(t, dataDir)
  const secondRecord = await second.waitReady()
  const bobToken = await sessionTokenFor(secondRecord.port, localToken, bob)
  const result = (await presenceGet(secondRecord.port, bobToken, '?include_offline=true')).json().result
  assert.deepEqual(result.online, [], 'the restart cleared the live registry')
  assert.equal(result.offline_recently.length, 1)
  assert.deepEqual(result.offline_recently[0], {
    chat_id: 'Alice',
    fingerprint: alice.fingerprint,
    last_seen: claimLastSeen(dataDir, 'alice'),
  })
  await second.stop()
})

test('viewer activity never creates or refreshes presence; an authenticated request does', async t => {
  const dataDir = makeDataDir(t)
  const nowRef = { now: Date.now() }
  const sessionRegistry = createSessionRegistry({ now: () => nowRef.now })
  const liveSessionRegistry = createLiveSessionRegistry({ now: () => nowRef.now })
  // The Epic 5 viewer shape: the viewer verifier slot accepts its own
  // credential class — and must never reach the presence machinery.
  const server = await startServer({
    dataDir,
    sessionRegistry,
    liveSessionRegistry,
    viewerVerifier: () => ({ viewer: true }),
  })
  t.after(() => server.close())
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const aliceToken = await sessionTokenFor(server.port, localToken, alice)
  assert.equal((await bind(server.port, aliceToken, 'Alice')).status, 200)
  const aliceKey = sessionKeyFromToken(aliceToken)

  nowRef.now += 60 * 1000
  for (let index = 0; index < 3; index += 1) {
    // Since Stories 5.1+5.2 the viewer routes are all live, so the probe
    // rides a NON-ASSET path under the registered wildcard: the viewer
    // verifier ran and accepted (the wildcard answers route_not_found for a
    // name it does not serve, after the auth gate, never 401) — and touched
    // nothing.
    const viewerRequest = await request(server.port, 'GET', '/viewer/not-a-viewer-asset')
    assert.equal(viewerRequest.status, 404)
    assert.equal(viewerRequest.json().error.code, 'route_not_found')
  }
  assert.equal(liveSessionRegistry.lookup(aliceKey).lastSeen, nowRef.now - 60 * 1000, 'viewer activity never refreshed liveness')
  assert.equal(claimLastSeen(dataDir, 'alice'), new Date(nowRef.now - 60 * 1000).toISOString(), 'nor the durable claim')

  // Positive control: one authenticated request advances the same clock.
  assert.equal((await statusGet(server.port, aliceToken)).status, 200)
  assert.equal(liveSessionRegistry.lookup(aliceKey).lastSeen, nowRef.now)
})

test('/health and pre-auth exchanges never touch; a viewer credential on /api/presence is 401 with no touch', async t => {
  const dataDir = makeDataDir(t)
  const nowRef = { now: Date.now() }
  const { server, liveSessionRegistry } = await clockedServer(t, dataDir, nowRef)
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const carol = installation()
  const aliceToken = await sessionTokenFor(server.port, localToken, alice)
  assert.equal((await bind(server.port, aliceToken, 'Alice')).status, 200)
  const aliceKey = sessionKeyFromToken(aliceToken)

  // Unauthenticated health + a pre-auth credential exchange (which mints a
  // fresh session for another installation) are non-session activity.
  nowRef.now += 60 * 1000
  assert.equal((await request(server.port, 'GET', '/health')).status, 200)
  assert.equal((await exchange(server.port, carol, localToken)).status, 200)
  assert.equal(liveSessionRegistry.lookup(aliceKey).lastSeen, nowRef.now - 60 * 1000, 'health and pre-auth never refreshed liveness')
  assert.equal(claimLastSeen(dataDir, 'alice'), new Date(nowRef.now - 60 * 1000).toISOString(), 'nor the durable claim')

  // The local (bootstrap/viewer-class) credential is never a session on an
  // actor route: the presence read itself refuses it 401 and touches nothing.
  nowRef.now += 60 * 1000
  const rejected = await presenceGet(server.port, localToken)
  assert.equal(rejected.status, 401)
  assert.equal(rejected.json().error.code, 'unauthorized')
  assert.equal(liveSessionRegistry.lookup(aliceKey).lastSeen, nowRef.now - 120 * 1000, 'the rejected read touched nothing')
  assert.equal(claimLastSeen(dataDir, 'alice'), new Date(nowRef.now - 120 * 1000).toISOString())
})

test('an unreachable server is a connection error, never a 200 with empty presence', async t => {
  // Hold a port, release it, then dial: nothing listens, so the client-side
  // dial fails — there is no "everyone offline" response shape anywhere.
  const holder = net.createServer()
  await new Promise(resolvePromise => holder.listen(0, '127.0.0.1', resolvePromise))
  const deadPort = holder.address().port
  await new Promise(resolvePromise => holder.close(resolvePromise))

  await assert.rejects(
    () => request(deadPort, 'GET', '/api/presence?include_offline=true'),
    error => error.code === 'ECONNREFUSED',
  )
})

// --- Matrix rows: gate discipline -------------------------------------------------

test('no session: the presence read answers 401 with zero state change', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const aliceToken = await sessionTokenFor(record.port, localToken, alice)
  assert.equal((await bind(record.port, aliceToken, 'Alice')).status, 200)
  const before = claimRows(dataDir)

  const anonymous = await presenceGet(record.port, undefined)
  assert.equal(anonymous.status, 401)
  assert.equal(anonymous.json().error.code, 'unauthorized')
  assert.equal(anonymous.json().error.message, PUBLIC_ERRORS.unauthorized)
  assert.equal(anonymous.headers[PROTOCOL_KEY], '1')
  const wrong = await presenceGet(record.port, 'x'.repeat(43))
  assert.equal(wrong.status, 401)
  assert.equal(wrong.json().error.code, 'unauthorized')

  assert.deepEqual(claimRows(dataDir), before, 'credential-less rejections never touch the claims index')
  await stop()
})

test('the presence query allowlist is strict: one boolean flag, nothing else', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const bob = installation()
  const aliceToken = await sessionTokenFor(record.port, localToken, alice)
  assert.equal((await bind(record.port, aliceToken, 'Alice')).status, 200)
  const bobToken = await sessionTokenFor(record.port, localToken, bob)
  assert.equal((await bind(record.port, bobToken, 'Bob')).status, 200)
  assert.equal((await disconnect(record.port, bobToken)).status, 200)

  // A misspelled flag and an extra parameter are unknown fields, rejected
  // and never ignored.
  const misspelled = await presenceGet(record.port, aliceToken, '?include_offlinee=true')
  assert.equal(misspelled.status, 400)
  assert.equal(misspelled.json().error.code, 'unknown_field')
  assert.match(misspelled.json().error.message, /"include_offlinee"/)
  const extra = await presenceGet(record.port, aliceToken, '?include_offline=true&extra=1')
  assert.equal(extra.status, 400)
  assert.equal(extra.json().error.code, 'unknown_field')
  // Duplicate query keys are malformed, not last-key-wins.
  const duplicated = await presenceGet(record.port, aliceToken, '?include_offline=true&include_offline=false')
  assert.equal(duplicated.status, 400)
  assert.equal(duplicated.json().error.code, 'invalid_request')
  // GET carries no body on this API.
  const withBody = await request(record.port, 'GET', '/api/presence', {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${aliceToken}`,
      'content-length': '2',
    },
  })
  assert.equal(withBody.status, 400)
  assert.equal(withBody.json().error.code, 'invalid_request')
  // The value parses strictly.
  const banana = await presenceGet(record.port, aliceToken, '?include_offline=banana')
  assert.equal(banana.status, 400)
  assert.equal(banana.json().error.code, 'invalid_request')
  assert.match(banana.json().error.message, /include_offline must be true or false/)

  // The accepted forms: "true" and the bare flag add the offline group;
  // "false" leaves it empty.
  const bobFingerprint = bob.fingerprint
  const explicit = (await presenceGet(record.port, aliceToken, '?include_offline=true')).json().result
  assert.deepEqual(explicit.offline_recently.map(row => row.fingerprint), [bobFingerprint])
  const bare = (await presenceGet(record.port, aliceToken, '?include_offline')).json().result
  assert.deepEqual(bare.offline_recently.map(row => row.fingerprint), [bobFingerprint])
  const negated = (await presenceGet(record.port, aliceToken, '?include_offline=false')).json().result
  assert.deepEqual(negated.offline_recently, [])
  assert.equal(negated.online.length, 1)

  await stop()
})

// --- GET /api/status (frozen route, registered this story) ------------------------

test('GET /api/status answers realm_id, version, and broadcast_room_id to an authenticated session', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const aliceToken = await sessionTokenFor(record.port, localToken, alice)

  const anonymous = await statusGet(record.port, undefined)
  assert.equal(anonymous.status, 401)
  assert.equal(anonymous.json().error.code, 'unauthorized')

  const status = await statusGet(record.port, aliceToken)
  assert.equal(status.status, 200, status.text)
  const result = status.json().result
  assert.deepEqual(Object.keys(result).sort(), ['broadcast_room_id', 'realm_id', 'version'])
  assert.match(result.realm_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.equal(result.version, APP_VERSION)
  assert.ok(typeof result.broadcast_room_id === 'string' && result.broadcast_room_id.length > 0)

  // The query allowlist holds here too.
  const extra = await request(record.port, 'GET', '/api/status?include_offline=true', {
    headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${aliceToken}` },
  })
  assert.equal(extra.status, 400)
  assert.equal(extra.json().error.code, 'unknown_field')

  await stop()
})

test('GET /api/status without the minted Broadcast Room is a coded 500, never a fabricated id', async t => {
  const dataDir = makeDataDir(t)
  const server = await startServer({ dataDir })
  try {
    const localToken = loadOrCreateLocalToken(dataDir)
    const aliceToken = await sessionTokenFor(server.port, localToken, installation())
    assert.equal((await statusGet(server.port, aliceToken)).status, 200)

    // Corrupt the bootstrap invariant beneath the running server.
    const raw = new DatabaseSync(join(dataDir, DB_PATH_NAME))
    raw.exec('DELETE FROM rooms')
    raw.close()

    const { result: outcome, chunks } = await captureStderr(() => statusGet(server.port, aliceToken))
    assert.equal(outcome.status, 500)
    assert.equal(outcome.json().error.code, 'request_failed')
    assert.equal(outcome.json().error.message, PUBLIC_ERRORS.request_failed)
    const lines = chunks.join('').split('\n').filter(line => line.includes('agent-room-server:'))
    assert.equal(lines.length, 1, 'exactly one diagnosable stderr line')
    assert.match(lines[0], /realm_bootstrap_incomplete/)
  } finally {
    await server.close()
  }
})

// --- The touch mechanism: failure and durable effect ------------------------------

test('a failing claim write answers request_failed with zero liveness drift, then recovers', async t => {
  const dataDir = makeDataDir(t)
  const nowRef = { now: Date.now() }
  const real = createLiveSessionRegistry({ now: () => nowRef.now })
  // Injectable seam: the wrapper delegates to a real registry but can fail
  // the durable persist step the server wires into touch — exactly where the
  // store's upsertChatIdClaim runs. No try/catch exists around the touch.
  let failClaimWrites = false
  const failingTouchRegistry = {
    claim: options => real.claim(options),
    rename: options => real.rename(options),
    release: sessionKey => real.release(sessionKey),
    lookup: sessionKey => real.lookup(sessionKey),
    presenceSnapshot: options => real.presenceSnapshot(options),
    clear: () => real.clear(),
    touch: (sessionKey, options = {}) => real.touch(sessionKey, options.persist === undefined ? {} : {
      persist: payload => {
        if (failClaimWrites) throw new Error('injected claim write failure')
        return options.persist(payload)
      },
    }),
  }
  const server = await startServer({ dataDir, sessionRegistry: createSessionRegistry({ now: () => nowRef.now }), liveSessionRegistry: failingTouchRegistry })
  try {
    const localToken = loadOrCreateLocalToken(dataDir)
    const alice = installation()
    const aliceToken = await sessionTokenFor(server.port, localToken, alice)
    assert.equal((await bind(server.port, aliceToken, 'Alice')).status, 200)
    const aliceKey = sessionKeyFromToken(aliceToken)
    const baseline = new Date(nowRef.now).toISOString()

    failClaimWrites = true
    nowRef.now += 60 * 1000
    const { result: failed, chunks } = await captureStderr(() => statusGet(server.port, aliceToken))
    assert.equal(failed.status, 500, 'the touch failure surfaces as a coded 500')
    assert.equal(failed.json().error.code, 'request_failed')
    assert.equal(failed.json().error.message, PUBLIC_ERRORS.request_failed)
    const lines = chunks.join('').split('\n').filter(line => line.includes('agent-room-server:'))
    assert.equal(lines.length, 1, 'exactly one diagnosable stderr line')
    assert.match(lines[0], /injected claim write failure/)
    assert.equal(real.lookup(aliceKey).lastSeen, nowRef.now - 60 * 1000, 'the live row did not advance')
    assert.equal(claimLastSeen(dataDir, 'alice'), baseline, 'the durable claim did not advance')

    failClaimWrites = false
    nowRef.now += 60 * 1000
    assert.equal((await statusGet(server.port, aliceToken)).status, 200, 'a healthy request touches normally')
    assert.equal(real.lookup(aliceKey).lastSeen, nowRef.now)
    assert.equal(claimLastSeen(dataDir, 'alice'), new Date(nowRef.now).toISOString())
  } finally {
    await server.close()
  }
})

test('an authenticated request refreshes the durable claim, keeping a live Actor inside the 7-day prune', async t => {
  const dataDir = makeDataDir(t)
  const nowRef = { now: Date.now() }
  const { server } = await clockedServer(t, dataDir, nowRef)
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const bob = installation()
  const aliceToken = await sessionTokenFor(server.port, localToken, alice)
  assert.equal((await bind(server.port, aliceToken, 'Alice')).status, 200)
  const bobToken = await sessionTokenFor(server.port, localToken, bob)
  assert.equal((await bind(server.port, bobToken, 'Bob')).status, 200)

  // Five hours inside the 7-day window before the prune, one authenticated
  // request touches Alice: her durable claim advances; Bob's stays behind.
  // (The touch must land inside the window the prune will apply: the prune
  // moment t0+7d+5h cuts at t0+5h, which keeps t0+11h and deletes t0.)
  nowRef.now += 11 * 60 * 60 * 1000
  assert.equal((await statusGet(server.port, aliceToken)).status, 200)
  assert.equal(claimLastSeen(dataDir, 'alice'), new Date(nowRef.now).toISOString())
  assert.equal(claimLastSeen(dataDir, 'bob'), new Date(nowRef.now - 11 * 60 * 60 * 1000).toISOString())

  // Now jump inside the prune window: the prune moment t0+7d+5h cuts at
  // t0+5h, which keeps Alice's touched claim (t0+11h) and deletes Bob's
  // untouched one (t0) — the request path is a heartbeat.
  nowRef.now += 7 * 24 * 60 * 60 * 1000 - 6 * 60 * 60 * 1000
  const pruner = openRoomLog({ dataDir })
  let pruned
  try {
    pruned = pruner.pruneChatIdClaims(CLAIMS_TTL_MS, nowRef.now)
  } finally {
    pruner.close()
  }
  assert.equal(pruned, 1, 'the untouched claim aged out')
  assert.deepEqual(claimRows(dataDir).map(row => row.chat_id_display), ['Alice'])
})

// --- Contract: payloads stay inside the frozen vocabulary -------------------------

test('presence and status payload keys are all frozen AD-8 response vocabulary names', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const bob = installation()
  const aliceToken = await sessionTokenFor(record.port, localToken, alice)
  assert.equal((await bind(record.port, aliceToken, 'Alice', 'mcp')).status, 200)
  const bobToken = await sessionTokenFor(record.port, localToken, bob)
  assert.equal((await bind(record.port, bobToken, 'Bob')).status, 200)
  // Disconnect Alice so the offline row shape is part of the audited payload.
  assert.equal((await disconnect(record.port, aliceToken)).status, 200)

  const presence = await presenceGet(record.port, bobToken, '?include_offline=true')
  assert.equal(presence.status, 200, presence.text)
  assertVocabularyKeys(presence.json().result, RESPONSE_FIELD_VOCABULARY)

  const status = await statusGet(record.port, bobToken)
  assert.equal(status.status, 200, status.text)
  assertVocabularyKeys(status.json().result, RESPONSE_FIELD_VOCABULARY)

  await stop()
})

// --- Operator tuning: presenceTtlMs -----------------------------------------------

test('presenceTtlMs tunes the online-visibility window without touching the lease', async t => {
  const dataDir = makeDataDir(t)
  // A 50 ms presence window: well below the 12 h claim lease, which a tuned
  // TTL can never widen or free.
  const server = await startServer({ dataDir, presenceTtlMs: 50 })
  try {
    const localToken = loadOrCreateLocalToken(dataDir)
    const alice = installation()
    const bob = installation()
    const aliceToken = await sessionTokenFor(server.port, localToken, alice)
    assert.equal((await bind(server.port, aliceToken, 'Alice')).status, 200)
    const bobToken = await sessionTokenFor(server.port, localToken, bob)

    // Fresh visibility is covered by the ordinary presence tests. This
    // operator-tuning row only proves the boundary after the elapsed TTL;
    // an immediate read would be sensitive to the test runner's scheduling.
    await sleep(150)
    const stale = (await presenceGet(server.port, bobToken, '?include_offline=true')).json().result
    assert.deepEqual(stale.online, [], 'the tuned TTL hides the idle session from online')
    assert.equal(stale.offline_recently.length, 1, 'the claim row still feeds the offline group')
    // The name is untouched — the lease is the auth session TTL, not this TTL.
    const reclaim = await bind(server.port, bobToken, 'Alice')
    assert.equal(reclaim.status, 409, 'the tuned presence TTL never frees a name')
  } finally {
    await server.close()
  }
})

test('presenceTtlMs is validated at startup and parsed from AGENT_ROOM_PRESENCE_TTL_MS with warning fallback', async t => {
  const dataDir = makeDataDir(t)
  await assert.rejects(
    () => startServer({ dataDir, presenceTtlMs: 0 }),
    /presenceTtlMs must be a positive safe integer/,
  )
  await assert.rejects(
    () => startServer({ dataDir, presenceTtlMs: 1.5 }),
    /presenceTtlMs must be a positive safe integer/,
  )

  assert.deepEqual(presenceTtlMsFromEnv({}), { presenceTtlMs: PRESENCE_TTL_MS })
  assert.deepEqual(presenceTtlMsFromEnv({ AGENT_ROOM_PRESENCE_TTL_MS: '1000' }), { presenceTtlMs: 1000 })
  assert.deepEqual(presenceTtlMsFromEnv({ AGENT_ROOM_PRESENCE_TTL_MS: ' 2000 ' }), { presenceTtlMs: 2000 })
  assert.deepEqual(presenceTtlMsFromEnv({ AGENT_ROOM_PRESENCE_TTL_MS: '' }), { presenceTtlMs: PRESENCE_TTL_MS })
  for (const bad of ['banana', '0', '-5', '1.5', '1e9', `${Number.MAX_SAFE_INTEGER}0`]) {
    const outcome = presenceTtlMsFromEnv({ AGENT_ROOM_PRESENCE_TTL_MS: bad })
    assert.equal(outcome.presenceTtlMs, PRESENCE_TTL_MS, bad)
    assert.match(outcome.warning, /AGENT_ROOM_PRESENCE_TTL_MS/, bad)
    assert.match(outcome.warning, /positive integer/, bad)
  }
})

// --- Store rows: the offline source ------------------------------------------------

test('recentClaims excludes future-dated rows so a rolled-back clock cannot surface them', t => {
  const dataDir = makeDataDir(t, 'agent-room-presence-store-')
  const store = openRoomLog({ dataDir })
  try {
    const fingerprint = `sha256:${'a'.repeat(64)}`
    const base = Date.now()
    const future = new Date(base + 5 * 60 * 60 * 1000).toISOString()
    store.upsertChatIdClaim({ chatId: 'Alice', actorFingerprint: fingerprint, lastSeenAt: future })

    // The forward-dated row is invisible to a now in its past (a clock moved
    // backwards after the write): the window is bounded above by now.
    assert.deepEqual(store.recentClaims(OFFLINE_RECENTLY_WINDOW_MS, base), [])
    // At the row's own time it is visible, inclusive at the upper bound.
    assert.deepEqual(
      store.recentClaims(OFFLINE_RECENTLY_WINDOW_MS, base + 5 * 60 * 60 * 1000).map(row => row.chat_id),
      ['Alice'],
    )
  } finally {
    store.close()
  }
})
