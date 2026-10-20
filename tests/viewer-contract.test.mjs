// The client half against the SERVER half — the contract seam that let a
// shipped defect survive a whole epic.
//
// tests/viewer-app.test.mjs runs web/app.js against a LITERAL boot descriptor.
// That catches the client reading the wrong field of a known shape, but it
// cannot catch the two halves disagreeing: the fixture is the client's own
// belief about what the server sends. The bug this file exists to close was
// exactly that disagreement — app.js read boot.broadcast_room_id from the top
// level while the API answers { ok, result } — and the whole viewer epic's
// suite stayed green because nothing ever asked the REAL server what it sends
// and handed the answer to the REAL client.
//
// This file closes that seam: a REAL server (the packaged artifact's own
// entrypoint, over its own HTTP surface, with a real minted viewer cookie) and
// the REAL shipped script, wired to each other. If the server's response shape
// and the client's read of it ever diverge again, this fails.

import assert from 'node:assert/strict'
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

import { startServer } from '../server/api/server.mjs'
import { createEnrollRateLimiter } from '../server/api/enroll-rate-limit.mjs'
import { loadOrCreateViewerToken } from '../server/runtime.mjs'

const rootDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const appScriptPath = path.join(rootDirectory, 'web', 'app.js')

// The storage floors off: this file is about the response SHAPE, not about
// what the server will accept.
const FLOORS_OFF = Object.freeze({
  sendTokenRefillPerSecond: 1000,
  sendTokenCapacity: 1000,
  requestBudgetPerMinute: 60000,
  requestBudgetBurst: 1000,
})

function request(port, method, urlPath, { headers = {} } = {}) {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers, agent: false }, (response) => {
      const chunks = []
      response.on('data', chunk => chunks.push(chunk))
      response.on('end', () => resolvePromise({
        status: response.statusCode,
        headers: response.headers,
        text: Buffer.concat(chunks).toString('utf8'),
        json() { return JSON.parse(this.text) },
      }))
    })
    req.on('error', rejectPromise)
    req.end()
  })
}

// The shipped script, run against a real server's real responses. The DOM
// double is the same one tests/viewer-app.test.mjs uses; the DIFFERENCE here
// is that the boot descriptor is not a fixture — it is whatever the server
// actually answers.
async function runViewerAgainst({ port, cookie }) {
  const source = await readFile(appScriptPath, 'utf8')

  const elements = new Map(
    ['connection-label', 'connection-status', 'conversation-cursor', 'message-list', 'notice',
      'presence-count', 'presence-offline', 'presence-online', 'retry-button']
      .map(id => [id, makeElement('div')]),
  )
  const openedStreams = []

  const document = {
    getElementById: id => elements.get(id) ?? null,
    createElement: makeElement,
    createDocumentFragment: () => makeElement('fragment'),
  }

  class FakeEventSource {
    constructor(url) {
      this.url = url
      this.readyState = 0
      this.listeners = new Map()
      openedStreams.push(this)
      this.readyState = 1
      queueMicrotask(() => this.emit('open', {}))
    }

    on(name, handler) { this.listeners.set(name, handler) }
    addEventListener(name, handler) { this.listeners.set(name, handler) }
    emit(name, data) {
      const handler = this.listeners.get(name)
      if (handler) handler({ data: typeof data === 'string' ? data : JSON.stringify(data) })
    }
    close() { this.readyState = 2 }
  }

  const window = {
    document,
    addEventListener() {},
    async fetch(requestPath, options) {
      const headers = { ...(options?.headers ?? {}) }
      if (cookie) headers.cookie = cookie
      const response = await request(port, options?.method ?? 'GET', requestPath, { headers })
      return {
        ok: response.status >= 200 && response.status < 300,
        status: response.status,
        async json() { return JSON.parse(response.text) },
      }
    },
  }

  const context = vm.createContext({ window, document, EventSource: FakeEventSource, console })
  context.globalThis = context
  context.setTimeout = setTimeout
  context.queueMicrotask = queueMicrotask
  vm.runInContext(source, context, { filename: appScriptPath })
  await new Promise(resolve => setTimeout(resolve, 100))
  return { elements, openedStreams, context }
}

function makeElement(tagName) {
  return {
    tagName: String(tagName).toUpperCase(),
    className: '',
    dataset: {},
    children: [],
    attributes: {},
    hidden: false,
    textContent: '',
    value: '',
    scrollTop: 0,
    scrollHeight: 0,
    setAttribute(name, value) { this.attributes[name] = String(value) },
    append(...nodes) { this.children.push(...nodes) },
    replaceChildren(...nodes) { this.children = [...nodes] },
    addEventListener() {},
  }
}

test("the shipped viewer connects to the REAL server's REAL boot descriptor", async (t) => {
  const dataDir = await mkdtempLike(t)
  // The operator's viewer token, minted the way the CLI mints it — BEFORE the
  // server starts, because the server reads the token file at boot.
  const viewerToken = loadOrCreateViewerToken(dataDir)
  const server = await startServer({
    dataDir,
    port: 0,
    host: '127.0.0.1',
    enrollRateLimiter: createEnrollRateLimiter({ limit: 1000 }),
    ...FLOORS_OFF,
  })
  t.after(() => server.close())
  const mint = await request(server.port, 'GET', '/viewer/auth', {
    headers: { authorization: `Bearer ${viewerToken}` },
  })
  assert.equal(mint.status, 200, 'the viewer bridge must mint a session cookie')
  const setCookie = [mint.headers['set-cookie']].flat().find(value => value.startsWith('agent_room_viewer='))
  const cookieValue = /^agent_room_viewer=([A-Za-z0-9_-]+);/.exec(`${setCookie};`)?.[1]
  assert.ok(cookieValue, 'the bridge must set the viewer cookie')

  // What the server ACTUALLY answers — the fixture the shipped script must read.
  const boot = await request(server.port, 'GET', '/viewer/boot.json', {
    headers: { cookie: `agent_room_viewer=${cookieValue}` },
  })
  assert.equal(boot.status, 200, 'the boot descriptor must answer')
  assert.equal(boot.json().ok, true, 'the API answers in the standard envelope')

  const { elements, openedStreams } = await runViewerAgainst({
    port: server.port,
    cookie: `agent_room_viewer=${cookieValue}`,
  })

  assert.equal(
    elements.get('connection-label').textContent,
    'Live · no messages yet',
    'the shipped viewer must reach its live state against the real server — a shape mismatch must not read as an unreachable server',
  )
  assert.equal(
    elements.get('notice').textContent,
    '',
    'no error notice may be shown when the server is healthy',
  )
  assert.equal(openedStreams.length, 1, 'exactly one stream')
  assert.equal(
    openedStreams[0].url,
    `/viewer/api/rooms/${boot.json().result.broadcast_room_id}/events`,
    'the stream must target the Broadcast Room the REAL server named',
  )
})

// A private temp dir, removed when the test ends.
async function mkdtempLike(t) {
  const { mkdtemp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const dir = await mkdtemp(path.join(tmpdir(), 'agent-room-viewer-contract-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return dir
}
