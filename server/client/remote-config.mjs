// Remote Mode configuration (Story 4.3, AC-1, AD-10/AD-11): the persisted
// server URL that turns an installation into a remote client. The file lives
// in PLUGIN_DATA — client state, never the shared data dir (AD-12: the
// shared dir is the LOCAL realm's home; which server this installation talks
// to is the installation's own decision).
//
// THE TRANSPORT POLICY IS THE MODULE: a configured server URL must be
// https:// with a hostname — plaintext (http://) remote is REFUSED with a
// coded error naming the scheme, before any wire work. TLS is Node's default
// certificate and hostname verification (the api-client overrides nothing —
// no verification escape hatch exists in this tree), per AD-11: TLS via
// node:https, plaintext permitted only on loopback.
//
// ONE SERVER IS ACTIVE AT A TIME: the file holds exactly one origin, and
// `saveRemoteConfig` replaces it wholesale. Per-realm state the installation
// earned from the previous server (cursors, allowlist, held cache under
// PLUGIN_DATA/realms/<old_realm_id>/) is DELIBERATELY LEFT ON DISK but
// becomes inert: realm identity comes from the server (AD-14), a different
// server is a different realm, and per AD-14/D13 a new realm starts with
// fresh trust — nothing under the old realm id can influence the new one.
// The stale directories are history, never an inheritance.
//
// The default is still Local Mode (FR-1, AD-10): no file, no remote. The
// file is written atomically at 0600 (the runtime.mjs machinery) and read
// through the bounded, anti-symlink reader; a missing file is the Local
// Mode default, while a corrupt or policy-violating one is an actionable
// coded error — a broken remote configuration must never silently fall back
// to Local Mode, because the safe direction is refusing, not retargeting.

import { existsSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'

import { CLIENT_CONFIG_MAX_BYTES } from '../constants.mjs'
import { AgentRoomRuntimeError, atomicWriteJson, readJsonFile } from '../runtime.mjs'

export const REMOTE_CONFIG_FILENAME = 'remote-config.json'

export function remoteConfigPath(pluginDataDir) {
  return join(pluginDataDir, REMOTE_CONFIG_FILENAME)
}

// Validate one configured server URL and return its normalized ORIGIN (the
// scheme, lowercased host, and explicit port only — no path, query, hash, or
// credentials). The origin-only rule is deliberate: the client joins API
// paths onto this base, so a path-bearing URL would silently change every
// request's shape; v0.2's deployment recipes front the root (the loopback
// backend plus a TLS front), and a subpath deployment would need a different
// joining contract to be honest. Every refusal is coded `invalid_request`
// and names what was wrong — for a scheme violation, the refused scheme.
export function validateRemoteServerUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.trim().length === 0) {
    throw new AgentRoomRuntimeError(
      'invalid_request',
      'a remote server URL is required: agent-room remote set <https-url>',
    )
  }
  let parsed
  try {
    parsed = new URL(rawUrl.trim())
  } catch {
    throw new AgentRoomRuntimeError(
      'invalid_request',
      `"${rawUrl.trim().slice(0, 200)}" is not a valid URL; a remote server URL looks like https://room.example.com`,
    )
  }
  if (parsed.protocol !== 'https:') {
    throw new AgentRoomRuntimeError(
      'invalid_request',
      `remote server URLs must use https:// (got ${parsed.protocol === 'http:' ? 'http' : parsed.protocol.replace(/:$/, '')}); ` +
      'plaintext remote connections are refused — the same host behind a TLS front (or the native node:https path) serves the https:// URL to set',
    )
  }
  if (parsed.hostname.length === 0) {
    throw new AgentRoomRuntimeError(
      'invalid_request',
      'a remote server URL needs a hostname: agent-room remote set <https-url> (for example https://room.example.com)',
    )
  }
  if (parsed.username !== '' || parsed.password !== '') {
    throw new AgentRoomRuntimeError(
      'invalid_request',
      'a remote server URL must not carry credentials; agent-room authenticates with this installation\'s key over the challenge lane',
    )
  }
  if (parsed.pathname !== '/' && parsed.pathname !== '') {
    throw new AgentRoomRuntimeError(
      'invalid_request',
      'a remote server URL must be the server origin (https://host[:port]) with no path; subpath deployments are not supported in v0.2',
    )
  }
  if (parsed.search !== '' || parsed.hash !== '') {
    throw new AgentRoomRuntimeError(
      'invalid_request',
      'a remote server URL must be the bare origin (https://host[:port]) with no query or fragment',
    )
  }
  return parsed.origin
}

// Read the persisted configuration. null means "not configured" — the Local
// Mode default (FR-1) applies and the api-client takes the ensureServer
// path. Anything that IS configured is re-validated on every read, never
// trusted: a hand-edited plaintext URL refuses exactly like a freshly typed
// one, and a corrupt file refuses instead of silently falling back to local.
export function loadRemoteConfig(pluginDataDir) {
  const path = remoteConfigPath(pluginDataDir)
  if (!existsSync(path)) return null
  let value
  try {
    value = readJsonFile(path, { maxBytes: CLIENT_CONFIG_MAX_BYTES })
  } catch (error) {
    throw new AgentRoomRuntimeError(
      'invalid_request',
      `agent-room remote config file is unusable (${error?.message ?? 'unreadable'}); fix or remove it, or run "agent-room remote set <https-url>" again`,
    )
  }
  if (typeof value?.server_url !== 'string' || value.server_url.length === 0) {
    throw new AgentRoomRuntimeError(
      'invalid_request',
      'agent-room remote config file has no server_url; run "agent-room remote set <https-url>" again, or "agent-room remote clear" to return to Local Mode',
    )
  }
  const setAt = typeof value.set_at === 'string' ? value.set_at : undefined
  return Object.freeze({
    serverUrl: validateRemoteServerUrl(value.server_url),
    ...(setAt === undefined ? {} : { setAt }),
    path,
  })
}

// Validate, then persist. The saved file carries exactly one server origin —
// the ONE active server (AC-1). Setting again replaces (and reports the
// replacement to the caller); the per-realm state of a replaced server stays
// on disk under its realm id, inert, as documented in the module header.
export function saveRemoteConfig(pluginDataDir, { serverUrl } = {}) {
  const origin = validateRemoteServerUrl(serverUrl)
  const path = remoteConfigPath(pluginDataDir)
  const setAt = new Date().toISOString()
  atomicWriteJson(path, { server_url: origin, set_at: setAt })
  return Object.freeze({ serverUrl: origin, setAt, path })
}

// Remove the configuration — back to the Local Mode default. Idempotent:
// clearing an unset configuration is a successful no-op that reports false.
export function clearRemoteConfig(pluginDataDir) {
  const path = remoteConfigPath(pluginDataDir)
  let removed = false
  try {
    unlinkSync(path)
    removed = true
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error
  }
  return removed
}
