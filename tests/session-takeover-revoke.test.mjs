// Story 1.3 acceptance: crash-safe resume, 4-case takeover matrix + CAS,
// client state preservation + <=3 HTTP budget + STOP_CODES, and host-local
// CLI revoke + zero-write clean 2nd boot.

import assert from 'node:assert/strict'
import { generateKeyPairSync, randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import { loadOrCreateLocalToken } from '../server/api/local-token.mjs'
import { startServer } from '../server/api/server.mjs'
import { main } from '../server/cli/agent-room.mjs'
import { createAgentRoomClient } from '../server/client/api-client.mjs'
import {
  clearSessionState,
  loadSessionState,
  newRecoveryId,
  saveSessionState,
  sessionStatePath,
} from '../server/client/session-state.mjs'
import {
  CONFLICT_TICKET_TTL_MS,
  SESSION_REVOKE_REASON_MAX,
} from '../server/constants.mjs'
import { fingerprintFromPublicKey } from '../server/keys.mjs'
import { startNotifier } from '../server/notification/notifier.mjs'
import { openRoomLog, ROOM_LOG_DATABASE_FILENAME } from '../server/store/room-log.mjs'

const PROTOCOL_KEY = 'agent-room-protocol'

const sleep = ms => new Promise(resolve => { setTimeout(resolve, ms) })

function makeInstallation() {
  const { publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const raw = spki.subarray(spki.length - 32)
  return {
    raw,
    publicKey: raw.toString('base64url'),
    fingerprint: fingerprintFromPublicKey(raw),
  }
}

function makeTempDir(t, prefix = 'agent-room-s13-') {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function bootTestServer(t, { dataDir, nowMs } = {}) {
  const dir = dataDir ?? makeTempDir(t)
  const store = openRoomLog({ dataDir: dir, role: 'server' })
  const server = await startServer({
    dataDir: dir,
    host: '127.0.0.1',
    port: 0,
    store,
    ...(nowMs === undefined ? {} : { now: nowMs }),
  })
  t.after(async () => {
    try { await server.close() } catch { /* already closed */ }
    try { store.close() } catch { /* already closed */ }
  })
  const token = loadOrCreateLocalToken(dir)
  return { dataDir: dir, store, server, port: server.port, token }
}

function requestJson(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1',
      port,
      method,
      path,
      agent: false,
      headers: {
        [PROTOCOL_KEY]: '1',
        ...(body === undefined ? {} : {
          'content-type': 'application/json; charset=utf-8',
          'content-length': Buffer.byteLength(body),
        }),
        ...headers,
      },
    }, res => {
      const chunks = []
      res.on('data', chunk => chunks.push(chunk))
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8')
        let parsed = null
        try { parsed = JSON.parse(text) } catch { /* non-json */ }
        resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: () => parsed })
      })
    })
    req.on('error', reject)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

function bearerHeaders(sessionToken) {
  return { authorization: `Bearer ${sessionToken}` }
}

function capHeaders(capability) {
  return { authorization: `Session ${capability}` }
}

async function authenticateLocal(port, localToken, install) {
  const auth = await requestJson(port, 'POST', '/api/auth/local', {
    headers: bearerHeaders(localToken),
    body: JSON.stringify({ public_key: install.publicKey }),
  })
  assert.equal(auth.status, 200, auth.text)
  return auth.json().result.session_token
}

test('WRONG_ROUTE_REJECTION: takeover fields are rejected on non-allocate routes and validated on allocate', async t => {
  const { port, token } = await bootTestServer(t)
  const inst = makeInstallation()
  const sTok = await authenticateLocal(port, token, inst)

  const alloc = await requestJson(port, 'POST', '/api/session-principals', {
    headers: bearerHeaders(sTok),
    body: JSON.stringify({ base_chat_id: 'alice', machine: 'mac', client_type: 'api' }),
  })
  assert.equal(alloc.status, 200, alloc.text)
  const p = alloc.json().result

  // Non-allocate routes reject replace_existing / conflict_ticket with 400 unknown_field naming the field.
  for (const [method, path, headers, body] of [
    ['POST', '/api/session-principals/resume', capHeaders(p.session_capability), { session_id: p.session_id, generation: p.generation, replace_existing: true }],
    ['POST', '/api/session-principals/resume', capHeaders(p.session_capability), { session_id: p.session_id, generation: p.generation, conflict_ticket: 'sp:abc' }],
    ['POST', '/api/session-principals/heartbeat', capHeaders(p.session_capability), { session_id: p.session_id, generation: p.generation, replace_existing: true }],
    ['DELETE', '/api/session-principals/current', capHeaders(p.session_capability), { session_id: p.session_id, generation: p.generation, conflict_ticket: 'sp:abc' }],
    ['POST', '/api/session-principals/revoke', bearerHeaders(sTok), { session_id: p.session_id, replace_existing: true }],
    ['PATCH', '/api/session', bearerHeaders(sTok), { chat_id: 'alice', replace_existing: true }],
  ]) {
    const res = await requestJson(port, method, path, { headers, body: JSON.stringify(body) })
    assert.equal(res.status, 400, `${method} ${path} -> ${res.text}`)
    const err = res.json().error
    assert.ok(err.code === 'unknown_field' || err.code === 'invalid_request', `${method} ${path} -> ${res.text}`)
    if (err.code === 'unknown_field') {
      assert.match(err.message, /replace_existing|conflict_ticket/)
    }
  }

  // POST /api/session-principals validates replace_existing boolean, required conflict_ticket, and recovery_id pattern.
  const missingTicket = await requestJson(port, 'POST', '/api/session-principals', {
    headers: bearerHeaders(sTok),
    body: JSON.stringify({ base_chat_id: 'alice', machine: 'mac', client_type: 'api', replace_existing: true }),
  })
  assert.equal(missingTicket.status, 400)
  assert.equal(missingTicket.json().error.code, 'invalid_request')

  const badBool = await requestJson(port, 'POST', '/api/session-principals', {
    headers: bearerHeaders(sTok),
    body: JSON.stringify({ base_chat_id: 'alice', machine: 'mac', client_type: 'api', replace_existing: 'yes' }),
  })
  assert.equal(badBool.status, 400)
  assert.equal(badBool.json().error.code, 'invalid_request')

  const badRecovery = await requestJson(port, 'POST', '/api/session-principals', {
    headers: bearerHeaders(sTok),
    body: JSON.stringify({ base_chat_id: 'bob', machine: 'mac', client_type: 'api', recovery_id: 'too-short' }),
  })
  assert.equal(badRecovery.status, 400)
  assert.equal(badRecovery.json().error.code, 'invalid_request')
})

test('TAKEOVER_MATRIX_4_CASES_AND_CAS: Principal->Principal, Legacy->Principal, Principal->Legacy, Cross-Install, CAS stale, cross-namespace resume', async t => {
  const { port, token, store } = await bootTestServer(t)
  const instA = makeInstallation()
  const instB = makeInstallation()
  const tokA = await authenticateLocal(port, token, instA)
  const tokB = await authenticateLocal(port, token, instB)

  // Case 1: Principal -> Principal (same installation)
  const alloc1 = await requestJson(port, 'POST', '/api/session-principals', {
    headers: bearerHeaders(tokA),
    body: JSON.stringify({ base_chat_id: 'alice', machine: 'mac', client_type: 'api' }),
  })
  assert.equal(alloc1.status, 200, alloc1.text)
  const p1 = alloc1.json().result
  assert.equal(p1.replaced, false)

  const conflict1 = await requestJson(port, 'POST', '/api/session-principals', {
    headers: bearerHeaders(tokA),
    body: JSON.stringify({ base_chat_id: 'alice', machine: 'mac', client_type: 'api' }),
  })
  assert.equal(conflict1.status, 409)
  assert.equal(conflict1.json().error.code, 'agent_id_taken')
  const ticket1 = conflict1.json().error.conflict_ticket
  assert.ok(typeof ticket1 === 'string' && ticket1.length > 0, `expected conflict_ticket, got ${ticket1}`)

  // CAS conflict_stale: p1 releases & resumes (bumping generation), then old ticket1 is stale.
  const release1 = await requestJson(port, 'DELETE', '/api/session-principals/current', {
    headers: capHeaders(p1.session_capability),
  })
  assert.equal(release1.status, 200)
  const resume1 = await requestJson(port, 'POST', '/api/session-principals/resume', {
    headers: capHeaders(p1.session_capability),
    body: JSON.stringify({ session_id: p1.session_id, generation: p1.generation }),
  })
  assert.equal(resume1.status, 200, resume1.text)
  const p1Resumed = resume1.json().result

  const staleTakeover = await requestJson(port, 'POST', '/api/session-principals', {
    headers: bearerHeaders(tokA),
    body: JSON.stringify({ base_chat_id: 'alice', machine: 'mac', client_type: 'api', replace_existing: true, conflict_ticket: ticket1 }),
  })
  assert.equal(staleTakeover.status, 409, staleTakeover.text)
  assert.equal(staleTakeover.json().error.code, 'conflict_stale')

  // Fresh ticket -> Principal -> Principal takeover succeeds.
  const conflict1b = await requestJson(port, 'POST', '/api/session-principals', {
    headers: bearerHeaders(tokA),
    body: JSON.stringify({ base_chat_id: 'alice', machine: 'mac', client_type: 'api' }),
  })
  assert.equal(conflict1b.status, 409)
  const ticket1b = conflict1b.json().error.conflict_ticket

  const takeover1 = await requestJson(port, 'POST', '/api/session-principals', {
    headers: bearerHeaders(tokA),
    body: JSON.stringify({ base_chat_id: 'alice', machine: 'mac', client_type: 'api', replace_existing: true, conflict_ticket: ticket1b }),
  })
  assert.equal(takeover1.status, 200, takeover1.text)
  const p2 = takeover1.json().result
  assert.equal(p2.replaced, true)
  assert.equal(p2.address, p1.address)
  assert.equal(p2.session_id, p1.session_id)
  assert.equal(p2.generation, p1Resumed.generation + 1)
  assert.notEqual(p2.session_capability, p1Resumed.session_capability)
  const oldHolderCheck = await requestJson(port, 'GET', '/api/status', {
    headers: capHeaders(p1Resumed.session_capability),
  })
  assert.equal(oldHolderCheck.status, 401)
  assert.equal(oldHolderCheck.json().error.code, 'session_credential_invalid')

  // Case 4: Cross-Installation -> omits conflict_ticket.
  const crossConflict = await requestJson(port, 'POST', '/api/session-principals', {
    headers: bearerHeaders(tokB),
    body: JSON.stringify({ base_chat_id: 'alice', machine: 'mac', client_type: 'api' }),
  })
  assert.equal(crossConflict.status, 409)
  assert.equal(crossConflict.json().error.code, 'agent_id_taken')
  assert.equal(crossConflict.json().error.conflict_ticket, undefined)

  // Case 3: Principal -> Legacy (same installation via a second Bearer session on instA).
  const tokA2 = await authenticateLocal(port, token, instA)
  const legacyConflict = await requestJson(port, 'POST', '/api/session', {
    headers: bearerHeaders(tokA2),
    body: JSON.stringify({ chat_id: 'alice', client_type: 'api' }),
  })
  assert.equal(legacyConflict.status, 409, legacyConflict.text)
  assert.equal(legacyConflict.json().error.code, 'agent_id_taken')
  const spTicket = legacyConflict.json().error.conflict_ticket
  assert.ok(typeof spTicket === 'string' && spTicket.length > 0)

  const legacyTakeover = await requestJson(port, 'POST', '/api/session', {
    headers: bearerHeaders(tokA2),
    body: JSON.stringify({ chat_id: 'alice', client_type: 'api', replace_existing: true, conflict_ticket: spTicket }),
  })
  assert.equal(legacyTakeover.status, 200, legacyTakeover.text)
  assert.equal(legacyTakeover.json().result.replaced, true)
  assert.equal(store.getSessionPrincipalStatus(p2.session_id).principal_status, 'retained')

  // Cross-namespace /resume check: p2 tries to resume while legacy tokA holds 'alice' -> 409 agent_id_taken (not 500).
  const crossNsResume = await requestJson(port, 'POST', '/api/session-principals/resume', {
    headers: capHeaders(p2.session_capability),
    body: JSON.stringify({ session_id: p2.session_id, generation: p2.generation }),
  })
  assert.equal(crossNsResume.status, 409, crossNsResume.text)
  assert.equal(crossNsResume.json().error.code, 'agent_id_taken')

  // Case 2: Legacy -> Principal (same installation via POST /api/session-principals).
  const pConflict = await requestJson(port, 'POST', '/api/session-principals', {
    headers: bearerHeaders(tokA),
    body: JSON.stringify({ base_chat_id: 'alice', machine: 'mac', client_type: 'api' }),
  })
  assert.equal(pConflict.status, 409, pConflict.text)
  const lsTicket = pConflict.json().error.conflict_ticket
  assert.ok(typeof lsTicket === 'string' && lsTicket.length > 0, `expected conflict_ticket, got ${lsTicket}`)

  const pTakeover = await requestJson(port, 'POST', '/api/session-principals', {
    headers: bearerHeaders(tokA),
    body: JSON.stringify({ base_chat_id: 'alice', machine: 'mac', client_type: 'api', replace_existing: true, conflict_ticket: lsTicket }),
  })
  assert.equal(pTakeover.status, 200, pTakeover.text)
  assert.equal(pTakeover.json().result.replaced, true)
})

test('CRASH_SAFE_RECOVERY_ID: 60s retry survives dropped response & server restart, clears on new-cap use, expires >60s, and T2 retry works', async t => {
  const dataDir = makeTempDir(t)
  const env1 = await bootTestServer(t, { dataDir })
  const inst = makeInstallation()
  const tok = await authenticateLocal(env1.port, env1.token, inst)
  const recId = newRecoveryId()

  const alloc = await requestJson(env1.port, 'POST', '/api/session-principals', {
    headers: bearerHeaders(tok),
    body: JSON.stringify({ base_chat_id: 'bob', machine: 'mac', client_type: 'api', recovery_id: recId }),
  })
  assert.equal(alloc.status, 200, alloc.text)
  const b0 = alloc.json().result

  // Release b0 so it is offline.
  const rel = await requestJson(env1.port, 'DELETE', '/api/session-principals/current', {
    headers: capHeaders(b0.session_capability),
  })
  assert.equal(rel.status, 200)

  // First /resume rotates capability -> cap1 (simulate client crashing before saving cap1).
  const res1 = await requestJson(env1.port, 'POST', '/api/session-principals/resume', {
    headers: capHeaders(b0.session_capability),
    body: JSON.stringify({ session_id: b0.session_id, generation: b0.generation, recovery_id: recId }),
  })
  assert.equal(res1.status, 200, res1.text)
  const b1 = res1.json().result
  assert.notEqual(b1.session_capability, b0.session_capability)
  assert.equal(b1.generation, b0.generation + 1)

  // prev_capability MUST be rejected on non-/resume routes.
  const oldOnStatus = await requestJson(env1.port, 'GET', '/api/status', {
    headers: capHeaders(b0.session_capability),
  })
  assert.equal(oldOnStatus.status, 401)
  assert.equal(oldOnStatus.json().error.code, 'session_credential_invalid')

  // Retry /resume with OLD capability + matching recovery_id (e.g. dropped response) -> rotates to cap2.
  const res2 = await requestJson(env1.port, 'POST', '/api/session-principals/resume', {
    headers: capHeaders(b0.session_capability),
    body: JSON.stringify({ session_id: b0.session_id, generation: b0.generation, recovery_id: recId }),
  })
  assert.equal(res2.status, 200, res2.text)
  const b2 = res2.json().result
  assert.notEqual(b2.session_capability, b1.session_capability)
  assert.equal(b2.generation, b1.generation + 1)

  // Restart server completely and retry again within 60s of t0 -> still succeeds!
  await env1.server.close()
  env1.store.close()
  const env2 = await bootTestServer(t, { dataDir })

  const res3 = await requestJson(env2.port, 'POST', '/api/session-principals/resume', {
    headers: capHeaders(b0.session_capability),
    body: JSON.stringify({ session_id: b0.session_id, generation: b0.generation, recovery_id: recId }),
  })
  assert.equal(res3.status, 200, res3.text)
  const b3 = res3.json().result
  assert.notEqual(b3.session_capability, b2.session_capability)
  assert.equal(b3.generation, b2.generation + 1)

  // First authenticated request using new capability b3 clears pending recovery immediately.
  const statusOk = await requestJson(env2.port, 'GET', '/api/status', {
    headers: capHeaders(b3.session_capability),
  })
  assert.equal(statusOk.status, 200, statusOk.text)
  assert.equal(env2.store.getSessionPrincipalStatus(b3.session_id).has_pending_recovery, false)

  // Now retrying /resume with b0.session_capability MUST fail 401.
  const afterClear = await requestJson(env2.port, 'POST', '/api/session-principals/resume', {
    headers: capHeaders(b0.session_capability),
    body: JSON.stringify({ session_id: b0.session_id, generation: b0.generation, recovery_id: recId }),
  })
  assert.equal(afterClear.status, 401)
  assert.equal(afterClear.json().error.code, 'session_credential_invalid')

  // Test > 60s expiry (t0 not extended).
  const rel2 = await requestJson(env2.port, 'DELETE', '/api/session-principals/current', {
    headers: capHeaders(b3.session_capability),
  })
  assert.equal(rel2.status, 200)
  const recId2 = newRecoveryId()
  const res4 = await requestJson(env2.port, 'POST', '/api/session-principals/resume', {
    headers: capHeaders(b3.session_capability),
    body: JSON.stringify({ session_id: b3.session_id, generation: b3.generation, recovery_id: recId2 }),
  })
  assert.equal(res4.status, 200)
  // Backdate rotated_at past 60s TTL directly in SQLite so the real server rejects expired recovery.
  const rwDb = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME))
  rwDb.prepare('UPDATE session_principals SET rotated_at = ? WHERE session_id = ?').run(
    new Date(Date.now() - CONFLICT_TICKET_TTL_MS - 1000).toISOString(),
    b3.session_id,
  )
  rwDb.close()
  const expiredRetry = await requestJson(env2.port, 'POST', '/api/session-principals/resume', {
    headers: capHeaders(b3.session_capability),
    body: JSON.stringify({ session_id: b3.session_id, generation: b3.generation, recovery_id: recId2 }),
  })
  assert.equal(expiredRetry.status, 401)
  assert.equal(expiredRetry.json().error.code, 'session_credential_invalid')

  // Test T2 takeover recovery_id retry within 60s even after ticket redemption.
  const b4 = res4.json().result
  const tok2 = await authenticateLocal(env2.port, env2.token, inst)
  const conflict = await requestJson(env2.port, 'POST', '/api/session-principals', {
    headers: bearerHeaders(tok2),
    body: JSON.stringify({ base_chat_id: 'bob', machine: 'mac', client_type: 'api' }),
  })
  assert.equal(conflict.status, 409)
  const ticket = conflict.json().error.conflict_ticket
  const t2RecId = newRecoveryId()

  const t2First = await requestJson(env2.port, 'POST', '/api/session-principals', {
    headers: bearerHeaders(tok2),
    body: JSON.stringify({ base_chat_id: 'bob', machine: 'mac', client_type: 'api', replace_existing: true, conflict_ticket: ticket, recovery_id: t2RecId }),
  })
  assert.equal(t2First.status, 200, t2First.text)
  const t2p1 = t2First.json().result
  assert.equal(t2p1.replaced, true)
  assert.equal(t2p1.session_id, b4.session_id)
  assert.equal(t2p1.generation, b4.generation + 1)

  // Retry exact same T2 takeover (ticket already redeemed) with same recovery_id within 60s -> succeeds idempotently.
  const t2Retry = await requestJson(env2.port, 'POST', '/api/session-principals', {
    headers: bearerHeaders(tok2),
    body: JSON.stringify({ base_chat_id: 'bob', machine: 'mac', client_type: 'api', replace_existing: true, conflict_ticket: ticket, recovery_id: t2RecId }),
  })
  assert.equal(t2Retry.status, 200, t2Retry.text)
  const t2p2 = t2Retry.json().result
  assert.equal(t2p2.replaced, true)
  assert.equal(t2p2.session_id, t2p1.session_id)
  assert.notEqual(t2p2.session_capability, t2p1.session_capability)
})

test('CLIENT_HYGIENE_AND_BUDGET: clearSessionState preserves cursors.json, <=3 HTTP calls on 401, notifier stops on session_revoked', async t => {
  const pluginDataDir = makeTempDir(t, 'agent-room-plugin-')
  const scope = 'scope-preserve'
  const dir = dirname(sessionStatePath(pluginDataDir, scope))
  mkdirSync(dir, { recursive: true })
  const cursorsPath = join(dir, 'cursors.json')
  const inboxPath = join(dir, 'inbox.jsonl')
  const cursorsPayload = '{"room-1":42}\n'
  const inboxPayload = '{"seq":1}\n'
  writeFileSync(cursorsPath, cursorsPayload, 'utf8')
  writeFileSync(inboxPath, inboxPayload, 'utf8')

  saveSessionState(pluginDataDir, scope, {
    sessionId: 'sp-1',
    generation: 1,
    address: 'carol~aaaaaaaaaa@inst-1',
    baseName: 'carol',
    machine: 'inst-1',
    capability: 'a'.repeat(43),
    recoveryId: newRecoveryId(),
  })
  assert.ok(loadSessionState(pluginDataDir, scope))

  clearSessionState(pluginDataDir, scope)
  assert.equal(loadSessionState(pluginDataDir, scope), null)
  assert.equal(readFileSync(cursorsPath, 'utf8'), cursorsPayload)
  assert.equal(readFileSync(inboxPath, 'utf8'), inboxPayload)

  // Notifier halts cleanly when session_revoked is encountered.
  let stopped = false
  const stopPromise = new Promise(resolve => {
    const notifier = startNotifier({
      client: {
        listRooms: async () => {
          const err = new Error('revoked')
          err.code = 'session_revoked'
          throw err
        },
      },
      pluginDataDir,
      realmIdOf: () => 'realm-1',
      env: { ...process.env, AGENT_ROOM_NOTIFIER: '1' },
      errorOutput: new PassThrough(),
      onStop: () => {
        stopped = true
        resolve(true)
      },
      refreshMs: 10,
      spacingMs: 1,
    })
    t.after(() => notifier.stop())
  })
  assert.equal(await stopPromise, true)
  assert.equal(stopped, true)

  // <= 3 HTTP calls budget on 401 session_credential_invalid (no Bearer re-auth loop).
  const { port, token, dataDir } = await bootTestServer(t)
  const inst = makeInstallation()
  const tok = await authenticateLocal(port, token, inst)
  const peerAlloc = await requestJson(port, 'POST', '/api/session-principals', {
    headers: bearerHeaders(tok),
    body: JSON.stringify({ base_chat_id: 'carol-peer', machine: 'mac', client_type: 'api' }),
  })
  assert.equal(peerAlloc.status, 200)
  const peer = peerAlloc.json().result

  const clientScope = 'client-budget-test'
  writeFileSync(join(pluginDataDir, 'config.json'), JSON.stringify({ chat_id: 'carol' }), 'utf8')
  const client = createAgentRoomClient({
    baseUrl: `http://127.0.0.1:${port}`,
    dataDir,
    pluginDataDir,
    sessionScope: clientScope,
    localToken: token,
    sessionPrincipals: true,
  })
  t.after(() => client.release().catch(() => {}))

  const c0 = await client.ensureSessionPrincipal('carol')
  const recId = newRecoveryId()
  saveSessionState(pluginDataDir, clientScope, {
    ...c0,
    recoveryId: recId,
  })

  // Rotate capability on server (simulating dropped response from a prior /resume).
  const serverResumed = await requestJson(port, 'POST', '/api/session-principals/resume', {
    headers: capHeaders(c0.capability),
    body: JSON.stringify({ session_id: c0.sessionId, generation: c0.generation, recovery_id: recId }),
  })
  assert.equal(serverResumed.status, 200, serverResumed.text)

  const originalHttpRequest = http.request
  const calls = []
  http.request = function wrappedRequest(options, cb) {
    calls.push({ method: options?.method ?? 'GET', path: options?.path ?? '' })
    return originalHttpRequest.apply(this, arguments)
  }
  t.after(() => { http.request = originalHttpRequest })

  const sendRes = await client.sendToAddress({ to: peer.address, text: 'hello after rotate' })
  assert.ok(sendRes && typeof sendRes.seq === 'number')
  // 1) POST /api/messages (401), 2) POST /api/session-principals/resume (200), 3) POST /api/messages (200) => <= 3 calls, 0 auth/local!
  assert.ok(calls.length <= 3, `expected <= 3 HTTP calls, got ${calls.length}: ${calls.map(c => `${c.method} ${c.path}`).join(', ')}`)
  assert.equal(calls.filter(c => c.path.includes('/api/auth/')).length, 0)

  const savedAfter = loadSessionState(pluginDataDir, clientScope)
  assert.ok(savedAfter)
  assert.equal(savedAfter.recoveryId, null)
  assert.notEqual(savedAfter.capability, c0.capability)
})

test('HOST_REVOKE_CLI_AND_ZERO_WRITE_BOOT_AND_LONG_POLL_WAKE: CLI revoke by address/id, missing DB, 0-write 2nd boot, long-poll fence', async t => {
  const dataDir = makeTempDir(t)
  const env1 = await bootTestServer(t, { dataDir })
  const inst = makeInstallation()
  const tok = await authenticateLocal(env1.port, env1.token, inst)

  // Verify clean 2nd boot performs 0 SQLite writes.
  const roDb = new DatabaseSync(join(dataDir, ROOM_LOG_DATABASE_FILENAME), { readOnly: true })
  t.after(() => { try { roDb.close() } catch {} })
  const dataVerBefore = roDb.prepare('PRAGMA data_version').get().data_version
  const store2 = openRoomLog({ dataDir, role: 'server' })
  t.after(() => { try { store2.close() } catch {} })
  const dataVerAfter = roDb.prepare('PRAGMA data_version').get().data_version
  assert.equal(dataVerAfter, dataVerBefore, 'clean 2nd boot must perform 0 SQLite writes')

  // Allocate two principals to revoke by address and by session_id.
  const allocA = await requestJson(env1.port, 'POST', '/api/session-principals', {
    headers: bearerHeaders(tok),
    body: JSON.stringify({ base_chat_id: 'dave', machine: 'mac', client_type: 'api' }),
  })
  assert.equal(allocA.status, 200, allocA.text)
  const dave = allocA.json().result

  const allocB = await requestJson(env1.port, 'POST', '/api/session-principals', {
    headers: bearerHeaders(tok),
    body: JSON.stringify({ base_chat_id: 'erin', machine: 'mac', client_type: 'api' }),
  })
  assert.equal(allocB.status, 200, allocB.text)
  const erin = allocB.json().result

  // Long-poll wake check: dave starts a long-poll, then CLI revokes dave -> long-poll wakes with 401 session_revoked.
  const pairRes = await requestJson(env1.port, 'POST', '/api/messages', {
    headers: capHeaders(dave.session_capability),
    body: JSON.stringify({ to: erin.address, text: 'ping', client_message_id: randomUUID() }),
  })
  assert.equal(pairRes.status, 200, pairRes.text)
  const roomId = pairRes.json().result.room_id

  const pollPromise = requestJson(env1.port, 'GET', `/api/rooms/${roomId}/messages?after_seq=1&wait_ms=2000`, {
    headers: capHeaders(dave.session_capability),
  })
  await sleep(60)

  const runCli = async argv => {
    const out = new PassThrough()
    const err = new PassThrough()
    const outChunks = []
    const errChunks = []
    out.on('data', c => outChunks.push(c))
    err.on('data', c => errChunks.push(c))
    process.exitCode = 0
    const outcome = await main(argv, {
      sharedDataDir: dataDir,
      env: { ...process.env, AGENT_ROOM_DATA_DIR: dataDir },
      output: out,
      errorOutput: err,
    })
    const code = process.exitCode ?? 0
    process.exitCode = 0
    return {
      outcome,
      exitCode: code,
      stdout: Buffer.concat(outChunks).toString('utf8'),
      stderr: Buffer.concat(errChunks).toString('utf8'),
    }
  }

  const revokeDave = await runCli(['session-principals', 'revoke', dave.address, '--reason', 'host-maintenance', '--json'])
  assert.equal(revokeDave.exitCode, 0, revokeDave.stderr)
  const revokeDaveJson = JSON.parse(revokeDave.stdout.trim())
  assert.equal(revokeDaveJson.ok, true)
  assert.equal(revokeDaveJson.principal_status, 'revoked')
  assert.equal(revokeDaveJson.revoked_reason, 'host-maintenance')

  const pollRes = await pollPromise
  assert.equal(pollRes.status, 401, pollRes.text)
  assert.equal(pollRes.json().error.code, 'session_revoked')

  // Subsequent API call with dave's capability returns 401 session_revoked.
  const daveStatus = await requestJson(env1.port, 'GET', '/api/status', {
    headers: capHeaders(dave.session_capability),
  })
  assert.equal(daveStatus.status, 401)
  assert.equal(daveStatus.json().error.code, 'session_revoked')

  // Revoke erin by session_id.
  const revokeErin = await runCli(['session-principals', 'revoke', erin.session_id, '--json'])
  assert.equal(revokeErin.exitCode, 0, revokeErin.stderr)
  assert.equal(JSON.parse(revokeErin.stdout.trim()).session_id, erin.session_id)

  // Missing principal -> exit 1.
  const missingPrincipal = await runCli(['session-principals', 'revoke', 'nobody@missing'])
  assert.equal(missingPrincipal.exitCode, 1)
  assert.match(missingPrincipal.stderr, /no retained session principal matches/)

  // --reason > 200 chars -> exit 2.
  const tooLongReason = await runCli(['session-principals', 'revoke', erin.session_id, '--reason', 'x'.repeat(SESSION_REVOKE_REASON_MAX + 1)])
  assert.equal(tooLongReason.exitCode, 2)

  // Missing DB -> exit 1 WITHOUT creating the DB file.
  const emptyDir = makeTempDir(t, 'agent-room-missing-db-')
  const out2 = new PassThrough()
  const err2 = new PassThrough()
  process.exitCode = 0
  await main(['session-principals', 'revoke', 'alice~aaaaaaaaaa@inst'], {
    sharedDataDir: emptyDir,
    env: { ...process.env, AGENT_ROOM_DATA_DIR: emptyDir },
    output: out2,
    errorOutput: err2,
  })
  assert.equal(process.exitCode, 1)
  process.exitCode = 0
  assert.equal(existsSync(join(emptyDir, ROOM_LOG_DATABASE_FILENAME)), false)
})
