// Core realm bootstrap (Story 1.3, AD-14 foundations): first boot mints the
// realm's stable UUID and creates the Broadcast Room implicitly. Idempotent
// and race-convergent: an existing realm id is kept as-is, insertRealm's
// singleton row makes racing minters agree on one id, and ensureBroadcastRoom
// re-checks inside the store's write transaction so concurrent or partial
// bootstraps (realm minted, room missing) converge on exactly one Broadcast
// Room. No join/leave verbs exist for the Broadcast Room: membership is
// implicit from enrollment (Epic 3).
//
// Pure orchestration over the store API only: no transport imports, no SQL
// strings (the store adapter owns every statement), no HTTP concerns. The
// bootstrap fabricates no identity whatsoever — the Broadcast Room's creator
// stays NULL until a real Actor shape owns it, because the room predates any
// Actor.

import { randomUUID } from 'node:crypto'

import { AgentRoomRuntimeError } from '../runtime.mjs'

function requireStore(store) {
  const required = ['getRealmId', 'insertRealm', 'findBroadcastRoom', 'ensureBroadcastRoom']
  const missing = required.filter(name => typeof store?.[name] !== 'function')
  if (missing.length > 0) {
    throw new AgentRoomRuntimeError(
      'invalid_argument',
      `bootstrapRealm requires an open room-log store (missing: ${missing.join(', ')})`,
    )
  }
  return store
}

export function bootstrapRealm(store) {
  requireStore(store)

  let realmId = store.getRealmId()
  if (!realmId) {
    // insertRealm returns the winner's id when a concurrent bootstrap raced
    // us, so every caller converges on the same realm.
    realmId = store.insertRealm(randomUUID())
  }

  // Partial-bootstrap recovery: a realm without its Broadcast Room (crash
  // between the two steps) is completed here; a present room is returned
  // untouched — never a second Broadcast Room, never a fabricated creator.
  const broadcastRoom = store.ensureBroadcastRoom()

  return { realmId, broadcastRoom }
}
