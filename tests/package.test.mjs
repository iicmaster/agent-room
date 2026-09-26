import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { accessSync, constants, statSync } from 'node:fs';
import {
  chmod,
  copyFile,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { MIN_NODE_VERSION } from '../server/runtime.mjs';

const execFile = promisify(execFileCallback);
const repoRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const packageScript = join(repoRoot, 'scripts', 'package-release.mjs');
const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

// The entries `scripts/package-release.mjs:46` copies into BOTH packages, named
// once so the snapshot walk and the source-completeness oracle cannot drift
// apart. The portable root additionally carries the two source manifests
// (`portableEntries`, :45), which the dual-artifact test pins byte-for-byte
// against the repository.
const sharedEntryNames = ['server', 'web', 'README.md', 'LICENSE', 'CHANGELOG.md', 'package.json'];

// Anchors that must be in every shared snapshot: the packager copies whatever
// the source holds, so a runtime file deleted from the source would shrink the
// snapshot silently. These are the entries whose absence would break the
// packages outright.
const requiredSharedPaths = [
  'server',
  'server/mcp-stdio.mjs',
  'server/cli/agent-room.mjs',
  'web',
  'web/index.html',
  'web/app.js',
  'web/styles.css',
  'README.md',
  'LICENSE',
  'CHANGELOG.md',
  'package.json',
];

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
  for (const entry of sharedEntryNames) {
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
  for (const required of requiredSharedPaths) {
    assert.ok(
      snapshot.has(required),
      `shared snapshot of ${root} is missing the required runtime entry: ${required}`,
    );
  }
  return snapshot;
}

// The SOURCE tree is the oracle, not the sibling package. A pairwise comparison
// alone would pass a pair that is identically incomplete — a runtime file
// missing from BOTH packages matches the other one — and `claude plugin validate
// --strict` never opens the runtime tree, so nothing else in the suite would
// notice. Pinning the exact key set (not merely "the two agree") is what makes
// an omission a failure.
function assertSharedSnapshotMatchesSource(label, snapshot, sourceSnapshot) {
  assert.deepEqual(
    [...snapshot.keys()],
    [...sourceSnapshot.keys()],
    `the ${label} package must carry exactly the repository's shared file set `
    + `(${sharedEntryNames.join(', ')}) — a missing or extra runtime entry is a packaging defect`,
  );
  for (const [path, expected] of sourceSnapshot) {
    const actual = snapshot.get(path);
    assert.ok(actual !== undefined, `the ${label} package is missing the shared entry: ${path}`);
    assert.equal(actual.type, expected.type, `shared entry type differs from source: ${path}`);
    if (expected.type === 'file') {
      assert.deepEqual(actual.bytes, expected.bytes, `shared entry bytes differ from source: ${path}`);
    }
  }
}

async function assertMissing(path) {
  await assert.rejects(lstat(path), (error) => error?.code === 'ENOENT');
}

// `scripts/package-release.mjs:98-113` refuses only three things: an output
// that contains the source, one inside the source's server//web/, and the
// filesystem root. An output anywhere ELSE in the checkout — which is exactly
// what `TMPDIR` pointed at the repository root or a subdirectory of it produces
// — is accepted, so the packager cannot be trusted to keep the gate outside the
// repository. The gate asserts the location itself, on the realpath-resolved
// path (TMPDIR is frequently a symlink; on macOS it always is), and does it
// BEFORE the packager child is spawned.
function isInsideDirectory(candidate, boundary) {
  const pathFromBoundary = relative(boundary, candidate);
  return pathFromBoundary === ''
    || (pathFromBoundary !== '..'
      && !pathFromBoundary.startsWith(`..${sep}`)
      && !isAbsolute(pathFromBoundary));
}

let repoBoundaryPromise = null;
function repoBoundary() {
  repoBoundaryPromise ??= realpath(repoRoot);
  return repoBoundaryPromise;
}

async function assertOutsideRepository(path, label) {
  const [resolvedPath, boundary] = await Promise.all([realpath(path), repoBoundary()]);
  assert.ok(
    !isInsideDirectory(resolvedPath, boundary),
    `${label} must live outside the repository: ${resolvedPath} is inside ${boundary}. `
    + 'The packaging gate must never validate or mutate a path in the checkout, and the packager does '
    + 'not refuse every in-repository output. Point TMPDIR at a directory outside the repository '
    + 'and re-run.',
  );
  return resolvedPath;
}

// Every temporary parent in this file goes through here, so no packaging or
// validation child can ever be pointed at a path inside the checkout. The
// removal hook is registered before the containment assertion runs, so a parent
// created inside the repository by a hostile TMPDIR is still reaped.
async function makeTempParent(t, prefix, base = tmpdir()) {
  const parent = await mkdtemp(join(base, prefix));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const resolvedParent = await assertOutsideRepository(parent, `the ${prefix} temporary parent`);
  return { parent, resolvedParent };
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
    bin: { 'agent-room': './server/cli/agent-room.mjs' },
    engines: { node: '>=24.15' },
    scripts: {
      test: 'node --test',
      package: 'node scripts/package-release.mjs',
    },
  });
  assert.equal(Object.hasOwn(packageJson, 'dependencies'), false);
  assert.equal(Object.hasOwn(packageJson, 'devDependencies'), false);

  // The bin target must be the setup CLI, and it must carry the shebang a
  // bin launcher relies on.
  assert.equal(packageJson.bin['agent-room'], './server/cli/agent-room.mjs');
  const cliSource = await readFile(join(repoRoot, 'server', 'cli', 'agent-room.mjs'), 'utf8');
  assert.match(cliSource, /^#!\/usr\/bin\/env node\n/);
});

test('engines.node agrees with the runtime Node floor and must not drift', async () => {
  const packageJson = await readJson(join(repoRoot, 'package.json'));
  assert.equal(packageJson.engines.node, `>=${MIN_NODE_VERSION}`);
});

test('release packaging creates two materialized byte-identical runtime artifacts', async (t) => {
  const { parent } = await makeTempParent(t, 'agent-room-package-');
  const out = join(parent, 'release');

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
    'package.json',
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
    'package.json',
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

  const sourceSnapshot = await sharedSnapshot(repoRoot);
  const portableSnapshot = await sharedSnapshot(portableRoot);
  const claudeSnapshot = await sharedSnapshot(claudeRoot);
  // Source first, then the sibling: neither comparison alone is sufficient. A
  // pairwise check would pass a pair that is identically incomplete, which is
  // the one defect the manifest-only validator cannot see.
  assertSharedSnapshotMatchesSource('portable', portableSnapshot, sourceSnapshot);
  assertSharedSnapshotMatchesSource('Claude Code', claudeSnapshot, sourceSnapshot);
  assert.deepEqual([...claudeSnapshot.keys()], [...portableSnapshot.keys()]);
  for (const [path, expected] of portableSnapshot) {
    const actual = claudeSnapshot.get(path);
    assert.equal(actual.type, expected.type, `runtime entry type differs: ${path}`);
    if (expected.type === 'file') {
      assert.deepEqual(actual.bytes, expected.bytes, `runtime bytes differ: ${path}`);
    }
  }

  // The setup command ships exposed in every artifact: the bin entry and an
  // executable, shebang-carrying CLI (a bin launcher depends on both).
  for (const artifactRoot of [portableRoot, claudeRoot]) {
    const artifactPackage = await readJson(join(artifactRoot, 'package.json'));
    assert.deepEqual(artifactPackage.bin, { 'agent-room': './server/cli/agent-room.mjs' });
    const cliPath = join(artifactRoot, 'server', 'cli', 'agent-room.mjs');
    const artifactCliSource = await readFile(cliPath, 'utf8');
    assert.match(artifactCliSource, /^#!\/usr\/bin\/env node\n/);
    const cliInfo = await stat(cliPath);
    assert.equal(cliInfo.isFile(), true);
    assert.notEqual(cliInfo.mode & 0o111, 0, 'the packaged setup CLI must be executable');
  }
});

test('release packaging refuses existing, relative, and unsafe output paths', async (t) => {
  const { parent } = await makeTempParent(t, 'agent-room-refusal-');

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
  const { parent } = await makeTempParent(t, 'agent-room-symlink-');
  const fixture = join(parent, 'fixture');
  const out = join(parent, 'release');

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

// Story 1.9 — the fail-closed `claude plugin validate --strict` gate.
//
// `AGENTS.md:30` and `README.md:109` name the command, but prose is not a
// gate: a manifest could drift out of Agent Plugins conformance and the suite
// would still be green. Everything below drives the real packager and the real
// Claude Code CLI, asserts the machine-readable `--json` report rather than a
// vendor banner, and fails closed — an unresolvable validator is a host
// blocker, never a skipped assertion. `AGENT_ROOM_CLAUDE_BIN` relocates the
// binary; it cannot switch the check off.

const CLAUDE_BIN_ENV = 'AGENT_ROOM_CLAUDE_BIN';
const CLAUDE_BIN_NAME = 'claude';
// The single unknown top-level key the load-bearing negative row injects into
// a COPY of the materialized manifest. `--strict`'s only observed effect is
// turning exactly this into a failure, so the row proves the gate bites.
const GATE_PROBE_FIELD = 'bogusGateProbeField';
// Harness budgets (not product limits). The packager walks the whole tree and
// the validator is a fast static check, but both get an explicit bound so a
// hung child fails the run instead of hanging it. Spelled to stay clear of the
// restated-limit audit in tests/constants.test.mjs, which scans every module
// under server/ and tests/ for a product limit's digits.
const PACKAGER_TIMEOUT_MS = 180_000;
const VALIDATE_TIMEOUT_MS = 180_000;
const VERSION_TIMEOUT_MS = 30_000;

function isExecutableFile(path) {
  try {
    accessSync(path, constants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function resolveClaudeBinary(env = process.env) {
  const override = (env[CLAUDE_BIN_ENV] ?? '').trim();
  const candidates = override.length > 0
    ? [override]
    : (env.PATH ?? '')
      .split(delimiter)
      .filter((directory) => directory.length > 0)
      .map((directory) => join(directory, CLAUDE_BIN_NAME));
  for (const candidate of candidates) {
    const absolute = resolve(candidate);
    if (isExecutableFile(absolute)) return absolute;
  }
  const searched = override.length > 0
    ? `${CLAUDE_BIN_ENV}=${override}`
    : `PATH entries for ${CLAUDE_BIN_NAME}`;
  throw new Error(
    `no executable ${CLAUDE_BIN_NAME} binary for the \`claude plugin validate <pkg> --strict\` gate `
    + `(searched ${searched}). Install Claude Code, or point ${CLAUDE_BIN_ENV} at its absolute path. `
    + 'This gate never skips.',
  );
}

async function claudeVersion(binary) {
  try {
    const { stdout } = await execFile(binary, ['--version'], {
      encoding: 'utf8',
      timeout: VERSION_TIMEOUT_MS,
    });
    return stdout.trim();
  } catch (error) {
    // No version is known yet, so the diagnostic names the binary instead: a
    // red gate still has to say which executable it could not interrogate.
    throw new Error(
      `validator ${binary} (\`claude --version\` did not complete: ${error?.message ?? error}). `
      + `The \`claude plugin validate <pkg> --strict\` gate never skips.`,
      { cause: error },
    );
  }
}

// What the real CLI stamps on its version line, e.g. `2.1.283 (Claude Code)`.
// The version NUMBER is deliberately never compared: pinning it would break on
// the next release. What is asserted is the product identity the CLI claims,
// which is the difference between "an executable that printed something" and
// "Claude Code".
const CLAUDE_PRODUCT_IDENTITY = /claude[\s._-]*code/i;
// The gate depends on this exact CLI surface, so identity is also established
// structurally: the binary must actually implement `claude plugin validate`, not
// merely echo a plausible string. A shim that fakes `--version` still has to
// pass this probe — and, further down, the load-bearing negative row, which
// requires it to emit a real warning about an unknown manifest field.
const CLAUDE_VALIDATE_USAGE = /claude\s+plugin\s+validate/i;

async function runValidatorHelpProbe(binary) {
  try {
    const { stdout, stderr } = await execFile(binary, ['plugin', 'validate', '--help'], {
      encoding: 'utf8',
      timeout: VERSION_TIMEOUT_MS,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    if (typeof error.code === 'number') {
      return { exitCode: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
    throw error;
  }
}

async function assertClaudeValidatorIdentity(binary, version) {
  const context = describeValidator(binary, version);
  assert.ok(
    version.length > 0,
    `${context}: the gate's validator must report a \`claude --version\` string`,
  );
  assert.match(
    version,
    CLAUDE_PRODUCT_IDENTITY,
    `${context}: the resolved executable must identify itself as Claude Code. `
    + `Point ${CLAUDE_BIN_ENV} at the real Claude Code binary, not a wrapper or a different tool.`,
  );
  const help = await runValidatorHelpProbe(binary);
  assert.equal(
    help.exitCode,
    0,
    `${context}: \`claude plugin validate --help\` must exit 0, proving the resolved executable is the `
    + `Claude Code CLI. Output: ${help.stdout}\n${help.stderr}`,
  );
  assert.match(
    `${help.stdout}${help.stderr}`,
    CLAUDE_VALIDATE_USAGE,
    `${context}: the resolved executable must implement \`claude plugin validate\`. `
    + `Output: ${help.stdout}\n${help.stderr}`,
  );
}

// Resolve, version, and identity in one step, so every gate test enters the
// validate call with a binary that has been established to be Claude Code.
async function openValidator(env = process.env) {
  const binary = resolveClaudeBinary(env);
  const version = await claudeVersion(binary);
  await assertClaudeValidatorIdentity(binary, version);
  return { binary, version, context: describeValidator(binary, version) };
}

// Every gate failure message names the binary that decided it and the version
// it reported, so a red run is actionable without a second manual probe.
function describeValidator(binary, version) {
  return `validator ${binary} (claude --version: ${version.length > 0 ? version : 'unknown'})`;
}

// Follows the `runPackage` shape: a real child spawned with `process.execPath`
// and a captured `stderr`, except this one is bounded and returns its exit code
// instead of rejecting, because the gate asserts on the result. Kept separate
// from `runPackage` so the existing refusal coverage is not re-threaded.
async function runPackager(out, timeoutMs = PACKAGER_TIMEOUT_MS) {
  try {
    const { stdout, stderr } = await execFile(
      process.execPath,
      [packageScript, '--out', out],
      { cwd: repoRoot, encoding: 'utf8', timeout: timeoutMs },
    );
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    if (typeof error.code === 'number') {
      return { exitCode: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
    throw error;
  }
}

// Materialize a real release into a fresh temporary parent outside the
// repository and reap that parent on every exit path, assertion failure
// included. The containment assertion inside `makeTempParent` runs BEFORE the
// packager child is spawned, so a TMPDIR inside the checkout fails the gate
// without ever building a package there. The packager publishes by rename and
// prints the realpath-resolved output, so the resolved path — not the
// requested one — is what the gate compares and what the validator is pointed
// at. `base` exists only so the location guard can be exercised without a
// hostile host environment.
async function materializeRelease(t, prefix, { base = tmpdir() } = {}) {
  const { parent, resolvedParent } = await makeTempParent(t, prefix, base);
  const out = join(resolvedParent, 'release');

  const { exitCode, stdout, stderr } = await runPackager(join(parent, 'release'));
  assert.equal(
    exitCode,
    0,
    `the packager must materialize into the fresh temporary parent. stderr: ${stderr}`,
  );
  assert.equal(
    stdout,
    `${out}\n`,
    'the packager must print exactly its absolute resolved output path',
  );
  assert.deepEqual(
    (await readdir(parent)).filter((name) => name.startsWith('.release.tmp-')),
    [],
    'the packager must not leave a temporary sibling behind',
  );
  assert.deepEqual(await readdir(out).then((names) => names.sort()), [
    'agent-room-agent-plugin',
    'agent-room-claude-code',
  ]);
  return {
    parent,
    out,
    portableRoot: join(out, 'agent-room-agent-plugin'),
    claudeRoot: join(out, 'agent-room-claude-code'),
  };
}

// Same bounded, never-rejecting shape as `runPackager`: a non-zero exit is a
// result the gate asserts on, not a rejection. A spawn failure or a timeout
// still rejects, so a broken validator fails the run loudly — but the rejection
// carries the same context every other gate failure does, including the
// already-discovered `claude --version`, so a red gate is diagnosable from its
// own message rather than by a second manual probe.
async function runClaudePluginValidate(binary, pluginRoot, context, timeoutMs = VALIDATE_TIMEOUT_MS) {
  const args = ['plugin', 'validate', resolve(pluginRoot), '--strict', '--json'];
  try {
    const { stdout, stderr } = await execFile(binary, args, {
      encoding: 'utf8',
      timeout: timeoutMs,
    });
    return { exitCode: 0, stdout, stderr };
  } catch (error) {
    if (typeof error.code === 'number') {
      return { exitCode: error.code, stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
    }
    const how = error?.killed
      ? `killed after exceeding the ${timeoutMs} ms budget`
      : `failed to start or complete (${error?.signal ?? 'no signal'})`;
    throw new Error(
      `${context}: \`claude plugin validate --strict --json\` ${how}. `
      + `Original error: ${error?.message ?? error}`,
      { cause: error },
    );
  }
}

function parseValidateReport(stdout, context) {
  let report;
  try {
    report = JSON.parse(stdout);
  } catch (error) {
    assert.fail(
      `${context}: \`claude plugin validate --json\` did not return parseable JSON (${error.message}). `
      + `Raw stdout: ${JSON.stringify(stdout)}`,
    );
  }
  assert.ok(
    typeof report === 'object' && report !== null && !Array.isArray(report),
    `${context}: the validate report must be a JSON object. Raw stdout: ${JSON.stringify(stdout)}`,
  );
  return report;
}

// Shape before meaning: a future CLI rename fails the suite here rather than
// leaving a silently ignored field behind.
function assertValidateReportShape(report, context) {
  const raw = JSON.stringify(report);
  assert.ok(
    typeof report.manifest === 'object' && report.manifest !== null && !Array.isArray(report.manifest),
    `${context}: the report's \`manifest\` must be a non-null object. Report: ${raw}`,
  );
  for (const field of ['manifest.errors', 'manifest.warnings', 'manifest.notes', 'contents']) {
    const value = field.split('.').reduce((node, key) => node?.[key], report);
    assert.ok(
      Array.isArray(value),
      `${context}: the report's \`${field}\` must be an array. Report: ${raw}`,
    );
  }
}

test('the materialized Claude Code package passes the fail-closed `claude plugin validate --strict` gate', async (t) => {
  const { binary, context } = await openValidator();
  const { parent, claudeRoot } = await materializeRelease(t, 'agent-room-validate-');

  const { exitCode, stdout, stderr } = await runClaudePluginValidate(binary, claudeRoot, context);
  const report = parseValidateReport(stdout, context);
  assertValidateReportShape(report, context);

  assert.equal(
    exitCode,
    0,
    `${context}: the materialized Claude Code package must pass \`claude plugin validate --strict\`. `
    + `Report: ${stdout}\n${stderr}`,
  );
  assert.equal(
    report.success,
    true,
    `${context}: the report's \`success\` must be true. Report: ${stdout}`,
  );
  assert.equal(
    report.strict,
    true,
    `${context}: the report's \`strict\` must be true, proving --strict was honored. Report: ${stdout}`,
  );
  assert.deepEqual(
    report.manifest.errors,
    [],
    `${context}: the report's \`manifest.errors\` must be empty. Report: ${stdout}`,
  );
  assert.deepEqual(
    report.manifest.warnings,
    [],
    `${context}: the report's \`manifest.warnings\` must be empty. Report: ${stdout}`,
  );
  // The exact materialized path is the assertion, so a report aimed at a
  // manifest anywhere else on the host cannot satisfy it.
  assert.equal(
    report.target,
    join(claudeRoot, '.claude-plugin', 'plugin.json'),
    `${context}: the report's \`target\` must be the materialized manifest inside the temporary `
    + `output ${parent} and nowhere else. Report: ${stdout}`,
  );
});

test('the validate gate is load-bearing: an unknown manifest field fails it in strict mode', async (t) => {
  const { binary, context } = await openValidator();
  const { claudeRoot } = await materializeRelease(t, 'agent-room-validate-negative-');
  const sourcePlugin = join(repoRoot, 'plugin.json');
  const sourceBefore = await readFile(sourcePlugin);

  // The fixture is a COPY in a second temporary parent: the materialized
  // package and the repository source are never edited, so a leaked write is a
  // test failure rather than a silent mutation of what ships. The parent is
  // containment-checked exactly like the materialized one.
  const { parent } = await makeTempParent(t, 'agent-room-validate-probe-');
  const probeRoot = join(parent, 'agent-room-claude-code');
  await cp(claudeRoot, probeRoot, { recursive: true });

  const probeManifest = join(probeRoot, '.claude-plugin', 'plugin.json');
  const mutated = await readJson(probeManifest);
  mutated[GATE_PROBE_FIELD] = 'injected by the packaging gate';
  await writeFile(probeManifest, `${JSON.stringify(mutated, null, 2)}\n`);

  const { exitCode, stdout, stderr } = await runClaudePluginValidate(binary, probeRoot, context);
  const report = parseValidateReport(stdout, context);
  assertValidateReportShape(report, context);

  assert.notEqual(
    exitCode,
    0,
    `${context}: a strict validate of a manifest carrying ${GATE_PROBE_FIELD} must exit non-zero, so a `
    + `validator that silently tolerates the regression cannot pass. Report: ${stdout}\n${stderr}`,
  );
  assert.equal(
    report.success,
    false,
    `${context}: the report's \`success\` must be false for the unknown field. Report: ${stdout}`,
  );
  const offending = report.manifest.warnings.filter(
    (warning) => warning?.path === GATE_PROBE_FIELD,
  );
  assert.equal(
    offending.length,
    1,
    `${context}: the report's \`manifest.warnings\` must carry exactly one entry for `
    + `${GATE_PROBE_FIELD}. Report: ${stdout}`,
  );
  assert.ok(
    typeof offending[0].message === 'string' && offending[0].message.includes(GATE_PROBE_FIELD),
    `${context}: the warning for ${GATE_PROBE_FIELD} must name the injected field. Report: ${stdout}`,
  );

  assert.deepEqual(
    await readFile(sourcePlugin),
    sourceBefore,
    'the negative fixture must never write into the repository source tree',
  );
  assert.deepEqual(
    await readJson(join(claudeRoot, '.claude-plugin', 'plugin.json')),
    expectedClaudeManifest,
    'only the copied fixture may be mutated; the materialized package stays canonical',
  );
});

test('the packaged entrypoint and the two-package split hold the layout the validator never opens', async (t) => {
  const { parent, portableRoot, claudeRoot } = await materializeRelease(t, 'agent-room-layout-');

  // `claude plugin validate` reports "Validation passed" even with
  // server/mcp-stdio.mjs renamed away or .mcp.json deleted: it never opens the
  // runtime tree. These assertions are therefore the only thing covering the
  // layout and entrypoint violations this gate exists to catch early.
  const claudeMcp = await readJson(join(claudeRoot, '.mcp.json'));
  assert.deepEqual(claudeMcp, expectedClaudeMcp);
  assert.deepEqual(
    Object.keys(claudeMcp.mcpServers),
    ['agent-room'],
    'the Claude package must declare exactly the one `agent-room` stdio server',
  );
  assert.deepEqual(
    claudeMcp.mcpServers['agent-room'].args,
    ['${CLAUDE_PLUGIN_ROOT}/server/mcp-stdio.mjs'],
    'the declared argument must name the packaged stdio server',
  );

  const entrypoint = join(claudeRoot, 'server', 'mcp-stdio.mjs');
  const entrypointInfo = await lstat(entrypoint);
  assert.equal(entrypointInfo.isSymbolicLink(), false, 'the packaged entrypoint must not be a symlink');
  assert.equal(entrypointInfo.isFile(), true, 'the packaged entrypoint must be a regular file');
  const entrypointBytes = await readFile(entrypoint);
  assert.deepEqual(
    entrypointBytes,
    await readFile(join(portableRoot, 'server', 'mcp-stdio.mjs')),
    `both packages must ship a byte-identical entrypoint under ${parent}`,
  );
  assert.deepEqual(
    entrypointBytes,
    await readFile(join(repoRoot, 'server', 'mcp-stdio.mjs')),
    'the packaged entrypoint must be byte-identical to the repository source',
  );

  // The structural reason the portable root is not a Claude-validator target:
  // it carries the Agent Plugins 1.0.0 manifests and nothing vendor-specific.
  await assertMissing(join(portableRoot, '.claude-plugin'));
  await assertMissing(join(portableRoot, '.mcp.json'));
  assert.deepEqual(
    await readFile(join(portableRoot, 'plugin.json')),
    await readFile(join(repoRoot, 'plugin.json')),
    'the portable plugin.json must be byte-identical to the repository source',
  );
  assert.deepEqual(
    await readFile(join(portableRoot, 'mcp.json')),
    await readFile(join(repoRoot, 'mcp.json')),
    'the portable mcp.json must be byte-identical to the repository source',
  );
});

test('the gate resolves its validator from AGENT_ROOM_CLAUDE_BIN or PATH and never falls back to a soft check', async (t) => {
  const { parent } = await makeTempParent(t, 'agent-room-validator-');

  // PATH resolution — the default every gate test above takes.
  const pathEnv = { ...process.env };
  delete pathEnv[CLAUDE_BIN_ENV];
  const fromPath = resolveClaudeBinary(pathEnv);
  assert.ok(isAbsolute(fromPath), `PATH resolution must return an absolute path, got ${fromPath}`);
  assert.ok(isExecutableFile(fromPath), `PATH resolution must land on an executable file, got ${fromPath}`);

  const overridden = resolveClaudeBinary({ ...pathEnv, [CLAUDE_BIN_ENV]: fromPath });
  assert.equal(overridden, fromPath, `${CLAUDE_BIN_ENV} must select the binary it names`);

  // Nothing resolvable: throw rather than return a fallback or a null, and
  // name both the requirement and the override so the failure is actionable.
  const emptyDirectory = join(parent, 'empty-path');
  await mkdir(emptyDirectory);
  assert.throws(
    () => resolveClaudeBinary({ PATH: emptyDirectory }),
    (error) => {
      assert.match(error.message, /claude plugin validate/);
      assert.match(error.message, /--strict/);
      assert.ok(error.message.includes(CLAUDE_BIN_ENV), error.message);
      return true;
    },
  );

  // A real file that is not executable fails the same way: the override
  // relocates a binary, it never downgrades the check.
  const notExecutable = join(parent, 'not-executable');
  await writeFile(notExecutable, 'not a binary\n', { mode: 0o600 });
  assert.throws(
    () => resolveClaudeBinary({ [CLAUDE_BIN_ENV]: notExecutable }),
    (error) => {
      assert.match(error.message, /claude plugin validate/);
      assert.ok(error.message.includes(CLAUDE_BIN_ENV), error.message);
      return true;
    },
  );

  // The resolved binary must be Claude Code, not merely something executable:
  // both the product identity on `--version` and the `plugin validate`
  // subcommand are asserted. The version NUMBER is never pinned, so a Claude
  // Code release does not break the gate.
  const { version, context } = await openValidator(pathEnv);
  assert.ok(version.length > 0, 'the resolved validator must report a `claude --version` string');
  assert.match(version, CLAUDE_PRODUCT_IDENTITY, 'the resolved validator must identify as Claude Code');
  assert.ok(context.includes(fromPath), 'the gate failure context must name the resolved binary');
  assert.ok(context.includes(version), 'the gate failure context must carry the resolved `claude --version`');

  // ...and an executable that merely prints a plausible version is refused.
  // Shims are the point of this row: a script that answers `--version` and has
  // no `plugin validate` behind it must not be accepted as the validator.
  const versionOnlyShim = join(parent, 'version-only-shim');
  await writeFile(versionOnlyShim, '#!/bin/sh\necho "0.0.0 (Claude Code)"\n');
  await chmod(versionOnlyShim, 0o755);
  await assert.rejects(
    assertClaudeValidatorIdentity(versionOnlyShim, await claudeVersion(versionOnlyShim)),
    /must implement `claude plugin validate`/,
    'a shim that only fakes `claude --version` must be refused as the validator',
  );

  // A completely different tool is refused on the product identity alone.
  const otherTool = join(parent, 'other-tool');
  await writeFile(otherTool, '#!/bin/sh\necho "9.9.9 (Some Other CLI)"\n');
  await chmod(otherTool, 0o755);
  await assert.rejects(
    assertClaudeValidatorIdentity(otherTool, await claudeVersion(otherTool)),
    /must identify itself as Claude Code/,
    'an unrelated executable must be refused as the validator',
  );
});

test('the gate refuses a temporary parent inside the repository before the packager runs', async (t) => {
  const boundary = await repoBoundary();
  const before = new Set(await readdir(repoRoot));
  const docsBefore = new Set(await readdir(join(repoRoot, 'docs')));

  // A TMPDIR at the repository root, and a TMPDIR at an ordinary subdirectory
  // of it, are both accepted by `scripts/package-release.mjs` — it refuses only
  // outputs containing the source, outputs under server//web/, and the
  // filesystem root. The gate therefore asserts the location itself, and does
  // so before spawning the packager, so no package is ever built in the
  // checkout. The packager is never invoked for real in either case.
  for (const base of [repoRoot, join(repoRoot, 'docs')]) {
    let failure = null;
    try {
      await materializeRelease(t, 'agent-room-in-repo-', { base });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure !== null, `a temporary parent under ${base} must be refused`);
    assert.match(failure.message, /must live outside the repository/);
    assert.ok(
      failure.message.includes(boundary),
      `the refusal must name the repository root it resolved to: ${failure.message}`,
    );
  }

  // The only thing either attempt may leave behind is its own empty parent,
  // reaped by t.after: no `release`, and no `.release.tmp-*` sibling, which is
  // the observable proof that the packager child never ran.
  const created = (await readdir(repoRoot)).filter((name) => !before.has(name));
  assert.equal(created.length, 1, `expected exactly the refused repository-root parent, got ${JSON.stringify(created)}`);
  assert.deepEqual(await readdir(join(repoRoot, created[0])), [], `${created[0]} must hold no materialized output`);
  const createdInDocs = (await readdir(join(repoRoot, 'docs'))).filter((name) => !docsBefore.has(name));
  assert.equal(createdInDocs.length, 1, `expected exactly the refused docs parent, got ${JSON.stringify(createdInDocs)}`);
  assert.deepEqual(
    await readdir(join(repoRoot, 'docs', createdInDocs[0])),
    [],
    'the refused docs parent must hold no materialized output',
  );

  // The accepting branch: the host temp directory is outside the checkout.
  const { resolvedParent } = await makeTempParent(t, 'agent-room-outside-');
  assert.equal(
    isInsideDirectory(resolvedParent, boundary),
    false,
    `the host temp directory must resolve outside the repository, got ${resolvedParent}`,
  );
});

test('a runtime file missing from BOTH packages still fails: the source tree is the oracle', async () => {
  // The positive side is the dual-artifact test, which runs this comparison
  // against two real materialized packages. This row proves the comparison
  // bites on the exact defect a pairwise check cannot see: a file dropped from
  // both packages. The trimmed copies are still identical to each other, so
  // the sibling comparison would pass them.
  const sourceSnapshot = await sharedSnapshot(repoRoot);
  const dropped = 'server/api/routes.mjs';
  const portable = new Map(sourceSnapshot);
  const claude = new Map(sourceSnapshot);
  for (const snapshot of [portable, claude]) {
    assert.ok(snapshot.has(dropped), `fixture precondition: ${dropped} must exist in the source snapshot`);
    snapshot.delete(dropped);
  }
  assert.deepEqual([...claude.keys()], [...portable.keys()]);
  for (const [label, snapshot] of [['portable', portable], ['Claude Code', claude]]) {
    assert.throws(
      () => assertSharedSnapshotMatchesSource(label, snapshot, sourceSnapshot),
      /shared file set/,
      `the ${label} package must fail when it is missing ${dropped}`,
    );
  }

  // The same holds for a file that is present in both but diverged from the
  // source: agreement between the packages is not identity with what ships.
  // Fresh, complete copies here — the key sets are intact and in the source's
  // order, so the byte comparison is what must reject them. `package.json` is
  // the probe because a failing Buffer deepEqual renders a whole-file diff, and
  // a small file keeps this negative row cheap.
  const diverged = [new Map(sourceSnapshot), new Map(sourceSnapshot)];
  for (const snapshot of diverged) {
    snapshot.set('package.json', { type: 'file', bytes: Buffer.from('{}\n') });
  }
  assert.deepEqual([...diverged[1].keys()], [...diverged[0].keys()]);
  for (const [label, snapshot] of [['portable', diverged[0]], ['Claude Code', diverged[1]]]) {
    assert.throws(
      () => assertSharedSnapshotMatchesSource(label, snapshot, sourceSnapshot),
      /bytes differ from source: package\.json/,
      `a shared file that diverges from the source must fail for the ${label} package even when both agree`,
    );
  }
});
