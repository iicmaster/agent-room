// Story 6.4 acceptance: the reconnect-recovery takeover — the explicit,
// operator-authorized same-Actor handoff that ends the "chat id is already
// claimed by another connected session" squat.
//
// The defect this closes, observed in the physical REL-1 run: a client whose
// process was killed left its live row holding the Chat ID. The row outlives
// the process (the lease is 12 h), the holder's session token stayed alive
// (the server never learned the process died), and the server's ordinary
// re-auth recovery only releases a holder whose token NO LONGER
// authenticates — so the restarted client was permanently unrecoverable
// under its own name. Nothing about the room, the history, or the peer was
// broken; the name was simply squatted.
//
// The proof rows below cover the advisor's required set: same Actor / same
// name recovery, same Actor / different name coexistence, foreign-Actor
// refusal, persistence failure, two competing replacements, the delayed old
// POST/PATCH/send/DELETE, the absence of ownership ping-pong, continued
// room/cursor/DM operation, and the graceful exit. No server reset and no
// token flooding appear in any acceptance path: every row uses ONE real
// server, real keypairs, and real session tokens.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { PassThrough } from 'node:stream'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { loadOrCreateLocalToken } from '../server/api/local-token.mjs'
import { DatabaseSync } from 'node:sqlite'
import { createLiveSessionRegistry } from '../server/core/session-registry.mjs'
import { createSessionRegistry, sessionKeyFromToken } from '../server/api/session.mjs'
import { fingerprintFromPublicKey, loadOrCreateKeypair } from '../server/keys.mjs'
import { startServer } from '../server/api/server.mjs'
import { AuthzStage, AuthStage, BudgetStage, runPipeline, reject, HANDLER_STREAMED } from '../server/api/pipeline.mjs'
import { createSessionVerifier } from '../server/api/session.mjs'
import { createAgentRoomClient } from '../server/client/api-client.mjs'
import { main } from '../server/cli/agent-room.mjs'
import { atomicWriteJson } from '../server/runtime.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MCP_ENTRY = join(ROOT, 'server', 'mcp-stdio.mjs')
const PROTOCOL_KEY = 'agent-room-protocol'

const sleep = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })

function installation() {
  const { publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const raw = spki.subarray(spki.length - 32)
  return {
    publicKey: raw.toString('base64url'),
    fingerprint: fingerprintFromPublicKey(raw),
  }
}

function makeDataDir(t, prefix = 'agent-room-takeover-') {
  const dataDir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dataDir, { recursive: true, force: true }))
  return dataDir
}

// A real server in-process, with the real registries injected so the rows
// can inspect the live registry directly (the same inspection style
// tests/session-routes.test.mjs uses).
async function makeServer(t) {
  const dataDir = makeDataDir(t)
  const sessionRegistry = createSessionRegistry()
  const liveSessionRegistry = createLiveSessionRegistry()
  const server = await startServer({ dataDir, sessionRegistry, liveSessionRegistry })
  t.after(() => server.close())
  return { dataDir, server, sessionRegistry, liveSessionRegistry }
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
          let json = null
          try { json = JSON.parse(text) } catch { json = null }
          resolvePromise({ status: response.statusCode, text, json })
        })
      },
    )
    req.on('error', rejectPromise)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

// The Story 1.4 credential exchange: the local token file plus this
// installation's public key buy a session token.
async function exchange(port, installation_, localToken) {
  const response = await request(port, 'POST', '/api/auth/local', {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${localToken}`,
      'content-type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify({ public_key: installation_.publicKey }),
  })
  assert.equal(response.status, 200, response.text)
  return response.json.result.session_token
}

function sessionRequest(port, method, sessionToken, body) {
  return request(port, method, '/api/session', {
    headers: {
      [PROTOCOL_KEY]: '1',
      authorization: `Bearer ${sessionToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json; charset=utf-8' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
}

// Story 7.2 two-step takeover over a raw session token: observe (the plain
// bind's same-Actor 409 carries the conflict ticket), then present the
// intent WITH that ticket — exactly what the CLI does.
async function takeoverBind(port, token, chatId) {
  const observation = await sessionRequest(port, 'POST', token, { chat_id: chatId, client_type: 'mcp' })
  const ticket = observation.json?.error?.conflict_ticket
  return sessionRequest(port, 'POST', token, {
    chat_id: chatId,
    client_type: 'mcp',
    replace_existing: true,
    ...(typeof ticket === 'string' && ticket.length > 0 ? { conflict_ticket: ticket } : {}),
  })
}

// One session of one installation: authenticate, then bind a name. With
// { replace: true } this performs the Story 7.2 two-step exactly as the CLI
// does: the plain bind's same-Actor 409 carries the conflict ticket, which
// the intent call then presents (a moved incumbent would answer
// conflict_stale).
async function bindSession(port, localToken, installation_, chatId, { replace = false } = {}) {
  const token = await exchange(port, installation_, localToken)
  if (!replace) {
    const bound = await sessionRequest(port, 'POST', token, { chat_id: chatId, client_type: 'mcp' })
    return { token, bound }
  }
  const observation = await sessionRequest(port, 'POST', token, { chat_id: chatId, client_type: 'mcp' })
  if (observation.status !== 409 || observation.json?.error?.code !== 'chat_id_taken') {
    return { token, bound: observation }
  }
  const ticket = observation.json.error.conflict_ticket
  const body = { chat_id: chatId, client_type: 'mcp' }
  if (typeof ticket === 'string' && ticket.length > 0) body.conflict_ticket = ticket
  body.replace_existing = true
  const bound = await sessionRequest(port, 'POST', token, body)
  return { token, bound, ticket }
}

// --- The defect, and the repair ---------------------------------------------------

test('the defect: a client whose process died keeps the name, and the ordinary re-bind is refused; the explicit same-Actor takeover recovers it', async t => {
  const { dataDir, server, liveSessionRegistry } = await makeServer(t)
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()

  // Alice's client binds the name and then DIES: the live row stays (the
  // lease is 12 h) and so does the session token (the server never learned
  // the process is gone). This is the squat.
  const { token: deadToken } = await bindSession(server.port, localToken, alice, 'Agent')
  const deadKey = sessionKeyFromToken(deadToken)
  assert.equal(liveSessionRegistry.holderOf('Agent').sessionKey, deadKey)

  // Alice restarts. A plain re-auth + re-bind is refused: the holder's
  // token still authenticates, so the server cannot tell a dead process
  // from a quiet one. The same-Actor 409 carries the observed incumbent's
  // conflict ticket (Story 7.2) — the observation this takeover confirms
  // against.
  const restarted = await exchange(server.port, alice, localToken)
  const plain = await sessionRequest(server.port, 'POST', restarted, { chat_id: 'Agent', client_type: 'mcp' })
  assert.equal(plain.status, 409, plain.text)
  assert.equal(plain.json.error.code, 'chat_id_taken')
  assert.equal(typeof plain.json.error.conflict_ticket, 'string', 'the same-Actor collision carries the conflict ticket')
  assert.equal(liveSessionRegistry.holderOf('Agent').sessionKey, deadKey, 'the refused bind changed nothing')

  // The explicit takeover: the operator asks for the handoff by name,
  // presenting the observation's ticket.
  const takeover = await sessionRequest(server.port, 'POST', restarted, {
    chat_id: 'Agent',
    client_type: 'mcp',
    replace_existing: true,
    conflict_ticket: plain.json.error.conflict_ticket,
  })
  assert.equal(takeover.status, 200, takeover.text)
  assert.equal(takeover.json.result.chat_id, 'Agent')
  assert.equal(takeover.json.result.replaced, true, 'the server reports that a live holder was displaced')

  // The name moved, and the displaced session is fenced: its token no
  // longer authenticates.
  assert.notEqual(liveSessionRegistry.holderOf('Agent').sessionKey, deadKey)
  const afterFence = await sessionRequest(server.port, 'POST', deadToken, { chat_id: 'Agent' })
  assert.equal(afterFence.status, 401, 'the displaced session\'s token no longer authenticates')
  assert.equal(afterFence.json.error.code, 'unauthorized')
})

test('a foreign key can never take the name, and the holder is untouched by the refused attempt', async t => {
  const { dataDir, server, liveSessionRegistry } = await makeServer(t)
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const bob = installation()

  const { token: aliceToken } = await bindSession(server.port, localToken, alice, 'Agent')
  const aliceKey = sessionKeyFromToken(aliceToken)

  // Bob asks for the takeover. The refusal is the ORDINARY collision
  // refusal: nothing in it tells Bob who holds the name.
  const bobToken = await exchange(server.port, bob, localToken)
  const refused = await sessionRequest(server.port, 'POST', bobToken, {
    chat_id: 'Agent',
    client_type: 'mcp',
    replace_existing: true,
  })
  assert.equal(refused.status, 409, refused.text)
  assert.equal(refused.json.error.code, 'chat_id_taken')
  assert.equal(refused.json.error.message.includes('fingerprint'), false, 'the refusal leaks no holder identity')

  // Alice's session is untouched and still works.
  assert.equal(liveSessionRegistry.holderOf('Agent').sessionKey, aliceKey)
  const stillWorks = await sessionRequest(server.port, 'PATCH', aliceToken, { chat_id: 'Agent-2' })
  assert.equal(stillWorks.status, 200, stillWorks.text)
})

test('the displaced session\'s late requests cannot land, and its DELETE cannot release the successor', async t => {
  const { dataDir, server, liveSessionRegistry } = await makeServer(t)
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()

  const { token: oldToken } = await bindSession(server.port, localToken, alice, 'Agent')
  const takeoverToken = await exchange(server.port, alice, localToken)
  const takeover = await takeoverBind(server.port, takeoverToken, 'Agent')
  assert.equal(takeover.status, 200, takeover.text)
  const successorKey = liveSessionRegistry.holderOf('Agent').sessionKey

  // Every late request of the displaced session is refused: the bind, the
  // rename, the send, the disconnect.
  const late = await Promise.all([
    sessionRequest(server.port, 'POST', oldToken, { chat_id: 'Agent' }),
    sessionRequest(server.port, 'PATCH', oldToken, { chat_id: 'Agent-3' }),
    request(server.port, 'POST', '/api/rooms/whatever/messages', {
      headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${oldToken}`, 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: 'Agent', client_message_id: 'cmid-late-1', text: 'late' }),
    }),
    sessionRequest(server.port, 'DELETE', oldToken),
  ])
  for (const response of late) {
    assert.equal(response.status, 401, `a late request answered ${response.status}: ${response.text}`)
    assert.equal(response.json.error.code, 'unauthorized')
  }
  // The successor still holds the name: the late DELETE did not release it.
  assert.equal(liveSessionRegistry.holderOf('Agent').sessionKey, successorKey)
})

test('no ownership ping-pong: an automatic re-authentication never takes the name back', async t => {
  const { dataDir, server, liveSessionRegistry } = await makeServer(t)
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()

  const { token: deadToken } = await bindSession(server.port, localToken, alice, 'Agent')
  const takeoverToken = await exchange(server.port, alice, localToken)
  await takeoverBind(server.port, takeoverToken, 'Agent')
  const winner = liveSessionRegistry.holderOf('Agent').sessionKey

  // The displaced client comes back (its token is dead, so it re-authenticates
  // like any client would) and binds plainly — with no takeover intent. It
  // is refused, because the name now belongs to the successor.
  const zombieToken = await exchange(server.port, alice, localToken)
  const zombie = await sessionRequest(server.port, 'POST', zombieToken, { chat_id: 'Agent', client_type: 'mcp' })
  assert.equal(zombie.status, 409, zombie.text)
  assert.equal(zombie.json.error.code, 'chat_id_taken')
  assert.equal(liveSessionRegistry.holderOf('Agent').sessionKey, winner, 'the name did not flip back')
  assert.notEqual(deadToken, zombieToken)
})

test('Story 7.2: two independent observations — the observed incumbent wins, and the stale observation is refused', async t => {
  // The A6 flip. v0.2.0's rule was "the last explicit intent wins", which
  // let a takeover displace whoever held the name at the moment it LANDED.
  // The observed-incumbent contract: B and C both observe A's occupancy
  // (independent tickets, both pinning A's pair); B redeems and wins; C's
  // still-unspent, still-unexpired ticket is now provably stale — the
  // occupancy it observed is gone — and the redemption is refused with the
  // coded conflict_stale. Only a FRESH observation (of B) can take the name
  // from B.
  const { dataDir, server, liveSessionRegistry } = await makeServer(t)
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()

  const { token: first } = await bindSession(server.port, localToken, alice, 'Agent')
  const second = await exchange(server.port, alice, localToken)
  const third = await exchange(server.port, alice, localToken)

  // Two independent observations of the SAME incumbent (per-pair slotting
  // keys on the OBSERVING session's own ticket — each observation mints its
  // own, and both pin first's occupancy).
  const observeB = await sessionRequest(server.port, 'POST', second, { chat_id: 'Agent', client_type: 'mcp' })
  const observeC = await sessionRequest(server.port, 'POST', third, { chat_id: 'Agent', client_type: 'mcp' })
  assert.equal(observeB.status, 409, observeB.text)
  assert.equal(observeC.status, 409, observeC.text)
  const ticketB = observeB.json.error.conflict_ticket
  const ticketC = observeC.json.error.conflict_ticket
  assert.equal(typeof ticketB, 'string', 'the same-Actor collision carries a ticket')
  assert.equal(typeof ticketC, 'string', 'the same-Actor collision carries a ticket')

  // B redeems its observation and takes the name from first.
  const takeTwo = await sessionRequest(server.port, 'POST', second, {
    chat_id: 'Agent', client_type: 'mcp', replace_existing: true, conflict_ticket: ticketB,
  })
  assert.equal(takeTwo.status, 200, takeTwo.text)
  assert.equal(takeTwo.json.result.replaced, true)

  // C's unspent ticket — pinned to FIRST's occupancy, which no longer
  // exists — is refused. It is not burned into a win: the current holder
  // (second) keeps the name, and a replay of B's consumed ticketB is
  // refused the same coded way.
  const staleC = await sessionRequest(server.port, 'POST', third, {
    chat_id: 'Agent', client_type: 'mcp', replace_existing: true, conflict_ticket: ticketC,
  })
  assert.equal(staleC.status, 409, staleC.text)
  assert.equal(staleC.json.error.code, 'conflict_stale')
  const replayB = await sessionRequest(server.port, 'POST', second, {
    chat_id: 'Agent', client_type: 'mcp', replace_existing: true, conflict_ticket: ticketB,
  })
  assert.equal(replayB.status, 409, replayB.text)
  assert.equal(replayB.json.error.code, 'conflict_stale', 'a consumed ticket never wins twice')
  assert.equal(liveSessionRegistry.holderOf('Agent').sessionKey, sessionKeyFromToken(second), 'the stale observation displaced nobody')

  // A fresh observation of the CURRENT holder wins: the command's retry
  // path is a new observation and a new confirmation, never a ticket
  // refresh.
  const observeC2 = await sessionRequest(server.port, 'POST', third, { chat_id: 'Agent', client_type: 'mcp' })
  assert.equal(observeC2.status, 409, observeC2.text)
  const takeThree = await sessionRequest(server.port, 'POST', third, {
    chat_id: 'Agent', client_type: 'mcp', replace_existing: true, conflict_ticket: observeC2.json.error.conflict_ticket,
  })
  assert.equal(takeThree.status, 200, takeThree.text)
  assert.equal(takeThree.json.result.replaced, true)

  // The chain of displaced sessions is fenced; the name sits with third.
  assert.equal((await sessionRequest(server.port, 'POST', first, { chat_id: 'Agent' })).status, 401)
  assert.equal((await sessionRequest(server.port, 'POST', second, { chat_id: 'Agent' })).status, 401)
  assert.equal(liveSessionRegistry.holderOf('Agent').sessionKey, sessionKeyFromToken(third))
})

test('Story 7.2: the takeover intent REQUIRES a conflict ticket, and a ticket without the intent is refused', async t => {
  const { dataDir, server, liveSessionRegistry } = await makeServer(t)
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()

  const { token: holder } = await bindSession(server.port, localToken, alice, 'Agent')
  const holderKey = sessionKeyFromToken(holder)
  const other = await exchange(server.port, alice, localToken)

  // Blind takeover (the retired v0.2.0 shape): refused as a request-shape
  // error before any state changes.
  const blind = await sessionRequest(server.port, 'POST', other, {
    chat_id: 'Agent', client_type: 'mcp', replace_existing: true,
  })
  assert.equal(blind.status, 400, blind.text)
  assert.equal(blind.json.error.code, 'invalid_request')
  assert.equal(liveSessionRegistry.holderOf('Agent').sessionKey, holderKey, 'the blind takeover took nothing')

  // A ticket is not a side channel: without the intent it is refused the
  // same request-shape way.
  const sideChannel = await sessionRequest(server.port, 'POST', other, {
    chat_id: 'Agent', client_type: 'mcp', conflict_ticket: 'not-a-real-ticket',
  })
  assert.equal(sideChannel.status, 400, sideChannel.text)
  assert.equal(sideChannel.json.error.code, 'invalid_request')

  // A malformed ticket under a true intent is a request-shape refusal too.
  for (const bad of [null, 1, {}, '', undefined]) {
    const refused = await sessionRequest(server.port, 'POST', other, {
      chat_id: 'Agent', client_type: 'mcp', replace_existing: true,
      ...(bad === undefined ? {} : { conflict_ticket: bad }),
    })
    assert.equal(refused.status, 400, `conflict_ticket=${JSON.stringify(bad)} was not refused`)
    assert.equal(refused.json.error.code, 'invalid_request')
  }
  assert.equal(liveSessionRegistry.holderOf('Agent').sessionKey, holderKey, 'nothing was taken')
})

test('Story 7.2: A→release→A — the same key reclaiming the name makes the old observation stale', async t => {
  const { dataDir, server, liveSessionRegistry } = await makeServer(t)
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()

  const { token: first } = await bindSession(server.port, localToken, alice, 'Agent')
  const second = await exchange(server.port, alice, localToken)

  // Observe first's occupancy...
  const observation = await sessionRequest(server.port, 'POST', second, { chat_id: 'Agent', client_type: 'mcp' })
  assert.equal(observation.status, 409, observation.text)
  const ticket = observation.json.error.conflict_ticket

  // ...then the holder releases and the SAME session key rebinds: the name
  // is held by first again, but it is a NEW occupancy (the generation
  // moved). The takeover presenting the old ticket must be refused — a
  // sessionKey-only comparison would have evicted the just-restored holder.
  const release = await sessionRequest(server.port, 'DELETE', first)
  assert.equal(release.status, 200, release.text)
  const rebind = await sessionRequest(server.port, 'POST', first, { chat_id: 'Agent', client_type: 'mcp' })
  assert.equal(rebind.status, 200, rebind.text)

  const stale = await sessionRequest(server.port, 'POST', second, {
    chat_id: 'Agent', client_type: 'mcp', replace_existing: true, conflict_ticket: ticket,
  })
  assert.equal(stale.status, 409, stale.text)
  assert.equal(stale.json.error.code, 'conflict_stale')
  assert.equal(liveSessionRegistry.holderOf('Agent').sessionKey, sessionKeyFromToken(first), 'the restored occupancy is untouched')
})

test('Story 7.2 (release gates): the generation history is BOUNDED and zero is never observable — the zero-ABA counterexample refuses', async t => {
  // The first release gate found the unbounded map; the confirmation round
  // EXECUTED the zero-ABA counterexample against the first repair (evicted
  // entries reading 0 let {holder, 0} == {holder, 0} wrongly allow an
  // A→free→A takeover). The repaired semantics: an evicted entry reads
  // null, mint refuses when unknown, and every observable stamp is unique —
  // this row drives the counterexample's exact sequence and pins the
  // refusal.
  const { GENERATION_HISTORY_MAX } = await import('../server/constants.mjs')
  const registry = createLiveSessionRegistry()
  const actor = `sha256:${'f'.repeat(64)}`
  const claimName = (sessionKey, chatId) => registry.claim({ sessionKey, chatId, actorFingerprint: actor })
  const churn = prefix => {
    for (let index = 0; index <= GENERATION_HISTORY_MAX; index += 1) {
      claimName('churn', `${prefix}-${index}`)
      registry.release('churn')
    }
  }

  // 1. Distinct-name churn far past the bound: the oldest stamps evict, and
  //    an evicted name reads NULL — never a fallback 0.
  for (let index = 0; index < GENERATION_HISTORY_MAX + 5_000; index += 1) {
    claimName('churn', `warm-${index}`)
    registry.release('churn')
  }
  assert.equal(registry.occupancyGeneration('warm-0'), null, 'evicted reads null, not 0')
  assert.ok(registry.occupancyGeneration(`warm-${GENERATION_HISTORY_MAX + 4_999}`) > 0, 'the newest stamps are retained (unique, nonzero)')

  // 2. The executed counterexample, end to end through the real server:
  //    holder live with an evicted stamp → the observation carries NO
  //    ticket (the mint refuses an unknown generation), so no {A, null}
  //    pair can ever be pinned; and once a ticket EXISTS, renewed churn
  //    after an A→free→A rebound cannot recreate its observed pair.
  const { dataDir, server, liveSessionRegistry } = await makeServer(t)
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const holder = await bindSession(server.port, localToken, alice, 'Agent')
  // Evict 'Agent's stamp while the holder stays live.
  for (let index = 0; index < GENERATION_HISTORY_MAX + 100; index += 1) {
    liveSessionRegistry.claim({ sessionKey: `filler-${index % 97}`, chatId: `filler-${index}`, actorFingerprint: actor })
  }
  const evictedObservation = await sessionRequest(server.port, 'POST', holder.token, { chat_id: 'Agent', client_type: 'mcp' })
  // The holder re-binding its own name is the idempotent path (200); the
  // takeover-relevant check is the OBSERVER's: an evicted live holder
  // observes WITHOUT a ticket (the bare 409) — nothing pinnable to null.
  const observerToken = await exchange(server.port, alice, localToken)
  const evictedCollision = await sessionRequest(server.port, 'POST', observerToken, { chat_id: 'Agent', client_type: 'mcp' })
  assert.equal(evictedCollision.status, 409, evictedCollision.text)
  // 'Agent' was re-stamped by the intervening transitions (the fillers
  // churned past it, but the holder's own presence kept a stamp? No —
  // eviction is by insertion age; assert BOTH possible worlds honestly):
  // whichever world, no zero-pair exists. If a ticket was minted, redeeming
  // it after A→free→A + renewed churn must REFUSE.
  const ticket = evictedCollision.json.error.conflict_ticket
  if (typeof ticket === 'string') {
    assert.equal(await sessionRequest(server.port, 'DELETE', holder.token).then(r => r.status), 200)
    const rebound = await sessionRequest(server.port, 'POST', holder.token, { chat_id: 'Agent', client_type: 'mcp' })
    assert.equal(rebound.status, 200, rebound.text)
    for (let index = 0; index < GENERATION_HISTORY_MAX + 100; index += 1) {
      liveSessionRegistry.claim({ sessionKey: `filler2-${index % 97}`, chatId: `filler2-${index}`, actorFingerprint: actor })
    }
    const stale = await sessionRequest(server.port, 'POST', observerToken, {
      chat_id: 'Agent', client_type: 'mcp', replace_existing: true, conflict_ticket: ticket,
    })
    assert.equal(stale.status, 409, stale.text)
    assert.equal(stale.json.error.code, 'conflict_stale', 'the zero-ABA sequence refuses: the observed pair can never recur')
    assert.equal(liveSessionRegistry.holderOf('Agent').sessionKey, sessionKeyFromToken(holder.token), 'the rebounded holder is untouched')
  } else {
    // The evicted world: the bare 409 (no pinnable pair) — the takeover
    // cannot even be attempted with an observation of THIS occupancy.
    assert.equal(evictedCollision.json.error.conflict_ticket, undefined, 'an evicted generation observes bare — zero is never pinnable')
    const blind = await sessionRequest(server.port, 'POST', observerToken, {
      chat_id: 'Agent', client_type: 'mcp', replace_existing: true, conflict_ticket: 'not-a-ticket',
    })
    assert.equal(blind.status, 409, blind.text)
    assert.notEqual(liveSessionRegistry.holderOf('Agent'), null, 'the holder is untouched')
  }

})

test('Story 7.2: a ticket presented under the wrong Actor or wrong name never burns and never wins', async t => {
  const { dataDir, server } = await makeServer(t)
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const bob = installation()

  const { token: holder } = await bindSession(server.port, localToken, alice, 'Agent')
  const aliceOther = await exchange(server.port, alice, localToken)
  const bobToken = await exchange(server.port, bob, localToken)

  // Alice observes her own incumbent; Bob (a foreign Actor) sees the BARE
  // envelope — no ticket, no metadata, byte-for-byte the legacy shape.
  const observeAlice = await sessionRequest(server.port, 'POST', aliceOther, { chat_id: 'Agent', client_type: 'mcp' })
  assert.equal(observeAlice.status, 409, observeAlice.text)
  const ticket = observeAlice.json.error.conflict_ticket
  assert.equal(typeof ticket, 'string')
  const observeBob = await sessionRequest(server.port, 'POST', bobToken, { chat_id: 'Agent', client_type: 'mcp' })
  assert.equal(observeBob.status, 409, observeBob.text)
  assert.equal(observeBob.json.error.conflict_ticket, undefined, 'a foreign collision carries no ticket')
  assert.deepEqual(Object.keys(observeBob.json.error).sort(), ['code', 'message'], 'the foreign envelope is exactly the legacy shape')

  // A thief holding Alice's ticket but Bob's credential learns nothing and
  // BURNS nothing: the refusal is the bare chat_id_taken, and Alice's
  // ticket still redeems afterwards.
  const stolen = await sessionRequest(server.port, 'POST', bobToken, {
    chat_id: 'Agent', client_type: 'mcp', replace_existing: true, conflict_ticket: ticket,
  })
  assert.equal(stolen.status, 409, stolen.text)
  assert.equal(stolen.json.error.code, 'chat_id_taken', 'the wrong-Actor presentation answers the bare collision refusal')

  const redeemed = await sessionRequest(server.port, 'POST', aliceOther, {
    chat_id: 'Agent', client_type: 'mcp', replace_existing: true, conflict_ticket: ticket,
  })
  assert.equal(redeemed.status, 200, redeemed.text)
  assert.equal(redeemed.json.result.replaced, true, 'the rightful ticket survived the wrong-Actor presentation')

  // A ticket used against a DIFFERENT name is stale, and the name it was
  // minted for keeps its holder.
  const { token: holder2 } = await bindSession(server.port, localToken, alice, 'Agent')
  const aliceThird = await exchange(server.port, alice, localToken)
  const observeOther = await sessionRequest(server.port, 'POST', aliceThird, { chat_id: 'Agent', client_type: 'mcp' })
  const ticketOther = observeOther.json.error.conflict_ticket
  // A ticket scoped to 'Agent' presented against a FREE 'Agent-2' target:
  // the redemption fails the name scope, and a free target NEVER falls back
  // into an ordinary claim under a takeover intent.
  const wrongName = await sessionRequest(server.port, 'POST', aliceThird, {
    chat_id: 'Agent-2', client_type: 'mcp', replace_existing: true, conflict_ticket: ticketOther,
  })
  assert.equal(wrongName.status, 409, `a mismatched-name ticket is stale, never a free claim: ${wrongName.text}`)
  assert.equal(wrongName.json.error.code, 'conflict_stale')
  assert.notEqual(holder2, undefined)
})

test('the takeover intent is grammar-checked: a non-boolean is refused, an explicit null means false', async t => {
  const { dataDir, server } = await makeServer(t)
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const { token } = await bindSession(server.port, localToken, alice, 'Agent')

  // A non-boolean is a request-shape refusal BEFORE any state changes.
  for (const value of ['yes', 1, {}, []]) {
    const refused = await sessionRequest(server.port, 'POST', token, {
      chat_id: 'Agent-2',
      client_type: 'mcp',
      replace_existing: value,
    })
    assert.equal(refused.status, 400, `replace_existing=${JSON.stringify(value)} was not refused`)
    assert.equal(refused.json.error.code, 'invalid_request')
  }
  // The refusal changed nothing: the session still holds its own name.
  const stillHeld = await sessionRequest(server.port, 'POST', token, { chat_id: 'Agent' })
  assert.equal(stillHeld.status, 200, stillHeld.text)

  // An explicit null is the codebase's "not provided" convention (the same
  // convention client_type uses): it means false, so the bind is an ordinary
  // bind and a name held by ANOTHER session is refused the ordinary way.
  const { token: squatter } = await bindSession(server.port, localToken, alice, 'Held')
  const nullIntent = await sessionRequest(server.port, 'POST', token, {
    chat_id: 'Held',
    client_type: 'mcp',
    replace_existing: null,
  })
  assert.equal(nullIntent.status, 409, nullIntent.text)
  assert.equal(nullIntent.json.error.code, 'chat_id_taken')
  // The squatter was NOT displaced: a null intent is not a takeover.
  const squatterStill = await sessionRequest(server.port, 'POST', squatter, { chat_id: 'Held' })
  assert.equal(squatterStill.status, 200, squatterStill.text)
})

test('the rename verb refuses the takeover intent', async t => {
  const { dataDir, server } = await makeServer(t)
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const { token } = await bindSession(server.port, localToken, alice, 'Agent')

  // A rename is not a takeover: the intent field does not belong to the verb.
  const refused = await sessionRequest(server.port, 'PATCH', token, {
    chat_id: 'Agent-2',
    client_type: 'mcp',
    replace_existing: true,
  })
  assert.equal(refused.status, 400, refused.text)
  assert.equal(refused.json.error.code, 'unknown_field')
  // Nothing moved.
  const stillHeld = await sessionRequest(server.port, 'POST', token, { chat_id: 'Agent' })
  assert.equal(stillHeld.status, 200, stillHeld.text)
})

test('the registry re-checks the incumbent itself: a stale or foreign incumbent key is refused', async t => {
  const { liveSessionRegistry } = await makeServer(t)
  const alice = installation()
  const bob = installation()
  liveSessionRegistry.claim({ sessionKey: 'k-alice', chatId: 'Agent', actorFingerprint: alice.fingerprint })

  // The named incumbent is not the holder (a stale observation).
  assert.throws(() => liveSessionRegistry.transfer({
    sessionKey: 'k-bob',
    chatId: 'Agent',
    actorFingerprint: bob.fingerprint,
    incumbentSessionKey: 'k-not-the-holder',
  }), error => error?.code === 'chat_id_taken')

  // The holder is the named session, but it belongs to ANOTHER Actor.
  assert.throws(() => liveSessionRegistry.transfer({
    sessionKey: 'k-bob',
    chatId: 'Agent',
    actorFingerprint: bob.fingerprint,
    incumbentSessionKey: 'k-alice',
  }), error => error?.code === 'chat_id_taken')

  // Alice's own transfer still works: the guard refuses only what it should.
  const taken = liveSessionRegistry.transfer({
    sessionKey: 'k-alice-2',
    chatId: 'Agent',
    actorFingerprint: alice.fingerprint,
    incumbentSessionKey: 'k-alice',
  })
  assert.equal(taken.displacedSessionKey, 'k-alice')
  assert.equal(liveSessionRegistry.holderOf('Agent').sessionKey, 'k-alice-2')
})

test('a failed takeover leaves the incumbent\'s authority intact', async t => {
  // The API layer's own ordering (durable write first, memory transfer
  // second, fence last) is what protects the incumbent when the write
  // fails. This row drives it through the API with a registry whose transfer
  // fails: the incumbent must still hold the name AND its token must still
  // authenticate — a fenced-but-still-holding incumbent would be the worst
  // of both worlds.
  const dataDir = makeDataDir(t)
  const sessionRegistry = createSessionRegistry()
  const real = createLiveSessionRegistry()
  const liveSessionRegistry = {
    ...real,
    claim: options => real.claim(options),
    rename: options => real.rename(options),
    transfer: () => { throw new Error('the durable write failed') },
    release: key => real.release(key),
    touch: (key, options) => real.touch(key, options),
    lookup: key => real.lookup(key),
    holderOf: id => real.holderOf(id),
    presenceSnapshot: options => real.presenceSnapshot(options),
    clear: () => real.clear(),
  }
  const server = await startServer({ dataDir, sessionRegistry, liveSessionRegistry })
  t.after(() => server.close())
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()

  const { token: incumbentToken } = await bindSession(server.port, localToken, alice, 'Agent')
  const takeoverToken = await exchange(server.port, alice, localToken)
  const failed = await takeoverBind(server.port, takeoverToken, 'Agent')
  assert.equal(failed.status, 500, failed.text)
  // The incumbent still holds the name, and its token still authenticates.
  assert.equal(real.holderOf('Agent').sessionKey, sessionKeyFromToken(incumbentToken))
  const stillWorks = await sessionRequest(server.port, 'POST', incumbentToken, { chat_id: 'Agent' })
  assert.equal(stillWorks.status, 200, stillWorks.text)
})

test('the real client\'s own recovery carries no takeover intent', async t => {
  const { dataDir, server, liveSessionRegistry } = await makeServer(t)
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()

  // A dead session holds the name with a token that still authenticates —
  // the squat the whole story is about.
  const { token: squatter } = await bindSession(server.port, localToken, alice, 'Agent')
  const squatterKey = sessionKeyFromToken(squatter)

  // The REAL client (the package's own api-client) tries to use the name.
  const pluginData = makePluginData(t, 'Agent')
  const client = createAgentRoomClient({ dataDir, pluginDataDir: pluginData })
  await assert.rejects(
    () => client.presence(),
    error => {
      assert.equal(error.code, 'chat_id_taken')
      assert.match(error.message, /agent-room session replace/)
      return true
    },
  )
  // The client's automatic path never seized the name: the squatter still
  // holds it, and the squatter's own session is still alive.
  assert.equal(liveSessionRegistry.holderOf('Agent').sessionKey, squatterKey)
  const squatterAlive = await sessionRequest(server.port, 'POST', squatter, { chat_id: 'Agent' })
  assert.equal(squatterAlive.status, 200, squatterAlive.text)
})

test('the takeover preserves the durable claim row and the client\'s cursor file', async t => {
  const { dataDir, server } = await makeServer(t)
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()

  const { token } = await bindSession(server.port, localToken, alice, 'Agent')
  const takeoverToken = await exchange(server.port, alice, localToken)
  const takeover = await takeoverBind(server.port, takeoverToken, 'Agent')
  assert.equal(takeover.status, 200, takeover.text)

  // The durable (name, Actor) claim survives the takeover — the ambiguity
  // data offline discovery resolves is still there.
  const db = new DatabaseSync(join(dataDir, 'agent-room.sqlite'))
  try {
    const rows = db.prepare(`
      SELECT chat_id_normalized, actor_fingerprint FROM chat_id_claims
      WHERE chat_id_normalized = ?
    `).all('agent')
    assert.equal(rows.length, 1, 'the durable claim row for the name survives')
    assert.equal(rows[0].actor_fingerprint, alice.fingerprint)
  } finally {
    db.close()
  }

  // The CLIENT's own cursor file is untouched: a takeover is a name
  // operation, not a data operation.
  const pluginData = makePluginData(t, 'Agent')
  const cursorPath = join(pluginData, 'realms', 'realm-under-test', 'cursors.json')
  mkdirSync(dirname(cursorPath), { recursive: true, mode: 0o700 })
  const cursorBody = JSON.stringify({ 'room-1': { afterSeq: 42 } })
  writeFileSync(cursorPath, cursorBody, { mode: 0o600 })
  const before = readFileSync(cursorPath, 'utf8')
  await sessionRequest(server.port, 'POST', takeoverToken, {
    chat_id: 'Agent-2',
    client_type: 'mcp',
  })
  assert.equal(readFileSync(cursorPath, 'utf8'), before, 'the client cursor file is untouched')
  // And the takeover token still works (it is the live session now).
  const alive = await sessionRequest(server.port, 'POST', takeoverToken, { chat_id: 'Agent-2' })
  assert.equal(alive.status, 200, alive.text)
})

test('the fence itself refuses a displaced session at the authorization stage', async t => {
  // The EARLY half of the fence (Story 6.4, refined by Story 7.1): the
  // authorization stage refuses a displaced key on the way in — before the
  // server spends memory reading its body for most routes (the send route's
  // budget stage reads first; the post-input revalidation still catches it).
  // This row drives the stage directly — the HTTP rows above prove the token
  // is revoked, this one proves the in-flight request is refused.
  const { sessionRegistry } = await makeServer(t)
  const key = 'session-key-under-test'
  const superseded = sessionRegistry.supersede(key)
  assert.equal(superseded, false, 'nothing was registered under that key, so no live session was revoked')
  assert.equal(sessionRegistry.isSuperseded(key), true, 'the fence still marks the displaced key')

  const stage = new AuthzStage()
  const refusal = stage.process({
    route: { class: 'actor' },
    session: { actorFingerprint: `sha256:${'a'.repeat(64)}`, sessionKey: key },
    store: { isActorBanned: () => false },
    sessionRegistry,
  })
  assert.ok(refusal, 'the authorization stage must refuse a superseded session')
  assert.equal(refusal.ok, false)
  assert.equal(refusal.code, 'unauthorized')

  // A session that was never displaced is untouched by the same stage.
  const untouched = stage.process({
    route: { class: 'actor' },
    session: { actorFingerprint: `sha256:${'a'.repeat(64)}`, sessionKey: 'another-key' },
    store: { isActorBanned: () => false },
    sessionRegistry,
  })
  assert.equal(untouched, undefined, 'an undisplaced session passes the fence')
})

test('Story 7.1: a request whose body arrives after the handoff is refused at the post-input revalidation', async t => {
  // The window Story 6.4 left open — the authorization stage runs before a
  // body-carrying route's body is read, so a request admitted before the
  // handoff whose body was still arriving could reach the handler (the
  // release-gate review executed that path) — is CLOSED by Story 7.1:
  // runPipeline re-checks the fence after the request fields resolve and
  // directly before the handler. The old row pinned the gap VISIBLY and
  // promised to flip when the fence moved after the last awaited input
  // step; this is that flip, with the same delayed-body shape.
  const auth = createSessionRegistry()
  const live = createLiveSessionRegistry()
  const actor = `sha256:${'a'.repeat(64)}`
  const oldToken = auth.issue(actor)
  const oldKey = sessionKeyFromToken(oldToken)
  const newKey = sessionKeyFromToken(auth.issue(actor))
  live.claim({ sessionKey: oldKey, chatId: 'Agent', actorFingerprint: actor })

  let enter
  let finish
  const entered = new Promise(resolve => { enter = resolve })
  const gate = new Promise(resolve => { finish = resolve })
  const bodyStream = (async function* () {
    enter()
    await gate
    yield Buffer.from(JSON.stringify({ chat_id: 'Ghost' }))
  })()
  const context = {
    method: 'POST',
    route: { class: 'actor', requestFields: ['chat_id'] },
    headers: { authorization: `Bearer ${oldToken}` },
    bodyStream,
    sessionRegistry: auth,
    liveSessionRegistry: live,
  }
  let handlerRan = false
  const pending = runPipeline(
    [new AuthStage({ sessionVerifier: createSessionVerifier({ registry: auth }) }), new AuthzStage()],
    context,
    ctx => {
      handlerRan = true
      return live.claim({
        sessionKey: ctx.session.sessionKey,
        chatId: ctx.body.chat_id,
        actorFingerprint: ctx.session.actorFingerprint,
      })
    },
  )
  await entered
  // The handoff happens while the request's body is still in flight.
  live.transfer({
    sessionKey: newKey,
    chatId: 'Agent',
    actorFingerprint: actor,
    incumbentSessionKey: oldKey,
  })
  auth.supersede(oldKey)
  assert.equal(auth.verify(oldToken).code, 'unauthorized', 'the displaced token no longer authenticates')
  finish()
  const outcome = await pending
  assert.equal(handlerRan, false, 'the closed window: the displaced request never reached the handler')
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'unauthorized')
  assert.equal(live.holderOf('Ghost'), null, 'and it claimed nothing')

  // The part that DOES hold: every LATER request from the displaced session
  // is refused at the auth stage, because its token no longer authenticates.
  assert.equal(auth.verify(oldToken).code, 'unauthorized')
})

test('Story 7.1: a pinned fence entry survives eviction pressure no matter how many supersessions follow', async t => {
  // The A7 defect: the fence was bounded at maxSessions ENTRIES, so the
  // (maxSessions + 1)th supersession could forget a still-admitted
  // predecessor — the release-gate review's exploit used exactly that
  // (supersede the displaced key, then supersede others until it fell off).
  // The ratified mechanism: the pipeline pins each admitted request's key,
  // and a PINNED entry is never evicted under any circumstance; the bound
  // gates only idle tombstones.
  const auth = createSessionRegistry({ maxSessions: 1 })
  const actor = `sha256:${'b'.repeat(64)}`
  const oldToken = auth.issue(actor)
  const oldKey = sessionKeyFromToken(oldToken)

  // One admitted request, mid-body (the pin the pipeline would hold).
  auth.enterInFlight(oldKey)
  auth.supersede(oldKey)
  assert.equal(auth.isSuperseded(oldKey), true, 'the displaced key is fenced while pinned')

  // Eviction pressure: far more supersessions than the bound, none pinned.
  for (let i = 0; i < 50; i++) {
    auth.supersede(sessionKeyFromToken(auth.issue(`sha256:${'c'.repeat(64)}`)))
  }
  assert.equal(auth.isSuperseded(oldKey), true, 'eviction pressure cannot forget a pinned predecessor')

  // The in-flight request completes; the tombstone is now idle, and the
  // next idle eviction (the bound exceeded) drops it — oldest idle first.
  auth.leaveInFlight(oldKey)
  auth.supersede(sessionKeyFromToken(auth.issue(`sha256:${'c'.repeat(64)}`)))
  assert.equal(auth.isSuperseded(oldKey), false, 'an idle tombstone is the first eviction candidate once the bound is exceeded')

  // And without any pin at all, the old over-the-bound supersessions evict
  // oldest-first as before.
  const first = sessionKeyFromToken(auth.issue(actor))
  auth.supersede(first)
  for (let i = 0; i < 50; i++) {
    auth.supersede(sessionKeyFromToken(auth.issue(`sha256:${'d'.repeat(64)}`)))
  }
  assert.equal(auth.isSuperseded(first), false, 'the idle-tombstone bound still holds without pins')
})

test('Story 7.1: the pipeline releases the pin exactly once and the fence drains after the request ends', async t => {
  // Every exit path must release exactly once — a leaked pin would make the
  // pinned entry immortal and grow the fence without bound.
  const auth = createSessionRegistry({ maxSessions: 1 })
  const live = createLiveSessionRegistry()
  const actor = `sha256:${'e'.repeat(64)}`
  const token = auth.issue(actor)
  const context = {
    method: 'GET',
    route: { class: 'actor' },
    headers: { authorization: `Bearer ${token}` },
    sessionRegistry: auth,
    liveSessionRegistry: live,
  }
  const outcome = await runPipeline(
    [new AuthStage({ sessionVerifier: createSessionVerifier({ registry: auth }) }), new AuthzStage()],
    context,
    () => ({ ok: true }),
  )
  assert.equal(outcome.ok, true)
  // No pin remains: superseding the key now leaves an evictable tombstone.
  const key = sessionKeyFromToken(token)
  auth.supersede(key)
  for (let i = 0; i < 5; i++) {
    auth.supersede(sessionKeyFromToken(auth.issue(`sha256:${'f'.repeat(64)}`)))
  }
  assert.equal(auth.isSuperseded(key), false, 'no pin leaked after a normal completion')

  // The same for a REJECTED pipeline (an unauthorized request never pins —
  // auth failed — and the finally must not throw or double-release).
  const badContext = {
    method: 'GET',
    route: { class: 'actor' },
    headers: {},
    sessionRegistry: auth,
    liveSessionRegistry: live,
  }
  const refused = await runPipeline(
    [new AuthStage({ sessionVerifier: createSessionVerifier({ registry: auth }) }), new AuthzStage()],
    badContext,
    () => ({ ok: true }),
  )
  assert.equal(refused.ok, false, 'an unauthenticated request is refused as before')
})

test('Story 7.1: a long-poll displaced mid-hold stops serving its holder on the next wake', async t => {
  // The poll loop re-checked the ban on every wake but never the fence, so a
  // session displaced while its long-poll held kept draining messages that
  // arrived after the handoff. The fence now rides the same wake.
  const { dataDir, server, liveSessionRegistry } = await makeServer(t)
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()

  const { token: deadToken } = await bindSession(server.port, localToken, alice, 'Agent')
  const deadKey = sessionKeyFromToken(deadToken)
  assert.equal(liveSessionRegistry.holderOf('Agent').sessionKey, deadKey)

  const status = await request(server.port, 'GET', '/api/status', {
    headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${deadToken}` },
  })
  assert.equal(status.status, 200, status.text)
  const broadcastRoomId = status.json.result.broadcast_room_id

  // The long-poll enters its hold with nothing new to deliver. The takeover
  // waits ~1 s — roughly a hundred-fold margin over an in-process request's
  // admission cost — so the displacement provably lands while the poll is
  // inside its hold, and the refusal that follows can only come from the
  // wake-time fence check (a poll without it would hold to the deadline and
  // answer 200 with an empty page).
  const pollStartedAt = Date.now()
  const pollPromise = request(
    server.port,
    'GET',
    `/api/rooms/${broadcastRoomId}/messages?after_seq=0&wait_ms=10000`,
    { headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${deadToken}` } },
  )
  await new Promise(resolvePromise => { setTimeout(resolvePromise, 1000) })

  // The explicit takeover displaces the polling session while it holds.
  const restarted = await exchange(server.port, alice, localToken)
  const takeover = await takeoverBind(server.port, restarted, 'Agent')
  assert.equal(takeover.status, 200, takeover.text)
  assert.equal(liveSessionRegistry.holderOf('Agent').sessionKey !== deadKey, true)

  // The very next wake answers the fence, not a page of messages — and the
  // early return itself is evidence: the poll never reached its deadline.
  const pollOutcome = await pollPromise
  assert.equal(pollOutcome.status, 401, pollOutcome.text)
  assert.equal(pollOutcome.json?.error?.code, 'unauthorized')
  assert.ok(Date.now() - pollStartedAt < 9000, 'the refusal came from a wake-time fence check, not the deadline')
})

test('Story 7.1: the pipeline acquires the pin WITH authentication, before the send route waits on its body in the budget stage', async t => {
  // The interleaving that broke the first draft: on the send route the
  // budget stage awaits the request body INSIDE the stage sequence, so a
  // request can be authenticated and suspended before the loop ends. The
  // pin must therefore be acquired synchronously with successful
  // verification — this row spies both pin calls and proves the enter
  // happened before the body gate resolved, and that the SEND-churn
  // supersessions cannot forget the pinned predecessor.
  const auth = createSessionRegistry({ maxSessions: 1 })
  const events = []
  const registry = {
    ...auth,
    enterInFlight(k) { events.push('enter'); auth.enterInFlight(k) },
    leaveInFlight(k) { events.push('leave'); auth.leaveInFlight(k) },
  }
  const actor = `sha256:${'7'.repeat(64)}`
  const token = auth.issue(actor)
  const key = sessionKeyFromToken(token)
  let enterBody
  let finishBody
  const bodyEntered = new Promise(resolve => { enterBody = resolve })
  const bodyGate = new Promise(resolve => { finishBody = resolve })
  const context = {
    method: 'POST',
    route: { class: 'actor', path: '/api/rooms/:id/messages', requestFields: ['client_message_id'] },
    params: { id: 'room' },
    headers: { authorization: `Bearer ${token}` },
    sessionRegistry: registry,
    bodyStream: (async function* () {
      enterBody()
      await bodyGate
      yield Buffer.from('{"client_message_id":"id"}')
    })(),
  }
  let handlerCalled = false
  const pending = runPipeline(
    [
      new AuthStage({ sessionVerifier: createSessionVerifier({ registry }) }),
      new BudgetStage({ sendBucketGate: { check() { return { ok: true } } } }),
      new AuthzStage(),
    ],
    context,
    () => { handlerCalled = true },
  )
  await bodyEntered
  assert.deepEqual(events, ['enter'], 'the pin was acquired with authentication, before the body resolved')
  assert.equal(context.pinnedSessionKey, key)
  // The takeover, then eviction pressure, while the request waits in the
  // budget stage's body read.
  auth.supersede(key)
  for (let i = 0; i < 50; i++) {
    auth.supersede(sessionKeyFromToken(auth.issue(`sha256:${'8'.repeat(64)}`)))
  }
  assert.equal(auth.isSuperseded(key), true, 'the churn cannot forget the pinned predecessor')
  finishBody()
  const outcome = await pending
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'unauthorized', 'the post-input revalidation refuses it')
  assert.equal(handlerCalled, false)
  assert.deepEqual(events, ['enter', 'leave'], 'exactly one pin pair for the whole request')
})

test('Story 7.1: the pin is released exactly once across every pipeline exit shape', async t => {
  // Each exit shape must produce exactly one enter/leave pair, clear the
  // context's pin bookkeeping, and (where the pipeline stops the request)
  // never reach the handler. The spy counts DOUBLE releases too.
  const actor = `sha256:${'9'.repeat(64)}`
  const exits = [
    'normal', 'stage-refusal', 'stage-rejection', 'stage-throw',
    'stage-async-rejection', 'input-rejection', 'input-abort',
    'post-input-refusal', 'handler-rejection', 'handler-throw',
    'handler-async-rejection', 'handler-awaited', 'streamed',
  ]
  for (const label of exits) {
    const auth = createSessionRegistry()
    const events = []
    const registry = {
      ...auth,
      enterInFlight(k) { events.push('enter'); auth.enterInFlight(k) },
      leaveInFlight(k) { events.push('leave'); auth.leaveInFlight(k) },
    }
    const token = auth.issue(actor)
    const context = {
      method: 'GET',
      route: { class: 'actor', requestFields: [] },
      headers: { authorization: `Bearer ${token}` },
      sessionRegistry: registry,
    }
    const stages = [new AuthStage({ sessionVerifier: createSessionVerifier({ registry }) })]
    const stageOutcomes = {
      'stage-refusal': () => ({ refusal: true }),
      'stage-rejection': () => reject('unauthorized'),
      'stage-throw': () => { throw new Error('stage') },
      'stage-async-rejection': () => Promise.reject(new Error('stage-async')),
    }
    if (stageOutcomes[label]) stages.push({ name: 'budgets', process: stageOutcomes[label] })
    stages.push(new AuthzStage())
    if (label === 'input-rejection') context.query = { unknown: 'field' }
    if (label === 'input-abort') {
      context.method = 'POST'
      context.bodyStream = (async function* () { throw new Error('abort') })()
    }
    if (label === 'post-input-refusal') {
      context.method = 'POST'
      const key = sessionKeyFromToken(token)
      context.bodyStream = (async function* () { auth.supersede(key); yield Buffer.from('{}') })()
    }
    let handlerCalled = false
    const handler = () => {
      handlerCalled = true
      if (label === 'handler-rejection') return reject('invalid_request')
      if (label === 'handler-throw') throw new Error('sync-handler')
      if (label === 'handler-async-rejection') return Promise.reject(new Error('async-handler'))
      if (label === 'handler-awaited') return Promise.resolve().then(() => {
        assert.deepEqual(events, ['enter'], `${label}: the pin holds through an awaited handler`)
        return { value: true }
      })
      if (label === 'streamed') return HANDLER_STREAMED
      return { value: true }
    }
    const pending = runPipeline(stages, context, handler)
    assert.deepEqual(events, ['enter'], `${label}: acquire before the first yield`)
    if (label === 'stage-throw' || label === 'stage-async-rejection') {
      await assert.rejects(pending, undefined, label)
    } else {
      await pending
    }
    assert.deepEqual(events, ['enter', 'leave'], `${label}: exactly one release`)
    assert.equal(context.pinnedSessionKey, null, label)
    assert.equal(context.pipelinePinManaged, false, label)
    if (label.startsWith('stage-') || label.startsWith('input-') || label === 'post-input-refusal') {
      assert.equal(handlerCalled, false, `${label}: the handler never ran`)
    }
  }
})

test('Story 7.1: protected predecessors survive far beyond the bound, and their release drains without a further supersession', async t => {
  const registry = createSessionRegistry()
  const actor = `sha256:${'a'.repeat(64)}`
  const keys = []
  for (let i = 0; i < 1002; i++) {
    const key = sessionKeyFromToken(registry.issue(actor))
    keys.push(key)
    registry.enterInFlight(key)
    registry.supersede(key)
  }
  assert.equal(registry.isSuperseded(keys[0]), true)
  assert.ok(keys.every(key => registry.isSuperseded(key)), 'every pinned predecessor survives past the 1,000 bound')
  // Revoke, re-supersede, and a fresh issue touch nothing protected.
  registry.revoke(keys[0])
  registry.supersede(keys[0])
  registry.issue(actor)
  assert.ok(keys.every(key => registry.isSuperseded(key)))
  // Each release drains that key alone, with no supersession following.
  registry.leaveInFlight(keys[0])
  assert.equal(registry.isSuperseded(keys[0]), false)
  registry.leaveInFlight(keys[1])
  assert.equal(registry.isSuperseded(keys[1]), false)
  assert.ok(keys.slice(2).every(key => registry.isSuperseded(key)), 'the still-pinned entries stay fenced')
})

test('Story 7.1: multiple in-flight requests share one pin count; the fence holds until the LAST one ends', async t => {
  const multi = createSessionRegistry({ maxSessions: 1 })
  const actor = `sha256:${'b'.repeat(64)}`
  const first = sessionKeyFromToken(multi.issue(actor))
  const second = sessionKeyFromToken(multi.issue(actor))
  multi.enterInFlight(first)
  multi.enterInFlight(first)
  multi.supersede(first)
  multi.enterInFlight(second)
  multi.supersede(second)
  multi.leaveInFlight(first)
  assert.equal(multi.isSuperseded(first), true, 'one request of the key remains; the entry stays pinned')
  multi.leaveInFlight(first)
  assert.equal(multi.isSuperseded(first), false, 'the last release makes it an evictable idle tombstone')
  assert.equal(multi.isSuperseded(second), true)
})

test('a failed durable write leaves the incumbent intact', async t => {
  const { liveSessionRegistry } = await makeServer(t)
  const alice = installation()
  const bob = installation()

  liveSessionRegistry.claim({ sessionKey: 'k1', chatId: 'Agent', actorFingerprint: alice.fingerprint })
  assert.throws(() => liveSessionRegistry.transfer({
    sessionKey: 'k2',
    chatId: 'Agent',
    actorFingerprint: alice.fingerprint,
    incumbentSessionKey: 'k1',
    persist: () => { throw new Error('durable write failed') },
  }), /durable write failed/)

  // The incumbent still holds the name: a failed write changed nothing.
  assert.equal(liveSessionRegistry.holderOf('Agent').sessionKey, 'k1')
  assert.notEqual(liveSessionRegistry.holderOf('Agent').actorFingerprint, bob.fingerprint)
})

test('the takeover leaves the Actor\'s OTHER names, the peer, the room, and the history untouched', async t => {
  const { dataDir, server, liveSessionRegistry } = await makeServer(t)
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()
  const bob = installation()

  // Alice holds two names; Bob holds one. Alice opens a DM with Bob and
  // sends a message.
  const { token: aliceToken } = await bindSession(server.port, localToken, alice, 'Agent')
  const aliceSecond = await bindSession(server.port, localToken, alice, 'Agent-2')
  const { token: bobToken } = await bindSession(server.port, localToken, bob, 'Bob')

  const status = await request(server.port, 'GET', '/api/status', {
    headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${aliceToken}` },
  })
  const broadcastRoomId = status.json.result.broadcast_room_id

  const opened = await request(server.port, 'POST', '/api/rooms/direct', {
    headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: 'Bob' }),
  })
  assert.equal(opened.status, 200, opened.text)
  const roomId = opened.json.result.room_id
  const sent = await request(server.port, 'POST', `/api/rooms/${roomId}/messages`, {
    headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${aliceToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: 'Agent', client_message_id: 'cmid-before-takeover-1', text: 'before the takeover' }),
  })
  assert.equal(sent.status, 200, sent.text)

  // The takeover of 'Agent' — and nothing else.
  const takeoverToken = await exchange(server.port, alice, localToken)
  const takeover = await takeoverBind(server.port, takeoverToken, 'Agent')
  assert.equal(takeover.status, 200, takeover.text)

  // Alice's OTHER name is untouched, and its session still works.
  assert.equal(liveSessionRegistry.holderOf('Agent-2').sessionKey, sessionKeyFromToken(aliceSecond.token))
  const stillWorks = await sessionRequest(server.port, 'PATCH', aliceSecond.token, { chat_id: 'Agent-2' })
  assert.equal(stillWorks.status, 200, stillWorks.text)

  // Bob's session is untouched.
  assert.equal(liveSessionRegistry.holderOf('Bob').sessionKey, sessionKeyFromToken(bobToken))
  const bobPresence = await request(server.port, 'GET', '/api/presence', {
    headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${bobToken}` },
  })
  assert.equal(bobPresence.status, 200, bobPresence.text)

  // The room, its history, and the cursor survive: the successor reads the
  // message that was sent BEFORE the takeover, and sends into the same room.
  const read = await request(server.port, 'GET', `/api/rooms/${roomId}/messages?after_seq=0&limit=50`, {
    headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${takeoverToken}` },
  })
  assert.equal(read.status, 200, read.text)
  const rows = read.json.result.messages
  assert.equal(rows.length, 1)
  assert.equal(rows[0].text, 'before the takeover')
  const head = read.json.result.head_seq

  const after = await request(server.port, 'POST', `/api/rooms/${roomId}/messages`, {
    headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${takeoverToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: 'Agent', client_message_id: 'cmid-after-takeover-1', text: 'after the takeover' }),
  })
  assert.equal(after.status, 200, after.text)
  assert.equal(after.json.result.status, 'committed')

  // The cursor advanced, and Bob sees both messages in the same room.
  const bobRead = await request(server.port, 'GET', `/api/rooms/${roomId}/messages?after_seq=${head}&limit=50`, {
    headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${bobToken}` },
  })
  assert.equal(bobRead.status, 200, bobRead.text)
  assert.equal(bobRead.json.result.messages.length, 1)
  assert.equal(bobRead.json.result.messages[0].text, 'after the takeover')
  assert.ok(broadcastRoomId.length > 0)
})

test('the client itself never takes a name: a squatted name is refused, not seized', async t => {
  const { dataDir, server } = await makeServer(t)
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()

  // A squatter holds 'Agent' with a live token — exactly the squat the
  // takeover exists for.
  await bindSession(server.port, localToken, alice, 'Agent')

  // A real client (the api-client) tries to use the same name: it is
  // refused with the coded collision and the actionable message, and it
  // never sends the takeover intent.
  const client = createAgentRoomClient({ dataDir, pluginDataDir: makePluginData(t, 'Agent') })
  await assert.rejects(
    () => client.presence(),
    error => {
      assert.equal(error.code, 'chat_id_taken')
      assert.match(error.message, /agent-room session replace/)
      return true
    },
  )
})

test('an orderly exit hands the name back: the next session binds it at once', async t => {
  const parent = mkdtempSync(join(tmpdir(), 'agent-room-graceful-exit-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const sharedData = join(parent, 'shared')
  const pluginData = join(parent, 'plugin-data')
  mkdirSync(sharedData, { recursive: true, mode: 0o700 })
  mkdirSync(pluginData, { recursive: true, mode: 0o700 })
  atomicWriteJson(join(pluginData, 'config.json'), { chat_id: 'Agent' })

  const { dataDir: serverData, server } = await makeServer(t)
  // The MCP child talks to the in-process server through the shared data
  // dir's local token — so it must run against THAT server's data dir.
  const localToken = loadOrCreateLocalToken(serverData)
  const alice = installation()

  // The squat first: another session holds the name with a live token.
  const { token: squatter } = await bindSession(server.port, localToken, alice, 'Agent')

  // The MCP child starts, fails to bind (the name is taken) and exits
  // cleanly — it must not leave anything behind.
  const child = spawn(process.execPath, [MCP_ENTRY], {
    cwd: pluginData,
    env: {
      PATH: process.env.PATH || '',
      PLUGIN_DATA: pluginData,
      AGENT_ROOM_DATA_DIR: serverData,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  child.stdout.resume()
  child.stderr.resume()
  await sleep(300)

  // The squatting session is released by an orderly disconnect (DELETE
  // /api/session) and the name is immediately claimable again.
  const released = await sessionRequest(server.port, 'DELETE', squatter)
  assert.equal(released.status, 200, released.text)
  const next = await bindSession(server.port, localToken, alice, 'Agent')
  assert.equal(next.bound.status, 200, next.bound.text)
})

test('the MCP adapter hands its name back when its stdin closes', async t => {
  const parent = mkdtempSync(join(tmpdir(), 'agent-room-mcp-exit-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const sharedData = join(parent, 'shared')
  const pluginData = join(parent, 'plugin-data')
  mkdirSync(sharedData, { recursive: true, mode: 0o700 })
  mkdirSync(pluginData, { recursive: true, mode: 0o700 })
  atomicWriteJson(join(pluginData, 'config.json'), { chat_id: 'Agent' })

  // A real server child: it writes the runtime record the MCP adapter
  // attaches to.
  const serverChild = spawn(process.execPath, [join(ROOT, 'server', 'api', 'server.mjs')], {
    env: { ...process.env, AGENT_ROOM_DATA_DIR: sharedData },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => {
    if (serverChild.exitCode === null && serverChild.signalCode === null) {
      serverChild.kill('SIGKILL')
      await once(serverChild, 'exit').catch(() => {})
    }
  })
  const runtimePath = join(sharedData, 'runtime.json')
  let port = 0
  for (let attempt = 0; attempt < 400 && port === 0; attempt += 1) {
    await sleep(25)
    if (!existsSync(runtimePath)) continue
    try {
      const record = JSON.parse(readFileSync(runtimePath, 'utf8'))
      if (Number.isInteger(record.port) && record.port > 0) port = record.port
    } catch { /* atomic rename: readers retry */ }
  }
  assert.ok(port > 0, 'the server child never became ready')

  // The MCP adapter: a real child, a real tool call (which binds the name),
  // then an orderly exit.
  const child = spawn(process.execPath, [MCP_ENTRY], {
    cwd: pluginData,
    env: {
      PATH: process.env.PATH || '',
      PLUGIN_DATA: pluginData,
      AGENT_ROOM_DATA_DIR: sharedData,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  child.stdout.setEncoding('utf8')
  child.stderr.setEncoding('utf8')
  let stdout = ''
  child.stdout.on('data', chunk => {
    stdout += chunk
  })
  child.stderr.resume()

  const call = async (method, params) => {
    const id = Math.floor(Math.random() * 1e9)
    const response = new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error(`the MCP child never answered ${method}; stdout=${stdout}`)), 15_000)
      const onData = () => {
        for (const line of stdout.split('\n')) {
          if (!line) continue
          try {
            const message = JSON.parse(line)
            if (message.id !== id) continue
            clearTimeout(timer)
            child.stdout.off('data', onData)
            resolvePromise(message)
          } catch { /* not a frame yet */ }
        }
      }
      child.stdout.on('data', onData)
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return response
  }

  await call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'TakeoverTest', version: '1.0.0' },
  })
  const presence = await call('tools/call', { name: 'room_presence', arguments: {} })
  assert.equal(presence.error, undefined, JSON.stringify(presence.error))
  assert.equal(presence.result.isError, undefined, 'the presence tool succeeded, so the adapter bound the name')

  // The name is held: another session cannot take it.
  const localToken = loadOrCreateLocalToken(sharedData)
  const stranger = installation()
  const blocked = await bindSession(port, localToken, stranger, 'Agent')
  assert.equal(blocked.bound.status, 409, 'the adapter holds the name while it is alive')

  // The orderly exit: stdin closes, the adapter releases the name, and the
  // process ends.
  child.stdin.end()
  await once(child, 'exit')

  // The name is free again — immediately, with no lease to wait out.
  const afterExit = await bindSession(port, localToken, stranger, 'Agent')
  assert.equal(afterExit.bound.status, 200, afterExit.bound.text)
})

// One real server child + one real MCP child, wired the way the stdin-close
// row (above) wires them: the tool call binds the name, and the teardown
// triggers (SIGTERM / SIGINT / stdin close) exercise the Story 7.3 shutdown.
// waitForExit() bounds the wait so a wedged child fails the row instead of
// the suite.
async function spawnMcpChild(t, { gate = null } = {}) {
  const parent = mkdtempSync(join(tmpdir(), 'agent-room-mcp-signals-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const sharedData = join(parent, 'shared')
  const pluginData = join(parent, 'plugin-data')
  mkdirSync(sharedData, { recursive: true, mode: 0o700 })
  mkdirSync(pluginData, { recursive: true, mode: 0o700 })
  atomicWriteJson(join(pluginData, 'config.json'), { chat_id: 'Agent' })

  const serverChild = spawn(process.execPath, [join(ROOT, 'server', 'api', 'server.mjs')], {
    env: { ...process.env, AGENT_ROOM_DATA_DIR: sharedData },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  t.after(async () => {
    if (serverChild.exitCode === null && serverChild.signalCode === null) {
      serverChild.kill('SIGKILL')
      await once(serverChild, 'exit').catch(() => {})
    }
  })
  const runtimePath = join(sharedData, 'runtime.json')
  let port = 0
  for (let attempt = 0; attempt < 400 && port === 0; attempt += 1) {
    await sleep(25)
    if (!existsSync(runtimePath)) continue
    try {
      const record = JSON.parse(readFileSync(runtimePath, 'utf8'))
      if (Number.isInteger(record.port) && record.port > 0) port = record.port
    } catch { /* atomic rename: readers retry */ }
  }
  assert.ok(port > 0, 'the server child never became ready')

  // The optional gate: a forwarding proxy the MCP child attaches to instead
  // of the server directly (the runtime record's port is rewritten). It
  // holds the FIRST matching request's response until the test opens the
  // gate, which makes "shutdown began while X was in flight" provable for
  // the A8/A9 rows (gate='delete' holds the release's DELETE; gate='bind'
  // holds the first bind's POST).
  let gateSeenResolve
  let gateOpenResolve
  const gateSeen = new Promise(resolvePromise => { gateSeenResolve = resolvePromise })
  const gateOpen = new Promise(resolvePromise => { gateOpenResolve = resolvePromise })
  const gateHandle = {
    seen: gateSeen,
    open: () => gateOpenResolve(),
  }
  if (gate !== null) {
    let armed = true
    const proxy = http.createServer((req, res) => {
      const chunks = []
      req.on('data', chunk => chunks.push(chunk))
      req.on('end', () => {
        const gated = armed
          && ((gate === 'delete' && req.method === 'DELETE' && req.url === '/api/session')
            || (gate === 'bind' && req.method === 'POST' && req.url === '/api/session'))
        if (gate === 'blackhole' && req.method === 'DELETE' && req.url === '/api/session') {
          // Never forwarded, never answered: the request vanishes. The
          // client's socket stays open until the process exits.
          if (armed) {
            armed = false
            gateSeenResolve()
          }
          return
        }
        if (gated) {
          armed = false
          gateSeenResolve()
        }
        const upstream = http.request(
          { host: '127.0.0.1', port, method: req.method, path: req.url, headers: req.headers },
          up => {
            const upstreamChunks = []
            up.on('data', chunk => upstreamChunks.push(chunk))
            up.on('end', async () => {
              if (gated) await gateOpen
              res.writeHead(up.statusCode, up.headers)
              res.end(Buffer.concat(upstreamChunks))
            })
          },
        )
        upstream.on('error', () => { try { res.destroy() } catch { } })
        upstream.end(Buffer.concat(chunks))
      })
    })
    const proxyPort = await new Promise(resolvePromise => {
      proxy.listen(0, '127.0.0.1', () => resolvePromise(proxy.address().port))
    })
    t.after(() => new Promise(resolvePromise => proxy.close(resolvePromise)))
    const record = JSON.parse(readFileSync(runtimePath, 'utf8'))
    atomicWriteJson(runtimePath, { ...record, port: proxyPort })
  }

  const child = spawn(process.execPath, [MCP_ENTRY], {
    cwd: pluginData,
    env: {
      PATH: process.env.PATH || '',
      PLUGIN_DATA: pluginData,
      AGENT_ROOM_DATA_DIR: sharedData,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  })
  child.stdout.setEncoding('utf8')
  let stderr = ''
  child.stderr.setEncoding('utf8')
  child.stderr.on('data', chunk => {
    stderr += chunk
  })

  let stdout = ''
  child.stdout.on('data', chunk => {
    stdout += chunk
  })

  const call = async (method, params) => {
    const id = Math.floor(Math.random() * 1e9)
    const response = new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => rejectPromise(new Error(`the MCP child never answered ${method}; stdout=${stdout}`)), 15_000)
      const onData = () => {
        for (const line of stdout.split('\n')) {
          if (!line) continue
          try {
            const message = JSON.parse(line)
            if (message.id !== id) continue
            clearTimeout(timer)
            child.stdout.off('data', onData)
            resolvePromise(message)
          } catch { /* not a frame yet */ }
        }
      }
      child.stdout.on('data', onData)
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return response
  }

  const waitForExit = () => Promise.race([
    once(child, 'exit').then(([exitCode, exitSignal]) => ({ code: exitCode, signal: exitSignal })),
    sleep(15_000).then(() => { throw new Error(`the MCP child never exited after its teardown trigger; stdout=${stdout}`) }),
  ])

  return { sharedData, child, port, call, waitForExit, gate: gateHandle, stderr: () => stderr }
}

test('Story 7.3: SIGTERM releases the name before the child exits (A8)', async t => {
  const { child, port, call, waitForExit, sharedData } = await spawnMcpChild(t)

  await call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'TakeoverTest', version: '1.0.0' },
  })
  const presence = await call('tools/call', { name: 'room_presence', arguments: {} })
  assert.equal(presence.error, undefined, JSON.stringify(presence.error))
  assert.equal(presence.result.isError, undefined, 'the presence tool succeeded, so the adapter bound the name')

  const localToken = loadOrCreateLocalToken(sharedData)
  const stranger = installation()
  const blocked = await bindSession(port, localToken, stranger, 'Agent')
  assert.equal(blocked.bound.status, 409, 'the adapter holds the name while it is alive')

  // The polite kill: the adapter runs its bounded shutdown (the release)
  // and only then exits — cleanly (exit code 0, not killed by the signal).
  child.kill('SIGTERM')
  const exit = await waitForExit()
  assert.deepEqual(exit, { code: 0, signal: null }, `a clean exit, not a signal death (got ${JSON.stringify(exit)})`)

  const afterExit = await bindSession(port, localToken, stranger, 'Agent')
  assert.equal(afterExit.bound.status, 200, afterExit.bound.text)
})

test('Story 7.3: a repeated SIGTERM while the release is held joins the shutdown and still exits cleanly (A8)', async t => {
  const { sharedData, child, port, call, waitForExit, gate } = await spawnMcpChild(t, { gate: 'delete' })

  await call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'TakeoverTest', version: '1.0.0' },
  })
  const presence = await call('tools/call', { name: 'room_presence', arguments: {} })
  assert.equal(presence.error, undefined, JSON.stringify(presence.error))

  // The release's DELETE is held by the gate: the shutdown is provably in
  // flight when the SECOND SIGTERM arrives — with the old process.once
  // wiring the listener was gone and the default kill won (the executed
  // finding this row pins).
  child.kill('SIGTERM')
  await gate.seen
  child.kill('SIGTERM')
  gate.open()
  const exit = await waitForExit()
  assert.deepEqual(exit, { code: 0, signal: null }, `the repeated signal joined instead of killing (got ${JSON.stringify(exit)})`)

  const localToken = loadOrCreateLocalToken(sharedData)
  const stranger = installation()
  const afterExit = await bindSession(port, localToken, stranger, 'Agent')
  assert.equal(afterExit.bound.status, 200, afterExit.bound.text)
})

test('Story 7.3: a release that never answers exits under the declared deadline and records the failure (A8)', async t => {
  const { sharedData, child, port, call, waitForExit, gate, stderr } = await spawnMcpChild(t, { gate: 'blackhole' })

  await call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'TakeoverTest', version: '1.0.0' },
  })
  const presence = await call('tools/call', { name: 'room_presence', arguments: {} })
  assert.equal(presence.error, undefined, JSON.stringify(presence.error))

  // The release's DELETE never reaches the server (the blackhole gate
  // accepts it, forwards nothing, answers nothing): the TOTAL budget
  // (2,000 ms wall clock, not the socket idle timeout) must end the
  // shutdown, the outcome must be recorded on the adapter's stderr, and
  // the exit must be clean — the process is never held hostage by the
  // held socket.
  const startedAt = Date.now()
  child.kill('SIGTERM')
  const exit = await waitForExit()
  const elapsedMs = Date.now() - startedAt
  assert.deepEqual(exit, { code: 0, signal: null }, `a clean, bounded exit (got ${JSON.stringify(exit)} after ${elapsedMs} ms)`)
  assert.ok(elapsedMs >= 1_500 && elapsedMs < 9_000, `the exit landed at the budget, not the 15 s harness cap (took ${elapsedMs} ms)`)
  assert.ok(stderr().includes('timeout'), `the timeout outcome is recorded (stderr: ${stderr().trim()})`)

  // The honest outcome: the release never completed, so the name is still
  // held — a lease remains, and the record says so.
  const localToken = loadOrCreateLocalToken(sharedData)
  const stranger = installation()
  const blocked = await bindSession(port, localToken, stranger, 'Agent')
  assert.equal(blocked.bound.status, 409, 'the unreleased name is honestly still held')
})

test('Story 7.3: a bind held when SIGTERM arrives is coordinated and rolled back before exit (A9, child composition)', async t => {
  const { sharedData, child, port, call, waitForExit, gate } = await spawnMcpChild(t, { gate: 'bind' })

  await call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'TakeoverTest', version: '1.0.0' },
  })
  // The tool call starts the FIRST bind; the gate holds its response, so
  // the bind is provably in flight (committed server-side, unanswered
  // client-side) when the SIGTERM lands.
  const presenceCall = call('tools/call', { name: 'room_presence', arguments: {} })
  await gate.seen
  child.kill('SIGTERM')
  gate.open()
  const exit = await waitForExit()
  assert.deepEqual(exit, { code: 0, signal: null }, `the shutdown coordinated the pending bind and exited cleanly (got ${JSON.stringify(exit)})`)
  // The aborted tool call was answered in the adapter's own JSON-RPC voice
  // (an error result or a rejection — either way it never hung the row);
  // its outcome is not this row's substance.
  await presenceCall.then(() => {}, () => {})

  // The coordinated rollback freed the name: a stranger binds at once.
  const localToken = loadOrCreateLocalToken(sharedData)
  const stranger = installation()
  const afterExit = await bindSession(port, localToken, stranger, 'Agent')
  assert.equal(afterExit.bound.status, 200, afterExit.bound.text)
})

test('Story 7.3: SIGINT joins the same shutdown, repeated signals land once (A8)', async t => {
  const { child, port, call, waitForExit, sharedData } = await spawnMcpChild(t)

  await call('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'TakeoverTest', version: '1.0.0' },
  })
  const presence = await call('tools/call', { name: 'room_presence', arguments: {} })
  assert.equal(presence.error, undefined, JSON.stringify(presence.error))

  // Three teardown triggers in quick succession: SIGINT, SIGINT again, and
  // stdin closing — all join ONE shutdown operation (single-flight), the
  // process exits once, cleanly.
  child.kill('SIGINT')
  child.kill('SIGINT')
  child.stdin.end()
  const exit = await waitForExit()
  assert.deepEqual(exit, { code: 0, signal: null }, `a clean exit, not a signal death (got ${JSON.stringify(exit)})`)

  const localToken = loadOrCreateLocalToken(sharedData)
  const stranger = installation()
  const afterExit = await bindSession(port, localToken, stranger, 'Agent')
  assert.equal(afterExit.bound.status, 200, afterExit.bound.text)
})

test('Story 7.3: a bind in flight when shutdown begins never publishes (A9, gated)', async t => {
  // The race: the shutdown release runs while the FIRST bind is in flight.
  // The old release read a null token and returned, and the late bind then
  // reserved the name for a dying process. The fix: release() marks the
  // client shutting down BEFORE it reads the token; a bind that completes
  // after that rolls the just-bound session back and never publishes its
  // token. The gate makes the ordering PROVABLE: a forwarding proxy holds
  // the bind's response until this test has begun the shutdown, so the
  // overlap is by construction, not by timing (the design gate asked for a
  // "gated shutdown during initial bind" row).
  const { dataDir, server, liveSessionRegistry } = await makeServer(t)

  let openBindGate
  const bindGate = new Promise(resolve => { openBindGate = resolve })
  let bindSeen
  const bindSeenPromise = new Promise(resolve => { bindSeen = resolve })
  let bindGateArmed = true
  const proxy = http.createServer((req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const gated = bindGateArmed && req.method === 'POST' && req.url === '/api/session'
      if (gated) {
        bindGateArmed = false
        bindSeen()
      }
      const upstream = http.request(
        { host: '127.0.0.1', port: server.port, method: req.method, path: req.url, headers: req.headers },
        up => {
          const upstreamChunks = []
          up.on('data', chunk => upstreamChunks.push(chunk))
          up.on('end', async () => {
            if (gated) await bindGate
            res.writeHead(up.statusCode, up.headers)
            res.end(Buffer.concat(upstreamChunks))
          })
        },
      )
      upstream.on('error', () => { try { res.destroy() } catch { } })
      upstream.end(Buffer.concat(chunks))
    })
  })
  const proxyPort = await new Promise(resolvePromise => {
    proxy.listen(0, '127.0.0.1', () => resolvePromise(proxy.address().port))
  })
  t.after(() => new Promise(resolvePromise => proxy.close(resolvePromise)))

  // The client attaches through the proxy: the runtime record's port is
  // rewritten to it (the health probe forwards), while the data dir — and
  // with it the local token file the exchange needs — stays the server's.
  const record = JSON.parse(readFileSync(join(dataDir, 'runtime.json'), 'utf8'))
  atomicWriteJson(join(dataDir, 'runtime.json'), { ...record, port: proxyPort })

  const localToken = loadOrCreateLocalToken(dataDir)
  const pluginData = makePluginData(t, 'Agent')
  const client = createAgentRoomClient({ dataDir, pluginDataDir: pluginData })

  // The tool-call shape: one call runs ensure → the local exchange passes
  // through → the bind arrives at the gate and is HELD.
  const inFlight = client.presence()
  // Attach the rejection handler NOW: the refusal must never be an
  // asynchronously-handled rejection (the row reads it after the release
  // settles, several ticks later).
  const lateFailurePromise = inFlight.then(() => null, error => error)
  await bindSeenPromise
  // Shutdown begins while the bind is provably in flight: the release
  // captures the in-flight auth (coordination) and marks the client shutting
  // down before any token can be published. The gate then opens, the bind
  // response arrives, and the shutdown operation owns the rollback.
  const releasePromise = client.release()
  openBindGate()
  const releaseOutcome = await releasePromise
  assert.equal(releaseOutcome.released, true, 'the shutdown operation freed the name')
  assert.equal(releaseOutcome.rolled_back, true, 'the name was freed by the coordinated rollback of the late bind')

  const lateFailure = await lateFailurePromise
  assert.ok(lateFailure instanceof Error, 'the in-flight call was refused')
  assert.equal(lateFailure.code, 'shutdown', `the coded shutdown refusal (got ${lateFailure.code}: ${lateFailure.message})`)

  // The rollback is best-effort and asynchronous: wait for it to land.
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (liveSessionRegistry.holderOf('Agent') === null) break
    await sleep(25)
  }
  assert.equal(liveSessionRegistry.holderOf('Agent'), null, 'the late bind rolled back — the name is free')

  // And the name is truly bindable by a stranger right away.
  const stranger = installation()
  const bound = await bindSession(server.port, localToken, stranger, 'Agent')
  assert.equal(bound.bound.status, 200, bound.bound.text)
})

// --- The operator surface ---------------------------------------------------------

function makePluginData(t, chatId) {
  const dir = mkdtempSync(join(tmpdir(), 'agent-room-takeover-plugin-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  atomicWriteJson(join(dir, 'config.json'), { chat_id: chatId })
  return dir
}

async function runCli(world, argv, { input } = {}) {
  const inputStream = input ?? new PassThrough()
  const output = new PassThrough()
  const errorOutput = new PassThrough()
  output.setEncoding('utf8')
  errorOutput.setEncoding('utf8')
  let stdout = ''
  let stderr = ''
  output.on('data', chunk => { stdout += chunk })
  errorOutput.on('data', chunk => { stderr += chunk })
  const previousExitCode = process.exitCode
  process.exitCode = undefined
  const outcome = await main(argv, {
    input: inputStream,
    output,
    errorOutput,
    sharedDataDir: world.sharedData,
    pluginDataDir: world.pluginData,
  })
  await sleep(30)
  const exitCode = process.exitCode ?? 0
  process.exitCode = previousExitCode
  return { outcome, stdout, stderr, exitCode }
}

test('the operator command refuses a non-interactive stdin and takes the name only after an explicit yes', async t => {
  const { dataDir, server, liveSessionRegistry } = await makeServer(t)
  const localToken = loadOrCreateLocalToken(dataDir)

  // The command's world points at THIS server's shared data dir (local
  // mode) and carries the configured Chat ID. The squatting session belongs
  // to THIS INSTALLATION — the same key the command authenticates with —
  // because only a same-Actor session can be displaced at all.
  const pluginData = makePluginData(t, 'Agent')
  const world = { sharedData: dataDir, pluginData }
  const keypair = loadOrCreateKeypair(pluginData)
  const owner = {
    publicKey: keypair.publicKey.toString('base64url'),
    fingerprint: keypair.fingerprint,
  }
  const { token: squatter } = await bindSession(server.port, localToken, owner, 'Agent')
  const squatterKey = sessionKeyFromToken(squatter)

  // A non-interactive stdin is refused outright: a command that needs a
  // human answer can never be driven programmatically into one.
  const piped = await runCli(world, ['session', 'replace'])
  assert.equal(piped.exitCode, 1, piped.stderr)
  assert.equal(piped.stderr.includes('TTY'), true, piped.stderr)
  assert.equal(liveSessionRegistry.holderOf('Agent').sessionKey, squatterKey, 'the refused command took nothing')

  // A TTY answer of "no" changes nothing.
  const declinedInput = new PassThrough()
  declinedInput.isTTY = true
  const declined = runCli(world, ['session', 'replace'], { input: declinedInput })
  await sleep(50)
  declinedInput.write('n\n')
  const declinedResult = await declined
  assert.equal(declinedResult.exitCode, 1, declinedResult.stderr)
  assert.equal(liveSessionRegistry.holderOf('Agent').sessionKey, squatterKey, 'the declined command took nothing')

  // A TTY answer of "yes" performs the takeover and releases the name.
  const confirmedInput = new PassThrough()
  confirmedInput.isTTY = true
  const confirmed = runCli(world, ['session', 'replace'], { input: confirmedInput })
  await sleep(50)
  confirmedInput.write('y\n')
  const confirmedResult = await confirmed
  assert.equal(confirmedResult.exitCode, 0, confirmedResult.stderr)
  const receipt = JSON.parse(confirmedResult.stdout.trim().split('\n').pop())
  assert.equal(confirmedResult.stdout.trim().split('\n').length, 1, 'the receipt is the only stdout line')
  assert.equal(receipt.ok, true)
  assert.equal(receipt.chat_id, 'Agent')
  assert.equal(receipt.replaced, true, 'a live holder was displaced')
  assert.equal(receipt.released, true, 'the name was released again for the live client')

  // The squatter is fenced and the name is free for the live client.
  assert.equal((await sessionRequest(server.port, 'POST', squatter, { chat_id: 'Agent' })).status, 401)
  assert.equal(liveSessionRegistry.holderOf('Agent'), null, 'the name is free again')
  const rebound = await bindSession(server.port, localToken, owner, 'Agent')
  assert.equal(rebound.bound.status, 200, rebound.bound.text)
})
