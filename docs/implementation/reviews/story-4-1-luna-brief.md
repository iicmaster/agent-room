# Story 4-1 Audit Brief — codex-advisor[luna]

## Role

Independent auditor for Story 4-1 of the agent-room build (Remote Challenge Authentication:
`/api/auth/challenge` single-use nonce + `/api/auth/answer` signature-for-token, the durable
`enrolled_actors` gate, and the client's declared-remote auth-path switch). READ-ONLY: do not
modify any file — do not modify, create, or delete anything in the repository. **Your outbox
file is the deliverable** — write the full audit to
`/Users/ngs/agent-skills/plugins/agent-room/.mailbox-out/story-4-1-audit-luna`; a chat answer
alone is not acceptable.

**Independence rule:** your Verdict is your own judgment and must NOT be reconciled into other
voices' opinions. Do not read, seek, or incorporate any other reviewer's or lane's opinions —
other files under `docs/implementation/reviews/` and other outboxes are out of scope. Decide
from the change, the contract, and the code alone.

## The contract

The contract under audit is
`docs/implementation/spec-4-1-remote-challenge-authentication.md`. Read its
`<intent-contract>` in full — Intent (Problem + Approach), Always, Block If (8 halt
triggers), Never, and the I/O & Edge-Case Matrix (14 rows) — plus its Code Map, Design Notes,
and the dated Record. The matrix rows are the acceptance surface.

## What changed

The change under review is every file differing from baseline
`c47141d04c5daafdcd45fad0a9e649f6acb28d7a`:

- `CHANGELOG.md` — Added entries for the challenge/answer routes, the enrollment seeding, and
  the declared-remote switch.
- `docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md` — additive,
  dated amendments: AD-8 responses gains `nonce` (the amendment prose must contain NO backticks
  except `nonce` itself — every backticked token in the responses segment is extracted as a
  response field name, `tests/api-contract.test.mjs:77-88`); AD-5's TTL assumption and Open
  Question 1 gain the dated 12 h ratification line.
- `docs/implementation/ac-evidence.yaml` — the Epic 4 header and the 4.1 entry, 14 evidence
  pointers.
- `server/api/routes.mjs` — `implemented: true` on the frozen challenge/answer rows; `nonce`
  joins the response vocabulary. No route or field added, renamed, or re-classed.
- `server/api/server.mjs` — the two handlers; the `challengeRegistry` default-plus-override
  option; the local handler now seeds the enrollment record on its success path only (zero
  wire change to the local exchange).
- `server/client/api-client.mjs` — the auth-path switch: a declared-remote installation runs
  challenge-answer and never falls back to the local token file; the local lane stays
  byte-for-byte; `transport: 'remote'` earned only after a successful exchange.
- `server/constants.mjs` — `CHALLENGE_NONCE_BYTES`, `CHALLENGE_NONCE_TTL_MS`,
  `CHALLENGE_NONCES_MAX`, `CHALLENGE_SIGNATURE_MAX_CHARS` plus three new PUBLIC_ERRORS
  (`challenge_invalid` 401, `signature_invalid` 401, `not_enrolled` 403), each registered once.
- `server/keys.mjs` — `signWithInstallationKey` (the private PEM never leaves the module) and
  `verifyWithRawPublicKey`; no return value, log, wire body, or tool result carries key
  material.
- `server/store/room-log.mjs` — `enrolledActorsTableDdl`, `ensureEnrolledActorsTable` with
  column verification via the additive open-path convergence (IF NOT EXISTS + STRICT
  verification list, NO `user_version` bump), `enrollActor` (first `enrolled_at` sticks) and
  `isActorEnrolled`.
- `tests/api-contract.test.mjs` — the implemented pin and the three new codes.
- `tests/api-host.test.mjs` — the 404 loop narrowed to pin only `enroll`; the additive-table
  pin.
- `tests/constants.test.mjs` — the exact `PUBLIC_ERRORS` key-list pin (declared mechanical
  pin).
- `tests/integration/trust-chain.test.mjs` — the 3.5 drill's declared-remote receiver now
  pre-enrolls through the shipped local exchange before its child runs; matrix outcomes
  unchanged, still zero-mock (declared mechanical pin).
- `docs/implementation/spec-4-1-remote-challenge-authentication.md` — the contract itself.
- `server/api/challenge.mjs` — new: `createChallengeRegistry`, the in-memory bounded nonce
  store (consume-before-verify, evict-oldest at `CHALLENGE_NONCES_MAX`, injectable clock).
- `tests/challenge-auth.test.mjs` — new: the entire behavioral proof, all 14 matrix rows,
  real spawned server children and the real api-client, zero wire mocks.

Factual note from `git diff --name-only c47141d04c5daafdcd45fad0a9e649f6acb28d7a HEAD` (run
while preparing this brief, at HEAD `3b919e4`): one more file also differs from baseline —
`docs/implementation/workflows/agent-room-story-build.ts` (+14/−3; the lane tooling that
dispatches this audit). It is outside the enumerated review set above; flag it only if it
materially contradicts the story. `server/mcp-stdio.mjs`, `web/*`, and `docs/epics.md` must
NOT differ — verify that claim yourself; if any does, that is a Block If/Never breach and a
high finding.

## Audit checks (report each PASS / FINDING with file:line evidence)

1. **Intent-contract, clause by clause** — walk every clause of the spec's `<intent-contract>`:
   each Intent claim (identity binds at challenge time — the frozen field sets admit no key
   smuggling; the substrate claims: routes frozen unregistered at `server/api/routes.mjs:71-72`,
   the shared session registry with its provisional 12 h TTL, `loadOrCreateKeypair` returning
   no private key, the 3.5 `AGENT_ROOM_CONNECTION_MODE=remote` seam); every Always (one
   mechanism — challenge tokens issue through the SAME `createSessionRegistry` instance, so
   sliding TTL/capacity/revocation/verification are identical to local; consume the nonce
   BEFORE verifying the signature so a failed answer burns it; challenge open to any
   well-formed 32-byte key, answer gated on the durable `enrolled_actors` row; the table added
   additively with NO `user_version` bump; enrollment seeded only from the local exchange's
   success path; nonces stay in memory — restart kills outstanding challenges but not
   enrollment; new bounds imported by name and the three codes registered once each; the
   private key file-scoped inside `keys.mjs`; the declared-remote branch never falls back to
   the local token file; `transport: 'remote'` recorded only after a successful exchange; the
   AD-8 amendment prose carries no backticks except `nonce`; every rejection is zero-state;
   tests against real spawned server children with an injectable clock); every Block If
   trigger (replay yields a token; a signature verified against any key other than the
   challenge-recorded one; answer succeeds unenrolled; a private-key byte anywhere on a wire,
   stderr, or tool result; the local lane's wire shape changes; a rejected request writes
   enrollment/claims/session; the challenge token's TTL/entropy/registry diverges from local;
   a limit literal or error status outside the constants module; the declared-remote branch
   touches the token file); and each of the 14 I/O & Edge-Case Matrix rows (fresh nonce shape
   and ≥16 bytes; enrolled answer commits a session that authenticates actor routes; replay →
   401 `challenge_invalid` with zero state; cross-key answer → 401 `signature_invalid`; the 60 s
   expiry bound; consume-before-verify — wrong-then-correct signature both refuse; unenrolled:
   challenge 200, answer 403 `not_enrolled`; durable enrollment survives restart while nonces
   die; bounded registry evicts oldest; the end-to-end declared-remote client with earned
   `transport === 'remote'`, no token-file request, and DM exchange with a local-lane
   installation; the private key never travels — counted scans; FR-3 plugin-data deletion
   yields a fresh unrelated Actor with only the Broadcast Room; NFR-3 mirrored at the wire —
   `unknown_field` on identity fields, including `public_key` smuggled into the answer; DR-2
   ratified — sliding TTL, capacity, revoke identical for a challenge-issued token). For each:
   is it implemented as written, and is the covering assertion genuinely present (not
   paraphrased away)? Name any clause or row with no real covering assertion.
2. **Store/API invariants the story depends on** — verify the claimed code homes carry the
   properties this story builds on: `server/api/routes.mjs` still freezes `challenge` to
   exactly `public_key` and `answer` to exactly `nonce`+`signature`, with `enroll` still
   unregistered (404); `server/api/session.mjs`'s registry is the same instance both issuance
   paths use — 12 h sliding TTL, `SESSIONS_MAX`, `revoke` unchanged, `SESSION_TTL_SECONDS`
   untouched; `server/store/room-log.mjs`'s additive convergence holds (IF NOT EXISTS + column
   verification against the STRICT list, no `user_version` bump) and `enrollActor` is
   idempotent with the first `enrolled_at` sticking, while a rejected local exchange writes
   nothing; `server/api/server.mjs` seeds enrollment only on the local exchange's success
   path and the answer handler never reads a `public_key`; `server/constants.mjs` is the
   single home of the four `CHALLENGE_*` bounds, the three codes, and their statuses — no
   numeric literal or error message restated outside it (AD-9); `server/keys.mjs` keeps
   `loadOrCreateKeypair`'s no-private-key return and the new helpers' signatures never leak
   PEM or key bytes; `server/client/api-client.mjs`'s switch is keyed on the declared
   connection mode with no fallback path, and the local lane's exchange is byte-identical;
   nonces, sessions, and challenge state never touch SQLite (the ephemeral/durable split of
   AD-6). A property the tests assert but whose code home does not hold is a finding.
3. **The tests' ability to fail** — could `tests/challenge-auth.test.mjs` pass vacuously? Are
   the servers real spawned children with real state, and the client the real
   `createAgentRoomClient` — zero wire mocks? Are expected values literal oracles built in the
   test file (never computed from a production module, so a producer regression cannot make
   both sides drift together)? Is replay actually asserted (the exact captured request
   re-sent, a second token must not appear, state counts unchanged)? Is cross-key binding
   asserted with a genuinely correct signature from the WRONG key (a wrong-signature check
   would pass vacuously)? Is consume-before-verify asserted in the right order (wrong
   signature burns the nonce; the follow-up correct signature gets `challenge_invalid`, not a
   token)? Is the 60 s expiry asserted through the injectable clock at the bound, with the
   constant imported by name? Is the unenrolled gate asserted at answer while challenge stays
   open? Is restart-durability asserted (enrollment survives, nonces do not)? Is the eviction
   at `CHALLENGE_NONCES_MAX` asserted on the oldest nonce? Is the end-to-end declared-remote
   client asserted to never send the local token request (a fallback regression must fail) and
   to earn `transport === 'remote'` only post-exchange? Is the no-key-material invariant a
   counted scan over bodies, stderr, and captured traffic (an accidental PEM leak must fail)?
   Does the FR-3 row prove the fresh Actor sees only the Broadcast Room? Is the `unknown_field`
   scan asserted on all three live routes including `public_key` in the answer body? Is the
   DR-2 row asserting sliding-TTL/capacity/revoke identity against a challenge-issued token?
   Do the narrowed pins (`tests/api-host.test.mjs` 404 loop on `enroll` only, the
   `PUBLIC_ERRORS` key list, the trust-chain drill's pre-enrollment) keep the Never-list
   honest? Is there any skip / `.only` / todo / host-conditional escape hatch? Would the suite
   actually fail if enrollment were written on a rejected local exchange, nonces were
   persisted, the answer read a `public_key`, or the TTL were restated outside the constants
   module?

## Output format (write to the outbox)

```markdown
# Story 4-1 Audit — codex-advisor[luna] (gpt-6-luna[max])

# Verdict
SHIP | FIX-FIRST

# Findings
- [high|medium|low] <short claim>
  Evidence: <file:line, or the command and its output>
  Why: <why it matters>

# Checks
1..3 — PASS or FINDING reference, with per-clause/per-row notes for check 1

TEAM_DONE story-4-1-audit-luna
```

## Hard constraints

- Evidence must cite file:line you actually read, or a command you actually ran with its
  output.
- READ-ONLY: do not modify, create, or delete any repository file, and do not run anything
  that mutates the repo. (Running the new test file itself is allowed if you judge it
  necessary — it uses `mkdtemp` outside the repository — but say so and report the exact
  command and outcome.)
- Findings only about this story's change; pre-existing behavior is in scope only where this
  change relies on it.
