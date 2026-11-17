// Story 5.2 — AC1/AC3 evidence for the release-readiness qualification runner.
//
// Focused tests only (the PM owns the epic full-suite gate). Each test drives
// the real runQualifyCommand with injected prerequisites/cells so the matrix,
// gating, exit codes and receipt invalidation are proven deterministically —
// no full pipeline, no 1000-send burst, no full-suite sweep in this file.

import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { PassThrough } from 'node:stream'
import test from 'node:test'

import {
  parseQualifyArgs, runQualifyCommand, cellPackaging, evaluateValidateReport, digestCandidate, sm2RowQualified,
} from '../server/cli/qualify-commands.mjs'

const CELL_NAMES = ['PREREQ', 'RECEIPT', 'SM-1', 'SM-2', 'SM-3', 'SM-C1', 'SM-C2', 'FULL-SUITE', 'PACKAGING']

// SM-2 must never soft-pass on an unmeasured scale. A row that meets only the
// latency/idle thresholds is NOT qualified unless it also proves 1000 sessions
// and the required watcher spread (Oren's finding, PM verified).
test('SM-2 predicate refuses a 5-session/1-watcher row even with good latency', () => {
  const smallScale = { p95_ms: 100, p99_ms: 300, idle_sql: 0, sessions_requested: 5, watchers: 1 }
  assert.equal(sm2RowQualified(smallScale), false)

  // The full-scale row is the only shape that can pass.
  const fullScale = { ...smallScale, sessions_requested: 1000, watchers: 1000 }
  assert.equal(sm2RowQualified(fullScale), true)

  // Scale alone cannot rescue a latency or idle-SQL breach.
  assert.equal(sm2RowQualified({ ...fullScale, p95_ms: 251 }), false)
  assert.equal(sm2RowQualified({ ...fullScale, idle_sql: 1 }), false)

  // 1000 sessions spread over only 1 watcher is still not the AC's 1000-watch scale.
  assert.equal(sm2RowQualified({ ...fullScale, watchers: 1 }), false)
})

function capture() {
  const output = new PassThrough()
  const errorOutput = new PassThrough()
  let stdout = ''
  let stderr = ''
  output.on('data', chunk => { stdout += chunk })
  errorOutput.on('data', chunk => { stderr += chunk })
  return { output, errorOutput, get stdout() { return stdout }, get stderr() { return stderr } }
}

function tempReceiptDir() {
  return mkdtempSync(join(tmpdir(), 'ar-story52-receipt-'))
}

const okPrereq = {
  ok: true,
  reasons: [],
  candidate: { files: 20, bytes: 1000, sha256: 'a'.repeat(64) },
}

function stubCells(status = 'qualified') {
  return Object.fromEntries(CELL_NAMES.map(name => [
    name,
    { status, ...(status === 'qualified' ? {} : { reason: `${name} is ${status}` }) },
  ]))
}

// --- argv grammar ------------------------------------------------------------------
test('parseQualifyArgs: defaults, bounds, enums, remote pairing', () => {
  assert.deepEqual(parseQualifyArgs(['--sessions', '10', '--json']).options, {
    sessions: 10, json: true, remote: null, invite: null, harness: 'generic',
  })
  assert.ok(parseQualifyArgs(['--sessions', '0']).error)
  assert.ok(parseQualifyArgs(['--sessions', '1001']).error)
  assert.ok(parseQualifyArgs(['--sessions', '1.5']).error)
  assert.ok(parseQualifyArgs(['--harness', 'bogus']).error)
  assert.ok(parseQualifyArgs(['--remote', 'https://x']).error, 'remote needs invite')
  assert.ok(parseQualifyArgs(['--invite', 'ar_inv1_x']).error, 'invite needs remote')
  assert.ok(parseQualifyArgs(['--remote', 'http://x', '--invite', 't']).error, 'remote must be https')
  assert.ok(parseQualifyArgs(['--bogus']).error)
  assert.equal(parseQualifyArgs(['--sessions', '1000']).options.sessions, 1000)
})

// --- AC1: prerequisite gating + inconclusive semantics -----------------------------
test('missing prerequisite (nofile) -> inconclusive + exit 1, no pipeline', async () => {
  const dir = tempReceiptDir()
  const cab = capture()
  const outcome = await runQualifyCommand(['--json'], {
    output: cab.output, errorOutput: cab.errorOutput, pluginDataDir: dir,
    nofileProbe: async () => ({ status: 'warn', limit: 4095, recommended: 4096, message: 'NOFILE=4095 (< 4096); raise with: ulimit -n 4096' }),
    profileFn: async () => ({ cpu: 'x' }),
    suiteFn: async () => { throw new Error('pipeline must not run') },
  })
  assert.equal(outcome.exitCode, 1)
  assert.equal(outcome.status, 'inconclusive')
  const report = JSON.parse(cab.stdout)
  assert.equal(report.verdict, 'inconclusive')
  assert.equal(report.exit_code, 1)
  assert.match(report.cells.PREREQ.reason, /NOFILE=4095/)
  assert.equal(report.cells['SM-1'].status, 'inconclusive')
  assert.equal(report.cells['SM-2'].status, 'inconclusive')
})

test('Node/SQLite prerequisite failure -> inconclusive with a clear reason', async () => {
  const dir = tempReceiptDir()
  const cab = capture()
  const outcome = await runQualifyCommand(['--json'], {
    output: cab.output, errorOutput: cab.errorOutput, pluginDataDir: dir,
    runtimeAssert: () => { throw Object.assign(new Error('agent-room requires Node 24.15 or newer; found 24.10'), { code: 'node_version_unsupported' }) },
    profileFn: async () => ({}),
  })
  assert.equal(outcome.exitCode, 1)
  const report = JSON.parse(cab.stdout)
  assert.equal(report.verdict, 'inconclusive')
  assert.match(report.cells.PREREQ.reason, /Node 24\.15/)
})

// --- AC1: per-cell status + exit codes ---------------------------------------------
test('every cell qualified -> qualified + exit 0', async () => {
  const dir = tempReceiptDir()
  const cab = capture()
  const cells = stubCells('qualified')
  const outcome = await runQualifyCommand(['--json'], {
    output: cab.output, errorOutput: cab.errorOutput, pluginDataDir: dir,
    nofileProbe: async () => ({ status: 'ok', limit: 4096 }),
    runtimeAssert: () => ({}),
    profileFn: async () => ({ cpu: 'x' }),
    suiteFn: async () => cells['FULL-SUITE'],
    packagingFn: async () => cells.PACKAGING,
    // Override the four measured cells with stubs, keeping the row set honest.
    ...stubOverrides(cells),
  })
  assert.equal(outcome.exitCode, 0)
  const report = JSON.parse(cab.stdout)
  assert.equal(report.verdict, 'qualified')
  assert.equal(report.exit_code, 0)
  assert.deepEqual(Object.keys(report.cells).sort(), [...CELL_NAMES].sort())
  for (const name of CELL_NAMES) assert.equal(report.cells[name].status, 'qualified', name)
})

test('one failed cell -> failed + exit 1 (no retry)', async () => {
  const dir = tempReceiptDir()
  const cab = capture()
  const cells = stubCells('qualified')
  cells['SM-1'] = { status: 'failed', reason: 'round 2 breached the threshold' }
  const outcome = await runQualifyCommand(['--json'], {
    output: cab.output, errorOutput: cab.errorOutput, pluginDataDir: dir,
    nofileProbe: async () => ({ status: 'ok', limit: 4096 }),
    runtimeAssert: () => ({}),
    profileFn: async () => ({}),
    suiteFn: async () => cells['FULL-SUITE'],
    packagingFn: async () => cells.PACKAGING,
    ...stubOverrides(cells),
  })
  assert.equal(outcome.exitCode, 1)
  const report = JSON.parse(cab.stdout)
  assert.equal(report.verdict, 'failed')
  assert.equal(report.cells['SM-1'].status, 'failed')
  assert.equal(report.cells['SM-1'].reason, 'round 2 breached the threshold')
})

test('one inconclusive cell -> inconclusive + exit 1', async () => {
  const dir = tempReceiptDir()
  const cab = capture()
  const cells = stubCells('qualified')
  cells.PACKAGING = { status: 'inconclusive', reason: 'no claude binary' }
  const outcome = await runQualifyCommand(['--json'], {
    output: cab.output, errorOutput: cab.errorOutput, pluginDataDir: dir,
    nofileProbe: async () => ({ status: 'ok', limit: 4096 }),
    runtimeAssert: () => ({}),
    profileFn: async () => ({}),
    suiteFn: async () => cells['FULL-SUITE'],
    packagingFn: async () => cells.PACKAGING,
    ...stubOverrides(cells),
  })
  assert.equal(outcome.exitCode, 1)
  assert.equal(JSON.parse(cab.stdout).verdict, 'inconclusive')
})

// --- AC3: receipt invalidation on candidate change ---------------------------------
test('changed candidate sha256 invalidates the prior receipt -> failed + exit 1', async () => {
  const dir = tempReceiptDir()
  writeFileSync(join(dir, 'qualify-receipt.json'), JSON.stringify({ sha256: 'deadbeef', verdict: 'qualified' }))
  const cab = capture()
  const outcome = await runQualifyCommand(['--json'], {
    output: cab.output, errorOutput: cab.errorOutput, pluginDataDir: dir,
    profileFn: async () => ({}),
  })
  assert.equal(outcome.exitCode, 1)
  const report = JSON.parse(cab.stdout)
  assert.equal(report.verdict, 'failed')
  assert.equal(report.cells.RECEIPT.status, 'failed')
  assert.match(report.cells.RECEIPT.reason, /prior receipt sha256=deadbeef/)
  assert.match(report.cells.RECEIPT.reason, /current sha256=[0-9a-f]{64}/)
  assert.equal(report.receipt.previous_sha256, 'deadbeef')
})

test('a matching candidate receipt is not invalidated', async () => {
  const dir = tempReceiptDir()
  const cab = capture()
  const cells = stubCells('qualified')
  // First run writes a receipt for whatever the real candidate sha256 is.
  await runQualifyCommand(['--json'], {
    output: new PassThrough(), errorOutput: new PassThrough(), pluginDataDir: dir,
    nofileProbe: async () => ({ status: 'ok', limit: 4096 }),
    runtimeAssert: () => ({}), profileFn: async () => ({}),
    suiteFn: async () => cells['FULL-SUITE'], packagingFn: async () => cells.PACKAGING,
    ...stubOverrides(cells),
  })
  const { readFileSync } = await import('node:fs')
  const stored = JSON.parse(readFileSync(join(dir, 'qualify-receipt.json'), 'utf8'))
  assert.equal(typeof stored.sha256, 'string')
  const cab2 = capture()
  await runQualifyCommand(['--json'], {
    output: cab2.output, errorOutput: cab2.errorOutput, pluginDataDir: dir,
    nofileProbe: async () => ({ status: 'ok', limit: 4096 }),
    runtimeAssert: () => ({}), profileFn: async () => ({}),
    suiteFn: async () => cells['FULL-SUITE'], packagingFn: async () => cells.PACKAGING,
    ...stubOverrides(cells),
  })
  const report = JSON.parse(cab2.stdout)
  assert.notEqual(report.cells.RECEIPT.status, 'failed')
  assert.equal(report.receipt.invalidated, false)
})

// The measured cells (SM-1, SM-2, SM-3, negatives) are intentionally NOT
// stubbed in a way that hides their thresholds — these tests inject them via
// the seams below and assert the aggregate verdict; the real measurement path
// is exercised by `agent-room qualify --json` (reported separately to the PM).
function cleanReport(target = '/release/agent-room-claude-code/.claude-plugin/plugin.json') {
  return {
    success: true, strict: true, target,
    manifest: { errors: [], warnings: [], notes: [] },
    contents: [],
  }
}

function stubOverrides(cells) {
  return {
    sm1Fn: async () => cells['SM-1'],
    sm2Fn: async () => cells['SM-2'],
    sm3Fn: async () => cells['SM-3'],
    negativesFn: async () => ({
      status: cells['SM-C1'].status,
      reason: cells['SM-C1'].reason,
      checks: [
        { check: 'loop_pause_and_wake_reset', status: cells['SM-C1'].status },
        { check: 'allowlist_leak_canary', status: cells['SM-C2'].status, leaks: 0, scanned: 3 },
      ],
    }),
  }
}

// --- E5-A1: packaging cell grades the FULL strict-validate report ------------------
test('E5-A1: evaluateValidateReport rejects degraded reports, accepts a clean one', () => {
  const target = '/release/agent-room-claude-code/.claude-plugin/plugin.json'
  const good = { code: 0 }
  assert.equal(evaluateValidateReport(cleanReport(target), good, target).ok, true)

  const degraded = [
    ['warnings present', r => { r.manifest.warnings.push('w') }],
    ['notes present', r => { r.manifest.notes.push('n') }],
    ['contents non-empty', r => { r.contents.push('x') }],
    ['strict false', r => { r.strict = false }],
    ['success false', r => { r.success = false }],
    ['wrong target', r => { r.target = '/somewhere/else/plugin.json' }],
    ['errors array missing', r => { delete r.manifest.errors }],
    ['contents missing', r => { delete r.contents }],
  ]
  for (const [label, mutate] of degraded) {
    const report = cleanReport(target)
    mutate(report)
    assert.equal(evaluateValidateReport(report, good, target).ok, false, label)
  }
})

test('E5-A1: packaging cell FAILS on a degraded validate report; qualify exits 1', async () => {
  const target = '/release/agent-room-claude-code/.claude-plugin/plugin.json'
  const degraded = cleanReport(target)
  degraded.manifest.warnings.push('a warning the old gate ignored')
  degraded.contents.push('unexpected file')
  degraded.strict = false

  // Invoke the REAL cellPackaging with a stubbed subprocess returning the
  // degraded report. validatorBinary bypasses PATH discovery; run() fakes both
  // the packager and validator. The cell must FAIL, never PASS.
  const cell = await cellPackaging({}, {
    validatorBinary: '/fake/claude',
    run: async (file, args) => {
      if (args[0] === 'plugin') return { code: 0, stdout: JSON.stringify(degraded), stderr: '' }
      return { code: 0, stdout: '', stderr: '' } // packager
    },
  })
  assert.equal(cell.status, 'failed')
  assert.match(cell.reason, /warnings|contents|strict/)

  // End-to-end: wire that degraded cell into the runner; verdict failed, exit 1.
  const dir = tempReceiptDir()
  const cab = capture()
  const cells = stubCells('qualified')
  const outcome = await runQualifyCommand(['--json'], {
    output: cab.output, errorOutput: cab.errorOutput, pluginDataDir: dir,
    nofileProbe: async () => ({ status: 'ok', limit: 4096 }),
    runtimeAssert: () => ({}),
    profileFn: async () => ({}),
    suiteFn: async () => cells['FULL-SUITE'],
    packagingFn: async () => cell,
    ...stubOverrides(cells),
  })
  assert.equal(outcome.exitCode, 1)
  const report = JSON.parse(cab.stdout)
  assert.equal(report.verdict, 'failed')
  assert.equal(report.cells.PACKAGING.status, 'failed')
  // runQualifyCommand's emit writes process.exitCode; restore so the test
  // runner's own exit code is not polluted by this deliberate failing run.
  process.exitCode = 0
})

// --- E5-A2: candidate digest ignores gitignored clutter & symlinks ------------------
test('E5-A2: digestCandidate never throws on a gitignored symlink and is stable', () => {
  const work = mkdtempSync(join(tmpdir(), 'ar-e5a2-digest-'))
  execFileSync('git', ['init', '-q'], { cwd: work })
  writeFileSync(join(work, '.gitignore'), '.vendor-lab/\n')
  writeFileSync(join(work, 'keep.txt'), 'tracked content\n')
  execFileSync('git', ['add', '.gitignore', 'keep.txt'], { cwd: work })

  // Exact reproducer: symlink inside a gitignored directory.
  const clutterDir = join(work, '.vendor-lab', 'agy-home', '.gemini')
  mkdirSync(clutterDir, { recursive: true })
  symlinkSync(join(work, 'keep.txt'), join(clutterDir, 'GEMINI.md'))

  const first = digestCandidate(work)
  const second = digestCandidate(work)
  assert.equal(first.sha256, second.sha256, 'digest must be stable across runs')
  assert.equal(first.files, 2, 'only the 2 tracked files contribute')
  assert.equal(first.digest_source, 'git-ls-files')

  // Adding more ignored clutter does not change the digest.
  writeFileSync(join(work, '.vendor-lab', 'random.txt'), 'clutter')
  assert.equal(digestCandidate(work).sha256, first.sha256)
})

test('E5-A2: digestCandidate fallback skips gitignored dirs and symlinks', () => {
  const work = mkdtempSync(join(tmpdir(), 'ar-e5a2-fallback-'))
  writeFileSync(join(work, '.gitignore'), 'ignored/\n')
  writeFileSync(join(work, 'keep.txt'), 'real\n')
  const ignored = join(work, 'ignored')
  mkdirSync(ignored, { recursive: true })
  writeFileSync(join(ignored, 'noise.txt'), 'ignored')
  symlinkSync(join(work, 'keep.txt'), join(work, 'link.txt'))

  // No git repo here -> deterministic bounded-walk fallback. Must not throw.
  const result = digestCandidate(work)
  assert.equal(result.digest_source, 'fallback-walk')
  assert.equal(result.files, 2, 'keep.txt + .gitignore; symlink and ignored/ skipped')
  assert.equal(digestCandidate(work).sha256, result.sha256)
})

test('E5-A2: qualify completes with a stable digest in a cluttered tree', async () => {
  const work = mkdtempSync(join(tmpdir(), 'ar-e5a2-qualify-'))
  execFileSync('git', ['init', '-q'], { cwd: work })
  writeFileSync(join(work, '.gitignore'), '.vendor-lab/\n')
  const required = [
    'server/cli/agent-room.mjs', 'server/mcp-stdio.mjs', 'server/api/server.mjs',
    'server/store/room-log.mjs', 'plugin.json', 'mcp.json', 'web/index.html',
    'skills/agent-room/SKILL.md',
  ]
  for (const file of required) {
    const full = join(work, file)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, `content of ${file}\n`)
  }
  execFileSync('git', ['add', '.'], { cwd: work })

  // The exact clutter that used to throw: symlink inside a gitignored dir.
  const clutterDir = join(work, '.vendor-lab', 'agy-home', '.gemini')
  mkdirSync(clutterDir, { recursive: true })
  symlinkSync(join(work, 'plugin.json'), join(clutterDir, 'GEMINI.md'))

  const dir = tempReceiptDir()
  const cab = capture()
  const cells = stubCells('qualified')
  const outcome = await runQualifyCommand(['--json'], {
    output: cab.output, errorOutput: cab.errorOutput, pluginDataDir: dir,
    candidateRoot: work,
    nofileProbe: async () => ({ status: 'ok', limit: 4096 }),
    runtimeAssert: () => ({}),
    profileFn: async () => ({}),
    suiteFn: async () => cells['FULL-SUITE'],
    packagingFn: async () => cells.PACKAGING,
    ...stubOverrides(cells),
  })
  process.exitCode = 0 // restore runner exit code polluted by emit()
  assert.equal(outcome.exitCode, 0, 'qualify must complete in a cluttered tree')
  const report = JSON.parse(cab.stdout)
  assert.equal(report.candidate.digest_source, 'git-ls-files')
  assert.match(report.candidate.sha256, /^[0-9a-f]{64}$/, 'stable digest present')
  assert.equal(report.candidate.files, required.length + 1, '+1 for .gitignore')
  // Re-run: identical digest (stable).
  process.exitCode = 0
  const cab2 = capture()
  await runQualifyCommand(['--json'], {
    output: cab2.output, errorOutput: cab2.errorOutput, pluginDataDir: tempReceiptDir(),
    candidateRoot: work,
    nofileProbe: async () => ({ status: 'ok', limit: 4096 }),
    runtimeAssert: () => ({}),
    profileFn: async () => ({}),
    suiteFn: async () => cells['FULL-SUITE'],
    packagingFn: async () => cells.PACKAGING,
    ...stubOverrides(cells),
  })
  process.exitCode = 0
  assert.equal(JSON.parse(cab2.stdout).candidate.sha256, report.candidate.sha256)
})
