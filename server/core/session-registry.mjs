// Live-session registry (Stories 1.5-1.6): the server-resident, ephemeral
// side of the chat id rules. One row per currently-connected session, keyed
// by the session token digest — the api layer derives that digest from the
// presented bearer token, so a raw token never enters this module — mapping
// to {chatId, chatIdNormalized, actorFingerprint, clientType, connectedSince,
// lastSeen}.
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
// Story 1.6: a bind may declare the session's client type from the closed
// CLIENT_TYPES set (the additive client_type request field). The type is
// never derived or guessed — an omitted declaration stays null on the
// presence row (v0.1's MCP-client-derived naming is retired). presenceSnapshot
// is the presence read model: one row per live Session within the presence
// TTL, plus — when the caller asks — the separately-labeled offline-recently
// group assembled from the durable claims index via the injected claimsReader.
//
// Atomicity: the registry is an in-memory Map pair and the server runs
// handlers on one thread, so claim's sequence — lease sweep, collision check,
// durable persist callback, memory commit — is atomic within the process; no
// await separates the check from the commit. The persist callback (the api
// layer's store write, which runs inside its own BEGIN IMMEDIATE transaction)
// fires only after the collision check passes and receives the claim payload
// with THIS registry's clock timestamp — one clock source for the live row
// and the durable row. A refusal — grammar, type, or collision — changes no
// state anywhere; a persist failure leaves the memory side untouched.
//
// Lease: live rows are ephemeral with a lease equal to SESSION_TTL_MS. A dead
// session (crash, kill -9, an auth token that expired without a disconnect)
// would otherwise squat its Chat ID until process restart, so claim() lazily
// sweeps rows whose lastSeen is older than the lease and frees their names —
// the same lazy-sweep pattern the session registry uses on issue. The durable
// chat_id_claims rows are deliberately untouched by the sweep: the (name,
// actor) pair stays as ambiguity data. This claim-time sweep is the ONLY
// name-freeing path, together with one EXPLICIT exception: transfer(), the
// operator-authorized same-Actor takeover that ends the squat without waiting
// a whole lease out (the reconnect-recovery handoff — see below). Presence
// liveness is a shorter window
// (presenceTtlMs, default PRESENCE_TTL_MS): presenceSnapshot FILTERS rows
// silent strictly longer than the TTL out of the online group at read time —
// a read never mutates this registry and never frees a name — and
// touch(), driven by the api layer on every authenticated request, refreshes
// lastSeen so an idle-but-alive session reappears online without re-binding.
// There is no server-side heartbeat timer: the server only judges liveness
// from the rows it holds.
//
// Ephemeral by design: a restart clears the registry and it rebuilds as
// sessions reconnect; clear() drops every live row (the server invokes it on
// close when it owns the process-default registry). The durable (chat_id,
// actor_fingerprint, last_seen_at) ambiguity data is the store's
// chat_id_claims index, which survives restart and is pruned at CLAIMS_TTL_MS.
// touch() is Story 1.6's liveness hook: wired with the same persist callback
// as claim, it refreshes a live session's lastSeen AND the durable claim
// row's last_seen_at in one operation (the server handle pre-wires that
// callback and drives it from the actor-class post-auth path — one liveness
// mechanism for the auth TTL slide and presence).

import {
  CLIENT_TYPES,
  FINGERPRINT_HEX_LENGTH,
  FINGERPRINT_PATTERN,
  FINGERPRINT_PREFIX,
  OFFLINE_RECENTLY_WINDOW_MS,
  PRESENCE_TTL_MS,
  PUBLIC_ERRORS,
  SESSION_TTL_MS,
  chatIdForms,
  CHAT_ID_INVALID_MESSAGE,
} from '../constants.mjs'
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

// The canonical Actor fingerprint shape is owned by the constants module (its
// prefix and hex length travel in as FINGERPRINT_PREFIX /
// FINGERPRINT_HEX_LENGTH; this file deliberately embeds no fingerprint-shaped
// literal of its own). This registry is the last layer before the value reaches
// the durable claims table, whose own CHECK enforces the same shape — so a
// malformed fingerprint must be refused HERE, as a clean coded rejection, not
// surface later as a store constraint failure.
function requireActorFingerprint(value) {
  if (typeof value !== 'string' || !FINGERPRINT_PATTERN.test(value)) {
    // The message is composed from the shared constants, not from a literal
    // here: server/core/ embeds no fingerprint-shaped string of its own.
    fail(
      'invalid_argument',
      `actorFingerprint must be ${FINGERPRINT_PREFIX} followed by ${FINGERPRINT_HEX_LENGTH} lowercase hex characters`,
    )
  }
  return value
}

// Story 1.6: the bind may declare the session's client type from the closed
// set in the constants module. An omitted declaration is valid and normalizes
// to null — the server never derives one; a present value must be a member.
function requireClientType(value) {
  if (value === undefined) return null
  if (typeof value !== 'string' || !CLIENT_TYPES.includes(value)) {
    fail('invalid_argument', `clientType must be one of: ${CLIENT_TYPES.join(', ')}`)
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
// `presenceTtlMs` (default PRESENCE_TTL_MS) is the online-visibility window
// the presenceSnapshot view applies — an operator-tunable surface
// (startServer({presenceTtlMs}) feeds the process-default registry); it never
// widens the claim lease, which stays leaseMs.
export function createLiveSessionRegistry({ now = Date.now, leaseMs = SESSION_TTL_MS, presenceTtlMs = PRESENCE_TTL_MS } = {}) {
  if (typeof now !== 'function') {
    throw new AgentRoomRuntimeError('invalid_argument', 'live session registry now must be a function')
  }
  if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0) {
    throw new AgentRoomRuntimeError('invalid_argument', 'live session registry leaseMs must be a positive safe integer')
  }
  if (!Number.isSafeInteger(presenceTtlMs) || presenceTtlMs <= 0) {
    throw new AgentRoomRuntimeError('invalid_argument', 'live session registry presenceTtlMs must be a positive safe integer')
  }

  // sessionKey (token digest) → row, and chatIdNormalized → sessionKey. The
  // name index is maintained together with the session map inside the same
  // synchronous steps, so a lookup can never observe a half-applied claim.
  const sessions = new Map()
  const names = new Map()

  // Story 7.2 (A6, the observed incumbent): the occupancy sequence. ONE
  // global monotonic counter stamps every EFFECTIVE occupancy transition —
  // a fresh claim, a takeover transfer, a release, a lease-sweep removal,
  // and a rename away from a name — so each occupancy of each name carries a
  // distinct, never-reused integer (the conflict ticket's
  // observedGeneration). Continuous tenure — an idempotent same-name
  // re-bind, a display-case refresh, a touch — advances nothing. The
  // sequence never resets inside a process lifetime, and clear() keeps the
  // stamped history: a restarted process voids every outstanding ticket
  // anyway, and within a lifetime a ticket pinned to an older generation of
  // a name is stale forever — which is exactly the guarantee.
  let occupancySequence = 0
  const generations = new Map()
  const stampGeneration = normalized => {
    occupancySequence += 1
    generations.set(normalized, occupancySequence)
  }

  // The name's CURRENT generation (0 before its first observed transition):
  // what a conflict ticket pins at mint time and what the takeover compares
  // at redemption — under the same live view the commit itself uses.
  function occupancyGeneration(chatId) {
    const forms = chatIdForms(chatId)
    if (forms === null) return null
    const generation = generations.get(forms.normalized)
    return generation === undefined ? 0 : generation
  }

  const snapshot = row => ({
    chatId: row.chatId,
    chatIdNormalized: row.chatIdNormalized,
    actorFingerprint: row.actorFingerprint,
    clientType: row.clientType,
    connectedSince: row.connectedSince,
    lastSeen: row.lastSeen,
  })

  // Lazy lease sweep (claim-time, same pattern as the session registry's
  // issue-time sweep): strictly older than the lease means dead. Memory only
  // — the durable claim row stays. This is the ONLY name-freeing path:
  // presence reads deliberately never sweep.
  function sweepExpired(timestamp) {
    for (const [key, row] of sessions) {
      if (timestamp - row.lastSeen > leaseMs) {
        sessions.delete(key)
        if (names.get(row.chatIdNormalized) === key) names.delete(row.chatIdNormalized)
        stampGeneration(row.chatIdNormalized)
      }
    }
  }

  // Bind a session to a chat id — the one atomic operation behind the connect
  // and rename verbs. Order of operations: validate, lease sweep, collision
  // check (a live holder other than this session refuses the claim; the first
  // holder is unaffected), then the durable persist callback, then the memory
  // commit. An idempotent re-bind of the held name refreshes lastSeen (and
  // the display case) while keeping connectedSince; a different name swaps
  // immediately, freeing the old one. The optional clientType (Story 1.6's
  // closed-set declaration) is validated against CLIENT_TYPES: a declared
  // value becomes the row's type on every accepted bind; an omitted one
  // carries the row's existing type over — on the same-name path and on the
  // different-name path alike, exactly like connectedSince (a rename is not
  // an undeclaration) — and a fresh row stays null (never derived). The
  // persist callback receives { chatId, actorFingerprint, lastSeenAt } — the
  // exact durable-write payload, timestamped by this registry's clock.
  //
  // The `replace` option is the ONE way a live holder loses its name: an
  // explicit, operator-authorized same-Actor takeover (the reconnect-recovery
  // handoff). It is never reachable by an ordinary bind, a rename, or an
  // automatic re-authentication — those never carry the intent. The caller
  // states WHICH session it displaces, and this registry re-checks the
  // statement against its own rows: the named session must still hold the
  // name AND it must belong to the SAME Actor as the claimant. A foreign
  // Actor's session is never displaced, whatever the caller claims.
  function commit({ sessionKey, chatId, actorFingerprint, clientType, persist, replace } = {}) {
    const key = requireSessionKey(sessionKey)
    const forms = chatIdForms(chatId)
    if (forms === null) fail('invalid_chat_id', CHAT_ID_INVALID_MESSAGE)
    const fingerprint = requireActorFingerprint(actorFingerprint)
    const type = requireClientType(clientType)
    const persistStep = requirePersist(persist)

    const timestamp = now()
    const lastSeenAt = requireTimestamp(timestamp)
    sweepExpired(timestamp)

    const holder = names.get(forms.normalized)
    let displacedSessionKey = null
    if (holder !== undefined && holder !== key) {
      const incumbent = sessions.get(holder)
      const authorized = replace !== undefined && replace !== null
        && typeof replace === 'object'
        && replace.sessionKey === holder
        && incumbent !== undefined
        && incumbent.actorFingerprint === fingerprint
      if (!authorized) {
        // Explicit refusal, no suffixing, no state change. A same-Actor
        // re-claim is a collision here TOO — the caller (the api layer) may
        // release a DEAD holder's row via release() and claim again; the
        // registry itself never decides a live session may lose its name.
        fail('chat_id_taken', PUBLIC_ERRORS.chat_id_taken)
      }
      displacedSessionKey = holder
    }

    const current = sessions.get(key)
    if (current !== undefined && current.chatIdNormalized === forms.normalized) {
      if (persistStep !== undefined) {
        persistStep({ chatId: forms.display, actorFingerprint: fingerprint, lastSeenAt })
      }
      // Same normalized name, possibly re-claimed in a different case: the
      // latest claim's display form is the session's current name.
      current.chatId = forms.display
      if (clientType !== undefined) current.clientType = type
      current.lastSeen = timestamp
      return { row: snapshot(current), displacedSessionKey: null }
    }

    // The durable write runs BEFORE the memory side: a failed write leaves
    // the incumbent's row and its name exactly where they were. The memory
    // commit that follows is synchronous and holds no await, so no observer
    // can see the name held by neither session or by both.
    if (persistStep !== undefined) {
      persistStep({ chatId: forms.display, actorFingerprint: fingerprint, lastSeenAt })
    }
    if (displacedSessionKey !== null) {
      // The displaced session loses its live row here, in the same
      // synchronous step that gives the name to the claimant. The durable
      // claim row is deliberately untouched — the (name, actor) pair stays as
      // ambiguity data, and it is this same Actor's row anyway.
      sessions.delete(displacedSessionKey)
    }
    if (current !== undefined) names.delete(current.chatIdNormalized)
    // The occupancy transition stamp (Story 7.2): this name's occupancy is
    // new — whether it changed hands (the takeover) or was freshly claimed
    // (the rename-swap's destination included) — and a renamed-away name's
    // occupancy just ended. Both are effective transitions; the observed
    // incumbent contract compares against exactly these stamps.
    stampGeneration(forms.normalized)
    if (current !== undefined && current.chatIdNormalized !== forms.normalized) {
      stampGeneration(current.chatIdNormalized)
    }
    const row = {
      chatId: forms.display,
      chatIdNormalized: forms.normalized,
      actorFingerprint: fingerprint,
      clientType: clientType !== undefined ? type : current !== undefined ? current.clientType : null,
      connectedSince: current !== undefined ? current.connectedSince : timestamp,
      lastSeen: timestamp,
    }
    sessions.set(key, row)
    names.set(forms.normalized, key)
    return { row: snapshot(row), displacedSessionKey }
  }

  function claim(options = {}) {
    return commit(options).row
  }

  // The explicit same-Actor takeover. The caller names the session it
  // displaces; this registry verifies the name against its own rows (the
  // named session must still hold the name and must belong to the caller's
  // Actor) and performs the transfer atomically: the durable claim write
  // first, then the memory commit that removes the incumbent's row and moves
  // the name. The result reports WHICH session was displaced, so the api
  // layer can fence it (the displaced session's authority ends with the
  // handoff, not with its next request).
  function transfer({ sessionKey, chatId, actorFingerprint, clientType, persist, incumbentSessionKey } = {}) {
    if (typeof incumbentSessionKey !== 'string' || incumbentSessionKey.length === 0) {
      fail('invalid_argument', 'incumbentSessionKey must be a non-empty string')
    }
    const { row, displacedSessionKey } = commit({
      sessionKey,
      chatId,
      actorFingerprint,
      clientType,
      persist,
      replace: { sessionKey: incumbentSessionKey },
    })
    return { ...row, displacedSessionKey }
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
  // The api layer needs to know WHO holds a name before it can decide that a
  // collision is against a dead session of the same Actor (the re-auth
  // recovery path). Read-only; it never mutates.
  function holderOf(chatId) {
    const forms = chatIdForms(chatId)
    if (forms === null) return null
    const key = names.get(forms.normalized)
    if (key === undefined) return null
    const row = sessions.get(key)
    if (row === undefined) return null
    return { sessionKey: key, actorFingerprint: row.actorFingerprint, chatId: row.chatId }
  }

  function release(sessionKey) {
    const key = requireSessionKey(sessionKey)
    const current = sessions.get(key)
    if (current === undefined) return false
    sessions.delete(key)
    if (names.get(current.chatIdNormalized) === key) names.delete(current.chatIdNormalized)
    // A release ends this name's occupancy: the next claim — even by the
    // SAME session key — is a new occupancy with a new generation, which is
    // what makes an A→free→A rebound refuse a ticket observed before the
    // release (Story 7.2's A→free→A rule).
    stampGeneration(current.chatIdNormalized)
    return true
  }

  // Story 1.6's liveness hook, pre-wired with claim's persist pattern: the
  // { persist } callback (the server handle passes the durable claim write)
  // refreshes the claim row's last_seen_at in the same operation and with the
  // same clock tick as the in-memory refresh. The api layer's actor-class
  // post-auth path drives it on every authenticated request. Returns the
  // snapshot, or null for an unknown key.
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

  // Story 1.6's presence read model: the one PURE assembly over the live rows
  // and (when asked) the durable claims index — no mutation of this registry,
  // no store writes. The handler consumes the wire's include_offline query
  // flag as this option set. Options:
  //   includeOffline    — boolean (default false): also assemble the
  //                       separately-labeled offline_recently group.
  //   now               — the read's clock: a finite epoch-ms number or a
  //                       function returning one; defaults to this registry's
  //                       own clock, so every presence timestamp comes from
  //                       the one injectable source.
  //   claimsReader      — function (windowMs, nowMs) → claim rows with
  //                       last_seen_at within the window (inclusive at the
  //                       boundary, never future-dated past now), most-
  //                       recent-first — the store's recentClaims shape.
  //                       Required when includeOffline is true; the registry
  //                       owns the window constant.
  //   readerFingerprint — the reading session's Actor fingerprint, excluded
  //                       from the offline group (reading your own stale
  //                       claim while unreachable is noise); optional.
  //
  // online: one row per live Session (wire-named: chat_id display form,
  // client_type, connected_since, last_seen, fingerprint), in connect order.
  // A row silent strictly longer than this registry's presenceTtlMs is
  // HIDDEN from the group — filtered out of the view only: the row itself
  // stays alive (its next authenticated touch re-lists it without a re-bind)
  // and the claim-time lease sweep remains the only name-freeing path.
  // offline_recently: one row per Actor — the most recent claim (the reader's
  // rows arrive most-recent-first, so the first row per fingerprint wins) —
  // with a claim last seen within OFFLINE_RECENTLY_WINDOW_MS, excluding
  // currently-online Actors (no double-listing across groups) and the
  // reader's own Actor. Offline rows cannot carry client_type: the claims
  // index holds none. Groups are always both present; the offline group is
  // empty unless includeOffline.
  function presenceSnapshot({ includeOffline = false, now: nowOverride, claimsReader, readerFingerprint } = {}) {
    if (typeof includeOffline !== 'boolean') {
      fail('invalid_argument', 'includeOffline must be a boolean')
    }
    if (readerFingerprint !== undefined
      && (typeof readerFingerprint !== 'string' || readerFingerprint.length === 0)) {
      fail('invalid_argument', 'readerFingerprint must be a non-empty string when provided')
    }
    if (includeOffline && (claimsReader === undefined || typeof claimsReader !== 'function')) {
      fail('invalid_argument', 'claimsReader must be a function when includeOffline is true')
    }
    const raw = nowOverride === undefined ? now() : nowOverride
    const timestamp = typeof raw === 'function' ? raw() : raw
    if (typeof timestamp !== 'number' || !Number.isFinite(timestamp)) {
      fail('invalid_argument', 'now must resolve to a finite epoch-millisecond value')
    }

    // Pure view over the live rows: a row silent strictly longer than the
    // presence TTL is hidden from online — nothing is deleted, so a
    // third party's read can neither free a name nor break the lease, and an
    // idle session's next authenticated touch re-lists it as-is.
    const online = []
    const onlineFingerprints = new Set()
    for (const row of sessions.values()) {
      if (timestamp - row.lastSeen > presenceTtlMs) continue
      online.push({
        chat_id: row.chatId,
        client_type: row.clientType,
        connected_since: new Date(row.connectedSince).toISOString(),
        last_seen: new Date(row.lastSeen).toISOString(),
        fingerprint: row.actorFingerprint,
      })
      onlineFingerprints.add(row.actorFingerprint)
    }

    const offlineRecently = []
    if (includeOffline) {
      // The window is inclusive at its boundary: a claim last seen exactly
      // OFFLINE_RECENTLY_WINDOW_MS ago is still in the group. Dedupe by Actor
      // fingerprint keeps each Actor's most recent claim; online Actors and
      // the reading session's own Actor never appear here.
      const seen = new Set()
      for (const claim of claimsReader(OFFLINE_RECENTLY_WINDOW_MS, timestamp)) {
        const fingerprint = claim.actor_fingerprint
        if (seen.has(fingerprint)) continue
        if (onlineFingerprints.has(fingerprint)) continue
        if (fingerprint === readerFingerprint) continue
        seen.add(fingerprint)
        offlineRecently.push({
          chat_id: claim.chat_id,
          fingerprint,
          last_seen: claim.last_seen_at,
        })
      }
    }

    return { online, offline_recently: offlineRecently }
  }

  // Drop every live row: the server close path invokes this when it owns the
  // process-default registry, so a restart-within-process finds no stale
  // names. Durable claim rows are untouched — ephemeral side only.
  function clear() {
    sessions.clear()
    names.clear()
  }

  return Object.freeze({ claim, rename, transfer, release, touch, lookup, holderOf, occupancyGeneration, presenceSnapshot, clear })
}
