# Story 1.5 Audit Brief — codex-advisor[luna]

## Role

You are the external auditor for Story 1.5 of the agent-room v0.2 build (Epic 1 "First Conversation"): Chat ID connect, rename & durable claims. The internal build-auto review already ran; you are the independent second opinion. READ-ONLY: do not modify any file. Your outbox file is the deliverable — write your full audit there; a chat answer alone is not acceptable.

## What to audit

- Spec (the contract): `docs/implementation/spec-1-5-chat-id-connect-rename-durable-claims.md`
- The change: `server/core/session-registry.mjs`, `tests/chat-id-claims.test.mjs`, `tests/session-routes.test.mjs` (new); `server/store/room-log.mjs`, `server/api/server.mjs`, `server/api/routes.mjs`, `server/api/session.mjs`, `server/constants.mjs`, `tests/constants.test.mjs`, `tests/api-contract.test.mjs`, `tests/api-host.test.mjs` (modified). See `git diff HEAD` + `git status --short --untracked-files=all`.
- Reference: spine AD-6 (durable claims + pair keys), AD-8 (frozen vocabulary), AD-14 (implicit broadcast); `docs/implementation/epic-1-context.md`; DR-1 in `docs/epics.md`.

## Audit checks (report each: PASS / FINDING with evidence)

1. **Spec fidelity** — every I/O matrix row implemented and truly tested; especially: live collision refusal (no suffixing, case-insensitive), rename immediacy (old name freed instantly, connected_since preserved), disconnect frees the name but the claim row persists, restart durability, multiple Actors per name (ambiguity data), prune (injectable clock, boundary), zero state change on rejections.
2. **DR-1 grammar** — 1–32 chars `[A-Za-z0-9_.-]`, case-insensitive uniqueness; normalized (lowercase) keys uniqueness/claims, display form preserved; pattern derived from constants (no restated numbers).
3. **Concurrency & atomicity** — claim/rename check→persist→commit sequences cannot interleave badly (single-process atomicity argument); concurrent claims of the same name cannot both win; store ops transactional; the upsert's non-monotonic last_seen note — is any caller able to regress a claim?
4. **Identity discipline** — chat_id never accepted without a valid session; actor identity from the token only; chat_id_taken/invalid_chat_id codes from constants; response bodies within the frozen vocabulary.
5. **Store additivity** — chat_id_claims table additive (IF NOT EXISTS convergence), STRICT verified, v0.1 untouched; prune bounded; no unbounded growth paths.
6. **Contradictions / traps** — flag anything conflicting with prior decisions (D13 session-level Chat IDs, FR-19 rename semantics, AD-6 claims model); flag traps for Stories 1.6–1.8 (heartbeat touch contract, ambiguous_chat_id consumption, the 1.8 checkpoint's two-participant flow) as observations.

## Output format (write to the outbox)

```markdown
# Story 1.5 Audit — codex-advisor[luna] (gpt-6-luna[max])

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
