// The CLI's one bounded HTTP round-trip helper (Story 3.4): the setup
// command's battle-tested `httpJson`/`bearerHeaders` pair, extracted verbatim
// from server/cli/agent-room.mjs into this single home so both halves of the
// `agent-room` bin — the interactive setup command (Story 1.7) and the human
// held/allow command family (Story 3.4) — share one substrate instead of
// private copies. Every round trip is loopback-only, unpooled (`agent: false`)
// and idle-timeout-bounded, so a server that accepts and stalls can never hang
// an interactive command.

import http from 'node:http'

import { AgentRoomRuntimeError } from '../runtime.mjs'
import { CLIENT_REQUEST_TIMEOUT_MS, PROTOCOL_HEADER, PROTOCOL_VERSION } from '../constants.mjs'

export function cliHttpJson(port, method, path, headers, body, timeoutMs = CLIENT_REQUEST_TIMEOUT_MS) {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = http.request(
      { host: '127.0.0.1', port, method, path, headers, agent: false },
      response => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('error', rejectPromise)
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed = null
          try { parsed = JSON.parse(text) } catch { parsed = null }
          resolvePromise({ status: response.statusCode, body: parsed })
        })
      },
    )
    // Every probe round trip is bounded: a server that accepts and stalls
    // cannot hang the interactive command.
    request.setTimeout(timeoutMs, () => request.destroy(new AgentRoomRuntimeError('request_failed', 'request timed out')))
    request.on('error', rejectPromise)
    if (body !== undefined) request.write(JSON.stringify(body))
    request.end()
  })
}

export function cliBearerHeaders(token) {
  return {
    [PROTOCOL_HEADER]: PROTOCOL_VERSION,
    authorization: `Bearer ${token}`,
    'content-type': 'application/json; charset=utf-8',
  }
}
