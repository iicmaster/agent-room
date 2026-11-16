// Host-local operator CLI for session principals (AD-13, Story 1.3):
//   agent-room session-principals revoke <session_address|session_id> [--reason <text<=200>] [--json]
//
// Opens the existing SQLite store directly on the server host via
// openRoomLog({ dataDir: sharedDataDir, role: 'cli', requireExisting: true }):
// - never creates an empty DB when none exists;
// - skips server startup DDL, convergence, repair, and chmod;
// - keeps busy_timeout = 5000, foreign_keys = ON, synchronous = FULL, and
//   retries SQLITE_BUSY 1 + 3 x 250ms outside the transaction;
// - revokes in a single short transaction while keeping capability_digest
//   intact so future requests answer canonical 401 session_revoked.

import { CLI_ERROR_SESSION_NOT_FOUND, SESSION_REVOKE_REASON_MAX } from '../constants.mjs'
import { openRoomLog } from '../store/room-log.mjs'

const line = object => JSON.stringify(object)

function usage(command, message) {
  return { status: 'usage', command, code: 'usage', message }
}

// Every CLI family answers a failure with 'refusal' (11 modules, 21 sites);
// this module was the lone 'error' until the Epic 1 retrospective, F-5.
function failure(command, code, message) {
  return { status: 'refusal', command, code, message }
}

export function runSessionPrincipalsRevoke({ sharedDataDir }, target, options = {}) {
  if (typeof target !== 'string' || target.length === 0) {
    return usage(
      'session-principals revoke',
      'expected <session_address|session_id>: agent-room session-principals revoke <session_address|session_id> [--reason <text<=200>] [--json]',
    )
  }
  const reason = options['--reason']
  if (reason !== undefined && (typeof reason !== 'string' || reason.length > SESSION_REVOKE_REASON_MAX)) {
    return usage(
      'session-principals revoke',
      `--reason must be at most ${SESSION_REVOKE_REASON_MAX} characters`,
    )
  }
  let store
  try {
    store = openRoomLog({ dataDir: sharedDataDir, role: 'cli', requireExisting: true })
  } catch (error) {
    return failure('session-principals revoke', error?.code ?? 'data_directory_invalid', error?.message ?? String(error))
  }
  try {
    const revoked = store.revokeSessionPrincipalByHost({
      target,
      ...(reason === undefined ? {} : { reason }),
    })
    if (revoked === null) {
      return failure(
        'session-principals revoke',
        CLI_ERROR_SESSION_NOT_FOUND,
        `no retained session principal matches ${target}`,
      )
    }
    return {
      status: 'ok',
      command: 'session-principals revoke',
      lines: [line({
        ok: true,
        command: 'session-principals revoke',
        session_id: revoked.session_id,
        address: revoked.address,
        principal_status: revoked.principal_status,
        base_lease_status: revoked.base_lease_status,
        revoked_reason: revoked.revoked_reason ?? null,
      })],
    }
  } finally {
    store.close()
  }
}

export async function runSessionPrincipalsFamilyCommand(subcommand, tokens, deps) {
  try {
    if (subcommand !== 'revoke') {
      return usage(
        'session-principals',
        'unknown subcommand; expected: agent-room session-principals revoke <session_address|session_id> [--reason <text<=200>] [--json]',
      )
    }
    const positional = []
    const options = {}
    for (let index = 0; index < tokens.length; index += 1) {
      const token = tokens[index]
      if (token === '--json') {
        options['--json'] = true
        continue
      }
      if (token === '--reason') {
        const value = tokens[index + 1]
        if (value === undefined || value.startsWith('--')) {
          return usage('session-principals revoke', '--reason needs a value')
        }
        options['--reason'] = value
        index += 1
        continue
      }
      if (token.startsWith('--reason=')) {
        options['--reason'] = token.slice('--reason='.length)
        continue
      }
      if (token.startsWith('--')) {
        return usage('session-principals revoke', `unknown option "${token}"`)
      }
      positional.push(token)
    }
    if (positional.length !== 1) {
      return usage(
        'session-principals revoke',
        'expected exactly one <session_address|session_id> argument',
      )
    }
    return runSessionPrincipalsRevoke(deps, positional[0], options)
  } catch (error) {
    return failure('session-principals revoke', error?.code ?? 'request_failed', error?.message ?? String(error))
  }
}
