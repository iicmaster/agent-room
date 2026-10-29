#!/usr/bin/env node
// REL-1 Operator Flight Kit — evidence verifier (Epic 6, Story 6.1 prep;
// docs/implementation/reviews/epic-6-execution-agy.md Phase 3).
//
// Validates the captured evidence bundle for the physical two-machine demo:
//
//   node scripts/rel1-verify-evidence.mjs --dir docs/release-evidence/v0.2.0-rel1
//
// It checks (each with a color-coded [PASS]/[FAIL] line; exit 0 only if all pass):
//   1. Required artifacts present and non-zero: both client transcripts, the
//      screen recording, both preflight reports, the server log, the viewer
//      observation record, and the candidate binding (candidate.json).
//   2. The candidate binding matches the frozen record
//      docs/release-evidence/v0.2.0-candidate.json — commit AND both package
//      tree digests (the Candidate Immutability Law, on the evidence side).
//   3. Both preflight reports are green, carry the right roles, and report two
//      DIFFERENT Actor fingerprints (the two-machines requirement) against the
//      SAME https LAN origin.
//   4. The transcripts contain the required message round-trips (the runbook's
//      REL1-* markers and the send acknowledgments).
//   5. The viewer observation record carries the three live-observation
//      confirmations (presence, <5 s broadcast freshness, DM exclusion).
//   6. Secret scan over EVERY file in the bundle: no PEM private key material,
//      no session_token field, no ar_inv1_ invite token, no viewer cookie value
//      may appear anywhere in the evidence.
//
// Exit codes: 0 every check passed; 1 at least one check failed; 2 usage.

import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { recomputeFreshnessDocument } from './rel1-freshness.mjs'

const KIT = 'rel1-verify-evidence'
const REPORT_KIT = 'rel1-preflight'
const DEFAULT_EVIDENCE_DIR = join('docs', 'release-evidence', 'v0.2.0-rel1')

const scriptDir = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(scriptDir, '..')
const candidateRecordPath = join(repoRoot, 'docs', 'release-evidence', 'v0.2.0-candidate.json')

const FINGERPRINT_PATTERN = /^sha256:[0-9a-f]{64}$/
const RECORDING_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.mkv'])
const VIEWER_SESSION_EXTENSIONS = new Set(['.md', '.txt', '.json', '.har'])
const SCAN_CHUNK_BYTES = 1024 * 1024
const SCAN_OVERLAP_BYTES = 64 * 1024

// The secret patterns. Byte-oriented (latin1) so binary recordings scan the same
// as text; every pattern is far shorter than the overlap window.
const SECRET_PATTERNS = [
  { id: 'private-key', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/, what: 'PEM private key material (Ed25519 identity key or TLS key)' },
  { id: 'session-token', pattern: /session_token/, what: 'a session token field ("session_token")' },
  { id: 'invite-token', pattern: /ar_inv1_/, what: 'an ar_inv1_ invite token (shown exactly once at mint; never in evidence)' },
  { id: 'viewer-cookie', pattern: /agent_room_viewer[=:"'\s]+[A-Za-z0-9_-]{32,}/, what: 'a viewer cookie value (agent_room_viewer=…)' },
]

const colorize = process.stdout.isTTY && !process.env.NO_COLOR
const paint = colorize
  ? { green: s => `\u001B[32m${s}\u001B[0m`, red: s => `\u001B[31m${s}\u001B[0m`, bold: s => `\u001B[1m${s}\u001B[0m` }
  : { green: s => s, red: s => s, bold: s => s }

function say(line) {
  process.stdout.write(`${line}\n`)
}

const USAGE_LINES = [
  `usage: node scripts/rel1-verify-evidence.mjs --dir <evidence-directory>`,
  '',
  `  --dir    the REL-1 evidence bundle to verify (default: ${DEFAULT_EVIDENCE_DIR}).`,
  '',
  'Required bundle: candidate.json, preflight-claude.json, preflight-zcode.json,',
  'transcript-claude.txt, transcript-zcode.txt, server.log, one recording.mp4|mov|webm|mkv,',
  'one viewer-session.md|txt|json|har, and freshness.json (the flight-kit',
  'measurement — recomputed by this verifier) — every file non-zero, every file secret-free.',
  '',
  'Exit codes: 0 all checks pass; 1 a check failed; 2 usage.',
]

function printUsage(stream) {
  stream.write(`${USAGE_LINES.join('\n')}\n`)
}

function usageExit(message) {
  if (message) process.stderr.write(`${KIT}: ${message}\n`)
  printUsage(process.stderr)
  process.exit(2)
}

function parseArgv(argv) {
  const options = { dir: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (flag === '--help' || flag === '-h') {
      printUsage(process.stdout)
      process.exit(0)
    } else if (flag === '--dir') {
      if (value === undefined || value.startsWith('--')) usageExit('--dir requires a value')
      options.dir = value
      index += 1
    } else {
      usageExit(`unknown argument "${flag}"`)
    }
  }
  if (options.dir !== undefined && options.dir.trim().length === 0) usageExit('--dir must not be empty')
  return options
}

// --- evidence bundle walk -----------------------------------------------------

function walkEvidence(root, baseRelative = '') {
  const found = []
  for (const name of readdirSync(root).sort((left, right) => left.localeCompare(right))) {
    const absolutePath = join(root, name)
    const relativePath = baseRelative.length === 0 ? name : join(baseRelative, name)
    const info = lstatSync(absolutePath)
    if (info.isSymbolicLink()) {
      found.push({ relativePath, absolutePath, symlink: true })
      continue
    }
    if (info.isDirectory()) {
      found.push(...walkEvidence(absolutePath, relativePath))
      continue
    }
    if (info.isFile()) {
      found.push({ relativePath, absolutePath, size: info.size, symlink: false })
    }
  }
  return found
}

// Streaming byte scanner: the visitor sees overlapping latin1 windows (each
// window = the previous 64 KiB carry + up to 1 MiB of fresh bytes) together with
// the absolute offset where the window starts, so a pattern can never straddle a
// chunk boundary unseen. Returning true from the visitor stops the scan.
function readChunked(path, visitor) {
  const descriptor = openSync(path, 'r')
  try {
    let carry = Buffer.alloc(0)
    let absoluteOffset = 0
    for (;;) {
      const chunk = Buffer.alloc(SCAN_CHUNK_BYTES)
      const read = readSync(descriptor, chunk, 0, SCAN_CHUNK_BYTES, absoluteOffset)
      const window = carry.length > 0 ? Buffer.concat([carry, chunk.subarray(0, read)]) : chunk.subarray(0, read)
      if (visitor(window.toString('latin1'), absoluteOffset - carry.length)) return true
      if (read === 0 || read < SCAN_CHUNK_BYTES) return false
      carry = window.length > SCAN_OVERLAP_BYTES ? window.subarray(window.length - SCAN_OVERLAP_BYTES) : window
      absoluteOffset += read
    }
  } finally {
    closeSync(descriptor)
  }
}

function scanFileForSecrets(file) {
  const hits = []
  readChunked(file.absolutePath, (windowText, windowOffset) => {
    for (const secret of SECRET_PATTERNS) {
      const match = secret.pattern.exec(windowText)
      if (match) {
        hits.push({ id: secret.id, what: secret.what, offset: windowOffset + match.index })
        return true
      }
    }
    return false
  })
  return hits
}

// --- checks -------------------------------------------------------------------

const failures = []

function record(id, ok, passDetail, failDetail) {
  if (ok) {
    say(`${paint.green('[PASS]')} ${id} ${passDetail}`)
  } else {
    say(`${paint.red('[FAIL]')} ${id} ${failDetail}`)
    failures.push({ id, detail: failDetail })
  }
  return ok
}

function readJsonIfPossible(file) {
  try {
    return { value: JSON.parse(readFileSync(file.absolutePath, 'utf8')) }
  } catch (error) {
    return { error: error?.message ?? String(error) }
  }
}

function verifyCandidateBinding(filesByName) {
  const file = filesByName.get('candidate.json')
  if (!file) return false // already failed the presence check
  let evidence
  let frozen
  try {
    evidence = JSON.parse(readFileSync(file.absolutePath, 'utf8'))
    frozen = JSON.parse(readFileSync(candidateRecordPath, 'utf8'))
  } catch (error) {
    return record('CAND', false, '', `candidate.json or the frozen record is not valid JSON (${error.message}). Remediation: re-copy docs/release-evidence/v0.2.0-candidate.json into the bundle (runbook §0).`)
  }
  const expectedCommit = frozen?.source?.git_commit
  const commitOk = typeof expectedCommit === 'string'
    && evidence?.source?.git_commit === expectedCommit
  const artifactsOk = ['portable', 'claude_code'].every((kind) => {
    const expected = frozen?.artifacts?.[kind]?.sha256
    return typeof expected === 'string' && evidence?.artifacts?.[kind]?.sha256 === expected
  })
  return record(
    'CAND',
    commitOk && artifactsOk,
    `binding matches the frozen record: commit ${String(expectedCommit).slice(0, 12)}…, portable ${String(frozen?.artifacts?.portable?.sha256).slice(0, 12)}…, claude_code ${String(frozen?.artifacts?.claude_code?.sha256).slice(0, 12)}…`,
    `candidate.json does not match docs/release-evidence/v0.2.0-candidate.json`
      + (!commitOk ? ` — expected commit ${expectedCommit}, found ${evidence?.source?.git_commit}` : '')
      + (!artifactsOk ? ' — package tree digest(s) differ' : '')
      + '. Remediation: the demonstration must pin the FROZEN candidate; re-copy the frozen record and confirm the demo ran the pinned artifact (both preflight reports carry the digest each machine verified).',
  )
}

function verifyPreflightReport(filesByName, name, expectedRole) {
  const file = filesByName.get(name)
  if (!file) return null
  const parsed = readJsonIfPossible(file)
  if (parsed.error !== undefined) {
    record(`PREFLIGHT-${expectedRole.toUpperCase()}`, false, '', `${name} is not valid JSON (${parsed.error}). Remediation: re-run the preflight with --json (runbook §2) — do not hand-edit reports.`)
    return null
  }
  const report = parsed.value
  const problems = []
  if (report?.kit !== REPORT_KIT) problems.push(`not a ${REPORT_KIT} report (kit=${JSON.stringify(report?.kit)})`)
  if (report?.all_pass !== true) problems.push('all_pass is not true — the preflight was not fully green on that machine')
  if (report?.role !== expectedRole) problems.push(`role is ${JSON.stringify(report?.role)}, expected ${expectedRole}`)
  const fingerprint = report?.actor_fingerprint
  if (typeof fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(fingerprint)) problems.push(`actor_fingerprint missing or malformed (${JSON.stringify(fingerprint)})`)
  const server = report?.server
  if (typeof server !== 'string' || !server.startsWith('https://')) problems.push(`server origin missing or not https (${JSON.stringify(server)})`)
  record(
    `PREFLIGHT-${expectedRole.toUpperCase()}`,
    problems.length === 0,
    `${name}: preflight fully green, role ${expectedRole}, origin ${server}, fingerprint ${fingerprint}`,
    `${name}: ${problems.join('; ')}. Remediation: re-run the preflight on that machine until ALL GATING CHECKS PASS (runbook §2), then re-capture the report.`,
  )
  return problems.length === 0 ? report : null
}

function verifyTranscript(filesByName, name, requiredMarkers) {
  const file = filesByName.get(name)
  if (!file) return
  const content = readFileSync(file.absolutePath, 'utf8')
  const missing = requiredMarkers.filter(marker => marker.kind === 'literal' && !content.includes(marker.value))
  record(
    `TRANSCRIPT-${name === 'transcript-claude.txt' ? 'CLAUDE' : 'ZCODE'}`,
    missing.length === 0,
    `${name}: all required round-trip markers present (${requiredMarkers.map(marker => marker.value).join(', ')}).`,
    `${name}: missing ${missing.map(marker => `"${marker.value}"`).join(', ')} — the demo exchanges are not evidenced in this transcript. Remediation: re-run the exchanges (runbook §4) and re-capture; never edit a transcript.`,
  )
}

function verifyViewerSession(file) {
  if (!file) return
  const content = readFileSync(file.absolutePath, 'utf8')
  const requiredTokens = ['PRESENCE-UPDATES-CONFIRMED', 'BROADCAST-FRESHNESS-CONFIRMED', 'DM-EXCLUSION-CONFIRMED']
  const missing = requiredTokens.filter(token => !content.includes(token))
  record(
    'VIEWER-OBS',
    missing.length === 0,
    `${file.relativePath}: all three live-observation confirmations recorded.`,
    `${file.relativePath}: missing ${missing.map(token => `"${token}"`).join(', ')} — the live viewer observations are not evidenced. Remediation: complete §5 of the runbook during a live demo and record the observations; never fabricate the tokens.`,
  )
}

// Story 7.5 (retro A10): the verifier RECOMPUTES, not greps. The freshness
// figures are recomputed from the recorded raw epoch numbers through the
// SAME shared arithmetic the flight-kit observer writes with
// (scripts/rel1-freshness.mjs) — drift between the captured document and
// the recomputation is a failure — and the recording's own container
// metadata is parsed (EBML header + DocType for webm/matroska, the ftyp
// atom for mp4/mov), so a renamed text file cannot pose as the recording.
function verifyFreshness(filesByName) {
  const file = filesByName.get('freshness.json')
  if (!file) {
    record(
      'FR:freshness',
      false,
      'freshness.json present',
      'no freshness.json in the bundle. Remediation: capture the two canary measurements with the flight-kit observer (scripts/rel1-freshness-observe.mjs) during the live demo.',
    )
    return
  }
  let document
  try {
    document = JSON.parse(readFileSync(file.absolutePath, 'utf8'))
  } catch (error) {
    record('FR:freshness', false, 'freshness.json parses', `freshness.json is not valid JSON: ${error.message}`)
    return
  }
  const mismatches = recomputeFreshnessDocument(document)
  record(
    'FR:freshness',
    mismatches.length === 0,
    `freshness.json recomputed from its raw epochs: same-clock ${document.same_clock_measurement?.freshness_seconds} s, cross-machine ${document.cross_machine_measurement?.corrected_freshness_seconds} s (corrected) — both inside the ${document.bound_seconds ?? 5} s bound, arithmetic exact.`,
    `the recomputed freshness disagrees with the recorded document: ${mismatches.join('; ')}. Remediation: recompute the measurement with the flight-kit observer (scripts/rel1-freshness-observe.mjs compute) — never edit the recorded numbers to pass.`,
  )
  // The canaries must be exactly the two recorded sequences, one per
  // machine half — a first transmission distinguished from anything else by
  // construction (the measurement input carries one epoch pair per canary).
  const sameSeq = document.same_clock_measurement?.seq
  const crossSeq = document.cross_machine_measurement?.seq
  record(
    'FR:canaries',
    sameSeq !== undefined && crossSeq !== undefined && sameSeq !== crossSeq,
    `two distinct canary sequences measured: seq ${sameSeq} (same-clock) and seq ${crossSeq} (cross-machine).`,
    'the measurement halves do not name two distinct canary sequences. Remediation: measure one canary per machine half with the flight-kit observer.',
  )
}

// The recording's container metadata, parsed from its own bytes (not its
// filename): the EBML magic (0x1A45DFA3) plus DocType 'webm'/'matroska',
// or the 'ftyp' atom for mp4/mov. This proves container integrity, not
// content — no claim is made about what the frames show.
function verifyRecordingContainer(recording) {
  if (!recording) return
  const descriptor = openSync(recording.absolutePath, 'r')
  try {
    const head = Buffer.alloc(256)
    const read = readSync(descriptor, head, 0, head.length, 0)
    const bytes = head.subarray(0, read)
    let container = null
    if (bytes.length >= 4 && bytes[0] === 0x1a && bytes[1] === 0x45 && bytes[2] === 0xdf && bytes[3] === 0xa3) {
      const docTypeAt = bytes.indexOf('webm')
      const matroskaAt = bytes.indexOf('matroska')
      container = docTypeAt !== -1 ? 'webm (EBML)' : matroskaAt !== -1 ? 'matroska (EBML)' : 'EBML (DocType not found in the header window)'
    } else if (bytes.length >= 12 && bytes.subarray(4, 8).toString('latin1') === 'ftyp') {
      container = `mp4 (ftyp: ${bytes.subarray(8, 12).toString('latin1')})`
    }
    record(
      'FR:recording',
      container !== null && !container.includes('not found'),
      `${recording.relativePath}: container metadata parsed from the file's own bytes — ${container}.`,
      `${recording.relativePath}: the recording's container header did not parse as webm/matroska (EBML) or mp4/mov — the file may be renamed or truncated. Remediation: re-capture the browser-session recording; never convert or re-encode to pass.`,
    )
  } finally {
    closeSync(descriptor)
  }
}

function verifySecrets(files) {
  const leaks = []
  for (const file of files) {
    if (file.symlink) continue // already failed the walk check
    for (const hit of scanFileForSecrets(file)) {
      leaks.push(`${file.relativePath} @ byte ${hit.offset}: ${hit.what} (${hit.id})`)
    }
  }
  record(
    'SECRETS',
    leaks.length === 0,
    `scanned ${files.length} file(s): no private keys, no session tokens, no invite tokens, no viewer cookie values.`,
    `secret material leaked into the evidence:\n       - ${leaks.join('\n       - ')}\n     Remediation: remove the leaked artifact from the bundle, revoke what leaked (invite: "agent-room invite revoke <digest-prefix>"; viewer: "agent-room viewer rotate"; a leaked identity key: delete the installation data and re-enroll), re-capture cleanly, and re-run. Release evidence must be secret-free.`,
  )
}

// --- main ---------------------------------------------------------------------

function main() {
  const options = parseArgv(process.argv.slice(2))
  const evidenceDir = resolve(options.dir ?? join(repoRoot, DEFAULT_EVIDENCE_DIR))

  say(paint.bold(`REL-1 evidence verification — ${evidenceDir}`))

  let entries
  try {
    entries = walkEvidence(evidenceDir)
  } catch (error) {
    record('DIR', false, '', `cannot read ${evidenceDir} (${error.message}). Remediation: create the bundle and capture the evidence per docs/rel1-runbook.md.`)
    finish()
    return
  }

  for (const entry of entries) {
    if (entry.symlink) {
      record('WALK', false, '', `${entry.relativePath} is a symlink. Remediation: evidence must be regular files (a symlink can hide what the scan sees); copy the real file in.`)
    }
  }

  const filesByName = new Map()
  for (const entry of entries) {
    if (!entry.symlink && entry.size > 0) filesByName.set(entry.relativePath, entry)
  }

  const requiredExact = [
    'candidate.json',
    'preflight-claude.json',
    'preflight-zcode.json',
    'transcript-claude.txt',
    'transcript-zcode.txt',
    'server.log',
  ]
  const missingExact = requiredExact.filter(name => !filesByName.has(name))
  for (const name of requiredExact) {
    record(
      `ART:${name}`,
      filesByName.has(name),
      `${name} present (${filesByName.get(name)?.size ?? 0} bytes)`,
      `${name} is missing or empty. Remediation: capture it per docs/rel1-runbook.md (${runbookSectionFor(name)}) and place it at ${join(evidenceDir, name)}.`,
    )
  }

  const baseNameOf = relativePath => relativePath.split('/').pop() ?? relativePath
  const extensionOf = relativePath => relativePath.slice(relativePath.lastIndexOf('.')).toLowerCase()
  const recording = entries.find(entry => !entry.symlink
    && RECORDING_EXTENSIONS.has(extensionOf(entry.relativePath))
    && baseNameOf(entry.relativePath).toLowerCase().startsWith('recording.'))
  record(
    'ART:recording',
    Boolean(recording),
    `screen recording present: ${recording?.relativePath} (${recording?.size ?? 0} bytes)`,
    'no recording.* (mp4/mov/webm/mkv) in the bundle. Remediation: save the screen recording into the bundle (runbook §6).',
  )

  const viewerSession = entries.find(entry => !entry.symlink
    && VIEWER_SESSION_EXTENSIONS.has(extensionOf(entry.relativePath))
    && baseNameOf(entry.relativePath).toLowerCase().startsWith('viewer-session.'))
  record(
    'ART:viewer-session',
    Boolean(viewerSession && (filesByName.has(viewerSession.relativePath))),
    `viewer observation record present: ${viewerSession?.relativePath} (${viewerSession?.size ?? 0} bytes)`,
    'no viewer-session.* (md/txt/json/har) in the bundle. Remediation: write the observation record during the live demo (runbook §5 template).',
  )

  verifyCandidateBinding(filesByName)

  const claudeReport = verifyPreflightReport(filesByName, 'preflight-claude.json', 'claude')
  const zcodeReport = verifyPreflightReport(filesByName, 'preflight-zcode.json', 'zcode')

  if (claudeReport && zcodeReport) {
    const distinct = claudeReport.actor_fingerprint !== zcodeReport.actor_fingerprint
    const sameOrigin = claudeReport.server === zcodeReport.server
    record(
      'MACHINES',
      distinct && sameOrigin,
      `two distinct Actor fingerprints (${claudeReport.actor_fingerprint.slice(0, 19)}…, ${zcodeReport.actor_fingerprint.slice(0, 19)}…) against one origin (${claudeReport.server}) — the two-machine, two-vendor shape holds.`,
      `the two reports do not establish two distinct machines against one server: `
        + `${distinct ? '' : 'the Actor fingerprints are IDENTICAL (both reports came from one installation) '}`
        + `${sameOrigin ? '' : `the server origins differ (${claudeReport.server} vs ${zcodeReport.server}) `}`
        + `. Remediation: run each preflight on its own machine with its own installation (runbook §2), then re-capture both reports.`,
    )
  }

  verifyTranscript(filesByName, 'transcript-claude.txt', [
    { kind: 'literal', value: 'REL1-DM-CLAUDE-1' },
    { kind: 'literal', value: 'REL1-BC-CLAUDE-1' },
    { kind: 'literal', value: 'committed' },
  ])
  verifyTranscript(filesByName, 'transcript-zcode.txt', [
    { kind: 'literal', value: 'REL1-DM-ZCODE-1' },
    { kind: 'literal', value: 'REL1-BC-ZCODE-1' },
    { kind: 'literal', value: 'committed' },
  ])

  verifyViewerSession(viewerSession && filesByName.has(viewerSession.relativePath) ? viewerSession : null)
  verifyFreshness(filesByName)
  verifyRecordingContainer(recording && filesByName.has(recording.relativePath) ? recording : null)
  verifySecrets(entries.filter(entry => !entry.symlink))

  finish()
}

function runbookSectionFor(name) {
  if (name === 'candidate.json') return '§0'
  if (name.startsWith('preflight-')) return '§2'
  if (name.startsWith('transcript-')) return '§3 (script capture) + §4 (exchanges)'
  if (name === 'server.log') return '§1'
  return '§6'
}

function finish() {
  if (failures.length === 0) {
    say(paint.green('RESULT: EVIDENCE VERIFIED — the REL-1 bundle is complete, consistent, and secret-free.'))
  } else {
    say(paint.red(`RESULT: ${failures.length} check(s) FAILED (${failures.map(failure => failure.id).join(', ')}). Fix the remediations above and re-run.`))
    process.exitCode = 1
  }
}

main()
