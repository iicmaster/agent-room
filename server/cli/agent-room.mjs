#!/usr/bin/env node

// The `agent-room` bin — the human side of this installation (the MCP adapter
// never asks the human anything: its stdin is the JSON-RPC channel and must
// stay pure). Two command families share this one entrypoint:
//
//   setup (Story 1.7)     the one-time Chat ID choice: collect chat_id →
//                         validate the DR-1 grammar (chatIdForms) →
//                         ensureServer + local auth → POST /api/session probe
//                         (a live collision answers 409 and re-prompts;
//                         success is immediately released with
//                         DELETE /api/session, so the name is verified
//                         claimable and then freed) → store
//                         PLUGIN_DATA/config.json at 0600 (atomic write).
//
//   held/allow (Story 3.4) the human trust surface over the held pipeline and
//                         the per-realm allowlist: `held list` (metadata
//                         only), `held show <room_id>:<seq>` (the ONLY surface
//                         where held body text appears), `allow <chat-id>`
//                         (resolve the key fingerprint from this realm's held
//                         records and presence, save the allowlist entry,
//                         release that key's held records) and `allow-all`
//                         (the accept-all flip, interactively confirmed).
//                         Their bodies live in ./held-commands.mjs; the
//                         session they use is UNBOUND — the local token plus
//                         the installation public key are exchanged for a
//                         session token and no Chat ID is ever claimed, so
//                         the commands run collision-free while the live MCP
//                         session holds the name and leave zero presence or
//                         durable-claim footprint.
//
// stdin discipline: prompting happens ONLY when stdin is a TTY. A non-TTY
// stdin (pipes, the MCP host, CI) exits with guidance and touches nothing —
// a command that needs a human answer can never be driven programmatically
// into one.
//
// No name is ever stored unless it passed the grammar gate AND the live
// probe; a refused probe writes no config, so a half-finished setup leaves
// no state behind. An existing configuration is never silently overwritten:
// the human confirms the replacement interactively.

import { createInterface } from 'node:readline'
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CHAT_ID_INVALID_MESSAGE,
  CHAT_ID_MAX,
  CLIENT_CONFIG_MAX_BYTES,
  CLIENT_REQUEST_TIMEOUT_MS,
  PUBLIC_ERROR_STATUS,
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
import { cliHttpJson, cliBearerHeaders } from './http.mjs'
import {
  runHeldList,
  runHeldShow,
  runAllow,
  runAllowAll,
} from './held-commands.mjs'

const OK_STATUS = 200
// The collision status is owned by the constants table (chat_id_taken), never restated.
const CONFLICT_STATUS = PUBLIC_ERROR_STATUS.chat_id_taken
export const SETUP_REQUIRES_TTY_MESSAGE = 'agent-room setup asks a human to choose the Chat ID, so it needs an interactive terminal (a TTY). Run it in your own terminal: agent-room setup'

// One claim probe with a fresh session: bind the candidate name, and on
// success release it — the name is verified claimable and then freed for the
// session that will actually use it. The release is best-effort: if it fails,
// the answer says so honestly, because the probe session keeps the name
// live-claimed until its session lease expires. A live collision is the
// caller's signal to re-prompt; any other coded answer is a real failure.
async function probeClaim({ port, localToken, publicKey, chatId, timeoutMs = CLIENT_REQUEST_TIMEOUT_MS }) {
  const exchange = await cliHttpJson(port, 'POST', '/api/auth/local', cliBearerHeaders(localToken), {
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
    bind = await cliHttpJson(port, 'POST', '/api/session', cliBearerHeaders(sessionToken), {
      chat_id: chatId,
      client_type: 'cli',
    }, timeoutMs)
  } finally {
    try {
      const releasedResponse = await cliHttpJson(port, 'DELETE', '/api/session', cliBearerHeaders(sessionToken), undefined, timeoutMs)
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

// The help text is the single home of the command grammar AND the honesty
// statement; tests/cli-surface.test.mjs pins both as literals and checks the
// AC's negative against this text verbatim.
const HELP_TEXT = `agent-room — the human side of your Agent Room installation.

Commands:

  agent-room setup
      Choose this installation's Chat ID (one-time, interactive).

  agent-room held list [--room <room_id>]
      List held messages — metadata only (id, chat id, key fingerprint, room,
      sequence, time, byte size, reason). Held body text appears nowhere here.

  agent-room held show <room_id>:<seq>
      Preview one held message's full body, exactly the artifact the pipeline
      withheld. This is the only surface where held body text appears. The id
      is printed by "agent-room held list".

  agent-room allow <chat-id> [--fingerprint <fingerprint>] [--remove]
      Allow a sender by Chat ID: the name is resolved to its key fingerprint
      from this realm's held records and presence (case-insensitive, merged by
      fingerprint); when several keys claim the name, disambiguate with
      --fingerprint. Saves the allowlist entry and releases that key's held
      messages. With --remove the entry is removed instead: future messages
      from that key are held again; already-ingested text is untouched.

  agent-room allow-all [--remove]
      Allow every future sender in this realm (accept-all). Asks for an
      interactive y/N confirmation; --remove switches it off without one
      (holding messages again is the fail-safe direction).

  agent-room help
      Show this help.

Approval is a human convention (Instructed) — same-user processes are not
cryptographically distinguishable, so an allowlist entry or accept-all is your
decision about processes running as your own user, never a cryptographic
guarantee. The untrusted envelope stays on every delivered foreign body.
`

// The family's uniform failure outcome: one coded line (plus optional detail
// lines, e.g. the ambiguity candidates) printed by the dispatch's single
// coded-error printer.
function failure(command, code, message, lines) {
  return { ok: false, command, code, message, ...(lines === undefined ? {} : { lines }) }
}

// Strict argv tokens for one command: the flags this command family declares,
// everything else positional; any other --token is refused. `--` is the
// end-of-options marker: everything after it passes through as positionals,
// because the DR-1 grammar makes a leading-hyphen Chat ID legal
// (`agent-room allow -- --alice`). A value-flag never consumes another flag
// as its value: a following --token is a coded refusal, never a silent
// mis-parse.
function parseTokens(tokens, { booleanFlags = [], valueFlags = [] } = {}) {
  const positional = []
  const options = {}
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') {
      positional.push(...tokens.slice(index + 1))
      break
    }
    if (booleanFlags.includes(token)) {
      options[token] = true
      continue
    }
    if (valueFlags.includes(token)) {
      const value = tokens[index + 1]
      if (value === undefined || value.startsWith('--')) return { error: `${token} needs a value` }
      options[token] = value
      index += 1
      continue
    }
    if (token.startsWith('--')) return { error: `unknown option "${token}"` }
    positional.push(token)
  }
  return { positional, options }
}

// The held/allow command family (Story 3.4). Returns null for an unrecognized
// command shape so the dispatch falls through to the usage error.
async function runHeldFamilyCommand(command, subcommand, tokens, deps) {
  if (command === 'held') {
    if (subcommand === 'list') {
      const parsed = parseTokens(tokens, { valueFlags: ['--room'] })
      if (parsed.error) return failure('held list', 'invalid_request', `${parsed.error}; see "agent-room help"`)
      if (parsed.positional.length > 0) {
        return failure('held list', 'invalid_request', `unexpected argument "${parsed.positional[0]}"; see "agent-room help"`)
      }
      return runHeldList(deps, { roomId: parsed.options['--room'] })
    }
    if (subcommand === 'show') {
      const parsed = parseTokens(tokens)
      if (parsed.error) return failure('held show', 'invalid_request', `${parsed.error}; see "agent-room help"`)
      if (parsed.positional.length !== 1) {
        return failure(
          'held show',
          'invalid_request',
          'expected exactly one held-message id: agent-room held show <room_id>:<seq> — the id as printed by "agent-room held list"',
        )
      }
      return runHeldShow(deps, parsed.positional[0])
    }
    return null
  }
  if (command === 'allow') {
    const parsed = parseTokens(tokens, { booleanFlags: ['--remove'], valueFlags: ['--fingerprint'] })
    if (parsed.error) return failure('allow', 'invalid_request', `${parsed.error}; see "agent-room help"`)
    if (parsed.positional.length !== 1) {
      return failure('allow', 'invalid_request', 'expected exactly one Chat ID: agent-room allow <chat-id> [--fingerprint <fingerprint>] [--remove]')
    }
    return runAllow(deps, parsed.positional[0], {
      remove: parsed.options['--remove'] === true,
      ...(parsed.options['--fingerprint'] === undefined ? {} : { fingerprint: parsed.options['--fingerprint'] }),
    })
  }
  if (command === 'allow-all') {
    const parsed = parseTokens(tokens, { booleanFlags: ['--remove'] })
    if (parsed.error) return failure('allow-all', 'invalid_request', `${parsed.error}; see "agent-room help"`)
    if (parsed.positional.length > 0) {
      return failure('allow-all', 'invalid_request', `unexpected argument "${parsed.positional[0]}"; see "agent-room help"`)
    }
    return runAllowAll(deps, { remove: parsed.options['--remove'] === true })
  }
  return null
}

export async function main(argv = process.argv.slice(2), {
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  sharedDataDir = sharedDataDirectory(),
  pluginDataDir = instanceDataDirectory(),
} = {}) {
  const [command, subcommand] = argv
  if (command === 'help' || command === '--help' || command === '-h') {
    output.write(HELP_TEXT)
    return { status: 'help' }
  }
  const deps = { input, output, sharedDataDir, pluginDataDir }
  if (command === 'setup') {
    const outcome = await runSetup({ input, output, sharedDataDir, pluginDataDir })
    if (outcome.status === 'not-a-tty' || outcome.status === 'aborted') {
      errorOutput.write(`${outcome.message}\n`)
      process.exitCode = 1
    }
    return outcome
  }
  if (command === 'held' || command === 'allow' || command === 'allow-all') {
    let outcome = null
    try {
      outcome = await runHeldFamilyCommand(
        command,
        subcommand,
        command === 'held' ? argv.slice(2) : argv.slice(1),
        deps,
      )
    } catch (error) {
      // The family's one coded-error printer: a thrown or rejected refusal
      // (the mutators reject, never throw past an await) surfaces as the
      // command's coded error, never a bare "invalid" or a stack trace.
      outcome = failure(
        command === 'held' ? `held ${subcommand ?? ''}`.trimEnd() : command,
        error?.code ?? 'request_failed',
        error?.message ?? String(error),
      )
    }
    if (outcome === null) {
      // Coded usage refusal (review patch): the family shape that did not
      // resolve is named, then the help follows.
      const attempted = [command, subcommand].filter(part => part !== undefined).join(' ')
      errorOutput.write(`agent-room: usage_refusal: unknown command "${attempted}"; run "agent-room help" for the command reference\n`)
      errorOutput.write(HELP_TEXT)
      process.exitCode = 1
      return { status: 'usage' }
    }
    if (outcome.ok === false) {
      if (outcome.aborted === true) {
        // The human answered the prompt "no" (or the input ended): the setup
        // command's established abort discipline — one coded line, exit 1,
        // nothing changed.
        errorOutput.write(`agent-room: confirm_declined: ${outcome.message}\n`)
      } else {
        errorOutput.write(`agent-room ${outcome.command} failed: ${outcome.code}: ${outcome.message}\n`)
        for (const line of outcome.lines ?? []) errorOutput.write(`${line}\n`)
      }
      process.exitCode = 1
      return outcome
    }
    output.write(`${outcome.lines.join('\n')}\n`)
    return outcome
  }
  // No args or an unknown command: one coded line, then usage plus the
  // honesty statement on stderr, exit 1, no state touched.
  if (command !== undefined) {
    errorOutput.write(`agent-room: unknown_command: unknown command "${command}"; run "agent-room help" for the command reference\n`)
  } else {
    errorOutput.write('agent-room: usage_refusal: no command given; run "agent-room help" for the command reference\n')
  }
  errorOutput.write(HELP_TEXT)
  process.exitCode = 1
  return { status: 'usage' }
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
