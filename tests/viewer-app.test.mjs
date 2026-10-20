// Story 5.2 (FR-18) — the viewer's CLIENT half, executed.
//
// The other viewer tests assert the SERVER's contract: the boot descriptor's
// shape, the SSE frames, the exposure rules. They never run web/app.js — so a
// client that reads the wrong field of a perfectly-shaped response still
// passes them. That gap was real: the shipped app.js read
// `boot.broadcast_room_id` from the TOP LEVEL of the boot descriptor, while the
// API answers in the standard `{ ok: true, result: { … } }` envelope. The
// viewer therefore reported "Room server unreachable" on every load, against a
// server that was perfectly healthy.
//
// This test runs the shipped script against a minimal DOM double and the REAL
// server's boot descriptor, so a shape mismatch between the two halves fails
// here instead of in a browser.

import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

const rootDirectory = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const appScriptPath = path.join(rootDirectory, 'web', 'app.js')

// The ids index.html gives the viewer. Each becomes a stand-in element with
// the few members app.js touches.
const ELEMENT_IDS = [
  'connection-label',
  'connection-status',
  'conversation-cursor',
  'message-list',
  'notice',
  'presence-count',
  'presence-offline',
  'presence-online',
  'retry-button',
]

function createElement(tagName) {
  const element = {
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
  return element
}

// A DOM double big enough for app.js: element lookup, creation, and the
// EventSource the viewer opens. Nothing here is a mock of agent-room — the
// boot response below is the REAL shape the server sends.
function createViewerHarness({ bootResponse, eventSourceBehaviour = 'open' }) {
  const elements = new Map(ELEMENT_IDS.map(id => [id, createElement('div')]))
  const openedStreams = []

  const document = {
    getElementById: id => elements.get(id) ?? null,
    createElement,
    createDocumentFragment: () => createElement('fragment'),
  }

  class FakeEventSource {
    constructor(url) {
      this.url = url
      this.readyState = 0
      this.listeners = new Map()
      openedStreams.push(this)
      if (eventSourceBehaviour === 'open') {
        this.readyState = 1
        queueMicrotask(() => this.emit('open', {}))
      }
    }

    on(name, handler) { this.listeners.set(name, handler) }

    addEventListener(name, handler) { this.listeners.set(name, handler) }

    emit(name, data) {
      const handler = this.listeners.get(name)
      if (handler) handler({ data: typeof data === 'string' ? data : JSON.stringify(data) })
    }

    close() { this.readyState = 2 }
  }

  const fetchCalls = []
  const window = {
    document,
    addEventListener() {},
    async fetch(path, options) {
      fetchCalls.push({ path, options })
      if (path === '/viewer/boot.json') {
        return {
          ok: true,
          status: 200,
          async json() { return bootResponse },
        }
      }
      return { ok: false, status: 404, async json() { return {} } }
    },
  }

  return { context: { window, document, EventSource: FakeEventSource, console }, elements, openedStreams, fetchCalls }
}

async function runViewer(bootResponse) {
  const source = await readFile(appScriptPath, 'utf8')
  const harness = createViewerHarness({ bootResponse })
  const context = vm.createContext(harness.context)
  context.globalThis = context
  context.setTimeout = setTimeout
  context.queueMicrotask = queueMicrotask
  context.EventSource = harness.context.EventSource
  vm.runInContext(source, context, { filename: appScriptPath })
  // The script ends in `void initialise()` — let its awaits settle.
  await new Promise(resolve => setTimeout(resolve, 50))
  return harness
}

// The REAL shape: the API's standard envelope, exactly as the server writes
// it (tests/viewer.test.mjs asserts the same field path on the server side).
const REAL_BOOT_ENVELOPE = {
  ok: true,
  result: {
    realm_id: 'f7928a1a-ce00-446d-905d-2a4af5d8dc40',
    version: '0.1.0',
    broadcast_room_id: 'IN-rLCpQ-5gGWIz9d9tE2Q',
  },
}

test('the shipped viewer reads the boot descriptor the server actually sends', async () => {
  const harness = await runViewer(REAL_BOOT_ENVELOPE)

  assert.equal(
    harness.elements.get('connection-label').textContent,
    'Live · no messages yet',
    'the viewer must reach the live state against the server\'s real boot envelope',
  )
  assert.notEqual(
    harness.elements.get('connection-label').textContent,
    'Room server unreachable',
    'a shape mismatch between app.js and the API envelope must not read as an unreachable server',
  )
})

test('the viewer opens the ONE SSE stream for the Broadcast Room the boot descriptor named', async () => {
  const harness = await runViewer(REAL_BOOT_ENVELOPE)

  assert.equal(harness.openedStreams.length, 1, 'exactly one stream, for the whole viewer')
  assert.equal(
    harness.openedStreams[0].url,
    '/viewer/api/rooms/IN-rLCpQ-5gGWIz9d9tE2Q/events',
    'the stream must target the Broadcast Room the boot descriptor named',
  )
})

test('the viewer still refuses a boot descriptor with no Broadcast Room', async () => {
  // An envelope that carries no Broadcast Room names nothing to stream — the
  // viewer must say the server is unreachable rather than open a bogus stream.
  const harness = await runViewer({ ok: true, result: { realm_id: 'x', version: '0.1.0' } })

  assert.equal(harness.openedStreams.length, 0, 'no stream without a Broadcast Room')
  assert.equal(harness.elements.get('connection-label').textContent, 'Room server unreachable')
})

test('the viewer still accepts a bare (un-enveloped) boot descriptor', async () => {
  // The envelope is the server's contract, but a bare descriptor is the shape
  // the older descriptor used; the viewer must not break on it either.
  const harness = await runViewer({
    realm_id: 'f7928a1a-ce00-446d-905d-2a4af5d8dc40',
    version: '0.1.0',
    broadcast_room_id: 'IN-rLCpQ-5gGWIz9d9tE2Q',
  })

  assert.equal(harness.openedStreams.length, 1, 'a bare descriptor still names the room')
  assert.equal(harness.elements.get('connection-label').textContent, 'Live · no messages yet')
})
