# Epic 6 State Record — In Progress (awaiting wall-clock + human)

Date: 2026-10-20 (soak PASS landed) · Suite: **550 pass / 0 fail / 0 skipped** · Commit: `3aec7ed` (soak pass) on top of `ea83e93`

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
| 6.2 — REL-3 formal soak | **PASS** (commit `3aec7ed`, run 2026-10-19→20) | 8h tracked (481.5 min), candidate-exact (`7dc980f`), zero loss (22625 acked==readable, 0 dup/lost), FD stable (worst drift ≤ corridor), final-window RSS pass, 47 bursts, 7 reconnect cycles, 481 samples. Evidence: `docs/release-evidence/v0.2.0-soak-results.{json,md}` |
| 6.1 prep — Operator Flight Kit | **done** (`33c7ec1`) | `scripts/rel1-preflight.mjs`, `docs/rel1-runbook.md`, `scripts/rel1-verify-evidence.mjs` (all hand-verified against real fixtures) |
| 6.1 — the physical demonstration | **awaiting the human** | runbook §0–§6; evidence bundle into `docs/release-evidence/v0.2.0-rel1/`, verified by `scripts/rel1-verify-evidence.mjs` |

## What remains, exactly (updated 2026-10-20)

1. ~~Wait for the soak~~ — **DONE** (PASS, commit `3aec7ed`).
2. **Run the REL-1 demo** per `docs/rel1-runbook.md` on two physical machines (Claude Code + Zcode), capture the evidence bundle into `docs/release-evidence/v0.2.0-rel1/`, run `scripts/rel1-verify-evidence.mjs`. This is the operator's personal execution; cannot be simulated.
3. **Close Epic 6**: audit + retro; publish release notes citing the cursor reset, the SM-C1 baseline, and the REL-1 evidence; tag v0.2.0.

**Soak evidence (PASS):** `docs/release-evidence/v0.2.0-soak-results.{json,md}` — 481.5 min tracked, 22625 acked==readable (0 dup/lost), FD stable, final-window RSS pass, 47 bursts, 7 reconnect cycles, 481 samples, candidate-exact identity, 0 failure reasons.

Both advisor verdicts are archived at `docs/implementation/reviews/epic-6-execution-{luna,agy}.md`.
