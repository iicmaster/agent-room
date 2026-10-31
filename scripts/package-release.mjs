import { constants } from 'node:fs';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, dirname, isAbsolute, join, normalize, parse, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';
const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// The canonical manifest is FROZEN PER RELEASE: the version literal moves
// with the release stamp (the v0.2.0 release notes' rule — the stamp lands
// BEFORE the candidate is cut, so the frozen artifact and the shipped
// artifact are the same bytes).
const expectedPluginManifest = {
  $schema: PLUGIN_SCHEMA,
  name: 'agent-room',
  version: '0.6.1',
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

const portableEntries = ['plugin.json', 'mcp.json', 'server', 'web', 'README.md', 'LICENSE', 'CHANGELOG.md', 'package.json'];
const sharedEntries = ['server', 'web', 'README.md', 'LICENSE', 'CHANGELOG.md', 'package.json'];

function isWithin(candidate, boundary) {
  const pathFromBoundary = relative(boundary, candidate);
  return pathFromBoundary === ''
    || (!pathFromBoundary.startsWith(`..${sep}`)
      && pathFromBoundary !== '..'
      && !isAbsolute(pathFromBoundary));
}

function parseOutputArgument(argv) {
  if (argv.length !== 2 || argv[0] !== '--out' || argv[1].length === 0) {
    throw new Error('usage: node scripts/package-release.mjs --out <absolute-dir>');
  }

  const requested = argv[1];
  if (!isAbsolute(requested)) {
    throw new Error('--out must be an absolute directory path');
  }
  if (normalize(requested) !== requested || resolve(requested) !== requested) {
    throw new Error('--out must be an absolute normalized directory path');
  }
  return requested;
}

async function ensureAbsent(path) {
  try {
    await lstat(path);
  } catch (error) {
    if (error?.code === 'ENOENT') return;
    throw error;
  }
  throw new Error(`output already exists: ${path}`);
}

async function resolveSafeOutput(requested) {
  const resolvedSourceRoot = await realpath(sourceRoot);
  const requestedParent = dirname(requested);

  let parentInfo;
  try {
    parentInfo = await stat(requestedParent);
  } catch (error) {
    if (error?.code === 'ENOENT') {
      throw new Error(`output parent does not exist: ${requestedParent}`);
    }
    throw error;
  }
  if (!parentInfo.isDirectory()) {
    throw new Error(`output parent is not a directory: ${requestedParent}`);
  }

  const resolvedParent = await realpath(requestedParent);
  const finalOutput = join(resolvedParent, basename(requested));
  if (parse(finalOutput).root === finalOutput) {
    throw new Error('unsafe output path: filesystem root');
  }
  if (isWithin(resolvedSourceRoot, finalOutput)) {
    throw new Error('unsafe output path: it contains the package source');
  }
  for (const copiedDirectory of ['server', 'web']) {
    if (isWithin(finalOutput, join(resolvedSourceRoot, copiedDirectory))) {
      throw new Error(`unsafe output path: it is inside source ${copiedDirectory}/`);
    }
  }

  await ensureAbsent(finalOutput);
  return { finalOutput, resolvedParent, resolvedSourceRoot };
}

async function checkedSource(path, boundary) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) {
    throw new Error(`source symlink is not allowed: ${relative(boundary, path)}`);
  }
  const resolvedPath = await realpath(path);
  if (!isWithin(resolvedPath, boundary)) {
    throw new Error(`source path escapes the package root: ${relative(boundary, path)}`);
  }
  return { info, resolvedPath };
}

async function readCheckedFile(path, boundary) {
  const { info } = await checkedSource(path, boundary);
  if (!info.isFile()) {
    throw new Error(`source is not a regular file: ${relative(boundary, path)}`);
  }

  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error?.code === 'ELOOP') {
      throw new Error(`source symlink is not allowed: ${relative(boundary, path)}`);
    }
    throw error;
  }

  try {
    const openedInfo = await handle.stat();
    if (!openedInfo.isFile()) {
      throw new Error(`source is not a regular file: ${relative(boundary, path)}`);
    }
    const bytes = await handle.readFile();
    const afterInfo = await lstat(path);
    if (afterInfo.isSymbolicLink() || !afterInfo.isFile()) {
      throw new Error(`source changed while packaging: ${relative(boundary, path)}`);
    }
    if (openedInfo.dev !== afterInfo.dev || openedInfo.ino !== afterInfo.ino) {
      throw new Error(`source changed while packaging: ${relative(boundary, path)}`);
    }
    const resolvedPath = await realpath(path);
    if (!isWithin(resolvedPath, boundary)) {
      throw new Error(`source path escapes the package root: ${relative(boundary, path)}`);
    }
    return { bytes, mode: openedInfo.mode & 0o777 };
  } finally {
    await handle.close();
  }
}

async function writeExclusive(path, bytes, mode = 0o644) {
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  await chmod(path, mode);
}

async function copyMaterialized(source, destination, boundary) {
  const { info } = await checkedSource(source, boundary);
  if (info.isDirectory()) {
    await mkdir(destination, { mode: 0o700 });
    const names = await readdir(source);
    names.sort((left, right) => left.localeCompare(right));
    for (const name of names) {
      await copyMaterialized(join(source, name), join(destination, name), boundary);
    }
    const afterInfo = await lstat(source);
    if (afterInfo.isSymbolicLink() || !afterInfo.isDirectory()) {
      throw new Error(`source changed while packaging: ${relative(boundary, source)}`);
    }
    await chmod(destination, info.mode & 0o777);
    return;
  }
  if (!info.isFile()) {
    throw new Error(`source is not a regular file or directory: ${relative(boundary, source)}`);
  }

  const { bytes, mode } = await readCheckedFile(source, boundary);
  await writeExclusive(destination, bytes, mode);
}

async function readJsonSource(name, boundary) {
  const { bytes } = await readCheckedFile(join(sourceRoot, name), boundary);
  try {
    return JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error(`source ${name} is not valid JSON`);
  }
}

function formatJson(value) {
  return `${JSON.stringify(value, null, 2)}\n`;
}

async function validateCanonicalManifests(boundary) {
  const [pluginManifest, mcpConfig] = await Promise.all([
    readJsonSource('plugin.json', boundary),
    readJsonSource('mcp.json', boundary),
  ]);
  if (!isDeepStrictEqual(pluginManifest, expectedPluginManifest)) {
    throw new Error('source plugin.json does not match the Agent Plugins 1.0.0 manifest');
  }
  if (!isDeepStrictEqual(mcpConfig, expectedMcpConfig)) {
    throw new Error('source mcp.json does not match the Agent Plugins 1.0.0 MCP configuration');
  }
  return pluginManifest;
}

async function buildArtifacts(tempOutput, sourceBoundary, pluginManifest) {
  const portableRoot = join(tempOutput, 'agent-room-agent-plugin');
  const claudeRoot = join(tempOutput, 'agent-room-claude-code');
  await mkdir(portableRoot, { mode: 0o700 });
  await mkdir(claudeRoot, { mode: 0o700 });

  for (const entry of portableEntries) {
    await copyMaterialized(join(sourceRoot, entry), join(portableRoot, entry), sourceBoundary);
  }

  const claudeManifest = {
    name: pluginManifest.name,
    version: pluginManifest.version,
    description: pluginManifest.description,
    author: pluginManifest.author,
    license: pluginManifest.license,
  };
  const claudeMcp = {
    mcpServers: {
      'agent-room': {
        command: 'node',
        args: ['${CLAUDE_PLUGIN_ROOT}/server/mcp-stdio.mjs'],
        cwd: '${CLAUDE_PLUGIN_DATA}',
      },
    },
  };

  const claudeManifestDirectory = join(claudeRoot, '.claude-plugin');
  await mkdir(claudeManifestDirectory, { mode: 0o755 });
  await writeExclusive(join(claudeManifestDirectory, 'plugin.json'), formatJson(claudeManifest));
  await writeExclusive(join(claudeRoot, '.mcp.json'), formatJson(claudeMcp));

  const portableBoundary = await realpath(portableRoot);
  for (const entry of sharedEntries) {
    await copyMaterialized(join(portableRoot, entry), join(claudeRoot, entry), portableBoundary);
  }
}

async function main() {
  const requestedOutput = parseOutputArgument(process.argv.slice(2));
  const { finalOutput, resolvedParent, resolvedSourceRoot } = await resolveSafeOutput(requestedOutput);
  const pluginManifest = await validateCanonicalManifests(resolvedSourceRoot);
  const tempOutput = join(
    resolvedParent,
    `.${basename(finalOutput)}.tmp-${process.pid}-${randomUUID()}`,
  );
  await ensureAbsent(tempOutput);

  let tempCreated = false;
  try {
    await mkdir(tempOutput, { mode: 0o700 });
    tempCreated = true;
    await buildArtifacts(tempOutput, resolvedSourceRoot, pluginManifest);
    await ensureAbsent(finalOutput);
    await rename(tempOutput, finalOutput);
    tempCreated = false;
  } finally {
    if (tempCreated) {
      await rm(tempOutput, { recursive: true, force: true, maxRetries: 2 });
    }
  }

  process.stdout.write(`${finalOutput}\n`);
}

main().catch((error) => {
  process.stderr.write(`agent-room package: ${error.message}\n`);
  process.exitCode = 1;
});
