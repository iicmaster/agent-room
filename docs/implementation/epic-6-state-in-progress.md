# Epic 6 State Record — In Progress (awaiting wall-clock + human)

Date: 2026-09-29 (updated as phases complete) · Suite: **550 pass / 0 fail / 0 skipped** · Commit: `33c7ec1`

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
| 6.3 — RC frozen & validated | **done** (`48bbf0d`) | `docs/release-evidence/v0.2.0-candidate.json` (commit `7dc980f`, tree digests, runtime versions, gate results); SM-C1 verdict PASS (0.459 s mean, 0.264 s adjusted vs v0.1's 0.352 s) |
| 6.2 — REL-3 formal soak | **in flight** (PID 57220, results land Oct 7 ~11:25 +07) | `tests/soak/rel3-soak.mjs` (the runner, git-runtime-identity-pinned to the RC), live checkpoints in `docs/release-evidence/v0.2.0-soak-results.{json,md}` |
| 6.1 prep — Operator Flight Kit | **done** (`33c7ec1`) | `scripts/rel1-preflight.mjs`, `docs/rel1-runbook.md`, `scripts/rel1-verify-evidence.mjs` (all hand-verified against real fixtures) |
| 6.1 — the physical demonstration | **awaiting the human** | runbook §0–§6; evidence bundle into `docs/release-evidence/v0.2.0-rel1/`, verified by `scripts/rel1-verify-evidence.mjs` |

## What remains, exactly

1. **Wait for the soak** (completes Oct 7 ~11:25 +07): read `docs/release-evidence/v0.2.0-soak-results.json` — all rules must pass (zero loss, FDs ±5 of hour-one, final-half RSS growth ≤2% of window start). If it fails: fix, cut a NEW candidate (re-run 6.3's gates), re-soak — the candidate-immutability law.
2. **Run the REL-1 demo** per `docs/rel1-runbook.md` on two physical machines (Claude Code + Zcode), capture the evidence bundle, run the verifier.
3. **Close Epic 6**: audit + retro; publish release notes citing the cursor reset, the SM-C1 baseline, and the REL-1 evidence; tag v0.2.0.

Both advisor verdicts are archived at `docs/implementation/reviews/epic-6-execution-{luna,agy}.md`.
