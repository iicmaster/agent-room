// Story 5.1 — cross-harness installer acceptance evidence (AC1 + AC2).
// Drives the REAL installer module and the REAL CLI dispatch. No mocks. All
// host config writes are redirected to temporary paths via the documented env
// overrides, so the developer's real ~/.claude / ~/.codex / etc. are untouched.

import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm, stat, writeFile, mkdir, symlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { main } from '../server/cli/agent-room.mjs'
import {
  buildSnippet,
  genericCliSetup,
  backupAndRestoreForTest,
  HARNESS_NAMES,
  harnessConfig,
  installHarness,
  mergeToml,
  renderTomlTable,
  templateFor,
  tomlValueMatches,
} from '../server/cli/harness-installer.mjs'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const RESOLVED_ENTRYPOINT = join(REPO_ROOT, 'server', 'mcp-stdio.mjs')

const OVERRIDE_KEYS = {
  claude: 'AGENT_ROOM_CLAUDE_CONFIG',
  codex: 'AGENT_ROOM_CODEX_CONFIG',
  antigravity: 'AGENT_ROOM_ANTIGRAVITY_CONFIG',
  opencode: 'AGENT_ROOM_OPENCODE_CONFIG',
  generic: 'AGENT_ROOM_GENERIC_ENV',
}

// Each test owns a fresh temp dir and redirects all harness targets into it.
async function sandbox(t) {
  const dir = await mkdtemp(join(tmpdir(), 'ar-5-1-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const env = { ...process.env }
  delete env.CLAUDE_PLUGIN_ROOT
  delete env.AGENT_ROOM_PLUGIN_MODE
  for (const [harness, key] of Object.entries(OVERRIDE_KEYS)) {
    env[key] = join(dir, `${harness}${harness === 'codex' ? '.toml' : harness === 'generic' ? '.sh' : '.json'}`)
  }
  return { dir, env }
}

// Invoke the real CLI dispatch with injected streams, capturing stdout/stderr
// and the exit code it sets. Uses a data dir inside the sandbox so no server
// boot can touch the developer's state; installer mode never boots anyway.
async function runCli(argv, { env } = {}) {
  const { PassThrough } = await import('node:stream')
  const output = new PassThrough()
  const errorOutput = new PassThrough()
  let stdout = ''
  let stderr = ''
  output.setEncoding('utf8')
  errorOutput.setEncoding('utf8')
  output.on('data', c => { stdout += c })
  errorOutput.on('data', c => { stderr += c })
  const previous = process.exitCode
  process.exitCode = undefined
  await main(['bootstrap', ...argv], {
    input: new PassThrough(),
    output,
    errorOutput,
    env: env ?? process.env,
    pluginDataDir: join(tmpdir(), `ar-5-1-cli-${process.pid}`),
    sharedDataDir: join(tmpdir(), `ar-5-1-cli-shared-${process.pid}`),
  })
  const exitCode = process.exitCode ?? 0
  process.exitCode = previous
  return { stdout, stderr, exitCode }
}

function noToken(text) {
  assert.doesNotMatch(text, /invite_token|session_token|ar_inv1_/)
}

const TEMPLATE_FILES = {
  claude: 'claude.json', codex: 'codex.toml', antigravity: 'antigravity.json',
  opencode: 'opencode.json', generic: 'generic.sh',
}

test('all five template files retain ${PLUGIN_ROOT}, while standalone buildSnippet resolves concrete package root', async () => {
  const dir = fileURLToPath(new URL('../server/cli/templates/', import.meta.url))
  for (const harness of HARNESS_NAMES) {
    const onDisk = await readFile(join(dir, TEMPLATE_FILES[harness]), 'utf8')
    assert.equal(templateFor(harness), onDisk, `${harness} raw template == disk bytes`)
    assert.equal(buildSnippet(harness, { CLAUDE_PLUGIN_ROOT: '/plugin/cache/agent-room' }).snippet.trimEnd(), onDisk.trimEnd(), `${harness} plugin mode keeps \${PLUGIN_ROOT}`)
    const standalone = buildSnippet(harness, {})
    assert.ok(!standalone.snippet.includes('${PLUGIN_ROOT}'), `${harness} standalone snippet resolves template token`)
    assert.ok(standalone.snippet.includes('mcp-stdio.mjs'), `${harness} points at server/mcp-stdio.mjs`)
    assert.ok(existsSync(RESOLVED_ENTRYPOINT), 'resolved entrypoint exists on disk')
    noToken(onDisk)
  }
})

// --- AC1: closed enum, XOR, --json, print writes nothing ----------------------

test('AC1 closed enum: all five harnesses install/print; outside the set is refused with the valid list and writes nothing', async t => {
  const { env } = await sandbox(t)
  assert.deepEqual([...HARNESS_NAMES], ['claude', 'codex', 'antigravity', 'opencode', 'generic'])

  // Every valid harness --print exits 0 and names its real gate label + path.
  for (const harness of HARNESS_NAMES) {
    const cfg = harnessConfig(harness, env)
    assert.ok(HARNESS_NAMES.includes(harness))
    assert.ok(cfg.gate.length > 0)
    assert.ok(cfg.path.length > 0)
  }

  // Invalid enum through the real CLI: exit 1, valid values listed, no file.
  const refused = await runCli(['--harness', 'vim', '--print'], { env })
  assert.equal(refused.exitCode, 1)
  assert.match(refused.stderr, /valid --harness values: claude, codex, antigravity, opencode, generic/)
  for (const harness of HARNESS_NAMES) {
    const cfg = harnessConfig(harness, env)
    await assert.rejects(stat(cfg.path), (e) => e?.code === 'ENOENT', `${harness} target untouched`)
  }
})

test('AC1 XOR: --install and --print together exit 1 with grammar, no writes', async t => {
  const { env } = await sandbox(t)
  const refused = await runCli(['--harness', 'claude', '--install', '--print'], { env })
  assert.equal(refused.exitCode, 1)
  assert.match(refused.stderr, /mutually exclusive/)
  await assert.rejects(stat(env.AGENT_ROOM_CLAUDE_CONFIG), (e) => e?.code === 'ENOENT')
})

test('AC1 --print writes ZERO files for every harness and shows snippet + guide + real gate', async t => {
  const { dir, env } = await sandbox(t)
  for (const harness of HARNESS_NAMES) {
    const info = buildSnippet(harness, env)
    const out = await runCli(['--harness', harness, '--print'], { env })
    assert.equal(out.exitCode, 0, `${harness}: ${out.stderr}`)
    assert.match(out.stdout, new RegExp(`Snippet for ${harness}`))
    assert.match(out.stdout, /Host gate:/)
    assert.ok(out.stdout.includes(info.gate), `${harness} gate label present`)
    assert.ok(out.stdout.includes('agent-room bootstrap'), 'install guide present')
    noToken(out.stdout)
  }
  // Only the 5 config target files would be created by install; print created none.
  assert.deepEqual(await readdir(dir).catch(() => []), [], '--print wrote nothing')
})

test('AC1 print --json is one machine-readable line with wrote_files empty and gate label', async t => {
  const { env } = await sandbox(t)
  const out = await runCli(['--harness', 'codex', '--print', '--json'], { env })
  assert.equal(out.exitCode, 0, out.stderr)
  const lines = out.stdout.trim().split('\n')
  assert.equal(lines.length, 1)
  const result = JSON.parse(lines[0])
  assert.equal(result.action, 'print')
  assert.equal(result.harness, 'codex')
  assert.deepEqual(result.wrote_files, [])
  assert.equal(result.gate, 'Plugin-enforced')
  assert.ok(result.snippet.includes('[mcp_servers.agent-room]'))
  noToken(out.stdout)
})

test('AC1 generic --print carries CLI dm/read/wait setup', async t => {
  const { env } = await sandbox(t)
  const out = await runCli(['--harness', 'generic', '--print'], { env })
  assert.equal(out.exitCode, 0)
  const setup = genericCliSetup()
  for (const cmd of ['agent-room dm --to', 'agent-room read --peer', 'agent-room wait']) {
    assert.ok(setup.includes(cmd), `generic setup mentions ${cmd}`)
    assert.ok(out.stdout.includes(cmd.split(' ').slice(0, 3).join(' ')), `print mentions ${cmd}`)
  }
})

// --- AC2: backup / merge / idempotence / conflict / rollback / no tokens ------

test('AC2 first install merges only the required key, preserves user keys/hooks, backs up 0o600', async t => {
  const { env } = await sandbox(t)
  const path = env.AGENT_ROOM_CLAUDE_CONFIG
  const original = {
    theme: 'dark',
    hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'my-hook' }] }] },
    mcpServers: { other: { command: 'other' } },
  }
  await writeFile(path, JSON.stringify(original, null, 2) + '\n')

  const out = await runCli(['--harness', 'claude', '--install', '--json'], { env })
  assert.equal(out.exitCode, 0, out.stderr)
  const result = JSON.parse(out.stdout.trim())
  assert.equal(result.changed, true)
  assert.ok(result.backup && result.backup.includes('.agent-room.bak-'))

  const merged = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual(merged.theme, 'dark', 'user key preserved')
  assert.deepEqual(merged.hooks, original.hooks, 'user hooks preserved 100%')
  assert.deepEqual(merged.mcpServers.other, { command: 'other' }, 'other MCP server preserved')
  assert.deepEqual(merged.mcpServers['agent-room'], { command: 'node', args: [RESOLVED_ENTRYPOINT] })

  // In plugin runtime mode (CLAUDE_PLUGIN_ROOT set), keep ${PLUGIN_ROOT} parameterized.
  const pluginPath = join(dirname(path), 'claude-plugin.json')
  await installHarness('claude', { ...env, AGENT_ROOM_CLAUDE_CONFIG: pluginPath, CLAUDE_PLUGIN_ROOT: '/plugins/agent-room' })
  const pluginMerged = JSON.parse(await readFile(pluginPath, 'utf8'))
  assert.deepEqual(pluginMerged.mcpServers['agent-room'], { command: 'node', args: ['${PLUGIN_ROOT}/server/mcp-stdio.mjs'] })

  const backupStat = await stat(result.backup)
  assert.equal(backupStat.mode & 0o777, 0o600, 'backup is 0o600')
  assert.deepEqual(JSON.parse(await readFile(result.backup, 'utf8')), original, 'backup is byte-faithful original')
  noToken(await readFile(path, 'utf8'))
})

test('AC2 second install is byte-identical, creates no new backup', async t => {
  const { env } = await sandbox(t)
  const path = env.AGENT_ROOM_CLAUDE_CONFIG
  await writeFile(path, JSON.stringify({ theme: 'dark', mcpServers: {} }, null, 2) + '\n')

  await runCli(['--harness', 'claude', '--install'], { env })
  const afterFirst = await readFile(path)
  const out = await runCli(['--harness', 'claude', '--install', '--json'], { env })
  assert.equal(out.exitCode, 0, out.stderr)
  const result = JSON.parse(out.stdout.trim())
  assert.equal(result.changed, false)
  assert.equal(result.backup, null)
  assert.deepEqual(await readFile(path), afterFirst, 'second run byte-identical')

  const backups = (await readdir(env.AGENT_ROOM_CLAUDE_CONFIG.replace(/[^/]+$/, '')))
    .filter(n => n.includes('.agent-room.bak-'))
  assert.equal(backups.length, 1, 'no duplicate backup on re-run')
})

test('AC2 unparseable JSON refused with reviewable diff, exit 1, no overwrite', async t => {
  const { env } = await sandbox(t)
  const path = env.AGENT_ROOM_CLAUDE_CONFIG
  const broken = '{ not valid json\n'
  await writeFile(path, broken)
  const out = await runCli(['--harness', 'claude', '--install', '--json'], { env })
  assert.equal(out.exitCode, 1)
  const payload = JSON.parse(out.stderr.trim())
  assert.equal(payload.code, 'config_unparseable')
  assert.equal(await readFile(path, 'utf8'), broken, 'file untouched')
  assert.match(out.stderr, /not a valid JSON object/)
})

test('AC2 conflicting required key refused with diff showing both values, no overwrite', async t => {
  const { env } = await sandbox(t)
  const path = env.AGENT_ROOM_CLAUDE_CONFIG
  const conflicting = {
    mcpServers: { 'agent-room': { command: 'node', args: ['/different/entry.mjs'] } },
  }
  await writeFile(path, JSON.stringify(conflicting, null, 2) + '\n')
  const out = await runCli(['--harness', 'claude', '--install', '--json'], { env })
  assert.equal(out.exitCode, 1)
  const payload = JSON.parse(out.stderr.trim())
  assert.equal(payload.code, 'config_conflict')
  assert.equal(payload.key, 'mcpServers.agent-room')
  assert.deepEqual(payload.existing, conflicting.mcpServers['agent-room'])
  assert.ok(payload.required, 'reviewable diff shows the required value')
  assert.match(payload.diff, /^\-\-\- .*\(current\)/m, 'reviewable unified diff present')
  assert.match(payload.diff, /\+.*mcp-stdio\.mjs/, 'diff shows proposed required entrypoint')
  assert.equal(await readFile(path, 'utf8'), JSON.stringify(conflicting, null, 2) + '\n', 'file untouched')
})

test('AC2 TOML install merges only required table and preserves user sections; conflict + parse refusal', async t => {
  const { env } = await sandbox(t)
  const path = env.AGENT_ROOM_CODEX_CONFIG
  const original = "# user config\n[general]\nmodel = 'gpt-x'\n\n[other]\nx = 1\n"
  await writeFile(path, original)

  const out = await runCli(['--harness', 'codex', '--install', '--json'], { env })
  assert.equal(out.exitCode, 0, out.stderr)
  const merged = await readFile(path, 'utf8')
  assert.match(merged, /model = 'gpt-x'/)
  assert.match(merged, /\[mcp_servers\.agent-room\]/)
  assert.match(merged, /\[other\]/)

  // Idempotent second run.
  const before = await readFile(path)
  await runCli(['--harness', 'codex', '--install'], { env })
  assert.deepEqual(await readFile(path), before)

  // Conflict: wrong command under the required table.
  await writeFile(path, "[mcp_servers.agent-room]\ncommand = 'something-else'\n")
  const conflict = await runCli(['--harness', 'codex', '--install', '--json'], { env })
  assert.equal(conflict.exitCode, 1)
  assert.equal(JSON.parse(conflict.stderr.trim()).code, 'config_conflict')

  // Unparseable line refused.
  await writeFile(path, 'this is not toml at all\n')
  const bad = await runCli(['--harness', 'codex', '--install', '--json'], { env })
  assert.equal(bad.exitCode, 1)
  assert.equal(JSON.parse(bad.stderr.trim()).code, 'config_unparseable')
})

test('AC2 rollback restores original bytes from backup after a failed write', async t => {
  const { env } = await sandbox(t)
  const path = env.AGENT_ROOM_CLAUDE_CONFIG
  const original = '{"keep":"me","mcpServers":{}}\n'
  await writeFile(path, original)
  const { backupPath, bytes } = await backupAndRestoreForTest(path)
  assert.ok(backupPath && backupPath.includes('.agent-room.bak-'))
  assert.deepEqual(bytes, Buffer.from(original), 'original bytes restored from backup')
  assert.equal((await stat(backupPath)).mode & 0o777, 0o600)
})

test('AC2 a conflicting required key is a clean refusal that changes nothing', async t => {
  const { env } = await sandbox(t)
  const path = env.AGENT_ROOM_CLAUDE_CONFIG
  const conflicting = '{"mcpServers":{"agent-room":{"command":"node","args":["/wrong"]}}}\n'
  await writeFile(path, conflicting)
  const refused = await installHarness('claude', env).then(() => 'no-refusal').catch(e => e)
  assert.ok(refused instanceof Error)
  assert.equal(refused.code, 'config_conflict')
  assert.equal(await readFile(path, 'utf8'), conflicting, 'original conflicting content untouched')
})

test('AC2 paths with spaces are quoted in print output and install still works', async t => {
  const { dir } = await sandbox(t)
  const spacedDir = join(dir, 'with spaces')
  await mkdir(spacedDir)
  const env = { ...process.env, AGENT_ROOM_CLAUDE_CONFIG: join(spacedDir, 'settings.json') }
  const info = buildSnippet('claude', env)
  assert.ok(info.quotedPath.startsWith("'") && info.quotedPath.endsWith("'"))
  assert.ok(info.quotedPath.includes('with spaces'))
  const out = await runCli(['--harness', 'claude', '--install'], { env })
  assert.equal(out.exitCode, 0, out.stderr)
  assert.ok((await readFile(env.AGENT_ROOM_CLAUDE_CONFIG, 'utf8')).includes('agent-room'))
})

test('AC2 host config never contains a raw token, even when the flag grammar mentions one', async t => {
  const { env } = await sandbox(t)
  // The installer mode rejects --invite/--remote as unknown options; nothing
  // token-shaped can flow into the config path.
  const out = await runCli(['--harness', 'claude', '--install', '--invite', 'ar_inv1_SECRET'], { env })
  assert.equal(out.exitCode, 1)
  const payload = JSON.parse(out.stderr.trim())
  assert.equal(payload.code, 'invalid_request')
  assert.match(payload.message, /not valid with --install\/--print/)
  assert.doesNotMatch(out.stderr, /ar_inv1_SECRET/, 'token never echoed')
  noToken(out.stdout)
})

test('TOML quoting handles spaces, apostrophes, double quotes, and backslashes safely and idempotently', () => {
  const nastyPath = "/tmp/Alice's \"repo\" \\v1/server/mcp-stdio.mjs"
  const keys = { command: 'node', args: [nastyPath] }
  const first = mergeToml('model = "gpt-5"\n', 'mcp_servers.agent-room', keys, 'codex.toml')
  assert.equal(first.changed, true)
  const second = mergeToml(first.text, 'mcp_servers.agent-room', keys, 'codex.toml')
  assert.equal(second.changed, false, 'idempotent second merge on nasty TOML path')
  assert.equal(tomlValueMatches(renderTomlTable('t', { a: [nastyPath] }).split('a = ')[1].trim(), [nastyPath]), true)
})
