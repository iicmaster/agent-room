// Bans: the durable operator ban registry (Story 4.5, the Epic 2 review's
// B1 boundary closed here — persistence is proven by THIS story's tests).
//
// One row per banned identity key. The row's key is the canonical Actor
// fingerprint (`sha256:` + 64 lowercase hex over the raw 32-byte public key,
// ../constants.mjs) — the identity the ban is ABOUT, never anything the
// banned client presented. There is deliberately NO foreign key into
// enrolled_actors: a ban may be PREEMPTIVE (an operator bans a fingerprint
// that has not enrolled yet — e.g. the key of an abusive actor whose plugin
// data was deleted, so the same key cannot quietly re-enroll), and a
// preemptive row must persist before any enrollment exists to reference.
//
// Writes are the operator CLI's (AR-13: the `agent-room ban`/`unban`
// commands open the store directly, in process, on the server host — no
// operator HTTP route exists). Reads are the server's per-request ban gate:
// the authz stage (and the long-poll loop) query this table on the server's
// own connection, so a ban committed by the separate CLI process is visible
// AT NEXT REQUEST through WAL — no cached ban state exists anywhere to go
// stale. Every write is its own BEGIN IMMEDIATE transaction (the room-log
// store's single-writer discipline, AD-2).
//
// Idempotence is the operator's intent made durable: banning an
// already-banned fingerprint keeps the FIRST ban's timestamp and reason
// (the INSERT ... DO NOTHING discipline enrollActor uses), and unbanning a
// fingerprint that holds no row is already the requested state — both are
// successes, never refusals. Unban deletes the row: nothing about a ban
// outlives it, so future requests flow again immediately.

import {
  FINGERPRINT_HEX_LENGTH,
  FINGERPRINT_PREFIX,
  FINGERPRINT_PATTERN,
} from '../constants.mjs'
import { AgentRoomRuntimeError } from '../runtime.mjs'

function fail(code, message) {
  throw new AgentRoomRuntimeError(code, message)
}

// The banned_actors registry: one row per banned identity key. banned_at is
// the canonical ISO 8601 timestamp every other durable timestamp in this
// store uses; reason is the operator's optional free-text note (NULL when
// omitted — never an empty string standing in for "no reason").
export function bannedActorsTableDdl({ ifNotExists = false } = {}) {
  return `
    CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}banned_actors (
      actor_fingerprint TEXT PRIMARY KEY,
      banned_at TEXT NOT NULL,
      reason TEXT,
      CHECK (length(actor_fingerprint) = ${FINGERPRINT_PREFIX.length + FINGERPRINT_HEX_LENGTH}
             AND substr(actor_fingerprint, 1, ${FINGERPRINT_PREFIX.length}) = '${FINGERPRINT_PREFIX}'
             AND substr(actor_fingerprint, ${FINGERPRINT_PREFIX.length + 1}) NOT GLOB '*[^0-9a-f]*')
    ) STRICT;
  `
}

// Column set verified on every store open (the enrolled_actors pattern):
// CREATE TABLE IF NOT EXISTS silently keeps a drifted table, so the open
// path refuses a foreign shape as a coded schema failure instead.
export const BANNED_ACTORS_COLUMNS = Object.freeze([
  'actor_fingerprint',
  'banned_at',
  'reason',
])

function requireFingerprint(value) {
  if (typeof value !== 'string' || !FINGERPRINT_PATTERN.test(value)) {
    fail('invalid_actor_id', 'actorFingerprint must be sha256: followed by 64 lowercase hex characters')
  }
  return value
}

function plainBan(row) {
  return {
    actor_fingerprint: row.actor_fingerprint,
    banned_at: row.banned_at,
    reason: row.reason === null ? null : String(row.reason),
  }
}

// The ban operations over one open room-log database handle. The transaction
// runner is room-log's own withImmediateTransaction — one implementation of
// the BEGIN IMMEDIATE / COMMIT / ROLLBACK discipline for the whole store.
// `now` is injectable so tests can pin ban timestamps without waiting on the
// wall clock.
export function createBanOperations({ database, withImmediateTransaction, now = Date.now }) {
  if (typeof withImmediateTransaction !== 'function') {
    fail('invalid_argument', 'createBanOperations requires the store transaction runner')
  }
  if (typeof now !== 'function') {
    fail('invalid_argument', 'createBanOperations now must be a function')
  }

  return {
    // Ban one identity key. Idempotent: a fingerprint already banned keeps
    // its FIRST banned_at and reason — the re-ban changes nothing, exactly
    // like a revoke of an already-revoked invite. A preemptive ban (no
    // enrolled_actors row, no claim, no message anywhere) is a first-class
    // success: the row simply precedes the key's first appearance.
    banActor(options) {
      const { actorFingerprint, reason, bannedAt } = options ?? {}
      const validFingerprint = requireFingerprint(actorFingerprint)
      let validReason = null
      if (reason !== undefined && reason !== null) {
        if (typeof reason !== 'string' || reason.trim().length === 0) {
          fail('invalid_request', 'reason must be a non-empty string when provided')
        }
        validReason = reason
      }
      // An injected timestamp must parse as a date (the store normalizes to
      // the canonical ISO 8601 form at write time); anything else is a coded
      // internal failure, never a silent substitution with the wall clock.
      let timestamp
      if (bannedAt === undefined || bannedAt === null) {
        timestamp = new Date(now()).toISOString()
      } else if (typeof bannedAt === 'string' && Number.isFinite(Date.parse(bannedAt))) {
        timestamp = new Date(Date.parse(bannedAt)).toISOString()
      } else {
        fail('invalid_argument', 'bannedAt must be an ISO 8601 timestamp string when provided')
      }
      return withImmediateTransaction(database, () => {
        database.prepare(`
          INSERT INTO banned_actors (actor_fingerprint, banned_at, reason)
          VALUES (?, ?, ?)
          ON CONFLICT (actor_fingerprint) DO NOTHING
        `).run(validFingerprint, timestamp, validReason)
        // Report the row as stored — with the FIRST ban's timestamp and
        // reason, never the attempted input on a re-ban.
        const row = database.prepare(`
          SELECT actor_fingerprint, banned_at, reason
          FROM banned_actors
          WHERE actor_fingerprint = ?
        `).get(validFingerprint)
        return plainBan(row)
      })
    },

    // Lift one ban by deleting its row. Idempotent: unbanning a fingerprint
    // that holds no row is already the requested state (removed false) —
    // the operator's intent is the stored state either way. Future requests
    // from the key flow again the moment the delete commits.
    unbanActor(options) {
      const { actorFingerprint } = options ?? {}
      const validFingerprint = requireFingerprint(actorFingerprint)
      return withImmediateTransaction(database, () => {
        const result = database
          .prepare('DELETE FROM banned_actors WHERE actor_fingerprint = ?')
          .run(validFingerprint)
        return { actor_fingerprint: validFingerprint, removed: Number(result.changes) > 0 }
      })
    },

    // Whether an identity key is banned. THE per-request ban gate's read:
    // a PRIMARY KEY lookup, run by the server's authz stage (and the
    // long-poll loop) on the server's own connection — a direct indexed
    // query per request, deliberately not a cached set, so a ban committed
    // by the separate CLI process is visible at next request (WAL readers
    // see every committed write; there is no ban state in memory to go
    // stale). A pure read: it writes nothing and never creates a row.
    isActorBanned(actorFingerprint) {
      const validFingerprint = requireFingerprint(actorFingerprint)
      const row = database.prepare(`
        SELECT 1 AS found
        FROM banned_actors
        WHERE actor_fingerprint = ?
      `).get(validFingerprint)
      return Boolean(row)
    },
  }
}
