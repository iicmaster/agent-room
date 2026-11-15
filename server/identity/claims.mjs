// Identity context: durable name directory and enrollment records.
//
// This module owns the SQL/query semantics for Identity tables while the
// storage composition root (`server/store/room-log.mjs`) remains sole owner
// of DB open/close, pragmas, schema bootstrap/migrations and validation
// functions. Operations receive only the already-open DatabaseSync and the
// existing BEGIN IMMEDIATE runner; they never create a connection or own a
// schema version.

export function createIdentityClaimOperations({ database, withImmediateTransaction, validate }) {
  const { assertOpen, fail, requireObject, requireChatId, requireFingerprint, requireClaimTimestamp } = validate

  function upsertChatIdClaimImpl(options) {
    const { chatId, actorFingerprint, lastSeenAt } = requireObject(options)
    const validChatId = requireChatId(chatId)
    const validFingerprint = requireFingerprint(actorFingerprint)
    const lastSeen = requireClaimTimestamp(lastSeenAt)
    const normalized = validChatId.toLowerCase()
    database.prepare(`
      INSERT INTO chat_id_claims (chat_id_normalized, actor_fingerprint, chat_id_display, last_seen_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT (chat_id_normalized, actor_fingerprint) DO UPDATE SET
        chat_id_display = excluded.chat_id_display,
        last_seen_at = CASE
          WHEN excluded.last_seen_at > chat_id_claims.last_seen_at
          THEN excluded.last_seen_at
          ELSE chat_id_claims.last_seen_at
        END
    `).run(normalized, validFingerprint, validChatId, lastSeen)
    const row = database.prepare(`
      SELECT chat_id_normalized, actor_fingerprint, chat_id_display, last_seen_at
      FROM chat_id_claims
      WHERE chat_id_normalized = ? AND actor_fingerprint = ?
    `).get(normalized, validFingerprint)
    return {
      chat_id: row.chat_id_display,
      chat_id_normalized: row.chat_id_normalized,
      actor_fingerprint: row.actor_fingerprint,
      last_seen_at: row.last_seen_at,
    }
  }

  return Object.freeze({
    upsertChatIdClaimInTx(options) {
      assertOpen()
      if (!database.isTransaction) {
        fail('invalid_argument', 'upsertChatIdClaimInTx requires an active transaction')
      }
      return upsertChatIdClaimImpl(options)
    },

    upsertChatIdClaim(options) {
      assertOpen()
      return withImmediateTransaction(database, () => upsertChatIdClaimImpl(options))
    },

    listClaimsForChatId(chatId) {
      assertOpen()
      const validChatId = requireChatId(chatId)
      const normalized = validChatId.toLowerCase()
      const rows = database.prepare(`
        SELECT chat_id_normalized, actor_fingerprint, chat_id_display, last_seen_at
        FROM chat_id_claims
        WHERE chat_id_normalized = ?
        ORDER BY last_seen_at DESC, actor_fingerprint ASC
      `).all(normalized)
      return rows.map(row => ({
        chat_id: row.chat_id_display,
        chat_id_normalized: row.chat_id_normalized,
        actor_fingerprint: row.actor_fingerprint,
        last_seen_at: row.last_seen_at,
      }))
    },

    // The unbound send's name resolution (v0.8.0, the codex round-3 decision):
    // one authenticated key may send WITHOUT holding a live session, and the
    // server — never the request body — decides which name it speaks as: the
    // key's most recent claim. Unique-latest wins; a newest-timestamp tie is
    // returned as `tie: true` (the route refuses it rather than picking
    // alphabetically); an absent claim returns null (the route refuses with
    // sender_claim_missing). Claims are a historical directory, so this reads
    // them without touching recency and never writes.
    latestClaimForActor(actorFingerprint) {
      assertOpen()
      const validFingerprint = requireFingerprint(actorFingerprint)
      const rows = database.prepare(`
        SELECT chat_id_normalized, actor_fingerprint, chat_id_display, last_seen_at
        FROM chat_id_claims
        WHERE actor_fingerprint = ?
        ORDER BY last_seen_at DESC, chat_id_normalized ASC
        LIMIT 2
      `).all(validFingerprint)
      if (rows.length === 0) return null
      return {
        claim: {
          chat_id: rows[0].chat_id_display,
          chat_id_normalized: rows[0].chat_id_normalized,
          actor_fingerprint: rows[0].actor_fingerprint,
          last_seen_at: rows[0].last_seen_at,
        },
        tie: rows.length > 1 && rows[1].last_seen_at === rows[0].last_seen_at,
      }
    },

    recentClaims(windowMs, now = Date.now) {      assertOpen()
      if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
        fail('invalid_argument', 'windowMs must be a positive safe integer')
      }
      const timestamp = typeof now === 'function' ? now() : now
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
        fail('invalid_argument', 'now must be an epoch-millisecond number or a function returning one')
      }
      const cutoffMs = timestamp - windowMs
      if (!Number.isFinite(cutoffMs)) fail('invalid_argument', 'the window cutoff must be a finite epoch-millisecond value')
      const cutoff = new Date(cutoffMs).toISOString()
      const upperBound = new Date(timestamp).toISOString()
      const rows = database.prepare(`
        SELECT chat_id_normalized, actor_fingerprint, chat_id_display, last_seen_at
        FROM chat_id_claims
        WHERE last_seen_at >= ? AND last_seen_at <= ?
        ORDER BY last_seen_at DESC, actor_fingerprint ASC, chat_id_normalized ASC
      `).all(cutoff, upperBound)
      return rows.map(row => ({
        chat_id: row.chat_id_display,
        chat_id_normalized: row.chat_id_normalized,
        actor_fingerprint: row.actor_fingerprint,
        last_seen_at: row.last_seen_at,
      }))
    },

    pruneChatIdClaimsInTx(olderThanMs, now = Date.now) {
      assertOpen()
      if (!database.isTransaction) {
        fail('invalid_argument', 'pruneChatIdClaimsInTx requires an active transaction')
      }
      if (!Number.isSafeInteger(olderThanMs) || olderThanMs <= 0) {
        fail('invalid_argument', 'olderThanMs must be a positive safe integer')
      }
      const timestamp = typeof now === 'function' ? now() : now
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
        fail('invalid_argument', 'now must be an epoch-millisecond number or a function returning one')
      }
      const cutoffMs = timestamp - olderThanMs
      if (!Number.isFinite(cutoffMs)) fail('invalid_argument', 'the prune cutoff must be a finite epoch-millisecond value')
      const cutoff = new Date(cutoffMs).toISOString()
      return Number(
        database.prepare('DELETE FROM chat_id_claims WHERE last_seen_at < ?').run(cutoff).changes,
      )
    },

    pruneChatIdClaims(olderThanMs, now = Date.now) {
      assertOpen()
      if (!Number.isSafeInteger(olderThanMs) || olderThanMs <= 0) {
        fail('invalid_argument', 'olderThanMs must be a positive safe integer')
      }
      const timestamp = typeof now === 'function' ? now() : now
      if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
        fail('invalid_argument', 'now must be an epoch-millisecond number or a function returning one')
      }
      const cutoffMs = timestamp - olderThanMs
      if (!Number.isFinite(cutoffMs)) fail('invalid_argument', 'the prune cutoff must be a finite epoch-millisecond value')
      const cutoff = new Date(cutoffMs).toISOString()
      const hasStale = database.prepare('SELECT 1 FROM chat_id_claims WHERE last_seen_at < ? LIMIT 1').get(cutoff)
      if (!hasStale) return 0
      return withImmediateTransaction(database, () => Number(
        database.prepare('DELETE FROM chat_id_claims WHERE last_seen_at < ?').run(cutoff).changes,
      ))
    },

    // Enrollment is Identity ownership; invite consumption is composed by the
    // invite repository in the same DB transaction at the outer store root.
    enrollActorInTx(options) {
      assertOpen()
      if (!database.isTransaction) {
        fail('invalid_argument', 'enrollActorInTx requires an active transaction')
      }
      const { actorFingerprint, enrolledAt, enrolledVia = 'local' } = requireObject(options)
      const validFingerprint = requireFingerprint(actorFingerprint)
      const enrolled = requireClaimTimestamp(enrolledAt)
      if (enrolledVia !== 'local' && enrolledVia !== 'remote') {
        fail('invalid_argument', "enrolledVia must be 'local' or 'remote'")
      }
      database.prepare(`
        INSERT INTO enrolled_actors (actor_fingerprint, enrolled_at, enrolled_via)
        VALUES (?, ?, ?)
        ON CONFLICT (actor_fingerprint) DO NOTHING
      `).run(validFingerprint, enrolled, enrolledVia)
      const row = database.prepare(`
        SELECT actor_fingerprint, enrolled_at, enrolled_via
        FROM enrolled_actors
        WHERE actor_fingerprint = ?
      `).get(validFingerprint)
      return {
        actor_fingerprint: row.actor_fingerprint,
        enrolled_at: row.enrolled_at,
        enrolled_via: row.enrolled_via ?? 'local',
      }
    },

    enrollActor(options) {
      assertOpen()
      const { actorFingerprint, enrolledAt, enrolledVia = 'local' } = requireObject(options)
      const validFingerprint = requireFingerprint(actorFingerprint)
      const enrolled = requireClaimTimestamp(enrolledAt)
      if (enrolledVia !== 'local' && enrolledVia !== 'remote') {
        fail('invalid_argument', "enrolledVia must be 'local' or 'remote'")
      }
      const existing = database.prepare(`
        SELECT actor_fingerprint, enrolled_at, enrolled_via
        FROM enrolled_actors
        WHERE actor_fingerprint = ?
      `).get(validFingerprint)
      if (existing) {
        return {
          actor_fingerprint: existing.actor_fingerprint,
          enrolled_at: existing.enrolled_at,
          enrolled_via: existing.enrolled_via ?? 'local',
        }
      }
      return withImmediateTransaction(database, () => {
        database.prepare(`
          INSERT INTO enrolled_actors (actor_fingerprint, enrolled_at, enrolled_via)
          VALUES (?, ?, ?)
          ON CONFLICT (actor_fingerprint) DO NOTHING
        `).run(validFingerprint, enrolled, enrolledVia)
        const row = database.prepare(`
          SELECT actor_fingerprint, enrolled_at, enrolled_via
          FROM enrolled_actors
          WHERE actor_fingerprint = ?
        `).get(validFingerprint)
        return {
          actor_fingerprint: row.actor_fingerprint,
          enrolled_at: row.enrolled_at,
          enrolled_via: row.enrolled_via ?? 'local',
        }
      })
    },

    isActorEnrolled(actorFingerprint) {
      assertOpen()
      const validFingerprint = requireFingerprint(actorFingerprint)
      return Boolean(database.prepare(`
        SELECT 1 AS found FROM enrolled_actors WHERE actor_fingerprint = ?
      `).get(validFingerprint))
    },
  })
}
