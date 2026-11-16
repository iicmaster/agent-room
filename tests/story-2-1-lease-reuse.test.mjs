// Story 2.1 AC4: `dm` and the MCP addressed send REUSE a live session lease
// inside its window — 0 calls to POST /api/session-principals/resume and 0
// calls to DELETE /api/session-principals/current across three consecutive
// sends — and only a lapsed lease triggers the singleflight resume.
//
// The counting is black-box: the CLI is pointed at a local proxy that forwards
// every request to the real server and tallies (method, path). The proxy is
// the only way the process can reach the server, so a request it does not see
// did not happen.

import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import http from 'node:http'
import { generateKeyPairSync } from 'node:crypto'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { PROTOCOL_VERSION } from '../server/constants.mjs'
import { APP_VERSION } from '../server/runtime.mjs'
import { loadOrCreateLocalToken } from '../server/api/local-token.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = join(ROOT, 'server', 'api', 'server.mjs')
const PROTOCOL_KEY = 'agent-room-protocol'

const sleep = ms => new Promise(resolvePromise => { setTimeout(resolvePromise, ms) })

function makeWorld(t) {
  const parent = mkdtempSync(join(tmpdir(), 'agent-room-lease-'))
  t.after(() => rmSync(parent, { recursive: true, force: true }))
  const sharedData = join(parent, 'shared')
  const pluginData = join(parent, 'plugin-data')
  for (const dir of [sharedData, pluginData]) mkdirSync(dir, { mode: 0o700 })
  writeFileSync(join(pluginData, 'config.json'), `${JSON.stringify({ chat_id: 'sender' })}\n`, { mode: 0o600 })

  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, AGENT_ROOM_DATA_DIR: sharedData },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const waitReady = async () => {
    const deadline = Date.now() + 10_000
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('server child exited early')
      if (existsSync(join(sharedData, 'runtime.json'))) {
        try {
          const record = JSON.parse(readFileSync(join(sharedData, 'runtime.json'), 'utf8'))
          if (Number.isInteger(record.port) && record.port > 0) return record
        } catch { /* atomic rename: retry */ }
      }
      if (Date.now() > deadline) throw new Error('server child never became ready')
      await sleep(25)
    }
  }
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      await once(child, 'exit').catch(() => {})
    }
  })
  return { parent, sharedData, pluginData, waitReady }
}

function request(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, response => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolvePromise({ status: response.statusCode, text: Buffer.concat(chunks).toString('utf8') }))
    })
    req.on('error', rejectPromise)
    if (body !== undefined) req.write(JSON.stringify(body))
    req.end()
  })
}

const bearer = token => ({
  [PROTOCOL_KEY]: PROTOCOL_VERSION,
  authorization: `Bearer ${token}`,
  'content-type': 'application/json; charset=utf-8',
})

// A forwarding proxy that tallies every (method, path) it carries. The
// tally is the test's instrument: the CLI is pointed at it as the runtime
// record's port, so nothing it does to the server escapes the count.
async function startCountingProxy(t, upstreamPort) {
  const tally = []
  const server = http.createServer((clientReq, clientRes) => {
    tally.push(`${clientReq.method} ${clientReq.url.split('?')[0]}`)
    const upstream = http.request({
      host: '127.0.0.1',
      port: upstreamPort,
      method: clientReq.method,
      path: clientReq.url,
      headers: { ...clientReq.headers, host: `127.0.0.1:${upstreamPort}` },
      agent: false,
    }, upstreamRes => {
      clientRes.writeHead(upstreamRes.statusCode, upstreamRes.headers)
      upstreamRes.pipe(clientRes)
    })
    upstream.on('error', () => {
      clientRes.writeHead(502)
      clientRes.end()
    })
    clientReq.pipe(upstream)
  })
  await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
  t.after(() => new Promise(resolveClose => server.close(resolveClose)))
  const countOf = needle => tally.filter(entry => entry === needle).length
  return { port: server.address().port, tally, countOf }
}

test('AC4: three consecutive dm sends reuse the live lease — 0 /resume and 0 DELETE /current', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()

  // A peer to send to: an ordinary allocated principal over the real server.
  const localToken = loadOrCreateLocalToken(world.sharedData)
  const auth = await request(record.port, 'POST', '/api/auth/local', {
    headers: bearer(localToken),
    body: { public_key: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url') },
  })
  assert.equal(auth.status, 200, auth.text)
  const peerToken = JSON.parse(auth.text).result.session_token
  const allocated = await request(record.port, 'POST', '/api/session-principals', {
    headers: bearer(peerToken),
    body: { base_chat_id: 'peer', machine: 'macbook', client_type: 'api' },
  })
  assert.equal(allocated.status, 200, allocated.text)
  const peer = JSON.parse(allocated.text).result

  const proxy = await startCountingProxy(t, record.port)
  writeFileSync(join(world.sharedData, 'runtime.json'), `${JSON.stringify({
    pid: process.pid,
    port: proxy.port,
    version: APP_VERSION,
  })}\n`, { mode: 0o600 })

  const { runDmCommand } = await import('../server/cli/message-commands.mjs')
  const deps = {
    pluginDataDir: world.pluginData,
    sharedDataDir: world.sharedData,
    env: { ...process.env, AGENT_ROOM_SESSION_SCOPE: 'lease-scope' },
  }

  // Three sends inside one lease window (the base lease is 30 s; these run in
  // well under a second). Only the FIRST may allocate; none may resume.
  const receipts = []
  for (const index of [1, 2, 3]) {
    const outcome = await runDmCommand(['--to', peer.address, '--text', `message ${index}`], deps)
    assert.equal(outcome.status, 'ok', JSON.stringify(outcome))
    receipts.push(JSON.parse(outcome.lines[0]))
  }
  for (const receipt of receipts) assert.equal(receipt.status, 'committed')

  const resumeCalls = proxy.countOf('POST /api/session-principals/resume')
  const releaseCalls = proxy.countOf('DELETE /api/session-principals/current')
  const allocateCalls = proxy.countOf('POST /api/session-principals')
  const sendCalls = proxy.countOf('POST /api/messages')

  console.log(`AC4_reuse resume=${resumeCalls} release=${releaseCalls} allocate=${allocateCalls} sends=${sendCalls}`)
  assert.equal(resumeCalls, 0, 'AC4: a live lease is reused with zero /resume calls')
  assert.equal(releaseCalls, 0, 'AC4: the base lease is never released — the finally block is gone')
  assert.equal(allocateCalls, 1, 'exactly one allocation: the first send mints the principal')
  assert.equal(sendCalls, 3, 'three addressed sends crossed the wire')
  // The one pair room is reused: all three sends committed to the same room.
  assert.equal(new Set(receipts.map(receipt => receipt.room_id)).size, 1, 'one pair room across the three sends')

  // And the peer's lease is still LIVE after the sends: the reuse did not
  // drop it. A fourth send therefore makes no /resume call either.
  const beforeFourth = proxy.countOf('POST /api/session-principals/resume')
  const fourth = await runDmCommand(['--to', peer.address, '--text', 'message 4'], deps)
  assert.equal(fourth.status, 'ok', JSON.stringify(fourth))
  assert.equal(proxy.countOf('POST /api/session-principals/resume'), beforeFourth, 'still zero resumes')
  assert.equal(proxy.countOf('DELETE /api/session-principals/current'), 0, 'still zero releases')
})

test('AC4: an EXPIRED lease triggers exactly one singleflight /resume, then reuses again', async t => {
  const world = makeWorld(t)
  const record = await world.waitReady()

  const localToken = loadOrCreateLocalToken(world.sharedData)
  const auth = await request(record.port, 'POST', '/api/auth/local', {
    headers: bearer(localToken),
    body: { public_key: generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('base64url') },
  })
  assert.equal(auth.status, 200, auth.text)
  const peerToken = JSON.parse(auth.text).result.session_token
  const allocated = await request(record.port, 'POST', '/api/session-principals', {
    headers: bearer(peerToken),
    body: { base_chat_id: 'peer', machine: 'macbook', client_type: 'api' },
  })
  const peer = JSON.parse(allocated.text).result

  const proxy = await startCountingProxy(t, record.port)
  writeFileSync(join(world.sharedData, 'runtime.json'), `${JSON.stringify({
    pid: process.pid,
    port: proxy.port,
    version: APP_VERSION,
  })}\n`, { mode: 0o600 })

  const { runDmCommand } = await import('../server/cli/message-commands.mjs')
  const deps = {
    pluginDataDir: world.pluginData,
    sharedDataDir: world.sharedData,
    env: { ...process.env, AGENT_ROOM_SESSION_SCOPE: 'expiry-scope' },
  }
  const first = await runDmCommand(['--to', peer.address, '--text', 'one'], deps)
  assert.equal(first.status, 'ok', JSON.stringify(first))

  // Force the stored lease into the past: this is exactly what a lapsed
  // window looks like on disk, without waiting 30 s.
  const statePath = join(world.pluginData, 'sessions', 'expiry-scope', 'session.json')
  const state = JSON.parse(readFileSync(statePath, 'utf8'))
  state.base_lease_expires_at = new Date(Date.now() - 60_000).toISOString()
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })

  const before = proxy.countOf('POST /api/session-principals/resume')
  const afterExpiry = await runDmCommand(['--to', peer.address, '--text', 'two'], deps)
  assert.equal(afterExpiry.status, 'ok', JSON.stringify(afterExpiry))
  assert.equal(proxy.countOf('POST /api/session-principals/resume'), before + 1, 'AC4: an expired lease resumes exactly once')
  assert.equal(proxy.countOf('DELETE /api/session-principals/current'), 0, 'still never releases')

  // The resumed lease is live again: a further send adds no resume.
  const afterResume = proxy.countOf('POST /api/session-principals/resume')
  const third = await runDmCommand(['--to', peer.address, '--text', 'three'], deps)
  assert.equal(third.status, 'ok', JSON.stringify(third))
  assert.equal(proxy.countOf('POST /api/session-principals/resume'), afterResume, 'the fresh lease is reused')
})
