// Notification delivery port must preserve the existing client trust matrix:
// same fingerprint outcomes for local/remote, allowlist, accept-all, and held.

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { emptyAllowlist, applyTrustMatrix, LOCAL_TRANSPORT, REMOTE_TRANSPORT } from '../server/client/trust.mjs'
import { createDeliveryClassifier } from '../server/notification/delivery.mjs'
import { atomicWriteJson } from '../server/runtime.mjs'

const own = 'sha256:' + 'a'.repeat(64)
const peer = 'sha256:' + 'b'.repeat(64)
const raw = { seq: 1, room_id: 'room', actor_fingerprint: peer, chat_id: 'Peer', text: 'SECRET_BODY_CANARY_27a1', created_at: '2026-11-01T00:00:00.000Z' }

test('Notification delivery port is equivalent to the existing trust matrix for local, remote, allowlisted and accept-all rows', t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-room-delivery-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const pluginData = join(root, 'plugin')
  mkdirSync(pluginData, { mode: 0o700 })
  const realmId = '308fb41d-f0f8-4b22-b9b6-78bc0f3723ed'
  const allowlistPath = join(pluginData, 'realms', realmId, 'allowlist.json')
  const cases = [
    { name: 'local', transport: LOCAL_TRANSPORT, allowlist: emptyAllowlist(), held: false },
    { name: 'remote-untrusted', transport: REMOTE_TRANSPORT, allowlist: emptyAllowlist(), held: true },
    { name: 'remote-allowlisted', transport: REMOTE_TRANSPORT, allowlist: { version: 1, accept_all: false, entries: [{ fingerprint: peer }] }, held: false },
    { name: 'remote-accept-all', transport: REMOTE_TRANSPORT, allowlist: { version: 1, accept_all: true, entries: [] }, held: false },
  ]
  for (const item of cases) {
    atomicWriteJson(allowlistPath, item.allowlist)
    const expected = applyTrustMatrix({ messages: [raw] }, { ownFingerprint: own, transport: item.transport, allowlist: item.allowlist }).messages[0]
    const actual = createDeliveryClassifier({ pluginDataDir: pluginData, realmId, ownFingerprint: own, transport: item.transport }).classifyRow(raw)
    assert.equal(actual.held === true, item.held, item.name)
    assert.deepEqual(actual, expected, item.name)
    if (item.held) {
      assert.equal(actual.preview, undefined)
      assert.ok(!actual.text.includes(raw.text), 'held classifier output is metadata-only, not raw message text')
      assert.match(actual.text, /Body text is withheld/)
    } else {
      assert.equal(actual.text, raw.text, `${item.name}: delivered rows preserve their body for the agent read path`)
    }
  }
})

test('Notification delivery port is own-fingerprint safe under every transport', t => {
  const root = mkdtempSync(join(tmpdir(), 'agent-room-delivery-own-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const pluginData = join(root, 'plugin')
  mkdirSync(pluginData, { mode: 0o700 })
  const realmId = '308fb41d-f0f8-4b22-b9b6-78bc0f3723ed'
  const ownRow = { ...raw, actor_fingerprint: own, text: 'own' }
  const classifier = createDeliveryClassifier({ pluginDataDir: pluginData, realmId, ownFingerprint: own, transport: REMOTE_TRANSPORT })
  assert.equal(classifier.classifyRow(ownRow).held, undefined)
})
