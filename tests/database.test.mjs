import assert from 'node:assert/strict'
import { statSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { DatabaseSync } from 'node:sqlite'

import {
  DATABASE_LIMITS,
  openRoomDatabase,
} from '../server/database.mjs'

function fixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-database-'))
  const databases = []
  t.after(() => {
    for (const database of databases.reverse()) database.close()
    rmSync(dataDir, { recursive: true, force: true })
  })
  return {
    dataDir,
    open() {
      const database = openRoomDatabase({ dataDir })
      databases.push(database)
      return database
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

test('opens a private file-backed STRICT WAL database with required pragmas', t => {
  const subject = fixture(t)
  const database = subject.open()

  assert.equal(database.journalMode, 'wal')
  assert.match(database.sqliteVersion, /^3\.\d+\.\d+/)
  assert.deepEqual(database.pragmas, {
    synchronous: 2,
    foreignKeys: true,
    busyTimeout: 5000,
    walAutoCheckpoint: 1000,
  })
  assert.equal(statSync(subject.dataDir).mode & 0o777, 0o700)
  assert.equal(statSync(database.databasePath).mode & 0o777, 0o600)

  const inspector = new DatabaseSync(database.databasePath)
  t.after(() => inspector.close())
  assert.equal(inspector.prepare('PRAGMA journal_mode').get().journal_mode, 'wal')
  assert.equal(inspector.prepare('PRAGMA user_version').get().user_version, 1)
  const strictTables = inspector.prepare(`
    SELECT name, strict
    FROM pragma_table_list
    WHERE schema = 'main'
      AND name IN ('actors', 'rooms', 'room_members', 'messages')
    ORDER BY name
  `).all().map(row => [row.name, row.strict])
  assert.deepEqual(strictTables, [
    ['actors', 1],
    ['messages', 1],
    ['room_members', 1],
    ['rooms', 1],
  ])
})

test('creates and joins rooms, then reads globally ordered messages by cursor', t => {
  const database = fixture(t).open()
  const room = database.createRoom({
    actorId: 'agent:alice',
    displayName: 'Alice',
    title: '  Design room  ',
  })
  const membership = database.joinRoom({
    roomId: room.id,
    actorId: 'agent:bob',
    displayName: 'Bob',
  })

  assert.equal(room.title, 'Design room')
  assert.equal(membership.room_id, room.id)
  const firstResult = database.sendMessage({
    roomId: room.id,
    actorId: 'agent:alice',
    clientMessageId: 'alice-1',
    text: 'What should we build?',
  })
  const first = firstResult.message
  const secondResult = database.sendMessage({
    roomId: room.id,
    actorId: 'agent:bob',
    clientMessageId: 'bob-1',
    text: 'A small vertical slice.',
    replyToSeq: first.seq,
  })
  const second = secondResult.message

  assert.ok(second.seq > first.seq)
  assert.equal(firstResult.duplicate, false)
  assert.equal(secondResult.duplicate, false)
  assert.equal(first.actor_display_name, 'Alice')
  assert.equal(second.actor_display_name, 'Bob')
  assert.equal(second.reply_to_seq, first.seq)
  assert.match(first.created_at, /^\d{4}-\d{2}-\d{2}T/)

  const firstPage = database.readMessages({
    roomId: room.id,
    actorId: 'agent:bob',
    afterSeq: 0,
    limit: 1,
  })
  assert.deepEqual(firstPage, [first])
  assert.deepEqual(
    database.readMessages({
      roomId: room.id,
      actorId: 'agent:bob',
      afterSeq: first.seq,
      limit: 10,
    }),
    [second],
  )
  assert.deepEqual(database.readRoomMessages({ roomId: room.id }), [first, second])
  assert.deepEqual(database.listRooms(), [room])
})

test('requires room membership for agent reads and sends', t => {
  const database = fixture(t).open()
  const room = database.createRoom({
    actorId: 'agent:alice',
    displayName: 'Alice',
    title: 'Private room',
  })

  assertCode(() => database.sendMessage({
    roomId: room.id,
    actorId: 'agent:eve',
    clientMessageId: 'eve-1',
    text: 'Hello',
  }), 'actor_not_member')
  assertCode(() => database.readMessages({
    roomId: room.id,
    actorId: 'agent:eve',
  }), 'actor_not_member')
  assertCode(() => database.joinRoom({
    roomId: 'missing-room',
    actorId: 'agent:eve',
    displayName: 'Eve',
  }), 'room_not_found')
  assert.deepEqual(database.readRoomMessages({ roomId: room.id }), [])
})

test('replays an idempotent send and rejects client-message payload drift', t => {
  const database = fixture(t).open()
  const room = database.createRoom({
    actorId: 'agent:alice',
    displayName: 'Alice',
    title: 'Retries',
  })
  const payload = {
    roomId: room.id,
    actorId: 'agent:alice',
    clientMessageId: 'request-1',
    text: 'Exactly once',
  }

  const original = database.sendMessage(payload)
  const replay = database.sendMessage(payload)
  assert.equal(original.duplicate, false)
  assert.equal(replay.duplicate, true)
  assert.deepEqual(replay.message, original.message)
  assertCode(
    () => database.sendMessage({ ...payload, text: 'Changed text' }),
    'client_message_id_conflict',
  )
  assertCode(
    () => database.sendMessage({ ...payload, replyToSeq: original.message.seq }),
    'client_message_id_conflict',
  )
  assert.deepEqual(database.readRoomMessages({ roomId: room.id }), [original.message])
})

test('accepts replies only to an existing message in the same room', t => {
  const database = fixture(t).open()
  const firstRoom = database.createRoom({
    actorId: 'agent:alice',
    displayName: 'Alice',
    title: 'First',
  })
  const secondRoom = database.createRoom({
    actorId: 'agent:alice',
    displayName: 'Alice',
    title: 'Second',
  })
  const firstMessage = database.sendMessage({
    roomId: firstRoom.id,
    actorId: 'agent:alice',
    clientMessageId: 'first-1',
    text: 'Only in the first room',
  }).message

  assertCode(() => database.sendMessage({
    roomId: secondRoom.id,
    actorId: 'agent:alice',
    clientMessageId: 'second-1',
    text: 'Cross-room reply',
    replyToSeq: firstMessage.seq,
  }), 'reply_room_mismatch')
  assertCode(() => database.sendMessage({
    roomId: firstRoom.id,
    actorId: 'agent:alice',
    clientMessageId: 'first-2',
    text: 'Missing reply',
    replyToSeq: firstMessage.seq + 10_000,
  }), 'message_not_found')
})

test('validates identifiers, text, reply cursors, and read bounds', t => {
  const database = fixture(t).open()
  assertCode(() => database.createRoom({
    actorId: 'invalid actor',
    displayName: 'Alice',
    title: 'Room',
  }), 'invalid_actor_id')
  assertCode(() => database.createRoom({
    actorId: 'agent:alice',
    displayName: 'A'.repeat(DATABASE_LIMITS.displayName + 1),
    title: 'Room',
  }), 'invalid_display_name')

  const room = database.createRoom({
    actorId: 'agent:alice',
    displayName: 'Alice',
    title: 'Bounds',
  })
  const base = {
    roomId: room.id,
    actorId: 'agent:alice',
    clientMessageId: 'message-1',
  }
  assertCode(() => database.sendMessage({ ...base, text: '   ' }), 'invalid_text')
  assertCode(
    () => database.sendMessage({ ...base, text: 'x'.repeat(DATABASE_LIMITS.messageText + 1) }),
    'invalid_text',
  )
  assertCode(
    () => database.sendMessage({ ...base, text: 'valid', replyToSeq: 0 }),
    'invalid_reply_to_seq',
  )
  assertCode(() => database.readMessages({
    roomId: room.id,
    actorId: 'agent:alice',
    afterSeq: -1,
  }), 'invalid_cursor')
  assertCode(() => database.readRoomMessages({ roomId: room.id, limit: 0 }), 'invalid_limit')
  assertCode(
    () => database.readRoomMessages({ roomId: room.id, limit: DATABASE_LIMITS.readLimit + 1 }),
    'invalid_limit',
  )
})

test('persists rooms, membership, messages, and idempotency across reopen', t => {
  const subject = fixture(t)
  const firstDatabase = subject.open()
  const room = firstDatabase.createRoom({
    actorId: 'agent:alice',
    displayName: 'Alice',
    title: 'Persistent room',
  })
  const payload = {
    roomId: room.id,
    actorId: 'agent:alice',
    clientMessageId: 'persistent-1',
    text: 'Survives restart',
  }
  const original = firstDatabase.sendMessage(payload).message
  firstDatabase.close()

  const reopened = subject.open()
  assert.deepEqual(reopened.listRooms(), [room])
  assert.deepEqual(reopened.readMessages({
    roomId: room.id,
    actorId: 'agent:alice',
  }), [original])
  assert.deepEqual(reopened.sendMessage(payload), { message: original, duplicate: true })
})
