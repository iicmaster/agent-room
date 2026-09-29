// The operator invite command bodies (Story 4.2, HCI-3/FR-14): the three
// `run*` functions behind `agent-room invite mint`, `invite list`, and
// `invite revoke <digest-prefix>`, plus the JSON-lines argument grammar they
// share. This family is where the operator CLI HOST is established (review
// MED-1): later operator stories (4.5 ban, 4.6 capacity) add commands to the
// same `agent-room` bin dispatch, never their own entrypoint.
//
// THE OPERATOR BOUNDARY IS THE HOST (AR-13): unlike the held/allow family —
// which talks to the server over the loopback HTTP API with an unbound
// session — these commands run on the server host and open the SQLite store
// DIRECTLY, in process. No operator HTTP route exists (the API cannot mint
// or revoke an invite), no session token is involved, and the server process
// need not even be running: authentication is the OS user at the host.
//
// THE JSON-LINES GRAMMAR (HCI-3 begins here): every success line on stdout
// is one self-contained JSON object (`ok`, `command`, and the payload);
// every refusal or usage error is ONE JSON object on stderr. Exit codes are
// stable and machine-readable: 0 ok, 1 refusal (coded — unknown invite,
// exhausted invite, ambiguous prefix, store failure), 2 usage (grammar:
// unknown flag, missing value, bad arity, a non-finite --uses/--ttl). The
// mint receipt carries the raw token EXACTLY ONCE — the store persists only
// the SHA-256 digest, listings project the digest PREFIX (never a
// secret-shaped value), and no error path ever embeds a presented token.

import {
  INVITE_DIGEST_PREFIX_CHARS,
  INVITE_MAX_USES,
  INVITE_TTL_SECONDS,
} from '../constants.mjs'
import { openRoomLog } from '../store/room-log.mjs'

// The secret-free projection every listing and revoke line prints: the
// digest prefix (never the full digest, never the token), uses remaining,
// expiry, and the revoked flag. The full digest is a one-way derivative and
// still never printed — the prefix is all an operator ever needs to
// identify and revoke.
function inviteProjection(row) {
  return {
    digest_prefix: row.digest.slice(0, INVITE_DIGEST_PREFIX_CHARS),
    uses_remaining: row.uses_remaining,
    expires_at: row.expires_at,
    revoked: row.revoked_at !== null,
  }
}

const line = object => JSON.stringify(object)

// --- The argv grammar ---------------------------------------------------------
//
// Value flags take the NEXT token; a flag never consumes another flag as its
// value (a following --token is a coded usage refusal, never a silent
// mis-parse). Values are strict digits (uses: whole; ttl: whole or decimal
// hours) so Infinity, NaN, "none", "inf", 0, and negatives are all just
// non-values — the unlimited and never-expiring modes have no spelling here
// and are rejected outright (FR-14's finite-only rule).

function usage(command, message) {
  return { status: 'usage', command: `invite ${command}`, code: 'usage', message }
}

function parsePositiveIntegerFlag(command, name, rawValue) {
  if (!/^[0-9]+$/.test(rawValue)) {
    return usage(
      command,
      `${name} must be a finite whole number of 1 or more (got "${rawValue}"); unlimited modes are rejected outright`,
    )
  }
  const value = Number(rawValue)
  if (!Number.isSafeInteger(value) || value < 1) {
    return usage(
      command,
      `${name} must be a finite whole number of 1 or more (got "${rawValue}"); unlimited modes are rejected outright`,
    )
  }
  return { value }
}

function parsePositiveNumberFlag(command, name, rawValue) {
  if (!/^[0-9]+(\.[0-9]+)?$/.test(rawValue)) {
    return usage(
      command,
      `${name} must be a finite positive number of hours (got "${rawValue}"); never-expiring modes are rejected outright`,
    )
  }
  const value = Number(rawValue)
  if (!Number.isFinite(value) || value <= 0) {
    return usage(
      command,
      `${name} must be a finite positive number of hours (got "${rawValue}"); never-expiring modes are rejected outright`,
    )
  }
  return { value }
}

// Returns { ok: true, options } or the usage outcome.
function parseInviteArgs(command, tokens, { valueFlags = [] } = {}) {
  const options = {}
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (valueFlags.includes(token)) {
      const value = tokens[index + 1]
      if (value === undefined || value.startsWith('--')) {
        return usage(command, `${token} needs a value; see "agent-room help"`)
      }
      const parsed = token === '--uses'
        ? parsePositiveIntegerFlag(command, '--uses', value)
        : parsePositiveNumberFlag(command, '--ttl', value)
      if (parsed.status === 'usage') return parsed
      options[token] = parsed.value
      index += 1
      continue
    }
    if (token.startsWith('--')) {
      return usage(command, `unknown option "${token}"; see "agent-room help"`)
    }
    return usage(command, `unexpected argument "${token}"; see "agent-room help"`)
  }
  return { ok: true, options }
}

// --- The store seam --------------------------------------------------------------
//
// The host boundary: the store opens directly over the shared data dir and
// closes before the command answers. Every call is its own open — the
// operator runs one command per decision, and the store's convergence makes
// each open idempotent.

function withStore(sharedDataDir, operation) {
  const store = openRoomLog({ dataDir: sharedDataDir })
  try {
    return operation(store)
  } finally {
    store.close()
  }
}

export function runInviteMint({ sharedDataDir }, options = {}) {
  const uses = options['--uses'] ?? INVITE_MAX_USES
  const ttlHours = options['--ttl'] ?? INVITE_TTL_SECONDS / (60 * 60)
  const minted = withStore(sharedDataDir, store => store.mintInvite({
    uses,
    ttlSeconds: ttlHours * 60 * 60,
  }))
  return {
    status: 'ok',
    command: 'invite mint',
    lines: [line({
      ok: true,
      command: 'invite mint',
      invite: {
        digest_prefix: minted.digest.slice(0, INVITE_DIGEST_PREFIX_CHARS),
        uses_remaining: minted.uses_remaining,
        uses_max: minted.uses_max,
        expires_at: minted.expires_at,
        created_at: minted.created_at,
      },
      // Shown exactly once, in this one line. Nothing else — listing,
      // revoke, errors, diagnostics — ever carries it again.
      token: minted.token,
    })],
  }
}

export function runInviteList({ sharedDataDir }) {
  const rows = withStore(sharedDataDir, store => store.listInvites())
  return {
    status: 'ok',
    command: 'invite list',
    lines: rows.map(row => line({
      ok: true,
      command: 'invite list',
      invite: inviteProjection(row),
    })),
  }
}

export function runInviteRevoke({ sharedDataDir }, rawPrefix) {
  if (typeof rawPrefix !== 'string' || rawPrefix.length === 0) {
    return usage('revoke', 'expected exactly one digest prefix: agent-room invite revoke <digest-prefix>')
  }
  const revoked = withStore(sharedDataDir, store => store.revokeInvite({ digestPrefix: rawPrefix }))
  return {
    status: 'ok',
    command: 'invite revoke',
    lines: [line({
      ok: true,
      command: 'invite revoke',
      invite: inviteProjection(revoked),
    })],
  }
}

// The family's dispatch: one subcommand, its tokens, the injected deps.
// Refusals (coded domain outcomes and store failures) and usage outcomes are
// returned, never printed here — the entrypoint's single JSON-error printer
// owns the stderr line and the exit code.
export async function runInviteFamilyCommand(subcommand, tokens, deps) {
  try {
    if (subcommand === 'mint') {
      const parsed = parseInviteArgs('mint', tokens, { valueFlags: ['--uses', '--ttl'] })
      if (parsed.ok !== true) return parsed
      return runInviteMint(deps, parsed.options)
    }
    if (subcommand === 'list') {
      const parsed = parseInviteArgs('list', tokens)
      if (parsed.ok !== true) return parsed
      return runInviteList(deps)
    }
    if (subcommand === 'revoke') {
      if (tokens.length === 0) {
        return usage('revoke', 'expected exactly one digest prefix: agent-room invite revoke <digest-prefix>')
      }
      if (tokens.length > 1) {
        return usage('revoke', `unexpected argument "${tokens[1]}"; expected exactly one digest prefix: agent-room invite revoke <digest-prefix>`)
      }
      const token = tokens[0]
      if (token.startsWith('--')) {
        return usage('revoke', `unknown option "${token}"; see "agent-room help"`)
      }
      return runInviteRevoke(deps, token)
    }
    const attempted = ['invite', subcommand].filter(part => part !== undefined).join(' ')
    return usage(String(subcommand ?? ''), `"${attempted}" is not an invite command; invite commands are: mint, list, revoke`)
  } catch (error) {
    return {
      status: 'refusal',
      command: `invite ${subcommand ?? ''}`.trimEnd(),
      code: error?.code ?? 'request_failed',
      message: error?.message ?? String(error),
    }
  }
}
