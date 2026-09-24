import assert from 'node:assert/strict'
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Symlink-safe walk: never follows links (dangling or cyclic) and tolerates
// entries that vanish mid-scan.
function listModules(directory) {
  const found = []
  let names
  try {
    names = readdirSync(directory)
  } catch (error) {
    if (error?.code === 'ENOENT') return found
    throw error
  }
  for (const name of names.sort()) {
    const path = join(directory, name)
    let info
    try {
      info = lstatSync(path)
    } catch (error) {
      if (error?.code === 'ENOENT') continue
      throw error
    }
    if (info.isSymbolicLink()) continue
    if (info.isDirectory()) found.push(...listModules(path))
    else if (name.endsWith('.mjs')) found.push(path)
  }
  return found
}

const IMPORT_SPECIFIER_PATTERNS = [
  /\bfrom\s+['"]([^'"]+)['"]/g,
  /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g,
  /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g,
]

test('package.json declares zero runtime and development dependencies', () => {
  const packageJson = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'))
  assert.equal(Object.keys(packageJson.dependencies ?? {}).length, 0)
  assert.equal(Object.keys(packageJson.devDependencies ?? {}).length, 0)
})

test('the source tree contains no node_modules directory', () => {
  assert.equal(existsSync(join(ROOT, 'node_modules')), false)
})

test('every import under server/ and scripts/ uses node built-ins or relative specifiers', () => {
  const bare = []
  for (const directory of [join(ROOT, 'server'), join(ROOT, 'scripts')]) {
    for (const path of listModules(directory)) {
      let source
      try {
        source = readFileSync(path, 'utf8')
      } catch (error) {
        if (error?.code === 'ENOENT') continue
        throw error
      }
      for (const pattern of IMPORT_SPECIFIER_PATTERNS) {
        for (const match of source.matchAll(pattern)) {
          const specifier = match[1]
          if (!specifier.startsWith('node:') && !specifier.startsWith('.')) {
            bare.push(`${relative(ROOT, path)}: ${specifier}`)
          }
        }
      }
    }
  }
  assert.deepEqual(bare, [])
})
