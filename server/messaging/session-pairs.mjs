// Messaging context: session-pair rooms — the private pair room between two
// SESSION principals (v0.9.0), additive to the fingerprint-pair DMs the
// direct-room path has always built. The room rows live in the SAME rooms
// table (kind 'direct') under the distinct pair-key prefix `ssession:` with
// the canonical (sorted) session ids, so the durable message log — and its
// foreign keys, sequences, idempotency and retention — stay exactly one
// substrate (CAP-6: "new messages append to the same durable room log");
// membership, however, is per SESSION id in the dedicated session_pair_members
// table, never per fingerprint: a third session of either installation holds
// no membership row and can neither append nor read (CAP-6 / THIRD_SESSION_ACL).
//
// Composition-root pattern (rooms.mjs / messages.mjs): this module receives
// the one DatabaseSync, the transaction runner, validators and helpers from
// server/store/room-log.mjs; it opens no connection and owns no schema
// lifecycle beyond exporting its table DDL for the open-path convergence.
// The addressed append itself lives in messages.mjs beside the storage
// admission gate it shares.

const DIRECT_KIND = 'direct'

// Canonical session-pair identity: the two session ids sorted lexicographically,
// so (a, b) and (b, a) derive the same key and openSessionPairRoom is
// idempotent in either argument order. Session ids are server-minted UUIDs of
// fixed shape, so the sort is stable. The `ssession:` prefix keeps these keys
// disjoint from the fingerprint pair keys (`direct:`) forever.
export const SESSION_PAIR_KEY_PREFIX = 'ssession:'

export function canonicalSessionPair(firstSessionId, secondSessionId) {
  const [min, max] = [firstSessionId, secondSessionId].sort()
  return Object.freeze({ min, max, pairKey: `${SESSION_PAIR_KEY_PREFIX}${min}:${max}` })
}

export function sessionPairMembersTableDdl({ ifNotExists = false } = {}) {
  return `
    CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}session_pair_members (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
      session_id TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (room_id, session_id)
    ) STRICT;
  `
}

export const SESSION_PAIR_MEMBERS_COLUMNS = Object.freeze([
  'room_id',
  'session_id',
  'joined_at',
])

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function createSessionPairOperations({ database, withImmediateTransaction, validate, helpers }) {
  const {
    assertOpen, fail, requireObject, requireRoomId,
    requireAfterSeq, requireReadLimit, requireNowMs,
  } = validate
  const {
    requireRoom, plainRoom, plainMessage, messageProjection, roomIdentity,
  } = helpers

  const requireSessionId = value => {
    if (typeof value !== 'string' || !SESSION_ID_PATTERN.test(value)) {
      fail('invalid_request', 'sessionId must be a UUID string issued by the server')
    }
    return value
  }

  const requireSessionPairMembership = (room, sessionId) => {
    const member = database.prepare(
      'SELECT 1 AS found FROM session_pair_members WHERE room_id = ? AND session_id = ?',
    ).get(room.id, sessionId)
    if (!member) fail('actor_not_member', `session is not a member of room ${room.id}`)
  }

  return Object.freeze({
    // Open-or-reuse the pair room between two retained session principals and
    // idempotently ensure both membership rows, in one BEGIN IMMEDIATE. Both
    // principals are re-verified inside the transaction (a revoked or
    // retention-expired peer refuses with the constant peer_not_found — the
    // same quiet answer an unresolvable address gives), so a room between a
    // live and a dead principal is never created. The room carries a NULL
    // creator: like the Broadcast Room, its identity is the pair itself and
    // the schema's fingerprint CHECK admits no fabricated creator.
    openSessionPairRoom(options) {
      assertOpen()
      const { sessionIds, nowMs } = requireObject(options)
      if (!Array.isArray(sessionIds) || sessionIds.length !== 2) {
        fail('invalid_request', 'sessionIds must contain exactly two session ids')
      }
      const [firstSessionId, secondSessionId] = sessionIds.map(requireSessionId)
      const now = requireNowMs(nowMs)
      const createdAt = new Date(now).toISOString()
      const { min, max, pairKey } = canonicalSessionPair(firstSessionId, secondSessionId)
      return withImmediateTransaction(database, () => {
        for (const sessionId of new Set([min, max])) {
          const principal = database.prepare(`
            SELECT 1 AS found FROM session_principals
            WHERE session_id = ? AND principal_status = 'retained'
          `).get(sessionId)
          if (!principal) fail('peer_not_found', 'no session principal resolves to this address')
        }
        let room = database
          .prepare('SELECT id, kind, title, pair_key, created_by_fingerprint, created_at FROM rooms WHERE pair_key = ?')
          .get(pairKey)
        if (!room) {
          const id = roomIdentity()
          database
            .prepare('INSERT INTO rooms (id, kind, title, pair_key, created_by_fingerprint, created_at) VALUES (?, ?, NULL, ?, NULL, ?)')
            .run(id, DIRECT_KIND, pairKey, createdAt)
          room = database
            .prepare('SELECT id, kind, title, pair_key, created_by_fingerprint, created_at FROM rooms WHERE pair_key = ?')
            .get(pairKey)
        }
        for (const sessionId of new Set([min, max])) {
          database.prepare(`
            INSERT INTO session_pair_members (room_id, session_id, joined_at)
            VALUES (?, ?, ?)
            ON CONFLICT (room_id, session_id) DO NOTHING
          `).run(room.id, sessionId, createdAt)
        }
        return plainRoom(room)
      })
    },

    // The per-session membership read: the read route's session-pair branch
    // consults this. Read-only, boolean.
    sessionPairMembership(options) {
      assertOpen()
      const { roomId, sessionId } = requireObject(options)
      const validRoomId = requireRoomId(roomId)
      const validSessionId = requireSessionId(sessionId)
      return Boolean(database.prepare(
        'SELECT 1 AS found FROM session_pair_members WHERE room_id = ? AND session_id = ?',
      ).get(validRoomId, validSessionId))
    },

    // The room's routing shape (kind + pair_key) for the read route's ACL
    // branch selection: which membership table governs this room. No ACL of
    // its own — every path that acts on the answer applies its own membership
    // check, and a missing room answers null exactly like the store's other
    // lookups.
    roomRouting(options) {
      assertOpen()
      const { roomId } = requireObject(options)
      const validRoomId = requireRoomId(roomId)
      const row = database
        .prepare('SELECT kind, pair_key FROM rooms WHERE id = ?')
        .get(validRoomId)
      return row
        ? { kind: row.kind, pair_key: row.pair_key === null ? null : String(row.pair_key) }
        : null
    },

    // Cursor page over a session-pair room: the exact page semantics of
    // readPage (strictly-greater afterSeq, seq ASC, bounded limit), with
    // membership from session_pair_members.
    readSessionPairPage(options) {
      assertOpen()
      const { roomId, sessionId, afterSeq = 0, limit } = requireObject(options)
      const validRoomId = requireRoomId(roomId)
      const validSessionId = requireSessionId(sessionId)
      const validAfterSeq = requireAfterSeq(afterSeq)
      const validLimit = requireReadLimit(limit)
      const room = requireRoom(validRoomId)
      requireSessionPairMembership(room, validSessionId)
      return database
        .prepare(`${messageProjection} WHERE room_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?`)
        .all(validRoomId, validAfterSeq, validLimit)
        .map(plainMessage)
    },

    // Head sequence with the session-pair membership ACL. The route orders
    // the page read first, so the coded room-not-found / not-member outcomes
    // come from the page read (rooms.mjs headSeq's discipline).
    sessionPairHeadSeq(options) {
      assertOpen()
      const { roomId, sessionId } = requireObject(options)
      const validRoomId = requireRoomId(roomId)
      const validSessionId = requireSessionId(sessionId)
      const room = requireRoom(validRoomId)
      requireSessionPairMembership(room, validSessionId)
      const head = database
        .prepare('SELECT COALESCE(MAX(seq), 0) AS head FROM messages WHERE room_id = ?')
        .get(validRoomId)
      return Number(head.head)
    },
  })
}
