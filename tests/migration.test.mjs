// Story 2.3 — the one-time v0.1→v0.2 in-place migration.
//
// The v0.1 store (server/database.mjs, user_version 1) keyed messages by a
// GLOBAL AUTOINCREMENT seq and threaded replies through that global number.
// The v0.2 store (server/store/room-log.mjs, user_version 2) keys messages
// (room_id, seq) with room-local contiguous sequences from 1. The migration
// (server/store/migrate-v1.mjs) upgrades a v0.1 file in place: absorb-or-stop
// the live v0.1 daemon named by runtime.json first, then ONE BEGIN IMMEDIATE
// transaction re-sequences each room from 1, remaps every reply_to_seq from
// global to room-local, reshapes the schema, mints the realm's first id, and
// stamps user_version = 2.
//
// Oracles here are literals built in this file (the v1 DDL is reproduced from
// the v0.1 store shape, not imported), every daemon and child is a real
// process, and every SQLite inspection of migrated state is direct. The
// suite covers the three acceptance criteria: the boot ordering (daemon
// stopped, single transaction, stamp v2), the crash/resume and no-op oracles
// (rollback leaves v1; the rerun completes; a second completed run changes
// nothing), and the migrated reads (reply threads intact, sequences
// contiguous from 1, realm preserved across restarts).

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import http from 'node:http'
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import {
  MESSAGE_TEXT_MAX,
  MIGRATION_DAEMON_SETTLE_MS,
  TITLE_MAX,
} from '../server/constants.mjs'
import { ROOM_LOG_DATABASE_FILENAME, openRoomLog } from '../server/store/room-log.mjs'
import { migrateV1InPlace } from '../server/store/migrate-v1.mjs'
import { startServer } from '../server/api/server.mjs'

const ROOT = resolve(import.meta.dirname, '..')
const MIGRATE_MODULE = join(ROOT, 'server', 'store', 'migrate-v1.mjs')

// Harness budgets (not product limits): daemon-ready and child-exit waits,
// and the mid-migration kill delay (sized against a ~2 s migration so the
// kill deterministically lands inside the single transaction).
const CHILD_READY_TIMEOUT_MS = 10_000
const CHILD_EXIT_TIMEOUT_MS = 10_000
const MIGRATION_KILL_DELAY_MS = 300

// --- The v0.1 schema, reproduced literally (fixture, not oracle) --------------

const V1_DDL = `
  CREATE TABLE actors (
    id TEXT PRIMARY KEY,
    display_name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    CHECK (length(id) BETWEEN 1 AND 128),
    CHECK (length(display_name) BETWEEN 1 AND 80)
  ) STRICT;

  CREATE TABLE rooms (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    created_at TEXT NOT NULL,
    CHECK (length(title) BETWEEN 1 AND ${TITLE_MAX})
  ) STRICT;

  CREATE TABLE room_members (
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
    actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    joined_at TEXT NOT NULL,
    PRIMARY KEY (room_id, actor_id)
  ) STRICT;

  CREATE TABLE messages (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
    actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
    actor_display_name TEXT NOT NULL,
    client_message_id TEXT NOT NULL,
    text TEXT NOT NULL,
    reply_to_seq INTEGER,
    created_at TEXT NOT NULL,
    UNIQUE (room_id, actor_id, client_message_id),
    UNIQUE (room_id, seq),
    FOREIGN KEY (room_id, actor_id)
      REFERENCES room_members(room_id, actor_id) ON DELETE RESTRICT,
    FOREIGN KEY (room_id, reply_to_seq)
      REFERENCES messages(room_id, seq) ON DELETE RESTRICT,
    CHECK (length(actor_display_name) BETWEEN 1 AND 80),
    CHECK (length(client_message_id) BETWEEN 1 AND 128),
    CHECK (length(text) BETWEEN 1 AND ${MESSAGE_TEXT_MAX})
  ) STRICT;

  PRAGMA user_version = 1;
`

// --- Fixtures ------------------------------------------------------------------

// Deterministic v0.1 world: two rooms, three actors whose display names
// exercise the chat id mapping (grammar-clean, dot-bearing, and non-ASCII),
// and six messages whose GLOBAL sequences interleave across the rooms, with
// reply chains inside each room (a reply to a reply included).
const ROOM_A = '11111111-1111-4111-8111-111111111111'
const ROOM_B = '22222222-2222-4222-8222-222222222222'
const ALICE_ID = 'agent:11111111-1111-4111-8111-111111111111'
const BOB_ID = 'agent:22222222-2222-4222-8222-222222222222'
const ZWEI_ID = 'agent:33333333-3333-4333-8333-333333333333'

const fingerprintOf = actorId => `sha256:${createHash('sha256').update(actorId, 'utf8').digest('hex')}`
const fpAlice = fingerprintOf(ALICE_ID)
const fpBob = fingerprintOf(BOB_ID)
const fpZwei = fingerprintOf(ZWEI_ID)

// The canonical migrated shape of the standard fixture, as literals: per-room
// rows with the room-local sequence, the derived fingerprint, the mapped chat
// id, the remapped room-local reply target, and the untouched text.
const EXPECTED_DESIGN = [
  { seq: 1, actor_fingerprint: fpAlice, chat_id: 'Design_Agent', reply_to_seq: null, text: 'Design kickoff' },
  { seq: 2, actor_fingerprint: fpBob, chat_id: 'bob.ops', reply_to_seq: 1, text: 'Reply from bob' },
  { seq: 3, actor_fingerprint: fpAlice, chat_id: 'Design_Agent', reply_to_seq: null, text: 'Second design note' },
]
const EXPECTED_OPS = [
  { seq: 1, actor_fingerprint: fpBob, chat_id: 'bob.ops', reply_to_seq: null, text: 'Ops check-in' },
  { seq: 2, actor_fingerprint: fpAlice, chat_id: 'Design_Agent', reply_to_seq: 1, text: 'Ops reply' },
  { seq: 3, actor_fingerprint: fpZwei, chat_id: 'M_ller___S_hne', reply_to_seq: 2, text: 'Grüße aus München' },
]

const STANDARD_V1_ROWS = {
  actors: [
    [ALICE_ID, 'Design Agent', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
    [BOB_ID, 'bob.ops', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
    [ZWEI_ID, 'Müller & Söhne', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'],
  ],
  rooms: [
    [ROOM_A, 'Design Room', ALICE_ID, '2026-01-01T00:00:00.000Z'],
    [ROOM_B, 'Ops Room', BOB_ID, '2026-01-01T00:01:00.000Z'],
  ],
  // (room, actor) memberships the messages' foreign keys require.
  memberships: [
    [ROOM_A, ALICE_ID], [ROOM_A, BOB_ID],
    [ROOM_B, BOB_ID], [ROOM_B, ALICE_ID], [ROOM_B, ZWEI_ID],
  ],
  // The seq column is the row's position in this list plus one; the interleave
  // across rooms is the point — v0.1 sequences were global.
  messages: [
    { room: ROOM_A, actor: ALICE_ID, name: 'Design Agent', id: 'kickoff-1', text: 'Design kickoff', reply: null, at: '2026-01-01T00:00:01.000Z' },
    { room: ROOM_B, actor: BOB_ID, name: 'bob.ops', id: 'ops-1', text: 'Ops check-in', reply: null, at: '2026-01-01T00:00:02.000Z' },
    { room: ROOM_A, actor: BOB_ID, name: 'bob.ops', id: 'reply-1', text: 'Reply from bob', reply: 1, at: '2026-01-01T00:00:03.000Z' },
    { room: ROOM_B, actor: ALICE_ID, name: 'Design Agent', id: 'ops-reply', text: 'Ops reply', reply: 2, at: '2026-01-01T00:00:04.000Z' },
    { room: ROOM_B, actor: ZWEI_ID, name: 'Müller & Söhne', id: 'ops-hello', text: 'Grüße aus München', reply: 4, at: '2026-01-01T00:00:05.000Z' },
    { room: ROOM_A, actor: ALICE_ID, name: 'Design Agent', id: 'design-2', text: 'Second design note', reply: null, at: '2026-01-01T00:00:06.000Z' },
  ],
}

function writeV1Database(dataDir, { actors, rooms, memberships, messages }) {
  mkdirSync(dataDir, { recursive: true, mode: 0o700 })
  const database = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME))
  try {
    // The real v0.1 store enforced WAL on every open (configureConnection);
    // a realistic fixture is therefore a WAL-mode v1 file, not a
    // default-journal one.
    database.exec('PRAGMA journal_mode = WAL')
    database.exec(V1_DDL)
    // node:sqlite enforces foreign keys by default; the fixture seeds raw
    // rows (including a deliberately corrupt one in the rollback test), so
    // enforcement is explicitly off for seeding only.
    database.exec('PRAGMA foreign_keys = OFF;')
    database.exec('BEGIN IMMEDIATE')
    const insertActor = database.prepare('INSERT INTO actors VALUES (?, ?, ?, ?)')
    for (const row of actors) insertActor.run(...row)
    const insertRoom = database.prepare('INSERT INTO rooms VALUES (?, ?, ?, ?)')
    for (const row of rooms) insertRoom.run(...row)
    const insertMember = database.prepare('INSERT INTO room_members VALUES (?, ?, ?)')
    for (const [roomId, actorId] of memberships) {
      insertMember.run(roomId, actorId, '2026-01-01T00:00:00.000Z')
    }
    const insertMessage = database.prepare(`
      INSERT INTO messages (room_id, actor_id, actor_display_name, client_message_id, text, reply_to_seq, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    const lastSeq = database.prepare('SELECT last_insert_rowid() AS seq')
    let globalSeq = 0
    for (const message of messages) {
      globalSeq += 1
      insertMessage.run(
        message.room,
        message.actor,
        message.name,
        message.id,
        message.text,
        message.reply === null ? null : message.reply,
        message.at,
      )
      assert.equal(Number(lastSeq.get().seq), globalSeq)
    }
    database.exec('COMMIT')
  } finally {
    database.close()
  }
}

function standardV1Fixture(dataDir) {
  writeV1Database(dataDir, STANDARD_V1_ROWS)
}

// --- Raw inspection helpers ------------------------------------------------------

function withRawDatabase(databasePath, operation) {
  const database = new DatabaseSync(databasePath)
  try {
    return operation(database)
  } finally {
    database.close()
  }
}

const rawVersion = databasePath => withRawDatabase(databasePath, database =>
  Number(database.prepare('PRAGMA user_version').get().user_version))

const rawTables = databasePath => withRawDatabase(databasePath, database => database
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map(row => row.name))

const rawMessageCount = databasePath => withRawDatabase(databasePath, database =>
  Number(database.prepare('SELECT COUNT(*) AS count FROM messages').get().count))

function rawMessages(databasePath, roomId) {
  return JSON.parse(JSON.stringify(withRawDatabase(databasePath, database => database.prepare(`
    SELECT seq, actor_fingerprint, chat_id, client_message_id, text, reply_to_seq, created_at
    FROM messages WHERE room_id = ? ORDER BY seq ASC
  `).all(roomId))))
}

// The no-op oracle's full durable state: every v2 table, the version, and the
// foreign-key verdict — captured whole and compared whole. The JSON round-trip
// strips SQLite's null-prototype wrappers so deepStrictEqual compares values.
function captureDurableState(databasePath) {
  return JSON.parse(JSON.stringify(withRawDatabase(databasePath, database => ({
    user_version: Number(database.prepare('PRAGMA user_version').get().user_version),
    rooms: database.prepare('SELECT * FROM rooms ORDER BY created_at ASC, id ASC').all(),
    messages: database.prepare('SELECT * FROM messages ORDER BY room_id, seq').all(),
    realms: database.prepare('SELECT * FROM realms').all(),
    direct_members: database.prepare('SELECT * FROM direct_members').all(),
    chat_id_claims: database.prepare('SELECT * FROM chat_id_claims').all(),
    foreign_key_violations: database.prepare('PRAGMA foreign_key_check').all(),
  }))))
}

const roomLocalProjection = rows => rows.map(row => ({
  seq: row.seq,
  actor_fingerprint: row.actor_fingerprint,
  chat_id: row.chat_id,
  reply_to_seq: row.reply_to_seq,
  text: row.text,
}))

// --- Process helpers ------------------------------------------------------------

function trackedChild(t, scriptPath, args) {
  const child = spawn(process.execPath, [scriptPath, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))
  return {
    child,
    stdout: () => stdout,
    stderr: () => stderr,
    pidAlive: () => {
      try {
        process.kill(child.pid, 0)
        return true
      } catch {
        return false
      }
    },
    waitForOutput: async needle => {
      const deadline = Date.now() + CHILD_READY_TIMEOUT_MS
      while (!stdout.includes(needle)) {
        if (child.exitCode !== null || child.signalCode !== null) {
          throw new Error(`child exited before printing "${needle}"\nstdout: ${stdout}\nstderr: ${stderr}`)
        }
        if (Date.now() > deadline) {
          throw new Error(`child never printed "${needle}"\nstdout: ${stdout}\nstderr: ${stderr}`)
        }
        await sleep(10)
      }
    },
    waitForExit: async () => {
      const deadline = Date.now() + CHILD_EXIT_TIMEOUT_MS
      while (child.exitCode === null && child.signalCode === null) {
        if (Date.now() > deadline) throw new Error(`child did not exit\nstdout: ${stdout}\nstderr: ${stderr}`)
        await sleep(10)
      }
      return { code: child.exitCode, signal: child.signalCode }
    },
  }
}

function writeChildScript(directory, filename, lines) {
  const path = join(directory, filename)
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 })
  return path
}

// A pid that is guaranteed dead: a child spawned only to exit.
async function collectDeadPid() {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'])
  await once(child, 'exit')
  return child.pid
}

// A loopback port that is momentarily guaranteed closed: bound, captured,
// released.
async function collectClosedPort() {
  const server = http.createServer()
  await new Promise(resolvePromise => server.listen(0, '127.0.0.1', resolvePromise))
  const { port } = server.address()
  await new Promise(resolvePromise => server.close(resolvePromise))
  return port
}

// The fake v0.1 daemon: holds the v1 database open (like the real roomd) and,
// in agent-room mode, answers GET /health with the v0.1 shape and writes the
// v0.1 runtime record {pid, version, protocolVersion, socketPath, httpOrigin,
// startedAt}. Foreign mode answers plain text on every path. Silent mode
// opens the database and stays alive with no HTTP surface, so the parent
// controls the record.
const DAEMON_SCRIPT = [
  "import { createServer } from 'node:http'",
  "import { DatabaseSync } from 'node:sqlite'",
  "import { writeFileSync } from 'node:fs'",
  "import { join } from 'node:path'",
  '',
  "const [dataDir, mode] = process.argv.slice(2)",
  "const database = new DatabaseSync(join(dataDir, 'agent-room.sqlite'))",
  "database.prepare('SELECT COUNT(*) AS count FROM messages').get()",
  "if (mode === 'silent') {",
  "  writeFileSync(join(dataDir, 'runtime.json'), JSON.stringify({ pid: process.pid, version: '0.1.0' }), { mode: 0o600 })",
  "  console.log(`READY ${process.pid}`)",
  "  setInterval(() => {}, 60_000)",
  "} else {",
  "  const server = createServer((request, response) => {",
  "    if (request.url === '/health' && mode === 'agent-room') {",
  "      response.writeHead(200, { 'Content-Type': 'application/json' })",
  "      response.end(JSON.stringify({ ok: true, version: '0.1.0', protocolVersion: 1 }))",
  "      return",
  "    }",
  "    response.writeHead(200, { 'Content-Type': 'text/plain' })",
  "    response.end('hello, not agent-room')",
  "  })",
  "  server.listen(0, '127.0.0.1', () => {",
  "    const port = server.address().port",
  "    writeFileSync(join(dataDir, 'runtime.json'), JSON.stringify({",
  "      pid: process.pid,",
  "      version: '0.1.0',",
  "      protocolVersion: 1,",
  "      socketPath: join(dataDir, 'roomd.sock'),",
  "      httpOrigin: 'http://127.0.0.1:' + port,",
  "      startedAt: new Date().toISOString(),",
  "    }), { mode: 0o600 })",
  "    console.log(`READY ${process.pid} ${port}`)",
  "  })",
  "}",
]

// The mid-migration crash child: prints MIGRATING, then runs the real
// migration against the given data dir and prints DONE on success.
const MIGRATE_CHILD_SCRIPT = [
  "import { writeSync } from 'node:fs'",
  "import { pathToFileURL } from 'node:url'",
  '',
  "const [dataDir, modulePath] = process.argv.slice(2)",
  "const { migrateV1InPlace } = await import(pathToFileURL(modulePath).href)",
  "writeSync(1, 'MIGRATING\\n')",
  'try {',
  '  const outcome = await migrateV1InPlace({ dataDir })',
  "  writeSync(1, 'DONE ' + JSON.stringify(outcome) + '\\n')",
  '} catch (error) {',
  "  writeSync(1, 'FAILED ' + (error.code ?? error.name) + '\\n')",
  '  process.exit(1)',
  '}',
]

// Real in-process boot of the API host (the wiring under test) plus a real
// GET /health probe against the listening port.
async function bootServer(t, dataDir) {
  const server = await startServer({ dataDir })
  t.after(() => server.close())
  const health = await new Promise((resolvePromise, rejectPromise) => {
    const request = http.get({ host: '127.0.0.1', port: server.port, path: '/health', agent: false }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolvePromise({
        statusCode: response.statusCode,
        body: JSON.parse(Buffer.concat(chunks).toString('utf8')),
      }))
    })
    request.on('error', rejectPromise)
    request.setTimeout(CHILD_READY_TIMEOUT_MS, () => request.destroy(new Error('health probe timed out')))
  })
  return { server, health }
}

// --- Boot ordering: detect, single transaction, stamp v2 ------------------------

test('a realistic v0.1 database migrates in place: room-local sequences from 1, reply threads remapped, realm minted, v2 stamped', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-migrate-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  standardV1Fixture(dataDir)
  const databasePath = join(dataDir, ROOM_LOG_DATABASE_FILENAME)

  // The pre-state is genuinely v0.1: four tables, and the six messages were
  // inserted under GLOBAL sequences 1..6 interleaved across the two rooms
  // (the fixture builder asserted each rowid).
  assert.equal(rawVersion(databasePath), 1)
  assert.deepEqual(rawTables(databasePath), ['actors', 'messages', 'room_members', 'rooms'])

  const outcome = await migrateV1InPlace({ dataDir })

  assert.equal(outcome.migrated, true)
  assert.match(outcome.realmId, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  assert.equal(outcome.roomCount, 2)
  assert.equal(outcome.messageCount, 6)

  assert.equal(rawVersion(databasePath), 2)
  assert.deepEqual(rawTables(databasePath), ['chat_id_claims', 'direct_members', 'messages', 'realms', 'rooms'])

  const database = new DatabaseSync(databasePath)
  t.after(() => database.close())
  assert.deepEqual(database.prepare('PRAGMA foreign_key_check').all(), [])

  // Rooms: ids, titles, and timestamps preserved; every room is a broadcast
  // room with no pair key and no fabricated creator.
  const rooms = JSON.parse(JSON.stringify(database.prepare(`
    SELECT id, kind, title, pair_key, created_by_fingerprint, created_at
    FROM rooms ORDER BY created_at ASC, id ASC
  `).all()))
  assert.deepEqual(rooms, [
    { id: ROOM_A, kind: 'broadcast', title: 'Design Room', pair_key: null, created_by_fingerprint: null, created_at: '2026-01-01T00:00:00.000Z' },
    { id: ROOM_B, kind: 'broadcast', title: 'Ops Room', pair_key: null, created_by_fingerprint: null, created_at: '2026-01-01T00:01:00.000Z' },
  ])

  // Messages: room-local sequences contiguous from 1; reply targets remapped
  // into the same room's local numbering; attribution derived deterministically
  // from the v0.1 actor ids and mapped into the chat id grammar.
  assert.deepEqual(roomLocalProjection(rawMessages(databasePath, ROOM_A)), EXPECTED_DESIGN)
  assert.deepEqual(roomLocalProjection(rawMessages(databasePath, ROOM_B)), EXPECTED_OPS)

  // Send-time attribution details are untouched: client_message_ids and
  // created_at timestamps carry across verbatim.
  const detail = JSON.parse(JSON.stringify(database.prepare(`
    SELECT client_message_id, created_at FROM messages WHERE room_id = ? ORDER BY seq ASC
  `).all(ROOM_A)))
  assert.deepEqual(detail, [
    { client_message_id: 'kickoff-1', created_at: '2026-01-01T00:00:01.000Z' },
    { client_message_id: 'reply-1', created_at: '2026-01-01T00:00:03.000Z' },
    { client_message_id: 'design-2', created_at: '2026-01-01T00:00:06.000Z' },
  ])

  // The realm is minted exactly once, and durable claims are NOT seeded from
  // v0.1 actors (the derived fingerprint is not the key the upgraded agent
  // will present — addressing recovers on reconnect).
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM realms').get().count, 1)
  const realm = JSON.parse(JSON.stringify(database.prepare('SELECT * FROM realms').all()))[0]
  assert.equal(realm.realm_id, outcome.realmId)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM chat_id_claims').get().count, 0)
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM direct_members').get().count, 0)
})

test('the migrated store reads and writes: reads match the literal maps, appends continue each room contiguously, and reply discipline is live', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-migrate-store-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  standardV1Fixture(dataDir)
  const outcome = await migrateV1InPlace({ dataDir })
  assert.equal(outcome.migrated, true)

  const store = openRoomLog({ dataDir })
  t.after(() => store.close())

  assert.equal(store.getRealmId(), outcome.realmId)
  assert.equal(store.schemaVersion, 2)

  // Reads return the migrated history exactly as the literals expect.
  assert.deepEqual(roomLocalProjection(store.readPage({ roomId: ROOM_A, actorFingerprint: fpAlice })), EXPECTED_DESIGN)
  assert.deepEqual(roomLocalProjection(store.readPage({ roomId: ROOM_B, actorFingerprint: fpBob })), EXPECTED_OPS)

  // Broadcast membership is implicit: any Actor reads any migrated room.
  assert.deepEqual(store.readPage({ roomId: ROOM_B, actorFingerprint: fpZwei }).map(message => message.seq), [1, 2, 3])

  // Appends continue each room's local sequence, not a global counter: Ops
  // Room reaches 4 while Design Room is still at 3.
  const nextB = store.appendMessage({
    roomId: ROOM_B, actorFingerprint: fpBob, chatId: 'bob.ops', clientMessageId: 'post-migration-b', text: 'First v0.2 send here',
  }).message
  assert.equal(nextB.seq, 4)

  // The reply discipline is live against the re-sequenced rooms: a reply
  // whose target exists only in ANOTHER room is refused (Design Room has no
  // local seq 4 yet, so a global-seq reply attempt names a foreign row).
  assert.throws(() => store.appendMessage({
    roomId: ROOM_A, actorFingerprint: fpBob, chatId: 'bob.ops', clientMessageId: 'cross-room', text: 'Wrong room', replyToSeq: nextB.seq,
  }), error => error?.name === 'AgentRoomRuntimeError' && error?.code === 'reply_room_mismatch')

  const nextA = store.appendMessage({
    roomId: ROOM_A, actorFingerprint: fpAlice, chatId: 'Design_Agent', clientMessageId: 'post-migration-a', text: 'First v0.2 send',
  }).message
  assert.equal(nextA.seq, 4)

  // A reply to a MIGRATED row resolves room-locally and commits.
  const reply = store.appendMessage({
    roomId: ROOM_A, actorFingerprint: fpBob, chatId: 'bob.ops', clientMessageId: 'post-reply', text: 'Replying to history', replyToSeq: 1,
  }).message
  assert.equal(reply.seq, 5)
  assert.equal(reply.reply_to_seq, 1)

  // Idempotency reaches into migrated rows: a migrated client_message_id
  // replays to the original under the mapped fingerprint.
  const replay = store.appendMessage({
    roomId: ROOM_A, actorFingerprint: fpAlice, chatId: 'Design_Agent', clientMessageId: 'kickoff-1', text: 'Design kickoff',
  })
  assert.equal(replay.duplicate, true)
  assert.equal(replay.message.seq, 1)
})

test('a server boot migrates a v0.1 data dir; the realm survives further restarts untouched', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-migrate-boot-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  standardV1Fixture(dataDir)
  const databasePath = join(dataDir, ROOM_LOG_DATABASE_FILENAME)

  // First boot: the startup step migrates before the store opens, and the
  // server comes up serving the migrated realm.
  const first = await bootServer(t, dataDir)
  assert.equal(first.health.statusCode, 200)
  assert.equal(first.health.body.ok, true)
  assert.equal(rawVersion(databasePath), 2)
  const stateAfterFirstBoot = captureDurableState(databasePath)
  assert.equal(stateAfterFirstBoot.realms.length, 1)
  const realmId = stateAfterFirstBoot.realms[0].realm_id
  await first.server.close()

  // An ordinary restart on the migrated file: same realm row, same maps.
  const second = await bootServer(t, dataDir)
  assert.equal(second.health.statusCode, 200)
  await second.server.close()
  const stateAfterSecondBoot = captureDurableState(databasePath)
  assert.deepEqual(stateAfterSecondBoot, stateAfterFirstBoot)
  assert.equal(stateAfterSecondBoot.realms[0].realm_id, realmId)

  // The oldest migrated room is the realm's Broadcast Room, by id.
  const store = openRoomLog({ dataDir })
  t.after(() => store.close())
  assert.equal(store.getRealmId(), realmId)
  assert.equal(store.findBroadcastRoom().id, ROOM_A)
})

test('an empty v0.1 database migrates: zero rooms and messages, realm minted, and the first boot adds only the Broadcast Room', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-migrate-empty-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  writeV1Database(dataDir, {
    actors: [[ALICE_ID, 'Design Agent', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']],
    rooms: [],
    memberships: [],
    messages: [],
  })

  const outcome = await migrateV1InPlace({ dataDir })
  assert.deepEqual(
    { migrated: outcome.migrated, roomCount: outcome.roomCount, messageCount: outcome.messageCount },
    { migrated: true, roomCount: 0, messageCount: 0 },
  )
  const realmId = outcome.realmId

  const store = openRoomLog({ dataDir })
  t.after(() => store.close())
  assert.equal(store.getRealmId(), realmId)
  assert.equal(store.findBroadcastRoom(), null)

  // The first boot completes the realm bootstrap (the implicit Broadcast
  // Room) without minting a second realm row.
  const boot = await bootServer(t, dataDir)
  assert.equal(boot.health.statusCode, 200)
  await boot.server.close()
  const state = captureDurableState(join(dataDir, ROOM_LOG_DATABASE_FILENAME))
  assert.equal(state.realms.length, 1)
  assert.equal(state.realms[0].realm_id, realmId)
  assert.deepEqual(state.rooms.map(room => room.kind), ['broadcast'])
})

// --- Crash/resume and the no-op oracle -------------------------------------------

test('a second completed run is a no-op oracle: nothing is re-mapped, the realm is untouched, and another boot changes nothing', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-migrate-noop-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  standardV1Fixture(dataDir)
  const databasePath = join(dataDir, ROOM_LOG_DATABASE_FILENAME)

  const first = await migrateV1InPlace({ dataDir })
  assert.equal(first.migrated, true)
  const afterFirst = captureDurableState(databasePath)

  // A direct second run reports not-migrated and leaves every value of
  // durable state identical (same room/sequence/reply maps, same realm).
  const second = await migrateV1InPlace({ dataDir })
  assert.deepEqual(second, { migrated: false })
  assert.deepEqual(captureDurableState(databasePath), afterFirst)

  // A second completed STARTUP run (the AC's oracle shape): boot the real
  // server on the already-v2 file — still a no-op.
  const boot = await bootServer(t, dataDir)
  assert.equal(boot.health.statusCode, 200)
  await boot.server.close()
  assert.deepEqual(captureDurableState(databasePath), afterFirst)

  // And a third direct run on the booted file, for the road.
  assert.deepEqual(await migrateV1InPlace({ dataDir }), { migrated: false })
  assert.deepEqual(captureDurableState(databasePath), afterFirst)
})

test('a mid-migration transaction failure rolls the file back to v1 — nothing partial persists — and a corrected rerun completes', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-migrate-rollback-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const rows = structuredClone(STANDARD_V1_ROWS)
  // A corrupt seventh message: a dangling reply target (999). The v1 DDL's
  // foreign keys were not enforced by the fixture connection, so the row
  // inserts legally into the v1 file, but the v2 remap cannot resolve the
  // target. The row sits at the end of the copy order, so five earlier
  // inserts have already succeeded inside the transaction when the failure
  // lands.
  rows.messages.push({
    room: ROOM_B, actor: BOB_ID, name: 'bob.ops', id: 'corrupt-7', text: 'Corrupt payload', reply: 999, at: '2026-01-01T00:00:07.000Z',
  })
  writeV1Database(dataDir, rows)
  const databasePath = join(dataDir, ROOM_LOG_DATABASE_FILENAME)
  const bytesBefore = readFileSync(databasePath)

  await assert.rejects(
    () => migrateV1InPlace({ dataDir }),
    error => error?.name === 'AgentRoomRuntimeError' && error?.code === 'database_schema_invalid',
  )

  // The transaction rolled back COMPLETELY: still v1, still the v1 tables,
  // still all seven rows, no *_next remnants, no realm row, and the file
  // bytes are unchanged (the version stamp rolled back with the reshape).
  assert.equal(rawVersion(databasePath), 1)
  assert.deepEqual(rawTables(databasePath), ['actors', 'messages', 'room_members', 'rooms'])
  assert.equal(rawMessageCount(databasePath), 7)
  const check = new DatabaseSync(databasePath)
  t.after(() => check.close())
  assert.equal(
    check.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE name LIKE '%_next'").get().count,
    0,
  )
  // The realms table itself rolled back with the transaction: the file is
  // exactly the v1 schema again, nothing partial.
  assert.equal(
    check.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'realms'").get().count,
    0,
  )
  assert.ok(bytesBefore.equals(readFileSync(databasePath)), 'a rolled-back migration modified the database file')

  // Repair the corrupt row (operator intervention) and the next boot's
  // migration completes from the SAME untouched v1 state — the resume is the
  // transaction, rerun from the start.
  check.prepare('UPDATE messages SET reply_to_seq = NULL WHERE client_message_id = ?')
    .run('corrupt-7')
  const outcome = await migrateV1InPlace({ dataDir })
  assert.equal(outcome.migrated, true)
  assert.deepEqual(
    { roomCount: outcome.roomCount, messageCount: outcome.messageCount },
    { roomCount: 2, messageCount: 7 },
  )
  assert.equal(rawVersion(databasePath), 2)
  assert.deepEqual(rawMessages(databasePath, ROOM_B).map(row => row.seq), [1, 2, 3, 4])
  assert.deepEqual(rawMessages(databasePath, ROOM_B).map(row => row.reply_to_seq), [null, 1, 2, null])
})

test('a real SIGKILL mid-migration leaves the file v1, and the next boot completes to the reference maps', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-migrate-kill-'))
  const referenceDir = mkdtempSync(join(tmpdir(), 'agent-room-migrate-kill-ref-'))
  const childDir = mkdtempSync(join(tmpdir(), 'agent-room-migrate-kill-child-'))
  t.after(() => {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(referenceDir, { recursive: true, force: true })
    rmSync(childDir, { recursive: true, force: true })
  })

  // A large deterministic v0.1 world: three rooms, 60k messages each with
  // periodic reply chains — the migration takes well over the kill delay, so
  // the SIGKILL deterministically lands inside the single transaction.
  // Global sequences interleave round-robin; a reply targets the same room's
  // message three rounds earlier.
  const ROOM_COUNT = 3
  const PER_ROOM = 60_000
  const rows = {
    actors: [[ALICE_ID, 'Design Agent', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z']],
    rooms: [],
    memberships: [],
    messages: [],
  }
  for (let room = 0; room < ROOM_COUNT; room += 1) {
    const roomId = `kill-room-${room}`
    rows.rooms.push([roomId, `Kill Room ${room}`, ALICE_ID, '2026-01-01T00:00:00.000Z'])
    rows.memberships.push([roomId, ALICE_ID])
  }
  let globalSeq = 0
  for (let index = 1; index <= PER_ROOM; index += 1) {
    for (let room = 0; room < ROOM_COUNT; room += 1) {
      globalSeq += 1
      rows.messages.push({
        room: `kill-room-${room}`,
        actor: ALICE_ID,
        name: 'Design Agent',
        id: `kill-${room}-${index}`,
        text: `Kill fixture ${room}:${index}`,
        reply: index > 3 && index % 10 === 7 ? globalSeq - (3 * ROOM_COUNT) : null,
        at: '2026-01-01T00:00:00.000Z',
      })
    }
  }
  writeV1Database(dataDir, rows)
  cpSync(dataDir, referenceDir, { recursive: true })

  // Reference migration of the pristine copy, in this process.
  const reference = await migrateV1InPlace({ dataDir: referenceDir })
  assert.equal(reference.migrated, true)
  assert.equal(reference.messageCount, ROOM_COUNT * PER_ROOM)
  const referenceState = captureDurableState(join(referenceDir, ROOM_LOG_DATABASE_FILENAME))

  // The crash child begins the real migration; the parent kills it with
  // SIGKILL while the single transaction is in flight.
  const script = writeChildScript(childDir, 'migrate-child.mjs', MIGRATE_CHILD_SCRIPT)
  const subject = trackedChild(t, script, [dataDir, MIGRATE_MODULE])
  await subject.waitForOutput('MIGRATING')
  await new Promise(resolvePromise => setTimeout(resolvePromise, MIGRATION_KILL_DELAY_MS))
  subject.child.kill('SIGKILL')
  const exit = await subject.waitForExit()

  // If the child somehow finished before the kill, the crash-resume oracle
  // degrades to the no-op oracle — recorded, not hidden.
  const finishedBeforeKill = subject.stdout().includes('DONE')
  if (!finishedBeforeKill) {
    assert.equal(exit.signal, 'SIGKILL')
    // The uncommitted transaction left no trace: still v1, still the v1
    // tables, still every row.
    assert.equal(rawVersion(join(dataDir, ROOM_LOG_DATABASE_FILENAME)), 1)
    assert.deepEqual(
      rawTables(join(dataDir, ROOM_LOG_DATABASE_FILENAME)),
      ['actors', 'messages', 'room_members', 'rooms'],
    )
    assert.equal(rawMessageCount(join(dataDir, ROOM_LOG_DATABASE_FILENAME)), ROOM_COUNT * PER_ROOM)
  }

  // The next boot resumes: the same single transaction reruns from the start
  // and completes to a state identical to the reference migration.
  const outcome = await migrateV1InPlace({ dataDir })
  assert.equal(outcome.migrated, true)
  assert.deepEqual(
    { roomCount: outcome.roomCount, messageCount: outcome.messageCount },
    { roomCount: reference.roomCount, messageCount: reference.messageCount },
  )
  // The realm id and its mint timestamp are created per completed migration
  // (a crash rolls the mint back), so their VALUES may differ from the
  // reference; the singleton realm row's shape and every other durable value
  // must match exactly.
  const subjectState = captureDurableState(join(dataDir, ROOM_LOG_DATABASE_FILENAME))
  assert.equal(subjectState.realms.length, 1)
  assert.match(subjectState.realms[0].realm_id, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
  const maskRealmMint = state => ({
    ...state,
    realms: state.realms.map(({ realm_id, created_at, ...rest }) => ({
      ...rest, realm_id: 'UUID', created_at: 'STAMP',
    })),
  })
  assert.deepEqual(maskRealmMint(subjectState), maskRealmMint(referenceState))
  // Sequences are contiguous from 1 in every room of the resumed migration,
  // and every reply chain still resolves to the same room-local target.
  for (let room = 0; room < ROOM_COUNT; room += 1) {
    const migrated = rawMessages(join(dataDir, ROOM_LOG_DATABASE_FILENAME), `kill-room-${room}`)
    assert.equal(migrated.length, PER_ROOM)
    assert.equal(migrated[0].seq, 1)
    assert.equal(migrated[migrated.length - 1].seq, PER_ROOM)
    const referenceRows = rawMessages(join(referenceDir, ROOM_LOG_DATABASE_FILENAME), `kill-room-${room}`)
    assert.deepEqual(
      migrated.map(row => [row.seq, row.reply_to_seq, row.text]),
      referenceRows.map(row => [row.seq, row.reply_to_seq, row.text]),
    )
  }
})

// --- Absorb-or-stop ----------------------------------------------------------------

test('a live v0.1 daemon is stopped (SIGTERM) before the migration runs, and the migration then completes', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-migrate-daemon-'))
  const childDir = mkdtempSync(join(tmpdir(), 'agent-room-migrate-daemon-child-'))
  t.after(() => {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(childDir, { recursive: true, force: true })
  })
  standardV1Fixture(dataDir)

  const script = writeChildScript(childDir, 'v01-daemon.mjs', DAEMON_SCRIPT)
  const daemon = trackedChild(t, script, [dataDir, 'agent-room'])
  await daemon.waitForOutput('READY')

  // The daemon is provably alive and named by the record before the migration.
  const [, daemonPid, daemonPort] = daemon.stdout().trim().split(' ')
  const record = JSON.parse(readFileSync(join(dataDir, 'runtime.json'), 'utf8'))
  assert.equal(record.pid, Number(daemonPid))
  assert.equal(record.httpOrigin, `http://127.0.0.1:${daemonPort}`)
  assert.equal(daemon.pidAlive(), true)

  const outcome = await migrateV1InPlace({ dataDir })
  assert.equal(outcome.migrated, true)
  assert.equal(outcome.messageCount, 6)

  // The identified daemon was stopped: it died by SIGTERM (the default
  // disposition — the fake daemon installs no handler, exactly as the
  // assertion wants), and only then did the migration commit.
  const exit = await daemon.waitForExit()
  assert.equal(exit.signal, 'SIGTERM')
  assert.equal(rawVersion(join(dataDir, ROOM_LOG_DATABASE_FILENAME)), 2)
})

test('a foreign responder on the recorded port is never signalled: the migration refuses coded and the file stays v1', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-migrate-foreign-'))
  const childDir = mkdtempSync(join(tmpdir(), 'agent-room-migrate-foreign-child-'))
  t.after(() => {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(childDir, { recursive: true, force: true })
  })
  standardV1Fixture(dataDir)
  const databasePath = join(dataDir, ROOM_LOG_DATABASE_FILENAME)
  const bytesBefore = readFileSync(databasePath)

  // A live process that is NOT agent-room holds the recorded port.
  const script = writeChildScript(childDir, 'foreign.mjs', DAEMON_SCRIPT)
  const foreign = trackedChild(t, script, [dataDir, 'foreign'])
  await foreign.waitForOutput('READY')

  await assert.rejects(
    () => migrateV1InPlace({ dataDir }),
    error => error?.name === 'AgentRoomRuntimeError' && error?.code === 'server_port_conflict',
  )

  // The foreign process survived (never signalled) and the file is untouched.
  assert.equal(foreign.pidAlive(), true)
  assert.equal(rawVersion(databasePath), 1)
  assert.ok(readFileSync(databasePath).equals(bytesBefore), 'the refused migration modified the database file')
})

test('a dead-and-unreachable record is reclaimed: the migration proceeds and completes', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-migrate-reclaim-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  standardV1Fixture(dataDir)

  const deadPid = await collectDeadPid()
  const closedPort = await collectClosedPort()
  writeFileSync(join(dataDir, 'runtime.json'), JSON.stringify({
    pid: deadPid,
    version: '0.1.0',
    protocolVersion: 1,
    socketPath: join(dataDir, 'roomd.sock'),
    httpOrigin: `http://127.0.0.1:${closedPort}`,
    startedAt: '2026-01-01T00:00:00.000Z',
  }), { mode: 0o600 })

  const outcome = await migrateV1InPlace({ dataDir })
  assert.equal(outcome.migrated, true)
  assert.equal(outcome.messageCount, 6)
  assert.equal(rawVersion(join(dataDir, ROOM_LOG_DATABASE_FILENAME)), 2)
})

test('a live pid whose port never answers is unidentifiable and is left alone: the migration settles, proceeds, and nothing is signalled', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-migrate-silent-'))
  const childDir = mkdtempSync(join(tmpdir(), 'agent-room-migrate-silent-child-'))
  t.after(() => {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(childDir, { recursive: true, force: true })
  })
  standardV1Fixture(dataDir)

  // A live process with no HTTP surface; the record names its pid and a
  // closed port. The migration may not signal it — it may not be the daemon.
  const script = writeChildScript(childDir, 'silent.mjs', DAEMON_SCRIPT)
  const silent = trackedChild(t, script, [dataDir, 'silent'])
  await silent.waitForOutput('READY')
  const closedPort = await collectClosedPort()
  writeFileSync(join(dataDir, 'runtime.json'), JSON.stringify({
    pid: silent.child.pid,
    version: '0.1.0',
    protocolVersion: 1,
    socketPath: join(dataDir, 'roomd.sock'),
    httpOrigin: `http://127.0.0.1:${closedPort}`,
    startedAt: '2026-01-01T00:00:00.000Z',
  }), { mode: 0o600 })

  const startedAt = Date.now()
  const outcome = await migrateV1InPlace({ dataDir })
  // The settle window ran before the migration proceeded.
  assert.ok(Date.now() - startedAt >= MIGRATION_DAEMON_SETTLE_MS, 'the migration did not honor the settle window')
  assert.equal(outcome.migrated, true)
  assert.equal(rawVersion(join(dataDir, ROOM_LOG_DATABASE_FILENAME)), 2)

  // The unidentified process survived untouched.
  const survived = await Promise.race([
    silent.waitForExit().then(() => false),
    new Promise(resolvePromise => setTimeout(() => resolvePromise(true), 250)),
  ])
  assert.equal(survived, true)
})

// --- Non-v1 files are no-ops; the store's refusals still hold ----------------------

test('anything that is not a v1 file is a no-op: missing, fresh, current, future, foreign, corrupt, and symlinked', async t => {
  // Missing database: a fresh data dir.
  const missingDir = mkdtempSync(join(tmpdir(), 'agent-room-migrate-missing-'))
  t.after(() => rmSync(missingDir, { recursive: true, force: true }))
  assert.deepEqual(await migrateV1InPlace({ dataDir: missingDir }), { migrated: false })
  assert.equal(existsSync(join(missingDir, ROOM_LOG_DATABASE_FILENAME)), false, 'the no-op created a database file')

  // A fresh v2 store: not migrated, realm and state untouched.
  const freshDir = mkdtempSync(join(tmpdir(), 'agent-room-migrate-fresh-'))
  t.after(() => rmSync(freshDir, { recursive: true, force: true }))
  const freshStore = openRoomLog({ dataDir: freshDir })
  freshStore.close()
  const freshPath = join(freshDir, ROOM_LOG_DATABASE_FILENAME)
  const freshBefore = readFileSync(freshPath)
  const freshStateBefore = captureDurableState(freshPath)
  assert.deepEqual(await migrateV1InPlace({ dataDir: freshDir }), { migrated: false })
  assert.deepEqual(captureDurableState(freshPath), freshStateBefore)
  assert.ok(readFileSync(freshPath).equals(freshBefore), 'the no-op modified a fresh v2 file')

  // A future version (3) stamped on a v2 store: a byte-untouched no-op for
  // the migration, and the store's coded refusal still holds.
  const futureDir = mkdtempSync(join(tmpdir(), 'agent-room-migrate-future-'))
  t.after(() => rmSync(futureDir, { recursive: true, force: true }))
  const futureStore = openRoomLog({ dataDir: futureDir })
  futureStore.close()
  const futurePath = join(futureDir, ROOM_LOG_DATABASE_FILENAME)
  const stamp = new DatabaseSync(futurePath)
  stamp.exec('PRAGMA user_version = 3')
  stamp.close()
  const futureBefore = readFileSync(futurePath)
  assert.deepEqual(await migrateV1InPlace({ dataDir: futureDir }), { migrated: false })
  assert.ok(readFileSync(futurePath).equals(futureBefore), 'the no-op modified a future-version file')
  assert.throws(() => openRoomLog({ dataDir: futureDir }), error => error?.code === 'database_schema_unsupported')

  // A version-0 file carrying foreign tables: untouched by the migration,
  // refused by the store.
  const strayDir = mkdtempSync(join(tmpdir(), 'agent-room-migrate-stray-'))
  t.after(() => rmSync(strayDir, { recursive: true, force: true }))
  const strayPath = join(strayDir, ROOM_LOG_DATABASE_FILENAME)
  const stray = new DatabaseSync(strayPath)
  stray.exec('CREATE TABLE someone_elses_data (a TEXT)')
  stray.close()
  const strayBefore = readFileSync(strayPath)
  assert.deepEqual(await migrateV1InPlace({ dataDir: strayDir }), { migrated: false })
  assert.ok(readFileSync(strayPath).equals(strayBefore), 'the no-op modified a foreign version-0 file')
  assert.throws(() => openRoomLog({ dataDir: strayDir }), error => error?.code === 'database_schema_unsupported')

  // A corrupt (non-SQLite) file: untouched by the migration, refused by the
  // store.
  const corruptDir = mkdtempSync(join(tmpdir(), 'agent-room-migrate-corrupt-'))
  t.after(() => rmSync(corruptDir, { recursive: true, force: true }))
  const corruptPath = join(corruptDir, ROOM_LOG_DATABASE_FILENAME)
  writeFileSync(corruptPath, Buffer.from('this file is definitely not a sqlite database; it is just text. '.repeat(20), 'utf8'))
  const corruptBefore = readFileSync(corruptPath)
  assert.deepEqual(await migrateV1InPlace({ dataDir: corruptDir }), { migrated: false })
  assert.ok(readFileSync(corruptPath).equals(corruptBefore), 'the no-op modified a corrupt file')
  assert.throws(() => openRoomLog({ dataDir: corruptDir }), error => error?.code === 'database_schema_unsupported')

  // A symlinked database path: not followed, not migrated.
  const symlinkDir = mkdtempSync(join(tmpdir(), 'agent-room-migrate-symlink-'))
  t.after(() => rmSync(symlinkDir, { recursive: true, force: true }))
  const targetPath = join(symlinkDir, 'target.sqlite')
  writeFileSync(targetPath, 'placeholder')
  symlinkSync(targetPath, join(symlinkDir, ROOM_LOG_DATABASE_FILENAME))
  assert.deepEqual(await migrateV1InPlace({ dataDir: symlinkDir }), { migrated: false })
  assert.equal(readFileSync(targetPath, 'utf8'), 'placeholder')
  assert.equal(lstatSync(join(symlinkDir, ROOM_LOG_DATABASE_FILENAME)).isSymbolicLink(), true)

  // Invalid dataDir arguments are coded.
  await assert.rejects(() => migrateV1InPlace(), error => error?.code === 'data_directory_invalid')
  await assert.rejects(() => migrateV1InPlace({ dataDir: '' }), error => error?.code === 'data_directory_invalid')
})

test('the raw store still refuses a v1 file byte-for-byte untouched: the migration belongs to startup, never to the raw store path', t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-migrate-storev1-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  standardV1Fixture(dataDir)
  const databasePath = join(dataDir, ROOM_LOG_DATABASE_FILENAME)
  const bytesBefore = readFileSync(databasePath)

  assert.throws(
    () => openRoomLog({ dataDir }),
    error => error?.name === 'AgentRoomRuntimeError' && error?.code === 'database_schema_unsupported',
  )

  assert.ok(readFileSync(databasePath).equals(bytesBefore), 'the raw store modified a refused v1 file')
  assert.equal(existsSync(`${databasePath}-wal`), false)
  assert.equal(existsSync(`${databasePath}-shm`), false)
  assert.equal(rawVersion(databasePath), 1)
})

// --- Documentation discipline --------------------------------------------------------

test('the one-time cursor reset is documented exactly once in production code', () => {
  const files = []
  const walk = directory => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name)
      const info = lstatSync(path)
      if (info.isSymbolicLink()) continue
      if (info.isDirectory()) walk(path)
      else if (name.endsWith('.mjs')) files.push(path)
    }
  }
  walk(join(ROOT, 'server'))
  const marker = 'THE ONE-TIME CURSOR RESET'
  const carriers = files.filter(path => readFileSync(path, 'utf8').includes(marker))
  assert.deepEqual(
    carriers.map(path => path.slice(ROOT.length + 1)),
    ['server/store/migrate-v1.mjs'],
    'the cursor-reset documentation must live in exactly one production file',
  )
  const source = readFileSync(carriers[0], 'utf8')
  assert.equal(source.split(marker).length - 1, 1)
  // The documented reset is real: the migration mints the realm's first id,
  // which is what takes pre-upgrade cursor values out of service.
  assert.match(source, /realm's first id/)
})
