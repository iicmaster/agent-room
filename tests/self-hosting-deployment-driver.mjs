// The self-hosting deployment journey driver (Story 4.7): a real child
// process spawned by tests/self-hosting-deployment.test.mjs that walks BOTH
// TLS paths of FR-4 end to end —
//
//   Path B (native node:https): startServer({ tls: { cert, key } }) binding
//     a TLS listener directly, enrollment through the REAL `agent-room
//     remote enroll` CLI dispatch, then the real api-client riding the
//     challenge lane, a send, and a held read through that one handler.
//   Path A (the Caddy shape): the same journey through a real TLS front
//     terminating to a loopback PLAINTEXT backend (hop-by-hop headers
//     stripped both directions — the reverse-proxy recipe's hygiene).
//
// WHY A CHILD PROCESS: the client's DEFAULT TLS verification is the policy
// under test (no override exists anywhere in this tree, and
// tls.rootCertificates is frozen by design), so the driver is spawned with
// NODE_EXTRA_CA_CERTS pointing at the test CA — Node's own documented
// mechanism for adding a private root WITHOUT touching verification
// strictness (chain and hostname checks stay fully on). The honest scope of
// the automated proof is loopback through real TLS; the literal cross-machine
// walkthrough is Story 4.8's dress rehearsal.
//
// The driver prints one line `REPORT:{...json}` on success; anything else is
// a failure the parent surfaces with the driver's stderr.

import http from 'node:http'
import https from 'node:https'
import { generateKeyPairSync } from 'node:crypto'
import { READ_HOLD_MAX_MS } from '../server/constants.mjs'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { PassThrough } from 'node:stream'

import { startServer } from '../server/api/server.mjs'
import { createSessionRegistry } from '../server/api/session.mjs'
import { createLiveSessionRegistry } from '../server/core/session-registry.mjs'
import { openRoomLog } from '../server/store/room-log.mjs'
import { fingerprintFromPublicKey } from '../server/keys.mjs'
import { saveRemoteConfig } from '../server/client/remote-config.mjs'
import { createAgentRoomClient } from '../server/client/api-client.mjs'
import { main as cliMain } from '../server/cli/agent-room.mjs'

const root = process.env.AGENT_ROOM_SELFHOST_ROOT
const certPath = process.env.AGENT_ROOM_SELFHOST_CERT
const keyPath = process.env.AGENT_ROOM_SELFHOST_KEY

if (!root || !certPath || !keyPath) {
  console.error('driver misconfigured: AGENT_ROOM_SELFHOST_ROOT/CERT/KEY are required')
  process.exit(3)
}
const leafCert = readFileSync(certPath, 'utf8')
const leafKey = readFileSync(keyPath, 'utf8')

function fail(message) {
  console.error(`driver failed: ${message}`)
  process.exit(1)
}

// --- The wire capture: both hops, request bodies included ---------------------
//
// Identical mechanism to tests/remote-client-driver.mjs — and the same
// varargs warning: the wrapper forwards EVERY argument, because requests
// arrive in both the (options[, callback]) shape (the front's loopback hop)
// and the (url, options[, callback]) shape (the clients' https legs); a
// fixed-signature wrapper silently drops the URL form's callback and the
// request hangs forever.

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
// Hop-by-hop headers are stripped in both directions — the Caddy recipe's
// documented hygiene (forwarding `connection`/`keep-alive`/
// `transfer-encoding` mis-frames both the forwarded request and the
// returned response; Node re-frames what it manages).

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
      // The backend hop is LOOPBACK PLAINTEXT ONLY — the recipe's one rule.
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

// One installation under its own plugin dir: config.json plus a real 0600 keypair.
function makeInstallation(parent, name, chatId) {
  const pluginData = join(parent, name)
  mkdirSync(pluginData, { recursive: true, mode: 0o700 })
  writeFileSync(join(pluginData, 'config.json'), `${JSON.stringify({ chat_id: chatId })}\n`, { mode: 0o600 })
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  writeFileSync(join(pluginData, 'identity.key'), privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 })
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const raw = spki.subarray(spki.length - 32)
  return { pluginData, chatId, fingerprint: fingerprintFromPublicKey(raw) }
}

// The REAL CLI dispatch, in streams: one `agent-room remote enroll <token>`
// invocation, with stdout/stderr captured for the redaction scan.
async function runCliEnroll({ dataDir, pluginData }, token) {
  const output = new PassThrough()
  const errorOutput = new PassThrough()
  let stdout = ''
  let stderr = ''
  output.setEncoding('utf8')
  errorOutput.setEncoding('utf8')
  output.on('data', chunk => { stdout += chunk })
  errorOutput.on('data', chunk => { stderr += chunk })
  const outcome = await cliMain(['remote', 'enroll', token], {
    input: new PassThrough(),
    output,
    errorOutput,
    sharedDataDir: dataDir,
    pluginDataDir: pluginData,
  })
  return { outcome, stdout, stderr }
}

// One leg's journey: enroll through the real CLI receipt, then the client
// phase (challenge lane, send, held read, fresh-client reconnect) with the
// counted negatives over both wire legs. `origin` is the leg's fixed public
// origin; `restart` models THE CLIENT RESTART the reconnect row proves — the
// server process is closed and brought back the way a real deployment
// restarts: the old live session and its Chat ID claim are GONE (fresh
// registries) before the fresh client connects. First-bind-wins is the
// production rule (chat_id_taken is the correct answer for a live holder),
// so the harness must never hold two live sessions of one installation
// against it.
async function journey({ label, dataDir, origin, withBoundRows, restart }) {
  const installation = makeInstallation(root, `${label}-plugin`, `${label}Inst`)
  const store = openRoomLog({ dataDir })
  const minted = store.mintInvite({ uses: 1, ttlSeconds: 3600 })
  store.close()

  saveRemoteConfig(installation.pluginData, { serverUrl: origin })

  // Enrollment through the REAL CLI dispatch — one command, one receipt.
  const enroll = await runCliEnroll({ dataDir, pluginData: installation.pluginData }, minted.token)
  if (enroll.outcome.status !== 'ok') {
    fail(`${label}: remote enroll did not succeed: ${enroll.stderr}`)
  }
  const receiptLines = enroll.stdout.trim().split('\n').filter(text => text.length > 0).map(text => JSON.parse(text))
  const receipt = receiptLines[0]
  const clientPhaseStart = captures.length

  const client1 = createAgentRoomClient({ dataDir, pluginDataDir: installation.pluginData })
  const presence1 = await client1.presence()
  const status1 = await client1.status()
  const transport1 = client1.transport
  const room = await client1.directOpen({ chatId: installation.chatId })
  const sent1 = await client1.sendMessage({ roomId: room.room_id, clientMessageId: 'm1', text: `${label}: first` })

  // A held read that RELEASES on arrival: the read holds past m1, a message
  // lands mid-hold, the hold releases carrying it.
  const readPromise = client1.readMessage({ roomId: room.room_id, afterSeq: sent1.seq, waitMs: 8000 })
  await new Promise(resolve => setTimeout(resolve, 400))
  const sent2 = await client1.sendMessage({ roomId: room.room_id, clientMessageId: 'm2', text: `${label}: mid-hold` })
  const heldPage = await readPromise

  // THE CLIENT RESTARTS — and the server with it, the way a real
  // installation restarts: the old process (and its live session and its
  // Chat ID claim) is GONE before the fresh one connects. Each restarted
  // server gets its own FRESH registries: in a real deployment the restarted
  // process shares nothing with its predecessor, and the harness must model
  // that (the process-default registries would silently carry the old live
  // session across the "restart", and the fresh client's bind would answer
  // the correct coded chat_id_taken — the 4.3 driver's identical discipline).
  await restart()

  // A FRESH client instance reconnects through the challenge lane — zero
  // enroll requests, zero invite bytes, no local token (counted below).
  const client2 = createAgentRoomClient({ dataDir, pluginDataDir: installation.pluginData })
  const presence2 = await client2.presence()
  const transport2 = client2.transport

  let boundHold = null
  let overBound = null
  if (withBoundRows) {
    // The 20-second read capture: a QUIET room held at the declared bound
    // (wait_ms = READ_HOLD_MAX_MS) returns the normal possibly-empty
    // page carrying the cursors. wait_ms beyond the bound is the coded
    // invalid_wait_ms refusal (the bound is the server's, cited not restated).
    const started = Date.now()
    const page = await client2.readMessage({ roomId: room.room_id, afterSeq: sent2.seq, waitMs: READ_HOLD_MAX_MS })
    const elapsed = Date.now() - started
    boundHold = {
      waitMs: READ_HOLD_MAX_MS,
      elapsedMs: elapsed,
      empty: Array.isArray(page.messages) && page.messages.length === 0,
      hasNextAfterSeq: page.next_after_seq === sent2.seq,
      hasHeadSeq: Number.isInteger(page.head_seq),
    }
    try {
      await client2.readMessage({ roomId: room.room_id, afterSeq: sent2.seq, waitMs: 20001 })
      overBound = null
    } catch (error) {
      overBound = error?.code ?? null
    }
  }

  const clientPhase = captures.slice(clientPhaseStart)
  const tokenSeenSomewhere = enroll.stdout.includes(minted.token)
    || enroll.stderr.includes(minted.token)
    || clientPhase.some(entry => entry.requestBody.includes(minted.token))
  return {
    label,
    origin,
    port: new URL(origin).port,
    fingerprint: client1.fingerprint,
    fingerprintMatches: client1.fingerprint === installation.fingerprint,
    receipt,
    receiptOk: receipt?.ok === true && receipt?.command === 'remote enroll' && receipt?.enrolled === true,
    receiptServerUrl: receipt?.server_url ?? null,
    receiptDigestPrefix: typeof receipt?.token_digest_prefix === 'string' ? receipt.token_digest_prefix : null,
    receiptFingerprintMatches: receipt?.fingerprint === installation.fingerprint,
    tokenLeaked: tokenSeenSomewhere,
    transports: [transport1, transport2],
    presenceRows: presence1.online.length > 0 && presence2.online.length > 0,
    selfRow: presence1.online.some(row => row.chat_id === installation.chatId),
    realmId: status1.realm_id,
    holdEngaged: sent2.seq === sent1.seq + 1,
    holdReleasedOnArrival: heldPage.messages.some(message => message.seq === sent2.seq)
      && heldPage.next_after_seq === sent2.seq,
    boundHold,
    overBound,
    counts: {
      enrollRequests: clientPhase.filter(entry => entry.path === '/api/auth/enroll').length,
      localAuthRequests: clientPhase.filter(entry => entry.path === '/api/auth/local').length,
      // One challenge/answer PER CLIENT INSTANCE: counted on the client's
      // https leg only. The front leg's loopback plaintext hop replays the
      // same paths onto the backend, so an unfiltered path count would count
      // each exchange twice (the 4.3 driver's identical rule).
      challengeRequests: clientPhase.filter(entry => entry.proto === 'https' && entry.path === '/api/auth/challenge').length,
      answerRequests: clientPhase.filter(entry => entry.proto === 'https' && entry.path === '/api/auth/answer').length,
      inviteTokenFieldOccurrences: clientPhase.reduce((n, entry) => n + (entry.requestBody.includes('invite_token') ? 1 : 0), 0),
      rawTokenOccurrences: clientPhase.reduce((n, entry) => n + (entry.requestBody.includes(minted.token) ? 1 : 0), 0),
      // The wire shape per leg: the native leg's client phase is https end to
      // end; the front leg shows BOTH the client's https leg AND the front's
      // http hop to the loopback plaintext backend.
      httpsHops: clientPhase.filter(entry => entry.proto === 'https').length,
      httpHops: clientPhase.filter(entry => entry.proto === 'http').length,
    },
  }
}

async function run() {
  captureWire()

  // Path B — the native node:https server holds the TLS listener itself.
  // FRESH registries on every start: each (re)started process shares nothing
  // with its predecessor, exactly as a restarted deployment process does not
  // (the process-default registries would silently carry old sessions — and
  // their Chat ID claims — across a "restart").
  const nativeDataDir = join(root, 'native-data')
  let nativeServer = await startServer({
    dataDir: nativeDataDir,
    host: '127.0.0.1',
    tls: { cert: leafCert, key: leafKey },
    sessionRegistry: createSessionRegistry(),
    liveSessionRegistry: createLiveSessionRegistry(),
  })
  const native = await journey({
    label: 'native',
    dataDir: nativeDataDir,
    origin: `https://127.0.0.1:${nativeServer.port}`,
    withBoundRows: true,
    restart: async () => {
      // The restarted native TLS server rebinds the SAME port — the fixed
      // origin the installation configured — with fresh registries.
      const port = nativeServer.port
      await nativeServer.close()
      nativeServer = await startServer({
        dataDir: nativeDataDir,
        host: '127.0.0.1',
        port,
        tls: { cert: leafCert, key: leafKey },
        sessionRegistry: createSessionRegistry(),
        liveSessionRegistry: createLiveSessionRegistry(),
      })
    },
  })

  // Path A — a real TLS front terminates and proxies to the loopback
  // PLAINTEXT backend (the Caddy shape).
  const frontDataDir = join(root, 'front-data')
  let backend = await startServer({
    dataDir: frontDataDir,
    sessionRegistry: createSessionRegistry(),
    liveSessionRegistry: createLiveSessionRegistry(),
  })
  const front = startTlsFront(leafCert, leafKey)
  front.setBackend(backend.port)
  const frontPort = await front.listen()
  const frontJourney = await journey({
    label: 'front',
    dataDir: frontDataDir,
    origin: `https://127.0.0.1:${frontPort}`,
    withBoundRows: false,
    restart: async () => {
      // THE SERVER RESTARTS BEHIND THE SAME URL (the deployment reality: a
      // fixed origin, a new backend process with fresh registries).
      await backend.close()
      backend = await startServer({
        dataDir: frontDataDir,
        sessionRegistry: createSessionRegistry(),
        liveSessionRegistry: createLiveSessionRegistry(),
      })
      front.setBackend(backend.port)
    },
  })

  const report = { native, front: frontJourney }
  console.log(`REPORT:${JSON.stringify(report)}`)

  await front.close()
  await backend.close()
  await nativeServer.close()
  process.exit(0)
}

run().catch(error => {
  fail(error?.stack ?? String(error))
})
