import { randomUUID } from 'node:crypto'
import { chmodSync, existsSync, lstatSync } from 'node:fs'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

import {
  CLIENT_MESSAGE_ID_MAX,
  DISPLAY_NAME_MAX,
  IDENTIFIER_MAX,
  MESSAGE_TEXT_MAX,
  READ_PAGE_MAX,
  TITLE_MAX,
} from './constants.mjs'
import {
  AgentRoomRuntimeError,
  assertSupportedRuntime,
  ensurePrivateDirectory,
} from './runtime.mjs'

export const DATABASE_FILENAME = 'agent-room.sqlite'
export const DATABASE_SCHEMA_VERSION = 1
// Bounds are owned by constants.mjs (AD-9); this grouping only re-points them.
export const DATABASE_LIMITS = Object.freeze({
  actorId: IDENTIFIER_MAX,
  clientMessageId: CLIENT_MESSAGE_ID_MAX,
  displayName: DISPLAY_NAME_MAX,
  title: TITLE_MAX,
  messageText: MESSAGE_TEXT_MAX,
  readLimit: READ_PAGE_MAX,
})

// Bounds are owned by constants.mjs (AD-9); the pattern only derives from them.
const IDENTIFIER_PATTERN = new RegExp(`^[A-Za-z0-9][A-Za-z0-9_.:-]{0,${IDENTIFIER_MAX - 1}}$`)
const MESSAGE_PROJECTION = `
  SELECT
    seq,
    room_id,
    actor_id,
    actor_display_name,
    client_message_id,
    text,
    reply_to_seq,
    created_at
  FROM messages
`

function fail(code, message) {
  throw new AgentRoomRuntimeError(code, message)
}

function requireObject(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    fail('invalid_argument', 'database operation requires an options object')
  }
  return value
}

function requireIdentifier(value, name, code) {
  if (typeof value !== 'string' || !IDENTIFIER_PATTERN.test(value)) {
    fail(
      code,
      `${name} must be 1-${DATABASE_LIMITS.actorId} characters using letters, numbers, dot, underscore, colon, or hyphen`,
    )
  }
  return value
}

function requireDisplayText(value, name, maximum, code) {
  if (typeof value !== 'string') {
    fail(code, `${name} must be a string`)
  }
  const normalized = value.trim()
  if (
    normalized.length === 0
    || normalized.length > maximum
    || /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    fail(code, `${name} must be 1-${maximum} printable characters`)
  }
  return normalized
}

function requireMessageText(value) {
  if (
    typeof value !== 'string'
    || value.trim().length === 0
    || value.length > DATABASE_LIMITS.messageText
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value)
  ) {
    fail(
      'invalid_text',
      `text must contain 1-${DATABASE_LIMITS.messageText} characters and no unsupported control bytes`,
    )
  }
  return value
}

function requireAfterSeq(value) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail('invalid_cursor', 'afterSeq must be a non-negative safe integer')
  }
  return value
}

function requireReadLimit(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > DATABASE_LIMITS.readLimit) {
    fail('invalid_limit', `limit must be an integer from 1-${DATABASE_LIMITS.readLimit}`)
  }
  return value
}

function requireReplyToSeq(value) {
  if (value === null || value === undefined) return null
  if (!Number.isSafeInteger(value) || value < 1) {
    fail('invalid_reply_to_seq', 'replyToSeq must be null or a positive safe integer')
  }
  return value
}

function pragmaValue(database, sql) {
  const row = database.prepare(sql).get()
  return row ? Object.values(row)[0] : undefined
}

function configureConnection(database) {
  const sqliteVersion = String(
    database.prepare('SELECT sqlite_version() AS version').get().version,
  )
  assertSupportedRuntime({ sqliteVersion })

  const journalMode = String(pragmaValue(database, 'PRAGMA journal_mode = WAL')).toLowerCase()
  if (journalMode !== 'wal') {
    fail('wal_unavailable', 'agent-room requires SQLite WAL journal mode')
  }

  database.exec(`
    PRAGMA synchronous = FULL;
    PRAGMA foreign_keys = ON;
    PRAGMA busy_timeout = 5000;
    PRAGMA wal_autocheckpoint = 1000;
  `)

  const pragmas = Object.freeze({
    synchronous: Number(pragmaValue(database, 'PRAGMA synchronous')),
    foreignKeys: Number(pragmaValue(database, 'PRAGMA foreign_keys')) === 1,
    busyTimeout: Number(pragmaValue(database, 'PRAGMA busy_timeout')),
    walAutoCheckpoint: Number(pragmaValue(database, 'PRAGMA wal_autocheckpoint')),
  })
  if (
    pragmas.synchronous !== 2
    || pragmas.foreignKeys !== true
    || pragmas.busyTimeout !== 5000
    || pragmas.walAutoCheckpoint !== 1000
  ) {
    fail('database_configuration_failed', 'SQLite connection pragmas were not applied')
  }
  return { sqliteVersion, journalMode, pragmas }
}

function withImmediateTransaction(database, operation) {
  database.exec('BEGIN IMMEDIATE')
  try {
    const result = operation()
    database.exec('COMMIT')
    return result
  } catch (error) {
    try {
      database.exec('ROLLBACK')
    } catch {
      // Preserve the operation error; the connection will surface later failures.
    }
    throw error
  }
}

function createSchema(database) {
  withImmediateTransaction(database, () => {
    database.exec(`
      CREATE TABLE actors (
        id TEXT PRIMARY KEY,
        display_name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        CHECK (length(id) BETWEEN 1 AND ${DATABASE_LIMITS.actorId}),
        CHECK (length(display_name) BETWEEN 1 AND ${DATABASE_LIMITS.displayName})
      ) STRICT;

      CREATE TABLE rooms (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        created_by_actor_id TEXT NOT NULL REFERENCES actors(id) ON DELETE RESTRICT,
        created_at TEXT NOT NULL,
        CHECK (length(title) BETWEEN 1 AND ${DATABASE_LIMITS.title})
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
        CHECK (length(actor_display_name) BETWEEN 1 AND ${DATABASE_LIMITS.displayName}),
        CHECK (length(client_message_id) BETWEEN 1 AND ${DATABASE_LIMITS.clientMessageId}),
        CHECK (length(text) BETWEEN 1 AND ${DATABASE_LIMITS.messageText})
      ) STRICT;

      PRAGMA user_version = ${DATABASE_SCHEMA_VERSION};
    `)
  })
}

function ensureSchema(database) {
  const version = Number(pragmaValue(database, 'PRAGMA user_version'))
  if (version === 0) {
    createSchema(database)
  } else if (version !== DATABASE_SCHEMA_VERSION) {
    fail(
      'database_schema_unsupported',
      `database schema ${version} is not supported; expected ${DATABASE_SCHEMA_VERSION}`,
    )
  }

  const strictTables = database.prepare(`
    SELECT name, strict
    FROM pragma_table_list
    WHERE schema = 'main'
      AND name IN ('actors', 'rooms', 'room_members', 'messages')
  `).all()
  const strictByName = new Map(strictTables.map(row => [row.name, Number(row.strict)]))
  for (const name of ['actors', 'rooms', 'room_members', 'messages']) {
    if (strictByName.get(name) !== 1) {
      fail('database_schema_invalid', `database table ${name} is missing or is not STRICT`)
    }
  }
}

function plainMessage(row) {
  return {
    seq: Number(row.seq),
    room_id: row.room_id,
    actor_id: row.actor_id,
    actor_display_name: row.actor_display_name,
    client_message_id: row.client_message_id,
    text: row.text,
    reply_to_seq: row.reply_to_seq === null ? null : Number(row.reply_to_seq),
    created_at: row.created_at,
  }
}

function plainRoom(row) {
  return {
    id: row.id,
    title: row.title,
    created_at: row.created_at,
  }
}

export function openRoomDatabase({ dataDir } = {}) {
  if (typeof dataDir !== 'string' || dataDir.trim().length === 0) {
    fail('data_directory_invalid', 'dataDir must be a non-empty path')
  }

  const directory = ensurePrivateDirectory(dataDir)
  const databasePath = join(directory, DATABASE_FILENAME)
  if (existsSync(databasePath)) {
    const info = lstatSync(databasePath)
    if (info.isSymbolicLink() || !info.isFile()) {
      fail('database_file_invalid', 'agent-room database must be a regular non-symlink file')
    }
  }

  let database
  try {
    database = new DatabaseSync(databasePath)
    chmodSync(databasePath, 0o600)
    const { sqliteVersion, journalMode, pragmas } = configureConnection(database)
    ensureSchema(database)

    const upsertActor = (actorId, displayName, timestamp) => {
      database.prepare(`
        INSERT INTO actors (id, display_name, created_at, updated_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT (id) DO UPDATE SET
          display_name = excluded.display_name,
          updated_at = excluded.updated_at
      `).run(actorId, displayName, timestamp, timestamp)
    }

    const assertRoomExists = roomId => {
      const row = database.prepare('SELECT 1 AS found FROM rooms WHERE id = ?').get(roomId)
      if (!row) fail('room_not_found', `room ${roomId} does not exist`)
    }

    const assertMember = (roomId, actorId) => {
      assertRoomExists(roomId)
      const row = database.prepare(`
        SELECT 1 AS found
        FROM room_members
        WHERE room_id = ? AND actor_id = ?
      `).get(roomId, actorId)
      if (!row) fail('actor_not_member', `actor ${actorId} is not a member of room ${roomId}`)
    }

    const selectMessage = (roomId, seq) => {
      const row = database.prepare(`${MESSAGE_PROJECTION} WHERE room_id = ? AND seq = ?`)
        .get(roomId, seq)
      return row ? plainMessage(row) : null
    }

    const readRoomPage = (roomId, afterSeq, limit) => {
      const rows = database.prepare(`
        ${MESSAGE_PROJECTION}
        WHERE room_id = ? AND seq > ?
        ORDER BY seq ASC
        LIMIT ?
      `).all(roomId, afterSeq, limit)
      return rows.map(plainMessage)
    }

    let closed = false
    const api = {
      databasePath,
      sqliteVersion,
      journalMode,
      pragmas,

      close() {
        if (closed) return
        database.close()
        closed = true
      },

      createRoom(options) {
        const { actorId, displayName, title } = requireObject(options)
        const validActorId = requireIdentifier(actorId, 'actorId', 'invalid_actor_id')
        const validDisplayName = requireDisplayText(
          displayName,
          'displayName',
          DATABASE_LIMITS.displayName,
          'invalid_display_name',
        )
        const validTitle = requireDisplayText(
          title,
          'title',
          DATABASE_LIMITS.title,
          'invalid_title',
        )
        const id = randomUUID()
        const createdAt = new Date().toISOString()

        return withImmediateTransaction(database, () => {
          upsertActor(validActorId, validDisplayName, createdAt)
          database.prepare(`
            INSERT INTO rooms (id, title, created_by_actor_id, created_at)
            VALUES (?, ?, ?, ?)
          `).run(id, validTitle, validActorId, createdAt)
          database.prepare(`
            INSERT INTO room_members (room_id, actor_id, joined_at)
            VALUES (?, ?, ?)
          `).run(id, validActorId, createdAt)
          return { id, title: validTitle, created_at: createdAt }
        })
      },

      joinRoom(options) {
        const { roomId, actorId, displayName } = requireObject(options)
        const validRoomId = requireIdentifier(roomId, 'roomId', 'invalid_room_id')
        const validActorId = requireIdentifier(actorId, 'actorId', 'invalid_actor_id')
        const validDisplayName = requireDisplayText(
          displayName,
          'displayName',
          DATABASE_LIMITS.displayName,
          'invalid_display_name',
        )
        const timestamp = new Date().toISOString()

        return withImmediateTransaction(database, () => {
          assertRoomExists(validRoomId)
          upsertActor(validActorId, validDisplayName, timestamp)
          database.prepare(`
            INSERT INTO room_members (room_id, actor_id, joined_at)
            VALUES (?, ?, ?)
            ON CONFLICT (room_id, actor_id) DO NOTHING
          `).run(validRoomId, validActorId, timestamp)
          const membership = database.prepare(`
            SELECT joined_at AS joinedAt
            FROM room_members
            WHERE room_id = ? AND actor_id = ?
          `).get(validRoomId, validActorId)
          return {
            room_id: validRoomId,
            actor_id: validActorId,
            display_name: validDisplayName,
            joined_at: membership.joinedAt,
          }
        })
      },

      sendMessage(options) {
        const {
          roomId,
          actorId,
          clientMessageId,
          text,
          replyToSeq = null,
        } = requireObject(options)
        const validRoomId = requireIdentifier(roomId, 'roomId', 'invalid_room_id')
        const validActorId = requireIdentifier(actorId, 'actorId', 'invalid_actor_id')
        const validClientMessageId = requireIdentifier(
          clientMessageId,
          'clientMessageId',
          'invalid_client_message_id',
        )
        const validText = requireMessageText(text)
        const validReplyToSeq = requireReplyToSeq(replyToSeq)

        return withImmediateTransaction(database, () => {
          assertMember(validRoomId, validActorId)
          const existingRow = database.prepare(`
            ${MESSAGE_PROJECTION}
            WHERE room_id = ? AND actor_id = ? AND client_message_id = ?
          `).get(validRoomId, validActorId, validClientMessageId)
          if (existingRow) {
            const existing = plainMessage(existingRow)
            if (existing.text !== validText || existing.reply_to_seq !== validReplyToSeq) {
              fail(
                'client_message_id_conflict',
                'clientMessageId was already used with a different message payload',
              )
            }
            return { message: existing, duplicate: true }
          }

          if (validReplyToSeq !== null) {
            const reply = database.prepare('SELECT room_id AS roomId FROM messages WHERE seq = ?')
              .get(validReplyToSeq)
            if (!reply) {
              fail('message_not_found', 'replyToSeq does not identify an existing message')
            }
            if (reply.roomId !== validRoomId) {
              fail('reply_room_mismatch', 'replyToSeq identifies a message in another room')
            }
          }

          const actor = database.prepare(`
            SELECT display_name AS displayName
            FROM actors
            WHERE id = ?
          `).get(validActorId)
          const createdAt = new Date().toISOString()
          const result = database.prepare(`
            INSERT INTO messages (
              room_id,
              actor_id,
              actor_display_name,
              client_message_id,
              text,
              reply_to_seq,
              created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(
            validRoomId,
            validActorId,
            actor.displayName,
            validClientMessageId,
            validText,
            validReplyToSeq,
            createdAt,
          )
          return {
            message: selectMessage(validRoomId, Number(result.lastInsertRowid)),
            duplicate: false,
          }
        })
      },

      readMessages(options) {
        const {
          roomId,
          actorId,
          afterSeq = 0,
          limit = 100,
        } = requireObject(options)
        const validRoomId = requireIdentifier(roomId, 'roomId', 'invalid_room_id')
        const validActorId = requireIdentifier(actorId, 'actorId', 'invalid_actor_id')
        const validAfterSeq = requireAfterSeq(afterSeq)
        const validLimit = requireReadLimit(limit)
        assertMember(validRoomId, validActorId)
        return readRoomPage(validRoomId, validAfterSeq, validLimit)
      },

      listRooms() {
        return database.prepare(`
          SELECT id, title, created_at
          FROM rooms
          ORDER BY created_at ASC, id ASC
        `).all().map(plainRoom)
      },

      readRoomMessages(options) {
        const { roomId, afterSeq = 0, limit = 100 } = requireObject(options)
        const validRoomId = requireIdentifier(roomId, 'roomId', 'invalid_room_id')
        const validAfterSeq = requireAfterSeq(afterSeq)
        const validLimit = requireReadLimit(limit)
        assertRoomExists(validRoomId)
        return readRoomPage(validRoomId, validAfterSeq, validLimit)
      },
    }
    return Object.freeze(api)
  } catch (error) {
    try {
      database?.close()
    } catch {
      // Preserve the opening/configuration error.
    }
    throw error
  }
}
