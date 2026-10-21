# Epic 6 State Record — In Progress (awaiting wall-clock + human)

Date: 2026-10-20 (candidate re-cut; soak re-running) · Suite: **554 tests** · Commit: `0110831` (preflight evidence) on top of `2c9cfe7` (candidate re-freeze)

## Verdict (interim, per both advisors)

**Epic 6 remains IN_PROGRESS until REL-1 passes.** Both advisors (codex-advisor[gpt-6-luna] and
agy-advisor[gemini], consulted per the operator's standing instruction) independently ruled:

- Stories 6.3 → 6.2 → 6.1-prep are autonomously executable and are DONE or in-flight (below).
- Story 6.1 (REL-1, the physical two-machine two-vendor demonstration) **cannot be simulated** —
  that is the cop-out the story exists to prevent. It is the operator's personal execution, using
  the Operator Flight Kit built for exactly that purpose.
- The epic is NOT "accepted-with-open-items": per Grumbal's ruling, that status is release debt
  that invites shipping before the demonstration. The epic is **in progress, blocked on (a) the
  8-hour wall clock and (b) the human's 20–30 minute demo.**

## Phase ledger

| Phase | Status | Evidence |
|---|---|---|
| 6.3 — RC frozen & validated | **done, RE-CUT** (`2c9cfe7`) | `docs/release-evidence/v0.2.0-candidate.json` (commit `89c8477`, version `0.2.0`, tree digests `fa2ede8a…`/`466874d1…`, runtime versions, gate results); SM-C1 verdict PASS (0.551 s mean, 0.318 s adjusted vs v0.1's 0.352 s anchor) |
| 6.2 — REL-3 formal soak | **ATTEMPT 3 RUNNING** on the quiet host ngs-staging (launched 2026-10-21T07:14:51Z, server pid 924048) | Attempt 1 PASSED against `7dc980f` (commit `3aec7ed`: 481.5 min, candidate-exact, zero loss over 22625 messages, FD stable, final-window RSS pass) and remains that artifact's record. Attempt 2 against the re-cut candidate `89c8477` FAILED the final-window RSS rule (`growthRatio` 1.7003 vs 0.02) after 481.5 min with zero loss and stable FDs — kept as its own attempt in `docs/release-evidence/v0.2.0-soak-attempts/attempt2-89c8477.{json,md}`, never relabelled. Attempt 3 runs the UNCHANGED harness against the UNCHANGED candidate on a separate, quiet host (ngs-staging, 4 CPU, load ~1.0, external host-telemetry sidecar) because attempt 2's host was contended — the advisor review had warned against exactly that |
| 6.2 (superseded) — the first soak | **PASS, superseded** (commit `3aec7ed`) | 8h tracked (481.5 min), candidate-exact (`7dc980f`), zero loss (22625 acked==readable, 0 dup/lost), FD stable, final-window RSS pass, 47 bursts, 7 reconnect cycles, 481 samples. Evidence: `docs/release-evidence/v0.2.0-soak-results.{json,md}` — valid for `7dc980f` only |
| 6.1 prep — Operator Flight Kit | **done** (`33c7ec1`) | `scripts/rel1-preflight.mjs`, `docs/rel1-runbook.md`, `scripts/rel1-verify-evidence.mjs` (all hand-verified against real fixtures) |
| 6.1 — the physical demonstration | **awaiting the human** | runbook §0–§6; evidence bundle into `docs/release-evidence/v0.2.0-rel1/`, verified by `scripts/rel1-verify-evidence.mjs` |

## What remains, exactly (updated 2026-10-20)

1. **Wait for soak attempt 3** (launched 2026-10-21T07:14:51Z against candidate `89c8477` on the quiet host ngs-staging; tracked window ends ~15:15Z, then the final drain). Attempt 1's PASS belongs to `7dc980f`; attempt 2 is a recorded FAIL kept under its own name.
2. **Run the REL-1 demo** per `docs/rel1-runbook.md` on two physical machines (Claude Code + Zcode) against the re-cut candidate, capture the evidence bundle into `docs/release-evidence/v0.2.0-rel1/`, run `scripts/rel1-verify-evidence.mjs`. This is the operator's personal execution; cannot be simulated.
3. **Close Epic 6**: audit + retro; publish release notes citing the cursor reset, the SM-C1 baseline, and the REL-1 evidence; tag v0.2.0.

**A cross-machine demonstration already happened** (`docs/release-evidence/v0.2.0-cross-machine/`): the Room Server in Docker on ngs-2 (Ubuntu, TLS over the public internet), a Claude Code client on the Mac, and a Codex client on ngs-staging (driven by that host's own 9Router) — enrolled over the wire, DMs in both directions with the untrusted envelope intact, the trust matrix HOLDING a cross-machine message and releasing it after an allowlist entry, broadcasts both ways, and the authenticated viewer observed live in a real browser. That run is what FOUND the viewer bug (the shipped viewer read the boot descriptor at the wrong level of the API envelope and could never connect) — fixed in `cc7eb6e` with a regression test that runs the shipped script.

**Soak evidence:** `docs/release-evidence/v0.2.0-soak-results.{json,md}` — the 481.5 min PASS against `7dc980f` (22625 acked==readable, 0 dup/lost, FD stable, final-window RSS pass, 47 bursts, 7 reconnect cycles, 481 samples, candidate-exact). Attempt 2 against `89c8477` FAILED the final-window RSS rule and is kept under its own name in `docs/release-evidence/v0.2.0-soak-attempts/` with the two advisor round-tables (`epic-6-soak-rss-astra.md`, `epic-6-soak-rss-agy.md`) and the mint-cost diagnostic (`rss-diagnostic-mint-probe.md`) beside it. Attempt 3 runs on the quiet host ngs-staging and replaces the release evidence only if it passes.

Both advisor verdicts are archived at `docs/implementation/reviews/epic-6-execution-{luna,agy}.md`.
