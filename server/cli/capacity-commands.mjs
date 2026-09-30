// The operator capacity command body (Story 4.6, HCI-3/AR-13): the `run*`
// function behind `agent-room capacity`. This command joins the operator CLI
// HOST Story 4.2 established (review MED-1): the same `agent-room` bin, the
// same dispatch, the same JSON-lines grammar — never its own entrypoint.
//
// THE OPERATOR BOUNDARY IS THE HOST (AR-13), exactly like the invite and ban
// families — with one deliberate difference: capacity opens NO store. It is a
// filesystem-and-configuration view (one statfs of the shared data directory
// against the storage admission reserves), so it answers even when the store
// file cannot open, which is precisely when an operator needs it most. The
// mechanism is the storage gate's own (`statfsFreeBytes`, the thresholds
// resolved exactly as openRoomLog resolves them), so the command and the
// append path can never disagree about which side of a reserve a byte count
// is on. Thresholds come from the same operator surface the direct launch
// reads (AGENT_ROOM_STORAGE_WARN_BYTES / AGENT_ROOM_STORAGE_REFUSE_BYTES,
// defaulting to the constants module's reserves); a startServer override
// applies to that server process only and is invisible here — the documented
// shared surface is the env.
//
// THE JSON-LINES GRAMMAR (HCI-3): the answer is always exactly one JSON
// object on stdout — `state` (ok | warn | refuse) and `admits_appends` are
// the machine-readable severity, FR-22's byte counts (`database_bytes`,
// `wal_bytes`, sized by stat with no store open) ride beside the free-space
// number, and `detail` rides the non-ok states. Exit 0 while new appends
// are admitted (ok and warn alike — a reserve breach is a warning, never a
// refusal), 1 when free space is below the refuse reserve (new appends
// answer storage_low) or the data directory cannot be stat'ed, 2 on usage
// error. A junk env value warns one line on stderr and falls back to the
// declared default — it never blocks the answer by itself (the resolved
// pair is still validated: refuse above warn fails coded).

import { statSync } from 'node:fs'
import { join } from 'node:path'

import { capacityOf, resolveStorageThresholds, statfsFreeBytes, storageThresholdsFromEnv } from '../store/storage-gate.mjs'
import { ROOM_LOG_DATABASE_FILENAME } from '../store/room-log.mjs'

const line = object => JSON.stringify(object)

function usage(command, message) {
  return { status: 'usage', command, code: 'usage', message }
}

export function runCapacity({ sharedDataDir, env, errorOutput } = {}, tokens = []) {
  if (!Array.isArray(tokens) || tokens.length > 0) {
    return usage('capacity', `unexpected argument "${String(tokens?.[0] ?? '')}"; agent-room capacity takes no arguments`)
  }
  if (typeof sharedDataDir !== 'string' || sharedDataDir.trim().length === 0) {
    return usage('capacity', 'the agent-room data directory path is required')
  }

  // The same threshold resolution the store's open path runs — junk env
  // values fall back to the declared defaults with one stderr line each.
  const warnSink = errorOutput ?? process.stderr
  const { storageWarnFreeBytes, storageRefuseFreeBytes, warnings } = storageThresholdsFromEnv(env)
  for (const warning of warnings) {
    warnSink.write(`agent-room: ${warning}\n`)
  }
  const thresholds = resolveStorageThresholds({
    warnFreeBytes: storageWarnFreeBytes,
    refuseFreeBytes: storageRefuseFreeBytes,
  })

  let freeBytes
  try {
    freeBytes = statfsFreeBytes(sharedDataDir)
  } catch (error) {
    // A missing or unusable data directory is a refusal with a recovery
    // step, never a dead end and never a guessed number.
    const reason = error?.code === 'ENOENT'
      ? 'the agent-room data directory does not exist yet; start the server once to create it'
      : `the agent-room data directory could not be inspected: ${error?.message ?? String(error)}`
    return { status: 'refusal', command: 'capacity', code: 'data_directory_invalid', message: reason }
  }

  // FR-22's byte counts: the database file and its WAL sidecar, sized by
  // stat — still NO store open (the command reads file sizes, never the
  // database). An absent file is zero bytes (nothing written yet, or the
  // WAL is fully checkpointed); this stays a filesystem-and-configuration
  // view that answers with the store file corrupt or absent.
  const fileSize = name => {
    try {
      return Number(statSync(join(sharedDataDir, name)).size)
    } catch (error) {
      if (error?.code === 'ENOENT') return 0
      throw error
    }
  }
  const databaseBytes = fileSize(ROOM_LOG_DATABASE_FILENAME)
  const walBytes = fileSize(`${ROOM_LOG_DATABASE_FILENAME}-wal`)

  const { state, admitsAppends } = capacityOf({ freeBytes, ...thresholds })
  const detail = state === 'refuse'
    ? 'free space is below the refuse reserve; new appends are refused with storage_low until space is freed'
    : state === 'warn'
      ? 'free space is below the warning reserve; new appends are still admitted — plan a backup or disk expansion'
      : undefined
  return {
    status: 'ok',
    command: 'capacity',
    // The refuse state keeps the JSON report on stdout (the answer IS the
    // report) but exits 1, so `agent-room capacity` can gate a monitoring
    // script without parsing the line.
    ...(state === 'refuse' ? { exitCode: 1 } : {}),
    lines: [line({
      ok: true,
      command: 'capacity',
      capacity: {
        data_dir: sharedDataDir,
        free_bytes: freeBytes,
        database_bytes: databaseBytes,
        wal_bytes: walBytes,
        warn_free_bytes: thresholds.warnFreeBytes,
        refuse_free_bytes: thresholds.refuseFreeBytes,
        state,
        admits_appends: admitsAppends,
        ...(detail === undefined ? {} : { detail }),
      },
    })],
  }
}

// The family's dispatch: the command name (capacity), the argv after it, the
// injected deps. Refusals and usage outcomes are returned, never printed
// here — the entrypoint's single JSON-error printer owns the stderr line and
// the exit code.
export async function runCapacityFamilyCommand(command, tokens, deps) {
  try {
    if (command === 'capacity') {
      return runCapacity(deps, tokens)
    }
    return usage(String(command ?? ''), `"${command}" is not a capacity command; the capacity command is: capacity`)
  } catch (error) {
    return {
      status: 'refusal',
      command,
      code: error?.code ?? 'request_failed',
      message: error?.message ?? String(error),
    }
  }
}
