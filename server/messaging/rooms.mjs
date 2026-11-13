// Messaging context room/read repository operations. The storage composition
// root injects its one DatabaseSync, transaction runner and validated helpers;
// this module owns room/membership/page operations only. It opens/closes no
// connection and performs no schema/migration work.

import { randomBytes } from 'node:crypto'
import { READ_PAGE_MAX, ROOM_ID_ENTROPY_BYTES } from '../constants.mjs'

const BROADCAST_KIND = 'broadcast'
const DIRECT_KIND = 'direct'

export function createMessagingRoomOperations({ database, withImmediateTransaction, validate, helpers }) {
  const { assertOpen, fail, requireObject, requireFingerprint, requireRoomId, requireAfterSeq, requireReadLimit, requireTitle } = validate
  const { selectRoom, requireRoom, requireDirectMembership, canonicalDirectPair, plainRoom, plainMessage, messageProjection } = helpers
  return Object.freeze({
    createBroadcastRoom(options) {
      assertOpen()
      const { actorFingerprint = null, title } = requireObject(options)
      const validFingerprint = actorFingerprint === null ? null : requireFingerprint(actorFingerprint)
      const validTitle = requireTitle(title, 'Broadcast Room')
      const id = randomBytes(ROOM_ID_ENTROPY_BYTES).toString('base64url')
      const createdAt = new Date().toISOString()
      return withImmediateTransaction(database, () => {
        database.prepare(`INSERT INTO rooms (id, kind, title, pair_key, created_by_fingerprint, created_at) VALUES (?, ?, ?, NULL, ?, ?)`).run(id, BROADCAST_KIND, validTitle, validFingerprint, createdAt)
        return { id, kind: BROADCAST_KIND, title: validTitle, pair_key: null, created_by_fingerprint: validFingerprint, created_at: createdAt }
      })
    },

    ensureBroadcastRoom(options = {}) {
      assertOpen()
      const { title } = requireObject(options)
      const validTitle = requireTitle(title, 'Broadcast Room')
      return withImmediateTransaction(database, () => {
        const existingRow = database.prepare(`SELECT id, kind, title, pair_key, created_by_fingerprint, created_at FROM rooms WHERE kind = 'broadcast' ORDER BY created_at ASC, id ASC LIMIT 1`).get()
        if (existingRow) return plainRoom(existingRow)
        const id = randomBytes(ROOM_ID_ENTROPY_BYTES).toString('base64url')
        const createdAt = new Date().toISOString()
        database.prepare(`INSERT INTO rooms (id, kind, title, pair_key, created_by_fingerprint, created_at) VALUES (?, ?, ?, NULL, NULL, ?)`).run(id, BROADCAST_KIND, validTitle, createdAt)
        return { id, kind: BROADCAST_KIND, title: validTitle, pair_key: null, created_by_fingerprint: null, created_at: createdAt }
      })
    },

    openDirectRoom(options) {
      assertOpen()
      const { actorFingerprints } = requireObject(options)
      if (!Array.isArray(actorFingerprints) || actorFingerprints.length !== 2) fail('invalid_actor_id', 'actorFingerprints must contain exactly two fingerprints')
      const [firstFingerprint, secondFingerprint] = actorFingerprints.map(requireFingerprint)
      const { min, max, pairKey } = canonicalDirectPair(firstFingerprint, secondFingerprint)
      const createdAt = new Date().toISOString()
      return withImmediateTransaction(database, () => {
        const existingRow = database.prepare('SELECT id, kind, title, pair_key, created_by_fingerprint, created_at FROM rooms WHERE pair_key = ?').get(pairKey)
        let room
        if (existingRow) room = plainRoom(existingRow)
        else {
          const id = randomBytes(ROOM_ID_ENTROPY_BYTES).toString('base64url')
          database.prepare(`INSERT INTO rooms (id, kind, title, pair_key, created_by_fingerprint, created_at) VALUES (?, ?, NULL, ?, ?, ?)`).run(id, DIRECT_KIND, pairKey, min, createdAt)
          room = { id, kind: DIRECT_KIND, title: null, pair_key: pairKey, created_by_fingerprint: min, created_at: createdAt }
        }
        for (const fingerprint of new Set([firstFingerprint, secondFingerprint])) {
          database.prepare(`INSERT INTO direct_members (room_id, actor_fingerprint, joined_at) VALUES (?, ?, ?) ON CONFLICT (room_id, actor_fingerprint) DO NOTHING`).run(room.id, fingerprint, createdAt)
        }
        return room
      })
    },

    listRoomsForActor(actorFingerprint) {
      assertOpen()
      const validFingerprint = requireFingerprint(actorFingerprint)
      // v0.9.0 (additive): session-pair rooms join the enumeration through
      // their principals' installation fingerprint — the reading installation
      // discovers rooms its own sessions belong to (so a peer's addressed
      // message is watchable without prior knowledge). Membership truth for
      // READING such a room stays per session id (session_pair_members); the
      // fingerprint here only WIDENS discovery, never the ACL.
      const rows = database.prepare(`SELECT id, kind, title, pair_key, created_by_fingerprint, created_at FROM rooms WHERE kind = 'broadcast' OR id IN (SELECT room_id FROM direct_members WHERE actor_fingerprint = ?) OR id IN (SELECT m.room_id FROM session_pair_members m JOIN session_principals p ON p.session_id = m.session_id WHERE p.installation_fingerprint = ?) ORDER BY created_at ASC, id ASC`).all(validFingerprint, validFingerprint)
      return rows.map(plainRoom)
    },

    getRoom(roomId, options = {}) {
      assertOpen()
      const validRoomId = requireRoomId(roomId)
      const { actorFingerprint = null } = requireObject(options)
      const row = selectRoom(validRoomId)
      if (!row) fail('room_not_found', `room ${validRoomId} does not exist`)
      if (row.kind === DIRECT_KIND) {
        if (actorFingerprint === null) fail('invalid_actor_id', 'actorFingerprint is required to inspect a direct room')
        requireDirectMembership(row, requireFingerprint(actorFingerprint))
      } else if (actorFingerprint !== null) requireFingerprint(actorFingerprint)
      return plainRoom(row)
    },

    readPage(options) {
      assertOpen()
      const { roomId, actorFingerprint, afterSeq = 0, limit = READ_PAGE_MAX } = requireObject(options)
      const validRoomId = requireRoomId(roomId)
      const validFingerprint = requireFingerprint(actorFingerprint)
      const validAfterSeq = requireAfterSeq(afterSeq)
      const validLimit = requireReadLimit(limit)
      const room = requireRoom(validRoomId)
      requireDirectMembership(room, validFingerprint)
      return database.prepare(`${messageProjection} WHERE room_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`).all(validRoomId, validAfterSeq, validLimit).map(plainMessage)
    },

    readBroadcastPage(options) {
      assertOpen()
      const { roomId, afterSeq = 0, limit = READ_PAGE_MAX } = requireObject(options)
      const validRoomId = requireRoomId(roomId)
      const validAfterSeq = requireAfterSeq(afterSeq)
      const validLimit = requireReadLimit(limit)
      const room = requireRoom(validRoomId)
      if (room.kind !== BROADCAST_KIND) fail('room_not_found', `room ${validRoomId} does not exist`)
      return database.prepare(`${messageProjection} WHERE room_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`).all(validRoomId, validAfterSeq, validLimit).map(plainMessage)
    },

    headSeq(roomId, options = {}) {
      assertOpen()
      const validRoomId = requireRoomId(roomId)
      const { actorFingerprint = null } = requireObject(options)
      const room = requireRoom(validRoomId)
      if (room.kind === DIRECT_KIND) {
        if (actorFingerprint === null) fail('invalid_actor_id', 'actorFingerprint is required to inspect a direct room')
        requireDirectMembership(room, requireFingerprint(actorFingerprint))
      } else if (actorFingerprint !== null) requireFingerprint(actorFingerprint)
      const head = database.prepare('SELECT COALESCE(MAX(seq), 0) AS head FROM messages WHERE room_id = ?').get(validRoomId)
      return Number(head.head)
    },
  })
}
