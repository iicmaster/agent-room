// The storage admission gate (Story 4.6, FR-22): free-space admission control
// for the durable log, shared by the store's append path and the operator
// capacity command.
//
// The AC's shape: below the WARN reserve (default 1 GiB free) the operator is
// warned; below the REFUSE reserve (default 256 MiB free) new appends are
// refused with the coded `storage_low`. Both thresholds are tunable capacity
// RESERVES — an operator's declared safety margin against a full disk — and
// are NEVER retention quotas: this module has no delete verb, and the store's
// log is append-only by construction, so a gate can never age work out. The
// refusal is the admission boundary's face of FR-17's storage_low status.
//
// MECHANISM: one statfs(2) of the data directory per append —
// statfsSync(dataDir).bavail * bsize is the free space available to
// unprivileged writes on the filesystem holding the data dir (bavail, not
// bfree: blocks reserved for root are not space agent-room can use). A single
// syscall is deliberately cheap enough to run inside the append's BEGIN
// IMMEDIATE transaction, so the admission decision and the insert it guards
// share one serialization point: a refusal and a commit can never race.
// The free-space source is injectable (freeBytesFn) so tests simulate full
// disks without filling a real one. (The live-filesystem test's 2% tolerance
// guards filesystems whose root reservation makes bavail differ measurably
// from bfree — on a filesystem where the two are equal the tolerance cannot
// distinguish them; see tests/storage-gates.test.mjs's real-source row.)
//
// The warn is rate-limited to one line per STORAGE_WARN_INTERVAL_MS per store
// connection — a hint an operator must be able to read in a log, not one line
// per append. The warn never refuses: between the reserves the realm keeps
// admitting and committing work while telling the operator the margin is
// gone. Reads are never gated anywhere: whatever storage can still serve,
// the log serves.

import { statfsSync } from 'node:fs'

import {
  STORAGE_REFUSE_FREE_BYTES,
  STORAGE_WARN_FREE_BYTES,
  STORAGE_WARN_INTERVAL_MS,
} from '../constants.mjs'
import { AgentRoomRuntimeError } from '../runtime.mjs'

function fail(code, message) {
  throw new AgentRoomRuntimeError(code, message)
}

// The real free-space source: one statfs of the directory, the free blocks
// times their size. Exported as the default freeBytesFn so the capacity
// command and the store share one mechanism, and so tests can prove the
// mechanism against a real filesystem.
export function statfsFreeBytes(dataPath) {
  const stats = statfsSync(dataPath)
  return stats.bavail * stats.bsize
}

// The default warn sink: one line per warn, newline-terminated. Injectable
// (openRoomLog's storageWarn / startServer's storageWarn) so tests capture
// the lines without touching the process stderr.
export function defaultStorageWarn(line) {
  process.stderr.write(`${line}\n`)
}

// Threshold validation, shared by the store open path, startServer, and the
// capacity command: both reserves are non-negative safe integers of bytes
// (0 = the gate at that level can never fire — free space is never below
// zero — which is how an operator disables a level), and the refuse reserve
// may not exceed the warn reserve (refusing while still above the warn line
// is a contradiction, not a configuration). Declared thresholds flow from the
// constants module; a literal restated here would be an AD-9 violation, so
// none is.
export function resolveStorageThresholds({ warnFreeBytes, refuseFreeBytes } = {}) {
  const requireReserve = (value, name) => {
    if (!Number.isSafeInteger(value) || value < 0) {
      fail('invalid_argument', `${name} must be a non-negative safe integer number of bytes`)
    }
    return value
  }
  const warn = requireReserve(warnFreeBytes, 'storageWarnFreeBytes')
  const refuse = requireReserve(refuseFreeBytes, 'storageRefuseFreeBytes')
  if (refuse > warn) {
    fail(
      'invalid_argument',
      `storageRefuseFreeBytes (${refuse}) must not exceed storageWarnFreeBytes (${warn}): the refuse reserve cannot sit above the warning reserve`,
    )
  }
  return Object.freeze({ warnFreeBytes: warn, refuseFreeBytes: refuse })
}

// The direct launch's operator surface (and the capacity command's): the two
// env knobs, each strictly validated — a present-but-invalid value never
// blocks a boot or breaks the command; it warns once and falls back to the
// declared default. The fallback is PER KEY: each junk value is replaced by
// its own default, and only then is the RESOLVED pair validated by
// `resolveStorageThresholds` — so a junk value that leaves refuse above warn
// (for example a valid `AGENT_ROOM_STORAGE_WARN_BYTES=0` beside junk refuse
// falling back to 256 MiB) still fails coded `invalid_argument` at
// resolution, exactly as a hand-tuned contradiction would. Same shape and
// discipline as the server's other env parsers (claimsTtlMsFromEnv,
// gateLimitsFromEnv).
export function storageThresholdsFromEnv(env = process.env) {
  const warnings = []
  const readBytes = (key, fallback) => {
    const raw = env?.[key]
    if (raw === undefined || String(raw).trim() === '') return fallback
    const trimmed = String(raw).trim()
    if (!/^[0-9]+$/.test(trimmed) || !Number.isSafeInteger(Number(trimmed))) {
      warnings.push(`ignoring invalid ${key} "${raw}": must be a non-negative integer number of bytes; using the default ${fallback}`)
      return fallback
    }
    return Number(trimmed)
  }
  return {
    storageWarnFreeBytes: readBytes('AGENT_ROOM_STORAGE_WARN_BYTES', STORAGE_WARN_FREE_BYTES),
    storageRefuseFreeBytes: readBytes('AGENT_ROOM_STORAGE_REFUSE_BYTES', STORAGE_REFUSE_FREE_BYTES),
    warnings,
  }
}

// The capacity state the capacity command reports and the gate warns with:
// free space against the two reserves. `refuse` answers admitsAppends:false —
// new appends are refused storage_low until space is freed; `warn` still
// admits (a reserve breach is a warning, never a refusal); `ok` is above the
// warn reserve entirely. Derived here once so the CLI, the gate, and the
// tests can never disagree about which side of a threshold a byte count is on.
export function capacityOf({ freeBytes, warnFreeBytes, refuseFreeBytes }) {
  const state = freeBytes < refuseFreeBytes
    ? 'refuse'
    : freeBytes < warnFreeBytes
      ? 'warn'
      : 'ok'
  return Object.freeze({ state, admitsAppends: state !== 'refuse' })
}

// The append-path gate over one data directory. `check(nowMs)` is the store's
// per-append admission decision: below the refuse reserve it throws the coded
// `storage_low` (the transaction rolls back, nothing is written, nothing is
// acknowledged); between the reserves it emits the rate-limited warn line and
// admits; above the warn reserve it is a no-op. The injected clock rides the
// append's own nowMs, so tests roll the warn window without waiting on the
// wall clock. `snapshot()` is the same observation without the refusal —
// the read-only face (used by tests; the capacity command reads the
// filesystem directly so it answers even when the store file cannot open).
export function createStorageAdmissionGate({
  dataDir,
  warnFreeBytes = STORAGE_WARN_FREE_BYTES,
  refuseFreeBytes = STORAGE_REFUSE_FREE_BYTES,
  freeBytesFn = statfsFreeBytes,
  warn = defaultStorageWarn,
} = {}) {
  if (typeof dataDir !== 'string' || dataDir.trim().length === 0) {
    fail('invalid_argument', 'createStorageAdmissionGate requires the data directory path')
  }
  if (typeof freeBytesFn !== 'function') {
    fail('invalid_argument', 'freeBytesFn must be a function when provided')
  }
  if (typeof warn !== 'function') {
    fail('invalid_argument', 'warn must be a function when provided')
  }
  const thresholds = resolveStorageThresholds({ warnFreeBytes, refuseFreeBytes })

  // The warn rate limiter's state is per gate — one store connection warns at
  // most once per interval. -Infinity makes the first below-warn append warn
  // immediately.
  let lastWarnMs = -Infinity

  const readFreeBytes = () => {
    const free = freeBytesFn(dataDir)
    if (typeof free !== 'number' || !Number.isFinite(free) || free < 0) {
      fail('invalid_argument', `freeBytesFn must return a non-negative finite number of bytes, got ${String(free)}`)
    }
    return free
  }

  const warnLine = free => `agent-room-store: storage_low warning: free space in ${dataDir} is ${free} bytes, below the warning reserve of ${thresholds.warnFreeBytes} bytes; new appends are refused below the refuse reserve of ${thresholds.refuseFreeBytes} bytes`

  function check(nowMs = Date.now()) {
    if (typeof nowMs !== 'number' || !Number.isFinite(nowMs)) {
      fail('invalid_argument', 'the storage gate clock must be a finite epoch-millisecond number')
    }
    const free = readFreeBytes()
    if (free < thresholds.refuseFreeBytes) {
      fail(
        'storage_low',
        `free space in ${dataDir} is ${free} bytes, below the refuse reserve of ${thresholds.refuseFreeBytes} bytes; the message was not committed`,
      )
    }
    if (free < thresholds.warnFreeBytes) {
      if (nowMs - lastWarnMs >= STORAGE_WARN_INTERVAL_MS) {
        lastWarnMs = nowMs
        warn(warnLine(free))
      }
    }
    return Object.freeze({ freeBytes: free, ...capacityOf({ freeBytes: free, ...thresholds }) })
  }

  function snapshot() {
    const free = readFreeBytes()
    return Object.freeze({ freeBytes: free, ...capacityOf({ freeBytes: free, ...thresholds }) })
  }

  return Object.freeze({
    check,
    snapshot,
    thresholds,
  })
}
