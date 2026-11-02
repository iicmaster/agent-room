// Messaging application service: resolve a Chat-ID directory query through
// the Identity port, then open/reuse the pair room through the Messaging store
// port. It imports neither Identity internals nor API/wire error helpers.
// The HTTP adapter owns input grammar and maps these typed outcomes onto the
// frozen API error envelope.

export function resolveDirectRoom({ chatId, targetFingerprint, callerFingerprint, listClaimsForChatId, openDirectRoom }) {
  const claims = listClaimsForChatId(chatId)
  const mostRecentPerActor = new Map()
  for (const claim of claims) {
    if (!mostRecentPerActor.has(claim.actor_fingerprint)) mostRecentPerActor.set(claim.actor_fingerprint, claim)
  }
  let candidates = [...mostRecentPerActor.values()]
  if (targetFingerprint !== undefined && targetFingerprint !== null) {
    candidates = candidates.filter(claim => claim.actor_fingerprint === targetFingerprint)
  }
  if (candidates.length === 0) {
    return {
      ok: false,
      code: 'chat_id_not_found',
      requestedFingerprint: targetFingerprint ?? null,
      chatId,
    }
  }
  if (candidates.length > 1) {
    return {
      ok: false,
      code: 'ambiguous_chat_id',
      chatId,
      candidates: candidates.map(claim => ({ fingerprint: claim.actor_fingerprint, last_seen: claim.last_seen_at })),
    }
  }
  const targetFingerprintResolved = candidates[0].actor_fingerprint
  const room = openDirectRoom({
    actorFingerprints: targetFingerprintResolved === callerFingerprint
      ? [callerFingerprint, callerFingerprint]
      : [callerFingerprint, targetFingerprintResolved],
  })
  return { ok: true, room_id: room.id, kind: room.kind }
}
