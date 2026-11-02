// Messaging direct-room application service contract: Identity resolves name
// claims; Messaging opens/reuses a pair room. No API envelope dependencies.
import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveDirectRoom } from '../server/messaging/direct-room.mjs'

const fpA = 'sha256:' + 'a'.repeat(64)
const fpB = 'sha256:' + 'b'.repeat(64)
const fpC = 'sha256:' + 'c'.repeat(64)
const claims = [
  { actor_fingerprint: fpB, last_seen_at: '2026-11-01T00:00:00.000Z' },
  { actor_fingerprint: fpA, last_seen_at: '2026-10-31T00:00:00.000Z' },
  { actor_fingerprint: fpB, last_seen_at: '2026-10-30T00:00:00.000Z' },
]

function harness(rows = claims) {
  const opened = []
  return {
    opened,
    run: options => resolveDirectRoom({
      chatId: 'Peer',
      callerFingerprint: fpA,
      listClaimsForChatId: chatId => { assert.equal(chatId, 'Peer'); return rows },
      openDirectRoom: arg => { opened.push(arg); return { id: 'room-1', kind: 'direct' } },
      ...options,
    }),
  }
}

test('unique directory identity resolves and opens one canonical pair room', () => {
  const h = harness([claims[0]])
  assert.deepEqual(h.run(), { ok: true, room_id: 'room-1', kind: 'direct' })
  assert.deepEqual(h.opened, [{ actorFingerprints: [fpA, fpB] }])
})

test('duplicate claims dedupe by Actor to most recent before ambiguity check', () => {
  const h = harness()
  const result = h.run()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'ambiguous_chat_id')
  assert.deepEqual(result.candidates.map(c => c.fingerprint), [fpB, fpA])
  assert.equal(h.opened.length, 0)
})

test('explicit target fingerprint resolves ambiguity; same Actor opens a self-DM', () => {
  const h = harness()
  assert.equal(h.run({ targetFingerprint: fpB }).ok, true)
  assert.deepEqual(h.opened[0].actorFingerprints, [fpA, fpB])
  assert.equal(h.run({ targetFingerprint: fpA }).ok, true)
  assert.deepEqual(h.opened[1].actorFingerprints, [fpA, fpA])
})

test('unknown name and unmatched fingerprint return typed absence without opening room', () => {
  const empty = harness([])
  assert.deepEqual(empty.run(), { ok: false, code: 'chat_id_not_found', requestedFingerprint: null, chatId: 'Peer' })
  const unmatched = harness([claims[0]])
  assert.equal(unmatched.run({ targetFingerprint: fpC }).code, 'chat_id_not_found')
  assert.equal(unmatched.opened.length, 0)
})
