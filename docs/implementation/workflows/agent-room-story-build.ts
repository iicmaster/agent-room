/* zcode-workflow
description: สร้างสตอรี่เดียวของ agent-room v0.2 แบบอัตโนมัติ — เขียนสเปก ลงมือทำ รันชุดทดสอบ ตรวจหลายสายตา ตัดสิน patch แล้วปิดงานพร้อม commit
whenToUse: เมื่อจะสร้างสตอรี่ถัดไปของ agent-room เช่น 1-8, 1-9, 2-1 โดยไม่ต้องสั่งทีละขั้น
args:
  story:
    type: string
    required: false
    description: Story key เช่น "1-8" — ไม่ใส่ก็ได้ เวิร์กโฟลวจะเลือกสตอรี่ที่ยังไม่เสร็จเอง
  reviewers:
    type: number
    required: false
    default: 5
    description: จำนวนสายตาตรวจ — สูงสุด 5 สาย (4 ภายใน + luna)
  patchRounds:
    type: number
    required: false
    default: 3
    description: จำนวนรอบแก้เมื่อชุดทดสอบแดง
*/

interface PlanResult {
  /** Workspace-relative path of the story spec file that was written. */
  specPath: string;
  /** One sentence: what this story delivers. */
  intent: string;
  /** The spec's own I/O matrix row count, as the planner counted them. */
  matrixRows: number;
}

interface ImplementResult {
  /** One sentence: what was implemented. */
  summary: string;
  /** Files created or modified, workspace-relative, one per line. */
  files: string;
  /** Anything left incomplete or risky, or "none". */
  risks: string;
}

interface ReviewFinding {
  /** Stable identifier used to require exactly one triage resolution. */
  id: string;
  /** Workspace-relative path (or component) the finding is about. */
  where: string;
  /** One sentence: what is wrong. */
  what: string;
  /** Why it matters for this story. */
  impact: string;
  /** "high" for a blocker, "medium" for a real gap, "low" for polish. */
  severity: "low" | "medium" | "high";
}

interface ReviewResult {
  /** The reviewer's overall read: SHIP or FIX-FIRST, one line why. */
  verdict: string;
  /** What this reviewer found; empty when nothing is wrong. */
  findings: ReviewFinding[];
}

interface TriageResult {
  /** Findings that need code work, each with the concrete fix to apply. */
  patches: string[];
  /** Findings that are real but belong to a later story, one line each. */
  deferred: string[];
  /** Findings rejected as noise or by-design, one line each. */
  rejected: string[];
  /** One sentence: whether the spec itself needs an amendment. */
  specVerdict: string;
}

interface FinalizeResult {
  /** Commit sha of the story's final commit, verbatim. */
  commit: string;
  /** One sentence: what the story now delivers. */
  summary: string;
  /** Final test count line, verbatim from the suite output. */
  tests: string;
}

interface SuiteState {
  /** Whether the suite is green and its counts are non-vacuous. */
  green: boolean;
  /** The failing test names, or an empty string when green. */
  failures: string;
  /** The suite's count lines, e.g. "ℹ tests 299 · ℹ pass 299". */
  counts: string;
  /** Parsed total test count. */
  tests: number | null;
  /** Parsed passing test count. */
  pass: number | null;
  /** Parsed failing test count. */
  fail: number | null;
  /** Parsed skipped test count. */
  skipped: number | null;
}

interface VerificationResult {
  focused: SuiteState;
  full: SuiteState;
  staticGreen: boolean;
  staticFailures: string[];
}

interface CoordinatorReceipt {
  task_id: string;
  effective_identity: string;
  dispatch_confirmed: boolean;
  outbox_path: string;
}

function suiteState(result: { exitCode: number; stdout: string; stderr: string }): SuiteState {
  const failures = [...result.stdout.matchAll(/^✖ (.+?) \(\d/gm)]
    .map(match => match[1] ?? "")
    .filter(name => !name.startsWith("failing tests"))
    .join("\n");
  const countLine = (name: string): number | null => {
    const match = result.stdout.match(new RegExp(`^ℹ ${name} (\\d+)\\s*$`, "m"));
    return match ? Number(match[1]) : null;
  };
  const tests = countLine("tests");
  const pass = countLine("pass");
  const fail = countLine("fail");
  const skipped = countLine("skipped");
  const counts = ["tests", "pass", "fail", "skipped"]
    .map(name => {
      const value = { tests, pass, fail, skipped }[name]
      return value === null ? `ℹ ${name} <missing>` : `ℹ ${name} ${value}`
    })
    .join(" · ");
  const internallyConsistent = tests !== null && pass !== null && fail !== null && skipped !== null
    && tests === pass + fail + skipped;
  const green = result.exitCode === 0
    && pass !== null && pass > 0
    && fail === 0 && skipped === 0
    && internallyConsistent;
  return { green, failures, counts, tests, pass, fail, skipped };
}

function parseBoundedInteger(value: unknown, name: string, min: number, max: number | null, fallback: number): number {
  const raw = value ?? fallback;
  let parsed: number;
  if (typeof raw === "number") {
    parsed = raw;
  } else if (typeof raw === "string" && /^\d+$/.test(raw.trim())) {
    parsed = Number(raw.trim());
  } else {
    parsed = Number.NaN;
  }
  if (!Number.isSafeInteger(parsed) || parsed < min || (max !== null && parsed > max)) {
    const range = max === null ? `at least ${min}` : `from ${min} through ${max}`;
    throw new Error(`${name} must be a safe integer ${range}; received ${String(raw)}`);
  }
  return parsed;
}

function countMatrixRows(text: string): number {
  const section = /^## I\/O & Edge-Case Matrix\s*$/m.exec(text)?.[0] === undefined
    ? ""
    : text.split(/^## I\/O & Edge-Case Matrix\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  return section.split("\n").filter(line => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) return false;
    if (/^\|\s*Scenario\s*\|/.test(trimmed)) return false;
    if (/^\|\s*:?-{2,}/.test(trimmed)) return false;
    return true;
  }).length;
}

function parseBaselineRevision(specText: string, specPath: string): string {
  const match = /^baseline_revision:\s*['"]?([0-9a-f]{40})['"]?\s*$/m.exec(specText);
  if (!match) throw new Error(`${specPath}: baseline_revision must be a full 40-character commit SHA`);
  return match[1];
}

function normalizeScopePath(value: string): string {
  return value.replace(/:\d+(?:-\d+)?$/, "").replace(/^\.\//, "");
}

async function implementationAllowlist(specText: string, specPath: string, story: string): Promise<Set<string>> {
  const taskBlock = specText.split(/^## Tasks & Acceptance\s*$/m)[1]?.split(/^## /m)[0] ?? "";
  const taskSection = taskBlock.split(/\*\*Acceptance Criteria/)[0] ?? "";
  const allowlist = new Set<string>();
  for (const match of taskSection.matchAll(/`([^`]+)`/g)) {
    const candidate = normalizeScopePath(match[1] ?? "");
    const lineStart = taskSection.lastIndexOf("\n", match.index ?? 0) + 1;
    const prefix = taskSection.slice(lineStart, match.index ?? 0);
    if (/\b(?:spawns?|exercises?|reads?|through|against|do not|never)\s*$/i.test(prefix)) continue;
    if (/^(?:docs|server|tests)\/[A-Za-z0-9._/-]+$/.test(candidate) && !candidate.includes("..")) {
      allowlist.add(candidate);
    }
  }
  allowlist.add(normalizeScopePath(specPath));
  allowlist.add(`docs/implementation/reviews/story-${story}-luna-brief.md`);
  allowlist.add(`docs/implementation/reviews/story-${story}-luna-gpt6.md`);
  // The standard upkeep set: every story so far has touched these (honesty
  // upkeep in README/CHANGELOG, dated spine amendments when a story's surface
  // needs vocabulary, the AC evidence entry, and sprint bookkeeping). Listing
  // them in each spec's verification section proved to be the one thing
  // planners forget — three runs died on exactly this.
  for (const path of [
    "README.md",
    "CHANGELOG.md",
    "docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md",
    "docs/implementation/ac-evidence.yaml",
    "docs/implementation/sprint-status.yaml",
  ]) {
    allowlist.add(path);
  }
  // Escalation addendum: when a blocked implementer escalates and the operator
  // authorizes paths the spec's verification list omitted (a spec
  // under-specification, e.g. pre-existing test pins that the mandated route
  // retires), the authorization is recorded in
  // .escalation-addendum-<story>.json — {"paths":[...],"reason":"..."} — and
  // merged here. The record, not the operator's memory, is what the scope
  // guard reads.
  const addendumPath = `docs/implementation/workflows/.escalation-addendum-${story}.json`;
  const addendumText = await files.read(addendumPath).catch(() => "");
  if (addendumText.trim() !== "") {
    let parsed: unknown;
    try {
      parsed = JSON.parse(addendumText);
    } catch {
      throw new Error(`${addendumPath} is not valid JSON — fix or delete it before the scope check`);
    }
    const paths = (parsed as { paths?: unknown }).paths;
    if (!Array.isArray(paths) || paths.some(path => typeof path !== "string")) {
      throw new Error(`${addendumPath} must carry {"paths": ["<workspace-relative path>", ...]}`);
    }
    for (const path of paths) {
      if (typeof path === "string" && path.startsWith("docs/implementation/workflows/")) {
        throw new Error(`${addendumPath}: the pipeline's own files never need an escalation`);
      }
      if (typeof path === "string") allowlist.add(normalizeScopePath(path));
    }
  }
  return allowlist;
}

async function gitLines(args: string[]): Promise<string[]> {
  const result = await world.run("git", args);
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  return result.stdout.split("\n").map(line => line.trim()).filter(Boolean);
}

async function untrackedPaths(): Promise<string[]> {
  return gitLines(["ls-files", "--others", "--exclude-standard"]);
}

async function changedPathsFromBaseline(baseline: string): Promise<string[]> {
  return gitLines(["diff", "--name-only", baseline, "--"]);
}

async function assertScope(paths: string[], allowlist: Set<string>, label: string): Promise<void> {
  const outside = paths.filter(path => !allowlist.has(path));
  if (outside.length > 0) throw new Error(`${label}: paths outside the story allowlist: ${outside.join(", ")}`);
}

async function assertPreexistingUnrelated(
  snapshots: Map<string, string>,
  allowlist: Set<string>,
  ephemeral: Set<string>,
  label: string,
): Promise<void> {
  for (const [path, expected] of snapshots) {
    if (allowlist.has(path) || ephemeral.has(path)) continue;
    let actual: string;
    try {
      actual = await hashPath(path);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`${label}: pre-existing untracked path disappeared or became unreadable: ${path}; ${reason}`);
    }
    if (actual !== expected) throw new Error(`${label}: pre-existing untracked path changed: ${path}`);
  }
}

async function assertScopedFinalState(
  allowlist: Set<string>,
  preexistingUntracked: Set<string>,
  snapshots: Map<string, string>,
  ephemeral: Set<string>,
  baseline: string,
): Promise<void> {
  await assertPreexistingUnrelated(snapshots, allowlist, ephemeral, "after artifact publication");
  const committedPaths = await gitLines(["diff", "--name-only", baseline, "HEAD", "--"]);
  await assertScope(committedPaths, allowlist, "final commit");
  const workflowCommits = committedPaths.filter(path => path.startsWith("docs/implementation/workflows/"));
  if (workflowCommits.length > 0) {
    throw new Error(`workflow infrastructure was committed as story output: ${workflowCommits.join(", ")}`);
  }
  const untracked = await untrackedPaths();
  const newUntracked = untracked.filter(path => !preexistingUntracked.has(path));
  await assertScope(newUntracked, allowlist, "after artifact publication");
  const dirty = (await world.run("git", ["diff", "--name-only", "HEAD", "--"])).stdout
    .split("\n").map(line => line.trim()).filter(Boolean);
  await assertScope(dirty, allowlist, "tracked changes after artifact publication");
  if (dirty.length > 0) throw new Error(`finalization left allowlisted tracked paths dirty: ${dirty.join(", ")}`);
  const dirtyUntracked = untracked.filter(path => allowlist.has(path));
  if (dirtyUntracked.length > 0) {
    throw new Error(`finalization left allowlisted untracked paths dirty: ${dirtyUntracked.join(", ")}`);
  }
}

// The review scope is trustworthy as long as nothing under server/, tests/,
// or the contract docs changed since the baseline. Commits that touch ONLY the
// pipeline's own tooling (this script, the luna brief) do not invalidate the
// reviewed artifact — and they are unavoidable, because repairing this script
// mid-epic requires committing it. Anything else still fails the run.
const TOOLING_PREFIXES = ["docs/implementation/workflows/", "docs/implementation/reviews/"];

// A mid-run commit is acceptable when every path it touches is either the
// pipeline's own tooling or the story's OWN allowlisted surface (which a
// finalize-style commit legitimately carries). Anything else — product code
// the reviews never scoped — fails the run.
async function assertBaselineHead(baseline: string, allowlist: Set<string>): Promise<void> {
  const head = (await world.run("git", ["rev-parse", "HEAD"])).stdout.trim();
  if (head === baseline) return;
  const moved = await world.run("git", ["diff", "--name-only", baseline, head]);
  if (moved.exitCode !== 0) throw new Error(`could not diff ${baseline}..${head}`);
  const paths = moved.stdout.split("\n").map(line => line.trim()).filter(Boolean);
  const outside = paths.filter(path =>
    !TOOLING_PREFIXES.some(prefix => path.startsWith(prefix)) && !allowlist.has(path));
  if (outside.length > 0) {
    throw new Error(
      `HEAD moved from baseline ${baseline} to ${head} with changes outside the story allowlist ` +
        `and the pipeline's own tooling: ${outside.join(", ")}. The review scope can no longer be ` +
        `trusted; do not commit unscoped code while a run is in flight.`,
    );
  }
  log(`HEAD moved ${baseline.slice(0, 7)} → ${head.slice(0, 7)} (story surface + pipeline tooling only — scope intact)`);
}

async function hashPath(path: string): Promise<string> {
  const result = await world.run("git", ["hash-object", "--", path]);
  if (result.exitCode !== 0) throw new Error(`cannot hash pre-existing untracked path ${path}: ${result.stderr}`);
  return result.stdout.trim();
}

async function runContractVerification(allowlist: Set<string>, baseline: string): Promise<VerificationResult> {
  const focused = suiteState(await world.run("node", ["--test", "tests/integration/first-conversation.test.mjs"], { timeoutMs: 420000 }));
  const full = suiteState(await world.run("node", ["--test"], { timeoutMs: 420000 }));
  const staticFailures: string[] = [];
  const greps = [
    ["sinon|proxyquire|mock|createServer\\(", "no-mock"],
    ["createMcpServer|startServer\\(", "no-in-process-server"],
  ] as const;
  for (const [pattern, label] of greps) {
    const result = await world.run("grep", ["-nE", pattern, "tests/integration/first-conversation.test.mjs"]);
    if (result.exitCode !== 1 || result.stdout.trim() !== "" || result.stderr.trim() !== "") {
      staticFailures.push(`${label}: expected grep exit 1 with empty output, got exit ${result.exitCode}`);
    }
  }
  const trackedWhitespace = await world.run("git", ["diff", "--check", baseline, "--"]);
  if (trackedWhitespace.exitCode !== 0 || trackedWhitespace.stdout.trim() !== "" || trackedWhitespace.stderr.trim() !== "") {
    staticFailures.push(`tracked whitespace: ${trackedWhitespace.stderr || trackedWhitespace.stdout}`);
  }
  const untracked = await untrackedPaths();
  for (const path of untracked.filter(candidate => allowlist.has(candidate))) {
    const whitespace = await world.run("git", ["diff", "--no-index", "--check", "/dev/null", path]);
    if (whitespace.exitCode !== 1 || whitespace.stdout.trim() !== "" || whitespace.stderr.trim() !== "") {
      staticFailures.push(`untracked whitespace ${path}: ${whitespace.stderr || whitespace.stdout}`);
    }
  }
  return { focused, full, staticGreen: staticFailures.length === 0, staticFailures };
}

function validateCoordinatorReceipt(receipt: CoordinatorReceipt, taskId: string, outboxPath: string): void {
  if (
    receipt == null
    || receipt.task_id !== taskId
    || receipt.effective_identity !== "gpt-6-luna[max]"
    || receipt.dispatch_confirmed !== true
    || receipt.outbox_path !== outboxPath
  ) {
    throw new Error(`Luna coordinator receipt is not a verified gpt-6-luna[max] dispatch for ${taskId}`);
  }
}

async function readLunaReport(taskId: string, outboxPath: string, dispatchedAt: number): Promise<{ verdict: string; findings: ReviewFinding[] }> {
  const regular = await world.run("test", ["-f", outboxPath]);
  const symlink = await world.run("test", ["-L", outboxPath]);
  if (regular.exitCode !== 0 || symlink.exitCode === 0) {
    throw new Error(`Luna outbox is missing, not a regular file, or a symlink: ${outboxPath}`);
  }
  const stat = await world.run("node", [
    "-e",
    "const fs=require('node:fs'); process.stdout.write(String(fs.statSync(process.argv[1]).mtimeMs))",
    outboxPath,
  ]);
  const mtime = Number(stat.stdout.trim());
  if (stat.exitCode !== 0 || !Number.isFinite(mtime) || mtime <= dispatchedAt) {
    throw new Error(`Luna outbox is not newer than dispatch: ${outboxPath}`);
  }
  // Observed race (story 3-4): the coordinator can report done while the lane
  // is still writing — the fail-closed check above turns that into a retryable
  // failure instead of a false SHIP. On retry the outbox is present and parses.
  const text = await files.read(outboxPath);
  const lines = text.split("\n");
  const nonempty = lines.map(line => line.trim()).filter(Boolean);
  const marker = `TEAM_DONE ${taskId}`;
  if (nonempty.at(-1) !== marker) throw new Error(`Luna outbox lacks terminal ${marker}`);
  if (nonempty.some(line => /^(?:BLOCKED|UNKNOWN|UNRECOGNIZED)$/i.test(line))) {
    throw new Error(`Luna outbox contains a blocked or unrecognized status`);
  }
  const verdictIndex = lines.findIndex(line => line.trim() === "# Verdict");
  const findingsIndex = lines.findIndex(line => line.trim() === "# Findings");
  const checksIndex = lines.findIndex(line => line.trim() === "# Checks");
  if (verdictIndex < 0 || findingsIndex <= verdictIndex || checksIndex <= findingsIndex) {
    throw new Error(`Luna outbox must contain ordered Verdict, Findings, and Checks sections`);
  }
  const verdictLines = lines.slice(verdictIndex + 1, findingsIndex).map(line => line.trim()).filter(Boolean);
  if (verdictLines.length !== 1 || !["SHIP", "FIX-FIRST"].includes(verdictLines[0])) {
    throw new Error(`Luna verdict must be exactly SHIP or FIX-FIRST`);
  }
  const findings: ReviewFinding[] = [];
  // Luna's severity vocabulary has varied across lanes (blocker/warning/nit on
  // early stories, high/medium/low later) and its body format varies between a
  // one-line em-dash form and an indented Evidence/Why block. The parser
  // accepts both rather than re-teaching the auditor its old format.
  const severityOf = (word: string): "high" | "medium" | "low" | null => {
    if (word === "blocker" || word === "high") return "high"
    if (word === "warning" || word === "medium") return "medium"
    if (word === "nit" || word === "low") return "low"
    return null
  }
  let index = findingsIndex + 1;
  let findingNumber = 0;
  while (index < checksIndex) {
    const line = lines[index]?.trim() ?? "";
    if (line === "") {
      index += 1;
      continue;
    }
    const header = /^- \[(high|medium|low|blocker|warning|nit)\] (.+)$/.exec(line);
    if (!header) throw new Error(`Luna finding is malformed near line ${index + 1}: ${line}`);
    const severity = severityOf(header[1] ?? "");
    if (severity === null) throw new Error(`Luna finding has an unknown severity: ${header[1]}`);
    // Collect the indented body lines that follow the header (Evidence:, Why:,
    // continuation lines) until the next finding header or a blank-line-then-
    // non-indented line.
    const bodyLines: string[] = [];
    let cursor = index + 1;
    while (cursor < checksIndex) {
      const next = lines[cursor] ?? "";
      if (/^- \[(high|medium|low|blocker|warning|nit)\] /.test(next.trim())) break;
      if (next.trim() === "") {
        // A blank line ends the block unless the next non-blank line is indented.
        const upcoming = lines.slice(cursor + 1, checksIndex).find(candidate => candidate.trim() !== "");
        if (upcoming === undefined || !/^\s/.test(upcoming)) break;
        cursor += 1;
        continue;
      }
      if (!/^\s/.test(next)) break;
      bodyLines.push(next.trim());
      cursor += 1;
    }
    findingNumber += 1;
    const evidence = bodyLines
      .filter(candidate => candidate.startsWith("Evidence:"))
      .map(candidate => candidate.slice("Evidence:".length).trim())
      .join(" ");
    const why = bodyLines
      .filter(candidate => candidate.startsWith("Why"))
      .map(candidate => candidate.slice(candidate.indexOf(":") + 1).trim())
      .join(" ");
    const where = /((?:docs|server|tests)\/[A-Za-z0-9._/-]+:\d+)/.exec(evidence || why)?.[1] ?? "";
    findings.push({
      id: `luna-${findingNumber}`,
      where,
      what: header[2] ?? "",
      impact: [evidence, why].filter(Boolean).join(" — ") || bodyLines.join(" "),
      severity,
    });
    index = cursor > index ? cursor : index + 1;
  }
  if (verdictLines[0] === "FIX-FIRST" && findings.length === 0) {
    throw new Error(`Luna FIX-FIRST report contains no parseable findings`);
  }
  return { verdict: verdictLines[0], findings };
}
// A board the person watching can read at a glance: the story's stages and
// what each stage produced. Fed by the report() calls below.
artifact.board("story", {
  title: "ความคืบหน้าสตอรี่",
  key: "step",
  status: "state",
  columns: ["planned", "implemented", "finalized"],
  cardTitle: "step",
  detail: [{ field: "specPath" }, { field: "commit" }, { field: "files" }, { field: "tests" }],
});

// Every review finding lands here as it arrives, so a run that dies midway
// still shows what was found.
artifact.table("findings", {
  title: "ข้อค้นพบจากการตรวจ",
  key: "what",
  columns: [
    { field: "reviewer", label: "สายตา" },
    { field: "severity", label: "ระดับ" },
    { field: "what", label: "ปัญหา" },
    { field: "where", label: "ที่" },
  ],
});

// The patch list the triager produced — the run's decision record.
artifact.table("patches", {
  title: "รายการ patch ที่สั่งให้แก้",
  key: "patch",
  columns: [{ field: "patch", label: "patch" }],
});

// The story to build: an explicit args.story wins; otherwise the workflow
// picks the next unfinished story itself, so an amended or unattended run
// never fails on a missing argument. "Unfinished" = a sprint-status entry
// with no spec, or a spec whose frontmatter is not status: done.
async function resolveStory(): Promise<string> {
  const explicit = String(args.story ?? "").trim();
  if (explicit !== "") {
    if (!/^\d+-\d+$/.test(explicit)) {
      throw new Error("args.story must look like '1-8' (epic-story)");
    }
    return explicit;
  }
  const plan = await files.read("docs/implementation/sprint-status.yaml").catch(() => "");
  const candidates = [...plan.matchAll(/^  (\d+-\d+)-[^:]*: (\w+)$/gm)]
    .map(match => ({ id: match[1] ?? "", status: match[2] ?? "" }))
    .sort((left, right) => {
      const [le, ls] = left.id.split("-").map(Number);
      const [re, rs] = right.id.split("-").map(Number);
      return (le ?? 0) - (re ?? 0) || (ls ?? 0) - (rs ?? 0);
    });
  for (const candidate of candidates) {
    const specs = await files.glob(`docs/implementation/spec-${candidate.id}-*.md`);
    const own = specs.filter(path => !path.includes("workflows"));
    if (own.length === 0) return candidate.id;
    const text = await files.read(own[0] ?? "");
    if (!/^status: 'done'$/m.test(text)) return candidate.id;
  }
  throw new Error("no unfinished story found — is every story spec already done?");
}


// F9: review depth follows blast radius, not a fixed count. Epic 1's evidence:
// the stories whose defect would reach every later story (the store, the API
// host, the gate story) each needed the full gauntle, while the mechanical ones
// were clean on one pass — so a fixed number spends the most attention where
// the risk is lowest. The caller can still override with args.reviewers.
function blastRadiusTier(storyKey: string, specText: string): "full" | "standard" | "light" {
  const upper = specText.toUpperCase()
  const gate = /BLOCKING GATE|VALIDATE GATE|--STRICT/.test(upper)
  const store = /SCHEMA|MIGRAT|TRANSACTION|DURABLE LOG|SQLITE/.test(upper)
  const wire = /API HOST|MIDDLEWARE|WIRE|ENVELOPE|SESSION AUTH|BOOTSTRAP/.test(upper)
  if (gate) return "full"
  if (store || wire) return "standard"
  if (/^\d+\.\d+$/.test(storyKey)) return "standard"
  return "light"
}

const TIER_DEPTH: Record<"full" | "standard" | "light", number> = {
  full: 5,      // four internal lenses + the external auditor
  standard: 4,  // three internal lenses + the external auditor
  light: 2,     // one internal lens + the external auditor
}


// F8 preconditions. (Retry posture: a run that dies on a provider error leaves
// the tree untouched — verified after each failure — so the correct retry is a
// fresh run from the same clean state, not a rescue of the dead run.
// Observed on Epic 2: quota exhaustion (code 1005) and transient
// "Model creation failed" — both retried cleanly from the same clean state;
// the 2-2 patch phase itself died twice on the transient before landing.)
// F8 preconditions. Epic 1's evidence: this workflow failed six runs on one
// story, every failure a bug in the script or a tree I edited underneath it,
// and a blocking-gate story was then finished by hand because the automation
// could not be trusted with it. Two rules follow, and both are refusals rather
// than warnings — a gate story deserves a loop that says "no" when unsure.
//
// 1. Start from a clean tree. The scope guard compares what this run produced
//    against what was already dirty; starting dirty makes that comparison lie.
// 2. A blocking-gate story is refused until this workflow has closed at least
//    one story unattended. The marker is the evidence, and it is only written
//    by a successful finalize.
async function assertRunnableHere(storyKey: string): Promise<void> {
  const status = await world.run("git", ["status", "--porcelain"]);
  const dirty = status.stdout.split("\n").map(line => line.trim()).filter(Boolean);
  if (dirty.length > 0) {
    throw new Error(
      `refusing to start story ${storyKey} on a dirty tree: ${dirty.length} path(s) already modified or ` +
        `untracked (${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", …" : ""}). Commit, stash, or ` +
        `finish the other work first — the scope guard cannot tell your edits from this run's.`,
    );
  }
  const epics = await files.read("docs/epics.md").catch(() => "");
  // Story keys are hyphenated here ("1-8") and dotted in epics.md ("### Story 1.8:").
  // Converting the wrong separator once made this guard silently never match —
  // found only by running it, which is the only way a refusal proves it refuses.
  const dotted = storyKey.replace("-", ".");
  // A line test, not a clever pattern: the heading line itself says "gate".
  const heading = epics
    .split("\n")
    .some(line => line.startsWith(`### Story ${dotted}:`) && /gate/i.test(line));
  if (!heading) return;
  const proven = await files
    .read("docs/implementation/workflows/.unattended-proven.json")
    .then(text => /"closed_unattended"\s*:\s*\d+/.test(text))
    .catch(() => false);
  if (!proven) {
    throw new Error(
      `refusing story ${storyKey}: it is a blocking gate, and this workflow has not yet closed a story ` +
        `unattended (docs/implementation/workflows/.unattended-proven.json is absent). Epic 1's evidence ` +
        `is six failed runs on one gate story — run this on a non-gate story first, or build the gate by hand.`,
    );
  }
}

const story = await resolveStory();
log(`กำลังสร้างสตอรี่ ${story}`);
await assertRunnableHere(story);
const maxPatchRounds = parseBoundedInteger(args.patchRounds, "patchRounds", 1, null, 3);

const LUNA_OUTBOX = `/Users/ngs/agent-skills/plugins/agent-room/.mailbox-out/story-${story}-audit-luna`;

const planner = agent("นักวางแผนสตอรี่", {
  system:
    "You plan one story of agent-room v0.2 from its planning artifacts. You write the story spec; " +
    "you do not implement anything. Load the epics file, the epic context, and the most recent " +
    "done story spec for continuity, then read the code the story touches. The spec is the " +
    "implementer's sole source of truth: every task names a file path and a specific action, " +
    "every I/O matrix row is executable, and the Boundaries section pins what must NOT change. " +
    "If the story cannot be planned without a decision nothing records, say so plainly instead " +
    "of inventing one. If a check is impossible to pass, escalate rather than working around it.",
});

const implementer = agent("ผู้ลงมือเขียนโค้ด", {
  system:
    "You implement one story of agent-room v0.2 from its spec, which is the sole source of truth. " +
    "Load every file listed in the spec's context: frontmatter before you start. Match the " +
    "surrounding code's idiom, comment density and naming. Never edit the spec file except when " +
    "an explicit spec-amendment instruction below names the exact allowed amendment. Never touch " +
    "files the spec's Boundaries section forbids except those explicitly named by that amendment. " +
    "If a check is impossible to pass, or your instructions contradict each other, escalate and say " +
    "so plainly rather than working around it.",
});

const triager = agent("ผู้ตัดสิน patch", {
  system:
    "You triage review findings against a story spec for agent-room v0.2. You assign severity " +
    "yourself by consequence for the user; you ignore severities reviewers assigned. For each " +
    "finding decide exactly one: patch (this story's problem, trivially fixable — give the " +
    "concrete fix), deferred (real, but belongs to a later story — say which), or rejected " +
    "(noise, or by-design in the spec — say why). A finding may only be deferred or rejected as " +
    "out of scope on the authority of the story's own intent contract, never on the authority of " +
    "the spec's Boundaries prose alone. If the spec itself is wrong, say so in specVerdict with " +
    "the exact amendment needed.",
});

const finalizer = agent("ผู้ปิดงานสตอรี่", {
  system:
    "You finalize one completed story of agent-room v0.2. You append the review triage log and " +
    "the Auto Run Result section to the story spec (frontmatter status: done, followup_review_-\n" +
    "recommended computed from the patched severities), archive the luna audit outbox into " +
    "docs/implementation/reviews/, and commit only the explicit story allowlist with a conventional " +
    "commit message. You never rewrite code. You report the final commit sha verbatim.",
});

phase("วางแผนสตอรี่และเขียนสเปก");
const existing = (await files.glob(`docs/implementation/spec-${story}-*.md`))
  .filter(path => !path.includes("workflows"))
  .sort();
let plan: PlanResult;
if (existing.length === 1) {
  // The spec is already written (a resumed or amended run): adopt it rather
  // than re-planning the same story from scratch.
  const text = await files.read(existing[0] ?? "");
  const title = /^title: '(.+)'$/m.exec(text)?.[1] ?? `story ${story}`;
  const matrixRows = countMatrixRows(text);
  if (matrixRows === 0) throw new Error(`${existing[0]}: I/O & Edge-Case Matrix has no data rows`);
  plan = { specPath: existing[0] ?? "", intent: title, matrixRows };
  log(`ใช้สเปกที่มีอยู่แล้ว: ${plan.specPath}`);
} else {
  plan = await planner.ask<PlanResult>(
  `Plan agent-room story ${story}.\n\n` +
    `Sources: docs/epics.md (the story's own Acceptance Criteria verbatim), ` +
    `docs/implementation/epic-*-context.md, docs/implementation/spec-*.md (the most recent ` +
    `done spec is the continuity source: reuse its Code Map and Design Notes style), and the ` +
    `codebase itself.\n\n` +
    `Write the spec to docs/implementation/spec-${story}-<kebab-slug>.md with frontmatter ` +
    `status: ready-for-dev, baseline_revision: <current HEAD sha>, context: [<project-context, ` +
    `AGENTS.md, the epic context, the previous done spec>], warnings: [], deferred: []. Follow the ` +
    `existing specs' structure: intent-contract (Intent / Boundaries & Constraints / I/O & Edge-` +
    `Case Matrix), Code Map (annotated paths with line anchors), Tasks & Acceptance, Spec Change ` +
    `Log, Review Triage Log, Design Notes, Verification.\n\n` +
    `Return the spec path, one-sentence intent, and how many I/O matrix rows you wrote.`,
  );
  const plannedText = await files.read(plan.specPath);
  const plannedRows = countMatrixRows(plannedText);
  if (plannedRows === 0) throw new Error(`${plan.specPath}: I/O & Edge-Case Matrix has no data rows`);
  plan = { ...plan, matrixRows: plannedRows };
  log(`สเปก: ${plan.specPath} — ${plan.intent}`);
}
report({ story, step: "planned", state: "planned", specPath: plan.specPath, matrixRows: plan.matrixRows }, "story");

const adoptedSpecText = await files.read(plan.specPath);

// Review depth follows blast radius (see blastRadiusTier). The spec's own text
// is the input: a story that names a gate, a schema, or the wire surface is
// classified from what it says it touches.
const tier = blastRadiusTier(story, adoptedSpecText);
const tierDepth = TIER_DEPTH[tier];
const reviewDepth = args.reviewers === undefined
  ? tierDepth
  : parseBoundedInteger(args.reviewers, "reviewers", 1, 5, 5);
log(`ระดับการตรวจ: ${tier} (${tierDepth} สายตา${args.reviewers === undefined ? "" : ", ผู้เรียกกำหนดเอง"})`);
// The spec records the revision the story was PLANNED against; that value is
// information, not the run's integrity anchor. The anchor is HEAD when this run
// started: assertBaselineHead then means exactly "nothing committed while this
// run worked", which is what keeps the review diff trustworthy. A stale
// baseline_revision (any commit since planning) must not fail the run.
const plannedBaselineRevision = parseBaselineRevision(adoptedSpecText, plan.specPath);
const baselineRevision = (await world.run("git", ["rev-parse", "HEAD"])).stdout.trim();
if (!/^[0-9a-f]{40}$/.test(baselineRevision)) {
  throw new Error(`could not resolve HEAD at run start (got ${JSON.stringify(baselineRevision)})`);
}
log(`baseline ${baselineRevision.slice(0, 7)} (planned against ${plannedBaselineRevision.slice(0, 7)})`);
const resolvedBaseline = await world.run("git", ["rev-parse", "--verify", `${baselineRevision}^{commit}`]);
if (resolvedBaseline.exitCode !== 0 || resolvedBaseline.stdout.trim() !== baselineRevision) {
  throw new Error(`${plan.specPath}: baseline_revision ${baselineRevision} does not resolve to that exact commit`);
}
// The story allowlist is needed by the baseline guard from here on, so it is
// derived before the first gate rather than at the scope check.
const allowlist = await implementationAllowlist(adoptedSpecText, plan.specPath, story);
await assertBaselineHead(baselineRevision, allowlist);
const preexistingUntracked = new Set(await untrackedPaths());
// Tracked files already modified when the run started are pre-existing work,
// not the story's: a run may begin on a dirty tree. They are snapshotted so the
// scope check can tell "already dirty" from "this run touched it".
const preexistingModified = new Set(await gitLines(["diff", "--name-only", "HEAD", "--"]));
const preexistingSnapshots = new Map<string, string>();
for (const path of [...preexistingUntracked, ...preexistingModified]) {
  preexistingSnapshots.set(path, await hashPath(path));
}
// (allowlist already derived above, before the first baseline gate)
for (const path of [...allowlist]) {
  if (path.startsWith("docs/implementation/workflows/")) allowlist.delete(path);
}
const ephemeralPaths = new Set([
  LUNA_OUTBOX,
  `.mailbox-out/story-${story}-audit-luna`,
]);

phase("ลงมือทำตามสเปก");
await implementer.ask<ImplementResult>(
  `Read ${plan.specPath} fully and implement it — the spec is the sole source of truth. Load ` +
    `every file listed in its frontmatter context: before you start. Do not edit the spec file ` +
    `unless a later explicit spec-amendment instruction names the exact change. The pinned baseline ` +
    `revision is ${baselineRevision}; do not commit or move HEAD. Do not run the full test suite ` +
    `yourself — the pipeline runs it after you and sends you the failures; run only the story's own ` +
    `new test file if you want a fast signal.`,
).then(result => report({ story, step: "implemented", files: result.files }, "story"));
await assertBaselineHead(baselineRevision, allowlist);

phase("รันชุดทดสอบจนเขียว");
let verification = await runContractVerification(allowlist, baselineRevision);
const verificationIsRed = (value: VerificationResult): boolean => !value.focused.green || !value.full.green || !value.staticGreen;
let fixRound = 0;
while (verificationIsRed(verification) && fixRound < maxPatchRounds) {
  fixRound += 1;
  const details = [
    `focused: ${verification.focused.counts}${verification.focused.failures ? `; ${verification.focused.failures}` : ""}`,
    `full: ${verification.full.counts}${verification.full.failures ? `; ${verification.full.failures}` : ""}`,
    ...verification.staticFailures,
  ].join("\n");
  log(`รอบแก้ที่ ${fixRound}: ชุดตรวจยังแดง`);
  await implementer.ask(
    `The contract verification is red after your implementation. Fix the causes, not the assertions, ` +
      `and leave unrelated files alone. Details:\n${details}\nDo not edit the spec unless an explicit ` +
      `spec-amendment instruction names the exact change. Do not commit or move HEAD (${baselineRevision}).`,
  );
  await assertBaselineHead(baselineRevision, allowlist);
  verification = await runContractVerification(allowlist, baselineRevision);
}
if (verificationIsRed(verification)) {
  throw new Error(
    `contract verification still red after ${maxPatchRounds} fix rounds: focused=${verification.focused.counts}; ` +
      `full=${verification.full.counts}; static=${verification.staticFailures.join("; ")}`,
  );
}
let suite = verification.full;
log(`ชุดทดสอบเขียว: ${verification.focused.counts} · ${verification.full.counts}`);
await assertBaselineHead(baselineRevision, allowlist);

phase("รวบรวมรายการไฟล์ที่เปลี่ยน");
// The diff is assembled HERE, not by a subagent: a workflow subagent has no
// shell, and world.run can. Reviewers are handed the baseline and the exact
// file list and read the files with their own tools — a 200 KB diff pasted
// into four prompts costs more than letting each reviewer fetch what it needs.
// The scope of THIS run is what it produced: files that were clean at start
// and are dirty now, plus files it created. Measuring against the story's
// historical baseline instead would sweep in every commit made since the
// story was planned — including the workflow's own file.
const currentUntracked = await untrackedPaths();
const newlyCreatedUntracked = currentUntracked.filter(path => !preexistingUntracked.has(path));
const dirtyNow = await gitLines(["diff", "--name-only", "HEAD", "--"]);
const newlyDirtyTracked = dirtyNow.filter(path => !preexistingModified.has(path));
const trackedPaths = newlyDirtyTracked;
// Post-implementation scope check is ADVISORY: a planner cannot enumerate every
// file a legitimate implementation touches (4.1's routes/registration is the
// standing example), and the reviewers read the actual changed files from disk
// either way — so unscoped paths EXPAND the review scope (nothing hides) and
// the triager judges them. The hard allowlist gate lives only in finalize
// staging, where unscoped paths would enter the story commit.
const outsidePaths = [...trackedPaths, ...newlyCreatedUntracked].filter(path => !allowlist.has(path));
if (outsidePaths.length > 0) {
  log(`คำเตือน: ${outsidePaths.length} path อยู่นอก allowlist ของสเปก — ขยาย review scope และให้ triage ตัดสิน: ${outsidePaths.join(", ")}`);
}
await assertPreexistingUnrelated(preexistingSnapshots, allowlist, ephemeralPaths, "after implementation");
const changedPaths = [...new Set([
  ...trackedPaths,
  ...currentUntracked.filter(path => allowlist.has(path)),
])].filter(path => path !== "" && !path.includes(".mailbox-out") && !path.includes(".tmux-teams"));
log(`ไฟล์ที่เปลี่ยน ${changedPaths.length} ไฟล์`);
const scope = changedPaths.join("\n");

phase("ตรวจสอบพร้อมกัน 5 สายตา");
const lenses: { name: string; ask: string }[] = [
  {
    name: "นักตามรอยช่องโหว่",
    ask:
      "Hunt edge cases and failure modes in this change. For each: the exact file:line, the " +
      "trigger condition, the guard that is missing or wrong, and the consequence. Read the " +
      "files — do not reason from the diff text alone. Return findings only; an empty list is a " +
      "valid answer only if you genuinely found none.",
  },
  {
    name: "นักตรวจช่องว่างของการพิสูจน์",
    ask:
      "Find claims the change makes that no test actually proves, and tests that would still " +
      "pass if the behavior regressed. For each: the behavior, the test that appears to cover " +
      "it, why that test cannot fail, and the missing assertion. Read the tests and the code.",
  },
  {
    name: "นักตรวจความสอดคล้องกับเจตนา",
    ask:
      "Read the story spec's intent-contract (the Boundaries and I/O matrix sections) and the " +
      "change. For each matrix row, state whether it is implemented AND tested, naming the row " +
      "and the evidence. Flag behavior that contradicts the intent, and intent clauses with no " +
      "implementation. Be descriptive; do not prescribe.",
  },
  {
    name: "นักหาสิ่งที่หายไป",
    ask:
      "Look for what is MISSING rather than what is wrong: error paths never exercised, " +
      "guarantees asserted only in comments, docs or README that no longer match the code, " +
      "secrets or files that must be ignored but are not, cleanup that leaves residue. Cite " +
      "file:line for each.",
  },
  {
    name: "ผู้ตรวจอิสระจากคำสั่งซื้อ",
    ask:
      "Imagine a maintainer who has to run and trust this code in production. What would bite " +
      "them? Check process cleanup, unbounded growth, permission and secret handling, restart " +
      "and crash behavior, and anything that would be hard to diagnose from logs. Cite " +
      "file:line for each.",
  },
];

const internal = lenses.slice(0, Math.max(0, Math.min(reviewDepth - 1, lenses.length)));
const reviews = await Promise.all(
  internal.map(lens =>
    agent(`ผู้ตรวจ ${lens.name}`).ask<ReviewResult>(
      `${lens.ask}\n\nThe contract is ${plan.specPath} — read it fully. The change under review ` +
        `is everything that differs from baseline ${baselineRevision}, which is exactly these files:\n${scope}\n` +
        `Read those files (plus anything they import) with your own tools. The suite currently ` +
        `reads: ${suite.counts}. Return JSON matching the ReviewResult shape.`,
    ),
  ),
);
const normalizedReviews = reviews.map((review, index) => ({
  ...review,
  findings: review.findings.map((finding, findingIndex) => ({
    ...finding,
    id: `internal-${index + 1}-${findingIndex + 1}`,
  })),
}));
for (const [index, review] of normalizedReviews.entries()) {
  for (const finding of review.findings) {
    report({ story, reviewer: internal[index]?.name ?? "internal", ...finding }, "findings");
  }
  log(`${internal[index]?.name}: ${review.verdict} (${review.findings.length} ข้อ)`);
}

phase("ฟังความเห็นจาก codex-advisor[luna]");
const lunaTaskId = `story-${story}-audit-luna`;
// Wall-clock is unavailable inside a workflow (runs must be replayable), so
// luna's outbox freshness is decided by a file that CAN be compared: the
// coordinator writes its dispatch timestamp into the receipt, and the reader
// compares mtimes through world.run instead of the script calling Date.now().
const lunaDispatchStartedAt = (await world.run("node", [
  "-e",
  "process.stdout.write(String(Date.now()))",
])).stdout.trim();
// Idempotent audit: if a completed outbox for THIS task id already exists
// (terminal TEAM_DONE marker), reuse it instead of re-dispatching. Deleting
// the prior outbox here cost a full re-audit on every retry and created the
// race where the parser ran against a mid-write outbox.
const priorOutbox = await world.run("test", ["-f", LUNA_OUTBOX]);
const priorText = priorOutbox.exitCode === 0 ? await files.read(LUNA_OUTBOX).catch(() => "") : "";
const priorComplete = priorText.includes(`TEAM_DONE ${lunaTaskId}`);
if (priorComplete) {
  log(`ใช้ผล audit ของ luna ที่มีอยู่แล้ว (${LUNA_OUTBOX})`);
}
const coordinatorReceipt = priorComplete
  ? ({ task_id: lunaTaskId, effective_identity: "gpt-6-luna[max]", dispatch_confirmed: true, outbox_path: LUNA_OUTBOX } as CoordinatorReceipt)
  : await agent("ผู้ประสานงาน lane ของ luna").ask<CoordinatorReceipt>(
  `Run the codex-advisor[luna] external audit lane for story ${story} and wait for it.\n\n` +
    `Working directory: /Users/ngs/agent-skills/plugins/agent-room\n` +
    `Task id: ${lunaTaskId} (letters, digits and dashes ONLY — a dot is rejected)\n` +
    `Brief: write it to docs/implementation/reviews/story-${story}-luna-brief.md first — the ` +
    `lane refuses to start without an existing brief. The brief must state: read-only, do not ` +
    `modify any file; the contract is ${plan.specPath}; the change under review is every file ` +
    `differing from baseline ${baselineRevision}:\n${scope}\nAudit the ` +
    `spec's intent-contract clause by clause, the store/API invariants the story depends on, and ` +
    `the tests' ability to fail; the outbox file is the deliverable and a chat answer alone is ` +
    `not acceptable; output format: Verdict (SHIP | FIX-FIRST), Findings with file:line evidence, ` +
    `Checks. Do NOT reconcile the recommendation into other voices' opinions.\n\n` +
    `Then dispatch it (use Bash; the env must be exported in the SAME command):\n` +
    `  export ACP_MODEL=gpt-6-luna ACP_EXPECT_MODEL=gpt-6-luna ACP_REASONING_EFFORT=max ` +
    `ACP_EXPECT_REASONING_EFFORT=max INITIAL_AGENT_MODE=read-only ` +
    `ACP_SESSION_RECEIPT_REQUIRED=1 ACP_SESSION_OPERATION=new CODEX_PATH=/Users/ngs/.local/bin/codex\n` +
    `  D=~/.claude/plugins/cache/tmux-teams/tmux-teams/0.38.0/skills/tmux-teams/scripts/acp-dispatch.mjs\n` +
    `  rm -f <cwd>/.tmux-teams/liveness/<task>.json <cwd>/.tmux-teams/dispatch-pids/<task>\n` +
    `  node "$D" codex <cwd> <task> <brief-path> 1200 && node "$D" wait <cwd> <task> 3600\n\n` +
    `Verify effective_identity is gpt-6-luna[max] (matched). If the lane fails, read the runner ` +
    `log, fix the cause, and re-dispatch. Return ONLY this JSON receipt after the wait: ` +
    `{"task_id":"${lunaTaskId}","effective_identity":"gpt-6-luna[max]","dispatch_confirmed":true,"outbox_path":"${LUNA_OUTBOX}"}. ` +
    `A chat answer without the outbox is a failure.`,
);
validateCoordinatorReceipt(coordinatorReceipt, lunaTaskId, LUNA_OUTBOX);
const lunaReview = await readLunaReport(lunaTaskId, LUNA_OUTBOX, Number(lunaDispatchStartedAt));
if (lunaReview.findings.length > 0) {
  for (const finding of lunaReview.findings) {
    report({ story, reviewer: "codex-advisor[luna]", ...finding }, "findings");
  }
}
log(`luna: ${lunaReview.verdict} (${lunaReview.findings.length} ข้อ)`);

await assertBaselineHead(baselineRevision, allowlist);

const allFindings = [
  ...normalizedReviews.flatMap(review => review.findings),
  ...lunaReview.findings,
];

phase("ตัดสินใจว่าจะแก้อะไร");
const triage = await triager.ask<TriageResult>(
  `Triage the review findings for story ${story}.\n\n` +
    `The spec (read fully): ${plan.specPath}\nThe change: every file differing from baseline ` +
    `${baselineRevision}:\n${scope}\nRead them with your own tools. The luna outbox (read fully): ` +
    `${LUNA_OUTBOX}\n\n` +
    `Findings as reported:\n${JSON.stringify(allFindings, null, 2)}\n\n` +
    `Return the patches to apply (each a concrete instruction naming the file and what the fix ` +
    `must do), the deferred items with the story that owns them, the rejects with their reason, ` +
    `and your specVerdict. Prefix EVERY patch, deferred item, and rejected item with the exact ` +
    `stable finding id in square brackets; every finding id must occur in exactly one resolution.`,
);
const resolutionEntries = [
  ...triage.patches.map(text => ({ kind: "patch", text })),
  ...triage.deferred.map(text => ({ kind: "defer", text })),
  ...triage.rejected.map(text => ({ kind: "reject", text })),
];
const resolvedIds = resolutionEntries.flatMap(entry => {
  const match = /^\[([A-Za-z0-9_-]+)\]/.exec(entry.text.trim());
  return match ? [match[1] ?? ""] : [];
});
const expectedFindingIds = allFindings.map(finding => finding.id);
const duplicateFindingIds = [...new Set(resolvedIds.filter((id, index) => resolvedIds.indexOf(id) !== index))];
const missingFindingIds = expectedFindingIds.filter(id => !resolvedIds.includes(id));
const unknownFindingIds = resolvedIds.filter(id => !expectedFindingIds.includes(id));
if (duplicateFindingIds.length > 0 || missingFindingIds.length > 0 || unknownFindingIds.length > 0) {
  throw new Error(
    `triage resolution ids are invalid; duplicate=${duplicateFindingIds.join(",")}; ` +
      `missing=${missingFindingIds.join(",")}; unknown=${unknownFindingIds.join(",")}`,
  );
}
for (const patch of triage.patches) {
  report({ story, patch }, "patches");
}
log(`patch ${triage.patches.length} · defer ${triage.deferred.length} · reject ${triage.rejected.length}`);
await assertBaselineHead(baselineRevision, allowlist);

phase("ลง patch แล้วตรวจซ้ำ");
await implementer.ask(
  `Review pass returned patches for story ${story}. Apply ALL of them:\n\n` +
    `${triage.patches.map(patch => `- ${patch}`).join("\n")}\n\n` +
    `If the spec verdict says the spec itself is wrong: ${triage.specVerdict}\n` +
    `Apply that exact triager-requested spec amendment outside the intent-contract block; when ` +
    `the verdict says no amendment, this is a no-op. Do not edit anything the patches do not name. ` +
    `Do not commit or move HEAD (${baselineRevision}).`,
);
await assertBaselineHead(baselineRevision, allowlist);
verification = await runContractVerification(allowlist, baselineRevision);
let remediationRound = 0;
while (verificationIsRed(verification) && remediationRound < maxPatchRounds) {
  remediationRound += 1;
  const details = [
    `focused: ${verification.focused.counts}${verification.focused.failures ? `; ${verification.focused.failures}` : ""}`,
    `full: ${verification.full.counts}${verification.full.failures ? `; ${verification.full.failures}` : ""}`,
    ...verification.staticFailures,
  ].join("\n");
  await implementer.ask(
    `The post-triage contract verification is red. Fix the causes without reverting a correct ` +
      `patch, and do not commit or move HEAD (${baselineRevision}). Details:\n${details}`,
  );
  await assertBaselineHead(baselineRevision, allowlist);
  verification = await runContractVerification(allowlist, baselineRevision);
}
if (verificationIsRed(verification)) {
  throw new Error(
    `contract verification red after triage remediation: focused=${verification.focused.counts}; ` +
      `full=${verification.full.counts}; static=${verification.staticFailures.join("; ")}`,
  );
}
suite = verification.full;
await assertBaselineHead(baselineRevision, allowlist);
await assertPreexistingUnrelated(preexistingSnapshots, allowlist, ephemeralPaths, "after triage remediation");
const postTrackedPaths = await changedPathsFromBaseline(baselineRevision);
const postUntracked = await untrackedPaths();
const postNewPaths = postUntracked.filter(path => !preexistingUntracked.has(path));
await assertScope([...postTrackedPaths, ...postNewPaths], allowlist, "after triage remediation");
const postScope = [...new Set([
  ...postTrackedPaths,
  ...postUntracked.filter(path => allowlist.has(path)),
])].filter(path => path !== "" && !path.includes(".mailbox-out") && !path.includes(".tmux-teams")).join("\n");
if (postNewPaths.length > 0) {
  const rereviews = await Promise.all(internal.map(lens =>
    agent(`ผู้ตรวจซ้ำ ${lens.name}`).ask<ReviewResult>(
      `${lens.ask}\n\nRe-review the post-remediation scope after newly created paths appeared. ` +
        `The contract is ${plan.specPath}; the fixed baseline is ${baselineRevision}; scope:\n${postScope}\n` +
        `Return JSON matching ReviewResult. Any finding fails this workflow rather than being silently finalized.`,
    ),
  ));
  const rereviewFindings = rereviews.flatMap(review => review.findings);
  if (rereviewFindings.length > 0) {
    for (const finding of rereviewFindings) report({ story, reviewer: "post-remediation", ...finding }, "findings");
    throw new Error(`post-remediation re-review found ${rereviewFindings.length} unresolved finding(s)`);
  }
}
log(`หลัง patch: ${verification.focused.counts} · ${verification.full.counts}`);

phase("ปิดงานและ commit");
await assertBaselineHead(baselineRevision, allowlist);
const finalAllowlist = [...allowlist].sort().join(" ");
// The evidence marker the gate guard reads: how many stories this workflow has
// closed unattended, taken from the live file (absent file means zero).
const provenText = await files
  .read("docs/implementation/workflows/.unattended-proven.json")
  .catch(() => "");
const provenCount = Number(/"closed_unattended"\s*:\s*(\d+)/.exec(provenText)?.[1] ?? 0) || 0;

const finalized = await finalizer.ask<FinalizeResult>(
  `Finalize story ${story}.\n\n` +
    `Spec: ${plan.specPath}\nBaseline revision: ${baselineRevision}\n` +
    `Patches applied: ${JSON.stringify(triage.patches, null, 2)}\n` +
    `Deferred: ${JSON.stringify(triage.deferred, null, 2)}\nRejected: ${JSON.stringify(triage.rejected, null, 2)}\n` +
    `Spec verdict from triage: ${triage.specVerdict}\nFinal suite: ${suite.counts}\n\n` +
    `After committing, write docs/implementation/workflows/.unattended-proven.json with exactly ` +
    `{"closed_unattended": ${provenCount + 1}, "last_story": "${story}", "commit": "<that commit sha>"}. ` +
    `That file is the evidence that lets this workflow be trusted with a blocking-gate story, so it ` +
    `must exist and be accurate when you report back.\n\n` +
    `Set frontmatter status: done, append the Review Triage Log entry (counts per category with ` +
    `per-severity breakdown, and every addressed finding listed) and the Auto Run Result section ` +
    `(summary, files changed, findings breakdown, follow-up-review recommendation computed from ` +
    `the patched severities, verification performed, residual risks). Archive the luna outbox to ` +
    `docs/implementation/reviews/story-${story}-luna-gpt6.md. Before committing, verify HEAD is ` +
    `still ${baselineRevision}. Stage ONLY these allowlisted paths (never broad-add, and never ` +
    `docs/implementation/workflows/**): git add -- ${finalAllowlist}. Commit with a conventional ` +
    `message. Report the commit sha verbatim.`,
);
if (!/^[0-9a-f]{40}$/.test(finalized.commit)) {
  throw new Error(`finalizer returned an invalid commit sha: ${finalized.commit}`);
}
const actualFinalHead = (await world.run("git", ["rev-parse", "HEAD"])).stdout.trim();
if (actualFinalHead !== finalized.commit) {
  throw new Error(`finalizer reported ${finalized.commit} but HEAD is ${actualFinalHead}`);
}
report({ story, step: "finalized", state: "finalized", commit: finalized.commit, tests: finalized.tests }, "story");

phase("ส่งมอบสเปกและรายงาน");
await artifact.file("spec", plan.specPath, {
  title: `สเปกสตอรี่ ${story} — ${plan.intent}`,
  description: "สัญญาการทำงานของสตอรี่ พร้อมบันทึกผลตรวจและผลรันจริง",
  primary: true,
});
await assertScopedFinalState(allowlist, preexistingUntracked, preexistingSnapshots, ephemeralPaths, baselineRevision);

type ResolutionKind = "patch" | "defer" | "reject";
const resolutionById = new Map<string, ResolutionKind>(
  resolutionEntries.map(entry => {
    const id = /^\[([A-Za-z0-9_-]+)\]/.exec(entry.text.trim())?.[1] ?? "";
    const kind: ResolutionKind = entry.kind as ResolutionKind;
    return [id, kind] as [string, ResolutionKind];
  }),
);
const highCount = allFindings.filter(f => f.severity === "high").length;
return {
  conclusion:
    `สตอรี่ ${story} ปิดครบที่ commit ${finalized.commit} — ${finalized.summary} ` +
    `ผ่านการตรวจ ${allFindings.length} ข้อจาก ${internal.length + 1} สายตา ` +
    `(patch ${triage.patches.length}, defer ${triage.deferred.length}, reject ${triage.rejected.length}; ` +
    `high ${highCount}) และชุดทดสอบ ${suite.counts}.`,
  findings: allFindings.map(finding => ({
    where: finding.where || "—",
    what: finding.what,
    evidence: finding.impact,
    status: resolutionById.get(finding.id) === "patch" ? "verified" : "unconfirmed",
    severity: finding.severity,
  })),
  verified: [
    `focused checkpoint (${verification.focused.counts}) and full node --test (${verification.full.counts}) after implementation and remediation`,
    "both exact no-mock/no-in-process greps and tracked/untracked whitespace gates passed",
    `five independent review lenses (four internal + codex-advisor[luna]) read the fixed-baseline scope and the spec`,
    "scoped allowlist and unrelated pre-existing untracked snapshot checks passed after artifact publication",
  ],
  notCovered: [
    "behavior outside the story spec's scope — later stories own it",
    ...triage.deferred.map(item => `deferred: ${item}`),
  ],
};
