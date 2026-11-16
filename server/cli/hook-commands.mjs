#!/usr/bin/env node
// Story 4.2 — the ONE lifecycle hook family: `agent-room hook <subcommand>`.
// Four subcommands, one stdin grammar, one fail-open path, one deadline.
//
//   session-start        write this scope's binding + CLAUDE_ENV_FILE export
//   user-prompt-submit   reset G1/G2 only for a genuine human prompt
//   post-tool-use        print a bounded, body-free unread summary (no writes)
//   stop                 block (exit 2) only on a real pending wake when this
//                        is not already a stop-hook retry; never loop
//
// FAIL-OPEN: malformed/oversize stdin, EOF, a non-boolean stop_hook_active when
// present, a network/IO stall past the budget, or any handler throw → exit 0
// with ONE redacted stderr line, ZERO reset, ZERO notified_seq advance, ZERO
// G1/G2 charge. Unknown subcommand → exit 2. Held bodies never reach stdout;
// no token or capability is ever printed. 0 npm dependencies.

import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

import {
  HOOK_STDIN_MAX_BYTES,
  HOOK_STDIN_TIMEOUT_MS,
  HOOK_TOTAL_BUDGET_MS,
} from '../constants.mjs'
import { instanceDataDirectory } from '../runtime.mjs'
import {
  hashHostSessionId,
  sessionScopeKey,
  writeScopeBinding,
} from '../client/session-state.mjs'
import {
  appendScopeToClaudeEnvFile,
} from './hook-session-start.mjs'
import {
  buildHookSummary,
  readHookWakeState,
  shouldResetOnHumanPrompt,
} from '../client/hook-wake-state.mjs'
import { createScopeLedger } from '../client/scope-ledger.mjs'

const HOOK_SUBCOMMANDS = Object.freeze([
  'session-start',
  'user-prompt-submit',
  'post-tool-use',
  'stop',
])

// --- bounded stdin (one implementation shared by all four hooks) -------------

export function readBoundedStdin(input = process.stdin, {
  maxBytes = HOOK_STDIN_MAX_BYTES,
  timeoutMs = HOOK_STDIN_TIMEOUT_MS,
} = {}) {
  return new Promise((resolvePromise) => {
    if (!input || input.isTTY || input.readableEnded) {
      resolvePromise({ text: '', reason: input?.readableEnded ? 'eof' : 'no_input' })
      return
    }
    const chunks = []
    let totalBytes = 0
    let settled = false
    const finish = (text, reason = null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.removeListener('data', onData)
      input.removeListener('end', onEnd)
      input.removeListener('error', onError)
      resolvePromise({ text, reason })
    }
    const timer = setTimeout(() => {
      try { input.pause?.() } catch { /* ignore */ }
      finish(Buffer.concat(chunks).toString('utf8'), 'timeout')
    }, timeoutMs)
    timer.unref?.()

    const onData = (chunk) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk), 'utf8')
      if (totalBytes + buf.length > maxBytes) {
        finish('', 'oversize')
        return
      }
      totalBytes += buf.length
      chunks.push(buf)
    }
    const onEnd = () => finish(Buffer.concat(chunks).toString('utf8'), null)
    const onError = () => finish('', 'io_error')

    input.on('data', onData)
    input.on('end', onEnd)
    input.on('error', onError)
    input.resume?.()
  })
}

// Parse the one stdin schema. Returns {ok:false, reason} on every fail-open
// trigger; the caller emits a single redacted diagnostic and exits 0.
export function parseHookPayload(text, { reason = null } = {}) {
  if (reason !== null) return { ok: false, reason }
  if (typeof text !== 'string' || text.trim().length === 0) return { ok: false, reason: 'empty_stdin' }
  let payload
  try { payload = JSON.parse(text) } catch { return { ok: false, reason: 'malformed_json' } }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, reason: 'invalid_shape' }
  // stop_hook_active is strict BOOLEAN when present (the Stop decision keys on
  // it). Claude omits it on the other three events; absence means false.
  if ('stop_hook_active' in payload && typeof payload.stop_hook_active !== 'boolean') {
    return { ok: false, reason: 'invalid_stop_hook_active' }
  }
  return { ok: true, payload }
}

// Diagnostics are FIXED reason codes only — never echo stdin, cwd, prompt, or
// any environment value, so a token/capability cannot leak to stderr.
const failOpen = reason => ({
  status: 'fail_open',
  exitCode: 0,
  stdout: [],
  stderr: [`[agent-room hook] fail-open (${reason}); no state changed`],
  reason,
})

function resolveScope(payload, { env, pluginDataDir, cwd }) {
  const effectiveCwd = typeof payload.cwd === 'string' && payload.cwd.length > 0 ? payload.cwd : cwd
  let explicitScope
  if (
    !env?.AGENT_ROOM_SESSION_SCOPE
    && !env?.CLAUDE_CODE_SESSION_ID
    && !env?.CLAUDE_SESSION_ID
    && typeof payload.session_id === 'string'
    && payload.session_id.length > 0
  ) {
    explicitScope = hashHostSessionId('claude', payload.session_id)
  }
  return {
    scope: sessionScopeKey({ explicitScope, env, pluginDataDir, cwd: effectiveCwd }),
    effectiveCwd,
  }
}

function effectivePluginData(pluginDataDir, env, cwd) {
  if (pluginDataDir) return pluginDataDir
  try { return instanceDataDirectory(env, cwd) } catch { return null }
}

// --- per-subcommand bodies ---------------------------------------------------

function sessionStart(payload, { env, pluginDataDir, cwd }) {
  const pdata = effectivePluginData(pluginDataDir, env, cwd)
  const { scope, effectiveCwd } = resolveScope(payload, { env, pluginDataDir: pdata, cwd })
  if (pdata) {
    try { writeScopeBinding({ pluginDataDir: pdata, scope, env, cwd: effectiveCwd }) } catch { /* fail-open */ }
  }
  if (typeof env?.CLAUDE_ENV_FILE === 'string' && env.CLAUDE_ENV_FILE.length > 0) {
    try { appendScopeToClaudeEnvFile(env.CLAUDE_ENV_FILE, scope) } catch { /* fail-open */ }
  }
  return { status: 'ok', exitCode: 0, stdout: [], stderr: [], scope }
}

function userPromptSubmit(payload, { env, pluginDataDir, cwd, state }) {
  if (state === null) {
    return { status: 'ok', exitCode: 0, stdout: [], stderr: [], reset: false, reason: 'no_recent_wake' }
  }
  const prompt = typeof payload.prompt === 'string' ? payload.prompt : ''
  if (!shouldResetOnHumanPrompt({
    prompt,
    lastWakeAtMs: state.lastWakeAtMs,
    nowMs: state.nowMs,
  })) {
    return { status: 'ok', exitCode: 0, stdout: [], stderr: [], reset: false, reason: 'grace_or_marker' }
  }
  // Reset G1/G2 via the ONE 3.2 ledger owner. notified_seq/suppressed_held_seq
  // are never touched. A busy ledger is a skip, not a block.
  let ledger
  try { ledger = createScopeLedger(pluginDataDir, state.scope) } catch {
    return { status: 'ok', exitCode: 0, stdout: [], stderr: [], reset: false, reason: 'ledger_unavailable' }
  }
  try {
    const result = ledger.reset({})
    const reset = result.status === 'ok'
    const diagnostics = ledger.drainDiagnostics()
    return {
      status: 'ok',
      exitCode: 0,
      stdout: [],
      stderr: diagnostics.length ? [diagnosticLine('ledger', diagnostics[0])] : [],
      reset,
    }
  } catch {
    return { status: 'ok', exitCode: 0, stdout: [], stderr: [], reset: false, reason: 'reset_failed' }
  } finally {
    try { ledger.close() } catch { /* ignore */ }
  }
}

function postToolUse(payload, { state }) {
  if (state === null) return { status: 'ok', exitCode: 0, stdout: [], stderr: [] }
  const lines = buildHookSummary(state)
  return { status: 'ok', exitCode: 0, stdout: lines, stderr: [] }
}

function stop(payload, { env, pluginDataDir, state }) {
  // The primary loop breaker: Claude sets stop_hook_active=true when it is
  // re-invoked after a Stop block. That must return immediately.
  if (payload.stop_hook_active === true) {
    return { status: 'ok', exitCode: 0, stdout: [], stderr: [], blocked: false, reason: 'active' }
  }
  if (state === null) {
    return { status: 'ok', exitCode: 0, stdout: [], stderr: [], blocked: false, reason: 'no_pending' }
  }

  let ledger
  try { ledger = createScopeLedger(pluginDataDir, state.scope) } catch {
    return failOpen('ledger_unavailable')
  }
  try {
    // HELD first: metadata-only, then suppress ONLY suppressed_held_seq so a
    // later Trusted row is never hidden and the same Held cannot re-block.
    if (state.heldEligible.length > 0) {
      for (const entry of state.heldEligible) {
        ledger.suppressHeld({ roomId: entry.room_id, seq: entry.seq })
      }
      const lines = buildHookSummary(state)
      return {
        status: 'blocked',
        exitCode: 2,
        stdout: lines.length ? lines : ['[agent-room] pending held messages (body withheld)'],
        stderr: [],
        blocked: true,
        kind: 'held',
      }
    }

    // TRUSTED: 2-phase lease (Phase A reserve = position + lease + G1/G2 guard).
    // A paused/busy/skip guard result means do NOT block — a hard-paused loop
    // must never hold the turn. notified_seq is NOT advanced by the hook: the
    // real read path owns it.
    for (const entry of state.eligibleTrusted) {
      const reservation = ledger.reserve({
        realmId: entry.realmId ?? state.scope,
        roomId: entry.room_id,
        seq: entry.seq,
        local: state.scope,
        peer: entry.from || 'unknown',
      })
      if (reservation.status === 'reserved') {
        const lines = buildHookSummary(state)
        return {
          status: 'blocked',
          exitCode: 2,
          stdout: lines.length ? lines : [`[agent-room] unread trusted message room ${entry.room_id} seq ${entry.seq}`],
          stderr: [],
          blocked: true,
          kind: 'trusted',
          verdict: reservation.verdict,
        }
      }
    }
    return { status: 'ok', exitCode: 0, stdout: [], stderr: [], blocked: false, reason: 'guard_declined' }
  } catch {
    return failOpen('stop_handler_failed')
  } finally {
    try { ledger.close() } catch { /* ignore */ }
  }
}

function diagnosticLine(prefix, detail) {
  // detail from the ledger is already bounded text; fold control chars so a
  // hostile path cannot inject terminal sequences.
  const safe = String(detail ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300)
  return `[agent-room hook] ${prefix}: ${safe}`
}

// --- the family entrypoint ----------------------------------------------------

export async function runHookCommand(subcommand, {
  input = process.stdin,
  env = process.env,
  cwd = process.cwd(),
  pluginDataDir,
  now = () => Date.now(),
  inboxPath = null,
  hooks = HOOK_HANDLERS,
} = {}) {
  if (!HOOK_SUBCOMMANDS.includes(subcommand)) {
    return {
      status: 'usage',
      exitCode: 2,
      stdout: [],
      stderr: [`[agent-room hook] unknown subcommand "${String(subcommand)}"; expected one of ${HOOK_SUBCOMMANDS.join(', ')}`],
    }
  }
  const startedMs = now()
  const stdinResult = await readBoundedStdin(input)
  const parsed = parseHookPayload(stdinResult.text, { reason: stdinResult.reason })
  if (!parsed.ok) return failOpen(parsed.reason)

  const payload = parsed.payload
  const pdata = effectivePluginData(pluginDataDir, env, cwd)
  if (pdata === null) return failOpen('no_plugin_data')

  // Deadline: reads below are bounded; writes are gated on the remaining budget
  // so a stall can never spend past HOOK_TOTAL_BUDGET_MS mutating state.
  const onBudget = () => (now() - startedMs) <= HOOK_TOTAL_BUDGET_MS
  const handler = hooks[subcommand]
  try {
    if (subcommand === 'session-start') {
      if (!onBudget()) return failOpen('budget_exceeded')
      return handler(payload, { env, pluginDataDir: pdata, cwd })
    }

    const { scope, effectiveCwd } = resolveScope(payload, { env, pluginDataDir: pdata, cwd })
    void effectiveCwd
    let wakeState = null
    try {
      const raw = readHookWakeState({ pluginDataDir: pdata, scope, nowMs: now(), inboxPath })
      wakeState = {
        ...raw,
        scope,
        lastWakeAtMs: raw.lastWakeAtMs,
        nowMs: raw.nowMs,
      }
    } catch {
      return failOpen('state_read_failed')
    }
    if (!onBudget()) return failOpen('budget_exceeded')
    return handler(payload, { env, pluginDataDir: pdata, cwd, state: wakeState })
  } catch {
    return failOpen('handler_failed')
  }
}

const HOOK_HANDLERS = Object.freeze({
  'session-start': sessionStart,
  'user-prompt-submit': userPromptSubmit,
  'post-tool-use': postToolUse,
  stop,
})

// Direct launch: `node hook-commands.mjs <subcommand>` (hooks.json passes the
// subcommand as argv[2]). Unknown/missing subcommand exits 2; every other path
// sets its own exit code from the outcome.
function launchedDirectly() {
  if (!process.argv[1]) return false
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}

if (launchedDirectly()) {
  runHookCommand(process.argv[2])
    .then((outcome) => {
      for (const line of outcome.stdout ?? []) process.stdout.write(`${line}\n`)
      for (const line of outcome.stderr ?? []) process.stderr.write(`${line}\n`)
      process.exitCode = outcome.exitCode ?? 0
    })
    .catch(() => { process.exitCode = 0 })
}
