# HANDOFF — agent-room v0.2

## 1. READ THIS FIRST

- Branch `main`, **not pushed** (126+ commits ahead of `origin/main`).
- **The candidate is `3929cc7`** (`docs/release-evidence/v0.2.0-candidate.json`): version `0.2.0`,
  portable package tree digest `3d90129b434b3b7adb9b4b6d8c05ed28b5a8fbf7b07951726c322cc438cf3999`
  (46 files), Claude Code package tree digest
  `e481c9a46ea5e14865119503e6d327df3993b29a28b325eb9eee9421def2f47b` (46 files). All five Story 6.3 gate
  rows pass against it (deterministic materialization, the real `claude plugin validate --strict`
  (2.1.305, exit 0), the installed Claude Code smoke, the installed portable smoke, and SM-C1 — five
  fresh installs, zero failures, 0.460 s raw mean / 0.262 s adjusted against v0.1's 0.352 s anchor).
- **THREE re-cuts, and the third was the advisors' doing.** The release-gate review found that the
  SHIPPED source, the CLI help, the packaged CHANGELOG and the packaged README still carried the
  overclaim the repo's record had already been corrected for. The codex lane recommended correcting the
  shipped explanations and re-cutting rather than publish a package whose operator-facing text promises
  more than the mechanism delivers; the agy lane was quota-exhausted for that round, so its earlier
  verdict stands as recorded (approve the bytes, correct the record). The third re-cut was TEXT-ONLY and
  it settled the process rule: **a story's changelog entry and README section land WITH the story,
  before the candidate is frozen.**
- **The quiet-host contract has been through an advisor gate, and the INSTRUMENT it names was
  rebuilt.** Both lanes (codex `gpt-6.1-sol[ultra]`, claude `claude-fable-5`; the agy seat was
  quota-exhausted) agreed the CORRECTION was honest — the timing, the basis, the cost of a voided
  night — and converged on the same two defects in the observer the contract names as its sole
  source, both of which would have marked every window CONFOUNDED: the busy-CPU total counted
  **idle and iowait** as consumption (an idle four-core host read 4.000 foreign cores), and the
  run's own CPU was summed over the processes that happened to be alive (the harness replaces its
  four clients every hour, so every replacement looked like a multi-core foreign spike). They also
  found that the CONFOUNDED verdict had no scorer at all, that the baseline was hearsay, and that
  the aggregation statistic lived only in the review brief. Their verdicts are archived at
  `docs/implementation/reviews/epic-6-quiet-host-contract-{codex,claude}.md`.
  What closed them: the run's identity and CPU are now its **cgroup's** (monotonic across process
  exit; no substring matching); busy CPU excludes idle and iowait; `steal` is reported separately;
  the observer excludes its own cost by sitting in its own cgroup; the per-minute sample is
  fork-free; the baseline is MEASURED and the foreign processes are PINNED by identity; the
  thresholds are frozen in `docs/implementation/rel3-quiet-host-thresholds.json`; and
  `scripts/rel3-soak-eligibility.mjs` is the named scorer (ELIGIBLE / CONFOUNDED / INCOMPLETE —
  never PASS, and missing telemetry is INCOMPLETE). The self-check
  `scripts/rel1-soak-telemetry-check.sh` now PASSES every assertion and is archived under
  `docs/release-evidence/v0.2.0-quiet-host/`. **One more finding came out of the repair: ngs-staging
  is not a quiet host and cannot be one** (a staging auto-deploy compiles PHP every minute, so the
  host's busy time moves between ~0.2 and ~4.0 cores) — so the CPU thresholds are relative to the
  measured baseline, which is the same F18 lesson one clause further on.
- **The quiet-host rule is FROZEN, DIGESTED and PROVEN on the host — the round-3 gate is running.**
  The round-2 gate (both lanes) held the launch and found nine defects; all nine are closed, and two
  more were found by the rehearsal and are closed too. The two that would have voided every night: the
  observer read `/proc/<pid>/cgroup` with a NUL delimiter, so the trailing newline stayed in the value,
  the run's own processes never matched, and SEVEN of them were counted as FOREIGN in every sample
  (the rehearsal's `foreignProcs=11` was `4 + 7`); and the observer's per-sample flag and its cadence
  variable shared a name, so it had been sampling every SECOND instead of every minute. The rest: a
  failed measurement could not be told from a good one (the observer now reports its validity signals
  and the scorer requires them); the window defaulted to the log's last sample and coverage counted
  ROWS (now: the run's bounds are required, the window is aligned to the last tracker sample, and
  coverage is measured in ELAPSED TIME); the limits were recomputed at adjudication time from
  operator-supplied files (now: ABSOLUTE limits registered in the thresholds file, with the baseline
  as a cross-check and the relative form a reported diagnostic); the launcher swallowed a failed
  cgroup placement and printed advice instead of enforcing it (now it verifies the placement, waits
  for a sound observer sample, stops the run if the host's baseline has moved since the registration,
  and stops the run if the minute-one partition is wrong); the amendment and the thresholds file gated
  DIFFERENT statistics (now the same two — the median and the elapsed-time-weighted mean); and the
  registered known limit understated the blind spot by about five times (now stated with its
  arithmetic: a one-core neighbour can be present for up to about 180 of the window's 240 minutes and
  still pass). The judge has **thirty fixtures** (`tests/soak/rel3-soak-eligibility.test.mjs`) driving
  the real scorer over synthetic logs, and the suite is green at **616 pass / 0 fail / 0 skipped**.
  The evidence is under `docs/release-evidence/v0.2.0-quiet-host/`: the host's baseline measured with
  the final observer (19 samples, mean 0.826, median 0.845) and a bursty window (41 samples, mean
  0.954, median 0.916, max 1.966) — the calibration; the self-check, every assertion green, including
  that the observer's counts match the cgroup's ACTUAL membership; and an end-to-end rehearsal whose
  own row reads `ownProcs=7 foreignProcs=4`, whose placement was verified, and whose adjudication
  returned INCOMPLETE with its reasons named.
- **THE TWELVE-HOUR QUALIFYING RUN IS IN FLIGHT.** It was launched 2026-10-22T12:17:57Z on the quiet
  host ngs-staging (`ssh 43.229.78.155`), world under `/root/rel1-soak6/.soak-world/`, launcher
  `scripts/rel3-soak-launch.sh` with a fifteen-minute pre-run baseline. Its tracked window ends about
  **2026-10-23T00:33Z**, and the final drain after that; the observer stops with the run, and
  `scripts/rel3-soak-adjudicate.sh /root/rel1-soak /root/rel1-soak6 attempt6-3929cc7` produces the
  eligibility verdict and archives the attempt's own evidence. **v0.2.0 is HELD until that verdict and
  the harness's own verdict are both read.** **Do not run `node --test`, another soak, or any heavy
  workload on ngs-staging or on this Mac while it is in flight** — the run's quiet-host contract is
  pre-registered, and a window whose telemetry breaches it is CONFOUNDED: the attempt is recorded under
  its own name as incomplete, never scored, never re-scored. The launch record at
  `/root/rel1-soak6/launch-record.txt` pins the commit, the five rule digests, the extra baseline's
  digest, the measured baseline and the placement and partition checks.
- **The formal soak is NOT in flight — the next twelve-hour run starts after the corrected
  quiet-host contract clears its advisor gate.** The first twelve-hour run (attempt 5: launched
  2026-10-22T02:41Z on the QUIET host ngs-staging, `ssh 43.229.78.155`, world under
  `/root/rel1-soak5/.soak-world/`, server pid 1325282, `candidate-exact`) was **ABORTED at 130.37 min**
  (2026-10-22T04:47:40Z) — not for anything the server did: the pre-registered quiet-host contract
  turned out to be UNSATISFIABLE on the host it was written for. It forbade any node process but the
  run's own, while ngs-staging carries seven foreign node processes of its own (a model gateway, two
  MCP servers with their npm wrappers, a `next-server`, the codex app-server) that were present during
  every attempt including attempt 4; and it gated the 1-minute load average, which on this host is
  dominated by the run's OWN fsync waits (the CPU sat over 90% idle while the load read 1.2–3.2). A
  criterion that can never be satisfied disqualifies every attempt equally — it measures the HOST, not
  the run. The contract is now a baseline-comparison form (available-memory floor; foreign node count
  against the host's own baseline; foreign CPU in cores; the load average REPORTED, not gated), its
  source is the repository's own read-only sidecar `scripts/rel1-soak-telemetry.sh`, and the MEMORY
  GATE ITSELF IS UNTOUCHED. Attempt 5 is never scored and the release evidence is not overwritten.
  **While the next run is in flight: do not run `node --test`, another soak, or any heavy workload on
  ngs-staging or on this Mac** — a window whose telemetry breaches the contract is CONFOUNDED, and the
  attempt is then recorded as INCOMPLETE, never scored.

  **How it got here.** Attempt 4 ran against `3929cc7` on the quiet host and FAILED one rule — the
  final-window RSS total-growth bound (113.9 → 116.5 MiB; `growthRatio` 0.02239 against 0.02; the
  slope's implied growth 0.03988) — with everything else green (zero loss over 23,080 messages, FD
  stable, 47 bursts, 7 reconnect cycles). Two advisor lanes found that the rule, as placed, measured
  EQUILIBRATION rather than retention: the profile's ramp IS the first half of the run and the measured
  window IS the cap-hold, so the rule asked whether the process had stopped growing during the hours it
  first carried its heaviest sustained load. The rule was therefore amended prospectively (the gate is
  FR-13's single band, the endpoint term is demoted to a report, the window is FR-13's four hours, the
  run is twelve hours with the ramp bounded to four, the retained-state diagnostic is collected and
  reported, the quiet-host contract is pre-registered), calibrated (twelve rows, four of them KNOWN
  LIMITATIONS), owner-ratified, and put through a second advisor gate whose findings are all closed.
  The ruling and the pre-registration:
  `docs/implementation/spec-6-2-rel-3-the-formal-soak.md.amendment-2026-10-22.md`. Attempt 4 is never
  re-scored, and the release evidence is NOT overwritten.
- **The soak's temp world must NOT live in `/tmp`** — macOS temp cleanup ate a credential file
  during an earlier run. The worlds are under `/root/rel1-soak4/` (attempt 4) and `/root/rel1-soak5/`
  (attempt 5, aborted); each new run gets its own directory.
- **REL-1 is DONE and verified** (`docs/release-evidence/v0.2.0-rel1/`, `scripts/rel1-verify-evidence.mjs`
  exits 0): two physical machines (NSG-Mac-mini and ngs-staging), two vendor hosts (the real Zcode
  CLI 0.17.0 on the Mac, the real Claude Code 2.1.306 on staging through that host's own model
  gateway), one self-hosted Room Server (Docker `node:24-alpine`, TLS with a demo CA) on ngs-2.
  DMs both ways inside the literal `<untrusted_message version="1">` envelope; the trust matrix HELD a
  cross-machine message (metadata only, body withheld) and then RELEASED it with its body; broadcasts
  both ways; the viewer's freshness MEASURED (0.150 s same-machine, 0.276 s cross-machine, with the
  observer attached BEFORE the first broadcast so all four arrivals are live); zero DM content in the
  whole rendered DOM; a browser-session recording, a screenshot, both vendor transcripts, the operator
  takeover receipts from both machines, and both machine preflights green.
- **The lease defect REL-1 found is FIXED and shipped** (`6d6b45f` + the corrected text in `3929cc7`,
  Story 6.4): the explicit, same-Actor, operator-authorized takeover with an atomic transfer and a
  fence; the MCP adapter's orderly-exit release; `agent-room session replace`. Nineteen acceptance rows
  in `tests/session-replacement.test.mjs`.
- **Two advisor lanes reviewed the release gate, twice**
  (`docs/implementation/reviews/epic-6-release-gate-{codex,agy}.md` and
  `epic-6-comments-vs-recut-codex.md`). The first round REFUSED to sign a blanket "6.4 enforces every
  guarantee" claim; the record was corrected everywhere (see §6) and five runtime items are OPEN work
  for the next release (§5). The second round found the shipped text's overclaim and produced the third
  re-cut.
- Working tree: clean at the last commit; `git status` before committing.

## 2. HOW TO VERIFY

```bash
node --test --test-concurrency=1 --test-timeout=600000   # 586 pass / 0 fail / 0 skipped (the release run)
node scripts/ac-sweep.mjs --epic N       # per epic 1..6; all six verdicts are `clean`
node scripts/rel1-verify-evidence.mjs --dir docs/release-evidence/v0.2.0-rel1   # exits 0
claude plugin validate <materialized-pkg> --strict   # release gate; needs the `claude` CLI
```
`--test-timeout` is required: several real-child integration tests exceed the 120 s default under load. Use
**600000**, not 300000 — the REL-3 compressed-soak validation runs a 5-minute profile that takes ~327 s on its
own, so a 300 s cap cancels it and reports a `not ok` that is a timeout, not a failure.

`--test-concurrency=1` is the RELEASE RUN's setting, and the reason is the same one as the soak's: the
compressed profile's final-window RSS rule measures the allocator under whatever else the machine is
doing. Under the full PARALLEL suite that row fails; ALONE it passes (366 s, exit 0) and SERIALLY it
passes (the release run: 574 pass / 0 fail). It is a load artifact, not a regression — and it is the same
effect that made soak attempt 2 look like a leak.

## 3. STATE

- **Epics 1–5: accepted**, each with audit + retro in `docs/implementation/epic-{1..5}-{completion-audit,retro}-*.md`.
- **Epic 6**: state record `docs/implementation/epic-6-state-in-progress.md`; audit
  `docs/implementation/epic-6-completion-audit.md`; retro `docs/implementation/epic-6-retro-2026-10-21.md`.
  - 6.1 **done** (evidence + verifier above).
  - 6.2 **the open gate** (the twelve-hour run, above).
  - 6.3 **done** (the candidate record above).
  - 6.4 **done** (the repair above).
- **Soak history** (every attempt kept under its own name, none relabelled):
  `docs/release-evidence/v0.2.0-soak-results.{json,md}` — attempt 1's PASS against the superseded
  `7dc980f`; `docs/release-evidence/v0.2.0-soak-attempts/` — attempt 2's FAIL against `89c8477`
  (host contention: the advisor review's statistical refutation of my own "unlucky phase" explanation,
  with the diagnostic beside it), attempt 3's 191 tracked minutes on the quiet host (stopped as void; its
  flat RSS trace is the evidence for the contention diagnosis), and the fresh run's telemetry.
- **Release notes**: `docs/release-notes-v0.2.md` (the one-time v1→v2 cursor reset, the SM-C1 numbers, the
  claimed-clients table, the reconnect-recovery section, and the changelog position).

## 3a. THE CLOSEOUT, STEP BY STEP (after the run's drain finishes)

The run's evidence lands in `/root/rel1-soak6/.soak-world/evidence/`. The steps, in order, and what each
one decides:

1. **Adjudicate the host window** — `ssh 9router 'cd /root/rel1-soak && bash scripts/rel3-soak-adjudicate.sh /root/rel1-soak /root/rel1-soak6 attempt6-3929cc7'`. It verifies the scorer's and the baseline's bytes against the launch record, scores the window against the FROZEN thresholds, and archives the attempt's evidence under its own name. **ELIGIBLE** means the host window was admissible; it does NOT mean the soak passed.
2. **Read the harness's own verdict** in `docs/release-evidence/v0.2.0-soak-attempts/attempt6-3929cc7.md` (the copied results). The release qualifies only if BOTH the harness says `pass` (with `wallMinutes ≥ 480`, `rules.finalWindowRss.pass`, `rules.fdStability.pass`, `rules.zeroMessageLoss.pass`, the identity `candidate-exact`, and no `failureReasons`) AND the eligibility verdict is `eligible`.
3. **Only then** copy `attempt6-3929cc7.json`/`.md` over `docs/release-evidence/v0.2.0-soak-results.{json,md}` — the release evidence. If either verdict fails, the release evidence is NOT overwritten and the release stays HELD.
4. **Update the record**: the AC evidence entry for 6.2 (`docs/implementation/ac-evidence.yaml`), the completion audit's verdict, the retro's acceptance verdict, the state record, and this file. Run `node scripts/ac-sweep.mjs --epic 6` and `node scripts/rel1-verify-evidence.mjs --dir docs/release-evidence/v0.2.0-rel1`.
5. **The sprint status**: `python3 ~/.agents/skills/bmad-retrospective/scripts/sprint_status.py update --file docs/implementation/sprint-status.yaml --epic 6 --set-retro-done --add-action '<the remaining open actions>' --verdict <the verdict>`, and then the story keys (`6-1-…`, `6-2-…`, `6-4-…`, `epic-6`) — the script owns the retro flag and the action items; the story keys are the orchestrator's.
6. **Tag** `v0.2.0` and commit everything with `git add` on NAMED paths (never `git add -A`).

## 4. DO NOT

- **Do not commit `server/` or `client/` code while a soak is in flight** — the candidate-immutability
  law: any product-code change after the soak started kills the RC and forces a full re-soak. Docs and
  tooling commits are fine.
- **Do not run heavy work on ngs-staging** while the soak runs, and do not run the full suite on a
  machine that is hosting a soak.
- **Do not put a soak world in `/tmp`** — macOS temp cleanup deleted the soak's `local-token` mid-run.
- **Do not edit the packaged CHANGELOG** (`CHANGELOG.md` ships inside both packages) after the freeze:
  it changes the artifact's bytes, voids the candidate and costs an eight-hour re-soak. The 6.4 entry
  and the released heading are therefore carried by the release notes; the process question is open
  (retro F8 / A1).
- **Do not `git add -A` while a workflow run is in flight.**
- **Do not hand-edit `sprint-status.yaml`** — use `python3 ~/.agents/skills/bmad-retrospective/scripts/sprint_status.py update …`.
- **Do not mark Epic 6 accepted before the soak passes** — both advisors ruled independently that
  "accepted-with-open-items" is release debt (`docs/implementation/reviews/epic-6-execution-{luna,agy}.md`).
- **Do not simulate REL-1's substance** — physical machines + real vendors are the proof.
- **Do not broaden the soak's RSS gate** — the memory rule is asserted on the settled idle window, not
  under load (Story 4.8's redesign, `c6cb589`).

## 5. DECIDED — DO NOT RELITELIGATE

- **REL-1 cannot be simulated** — ruled by both advisors independently; user-endorsed.
- **Epic 6 stays in-progress until the soak passes.**
- **1 session = 1 Chat ID; trust binds Actor fingerprints, never names** (D13, user decision).
- **The `<untrusted_message>` v1 envelope is frozen** — additive labeling only.
- **Ban ships WITHOUT session revocation** — the ban holds at the resource boundary (Story 4.5).
- **Local Mode is the default; Remote Mode is opt-in and https-only** (FR-1/AD-10).
- **Candidate immutability law** — code change after a soak starts kills the RC; new RC = re-soak.
- **The memory rule is asserted on the settled idle window, not under load** (Story 4.8).
- **The v0.2.0 ownership semantics are what the code delivers, and the release owner accepted the
  reduced intra-Actor semantics** (both advisor lanes: approve the candidate bytes for v0.2.0, log the
  concurrency items for the next release). The next release's first acceptance criterion is the stronger
  one: revalidate the session authority after the last awaited input step, directly before the mutation.

## 6. OPEN — the five runtime items the release-gate review found

Each is recorded in the Epic 6 retro with the review's executed proof, and each is scheduled for the next
release:

| # | Item | Why it matters |
|---|---|---|
| A5 | Revalidate the session authority after the LAST awaited input step | the fence is checked before the request body is read, so a request admitted before a handoff whose body was still streaming can still reach the handler |
| A6 | Bind the takeover intent to an OBSERVED incumbent (an opaque conflict ticket, never a bearer or a digest) | today the takeover displaces whoever holds the name at that moment, so a stale intent is not refused |
| A7 | Make the fence's retention unexhaustible | the fence is bounded at 1,000 entries, so 1,001 supersessions can forget a still-admitted predecessor |
| A8 | Signal-safe teardown in the MCP adapter (SIGTERM/SIGINT → release → exit) | `input.once('close')` covers a polite exit, not a host that kills the child: in the real run the name stayed squatted after three clean CLI exits |
| A9 | The shutdown-during-initial-bind race | stdin can close while the first bind is pending; the release then sees no token |

## 7. UNPROVEN

- **Automatic unattended crash recovery** — not built and not promised: identifying the rightful
  successor process needs session-resume ownership evidence the Actor key alone cannot provide.
- **A human-facing screen recording** of the operator's desktop — the recording is the browser session.
- **The evidence verifier is a structural check**, not an adjudicator: it greps transcripts for
  substrings and checks that files exist; it does not recompute the freshness arithmetic or distinguish
  a first transmission from an idempotent replay (A10).

## 8. WHERE THINGS LIVE

- Epics/ACs (source of truth): `docs/epics.md`
- Story specs: `docs/implementation/spec-*.md` (Story 6.4: `spec-6-4-reconnect-recovery-takeover.md`)
- Per-epic audits/retros: `docs/implementation/epic-{1..6}-{completion-audit,retro}-*.md`
- Epic 6 state record: `docs/implementation/epic-6-state-in-progress.md`
- AC evidence: `docs/implementation/ac-evidence.yaml` · sweep: `node scripts/ac-sweep.mjs --epic N`
- v0.1 baseline / v0.2 candidate / soak results: `docs/v01-baseline.md`,
  `docs/release-evidence/v0.2.0-candidate.json`, `docs/release-evidence/v0.2.0-soak-results.{json,md}`
- Release notes: `docs/release-notes-v0.2.md` · REL-1 kit: `scripts/rel1-preflight.mjs`,
  `docs/rel1-runbook.md`, `scripts/rel1-verify-evidence.mjs`
- Advisor verdicts: `docs/implementation/reviews/*`; raw outboxes `.mailbox-out/`
- Runtime gates: Node ≥ 24.15, SQLite ≥ 3.51.3 — asserted at every entrypoint

## 9. THE MACHINE-LEVEL EDITS THIS SESSION MADE (outside the repo — review or revert)

- `~/.zcode/v2/provider_config.json` — the model order was changed so the free `minimax-m3.1-flash-free`
  seat is picked first (the CLI's monthly quota was exhausted otherwise). Backup: `/tmp/provider_config.backup.json`.
- `~/.zcode/cli/config.json` — the `agent-room` MCP server is registered for the Zcode CLI (the portable
  package as the entrypoint, `PLUGIN_DATA` pointing at the demo installation). Backup: `/tmp/zcode-config-backup.json`.
- `~/.local/bin/zcode` — a symlink to the desktop app's `zcode.cjs`, so the REL-1 preflight can find the
  `zcode` binary on PATH. Remove it if the desktop app manages its own.
- The demo hosts still carry state: the server container `agroom-rel1-64` on ngs-2 (port 18444, data dir
  `/home/forge/rel1-64-data`) and the installed package + client under `/root/rel1-claude/` on ngs-staging.
