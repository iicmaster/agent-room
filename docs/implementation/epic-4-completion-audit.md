# Epic 4 Completion Audit — The Wider Room

Date: 2026-09-29 · Commit range `5c3157a` (post-Epic-3) → `cd8c1e8` · Suite: **530 pass / 0 fail / 0 skipped** · AC sweep: **clean** (8 stories, 24 criteria, 112 evidence pointers)

## Verdict

**Epic 4 is complete.** Remote Mode is safe by default and fully governed: challenge-response
enrollment with invite gating, HTTPS-only transport with real certificate verification, four
independently-tested rate gates, operator ban with persistence, storage admission control, and the
whole chain composed in a randomized dress rehearsal over real TLS — Epic 4's blocking exit gate.

## Story ledger

| Story | Commit(s) | Proof |
|---|---|---|
| 4.1 challenge auth | `74c0f19`+`fc3d473` + review pass | `tests/challenge-auth.test.mjs` (24) — nonce bounds, single-use, canonical signature, enrollment ordering, registry injection proven live |
| 4.2 invites + CLI host | `5b383f7` | `tests/invites.test.mjs` (16) — token shape, digest-only persistence, two-process race, lost-response retry, rate limit, forwarded-address spoofing |
| 4.3 remote client | `5f7ce3f` | `tests/remote-client.test.mjs` (8) — https-only, self-signed refused, enrolled reconnect needs no invite, CLI family |
| 4.4 rate gates | `0693c40` | `tests/rate-gates.test.mjs` (17) — four gates isolated + ordering (idempotency first), p95 3–4 ms vs the 150 ms bound |
| 4.5 ban | `658744f` | `tests/ban.test.mjs` (13) — persistence across restart (B1 closed), long-poll termination, re-enroll refused after proof |
| 4.6 storage gates | `8dfd2d2`+`6b82d3c` | `tests/storage-gates.test.mjs` — refuse/warn thresholds, refused send never acknowledged, reads continue, capacity command |
| 4.7 deploy guide | `562ea81`+`0eb3e94` | `tests/self-hosting-deployment.test.mjs` (17) — native TLS + proxy topologies, TLS material matrix, remote enroll family |
| 4.8 dress rehearsal (gate) | `cd8c1e8` | `tests/drills/remote-dress-rehearsal.test.mjs` — the full governance chain over real HTTPS, zero local-token requests, churn zero-leak |

## What review found

1. **Signature canonical form** (internal-1-1): interspersed invalid base64url characters decoded
   to the exact canonical bytes and were accepted — fixed with an 86-char pattern gate (nonce still
   burned; no grinding).
2. **Declared-remote clients could still present the local token** via ensureServer's half-stale
   reuse proof (luna-1 + internal-1-2, same root, HIGH): fixed — declared-remote attach presents
   no local-token request on any path.
3. **The challengeRegistry injection seam was dead code** (mutation-verified): now proven live.
4. **The keypair-replacement wedge**: a replaced identity.key wedged the client in an infinite 401
   loop — now recovers or surfaces the honest coded identity change.
5. **22+ further findings** across both review passes: literal restatements, TTY-gate ordering,
   refused-exchange enrollment ordering, spawned-child coverage honesty. All applied.

## Process record

- The story-build workflow returned for 4.1: phases 1–6 ran unattended (implement + 4 reviews
  produced 14 findings); the provider failed at luna twice, and the orchestrator's mid-run commits
  tripped the baseline guard once — after which 4.1 was hand-finished with the recorded findings.
- Stories 4.2–4.5 were built by hand subagents (provider instability); 4.6 by a subagent cancelled
  mid-flight whose on-disk work was completed by hand with a re-run review (29 findings, folded);
  4.7 by a subagent whose in-flight fix-loop was completed by hand (2 real production bugs fixed);
  4.8 by a subagent cancelled just before completion — its drill was on disk, green, and needed
  only the spec + evidence trail.
- The workflow's guards and idempotent phases (proven across these runs) carry forward: unique
  actor names per story, stale-queue skipping, the upkeep allowlist, the advisory post-check,
  idempotent luna audits, and escalation addenda.

## Known limits at Epic 4 close

- **Physical cross-machine wire** is Epic 6's REL-1 (4.8's rehearsal is one machine, real TLS).
- **The declared-remote seam** (`AGENT_ROOM_CONNECTION_MODE=remote`) remains an environment
  declaration until challenge auth replaces the presentation question — 4.1's challenge lane now
  exists, so Epic 4's own stories already exercise it.
- **CLI session lifetime** at SESSIONS_MAX under automation-paced invocation — deferred (3.4).
