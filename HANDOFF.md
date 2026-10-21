# HANDOFF — agent-room v0.2

## 1. READ THIS FIRST

- Branch `main`, **not pushed** (42+ commits ahead of `origin/main`).
- **The REL-3 8-hour soak PASSED** against candidate `7dc980f` (commit `3aec7ed`; 481.5 min; zero loss over 22625 messages; FD stable; final-window RSS pass). That PASS belongs to `7dc980f`.
- **The candidate was RE-CUT** (`2c9cfe7`, record at `docs/release-evidence/v0.2.0-candidate.json`, commit `89c8477`, version `0.2.0`): a real cross-machine demo found that the shipped viewer could NEVER connect (it read the boot descriptor at the wrong level of the API envelope — fixed in `cc7eb6e`, regression test `tests/viewer-app.test.mjs`), and the v0.2.0 version stamp was applied BEFORE the re-cut so the shipped bytes and the frozen bytes are the same. All 5 Story 6.3 gate rows pass against the re-cut artifact; SM-C1 adjusted mean 0.318 s (below v0.1's 0.352 s anchor).
- **Soak attempt 2 against the re-cut candidate FAILED** the final-window RSS rule (481.5 min, `candidate-exact`, zero loss over 22,615 messages, FDs stable, but `growthRatio` 1.7003 against the 0.02 bound). It is kept as its own attempt in `docs/release-evidence/v0.2.0-soak-attempts/` and is never relabelled. Two advisor round-tables (`epic-6-soak-rss-{astra,agy}.md`) agree the run was **contaminated** — the host was running the 555-test suite, a second compressed soak and a vendor-CLI demo during hour 1 — and agree the answer is a quiet-host repeat with the candidate and harness UNCHANGED, plus external host telemetry.
- **Soak attempt 3 is RUNNING on the QUIET host ngs-staging** (`ssh 9router`), launched 2026-10-21T07:14:51Z, server pid 924048, `candidate-exact` at launch, 4 CPU, load ~1.0, world under `/root/rel1-soak/.soak-world/` (outside `/tmp`), with an external read-only host-telemetry sidecar writing `host-telemetry.log`. **Do not run `node --test`, another soak, or any heavy workload on ngs-staging or on this Mac while it is in flight** — that is exactly what broke attempt 2.
- **The soak's temp world must NOT live in `/tmp`** — macOS temp cleanup ate its credential file. Re-locate the soak world to a repo-ignored dir (e.g. `.soak-world/`) before re-running.
- Working tree: currently has Story 4.7's fix-loop output committed (`0eb3e94`+`562ea81`) plus 4.7/4.8 evidence entries — verify with `git status`.
- The story-build workflow is **PARKED** (see DO NOT #1).

## 2. HOW TO VERIFY

```bash
node --test --test-timeout=600000        # expect ~554+ pass, 0 fail (some storage-gate tests need >1 GiB free — see DO NOT #4)
node scripts/ac-sweep.mjs --epic N       # per epic 1..6; verdict must be `clean` (epic 6 currently `gaps` — 6.1/6.2 open by design)
claude plugin validate <materialized-pkg> --strict   # release gate; needs the `claude` CLI
```
`--test-timeout` is required: several real-child integration tests exceed the 120 s default under load. Use **600000**, not 300000 — the REL-3 compressed-soak validation runs a 5-minute profile that takes ~327 s on its own, so a 300 s cap cancels it and reports a `not ok` that is a timeout, not a failure.

## 3. STATE

- **Epics 1–5: accepted**, each with audit + retro in `docs/implementation/epic-{1..5}-{completion-audit,retro}-*.md`. Per-story specs live in `docs/implementation/spec-*.md`, each ending with a Review Triage Log + Auto Run Result.
- **Epic 6 (in progress)** — state record: `docs/implementation/epic-6-state-in-progress.md`.
  - 6.3 **done**: RC frozen — `docs/release-evidence/v0.2.0-candidate.json` (commit `7dc980f`, tree digests, Node v24.18.1 / SQLite 3.53.4); SM-C1 PASS (0.459 s mean, 0.264 s adjusted vs v0.1's 0.352 s); release notes at `docs/release-notes-v0.2.md`.
  - 6.2 **PASS**: runner `tests/soak/rel3-soak.mjs` (8h tracked, 481.5 min; candidate-exact `7dc980f`; zero loss 22625; FD stable; RSS pass; 47 bursts; 7 reconnects; 481 samples). Evidence: `docs/release-evidence/v0.2.0-soak-results.{json,md}` (commit `3aec7ed`).
  - 6.1 **prepared, awaiting the human**: `scripts/rel1-preflight.mjs` + `docs/rel1-runbook.md` + `scripts/rel1-verify-evidence.mjs` (the Operator Flight Kit). The physical two-machine demo is the human's — it cannot be simulated (see DECIDED).
- **Advisor verdicts on Epic 6 execution** (consensus: RC-first ordering, flight kit, human demo last): `docs/implementation/reviews/epic-6-execution-{luna,agy}.md`.

## 4. DO NOT

- **Do not commit `server/` or `client/` code while a soak/run is in flight** — the candidate-immutability law: any product-code change after the soak started kills the RC and forces a full re-soak. Docs/tooling commits are fine. (Measured: `assertBaselineHead` correctly failed runs `dwfrun-{7a668b26,e3b56d2f}` for exactly this.)
- **Do not run the story-build workflow on a dirty tree** — its clean-tree precondition refuses, correctly (`dwfrun-3455d41f` died there). Commit or stash first.
- **Do not `git add -A` while a workflow run is in flight** — it sweeps the story's own uncommitted files into tooling commits and trips the baseline guard (`dwfrun-{9941dd61,d3e1f08c}` died this way). Commit only named paths.
- **Do not put the soak world in `/tmp`** — macOS temp cleanup deleted the soak's `local-token` mid-run (the failed run's root cause, `docs/release-evidence/v0.2.0-soak-results.json` failureReasons[0]). Re-locate to a repo-ignored dir.
- **Do not mark Epic 6 accepted before REL-1 passes** — both advisors ruled independently (luna: "interim only"; agy/Grumbal: "accepted-with-open-items is release debt"). `docs/implementation/reviews/epic-6-execution-{luna,agy}.md`.
- **Do not simulate REL-1's substance** (localhost namespaces, mocked vendors) — every legitimate automated simulation already exists as Stories 1.8/4.8/5.3/6.3. Physical machines + real vendors are the proof.
- **Do not hand-edit `sprint-status.yaml`** — it lagged the real work twice (Epic 1 retro F6, Epic 2 close). Use `scripts/ac-sweep.mjs` for verification and the `sprint_plan.py`/`sprint_status.py` scripts for writes.
- **Do not retry a failing workflow dispatch more than twice** — after two provider failures, hand-loop the story (this is how 4.2–4.5 and 4.7 landed).
- **Do not widen the soak's RSS gate to under-load windows** — under heavy traffic the RSS slope measures allocation rate (5–8%/s measured), not leaks; the 2% rule is asserted on the settled idle window only (Story 4.8's redesign, `c6cb589`).

## 5. DECIDED — DO NOT RELITIGATE

- **REL-1 cannot be simulated** — ruled by both advisors independently (luna: the named vendors/network/human observation ARE the proof; agy/Grumbal: "ABSOLUTELY NOT… safety theater"). User-endorsed via the standing advisor instruction.
- **Epic 6 stays in-progress until REL-1 passes** — luna + agy consensus; the operator endorsed advisor-mediated decisions.
- **1 session = 1 Chat ID; trust binds Actor fingerprints, never names** (D13, user decision).
- **The `<untrusted_message>` v1 envelope is frozen** — additive labeling only (Story 1.7 freeze; 1.8 byte-pin; REL-2 byte-match).
- **Ban ships WITHOUT session revocation** — the ban holds at the resource boundary; existing sessions stay alive by design (Story 4.5 Design Note; do not "fix" the apparent gap).
- **Local Mode is the default; Remote Mode is opt-in and https-only** (FR-1/AD-10).
- **Candidate immutability law** — code change after a soak starts kills the RC; new RC = re-soak (agy consensus, Epic 6).
- **The memory rule is asserted on the settled idle window, not under load** (Story 4.8 redesign, `c6cb589`).

## 6. UNPROVEN

- **The 8-hour soak has never completed** — the only run died at 60 min (environmental). Zero-loss, FD stability, and the final-four-hour RSS rule are all unproven until a green re-run.
- **REL-1 (physical two-machine, two-vendor)** — unproven by design; the Flight Kit (`scripts/rel1-preflight.mjs`, `docs/rel1-runbook.md`, `scripts/rel1-verify-evidence.mjs`) is built but never executed against real hardware.
- **The declared-remote lane under real challenge traffic** — exercised by 4.8's drill over one machine's TLS; real cross-machine wire is REL-1.
- **The reconnect loop's mutation coverage claims** rest on the 2.2 review pass's mutation runs (14 mutations, zero survivors) — the mutations themselves are not preserved as permanent tests beyond the five added tests.
- **The 4.6 storage-gate findings from the mislabeled review run** (29 findings produced under a wrong story key before the run was fixed) — several were folded into the 4.6 hardening, but the full list was never formally triaged; it lives in the `dwfrun-7bb57776` run record's findings table.

## 7. WHERE THINGS LIVE

- Epics/ACs (source of truth): `docs/epics.md`
- Story specs (done, with triage logs + Auto Run Results): `docs/implementation/spec-*.md`
- Per-epic audits: `docs/implementation/epic-{1..5}-completion-audit.md`, `epic-{1..5}-retro-*.md`
- Epic 6 state record: `docs/implementation/epic-6-state-in-progress.md`
- AC evidence: `docs/implementation/ac-evidence.yaml` · sweep: `node scripts/ac-sweep.mjs --epic N`
- Workflow (parked): `docs/implementation/workflows/agent-room-story-build.ts` · batch orchestrator: `agent-room-epic-batch.ts`
- v0.1 baseline / v0.2 candidate / soak results: `docs/v01-baseline.md`, `docs/release-evidence/v0.2.0-candidate.json`, `docs/release-evidence/v0.2.0-soak-results.{json,md}`
- Release notes: `docs/release-notes-v0.2.md` · REL-1 kit: `scripts/rel1-preflight.mjs`, `docs/rel1-runbook.md`, `scripts/rel1-verify-evidence.mjs`
- Advisor verdicts: `docs/implementation/reviews/*luna*.md`, `*agy*.md`; raw outboxes `.mailbox-out/`; lane state `.tmux-teams/`
- Runtime gates: Node ≥ 24.15, SQLite ≥ 3.51.3 — asserted at every entrypoint (`server/runtime.mjs`); `package.json` engines pinned and test-tied
