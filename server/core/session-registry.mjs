// Live-session registry (Story 1.5): the server-resident, ephemeral side of
// the chat id rules. One row per currently-connected session, keyed by the
// session token digest — the api layer derives that digest from the presented
// bearer token, so a raw token never enters this module — mapping to
// {chatId, chatIdNormalized, actorFingerprint, connectedSince, lastSeen}.
//
// DR-1 discipline lives here: the chat id grammar (1-CHAT_ID_MAX characters
// of [A-Za-z0-9_.-], validated by the shared chatIdForms gate from the
// constants module) and live-name uniqueness among connected sessions.
// Comparison is case-insensitive — the normalized form is the lowercase chat
// id, while the display form preserves the caller's case. A live collision is
// refused with the canonical coded error (chat_id_taken): never suffixed,
// never auto-mangled. Rename is immediate: the old name is claimable by the
// next session in the same instant, and nothing here ever rewrites history
// (messages keep their send-time chat ids in the store; this registry owns no
// message state).
//
// Atomicity: the registry is an in-memory Map pair and the server runs
// handlers on one thread, so claim's sequence — lease sweep, collision check,
// durable persist callback, memory commit — is atomic within the process; no
// await separates the check from the commit. The persist callback (the api
// layer's store write, which runs inside its own BEGIN IMMEDIATE transaction)
// fires only after the collision check passes and receives the claim payload
// with THIS registry's clock timestamp — one clock source for the live row
// and the durable row. A refusal — grammar or collision — changes no state
// anywhere; a persist failure leaves the memory side untouched.
//
// Lease: live rows are ephemeral with a lease equal to SESSION_TTL_MS. A dead
// session (crash, kill -9, an auth token that expired without a disconnect)
// would otherwise squat its Chat ID until process restart, so claim() lazily
// sweeps rows whose lastSeen is older than the lease and frees their names —
// the same lazy-sweep pattern the session registry uses on issue. The durable
// chat_id_claims rows are deliberately untouched by the sweep: the (name,
// actor) pair stays as ambiguity data.
//
// Ephemeral by design: a restart clears the registry and it rebuilds as
// sessions reconnect; clear() drops every live row (the server invokes it on
// close when it owns the process-default registry). The durable (chat_id,
// actor_fingerprint, last_seen_at) ambiguity data is the store's
// chat_id_claims index, which survives restart and is pruned at CLAIMS_TTL_MS.
// touch() is Story 1.6's heartbeat hook: wired with the same persist callback
// as claim, it refreshes a live session's lastSeen AND the durable claim
// row's last_seen_at in one operation (the server handle pre-wires that
// callback). Nothing in this story calls it on a request path: exposed,
// documented, pre-wired.

import { PUBLIC_ERRORS, SESSION_TTL_MS, chatIdForms, CHAT_ID_INVALID_MESSAGE } from '../constants.mjs'
import { AgentRoomRuntimeError } from '../runtime.mjs'

function fail(code, message) {
  throw new AgentRoomRuntimeError(code, message)
}

function requireSessionKey(value) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('invalid_argument', 'sessionKey must be a non-empty string')
  }
  return value
}

function requireActorFingerprint(value) {
  if (typeof value !== 'string' || value.length === 0) {
    fail('invalid_argument', 'actorFingerprint must be a non-empty string')
  }
  return value
}

// One clock for live and durable recency: every persist payload carries the
// ISO form of this registry's own now() so the store row and the memory row
// can never disagree about "when".
function requireTimestamp(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    fail('invalid_argument', 'now must resolve to a finite epoch-millisecond value')
  }
  return new Date(value).toISOString()
}

function requirePersist(persist) {
  if (persist !== undefined && typeof persist !== 'function') {
    fail('invalid_argument', 'persist must be a function when provided')
  }
  return persist
}

// `now` is injectable so tests can drive connectedSince/lastSeen and the
// lease sweep without the wall clock; `leaseMs` defaults to the auth session
// TTL — a live row is exactly as durable as the credential behind it.
export function createLiveSessionRegistry({ now = Date.now, leaseMs = SESSION_TTL_MS } = {}) {
  if (typeof now !== 'function') {
    throw new AgentRoomRuntimeError('invalid_argument', 'live session registry now must be a function')
  }
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new AgentRoomRuntimeError('invalid_argument', 'live session registry leaseMs must be a positive safe integer')
  }

  // sessionKey (token digest) → row, and chatIdNormalized → sessionKey. The
  // name index is maintained together with the session map inside the same
  // synchronous steps, so a lookup can never observe a half-applied claim.
  const sessions = new Map()
  const names = new Map()

  const snapshot = row => ({
    chatId: row.chatId,
    chatIdNormalized: row.chatIdNormalized,
    actorFingerprint: row.actorFingerprint,
    connectedSince: row.connectedSince,
    lastSeen: row.lastSeen,
  })

  // Lazy lease sweep (claim-time, same pattern as the session registry's
  // issue-time sweep): strictly older than the lease means dead. Memory only
  // — the durable claim row stays.
  function sweepExpired(timestamp) {
    for (const [key, row] of sessions) {
      if (timestamp - row.lastSeen > leaseMs) {
        sessions.delete(key)
        if (names.get(row.chatIdNormalized) === key) names.delete(row.chatIdNormalized)
      }
    }
  }

  // Bind a session to a chat id — the one atomic operation behind the connect
  // and rename verbs. Order of operations: validate, lease sweep, collision
  // check (a live holder other than this session refuses the claim; the first
  // holder is unaffected), then the durable persist callback, then the memory
  // commit. An idempotent re-bind of the held name refreshes lastSeen (and
  // the display case) while keeping connectedSince; a different name swaps
  // immediately, freeing the old one. The persist callback receives
  // { chatId, actorFingerprint, lastSeenAt } — the exact durable-write
  // payload, timestamped by this registry's clock.
  function claim({ sessionKey, chatId, actorFingerprint, persist } = {}) {
    const key = requireSessionKey(sessionKey)
    const forms = chatIdForms(chatId)
    if (forms === null) fail('invalid_chat_id', CHAT_ID_INVALID_MESSAGE)
    const fingerprint = requireActorFingerprint(actorFingerprint)
    const persistStep = requirePersist(persist)

    const timestamp = now()
    const lastSeenAt = requireTimestamp(timestamp)
    sweepExpired(timestamp)

    const holder = names.get(forms.normalized)
    if (holder !== undefined && holder !== key) {
      // Explicit refusal, no suffixing, no state change.
      fail('chat_id_taken', PUBLIC_ERRORS.chat_id_taken)
    }

    const current = sessions.get(key)
    if (current !== undefined && current.chatIdNormalized === forms.normalized) {
      if (persistStep !== undefined) {
        persistStep({ chatId: forms.display, actorFingerprint: fingerprint, lastSeenAt })
      }
      // Same normalized name, possibly re-claimed in a different case: the
      // latest claim's display form is the session's current name.
      current.chatId = forms.display
      current.lastSeen = timestamp
      return snapshot(current)
    }

    if (persistStep !== undefined) {
      persistStep({ chatId: forms.display, actorFingerprint: fingerprint, lastSeenAt })
    }
    if (current !== undefined) names.delete(current.chatIdNormalized)
    const row = {
      chatId: forms.display,
      chatIdNormalized: forms.normalized,
      actorFingerprint: fingerprint,
      connectedSince: current !== undefined ? current.connectedSince : timestamp,
      lastSeen: timestamp,
    }
    sessions.set(key, row)
    names.set(forms.normalized, key)
    return snapshot(row)
  }

  // rename exposes the same atomic bind under its own name (the Code Map's
  // operation set). On the wire, POST and PATCH both route through claim in
  // server.mjs and share these exact semantics: an exact re-bind is an
  // idempotent refresh, a different free name swaps immediately, a live
  // collision is refused with the original retained.
  function rename(options = {}) {
    return claim(options)
  }

  // Disconnect: remove the live row and free the name for the next claimer
  // immediately. The durable claim row is deliberately untouched — the
  // (name, actor) pair stays in the store as ambiguity data. Returns whether
  // a live row existed.
  function release(sessionKey) {
    const key = requireSessionKey(sessionKey)
    const current = sessions.get(key)
    if (current === undefined) return false
    sessions.delete(key)
    if (names.get(current.chatIdNormalized) === key) names.delete(current.chatIdNormalized)
    return true
  }

  // Story 1.6's heartbeat hook, pre-wired with claim's persist pattern: the
  // { persist } callback (the server handle passes the durable claim write)
  // refreshes the claim row's last_seen_at in the same operation and with the
  // same clock tick as the in-memory refresh. Returns the snapshot, or null
  // for an unknown key.
  function touch(sessionKey, { persist } = {}) {
    const key = requireSessionKey(sessionKey)
    const current = sessions.get(key)
    if (current === undefined) return null
    const persistStep = requirePersist(persist)
    const timestamp = now()
    const lastSeenAt = requireTimestamp(timestamp)
    if (persistStep !== undefined) {
      persistStep({ chatId: current.chatId, actorFingerprint: current.actorFingerprint, lastSeenAt })
    }
    current.lastSeen = timestamp
    return snapshot(current)
  }

  function lookup(sessionKey) {
    const key = requireSessionKey(sessionKey)
    const current = sessions.get(key)
    return current === undefined ? null : snapshot(current)
  }

  // Drop every live row: the server close path invokes this when it owns the
  // process-default registry, so a restart-within-process finds no stale
  // names. Durable claim rows are untouched — ephemeral side only.
  function clear() {
    sessions.clear()
    names.clear()
  }

  return Object.freeze({ claim, rename, release, touch, lookup, clear })
}
