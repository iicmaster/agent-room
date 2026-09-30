// The operator ban command bodies (Story 4.5, HCI-3/AR-13): the two `run*`
// functions behind `agent-room ban <fingerprint>` and
// `agent-room unban <fingerprint>`. This family extends the operator CLI
// HOST Story 4.2 established (review MED-1): the same `agent-room` bin, the
// same dispatch, the same JSON-lines grammar — never its own entrypoint.
//
// THE OPERATOR BOUNDARY IS THE HOST (AR-13), exactly as for the invite
// family: these commands run on the server host and open the SQLite store
// DIRECTLY, in process. No operator HTTP route exists (the API cannot ban),
// no session token is involved, and the server process need not even be
// running — authentication is the OS user at the host. The ban is visible
// to a running server AT NEXT REQUEST because the server's authz stage
// reads the same store per request (no cached ban state anywhere).
//
// THE JSON-LINES GRAMMAR (HCI-3): success prints one JSON object on stdout
// and exits 0; a refusal or usage error prints ONE JSON object on stderr
// and exits 1 or 2. The grammar is strict: exactly one positional
// fingerprint (`sha256:` + 64 lowercase hex, the canonical shape from the
// constants module — never a chat id, never a decorated spelling), an
// optional --reason value on ban (never consumed from another flag), and
// nothing else. Banning a fingerprint nobody has seen is first-class
// (preemptive ban); re-banning an already-banned key is an idempotent
// success keeping the first ban's timestamp; unbanning a key that holds no
// ban is already the requested state.

import { FINGERPRINT_PATTERN } from '../constants.mjs'
import { openRoomLog } from '../store/room-log.mjs'

const line = object => JSON.stringify(object)

function usage(command, message) {
  return { status: 'usage', command, code: 'usage', message }
}

// The store seam: the host boundary. The store opens directly over the
// shared data dir and closes before the command answers — every call is its
// own open, and the store's convergence makes each open idempotent.
function withStore(sharedDataDir, operation) {
  const store = openRoomLog({ dataDir: sharedDataDir })
  try {
    return operation(store)
  } finally {
    store.close()
  }
}

export function runBan({ sharedDataDir }, fingerprint, options = {}) {
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
    return usage('ban', 'expected exactly one fingerprint: agent-room ban <fingerprint> [--reason <text>]')
  }
  if (!FINGERPRINT_PATTERN.test(fingerprint)) {
    return usage(
      'ban',
      `"${fingerprint}" is not a fingerprint: agent-room ban <fingerprint> [--reason <text>] — the key's fingerprint is "sha256:" followed by 64 lowercase hex characters, as the key holder's diagnostics show it`,
    )
  }
  const reason = options['--reason']
  const banned = withStore(sharedDataDir, store => store.banActor({
    actorFingerprint: fingerprint,
    ...(reason === undefined ? {} : { reason }),
  }))
  return {
    status: 'ok',
    command: 'ban',
    lines: [line({
      ok: true,
      command: 'ban',
      ban: {
        fingerprint: banned.actor_fingerprint,
        banned: true,
        banned_at: banned.banned_at,
        reason: banned.reason,
      },
    })],
  }
}

export function runUnban({ sharedDataDir }, fingerprint) {
  if (typeof fingerprint !== 'string' || fingerprint.length === 0) {
    return usage('unban', 'expected exactly one fingerprint: agent-room unban <fingerprint>')
  }
  if (!FINGERPRINT_PATTERN.test(fingerprint)) {
    return usage(
      'unban',
      `"${fingerprint}" is not a fingerprint: agent-room unban <fingerprint> — the key's fingerprint is "sha256:" followed by 64 lowercase hex characters`,
    )
  }
  withStore(sharedDataDir, store => store.unbanActor({ actorFingerprint: fingerprint }))
  return {
    status: 'ok',
    command: 'unban',
    lines: [line({
      ok: true,
      command: 'unban',
      ban: {
        fingerprint,
        banned: false,
      },
    })],
  }
}

// The family's dispatch: the command name (ban or unban), the argv after it,
// the injected deps. Refusals (coded domain outcomes and store failures) and
// usage outcomes are returned, never printed here — the entrypoint's single
// JSON-error printer owns the stderr line and the exit code.
export async function runBanFamilyCommand(command, tokens, deps) {
  try {
    if (command === 'ban') {
      const positional = []
      const options = {}
      for (let index = 0; index < tokens.length; index += 1) {
        const token = tokens[index]
        if (token === '--reason') {
          const value = tokens[index + 1]
          if (value === undefined || value.startsWith('--')) {
            return usage('ban', '--reason needs a value; see "agent-room help"')
          }
          options['--reason'] = value
          index += 1
          continue
        }
        if (token.startsWith('--')) {
          return usage('ban', `unknown option "${token}"; see "agent-room help"`)
        }
        positional.push(token)
      }
      if (positional.length === 0) {
        return usage('ban', 'expected exactly one fingerprint: agent-room ban <fingerprint> [--reason <text>]')
      }
      if (positional.length > 1) {
        return usage('ban', `unexpected argument "${positional[1]}"; expected exactly one fingerprint: agent-room ban <fingerprint> [--reason <text>]`)
      }
      return runBan(deps, positional[0], options)
    }
    if (command === 'unban') {
      if (tokens.length === 0) {
        return usage('unban', 'expected exactly one fingerprint: agent-room unban <fingerprint>')
      }
      if (tokens.length > 1) {
        return usage('unban', `unexpected argument "${tokens[1]}"; expected exactly one fingerprint: agent-room unban <fingerprint>`)
      }
      const token = tokens[0]
      if (token.startsWith('--')) {
        return usage('unban', `unknown option "${token}"; see "agent-room help"`)
      }
      return runUnban(deps, token)
    }
    return usage(String(command ?? ''), `"${command}" is not a ban command; ban commands are: ban, unban`)
  } catch (error) {
    return {
      status: 'refusal',
      command,
      code: error?.code ?? 'request_failed',
      message: error?.message ?? String(error),
    }
  }
}
