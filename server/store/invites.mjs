// Invites: the durable invite registry and the atomic invite-gated
// enrollment transaction (Story 4.2, FR-14).
//
// A token is `ar_inv1_` plus exactly INVITE_TOKEN_CHARS base64url characters
// — the canonical unpadded encoding of INVITE_TOKEN_BYTES (32) random bytes
// (shapes declared once in ../constants.mjs). ONLY the SHA-256 digest of
// those 32 bytes is ever persisted: mintInvite generates the bytes, stores
// the digest, and returns the raw token to the caller exactly once — no
// write path in this module ever accepts or stores token material, so no
// listing, error, or diagnostic can leak a secret that is not on disk.
//
// Enrollment is ONE BEGIN IMMEDIATE transaction (the room-log store's single
// writer discipline, AD-2), run through the transaction runner room-log
// passes in, so consumption and enrollment commit or roll back together:
//
//   1. validate the presented token's shape (never a crash on junk);
//   2. look the invite up by digest — unknown, revoked, or expired invites
//      refuse with invite_invalid, consuming nothing;
//   3. verify the possession proof FIRST: the presented raw 32-byte public
//      key must have Ed25519-signed the exact presented token bytes — the
//      invite secret is itself the challenge, so the proof is bound to this
//      invite presentation and a captured signature enrolls nothing else;
//   4. reattach: the (invite, fingerprint) pair already in
//      invite_consumptions means this key enrolled through THIS invite
//      before — the lost-response retry returns success without consuming
//      (idempotent by the primary key);
//   5. consume: uses_remaining > 0 or invite_exhausted (the race loser's
//      coded answer — the single-writer transaction serializes the
//      contenders, so exactly one first presenter commits); record the
//      consumption row, decrement uses, and insert the durable
//      enrolled_actors record. A failure anywhere rolls the whole thing
//      back: a failed or rolled-back attempt consumes nothing.
//
// Expiry and revocation block new enrollment only — they never un-enroll a
// key (FR-14); the durable consumption rows survive so the reattach window
// is exactly the invite's own lifetime. Revocation is an operator action
// through this module's revokeInvite (the CLI host, AD-13); it is matched
// by digest PREFIX and refuses an ambiguous prefix with the candidates
// rather than guessing.

import { createHash, randomBytes } from 'node:crypto'

import {
  INVITE_DIGEST_PREFIX_CHARS,
  INVITE_TOKEN_BYTES,
  INVITE_TOKEN_CHARS,
  INVITE_TOKEN_PATTERN,
  INVITE_TOKEN_PREFIX,
} from '../constants.mjs'
import { AgentRoomRuntimeError } from '../runtime.mjs'
import { fingerprintFromPublicKey, verifyWithRawPublicKey } from '../keys.mjs'

function fail(code, message) {
  throw new AgentRoomRuntimeError(code, message)
}

// The invites registry: one row per minted invite. The digest is the hex
// SHA-256 over the token's 32 random bytes — a one-way derivative, safe to
// list and prefix-match. uses_max is the minted budget and uses_remaining
// never exceeds it (the CHECK pins both directions). revoked_at is NULL
// until the operator revokes; expiry is the canonical ISO 8601 timestamp
// every other durable timestamp in this store uses.
export function invitesTableDdl({ ifNotExists = false } = {}) {
  return `
    CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}invites (
      digest TEXT PRIMARY KEY,
      uses_remaining INTEGER NOT NULL,
      uses_max INTEGER NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL,
      revoked_at TEXT,
      CHECK (length(digest) = 64 AND digest NOT GLOB '*[^0-9a-f]*'),
      CHECK (uses_max >= 1),
      CHECK (uses_remaining BETWEEN 0 AND uses_max)
    ) STRICT;
  `
}

// One row per (invite, enrolled fingerprint): the record that makes the
// lost-response retry idempotent (reattach without consuming) and survives
// expiry and revocation. The FK pins every consumption to a live invite row;
// invites are never deleted, so RESTRICT never fires.
export function inviteConsumptionsTableDdl({ ifNotExists = false } = {}) {
  return `
    CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}invite_consumptions (
      digest TEXT NOT NULL REFERENCES invites(digest) ON DELETE RESTRICT,
      actor_fingerprint TEXT NOT NULL,
      consumed_at TEXT NOT NULL,
      PRIMARY KEY (digest, actor_fingerprint)
    ) STRICT;
  `
}

// Column sets verified on every store open (the enrolled_actors pattern):
// CREATE TABLE IF NOT EXISTS silently keeps a drifted table, so the open
// path refuses a foreign shape as a coded schema failure instead.
export const INVITES_COLUMNS = Object.freeze([
  'digest',
  'uses_remaining',
  'uses_max',
  'expires_at',
  'created_at',
  'revoked_at',
])

export const INVITE_CONSUMPTIONS_COLUMNS = Object.freeze([
  'digest',
  'actor_fingerprint',
  'consumed_at',
])

function plainInvite(row) {
  return {
    digest: row.digest,
    uses_remaining: Number(row.uses_remaining),
    uses_max: Number(row.uses_max),
    expires_at: row.expires_at,
    created_at: row.created_at,
    revoked_at: row.revoked_at === null ? null : String(row.revoked_at),
  }
}

// The digest of a presented token: decode the canonical base64url payload
// (the shape pattern has already gated the whole token) and hash the exact
// 32 random bytes the token encodes — the same derivation mint used, so a
// presented token and its mint-time record always agree.
function digestOfToken(token) {
  const payload = token.slice(INVITE_TOKEN_PREFIX.length)
  const bytes = Buffer.from(payload, 'base64url')
  if (bytes.length !== INVITE_TOKEN_BYTES) {
    fail('invite_invalid', 'invite token payload does not decode to the declared byte count')
  }
  return createHash('sha256').update(bytes).digest('hex')
}

function expireMs(expiresAt) {
  const parsed = Date.parse(expiresAt)
  return Number.isFinite(parsed) ? parsed : -1
}

// The invite operations over one open room-log database handle. The
// transaction runner is room-log's own withImmediateTransaction — one
// implementation of the BEGIN IMMEDIATE / COMMIT / ROLLBACK discipline for
// the whole store, and the property that makes consumption + enrollment
// all-or-nothing. `now` is injectable so tests can exercise expiry without
// waiting on the wall clock.
export function createInviteOperations({ database, withImmediateTransaction, now = Date.now }) {
  if (typeof withImmediateTransaction !== 'function') {
    fail('invalid_argument', 'createInviteOperations requires the store transaction runner')
  }
  if (typeof now !== 'function') {
    fail('invalid_argument', 'createInviteOperations now must be a function')
  }

  const selectInvite = digest => database
    .prepare(`
      SELECT digest, uses_remaining, uses_max, expires_at, created_at, revoked_at
      FROM invites
      WHERE digest = ?
    `)
    .get(digest)

  return {
    // Mint one invite: generate the token, persist the digest only, return
    // the raw token ONCE alongside the stored record. Both budget arguments
    // are REQUIRED finite values — the store has no implicit default, so an
    // unlimited or never-expiring invite has no representation here and the
    // unlimited modes are rejected outright, not approximated. The CLI
    // family derives the ratified defaults (INVITE_MAX_USES, INVITE_TTL_
    // SECONDS) from the constants module before calling.
    mintInvite(options) {
      const { uses, ttlSeconds } = options ?? {}
      if (!Number.isSafeInteger(uses) || uses < 1) {
        fail('invalid_argument', 'invite uses must be a finite whole number, 1 or more — unlimited modes are rejected')
      }
      if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0
        || !Number.isSafeInteger(ttlSeconds * 1000)) {
        fail('invalid_argument', 'invite ttlSeconds must be a finite positive number — never-expiring modes are rejected')
      }
      const timestamp = now()
      const token = `${INVITE_TOKEN_PREFIX}${randomBytes(INVITE_TOKEN_BYTES).toString('base64url')}`
      const digest = digestOfToken(token)
      const created = new Date(timestamp).toISOString()
      const expires = new Date(timestamp + ttlSeconds * 1000).toISOString()
      return withImmediateTransaction(database, () => {
        // A 256-bit fresh digest colliding with a live row is not a real
        // possibility, but the insert is still guarded: a collision (or a
        // foreign row squattering the digest) surfaces as a coded refusal
        // instead of a silent second row behind the same prefix.
        const existing = selectInvite(digest)
        if (existing) {
          fail('invalid_argument', 'the minted invite digest collided with an existing row; mint again')
        }
        database.prepare(`
          INSERT INTO invites (digest, uses_remaining, uses_max, expires_at, created_at, revoked_at)
          VALUES (?, ?, ?, ?, ?, NULL)
        `).run(digest, uses, uses, expires, created)
        return {
          token,
          digest,
          uses_remaining: uses,
          uses_max: uses,
          expires_at: expires,
          created_at: created,
        }
      })
    },

    // Every invite, oldest first, full records — the projection to the
    // secret-free listing shape (digest prefix, uses remaining, expiry,
    // revoked) is the CLI's, and the full digest itself is a one-way
    // derivative, never the token.
    listInvites() {
      const rows = database.prepare(`
        SELECT digest, uses_remaining, uses_max, expires_at, created_at, revoked_at
        FROM invites
        ORDER BY created_at ASC, digest ASC
      `).all()
      return rows.map(plainInvite)
    },

    // Revoke by digest prefix: the prefix must be at least
    // INVITE_DIGEST_PREFIX_CHARS hex characters; zero matches refuse
    // invite_not_found, several refuse invalid_request naming the candidate
    // prefixes (never a guess), one revokes. Revoking an already-revoked
    // invite is an idempotent success — the operator's intent is already
    // the stored state.
    revokeInvite(options) {
      const { digestPrefix } = options ?? {}
      if (typeof digestPrefix !== 'string') {
        fail('invalid_request', 'digestPrefix is required: the hex prefix shown by invite list')
      }
      const prefix = digestPrefix.toLowerCase()
      if (!new RegExp(`^[0-9a-f]{${INVITE_DIGEST_PREFIX_CHARS},64}$`).test(prefix)) {
        fail(
          'invalid_request',
          `"${digestPrefix}" is not a digest prefix (at least ${INVITE_DIGEST_PREFIX_CHARS} hex characters, as shown by invite list)`,
        )
      }
      return withImmediateTransaction(database, () => {
        const matches = database.prepare(`
          SELECT digest, uses_remaining, uses_max, expires_at, created_at, revoked_at
          FROM invites
          WHERE digest GLOB ?
          ORDER BY created_at ASC, digest ASC
        `).all(`${prefix}*`)
        if (matches.length === 0) {
          fail('invite_not_found', `no invite matches the digest prefix "${digestPrefix}"`)
        }
        if (matches.length > 1) {
          const candidates = matches
            .map(row => row.digest.slice(0, INVITE_DIGEST_PREFIX_CHARS * 2))
            .join(', ')
          fail(
            'invalid_request',
            `the digest prefix "${digestPrefix}" matches ${matches.length} invites; name one with more characters — candidates: ${candidates}`,
          )
        }
        const row = matches[0]
        if (row.revoked_at === null) {
          database.prepare('UPDATE invites SET revoked_at = ? WHERE digest = ?')
            .run(new Date(now()).toISOString(), row.digest)
        }
        return plainInvite(selectInvite(row.digest))
      })
    },

    // The atomic invite-gated enrollment (see the module header for the
    // step order). The presented key IS the identity: the fingerprint is
    // derived from the raw bytes, never claimed. Returns
    // { reattached, fingerprint, digest } — reattached true means the
    // (invite, fingerprint) pair had already consumed a use, so this call
    // is the lost-response retry and wrote nothing.
    enrollRemoteActor(options) {
      const { inviteToken, rawPublicKey, signature } = options ?? {}
      if (typeof inviteToken !== 'string' || !INVITE_TOKEN_PATTERN.test(inviteToken)) {
        fail('invite_invalid', `invite token must be ${INVITE_TOKEN_PREFIX} followed by exactly ${INVITE_TOKEN_CHARS} base64url characters`)
      }
      if (!(rawPublicKey instanceof Uint8Array) || rawPublicKey.length !== 32) {
        fail('invalid_argument', 'enrollRemoteActor requires the raw 32-byte Ed25519 public key as a Buffer or Uint8Array')
      }
      if (!(signature instanceof Uint8Array) || signature.length !== 64) {
        fail('invalid_argument', 'enrollRemoteActor requires the 64-byte Ed25519 signature as a Buffer or Uint8Array')
      }
      const timestamp = now()
      const fingerprint = fingerprintFromPublicKey(rawPublicKey)
      const digest = digestOfToken(inviteToken)
      // The possession proof is bound to the exact presented token bytes —
      // the invite secret is the challenge, and the proof names both the
      // key (via the derived fingerprint) and this invite presentation.
      const tokenBytes = Buffer.from(inviteToken, 'utf8')

      return withImmediateTransaction(database, () => {
        const row = selectInvite(digest)
        if (!row) fail('invite_invalid', 'invite is unknown to this server')
        if (row.revoked_at !== null) fail('invite_invalid', 'invite was revoked by the operator')
        if (timestamp >= expireMs(row.expires_at)) fail('invite_invalid', 'invite has expired')
        if (!verifyWithRawPublicKey(rawPublicKey, tokenBytes, Buffer.from(signature))) {
          fail('signature_invalid', 'the invite possession proof failed: the signature does not verify under the presented key over the exact token bytes')
        }
        const reattached = database.prepare(`
          SELECT 1 AS found
          FROM invite_consumptions
          WHERE digest = ? AND actor_fingerprint = ?
        `).get(digest, fingerprint)
        if (reattached) {
          return { reattached: true, fingerprint, digest }
        }
        if (Number(row.uses_remaining) <= 0) {
          fail('invite_exhausted', 'invite has no uses remaining')
        }
        database.prepare(`
          INSERT INTO invite_consumptions (digest, actor_fingerprint, consumed_at)
          VALUES (?, ?, ?)
        `).run(digest, fingerprint, new Date(timestamp).toISOString())
        database.prepare(
          'UPDATE invites SET uses_remaining = uses_remaining - 1 WHERE digest = ?',
        ).run(digest)
        // The durable enrollment record the challenge-answer route gates on
        // (Story 4.1): the second writer Story 4.1's design reserved this
        // story for. INSERT DO NOTHING — a key already enrolled through the
        // local path or an earlier invite keeps its first registration.
        database.prepare(`
          INSERT INTO enrolled_actors (actor_fingerprint, enrolled_at)
          VALUES (?, ?)
          ON CONFLICT (actor_fingerprint) DO NOTHING
        `).run(fingerprint, new Date(timestamp).toISOString())
        return { reattached: false, fingerprint, digest }
      })
    },
  }
}
