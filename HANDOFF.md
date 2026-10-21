# HANDOFF — agent-room v0.2

## 1. READ THIS FIRST

- Branch `main`, **not pushed** (126+ commits ahead of `origin/main`).
- **The candidate is `6d6b45f`** (`docs/release-evidence/v0.2.0-candidate.json`): version `0.2.0`,
  portable package tree digest `ad08240b847d970233fff44e182cd3c8787ded45e66751796672082c03d4fceb`
  (46 files), Claude Code package tree digest
  `fe4d2aaa2520e0031538c07a28b4b24e6439d6ecf92514ce8ea735e44f378d88` (46 files). All five Story 6.3 gate
  rows pass against it (deterministic materialization, the real `claude plugin validate --strict`
  (2.1.305, exit 0), the installed Claude Code smoke, the installed portable smoke, and SM-C1 — five
  fresh installs, zero failures, 0.460 s raw mean / 0.265 s adjusted against v0.1's 0.352 s anchor).
- **The formal 8-hour soak is the open gate.** It is running against `6d6b45f` on the QUIET host
  ngs-staging (`ssh 43.229.78.155`), launched 2026-10-21T11:29:25Z, server pid 1017734, world under
  `/root/rel1-soak4/.soak-world/`, with an external read-only host-telemetry sidecar writing
  `host-telemetry.log` beside it. The run's identity line reads `candidate-exact`.
  **Do not run `node --test`, another soak, or any heavy workload on ngs-staging while it is in
  flight** — that is exactly what broke soak attempt 2.
- **The soak's temp world must NOT live in `/tmp`** — macOS temp cleanup ate a credential file
  during an earlier run. The world is under `/root/rel1-soak4/`.
- **REL-1 is DONE and verified** (`docs/release-evidence/v0.2.0-rel1/`, `scripts/rel1-verify-evidence.mjs`
  exits 0): two physical machines (NSG-Mac-mini and ngs-staging), two vendor hosts (the real Zcode
  CLI 0.17.0 on the Mac, the real Claude Code 2.1.306 on staging through that host's own model
  gateway), one self-hosted Room Server (Docker `node:24-alpine`, TLS with a demo CA) on ngs-2.
  DMs both ways inside the literal `<untrusted_message version="1">` envelope; the trust matrix HELD a
  cross-machine message and then RELEASED it; broadcasts both ways; the viewer's freshness MEASURED
  (0.107 s same-machine, 0.217 s cross-machine); zero DM content in the rendered DOM; a browser-session
  recording, a screenshot, both vendor transcripts, and both machine preflights green.
- **The lease defect REL-1 found is FIXED and shipped** (`6d6b45f`, Story 6.4): the explicit,
  same-Actor, operator-authorized takeover with an atomic transfer and a fence; the MCP adapter's
  orderly-exit release; `agent-room session replace`. Nineteen acceptance rows in
  `tests/session-replacement.test.mjs`.
- **Two advisor lanes reviewed the release gate** (`docs/implementation/reviews/epic-6-release-gate-{codex,agy}.md`)
  and both REFUSED to sign a blanket "6.4 enforces every guarantee" claim. The record was corrected
  everywhere (see §6) and five runtime items are OPEN work for the next release (§5).
- Working tree: clean at the last commit; `git status` before committing.

## 2. HOW TO VERIFY

```bash
node --test --test-timeout=600000        # 574 pass / 0 fail / 0 skipped
node scripts/ac-sweep.mjs --epic N       # per epic 1..6; all six verdicts are `clean`
node scripts/rel1-verify-evidence.mjs --dir docs/release-evidence/v0.2.0-rel1   # exits 0
claude plugin validate <materialized-pkg> --strict   # release gate; needs the `claude` CLI
```
`--test-timeout` is required: several real-child integration tests exceed the 120 s default under load. Use
**600000**, not 300000 — the REL-3 compressed-soak validation runs a 5-minute profile that takes ~327 s on its
own, so a 300 s cap cancels it and reports a `not ok` that is a timeout, not a failure.

## 3. STATE

- **Epics 1–5: accepted**, each with audit + retro in `docs/implementation/epic-{1..5}-{completion-audit,retro}-*.md`.
- **Epic 6**: state record `docs/implementation/epic-6-state-in-progress.md`; audit
  `docs/implementation/epic-6-completion-audit.md`; retro `docs/implementation/epic-6-retro-2026-10-21.md`.
  - 6.1 **done** (evidence + verifier above).
  - 6.2 **the open gate** (the 8-hour run above).
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
