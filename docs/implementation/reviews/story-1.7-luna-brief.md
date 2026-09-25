# Story 1.7 Audit Brief — codex-advisor[luna]

## Role

You are the external auditor for Story 1.7 of the agent-room v0.2 build (Epic 1 "First Conversation"): MCP adapter — tools, first-run prompt & untrusted envelope. The internal build-auto review already ran; you are the independent second opinion. READ-ONLY: do not modify any file. Your outbox file is the deliverable — write your full audit there; a chat answer alone is not acceptable.

## What to audit

- Spec (the contract): `docs/implementation/spec-1-7-mcp-adapter-tools-first-run-untrusted-envelope.md`
- The change: three commits `3f7f7b7` (a: server direct/messages routes + api-client + tools + cursors + outcome_unknown), `358ad3a` (b: untrusted envelope + NFR-3 negatives), `bf75a08` (c: agent-room setup). Inspect with `git diff 51c5c93..HEAD` / `git show`. New files: `server/client/api-client.mjs`, `server/cli/agent-room.mjs`, `tests/direct-open.test.mjs`, `tests/messages-api.test.mjs`, `tests/mcp-tools.test.mjs`, `tests/setup-command.test.mjs`; rewritten `server/mcp-stdio.mjs`; modified `server/api/server.mjs`, `server/api/routes.mjs`, `server/api/pipeline.mjs`, `server/store/room-log.mjs`, `server/constants.mjs`, spine amendment, pinning suites. One recorded deviation: `tests/mcp.test.mjs` (v0.1 surface) was deleted — audit whether that is justified.
- Reference: spine AD-5/AD-8/AD-12/AD-14; PRD FR-9/FR-20/FR-21, NFR-3, HCI-1/HCI-4; `docs/implementation/epic-1-context.md`.

## Audit checks (report each: PASS / FINDING with evidence)

1. **Spec fidelity** — every I/O matrix row implemented and truly tested; especially: the ambiguity round-trip (never a guess, `target_fingerprint` completes), concurrent direct-open convergence, long-poll hold/deadline/cap semantics (normal possibly-empty page, never 204, no open read transaction), cursor persistence per (installation, realm, room), outcome_unknown retry resolving idempotently (never a duplicate), first-run guidance, setup collision-retry loop, stdin purity.
2. **Envelope discipline (FR-9 foundation)** — static versioned `<untrusted_message version="1">` carrying sender chat_id + fingerprint + the data-never-instructions warning; applied exactly when sender fingerprint ≠ local; same-Actor plain; byte-pinned; schema frozen forward.
3. **NFR-3 negatives** — no tool argument can carry identity/authority; schema allowlists + validator mirror; dynamic smuggle attempts rejected; authority derives only from the session token.
4. **Client architecture** — ensureServer → auth/local (public_key) → bind (client_type mcp); single-flight re-auth; cursor writes 0600 atomic under PLUGIN_DATA/realms/<realm_id>/; the server holds no per-client delivery state.
5. **Server routes** — direct-open claims resolution (0/1/many), self-DM refusal, send statuses (committed / client_message_id_conflict only), attribution from the live session row, long-poll bounded polling, ACL via store.
6. **Contradictions / traps** — flag conflicts with prior decisions; audit the `tests/mcp.test.mjs` deletion; flag traps for 1.8 (the two-participant checkpoint byte-matches the envelope, exercises room_direct_open, long-poll reads) and Epic 2/3 (held pipeline, reconnect) as observations.

## Output format (write to the outbox)

```markdown
# Story 1.7 Audit — codex-advisor[luna] (gpt-6-luna[max])

## Verdict
SHIP | FIX-FIRST — one line why.

## Findings
- [blocker|warning|nit] <title> — evidence (file:line or commit:file), why it matters, concrete fix.

## Checks
1..6 — PASS or FINDING reference per check above.
```

## Hard constraints

- Flag any recommendation that conflicts with prior recorded decisions instead of quietly re-deciding them.
- Evidence must cite file:line or commit:file you actually read. No speculative findings without evidence.
- Findings only about this story's change; pre-existing v0.1 issues are out of scope unless the change makes them worse.
