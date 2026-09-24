# Story 1.3 Audit Brief — codex-advisor[luna]

## Role

You are the external auditor for Story 1.3 of the agent-room v0.2 build (Epic 1 "First Conversation"): HTTP API host, middleware classes, health & realm bootstrap. The internal build-auto review already ran; you are the independent second opinion. READ-ONLY: do not modify any file. Your outbox file is the deliverable — write your full audit there; a chat answer alone is not acceptable.

## What to audit

- Spec (the contract): `docs/implementation/spec-1-3-http-api-host-middleware-classes-health-realm-bootstrap.md`
- The change: `server/api/routes.mjs`, `server/api/pipeline.mjs`, `server/api/server.mjs`, `server/core/realm.mjs` (new); `server/store/room-log.mjs`, `server/constants.mjs`, `tests/constants.test.mjs` (modified); `tests/api-host.test.mjs`, `tests/api-contract.test.mjs`, `tests/core-boundary.test.mjs` (new). See `git diff HEAD` + `git status --short --untracked-files=all`.
- Reference: spine AD-7/AD-8/AD-9/AD-10/AD-14 in `docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md`; `docs/implementation/epic-1-context.md`.

## Audit checks (report each: PASS / FINDING with evidence)

1. **Spec fidelity** — every intent-contract clause, boundary, and I/O matrix row is implemented and tested; name any row whose covering test does not truly verify the behavior (especially: pipeline ORDER with reorder-fails proof, rejection invariants with zero state change, protocol header enforcement + echo scope, unknown-field rejection, first-boot realm + implicit Broadcast Room + restart idempotence, core boundary).
2. **Wire contract discipline** — route table and field vocabulary match spine AD-8 verbatim; envelope `{ok, result|error:{code,message}}`; every HTTP status from the constants table, never per-route; unknown request fields rejected, not ignored; no implicit downgrade.
3. **Middleware architecture** — four route classes with the fixed stage order; viewer/health skip protocol; handlers contain no gate logic; injectable auth verifier rejects until Story 1.4; budgets/authz structural pass-throughs; no policy duplication between classes.
4. **Hexagonal boundary** — `server/core/` imports no node:http / MCP / CLI; store changes strictly additive (v0.1 `roomd.mjs`/`database.mjs` untouched); realm bootstrap pure orchestration over the store API.
5. **Server lifecycle** — runtime gate; loopback-only bind; runtime.json `{pid, port, version}` 0600 written after listen, removed on owned close; direct-launch failures exit 1 with one stderr line; no leak paths on startup failure.
6. **Contradictions with prior decisions** — flag anything conflicting with the spine or v0.2 decisions (Local Mode = configuration not code path; AD-13 no operator routes; broadcast membership implicit; additive-only wire policy; realm_id keys plugin-local state). Also flag places where this story's choices will trap Stories 1.4–1.8 (e.g., verifier slot design, route registration ergonomics) — but as observations, not scope expansion.

## Output format (write to the outbox)

```markdown
# Story 1.3 Audit — codex-advisor[luna] (gpt-6-luna[max])

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
