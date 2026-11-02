// Messaging context message-log operations. Receives the shared SQLite
// connection/schema owner, validators, ACL helpers and storage gate from the
// composition root. No database open/close/migration ownership here.

import { DUPLICATE_WINDOW_MS } from '../constants.mjs'

export function createMessagingMessageOperations({ database, withImmediateTransaction, validate, helpers, storageGate, duplicateWindowMs, storageNowMs, resetStorageWarning, takeStorageWarning, storageWarn }) {
  const {
    assertOpen, fail, requireObject, requireRoomId, requireFingerprint,
    requireChatId, requireClientMessageId, requireMessageText,
    requireReplyToSeq, requireNowMs,
  } = validate
  const { requireRoom, requireDirectMembership, selectMessage, plainMessage, messageProjection } = helpers
  const validDuplicateWindowMs = duplicateWindowMs ?? DUPLICATE_WINDOW_MS

  return Object.freeze({
    findIdempotentSend(options) {
      assertOpen()
      const { roomId, actorFingerprint, clientMessageId } = requireObject(options)
      const validRoomId = requireRoomId(roomId)
      const validFingerprint = requireFingerprint(actorFingerprint)
      const validClientMessageId = requireClientMessageId(clientMessageId)
      const row = database.prepare(`${messageProjection} WHERE room_id = ? AND actor_fingerprint = ? AND client_message_id = ?`).get(validRoomId, validFingerprint, validClientMessageId)
      return row ? plainMessage(row) : null
    },

    appendMessage(options) {
      assertOpen()
      const { roomId, actorFingerprint, chatId, clientMessageId, text, replyToSeq = null, nowMs } = requireObject(options)
      const validRoomId = requireRoomId(roomId)
      const validFingerprint = requireFingerprint(actorFingerprint)
      const validChatId = requireChatId(chatId)
      const validClientMessageId = requireClientMessageId(clientMessageId)
      const validText = requireMessageText(text)
      const validReplyToSeq = requireReplyToSeq(replyToSeq)
      const gateNowMs = requireNowMs(nowMs ?? storageNowMs)

      try {
        resetStorageWarning()
        const outcome = withImmediateTransaction(database, () => {
          const room = requireRoom(validRoomId)
          requireDirectMembership(room, validFingerprint)
          const existingRow = database.prepare(`${messageProjection} WHERE room_id = ? AND actor_fingerprint = ? AND client_message_id = ?`).get(validRoomId, validFingerprint, validClientMessageId)
          if (existingRow) {
            const existing = plainMessage(existingRow)
            if (existing.text !== validText || existing.reply_to_seq !== validReplyToSeq) {
              fail('client_message_id_conflict', 'clientMessageId was already used with a different message payload')
            }
            return { message: existing, duplicate: true, duplicateDropped: false, original: null }
          }

          if (validReplyToSeq !== null) {
            const localTarget = database.prepare('SELECT 1 AS found FROM messages WHERE room_id = ? AND seq = ?').get(validRoomId, validReplyToSeq)
            if (!localTarget) {
              const foreignTarget = database.prepare('SELECT 1 AS found FROM messages WHERE seq = ? AND room_id <> ?').get(validReplyToSeq, validRoomId)
              if (foreignTarget) fail('reply_room_mismatch', 'replyToSeq identifies a message in another room')
              fail('message_not_found', 'replyToSeq does not identify an existing message')
            }
          }

          const duplicateCutoff = new Date(gateNowMs - validDuplicateWindowMs).toISOString()
          const duplicateRow = database.prepare(`${messageProjection} WHERE room_id = ? AND actor_fingerprint = ? AND text = ? AND reply_to_seq IS ? AND created_at >= ? ORDER BY seq DESC LIMIT 1`).get(validRoomId, validFingerprint, validText, validReplyToSeq, duplicateCutoff)
          if (duplicateRow) return { message: null, duplicate: false, duplicateDropped: true, original: plainMessage(duplicateRow) }

          storageGate.check(gateNowMs)
          const nextSeq = Number(database.prepare('SELECT COALESCE(MAX(seq), 0) + 1 AS next_seq FROM messages WHERE room_id = ?').get(validRoomId).next_seq)
          const createdAt = new Date(gateNowMs).toISOString()
          database.prepare(`INSERT INTO messages (room_id, seq, actor_fingerprint, chat_id, client_message_id, text, reply_to_seq, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(validRoomId, nextSeq, validFingerprint, validChatId, validClientMessageId, validText, validReplyToSeq, createdAt)
          return { message: selectMessage(validRoomId, nextSeq), duplicate: false, duplicateDropped: false, original: null }
        })
        const warnLine = takeStorageWarning()
        if (warnLine !== null) {
          try { storageWarn(warnLine) } catch { /* committed send remains committed */ }
        }
        return outcome
      } catch (error) {
        if (error?.errcode === 13) fail('storage_low', 'the disk holding the agent-room data directory is full; the message was not committed')
        throw error
      }
    },
  })
}
