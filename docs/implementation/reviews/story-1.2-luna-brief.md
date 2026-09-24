# Story 1.2 Audit Brief — codex-advisor[luna]

## Role

You are the external auditor for Story 1.2 of the agent-room v0.2 build (Epic 1 "First Conversation"). The internal build-auto review already ran; you are the independent second opinion. READ-ONLY: do not modify any file. Your outbox file is the deliverable — write your full audit there; a chat answer alone is not acceptable.

## What to audit

- Spec (the contract): `docs/implementation/spec-1-2-store-schema-v2-rooms-the-durable-log.md`
- The change (all of it is new code): `server/store/room-log.mjs` and `tests/store.test.mjs`
- Reference for existing conventions: `server/constants.mjs`, `server/database.mjs` (v0.1 store — must remain untouched; verify with `git status` / `git diff HEAD` that only the new files + spec are untracked additions)

## Audit checks (report each: PASS / FINDING with evidence)

1. **Spec fidelity** — every intent-contract clause, boundary, and I/O matrix row is actually implemented and actually tested. Name any row whose "covering test" does not truly verify the expected behavior.
2. **Schema v2 correctness** — room-local contiguous sequences from 1 under single-writer `BEGIN IMMEDIATE`; idempotency tuple (actor fingerprint, room, client_message_id) checked before insert with matching-resend-returns-original and conflict-throws; reply targets resolve room-locally at `(room_id, seq)`.
3. **DM privacy** — third-actor denial at the store boundary for both post and read; canonical pair key `direct:<fp_min>:<fp_max>` lexicographic, idempotent in either argument order, same fingerprint twice allowed.
4. **Durability guarantees** — STRICT/WAL/FULL/fk/autocheckpoint asserted by test; append-only messages (no UPDATE/DELETE path, asserted); crash-before-commit leaves nothing acknowledged (verify the SIGKILL test really proves the AC).
5. **Constants discipline** — zero numeric limits restated in the new module; all error names from constants.mjs; no new numbers invented.
6. **Contradictions with prior decisions** — flag anything that conflicts with the spine (hexagonal core, single writer per realm, AD-4 room-local seq, AD-6/AD-8/AD-9/AD-14) or with the v0.2 product decisions (DM-first, send-time chat_id attribution never rewritten, broadcast membership implicit). Prior decisions live in `docs/implementation/epic-1-context.md` and `docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md`.

## Output format (write to the outbox)

```markdown
# Story 1.2 Audit — codex-advisor[luna] (gpt-5.6-luna[max])

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
- Findings only about this story's change (the two new files); pre-existing v0.1 issues are out of scope unless the change makes them worse.
