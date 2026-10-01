// The remote command bodies (Story 4.3, AC-1): `agent-room remote set
// <https-url>`, `remote show`, and `remote clear` — the human configuration
// of Remote Mode, mounted on the shared CLI host the invite family
// established (review MED-1: later commands extend the one dispatch, never
// build their own entrypoint). This family is the PLUGIN/installation side
// (it writes PLUGIN_DATA/remote-config.json), unlike the server-host invite
// family — but it speaks the same machine grammar.
//
// Story 4.7 adds `remote enroll <invite-token>`: the one shipped step that
// enrolls THIS installation's key with the configured server through the
// frozen Story 4.2 route (POST /api/auth/enroll — token, raw public key, and
// the Ed25519 signature over the EXACT token bytes, the route's possession
// proof). The command requires a configured origin (a coded refusal names
// `remote set` otherwise), signs with the installation keypair (the
// runtime.mjs/keys.mjs machinery — the private PEM is read inside the keys
// module and only the 64-byte signature leaves), POSTs ONCE over
// default-verification HTTPS (Node's own TLS stack — no option, no CA
// override, no bypass anywhere), and prints ONE JSON receipt that never
// echoes the token (its digest prefix at most, the same derivation the
// store's registry uses, so the receipt correlates with `invite list`).
// Enrollment consumes nothing on a refusal (the route's own durability
// rule) and unlocks the already-live challenge lane — after it the client
// connects with zero further enroll requests.
//
// THE JSON-LINES GRAMMAR (HCI-3, shared with the invite family): every
// success line on stdout is one self-contained JSON object; every refusal or
// usage error is ONE JSON object on stderr. Exit codes are stable: 0 ok,
// 1 refusal (coded — most importantly the TRANSPORT POLICY refusal: a
// plaintext http:// URL names the refused scheme and is never stored),
// 2 usage (grammar: missing or extra arguments, unknown flags).
//
// Validation and persistence live in server/client/remote-config.mjs — this
// module only parses argv and projects the result. One server is active at
// a time: `remote set` replaces the previous origin and reports it; the
// per-realm state of a replaced server stays on disk under its realm id,
// inert (a different server is a different realm and starts with fresh
// trust, AD-14/D13).

import { createHash } from 'node:crypto'
import https from 'node:https'

import {
  CLIENT_REQUEST_TIMEOUT_MS,
  INVITE_DIGEST_PREFIX_CHARS,
  INVITE_TOKEN_BYTES,
  INVITE_TOKEN_PATTERN,
  INVITE_TOKEN_PREFIX,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
} from '../constants.mjs'
import { AgentRoomRuntimeError } from '../runtime.mjs'
import { loadOrCreateKeypair, signWithInstallationKey } from '../keys.mjs'
import {
  clearRemoteConfig,
  loadRemoteConfig,
  saveRemoteConfig,
} from '../client/remote-config.mjs'

const line = object => JSON.stringify(object)

function usage(command, message) {
  return { status: 'usage', command: `remote ${command}`, code: 'usage', message }
}

export function runRemoteSet({ pluginDataDir }, rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0) {
    return usage('set', 'expected exactly one https URL: agent-room remote set <https-url>')
  }
  const previous = loadRemoteConfig(pluginDataDir)
  const saved = saveRemoteConfig(pluginDataDir, { serverUrl: rawUrl })
  return {
    status: 'ok',
    command: 'remote set',
    lines: [line({
      ok: true,
      command: 'remote set',
      mode: 'remote',
      server_url: saved.serverUrl,
      set_at: saved.setAt,
      path: saved.path,
      previous_server_url: previous === null ? null : previous.serverUrl,
    })],
  }
}

export function runRemoteShow({ pluginDataDir }) {
  const config = loadRemoteConfig(pluginDataDir)
  return {
    status: 'ok',
    command: 'remote show',
    lines: [line({
      ok: true,
      command: 'remote show',
      mode: config === null ? 'local' : 'remote',
      server_url: config === null ? null : config.serverUrl,
      ...(config === null ? {} : { set_at: config.setAt ?? null }),
    })],
  }
}

export function runRemoteClear({ pluginDataDir }) {
  const removed = clearRemoteConfig(pluginDataDir)
  return {
    status: 'ok',
    command: 'remote clear',
    lines: [line({
      ok: true,
      command: 'remote clear',
      mode: 'local',
      removed,
    })],
  }
}

// The receipt's only token derivative: the SHA-256 digest PREFIX of the
// presented token — the same derivation the store's invites registry uses
// (decode the canonical base64url payload, hash the exact bytes) — so the
// receipt correlates with `invite list` without ever echoing a secret. The
// full token appears NOWHERE on any enroll surface (the receipt, an error,
// a diagnostic): a refused or lost enrollment is retried by re-running the
// command with the token the operator still holds.
function tokenDigestPrefix(inviteToken) {
  const bytes = Buffer.from(inviteToken.slice(INVITE_TOKEN_PREFIX.length), 'base64url')
  if (bytes.length !== INVITE_TOKEN_BYTES) {
    throw new AgentRoomRuntimeError('invalid_request', 'the invite token payload does not decode to the declared byte count')
  }
  return createHash('sha256').update(bytes).digest('hex').slice(0, INVITE_DIGEST_PREFIX_CHARS)
}

// One HTTPS POST to the configured origin over Node's DEFAULT verification —
// the api-client's transport discipline (normal certificate and hostname
// checks; no option, no CA override, no bypass exists in this tree), unpooled
// and timeout-bounded exactly like the CLI's loopback helper. A coded answer
// (the frozen route's refusal vocabulary) surfaces as the coded error the
// family's dispatch prints; a transport failure is a coded request_failed.
function enrollHttpPost(origin, path, body) {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = https.request(
      new URL(path, origin),
      {
        method: 'POST',
        agent: false,
        headers: {
          [PROTOCOL_HEADER]: PROTOCOL_VERSION,
          'content-type': 'application/json; charset=utf-8',
        },
      },
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
    request.setTimeout(CLIENT_REQUEST_TIMEOUT_MS, () => {
      request.destroy(new AgentRoomRuntimeError('request_failed', 'the enrollment request timed out'))
    })
    request.on('error', error => {
      rejectPromise(new AgentRoomRuntimeError('request_failed', `the enrollment request failed: ${error?.message ?? error}`))
    })
    request.end(JSON.stringify(body))
  })
}

// Story 4.7: `agent-room remote enroll <invite-token>` — the operator's
// invite flow, installation side. Requires the configured origin (a coded
// refusal names `remote set` first — enrollment is meaningless without a
// server to enroll WITH, and nothing is sent), signs the EXACT invite-token
// bytes with this installation's keypair (the frozen route's possession
// proof: the presented key must have signed the presented token), POSTs once
// to the frozen route, and prints one JSON receipt carrying the server's
// origin, the DERIVED fingerprint (refused coded when the server returns a
// different one — that would mean the wire answered for another key), and
// the token's digest prefix — never the token.
export async function runRemoteEnroll({ pluginDataDir }, rawToken) {
  if (typeof rawToken !== 'string' || !INVITE_TOKEN_PATTERN.test(rawToken)) {
    return usage(
      'enroll',
      'expected exactly one invite token: agent-room remote enroll <invite-token> — the ar_inv1_ token exactly as "agent-room invite mint" printed it',
    )
  }
  const config = loadRemoteConfig(pluginDataDir)
  if (config === null) {
    return {
      status: 'refusal',
      command: 'remote enroll',
      code: 'invalid_request',
      message: 'no remote server is configured for this installation; run "agent-room remote set <https-url>" first, then enroll again',
    }
  }
  const keypair = loadOrCreateKeypair(pluginDataDir)
  const digestPrefix = tokenDigestPrefix(rawToken)
  const response = await enrollHttpPost(config.serverUrl, '/api/auth/enroll', {
    invite_token: rawToken,
    public_key: keypair.publicKey.toString('base64url'),
    // The possession proof signs the EXACT token bytes — the same bytes the
    // store's enrollment transaction verifies inside its one transaction.
    signature: signWithInstallationKey(pluginDataDir, Buffer.from(rawToken, 'utf8')).toString('base64url'),
  })
  if (response.status !== 200 || response.body?.ok !== true) {
    const code = response.body?.error?.code
    if (typeof code === 'string' && code.length > 0) {
      throw new AgentRoomRuntimeError(code, response.body?.error?.message ?? 'the enrollment was refused')
    }
    throw new AgentRoomRuntimeError('request_failed', `the enrollment request answered ${response.status}`)
  }
  const fingerprint = response.body?.result?.fingerprint
  if (fingerprint !== keypair.fingerprint) {
    throw new AgentRoomRuntimeError(
      'request_failed',
      `the server enrolled fingerprint ${String(fingerprint)} instead of this installation's key (${keypair.fingerprint}); nothing about this installation is enrolled correctly — investigate before connecting`,
    )
  }
  return {
    status: 'ok',
    command: 'remote enroll',
    lines: [line({
      ok: true,
      command: 'remote enroll',
      mode: 'remote',
      server_url: config.serverUrl,
      fingerprint,
      token_digest_prefix: digestPrefix,
      enrolled: true,
    })],
  }
}

// The family's dispatch: one subcommand, its tokens, the injected deps.
// Refusals (coded domain outcomes — the https policy refusal among them)
// and usage outcomes are returned, never printed here — the entrypoint's
// single JSON-error printer owns the stderr line and the exit code.
export async function runRemoteFamilyCommand(subcommand, tokens, deps) {
  try {
    if (subcommand === 'set') {
      if (tokens.length === 0) {
        return usage('set', 'expected exactly one https URL: agent-room remote set <https-url>')
      }
      if (tokens.length > 1) {
        return usage('set', `unexpected argument "${tokens[1]}"; expected exactly one https URL: agent-room remote set <https-url>`)
      }
      if (tokens[0].startsWith('--')) {
        return usage('set', `unknown option "${tokens[0]}"; see "agent-room help"`)
      }
      return runRemoteSet(deps, tokens[0])
    }
    if (subcommand === 'show') {
      if (tokens.length > 0) {
        return usage('show', `unexpected argument "${tokens[0]}"; see "agent-room help"`)
      }
      return runRemoteShow(deps)
    }
    if (subcommand === 'clear') {
      if (tokens.length > 0) {
        return usage('clear', `unexpected argument "${tokens[0]}"; see "agent-room help"`)
      }
      return runRemoteClear(deps)
    }
    if (subcommand === 'enroll') {
      // The invite token is a SECRET: usage messages never echo a positional
      // value (it may be the token) — the grammar error names the shape, the
      // operator re-reads the mint receipt.
      if (tokens.length === 0) {
        return usage('enroll', 'expected exactly one invite token: agent-room remote enroll <invite-token>')
      }
      if (tokens[0].startsWith('--')) {
        return usage('enroll', `unknown option "${tokens[0]}"; see "agent-room help"`)
      }
      if (tokens.length > 1) {
        return usage('enroll', 'unexpected extra argument; expected exactly one invite token: agent-room remote enroll <invite-token>')
      }
      // `return await`, deliberately: runRemoteEnroll is async, and its coded
      // refusals (the frozen route's rejection vocabulary, the transport
      // failure among them) must surface through THIS catch as the family's
      // one refusal outcome. A bare `return` of a promise from inside a try
      // hands the rejection to the CALLER's await instead — the rejection
      // settles after this try has exited — and the entrypoint would die on
      // it rather than print the family's one JSON stderr line.
      return await runRemoteEnroll(deps, tokens[0])
    }
    const attempted = ['remote', subcommand].filter(part => part !== undefined).join(' ')
    return usage(String(subcommand ?? ''), `"${attempted}" is not a remote command; remote commands are: set, show, clear, enroll`)
  } catch (error) {
    return {
      status: 'refusal',
      command: `remote ${subcommand ?? ''}`.trimEnd(),
      code: error?.code ?? 'request_failed',
      message: error?.message ?? String(error),
    }
  }
}
