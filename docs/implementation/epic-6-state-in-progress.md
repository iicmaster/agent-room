# Epic 6 State Record — In Progress (awaiting wall-clock + human)

Date: 2026-10-20 (Story 6.4 landed — the reconnect-recovery takeover; the candidate is VOID and must be re-cut) · Suite: **565 tests** · Commit: `8838fb2` (the quiet-host telemetry) on top of `2c9cfe7` (the candidate re-freeze)

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
| 6.2 — REL-3 formal soak | **NO QUALIFYING RUN — candidate void** | Attempt 1 PASSED against `7dc980f` (commit `3aec7ed`: 481.5 min, candidate-exact, zero loss over 22625 messages, FD stable, final-window RSS pass) and remains that artifact's record. Attempt 2 against the re-cut candidate `89c8477` FAILED the final-window RSS rule (`growthRatio` 1.7003 vs 0.02) after 481.5 min with zero loss and stable FDs — kept as its own attempt in `docs/release-evidence/v0.2.0-soak-attempts/attempt2-89c8477.{json,md}`, never relabelled. Attempt 3 ran 191 tracked minutes on the quiet host ngs-staging (external telemetry sidecar) and was STOPPED at 2026-10-21T10:41Z: its RSS trace is FLAT (90–117 MiB, no sawtooth), which is the direct evidence that attempt 2's failure was host contention — but Story 6.4 changed the packaged server bytes, so `89c8477` is void and attempt 3 qualifies nothing. A FRESH 8-hour soak against the FINAL candidate is required |
| 6.2 (superseded) — the first soak | **PASS, superseded** (commit `3aec7ed`) | 8h tracked (481.5 min), candidate-exact (`7dc980f`), zero loss (22625 acked==readable, 0 dup/lost), FD stable, final-window RSS pass, 47 bursts, 7 reconnect cycles, 481 samples. Evidence: `docs/release-evidence/v0.2.0-soak-results.{json,md}` — valid for `7dc980f` only |
| 6.1 prep — Operator Flight Kit | **done** (`33c7ec1`) | `scripts/rel1-preflight.mjs`, `docs/rel1-runbook.md`, `scripts/rel1-verify-evidence.mjs` (all hand-verified against real fixtures) |
| 6.1 — the physical demonstration | **awaiting the human** | runbook §0–§6; evidence bundle into `docs/release-evidence/v0.2.0-rel1/`, verified by `scripts/rel1-verify-evidence.mjs` |

## What remains, exactly (updated 2026-10-20)

1. **Re-cut the candidate** from the fixed tree (Story 6.4 changed `server/`, `server/cli/`, `server/client/`, `server/constants.mjs` — all packaged inputs). Re-materialize both packages, re-run all five Story 6.3 gates, and re-freeze the digests in `docs/release-evidence/v0.2.0-candidate.json`. The candidate `89c8477` is VOID.
2. **Run a FRESH, uninterrupted 8-hour REL-3** against the final candidate, on the quiet host (ngs-staging, now released: the void attempt 3 was stopped at 2026-10-21T10:41Z). No heavy work on either host while it runs — attempt 2 failed because its host was contended.
3. **Run the REL-1 demo** per `docs/rel1-runbook.md` on two physical machines (Claude Code + Zcode) against the FINAL candidate, capture the evidence bundle into `docs/release-evidence/v0.2.0-rel1/`, run `scripts/rel1-verify-evidence.mjs`, and measure the ≤5 s viewer freshness number that is still unmeasured. This is the operator's personal execution; cannot be simulated.
4. **Close Epic 6**: audit + retro; publish release notes citing the cursor reset, the SM-C1 baseline, the Story 6.4 repair, and the REL-1 evidence; tag v0.2.0.

**A cross-machine demonstration already happened** (`docs/release-evidence/v0.2.0-cross-machine/`): the Room Server in Docker on ngs-2 (Ubuntu, TLS over the public internet), a Claude Code client on the Mac, and a Codex client on ngs-staging (driven by that host's own 9Router) — enrolled over the wire, DMs in both directions with the untrusted envelope intact, the trust matrix HOLDING a cross-machine message and releasing it after an allowlist entry, broadcasts both ways, and the authenticated viewer observed live in a real browser. That run is what FOUND the viewer bug (the shipped viewer read the boot descriptor at the wrong level of the API envelope and could never connect) — fixed in `cc7eb6e` with a regression test that runs the shipped script.

**Soak evidence:** `docs/release-evidence/v0.2.0-soak-results.{json,md}` — the 481.5 min PASS against `7dc980f` (22625 acked==readable, 0 dup/lost, FD stable, final-window RSS pass, 47 bursts, 7 reconnect cycles, 481 samples, candidate-exact). Attempt 2 against `89c8477` FAILED the final-window RSS rule and is kept under its own name in `docs/release-evidence/v0.2.0-soak-attempts/` with the two advisor round-tables (`epic-6-soak-rss-astra.md`, `epic-6-soak-rss-agy.md`) and the mint-cost diagnostic (`rss-diagnostic-mint-probe.md`) beside it. Attempt 3 (quiet host, 191 min) was STOPPED as void and is kept with its partial state and its host telemetry beside them — its flat RSS trace is the evidence that attempt 2 failed on contention, not on a defect.

**The Story 6.4 repair (2026-10-20):** the physical REL-1 run uncovered a real continuity defect — a client whose process was killed left its live row holding the Chat ID, and the ordinary re-bind was refused with `chat_id_taken` because the server cannot tell a dead process from a quiet one. FR-12 puts reconnection in MVP scope, so the repair belongs to v0.2.0. The advisor round-table (`docs/implementation/reviews/epic-6-lease-astra.md`) chose the smallest complete option: an EXPLICIT, operator-authorized same-Actor takeover with an atomic transfer and a fence (the displaced session's authority ends with the handoff). It landed as `POST /api/session`'s additive `replace_existing` intent, the live registry's `transfer`, the session registry's `supersede`/`isSuperseded` fence, the pipeline's authorization-stage re-check, the MCP adapter's orderly-exit release, and the operator command `agent-room session replace`. Eleven acceptance rows live in `tests/session-replacement.test.mjs`; the spec is `docs/implementation/spec-6-4-reconnect-recovery-takeover.md`. The shipped bytes changed, so the candidate is void and the sequence is: re-cut → 6.3 gates → fresh 8 h soak → candidate-bound REL-1 → closeout.

Both advisor verdicts are archived at `docs/implementation/reviews/epic-6-execution-{luna,agy}.md`.
