#!/usr/bin/env node
// REL-1 Operator Flight Kit — per-machine preflight validator (Epic 6, Story 6.1
// prep; docs/implementation/reviews/epic-6-execution-agy.md Phase 3).
//
// A READ-ONLY environment and reachability validator run on each machine before
// the physical two-machine demo. It never creates, rewrites, or signs anything:
// no keypair is born here, no token is minted here, no state changes anywhere.
// Every failure prints one color-coded [FAIL] line naming the exact remediation;
// the process exits 0 only when every gating check passes.
//
// Usage:
//   node scripts/rel1-preflight.mjs --server <https-origin> --role <server|claude|zcode>
//        [--plugin-root <installed-package-dir>] [--plugin-data <client-data-dir>]
//        [--data-dir <server-data-dir>] [--json <report-path>]
//
// Roles:
//   server  — this host runs the Room Server: dedicated data dir, healthy
//             runtime.json (live pid), GET /health answering, and (REPORT ONLY,
//             never gating) the candidate record's provenance versus this tree.
//   claude  — this host runs the real Claude Code client: runtime floor, HTTPS
//             reachability of the LAN origin, the `claude` binary, this
//             installation's Ed25519 Actor keypair, and the installed candidate
//             artifact's tree digest against the frozen v0.2.0 record.
//   zcode   — same as claude with the `zcode` binary.
//
// Exit codes: 0 every gating check passed; 1 at least one gating check failed;
// 2 usage error.

import { execFile, spawnSync } from 'node:child_process'
import {
  createHash,
  createPrivateKey,
  createPublicKey,
} from 'node:crypto'
import { accessSync, constants as fsConstants, existsSync, lstatSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { hostname, platform, arch } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

import {
  APP_VERSION,
  AgentRoomRuntimeError,
  assertSupportedRuntime,
  atomicWriteJson,
  instanceDataDirectory,
  sharedDataDirectory,
} from '../server/runtime.mjs'

const execFileAsync = promisify(execFile)

const KIT = 'rel1-preflight'
const REPORT_SCHEMA_VERSION = 1
const HEALTH_TIMEOUT_MS = 10_000
const VENDOR_CLI_TIMEOUT_MS = 15_000
const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', '[::1]', 'localhost'])
const ROLE_SERVER = 'server'
const ROLES = new Set([ROLE_SERVER, 'claude', 'zcode'])
const KEYPAIR_FILENAME = 'identity.key'
const KEYPAIR_FILE_MAX_BYTES = 4096

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const candidateRecordPath = join(repoRoot, 'docs', 'release-evidence', 'v0.2.0-candidate.json')

// --- terminal helpers ---------------------------------------------------------

const colorize = process.stdout.isTTY && !process.env.NO_COLOR
const paint = colorize
  ? { green: s => `\u001B[32m${s}\u001B[0m`, red: s => `\u001B[31m${s}\u001B[0m`, yellow: s => `\u001B[33m${s}\u001B[0m`, dim: s => `\u001B[2m${s}\u001B[0m`, bold: s => `\u001B[1m${s}\u001B[0m` }
  : { green: s => s, red: s => s, yellow: s => s, dim: s => s, bold: s => s }

function say(line) {
  process.stdout.write(`${line}\n`)
}

const USAGE_LINES = [
  `usage: node scripts/rel1-preflight.mjs --server <https-origin> --role <${[...ROLES].join('|')}>`,
  '       [--plugin-root <installed-package-dir>] [--plugin-data <client-data-dir>]',
  '       [--data-dir <server-data-dir>] [--json <report-path>]',
  '',
  '  --server       the Room Server origin (https://<lan-ip>:<port>). Required for',
  '                 roles claude/zcode; optional for role server (defaults to the',
  '                 loopback health endpoint of the recorded runtime.json port).',
  '  --role         which machine this run validates: server, claude, or zcode.',
  '  --plugin-root  the installed materialized package directory whose tree digest',
  '                 must match the frozen candidate (roles claude/zcode).',
  '  --plugin-data  the installation data dir holding identity.key (roles',
  '                 claude/zcode; default $PLUGIN_DATA / $CLAUDE_PLUGIN_DATA, else',
  '                 ~/.agent-room/client-data/manual).',
  '  --data-dir     the server shared data dir (role server; default',
  '                 $AGENT_ROOM_DATA_DIR, else ~/.agent-room).',
  '  --json         also write the machine-readable report to this path (0600);',
  '                 save both reports as REL-1 evidence (preflight-claude.json /',
  '                 preflight-zcode.json).',
  '',
  'Exit codes: 0 all gating checks pass; 1 a gating check failed; 2 usage.',
]

function printUsage(stream) {
  stream.write(`${USAGE_LINES.join('\n')}\n`)
}

function usageExit(message) {
  if (message) process.stderr.write(`${KIT}: ${message}\n`)
  printUsage(process.stderr)
  process.exit(2)
}

function parseArgv(argv) {
  const options = { role: undefined, server: undefined, pluginRoot: undefined, pluginData: undefined, dataDir: undefined, json: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    const wantsValue = () => {
      if (value === undefined || value.startsWith('--')) usageExit(`flag ${flag} requires a value`)
      index += 1
      return value
    }
    if (flag === '--help' || flag === '-h') {
      printUsage(process.stdout)
      process.exit(0)
    } else if (flag === '--role') {
      options.role = wantsValue()
    } else if (flag === '--server') {
      options.server = wantsValue()
    } else if (flag === '--plugin-root') {
      options.pluginRoot = wantsValue()
    } else if (flag === '--plugin-data') {
      options.pluginData = wantsValue()
    } else if (flag === '--data-dir') {
      options.dataDir = wantsValue()
    } else if (flag === '--json') {
      options.json = wantsValue()
    } else {
      usageExit(`unknown argument "${flag}"`)
    }
  }
  if (options.role === undefined) usageExit('--role is required (server, claude, or zcode)')
  if (!ROLES.has(options.role)) usageExit(`--role must be one of: ${[...ROLES].join(', ')}`)
  for (const [name, value] of Object.entries(options)) {
    if (name !== 'role' && value !== undefined && value.trim().length === 0) {
      usageExit(`--${name.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)} must not be empty`)
    }
  }
  return options
}

// --- check machinery ----------------------------------------------------------

const CHECK = {
  pass: (detail) => ({ status: 'pass', detail }),
  fail: (detail) => ({ status: 'fail', detail }),
  warn: (detail) => ({ status: 'warn', detail }),
}

function printCheck(check) {
  const badge = check.status === 'pass'
    ? paint.green('[PASS]')
    : check.status === 'fail'
      ? paint.red('[FAIL]')
      : paint.yellow('[WARN]')
  const gating = check.gating ? '' : paint.dim(' (report only — does not gate)')
  say(`${badge} ${check.id} ${check.title}${gating}`)
  say(`       ${check.detail}`)
}

// --- shared primitives --------------------------------------------------------

function loadCandidateRecord() {
  if (!existsSync(candidateRecordPath)) {
    throw new AgentRoomRuntimeError(
      'candidate_record_missing',
      `the frozen candidate record is missing at ${candidateRecordPath}; run this script from a checkout of the pinned repository`,
    )
  }
  return JSON.parse(readFileSync(candidateRecordPath, 'utf8'))
}

// The exact digest algorithm the frozen record pins (tests/release-smoke.test.mjs,
// treeDigest): every regular file, path-sorted, folded as hex(sha256(relative
// path)) + '\n' + hex(sha256(bytes)) + '\n'. No metadata enters the digest.
function treeDigest(root, relativePath = '', ledger = { files: 0, bytes: 0, fold: createHash('sha256') }) {
  const absolutePath = relativePath.length === 0 ? root : join(root, relativePath)
  const info = lstatSync(absolutePath)
  if (info.isSymbolicLink()) {
    throw new AgentRoomRuntimeError('artifact_symlink', `artifact contains a symlink: ${relativePath}`)
  }
  if (info.isDirectory()) {
    for (const name of readdirSync(absolutePath).sort((left, right) => left.localeCompare(right))) {
      const childRelative = relativePath.length === 0 ? name : join(relativePath, name)
      treeDigest(root, childRelative, ledger)
    }
    return ledger
  }
  if (!info.isFile()) {
    throw new AgentRoomRuntimeError('artifact_non_regular', `artifact contains a non-regular file: ${relativePath}`)
  }
  const bytes = readFileSync(absolutePath)
  ledger.files += 1
  ledger.bytes += bytes.length
  ledger.fold.update(`${createHash('sha256').update(relativePath).digest('hex')}\n`)
  ledger.fold.update(`${createHash('sha256').update(bytes).digest('hex')}\n`)
  return ledger
}

// Read-only keypair inspection: the same canonical fingerprint the server derives
// (sha256 over the RAW 32-byte Ed25519 public key), computed WITHOUT creating or
// rewriting anything. Refuses symlinks and non-owner-only files like the runtime
// reader does.
function inspectActorKeypair(pluginDataDir) {
  const path = join(pluginDataDir, KEYPAIR_FILENAME)
  if (!existsSync(path)) {
    return CHECK.fail(
      `no installation keypair at ${path}. Remediation: the keypair is born on first enrollment — run ` +
      `"node <plugin-root>/server/cli/agent-room.mjs remote set <origin>" then "… remote enroll <token>" with ` +
      `PLUGIN_DATA pointing at THIS directory (runbook §2), then re-run this preflight.`,
    )
  }
  const info = lstatSync(path)
  if (info.isSymbolicLink() || !info.isFile()) {
    return CHECK.fail(`${path} is not a regular file (symlink refusal). Remediation: remove it and re-run the enrollment step; never hand-place key material.`)
  }
  if (info.size < 1 || info.size > KEYPAIR_FILE_MAX_BYTES) {
    return CHECK.fail(`${path} is not a bounded regular file (${info.size} bytes). Remediation: remove it and re-run the enrollment step.`)
  }
  const mode = info.mode & 0o777
  if (mode !== 0o600) {
    return CHECK.fail(
      `${path} is ${mode.toString(8)}, not owner-only 600. Remediation: chmod 600 "${path}" — ` +
      `Actor private keys are 0600 by policy; a loosened key file is a real exposure.`,
    )
  }
  let privateKey
  try {
    privateKey = createPrivateKey(readFileSync(path, 'utf8'))
  } catch {
    return CHECK.fail(`${path} is not valid private key material. Remediation: remove it and re-run the enrollment step (a fresh keypair is born).`)
  }
  if (privateKey.asymmetricKeyType !== 'ed25519') {
    return CHECK.fail(`${path} is not an Ed25519 key. Remediation: remove it and re-run the enrollment step.`)
  }
  const spki = createPublicKey(privateKey).export({ type: 'spki', format: 'der' })
  const fingerprint = `sha256:${createHash('sha256').update(spki.subarray(-32)).digest('hex')}`
  return { status: 'pass', detail: `Actor fingerprint ${fingerprint} (${path}, 0600)`, fingerprint }
}

async function fetchHealth(origin) {
  const response = await fetch(`${new URL(origin).origin}/health`, { signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS) })
  const body = await response.json()
  if (!response.ok || body?.ok !== true || typeof body?.result?.version !== 'string') {
    throw new AgentRoomRuntimeError('health_unexpected', `GET /health answered HTTP ${response.status} without the expected {"ok":true,"result":{"version"}} envelope`)
  }
  return { version: body.result.version, status: response.status }
}

function tlsRemediation(error) {
  const code = error?.cause?.code ?? error?.code ?? ''
  const message = error?.cause?.message ?? error?.message ?? String(error)
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return `the hostname did not resolve (${code}). Remediation: use the server's LAN address origin (on the server host: "ipconfig getifaddr en0" on macOS, "hostname -I" on Linux) and confirm both machines are on the same network.`
  }
  if (code === 'ECONNREFUSED') {
    return `the port refused the connection (${code}). Remediation: confirm the server process is up and AGENT_ROOM_PORT matches the origin's port.`
  }
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') {
    return `the connection timed out. Remediation: confirm both machines share the network, the server binds the LAN interface (AGENT_ROOM_HOST), and no firewall blocks the port.`
  }
  if (code === 'CERT_HAS_EXPIRED' || code === 'CERT_NOT_YET_VALID') {
    return `the TLS certificate is outside its validity window (${code}). Remediation: reissue the certificate chain covering the LAN hostname (runbook §1); clients never bypass verification.`
  }
  if (code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || code === 'SELF_SIGNED_CERT_IN_CHAIN' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY') {
    return `the TLS chain did not verify against this machine's trust store (${code}). Remediation: install the demo CA into the system trust store (mkcert -install) AND export NODE_EXTRA_CA_CERTS=<root-ca.pem> in this shell — Node keeps its own store; both machines need the same CA. Never bypass verification.`
  }
  if (code === 'ERR_TLS_CERT_ALTNAME_INVALID' || code === 'HostnameMismatch') {
    return `the certificate does not cover the hostname (${code}). Remediation: reissue the certificate naming the LAN address used in the origin (mkcert <lan-ip>).`
  }
  return `TLS/HTTP failure: ${message}. Remediation: confirm the origin is the https:// LAN origin from runbook §1 and that the server is up ("curl -s <origin>/health").`
}

function findExecutableInPath(name) {
  const pathValue = process.env.PATH ?? ''
  for (const directory of pathValue.split(':')) {
    if (directory.length === 0) continue
    const candidatePath = join(directory, name)
    try {
      accessSync(candidatePath, fsConstants.X_OK)
      if (statSync(candidatePath).isFile()) return candidatePath
    } catch {
      // not here; keep scanning PATH
    }
  }
  return null
}

// --- role: server -------------------------------------------------------------

function buildServerChecks(options, runtimeFloor) {
  const checks = []
  const dataDir = resolve(options.dataDir ?? sharedDataDirectory())

  checks.push({ id: 'RT', title: 'runtime floor (Node >= 24.15, bundled SQLite >= 3.51.3)', gating: true, ...runtimeFloor })

  const dataDirInfo = (() => {
    if (!existsSync(dataDir)) {
      return CHECK.fail(
        `the shared data dir ${dataDir} does not exist. Remediation: create a DEDICATED directory for this realm ` +
        `and export AGENT_ROOM_DATA_DIR=<absolute-path> before launching the server (a public realm and the local ` +
        `auto-start server must never share one data dir — runbook §1).`,
      )
    }
    const info = lstatSync(dataDir)
    if (info.isSymbolicLink() || !info.isDirectory()) {
      return CHECK.fail(`${dataDir} is not a real directory. Remediation: point AGENT_ROOM_DATA_DIR at a real dedicated directory (symlinks are refused).`)
    }
    const mode = info.mode & 0o777
    if (mode !== 0o700) {
      return CHECK.warn(`${dataDir} is mode ${mode.toString(8)}, not owner-only 700. Remediation: chmod 700 "${dataDir}". (The server re-tightens its own state; the loosened directory itself is an operator exposure.)`)
    }
    return CHECK.pass(`${dataDir} exists, real directory, mode 700`)
  })()
  checks.push({ id: 'DD', title: 'dedicated data directory', gating: true, ...dataDirInfo })

  const runtimeRecord = (() => {
    const path = join(dataDir, 'runtime.json')
    if (!existsSync(path)) {
      return CHECK.fail(
        `no runtime.json in ${dataDir}. Remediation: launch the pinned server (runbook §1: ` +
        `"node <plugin-root>/server/api/server.mjs" with AGENT_ROOM_DATA_DIR/HOST/PORT/TLS_* set); the record is ` +
        `written only after the listener is live, so its absence means the server never came up.`,
      )
    }
    let record
    try {
      record = JSON.parse(readFileSync(path, 'utf8'))
    } catch {
      return CHECK.fail(`${path} is not valid JSON. Remediation: stop any server process for this data dir, remove the stale record, and start again.`)
    }
    if (typeof record?.pid !== 'number' || typeof record?.port !== 'number' || typeof record?.version !== 'string') {
      return CHECK.fail(`${path} lacks {pid, port, version}. Remediation: stop the server, remove the stale record, start again.`)
    }
    try {
      process.kill(record.pid, 0)
    } catch (error) {
      if (error?.code === 'EPERM') {
        // Not ours to signal, but alive.
      } else {
        return CHECK.fail(
          `runtime.json names pid ${record.pid}, which is not running (stale record). Remediation: the server exited — ` +
          `read its stderr line, fix the cause, remove ${path} if the next start does not overwrite it, and start again.`,
        )
      }
    }
    return { status: 'pass', detail: `runtime.json healthy: pid ${record.pid} alive, port ${record.port}, version ${record.version}`, record }
  })()
  checks.push({ id: 'RR', title: 'runtime.json healthy (live pid, port, version)', gating: true, ...runtimeRecord })

  const healthOrigin = options.server ?? (runtimeRecord.record ? `http://127.0.0.1:${runtimeRecord.record.port}` : null)
  const healthEnabled = runtimeRecord.status === 'pass' && Boolean(healthOrigin)
  const healthCheck = {
    id: 'HP',
    title: `GET /health answers${healthOrigin ? ` (${healthOrigin})` : ''}`,
    gating: true,
    status: 'fail',
    detail: healthEnabled
      ? 'probing…'
      : 'skipped: no healthy runtime.json and no --server origin. Remediation: start the server first (runbook §1).',
  }
  checks.push(healthCheck)

  // Provenance is REPORT ONLY per the agy consensus ("report, don't gate hard").
  const provenance = (() => {
    let record
    try {
      record = loadCandidateRecord()
    } catch (error) {
      return CHECK.warn(`candidate provenance not checkable: ${error.message}`)
    }
    const expectedCommit = record?.source?.git_commit
    const lines = [`candidate ${record?.candidate} frozen at commit ${expectedCommit}`]
    const gitProbe = spawnSync('git', ['-C', repoRoot, 'rev-parse', 'HEAD'], { encoding: 'utf8' })
    if (gitProbe.status === 0) {
      const head = gitProbe.stdout.trim()
      lines.push(head === expectedCommit
        ? `this checkout's HEAD matches the frozen commit (${head})`
        : `MISMATCH: this checkout's HEAD is ${head}, the frozen commit is ${expectedCommit} — verify you are demonstrating the pinned tree`)
    } else {
      lines.push('git metadata unavailable in this checkout — verify the pinned commit manually (report only)')
    }
    const manifestPath = join(repoRoot, 'plugin.json')
    if (existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
        lines.push(manifest.version === APP_VERSION
          ? `plugin manifest version ${manifest.version} matches the running server build (${APP_VERSION})`
          : `MISMATCH: plugin manifest version ${manifest.version} vs running build ${APP_VERSION}`)
      } catch {
        lines.push('plugin.json unreadable — version provenance not comparable (report only)')
      }
    }
    const artifacts = record?.artifacts
    if (artifacts?.portable?.sha256 && artifacts?.claude_code?.sha256) {
      lines.push(`pinned artifact digests: portable ${artifacts.portable.sha256.slice(0, 16)}…, claude_code ${artifacts.claude_code.sha256.slice(0, 16)}…`)
    }
    return CHECK.warn(lines.join('; '))
  })()
  checks.push({ id: 'PV', title: 'candidate provenance', gating: false, ...provenance })

  return { checks, healthProbe: { origin: healthOrigin, enabled: healthEnabled, record: runtimeRecord.record ?? null, check: healthCheck, defaultLoopback: !options.server && Boolean(healthOrigin) } }
}

// --- role: claude / zcode -----------------------------------------------------

function buildClientChecks(options, runtimeFloor) {
  const checks = []
  const vendor = options.role === 'claude' ? 'claude' : 'zcode'
  const pluginData = resolve(options.pluginData ?? instanceDataDirectory())
  const report = { pluginData }

  checks.push({ id: 'RT', title: 'runtime floor (Node >= 24.15, bundled SQLite >= 3.51.3)', gating: true, ...runtimeFloor })

  const origin = (() => {
    if (!options.server) {
      return CHECK.fail(
        '--server is required for this role. Remediation: re-run with the LAN https origin recorded in runbook §1, ' +
        'e.g. --server https://192.168.1.20:8443',
      )
    }
    let parsed
    try {
      parsed = new URL(options.server)
    } catch {
      return CHECK.fail(`"${options.server}" is not a valid URL. Remediation: pass the bare origin, e.g. https://<lan-ip>:<port>.`)
    }
    if (parsed.protocol !== 'https:') {
      return CHECK.fail(`the origin must be https:// (got ${parsed.protocol}). Remediation: remote clients refuse plaintext by design; use the TLS origin from runbook §1.`)
    }
    if (parsed.pathname !== '/' && parsed.pathname !== '') {
      return CHECK.fail('the origin must be the bare https://host[:port] with no path. Remediation: drop the path — the client joins API paths onto this base.')
    }
    if (LOOPBACK_HOSTS.has(parsed.hostname)) {
      return CHECK.fail(
        `the origin ${parsed.origin} is loopback. REL-1 is the PHYSICAL two-machine demonstration; a loopback origin ` +
        `is exactly the simulated topology this gate exists to prevent. Remediation: use the server's LAN address origin.`,
      )
    }
    return { status: 'pass', detail: `origin ${parsed.origin} is https and non-loopback (${parsed.hostname})`, origin: parsed.origin }
  })()
  checks.push({ id: 'SU', title: 'server origin is the LAN https origin', gating: true, ...origin })

  checks.push({
    id: 'RC',
    title: `HTTPS reachability + GET /health${origin.origin ? ` (${origin.origin})` : ''}`,
    gating: true,
    status: 'fail',
    detail: origin.status === 'pass' ? 'probing…' : 'skipped: no valid origin. Remediation: pass a valid --server https origin.',
  })
  const reachability = { enabled: origin.status === 'pass', origin: origin.origin ?? null, check: checks[checks.length - 1] }

  const vendorCli = (() => {
    const binaryPath = findExecutableInPath(vendor)
    if (binaryPath === null) {
      return CHECK.fail(
        vendor === 'claude'
          ? 'the `claude` binary is not on PATH. Remediation: install Claude Code (the vendor\'s documented installer), open a NEW shell so PATH updates, and re-run.'
          : 'the `zcode` binary is not on PATH. Remediation: install Zcode (the vendor\'s documented installer), open a NEW shell so PATH updates, and re-run.',
      )
    }
    return { status: 'pass', detail: `found ${vendor} at ${binaryPath}`, binaryPath }
  })()
  checks.push({ id: 'VC', title: `vendor CLI (${vendor}) present`, gating: true, ...vendorCli })
  const vendorVersion = { enabled: vendorCli.status === 'pass', binaryPath: vendorCli.binaryPath, check: checks[checks.length - 1] }

  const keypair = inspectActorKeypair(pluginData)
  checks.push({ id: 'AK', title: 'installation Actor keypair (distinct per machine)', gating: true, ...keypair })
  report.actorFingerprint = keypair.fingerprint ?? null

  const candidate = (() => {
    if (!options.pluginRoot) {
      return CHECK.fail(
        '--plugin-root is required for this role. Remediation: pass the directory of the INSTALLED materialized package ' +
        '(agent-room-claude-code for role claude, agent-room-agent-plugin for role zcode) so this machine is proven to run the pinned candidate.',
      )
    }
    const root = resolve(options.pluginRoot)
    if (!existsSync(root)) {
      return CHECK.fail(`--plugin-root ${root} does not exist. Remediation: materialize with "node scripts/package-release.mjs --out <fresh-abs-dir>" and install per runbook §0.`)
    }
    const claudeManifest = join(root, '.claude-plugin', 'plugin.json')
    const portableManifest = join(root, 'plugin.json')
    let kind
    if (existsSync(claudeManifest)) kind = 'claude_code'
    else if (existsSync(portableManifest)) kind = 'portable'
    else {
      return CHECK.fail(`${root} is not a materialized agent-room package (no .claude-plugin/plugin.json, no plugin.json). Remediation: point --plugin-root at the materialized package directory from scripts/package-release.mjs.`)
    }
    let record
    try {
      record = loadCandidateRecord()
    } catch (error) {
      return CHECK.fail(error.message)
    }
    const expected = record?.artifacts?.[kind]
    if (!expected?.sha256) {
      return CHECK.fail(`the frozen candidate record carries no ${kind} artifact digest; cannot verify the installed artifact.`)
    }
    let ledger
    try {
      ledger = treeDigest(root)
    } catch (error) {
      return CHECK.fail(`the installed tree at ${root} cannot be digested (${error.message}). Remediation: re-materialize and reinstall the candidate; installed trees must be plain regular files.`)
    }
    const sha256 = ledger.fold.digest('hex')
    report.plugin = { root, kind, manifestVersion: JSON.parse(readFileSync(kind === 'claude_code' ? claudeManifest : portableManifest, 'utf8')).version, files: ledger.files, bytes: ledger.bytes, sha256 }
    if (sha256 !== expected.sha256) {
      return CHECK.fail(
        `the installed ${kind} package digest ${sha256.slice(0, 16)}… (${ledger.files} files, ${ledger.bytes} bytes) does not match the frozen candidate ` +
        `${expected.sha256.slice(0, 16)}… (${expected.files} files, ${expected.bytes} bytes). Candidate Immutability Law: ANY difference voids the demo. ` +
        `Remediation: re-materialize ("node scripts/package-release.mjs --out <fresh-abs-dir>"), reinstall, and re-run this preflight.`,
      )
    }
    return CHECK.pass(`installed ${kind} package at ${root} matches the frozen candidate (${ledger.files} files, ${ledger.bytes} bytes, sha256 ${sha256.slice(0, 16)}…)`)
  })()
  checks.push({ id: 'CA', title: 'installed artifact is the frozen v0.2.0 candidate', gating: true, ...candidate })

  return { checks, reachability, vendorVersion, report }
}

// --- async probes -------------------------------------------------------------

async function runHealthProbe(probe) {
  if (!probe.enabled) return
  try {
    const health = await fetchHealth(probe.origin)
    if (probe.record && health.version !== probe.record.version) {
      probe.check.status = 'fail'
      probe.check.detail = `/health reports version ${health.version} but runtime.json records ${probe.record.version} — the record is from another build. Remediation: restart the server so the record matches the running build.`
    } else {
      probe.check.status = 'pass'
      probe.check.detail = `${probe.origin}/health answered ok (version ${health.version})`
    }
  } catch (error) {
    probe.check.status = 'fail'
    probe.check.detail = tlsRemediation(error)
    if (probe.defaultLoopback && (error?.cause?.code ?? error?.code) === 'ECONNREFUSED') {
      probe.check.detail = `nothing answers on the loopback face of port ${probe.record?.port}. If the server binds a non-loopback host (runbook §1, AGENT_ROOM_HOST), re-run with --server <origin>; otherwise the server is down — start it and re-run.`
    }
  }
}

async function runReachabilityProbe(probe) {
  if (!probe.enabled) return
  try {
    const health = await fetchHealth(probe.origin)
    probe.check.status = 'pass'
    probe.check.detail = `verified TLS handshake + /health answered ok (version ${health.version})`
  } catch (error) {
    probe.check.status = 'fail'
    probe.check.detail = tlsRemediation(error)
  }
}

async function runVendorVersion(probe) {
  if (!probe.enabled) return
  try {
    const { stdout } = await execFileAsync(probe.binaryPath, ['--version'], { timeout: VENDOR_CLI_TIMEOUT_MS })
    const versionLine = String(stdout).trim().split('\n')[0] ?? ''
    if (versionLine.length === 0) throw new Error('empty --version output')
    probe.check.detail = `${probe.check.detail}; answers --version: ${versionLine}`
  } catch (error) {
    probe.check.status = 'fail'
    probe.check.detail = `${probe.check.detail} but "--version" failed (${error.message}). Remediation: reinstall the vendor CLI and confirm "${probe.binaryPath ?? 'it'}" runs from a fresh shell.`
  }
}

// --- main ---------------------------------------------------------------------

async function main() {
  const options = parseArgv(process.argv.slice(2))

  let runtimeFloor
  try {
    const versions = assertSupportedRuntime()
    runtimeFloor = CHECK.pass(`Node ${versions.nodeVersion}, bundled SQLite ${versions.sqliteVersion}`)
  } catch (error) {
    runtimeFloor = CHECK.fail(
      `${error.message}. Remediation: install a stock Node.js >= 24.15 build (it bundles SQLite >= 3.51.3); ` +
      'homebrew node@24 or the official installer both satisfy the floor. The server refuses to boot below it either way.',
    )
  }

  const built = options.role === ROLE_SERVER
    ? buildServerChecks(options, runtimeFloor)
    : buildClientChecks(options, runtimeFloor)

  if (options.role === ROLE_SERVER) {
    await runHealthProbe(built.healthProbe)
  } else {
    await Promise.all([runReachabilityProbe(built.reachability), runVendorVersion(built.vendorVersion)])
  }

  say(paint.bold(`REL-1 preflight — role ${options.role} — ${hostname()} (${platform()} ${arch()})`))
  for (const check of built.checks) {
    printCheck({ ...check })
  }

  const gatingChecks = built.checks.filter(check => check.gating)
  const failed = gatingChecks.filter(check => check.status === 'fail')
  const allPass = failed.length === 0

  if (allPass) {
    say(paint.green(`RESULT: ALL GATING CHECKS PASS — this machine (${options.role}) is ready for the REL-1 demonstration.`))
  } else {
    say(paint.red(`RESULT: ${failed.length} gating check(s) FAILED (${failed.map(check => check.id).join(', ')}). Fix the remediations above and re-run.`))
  }

  if (options.json) {
    const report = {
      kit: KIT,
      schema_version: REPORT_SCHEMA_VERSION,
      timestamp: new Date().toISOString(),
      host: {
        hostname: hostname(),
        platform: platform(),
        arch: arch(),
        node: process.versions.node,
        sqlite: process.versions.sqlite ?? null,
      },
      role: options.role,
      server: built.reachability?.origin ?? options.server ?? null,
      actor_fingerprint: options.role === ROLE_SERVER ? null : built.report.actorFingerprint,
      plugin: options.role === ROLE_SERVER ? null : (built.report.plugin ?? null),
      plugin_data: options.role === ROLE_SERVER ? null : built.report.pluginData,
      checks: built.checks.map(({ id, title, status, gating, detail }) => ({ id, title, status, gating, detail })),
      all_pass: allPass,
    }
    try {
      atomicWriteJson(resolve(options.json), report, 0o600)
      say(paint.dim(`report written: ${resolve(options.json)}`))
    } catch (error) {
      process.stderr.write(`${KIT}: could not write --json report: ${error.message}\n`)
      if (allPass) process.exitCode = 1
    }
  }

  if (!allPass) process.exitCode = 1
}

main().catch((error) => {
  process.stderr.write(`${KIT}: ${error?.message ?? String(error)}\n`)
  process.exitCode = 1
})
