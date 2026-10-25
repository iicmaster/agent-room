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
import { AuthzStage, AuthStage, runPipeline } from '../server/api/pipeline.mjs'
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

// One session of one installation: authenticate, then bind a name.
async function bindSession(port, localToken, installation_, chatId, { replace = false } = {}) {
  const token = await exchange(port, installation_, localToken)
  const body = { chat_id: chatId, client_type: 'mcp' }
  if (replace) body.replace_existing = true
  const bound = await sessionRequest(port, 'POST', token, body)
  return { token, bound }
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
  // from a quiet one.
  const restarted = await exchange(server.port, alice, localToken)
  const plain = await sessionRequest(server.port, 'POST', restarted, { chat_id: 'Agent', client_type: 'mcp' })
  assert.equal(plain.status, 409, plain.text)
  assert.equal(plain.json.error.code, 'chat_id_taken')
  assert.equal(liveSessionRegistry.holderOf('Agent').sessionKey, deadKey, 'the refused bind changed nothing')

  // The explicit takeover: the operator asks for the handoff by name.
  const takeover = await sessionRequest(server.port, 'POST', restarted, {
    chat_id: 'Agent',
    client_type: 'mcp',
    replace_existing: true,
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
  const takeover = await sessionRequest(server.port, 'POST', takeoverToken, {
    chat_id: 'Agent',
    client_type: 'mcp',
    replace_existing: true,
  })
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
  await sessionRequest(server.port, 'POST', takeoverToken, {
    chat_id: 'Agent',
    client_type: 'mcp',
    replace_existing: true,
  })
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

test('two competing takeovers: the last explicit intent wins, and the loser is fenced', async t => {
  const { dataDir, server, liveSessionRegistry } = await makeServer(t)
  const localToken = loadOrCreateLocalToken(dataDir)
  const alice = installation()

  const { token: first } = await bindSession(server.port, localToken, alice, 'Agent')
  const second = await exchange(server.port, alice, localToken)
  const third = await exchange(server.port, alice, localToken)

  const takeTwo = await sessionRequest(server.port, 'POST', second, {
    chat_id: 'Agent', client_type: 'mcp', replace_existing: true,
  })
  assert.equal(takeTwo.status, 200, takeTwo.text)
  const takeThree = await sessionRequest(server.port, 'POST', third, {
    chat_id: 'Agent', client_type: 'mcp', replace_existing: true,
  })
  assert.equal(takeThree.status, 200, takeThree.text)
  assert.equal(takeThree.json.result.replaced, true)

  // The middle session is fenced by the last handoff; the first was fenced
  // by the second.
  assert.equal((await sessionRequest(server.port, 'POST', first, { chat_id: 'Agent' })).status, 401)
  assert.equal((await sessionRequest(server.port, 'POST', second, { chat_id: 'Agent' })).status, 401)
  assert.equal(liveSessionRegistry.holderOf('Agent').sessionKey, sessionKeyFromToken(third))
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
  const failed = await sessionRequest(server.port, 'POST', takeoverToken, {
    chat_id: 'Agent',
    client_type: 'mcp',
    replace_existing: true,
  })
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
  const takeover = await sessionRequest(server.port, 'POST', takeoverToken, {
    chat_id: 'Agent',
    client_type: 'mcp',
    replace_existing: true,
  })
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
  // The mechanism behind "admission alone is never authority": the
  // authorization stage re-checks the fence immediately before the handler
  // runs, so a request admitted BEFORE the handoff is refused rather than
  // landing after it. This row drives the stage directly — the HTTP rows
  // above prove the token is revoked, this one proves the in-flight request
  // is refused.
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

  // The long-poll enters its hold with nothing new to deliver.
  const pollPromise = request(
    server.port,
    'GET',
    `/api/rooms/${broadcastRoomId}/messages?after_seq=0&wait_ms=10000`,
    { headers: { [PROTOCOL_KEY]: '1', authorization: `Bearer ${deadToken}` } },
  )
  await new Promise(resolvePromise => { setTimeout(resolvePromise, 250) })

  // The explicit takeover displaces the polling session while it holds.
  const restarted = await exchange(server.port, alice, localToken)
  const takeover = await sessionRequest(server.port, 'POST', restarted, {
    chat_id: 'Agent', client_type: 'mcp', replace_existing: true,
  })
  assert.equal(takeover.status, 200, takeover.text)
  assert.equal(liveSessionRegistry.holderOf('Agent').sessionKey !== deadKey, true)

  // The very next wake answers the fence, not a page of messages.
  const pollOutcome = await pollPromise
  assert.equal(pollOutcome.status, 401, pollOutcome.text)
  assert.equal(pollOutcome.json?.error?.code, 'unauthorized')
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
  const takeover = await sessionRequest(server.port, 'POST', takeoverToken, {
    chat_id: 'Agent', client_type: 'mcp', replace_existing: true,
  })
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
