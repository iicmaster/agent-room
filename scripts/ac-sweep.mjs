#!/usr/bin/env node
// Epic acceptance-criteria sweep.
//
// Story 1.7 added the `agent-room setup` CLI without the runtime gate, breaking
// Story 1.1's "any entrypoint exits non-zero" criterion. Nothing caught it: the
// suite stayed green for the rest of the epic, because the suite tests what a
// story built, not what an EARLIER story promised. This script is the check
// that closes that gap — it is deliberately narrow about what it can prove.
//
// What it proves, mechanically:
//   1. every story of the epic has an entry;
//   2. every entry names at least one evidence pointer;
//   3. every pointer names a real test (by name) in a real test file;
//   4. every named test actually exists in the suite that runs.
//
// What it cannot prove, and says so: that a named test genuinely covers its
// criterion. That judgement is recorded in the evidence file's `note` field and
// reviewed by a human — a script pretending to grade coverage would be worse
// than no script, because it would be trusted.
//
// Usage:
//   node scripts/ac-sweep.mjs --epic 1 [--json]
//   node scripts/ac-sweep.mjs --epic 1 --seed        # print a starter file
//
// Evidence lives beside the specs: docs/implementation/ac-evidence.yaml

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const EPICS_MD = join(ROOT, 'docs', 'epics.md')
const EVIDENCE = join(ROOT, 'docs', 'implementation', 'ac-evidence.yaml')
const TESTS_DIR = join(ROOT, 'tests')

function parseArgs(argv) {
  const args = { epic: null, json: false, seed: false }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (token === '--json') args.json = true
    else if (token === '--seed') args.seed = true
    else if (token === '--epic') args.epic = Number(argv[index + 1])
  }
  return args
}

// --- Story inventory from docs/epics.md ---------------------------------------
// The format is stable: "### Story N.M:" headings, one per story, in order.
function epicStories(epicNumber) {
  const text = readFileSync(EPICS_MD, 'utf8')
  const heading = new RegExp(`^### Story ${epicNumber}\\.(\\d+):(.+)$`, 'gm')
  const stories = []
  let match
  while ((match = heading.exec(text)) !== null) {
    const start = match.index + match[0].length
    const next = text.indexOf('\n### Story', start)
    const body = text.slice(start, next === -1 ? text.length : next)
    stories.push({
      id: `${epicNumber}.${match[1]}`,
      title: match[2].trim(),
      // Count the bolded Given/When/Then clauses: each is one criterion.
      criteria: (body.match(/^\*\*Given\*\*/gm) ?? []).length,
    })
  }
  return stories
}

// --- Evidence file ------------------------------------------------------------
// A deliberately small subset of YAML: a mapping of story id -> { evidence: [...], note }.
function parseEvidence(text) {
  const entries = new Map()
  const lines = text.split('\n')
  let current = null
  let inEvidence = false
  for (const raw of lines) {
    const line = raw.replace(/\s+$/, '')
    if (/^\s*#/.test(line) || line.trim() === '') continue
    const storyMatch = /^  (\d+\.\d+):\s*(?:#.*)?$/.exec(line)
    if (storyMatch) {
      current = storyMatch[1]
      entries.set(current, { evidence: [], note: '' })
      inEvidence = false
      continue
    }
    if (current === null) continue
    const evidenceMatch = /^\s+-\s+test:\s*"?([^"]+)"?\s*$/.exec(line)
    if (evidenceMatch) {
      entries.get(current).evidence.push({ test: evidenceMatch[1], file: '' })
      inEvidence = true
      continue
    }
    const fileMatch = /^\s+file:\s*"?([^"]+)"?\s*$/.exec(line)
    if (fileMatch && entries.get(current).evidence.length > 0) {
      entries.get(current).evidence[entries.get(current).evidence.length - 1].file = fileMatch[1]
      continue
    }
    const noteMatch = /^\s+note:\s*(.+)$/.exec(line)
    if (noteMatch) {
      entries.get(current).note = noteMatch[1].trim()
      inEvidence = false
    }
  }
  return entries
}

// --- The live test inventory --------------------------------------------------
// Read from the files, not from a cached list: a renamed or deleted test must
// make the sweep fail, which is the whole point.
function testInventory() {
  const names = new Map()
  const files = readdirSync(TESTS_DIR, { withFileTypes: true })
  const testFiles = files
    .filter(entry => entry.isFile() && entry.name.endsWith('.test.mjs'))
    .map(entry => entry.name)
  const nested = files
    .filter(entry => entry.isDirectory())
    .flatMap(dir => readdirSync(join(TESTS_DIR, dir.name))
      .filter(name => name.endsWith('.test.mjs'))
      .map(name => `${dir.name}/${name}`))
  for (const name of [...testFiles, ...nested]) {
    const source = readFileSync(join(TESTS_DIR, name), 'utf8')
    for (const match of source.matchAll(/^test\(\s*\n?\s*(['"])((?:\\.|(?!\1).)*)\1/gm)) {
      // The captured text is the SOURCE spelling: a quote inside a name is
      // written escaped ("the session\'s request"), and the evidence file
      // spells it the way a human reads it. Unescape the quote characters
      // only — the name a test prints is the name the evidence cites.
      names.set(match[2].replace(/\\(['"])/g, '$1'), name)
    }
  }
  return names
}

const args = parseArgs(process.argv.slice(2))
if (args.epic === null || Number.isNaN(args.epic)) {
  process.stderr.write('usage: node scripts/ac-sweep.mjs --epic <N> [--json|--seed]\n')
  process.exit(2)
}

const stories = epicStories(args.epic)

if (args.seed) {
  const lines = [
    '# Acceptance-criteria evidence for each story of the epic.',
    '#',
    '# `test:`  — the exact name of a test in tests/ that proves the criterion. The sweep',
    '#           fails if that test does not exist, so a renamed or deleted test surfaces.',
    '# `file:`  — the file the test lives in (documentation for the reader; the sweep reads',
    '#           the live suite either way).',
    '# `note:`  — what the evidence does NOT prove. Read this before trusting the sweep:',
    '#           it verifies that evidence exists, never that evidence is sufficient.',
    '',
  ]
  for (const story of stories) {
    lines.push(`  ${story.id}:                       # ${story.title} (${story.criteria} criteria)`)
    lines.push('    note: TODO — say what the evidence below does not prove')
    lines.push('    evidence:')
    lines.push('      - test: "TODO exact test name"')
    lines.push('        file: "tests/example.test.mjs"')
    lines.push('')
  }
  process.stdout.write(lines.join('\n'))
  process.exit(0)
}

const problems = []
const checked = []

if (stories.length === 0) {
  problems.push(`no stories found for epic ${args.epic} in docs/epics.md — is the number right?`)
}

let evidence = new Map()
if (!existsSync(EVIDENCE)) {
  problems.push(`docs/implementation/ac-evidence.yaml is missing — run with --seed to create a starter`)
} else {
  evidence = parseEvidence(readFileSync(EVIDENCE, 'utf8'))
}

const inventory = testInventory()

for (const story of stories) {
  const entry = evidence.get(story.id)
  if (entry === undefined) {
    problems.push(`${story.id} (${story.title}) has no evidence entry — an AC with no evidence is how Story 1.7c broke Story 1.1 silently`)
    continue
  }
  if (entry.evidence.length === 0) {
    problems.push(`${story.id} (${story.title}) declares no evidence`)
    continue
  }
  if (entry.note === '' || entry.note.startsWith('TODO')) {
    problems.push(`${story.id} (${story.title}) has no real note about what its evidence does not prove`)
  }
  for (const item of entry.evidence) {
    if (item.test.startsWith('TODO')) {
      problems.push(`${story.id} still points at a TODO test name`)
      continue
    }
    const where = inventory.get(item.test)
    if (where === undefined) {
      problems.push(`${story.id} cites a test that does not exist in the suite: "${item.test}"`)
      continue
    }
    checked.push({ story: story.id, test: item.test, file: where })
  }
}

const result = {
  epic: args.epic,
  stories: stories.length,
  criteria: stories.reduce((sum, story) => sum + story.criteria, 0),
  evidenceChecked: checked.length,
  testsInSuite: inventory.size,
  problems,
  verdict: problems.length === 0 ? 'clean' : 'gaps',
  scopeNote:
    'Proves: every story has evidence, every cited test exists in the live suite. ' +
    'Does NOT prove: that a cited test actually covers its criterion — that judgement ' +
    'lives in each note and is the reviewer\'s to make.',
}

if (args.json) {
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`)
} else {
  process.stdout.write(
    `Epic ${args.epic}: ${result.stories} stories · ${result.criteria} criteria · ` +
    `${result.evidenceChecked} evidence pointers · ${result.testsInSuite} tests in suite\n` +
    `Verdict: ${result.verdict}\n`,
  )
  for (const problem of result.problems) process.stdout.write(`  - ${problem}\n`)
}

process.exit(result.verdict === 'clean' ? 0 : 1)
