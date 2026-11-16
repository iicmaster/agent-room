// Story 4.3 — Tier 3 shell-free external notify runner.
//
// This is the ONE notify-runner path. It replaces the retired `runHook` in
// notifier.mjs (which ran `execFile(cmd, [], {timeout:10000})` with a line on
// stdin — a Tier 3 violation: wrong budget and a message body on stdin).
//
// CONTRACT (per epic AQ-3 / AC1, all hard):
//   - config is LOCAL USER CONFIG ONLY: AGENT_ROOM_NOTIFY_CMD or a local JSON
//     file. Never read from a remote/peer. The config is either an argv array
//     or an executable path string.
//   - the executable is verified with lstat (regular file, not a symlink,
//     executable bit) AND realpath (no symlink escape in any path component).
//     A path string with ANY whitespace is misconfigured (string path mode
//     forbids spaces; use the argv-array form for arguments).
//   - it runs via execFile(cmd, args, {shell:false, timeout:1000}) — NEVER
//     shell:true, NEVER /bin/sh -c.
//   - only the four allowlisted metadata variables reach the child env, plus
//     a short benign inherit list (PATH for `#!/usr/bin/env`, etc). Every other
//     AGENT_ROOM_* variable — including tokens and secrets — is DROPPED.
//   - NO message text, body, or token is ever passed in argv or env.
//   - failure / nonzero / timeout => 0 retries, a REDACTED diagnostic (code
//     only, never a raw error message that might carry metadata), and a bounded
//     passive fallback owned by the caller (the inbox line is already written).
//
// Zero external dependencies.

import { execFile } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'

import {
  NOTIFY_CHILD_ENV_ALLOWLIST,
  NOTIFY_CONFIG_FILENAME,
  NOTIFY_CONFIG_PATH_ENV,
  NOTIFY_ENV_ALLOWLIST,
  TIER3_TIMEOUT_MS,
} from '../constants.mjs'
import { readJsonFile } from '../runtime.mjs'

const WHITESPACE = /\s/
const REDACTABLE_CODES = new Set(['ETIMEDOUT', 'ENOENT', 'EACCES', 'EISDIR', 'ENOTDIR', 'EPERM', 'E2BIG'])

// Strip control characters (including CR/LF/NUL) from a metadata value. The
// value stays DATA — with shell:false there is no expansion — but control
// chars are removed so a hostile sender field cannot forge log lines or env.
function safeMetadataValue(value) {
  if (value === undefined || value === null) return ''
  return String(value).replace(/[\u0000-\u001f\u007f]/g, '')
}

// --- config loading (local only) ------------------------------------------------

// Parse one config source into a normalized shape. Returns:
//   { status:'none' }
//   { status:'ok', argv:[executable, ...literalArgs], mode:'argv'|'path', provenance }
//   { status:'misconfigured', reason, provenance }
// `provenance` names the local source (never a remote/peer).
function normalizeConfig(raw, provenance) {
  if (raw === undefined || raw === null || raw === '') return { status: 'none' }

  // Env string mode: a JSON array is the argv form; otherwise it is a path
  // string (which forbids whitespace).
  if (typeof raw === 'string') {
    const trimmed = raw.trim()
    if (trimmed.startsWith('[')) {
      let parsed
      try { parsed = JSON.parse(trimmed) } catch { return { status: 'misconfigured', reason: 'invalid-json', provenance } }
      return normalizeConfig(parsed, provenance)
    }
    if (WHITESPACE.test(raw)) return { status: 'misconfigured', reason: 'whitespace-in-path', provenance }
    return { status: 'ok', argv: [raw], mode: 'path', provenance }
  }

  // Array mode: a non-empty array of strings; argv[0] is the executable.
  if (Array.isArray(raw)) {
    if (raw.length === 0 || raw.some(item => typeof item !== 'string' || item.length === 0)) {
      return { status: 'misconfigured', reason: 'invalid-argv', provenance }
    }
    return { status: 'ok', argv: [...raw], mode: 'argv', provenance }
  }

  // Object (config file) mode: {argv:[...]} or {cmd:[...]} or {cmd:"path"}.
  if (typeof raw === 'object') {
    const value = raw.argv ?? raw.cmd ?? raw.path
    if (value === undefined) return { status: 'misconfigured', reason: 'missing-command', provenance }
    return normalizeConfig(value, provenance)
  }
  return { status: 'misconfigured', reason: 'invalid-config', provenance }
}

/**
 * Resolve the Tier 3 config from local sources only. The environment variable
 * wins; otherwise a local JSON config file is read. No remote/peer source is
 * ever consulted. Does NOT verify the executable (see verifyExecutable) — this
 * is the pure config-shape half reused by doctor's misconfigured detection.
 */
export function loadNotifyConfig({ env = process.env, pluginDataDir } = {}) {
  const fromEnv = env[NOTIFY_CONFIG_PATH_ENV]
  const envProvenance = `${NOTIFY_CONFIG_PATH_ENV}`
  if (typeof fromEnv === 'string' && fromEnv.length > 0) {
    return normalizeConfig(fromEnv, envProvenance)
  }
  if (typeof pluginDataDir === 'string' && pluginDataDir.length > 0) {
    const configPath = `${String(pluginDataDir).replace(/\/$/, '')}/${NOTIFY_CONFIG_FILENAME}`
    let doc
    try {
      doc = readJsonFile(configPath)
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'state_file_invalid' && error?.cause?.code === 'ENOENT') {
        return { status: 'none' }
      }
      // A present-but-unreadable/invalid local config is misconfigured, not
      // silently absent — doctor must be able to detect it.
      return { status: 'misconfigured', reason: 'config-unreadable', provenance: configPath }
    }
    return normalizeConfig(doc, configPath)
  }
  return { status: 'none' }
}

// Detect the legacy variable name too, as a path-string source. Kept separate
// so its empty state is honest and the two sources have distinct provenance.
export function loadNotifyConfigFromLegacyEnv({ env = process.env } = {}) {
  return normalizeConfig(env.AGENT_ROOM_NOTIFY_CMD, 'AGENT_ROOM_NOTIFY_CMD')
}

// The notifier owns AGENT_ROOM_NOTIFY_CMD as a plain path string (its historical
// shape). Convert it to a normalized config without re-reading the environment.
export function normalizeNotifyCommand(command) {
  return normalizeConfig(command, 'AGENT_ROOM_NOTIFY_CMD')
}

/**
 * Merge the local config sources: the primary config (env var or JSON file)
 * takes precedence, then the legacy AGENT_ROOM_NOTIFY_CMD env string.
 */
export function resolveNotifyConfig(options = {}) {
  const primary = loadNotifyConfig(options)
  if (primary.status !== 'none') return primary
  return loadNotifyConfigFromLegacyEnv(options)
}

// --- executable verification ----------------------------------------------------

/**
 * lstat + realpath verification of the executable. Returns {ok:true} or
 * {ok:false, reason}. A symlink (anywhere in the resolved path) or whitespace
 * in a path-string executable is misconfigured. No execution happens here.
 */
export function verifyExecutable(executable, { mode = 'path' } = {}) {
  if (typeof executable !== 'string' || executable.length === 0) return { ok: false, reason: 'invalid-executable' }
  if (mode === 'path' && WHITESPACE.test(executable)) return { ok: false, reason: 'whitespace-in-path' }
  let info
  try {
    info = lstatSync(executable)
  } catch (error) {
    return { ok: false, reason: error?.code === 'ENOENT' ? 'not-found' : 'lstat-failed' }
  }
  // lstat does NOT follow the final component: a symlink configured as the
  // executable (the classic retargetable-escape attack) is refused here.
  if (info.isSymbolicLink()) return { ok: false, reason: 'symlink-escape' }
  if (!info.isFile()) return { ok: false, reason: 'not-regular-file' }
  if ((info.mode & 0o111) === 0) return { ok: false, reason: 'not-executable' }
  // realpath canonicalizes the whole path (parent symlinks such as macOS
  // /tmp -> /private/tmp are legitimate). The canonical target must ALSO be a
  // regular executable file — a parent symlink redirecting to a directory or
  // non-executable is refused rather than followed into a surprise target.
  let resolved
  let resolvedInfo
  try {
    resolved = realpathSync(executable)
    resolvedInfo = lstatSync(resolved)
  } catch {
    return { ok: false, reason: 'realpath-failed' }
  }
  if (!resolvedInfo.isFile() || (resolvedInfo.mode & 0o111) === 0) {
    return { ok: false, reason: 'escape-target-invalid' }
  }
  return { ok: true, resolved }
}

// --- metadata + child env -------------------------------------------------------

/** Reduce a raw candidate row to the four allowlisted metadata values. */
export function notifyMetadata({ room_id, seq, chat_id, from_address, trusted } = {}) {
  return {
    AGENT_ROOM_ROOM_ID: safeMetadataValue(room_id),
    AGENT_ROOM_SEQ: safeMetadataValue(seq),
    AGENT_ROOM_FROM_ADDRESS: safeMetadataValue(from_address ?? chat_id),
    AGENT_ROOM_TRUSTED: safeMetadataValue(trusted === true ? 'true' : trusted === false ? 'false' : trusted),
  }
}

/** Build the child env: benign inherit list + only the four metadata vars. */
export function buildTier3Env(metadata = {}, { env = process.env } = {}) {
  const child = {}
  for (const key of NOTIFY_CHILD_ENV_ALLOWLIST) {
    const value = env[key] ?? process.env[key]
    if (typeof value === 'string') child[key] = value
  }
  for (const key of NOTIFY_ENV_ALLOWLIST) {
    child[key] = safeMetadataValue(metadata[key])
  }
  return child
}

/** Redact an exec error to a short, safe code — never its raw message. */
export function redactTier3Error(error, { timedOut = false } = {}) {
  if (timedOut || error?.killed || error?.code === 'ETIMEDOUT') return 'timeout'
  if (typeof error?.code === 'string' && REDACTABLE_CODES.has(error.code)) return error.code
  if (typeof error?.signal === 'string' && error.signal.length > 0) return `signal:${error.signal}`
  if (typeof error?.code === 'number' && error.code !== 0) return `exit:${error.code}`
  return 'error'
}

// --- the single runner ----------------------------------------------------------

/**
 * Run the configured Tier 3 command once, with zero retries. Returns a small
 * result object; all failures are redacted and never carry message text.
 *
 * @returns {Promise<{ok:boolean, reason?:string, provenance?:string, skipped?:boolean}>}
 */
export async function runTier3Notify({
  config,
  metadata = {},
  env = process.env,
  execFileFn = execFile,
  errorOutput = process.stderr,
  signal,
} = {}) {
  const resolved = config ?? resolveNotifyConfig({ env })
  if (resolved.status === 'none') return { ok: true, skipped: true, reason: 'not-configured' }
  if (resolved.status === 'misconfigured') {
    return { ok: false, reason: resolved.reason, provenance: resolved.provenance }
  }
  const verified = verifyExecutable(resolved.argv[0], { mode: resolved.mode })
  if (!verified.ok) {
    return { ok: false, reason: verified.reason, provenance: resolved.provenance }
  }

  const [executable, ...args] = resolved.argv
  const childEnv = buildTier3Env(metadata, { env })
  const options = {
    shell: false,
    timeout: TIER3_TIMEOUT_MS,
    env: childEnv,
    windowsHide: true,
    ...(signal ? { signal } : {}),
  }
  return new Promise(resolvePromise => {
    execFileFn(executable, args, options, error => {
      if (!error) {
        resolvePromise({ ok: true, provenance: resolved.provenance })
        return
      }
      // A caller-driven abort is not a notify failure worth a redacted error.
      if (signal?.aborted || error?.name === 'AbortError') {
        resolvePromise({ ok: false, reason: 'aborted', provenance: resolved.provenance })
        return
      }
      const reason = redactTier3Error(error, { timedOut: error?.killed === true })
      // Bounded, redacted diagnostic: code only, never a raw message/argv/env.
      try {
        errorOutput.write(`agent-room notifier: tier3 notify failed: ${reason}\n`)
      } catch { /* a closed stderr must not break the passive path */ }
      resolvePromise({ ok: false, reason, provenance: resolved.provenance })
    })
  })
}

export const TIER3_METADATA_KEYS = Object.freeze([...NOTIFY_ENV_ALLOWLIST])
