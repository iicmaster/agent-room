// Server configuration readers, extracted from server.mjs by the Epic 1
// retrospective (action item 6 / findings F-1, F-2): the operator-facing
// environment parsers and the TLS material reader are pure functions of
// (env | paths), own no server state, and were 199 lines of the 3,269-line
// handler module. server.mjs re-exports every name below, so the CLI, the
// direct-launch path and the tests all keep importing them from where they
// always did.
//
// Discipline these share (kept verbatim from their original home): a
// present-but-INVALID value never blocks a boot — one stderr-bound warning
// line and the declared default — because a typo in an operator's env must
// not look like a corrupt installation.

import { X509Certificate, createPrivateKey, createPublicKey } from 'node:crypto'
import { readFileSync } from 'node:fs'

import { isAbsolute } from 'node:path'

import {
  CLAIMS_TTL_MS,
  DUPLICATE_WINDOW_MS,
  PRESENCE_TTL_MS,
} from '../constants.mjs'
import { AgentRoomRuntimeError, regularPrivateFile } from '../runtime.mjs'

// Direct-launch operator surface for the durable claim TTL: the same knob as
// startServer({claimsTtlMs}), read from the environment so a real operator
// can tune the 7-day window without code. Strictly validated — a positive
// finite integer in digits — and a present-but-invalid value never blocks a
// boot: one stderr warning line and the declared default.
export function claimsTtlMsFromEnv(env = process.env) {
  const raw = env?.AGENT_ROOM_CLAIMS_TTL_MS
  if (raw === undefined || String(raw).trim() === '') {
    return { claimsTtlMs: CLAIMS_TTL_MS }
  }
  const trimmed = String(raw).trim()
  if (!/^[0-9]+$/.test(trimmed)) {
    return {
      claimsTtlMs: CLAIMS_TTL_MS,
      warning: `ignoring invalid AGENT_ROOM_CLAIMS_TTL_MS "${raw}": must be a positive integer number of milliseconds; using the default ${CLAIMS_TTL_MS} ms`,
    }
  }
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value) || value <= 0) {
    return {
      claimsTtlMs: CLAIMS_TTL_MS,
      warning: `ignoring invalid AGENT_ROOM_CLAIMS_TTL_MS "${raw}": must be a positive integer number of milliseconds; using the default ${CLAIMS_TTL_MS} ms`,
    }
  }
  return { claimsTtlMs: value }
}

// Story 1.6 review: the same operator surface for the presence TTL —
// startServer({presenceTtlMs}) via AGENT_ROOM_PRESENCE_TTL_MS, identical
// strict validation and warning-fallback shape. (The 60 s client heartbeat
// cadence is the Story 1.7 adapter's surface — deliberately not tunable here.)
export function presenceTtlMsFromEnv(env = process.env) {
  const raw = env?.AGENT_ROOM_PRESENCE_TTL_MS
  if (raw === undefined || String(raw).trim() === '') {
    return { presenceTtlMs: PRESENCE_TTL_MS }
  }
  const trimmed = String(raw).trim()
  if (!/^[0-9]+$/.test(trimmed)) {
    return {
      presenceTtlMs: PRESENCE_TTL_MS,
      warning: `ignoring invalid AGENT_ROOM_PRESENCE_TTL_MS "${raw}": must be a positive integer number of milliseconds; using the default ${PRESENCE_TTL_MS} ms`,
    }
  }
  const value = Number(trimmed)
  if (!Number.isSafeInteger(value) || value <= 0) {
    return {
      presenceTtlMs: PRESENCE_TTL_MS,
      warning: `ignoring invalid AGENT_ROOM_PRESENCE_TTL_MS "${raw}": must be a positive integer number of milliseconds; using the default ${PRESENCE_TTL_MS} ms`,
    }
  }
  return { presenceTtlMs: value }
}

// Operator-configurable direct-launch env knobs (trustedProxy and
// duplicateWindowMs; invalid values warn and fall back to declared defaults
// without blocking boot).
export function trustedProxyFromEnv(env = process.env) {
  const raw = env?.AGENT_ROOM_TRUSTED_PROXY
  if (raw === undefined || String(raw).trim() === '') {
    return { trustedProxy: false }
  }
  const normalized = String(raw).trim().toLowerCase()
  if (normalized === '1' || normalized === 'true') {
    return { trustedProxy: true }
  }
  if (normalized === '0' || normalized === 'false') {
    return { trustedProxy: false }
  }
  return {
    trustedProxy: false,
    warning: `ignoring invalid AGENT_ROOM_TRUSTED_PROXY "${raw}": must be "true"/"1" or "false"/"0"; using the default false`,
  }
}

// Story 1.1: post-auth token buckets were retired; duplicateWindowMs remains
// the operator-tunable server floor on the direct-launch env surface.
export function gateLimitsFromEnv(env = process.env) {
  const warnings = []
  const readInteger = (key, fallback) => {
    const raw = env?.[key]
    if (raw === undefined || String(raw).trim() === '') return fallback
    const trimmed = String(raw).trim()
    if (!/^[0-9]+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed)) || Number(trimmed) < 1) {
      warnings.push(`ignoring invalid ${key} "${raw}": must be a positive integer; using the default ${fallback}`)
      return fallback
    }
    return Number(trimmed)
  }
  return {
    gateLimits: {
      duplicateWindowMs: readInteger('AGENT_ROOM_DUPLICATE_WINDOW_MS', DUPLICATE_WINDOW_MS),
    },
    warnings,
  }
}

// Story 4.7: the direct launch's TOPOLOGY surface — deliberately STRICT
// where every earlier *FromEnv knob warns-and-falls-back. The tuning knobs
// (TTLs, floors, reserves) tune LIMITS: a junk value falling back to its
// default still leaves the server behaving, just with defaults. HOST, PORT,
// and the TLS material are TOPOLOGY: a junk AGENT_ROOM_PORT falling back to
// ephemeral would change WHERE the server is reachable — exactly the failure
// the start boundary (health answers + bound ports vs non-zero exit with a
// diagnosable error) defines as not recoverable. So a junk value produces a
// coded problem line and exit 1, never a fallback, and the ABSENT env is
// byte-identical to today's loopback/ephemeral launch. The TLS knobs carry
// PATHS, never content (secrets stay out of environments and process
// listings), must be absolute, and must arrive together — one knob without
// its sibling is a problem, not a half-configured listener.
export function topologyFromEnv(env = process.env) {
  const problems = []
  let host = '127.0.0.1'
  let port = 0
  let tlsCertPath
  let tlsKeyPath

  const rawHost = env?.AGENT_ROOM_HOST
  if (rawHost !== undefined && String(rawHost).trim() !== '') {
    const candidate = String(rawHost).trim()
    if (/[\s/@#?]/.test(candidate)) {
      problems.push(`AGENT_ROOM_HOST "${rawHost}" is not a bindable host: name an interface address or a hostname (for example 127.0.0.1, 0.0.0.0, or room.example.com)`)
    } else {
      host = candidate
    }
  }
  const rawPort = env?.AGENT_ROOM_PORT
  if (rawPort !== undefined && String(rawPort).trim() !== '') {
    const trimmed = String(rawPort).trim()
    if (!/^[0-9]+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed)) || Number(trimmed) > 65535) {
      problems.push(`AGENT_ROOM_PORT "${rawPort}" must be an integer from 0-65535 (0 asks for an ephemeral port); there is no fallback — a wrong port silently moves where the server is reachable`)
    } else {
      port = Number(trimmed)
    }
  }
  const rawCert = env?.AGENT_ROOM_TLS_CERT
  const rawKey = env?.AGENT_ROOM_TLS_KEY
  const certPresent = rawCert !== undefined && String(rawCert).trim() !== ''
  const keyPresent = rawKey !== undefined && String(rawKey).trim() !== ''
  if (certPresent !== keyPresent) {
    problems.push(`AGENT_ROOM_TLS_CERT and AGENT_ROOM_TLS_KEY must be given together (both or neither); ${certPresent ? 'AGENT_ROOM_TLS_KEY is missing' : 'AGENT_ROOM_TLS_CERT is missing'}`)
  }
  if (certPresent && keyPresent) {
    for (const [name, raw] of [['AGENT_ROOM_TLS_CERT', rawCert], ['AGENT_ROOM_TLS_KEY', rawKey]]) {
      const candidate = String(raw).trim()
      if (!isAbsolute(candidate)) {
        problems.push(`${name} must be an absolute path to the PEM file`)
      } else if (name === 'AGENT_ROOM_TLS_CERT') {
        tlsCertPath = candidate
      } else {
        tlsKeyPath = candidate
      }
    }
  }
  return Object.freeze({
    host,
    port,
    tlsCertPath,
    tlsKeyPath,
    problems: Object.freeze(problems),
  })
}

// Story 4.7: the operator's TLS material read by PATH (the direct launch's
// env carries paths; the content strings startServer consumes are read here,
// through the bounded regular-file reader every private state file uses —
// never a symlink, never unbounded). Every failure maps to one coded
// invalid_argument naming the env knob, so the direct launch dies before any
// listener exists with exactly one diagnosable line. The FILES' permissions
// are the operator's responsibility (the guide documents 0600) — these are
// not agent-room state, so the runtime permission gates do not rewrite them;
// the bounded-regular-file check only refuses what it cannot read safely.
export function tlsMaterialFromPaths({ certPath, keyPath } = {}) {
  const read = (path, name) => {
    try {
      regularPrivateFile(path)
    } catch (error) {
      throw new AgentRoomRuntimeError(
        'invalid_argument',
        `${name} ("${path}") is not a readable bounded regular file: ${error?.message ?? error}`,
      )
    }
    try {
      return readFileSync(path, 'utf8')
    } catch (error) {
      throw new AgentRoomRuntimeError(
        'invalid_argument',
        `${name} ("${path}") could not be read: ${error?.message ?? error}`,
      )
    }
  }
  if (typeof certPath !== 'string' || typeof keyPath !== 'string') {
    throw new AgentRoomRuntimeError('invalid_argument', 'tlsMaterialFromPaths requires both certPath and keyPath')
  }
  return Object.freeze({
    cert: read(certPath, 'AGENT_ROOM_TLS_CERT'),
    key: read(keyPath, 'AGENT_ROOM_TLS_KEY'),
  })
}
