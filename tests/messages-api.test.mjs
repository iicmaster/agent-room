// Story 1.7 acceptance: the messages pair — GET /api/rooms/:id/messages
// (long-poll read) and POST /api/rooms/:id/messages (idempotent append).
// Every matrix row runs against real spawned server children. The rows cover
// the long-poll (a message arriving mid-hold returns immediately with
// next_after_seq/head_seq; silence runs out to a normal possibly-empty page —
// never 204, never an error; holds above the 20 s cap are refused 400), the
// send statuses (committed / identical resend returns the original / coded
// client_message_id_conflict), the read semantics (strictly-greater
// after_seq, page bound, contiguous room-local sequences, head_seq), the
// member ACL on the pair room (third Actors denied by the store), and the
// NFR-3 attribution rule (the sender Chat ID always comes from the session's
// live row, never from the caller's hands).

import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import http from 'node:http'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { DatabaseSync } from 'node:sqlite'

import {
  MESSAGE_TEXT_MAX,
  READ_HOLD_MAX_MS,
  READ_PAGE_DEFAULT,
  READ_PAGE_MAX,
} from '../server/constants.mjs'
import { loadOrCreateLocalToken } from '../server/api/local-token.mjs'
import { fingerprintFromPublicKey } from '../server/keys.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = join(ROOT, 'server', 'api', 'server.mjs')
const RUNTIME_RECORD_FILENAME = 'runtime.json'
const PROTOCOL_KEY = 'agent-room-protocol'

const sleep = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })

function installation() {
  const { publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const raw = spki.subarray(spki.length - 32)
  return {
    raw,
    publicKey: raw.toString('base64url'),
    fingerprint: fingerprintFromPublicKey(raw),
  }
}

function makeDataDir(t) {
  const dataDir = mkdtempSync(join(tmpdir(), 'agent-room-messages-api-'))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  return dataDir
}

function spawnServerChild(t, dataDir) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, AGENT_ROOM_DATA_DIR: dataDir },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stderrChunks = []
  child.stderr.on('data', chunk => stderrChunks.push(chunk))
  const stderrText = () => Buffer.concat(stderrChunks).toString('utf8')
  const runtimePath = join(dataDir, RUNTIME_RECORD_FILENAME)

  const waitReady = async () => {
    const deadline = Date.now() + 10 * 1000
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`server child exited early (code=${child.exitCode}); stderr: ${stderrText()}`)
      }
      if (existsSync(runtimePath)) {
        try {
          const record = JSON.parse(readFileSync(runtimePath, 'utf8'))
          if (Number.isInteger(record.port) && record.port > 0) return record
        } catch {
          // Atomic rename means readers never see partial files; retry anyway.
        }
      }
      if (Date.now() > deadline) {
        throw new Error(`server child never wrote runtime.json; stderr: ${stderrText()}`)
      }
      await sleep(25)
    }
  }

  const stop = async () => {
    if (child.exitCode !== null || child.signalCode !== null) return
    child.kill('SIGTERM')
    await once(child, 'exit')
  }

  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit').catch(() => {})
    }
  })

  return { child, waitReady, stop, stderrText }
}

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
          resolvePromise({
            status: response.statusCode,
            headers: response.headers,
            text,
            json: () => JSON.parse(text),
          })
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

async function connectInstallation(port, localToken, installation_, chatId) {
  const auth = await request(port, 'POST', '/api/auth/local', {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${localToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ public_key: installation_.publicKey }),
  })
  assert.equal(auth.status, 200, auth.text)
  const sessionToken = auth.json().result.session_token
  const connected = await sessioned(port, 'POST', sessionToken, '/api/session', { chat_id: chatId })
  assert.equal(connected.status, 200, connected.text)
  return { sessionToken, fingerprint: installation_.fingerprint }
}

// Open a pair room between two connected installations via the frozen route.
async function openPairRoom(port, openerToken, peerChatId, targetFingerprint) {
  const opened = await sessioned(port, 'POST', openerToken, '/api/rooms/direct', {
    chat_id: peerChatId,
    ...(targetFingerprint === undefined ? {} : { target_fingerprint: targetFingerprint }),
  })
  assert.equal(opened.status, 200, opened.text)
  return opened.json().result.room_id
}

async function send(port, sessionToken, roomId, clientMessageId, text, extra = {}) {
  return sessioned(port, 'POST', sessionToken, `/api/rooms/${roomId}/messages`, {
    chat_id: extra.chat_id ?? 'Alice',
    client_message_id: clientMessageId,
    text,
    ...(extra.reply_to_seq === undefined ? {} : { reply_to_seq: extra.reply_to_seq }),
  })
}

// --- The long-poll read ------------------------------------------------------------

test('long-poll returns the moment a message lands, with correct next_after_seq and head_seq', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const peer = installation()

  const aliceSession = await connectInstallation(record.port, localToken, alice, 'Alice')
  const peerSession = await connectInstallation(record.port, localToken, peer, 'Peer')
  const roomId = await openPairRoom(record.port, aliceSession.sessionToken, 'Peer')

  // Silence first: a short hold returns an empty page quickly, proving the
  // loop works before we test the wake-up.
  const silentStart = Date.now()
  const silent = await sessioned(record.port, 'GET', aliceSession.sessionToken,
    `/api/rooms/${roomId}/messages?after_seq=0&wait_ms=250`)
  const silentElapsed = Date.now() - silentStart
  assert.equal(silent.status, 200, silent.text)
  assert.equal(silent.json().ok, true, 'a deadline return is a normal page, never 204, never an error')
  assert.deepEqual(silent.json().result.messages, [])
  assert.equal(silent.json().result.next_after_seq, 0, 'an empty page resumes from the requested cursor')
  assert.equal(silent.json().result.head_seq, 0, 'an empty room has head 0')
  // The wake-up sleep clamps to the remaining hold time, so the response
  // lands within the requested wait, never a full extra poll past it.
  assert.ok(silentElapsed >= 250 && silentElapsed < 1000, `held for the deadline, took ${silentElapsed}ms`)

  // Hold with a mid-flight arrival: the peer sends ~150ms in; the read must
  // return with the message well before the hold expires.
  const holdStart = Date.now()
  const holding = sessioned(record.port, 'GET', aliceSession.sessionToken,
    `/api/rooms/${roomId}/messages?after_seq=0&wait_ms=8000`)
  await sleep(150)
  const sent = await send(record.port, peerSession.sessionToken, roomId, 'p-1', 'hello from Peer', { chat_id: 'Peer' })
  assert.equal(sent.status, 200, sent.text)
  const woke = await holding
  const wokeElapsed = Date.now() - holdStart
  assert.equal(woke.status, 200, woke.text)
  const page = woke.json().result
  assert.equal(page.messages.length, 1)
  assert.equal(page.messages[0].seq, 1)
  assert.equal(page.messages[0].text, 'hello from Peer')
  assert.equal(page.messages[0].chat_id, 'Peer', 'attribution is the sender\'s live display form')
  assert.equal(page.next_after_seq, 1)
  assert.equal(page.head_seq, 1)
  assert.ok(wokeElapsed < 5 * 1000, `woke on arrival, took ${wokeElapsed}ms`)

  await stop()
})

test('a deadline return is a normal possibly-empty page; the hold cap is refused 400', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const peer = installation()

  const aliceSession = await connectInstallation(record.port, localToken, alice, 'Alice')
  const peerSession = await connectInstallation(record.port, localToken, peer, 'Peer')
  const roomId = await openPairRoom(record.port, aliceSession.sessionToken, 'Peer')

  // Deadline with prior traffic: the page may carry older messages — the
  // cursor semantics, not silence, decide emptiness.
  await send(record.port, peerSession.sessionToken, roomId, 'p-1', 'earlier', { chat_id: 'Peer' })
  const exhausted = await sessioned(record.port, 'GET', aliceSession.sessionToken,
    `/api/rooms/${roomId}/messages?after_seq=1&wait_ms=300`)
  assert.equal(exhausted.status, 200, exhausted.text)
  assert.deepEqual(exhausted.json().result.messages, [])
  assert.equal(exhausted.json().result.next_after_seq, 1, 'an empty page never moves the cursor backwards')
  assert.equal(exhausted.json().result.head_seq, 1, 'head_seq reports the room\'s largest seq')

  // Holds above the cap are refused before any waiting, with the hold's own
  // coded shape error.
  const overCap = await sessioned(record.port, 'GET', aliceSession.sessionToken,
    `/api/rooms/${roomId}/messages?wait_ms=${READ_HOLD_MAX_MS + 5_000}`)
  assert.equal(overCap.status, 400, overCap.text)
  assert.equal(overCap.json().error.code, 'invalid_wait_ms')

  // Malformed bounds are coded, never lenient — and an empty-string param is
  // junk like any other, never silently defaulted.
  for (const query of ['after_seq=-1', 'after_seq=abc', 'after_seq=', 'limit=0', `limit=${READ_PAGE_MAX + 1}`, 'limit=', 'wait_ms=-1', 'wait_ms=nope', 'wait_ms=']) {
    const refused = await sessioned(record.port, 'GET', aliceSession.sessionToken,
      `/api/rooms/${roomId}/messages?${query}`)
    assert.equal(refused.status, 400, query)
    assert.ok(
      ['invalid_cursor', 'invalid_limit', 'invalid_wait_ms'].includes(refused.json().error.code),
      `${query} -> ${refused.json().error.code}`,
    )
  }
  // The empty hold param names the wait code, not a generic shape error.
  const emptyHold = await sessioned(record.port, 'GET', aliceSession.sessionToken,
    `/api/rooms/${roomId}/messages?wait_ms=`)
  assert.equal(emptyHold.json().error.code, 'invalid_wait_ms')

  // Unknown query fields are rejected, not ignored.
  const unknownField = await sessioned(record.port, 'GET', aliceSession.sessionToken,
    `/api/rooms/${roomId}/messages?after_seq=0&cursor=5`)
  assert.equal(unknownField.status, 400)
  assert.equal(unknownField.json().error.code, 'unknown_field')
  assert.match(unknownField.json().error.message, /"cursor"/)

  await stop()
})

// --- Send statuses -----------------------------------------------------------------

test('send is idempotent: a matching resend returns the original; a conflicting payload is a coded conflict', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const peer = installation()

  const aliceSession = await connectInstallation(record.port, localToken, alice, 'Alice')
  const peerSession = await connectInstallation(record.port, localToken, peer, 'Peer')
  const roomId = await openPairRoom(record.port, aliceSession.sessionToken, 'Peer')

  const first = await send(record.port, aliceSession.sessionToken, roomId, 'a-1', 'hello')
  assert.equal(first.status, 200, first.text)
  const firstResult = first.json().result
  assert.deepEqual(Object.keys(firstResult).sort(), ['room_id', 'seq', 'status'])
  assert.equal(firstResult.status, 'committed')
  assert.equal(firstResult.seq, 1, 'room-local sequences are contiguous from 1')

  // Identical resend (the outcome_unknown resolution): the ORIGINAL, same seq.
  const resend = await send(record.port, aliceSession.sessionToken, roomId, 'a-1', 'hello')
  assert.equal(resend.status, 200, resend.text)
  assert.deepEqual(resend.json().result, firstResult)

  // Conflicting payload on the same client_message_id: coded 409, and the
  // stored message is untouched.
  const conflict = await send(record.port, aliceSession.sessionToken, roomId, 'a-1', 'something else')
  assert.equal(conflict.status, 409, conflict.text)
  assert.equal(conflict.json().error.code, 'client_message_id_conflict')
  assert.match(conflict.json().error.message, /different message payload/)

  const reread = await sessioned(record.port, 'GET', aliceSession.sessionToken,
    `/api/rooms/${roomId}/messages?after_seq=0`)
  assert.equal(reread.json().result.messages.length, 1, 'the conflict appended nothing')
  assert.equal(reread.json().result.messages[0].text, 'hello')

  // Text bound: the constants module owns the limit; oversized text is coded.
  const oversized = await send(record.port, aliceSession.sessionToken, roomId, 'a-big', 'x'.repeat(MESSAGE_TEXT_MAX + 1))
  assert.equal(oversized.status, 400)
  assert.equal(oversized.json().error.code, 'invalid_text')

  // Reply targets resolve room-locally; a foreign target is coded.
  const peerRoomId = await openPairRoom(record.port, peerSession.sessionToken, 'Alice')
  assert.equal(peerRoomId, roomId, 'the pair is the same room from either side')
  const reply = await send(record.port, aliceSession.sessionToken, roomId, 'a-2', 'replying', { reply_to_seq: 1 })
  assert.equal(reply.status, 200, reply.text)
  assert.equal(reply.json().result.seq, 2)

  await stop()
})

test('NFR-3 attribution: the sender Chat ID comes from the session, never from the caller\'s hands', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const peer = installation()

  const aliceSession = await connectInstallation(record.port, localToken, alice, 'Alice')
  await connectInstallation(record.port, localToken, peer, 'Peer')
  const roomId = await openPairRoom(record.port, aliceSession.sessionToken, 'Peer')

  // A send attributing another agent's name is refused — the body's chat_id
  // must match the session's live Chat ID.
  const spoofed = await sessioned(record.port, 'POST', aliceSession.sessionToken,
    `/api/rooms/${roomId}/messages`, {
      chat_id: 'Peer',
      client_message_id: 'spoof-1',
      text: 'pretending to be Peer',
    })
  assert.equal(spoofed.status, 400, spoofed.text)
  assert.equal(spoofed.json().error.code, 'invalid_request')
  assert.match(spoofed.json().error.message, /does not match/)

  // Case-insensitive match is accepted, and the live display form is what
  // history keeps.
  const recased = await sessioned(record.port, 'POST', aliceSession.sessionToken,
    `/api/rooms/${roomId}/messages`, { chat_id: 'ALICE', client_message_id: 'a-1', text: 'hi' })
  assert.equal(recased.status, 200, recased.text)
  const page = await sessioned(record.port, 'GET', aliceSession.sessionToken,
    `/api/rooms/${roomId}/messages?after_seq=0`)
  assert.equal(page.json().result.messages[0].chat_id, 'Alice', 'attribution is the live display form')

  // A session that never connected a Chat ID cannot send at all.
  const unbound = await request(record.port, 'POST', '/api/auth/local', {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${loadOrCreateLocalToken(dataDir)}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ public_key: installation().publicKey }),
  })
  const unboundToken = unbound.json().result.session_token
  const noChat = await sessioned(record.port, 'POST', unboundToken,
    `/api/rooms/${roomId}/messages`, { chat_id: '', client_message_id: 'x-1', text: 'hi' })
  assert.equal(noChat.status, 400, noChat.text)
  assert.equal(noChat.json().error.code, 'invalid_request')
  assert.match(noChat.json().error.message, /chat_id is required/)
  const unconnected = await sessioned(record.port, 'POST', unboundToken,
    `/api/rooms/${roomId}/messages`, { chat_id: 'Stranger', client_message_id: 'x-2', text: 'hi' })
  assert.equal(unconnected.status, 400, unconnected.text)
  assert.match(unconnected.json().error.message, /connected Chat ID/)

  await stop()
})

// --- Read semantics & ACL -----------------------------------------------------------

test('pages are strictly-greater, bounded, contiguous, and head_seq tracks the room', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const peer = installation()

  const aliceSession = await connectInstallation(record.port, localToken, alice, 'Alice')
  const peerSession = await connectInstallation(record.port, localToken, peer, 'Peer')
  const roomId = await openPairRoom(record.port, aliceSession.sessionToken, 'Peer')

  for (const [id, text] of [['a-1', 'one'], ['p-1', 'two'], ['a-2', 'three']]) {
    const sender = id.startsWith('a') ? aliceSession : peerSession
    const chatId = id.startsWith('a') ? 'Alice' : 'Peer'
    const sent = await send(record.port, sender.sessionToken, roomId, id, text, { chat_id: chatId })
    assert.equal(sent.status, 200, sent.text)
  }

  // Strictly-greater cursor: after_seq=1 excludes seq 1.
  const after = await sessioned(record.port, 'GET', aliceSession.sessionToken,
    `/api/rooms/${roomId}/messages?after_seq=1`)
  assert.deepEqual(after.json().result.messages.map(message => message.seq), [2, 3])
  assert.equal(after.json().result.next_after_seq, 3)
  assert.equal(after.json().result.head_seq, 3)

  // The page bound is honored.
  const paged = await sessioned(record.port, 'GET', aliceSession.sessionToken,
    `/api/rooms/${roomId}/messages?after_seq=0&limit=2`)
  assert.deepEqual(paged.json().result.messages.map(message => message.seq), [1, 2])
  assert.equal(paged.json().result.next_after_seq, 2)

  // Omitted params fall back to the declared defaults.
  const defaulted = await sessioned(record.port, 'GET', aliceSession.sessionToken,
    `/api/rooms/${roomId}/messages`)
  assert.deepEqual(defaulted.json().result.messages.map(message => message.seq), [1, 2, 3])
  const defaultLimit = await sessioned(record.port, 'GET', aliceSession.sessionToken,
    `/api/rooms/${roomId}/messages?after_seq=0&limit=${READ_PAGE_DEFAULT}`)
  assert.equal(defaultLimit.status, 200)

  // The response shape stays inside the frozen vocabulary names.
  const shape = defaulted.json().result
  assert.deepEqual(Object.keys(shape).sort(), ['head_seq', 'messages', 'next_after_seq'])
  assert.deepEqual(
    Object.keys(shape.messages[0]).sort(),
    ['actor_fingerprint', 'chat_id', 'client_message_id', 'created_at', 'reply_to_seq', 'room_id', 'seq', 'text'],
  )
  assert.equal(shape.messages[0].actor_fingerprint, alice.fingerprint)

  await stop()
})

test('member ACL: a third Actor is denied the pair room by the store; missing rooms are coded', async t => {
  const dataDir = makeDataDir(t)
  const { waitReady, stop } = spawnServerChild(t, dataDir)
  const record = await waitReady()
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const peer = installation()
  const eavesdropper = installation()

  const aliceSession = await connectInstallation(record.port, localToken, alice, 'Alice')
  await connectInstallation(record.port, localToken, peer, 'Peer')
  const eavesSession = await connectInstallation(record.port, localToken, eavesdropper, 'Eaves')
  const roomId = await openPairRoom(record.port, aliceSession.sessionToken, 'Peer')
  await send(record.port, aliceSession.sessionToken, roomId, 'a-1', 'private', { chat_id: 'Alice' })

  // Read denied.
  const readDenied = await sessioned(record.port, 'GET', eavesSession.sessionToken,
    `/api/rooms/${roomId}/messages?after_seq=0`)
  assert.equal(readDenied.status, 403, readDenied.text)
  assert.equal(readDenied.json().error.code, 'actor_not_member')

  // Append denied.
  const writeDenied = await send(record.port, eavesSession.sessionToken, roomId, 'e-1', 'let me in', { chat_id: 'Eaves' })
  assert.equal(writeDenied.status, 403, writeDenied.text)
  assert.equal(writeDenied.json().error.code, 'actor_not_member')

  // Coded room handling: unknown and malformed ids.
  const missing = await sessioned(record.port, 'GET', aliceSession.sessionToken,
    `/api/rooms/${'z'.repeat(22)}/messages?after_seq=0`)
  assert.equal(missing.status, 404, missing.text)
  assert.equal(missing.json().error.code, 'room_not_found')
  const malformed = await sessioned(record.port, 'GET', aliceSession.sessionToken,
    '/api/rooms/bad%20id/messages?after_seq=0')
  assert.equal(malformed.status, 400, malformed.text)
  assert.equal(malformed.json().error.code, 'invalid_room_id')

  await stop()
})
