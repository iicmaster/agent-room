import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { MIN_NODE_VERSION } from '../server/runtime.mjs';

const execFile = promisify(execFileCallback);
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageScript = join(repoRoot, 'scripts', 'package-release.mjs');
const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

const expectedPluginManifest = {
  $schema: PLUGIN_SCHEMA,
  name: 'agent-room',
  version: '0.1.0',
  description: 'Vendor-neutral agent chat rooms over MCP with a live web viewer',
  author: { name: 'NGS' },
  license: 'MIT',
};

const expectedMcpConfig = {
  $schema: MCP_SCHEMA,
  mcpServers: {
    'agent-room': {
      type: 'stdio',
      command: 'node',
      args: ['${PLUGIN_ROOT}/server/mcp-stdio.mjs'],
      cwd: '${PLUGIN_DATA}',
    },
  },
};

const expectedClaudeManifest = {
  name: 'agent-room',
  version: '0.1.0',
  description: 'Vendor-neutral agent chat rooms over MCP with a live web viewer',
  author: { name: 'NGS' },
  license: 'MIT',
};

const expectedClaudeMcp = {
  mcpServers: {
    'agent-room': {
      command: 'node',
      args: ['${CLAUDE_PLUGIN_ROOT}/server/mcp-stdio.mjs'],
      cwd: '${CLAUDE_PLUGIN_DATA}',
    },
  },
};

async function readJson(path) {
  return JSON.parse(await readFile(path, 'utf8'));
}

async function runPackage(projectRoot, out) {
  return execFile(process.execPath, [join(projectRoot, 'scripts', 'package-release.mjs'), '--out', out], {
    cwd: projectRoot,
    encoding: 'utf8',
  });
}

async function expectPackageFailure(projectRoot, out, pattern) {
  await assert.rejects(
    runPackage(projectRoot, out),
    (error) => {
      assert.match(`${error.stderr ?? ''}\n${error.message ?? ''}`, pattern);
      return true;
    },
  );
}

function schemaVersion(identifier) {
  const match = new URL(identifier).pathname.match(/^\/schemas\/([^/]+)\//);
  assert.ok(match, `not a canonical Agent Plugins schema identifier: ${identifier}`);
  return match[1];
}

async function collectTree(root, relativePath = '', entries = new Map()) {
  const absolutePath = relativePath.length === 0 ? root : join(root, relativePath);
  const names = await readdir(absolutePath);
  names.sort((left, right) => left.localeCompare(right));
  for (const name of names) {
    const childRelative = relativePath.length === 0 ? name : join(relativePath, name);
    const childAbsolute = join(root, childRelative);
    const info = await lstat(childAbsolute);
    assert.equal(info.isSymbolicLink(), false, `artifact contains symlink: ${childRelative}`);
    if (info.isDirectory()) {
      entries.set(childRelative, { type: 'directory' });
      await collectTree(root, childRelative, entries);
    } else {
      assert.equal(info.isFile(), true, `artifact contains non-regular file: ${childRelative}`);
      entries.set(childRelative, { type: 'file', bytes: await readFile(childAbsolute) });
    }
  }
  return entries;
}

async function sharedSnapshot(root) {
  const snapshot = new Map();
  for (const entry of ['server', 'web', 'README.md', 'LICENSE', 'CHANGELOG.md']) {
    const path = join(root, entry);
    const info = await lstat(path);
    assert.equal(info.isSymbolicLink(), false, `shared entry is a symlink: ${entry}`);
    if (info.isDirectory()) {
      snapshot.set(entry, { type: 'directory' });
      await collectTree(root, entry, snapshot);
    } else {
      assert.equal(info.isFile(), true, `shared entry is not a regular file: ${entry}`);
      snapshot.set(entry, { type: 'file', bytes: await readFile(path) });
    }
  }
  return snapshot;
}

async function assertMissing(path) {
  await assert.rejects(lstat(path), (error) => error?.code === 'ENOENT');
}

test('portable manifests and package metadata have exact closed shapes', async () => {
  const [pluginManifest, mcpConfig, packageJson] = await Promise.all([
    readJson(join(repoRoot, 'plugin.json')),
    readJson(join(repoRoot, 'mcp.json')),
    readJson(join(repoRoot, 'package.json')),
  ]);

  assert.deepEqual(pluginManifest, expectedPluginManifest);
  assert.deepEqual(mcpConfig, expectedMcpConfig);
  assert.equal(schemaVersion(pluginManifest.$schema), '1.0.0');
  assert.equal(schemaVersion(mcpConfig.$schema), schemaVersion(pluginManifest.$schema));

  const server = mcpConfig.mcpServers['agent-room'];
  assert.match(server.command, /^[a-zA-Z0-9._-]+$/, 'command must be one bare executable token');
  assert.doesNotMatch(server.command, /\$\{|[/\\]/, 'command must not contain paths or placeholders');
  assert.equal(Object.hasOwn(server, 'env'), false, 'portable package must not embed environment data');
  assert.equal(Object.hasOwn(server, 'headers'), false, 'portable package must not embed headers');

  assert.deepEqual(packageJson, {
    name: 'agent-room',
    version: '0.1.0',
    private: true,
    type: 'module',
    engines: { node: '>=24.15' },
    scripts: {
      test: 'node --test',
      package: 'node scripts/package-release.mjs',
    },
  });
  assert.equal(Object.hasOwn(packageJson, 'dependencies'), false);
  assert.equal(Object.hasOwn(packageJson, 'devDependencies'), false);
});

test('engines.node agrees with the runtime Node floor and must not drift', async () => {
  const packageJson = await readJson(join(repoRoot, 'package.json'));
  assert.equal(packageJson.engines.node, `>=${MIN_NODE_VERSION}`);
});

test('release packaging creates two materialized byte-identical runtime artifacts', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-room-package-'));
  const out = join(parent, 'release');
  t.after(() => rm(parent, { recursive: true, force: true }));

  await runPackage(repoRoot, out);

  assert.deepEqual(await readdir(out).then((names) => names.sort()), [
    'agent-room-agent-plugin',
    'agent-room-claude-code',
  ]);
  const portableRoot = join(out, 'agent-room-agent-plugin');
  const claudeRoot = join(out, 'agent-room-claude-code');
  assert.deepEqual(await readdir(portableRoot).then((names) => names.sort()), [
    'CHANGELOG.md',
    'LICENSE',
    'README.md',
    'mcp.json',
    'plugin.json',
    'server',
    'web',
  ]);
  assert.deepEqual(await readdir(claudeRoot).then((names) => names.sort()), [
    '.claude-plugin',
    '.mcp.json',
    'CHANGELOG.md',
    'LICENSE',
    'README.md',
    'server',
    'web',
  ]);

  const artifactPaths = [...(await collectTree(out)).keys()];
  assert.equal(
    artifactPaths.some((path) => /(^|[/\\])node_modules([/\\]|$)/.test(path)),
    false,
    'packaged artifacts must not contain a node_modules directory',
  );
  assert.deepEqual(
    await readFile(join(portableRoot, 'plugin.json')),
    await readFile(join(repoRoot, 'plugin.json')),
  );
  assert.deepEqual(
    await readFile(join(portableRoot, 'mcp.json')),
    await readFile(join(repoRoot, 'mcp.json')),
  );
  assert.deepEqual(await readJson(join(claudeRoot, '.claude-plugin', 'plugin.json')), expectedClaudeManifest);
  assert.deepEqual(await readJson(join(claudeRoot, '.mcp.json')), expectedClaudeMcp);

  const portableSnapshot = await sharedSnapshot(portableRoot);
  const claudeSnapshot = await sharedSnapshot(claudeRoot);
  assert.deepEqual([...claudeSnapshot.keys()], [...portableSnapshot.keys()]);
  for (const [path, expected] of portableSnapshot) {
    const actual = claudeSnapshot.get(path);
    assert.equal(actual.type, expected.type, `runtime entry type differs: ${path}`);
    if (expected.type === 'file') {
      assert.deepEqual(actual.bytes, expected.bytes, `runtime bytes differ: ${path}`);
    }
  }
});

test('release packaging refuses existing, relative, and unsafe output paths', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-room-refusal-'));
  t.after(() => rm(parent, { recursive: true, force: true }));

  const empty = join(parent, 'empty');
  await mkdir(empty);
  await expectPackageFailure(repoRoot, empty, /output already exists/);

  const nonempty = join(parent, 'nonempty');
  await mkdir(nonempty);
  await writeFile(join(nonempty, 'KEEP'), 'preserve me\n');
  await expectPackageFailure(repoRoot, nonempty, /output already exists/);
  assert.equal(await readFile(join(nonempty, 'KEEP'), 'utf8'), 'preserve me\n');

  await expectPackageFailure(repoRoot, 'relative-release', /absolute directory path/);

  const unsafe = join(repoRoot, 'server', `.package-output-${randomUUID()}`);
  await expectPackageFailure(repoRoot, unsafe, /unsafe output path/);
  await assertMissing(unsafe);
});

test('release packaging rejects source symlinks and removes its temporary output', async (t) => {
  const parent = await mkdtemp(join(tmpdir(), 'agent-room-symlink-'));
  const fixture = join(parent, 'fixture');
  const out = join(parent, 'release');
  t.after(() => rm(parent, { recursive: true, force: true }));

  await mkdir(join(fixture, 'scripts'), { recursive: true });
  await mkdir(join(fixture, 'server'));
  await mkdir(join(fixture, 'web'));
  for (const entry of ['plugin.json', 'mcp.json', 'README.md', 'LICENSE', 'CHANGELOG.md']) {
    await copyFile(join(repoRoot, entry), join(fixture, entry));
  }
  await copyFile(packageScript, join(fixture, 'scripts', 'package-release.mjs'));
  await writeFile(join(fixture, 'server', 'mcp-stdio.mjs'), 'export {};\n');
  await writeFile(join(fixture, 'web', 'index.html'), '<!doctype html>\n');
  const outside = join(parent, 'outside.txt');
  await writeFile(outside, 'must not be packaged\n');
  await symlink(outside, join(fixture, 'server', 'escape'));

  await expectPackageFailure(fixture, out, /source symlink is not allowed/);
  await assertMissing(out);
  assert.deepEqual(
    (await readdir(parent)).filter((name) => name.startsWith('.release.tmp-')),
    [],
  );
});
