// Story 3.2 — `agent-room wake-reset`. Re-enable a hard-paused auto-wake pair
// (G1) or the whole scope's global budget (G2), by PEER or by --all. It is a
// recovery lever, NOT a cursor operation: notified_seq and suppressed_held_seq
// are NEVER deleted. Blast radius is deliberate:
//   --peer <selector>   resolve to ONE session id via the SAME peer resolver as
//                       `read`/`dm` (full Session Address or bare Agent ID),
//                       clear only that peer's pairs + G2, current scope unless
//                       --scope names another;
//   --all               every pair in the current scope ONLY (G2 included);
//                       another scope requires an explicit --scope <k>.
// --peer and --all are mutually exclusive and exactly one is required.
//
// Grammar: one JSON line on stdout on success (exit 0); a coded refusal line on
// stderr (exit 1) for peer resolution failures; a usage line (exit 2) for a
// missing/both selector, an unknown flag, or a bad scope key.

import {
  CLI_ERROR_PEER_AMBIGUOUS,
  CLI_ERROR_PEER_LIST_TRUNCATED,
  CLIENT_REQUEST_TIMEOUT_MS,
} from '../constants.mjs'
import { AgentRoomRuntimeError } from '../runtime.mjs'
import { ensureServer } from '../client/ensure-server.mjs'
import { loadRemoteConfig } from '../client/remote-config.mjs'
import { CONNECTION_MODE_ENV } from '../client/api-client.mjs'
import { REMOTE_TRANSPORT } from '../client/trust.mjs'
import { sessionScopeKey, assertSafeSessionScope } from '../client/session-state.mjs'
import { createScopeLedger, listScopes } from '../client/scope-ledger.mjs'
import { authenticate, protocolHeaders, roundTrip } from './session-commands.mjs'
import { resolvePeerSession } from './message-commands.mjs'

const usage = (command, message) => ({ status: 'usage', command, code: 'usage', message })
const refusal = (command, error, extra) => ({
  status: 'refusal', command, code: error?.code ?? 'request_failed',
  message: error?.message ?? String(error), ...(extra === undefined ? {} : { extra }),
})

function parseFlags(tokens) {
  const flags = {}
  const rest = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (!token.startsWith('--')) { rest.push(token); continue }
    const name = token.slice(2)
    if (!['peer', 'all', 'scope', 'json'].includes(name)) return { error: `unknown option "--${name}"` }
    if (name === 'all' || name === 'json') { flags[name] = true; continue }
    const value = tokens[index + 1]
    if (value === undefined || value.startsWith('--')) return { error: `--${name} needs a value` }
    flags[name] = value
    index += 1
  }
  return { flags, rest }
}

export async function runWakeResetCommand(tokens, { pluginDataDir, sharedDataDir, env = process.env } = {}) {
  const command = 'wake-reset'
  try {
    const parsed = parseFlags(tokens)
    if (parsed.error !== undefined) return usage(command, parsed.error)
    if (parsed.rest.length > 0) return usage(command, `unexpected argument "${parsed.rest[0]}"; wake-reset takes options only`)
    const hasPeer = typeof parsed.flags.peer === 'string'
    const hasAll = parsed.flags.all === true
    // XOR + presence: neither or both is a usage error (exit 2).
    if (hasPeer === hasAll) {
      return usage(command, 'exactly one of --peer <selector> or --all is required (not both, not neither)')
    }
    let scope = parsed.flags.scope
    if (scope !== undefined) {
      try { assertSafeSessionScope(scope) } catch {
        return usage(command, `--scope is not a safe session scope key`)
      }
    } else {
      scope = sessionScopeKey({ env, pluginDataDir })
    }

    let peerSessionId = null
    if (hasPeer) {
      // Resolve via the ONE existing peer resolver — full address or bare Agent
      // ID, retained-only, refuses truncated/ambiguous. No second authority.
      const remote = loadRemoteConfig(pluginDataDir)
      const target = remote !== null
        ? { kind: 'remote', serverUrl: remote.serverUrl }
        : { kind: 'local', port: (await ensureServer({ dataDir: sharedDataDir, ...(env[CONNECTION_MODE_ENV] === REMOTE_TRANSPORT ? { connectionMode: REMOTE_TRANSPORT } : {}) })).port }
      const { token } = await authenticate(target, { pluginDataDir, sharedDataDir, env, sessionKind: 'cli_oneshot' })
      const roundTripOrThrow = async (method, path, headers, body) => {
        const response = await roundTrip(target, method, path, headers, body, CLIENT_REQUEST_TIMEOUT_MS)
        if (response.status !== 200) {
          throw new AgentRoomRuntimeError(
            response.body?.error?.code ?? 'request_failed',
            response.body?.error?.message ?? `the agent-room server answered ${response.status}`,
          )
        }
        return response.body.result
      }
      const resolved = await resolvePeerSession({ selector: parsed.flags.peer, token, roundTripOrThrow })
      if (resolved.status !== 'ok') {
        const outcome = resolved.outcome(command)
        return { status: 'refusal', command, code: outcome.code, message: outcome.message }
      }
      peerSessionId = resolved.session.session_id
    }

    const ledger = createScopeLedger(pluginDataDir, scope)
    try {
      const result = ledger.reset({ peerSessionId })
      if (result.status === 'busy') return refusal(command, { code: 'ledger_busy', message: result.detail })
      const diagnostics = ledger.drainDiagnostics()
      return {
        status: 'ok',
        command,
        lines: [JSON.stringify({
          ok: true,
          command,
          scope,
          ...(peerSessionId === null ? { all: true } : { peer_session_id: peerSessionId }),
          reset: 'g1_pairs_and_g2',
          preserved: ['notified_seq', 'suppressed_held_seq'],
          ...(diagnostics.length > 0 ? { diagnostics } : {}),
        })],
      }
    } finally { ledger.close() }
  } catch (error) {
    return refusal(command, error)
  }
}

// Re-exported refusal codes so the dispatcher/help can name them verbatim.
export const WAKE_RESET_REFUSAL_CODES = Object.freeze([
  CLI_ERROR_PEER_AMBIGUOUS,
  CLI_ERROR_PEER_LIST_TRUNCATED,
])
