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
| 6.2 — REL-3 formal soak | **RE-RUNNING** against the re-cut candidate (launched 2026-10-20T19:52Z, PID 41495) | The 8h soak that PASSED against `7dc980f` (commit `3aec7ed`: 481.5 min, candidate-exact, zero loss over 22625 messages, FD stable, final-window RSS pass) remains that artifact's record — the viewer fix and the version stamp changed packaged inputs, so it does not qualify the re-cut candidate. The new run: candidate-exact `89c8477`, 8h tracked, world under `.soak-world/` (outside `/tmp`), evidence in `.soak-world/evidence/` |
| 6.2 (superseded) — the first soak | **PASS, superseded** (commit `3aec7ed`) | 8h tracked (481.5 min), candidate-exact (`7dc980f`), zero loss (22625 acked==readable, 0 dup/lost), FD stable, final-window RSS pass, 47 bursts, 7 reconnect cycles, 481 samples. Evidence: `docs/release-evidence/v0.2.0-soak-results.{json,md}` — valid for `7dc980f` only |
| 6.1 prep — Operator Flight Kit | **done** (`33c7ec1`) | `scripts/rel1-preflight.mjs`, `docs/rel1-runbook.md`, `scripts/rel1-verify-evidence.mjs` (all hand-verified against real fixtures) |
| 6.1 — the physical demonstration | **awaiting the human** | runbook §0–§6; evidence bundle into `docs/release-evidence/v0.2.0-rel1/`, verified by `scripts/rel1-verify-evidence.mjs` |

## What remains, exactly (updated 2026-10-20)

1. **Wait for the re-run soak** (launched 2026-10-20T19:52Z against candidate `89c8477`; ~8h tracked, then the final drain). The first soak's PASS belongs to `7dc980f`.
2. **Run the REL-1 demo** per `docs/rel1-runbook.md` on two physical machines (Claude Code + Zcode) against the re-cut candidate, capture the evidence bundle into `docs/release-evidence/v0.2.0-rel1/`, run `scripts/rel1-verify-evidence.mjs`. This is the operator's personal execution; cannot be simulated.
3. **Close Epic 6**: audit + retro; publish release notes citing the cursor reset, the SM-C1 baseline, and the REL-1 evidence; tag v0.2.0.

**A cross-machine demonstration already happened** (`docs/release-evidence/v0.2.0-cross-machine/`): the Room Server in Docker on ngs-2 (Ubuntu, TLS over the public internet), a Claude Code client on the Mac, and a Codex client on ngs-staging (driven by that host's own 9Router) — enrolled over the wire, DMs in both directions with the untrusted envelope intact, the trust matrix HOLDING a cross-machine message and releasing it after an allowlist entry, broadcasts both ways, and the authenticated viewer observed live in a real browser. That run is what FOUND the viewer bug (the shipped viewer read the boot descriptor at the wrong level of the API envelope and could never connect) — fixed in `cc7eb6e` with a regression test that runs the shipped script.

**Soak evidence:** `docs/release-evidence/v0.2.0-soak-results.{json,md}` — the 481.5 min PASS against `7dc980f` (22625 acked==readable, 0 dup/lost, FD stable, final-window RSS pass, 47 bursts, 7 reconnect cycles, 481 samples, candidate-exact). The re-run against `89c8477` writes to `.soak-world/evidence/` and replaces these files when it finishes.

Both advisor verdicts are archived at `docs/implementation/reviews/epic-6-execution-{luna,agy}.md`.
