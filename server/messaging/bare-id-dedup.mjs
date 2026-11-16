// Messaging context (Story 2.2): the DURABLE retry-dedup ledger for bare-ID
// direct sends. The per-room append gate in messages.mjs keys on
// (room_id, chat_id, client_message_id), which rotates when a peer /resumes —
// so a retry after a reconnect or a name takeover would post twice. This table
// keys on the STABLE tuple (sender_session_id, lower(base_name),
// client_message_id) inside CONFLICT_TICKET_TTL_MS, which survives both.
//
// One op (recordAndCheck) is called from inside the single WriteQueue
// SAVEPOINT that also resolves the peer, opens the pair room, and appends — so
// a bad reply_to_seq or a full disk rolls the dedup row back with everything
// else. This module owns only SQL; the store (room-log.mjs) owns the
// connection, schema convergence, and transaction runner.

import { createHash } from 'node:crypto'

import { CONFLICT_TICKET_TTL_MS } from '../constants.mjs'

export const BARE_ID_DEDUP_TABLE = 'bare_id_send_dedup'
export const BARE_ID_DEDUP_INDEX = 'idx_bare_id_send_dedup_lookup'

// STRICT table. payload_digest binds the retry to the exact (text,
// reply_to_seq) so a changed payload under the same key is a conflict, never a
// silent drop. created_at is retained for the TTL cut-off (an indexed range
// predicate) and never rendered to a caller.
export function bareIdSendDedupTableDdl({ ifNotExists = false } = {}) {
  return `
    CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${BARE_ID_DEDUP_TABLE} (
      sender_session_id TEXT NOT NULL,
      base_name_lower TEXT NOT NULL,
      client_message_id TEXT NOT NULL,
      payload_digest TEXT NOT NULL,
      room_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (sender_session_id, base_name_lower, client_message_id)
    ) STRICT;
  `
}

// The lookup index: the TTL sweep and the freshness probe both filter on
// (sender_session_id, base_name_lower, client_message_id, created_at), so the
// covering index keeps EXPLAIN QUERY PLAN off a full table scan.
export function bareIdSendDedupIndexDdl() {
  return `
    CREATE INDEX IF NOT EXISTS ${BARE_ID_DEDUP_INDEX}
      ON ${BARE_ID_DEDUP_TABLE} (sender_session_id, base_name_lower, client_message_id, created_at);
  `
}

export const BARE_ID_DEDUP_COLUMNS = Object.freeze([
  'sender_session_id', 'base_name_lower', 'client_message_id',
  'payload_digest', 'room_id', 'seq', 'created_at',
])

// The digest is over exactly the fields that make two sends "the same payload"
// at the wire level. It is not a secret (text is the message body); storing the
// digest rather than the text keeps the ledger bounded and never duplicates a
// message body into a second store location.
export function bareIdPayloadDigest(text, replyToSeq) {
  return createHash('sha256')
    .update(text, 'utf8')
    .update('\u0000')
    .update(replyToSeq === null || replyToSeq === undefined ? '' : String(replyToSeq))
    .digest('hex')
}

// Pure operation factory. `database` is the store's one open connection;
// `nowMsFn` is injectable for deterministic TTL tests. All calls run inside the
// caller's active SAVEPOINT (the store's enqueueWrite batch).
export function createBareIdDedupOperations({ database, nowMsFn = () => Date.now(), ttlMs = CONFLICT_TICKET_TTL_MS }) {
  function lookupInTx({ senderSessionId, baseNameLower, clientMessageId, payloadDigest, nowMs }) {
    const cutoff = new Date(nowMs - ttlMs).toISOString()
    const row = database.prepare(`
      SELECT payload_digest, room_id, seq, created_at
      FROM ${BARE_ID_DEDUP_TABLE}
      WHERE sender_session_id = ? AND base_name_lower = ? AND client_message_id = ?
        AND created_at >= ?
      ORDER BY created_at DESC
      LIMIT 1
    `).get(senderSessionId, baseNameLower, clientMessageId, cutoff)
    if (row === undefined) return { kind: 'fresh' }
    if (row.payload_digest !== payloadDigest) return { kind: 'conflict' }
    return { kind: 'duplicate', roomId: row.room_id, seq: Number(row.seq) }
  }

  function recordInTx({ senderSessionId, baseNameLower, clientMessageId, payloadDigest, roomId, seq, nowMs }) {
    const createdAt = new Date(nowMs).toISOString()
    database.prepare(`
      INSERT INTO ${BARE_ID_DEDUP_TABLE}
        (sender_session_id, base_name_lower, client_message_id, payload_digest, room_id, seq, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT (sender_session_id, base_name_lower, client_message_id)
      DO UPDATE SET
        payload_digest = excluded.payload_digest,
        room_id = excluded.room_id,
        seq = excluded.seq,
        created_at = excluded.created_at
    `).run(senderSessionId, baseNameLower, clientMessageId, payloadDigest, roomId, seq, createdAt)
  }

  return Object.freeze({
    // Check-then-record inside ONE savepoint. A same-payload hit within the TTL
    // returns {kind:'duplicate', originalSeq} (no row written); a different
    // payload returns {kind:'conflict'}; otherwise the caller appends and then
    // calls record() with the resulting room/seq. Split lookup/record (rather
    // than one combined op) so the dedup row is written ONLY after a successful
    // append — a failed append rolls the whole savepoint back regardless.
    lookupInTx,
    recordInTx,
  })
}
