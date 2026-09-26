// The AC sweep is a gate, not a document: it runs inside node --test so an
// epic cannot be declared done with an acceptance criterion that lost its
// evidence. Story 1.7c shipped an entrypoint that broke Story 1.1's criterion
// while the whole suite stayed green; this is what makes that class of silence
// fail.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const SWEEP = join(ROOT, 'scripts', 'ac-sweep.mjs')
const EVIDENCE = join(ROOT, 'docs', 'implementation', 'ac-evidence.yaml')

function sweep(args) {
  try {
    const stdout = execFileSync(process.execPath, [SWEEP, ...args], { cwd: ROOT, encoding: 'utf8' })
    return { code: 0, stdout }
  } catch (error) {
    return { code: error.status ?? 1, stdout: String(error.stdout ?? '') }
  }
}

test('every acceptance criterion of the completed epic has live evidence', () => {
  const result = sweep(['--epic', '1'])
  assert.equal(result.code, 0, `AC sweep found gaps:\n${result.stdout}`)
  assert.match(result.stdout, /Verdict: clean/)
})

test('the evidence file says what its evidence does not prove', () => {
  // A note field is the mechanism that keeps the sweep honest: without it the
  // file degenerates into a list of names that looks like coverage.
  const text = readFileSync(EVIDENCE, 'utf8')
  const notes = (text.match(/^    note: >-/gm) ?? []).length
  const stories = (text.match(/^  \d+\.\d+:/gm) ?? []).length
  assert.equal(notes, stories, 'every story entry carries a note')
  assert.doesNotMatch(text, /note: TODO/, 'no entry is left as a TODO')
  assert.ok(existsSync(EVIDENCE))
})

test('the sweep fails when an acceptance criterion has no evidence', () => {
  // The negative case: without it, a sweep that always returns clean would
  // satisfy every other test in this file.
  const bogus = sweep(['--epic', '99'])
  assert.notEqual(bogus.code, 0, 'a nonexistent epic is a failure, not a pass')
  assert.match(bogus.stdout, /gaps/)
})
