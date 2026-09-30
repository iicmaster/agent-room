// Story 4.4 acceptance: the four rate gates and the full send statuses.
//
// The gates are tested in isolation, each over an injectable clock, exactly
// as the criterion demands:
//
//   1. The send bucket (token bucket, per Actor, on the send route) and the
//      request budget (per Actor, every authenticated request) are the same
//      arithmetic over different declared constants — unit-tested here
//      directly, then over the wire with operator-tuned floors.
//   2. The duplicate gate lives inside the store's append transaction,
//      ordered AFTER the idempotency lookup (the AC's ordering is
//      structural: an exact retry short-circuits at the tuple and can never
//      reach the gate). Store-isolated rows drive the gate on an injected
//      clock, including the exact window boundary and the
//      different-room/different-reply-context non-deduplication.
//   3. The ordering test runs over the real HTTP surface: an exact retry
//      during a rate-limited period still returns the original and consumes
//      nothing — the gate probes the store's idempotency index before the
//      bucket spends a token — while a NEW send stays refused.
//   4. The refusal statuses are the complete FR-17 set: rate_limited (429)
//      always carries retry_after_ms; duplicate_dropped is a normal 200
//      result naming original_seq; the store is untouched by a drop.
//   5. NFR-5 executable: send p95 ≤ 150 ms server-side, excluding network
//      RTT. The measurement drives a warm in-process server over real
//      loopback HTTP and asserts the END-TO-END p95 — an upper bound that
//      includes the loopback round trip, so the server-side processing p95
//      it bounds is ≤ 150 ms a fortiori (on loopback the RTT is a fraction
//      of a millisecond; the bound has order-of-magnitude headroom).
//
// Every limit value in this file is either imported by name from the
// constants module (AD-9) or an operator override deliberately distinct from
// the declared defaults; no declared limit is restated.

import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Readable } from 'node:stream'
import test from 'node:test'

import { DatabaseSync } from 'node:sqlite'

import {
  DUPLICATE_WINDOW_MS,
  REQUEST_BUDGET_BURST,
  REQUEST_BUDGET_PER_MINUTE,
  SEND_TOKEN_CAPACITY,
  SEND_TOKEN_REFILL_PER_SECOND,
} from '../server/constants.mjs'
import { openRoomLog } from '../server/store/room-log.mjs'
import { startServer } from '../server/api/server.mjs'
import { createTokenBucketGate } from '../server/api/rate-gates.mjs'
import { BudgetStage } from '../server/api/pipeline.mjs'
import { loadOrCreateLocalToken } from '../server/api/local-token.mjs'
import { fingerprintFromPublicKey } from '../server/keys.mjs'
import { gateLimitsFromEnv } from '../server/api/server.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const PROTOCOL_KEY = 'agent-room-protocol'

const FINGERPRINT_A = `sha256:${'a'.repeat(64)}`
const FINGERPRINT_B = `sha256:${'b'.repeat(64)}`
const FINGERPRINT_C = `sha256:${'c'.repeat(64)}`

// Operator floors for wire tests that need throughput instead of throttling
// (deliberately far above the declared defaults — the gates still run, they
// just never refuse these workloads).
const FLOORS_OFF = Object.freeze({
  sendTokenRefillPerSecond: 1000,
  sendTokenCapacity: 1000,
  requestBudgetPerMinute: 60000,
  requestBudgetBurst: 1000,
})

const sleep = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })

function request(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = http.request(
      { host: '127.0.0.1', port, method, path, headers, agent: false },
      response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('error', rejectPromise)
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          resolvePromise({ status: response.statusCode, text, json: () => JSON.parse(text) })
        })
      },
    )
    req.on('error', rejectPromise)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

function sessioned(port, method, sessionToken, path, body) {
  return request(port, method, path, {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${sessionToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

function installation() {
  const { publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const raw = spki.subarray(spki.length - 32)
  return {
    publicKey: raw.toString('base64url'),
    fingerprint: fingerprintFromPublicKey(raw),
  }
}

async function startTestServer(t, options = {}) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-rate-gates-'))
  t.after(async () => {
    rmSync(dataDir, { recursive: true, force: true })
  })
  const server = await startServer({ dataDir, port: 0, ...options })
  t.after(async () => {
    await server.close()
  })
  return { server, port: server.port, dataDir }
}

// One installed, connected session with its Broadcast Room id and a bound
// sender (the chat_id attribution always mirrors the session's live Chat ID).
async function connectSession(port, dataDir, chatId) {
  const actor = installation()
  const auth = await request(port, 'POST', '/api/auth/local', {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${loadOrCreateLocalToken(dataDir)}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ public_key: actor.publicKey }),
  })
  assert.equal(auth.status, 200, auth.text)
  const sessionToken = auth.json().result.session_token
  const bound = await sessioned(port, 'POST', sessionToken, '/api/session', { chat_id: chatId })
  assert.equal(bound.status, 200, bound.text)
  const status = await sessioned(port, 'GET', sessionToken, '/api/status')
  assert.equal(status.status, 200, status.text)
  return {
    sessionToken,
    fingerprint: actor.fingerprint,
    chatId,
    broadcastRoomId: status.json().result.broadcast_room_id,
    send(roomId, clientMessageId, text, extra = {}) {
      return send(port, sessionToken, roomId, clientMessageId, text, { chat_id: chatId, ...extra })
    },
  }
}

async function send(port, sessionToken, roomId, clientMessageId, text, extra = {}) {
  return sessioned(port, 'POST', sessionToken, `/api/rooms/${roomId}/messages`, {
    chat_id: extra.chat_id ?? 'gatelab',
    client_message_id: clientMessageId,
    text,
    ...(extra.reply_to_seq === undefined ? {} : { reply_to_seq: extra.reply_to_seq }),
  })
}

// --- Isolated gate units (injectable clock) -----------------------------------------

test('the send bucket admits capacity 10 instantly, refuses the 11th with a delay, and refills at 0.5/s on the injected clock', () => {
  const now = { value: 0 }
  const gate = createTokenBucketGate({
    refillPerSecond: SEND_TOKEN_REFILL_PER_SECOND,
    capacity: SEND_TOKEN_CAPACITY,
    now: () => now.value,
  })
  for (let index = 0; index < SEND_TOKEN_CAPACITY; index += 1) {
    assert.deepEqual(gate.check('actor'), { ok: true }, `token ${index + 1} of the burst admits`)
  }
  const refusal = gate.check('actor')
  assert.equal(refusal.ok, false)
  assert.ok(Number.isSafeInteger(refusal.retryAfterMs) && refusal.retryAfterMs >= 1,
    'the refusal names a retry delay of at least 1 ms')
  assert.equal(refusal.retryAfterMs, 2000,
    'an empty bucket needs exactly one full refill period for the next token at 0.5/s')

  // Halfway to the next token the delay halves; at a full period the token
  // is there and the refusal becomes an admission.
  now.value = 1000
  assert.equal(gate.check('actor').ok, false, 'half a period in, the token is not there yet')
  now.value = 2000
  assert.equal(gate.check('actor').ok, true, 'a full period refills exactly one token')
  assert.equal(gate.check('actor').ok, false, 'and the bucket is empty again immediately after')
})

test('the request budget is the same mechanism at 120/min burst 30, and keys never share buckets', () => {
  const now = { value: 0 }
  const gate = createTokenBucketGate({
    refillPerSecond: REQUEST_BUDGET_PER_MINUTE / 60,
    capacity: REQUEST_BUDGET_BURST,
    now: () => now.value,
  })
  for (let index = 0; index < REQUEST_BUDGET_BURST; index += 1) {
    assert.deepEqual(gate.check('actor-a'), { ok: true }, `request ${index + 1} of the burst admits`)
  }
  const refusal = gate.check('actor-a')
  assert.equal(refusal.ok, false)
  assert.equal(refusal.retryAfterMs, 500,
    'at 2 tokens/s the next token is 500 ms away')
  assert.equal(gate.check('actor-b').ok, true, 'a different key draws its own full bucket')
  now.value = 500
  assert.equal(gate.check('actor-a').ok, true, 'the first key refills one token after 500 ms')
})

test('a bucket idle past its full-refill horizon sweeps to a fresh full bucket (sweep-expired, bounded state)', () => {
  const now = { value: 0 }
  const gate = createTokenBucketGate({ refillPerSecond: 1, capacity: 2, now: () => now.value })
  assert.equal(gate.check('k').ok, true)
  assert.equal(gate.check('k').ok, true)
  assert.equal(gate.check('k').ok, false)
  // Past the horizon (2 s at 1/s capacity 2) the entry is provably full
  // again: dropping it equals refilling it. An infinity of stale keys
  // cannot grow the map past the live horizon.
  now.value = 2001
  for (let index = 0; index < 50; index += 1) gate.check(`stale-${index}`)
  assert.equal(gate.check('k').ok, true, 'the swept key starts full again')
  now.value = 2002
  assert.equal(gate.check('stale-0').ok, true, 'an equally swept stale key behaves identically')
})

// --- The duplicate gate, store-isolated (injectable clock, in-transaction) ----------

function storeFixture(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-rate-gates-store-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const store = openRoomLog({ dataDir })
  t.after(() => store.close())
  const room = store.createBroadcastRoom({ actorFingerprint: FINGERPRINT_A, title: 'Gates' })
  const other = store.createBroadcastRoom({ actorFingerprint: FINGERPRINT_A, title: 'Other' })
  return { store, room, other }
}

test('the duplicate gate drops a new send repeating the same actor-room-text within the window, writes nothing, and names the original sequence', t => {
  const { store, room } = storeFixture(t)
  let nowMs = 1_000_000
  const first = store.appendMessage({
    roomId: room.id, actorFingerprint: FINGERPRINT_A, chatId: 'alice',
    clientMessageId: 'm-1', text: 'exactly this', nowMs,
  })
  assert.equal(first.duplicateDropped, false)
  assert.equal(first.message.seq, 1)

  nowMs += 1000
  const repeat = store.appendMessage({
    roomId: room.id, actorFingerprint: FINGERPRINT_A, chatId: 'alice',
    clientMessageId: 'm-2', text: 'exactly this', nowMs,
  })
  assert.equal(repeat.duplicateDropped, true, 'the repeat is the gate\'s explicit drop')
  assert.equal(repeat.duplicate, false, 'a drop is never mistaken for the idempotent retry')
  assert.equal(repeat.message, null, 'nothing was committed')
  assert.equal(repeat.original.seq, 1, 'the drop names the original sequence')
  assert.equal(repeat.original.client_message_id, 'm-1')

  // The store is untouched: still exactly one row, still head 1.
  assert.equal(store.readPage({ roomId: room.id, actorFingerprint: FINGERPRINT_A }).length, 1)
  assert.equal(store.headSeq(room.id, { actorFingerprint: FINGERPRINT_A }), 1)

  // A different text from the same actor commits normally.
  nowMs += 1000
  const fresh = store.appendMessage({
    roomId: room.id, actorFingerprint: FINGERPRINT_A, chatId: 'alice',
    clientMessageId: 'm-3', text: 'something else', nowMs,
  })
  assert.equal(fresh.duplicateDropped, false)
  assert.equal(fresh.message.seq, 2, 'the gate consumed no sequence')
})

test('the window boundary is exact and inclusive: a repeat exactly windowMs old is dropped, one millisecond later commits', t => {
  const { store, room } = storeFixture(t)
  const t0 = 2_000_000
  store.appendMessage({
    roomId: room.id, actorFingerprint: FINGERPRINT_A, chatId: 'alice',
    clientMessageId: 'w-0', text: 'boundary', nowMs: t0,
  })
  const atWindow = store.appendMessage({
    roomId: room.id, actorFingerprint: FINGERPRINT_A, chatId: 'alice',
    clientMessageId: 'w-1', text: 'boundary', nowMs: t0 + DUPLICATE_WINDOW_MS,
  })
  assert.equal(atWindow.duplicateDropped, true, 'the window is inclusive at its lower boundary')

  const pastWindow = store.appendMessage({
    roomId: room.id, actorFingerprint: FINGERPRINT_A, chatId: 'alice',
    clientMessageId: 'w-2', text: 'boundary', nowMs: t0 + DUPLICATE_WINDOW_MS + 1,
  })
  assert.equal(pastWindow.duplicateDropped, false, 'one millisecond past the window is a new send')
  assert.equal(pastWindow.message.seq, 2)
})

test('identical text in a different room, a different reply context, or from a different actor is not deduplicated', t => {
  const { store, room, other } = storeFixture(t)
  let nowMs = 3_000_000
  store.appendMessage({
    roomId: room.id, actorFingerprint: FINGERPRINT_A, chatId: 'alice',
    clientMessageId: 'd-0', text: 'same words', nowMs,
  })

  // Different room, same actor, same text, inside the window.
  const otherRoom = store.appendMessage({
    roomId: other.id, actorFingerprint: FINGERPRINT_A, chatId: 'alice',
    clientMessageId: 'd-1', text: 'same words', nowMs: nowMs + 10,
  })
  assert.equal(otherRoom.duplicateDropped, false, 'a different room is a different operation')
  assert.equal(otherRoom.message.seq, 1)

  // Same room, same text, different reply context (the original had none).
  const replied = store.appendMessage({
    roomId: room.id, actorFingerprint: FINGERPRINT_A, chatId: 'alice',
    clientMessageId: 'd-2', text: 'same words', replyToSeq: 1, nowMs: nowMs + 20,
  })
  assert.equal(replied.duplicateDropped, false, 'a different reply context is a different operation')
  assert.equal(replied.message.seq, 2)

  // Same room, same text, same (null) reply context, different actor.
  const otherActor = store.appendMessage({
    roomId: room.id, actorFingerprint: FINGERPRINT_B, chatId: 'bob',
    clientMessageId: 'd-3', text: 'same words', nowMs: nowMs + 30,
  })
  assert.equal(otherActor.duplicateDropped, false, 'another actor\'s identical text is their own send')
  assert.equal(otherActor.message.seq, 3)
})

test('the idempotency tuple is checked before the duplicate gate: an exact retry returns the original and a conflicting resend still conflicts, whatever the window holds', t => {
  const { store, room } = storeFixture(t)
  const t0 = 4_000_000
  const original = store.appendMessage({
    roomId: room.id, actorFingerprint: FINGERPRINT_A, chatId: 'alice',
    clientMessageId: 'i-1', text: 'the original', nowMs: t0,
  }).message

  // The exact retry — same tuple, same payload — is the idempotent path even
  // though a same-text message (this very one) sits inside the window.
  const retry = store.appendMessage({
    roomId: room.id, actorFingerprint: FINGERPRINT_A, chatId: 'alice',
    clientMessageId: 'i-1', text: 'the original', nowMs: t0 + 10,
  })
  assert.equal(retry.duplicate, true, 'the tuple short-circuits before the gate')
  assert.equal(retry.duplicateDropped, false, 'a retry is never duplicate_dropped')
  assert.equal(retry.message.seq, original.seq, 'the original comes back')

  // The conflicting resend — same tuple, different payload — is the coded
  // conflict, not a drop: idempotency owns the tuple.
  assert.throws(() => store.appendMessage({
    roomId: room.id, actorFingerprint: FINGERPRINT_A, chatId: 'alice',
    clientMessageId: 'i-1', text: 'a DIFFERENT payload', nowMs: t0 + 20,
  }), error => error.code === 'client_message_id_conflict')
})

test('the duplicate window is an open-time store configuration and the gate clock rides created_at', t => {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-rate-gates-window-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  const store = openRoomLog({ dataDir, duplicateWindowMs: 100 })
  t.after(() => store.close())
  const room = store.createBroadcastRoom({ actorFingerprint: FINGERPRINT_A, title: 'W' })
  store.appendMessage({
    roomId: room.id, actorFingerprint: FINGERPRINT_A, chatId: 'alice',
    clientMessageId: 't-1', text: 'tuned', nowMs: 50_000,
  })
  const inside = store.appendMessage({
    roomId: room.id, actorFingerprint: FINGERPRINT_A, chatId: 'alice',
    clientMessageId: 't-2', text: 'tuned', nowMs: 50_099,
  })
  assert.equal(inside.duplicateDropped, true, 'the tuned window applies')
  const outside = store.appendMessage({
    roomId: room.id, actorFingerprint: FINGERPRINT_A, chatId: 'alice',
    clientMessageId: 't-3', text: 'tuned', nowMs: 50_101,
  })
  assert.equal(outside.duplicateDropped, false, 'past the tuned window the send commits')
  assert.throws(() => openRoomLog({ dataDir: mkdtempSync(join(tmpdir(), 'agent-room-rate-gates-bad-')), duplicateWindowMs: 0 }),
    error => error.code === 'invalid_argument')
})

test('findIdempotentSend resolves the tuple for the gate probe and validates like every store read', t => {
  const { store, room } = storeFixture(t)
  store.appendMessage({
    roomId: room.id, actorFingerprint: FINGERPRINT_A, chatId: 'alice',
    clientMessageId: 'p-1', text: 'probe me', nowMs: 10,
  })
  const found = store.findIdempotentSend({
    roomId: room.id, actorFingerprint: FINGERPRINT_A, clientMessageId: 'p-1',
  })
  assert.equal(found.seq, 1)
  assert.equal(store.findIdempotentSend({
    roomId: room.id, actorFingerprint: FINGERPRINT_A, clientMessageId: 'missing',
  }), null)
  assert.equal(store.findIdempotentSend({
    roomId: room.id, actorFingerprint: FINGERPRINT_B, clientMessageId: 'p-1',
  }), null, 'the tuple is per actor')
  assert.throws(() => store.findIdempotentSend({
    roomId: room.id, actorFingerprint: 'not-a-fingerprint', clientMessageId: 'p-1',
  }), error => error.code === 'invalid_actor_id')
})

// --- The budgets stage, unit-level ---------------------------------------------------

function stageContext(overrides = {}) {
  return {
    method: 'GET',
    route: { path: '/api/status', class: 'actor', requestFields: [] },
    session: { actorFingerprint: FINGERPRINT_A, sessionKey: 'sk' },
    headers: {},
    query: {},
    params: {},
    body: undefined,
    store: undefined,
    ...overrides,
  }
}

test('the budgets stage counts every actor request at admission and answers refusals with the retry delay', async () => {
  const now = { value: 0 }
  const stage = new BudgetStage({
    requestBudgetGate: createTokenBucketGate({ refillPerSecond: 0.001, capacity: 2, now: () => now.value }),
  })
  assert.equal(await stage.process(stageContext()), undefined, 'request 1 admits')
  assert.equal(await stage.process(stageContext()), undefined, 'request 2 admits')
  const refusal = await stage.process(stageContext())
  assert.equal(refusal.ok, false)
  assert.equal(refusal.code, 'rate_limited')
  assert.equal(refusal.status, 429)
  assert.ok(refusal.retry_after_ms >= 1, 'the refusal carries its retry delay for the envelope')
  // Pre-auth and unkeyed contexts are not the request budget's concern.
  assert.equal(await stage.process(stageContext({ route: { path: '/api/auth/challenge', class: 'pre-auth' }, session: undefined })), undefined)
  assert.equal(await stage.process(stageContext({ session: undefined })), undefined)
})

test('the send-bucket gate probes the idempotency tuple before consuming: an existing tuple is admitted free from an empty bucket', async () => {
  const now = { value: 0 }
  const sendRoute = { path: '/api/rooms/:id/messages', class: 'actor', requestFields: ['chat_id', 'client_message_id', 'text', 'reply_to_seq'] }
  const bucket = createTokenBucketGate({ refillPerSecond: 0.001, capacity: 1, now: () => now.value })
  const stage = new BudgetStage({ sendBucketGate: bucket })
  // A real body stream: the send route's field read runs inside the stage,
  // exactly as it does on the wire.
  const sendContext = body => stageContext({
    method: 'POST',
    route: sendRoute,
    params: { id: 'room-1' },
    bodyStream: Readable.from([JSON.stringify(body)]),
    headers: { 'content-length': String(Buffer.byteLength(JSON.stringify(body))) },
  })

  // The one token goes to a new send.
  assert.equal(await stage.process(sendContext({ client_message_id: 'm-1' })), undefined)
  const refused = await stage.process(sendContext({ client_message_id: 'm-2' }))
  assert.equal(refused?.code, 'rate_limited', 'a new send finds the bucket empty')

  // A tuple the store already holds is a retry: admitted free, consuming
  // nothing — the next new send is refused exactly as before.
  const retryContext = sendContext({ client_message_id: 'm-1' })
  retryContext.store = {
    findIdempotentSend: ({ roomId, actorFingerprint, clientMessageId }) => {
      assert.equal(roomId, 'room-1')
      assert.equal(actorFingerprint, FINGERPRINT_A)
      assert.equal(clientMessageId, 'm-1')
      return { seq: 7 }
    },
  }
  assert.equal(await stage.process(retryContext), undefined, 'the retry passes free')
  assert.equal((await stage.process(sendContext({ client_message_id: 'm-3' })))?.code, 'rate_limited',
    'the retry consumed nothing — the bucket is still empty')

  // A missing client_message_id is not probeable: it consumes like any new
  // admission (and fails shape validation later, counted).
  assert.equal((await stage.process(sendContext({})))?.code, 'rate_limited')
})

// --- Over the wire: gate ordering, statuses, counting --------------------------------

test('ordering over the wire: an exact retry during a rate-limited period returns the original and consumes nothing; new sends stay refused with their delay', async t => {
  const { port, dataDir } = await startTestServer(t, {
    ...FLOORS_OFF,
    sendTokenCapacity: 2,
    sendTokenRefillPerSecond: 0.001,
  })
  const session = await connectSession(port, dataDir, 'gatelab-order')
  const roomId = session.broadcastRoomId

  const first = await session.send(roomId, 'ord-1', 'retry me')
  assert.equal(first.status, 200, first.text)
  const second = await session.send(roomId, 'ord-2', 'second send')
  assert.equal(second.status, 200, second.text)
  assert.equal(second.json().result.seq, 2)

  // The bucket (capacity 2) is empty: a NEW send is refused with its delay.
  const refused = await session.send(roomId, 'ord-3', 'third send')
  assert.equal(refused.status, 429, refused.text)
  assert.equal(refused.json().error.code, 'rate_limited')
  assert.ok(Number.isSafeInteger(refused.json().error.retry_after_ms) && refused.json().error.retry_after_ms >= 1,
    'the rate_limited envelope carries retry_after_ms')

  // The exact retry of the FIRST send rides the idempotency probe past the
  // empty bucket and returns the original, committed.
  const retry = await session.send(roomId, 'ord-1', 'retry me')
  assert.equal(retry.status, 200, retry.text)
  assert.equal(retry.json().result.status, 'committed')
  assert.equal(retry.json().result.seq, 1, 'the original sequence comes back')

  // The retry consumed nothing: a new send is STILL refused.
  const stillRefused = await session.send(roomId, 'ord-4', 'fourth send')
  assert.equal(stillRefused.status, 429, stillRefused.text)
  assert.equal(stillRefused.json().error.code, 'rate_limited')
})

test('duplicate_dropped over the wire: a 200 result naming original_seq, the store untouched, and different-room or different-reply sends commit', async t => {
  const { port, dataDir } = await startTestServer(t, FLOORS_OFF)
  const session = await connectSession(port, dataDir, 'gatelab-dup')
  const roomId = session.broadcastRoomId

  const first = await session.send(roomId, 'dup-1', 'the same words')
  assert.equal(first.status, 200, first.text)
  assert.deepEqual(first.json().result, { status: 'committed', seq: 1, room_id: roomId })

  const repeat = await session.send(roomId, 'dup-2', 'the same words')
  assert.equal(repeat.status, 200, repeat.text)
  assert.deepEqual(repeat.json().result, {
    status: 'duplicate_dropped',
    original_seq: 1,
    room_id: roomId,
  }, 'the drop is a normal result naming the original sequence')

  // The exact retry (same client_message_id) is NEVER duplicate_dropped: it
  // returns the original via the idempotency path.
  const idempotent = await session.send(roomId, 'dup-1', 'the same words')
  assert.deepEqual(idempotent.json().result, { status: 'committed', seq: 1, room_id: roomId })

  // The store is untouched by the drop: the log holds exactly the original.
  const page = await sessioned(port, 'GET', session.sessionToken, `/api/rooms/${roomId}/messages`)
  assert.deepEqual(page.json().result.messages.map(message => message.seq), [1])

  // A different reply context with the same text is a different operation.
  const replied = await session.send(roomId, 'dup-3', 'the same words', { reply_to_seq: 1 })
  assert.equal(replied.status, 200, replied.text)
  assert.deepEqual(replied.json().result, { status: 'committed', seq: 2, room_id: roomId })

  // A different room (the pair room with the session's own Actor) with the
  // same text is a different operation too.
  const opened = await sessioned(port, 'POST', session.sessionToken, '/api/rooms/direct', {
    chat_id: session.chatId,
    target_fingerprint: session.fingerprint,
  })
  assert.equal(opened.status, 200, opened.text)
  const pairRoomId = opened.json().result.room_id
  const otherRoom = await session.send(pairRoomId, 'dup-4', 'the same words')
  assert.equal(otherRoom.status, 200, otherRoom.text)
  assert.deepEqual(otherRoom.json().result, { status: 'committed', seq: 1, room_id: pairRoomId })
})

test('the request budget counts failed and replayed attempts, and a long-poll counts once at admission', async t => {
  const budgetTuned = Object.freeze({
    ...FLOORS_OFF,
    // The burst admits: bind, status, two failing sends, one read — and the
    // next request is over the burst (refill 1/min is zero at test pace).
    requestBudgetBurst: 5,
    requestBudgetPerMinute: 1,
  })
  const { port, dataDir } = await startTestServer(t, budgetTuned)
  const session = await connectSession(port, dataDir, 'gatelab-budget')
  const roomId = session.broadcastRoomId

  // Two FAILING sends (unknown room — 404s) and one good read exhaust the
  // burst: failures count at admission like everything else.
  const failed = await session.send('nosuchroom', 'fail-1', 'counts anyway')
  assert.equal(failed.status, 404, failed.text)
  const failedAgain = await session.send('nosuchroom', 'fail-1', 'counts anyway')
  assert.equal(failedAgain.status, 404, failedAgain.text)
  const read = await sessioned(port, 'GET', session.sessionToken, `/api/rooms/${roomId}/messages`)
  assert.equal(read.status, 200, read.text)

  const refused = await sessioned(port, 'GET', session.sessionToken, '/api/presence')
  assert.equal(refused.status, 429, refused.text)
  assert.equal(refused.json().error.code, 'rate_limited')
  assert.ok(refused.json().error.retry_after_ms >= 1)

  // A long-poll counts ONCE at admission, never per poll iteration: on a
  // fresh server with the same burst of 5, two 300 ms holds plus one read
  // consume exactly 5 tokens — per-iteration counting would demand more.
  const fresh = await startTestServer(t, budgetTuned)
  const freshSession = await connectSession(fresh.port, fresh.dataDir, 'gatelab-longpoll')
  for (let index = 0; index < 2; index += 1) {
    const held = await sessioned(fresh.port, 'GET', freshSession.sessionToken,
      `/api/rooms/${freshSession.broadcastRoomId}/messages?wait_ms=300`)
    assert.equal(held.status, 200, held.text)
  }
  const third = await sessioned(fresh.port, 'GET', freshSession.sessionToken, '/api/presence')
  assert.equal(third.status, 200, third.text)
  const fourth = await sessioned(fresh.port, 'GET', freshSession.sessionToken, '/api/presence')
  assert.equal(fourth.status, 429, 'the next request is over the burst — the holds counted once each')
})

test('the operator floors are honored: a tuned send capacity refuses, a tuned duplicate window rolls, and malformed overrides fail startup', async t => {
  // Send capacity 1 with a negligible refill: the second distinct send
  // within the window is refused — the tuned floor is the gate's law.
  const tuned = await startTestServer(t, {
    ...FLOORS_OFF,
    sendTokenCapacity: 1,
    sendTokenRefillPerSecond: 0.001,
  })
  const session = await connectSession(tuned.port, tuned.dataDir, 'gatelab-tuned')
  const roomId = session.broadcastRoomId
  const first = await session.send(roomId, 't-1', 'one')
  assert.equal(first.status, 200, first.text)
  const second = await session.send(roomId, 't-2', 'two')
  assert.equal(second.status, 429, second.text)
  assert.equal(second.json().error.code, 'rate_limited')

  // The tuned duplicate window (60 ms) rolls quickly: after it passes, the
  // same text under a new id commits (on a server whose send bucket is not
  // the knob under test).
  const windowTuned = await startTestServer(t, { ...FLOORS_OFF, duplicateWindowMs: 60 })
  const windowSession = await connectSession(windowTuned.port, windowTuned.dataDir, 'gatelab-window')
  const windowRoomId = windowSession.broadcastRoomId
  const inside = await windowSession.send(windowRoomId, 'w-1', 'one')
  assert.equal(inside.status, 200, inside.text)
  await sleep(120)
  const rolled = await windowSession.send(windowRoomId, 'w-2', 'one')
  assert.equal(rolled.status, 200, rolled.text)
  assert.equal(rolled.json().result.status, 'committed', 'the tuned window rolled')
  assert.equal(rolled.json().result.seq, 2)

  for (const bad of [
    { sendTokenRefillPerSecond: 0 },
    { sendTokenRefillPerSecond: 'fast' },
    { sendTokenCapacity: 0 },
    { sendTokenCapacity: 2.5 },
    { requestBudgetPerMinute: 0 },
    { requestBudgetBurst: -1 },
    { duplicateWindowMs: 0 },
  ]) {
    const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-rate-gates-invalid-'))
    try {
      await assert.rejects(
        () => startServer({ dataDir, port: 0, ...bad }),
        error => error.code === 'invalid_argument',
        JSON.stringify(bad),
      )
    } finally {
      rmSync(dataDir, { recursive: true, force: true })
    }
  }
})

test('the env surface parses the five operator floors strictly and falls back with a warning per junk value', () => {
  const parsed = gateLimitsFromEnv({
    AGENT_ROOM_SEND_TOKEN_REFILL_PER_SECOND: '25.5',
    AGENT_ROOM_SEND_TOKEN_CAPACITY: '40',
    AGENT_ROOM_REQUEST_BUDGET_PER_MINUTE: '240',
    AGENT_ROOM_REQUEST_BUDGET_BURST: '60',
    AGENT_ROOM_DUPLICATE_WINDOW_MS: '1000',
  })
  assert.deepEqual(parsed, {
    gateLimits: {
      sendTokenRefillPerSecond: 25.5,
      sendTokenCapacity: 40,
      requestBudgetPerMinute: 240,
      requestBudgetBurst: 60,
      duplicateWindowMs: 1000,
    },
    warnings: [],
  })

  const fallback = gateLimitsFromEnv({
    AGENT_ROOM_SEND_TOKEN_REFILL_PER_SECOND: 'fast',
    AGENT_ROOM_SEND_TOKEN_CAPACITY: '0',
    AGENT_ROOM_REQUEST_BUDGET_PER_MINUTE: '1.5',
    AGENT_ROOM_REQUEST_BUDGET_BURST: '-3',
    AGENT_ROOM_DUPLICATE_WINDOW_MS: 'soon',
  })
  assert.deepEqual(fallback.gateLimits, {
    sendTokenRefillPerSecond: SEND_TOKEN_REFILL_PER_SECOND,
    sendTokenCapacity: SEND_TOKEN_CAPACITY,
    requestBudgetPerMinute: REQUEST_BUDGET_PER_MINUTE,
    requestBudgetBurst: REQUEST_BUDGET_BURST,
    duplicateWindowMs: DUPLICATE_WINDOW_MS,
  })
  assert.equal(fallback.warnings.length, 5, 'each junk value warns once and falls back to its default')

  const silent = gateLimitsFromEnv({})
  assert.deepEqual(silent.warnings, [])
  assert.equal(silent.gateLimits.sendTokenRefillPerSecond, SEND_TOKEN_REFILL_PER_SECOND)
})

// --- NFR-5 executable: send p95 -------------------------------------------------------

test('send p95 stays within 150 ms server-side (end-to-end loopback p95 upper-bounds it), excluding admission-free retries', async t => {
  const { port, dataDir } = await startTestServer(t, FLOORS_OFF)
  const session = await connectSession(port, dataDir, 'gatelab-perf')
  const roomId = session.broadcastRoomId

  // Keep-alive agent: the measured population is server-side processing and
  // the loopback round trip, never connection setup.
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
  t.after(() => agent.destroy())
  const timedSend = (clientMessageId, text) => new Promise((resolvePromise, rejectPromise) => {
    const startedAt = performance.now()
    const req = http.request({
      host: '127.0.0.1', port, agent,
      method: 'POST',
      path: `/api/rooms/${roomId}/messages`,
      headers: {
        [PROTOCOL_KEY]: '1',
        authorization: `Bearer ${session.sessionToken}`,
        'content-type': 'application/json; charset=utf-8',
      },
    }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        resolvePromise({ elapsedMs: performance.now() - startedAt, status: response.statusCode, text })
      })
    })
    req.on('error', rejectPromise)
    req.end(JSON.stringify({ chat_id: session.chatId, client_message_id: clientMessageId, text }))
  })

  // Warmup drives JIT, page cache, and the WAL's steady state before the
  // measured window opens (the suite's warm-then-measure discipline).
  for (let index = 0; index < 20; index += 1) {
    const warm = await timedSend(`warm-${index}`, `warm ${index}`)
    assert.equal(warm.status, 200, warm.text)
  }

  const MEASURED = 200
  const samples = []
  for (let index = 0; index < MEASURED; index += 1) {
    const sample = await timedSend(`perf-${index}`, `perf payload ${index}`)
    assert.equal(sample.status, 200, sample.text)
    assert.equal(JSON.parse(sample.text).result.status, 'committed')
    samples.push(sample.elapsedMs)
  }
  samples.sort((left, right) => left - right)
  const p95 = samples[Math.ceil(0.95 * samples.length) - 1]
  const p50 = samples[Math.floor(samples.length / 2)]
  t.diagnostic(`send latency over ${MEASURED} committed sends: p50=${p50.toFixed(2)}ms p95=${p95.toFixed(2)}ms max=${samples[samples.length - 1].toFixed(2)}ms`)
  assert.ok(p95 <= 150, `send p95 ${p95.toFixed(2)}ms must stay within 150 ms (NFR-5; includes the loopback RTT, so server-side processing is within it a fortiori)`)
})
