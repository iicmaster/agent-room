// The remote command bodies (Story 4.3, AC-1): `agent-room remote set
// <https-url>`, `remote show`, and `remote clear` — the human configuration
// of Remote Mode, mounted on the shared CLI host the invite family
// established (review MED-1: later commands extend the one dispatch, never
// build their own entrypoint). This family is the PLUGIN/installation side
// (it writes PLUGIN_DATA/remote-config.json), unlike the server-host invite
// family — but it speaks the same machine grammar.
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
    const attempted = ['remote', subcommand].filter(part => part !== undefined).join(' ')
    return usage(String(subcommand ?? ''), `"${attempted}" is not a remote command; remote commands are: set, show, clear`)
  } catch (error) {
    return {
      status: 'refusal',
      command: `remote ${subcommand ?? ''}`.trimEnd(),
      code: error?.code ?? 'request_failed',
      message: error?.message ?? String(error),
    }
  }
}
