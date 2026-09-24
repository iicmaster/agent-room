# Story 1.4 Audit Brief — codex-advisor[luna]

## Role

You are the external auditor for Story 1.4 of the agent-room v0.2 build (Epic 1 "First Conversation"): Local bootstrap & local session auth. The internal build-auto review already ran; you are the independent second opinion. READ-ONLY: do not modify any file. Your outbox file is the deliverable — write your full audit there; a chat answer alone is not acceptable.

## What to audit

- Spec (the contract): `docs/implementation/spec-1-4-local-bootstrap-local-session-auth.md`
- The change: `server/client/ensure-server.mjs`, `server/api/session.mjs`, `server/api/local-token.mjs` (new); `server/api/server.mjs`, `server/api/routes.mjs`, `server/constants.mjs`, `server/runtime.mjs`, `tests/constants.test.mjs`, `tests/api-host.test.mjs` (modified); `tests/ensure-server.test.mjs`, `tests/local-auth.test.mjs` (new). See `git diff HEAD` + `git status --short --untracked-files=all`.
- Reference: spine AD-5/AD-7/AD-10 in `docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md`; `docs/implementation/epic-1-context.md`.

## Known open question to give your opinion on (do not treat as decided)

The implementation keys local sessions by a digest of the local token itself — every local client shares one session identity. The frozen request vocabulary contains `public_key`; the v0.2 design (D13: distinct sessions are distinct participants; FR-3: identity from per-installation keypairs; AD-10: auto-enrollment under the OS-user boundary) suggests `POST /api/auth/local` should bind the session to the caller's declared public key (fingerprint = sha256 over the raw 32 bytes) instead. Audit this: is hash-of-token defensible for 1.4, or is public_key binding required before Stories 1.5–1.8 can be built correctly? Recommend concretely.

## Audit checks (report each: PASS / FINDING with evidence)

1. **Spec fidelity** — every intent-contract clause, boundary, and I/O matrix row implemented and tested; especially the race (exactly one winner, loser attaches), staleness rules (dead-pid AND unreachable-health for BOTH lock and runtime.json; foreign responder never killed), token-file discipline (0600, non-symlink, bounded, never a per-request credential elsewhere), AR-1 (no unix socket anywhere), FR-1 negative (no URL/token/room-id input).
2. **Credential mechanics** — Bearer-only on /api/auth/local; constant-time compares; 12 h sliding TTL; session tokens never logged; verifier binds to the actor class only (viewer slot separate); no credential crosses classes; rejections change no state.
3. **Process lifecycle** — detached spawn of the same server binary; minimal env; readiness poll; lock release on all paths; no orphaned processes or leaked listeners on failure paths; stale-state reclamation safe under races.
4. **Boundaries** — v0.1 files untouched (`roomd.mjs`, `database.mjs`, v0.1 behavior tests); ensure-server mirrors (not imports) daemon-client; constants additive only; route registration via the frozen table.
5. **Threat model** — Local Mode trusts the OS-user boundary: what can a local non-OS-user process do? What can a compromised local client do with a session token? Are secrets (local token, session tokens) ever on the wire in URLs/logs/stderr?
6. **Contradictions / traps** — flag conflicts with prior decisions; flag choices that will trap Stories 1.5–1.8 (identity binding above; presence writes; cursor persistence; untrusted envelope) as observations with concrete recommendations.

## Output format (write to the outbox)

```markdown
# Story 1.4 Audit — codex-advisor[luna] (gpt-6-luna[max])

## Verdict
SHIP | FIX-FIRST — one line why.

## Findings
- [blocker|warning|nit] <title> — evidence (file:line), why it matters, concrete fix.

## Open-question opinion
<the public_key binding question above — recommend concretely>

## Checks
1..6 — PASS or FINDING reference per check above.
```

## Hard constraints

- Flag any recommendation that conflicts with prior recorded decisions instead of quietly re-deciding them.
- Evidence must cite file:line you actually read. No speculative findings without evidence.
- Findings only about this story's change; pre-existing v0.1 issues are out of scope unless the change makes them worse.
