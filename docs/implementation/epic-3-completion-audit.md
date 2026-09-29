# Epic 3 Completion Audit — Safe to Talk to Strangers

Date: 2026-09-29 · Commit range `5c3157a` (post-Epic-2) → `fe2913b` · Suite: **394 pass / 0 fail / 0 skipped** · AC sweep: **clean** (5 stories, 13 criteria, 40 evidence pointers)

## Verdict

**Epic 3 is complete.** FR-9's two-lane trust split is now executable end to end: a stranger's
message is held with zero body bytes in every agent-visible result, the human CLI releases or
removes trust, and the full chain composes in one zero-mock integration test.

## Story ledger

| Story | Commit(s) | Proof |
|---|---|---|
| 3.1 untrusted marking at full rigor | `f5a2458` | 13-row all-foreign batch: wrapped=13, unwrapped=0 by count; two-lane honesty pinned (negative scan for overclaim phrases); additive-only vs the 1.7 byte fixture |
| 3.2 per-realm Allowlist & trust matrix | `aba60c5` | `server/client/trust.mjs` — every matrix cell with lane labels; D13 (reused chat id / swapped key held); accept-all default false; removal re-holds |
| 3.3 held pipeline | `42c89c9` | `tests/held.test.mjs` (9) — metadata-only structural whitelist, eviction past 100 with point-read recovery, cursor independence at the file layer |
| 3.4 human CLI (HCI-2) | `c62b8c6` | `tests/cli-surface.test.mjs` (17) — held list/show (the only body surface), allow resolution + release, --remove from the stored allowlist, coded refusals, Instructed-lane help text |
| 3.5 end-to-end trust chain | `fe2913b` | `tests/integration/trust-chain.test.mjs` — the one zero-mock chain: hold → cursor → eviction+recovery → release → remove → monotonic cursors |

## What review found

1. **`allow --remove` was unusable against an offline sender** (medium, internal-1-1): the
   zero-candidates refusal fired before --remove could act, leaving a standing grant with no human
   revocation path after 24 h offline. Fixed: removal resolves from the stored allowlist.
2. **The trust matrix's remote lane was unreachable end to end** — Stories 3.2–3.4 could prove
   holds only at the composed layer, because Local Mode auto-delivers. Fixed with a strictly
   fail-closed seam (`AGENT_ROOM_CONNECTION_MODE=remote`): it can only withhold, never grant;
   'local' is earned only by the token exchange. Epic 4's challenge-authenticated client inherits
   this input naturally.
3. **luna verdict FIX-FIRST on 3.4** — plus 20 internal findings (usage/declined refusals bypassing
   the coded format, delimiter injection in held-show output, parseTokens flag handling, TTY-gate
   ordering). All patched; the CLI's honesty surface is now grep-guarded.

## Process record

- **The story-build workflow returned to service on Story 3.4** (per the operator's direction and
  Epic 1 item 1's unattended-proof plan): it planned, implemented, and reviewed the story, and its
  guards held correctly through two scope events and a coordinator/outbox race — each producing a
  durable workflow fix (upkeep-set allowlist, idempotent luna audit phase, race documentation).
  The triage phase died twice on provider errors, so the final triage + patch pass was hand-run
  from the recorded findings. **Unattended-proof status: phases 1–6 unattended; phases 8–10
  (triage/patch/finalize) hand-finished due to provider instability — the proof marker was not
  written; the requirement carries forward.**
- Story 3.5 was hand-looped as well (provider stability), with the same discipline.

## Known limits at Epic 3 close

- **A v0.2 local connection cannot produce a held row by construction** (Local Mode delivers
  same-OS-user senders) — holds are proven at the composed layer plus the 3.5 chain over the
  declared-remote seam. Epic 4's real remote traffic is the first production exercise of the lane.
- **Allowlist removal vs already-ingested text**: removal re-holds future deliveries and never
  withdraws the past — the AC's stated behavior, now tested.
- **CLI session lifetime** at SESSIONS_MAX under automation-paced invocation is recorded as a
  deferred low (Story 3.4 triage).
