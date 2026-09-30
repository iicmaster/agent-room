import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'

import {
  CHAT_ID_MAX,
  CLIENT_MESSAGE_ID_MAX,
  INTERNAL_ERROR_CODES,
  MESSAGE_TEXT_MAX,
  PUBLIC_ERRORS,
  READ_PAGE_MAX,
  ROOM_ID_ENTROPY_BYTES,
  TITLE_MAX,
} from '../server/constants.mjs'
import {
  ROOM_LOG_DATABASE_FILENAME,
  openRoomLog,
} from '../server/store/room-log.mjs'
import { openRoomDatabase } from '../server/database.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Deterministic canonical fingerprints: sha256: + 64 lowercase hex characters.
const fingerprintOf = name => `sha256:${createHash('sha256').update(name).digest('hex')}`
const fpA = fingerprintOf('alice')
const fpB = fingerprintOf('bob')
const fpC = fingerprintOf('eve')

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-store-'))
  const stores = []
  t.after(() => {
    for (const store of stores.reverse()) store.close()
    rmSync(dataDir, { recursive: true, force: true })
  })
  return {
    dataDir,
    open() {
      const store = openRoomLog({ dataDir })
      stores.push(store)
      return store
    },
  }
}

function assertCode(operation, code) {
  assert.throws(operation, error => {
    assert.equal(error?.name, 'AgentRoomRuntimeError')
    assert.equal(error?.code, code)
    return true
  })
}

function appendMessage(store, roomId, overrides = {}) {
  return store.appendMessage({
    roomId,
    actorFingerprint: fpA,
    chatId: 'alice',
    clientMessageId: `message-${Math.random().toString(36).slice(2)}`,
    text: 'Hello room',
    ...overrides,
  })
}

// Symlink-safe walk mirroring tests/constants.test.mjs.
function listModules(directory) {
  const found = []
  let names
  try {
    names = readdirSync(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return found
    throw error
  }
  for (const name of names.sort()) {
    const path = join(directory, name)
    let info
    try {
      info = lstatSync(path)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) found.push(...listModules(path))
    else if (name.endsWith('.mjs')) found.push(path)
  }
  return found
}

function writeChildScript(directory, filename, lines) {
  const path = join(directory, filename)
  writeFileSync(path, `${lines.join('\n')}\n`, { mode: 0o600 })
  return path
}

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms) })

// --- Store guarantees: STRICT, WAL, FULL, fk, autocheckpoint, permissions ----

test('opens a private STRICT WAL v2 store with the required pragma discipline', t => {
  const subject = fixture(t)
  const store = subject.open()

  assert.equal(store.journalMode, 'wal')
  assert.equal(store.schemaVersion, 2)
  assert.match(store.sqliteVersion, /^3\.\d+\.\d+/)
  assert.deepEqual(store.pragmas, {
    synchronous: 2,
    foreignKeys: true,
    busyTimeout: 5000,
    walAutoCheckpoint: 1000,
  })
  assert.equal(statSync(subject.dataDir).mode & 0o777, 0o700)
  assert.equal(statSync(store.databasePath).mode & 0o777, 0o600)

  const inspector = new DatabaseSync(store.databasePath)
  t.after(() => inspector.close())
  assert.equal(inspector.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
  assert.equal(inspector.prepare('PRAGMA user_version').get().user_version, 2)
  const strictTables = inspector.prepare(`
    SELECT name, strict
    FROM pragma_table_list
    WHERE schema = 'main'
      AND name IN ('rooms', 'direct_members', 'messages')
    ORDER BY name
  `).all().map(row => [row.name, row.strict])
  assert.deepEqual(strictTables, [
    ['direct_members', 1],
    ['messages', 1],
    ['rooms', 1],
  ])
})

test('database, wal, and shm files are owner-only 0600 after activity', t => {
  const subject = fixture(t)
  const store = subject.open()
  const room = store.createBroadcastRoom({ actorFingerprint: fpA, title: 'Modes' })
  appendMessage(store, room.id, { clientMessageId: 'mode-1' })

  for (const suffix of ['', '-wal', '-shm']) {
    const info = statSync(`${store.databasePath}${suffix}`)
    assert.equal(info.mode & 0o777, 0o600, `mode of ${suffix || 'database'}`)
  }
})

test('schema-level CHECKs reject malformed fingerprints and reply targets on raw writes', t => {
  const subject = fixture(t)
  const store = subject.open()
  const room = store.createBroadcastRoom({ actorFingerprint: fpA, title: 'Checks' })
  // A raw connection bypasses the store's validation (and carries no foreign
  // keys of its own) so the table CHECKs must hold the line themselves.
  const raw = new DatabaseSync(store.databasePath)
  t.after(() => raw.close())
  const insert = fingerprint => raw.prepare(`
    INSERT INTO messages (
      room_id, seq, actor_fingerprint, chat_id, client_message_id, text, reply_to_seq, created_at
    ) VALUES (?, 1, ?, 'alice', 'raw-1', 'raw insert', NULL, '2026-01-01T00:00:00.000Z')
  `).run(room.id, fingerprint)

  assert.throws(() => insert('sha256:NOPE'), /CHECK constraint failed/)
  assert.throws(() => insert(`sha256:${'A'.repeat(64)}`), /CHECK constraint failed/)
  assert.throws(() => insert(`sha256:${'a'.repeat(63)}`), /CHECK constraint failed/)

  const badReply = raw.prepare(`
    INSERT INTO messages (
      room_id, seq, actor_fingerprint, chat_id, client_message_id, text, reply_to_seq, created_at
    ) VALUES (?, 1, ?, 'alice', 'raw-2', 'raw insert', 0, '2026-01-01T00:00:00.000Z')
  `)
  assert.throws(() => badReply.run(room.id, fpA), /CHECK constraint failed/)
})

// --- Contiguous room-local sequences ------------------------------------------

test('sequences are room-local, contiguous from 1; each room starts at 1', t => {
  const store = fixture(t).open()
  const room = store.createBroadcastRoom({ actorFingerprint: fpA, title: 'Log' })
  const other = store.createBroadcastRoom({ actorFingerprint: fpB, title: 'Other log' })

  assert.equal(room.kind, 'broadcast')
  assert.equal(room.pair_key, null)
  assert.equal(room.title, 'Log')

  const first = appendMessage(store, room.id, { clientMessageId: 'a-1' }).message
  const second = appendMessage(store, room.id, {
    actorFingerprint: fpB,
    chatId: 'bob',
    clientMessageId: 'b-1',
    text: 'Second',
  }).message

  assert.deepEqual([first.seq, second.seq], [1, 2])
  assert.equal(first.room_id, room.id)
  assert.equal(first.actor_fingerprint, fpA)
  assert.equal(first.chat_id, 'alice')
  assert.equal(first.reply_to_seq, null)
  assert.match(first.created_at, /^\d{4}-\d{2}-\d{2}T/)

  const otherFirst = appendMessage(store, other.id, { clientMessageId: 'a-2' }).message
  assert.equal(otherFirst.seq, 1)
})

test('room ids are opaque base64url: 16 bytes of entropy, exactly 22 characters', t => {
  const store = fixture(t).open()
  const broadcast = store.createBroadcastRoom({ actorFingerprint: fpA, title: 'Ids' })
  const dm = store.openDirectRoom({ actorFingerprints: [fpA, fpB] })

  const base64urlPattern = /^[A-Za-z0-9_-]{22}$/
  assert.match(broadcast.id, base64urlPattern)
  assert.match(dm.id, base64urlPattern)
  // 16 bytes → 128 bits → ceil(128/6) = 22 unpadded base64url characters.
  assert.equal(Math.ceil((ROOM_ID_ENTROPY_BYTES * 8) / 6), 22)

  // The ids round-trip through every api entry that consumes a room id.
  assert.equal(store.getRoom(broadcast.id).id, broadcast.id)
  assert.equal(store.getRoom(dm.id, { actorFingerprint: fpA }).id, dm.id)
  assert.equal(appendMessage(store, broadcast.id, { clientMessageId: 'id-1' }).message.room_id, broadcast.id)
})

// --- Idempotency: resend, conflict, room scope, chat-id attribution ----------

test('an idempotent resend returns the original message and adds no row', t => {
  const store = fixture(t).open()
  const room = store.createBroadcastRoom({ actorFingerprint: fpA, title: 'Retries' })
  const payload = {
    roomId: room.id,
    actorFingerprint: fpA,
    chatId: 'alice',
    clientMessageId: 'request-1',
    text: 'Exactly once',
  }

  const original = store.appendMessage(payload)
  assert.equal(original.duplicate, false)
  const replay = store.appendMessage(payload)
  assert.equal(replay.duplicate, true)
  assert.deepEqual(replay.message, original.message)
  assert.deepEqual(store.readPage({ roomId: room.id, actorFingerprint: fpA }), [original.message])
})

test('a payload conflict under the same idempotency tuple adds no row', t => {
  const store = fixture(t).open()
  const room = store.createBroadcastRoom({ actorFingerprint: fpA, title: 'Conflicts' })
  const payload = {
    roomId: room.id,
    actorFingerprint: fpA,
    chatId: 'alice',
    clientMessageId: 'request-1',
    text: 'Original',
  }
  const original = store.appendMessage(payload).message

  assertCode(() => store.appendMessage({ ...payload, text: 'Changed text' }), 'client_message_id_conflict')
  assertCode(
    () => store.appendMessage({ ...payload, replyToSeq: original.seq }),
    'client_message_id_conflict',
  )
  assert.deepEqual(store.readPage({ roomId: room.id, actorFingerprint: fpA }), [original])
})

test('idempotency is room-scoped: the same tuple in another room appends fresh', t => {
  const store = fixture(t).open()
  const firstRoom = store.createBroadcastRoom({ actorFingerprint: fpA, title: 'One' })
  const secondRoom = store.createBroadcastRoom({ actorFingerprint: fpA, title: 'Two' })
  const shared = {
    actorFingerprint: fpA,
    chatId: 'alice',
    clientMessageId: 'cross-1',
    text: 'Same tuple',
  }

  const inFirst = store.appendMessage({ roomId: firstRoom.id, ...shared })
  assert.equal(inFirst.duplicate, false)
  assert.equal(inFirst.message.seq, 1)

  const inSecond = store.appendMessage({ roomId: secondRoom.id, ...shared })
  assert.equal(inSecond.duplicate, false)
  assert.equal(inSecond.message.seq, 1)
  assert.equal(inSecond.message.room_id, secondRoom.id)
})

test('chat id is send-time attribution, not payload: a renamed resend returns the original', t => {
  const store = fixture(t).open()
  const room = store.createBroadcastRoom({ actorFingerprint: fpA, title: 'Rename' })
  const payload = {
    roomId: room.id,
    actorFingerprint: fpA,
    chatId: 'alice',
    clientMessageId: 'rename-1',
    text: 'Same words',
  }
  const original = store.appendMessage(payload).message

  const renamed = store.appendMessage({ ...payload, chatId: 'alice-renamed' })
  assert.equal(renamed.duplicate, true)
  assert.deepEqual(renamed.message, original)
  assert.equal(renamed.message.chat_id, 'alice')
})

// --- Crash before commit: the real appendMessage path, SIGKILL mid-insert -----

test('a crash mid-insert leaves no acknowledgment, no message, and its seq unconsumed', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-store-crash-'))
  const childDir = mkdtempSync(join(tmpdir(), 'agent-room-store-crash-child-'))
  t.after(() => {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(childDir, { recursive: true, force: true })
  })

  const storePath = fileURLToPath(new URL('../server/store/room-log.mjs', import.meta.url))

  // The schema must exist before the test-only trigger can be attached.
  const setup = openRoomLog({ dataDir })
  const databasePath = setup.databasePath
  setup.close()

  // TEST-ONLY instrumentation (no production-code hook): a BEFORE INSERT
  // trigger running a slow deterministic recursive CTE so the child's real
  // appendMessage blocks DURING the insert — transaction begun, row not yet
  // written — when the SIGKILL lands. Dropped before the recovery asserts.
  const trigger = new DatabaseSync(databasePath)
  let triggerClosed = false
  const closeTrigger = () => {
    if (!triggerClosed) {
      trigger.close()
      triggerClosed = true
    }
  }
  t.after(closeTrigger)
  trigger.exec(`
    CREATE TRIGGER store_test_slow_insert
    BEFORE INSERT ON messages
    BEGIN
      WITH RECURSIVE countdown(n, total) AS (
        SELECT 1, 0
        UNION ALL
        SELECT n + 1, total + n FROM countdown WHERE n < 500000000
      )
      SELECT total FROM countdown;
    END
  `)

  const childPath = writeChildScript(childDir, 'crash-child.mjs', [
    "import { createHash } from 'node:crypto'",
    "import { writeSync } from 'node:fs'",
    "import { pathToFileURL } from 'node:url'",
    '',
    "const [dataDir, storePath] = process.argv.slice(2)",
    "const fingerprint = 'sha256:' + createHash('sha256').update('crash-parent').digest('hex')",
    "const { openRoomLog } = await import(pathToFileURL(storePath).href)",
    'const store = openRoomLog({ dataDir })',
    "const room = store.createBroadcastRoom({ actorFingerprint: fingerprint, title: 'Crash room' })",
    // The insert below blocks inside the test-only slow trigger, inside its
    // own BEGIN IMMEDIATE transaction — the true uncommitted-insert path.
    "writeSync(1, 'APPENDING ' + room.id + '\\n')",
    'try {',
    '  const result = store.appendMessage({',
    '    roomId: room.id,',
    '    actorFingerprint: fingerprint,',
    "    chatId: 'crash-child',",
    "    clientMessageId: 'crash-1',",
    "    text: 'Never acknowledged',",
    '  })',
    "  writeSync(1, 'ACK seq=' + result.message.seq + '\\n')",
    '} catch (error) {',
    "  writeSync(1, 'ERROR ' + (error.code ?? error.name) + '\\n')",
    '}',
    'process.exit(0)',
  ])

  const child = spawn(process.execPath, [childPath, dataDir, storePath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.on('data', chunk => { stdout += String(chunk) })
  child.stderr.on('data', chunk => { stderr += String(chunk) })

  await new Promise((resolveAppending, rejectAppending) => {
    const timer = setTimeout(
      () => rejectAppending(new Error(`crash child never signaled APPENDING\nstdout: ${stdout}\nstderr: ${stderr}`)),
      15_000,
    )
    child.on('exit', (exitCode, exitSignal) => {
      if (!stdout.includes('APPENDING')) {
        clearTimeout(timer)
        rejectAppending(new Error(`crash child exited early (${exitCode}/${exitSignal})\nstdout: ${stdout}\nstderr: ${stderr}`))
      }
    })
    const poll = setInterval(() => {
      if (stdout.includes('APPENDING')) {
        clearInterval(poll)
        clearTimeout(timer)
        resolveAppending()
      }
    }, 5)
    t.after(() => { clearTimeout(timer); clearInterval(poll) })
  })

  const crashedRoomId = /APPENDING (\S+)/.exec(stdout)[1]
  // The child is now deterministically inside the INSERT (the slow trigger
  // holds its transaction open with the row in flight); kill mid-insert.
  const exited = once(child, 'exit')
  await sleep(400)
  child.kill('SIGKILL')
  const [code, signal] = await exited
  assert.equal(signal, 'SIGKILL')
  assert.notEqual(code, 0)

  // The append never committed and never returned an acknowledgment.
  assert.ok(stdout.includes('APPENDING'), stdout)
  assert.ok(!stdout.includes('ACK'), `append acknowledged before the crash: ${stdout}`)
  assert.ok(!stdout.includes('ERROR'), `append errored before the crash: ${stdout}`)
  assert.ok(!stderr.includes('Error'), stderr)

  // Remove the test-only trigger so recovery assertions run at real speed.
  trigger.exec('DROP TRIGGER IF EXISTS store_test_slow_insert')
  closeTrigger()

  const reopened = openRoomLog({ dataDir })
  t.after(() => reopened.close())

  // The committed room survives; the in-flight message does not.
  const room = reopened.getRoom(crashedRoomId)
  assert.equal(room.kind, 'broadcast')
  assert.deepEqual(reopened.readPage({ roomId: crashedRoomId, actorFingerprint: fingerprintOf('crash-parent') }), [])

  // The crashed append reserved seq 1; the next committed append gets it.
  const next = appendMessage(reopened, crashedRoomId, { clientMessageId: 'after-crash', text: 'Seq not consumed' })
  assert.equal(next.duplicate, false)
  assert.equal(next.message.seq, 1)
})

// --- Concurrency: two writers, one room, one contiguous sequence ---------------

test('two openRoomLog connections interleaving appends commit exactly 1..n', t => {
  const subject = fixture(t)
  const first = subject.open()
  const second = subject.open()
  const room = first.createBroadcastRoom({ actorFingerprint: fpA, title: 'Shared log' })

  for (let round = 1; round <= 4; round += 1) {
    first.appendMessage({
      roomId: room.id,
      actorFingerprint: fpA,
      chatId: 'alice',
      clientMessageId: `a-${round}`,
      text: `From the first writer ${round}`,
    })
    second.appendMessage({
      roomId: room.id,
      actorFingerprint: fpB,
      chatId: 'bob',
      clientMessageId: `b-${round}`,
      text: `From the second writer ${round}`,
    })
  }

  const page = first.readPage({ roomId: room.id, actorFingerprint: fpA })
  assert.deepEqual(page.map(message => message.seq), [1, 2, 3, 4, 5, 6, 7, 8])
  assert.equal(new Set(page.map(message => message.seq)).size, 8)
  assert.equal(new Set(page.map(message => message.actor_fingerprint)).size, 2)
})

test('two child processes appending concurrently serialize into 1..n with no gaps', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-store-concurrent-'))
  const childDir = mkdtempSync(join(tmpdir(), 'agent-room-store-concurrent-child-'))
  t.after(() => {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(childDir, { recursive: true, force: true })
  })

  const storePath = fileURLToPath(new URL('../server/store/room-log.mjs', import.meta.url))
  const childPath = writeChildScript(childDir, 'concurrent-child.mjs', [
    "import { createHash } from 'node:crypto'",
    "import { writeSync } from 'node:fs'",
    "import { pathToFileURL } from 'node:url'",
    '',
    "const [dataDir, storePath, roomId, tag, count] = process.argv.slice(2)",
    "const fingerprint = 'sha256:' + createHash('sha256').update(tag).digest('hex')",
    "const { openRoomLog } = await import(pathToFileURL(storePath).href)",
    'try {',
    '  const store = openRoomLog({ dataDir })',
    '  for (let i = 1; i <= Number(count); i += 1) {',
    '    store.appendMessage({',
    '      roomId,',
    '      actorFingerprint: fingerprint,',
    '      chatId: tag,',
    '      clientMessageId: tag + \'-\' + i,',
    "      text: 'Concurrent ' + tag + ' ' + i,",
    '    })',
    '  }',
    "  writeSync(1, 'DONE ' + tag + '\\n')",
    '  store.close()',
    '} catch (error) {',
    "  writeSync(1, 'FAILED ' + (error.code ?? error.name) + ': ' + error.message + '\\n')",
    '  process.exit(1)',
    '}',
  ])

  const parent = openRoomLog({ dataDir })
  t.after(() => parent.close())
  const room = parent.createBroadcastRoom({ actorFingerprint: fpA, title: 'Contended' })

  const children = ['writer-one', 'writer-two'].map(tag =>
    spawn(process.execPath, [childPath, dataDir, storePath, room.id, tag, '6'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    }))
  const outputs = await Promise.all(children.map(async child => {
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    const [code, signal] = await once(child, 'exit')
    return { code, signal, stdout, stderr }
  }))

  for (const output of outputs) {
    assert.equal(output.signal, null, output.stderr)
    assert.equal(output.code, 0, `${output.stdout}\n${output.stderr}`)
    assert.ok(output.stdout.includes('DONE'), output.stdout)
    assert.ok(!output.stdout.includes('FAILED'), output.stdout)
  }

  const page = parent.readPage({ roomId: room.id, actorFingerprint: fpA })
  assert.deepEqual(page.map(message => message.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])
  assert.equal(new Set(page.map(message => message.client_message_id)).size, 12)
  for (const tag of ['writer-one', 'writer-two']) {
    assert.equal(page.filter(message => message.chat_id === tag).length, 6)
  }
})

// --- Append-only: static scan + unchanged bytes across reads -------------------

test('the store source contains no mutation verb against the message log', () => {
  const mutationPattern = /UPDATE\s+messages|DELETE\s+FROM\s+messages|REPLACE\s+INTO\s+messages/i
  const offenders = []
  for (const path of listModules(join(ROOT, 'server', 'store'))) {
    // Whitespace-normalize the whole source so verbs split across lines,
    // comments, or unusual spacing are still caught.
    const normalized = readFileSync(path, 'utf8').replace(/\s+/g, ' ')
    if (mutationPattern.test(normalized)) offenders.push(relative(ROOT, path))
  }
  assert.deepEqual(offenders, [])
})

test('every error code the store throws is declared in the constants module', () => {
  const declared = new Set([...Object.keys(PUBLIC_ERRORS), ...INTERNAL_ERROR_CODES])
  const thrown = new Set()
  for (const path of listModules(join(ROOT, 'server', 'store'))) {
    const source = readFileSync(path, 'utf8')
    for (const match of source.matchAll(/\bfail\(\s*'([A-Za-z0-9_]+)'/g)) {
      thrown.add(match[1])
    }
  }
  assert.ok(thrown.size >= 20, `expected a real vocabulary scan, found ${thrown.size} codes`)
  const undeclared = [...thrown].filter(code => !declared.has(code)).sort()
  assert.deepEqual(undeclared, [])
})

test('reads leave the database file byte-for-byte unchanged across reopen', t => {
  const subject = fixture(t)
  const store = subject.open()
  const room = store.createBroadcastRoom({ actorFingerprint: fpA, title: 'Immutable' })
  appendMessage(store, room.id, { clientMessageId: 'i-1' })
  appendMessage(store, room.id, { clientMessageId: 'i-2', text: 'Second' })
  store.close()

  const bytesAfterWrites = readFileSync(join(subject.dataDir, ROOM_LOG_DATABASE_FILENAME))

  const reopened = subject.open()
  reopened.getRoom(room.id)
  reopened.readPage({ roomId: room.id, actorFingerprint: fpA })
  reopened.readPage({ roomId: room.id, actorFingerprint: fpA, afterSeq: 1, limit: 1 })
  reopened.close()

  const bytesAfterReads = readFileSync(join(subject.dataDir, ROOM_LOG_DATABASE_FILENAME))
  assert.ok(bytesAfterWrites.equals(bytesAfterReads), 'reads modified the database file')
})

// --- DM privacy ----------------------------------------------------------------

test('a third actor is denied post and read on a direct room', t => {
  const store = fixture(t).open()
  const dm = store.openDirectRoom({ actorFingerprints: [fpA, fpB] })
  const committed = store.appendMessage({
    roomId: dm.id,
    actorFingerprint: fpA,
    chatId: 'alice',
    clientMessageId: 'dm-1',
    text: 'Psst',
  }).message
  assert.equal(committed.seq, 1)

  assertCode(() => store.appendMessage({
    roomId: dm.id,
    actorFingerprint: fpC,
    chatId: 'eve',
    clientMessageId: 'eve-1',
    text: 'Sneak',
  }), 'actor_not_member')
  assertCode(() => store.readPage({ roomId: dm.id, actorFingerprint: fpC }), 'actor_not_member')

  // The other member reads fine.
  assert.deepEqual(store.readPage({ roomId: dm.id, actorFingerprint: fpB }), [committed])
})

test('getRoom keeps direct rooms private and broadcast rooms open', t => {
  const store = fixture(t).open()
  const dm = store.openDirectRoom({ actorFingerprints: [fpA, fpB] })

  // Members see the full row (pair_key included).
  assert.deepEqual(store.getRoom(dm.id, { actorFingerprint: fpA }), dm)
  assert.deepEqual(store.getRoom(dm.id, { actorFingerprint: fpB }), dm)
  // A third actor is denied — the pair key embeds both fingerprints.
  assertCode(() => store.getRoom(dm.id, { actorFingerprint: fpC }), 'actor_not_member')
  // Direct rooms require an actor fingerprint at all.
  assertCode(() => store.getRoom(dm.id), 'invalid_actor_id')
  assertCode(() => store.getRoom(dm.id, { actorFingerprint: 'nope' }), 'invalid_actor_id')

  const room = store.createBroadcastRoom({ actorFingerprint: fpA, title: 'Open' })
  assert.deepEqual(store.getRoom(room.id, { actorFingerprint: fpC }), room)
  assert.deepEqual(store.getRoom(room.id), room)
  assertCode(() => store.getRoom(room.id, { actorFingerprint: 'nope' }), 'invalid_actor_id')
})

test('broadcast rooms are open: any actor posts and reads without membership rows', t => {
  const store = fixture(t).open()
  const room = store.createBroadcastRoom({ actorFingerprint: fpA, title: 'Town square' })

  const message = store.appendMessage({
    roomId: room.id,
    actorFingerprint: fpB,
    chatId: 'bob',
    clientMessageId: 'bob-1',
    text: 'Anyone may speak',
  }).message
  assert.equal(message.seq, 1)
  assert.deepEqual(store.readPage({ roomId: room.id, actorFingerprint: fpC }), [message])
})

// --- Pair key canonicalization ---------------------------------------------------

test('direct rooms canonicalize the pair key and open idempotently in either order', t => {
  const store = fixture(t).open()
  const [min, max] = [fpA, fpB].sort()

  const first = store.openDirectRoom({ actorFingerprints: [fpA, fpB] })
  const second = store.openDirectRoom({ actorFingerprints: [fpB, fpA] })

  assert.equal(first.kind, 'direct')
  assert.equal(first.title, null)
  assert.equal(first.pair_key, `direct:${min}:${max}`)
  assert.equal(first.created_by_fingerprint, min)
  assert.deepEqual(second, first)

  // Same fingerprint twice: a same-Actor room is allowed.
  const selfRoom = store.openDirectRoom({ actorFingerprints: [fpA, fpA] })
  assert.equal(selfRoom.kind, 'direct')
  assert.equal(selfRoom.pair_key, `direct:${fpA}:${fpA}`)
  assert.notEqual(selfRoom.id, first.id)
  const note = store.appendMessage({
    roomId: selfRoom.id,
    actorFingerprint: fpA,
    chatId: 'alice',
    clientMessageId: 'self-1',
    text: 'Note to self',
  }).message
  assert.equal(note.seq, 1)
})

// --- v1 databases: refused, not migrated ----------------------------------------

test('a realistic v1 store is refused untouched with no sidecar files', t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-store-v1-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))

  // Build the v1 fixture with the real v0.1 store: actors, rooms,
  // room_members, messages, user_version 1, WAL.
  const legacy = openRoomDatabase({ dataDir })
  const legacyRoom = legacy.createRoom({
    actorId: 'agent:legacy',
    displayName: 'Legacy',
    title: 'v0.1 room',
  })
  assert.ok(legacyRoom.id)
  const databasePath = legacy.databasePath
  assert.equal(legacy.journalMode, 'wal')
  legacy.close()

  const bytesBefore = readFileSync(databasePath)
  assertCode(() => openRoomLog({ dataDir }), 'database_schema_unsupported')

  assert.ok(bytesBefore.equals(readFileSync(databasePath)), 'the refused v1 file was modified')
  assert.equal(existsSync(`${databasePath}-wal`), false)
  assert.equal(existsSync(`${databasePath}-shm`), false)

  const inspector = new DatabaseSync(databasePath)
  t.after(() => inspector.close())
  assert.equal(inspector.prepare('PRAGMA user_version').get().user_version, 1)
  const tables = inspector
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map(row => row.name)
  assert.deepEqual(tables, ['actors', 'messages', 'room_members', 'rooms'])

  // Any other unknown version is refused the same way.
  const future = new DatabaseSync(databasePath)
  future.exec('PRAGMA user_version = 3')
  future.close()
  assertCode(() => openRoomLog({ dataDir }), 'database_schema_unsupported')
})

test('a version-0 file with existing tables and a corrupt file are both refused as unsupported', t => {
  const strayDir = mkdtempSync(join(tmpdir(), 'agent-room-store-stray-'))
  const corruptDir = mkdtempSync(join(tmpdir(), 'agent-room-store-corrupt-'))
  t.after(() => {
    rmSync(strayDir, { recursive: true, force: true })
    rmSync(corruptDir, { recursive: true, force: true })
  })

  const strayPath = join(strayDir, ROOM_LOG_DATABASE_FILENAME)
  const stray = new DatabaseSync(strayPath)
  stray.exec('CREATE TABLE someone_elses_data (a TEXT)')
  stray.close()
  assertCode(() => openRoomLog({ dataDir: strayDir }), 'database_schema_unsupported')

  writeFileSync(
    join(corruptDir, ROOM_LOG_DATABASE_FILENAME),
    Buffer.from('this file is definitely not a sqlite database; it is just text. '.repeat(20), 'utf8'),
  )
  assertCode(() => openRoomLog({ dataDir: corruptDir }), 'database_schema_unsupported')
})

// --- Reply targets are room-local ----------------------------------------------

test('reply targets resolve room-locally against (room_id, seq)', t => {
  const store = fixture(t).open()
  const firstRoom = store.createBroadcastRoom({ actorFingerprint: fpA, title: 'First' })
  const secondRoom = store.createBroadcastRoom({ actorFingerprint: fpA, title: 'Second' })
  const firstMessage = appendMessage(store, firstRoom.id, { clientMessageId: 'f-1', text: 'Only in the first room' }).message
  assert.equal(firstMessage.seq, 1)

  // seq 1 exists only in the first room: refused from the second room.
  assertCode(() => store.appendMessage({
    roomId: secondRoom.id,
    actorFingerprint: fpA,
    chatId: 'alice',
    clientMessageId: 's-1',
    text: 'Cross-room reply',
    replyToSeq: 1,
  }), 'reply_room_mismatch')

  // No room has seq 999: the target does not exist at all.
  assertCode(() => store.appendMessage({
    roomId: firstRoom.id,
    actorFingerprint: fpA,
    chatId: 'alice',
    clientMessageId: 'f-2',
    text: 'Missing reply',
    replyToSeq: 999,
  }), 'message_not_found')

  // Room-local resolution: both rooms now have a seq 1; the reply in the
  // second room binds to the second room's seq 1, never the first's.
  const secondHead = appendMessage(store, secondRoom.id, { clientMessageId: 's-2', text: 'Second room head' }).message
  assert.equal(secondHead.seq, 1)
  const reply = store.appendMessage({
    roomId: secondRoom.id,
    actorFingerprint: fpA,
    chatId: 'alice',
    clientMessageId: 's-3',
    text: 'Local reply',
    replyToSeq: 1,
  }).message
  assert.equal(reply.seq, 2)
  assert.equal(reply.reply_to_seq, 1)
})

// --- Cursor pagination -----------------------------------------------------------

test('cursor pagination is strictly-greater, ordered, and truncated by limit', t => {
  const store = fixture(t).open()
  const room = store.createBroadcastRoom({ actorFingerprint: fpA, title: 'Pages' })
  const messages = []
  for (let index = 1; index <= 3; index += 1) {
    messages.push(appendMessage(store, room.id, { clientMessageId: `p-${index}`, text: `Page ${index}` }).message)
  }
  assert.deepEqual(messages.map(message => message.seq), [1, 2, 3])

  // afterSeq is strictly greater: the page after seq 1 starts at seq 2.
  const afterFirst = store.readPage({ roomId: room.id, actorFingerprint: fpA, afterSeq: 1, limit: 1 })
  assert.deepEqual(afterFirst, [messages[1]])
  const afterSecond = store.readPage({ roomId: room.id, actorFingerprint: fpA, afterSeq: 2, limit: 1 })
  assert.deepEqual(afterSecond, [messages[2]])
  // A cursor beyond the head is a normal empty page.
  assert.deepEqual(store.readPage({ roomId: room.id, actorFingerprint: fpA, afterSeq: 999 }), [])
  // The default page returns everything in order.
  assert.deepEqual(store.readPage({ roomId: room.id, actorFingerprint: fpA }), messages)
})

// --- Input validation and boundaries ---------------------------------------------

test('validates fingerprints, room ids, chat ids, text, cursors, and bounds with coded errors', t => {
  const store = fixture(t).open()
  const room = store.createBroadcastRoom({ actorFingerprint: fpA, title: 'Bounds' })
  const base = {
    roomId: room.id,
    actorFingerprint: fpA,
    chatId: 'alice',
    clientMessageId: 'message-1',
    text: 'Hello',
  }

  assertCode(() => store.appendMessage({ ...base, actorFingerprint: 'nope' }), 'invalid_actor_id')
  assertCode(() => store.appendMessage({ ...base, actorFingerprint: `sha256:${'G'.repeat(64)}` }), 'invalid_actor_id')
  assertCode(() => store.appendMessage({ ...base, actorFingerprint: `sha256:${'a'.repeat(63)}` }), 'invalid_actor_id')
  assertCode(() => store.appendMessage({ ...base, chatId: 'bad chat id' }), 'invalid_chat_id')
  assertCode(() => store.appendMessage({ ...base, chatId: 'x'.repeat(CHAT_ID_MAX + 1) }), 'invalid_chat_id')
  assertCode(() => store.appendMessage({ ...base, chatId: 'bad~id' }), 'invalid_chat_id')
  assertCode(() => store.appendMessage({ ...base, clientMessageId: '' }), 'invalid_client_message_id')
  assertCode(() => store.appendMessage({ ...base, clientMessageId: '-leading-hyphen' }), 'invalid_client_message_id')
  assertCode(() => store.appendMessage({ ...base, text: '   ' }), 'invalid_text')
  assertCode(
    () => store.appendMessage({ ...base, text: 'x'.repeat(MESSAGE_TEXT_MAX + 1) }),
    'invalid_text',
  )
  assertCode(() => store.appendMessage({ ...base, text: 'bad\u0000text' }), 'invalid_text')
  assertCode(() => store.appendMessage({ ...base, text: 'lone\uD800surrogate' }), 'invalid_text')
  assertCode(() => store.appendMessage({ ...base, replyToSeq: 0 }), 'invalid_reply_to_seq')
  assertCode(() => store.appendMessage({ ...base, replyToSeq: 1.5 }), 'invalid_reply_to_seq')

  assertCode(() => store.readPage({ roomId: room.id, actorFingerprint: fpA, afterSeq: -1 }), 'invalid_cursor')
  assertCode(() => store.readPage({ roomId: room.id, actorFingerprint: fpA, afterSeq: 1.5 }), 'invalid_cursor')
  assertCode(() => store.readPage({ roomId: room.id, actorFingerprint: fpA, afterSeq: '1' }), 'invalid_cursor')
  assertCode(() => store.readPage({ roomId: room.id, actorFingerprint: fpA, limit: 0 }), 'invalid_limit')
  assertCode(
    () => store.readPage({ roomId: room.id, actorFingerprint: fpA, limit: READ_PAGE_MAX + 1 }),
    'invalid_limit',
  )
  assertCode(() => store.createBroadcastRoom({ actorFingerprint: fpA, title: '   ' }), 'invalid_title')
  assertCode(
    () => store.createBroadcastRoom({ actorFingerprint: fpA, title: 'x'.repeat(TITLE_MAX + 1) }),
    'invalid_title',
  )
  assertCode(() => store.createBroadcastRoom({ actorFingerprint: fpA, title: 'bell\u0007x' }), 'invalid_title')
  assertCode(() => store.createBroadcastRoom({ actorFingerprint: fpA, title: 'lone\uDC00surrogate' }), 'invalid_title')
  assertCode(() => store.openDirectRoom({ actorFingerprints: [fpA] }), 'invalid_actor_id')
  assertCode(() => store.openDirectRoom({ actorFingerprints: 'not-an-array' }), 'invalid_actor_id')
  assertCode(() => store.openDirectRoom({ actorFingerprints: [fpA, 42] }), 'invalid_actor_id')
  assertCode(() => store.openDirectRoom({ actorFingerprints: [fpA, 'sha256:NOPE'] }), 'invalid_actor_id')

  assertCode(() => appendMessage(store, 'not a room id!'), 'invalid_room_id')
  const unknownRoomId = 'unknown-room'
  assertCode(() => appendMessage(store, unknownRoomId, { clientMessageId: 'missing-room' }), 'room_not_found')
  assertCode(() => store.readPage({ roomId: unknownRoomId, actorFingerprint: fpA }), 'room_not_found')
  assertCode(() => store.getRoom(unknownRoomId), 'room_not_found')
})

test('identifier boundaries: clientMessageId is accepted at the bound and rejected past it', t => {
  const store = fixture(t).open()
  const room = store.createBroadcastRoom({ actorFingerprint: fpA, title: 'Boundary' })

  const atBound = appendMessage(store, room.id, {
    clientMessageId: 'a'.repeat(CLIENT_MESSAGE_ID_MAX),
    text: 'At the bound',
  })
  assert.equal(atBound.duplicate, false)
  assert.equal(atBound.message.client_message_id.length, CLIENT_MESSAGE_ID_MAX)

  assertCode(() => appendMessage(store, room.id, {
    clientMessageId: 'a'.repeat(CLIENT_MESSAGE_ID_MAX + 1),
    text: 'Past the bound',
  }), 'invalid_client_message_id')

  // Paired surrogates are valid text; an exact resend stays byte-identical.
  const payload = {
    roomId: room.id,
    actorFingerprint: fpA,
    chatId: 'alice',
    clientMessageId: 'astral-1',
    text: 'thumbs up \u{1F44D} pair',
  }
  const original = store.appendMessage(payload)
  const resend = store.appendMessage(payload)
  assert.equal(resend.duplicate, true)
  assert.deepEqual(resend.message, original.message)
})

test('titles default when omitted, are trimmed, and getRoom projects room metadata', t => {
  const store = fixture(t).open()
  const untitled = store.createBroadcastRoom({ actorFingerprint: fpA })
  assert.equal(untitled.title, 'Broadcast Room')
  const trimmed = store.createBroadcastRoom({ actorFingerprint: fpA, title: '  Design room  ' })
  assert.equal(trimmed.title, 'Design room')

  const dm = store.openDirectRoom({ actorFingerprints: [fpA, fpB] })
  assert.deepEqual(store.getRoom(dm.id, { actorFingerprint: fpA }), dm)
  assert.deepEqual(store.getRoom(untitled.id), {
    id: untitled.id,
    kind: 'broadcast',
    title: 'Broadcast Room',
    pair_key: null,
    created_by_fingerprint: fpA,
    created_at: untitled.created_at,
  })
})

// --- Durability across reopen ---------------------------------------------------

test('rooms, the log, idempotency, and direct membership survive reopen', t => {
  const subject = fixture(t)
  const first = subject.open()
  const room = first.createBroadcastRoom({ actorFingerprint: fpA, title: 'Persistent' })
  const dm = first.openDirectRoom({ actorFingerprints: [fpA, fpB] })
  const dmMessage = first.appendMessage({
    roomId: dm.id,
    actorFingerprint: fpA,
    chatId: 'alice',
    clientMessageId: 'dm-persist-1',
    text: 'DM survives restart',
  }).message
  const payload = {
    roomId: room.id,
    actorFingerprint: fpA,
    chatId: 'alice',
    clientMessageId: 'persist-1',
    text: 'Survives restart',
  }
  const original = first.appendMessage(payload).message
  first.close()

  const reopened = subject.open()
  assert.deepEqual(reopened.getRoom(room.id), {
    id: room.id,
    kind: 'broadcast',
    title: 'Persistent',
    pair_key: null,
    created_by_fingerprint: fpA,
    created_at: room.created_at,
  })
  assert.equal(reopened.openDirectRoom({ actorFingerprints: [fpB, fpA] }).id, dm.id)
  // The DM is still readable by its members and still closed to others.
  assert.deepEqual(reopened.readPage({ roomId: dm.id, actorFingerprint: fpB }), [dmMessage])
  assertCode(() => reopened.readPage({ roomId: dm.id, actorFingerprint: fpC }), 'actor_not_member')
  assert.deepEqual(reopened.readPage({ roomId: room.id, actorFingerprint: fpA }), [original])
  // Story 4.4: the append result is a uniform discriminated outcome —
  // duplicate (the idempotent retry) and duplicateDropped (the new-send
  // duplicate gate) are disjoint booleans, and original names the prior
  // message only on the dropped path.
  assert.deepEqual(reopened.appendMessage(payload), {
    message: original,
    duplicate: true,
    duplicateDropped: false,
    original: null,
  })
})

// --- Connection lifecycle and raw-error hardening --------------------------------

test('every api method throws a coded internal error after close', t => {
  const subject = fixture(t)
  const store = subject.open()
  const room = store.createBroadcastRoom({ actorFingerprint: fpA, title: 'Closed' })
  store.close()
  store.close() // idempotent

  assertCode(() => store.createBroadcastRoom({ actorFingerprint: fpA }), 'store_connection_closed')
  assertCode(() => store.openDirectRoom({ actorFingerprints: [fpA, fpB] }), 'store_connection_closed')
  assertCode(() => appendMessage(store, room.id, { clientMessageId: 'closed-1' }), 'store_connection_closed')
  assertCode(() => store.readPage({ roomId: room.id, actorFingerprint: fpA }), 'store_connection_closed')
  assertCode(() => store.getRoom(room.id), 'store_connection_closed')
})

test('a held write lock makes BEGIN IMMEDIATE map SQLITE_BUSY to a coded internal error', t => {
  const subject = fixture(t)
  const store = subject.open()
  const blocker = new DatabaseSync(store.databasePath)
  t.after(() => blocker.close())
  blocker.exec('BEGIN IMMEDIATE')

  const started = Date.now()
  assertCode(
    () => appendMessage(store, 'uncontended-room', { clientMessageId: 'busy-1' }),
    'database_busy',
  )
  // The store's busy_timeout (5000 ms) was respected before the coded error.
  assert.ok(Date.now() - started >= 4000, `returned after ${Date.now() - started} ms`)

  store.close()
})

test('openRoomLog guards the data directory and refuses symlinked database files', t => {
  assertCode(() => openRoomLog(), 'data_directory_invalid')
  assertCode(() => openRoomLog({}), 'data_directory_invalid')
  assertCode(() => openRoomLog({ dataDir: '' }), 'data_directory_invalid')
  assertCode(() => openRoomLog({ dataDir: '   ' }), 'data_directory_invalid')
  assertCode(() => openRoomLog({ dataDir: 42 }), 'data_directory_invalid')

  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-store-symlink-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const target = join(dataDir, 'real-database.sqlite')
  writeFileSync(target, 'placeholder bytes')
  symlinkSync(target, join(dataDir, ROOM_LOG_DATABASE_FILENAME))
  assertCode(() => openRoomLog({ dataDir }), 'data_directory_invalid')
  // The symlink itself was not followed or replaced.
  assert.ok(lstatSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME)).isSymbolicLink())
})

test('concurrent openers on a fresh file all succeed without crashing the loser', async t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-store-race-'))
  const childDir = mkdtempSync(join(tmpdir(), 'agent-room-store-race-child-'))
  t.after(() => {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(childDir, { recursive: true, force: true })
  })

  const storePath = fileURLToPath(new URL('../server/store/room-log.mjs', import.meta.url))
  const childPath = writeChildScript(childDir, 'race-child.mjs', [
    "import { writeSync } from 'node:fs'",
    "import { pathToFileURL } from 'node:url'",
    '',
    "const [dataDir, storePath] = process.argv.slice(2)",
    "const { openRoomLog } = await import(pathToFileURL(storePath).href)",
    'try {',
    '  const store = openRoomLog({ dataDir })',
    "  store.createBroadcastRoom({ actorFingerprint: 'sha256:' + 'a'.repeat(64), title: 'Race' })",
    "  writeSync(1, 'OK ' + store.schemaVersion + '\\n')",
    '  store.close()',
    '} catch (error) {',
    "  writeSync(1, 'FAILED ' + (error.code ?? error.name) + ': ' + error.message + '\\n')",
    '  process.exit(1)',
    '}',
  ])

  const children = []
  for (let index = 0; index < 4; index += 1) {
    const child = spawn(process.execPath, [childPath, dataDir, storePath], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', chunk => { stdout += String(chunk) })
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    children.push({ child, stdout: () => stdout, stderr: () => stderr })
  }

  const results = await Promise.all(children.map(async entry => {
    const [code, signal] = await once(entry.child, 'exit')
    return { code, signal, stdout: entry.stdout(), stderr: entry.stderr() }
  }))
  for (const result of results) {
    assert.equal(result.signal, null, result.stderr)
    assert.equal(result.code, 0, `${result.stdout}\n${result.stderr}`)
    assert.ok(result.stdout.includes('OK 2'), result.stdout)
    assert.ok(!result.stdout.includes('FAILED'), result.stdout)
  }

  // Exactly one schema exists and it is fully usable.
  const parent = openRoomLog({ dataDir })
  t.after(() => parent.close())
  assert.equal(parent.schemaVersion, 2)
  const inspector = new DatabaseSync(parent.databasePath)
  t.after(() => inspector.close())
  assert.equal(
    inspector.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'rooms'").get().count,
    1,
  )
  const room = parent.createBroadcastRoom({ actorFingerprint: fpA, title: 'After the race' })
  assert.equal(appendMessage(parent, room.id, { clientMessageId: 'post-race-1' }).message.seq, 1)
})
