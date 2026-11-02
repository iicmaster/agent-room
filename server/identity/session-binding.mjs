// Identity application operation for Chat-ID bind/rename/takeover. The API
// adapter validates wire shape and maps typed outcomes to existing error
// envelopes. This operation is synchronous: no await between holder/ticket
// observation, durable claim write, memory transfer and supersession.

export function bindIdentitySession({
  principal,
  chatId,
  clientType,
  replaceExisting = false,
  conflictTicket,
  liveRegistry,
  sessionRegistry,
  conflictTickets,
  persistClaim,
}) {
  const { sessionKey, actorFingerprint } = principal
  const holder = typeof liveRegistry.holderOf === 'function' ? liveRegistry.holderOf(chatId) : null
  const heldByAnotherSession = holder !== null && holder.sessionKey !== sessionKey
  let incumbentSessionKey = null

  if (replaceExisting) {
    // Foreign collision precedes ticket handling: it reveals nothing and
    // cannot burn a ticket scoped to another Actor.
    if (heldByAnotherSession && holder.actorFingerprint !== actorFingerprint) {
      return { kind: 'refused', code: 'chat_id_taken' }
    }
    if (typeof liveRegistry.transfer !== 'function') return { kind: 'refused', code: 'chat_id_taken' }
    if (typeof conflictTicket !== 'string' || conflictTicket.length === 0) {
      return {
        kind: 'refused',
        code: 'invalid_request',
        message: 'conflict_ticket is required when replace_existing is true: attempt a plain bind first and confirm against the ticket its refusal carries',
      }
    }
    const observed = conflictTickets.redeem({ ticket: conflictTicket, actorFingerprint, chatId })
    if (observed === null) return { kind: 'refused', code: 'conflict_stale' }
    const currentHolder = typeof liveRegistry.holderOf === 'function' ? liveRegistry.holderOf(chatId) : null
    const currentGeneration = typeof liveRegistry.occupancyGeneration === 'function'
      ? liveRegistry.occupancyGeneration(chatId)
      : null
    if (currentHolder === null
      || currentHolder.sessionKey !== observed.incumbentSessionKey
      || currentGeneration === null
      || currentGeneration !== observed.observedGeneration) {
      return { kind: 'refused', code: 'conflict_stale' }
    }
    incumbentSessionKey = currentHolder.sessionKey
  } else if (heldByAnotherSession) {
    const sameActor = holder.actorFingerprint === actorFingerprint
    if (sameActor && typeof sessionRegistry?.isLive === 'function' && sessionRegistry.isLive(holder.sessionKey) === false) {
      // Re-authentication can reclaim only a dead same-Actor holder.
      liveRegistry.release(holder.sessionKey)
    } else if (sameActor
      && typeof sessionRegistry?.isLive === 'function'
      && sessionRegistry.isLive(holder.sessionKey) === true
      && typeof liveRegistry.occupancyGeneration === 'function'
      && liveRegistry.occupancyGeneration(chatId) !== null
      && typeof conflictTickets.mint === 'function') {
      const minted = conflictTickets.mint({
        actorFingerprint,
        chatId,
        observerSessionKey: sessionKey,
        incumbentSessionKey: holder.sessionKey,
        observedGeneration: liveRegistry.occupancyGeneration(chatId),
      })
      if (minted.rateLimited === true) return { kind: 'refused', code: 'rate_limited', extra: { retry_after_ms: minted.retryAfterMs } }
      return { kind: 'refused', code: 'chat_id_taken', extra: { conflict_ticket: minted.ticket } }
    }
  }

  // Registry claim/transfer own the transaction: persistClaim commits before
  // the in-memory occupancy transition. If persistence throws, the incumbent
  // remains authoritative and no supersession occurs.
  const state = incumbentSessionKey === null
    ? liveRegistry.claim({ sessionKey, chatId, actorFingerprint, clientType, persist: persistClaim })
    : liveRegistry.transfer({ sessionKey, chatId, actorFingerprint, clientType, persist: persistClaim, incumbentSessionKey })
  const displacedSessionKey = state.displacedSessionKey ?? null
  if (displacedSessionKey !== null && typeof sessionRegistry?.supersede === 'function') {
    sessionRegistry.supersede(displacedSessionKey)
  }
  return {
    kind: 'bound',
    chatId: state.chatId,
    connectedSince: state.connectedSince,
    lastSeen: state.lastSeen,
    displacedSessionKey,
  }
}
