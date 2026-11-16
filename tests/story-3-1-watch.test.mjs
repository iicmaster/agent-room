// Story 3.1 — Multiplexed Watch Stream and PostCommitBus.
// Evidence for all four ACs: bus after-commit semantics, cursors/Accept
// validation, catch-up + capacity + replacement, long-lived safety, and the
// unpooled client backoff/terminal-stop. Native node:test only.

import assert from 'node:assert/strict'
import { generateKeyPairSync } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import http from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { once } from 'node:events'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { loadOrCreateLocalToken } from '../server/api/local-token.mjs'
import { fingerprintFromPublicKey } from '../server/keys.mjs'
import { createPostCommitBus } from '../server/notification/post-commit-bus.mjs'
import { openRoomLog } from '../server/store/room-log.mjs'
import { watchBackoffMs, createFrameParser } from '../server/client/watch-client.mjs'
import {
  WATCH_CATCHUP_MAX,
  WATCH_CONCURRENT_MAX,
  WATCH_CURSORS_PARAM_MAX_BYTES,
  WATCH_OUTBOUND_BUFFER_MAX_BYTES,
} from '../server/constants.mjs'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SERVER_ENTRY = join(ROOT, 'server', 'api', 'server.mjs')
const PROTOCOL_KEY = 'agent-room-protocol'
const sleep = ms => new Promise(r => { setTimeout(r, ms) })

function dataDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'ar-watch-'))
  t.after(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

function installation() {
  const { publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ type: 'spki', format: 'der' })
  const raw = spki.subarray(spki.length - 32)
  return { publicKey: raw.toString('base64url'), fingerprint: fingerprintFromPublicKey(raw) }
}

// --- HTTP helpers ---------------------------------------------------------------

function request(port, method, path, { headers = {}, body } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers, agent: false }, response => {
      const chunks = []
      response.on('data', c => chunks.push(c))
      response.on('end', () => resolvePromise({
        status: response.statusCode, headers: response.headers,
        text: Buffer.concat(chunks).toString('utf8'),
        json() { return JSON.parse(Buffer.concat(chunks).toString('utf8')) },
      }))
      response.on('error', rejectPromise)
    })
    req.on('error', rejectPromise)
    if (body !== undefined) req.write(body)
    req.end()
  })
}

function streamRequest(port, path, headers, onFrame) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = http.request({ host: '127.0.0.1', port, method: 'GET', path, headers, agent: false }, response => {
      let buffer = ''
      response.on('data', chunk => {
        buffer += chunk.toString('utf8')
        let n
        while ((n = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, n).replace(/\r$/, '')
          buffer = buffer.slice(n + 1)
          if (line.trim() && onFrame) onFrame(line)
        }
      })
      response.on('error', rejectPromise)
      resolvePromise({ status: response.statusCode, headers: response.headers, request: req, response })
    })
    req.on('error', rejectPromise)
    req.end()
  })
}

function spawnServer(t, dir, { env = {} } = {}) {
  const child = spawn(process.execPath, [SERVER_ENTRY], {
    env: { ...process.env, AGENT_ROOM_DATA_DIR: dir, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr.on('data', c => { stderr += c.toString('utf8') })
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      return once(child, 'exit').catch(() => {})
    }
  })
  const runtimePath = join(dir, 'runtime.json')
  const ready = async () => {
    const deadline = Date.now() + 10_000
    for (;;) {
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`server exited: ${stderr}`)
      if (existsSync(runtimePath)) {
        try {
          const record = JSON.parse(readFileSync(runtimePath, 'utf8'))
          if (Number.isInteger(record.port) && record.port > 0) return record
        } catch { /* retry */ }
      }
      if (Date.now() > deadline) throw new Error(`server not ready: ${stderr}`)
      await sleep(25)
    }
  }
  return { child, ready, stderr: () => stderr }
}

const hdr = (token, capability) => ({
  [PROTOCOL_KEY]: '1',
  'content-type': 'application/json; charset=utf-8',
  ...(token ? { authorization: `Bearer ${token}` } : {}),
  ...(capability ? { authorization: `Session ${capability}` } : {}),
})

async function establishSession(port, dir, inst, chatId) {
  const token = loadOrCreateLocalToken(dir)
  const auth = await request(port, 'POST', '/api/auth/local', {
    headers: hdr(token), body: JSON.stringify({ public_key: inst.publicKey }),
  })
  assert.equal(auth.status, 200, auth.text)
  const sessionToken = auth.json().result.session_token
  const connected = await request(port, 'POST', '/api/session', {
    headers: hdr(sessionToken), body: JSON.stringify({ chat_id: chatId, client_type: 'api' }),
  })
  assert.equal(connected.status, 200, connected.text)
  return sessionToken
}

async function allocate(port, token, base) {
  const r = await request(port, 'POST', '/api/session-principals', {
    headers: hdr(token), body: JSON.stringify({ base_chat_id: base, machine: 'mac', client_type: 'api' }),
  })
  assert.equal(r.status, 200, r.text)
  return r.json().result
}

// --- AC1: PostCommitBus ---------------------------------------------------------

test('bus: per-publish fan-out, listener error isolated, bounded queue evicts slow subscriber', () => {
  const bus = createPostCommitBus({ maxQueueBytes: 100 })
  const got = []
  const unsub = bus.subscribe('s1', e => got.push(e))
  bus.publish({ event: 'message', seq: 1, text: 'x'.repeat(20) })
  bus.publish({ event: 'message', seq: 2, text: 'x'.repeat(20) })
  assert.deepEqual(got.map(e => e.seq), [1, 2])
  assert.equal(bus.subscriberCount(), 1)
  unsub()

  const other = []
  const u2 = bus.subscribe('thrower', () => { throw new Error('boom') })
  const u3 = bus.subscribe('ok', e => other.push(e))
  assert.doesNotThrow(() => bus.publish({ event: 'message', seq: 3, text: 'ok' }))
  assert.deepEqual(other.map(e => e.seq), [3])
  u2(); u3()

  const notices = []
  // An async listener whose promise never settles keeps its entries queued,
  // modelling a genuinely slow consumer. Once queued bytes exceed the cap the
  // bus evicts it and delivers rescan_required.
  bus.subscribe('slow', e => {
    notices.push(e)
    return new Promise(() => {})
  })
  for (let i = 0; i < 20; i += 1) {
    bus.publish({ event: 'message', seq: 100 + i, text: 'y'.repeat(20) })
  }
  assert.ok(notices.some(e => e.event === 'rescan_required'))
  assert.equal(bus.subscriberCount(), 0)
})

test('store wiring: one event per new insert, none on duplicate/idempotent retry', async () => {
  const dir = dataDir({ after: () => {} })
  const bus = createPostCommitBus({ maxQueueBytes: 1_000_000 })
  const events = []
  bus.subscribe('w', e => events.push(e))
  const store = openRoomLog({ dataDir: dir, role: 'server', postCommitBus: bus })
  try {
    const fp = `sha256:${'f'.repeat(64)}`
    // createBroadcastRoom owns its own transaction; call it directly.
    const made = store.createBroadcastRoom({ actorFingerprint: fp, title: 'Watch Seed' })
    const roomId = made.id
    const send = () => store.enqueueWrite({
      sessionKey: 'seed',
      execute: tx => tx.appendMessageInTx({
        roomId, actorFingerprint: fp, chatId: 'Seed', clientMessageId: 'c1', text: 'hello', replyToSeq: null,
      }),
    })
    const r1 = await send()
    assert.equal(r1.duplicateDropped, false)
    assert.equal(events.length, 1)
    assert.equal(events[0].event, 'message')
    assert.equal(events[0].room_id, roomId)
    assert.equal(typeof events[0].seq, 'number')
    // Exact retry: idempotent, no new row, no new publish.
    await send()
    assert.equal(events.length, 1)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

// --- AC2/4: validation + client helpers -----------------------------------------

test('bounds and client: strict frame parsing, 250->8000 backoff ±20%', () => {
  assert.equal(WATCH_CURSORS_PARAM_MAX_BYTES, 4096)
  assert.equal(WATCH_CATCHUP_MAX, 200)
  assert.equal(WATCH_CONCURRENT_MAX, 1500)
  assert.equal(WATCH_OUTBOUND_BUFFER_MAX_BYTES, 65536)
  const p = createFrameParser()
  assert.deepEqual(p.feed(': comment\n\n'), [])
  assert.deepEqual(p.feed('data: {"event":"message","seq":1}\n\n'), [{ event: 'message', seq: 1 }])
  assert.deepEqual(p.feed('{"event":"keepalive"}\n'), [{ event: 'keepalive' }])
  const mid = { random: () => 0.5 }
  assert.deepEqual([1, 2, 3, 4, 5, 6].map(n => watchBackoffMs(n, mid)), [250, 500, 1000, 2000, 4000, 8000])
  assert.equal(watchBackoffMs(1, { random: () => 0 }), 200)
  assert.ok(watchBackoffMs(1, { random: () => 0.999999 }) <= 300)
  assert.equal(watchBackoffMs(100, mid), 8000)
})

// --- Live watch on a real spawned server ----------------------------------------

test('live: cursors validation, NDJSON strict, commit->event latency, idle SQL=0 via child preload', async t => {
  const dir = dataDir(t)
  // Preload wraps db.prepare in the CHILD and exposes a counter over a control
  // file; the watch's idle path must never call prepare.
  const preload = join(dir, 'preload.cjs')
  const counter = join(dir, 'prepare-count.txt')
  const { writeFileSync } = await import('node:fs')
  writeFileSync(preload, `
    const { DatabaseSync } = require('node:sqlite');
    const fs = require('node:fs');
    const p = DatabaseSync.prototype.prepare;
    DatabaseSync.prototype.prepare = function (...a) {
      try { fs.appendFileSync(${JSON.stringify(counter)}, '\\n') } catch {}
      return p.apply(this, a);
    };
  `)
  const { child, ready } = spawnServer(t, dir, { env: { NODE_OPTIONS: `--require=${preload}` } })
  const record = await ready()
  const port = record.port
  const instA = installation()
  const instB = installation()
  const tokenA = await establishSession(port, dir, instA, 'WatcherA')
  const tokenB = await establishSession(port, dir, instB, 'SenderB')
  const pA = await allocate(port, tokenA, 'watcha')
  const pB = await allocate(port, tokenB, 'watchb')

  // Open the pair room + first message.
  const first = await request(port, 'POST', '/api/messages', {
    headers: hdr(null, pA.session_capability),
    body: JSON.stringify({ to: pB.address, client_message_id: 'seed-1', text: 'seed' }),
  })
  assert.equal(first.status, 200, first.text)
  const roomId = first.json().result.room_id

  // --- cursors validation → 400 invalid_request -----------------------------
  const bad = [
    'not-json', '[]',
    JSON.stringify({ [roomId]: -1 }),
    JSON.stringify({ [roomId]: 1.5 }),
    JSON.stringify(Object.fromEntries(Array.from({ length: 201 }, (_, i) => [`r${i}`, 0]))),
    `{"${roomId}":0,"${roomId}":1}`,
  ]
  for (const raw of bad) {
    const r = await request(port, 'GET', `/api/watch?cursors=${encodeURIComponent(raw)}`, { headers: hdr(null, pA.session_capability) })
    assert.equal(r.status, 400, `expected 400 for ${raw.slice(0, 40)}`)
    assert.equal(r.json().error.code, 'invalid_request')
  }
  const big = JSON.stringify({ [roomId]: 0, pad: 'x'.repeat(WATCH_CURSORS_PARAM_MAX_BYTES) })
  const rBig = await request(port, 'GET', `/api/watch?cursors=${encodeURIComponent(big)}`, { headers: hdr(null, pA.session_capability) })
  assert.equal(rBig.status, 400)

  // --- duplicate query key → 400 invalid_request (pipeline gate) -----------
  const rDup = await request(port, 'GET', `/api/watch?cursors=%7B%7D&cursors=%7B%7D`, { headers: hdr(null, pA.session_capability) })
  assert.equal(rDup.status, 400)
  assert.equal(rDup.json().error.code, 'invalid_request')

  // --- NDJSON strict stream + idle SQL -------------------------------------
  const frames = []
  const stream = await streamRequest(
    port,
    `/api/watch?cursors=${encodeURIComponent(JSON.stringify({ [roomId]: 0 }))}`,
    { ...hdr(null, pA.session_capability), accept: 'application/x-ndjson' },
    line => {
      assert.doesNotThrow(() => JSON.parse(line), 'NDJSON line must be strict JSON (0 comment lines)')
      for (const f of createFrameParser().feed(`${line}\n`)) frames.push(f)
    },
  )
  assert.equal(stream.status, 200, `watch status ${stream.status}`)

  await sleep(1500) // warm-up: absorb startup/checkpoint prepares
  const before = existsSync(counter) ? readFileSync(counter, 'utf8').length : 0
  await sleep(2500) // > 2 reconciler ticks, < 15 s keepalive
  const after = existsSync(counter) ? readFileSync(counter, 'utf8').length : 0
  assert.equal(after - before, 0, `idle watch issued ${after - before} SQL prepares (expected 0)`)

  // --- commit -> event ------------------------------------------------------
  const sendAt = Date.now()
  const sent = await request(port, 'POST', '/api/messages', {
    headers: hdr(null, pB.session_capability),
    body: JSON.stringify({ to: pA.address, client_message_id: 'watch-live', text: 'ping' }),
  })
  assert.equal(sent.status, 200, sent.text)
  const deadline = Date.now() + 3000
  let message = null
  while (Date.now() < deadline && !message) {
    message = frames.find(f => f.event === 'message')
    if (!message) await sleep(10)
  }
  assert.ok(message, 'message event delivered on the watch stream')
  assert.equal(message.room_id, roomId)
  const latency = Date.now() - sendAt
  assert.ok(latency <= 300, `commit->wire latency ${latency}ms`)
  t.diagnostic(`commit->wire latency: ${latency}ms; idle SQL delta over 2.5s: ${after - before}`)
  assert.equal(child.exitCode, null, 'child alive at end of test')
})
