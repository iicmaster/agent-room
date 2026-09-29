// The Remote Mode journey driver (Story 4.3): a real child process spawned by
// tests/remote-client.test.mjs that runs the whole configured-URL story
// end to end — the real server code (startServer), a real TLS front, the real
// enrollment route, and the real api-client pointed at a configured https
// origin by its persisted remote config alone.
//
// WHY A CHILD PROCESS: the happy path needs a TLS certificate the client's
// DEFAULT verification trusts (the policy under test — this tree has no
// certificate-verification override anywhere). The parent test process cannot
// add a private root at runtime (tls.rootCertificates is frozen by design), so
// the driver is spawned with NODE_EXTRA_CA_CERTS pointing at the test CA —
// Node's own documented mechanism for adding a private root WITHOUT touching
// verification strictness: chain building and hostname checks stay fully on,
// and the parent's separate self-signed row proves a certificate outside the
// store is refused by the same client code.
//
// THE DEPLOYMENT SHAPE the front mirrors (AD-11): TLS terminates at a front;
// the plaintext hop is loopback-only (the front proxies to 127.0.0.1:port,
// the same-handler reverse-proxy recipe of the self-hosting guide). The wire
// capture sees BOTH hops, so the no-invite and no-local-token negatives are
// proven across the full path, not just the client leg.
//
// The driver prints one line `REPORT:{...json}` on success; anything else is
// a failure the parent surfaces with the driver's stderr.

import http from 'node:http'
import https from 'node:https'
import { generateKeyPairSync } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { PROTOCOL_HEADER, PROTOCOL_VERSION } from '../server/constants.mjs'
import { startServer } from '../server/api/server.mjs'
import { createSessionRegistry } from '../server/api/session.mjs'
import { createLiveSessionRegistry } from '../server/core/session-registry.mjs'
import { openRoomLog } from '../server/store/room-log.mjs'
import { fingerprintFromPublicKey, signWithInstallationKey } from '../server/keys.mjs'
import { saveRemoteConfig } from '../server/client/remote-config.mjs'
import { createAgentRoomClient } from '../server/client/api-client.mjs'

const dataDir = process.env.AGENT_ROOM_DRIVER_DATA_DIR
const pluginData = process.env.AGENT_ROOM_DRIVER_PLUGIN_DATA
// The env carries PATHS; the PEM bytes are read here.
const leafCertPath = process.env.AGENT_ROOM_DRIVER_CERT
const leafKeyPath = process.env.AGENT_ROOM_DRIVER_KEY
const CHAT_ID = 'RemoteInst'

if (!dataDir || !pluginData || !leafCertPath || !leafKeyPath) {
  console.error('driver misconfigured: the four AGENT_ROOM_DRIVER_* variables are required')
  process.exit(3)
}
const leafCert = readFileSync(leafCertPath, 'utf8')
const leafKey = readFileSync(leafKeyPath, 'utf8')

function fail(message) {
  console.error(`driver failed: ${message}`)
  process.exit(1)
}

// --- The wire capture: both hops, request bodies included ---------------------
//
// The wrapper forwards EVERY argument: requests come in both the
// (options[, callback]) shape (the loopback proxy leg) and the
// (url, options[, callback]) shape (the client's https leg) — a wrapper with
// a fixed two-argument signature would silently drop the URL form's callback
// and the request would hang waiting for a listener that never attached
// (this exact bug hung the first driver runs).

const captures = []
function captureWire() {
  for (const [mod, proto] of [[http, 'http'], [https, 'https']]) {
    const original = mod.request
    mod.request = (...args) => {
      const record = {
        proto,
        path: typeof args[0] === 'string'
          ? new URL(args[0]).pathname
          : args[0] instanceof URL
            ? args[0].pathname
            : args[0]?.path,
        requestBody: [],
      }
      const settle = response => {
        response.on('data', () => {})
        response.on('end', () => captures.push({ ...record, requestBody: Buffer.concat(record.requestBody).toString('utf8') }))
      }
      let request
      if (args.some(arg => typeof arg === 'function')) {
        const patched = args.map(arg => (typeof arg === 'function'
          ? response => { settle(response); return arg(response) }
          : arg))
        request = original.call(mod, ...patched)
      } else {
        request = original.call(mod, ...args)
        request.on('response', settle)
      }
      const originalWrite = request.write.bind(request)
      request.write = (chunk, ...rest) => {
        if (chunk !== undefined) record.requestBody.push(Buffer.from(chunk))
        return originalWrite(chunk, ...rest)
      }
      const originalEnd = request.end.bind(request)
      request.end = (chunk, ...rest) => {
        if (chunk === undefined) return originalEnd()
        record.requestBody.push(Buffer.from(chunk))
        return originalEnd(chunk, ...rest)
      }
      return request
    }
  }
}

// --- The TLS front: terminate TLS, proxy to the loopback plaintext backend ----
//
// Hop-by-hop headers are stripped in both directions (the reverse-proxy
// recipe's hygiene): forwarding the backend's `connection`/`keep-alive`/
// `transfer-encoding` mis-frames the response for the client and mis-frames
// the forwarded request for the backend; Node re-frames what it manages.
const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'te', 'trailer', 'upgrade', 'proxy-authenticate', 'proxy-authorization']

function stripHopByHop(headers) {
  const clean = { ...headers }
  for (const name of HOP_BY_HOP) delete clean[name]
  return clean
}

function startTlsFront(certPem, keyPem) {
  let backendPort = null
  const front = https.createServer({ cert: certPem, key: keyPem }, (req, res) => {
    const chunks = []
    req.on('data', chunk => chunks.push(chunk))
    req.on('end', () => {
      const body = Buffer.concat(chunks)
      const headers = stripHopByHop(req.headers)
      headers['content-length'] = body.length
      const upstream = http.request(
        { host: '127.0.0.1', port: backendPort, path: req.url, method: req.method, headers, agent: false },
        response => {
          res.writeHead(response.statusCode ?? 502, stripHopByHop(response.headers))
          response.pipe(res)
        },
      )
      upstream.on('error', () => {
        if (res.headersSent) return res.destroy()
        res.writeHead(502, { 'content-type': 'application/json; charset=utf-8' })
        res.end(JSON.stringify({ error: { code: 'backend_unreachable', message: 'the loopback backend is not answering' } }))
      })
      if (body.length > 0) upstream.write(body)
      upstream.end()
    })
  })
  return {
    setBackend: port => { backendPort = port },
    listen: () => new Promise(resolve => front.listen(0, '127.0.0.1', () => resolve(front.address().port))),
    close: () => new Promise(resolve => front.close(() => resolve())),
  }
}

// One JSON POST against the configured origin over default verification.
function postJson(origin, path, body) {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = https.request(
      new URL(path, origin),
      { method: 'POST', agent: false, headers: { [PROTOCOL_HEADER]: PROTOCOL_VERSION, 'content-type': 'application/json; charset=utf-8' } },
      response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('end', () => resolvePromise({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    request.on('error', rejectPromise)
    request.end(JSON.stringify(body))
  })
}

async function main() {
  captureWire()

  mkdirSync(pluginData, { recursive: true, mode: 0o700 })
  writeFileSync(join(pluginData, 'config.json'), `${JSON.stringify({ chat_id: CHAT_ID })}\n`, { mode: 0o600 })
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' })
  writeFileSync(join(pluginData, 'identity.key'), pem, { mode: 0o600 })
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const raw = spki.subarray(spki.length - 32)
  const publicKeyB64 = Buffer.from(raw).toString('base64url')

  // The loopback plaintext backend — the real server, real store, real realm.
  const server1 = await startServer({ dataDir })
  const front = startTlsFront(leafCert, leafKey)
  front.setBackend(server1.port)
  const frontPort = await front.listen()
  const origin = `https://127.0.0.1:${frontPort}`

  // Enrollment ONCE — the operator's invite flow (Story 4.2) over the same
  // verified TLS origin. Everything after this must ride the challenge lane.
  const store = openRoomLog({ dataDir })
  const minted = store.mintInvite({ uses: 1, ttlSeconds: 3600 })
  store.close()
  const enrolled = await postJson(origin, '/api/auth/enroll', {
    invite_token: minted.token,
    public_key: publicKeyB64,
    signature: signWithInstallationKey(pluginData, Buffer.from(minted.token, 'utf8')).toString('base64url'),
  })
  if (enrolled.status !== 200) {
    fail(`enrollment answered ${enrolled.status}: ${enrolled.text}`)
  }

  // The client phase starts here: from this marker on, the captured wire must
  // carry no invite token and no local-token exchange — only challenges.
  const clientPhaseStart = captures.length

  // The persisted configuration alone (no option, no env declaration) makes
  // the client a remote client.
  saveRemoteConfig(pluginData, { serverUrl: origin })

  const client1 = createAgentRoomClient({ dataDir, pluginDataDir: pluginData })
  const presence1 = await client1.presence()
  const status1 = await client1.status()
  const transport1 = client1.transport

  // THE CLIENT RESTARTS — and the server with it, the way a real
  // installation restarts: the old process (and its live session and its
  // Chat ID claim) is GONE before the fresh one connects. A fresh client
  // instance with no cached session re-authenticates through the challenge
  // lane — the reconnect needs no invite anywhere. Each restarted server
  // gets its own FRESH registries: in a real deployment the restarted
  // process shares nothing with its predecessor, and the harness must model
  // that (the process-default registries would silently carry the old
  // sessions across the "restart").
  await server1.close()
  const server2 = await startServer({
    dataDir,
    sessionRegistry: createSessionRegistry(),
    liveSessionRegistry: createLiveSessionRegistry(),
  })
  front.setBackend(server2.port)
  const client2 = createAgentRoomClient({ dataDir, pluginDataDir: pluginData })
  const presence2 = await client2.presence()
  const transport2 = client2.transport

  // THE SERVER RESTARTS BEHIND THE SAME URL (the deployment reality: a fixed
  // origin, a new backend). client2's live session died with server2's fresh
  // registry; the durable enrollment survived. The next call answers 401,
  // re-authenticates (the one single-flight re-auth) through the challenge
  // lane, re-binds, and succeeds — with no invite.
  await server2.close()
  const server3 = await startServer({
    dataDir,
    sessionRegistry: createSessionRegistry(),
    liveSessionRegistry: createLiveSessionRegistry(),
  })
  front.setBackend(server3.port)
  const presence2b = await client2.presence()
  const status2b = await client2.status()
  const transport2b = client2.transport

  // The stranger gate, same configured origin: a fresh, never-enrolled
  // installation must surface the coded not_enrolled refusal WITH the
  // actionable enrollment guidance — never a silent fallback and never an
  // auto-enrollment.
  const strangerData = `${pluginData}-stranger`
  mkdirSync(strangerData, { recursive: true, mode: 0o700 })
  writeFileSync(join(strangerData, 'config.json'), `${JSON.stringify({ chat_id: 'StrangerInst' })}\n`, { mode: 0o600 })
  const strangerKeys = generateKeyPairSync('ed25519')
  writeFileSync(join(strangerData, 'identity.key'), strangerKeys.privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  saveRemoteConfig(strangerData, { serverUrl: origin })
  const stranger = createAgentRoomClient({ dataDir, pluginDataDir: strangerData })
  let notEnrolled = null
  try {
    await stranger.presence()
    fail('the never-enrolled stranger was not refused')
  } catch (error) {
    notEnrolled = { code: error?.code, message: String(error?.message ?? '') }
  }

  const onlineRow = presence1.online.find(row => row.chat_id === CHAT_ID)
  const online2bRow = presence2b.online.find(row => row.chat_id === CHAT_ID)
  const clientPhase = captures.slice(clientPhaseStart)
  const report = {
    ok: true,
    fingerprint: client1.fingerprint,
    chatId: client1.chatId,
    transports: [transport1, transport2, transport2b],
    realmId1: status1.realm_id,
    realmId2: status2b.realm_id,
    onlineMcpRow: onlineRow !== undefined && onlineRow.client_type === 'mcp' && onlineRow.fingerprint === fingerprintFromPublicKey(raw),
    presence2Rows: Array.isArray(presence2.online),
    presence2bSelfRow: online2bRow !== undefined && online2bRow.fingerprint === fingerprintFromPublicKey(raw),
    counts: {
      enrollRequests: clientPhase.filter(entry => entry.path === '/api/auth/enroll').length,
      localAuthRequests: clientPhase.filter(entry => entry.path === '/api/auth/local').length,
      challengeRequests: clientPhase.filter(entry => entry.proto === 'https' && entry.path === '/api/auth/challenge').length,
      answerRequests: clientPhase.filter(entry => entry.proto === 'https' && entry.path === '/api/auth/answer').length,
      inviteTokenFieldOccurrences: clientPhase.reduce((n, entry) => n + (entry.requestBody.includes('invite_token') ? 1 : 0), 0),
      rawTokenOccurrences: clientPhase.reduce((n, entry) => n + (entry.requestBody.includes(minted.token) ? 1 : 0), 0),
    },
    notEnrolled: {
      code: notEnrolled?.code ?? null,
      actionable: notEnrolled !== null && /invite/.test(notEnrolled.message) && /enroll/.test(notEnrolled.message),
      message: notEnrolled?.message ?? '',
    },
  }
  console.log(`REPORT:${JSON.stringify(report)}`)

  await front.close()
  await server3.close()
  process.exit(0)
}

main().catch(error => {
  fail(error?.stack ?? String(error))
})
