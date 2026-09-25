#!/usr/bin/env node

// The one-time `agent-room setup` command (Story 1.7): the only place where a
// human chooses this installation's Chat ID. The MCP adapter never asks the
// human anything — its stdin is the JSON-RPC channel and must stay pure — so
// first-run Chat ID selection lives here, in the user's own terminal:
//
//   collect chat_id → validate the DR-1 grammar (chatIdForms) → ensureServer
//   + local auth → POST /api/session probe (a live collision answers 409 and
//   re-prompts; success is immediately released with DELETE /api/session, so
//   the name is verified claimable and then freed) → store
//   PLUGIN_DATA/config.json at 0600 (atomic write).
//
// stdin discipline: prompting happens ONLY when stdin is a TTY. A non-TTY
// stdin (pipes, the MCP host, CI) exits with guidance and touches nothing —
// the command can never be driven programmatically into storing a name.
//
// No name is ever stored unless it passed the grammar gate AND the live
// probe; a refused probe writes no config, so a half-finished setup leaves
// no state behind.

import { createInterface } from 'node:readline'
import http from 'node:http'
import { realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CHAT_ID_INVALID_MESSAGE,
  CHAT_ID_MAX,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  chatIdForms,
} from '../constants.mjs'
import {
  AgentRoomRuntimeError,
  atomicWriteJson,
  instanceDataDirectory,
  sharedDataDirectory,
} from '../runtime.mjs'
import { loadOrCreateKeypair } from '../keys.mjs'
import { loadOrCreateLocalToken } from '../api/local-token.mjs'
import { ensureServer } from '../client/ensure-server.mjs'

const OK_STATUS = 200
const CONFLICT_STATUS = 409
export const SETUP_REQUIRES_TTY_MESSAGE = 'agent-room setup asks a human to choose the Chat ID, so it needs an interactive terminal (a TTY). Run it in your own terminal: agent-room setup'

function httpJson(port, method, path, headers, body) {
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
    request.on('error', rejectPromise)
    if (body !== undefined) request.write(JSON.stringify(body))
    request.end()
  })
}

function bearerHeaders(token) {
  return {
    [PROTOCOL_HEADER]: PROTOCOL_VERSION,
    authorization: `Bearer ${token}`,
    'content-type': 'application/json; charset=utf-8',
  }
}

// One claim probe with a fresh session: bind the candidate name, and on
// success release it immediately — the name is verified claimable and then
// freed for the session that will actually use it. A live collision is the
// caller's signal to re-prompt; any other coded answer is a real failure.
async function probeClaim({ port, localToken, publicKey, chatId }) {
  const exchange = await httpJson(port, 'POST', '/api/auth/local', bearerHeaders(localToken), {
    public_key: publicKey,
  })
  if (exchange.status !== OK_STATUS || exchange.body?.result?.session_token === undefined) {
    throw new AgentRoomRuntimeError(
      exchange.body?.error?.code ?? 'request_failed',
      exchange.body?.error?.message ?? `the agent-room credential exchange answered ${exchange.status}`,
    )
  }
  const sessionToken = exchange.body.result.session_token
  const bind = await httpJson(port, 'POST', '/api/session', bearerHeaders(sessionToken), {
    chat_id: chatId,
    client_type: 'cli',
  })
  if (bind.status === OK_STATUS) {
    const released = await httpJson(port, 'DELETE', '/api/session', bearerHeaders(sessionToken))
    if (released.status !== OK_STATUS) {
      throw new AgentRoomRuntimeError(
        released.body?.error?.code ?? 'request_failed',
        released.body?.error?.message ?? 'the probe session could not be released',
      )
    }
    return { claimed: true }
  }
  if (bind.status === CONFLICT_STATUS && bind.body?.error?.code === 'chat_id_taken') {
    return { claimed: false }
  }
  throw new AgentRoomRuntimeError(
    bind.body?.error?.code ?? 'request_failed',
    bind.body?.error?.message ?? `the agent-room session probe answered ${bind.status}`,
  )
}

// The interactive setup flow. Streams and directories are injectable so the
// tests can drive it without a TTY process. Returns a result object:
//   { status: 'configured', chatId, configPath }
//   { status: 'not-a-tty' }              — guidance, nothing touched
//   { status: 'aborted' }                — the human ended the input early
export async function runSetup({
  input = process.stdin,
  output = process.stdout,
  sharedDataDir = sharedDataDirectory(),
  pluginDataDir = instanceDataDirectory(),
  waitMs,
} = {}) {
  if (!input.isTTY) {
    return { status: 'not-a-tty', message: SETUP_REQUIRES_TTY_MESSAGE }
  }

  // Local Mode bootstrap: the shared server (and, after a boot, the local
  // credential file) exists before the first probe.
  const server = await ensureServer({ dataDir: sharedDataDir, ...(waitMs === undefined ? {} : { waitMs }) })
  const localToken = loadOrCreateLocalToken(sharedDataDir)
  const keypair = loadOrCreateKeypair(pluginDataDir)

  const lines = createInterface({ input, output, terminal: false })
  // One pending ask at a time. When the interface closes (the human pressed
  // Ctrl-D, or the input ended), the pending question resolves with null so
  // the flow can return an honest aborted outcome instead of hanging.
  let pendingAsk = null
  lines.once('close', () => {
    if (pendingAsk) {
      const resolveAborted = pendingAsk
      pendingAsk = null
      resolveAborted(null)
    }
  })
  const ask = question => new Promise(resolvePromise => {
    pendingAsk = resolvePromise
    lines.question(question, answer => {
      pendingAsk = null
      resolvePromise(answer)
    })
  })
  const say = message => output.write(`${message}\n`)

  say(`Welcome to agent-room setup. This installation needs one Chat ID (1-${CHAT_ID_MAX} characters: letters, numbers, dot, underscore, hyphen) — other agents will use it to find and message you.`)
  const configPath = join(pluginDataDir, 'config.json')

  try {
    for (;;) {
      const answer = await ask(`Choose a Chat ID: `)
      if (answer === null) {
        return { status: 'aborted', message: 'agent-room setup ended before a Chat ID was chosen; no configuration was written' }
      }
      const candidate = String(answer).trim()
      const forms = chatIdForms(candidate)
      if (forms === null) {
        say(`"${candidate.slice(0, CHAT_ID_MAX + 16)}" is not a valid Chat ID: ${CHAT_ID_INVALID_MESSAGE}`)
        continue
      }

      let probe
      try {
        probe = await probeClaim({
          port: server.port,
          localToken,
          publicKey: keypair.publicKey.toString('base64url'),
          chatId: forms.display,
        })
      } catch (error) {
        throw new AgentRoomRuntimeError(
          error?.code ?? 'request_failed',
          `agent-room setup could not verify "${forms.display}": ${error?.message ?? 'probe failed'}`,
        )
      }
      if (!probe.claimed) {
        say(`"${forms.display}" is already claimed live by another connected session. Choose another name.`)
        continue
      }

      // Verified claimable and released. Now — and only now — is the
      // configuration written, atomically, 0600, into PLUGIN_DATA.
      atomicWriteJson(configPath, {
        chat_id: forms.display,
        set_up_at: new Date().toISOString(),
      })
      say(`Done. This installation's Chat ID is "${forms.display}".`)
      say(`Stored in ${configPath} — the agent-room tools are ready to use.`)
      return { status: 'configured', chatId: forms.display, configPath }
    }
  } finally {
    lines.close()
  }
}

function launchedDirectly() {
  if (!process.argv[1]) return false
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}

export async function main(argv = process.argv.slice(2)) {
  if (argv[0] !== 'setup') {
    process.stderr.write('Usage: agent-room setup — choose this installation\'s Chat ID (one-time, interactive)\n')
    process.exitCode = 1
    return
  }
  const outcome = await runSetup()
  if (outcome.status === 'not-a-tty') {
    process.stderr.write(`${outcome.message}\n`)
    process.exitCode = 1
    return
  }
  if (outcome.status === 'aborted') {
    process.stderr.write(`${outcome.message}\n`)
    process.exitCode = 1
  }
}

if (launchedDirectly()) {
  main().catch(error => {
    process.stderr.write(`agent-room setup failed: ${error?.code ?? 'setup_failed'}: ${error?.message}\n`)
    process.exitCode = 1
  })
}
