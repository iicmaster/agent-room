# Epic 2 Completion Audit — Nothing Is Lost

Date: 2026-09-28 · Commit range `26f2a2c` (post-Epic-1) → `c6cb589` · Suite: **354 pass / 0 fail / 0 skipped** · AC sweep: **clean** (5 stories, 12 criteria, 27 evidence pointers)

## Verdict

**Epic 2 is complete.** The epic's own exit gate — the REL-2 randomized kill-drill — passed with
53,751 acknowledged messages across 3 randomized SIGKILL/restore cycles: acked-set == readable-set,
zero duplicates, per-room contiguity, cursors exactly at head. No clean-restart-only acceptance:
the drill kills the live server under continuous traffic.

## Story ledger

| Story | Commit(s) | Proof |
|---|---|---|
| 2.1 restart survival | `b568fde`+`26f2a2c`+`6f0fcb1`-lineage hardening + final pass | `tests/integration/restart-survival.test.mjs` — SIGKILL adjacent to the final ack, durable snapshot from the crashed file, byte-exact UTF-8, third-Actor denial |
| 2.2 reconnection & discovery | `2861207`+`d3de550` | `tests/reconnection.test.mjs` (19) — bounded schedule, foreign-responder refusal, abort threading, runtime.json re-resolve; 22 review findings patched, mutation-verified |
| 2.3 migration v1→v2 | `c13cedb` | `tests/migration.test.mjs` (14) — real SIGKILL mid-migration on 180k rows, three-run no-op oracle, absorb-or-stop, realm preserved |
| 2.4 endurance harness | `4734318` | `tests/harness/leak-tracker.mjs` + `tests/churn.test.mjs` — 100-cycle FD oracle (±5, worst drift 0), memory slope ≤2%/s after steady state |
| 2.5 REL-2 drill (gate) | `ffe5104`+`c6cb589` | `tests/drills/rel2-kill-drill.test.mjs` — 64k/53k acked==readable runs, external recorder, seeded randomness, idle leak check |

## What review found (and what it means)

1. **The drill found a real production bug** — multi-call recovery across a kill double-bound the
   Chat ID on the fresh server, wedging the client on `chat_id_taken` ~15 s per restart
   (~1,500 failed sends in the drill). Fixed via attach-epoch coalescing + single-flight
   `authenticateOnce()`. This is exactly what the drill exists for: the bug was invisible to every
   per-mechanism test.
2. **Story 2.1's kill adjacency was unproven as first shipped** — the SIGKILL landed after reads
   and snapshots, so an ack-before-commit regression would have hidden. Restructured: kill
   adjacent to the final ack, durable snapshot from the crashed file.
3. **Story 2.2's reconnect loop had three unproven guarantees** (foreign-responder refusal, abort
   threading, single-schedule per send) — all mutation-verified as uncovered, then covered; 14
   mutations, zero survivors.
4. **The story-build workflow was parked after six failed runs on Story 2.2** — every failure was
   either a script bug of the orchestrator's or a mid-run repo edit (both recorded in the Epic 1
   retro's F8). Stories 2.2–2.5 were hand-finished with the same review discipline. The workflow's
   guards now accept escalation addenda and story-surface commits, but it has still not closed a
   story unattended — it stays parked for gate stories.

## Known limits at Epic 2 close

- **v0.1 rooms all migrate as broadcast** — v0.1 actor ids are `agent:<uuid>` strings, not
  fingerprints, so DM continuity across the migration is honestly not promised (documented in the
  2.3 spec).
- **Derived fingerprints for migrated actors** are deterministic but are NOT the keys a v0.2 client
  presents — `chat_id_claims` is deliberately unseeded for them.
- **The drill proves short-horizon endurance** (minutes, thousands of messages); multi-hour soak is
  Story 6.3's REL-3.
- **The memory 2% rule is asserted on the settled idle window**, not under load — under load the
  slope measures allocation rate (5–8%/s measured), recorded as data.
