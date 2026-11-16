import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import https from 'node:https'
import { performance } from 'node:perf_hooks'
import { promisify } from 'node:util'

import {
  BOOTSTRAP_READINESS_TIMEOUT_MS,
  CLI_ERROR_TIMEOUT,
  INVITE_DIGEST_PREFIX_CHARS,
  INVITE_TOKEN_BYTES,
  INVITE_TOKEN_PATTERN,
  INVITE_TOKEN_PREFIX,
  NOFILE_PROBE_TIMEOUT_MS,
  NOFILE_RECOMMENDED,
  PROTOCOL_HEADER,
  PROTOCOL_VERSION,
} from '../constants.mjs'
import {
  AgentRoomRuntimeError,
  assertSafePathKey,
  assertSupportedRuntime,
  ensurePrivateDirectory,
} from '../runtime.mjs'
import { loadOrCreateKeypair, signWithInstallationKey } from '../keys.mjs'
import { loadOrCreateLocalToken } from '../api/local-token.mjs'
import { ensureServer, readRuntimeRecord } from '../client/ensure-server.mjs'
import { resolveOrMintSessionPrincipal } from '../client/api-client.mjs'
import {
  loadSessionState,
  machineLabel,
  sessionScopeKey,
  writeScopeBinding,
} from '../client/session-state.mjs'
import { loadRemoteConfig, saveRemoteConfig, validateRemoteServerUrl } from '../client/remote-config.mjs'
import { LOCAL_TRANSPORT } from '../client/trust.mjs'
import { authenticate, protocolHeaders, roundTrip } from './session-commands.mjs'

const execFileAsync = promisify(execFile)

function redactInviteTokens(text) {
  return String(text ?? '').replace(/ar_inv1_[A-Za-z0-9_-]{43}/g, 'ar_inv1_<redacted>')
}

function sessionHeadersOf(capability) {
  return {
    [PROTOCOL_HEADER]: PROTOCOL_VERSION,
    authorization: `Session ${capability}`,
  }
}

function usage(message) {
  return {
    status: 'usage',
    command: 'bootstrap',
    code: 'invalid_request',
    message,
  }
}

function refusal(code, message) {
  return {
    status: 'refusal',
    command: 'bootstrap',
    code,
    message: redactInviteTokens(message),
  }
}

function parseBootstrapArgs(tokens) {
  const flags = {
    remote: undefined,
    invite: undefined,
    harness: undefined,
    scope: undefined,
    json: false,
  }
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--json') {
      flags.json = true
      continue
    }
    if (token === '--remote' || token === '--invite' || token === '--harness' || token === '--scope') {
      const value = tokens[index + 1]
      if (value === undefined || value.startsWith('--')) {
        return { error: `agent-room bootstrap ${token} needs a value` }
      }
      flags[token.slice(2)] = value
      index += 1
      continue
    }
    if (token.startsWith('--')) {
      return { error: `unknown option "${token}"; expected: agent-room bootstrap [--remote <https-origin> --invite <token>] [--harness <name>] [--scope <key>] [--json]` }
    }
    return { error: `unexpected argument "${token}"; agent-room bootstrap takes options only` }
  }
  return { flags }
}

function normalizeHarnessRole(harness) {
  if (typeof harness !== 'string' || harness.trim().length === 0) return 'agent'
  const cleaned = harness.trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 23)
  return cleaned || 'agent'
}

function tokenDigestPrefix(inviteToken) {
  const bytes = Buffer.from(inviteToken.slice(INVITE_TOKEN_PREFIX.length), 'base64url')
  if (bytes.length !== INVITE_TOKEN_BYTES) {
    throw new AgentRoomRuntimeError('invalid_request', 'the invite token payload does not decode to the declared byte count')
  }
  return createHash('sha256').update(bytes).digest('hex').slice(0, INVITE_DIGEST_PREFIX_CHARS)
}

function remainingBudgetMs(deadlineMs, floorMs = 250) {
  const remaining = Math.floor(deadlineMs - performance.now())
  if (remaining <= 0) {
    throw new AgentRoomRuntimeError(CLI_ERROR_TIMEOUT, 'bootstrap exceeded the 10s readiness deadline')
  }
  return Math.max(floorMs, remaining)
}

function enrollHttpPost(origin, path, body, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const request = https.request(
      new URL(path, origin),
      {
        method: 'POST',
        agent: false,
        headers: {
          [PROTOCOL_HEADER]: PROTOCOL_VERSION,
          'content-type': 'application/json; charset=utf-8',
        },
      },
      (response) => {
        const chunks = []
        response.on('data', chunk => chunks.push(chunk))
        response.on('error', rejectPromise)
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed = null
          try { parsed = JSON.parse(text) } catch { parsed = null }
          resolvePromise({ status: response.statusCode, body: parsed })
        })
      },
    )
    request.setTimeout(timeoutMs, () => {
      request.destroy(new AgentRoomRuntimeError('request_failed', 'the enrollment request timed out'))
    })
    request.on('error', (error) => {
      rejectPromise(new AgentRoomRuntimeError('request_failed', `the enrollment request failed: ${error?.message ?? error}`))
    })
    request.end(JSON.stringify(body))
  })
}

export async function probeNofile() {
  try {
    const { stdout } = await execFileAsync('/bin/sh', ['-c', 'ulimit -n'], {
      timeout: NOFILE_PROBE_TIMEOUT_MS,
      encoding: 'utf8',
    })
    const trimmed = String(stdout ?? '').trim()
    if (trimmed === 'unlimited') {
      return { status: 'ok', limit: 'unlimited', recommended: NOFILE_RECOMMENDED, message: 'NOFILE: unlimited' }
    }
    if (/^\d+$/.test(trimmed)) {
      const value = Number(trimmed)
      if (value >= NOFILE_RECOMMENDED) {
        return { status: 'ok', limit: value, recommended: NOFILE_RECOMMENDED, message: `NOFILE: ${value}` }
      }
      return {
        status: 'warn',
        limit: value,
        recommended: NOFILE_RECOMMENDED,
        message: `NOFILE=${value} (< ${NOFILE_RECOMMENDED}); raise with: ulimit -n ${NOFILE_RECOMMENDED}`,
      }
    }
    return { status: 'unknown', limit: null, recommended: NOFILE_RECOMMENDED, message: 'NOFILE: unknown' }
  } catch {
    return { status: 'unknown', limit: null, recommended: NOFILE_RECOMMENDED, message: 'NOFILE: unknown' }
  }
}

export async function runBootstrapCommand(tokens, deps) {
  const { pluginDataDir, sharedDataDir, env = process.env } = deps
  const deadlineMs = performance.now() + BOOTSTRAP_READINESS_TIMEOUT_MS

  try {
    assertSupportedRuntime()
  } catch (error) {
    return refusal(error?.code ?? 'startup_failed', error?.message ?? String(error))
  }

  const parsed = parseBootstrapArgs(tokens)
  if (parsed.error !== undefined) return usage(parsed.error)
  const { flags } = parsed

  const hasRemote = flags.remote !== undefined
  const hasInvite = flags.invite !== undefined
  if (hasRemote !== hasInvite) {
    return refusal('invalid_request', '--remote and --invite must be given together')
  }

  try {
    let remoteOrigin = null
    let inviteDigestPrefix = null
    if (hasRemote) {
      remoteOrigin = validateRemoteServerUrl(flags.remote)
      if (typeof flags.invite !== 'string' || !INVITE_TOKEN_PATTERN.test(flags.invite)) {
        return refusal('invalid_request', 'invalid --invite token format; expected ar_inv1_<43-char-token>')
      }
      inviteDigestPrefix = tokenDigestPrefix(flags.invite)
    }

    const role = normalizeHarnessRole(flags.harness)
    const nofile = await probeNofile()

    ensurePrivateDirectory(pluginDataDir)
    const keypair = loadOrCreateKeypair(pluginDataDir)

    let target
    let origin
    let mode = 'local'

    if (remoteOrigin !== null) {
      mode = 'remote'
      const existingRemote = loadRemoteConfig(pluginDataDir)
      const alreadyEnrolled = existingRemote !== null
        && existingRemote.serverUrl === remoteOrigin
        && existingRemote.enrolled?.fingerprint === keypair.fingerprint
        && existingRemote.enrolled?.server_url === remoteOrigin
        && existingRemote.enrolled?.token_digest_prefix === inviteDigestPrefix

      if (!alreadyEnrolled) {
        const response = await enrollHttpPost(
          remoteOrigin,
          '/api/auth/enroll',
          {
            invite_token: flags.invite,
            public_key: keypair.publicKey.toString('base64url'),
            signature: signWithInstallationKey(pluginDataDir, Buffer.from(flags.invite, 'utf8')).toString('base64url'),
          },
          remainingBudgetMs(deadlineMs),
        )
        if (response.status !== 200 || response.body?.ok !== true) {
          const code = response.body?.error?.code
          throw new AgentRoomRuntimeError(
            typeof code === 'string' && code.length > 0 ? code : 'request_failed',
            redactInviteTokens(response.body?.error?.message ?? `the enrollment request answered ${response.status}`),
          )
        }
        const enrolledFingerprint = response.body?.result?.fingerprint
        if (enrolledFingerprint !== keypair.fingerprint) {
          throw new AgentRoomRuntimeError(
            'request_failed',
            `the server enrolled fingerprint ${String(enrolledFingerprint)} instead of ${keypair.fingerprint}`,
          )
        }
        saveRemoteConfig(pluginDataDir, {
          serverUrl: remoteOrigin,
          enrolled: {
            fingerprint: keypair.fingerprint,
            server_url: remoteOrigin,
            token_digest_prefix: inviteDigestPrefix,
          },
        })
      }
      target = { kind: 'remote', serverUrl: remoteOrigin }
      origin = remoteOrigin
    } else {
      const configuredRemote = loadRemoteConfig(pluginDataDir)
      if (configuredRemote !== null) {
        mode = 'remote'
        target = { kind: 'remote', serverUrl: configuredRemote.serverUrl }
        origin = configuredRemote.serverUrl
      } else {
        ensurePrivateDirectory(sharedDataDir)
        const server = await ensureServer({
          dataDir: sharedDataDir,
          waitMs: remainingBudgetMs(deadlineMs, 1000),
        })
        loadOrCreateLocalToken(sharedDataDir)
        target = { kind: 'local', port: server.port }
        origin = `local:${server.port}`
      }
    }

    const scope = sessionScopeKey({
      explicitScope: flags.scope,
      env,
      pluginDataDir,
    })
    try {
      writeScopeBinding({ pluginDataDir, scope, env })
    } catch {
      // best-effort scope binding
    }

    const { token, fingerprint, transport } = await authenticate(target, {
      pluginDataDir,
      sharedDataDir,
      env,
      sessionKind: 'cli_oneshot',
    })

    const statusResp = await roundTrip(
      target,
      'GET',
      '/api/status',
      protocolHeaders(token),
      undefined,
      remainingBudgetMs(deadlineMs),
    )
    if (statusResp.status !== 200 || typeof statusResp.body?.result?.realm_id !== 'string') {
      throw new AgentRoomRuntimeError(
        statusResp.body?.error?.code ?? 'request_failed',
        statusResp.body?.error?.message ?? `the agent-room server answered ${statusResp.status}`,
      )
    }
    const realmId = assertSafePathKey(statusResp.body.result.realm_id, { label: 'realm id' })

    const roundTripOrThrow = async (method, path, headers, body) => {
      const response = await roundTrip(target, method, path, headers, body, remainingBudgetMs(deadlineMs))
      if (response.status !== 200) {
        throw new AgentRoomRuntimeError(
          response.body?.error?.code ?? 'request_failed',
          response.body?.error?.message ?? `the agent-room server answered ${response.status}`,
        )
      }
      return response.body.result
    }

    const listPrincipals = () => roundTripOrThrow('GET', '/api/session-principals', protocolHeaders(token))
    const initialDirectory = await listPrincipals()
    const initialSessions = Array.isArray(initialDirectory?.sessions) ? initialDirectory.sessions : []

    const existingState = loadSessionState(pluginDataDir, scope)
    const alreadyOnline = existingState !== null
      && initialSessions.some(row => row.session_id === existingState.sessionId && row.presence === 'online')

    let principal
    if (alreadyOnline) {
      principal = existingState
    } else {
      const machine = machineLabel({ env })
      principal = await resolveOrMintSessionPrincipal({
        pluginDataDir,
        sessionScope: scope,
        requestedName: null,
        requestedRole: role,
        resumePrincipal: ({ sessionId, generation, capability }) => roundTripOrThrow(
          'POST',
          '/api/session-principals/resume',
          sessionHeadersOf(capability),
          { session_id: sessionId, generation },
        ),
        allocatePrincipal: baseChatId => roundTripOrThrow(
          'POST',
          '/api/session-principals',
          protocolHeaders(token),
          { base_chat_id: baseChatId, machine, client_type: 'cli' },
        ),
      })
    }

    const verifiedDirectory = alreadyOnline ? initialDirectory : await listPrincipals()
    const verifiedSessions = Array.isArray(verifiedDirectory?.sessions) ? verifiedDirectory.sessions : []
    const selfRow = verifiedSessions.find(row => row.session_id === principal.sessionId)
    if (!selfRow || selfRow.presence !== 'online') {
      throw new AgentRoomRuntimeError('request_failed', 'session principal did not appear online after bootstrap')
    }

    const runtimeRecord = transport === LOCAL_TRANSPORT ? readRuntimeRecord(sharedDataDir) : null
    const sameRealm = Boolean(runtimeRecord?.realm_id && runtimeRecord.realm_id === realmId)
    const locality = transport === LOCAL_TRANSPORT
      && sameRealm
      && (selfRow.enrolled_via === 'local' || selfRow.fingerprint === fingerprint)
      ? 'local'
      : 'remote'

    const instructions = [
      `Session scope: ${scope} (address: ${principal.address}, locality: ${locality})`,
      'Base lease is 45s (heartbeat 15s); keep a live watch/MCP session or resume with the same scope.',
      'Use agent-room sessions to list peers, agent-room dm --to <address> --text <msg> to send, agent-room read --room <room_id> (or --wait-ms for READ_HOLD) to read, and agent-room wait to wait for replies.',
    ]

    const result = {
      ok: true,
      command: 'bootstrap',
      mode,
      origin,
      realm_id: realmId,
      scope,
      session_id: principal.sessionId,
      base_name: principal.baseName,
      address: principal.address,
      locality,
      presence: selfRow.presence,
      nofile,
      ...(inviteDigestPrefix === null ? {} : { token_digest_prefix: inviteDigestPrefix.slice(0, 8) }),
      instructions,
    }

    if (flags.json) {
      return {
        status: 'ok',
        command: 'bootstrap',
        lines: [JSON.stringify(result)],
      }
    }

    const lines = [
      `agent-room bootstrap: ${principal.address} (${locality} ${selfRow.presence})`,
      `scope: ${scope}`,
      `realm: ${realmId} (${origin})`,
      `nofile: ${nofile.message}`,
      ...instructions.map(line => `  - ${line}`),
    ]
    return {
      status: 'ok',
      command: 'bootstrap',
      lines,
    }
  } catch (error) {
    return refusal(error?.code ?? 'request_failed', error?.message ?? String(error))
  }
}
