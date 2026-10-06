---
title: 'Remote churn & the dress rehearsal *(blocking gate — ruling Q3)*'
type: 'test'
created: '2026-09-29'
status: 'done'
baseline_revision: '0eb3e94'
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/docs/implementation/epic-1-context.md'
  - '{project-root}/docs/implementation/spec-4-2-invite-gated-enrollment-operator-cli-host.md'
  - '{project-root}/docs/implementation/spec-4-7-self-hosting-deployment-guide.md'
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** Remote Mode's governance chain (invite → challenge enrollment → rate-gated traffic →
operator ban) and its transport policy (HTTPS, real certificate verification) existed only as
per-mechanism tests — nothing proved the pieces compose, and Epic 4 cannot exit on clean-restart
evidence alone.

**Approach:** one blocking drill (`tests/drills/remote-dress-rehearsal.test.mjs`) over real TLS
with two identity sandboxes (distinct keypairs) exercising the full governance flow — mint →
enroll A (challenge-response) → second-use invite refused → enroll B → A/B exchange DMs and
broadcast through the rate gates → operator bans B → B's sends and long-polls refused `banned` —
plus multi-client connection churn under remote HTTPS with zero leaks (the Story 2.4 harness).

## Boundaries & Constraints

**Always:** `/api/auth/local` is FORBIDDEN in this drill (counted wire scan proves zero
local-token requests); real HTTPS with a test CA (the Story 4.7 driver harness); seeded where
randomized; the operator side (mint/revoke/ban) runs in-process or via the CLI host, the REMOTE
clients use only the wire.

**Block If:** the TLS front cannot serve the challenge lane (halt with evidence).

**Never:** no mocks for the server or clients; no physical cross-machine wire (Epic 6's REL-1).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| governance chain | mint → enroll A → second-use invite → enroll B | second use refused coded; B enrolled on the second invite | coded refusals |
| rate gates | A/B exchange DMs + broadcast paced 2/s; one burst >10 sends | traffic flows; the burst asserts rate_limited + retry_after_ms, then backs off and succeeds | coded 429 |
| operator ban | ban B by fingerprint via the CLI host | B's sends and long-polls refused `banned` at next request; the in-flight long-poll terminates within the window | coded 403 |
| churn | multi-client connect/auth/bind/disconnect cycles over TLS | FD within ±5 of baseline; zero leaked sockets/handles | numeric oracle |
| forbidden surface | counted wire scan | zero `/api/auth/local` requests | drill fails otherwise |

</intent-contract>

## Code Map

- `tests/drills/remote-dress-rehearsal.test.mjs` -- the drill (one test, the whole chain).
- `tests/drills/remote-dress-rehearsal-driver.mjs` -- the TLS front + journey-child harness (reuses the Story 4.7 test-CA pattern).

## Tasks & Acceptance

**Execution:**
- The drill + driver (implemented in the interrupted run, completed and stabilized by hand).

**Acceptance Criteria:**
- The chain executes as the matrix specifies; the drill is Epic 4's blocking exit gate.

## Spec Change Log

### 2026-09-29 — implementation completed by hand after an interrupted dispatch
The implementing subagent was cancelled mid-flight (session interruption) with the drill test +
driver on disk but unverified and the spec unwritten. The hand pass verified the drill green 3×,
ran the full suite, and wrote this spec. Known-bad state avoided: an unwritten spec trail for the
epic's blocking gate.

## Review Triage Log

### 2026-09-29 — hand completion (no separate review pass: the drill reuses the harness and mechanics reviewed in Stories 4.7, 2.5, and 4.5; the operator mandate was codex+agy advisors on blocking DECISIONS, and no such decision arose — the chain exercised existing reviewed mechanisms)
- intent_gap: 0
- bad_spec: 0
- patch: 0
- defer: 0
- reject: 0

## Auto Run Result

Status: done

**Summary:** Epic 4's blocking exit gate is closed: two identity sandboxes ran the full governance
flow over real HTTPS (challenge-response enrollment, zero local-token requests — counted), the
rate gates carried paced DM/broadcast traffic with one explicit burst probe (rate_limited +
retry_after_ms, then success), the operator banned B mid-flight (B's long-poll terminated within
the window with `banned`), and multi-client churn held the FD corridor with zero leaks under the
Story 2.4 tracker.

**Verification performed:** drill green 3× consecutively (~31 s each, within budget); full suite
530/530, 0 skipped; the forbidden-surface scan (zero /api/auth/local requests) passed on every
run.

**Residual risks:** physical cross-machine wire behaviour is Epic 6's REL-1 (this drill is one
machine, real TLS); multi-hour soak is Story 6.3's REL-3.
