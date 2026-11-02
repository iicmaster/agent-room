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
  return Object.freeze({
    upsertChatIdClaim(options) {
      assertOpen()
      const { chatId, actorFingerprint, lastSeenAt } = requireObject(options)
      const validChatId = requireChatId(chatId)
      const validFingerprint = requireFingerprint(actorFingerprint)
      const lastSeen = requireClaimTimestamp(lastSeenAt)
      const normalized = validChatId.toLowerCase()
      return withImmediateTransaction(database, () => {
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
      })
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

    recentClaims(windowMs, now = Date.now) {
      assertOpen()
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
      return withImmediateTransaction(database, () => Number(
        database.prepare('DELETE FROM chat_id_claims WHERE last_seen_at < ?').run(cutoff).changes,
      ))
    },

    // Enrollment is Identity ownership; invite consumption is composed by the
    // invite repository in the same DB transaction at the outer store root.
    enrollActor(options) {
      assertOpen()
      const { actorFingerprint, enrolledAt } = requireObject(options)
      const validFingerprint = requireFingerprint(actorFingerprint)
      const enrolled = requireClaimTimestamp(enrolledAt)
      return withImmediateTransaction(database, () => {
        database.prepare(`
          INSERT INTO enrolled_actors (actor_fingerprint, enrolled_at)
          VALUES (?, ?)
          ON CONFLICT (actor_fingerprint) DO NOTHING
        `).run(validFingerprint, enrolled)
        const row = database.prepare(`
          SELECT actor_fingerprint, enrolled_at
          FROM enrolled_actors
          WHERE actor_fingerprint = ?
        `).get(validFingerprint)
        return { actor_fingerprint: row.actor_fingerprint, enrolled_at: row.enrolled_at }
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
