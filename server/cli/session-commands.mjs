// The session command family (Story 6.4, v0.2.0 reconnect recovery):
// `agent-room session replace` — the ONE explicit, operator-authorized
// takeover of a Chat ID that another session still holds.
//
// WHY IT EXISTS. A client's Chat ID is held by a live row in the server's
// session registry, and that row outlives the process that created it: a
// client that was killed, crashed, or lost its host keeps the name until the
// row's lease expires, while presence shows the holder offline. The server's
// ordinary re-auth recovery releases a DEAD holder only — it cannot tell a
// dead process from a quiet one, so it refuses, and the restarted client is
// permanently unrecoverable under its own name. FR-12 asks for exactly the
// opposite: a client that died, slept, or lost connectivity must be able to
// reclaim or re-pick its Chat ID.
//
// THE CONTRACT. This command never invents authority: it authenticates as
// THIS installation (its own key, its own credential path) and asks the
// server for the takeover with the additive `replace_existing` intent. The
// server grants it only when the live holder is the SAME Actor, verifies the
// incumbent against its own rows, writes the durable claim before the
// memory commit, and fences the displaced session: its token stops
// authenticating (so it cannot take the name back by re-authenticating) and
// every request the displaced session had in flight is refused — at the
// authorization stage before the server reads its body, and at the
// pipeline's post-input revalidation directly before the handler, after the
// body has fully arrived (Story 7.1 closed the body-arrival window the
// release-gate review had executed). A session of a
// DIFFERENT key is never displaced — the refusal is the ordinary collision
// refusal, so the refused operator learns nothing about who holds the name.
//
// WHAT IT DOES WITH THE NAME. The command's own session holds the name only
// for the duration of the takeover, then releases it again: the live client
// the operator is recovering binds it on its next call. (Holding it would
// leave the recovered client unable to bind at all — the name would sit in
// this command's lease.) The window between the release and that bind is
// small and the receipt says so plainly: the name is free until the live
// client takes it again.
//
// THE GRAMMAR (HCI-3, shared with the other machine-readable families):
// one JSON object per line on stdout, one JSON object on stderr for a
// refusal, exit 0 ok / 1 refusal / 2 usage. The takeover DISPLACES another
// session, so it asks for an interactive y/N first and refuses a
// non-interactive stdin outright.
//
// WHAT THE CONFIRMATION IS, exactly: a guardrail against an ACCIDENT — an
// unattended pipe, a script, a harness cannot displace a session by accident.
// It is NOT proof that a human answered, and NOT a security boundary: a
// local process that can read this installation's key can post the takeover
// directly, and a shell-capable agent can allocate a pseudo-TTY and answer
// the prompt itself (the REL-1 run recorded exactly that). What the server
// guarantees is absolute and is the part that matters: a session of a
// DIFFERENT key is never displaced, whoever asks.

import { createInterface } from 'node:readline'

import {
  CHAT_ID_INVALID_MESSAGE,
  CLIENT_REQUEST_TIMEOUT_MS,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
  chatIdForms,
} from '../constants.mjs'
import { AgentRoomRuntimeError } from '../runtime.mjs'
import { loadOrCreateKeypair, signWithInstallationKey } from '../keys.mjs'
import { loadOrCreateLocalToken } from '../api/local-token.mjs'
import { ensureServer } from '../client/ensure-server.mjs'
import { loadRemoteConfig } from '../client/remote-config.mjs'
import { loadChatIdConfig } from '../client/api-client.mjs'
import { cliHttpJson, cliHttpJsonUrl, cliBearerHeaders } from './http.mjs'

const line = object => JSON.stringify(object)

export const SESSION_REPLACE_REQUIRES_TTY_MESSAGE = 'agent-room session replace displaces the session that currently holds the Chat ID, so it asks a human to confirm: run it in your own terminal (a TTY).'

function usage(command, message) {
  return { status: 'usage', command: `session ${command}`, code: 'usage', message }
}

// One JSON round trip to the local loopback server or to the configured
// remote origin — the same substrate, the same timeout discipline.
function roundTrip(target, method, path, headers, body, timeoutMs) {
  if (target.kind === 'remote') {
    return cliHttpJsonUrl(target.serverUrl, method, path, headers, body, timeoutMs)
  }
  return cliHttpJson(target.port, method, path, headers, body, timeoutMs)
}

function protocolHeaders(bearer) {
  return {
    [PROTOCOL_HEADER]: PROTOCOL_VERSION,
    ...(bearer === undefined ? {} : { authorization: `Bearer ${bearer}` }),
    'content-type': 'application/json; charset=utf-8',
  }
}

// The credential exchange, per transport. Local Mode: the shared data
// directory's local token file plus this installation's public key (the
// OS-user boundary). Remote Mode: the challenge lane — challenge, sign the
// raw nonce with this installation's own key, answer — and never the local
// token file. Either way the resulting session belongs to THIS Actor, which
// is exactly the identity a takeover requires.
async function authenticate(target, { pluginDataDir, sharedDataDir }) {
  const keypair = loadOrCreateKeypair(pluginDataDir)
  if (target.kind === 'remote') {
    const challenge = await roundTrip(target, 'POST', '/api/auth/challenge', protocolHeaders(), {
      public_key: keypair.publicKey.toString('base64url'),
    }, CLIENT_REQUEST_TIMEOUT_MS)
    const nonce = challenge.body?.result?.nonce
    if (challenge.status !== 200 || typeof nonce !== 'string' || nonce.length === 0) {
      throw new AgentRoomRuntimeError(
        challenge.body?.error?.code ?? 'request_failed',
        challenge.body?.error?.message ?? `the agent-room server answered ${challenge.status}`,
      )
    }
    const signature = signWithInstallationKey(pluginDataDir, Buffer.from(nonce, 'base64url')).toString('base64url')
    const answer = await roundTrip(target, 'POST', '/api/auth/answer', protocolHeaders(), {
      nonce,
      signature,
    }, CLIENT_REQUEST_TIMEOUT_MS)
    const token = answer.body?.result?.session_token
    if (answer.status !== 200 || typeof token !== 'string' || token.length === 0) {
      throw new AgentRoomRuntimeError(
        answer.body?.error?.code ?? 'request_failed',
        answer.body?.error?.message ?? `the agent-room server answered ${answer.status}`,
      )
    }
    return { token, fingerprint: keypair.fingerprint }
  }
  const localToken = loadOrCreateLocalToken(sharedDataDir)
  const exchange = await roundTrip(target, 'POST', '/api/auth/local', protocolHeaders(localToken), {
    public_key: keypair.publicKey.toString('base64url'),
  }, CLIENT_REQUEST_TIMEOUT_MS)
  const token = exchange.body?.result?.session_token
  if (exchange.status !== 200 || typeof token !== 'string' || token.length === 0) {
    throw new AgentRoomRuntimeError(
      exchange.body?.error?.code ?? 'request_failed',
      exchange.body?.error?.message ?? `the agent-room server answered ${exchange.status}`,
    )
  }
  return { token, fingerprint: keypair.fingerprint }
}

// The takeover itself: bind the name WITH the explicit intent, then release
// this command's own session so the live client can take the name.
async function takeOver(target, { token, chatId }) {
  const bind = await roundTrip(target, 'POST', '/api/session', protocolHeaders(token), {
    chat_id: chatId,
    client_type: 'cli',
    replace_existing: true,
  }, CLIENT_REQUEST_TIMEOUT_MS)
  if (bind.status !== 200) {
    const code = bind.body?.error?.code
    const message = bind.body?.error?.message
    if (code === 'chat_id_taken') {
      throw new AgentRoomRuntimeError(
        'chat_id_taken',
        `the Chat ID "${chatId}" is held by a session this installation cannot displace — another key holds it, or the takeover was refused. `
        + 'Only a session of THIS installation\'s own key can be displaced.',
      )
    }
    throw new AgentRoomRuntimeError(
      typeof code === 'string' && code.length > 0 ? code : 'request_failed',
      typeof message === 'string' ? message : `the agent-room server answered ${bind.status}`,
    )
  }
  const replaced = bind.body?.result?.replaced === true
  // Release this command's own session: the takeover's job is to hand the
  // name BACK to the live client, not to keep it. A failed release is
  // reported honestly in the receipt — the name would then stay claimed by
  // this command's lease.
  let released = true
  try {
    const release = await roundTrip(target, 'DELETE', '/api/session', protocolHeaders(token), undefined, CLIENT_REQUEST_TIMEOUT_MS)
    released = release.status === 200
  } catch {
    released = false
  }
  return { replaced, released }
}

// The human's answer. A TTY is required (the takeover displaces another
// session); the prompt names the Chat ID and what the takeover does. The
// prompt goes to STDERR, never to stdout: this family's stdout carries
// JSON lines only, one self-contained object per line.
async function askConfirm({ input, errorOutput, question }) {
  // The readline interface writes the question to ITS output stream — so
  // that stream is stderr here, and stdout keeps the JSON-lines grammar.
  const lines = createInterface({ input, output: errorOutput, terminal: false })
  return new Promise(resolvePromise => {
    let settled = false
    const settle = value => {
      if (settled) return
      settled = true
      lines.close()
      resolvePromise(value)
    }
    lines.once('close', () => settle(null))
    lines.question(question, answer => settle(/^(y|yes)$/i.test(String(answer).trim())))
  })
}

// `agent-room session replace [<chat-id>]` — take the name back for this
// installation.
export async function runSessionReplace({ input, output, errorOutput, pluginDataDir, sharedDataDir }, rawChatId) {
  if (!input?.isTTY) {
    return {
      status: 'refusal',
      command: 'session replace',
      code: 'invalid_request',
      message: SESSION_REPLACE_REQUIRES_TTY_MESSAGE,
    }
  }
  const configured = loadChatIdConfig(pluginDataDir)
  const requested = rawChatId === undefined ? configured.chatId : rawChatId
  const forms = chatIdForms(requested)
  if (forms === null) {
    return {
      status: 'refusal',
      command: 'session replace',
      code: 'invalid_chat_id',
      message: `"${String(requested).slice(0, 64)}" is not a valid Chat ID: ${CHAT_ID_INVALID_MESSAGE}`,
    }
  }
  // The transport: a configured remote origin is the remote lane; otherwise
  // the shared local server (which the command boots if it is not running).
  const remote = loadRemoteConfig(pluginDataDir)
  let target
  if (remote !== null) {
    target = { kind: 'remote', serverUrl: remote.serverUrl }
  } else {
    const server = await ensureServer({ dataDir: sharedDataDir })
    target = { kind: 'local', port: server.port }
  }
  const confirmed = await askConfirm({
    input,
    errorOutput,
    question: `Take over the Chat ID "${forms.display}"? The session that currently holds it is displaced and can no longer use it — `
      + 'use this only when that session is gone. [y/N] ',
  })
  if (confirmed === null) {
    return {
      status: 'refusal',
      command: 'session replace',
      code: 'confirm_declined',
      message: 'agent-room session replace ended before an answer was given; nothing was taken over',
    }
  }
  if (confirmed !== true) {
    return {
      status: 'refusal',
      command: 'session replace',
      code: 'confirm_declined',
      message: 'agent-room session replace kept the Chat ID with its current holder; nothing was changed',
    }
  }
  const { token, fingerprint } = await authenticate(target, { pluginDataDir, sharedDataDir })
  const outcome = await takeOver(target, { token, chatId: forms.display })
  return {
    status: 'ok',
    command: 'session replace',
    lines: [line({
      ok: true,
      command: 'session replace',
      chat_id: forms.display,
      mode: target.kind,
      server_url: target.kind === 'remote' ? target.serverUrl : null,
      fingerprint,
      // True when a live holder was actually displaced; false when the name
      // was free (the takeover then had nothing to take).
      replaced: outcome.replaced,
      // True when this command's own session released the name again, so the
      // live client can bind it on its next call.
      released: outcome.released,
      note: outcome.released
        ? 'the name is free until the live client binds it again; restart the client that uses this Chat ID'
        : 'the release failed, so this command\'s session still holds the name until its lease expires',
    })],
  }
}

// The family's dispatch: one subcommand, its tokens, the injected deps.
export async function runSessionFamilyCommand(subcommand, tokens, deps) {
  try {
    if (subcommand === 'replace') {
      if (tokens.length > 1) {
        return usage('replace', 'unexpected extra argument; expected at most one Chat ID: agent-room session replace [<chat-id>]')
      }
      if (tokens.length === 1 && tokens[0].startsWith('--')) {
        return usage('replace', `unknown option "${tokens[0]}"; see "agent-room help"`)
      }
      return await runSessionReplace(deps, tokens.length === 1 ? tokens[0] : undefined)
    }
    const attempted = ['session', subcommand].filter(part => part !== undefined).join(' ')
    return usage(String(subcommand ?? ''), `"${attempted}" is not a session command; session commands are: replace`)
  } catch (error) {
    return {
      status: 'refusal',
      command: `session ${subcommand ?? ''}`.trimEnd(),
      code: error?.code ?? 'request_failed',
      message: error?.message ?? String(error),
    }
  }
}
