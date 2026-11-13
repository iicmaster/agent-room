// v0.9.0 session principals: the protocol matrix against the real store —
// the two independent lifetimes (30 s base lease vs 30-day principal
// retention), the allocation races (DUP_BASE_SAME_INSTALL both succeed under
// distinct locator tokens; a pinned full-address collision refuses
// name_taken and never suffixes), the generation fence (OLD_GEN_HEARTBEAT),
// the release/revoke idempotence, restart persistence, and the additive
// schema convergence: an existing v2 file carrying the OLD 32-character
// chat_id bound rebuilds in place, preserving every row, so a session
// address fits as a message attribution.

import assert from 'node:assert/strict'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'

import { openRoomLog } from '../server/store/room-log.mjs'
import { sessionCursorSeedState } from '../server/client/session-state.mjs'
import {
  MESSAGE_TEXT_MAX,
  SESSION_BASE_LEASE_MS,
  SESSION_PRINCIPAL_RETENTION_MS,
} from '../server/constants.mjs'

const FINGERPRINT_A = 'sha256:' + 'a'.repeat(64)
const FINGERPRINT_B = 'sha256:' + 'b'.repeat(64)
const T0 = 1_000_000_000_000
const MIGRATION_REALM = 'm0a1b2c3-d4e5-4f6a-8b9c-0d1e2f3a4b5c'

function makeStore(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-session-principals-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  return openRoomLog({ dataDir })
}

const iso = ms => new Date(ms).toISOString()
const tokenOf = address => address.split('~')[1].split('@')[0]

// --- Allocation -------------------------------------------------------------

test('HAPPY_ALLOCATE: one allocation answers the full principal shape, capability once', t => {
  const store = makeStore(t)
  const allocated = store.allocateSessionPrincipal({
    installationFingerprint: FINGERPRINT_A, baseName: 'zcode', machine: 'macbook', nowMs: T0,
  })
  assert.match(allocated.session_id, /^[0-9a-f-]{36}$/)
  assert.equal(allocated.generation, 1)
  assert.match(allocated.address, /^zcode~[A-Za-z0-9_-]{10}@macbook$/)
  assert.equal(allocated.base_name, 'zcode')
  assert.equal(allocated.machine, 'macbook')
  assert.equal(allocated.base_lease_status, 'occupied')
  assert.equal(allocated.base_lease_expires_at, iso(T0 + SESSION_BASE_LEASE_MS))
  assert.equal(allocated.principal_retention_expires_at, iso(T0 + SESSION_PRINCIPAL_RETENTION_MS))
  assert.equal(allocated.principal_status, 'retained')
  assert.equal(allocated.last_heartbeat_at, iso(T0))
  assert.match(allocated.session_capability, /^[A-Za-z0-9_-]{43}$/)
  // The raw capability appears in the allocation result only; the listing
  // and the resolution carry no credential material — no capability, no
  // digest (the digest is the store's own keying, never a projection field).
  const listed = store.listSessionPrincipals({ nowMs: T0 })
  assert.equal(listed.length, 1)
  assert.equal(listed[0].session_capability, undefined)
  assert.equal(listed[0].capability_digest, undefined)
  assert.equal(listed[0].presence, 'online', 'a freshly allocated occupied lease is online')
  store.close()
})

test('DUP_BASE_SAME_INSTALL: two processes, one base, one machine — both succeed, distinct tokens', t => {
  const store = makeStore(t)
  const first = store.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_A, baseName: 'zcode', machine: 'macbook', nowMs: T0 })
  const second = store.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_A, baseName: 'zcode', machine: 'macbook', nowMs: T0 })
  assert.notEqual(first.address, second.address)
  assert.notEqual(tokenOf(first.address), tokenOf(second.address))
  assert.equal(first.base_name, second.base_name)
  assert.equal(first.machine, second.machine)
  assert.notEqual(first.session_id, second.session_id)
  assert.notEqual(first.session_capability, second.session_capability)
  // `chat_id_taken` never arises from this race: both principals are listed.
  assert.equal(store.listSessionPrincipals({ nowMs: T0 }).length, 2)
  store.close()
})

test('DUP_FULL_ADDRESS: a pinned token collision refuses name_taken with the holder machine, never suffixes', t => {
  const store = makeStore(t)
  const first = store.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_A, baseName: 'zcode', machine: 'macbook', nowMs: T0 })
  const pinnedToken = tokenOf(first.address)
  assert.throws(
    () => store.allocateSessionPrincipal({
      installationFingerprint: FINGERPRINT_B, baseName: 'zcode', machine: 'macbook', nowMs: T0,
      locatorTokenFn: () => pinnedToken,
    }),
    error => error.code === 'name_taken' && error.message.includes('macbook') && error.message.includes(pinnedToken),
  )
  // No suffix, no merge: exactly two allocates produced exactly one live row
  // for this base plus the second attempt wrote nothing.
  const listed = store.listSessionPrincipals({ nowMs: T0 })
  assert.equal(listed.length, 1)
  assert.equal(listed[0].session_id, first.session_id)
  store.close()
})

// --- Heartbeat: the 30 s lease, per principal ---------------------------------

test('HEARTBEAT_RENEW: a beat at 29,999 ms renews only its own lease', t => {
  const store = makeStore(t)
  const a = store.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_A, baseName: 'a-base', machine: 'macbook', nowMs: T0 })
  const b = store.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_A, baseName: 'b-base', machine: 'macbook', nowMs: T0 })
  const beaten = store.heartbeatSessionPrincipal({ sessionId: a.session_id, generation: 1, nowMs: T0 + 29_999 })
  assert.equal(beaten.base_lease_expires_at, iso(T0 + 29_999 + SESSION_BASE_LEASE_MS))
  assert.equal(beaten.last_heartbeat_at, iso(T0 + 29_999))
  // B's lease is untouched: A's beat renews A alone.
  const listed = store.listSessionPrincipals({ nowMs: T0 + 29_999 + 1 })
  const byId = new Map(listed.map(row => [row.session_id, row]))
  assert.equal(byId.get(a.session_id).presence, 'online')
  assert.equal(byId.get(b.session_id).presence, 'offline', 'B missed its beats and reads offline')
  store.close()
})

test('LEASE_EXPIRE_RECLAIM: after 30 s without a beat, a new principal claims the base; the old one persists offline', t => {
  const store = makeStore(t)
  const old = store.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_A, baseName: 'zcode', machine: 'macbook', nowMs: T0 })
  const now = T0 + 30_000
  const fresh = store.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_A, baseName: 'zcode', machine: 'macbook', nowMs: now })
  assert.notEqual(tokenOf(old.address), tokenOf(fresh.address))
  // The old principal, its full address, and its mailbox are all still there
  // — offline, retained, resolvable.
  const resolved = store.resolveSessionPrincipalByAddress(old.address)
  assert.equal(resolved.session_id, old.session_id)
  assert.equal(resolved.principal_status, 'retained')
  const listed = store.listSessionPrincipals({ nowMs: now })
  const oldRow = listed.find(row => row.session_id === old.session_id)
  assert.equal(oldRow.presence, 'offline')
  assert.equal(oldRow.principal_status, 'retained')
  store.close()
})

test('OLD_GEN_HEARTBEAT: a beat with a fenced generation answers session_expired and renews nothing', t => {
  const store = makeStore(t)
  const principal = store.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_A, baseName: 'zcode', machine: 'macbook', nowMs: T0 })
  // A resume increments the generation: the old generation is fenced now.
  const resumed = store.resumeSessionPrincipal({ sessionId: principal.session_id, generation: 1, nowMs: T0 + 1000 })
  assert.equal(resumed.generation, 2)
  assert.equal(resumed.address, principal.address, 'resume returns the SAME full address')
  assert.equal(resumed.session_id, principal.session_id)
  assert.throws(
    () => store.heartbeatSessionPrincipal({ sessionId: principal.session_id, generation: 1, nowMs: T0 + 2000 }),
    error => error.code === 'session_expired',
  )
  assert.throws(
    () => store.heartbeatSessionPrincipal({ sessionId: principal.session_id, generation: 3, nowMs: T0 + 2000 }),
    error => error.code === 'session_expired',
  )
  // The lease was renewed by the RESUME (generation 2's own beat), not by
  // any fenced attempt.
  const row = store.resolveSessionPrincipalByAddress(principal.address)
  assert.equal(row.generation, 2)
  assert.equal(row.base_lease_expires_at, iso(T0 + 1000 + SESSION_BASE_LEASE_MS))
  store.close()
})

// --- Capability digest ---------------------------------------------------------

test('CAPABILITY_MISMATCH foundations: the digest resolves exactly its own principal, nothing else', async t => {
  const store = makeStore(t)
  const a = store.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_A, baseName: 'a-base', machine: 'macbook', nowMs: T0 })
  const b = store.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_A, baseName: 'b-base', machine: 'macbook', nowMs: T0 })
  const { createHash } = await import('node:crypto')
  const digestOf = capability => createHash('sha256').update(capability, 'utf8').digest('hex')
  assert.equal(store.findSessionPrincipalByCapabilityDigest(digestOf(a.session_capability)).session_id, a.session_id)
  assert.equal(store.findSessionPrincipalByCapabilityDigest(digestOf(b.session_capability)).session_id, b.session_id)
  assert.equal(store.findSessionPrincipalByCapabilityDigest(digestOf('not-a-real-capability')), null)
  store.close()
})

// --- Release and revoke --------------------------------------------------------

test('release frees only the base lease; duplicate release is idempotent; the mailbox persists', t => {
  const store = makeStore(t)
  const a = store.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_A, baseName: 'a-base', machine: 'macbook', nowMs: T0 })
  const b = store.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_A, baseName: 'b-base', machine: 'macbook', nowMs: T0 })
  const room = store.openSessionPairRoom({ sessionIds: [a.session_id, b.session_id], nowMs: T0 })
  store.appendSessionPairMessage({
    roomId: room.id, sessionId: a.session_id, installationFingerprint: FINGERPRINT_A,
    chatId: a.address, clientMessageId: 'm-1', text: 'hello b', nowMs: T0,
  })
  const released = store.releaseSessionBaseLease({ sessionId: a.session_id })
  assert.equal(released.base_lease_status, 'released')
  assert.equal(released.principal_status, 'retained', 'release never touches retention')
  const releasedAgain = store.releaseSessionBaseLease({ sessionId: a.session_id })
  assert.equal(releasedAgain.base_lease_status, 'released')
  // B still reads the pair room: A's mailbox is not A's lease.
  const page = store.readSessionPairPage({ roomId: room.id, sessionId: b.session_id, afterSeq: 0, limit: 10 })
  assert.equal(page.length, 1)
  store.close()
})

test('revoke: installation-scoped, ends retention, fences the capability, idempotent, never deletes messages', t => {
  const store = makeStore(t)
  const a = store.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_A, baseName: 'a-base', machine: 'macbook', nowMs: T0 })
  const b = store.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_A, baseName: 'b-base', machine: 'macbook', nowMs: T0 })
  const room = store.openSessionPairRoom({ sessionIds: [a.session_id, b.session_id], nowMs: T0 })
  store.appendSessionPairMessage({
    roomId: room.id, sessionId: a.session_id, installationFingerprint: FINGERPRINT_A,
    chatId: a.address, clientMessageId: 'm-1', text: 'hello', nowMs: T0,
  })
  // A foreign installation's revoke is a zero-state refusal.
  assert.throws(
    () => store.revokeSessionPrincipal({ sessionId: a.session_id, installationFingerprint: FINGERPRINT_B }),
    error => error.code === 'unauthorized',
  )
  const revoked = store.revokeSessionPrincipal({ sessionId: a.session_id, installationFingerprint: FINGERPRINT_A })
  assert.equal(revoked.principal_status, 'revoked')
  assert.equal(revoked.base_lease_status, 'released')
  // Idempotent.
  const revokedAgain = store.revokeSessionPrincipal({ sessionId: a.session_id, installationFingerprint: FINGERPRINT_A })
  assert.equal(revokedAgain.principal_status, 'revoked')
  // The capability is dead: heartbeat and resume answer session_revoked,
  // and the address resolves to nothing (revoked principals free it).
  assert.throws(
    () => store.heartbeatSessionPrincipal({ sessionId: a.session_id, generation: 1, nowMs: T0 + 1000 }),
    error => error.code === 'session_revoked',
  )
  assert.throws(
    () => store.resumeSessionPrincipal({ sessionId: a.session_id, generation: 1, nowMs: T0 + 1000 }),
    error => error.code === 'session_revoked',
  )
  assert.equal(store.resolveSessionPrincipalByAddress(a.address), null)
  // Room-log messages are never deleted.
  const page = store.readSessionPairPage({ roomId: room.id, sessionId: b.session_id, afterSeq: 0, limit: 10 })
  assert.equal(page.length, 1)
  store.close()
})

// --- Restart persistence --------------------------------------------------------

test('server restart restores retained principals and lease states; expired leases are reclaimable', t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-session-principals-restart-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const first = openRoomLog({ dataDir })
  const live = first.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_A, baseName: 'live', machine: 'macbook', nowMs: T0 })
  const offline = first.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_A, baseName: 'offline', machine: 'macbook', nowMs: T0 })
  first.releaseSessionBaseLease({ sessionId: offline.session_id })
  first.close()

  const second = openRoomLog({ dataDir })
  // Same generation, same address, no silent re-mint.
  const liveRestored = second.resolveSessionPrincipalByAddress(live.address)
  assert.equal(liveRestored.session_id, live.session_id)
  assert.equal(liveRestored.generation, 1)
  assert.equal(liveRestored.base_lease_expires_at, live.base_lease_expires_at)
  const offlineRestored = second.resolveSessionPrincipalByAddress(offline.address)
  assert.equal(offlineRestored.base_lease_status, 'released')
  // The resumed beat works across the restart with the same generation.
  const beaten = second.heartbeatSessionPrincipal({ sessionId: live.session_id, generation: 1, nowMs: T0 + 5000 })
  assert.equal(beaten.base_lease_expires_at, iso(T0 + 5000 + SESSION_BASE_LEASE_MS))
  second.close()
})

// --- Retention ------------------------------------------------------------------

test('retention expiry: 30 days without a beat ends retention, frees the address, keeps the row', t => {
  const store = makeStore(t)
  const principal = store.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_A, baseName: 'zcode', machine: 'macbook', nowMs: T0 })
  const afterRetention = T0 + SESSION_PRINCIPAL_RETENTION_MS + 1000
  const listed = store.listSessionPrincipals({ nowMs: afterRetention })
  const row = listed.find(entry => entry.session_id === principal.session_id)
  assert.equal(row.principal_status, 'retention_expired')
  assert.equal(row.base_lease_status, 'released')
  assert.equal(store.resolveSessionPrincipalByAddress(principal.address), null, 'the address of a retention-expired principal resolves to nothing')
  // Resume and heartbeat answer session_expired, never mutate.
  assert.throws(
    () => store.resumeSessionPrincipal({ sessionId: principal.session_id, generation: 1, nowMs: afterRetention }),
    error => error.code === 'session_expired',
  )
  store.close()
})

// --- Session-pair rooms -----------------------------------------------------------

test('pair room: idempotent in either order, peer_not_found for a dead peer, membership is per session', t => {
  const store = makeStore(t)
  const a = store.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_A, baseName: 'a-base', machine: 'macbook', nowMs: T0 })
  const b = store.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_B, baseName: 'b-base', machine: 'macbook', nowMs: T0 })
  const c = store.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_B, baseName: 'c-base', machine: 'macbook', nowMs: T0 })
  const ab = store.openSessionPairRoom({ sessionIds: [a.session_id, b.session_id], nowMs: T0 })
  const ba = store.openSessionPairRoom({ sessionIds: [b.session_id, a.session_id], nowMs: T0 })
  assert.equal(ab.id, ba.id, 'either argument order converges on one room')
  assert.match(ab.pair_key, /^ssession:/)
  // Reuse: a second open adds no second room.
  const again = store.openSessionPairRoom({ sessionIds: [a.session_id, b.session_id], nowMs: T0 + 1 })
  assert.equal(again.id, ab.id)
  // A self-pair is first-class (the same-Actor room's session analogue).
  const self = store.openSessionPairRoom({ sessionIds: [a.session_id, a.session_id], nowMs: T0 })
  assert.notEqual(self.id, ab.id)
  // THIRD_SESSION_ACL: C — same installation as B — holds no membership.
  assert.equal(store.sessionPairMembership({ roomId: ab.id, sessionId: c.session_id }), false)
  assert.throws(
    () => store.readSessionPairPage({ roomId: ab.id, sessionId: c.session_id, afterSeq: 0, limit: 10 }),
    error => error.code === 'actor_not_member',
  )
  // A dead peer's room is never created: revoke B, then a room with B refuses
  // with the constant quiet code.
  store.revokeSessionPrincipal({ sessionId: b.session_id, installationFingerprint: FINGERPRINT_B })
  assert.throws(
    () => store.openSessionPairRoom({ sessionIds: [a.session_id, b.session_id], nowMs: T0 + 2 }),
    error => error.code === 'peer_not_found',
  )
  store.close()
})

test('session-pair rooms join the installation room listing; the old fingerprint append still refuses there', t => {
  const store = makeStore(t)
  const a = store.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_A, baseName: 'a-base', machine: 'macbook', nowMs: T0 })
  const sibling = store.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_A, baseName: 'sib-base', machine: 'macbook', nowMs: T0 })
  const foreign = store.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_B, baseName: 'f-base', machine: 'macbook', nowMs: T0 })
  const room = store.openSessionPairRoom({ sessionIds: [a.session_id, foreign.session_id], nowMs: T0 })
  const listed = store.listRoomsForActor(FINGERPRINT_A)
  assert.deepEqual(listed.map(entry => entry.id), [room.id], 'the installation discovers the rooms its sessions belong to')
  // The OLD append path (fingerprint membership) refuses on a session-pair
  // room: the fingerprint holds no direct_members row there.
  assert.throws(
    () => store.appendMessage({
      roomId: room.id, actorFingerprint: FINGERPRINT_A, chatId: 'a-base',
      clientMessageId: 'old-path', text: 'nope', nowMs: T0,
    }),
    error => error.code === 'actor_not_member',
  )
  store.close()
})

test('addressed append: idempotent by (room, SENDER ADDRESS, client_message_id), conflict on payload change, address stored verbatim', t => {
  const store = makeStore(t)
  const a = store.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_A, baseName: 'a-base', machine: 'macbook', nowMs: T0 })
  const b = store.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_B, baseName: 'b-base', machine: 'macbook', nowMs: T0 })
  const room = store.openSessionPairRoom({ sessionIds: [a.session_id, b.session_id], nowMs: T0 })
  const first = store.appendSessionPairMessage({
    roomId: room.id, sessionId: a.session_id, installationFingerprint: FINGERPRINT_A,
    chatId: a.address, clientMessageId: 'dm-1', text: 'nonce-123', nowMs: T0,
  })
  assert.equal(first.duplicate, false)
  // The exact retry returns the ORIGINAL row (S6).
  const retry = store.appendSessionPairMessage({
    roomId: room.id, sessionId: a.session_id, installationFingerprint: FINGERPRINT_A,
    chatId: a.address, clientMessageId: 'dm-1', text: 'nonce-123', nowMs: T0 + 1,
  })
  assert.equal(retry.duplicate, true)
  assert.equal(retry.message.seq, first.message.seq)
  assert.equal(retry.message.chat_id, a.address, 'the attribution chat_id is the sender full address')
  assert.equal(retry.message.actor_fingerprint, FINGERPRINT_A, 'provenance stays installation-scoped')
  // A conflicting payload is the coded 409.
  assert.throws(
    () => store.appendSessionPairMessage({
      roomId: room.id, sessionId: a.session_id, installationFingerprint: FINGERPRINT_A,
      chatId: a.address, clientMessageId: 'dm-1', text: 'different', nowMs: T0 + 2,
    }),
    error => error.code === 'client_message_id_conflict',
  )
  // Reply targets resolve room-locally, exactly as the old append does.
  assert.throws(
    () => store.appendSessionPairMessage({
      roomId: room.id, sessionId: a.session_id, installationFingerprint: FINGERPRINT_A,
      chatId: a.address, clientMessageId: 'dm-2', text: 'reply', replyToSeq: 99, nowMs: T0 + 3,
    }),
    error => error.code === 'message_not_found',
  )
  store.close()
})

test('SIBLING sessions of one installation never collide on a shared client_message_id (the idempotency key is the sender address, not the shared fingerprint)', t => {
  const store = makeStore(t)
  const siblingA = store.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_A, baseName: 'sib-a', machine: 'macbook', nowMs: T0 })
  const siblingB = store.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_A, baseName: 'sib-b', machine: 'macbook', nowMs: T0 })
  const peer = store.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_B, baseName: 'peer-b', machine: 'macbook', nowMs: T0 })
  // The one shape where two siblings share a room AND a fingerprint: the
  // pair room between the siblings themselves. Same client_message_id from
  // each side — the fingerprint-keyed key would false-conflict (or falsely
  // duplicate-drop identical text); the ADDRESS-keyed key lets both commit.
  const shared = store.openSessionPairRoom({ sessionIds: [siblingA.session_id, siblingB.session_id], nowMs: T0 })
  const fromA = store.appendSessionPairMessage({
    roomId: shared.id, sessionId: siblingA.session_id, installationFingerprint: FINGERPRINT_A,
    chatId: siblingA.address, clientMessageId: 'shared-id', text: 'a speaks', nowMs: T0,
  })
  const fromB = store.appendSessionPairMessage({
    roomId: shared.id, sessionId: siblingB.session_id, installationFingerprint: FINGERPRINT_A,
    chatId: siblingB.address, clientMessageId: 'shared-id', text: 'b speaks', nowMs: T0 + 1,
  })
  assert.equal(fromA.duplicate, false)
  assert.equal(fromB.duplicate, false)
  assert.equal(fromA.message.seq, 1)
  assert.equal(fromB.message.seq, 2, 'the shared id commits twice under two distinct sender addresses')

  // IDENTICAL text from both siblings inside the duplicate window: the
  // content gate is address-keyed too, so neither row is duplicate_dropped.
  const sameTextA = store.appendSessionPairMessage({
    roomId: shared.id, sessionId: siblingA.session_id, installationFingerprint: FINGERPRINT_A,
    chatId: siblingA.address, clientMessageId: 'shared-id-2', text: 'identical words', nowMs: T0 + 2,
  })
  const sameTextB = store.appendSessionPairMessage({
    roomId: shared.id, sessionId: siblingB.session_id, installationFingerprint: FINGERPRINT_A,
    chatId: siblingB.address, clientMessageId: 'shared-id-2', text: 'identical words', nowMs: T0 + 3,
  })
  assert.equal(sameTextA.duplicate, false)
  assert.equal(sameTextB.duplicate, false)
  assert.equal(sameTextB.message.seq, sameTextA.message.seq + 1)

  // Different pair rooms (each sibling with the peer): the room_id in the
  // key keeps them independent, as always.
  const roomA = store.openSessionPairRoom({ sessionIds: [siblingA.session_id, peer.session_id], nowMs: T0 })
  const roomB = store.openSessionPairRoom({ sessionIds: [siblingB.session_id, peer.session_id], nowMs: T0 })
  const crossRoomA = store.appendSessionPairMessage({
    roomId: roomA.id, sessionId: siblingA.session_id, installationFingerprint: FINGERPRINT_A,
    chatId: siblingA.address, clientMessageId: 'cross-id', text: 'to the peer from a', nowMs: T0 + 4,
  })
  const crossRoomB = store.appendSessionPairMessage({
    roomId: roomB.id, sessionId: siblingB.session_id, installationFingerprint: FINGERPRINT_A,
    chatId: siblingB.address, clientMessageId: 'cross-id', text: 'to the peer from b', nowMs: T0 + 5,
  })
  assert.equal(crossRoomA.message.seq, 1)
  assert.equal(crossRoomB.message.seq, 1)
  store.close()
})

test('the attribution validator admits both shapes and nothing wider', t => {
  const store = makeStore(t)
  const a = store.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_A, baseName: 'a-base', machine: 'macbook', nowMs: T0 })
  const b = store.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_B, baseName: 'b-base', machine: 'macbook', nowMs: T0 })
  const room = store.openSessionPairRoom({ sessionIds: [a.session_id, b.session_id], nowMs: T0 })
  // A classic DR-1 chat id is still a valid attribution on the addressed path.
  store.appendSessionPairMessage({
    roomId: room.id, sessionId: a.session_id, installationFingerprint: FINGERPRINT_A,
    chatId: 'a-base', clientMessageId: 'classic', text: 'plain name', nowMs: T0,
  })
  // Neither a truncated address nor an arbitrary string passes.
  assert.throws(
    () => store.appendSessionPairMessage({
      roomId: room.id, sessionId: a.session_id, installationFingerprint: FINGERPRINT_A,
      chatId: 'a-base@macbook', clientMessageId: 'bad-1', text: 'nope', nowMs: T0,
    }),
    error => error.code === 'invalid_chat_id',
  )
  assert.throws(
    () => store.appendSessionPairMessage({
      roomId: room.id, sessionId: a.session_id, installationFingerprint: FINGERPRINT_A,
      chatId: 'a-base~short@macbook', clientMessageId: 'bad-2', text: 'nope', nowMs: T0,
    }),
    error => error.code === 'invalid_chat_id',
  )
  store.close()
})

// --- Additive schema convergence --------------------------------------------------

// Build a schema-v2 file carrying the OLD 32-character messages.chat_id bound
// (the shape every pre-v0.9 installation has on disk), with one committed row.
function makeLegacyV2File(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-session-principals-legacy-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const database = new DatabaseSync(join(dataDir, 'agent-room.sqlite'))
  const fingerprintCheck = column => `CHECK (length(${column}) = 71
          AND substr(${column}, 1, 7) = 'sha256:'
          AND substr(${column}, 8) NOT GLOB '*[^0-9a-f]*')`
  database.exec(`
    CREATE TABLE rooms (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      title TEXT,
      pair_key TEXT UNIQUE,
      created_by_fingerprint TEXT,
      created_at TEXT NOT NULL,
      CHECK (kind IN ('broadcast', 'direct')),
      CHECK ((kind = 'direct') = (pair_key IS NOT NULL)),
      CHECK (kind = 'direct' OR title IS NOT NULL),
      CHECK (kind = 'direct' OR length(title) BETWEEN 1 AND 120),
      CHECK (length(id) BETWEEN 1 AND 128),
      ${fingerprintCheck('created_by_fingerprint')}
    ) STRICT;
    CREATE TABLE direct_members (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
      actor_fingerprint TEXT NOT NULL,
      joined_at TEXT NOT NULL,
      PRIMARY KEY (room_id, actor_fingerprint),
      ${fingerprintCheck('actor_fingerprint')}
    ) STRICT;
    CREATE TABLE messages (
      room_id TEXT NOT NULL REFERENCES rooms(id) ON DELETE RESTRICT,
      seq INTEGER NOT NULL,
      actor_fingerprint TEXT NOT NULL,
      chat_id TEXT NOT NULL,
      client_message_id TEXT NOT NULL,
      text TEXT NOT NULL,
      reply_to_seq INTEGER,
      created_at TEXT NOT NULL,
      PRIMARY KEY (room_id, seq),
      UNIQUE (room_id, actor_fingerprint, client_message_id),
      FOREIGN KEY (room_id, reply_to_seq)
        REFERENCES messages(room_id, seq) ON DELETE RESTRICT,
      CHECK (seq >= 1),
      CHECK (reply_to_seq IS NULL OR reply_to_seq >= 1),
      ${fingerprintCheck('actor_fingerprint')},
      CHECK (length(chat_id) BETWEEN 1 AND 32),
      CHECK (length(client_message_id) BETWEEN 1 AND 128),
      CHECK (length(text) BETWEEN 1 AND ${MESSAGE_TEXT_MAX})
    ) STRICT;
    CREATE TABLE realms (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      realm_id TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL
    ) STRICT;
    INSERT INTO realms (singleton, realm_id, created_at) VALUES (1, '00000000-0000-4000-8000-000000000000', '2026-01-01T00:00:00.000Z');
    INSERT INTO rooms (id, kind, title, pair_key, created_by_fingerprint, created_at)
      VALUES ('broadcastroom', 'broadcast', 'Broadcast Room', NULL, NULL, '2026-01-01T00:00:00.000Z');
    INSERT INTO messages (room_id, seq, actor_fingerprint, chat_id, client_message_id, text, reply_to_seq, created_at)
      VALUES ('broadcastroom', 1, '${FINGERPRINT_A}', 'zcode', 'legacy-1', 'a committed v0.8 message', NULL, '2026-01-01T00:00:01.000Z');
    PRAGMA user_version = 2;
  `)
  database.close()
  return dataDir
}

test('MIGRATION (additive convergence): a pre-v0.9 v2 file rebuilds in place, keeps every row, and gains the widened bound', t => {
  const dataDir = makeLegacyV2File(t)
  const store = openRoomLog({ dataDir })
  // The legacy row survived the convergence rebuild byte-for-byte.
  const page = store.readBroadcastPage({ roomId: 'broadcastroom', afterSeq: 0, limit: 10 })
  assert.equal(page.length, 1)
  assert.equal(page[0].chat_id, 'zcode')
  assert.equal(page[0].text, 'a committed v0.8 message')
  // A full session address now fits as an attribution in that same file.
  const a = store.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_A, baseName: 'a-base', machine: 'a-machine-with-a-long-name', nowMs: T0 })
  const b = store.allocateSessionPrincipal({ installationFingerprint: FINGERPRINT_B, baseName: 'b-base', machine: 'macbook', nowMs: T0 })
  const room = store.openSessionPairRoom({ sessionIds: [a.session_id, b.session_id], nowMs: T0 })
  const appended = store.appendSessionPairMessage({
    roomId: room.id, sessionId: a.session_id, installationFingerprint: FINGERPRINT_A,
    chatId: a.address, clientMessageId: 'm-1', text: 'addressed after convergence', nowMs: T0,
  })
  assert.equal(appended.message.chat_id, a.address)
  assert.ok(a.address.length > 32, 'the address exceeds the old 32-character bound')
  // Reopening is stable (the widened shape is detected, no second rebuild).
  store.close()
  const reopened = openRoomLog({ dataDir })
  assert.equal(reopened.readBroadcastPage({ roomId: 'broadcastroom', afterSeq: 0, limit: 10 }).length, 1)
  reopened.close()
})

// --- MIGRATION_SEED: the first v0.9 session seeds the legacy cursor; later ones start at 0 ---

test('MIGRATION_SEED: first session seeds the legacy cursor, later sessions start at 0, re-runs are no-ops, an unreadable legacy file refuses loudly', t => {
  const parent = mkdtempSync(join(tmpdir(), 'agent-room-migration-seed-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const pluginData = join(parent, 'plugin-data')
  mkdirSync(join(pluginData, 'realms', MIGRATION_REALM), { recursive: true, mode: 0o700 })
  const legacyPath = join(pluginData, 'realms', MIGRATION_REALM, 'cursors.json')
  writeFileSync(legacyPath, `${JSON.stringify({ version: 1, cursors: { 'room-a': { after_seq: 12 } } })}\n`, { mode: 0o600 })

  const first = sessionCursorSeedState({ pluginDataDir: pluginData, realmId: MIGRATION_REALM, scope: 'scope-one' })
  assert.equal(first.seeded, true, 'the first session performs the seed')
  assert.deepEqual(first.cursors, { 'room-a': { after_seq: 12 } }, 'the first session inherits the legacy position')
  // The caller (the adapter's cursor loader) materializes the seeded position:
  // write it exactly as loadSessionCursors does, so the re-run reads the file.
  mkdirSync(join(pluginData, 'sessions', 'scope-one'), { recursive: true, mode: 0o700 })
  writeFileSync(join(first.cursorPath), `${JSON.stringify({ version: 1, realm_id: MIGRATION_REALM, cursors: first.cursors })}\n`, { mode: 0o600 })

  const second = sessionCursorSeedState({ pluginDataDir: pluginData, realmId: MIGRATION_REALM, scope: 'scope-two' })
  assert.equal(second.seeded, false, 'the second session does not re-seed')
  assert.deepEqual(second.cursors, {}, 'the second session starts at 0')

  const again = sessionCursorSeedState({ pluginDataDir: pluginData, realmId: MIGRATION_REALM, scope: 'scope-one' })
  assert.equal(again.seeded, false, 'a re-run is a no-op')
  assert.deepEqual(again.cursors, { 'room-a': { after_seq: 12 } }, 'the seeded position survives the re-run')
})

test('MIGRATION_SEED: an unreadable legacy cursor file refuses with migration_source_unreadable', t => {
  const parent = mkdtempSync(join(tmpdir(), 'agent-room-migration-seed-bad-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const pluginData = join(parent, 'plugin-data')
  mkdirSync(join(pluginData, 'realms', MIGRATION_REALM), { recursive: true, mode: 0o700 })
  const legacyPath = join(pluginData, 'realms', MIGRATION_REALM, 'cursors.json')
  writeFileSync(legacyPath, '{}', { mode: 0o000 })

  assert.throws(
    () => sessionCursorSeedState({ pluginDataDir: pluginData, realmId: MIGRATION_REALM, scope: 'scope-bad' }),
    error => error?.code === 'migration_source_unreadable',
    'the unreadable authority refuses the seed',
  )
  assert.equal(existsSync(join(pluginData, 'sessions', 'scope-bad', 'cursors.json')), false, 'no false cursor was materialized')
  chmodSync(legacyPath, 0o600)
})
