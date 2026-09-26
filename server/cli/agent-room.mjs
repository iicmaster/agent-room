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
// no state behind. An existing configuration is never silently overwritten:
// the human confirms the replacement interactively.

import { createInterface } from 'node:readline'
import http from 'node:http'
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CHAT_ID_INVALID_MESSAGE,
  CHAT_ID_MAX,
  CLIENT_CONFIG_MAX_BYTES,
  CLIENT_REQUEST_TIMEOUT_MS,
  PROTOCOL_HEADER,
  PUBLIC_ERROR_STATUS,
  PROTOCOL_VERSION,
  chatIdForms,
} from '../constants.mjs'
import {
  AgentRoomRuntimeError,
  atomicWriteJson,
  instanceDataDirectory,
  readJsonFile,
  sharedDataDirectory,
} from '../runtime.mjs'
import { assertSupportedRuntime } from '../runtime.mjs'
import { loadOrCreateKeypair } from '../keys.mjs'
import { loadOrCreateLocalToken } from '../api/local-token.mjs'
import { ensureServer } from '../client/ensure-server.mjs'

const OK_STATUS = 200
// The collision status is owned by the constants table (chat_id_taken), never restated.
const CONFLICT_STATUS = PUBLIC_ERROR_STATUS.chat_id_taken
export const SETUP_REQUIRES_TTY_MESSAGE = 'agent-room setup asks a human to choose the Chat ID, so it needs an interactive terminal (a TTY). Run it in your own terminal: agent-room setup'

function httpJson(port, method, path, headers, body, timeoutMs = CLIENT_REQUEST_TIMEOUT_MS) {
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

function bearerHeaders(token) {
  return {
    [PROTOCOL_HEADER]: PROTOCOL_VERSION,
    authorization: `Bearer ${token}`,
    'content-type': 'application/json; charset=utf-8',
  }
}

// One claim probe with a fresh session: bind the candidate name, and on
// success release it — the name is verified claimable and then freed for the
// session that will actually use it. The release is best-effort: if it fails,
// the answer says so honestly, because the probe session keeps the name
// live-claimed until its session lease expires. A live collision is the
// caller's signal to re-prompt; any other coded answer is a real failure.
async function probeClaim({ port, localToken, publicKey, chatId, timeoutMs = CLIENT_REQUEST_TIMEOUT_MS }) {
  const exchange = await httpJson(port, 'POST', '/api/auth/local', bearerHeaders(localToken), {
    public_key: publicKey,
  }, timeoutMs)
  if (exchange.status !== OK_STATUS || exchange.body?.result?.session_token === undefined) {
    throw new AgentRoomRuntimeError(
      exchange.body?.error?.code ?? 'request_failed',
      exchange.body?.error?.message ?? `the agent-room credential exchange answered ${exchange.status}`,
    )
  }
  const sessionToken = exchange.body.result.session_token
  let released = true
  let bind
  try {
    bind = await httpJson(port, 'POST', '/api/session', bearerHeaders(sessionToken), {
      chat_id: chatId,
      client_type: 'cli',
    }, timeoutMs)
  } finally {
    try {
      const releasedResponse = await httpJson(port, 'DELETE', '/api/session', bearerHeaders(sessionToken), undefined, timeoutMs)
      released = releasedResponse.status === OK_STATUS
    } catch {
      released = false
    }
  }
  if (bind.status === OK_STATUS) {
    return { claimed: true, released }
  }
  if (bind.status === CONFLICT_STATUS && bind.body?.error?.code === 'chat_id_taken') {
    return { claimed: false, released }
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

  // The grammar text is derived from the constants module, never restated.
  say(`Welcome to agent-room setup. This installation needs one Chat ID — ${CHAT_ID_INVALID_MESSAGE} — other agents will use it to find and message you.`)
  const configPath = join(pluginDataDir, 'config.json')

  try {
    // An existing configuration is never silently overwritten: the human
    // confirms the replacement interactively before anything else happens
    // (and before the shared server is even booted).
    if (existsSync(configPath)) {
      let existing = null
      try {
        existing = readJsonFile(configPath, { maxBytes: CLIENT_CONFIG_MAX_BYTES })
      } catch {
        existing = null
      }
      const existingChatId = typeof existing?.chat_id === 'string' ? existing.chat_id : '(unreadable)'
      const answer = await ask(`A Chat ID ("${existingChatId}") is already configured for this installation (${configPath}). Overwrite it? [y/N] `)
      if (answer === null) {
        return { status: 'aborted', message: 'agent-room setup ended before an answer was given; no configuration was written' }
      }
      if (!/^(y|yes)$/i.test(String(answer).trim())) {
        return { status: 'aborted', message: 'agent-room setup kept the existing configuration; nothing was changed' }
      }
    }

    // Local Mode bootstrap: the shared server (and, after a boot, the local
    // credential file) exists before the first probe.
    const server = await ensureServer({ dataDir: sharedDataDir, ...(waitMs === undefined ? {} : { waitMs }) })
    const localToken = loadOrCreateLocalToken(sharedDataDir)
    const keypair = loadOrCreateKeypair(pluginDataDir)

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
      if (!probe.released) {
        say(`Warning: the probe session could not be released, so "${forms.display}" stays live-claimed until that session's lease expires; connecting with it may answer chat_id_taken until then.`)
      }
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

// Story 1.1's contract gates EVERY entrypoint. This one was added later (the
// setup command) and initially shipped ungated, which the Story 1.1 audit
// caught: on Node < 24.15 the module loaded and printed usage instead of
// refusing. Same shape as mcp-stdio / roomd / the API server: a direct launch
// reports one diagnosable line and exits 1 with no stack trace; an importer
// gets a catchable rejection so harnesses can assert on the failure.
try {
  assertSupportedRuntime()
} catch (error) {
  if (launchedDirectly()) {
    process.stderr.write(`agent-room setup failed: ${error?.code ?? 'startup_failed'}: ${error?.message}\n`)
    process.exit(1)
  }
  throw error
}

if (launchedDirectly()) {
  main().catch(error => {
    process.stderr.write(`agent-room setup failed: ${error?.code ?? 'setup_failed'}: ${error?.message}\n`)
    process.exitCode = 1
  })
}
