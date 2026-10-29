// Conflict tickets (Story 7.2, retro action A6 — the observed incumbent).
// An operator's takeover intent must name the holder the operator actually
// SAW, not whoever holds the name at the moment the intent lands. A plain
// bind refused with 409 chat_id_taken against a LIVE holder of the SAME
// Actor mints one opaque ticket bound to {actorFingerprint, normalized
// chat id, incumbentSessionKey, observedGeneration}; the takeover then
// presents that ticket, and the server redeems it only against the exact
// occupancy pair it was minted for — a moved incumbent (anyone else took
// the name, the name went free, or even the SAME key re-claimed it after a
// release) is refused with the coded `conflict_stale` instead of being
// displaced.
//
// The design of record (both vendor lanes, 2026-10-29,
// docs/implementation/spec-7-2-the-observed-incumbent.md):
// - SERVER-SIDE IN-MEMORY only: a restart voids every outstanding ticket —
//   the CLI re-observes. No durable store, no schema, no resurrection.
// - The ticket is NOT a credential: it never authenticates anyone, carries
//   no bearer and no digest, and is bound to the authenticated Actor — a
//   ticket presented under a different Actor's session is refused WITHOUT
//   burning the rightful holder's ticket.
// - Single-use: burned synchronously on the first valid-scoped evaluation,
//   success or failure alike. A wrong-Actor or wrong-name presentation
//   never burns (a thief with no credential must not be able to destroy
//   the operator's prompt window).
// - Same-Actor confidentiality is structural: minting happens only on the
//   same-Actor live-collision path in bindSession — a foreign collision
//   never reaches this module, so it can leak nothing.
// - Bounded, with the fence's lesson applied: an UNEXPIRED ticket is never
//   evicted to make room. Re-observing the same (Actor, name) pair REPLACES
//   that pair's outstanding ticket (per-pair slotting — one operator, one
//   name, one live ticket); a full map refuses NEW issuance with the
//   existing rate_limited 429 (+ retry_after_ms naming the earliest
//   relevant expiry) rather than silently dropping anyone's observation.
// - TTL: fixed (non-sliding), judged with the monotonic execution-time
//   clock — `now < deadline` at the redemption check; receiving a request's
//   headers before the deadline reserves nothing after it.

import { randomBytes } from 'node:crypto'

import {
  CONFLICT_TICKET_MAX_OUTSTANDING,
  CONFLICT_TICKET_MAX_PER_ACTOR,
  CONFLICT_TICKET_TTL_MS,
  chatIdForms,
} from '../constants.mjs'
import { AgentRoomRuntimeError } from '../runtime.mjs'

// The opaque ticket id: 32 bytes of entropy, url-safe. It encodes nothing —
// not the incumbent's key, not a digest, not the Actor — it is only a
// reference into this server's in-memory map.
function newTicketId() {
  return randomBytes(32).toString('base64url')
}

export function createConflictTicketStore({
  now = Date.now,
  ttlMs = CONFLICT_TICKET_TTL_MS,
  maxOutstanding = CONFLICT_TICKET_MAX_OUTSTANDING,
  maxPerActor = CONFLICT_TICKET_MAX_PER_ACTOR,
  randomId = newTicketId,
} = {}) {
  if (typeof now !== 'function') {
    throw new AgentRoomRuntimeError('invalid_argument', 'conflict ticket store now must be a function')
  }
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new AgentRoomRuntimeError('invalid_argument', 'conflict ticket store ttlMs must be a positive safe integer')
  }
  if (!Number.isSafeInteger(maxOutstanding) || maxOutstanding <= 0) {
    throw new AgentRoomRuntimeError('invalid_argument', 'conflict ticket store maxOutstanding must be a positive safe integer')
  }
  if (!Number.isSafeInteger(maxPerActor) || maxPerActor <= 0) {
    throw new AgentRoomRuntimeError('invalid_argument', 'conflict ticket store maxPerActor must be a positive safe integer')
  }

  // ticketId → { actorFingerprint, chatIdNormalized, observerSessionKey,
  // incumbentSessionKey, observedGeneration, issuedAt, deadline }. The
  // per-(Actor, name, observing session) slot index keeps ONE outstanding
  // ticket per observing session per name (re-observation by the same
  // session replaces its own; two sessions of one Actor each keep their own
  // — the two-independent-observations proof depends on that).
  const tickets = new Map()
  const slots = new Map()

  function purgeExpired(timestamp) {
    for (const [id, record] of tickets) {
      if (timestamp >= record.deadline) {
        tickets.delete(id)
        const slotKey = `${record.actorFingerprint}\n${record.chatIdNormalized}\n${record.observerSessionKey}`
        if (slots.get(slotKey) === id) slots.delete(slotKey)
      }
    }
  }

  function countForActor(actorFingerprint) {
    let count = 0
    for (const record of tickets.values()) {
      if (record.actorFingerprint === actorFingerprint) count += 1
    }
    return count
  }

  function earliestDeadline(actorFingerprint) {
    let earliest = null
    for (const record of tickets.values()) {
      if (actorFingerprint !== undefined && record.actorFingerprint !== actorFingerprint) continue
      if (earliest === null || record.deadline < earliest) earliest = record.deadline
    }
    return earliest
  }

  // Mint one ticket for an observed same-Actor live collision. Replaces the
  // OBSERVING SESSION's outstanding unconsumed ticket for the same name
  // (per-slot replacement — a second session of the same Actor keeps its
  // own). Returns { ticket } — or { rateLimited: true, retryAfterMs } when
  // a bound is full, in which case NOTHING is minted and nothing existing
  // is evicted.
  function mint({ actorFingerprint, chatId, observerSessionKey, incumbentSessionKey, observedGeneration }) {
    if (typeof actorFingerprint !== 'string' || actorFingerprint.length === 0) {
      throw new AgentRoomRuntimeError('invalid_argument', 'conflict ticket mint requires the observing Actor fingerprint')
    }
    if (typeof observerSessionKey !== 'string' || observerSessionKey.length === 0) {
      throw new AgentRoomRuntimeError('invalid_argument', 'conflict ticket mint requires the observing session key')
    }
    const forms = chatIdForms(chatId)
    if (forms === null) {
      throw new AgentRoomRuntimeError('invalid_argument', 'conflict ticket mint requires a valid chat id')
    }
    if (typeof incumbentSessionKey !== 'string' || incumbentSessionKey.length === 0) {
      throw new AgentRoomRuntimeError('invalid_argument', 'conflict ticket mint requires the observed incumbent session key')
    }
    if (!Number.isSafeInteger(observedGeneration) || observedGeneration < 0) {
      throw new AgentRoomRuntimeError('invalid_argument', 'conflict ticket mint requires the observed occupancy generation')
    }
    const timestamp = now()
    purgeExpired(timestamp)
    const slotKey = `${actorFingerprint}\n${forms.normalized}\n${observerSessionKey}`
    const existingId = slots.get(slotKey)
    const existingCounted = existingId !== undefined && tickets.has(existingId) ? 1 : 0
    const outstandingAfterReplace = tickets.size - existingCounted + 1
    const actorCountAfterReplace = countForActor(actorFingerprint) - existingCounted + 1
    if (outstandingAfterReplace > maxOutstanding || actorCountAfterReplace > maxPerActor) {
      const earliest = earliestDeadline(actorFingerprint) ?? timestamp + ttlMs
      const retryAfterMs = Math.max(1, Math.ceil((earliest - timestamp)))
      return { rateLimited: true, retryAfterMs }
    }
    if (existingId !== undefined) {
      tickets.delete(existingId)
    }
    const id = randomId()
    tickets.set(id, {
      actorFingerprint,
      chatIdNormalized: forms.normalized,
      observerSessionKey,
      incumbentSessionKey,
      observedGeneration,
      issuedAt: timestamp,
      deadline: timestamp + ttlMs,
    })
    slots.set(slotKey, id)
    return { ticket: id }
  }

  // Redeem a ticket under the presenting Actor and target name. Returns the
  // burned record on a valid scoped redemption (the caller then compares the
  // occupancy pair), or null for every stale shape: unknown, expired,
  // already consumed, wrong Actor, or wrong name. A scope mismatch (wrong
  // Actor / wrong name) never burns the rightful ticket.
  function redeem({ ticket, actorFingerprint, chatId }) {
    if (typeof ticket !== 'string' || ticket.length === 0) return null
    const record = tickets.get(ticket)
    if (record === undefined) return null
    if (now() >= record.deadline) {
      tickets.delete(ticket)
      const slotKey = `${record.actorFingerprint}\n${record.chatIdNormalized}\n${record.observerSessionKey}`
      if (slots.get(slotKey) === ticket) slots.delete(slotKey)
      return null
    }
    const forms = chatIdForms(chatId)
    if (forms === null
      || record.actorFingerprint !== actorFingerprint
      || record.chatIdNormalized !== forms.normalized) {
      return null
    }
    tickets.delete(ticket)
    const slotKey = `${record.actorFingerprint}\n${record.chatIdNormalized}\n${record.observerSessionKey}`
    if (slots.get(slotKey) === ticket) slots.delete(slotKey)
    return {
      incumbentSessionKey: record.incumbentSessionKey,
      observedGeneration: record.observedGeneration,
    }
  }

  // Test/inspection surface: how many tickets are outstanding.
  function size() {
    return tickets.size
  }

  return Object.freeze({ mint, redeem, size })
}
