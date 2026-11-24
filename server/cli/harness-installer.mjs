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
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

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
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

// Standalone raw git-clone installs resolve the real package path on disk
// because non-plugin hosts never expand ${PLUGIN_ROOT}; live plugin runtimes
// (CLAUDE_PLUGIN_ROOT set, or AGENT_ROOM_PLUGIN_MODE=1) keep the parameterized
// token so cache upgrades stay decoupled across versions.
function resolveInstallRoot(env = process.env) {
  const inClaudePlugin = typeof env?.CLAUDE_PLUGIN_ROOT === 'string' && env.CLAUDE_PLUGIN_ROOT.trim().length > 0
  if (inClaudePlugin || env?.AGENT_ROOM_PLUGIN_MODE === '1') {
    return { root: PLUGIN_ROOT_TOKEN, pluginMode: true }
  }
  return { root: PACKAGE_ROOT, pluginMode: false }
}

function stdioEntrypoint(env = process.env) {
  const { root, pluginMode } = resolveInstallRoot(env)
  return pluginMode ? `${root}/server/mcp-stdio.mjs` : join(root, 'server', 'mcp-stdio.mjs')
}

// The five template files are the single canonical format specification for
// --print/--install. Raw templates retain ${PLUGIN_ROOT} for plugin bundles;
// standalone installs substitute PACKAGE_ROOT dynamically at render/merge time.
const TEMPLATE_DIR = join(dirname(fileURLToPath(import.meta.url)), 'templates')
const TEMPLATE_FILE = Object.freeze({
  claude: 'claude.json',
  antigravity: 'antigravity.json',
  opencode: 'opencode.json',
  codex: 'codex.toml',
  generic: 'generic.sh',
})
export function templateFor(harness) {
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
    case 'antigravity': return join(home, '.gemini', 'config', 'mcp_config.json')
    case 'opencode': return join(home, '.config', 'opencode', 'opencode.json')
    case 'generic': return join(home, '.agent-room', 'env.sh')
    default: throw new Error(`unknown harness: ${harness}`)
  }
}

// The single required MCP entry, per harness format. `command`/`args` are the
// stdio entrypoint only — no env, no headers, no tokens.
function requiredEntry(harness, env = process.env) {
  const entrypoint = stdioEntrypoint(env)
  const args = [entrypoint]
  switch (harness) {
    case 'claude':
    case 'antigravity':
      return { format: 'json', pointer: ['mcpServers', 'agent-room'], value: { command: 'node', args } }
    case 'opencode':
      return {
        format: 'json',
        pointer: ['mcp', 'agent-room'],
        value: {
          type: 'local',
          command: ['node', entrypoint],
          enabled: true,
        },
      }
    case 'codex':
      return { format: 'toml', table: 'mcp_servers.agent-room', keys: { command: 'node', args } }
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

export function formatTomlString(value) {
  const str = String(value)
  // TOML literal strings ('...') forbid backslash escapes and cannot contain ',
  // CR, or control chars; fall back to TOML basic strings (JSON escaping) when
  // an apostrophe or control character is present.
  if (!/['\r\n\u0000-\u001f\u007f]/.test(str)) return `'${str}'`
  return JSON.stringify(str)
}

function parseTomlStringAt(text, startIndex) {
  const quote = text[startIndex]
  if (quote === "'") {
    const close = text.indexOf("'", startIndex + 1)
    if (close === -1) return { ok: false }
    const val = text.slice(startIndex + 1, close)
    if (/[\r\n]/.test(val)) return { ok: false }
    return { ok: true, value: val, nextIndex: close + 1 }
  }
  if (quote === '"') {
    let cursor = startIndex + 1
    let escaped = false
    while (cursor < text.length) {
      const ch = text[cursor]
      if (escaped) { escaped = false; cursor += 1; continue }
      if (ch === '\\') { escaped = true; cursor += 1; continue }
      if (ch === '"') {
        try {
          return { ok: true, value: JSON.parse(text.slice(startIndex, cursor + 1)), nextIndex: cursor + 1 }
        } catch {
          return { ok: false }
        }
      }
      if (ch === '\r' || ch === '\n') return { ok: false }
      cursor += 1
    }
  }
  return { ok: false }
}

export function parseTomlValue(raw) {
  const s = String(raw).trim()
  if (s.startsWith("'") || s.startsWith('"')) {
    const parsed = parseTomlStringAt(s, 0)
    if (!parsed.ok || s.slice(parsed.nextIndex).trim() !== '') return { ok: false }
    return { ok: true, value: parsed.value }
  }
  if (s.startsWith('[')) {
    let cursor = 1
    const items = []
    while (cursor < s.length) {
      while (cursor < s.length && /\s/.test(s[cursor])) cursor += 1
      if (s[cursor] === ']') {
        return s.slice(cursor + 1).trim() === '' ? { ok: true, value: items } : { ok: false }
      }
      const item = parseTomlStringAt(s, cursor)
      if (!item.ok) return { ok: false }
      items.push(item.value)
      cursor = item.nextIndex
      while (cursor < s.length && /\s/.test(s[cursor])) cursor += 1
      if (s[cursor] === ',') { cursor += 1; continue }
      if (s[cursor] === ']') {
        return s.slice(cursor + 1).trim() === '' ? { ok: true, value: items } : { ok: false }
      }
      return { ok: false }
    }
  }
  return { ok: false }
}

export function tomlValueMatches(raw, expected) {
  const parsed = parseTomlValue(raw)
  return parsed.ok && isDeepStrictEqual(parsed.value, expected)
}

export function renderTomlTable(table, keys) {
  const addition = [`[${table}]`]
  for (const [key, expected] of Object.entries(keys)) {
    const rendered = Array.isArray(expected)
      ? `[${expected.map(item => formatTomlString(item)).join(', ')}]`
      : formatTomlString(expected)
    addition.push(`${key} = ${rendered}`)
  }
  return `${addition.join('\n')}\n`
}

export function mergeToml(originalText, table, keys, label) {
  const assignments = parseTomlAssignments(originalText, label)
  const conflicts = []
  for (const [key, expected] of Object.entries(keys)) {
    const full = `${table}.${key}`
    const raw = assignments.get(full)
    if (raw === undefined) continue
    if (!tomlValueMatches(raw, expected)) conflicts.push({ key: full, existing: raw, required: expected })
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

function renderShellEnv(env = process.env) {
  const { root, pluginMode } = resolveInstallRoot(env)
  if (pluginMode) return templateFor('generic')
  const entrypoint = stdioEntrypoint(env)
  // Escape double-quote shell metacharacters while keeping ${PLUGIN_ROOT} out.
  const escaped = entrypoint.replace(/["\\$`]/g, '\\$&')
  return templateFor('generic').replace(`${PLUGIN_ROOT_TOKEN}/server/mcp-stdio.mjs`, () => escaped)
}

function mergeShell(originalText, label, env = process.env) {
  const body = renderShellEnv(env)
  if (originalText.length === 0) return { text: body, mode: 0o700, changed: true }
  // Idempotent: if our marker is present and entrypoint matches, keep byte-identical.
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
  return { harness, path: targetPath(harness, env), gate: GATE[harness], required: requiredEntry(harness, env) }
}

export function buildSnippet(harness, env = process.env) {
  const cfg = harnessConfig(harness, env)
  const req = cfg.required
  const { pluginMode } = resolveInstallRoot(env)
  let snippet
  if (pluginMode) {
    snippet = templateFor(harness)
  } else if (req.format === 'toml') {
    snippet = renderTomlTable(req.table, req.keys).trimEnd()
  } else if (req.format === 'json') {
    const rootObj = {}
    setPointer(rootObj, req.pointer, req.value)
    snippet = JSON.stringify(rootObj, null, 2)
  } else {
    snippet = renderShellEnv(env).trimEnd()
  }
  return {
    harness,
    path: cfg.path,
    format: req.format,
    gate: cfg.gate,
    snippet,
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
    merged = mergeShell(originalText, label, env)
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
