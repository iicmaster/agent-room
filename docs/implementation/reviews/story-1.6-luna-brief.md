# Story 1.6 Audit Brief — codex-advisor[luna]

## Role

You are the external auditor for Story 1.6 of the agent-room v0.2 build (Epic 1 "First Conversation"): Presence — online & offline-recently. The internal build-auto review already ran; you are the independent second opinion. READ-ONLY: do not modify any file. Your outbox file is the deliverable — write your full audit there; a chat answer alone is not acceptable.

## What to audit

- Spec (the contract): `docs/implementation/spec-1-6-presence-online-offline-recently.md`
- The change: `tests/presence.test.mjs` (new); `server/core/session-registry.mjs`, `server/api/server.mjs`, `server/api/routes.mjs`, `server/store/room-log.mjs`, `server/constants.mjs`, spine AD-8 amendments, `tests/api-contract.test.mjs`, `tests/constants.test.mjs`, `tests/session-routes.test.mjs`, `tests/local-auth.test.mjs`, `tests/api-host.test.mjs`, `tests/chat-id-claims.test.mjs` (modified). See `git diff HEAD` + `git status --short --untracked-files=all`.
- Reference: spine AD-6/AD-8/AD-14; PRD FR-5 in `docs/prds/prd-agent-room-2026-09-20/prd.md`; `docs/implementation/epic-1-context.md`.

## Audit checks (report each: PASS / FINDING with evidence)

1. **Spec fidelity** — every I/O matrix row implemented and truly tested (online row shape, liveness refresh on any authenticated request, TTL expiry/lease, include_offline + 24 h boundaries, no double-listing, restart survival, viewer isolation, unreachable ≠ everyone-offline, 401 zero-state, query allowlist, client_type closed set).
2. **One-liveness-mechanism discipline** — auth-slide and presence touch are one event; no server-side heartbeat timer; viewer/daemon activity can never refresh presence; every authenticated request performs a durable claim write (BEGIN IMMEDIATE) — audit the write-amplification and failure-surface consequences (a store failure on touch → 500) and say whether that trade is right for 1.6.
3. **Presence read model** — online = live rows within 180 s (read-time lease sweep frees names); offline_recently = claims within 24 h EXCLUDING online Actors and the reader's own Actor, deduped most-recent per Actor; inclusive/exclusive window boundaries; deterministic tie-breaks.
4. **Identity/vocabulary discipline** — client_type optional-at-bind (absent → null) — audit whether that reading is safe for Stories 1.7/1.8 or should be required; response fields within the frozen vocabulary; spine amendments dated and parsed by the live contract test; no restated numbers.
5. **Durability & performance** — recentClaims bounded query; prune interaction (touched claims survive 7-day window); no unbounded growth; transactional writes; injectable clocks everywhere.
6. **Contradictions / traps** — flag conflicts with prior decisions (FR-5 semantics, D13, AD-6/AD-8); flag traps for 1.7 (adapter heartbeat cadence 60 s ±10%, re-bind after TTL eviction, room_presence tool shape) and 1.8 (two-participant checkpoint) as observations.

## Output format (write to the outbox)

```markdown
# Story 1.6 Audit — codex-advisor[luna] (gpt-6-luna[max])

## Verdict
SHIP | FIX-FIRST — one line why.

## Findings
- [blocker|warning|nit] <title> — evidence (file:line), why it matters, concrete fix.

## Checks
1..6 — PASS or FINDING reference per check above.
```

## Hard constraints

- Flag any recommendation that conflicts with prior recorded decisions instead of quietly re-deciding them.
- Evidence must cite file:line you actually read. No speculative findings without evidence.
- Findings only about this story's change; pre-existing v0.1 issues are out of scope unless the change makes them worse.
