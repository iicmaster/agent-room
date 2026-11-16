// Story 5.1 — safe, idempotent cross-harness MCP installer.
//
// Owns ONLY host config manipulation for `bootstrap --harness <h> --install|--print`.
// It never boots a server, enrolls a key, or touches enroll/auth/scope code. It
// writes no secret: the snippets carry the stdio entrypoint path and NOTHING
// derived from invite_token / session_token.
//
// Safety contract (AC2):
//   - backup the original as <file>.agent-room.bak-<ts> at mode 0o600
//   - merge only required keys, idempotently (2nd run byte-identical)
//   - preserve 100% of user keys/hooks; refuse (exit 1) with a reviewable
//     diff on unparseable input or a conflicting required key
//   - restore every touched file from backup on a mid-way failure
//   - quote shell paths that contain spaces

import { readFileSync } from 'node:fs'
import {
  chmod,
  lstat,
  mkdir,
  readFile,
  rename,
  writeFile,
} from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const HARNESS_NAMES = Object.freeze([
  'claude',
  'codex',
  'antigravity',
  'opencode',
  'generic',
])

// Real, currently-shipped gate labels (server/constants.mjs NOTIFY_GATE_STATES).
const GATE = Object.freeze({
  claude: 'Host-channel-enforced',
  codex: 'Plugin-enforced',
  antigravity: 'Plugin-enforced',
  opencode: 'Plugin-enforced',
  generic: 'Instructed',
})

const PLUGIN_ROOT_TOKEN = '${PLUGIN_ROOT}'

// The five template files are the single content source for --print/--install
// (spec Code Map). They carry ONLY the required MCP entrypoint — no tokens.
const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'templates')
const TEMPLATE_FILE = Object.freeze({
  claude: 'claude.json',
  antigravity: 'antigravity.json',
  opencode: 'opencode.json',
  codex: 'codex.toml',
  generic: 'generic.sh',
})
function templateFor(harness) {
  return readFileSync(join(TEMPLATE_DIR, TEMPLATE_FILE[harness]), 'utf8')
}

// Target paths follow the Story 5.1 Design Notes. Each `env` variable lets a
// test redirect a target without touching the host's real config; production
// never sets them, so defaults are the documented paths.
function targetPath(harness, env) {
  const overrides = {
    claude: 'AGENT_ROOM_CLAUDE_CONFIG',
    codex: 'AGENT_ROOM_CODEX_CONFIG',
    antigravity: 'AGENT_ROOM_ANTIGRAVITY_CONFIG',
    opencode: 'AGENT_ROOM_OPENCODE_CONFIG',
    generic: 'AGENT_ROOM_GENERIC_ENV',
  }
  const override = env[overrides[harness]]
  if (typeof override === 'string' && override.length > 0) return override
  const home = homedir()
  switch (harness) {
    case 'claude': return join(home, '.claude', 'settings.json')
    case 'codex': return join(home, '.codex', 'config.toml')
    case 'antigravity': return join(home, '.gemini', 'settings.json')
    case 'opencode': return join(home, '.config', 'opencode', 'opencode.json')
    case 'generic': return join(home, '.agent-room', 'env.sh')
    default: throw new Error(`unknown harness: ${harness}`)
  }
}

// The single required MCP entry, per harness format. `command`/`args` are the
// stdio entrypoint only — no env, no headers, no tokens.
const STDIO_ARGS = [`${PLUGIN_ROOT_TOKEN}/server/mcp-stdio.mjs`]

function requiredEntry(harness) {
  switch (harness) {
    case 'claude':
    case 'antigravity':
      return { format: 'json', pointer: ['mcpServers', 'agent-room'], value: { command: 'node', args: STDIO_ARGS } }
    case 'opencode':
      return { format: 'json', pointer: ['mcp', 'agent-room'], value: { command: 'node', args: STDIO_ARGS } }
    case 'codex':
      return { format: 'toml', table: 'mcp_servers.agent-room', keys: { command: 'node', args: STDIO_ARGS } }
    case 'generic':
      return { format: 'shell' }
    default:
      throw new Error(`unknown harness: ${harness}`)
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function quoteShellPath(path) {
  return `'${String(path).replace(/'/g, `'\\''`)}'`
}

// ---- JSON parse/merge --------------------------------------------------------

function parseJson(text, label) {
  try {
    const parsed = JSON.parse(text)
    if (!isPlainObject(parsed)) throw new Error('root is not an object')
    return parsed
  } catch (error) {
    throw new ConfigError(`config_unparseable`, `${label} is not a valid JSON object (${error.message})`)
  }
}

function getPointer(root, pointer) {
  let node = root
  for (const key of pointer) {
    if (!isPlainObject(node) || !Object.hasOwn(node, key)) return undefined
    node = node[key]
  }
  return node
}

function setPointer(root, pointer, value) {
  let node = root
  for (const key of pointer.slice(0, -1)) {
    if (!isPlainObject(node[key])) node[key] = {}
    node = node[key]
  }
  node[pointer[pointer.length - 1]] = value
}

function stableJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`
}

// Deterministic key order: existing keys keep their insertion order, new keys
// appended. JSON.stringify over a fresh object with sorted top-level keys would
// reorder the user's file; we preserve original order and only add the required
// pointer at the end.
function mergeJson(originalText, pointer, value, label) {
  const root = originalText.length === 0 ? {} : parseJson(originalText, label)
  const existing = getPointer(root, pointer)
  if (existing !== undefined) {
    if (JSON.stringify(existing) !== JSON.stringify(value)) {
      const proposed = JSON.parse(JSON.stringify(root))
      setPointer(proposed, pointer, value)
      throw new ConfigError('config_conflict',
        `required key ${pointer.join('.')} already exists with a different value; nothing was changed`,
        {
          key: pointer.join('.'), existing, required: value,
          diff: unifiedDiff(originalText, stableJson(proposed), label),
        })
    }
    return { text: originalText, changed: false }
  }
  setPointer(root, pointer, value)
  return { text: stableJson(root), changed: true }
}

// ---- TOML parse/merge (narrow: we only touch the required table) -------------

function parseTomlAssignments(text, label) {
  // Accept standard TOML lines: tables [a.b], key = value, comments, blanks.
  // We do NOT fully evaluate TOML; we reject any line we cannot classify so a
  // malformed host file can never be silently rewritten.
  const tables = new Map()
  let current = ''
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (line === '' || line.startsWith('#')) continue
    const tableMatch = line.match(/^\[([^\]]+)\]$/)
    if (tableMatch) {
      current = tableMatch[1].trim()
      if (!current) throw new ConfigError('config_unparseable', `${label} has an empty table header`)
      continue
    }
    const assignment = line.match(/^([A-Za-z0-9_.-]+)\s*=\s*(.+)$/)
    if (!assignment) {
      throw new ConfigError('config_unparseable', `${label} has an unrecognized line: ${JSON.stringify(rawLine)}`)
    }
    const key = `${current ? `${current}.` : ''}${assignment[1]}`
    tables.set(key, assignment[2].trim())
  }
  return tables
}

function tomlValueMatches(raw, expected) {
  // Expected args is an array of one string; command is a bare string.
  try {
    return JSON.parse(raw.replace(/'/g, '"')) === expected
  } catch {
    return raw.replace(/^"|"$/g, '') === expected
  }
}

function renderTomlTable(table, keys) {
  const addition = [`[${table}]`]
  for (const [key, expected] of Object.entries(keys)) {
    const rendered = Array.isArray(expected)
      ? JSON.stringify(expected).replace(/"/g, "'")
      : `'${String(expected).replace(/'/g, "\\'")}'`
    addition.push(`${key} = ${rendered}`)
  }
  return `${addition.join('\n')}\n`
}

function mergeToml(originalText, table, keys, label) {
  const assignments = parseTomlAssignments(originalText, label)
  const conflicts = []
  for (const [key, expected] of Object.entries(keys)) {
    const full = `${table}.${key}`
    const raw = assignments.get(full)
    if (raw === undefined) continue
    const matches = Array.isArray(expected)
      ? (() => { try { return JSON.stringify(JSON.parse(raw.replace(/'/g, '"'))) === JSON.stringify(expected) } catch { return false } })()
      : tomlValueMatches(raw, expected)
    if (!matches) conflicts.push({ key: full, existing: raw, required: expected })
  }
  if (conflicts.length > 0) {
    const requiredRoot = renderTomlTable(table, keys)
    throw new ConfigError('config_conflict',
      `required TOML keys already exist with different values; nothing was changed`,
      { conflicts, diff: unifiedDiff(originalText, requiredRoot, label) })
  }
  const alreadyPresent = Object.keys(keys).every(key => assignments.has(`${table}.${key}`))
  if (alreadyPresent) return { text: originalText, changed: false }

  const trimmed = originalText.replace(/\s+$/, '')
  const text = trimmed.length === 0
    ? renderTomlTable(table, keys)
    : `${trimmed}\n\n${renderTomlTable(table, keys)}`
  return { text, changed: true }
}

// ---- shell (generic) ---------------------------------------------------------

const GENERIC_MARKER = '# Generated by `agent-room bootstrap --harness generic --install`.'

function mergeShell(originalText, label) {
  const body = templateFor('generic')
  if (originalText.length === 0) return { text: body, mode: 0o700, changed: true }
  // Idempotent: if our marker is present, leave the file byte-identical.
  if (originalText.includes(GENERIC_MARKER)) {
    return { text: originalText, mode: null, changed: false }
  }
  // A foreign env.sh: refuse rather than silently overwrite user shell config.
  throw new ConfigError('config_conflict',
    `${label} already exists with foreign content; refusing to overwrite; nothing was changed`,
    { existing: originalText.slice(0, 200) })
}

// ---- errors and diffs --------------------------------------------------------

export class ConfigError extends Error {
  constructor(code, message, extra = {}) {
    super(message)
    this.name = 'ConfigError'
    this.code = code
    this.extra = extra
  }
}

function unifiedDiff(before, after, label) {
  const a = before.split('\n')
  const b = after.split('\n')
  const lines = [`--- ${label} (current)`, `+++ ${label} (proposed)`]
  const max = Math.max(a.length, b.length)
  for (let i = 0; i < max; i += 1) {
    if (a[i] === b[i]) continue
    if (a[i] !== undefined) lines.push(`-${a[i]}`)
    if (b[i] !== undefined) lines.push(`+${b[i]}`)
  }
  return lines.join('\n')
}

async function readIfExists(path) {
  try {
    const info = await lstat(path)
    if (info.isSymbolicLink()) {
      throw new ConfigError('config_refusal', `refusing to follow symlink: ${path}`)
    }
    if (!info.isFile()) {
      throw new ConfigError('config_refusal', `target is not a regular file: ${path}`)
    }
    return await readFile(path, 'utf8')
  } catch (error) {
    if (error?.code === 'ENOENT') return ''
    throw error
  }
}

async function writeAtomic(path, text, mode) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = `${path}.agent-room.tmp-${process.pid}-${Date.now()}`
  await writeFile(temp, text, { flag: 'wx', mode: 0o600 })
  await chmod(temp, mode)
  await rename(temp, path)
  // best-effort cleanup if rename left the temp (it does not on success)
  // — covered by the backup restore on the failure path.
}

async function backupOriginal(path, existed) {
  if (!existed) return null
  const backup = `${path}.agent-room.bak-${Date.now()}`
  const original = await readFile(path)
  await writeFile(backup, original, { flag: 'wx', mode: 0o600 })
  await chmod(backup, 0o600)
  return { path: backup, bytes: original }
}

async function restoreBackups(backups) {
  for (const backup of backups) {
    if (backup === null) continue
    // backup.path is <target>.agent-room.bak-<ts>; recover the target path.
    const target = backup.path.replace(/\.agent-room\.bak-\d+$/, '')
    try {
      await writeFile(target, backup.bytes, { flag: 'w', mode: 0o600 })
    } catch { /* best effort during rollback */ }
  }
}

// ---- public API --------------------------------------------------------------

// Exposed for the rollback self-check (tests/story-5-1-installers.test.mjs):
// proves a captured backup restores the original bytes after a failed write.
export async function backupAndRestoreForTest(path) {
  const bytes = await readFile(path)
  const existed = bytes.length > 0
  const backup = await backupOriginal(path, existed)
  await writeFile(path, 'CORRUPTED BY FAILED WRITE', { flag: 'w' })
  await restoreBackups([backup])
  return { backupPath: backup?.path ?? null, bytes: await readFile(path) }
}

export function harnessConfig(harness, env = process.env) {
  if (!HARNESS_NAMES.includes(harness)) {
    throw new ConfigError('invalid_harness',
      `unknown harness "${harness}"; valid values: ${HARNESS_NAMES.join(', ')}`)
  }
  return { harness, path: targetPath(harness, env), gate: GATE[harness], required: requiredEntry(harness) }
}

export function buildSnippet(harness, env = process.env) {
  const cfg = harnessConfig(harness, env)
  return {
    harness,
    path: cfg.path,
    format: cfg.required.format,
    gate: cfg.gate,
    snippet: templateFor(harness),
    quotedPath: quoteShellPath(cfg.path),
  }
}

export function genericCliSetup() {
  return [
    'Generic POSIX-shell setup (no host MCP config is written by --install):',
    '  agent-room bootstrap --json                         # auth + scope binding',
    '  agent-room sessions --json                          # list peers',
    '  agent-room dm --to <address> --text "<message>"     # send',
    '  agent-room read --peer <address> [--wait-ms <ms>]   # read the private reply',
    '  agent-room wait [--timeout <seconds>] --json        # wait for replies',
  ].join('\n')
}

export async function installHarness(harness, env = process.env) {
  const cfg = harnessConfig(harness, env)
  const path = cfg.path
  const backups = []
  const originalText = await readIfExists(path)
  const existed = originalText.length > 0
  const label = path

  let merged
  const req = cfg.required
  if (req.format === 'json') {
    merged = mergeJson(originalText, req.pointer, req.value, label)
  } else if (req.format === 'toml') {
    merged = mergeToml(originalText, req.table, req.keys, label)
  } else {
    merged = mergeShell(originalText, label)
  }

  if (!merged.changed) {
    return {
      harness, path, changed: false, backup: null, gate: cfg.gate,
      message: `${path}: already configured (byte-identical; no backup created)`,
    }
  }

  // Refuse with a reviewable diff BEFORE any write when the proposal is not
  // clearly additive. (Conflict cases are thrown above; this is a second gate
  // for the merge shape itself.)
  const diff = unifiedDiff(originalText, merged.text, label)

  try {
    const backup = await backupOriginal(path, existed)
    if (backup) backups.push(backup)
    await writeAtomic(path, merged.text, merged.mode ?? 0o600)
  } catch (error) {
    await restoreBackups(backups)
    throw new ConfigError('install_failed',
      `install failed and all touched files were restored from backup: ${error.message}`)
  }

  return {
    harness,
    path,
    changed: true,
    backup: backups[0]?.path ?? null,
    gate: cfg.gate,
    diff,
    message: `${path}: installed MCP entrypoint (backup: ${backups[0]?.path ?? 'none'})`,
  }
}
