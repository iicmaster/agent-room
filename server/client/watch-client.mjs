// Story 3.1: the watch client — a dedicated, UNPOOLED ({ agent: false })
// connection that streams GET /api/watch and reconnects with jittered
// exponential backoff. It is deliberately separate from the pooled request
// path in api-client.mjs: a long-lived watch must never pin a pooled socket.
//
// Reconnect STOPS immediately on session_superseded, actor_banned or
// session_revoked — those are terminal authority events; retrying them would
// loop forever against a credential that can never become valid again.

import http from 'node:http'
import https from 'node:https'
import { AgentRoomRuntimeError } from '../runtime.mjs'
import {
  WATCH_RECONNECT_BASE_MS,
  WATCH_RECONNECT_JITTER,
  WATCH_RECONNECT_MAX_MS,
} from '../constants.mjs'

const TERMINAL_EVENTS = new Set(['session_superseded', 'actor_banned', 'session_revoked'])

// The pure backoff for retry n (1-based): base·2^(n−1) capped at max, jittered
// uniformly by ±WATCH_RECONNECT_JITTER. `random` is injectable for tests.
export function watchBackoffMs(retry, { random = Math.random } = {}) {
  if (!Number.isSafeInteger(retry) || retry < 1) {
    throw new AgentRoomRuntimeError('invalid_argument', 'retry must be a positive safe integer')
  }
  if (typeof random !== 'function') {
    throw new AgentRoomRuntimeError('invalid_argument', 'random must be a function')
  }
  const base = Math.min(WATCH_RECONNECT_BASE_MS * 2 ** (retry - 1), WATCH_RECONNECT_MAX_MS)
  return Math.round(base * (1 - WATCH_RECONNECT_JITTER) + random() * base * 2 * WATCH_RECONNECT_JITTER)
}

function sleep(ms, signal) {
  return new Promise((resolvePromise, rejectPromise) => {
    if (signal?.aborted) { rejectPromise(new Error('cancelled')); return }
    const timer = setTimeout(() => { signal?.removeEventListener('abort', onAbort); resolvePromise() }, ms)
    function onAbort() { clearTimeout(timer); rejectPromise(new Error('cancelled')) }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

// Parse an SSE or NDJSON event stream into { event, data } frames. Accepts a
// synchronous chunk feed; returns complete frames. Handles both `data: `
// (SSE) and bare JSON lines (NDJSON). Comment lines (`:`) are ignored.
export function createFrameParser() {
  let buffer = ''
  let sseData = []
  return {
    feed(chunk) {
      buffer += chunk
      const frames = []
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/, '')
        buffer = buffer.slice(newline + 1)
        if (line === '') {
          if (sseData.length > 0) {
            const raw = sseData.join('\n')
            sseData = []
            try { frames.push(JSON.parse(raw)) } catch { /* non-JSON data ignored */ }
          }
          continue
        }
        if (line.startsWith('data:')) {
          sseData.push(line.slice(5).trimStart())
        } else if (!line.startsWith(':') && !line.startsWith('event:')) {
          // NDJSON bare object line.
          try { frames.push(JSON.parse(line)) } catch { /* ignore partial/junk */ }
        }
      }
      return frames
    },
  }
}

// Open one unpooled streaming GET. Resolves on the 200 response (with a
// `frames` async iterator of parsed events) and rejects on any non-2xx or
// transport error. The caller owns the AbortController for cancellation.
export function openWatchStream({ port, url, path, headers, signal }) {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = (url === undefined ? http.request : https.request)(
      ...(url === undefined
        ? [{ host: '127.0.0.1', port, method: 'GET', path, headers, agent: false }]
        : [new URL(path, url), { method: 'GET', headers, agent: false }]),
      response => {
        if (response.statusCode !== 200) {
          response.resume()
          rejectPromise(new AgentRoomRuntimeError('request_failed', `watch stream answered ${response.statusCode}`))
          return
        }
        const parser = createFrameParser()
        const queue = []
        let wake = null
        let ended = false
        response.on('data', chunk => {
          for (const frame of parser.feed(chunk.toString('utf8'))) {
            queue.push(frame)
            if (wake) { const w = wake; wake = null; w() }
          }
        })
        const finish = () => { ended = true; if (wake) { const w = wake; wake = null; w() } }
        response.on('end', finish)
        response.on('error', finish)
        response.on('aborted', finish)
        const frames = {
          async *[Symbol.asyncIterator]() {
            for (;;) {
              while (queue.length > 0) yield queue.shift()
              if (ended) return
              await new Promise(resolveWait => { wake = resolveWait })
            }
          },
        }
        resolvePromise({ response, frames })
      },
    )
    request.on('error', rejectPromise)
    if (signal) {
      if (signal.aborted) request.destroy()
      else signal.addEventListener('abort', () => request.destroy(), { once: true })
    }
    request.end()
  })
}

// The reconnecting watch loop. `onEvent` receives each parsed event frame;
// `connect` is injectable (defaults to openWatchStream) so tests can drive it.
// Stops on a terminal event or an aborted signal. Backoff uses watchBackoffMs.
export async function runWatchLoop({ connect = openWatchStream, onEvent, onRetry = () => {}, signal, random = Math.random }) {
  let retry = 0
  while (!signal?.aborted) {
    let stream
    try {
      stream = await connect({ signal })
    } catch (error) {
      if (signal?.aborted) return
      retry += 1
      onRetry(retry, error)
      try { await sleep(watchBackoffMs(retry, { random }), signal) } catch { return }
      continue
    }
    retry = 0
    let terminal = false
    try {
      for await (const event of stream.frames) {
        if (event && typeof event === 'object') {
          onEvent(event)
          if (TERMINAL_EVENTS.has(event.event)) { terminal = true; break }
        }
      }
    } catch {
      // stream failed — reconnect below unless terminal
    }
    if (terminal || signal?.aborted) return
    retry += 1
    onRetry(retry, null)
    try { await sleep(watchBackoffMs(retry, { random }), signal) } catch { return }
  }
}
