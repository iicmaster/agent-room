/* zcode-workflow
description: รันสตอรี่ที่เหลือทั้งหมดของ agent-room v0.2 อัตโนมัติ — ต่อคิวตาม dependency, แต่ละสตอรี่ผ่าน plan/implement/test/reviews/luna/triage/patch/finalize และปิดท้ายตรวจ AC sweep
whenToUse: เมื่อจะรันงานค้างทั้งหมด (4.6→6.x) แบบไม่ต้องสั่งทีละสตอรี่
args:
  stories:
    type: string
    required: false
    description: คิวสตอรี่คั่นด้วยจุลภาค เช่น "4-6,4-7,4-8,5-1" — ไม่ใส่ = ทุกสตอรี่ที่ยังไม่ done ตามลำดับ
*/

interface PlanResult {
  /** Workspace-relative path of the story spec file that was written. */
  specPath: string;
  /** One sentence: what this story delivers. */
  intent: string;
}

interface ImplementResult {
  /** One sentence: what was implemented. */
  summary: string;
  /** Files created or modified, workspace-relative. */
  files: string;
}

interface ReviewFinding {
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
  verdict: string;
  findings: ReviewFinding[];
}

interface TriageResult {
  patches: string[];
  deferred: string[];
  rejected: string[];
  specVerdict: string;
}

interface FinalizeResult {
  commit: string;
  summary: string;
  tests: string;
}

interface SuiteState {
  green: boolean;
  passCount: number | null;
  failures: string;
  counts: string;
}

function suiteState(result: { exitCode: number; stdout: string }): SuiteState {
  const failures = [...result.stdout.matchAll(/^✖ (.+?) \(\d/gm)]
    .map(match => match[1] ?? "")
    .filter(name => !name.startsWith("failing tests"))
    .join("\n");
  const countLine = (name: string): number | null => {
    const m = result.stdout.match(new RegExp(`^ℹ ${name} (\\d+)\\s*$`, "m"));
    return m ? Number(m[1]) : null;
  };
  const pass = countLine("pass");
  const counts = ["tests", "pass", "fail", "skipped"]
    .map(name => {
      const v = countLine(name);
      return v === null ? `ℹ ${name} <missing>` : `ℹ ${name} ${v}`;
    })
    .join(" · ");
  return {
    green: result.exitCode === 0 && pass !== null && pass > 0,
    passCount: pass,
    failures,
    counts,
  };
}

function runSuite(): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  // The per-test ceiling is 300000 — the specs' own full-suite verification
  // command (every spec's Verification section). 120000 deterministically
  // killed the REL-2 continuity drill (tests/drills/rel2-kill-drill.test.mjs),
  // whose documented budgets (four tracked windows, each with a warmup
  // deadline of 25 s, plus randomized kill/restore cycles and final
  // verification) put it structurally above two minutes even on a quiet
  // machine — reproduced: 'test timed out after 120000ms' at exactly 120.1 s.
  return world.run("node", ["--test", "--test-timeout=300000"], { timeoutMs: 420000 });
}

// --- Story queue ---------------------------------------------------------------
async function resolveQueue(): Promise<string[]> {
  const explicit = String(args.stories ?? "").trim();
  if (explicit !== "") {
    const list = explicit.split(",").map(s => s.trim()).filter(Boolean);
    for (const item of list) {
      if (!/^\d+-\d+$/.test(item)) throw new Error(`bad story key '${item}' — expected e.g. 4-6`);
    }
    return list;
  }
  const plan = await files.read("docs/implementation/sprint-status.yaml").catch(() => "");
  const candidates = [...plan.matchAll(/^  (\d+-\d+)-[^:]*: backlog$/gm)]
    .map(m => m[1] ?? "")
    .filter(id => /^([4-6])-\d+$/.test(id))
    .sort((a, b) => {
      const [ae, as] = a.split("-").map(Number);
      const [be, bs] = b.split("-").map(Number);
      return (ae ?? 0) - (be ?? 0) || (as ?? 0) - (bs ?? 0);
    });
  // Sprint status lags the real work (stories land between syncs), so a
  // backlog entry whose spec already says done is skipped — otherwise a stale
  // file re-runs finished stories.
  const live: string[] = [];
  for (const id of candidates) {
    const specs = await files.glob(`docs/implementation/spec-${id}-*.md`);
    const spec = specs.find(p => !p.includes("workflows"));
    if (spec === undefined) { live.push(id); continue; }
    const text = await files.read(spec).catch(() => "");
    if (!/^status: 'done'$/m.test(text)) live.push(id);
  }
  if (live.length === 0) throw new Error("no live backlog stories found — every spec is done");
  return live;
}

const queue = await resolveQueue();
log(`คิวงาน: ${queue.join(" → ")}`);

artifact.board("story", {
  title: "ความคืบหน้าสตอรี่",
  key: "step",
  status: "state",
  columns: ["planned", "implemented", "finalized"],
  cardTitle: "step",
  detail: [{ field: "specPath" }, { field: "commit" }, { field: "files" }, { field: "tests" }],
});
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

const completed: { story: string; commit: string; tests: string }[] = [];

for (const story of queue) {
  const lunaTaskId = `story-${story}-audit-luna`;
  const LUNA_OUTBOX = `/Users/ngs/agent-skills/plugins/agent-room/.mailbox-out/${lunaTaskId}`;

  // ---- Plan ----
  phase("วางแผนสตอรี่และเขียนสเปก");
  const planner = agent(`นักวางแผน ${story}`, {
    system:
      "You plan one story of agent-room v0.2 from its planning artifacts. You write the story " +
      "spec; you do not implement anything. Load the epics file (the story's Acceptance Criteria " +
      "are binding verbatim), docs/implementation/epic-1-context.md, the most recent done spec " +
      "under docs/implementation/spec-*.md for continuity, and the code the story touches. The " +
      "spec is the implementer's sole source of truth: every task names a file path, every I/O " +
      "matrix row is executable, and Boundaries pin what must NOT change. In the Tasks section " +
      "list every file the implementation will create or modify (the pipeline's scope check uses " +
      "this list). If the story cannot be planned without a decision nothing records, say so " +
      "plainly. If a check is impossible to pass, escalate rather than working around it. " +
      "IMPORTANT housekeeping files every story touches (list them in Tasks): README.md, " +
      "CHANGELOG.md, docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md " +
      "(dated amendment if needed), docs/implementation/ac-evidence.yaml.",
  });
  const existing = (await files.glob(`docs/implementation/spec-${story}-*.md`)).sort();
  let plan: PlanResult;
  if (existing.length === 1) {
    const text = await files.read(existing[0] ?? "");
    const title = /^title: '(.+)'$/m.exec(text)?.[1] ?? `story ${story}`;
    plan = { specPath: existing[0] ?? "", intent: title };
    log(`ใช้สเปกที่มีอยู่แล้ว: ${plan.specPath}`);
  } else {
    plan = await planner.ask<PlanResult>(
      `Plan agent-room story ${story}.\n\nWrite the spec to ` +
        `docs/implementation/spec-${story}-<kebab-slug>.md with frontmatter status: ready-for-dev, ` +
        `baseline_revision: <current HEAD sha>. Follow the existing specs' structure (intent-` +
        `contract, code map, tasks, verification). Return the spec path and a one-sentence intent.`,
    );
    log(`สเปก: ${plan.specPath}`);
  }
  report({ story, step: "planned", state: "planned", specPath: plan.specPath }, "story");

  // ---- Implement ----
  phase("ลงมือทำตามสเปก");
  const implementer = agent(`ผู้ลงมือเขียนโค้ด ${story}`, {
    system:
      "You implement one story of agent-room v0.2 from its spec — the spec is the sole source " +
      "of truth. Load every file listed in its frontmatter context: first. Match the surrounding " +
      "code's idiom. Never edit the spec file. Never touch files outside the spec's declared " +
      "surface plus the housekeeping set (README, CHANGELOG, spine, ac-evidence). If a check is " +
      "impossible to pass, or your instructions contradict each other, escalate and say so " +
      "plainly rather than working around it. Do not run the full test suite — the pipeline runs " +
      "it after you; run only your own new test file for a fast signal.",
  });
  const implemented = await implementer.ask<ImplementResult>(
    `Read ${plan.specPath} fully and implement it.`,
  );
  report({ story, step: "implemented", state: "implemented", files: implemented.files }, "story");

  // ---- Test gate ----
  phase("รันชุดทดสอบจนเขียว");
  let suite = suiteState(await runSuite());
  let fixRound = 0;
  while (!suite.green && fixRound < 3) {
    fixRound += 1;
    log(`รอบแก้ที่ ${fixRound}: ${suite.failures.split("\n").filter(Boolean).length} เคสแดง`);
    await implementer.ask(
      `The suite is red. Failing tests:\n${suite.failures}\nFix the CAUSES (not the assertions).`,
    );
    suite = suiteState(await runSuite());
  }
  if (!suite.green) throw new Error(`suite still red after 3 fix rounds: ${suite.failures}`);
  log(`เขียว: ${suite.counts}`);

  const baseline = (await world.run("git", ["rev-parse", "HEAD"])).stdout.trim();

  // ---- Reviews ----
  phase("ตรวจสอบพร้อมกัน 5 สายตา");
  const diffPath = `/tmp/agent-room-build/diff-${story}.txt`;
  await world.run("mkdir", ["-p", "/tmp/agent-room-build"]);
  await world.run("git", ["diff", baseline, "--"]);
  const dirty = await world.run("git", ["status", "--porcelain"]);
  const changedFiles = dirty.stdout.split("\n").map(l => l.trim().replace(/^\S+\s+/, "")).filter(Boolean);
  const scope = changedFiles.join("\n");
  log(`scope: ${changedFiles.length} ไฟล์`);

  const lenses: { name: string; ask: string }[] = [
    {
      name: "นักตามรอยช่องโหว่",
      ask: "Hunt edge cases and failure modes. For each: file:line, trigger, missing guard, consequence. Read the files — do not reason from a diff alone.",
    },
    {
      name: "นักตรวจช่องว่างของการพิสูจน์",
      ask: "Find claims the change makes that no test actually proves, and tests that would pass if the behavior regressed. For each: the behavior, the covering test, why it cannot fail, the missing assertion.",
    },
    {
      name: "นักตรวจความสอดคล้องกับเจตนา",
      ask: "Read the story spec's intent-contract and matrix. For each matrix row: implemented AND tested? Name the row and evidence. Flag contradictions. Descriptive, not prescriptive.",
    },
    {
      name: "นักหาสิ่งที่หายไป",
      ask: "Look for what is MISSING: error paths never exercised, guarantees asserted only in comments, docs that no longer match the code, secrets mishandled, cleanup that leaves residue. Cite file:line.",
    },
  ];
  const reviews = await Promise.all(
    lenses.map(lens =>
      agent(`ผู้ตรวจ ${story} ${lens.name}`).ask<ReviewResult>(
        `${lens.ask}\n\nThe contract is ${plan.specPath} — read it fully. The change under review ` +
          `is every file differing from baseline ${baseline}:\n${scope}\nRead those files (plus ` +
          `anything they import) with your own tools. Suite currently: ${suite.counts}. ` +
          `Return JSON matching the ReviewResult shape.`,
      ),
    ),
  );
  const normalizedReviews = reviews.map((review, index) => ({
    ...review,
    findings: review.findings.map((finding, fi) => ({
      ...finding,
      id: `internal-${index + 1}-${fi + 1}`,
    })),
  }));
  for (const [index, review] of normalizedReviews.entries()) {
    for (const finding of review.findings) {
      report({ story, reviewer: lenses[index]?.name ?? "internal", ...finding }, "findings");
    }
    log(`${lenses[index]?.name}: ${review.verdict} (${review.findings.length} ข้อ)`);
  }

  // ---- luna ----
  phase("ฟังความเห็นจาก codex-advisor[luna]");
  await agent(`ผู้ประสานงาน lane ของ luna ${story}`).ask(
    `Ensure the codex-advisor[luna] external audit lane for story ${story} has COMPLETED and its ` +
      `outbox exists.\n\nWorking directory: /Users/ngs/agent-skills/plugins/agent-room\n` +
      `Task id: ${lunaTaskId} (letters, digits, dashes ONLY)\n` +
      `Brief: docs/implementation/reviews/story-${story}-luna-brief.md — write it first if absent ` +
      `(read-only audit; contract = ${plan.specPath}; change = every file differing from baseline ` +
      `${baseline}; the outbox FILE is the deliverable; output: # Verdict SHIP|FIX-FIRST, # Findings ` +
      `with - [high|medium|low] headers + Evidence/Why lines, # Checks, terminal line TEAM_DONE ` +
      `${lunaTaskId}).\n\n` +
      `If the outbox already exists WITH the terminal marker, do not re-dispatch — report it.\n` +
      `Env (export in the SAME command): ACP_MODEL=gpt-6-luna ACP_EXPECT_MODEL=gpt-6-luna ` +
      `ACP_REASONING_EFFORT=max ACP_EXPECT_REASONING_EFFORT=max INITIAL_AGENT_MODE=read-only ` +
      `ACP_SESSION_RECEIPT_REQUIRED=1 ACP_SESSION_OPERATION=new CODEX_PATH=/Users/ngs/.local/bin/codex\n` +
      `Dispatch: node ~/.claude/plugins/cache/tmux-teams/tmux-teams/0.38.0/skills/tmux-teams/scripts/acp-dispatch.mjs ` +
      `codex <cwd> ${lunaTaskId} <brief> 1200, then ... wait <cwd> ${lunaTaskId} 3600\n` +
      `Verify effective_identity is gpt-6-luna[max] (matched). If the lane fails, read the runner ` +
      `log, fix, re-dispatch. Return JSON {"task_id":"${lunaTaskId}","effective_identity":"gpt-6-luna[max]","dispatch_confirmed":true,"outbox_path":"${LUNA_OUTBOX}"}.`,
  );

  const lunaText = await files.read(LUNA_OUTBOX).catch(() => "");
  if (!lunaText.includes(`TEAM_DONE ${lunaTaskId}`)) {
    throw new Error(`luna outbox lacks terminal TEAM_DONE ${lunaTaskId}`);
  }
  const lunaVerdictLine = lunaText.split("\n").map(l => l.trim()).find(l => l === "SHIP" || l === "FIX-FIRST");
  const lunaFindings: ReviewFinding[] = [];
  const sevOf = (w: string): "high" | "medium" | "low" | null =>
    w === "blocker" || w === "high" ? "high" : w === "warning" || w === "medium" ? "medium" : w === "nit" || w === "low" ? "low" : null;
  {
    const lines = lunaText.split("\n");
    const fi = lines.findIndex(l => l.trim() === "# Findings");
    const ci = lines.findIndex(l => l.trim() === "# Checks");
    let i = fi + 1;
    let n = 0;
    while (i < ci) {
      const line = (lines[i] ?? "").trim();
      if (line === "") { i += 1; continue; }
      const h = /^- \[(high|medium|low|blocker|warning|nit)\] (.+)$/.exec(line);
      if (!h) { i += 1; continue; }
      n += 1;
      const body: string[] = [];
      let c = i + 1;
      while (c < ci) {
        const next = lines[c] ?? "";
        if (/^- \[(high|medium|low|blocker|warning|nit)\] /.test(next.trim())) break;
        if (next.trim() === "") {
          const upcoming = lines.slice(c + 1, ci).find(x => x.trim() !== "");
          if (upcoming === undefined || !/^\s/.test(upcoming)) break;
          c += 1;
          continue;
        }
        if (!/^\s/.test(next)) break;
        body.push(next.trim());
        c += 1;
      }
      const evidence = body.filter(b => b.startsWith("Evidence:")).map(b => b.slice(9).trim()).join(" ");
      const why = body.filter(b => b.startsWith("Why")).map(b => b.slice(b.indexOf(":") + 1).trim()).join(" ");
      lunaFindings.push({
        where: /((?:docs|server|tests)\/[A-Za-z0-9._/-]+:\d+)/.exec(evidence || why)?.[1] ?? "",
        what: h[2] ?? "",
        impact: [evidence, why].filter(Boolean).join(" — ") || body.join(" "),
        severity: sevOf(h[1] ?? "") ?? "medium",
      });
      i = c > i ? c : i + 1;
    }
  }
  if (lunaVerdictLine === "FIX-FIRST" && lunaFindings.length === 0) {
    throw new Error("luna says FIX-FIRST but no findings parsed — investigate the outbox format");
  }
  for (const finding of lunaFindings) {
    report({ story, reviewer: "codex-advisor[luna]", ...finding }, "findings");
  }
  log(`luna: ${lunaVerdictLine ?? "?"} (${lunaFindings.length} ข้อ)`);

  const allFindings = [
    ...normalizedReviews.flatMap(r => r.findings),
    ...lunaFindings,
  ];

  // ---- Triage ----
  phase("ตัดสินใจว่าจะแก้อะไร");
  const triager = agent(`ผู้ตัดสิน patch ${story}`, {
    system:
      "You triage review findings against a story spec for agent-room v0.2. Assign severity " +
      "yourself by consequence; ignore reviewers' severities. Each finding gets exactly one: " +
      "patch (this story's problem, concrete fix), deferred (real, later story — say which), or " +
      "rejected (noise or by-design — say why). Out-of-scope routing requires the spec's own " +
      "intent as authority. If the spec itself is wrong, say so in specVerdict.",
  });
  const triage = await triager.ask<TriageResult>(
    `Triage the review findings for story ${story}.\n\nSpec (read fully): ${plan.specPath}\n` +
      `Changed files (read them):\n${scope}\nLuna outbox (read fully): ${LUNA_OUTBOX}\n\n` +
      `Findings:\n${JSON.stringify(allFindings, null, 2)}\n\n` +
      `Prefix EVERY patch/deferred/rejected entry with the exact finding id in square brackets.`,
  );
  log(`patch ${triage.patches.length} · defer ${triage.deferred.length} · reject ${triage.rejected.length}`);

  // ---- Patch ----
  phase("ลง patch แล้วตรวจซ้ำ");
  if (triage.patches.length > 0) {
    await implementer.ask(
      `Review pass returned patches for story ${story}. Apply ALL:\n\n` +
        `${triage.patches.map(p => `- ${p}`).join("\n")}\n\n` +
        `Spec verdict: ${triage.specVerdict}\n` +
        `Apply that spec amendment outside the intent-contract block when it names a change.`,
    );
    suite = suiteState(await runSuite());
    if (!suite.green) {
      await implementer.ask(`Patches broke something. Failing tests:\n${suite.failures}\nFix the causes.`);
      suite = suiteState(await runSuite());
    }
    if (!suite.green) throw new Error(`suite red after patches: ${suite.failures}`);
  }
  log(`หลัง patch: ${suite.counts}`);

  // ---- Finalize ----
  phase("ปิดงานและ commit");
  const finalizer = agent(`ผู้ปิดงาน ${story}`, {
    system:
      "You finalize one completed story of agent-room v0.2. Append the Review Triage Log and Auto " +
      "Run Result to the story spec (frontmatter status: done), archive the luna outbox to " +
      "docs/implementation/reviews/, update docs/implementation/ac-evidence.yaml with the real " +
      "test names + honest note, and commit everything. Never rewrite code. Report the commit sha " +
      "verbatim. Also update docs/implementation/sprint-status.yaml — flip this story's key to " +
      "done using: uv run --no-cache /Users/ngs/.agents/skills/bmad-sprint-planning/scripts/" +
      "sprint_plan.py generate --epic-file docs/epics.md --status-file docs/implementation/" +
      "sprint-status.yaml --stories-dir docs/implementation --project agent-room --set " +
      "\"<key>=done\".",
  });
  const finalized = await finalizer.ask<FinalizeResult>(
    `Finalize story ${story}.\n\nSpec: ${plan.specPath}\nBaseline: ${baseline}\n` +
      `Patches: ${JSON.stringify(triage.patches, null, 2)}\nDeferred: ${JSON.stringify(triage.deferred, null, 2)}\n` +
      `Rejected: ${JSON.stringify(triage.rejected, null, 2)}\nSpec verdict: ${triage.specVerdict}\n` +
      `Suite: ${suite.counts}\n\n` +
      `After committing, write docs/implementation/workflows/.unattended-proven.json with ` +
      `{"closed_unattended": true, "last_story": "${story}", "commit": "<commit sha>"} — the marker ` +
      `that records this close. Report the commit sha verbatim.`,
  );
  report({ story, step: "finalized", state: "finalized", commit: finalized.commit, tests: finalized.tests }, "story");
  completed.push({ story, commit: finalized.commit, tests: finalized.tests });
  log(`ปิดสตอรี่ ${story} ที่ ${finalized.commit}`);
}

// ---- AC sweep ----
phase("ตรวจ AC sweep ทุก epic ที่เกี่ยว");
const sweeps: { epic: string; verdict: string }[] = [];
for (const epic of ["4", "5", "6"]) {
  const r = await world.run("node", ["scripts/ac-sweep.mjs", "--epic", epic]);
  const verdict = /Verdict: (\w+)/.exec(r.stdout)?.[1] ?? "unknown";
  sweeps.push({ epic, verdict });
  log(`AC sweep epic ${epic}: ${verdict}`);
}

const tree = await world.run("git", ["status", "--porcelain"]);
if (tree.stdout.trim() !== "") {
  log(`เตือน: tree ยังไม่สะอาดหลัง finalize สตอรี่สุดท้าย: ${tree.stdout.slice(0, 300)}`);
}

await artifact.markdown(
  "report",
  [
    `# รายงานการรันสตอรี่อัตโนมัติ`,
    "",
    ...completed.map(c => `- **${c.story}** → ${c.commit} · ${c.tests}`),
    "",
    `AC sweep: ${sweeps.map(s => `epic ${s.epic} = ${s.verdict}`).join(" · ")}`,
  ].join("\n"),
  { title: "รายงานการรันสตอรี่", description: "สตอรี่ที่ปิด พร้อม commit และผล AC sweep", primary: true },
);

return {
  conclusion:
    `ปิดครบ ${completed.length} สตอรี่: ${completed.map(c => c.story).join(", ")}. ` +
    `AC sweep: ${sweeps.map(s => `epic ${s.epic} ${s.verdict}`).join(", ")}.`,
  findings: [],
  verified: [`node --test after every story and after every patch round`, `AC sweep per epic`, `luna audit per story`],
  notCovered: [`epic-level retrospectives (the orchestrator's operator runs them per the goal)`],
};
