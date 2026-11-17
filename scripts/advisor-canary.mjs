#!/usr/bin/env node
// Read-only advisor-lane health canary. Probes each configured advisor seat with
// a one-word prompt via the installed tmux-teams acp-dispatch.mjs, classifies by
// outbox presence, and writes a machine-readable snapshot. Never mutates a lane's
// purpose beyond a trivial ping; no credentials or models beyond the four seats.
import { spawnSync } from 'node:child_process'
import { accessSync, constants as fsConstants, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const CONFIG = join(homedir(), '.zcode/cli/plugins/installed_plugins.json')
const TM_VERSION = '0.51.0'
// Documented seats only (model ids, never credentials).
export const SEATS = Object.freeze({
  codex: 'gpt-6.1-terra',
  claude: 'claude-fable-5',
  agy: 'gemini-4-hydrogen-high',
  oc: 'opencode/minimax-m3.1-flash-free',
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
function envFor(name, dispatch, cwd) {
  const model = SEATS[name]
  const path = `${homedir()}/.bun/bin:${homedir()}/.local/bin:${process.env.PATH ?? ''}`
  const base = { ...process.env, PATH: path, ACP_DISPATCH_BOOT_SEC: '3', ACP_DISPATCH_POLL_SEC: '1' }
  if (name === 'codex') {
    const codex = bin('codex')
    if (!codex) return null
    return { ...base, CODEX_PATH: codex, ACP_MODEL: model, ACP_EXPECT_MODEL: model }
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
    { env: base, encoding: 'utf8', timeout: 5000 })
  if (p.status !== 0) return null
  const out = {}
  for (const line of p.stdout.split('\n')) {
    const m = /^ACP_(CMD|EXECUTION_PROFILE)='(.*)'$/.exec(line.trim())
    if (m) out[`ACP_${m[1]}`] = m[2]
  }
  if (!out.ACP_CMD || !out.ACP_EXECUTION_PROFILE) return null
  return { ...base, ...out, ACP_MODEL: model, ACP_EXPECT_MODEL: model, ACP_PERMISSIONS: 'deny' }
}

// One lane: dispatch (bounded boot), then `wait` — exit 0 means outbox present.
function runLane(name, dispatch, cwd, brief, taskId) {
  const env = envFor(name, dispatch, cwd)
  if (!env) return 'down'
  const worker = name === 'oc' ? 'opencode' : name
  const d = spawnSync(process.execPath, [dispatch, worker, cwd, taskId, brief, '3'],
    { env, encoding: 'utf8', timeout: 4500 })
  if (d.status !== 0 && d.status !== 1) return 'down'
  const w = spawnSync(process.execPath, [dispatch, 'wait', cwd, taskId, '2'],
    { env, encoding: 'utf8', timeout: 3500 })
  return w.status === 0 ? 'ok' : 'down'
}

export async function main({ configPath = CONFIG, outDir = join(REPO, '_bmad-output/implementation-artifacts'),
  date = new Date().toISOString(), probe = null } = {}) {
  const dispatch = resolveDispatchPath(configPath)
  const cwd = mkdtempSync(join(tmpdir(), 'advisor-canary-'))
  const brief = join(cwd, 'brief.txt')
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
