// Messaging context (Story 2.2): the ALL-IN-ONE bare-ID direct send. This is
// the operation a WriteQueue SAVEPOINT executes. Its four steps — durable
// dedup check, peer resolve, pair-room open, append — share ONE savepoint, so
// a bad reply_to_seq or ENOSPC rolls back with NO orphan room or membership.
//
// It owns no connection, schema, or transaction: those come from the store
// (room-log.mjs). The peer is resolved by the identity module's
// findOccupiedByBaseInTx / listRetiredByBaseForCandidatesInTx with an EXPLICIT
// nowMs (never the retention-filtering default). Identity is ALWAYS the sender
// capability's session id passed by the route — never a request field.

import { AgentRoomRuntimeError } from '../runtime.mjs'
import { PEER_OFFLINE_CANDIDATES_MAX, PUBLIC_ERRORS } from '../constants.mjs'
import { bareIdPayloadDigest } from './bare-id-dedup.mjs'

function peerOfflineCandidates(rows) {
  // Project to the safe candidate shape: session_id, address, fingerprint,
  // last_heartbeat_at. The client filters these through its trust matrix
  // BEFORE any render; the server never renders them itself. The bounded SQL
  // LIMIT already over-fetched by one, so drop the sentinel here.
  return rows.slice(0, PEER_OFFLINE_CANDIDATES_MAX).map(row => ({
    session_id: row.session_id,
    address: row.address,
    fingerprint: row.installation_fingerprint,
    last_heartbeat_at: row.last_heartbeat_at,
  }))
}

// `deps`:
//   database          - store's open connection (only for reading peer rows
//                       via identityOperations; no SQL issued here directly)
//   dedup             - createBareIdDedupOperations()
//   identity          - { findOccupiedByBaseInTx, listRetiredByBaseForCandidatesInTx }
//   pairRooms         - { openSessionPairRoomInTx }
//   messages          - { appendSessionPairMessageInTx }
export function createBareIdSendOperations({ dedup, identity, pairRooms, messages }) {
  // Called inside an ACTIVE savepoint from enqueueWrite's execute(tx). `tx` is
  // the store facade; we pass the injected ops bound to that same connection.
  function sendInTx({
    senderSessionId,
    senderFingerprint,
    senderAddress,
    baseNameLower,
    clientMessageId,
    text,
    replyToSeq = null,
    nowMs,
  }) {
    const payloadDigest = bareIdPayloadDigest(text, replyToSeq)
    const lookup = dedup.lookupInTx({
      senderSessionId,
      baseNameLower,
      clientMessageId,
      payloadDigest,
      nowMs,
    })
    if (lookup.kind === 'conflict') {
      throw new AgentRoomRuntimeError('client_message_id_conflict', PUBLIC_ERRORS.client_message_id_conflict)
    }
    if (lookup.kind === 'duplicate') {
      // Same payload inside the TTL. Return BEFORE resolving the peer — a peer
      // that has since /resumed or whose name was taken is irrelevant to a
      // retry that must be a no-op. No pair room is opened, no row is written.
      return { kind: 'duplicate_dropped', originalSeq: lookup.seq, roomId: lookup.roomId }
    }

    const peer = identity.findOccupiedByBaseInTx(baseNameLower, nowMs)
    if (peer === null) {
      const retained = identity.listRetiredByBaseForCandidatesInTx(baseNameLower, nowMs)
      if (retained.length > 0) {
        return { kind: 'peer_offline', candidates: peerOfflineCandidates(retained) }
      }
      // CONSTANT quiet 404 — no names, no counts, no hints. This is the exact
      // same answer an unresolvable full address gives, so the two are
      // byte-identical and the p50 timing delta stays within budget: both paths
      // run the same bounded indexed lookups above before reaching here.
      throw new AgentRoomRuntimeError('peer_not_found', PUBLIC_ERRORS.peer_not_found)
    }
    if (peer.session_id === senderSessionId) {
      // Defense in depth: the route refuses self-target before queueing, but a
      // race that rotated the sender into the target slot must not open a
      // one-member "pair" room.
      throw new AgentRoomRuntimeError('invalid_request', 'to must name a different session than the sender')
    }

    const room = pairRooms.openSessionPairRoomInTx({
      sessionIds: [senderSessionId, peer.session_id],
      nowMs,
    })
    const { warnLine, ...outcome } = messages.appendSessionPairMessageInTx({
      roomId: room.id,
      sessionId: senderSessionId,
      installationFingerprint: senderFingerprint,
      chatId: senderAddress,
      clientMessageId,
      text,
      replyToSeq,
    })
    if (outcome.duplicateDropped) {
      // The per-room content gate (5 s) already dropped this as a content
      // duplicate. Persist the durable key too so a later retry past the 5 s
      // window still answers duplicate_dropped with the same original seq.
      const originalSeq = outcome.original.seq
      dedup.recordInTx({
        senderSessionId, baseNameLower, clientMessageId, payloadDigest,
        roomId: room.id, seq: originalSeq, nowMs,
      })
      return { kind: 'duplicate_dropped', originalSeq, roomId: room.id }
    }
    dedup.recordInTx({
      senderSessionId, baseNameLower, clientMessageId, payloadDigest,
      roomId: room.id, seq: outcome.message.seq, nowMs,
    })
    const peerPresence = peer.base_lease_status === 'occupied'
      && Date.parse(peer.base_lease_expires_at) > nowMs
      ? 'online'
      : 'offline'
    return {
      kind: 'committed',
      roomId: room.id,
      seq: outcome.message.seq,
      peer: { session_id: peer.session_id, address: peer.address, presence: peerPresence },
      ...(warnLine === undefined ? {} : { warnLine }),
    }
  }

  return Object.freeze({ sendInTx })
}
