#!/usr/bin/env node
// Read-only advisor-lane health canary. Probes each configured advisor seat with
// a one-word prompt via the installed tmux-teams acp-dispatch.mjs, classifies by
// outbox presence, and writes a machine-readable snapshot. Never mutates a lane's
// purpose beyond a trivial ping; no credentials or models beyond the four seats.
//
// BUDGET — this is NOT a 14-second smoke test. Real AGY boot on this host reaches
// ~4.5 min and a full prompt round takes minutes, so the old 3s-boot/2s-wait
// values failed closed on healthy lanes. Each lane now gets CANARY_BOOT_SEC
// (120s, adapter boot + identity ack) plus CANARY_WAIT_SEC (180s, outbox/prompt):
// ~5 min bounded budget PER LANE (the old 3s boot / 2s wait could not see a
// working lane). Lanes are probed sequentially; refusals fail fast, so a healthy
// run is usually far shorter than the theoretical bound. Still a canary, not a
// review. Explicit refusals (no executable, invalid config, identity mismatch)
// remain fast-fail.
// Run state is written under the repo (override with CANARY_CWD) so logs at
// <cwd>/.tmux-teams/runner-logs/canary-* stay inspectable. Outbox files are an
// accepted side effect of a canary run.
import { spawnSync } from 'node:child_process'
import { accessSync, constants as fsConstants, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG = join(homedir(), '.zcode/cli/plugins/installed_plugins.json')
const TM_VERSION = '0.51.0'
// Realistic, bounded observation window for ONE lane. See header: never shrink
// these to "make the canary fast" — that recreates the false negative.
export const CANARY_BOOT_SEC = 120
export const CANARY_WAIT_SEC = 180
// A cold opencode execution-profile run reaches ~4.8s+ and occasionally exceeds
// a 5s cap, classifying oc down before any dispatch. Only the profile producer
// gets this budget; dispatch/wait budgets above stay unchanged.
export const CANARY_PROFILE_TIMEOUT_MS = 30_000
// The companion's inactivity lease must outlive the whole window, or a slow
// boot cancels itself before it can write an outbox. Poll modestly. Spawn wall
// clocks get a small margin over the dispatcher's reporting bounds so a local
// timeout is not mistaken for a lane failure.
const CANARY_STALL_SEC = CANARY_BOOT_SEC + CANARY_WAIT_SEC
const CANARY_POLL_SEC = 5
const SPAWN_MARGIN_SEC = 15
// Run workspace: default to the repo so runner logs stay inspectable; the env
// override lets an operator redirect the side-effect outbox/logs elsewhere.
export function resolveCanaryCwd(env = process.env) { return resolve(env.CANARY_CWD || REPO) }

// Documented seats only (model ids, never credentials).
export const SEATS = Object.freeze({
  codex: 'gpt-6.1-terra',
  claude: 'claude-fable-5',
  agy: 'gemini-4-hydrogen-high',
  oc: 'opencode/deepseek-v4.1-flash-free',
})

export function resolveDispatchPath(configPath = CONFIG) {
  const cfg = JSON.parse(readFileSync(configPath, 'utf8'))
  const plugin = (cfg.plugins ?? []).find(p => p.name === 'tmux-teams' && p.version === TM_VERSION)
  if (!plugin?.installPath) throw new Error(`tmux-teams ${TM_VERSION} not installed in ${configPath}`)
  return join(plugin.installPath, 'skills/tmux-teams/scripts/acp-dispatch.mjs')
}

// Pure snapshot builder — the test stubs the dispatcher through collect().
export function makeSnapshot(lanes, date = new Date().toISOString()) {
  const familiesOk = Object.values(lanes).filter(v => v === 'ok').length
  return { date, lanes, families_ok: familiesOk }
}
export const passes = (snapshot) => snapshot.families_ok >= 2

export async function collect(probe, names = Object.keys(SEATS), date) {
  const lanes = {}
  for (const name of names) lanes[name] = (await probe(name)) === 'ok' ? 'ok' : 'down'
  return makeSnapshot(lanes, date)
}

function bin(name) {
  for (const dir of (process.env.PATH ?? '').split(':')) {
    const p = join(dir, name)
    try { accessSync(p, fsConstants.X_OK); return p } catch { /* keep looking */ }
  }
  return null
}
// npm-global codex (fresh) beats the PATH-first ~/.local/bin/codex symlink,
// which points at an older pinned copy and trips execution_profile_drift.
export const NPM_GLOBAL_CODEX = '/opt/homebrew/bin/codex'
export const NPM_GLOBAL_BIN_DIR = '/opt/homebrew/bin'
// Pure selector: prefer the npm-global candidate, resolve via realpath (the
// codex-advisor recipe uses `realpath "$(command -v codex)"`). Injectable rp.
export function selectCodexPath(npmGlobal, fallback, rp = realpathSync) {
  const chosen = npmGlobal || fallback
  if (!chosen) return null
  try { return rp(chosen) } catch { return chosen }
}

function envFor(name, dispatch, cwd) {
  const model = SEATS[name]
  const path = `${homedir()}/.bun/bin:${homedir()}/.local/bin:${process.env.PATH ?? ''}`
  const base = {
    ...process.env,
    PATH: path,
    ACP_DISPATCH_BOOT_SEC: String(CANARY_BOOT_SEC),
    ACP_DISPATCH_POLL_SEC: String(CANARY_POLL_SEC),
  }
  if (name === 'codex') {
    const npmGlobal = existsSync(NPM_GLOBAL_CODEX) ? NPM_GLOBAL_CODEX : null
    const fallback = bin('codex')
    const codex = selectCodexPath(npmGlobal, fallback)
    if (!codex) return null
    // The companion re-resolves `which codex` from its inherited PATH and
    // compares it to CODEX_PATH; keep both on the same (fresh) binary.
    const codexPath = npmGlobal ? `${NPM_GLOBAL_BIN_DIR}:${path}` : path
    return { ...base, PATH: codexPath, CODEX_PATH: codex, ACP_MODEL: model, ACP_EXPECT_MODEL: model }
  }
  if (name === 'claude') return { ...base, ANTHROPIC_MODEL: model, ACP_EXPECT_MODEL: model }
  if (name === 'agy') {
    const agy = `${homedir()}/.local/bin/agy`
    if (!existsSync(agy)) return null
    return { ...base, AGY_BIN: agy, AGY_SKIP_DOWNLOAD: '1', ACP_MODEL: model, ACP_EXPECT_MODEL: model }
  }
  // oc: generate the pinned execution profile; without it receipt mode cannot run.
  const producer = join(dispatch, '..', 'opencode-execution-profile.mjs')
  const p = spawnSync(process.execPath, [producer, join(cwd, '.tmux-teams', 'opencode-execution-profile.json')],
    { env: base, encoding: 'utf8', timeout: CANARY_PROFILE_TIMEOUT_MS })
  if (p.status !== 0) return null
  const out = {}
  for (const line of p.stdout.split('\n')) {
    const m = /^ACP_(CMD|EXECUTION_PROFILE)='(.*)'$/.exec(line.trim())
    if (m) out[`ACP_${m[1]}`] = m[2]
  }
  if (!out.ACP_CMD || !out.ACP_EXECUTION_PROFILE) return null
  return { ...base, ...out, ACP_MODEL: model, ACP_EXPECT_MODEL: model, ACP_PERMISSIONS: 'deny' }
}

// Pure classification of a probe. Dispatch exit 2 is an EXPLICIT refusal
// (config-option-invalid / identity mismatch / usage) and wins fast. Wait exit 0
// means the outbox exists AND the turn ended. Every other wait outcome — 1 still
// running after the full CANARY_WAIT_SEC, 2 ended with no outbox, null = the
// bounded watch timed out — is down ONLY because the whole budget elapsed.
export function classifyLane(dispatchStatus, waitStatus) {
  if (dispatchStatus === 2) return 'down'
  return waitStatus === 0 ? 'ok' : 'down'
}

// One lane: dispatch (bounded boot), then `wait` (bounded outbox observation).
function runLane(name, dispatch, cwd, brief, taskId) {
  const env = envFor(name, dispatch, cwd)
  if (!env) return 'down' // fast-fail: no executable / config unavailable
  const worker = name === 'oc' ? 'opencode' : name
  // Pass the full window as the companion's inactivity lease so a slow boot is
  // not cancelled before it can write an outbox. Boot exit 0 = acknowledged,
  // 1 = still booting (lane RUNNING), null = our spawn cap fired but the lane
  // detached into its own process group and may still be alive: all proceed.
  const d = spawnSync(process.execPath, [dispatch, worker, cwd, taskId, brief, String(CANARY_STALL_SEC)],
    { env, encoding: 'utf8', timeout: (CANARY_BOOT_SEC + SPAWN_MARGIN_SEC) * 1000 })
  // Explicit refusal -> fail fast; do not spend the wait budget on a lane that
  // never started. Also covers a truly absent dispatch (status null, no error
  // path) — but a running lane (0/1/null-timeout) still gets its full wait.
  if (d.status === 2) return classifyLane(d.status, null)
  const w = spawnSync(process.execPath, [dispatch, 'wait', cwd, taskId, String(CANARY_WAIT_SEC)],
    { env, encoding: 'utf8', timeout: (CANARY_WAIT_SEC + SPAWN_MARGIN_SEC) * 1000 })
  return classifyLane(d.status, w.status)
}

export async function main({ configPath = CONFIG, outDir = join(REPO, '_bmad-output/implementation-artifacts'),
  date = new Date().toISOString(), probe = null } = {}) {
  const dispatch = resolveDispatchPath(configPath)
  const cwd = resolveCanaryCwd()
  mkdirSync(cwd, { recursive: true })
  const brief = join(cwd, '.tmux-teams', 'canary-brief.txt')
  mkdirSync(dirname(brief), { recursive: true })
  writeFileSync(brief, 'ping\n')
  const actualProbe = probe ?? ((name) => runLane(name, dispatch, cwd, brief, `canary-${name}-${Date.now()}`))
  const snapshot = await collect(actualProbe, Object.keys(SEATS), date)
  mkdirSync(outDir, { recursive: true, mode: 0o700 })
  writeFileSync(join(outDir, 'advisor-canary.json'), `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 })
  return passes(snapshot) ? 0 : 1
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code })
    .catch(err => { console.error(err?.message ?? String(err)); process.exitCode = 1 })
}
