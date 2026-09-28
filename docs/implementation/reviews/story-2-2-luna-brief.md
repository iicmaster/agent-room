# Story 2-2 Audit Brief — codex-advisor[luna]

## Role

Independent auditor for Story 2-2 of the agent-room v0.2 build (Epic 2: reconnection backoff +
room discovery). READ-ONLY: do not modify any file. **Your outbox file is the deliverable** —
write the full audit to `/Users/ngs/agent-skills/plugins/agent-room/.mailbox-out/story-2-2-audit-luna`;
a chat answer alone is not acceptable.

**Independence rule:** your Verdict is your own judgment and must NOT be reconciled into other
voices' opinions. Do not read, seek, or incorporate any other reviewer's or lane's opinions —
other files under `docs/implementation/reviews/` and other outboxes are out of scope. Decide from
the change, the contract, and the code alone.

## The contract

The contract under audit is `docs/implementation/spec-2-2-reconnection-room-discovery.md`. Read its
`<intent-contract>` in full — Intent, Boundaries & Constraints (Always / Block If / Never), and the
I/O & Edge-Case Matrix — plus its Code Map. The matrix rows are the acceptance surface.

## What changed

The change under review is every file differing from baseline
`26f2a2cfcdc47b39ecc2b0da95bcb948d0225975`:

- `docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md` — the dated,
  strictly-additive spine amendments (rooms-list route vocabulary entry; the two new numeric
  knobs mirrored into AD-9's limit list).
- `docs/implementation/ac-evidence.yaml` — the seeded 2.2 entry filled in with real test names
  and the does-not-prove note.
- `server/api/routes.mjs` — the `GET /api/rooms` enumeration route registration.
- `server/api/server.mjs` — wiring for the rooms list.
- `server/client/api-client.mjs` — the reconnect backoff loop and the client-side rooms listing.
- `server/client/ensure-server.mjs` — export of the existing `probeHealth` (and nothing else).
- `server/constants.mjs` — the two new knobs (`RECONNECT_BACKOFF_JITTER`,
  `RECONNECT_RECOVERY_PROBE_MS`), declared once.
- `server/store/room-log.mjs` — the store-layer membership enumeration
  (Broadcast Room without consulting `direct_members`; Direct Rooms via the caller's own
  `direct_members` rows; deterministic `created_at` ASC, then `id` ASC ordering; projection to
  `{room_id, kind}` only).
- `tests/api-contract.test.mjs` — the spine-derived route/vocabulary contract assertions.
- `tests/api-host.test.mjs` — host-level assertions touching the new route.
- `tests/constants.test.mjs` — the static no-restated-literal scan over the new knobs.
- `tests/local-auth.test.mjs` — local-auth assertions touching the changed surface.
- `tests/session-routes.test.mjs` — session-route assertions touching the changed surface.
- `docs/implementation/spec-2-2-reconnection-room-discovery.md` — the contract itself.
- `tests/reconnection.test.mjs` — the entire behavioral proof: real spawned server children, real
  keypairs, real 0600 local-token files, real `createAgentRoomClient` instances, zero component
  mocks; the injected seams (`reconnectSleep`, `reconnectRandom`, `reconnectProbe`) pace time
  only.

Factual note from `git diff --name-only 26f2a2cfcdc47b39ecc2b0da95bcb948d0225975 HEAD` (run while
preparing this brief): two more files also differ from baseline —
`docs/implementation/workflows/.escalation-addendum-2-2.json` and
`docs/implementation/workflows/agent-room-story-build.ts` (the lane tooling that dispatches this
audit). They are outside the enumerated review set above; flag them only if they materially
contradict the story. `server/mcp-stdio.mjs` must NOT differ — verify that claim yourself; if it
does, that is a Block If, and a high finding.

## Audit checks (report each PASS / FINDING with file:line evidence)

1. **Intent-contract, clause by clause** — walk every clause of the spec's `<intent-contract>`:
   each Intent claim; every Always (Broadcast Room listed for every Actor without consulting
   `direct_members`; Direct Rooms only through the caller's own `direct_members` rows;
   deterministic `created_at` ASC then `id` ASC ordering; wire projection exactly
   `{rooms: [{room_id, kind}]}` with `pair_key`, `title`, `created_by_fingerprint`,
   `created_at` never leaving the store layer; identity only from the session token via
   `sessionPrincipalOf`; `requestFields: []` so any query key is an `unknown_field` rejection;
   additive-only dated spine amendments; the two knobs declared once in `server/constants.mjs`
   and imported by name; backoff trigger exactly
   `outcomeUnknown === true && transportCode === 'ECONNREFUSED'` with the FIRST attempt immediate;
   probe cadence via `probeHealth` treating only `agentRoom === true` as detected recovery;
   schedule-bounded loop (1, 2, 4, 8, 16, 32, 60 s) with the last real error surfaced after the
   capped attempt; the caller's abort signal threaded through the loop; optional seams defaulting
   to real behavior); every Block If trigger and every Never; and each I/O & Edge-Case Matrix row.
   For each: is it implemented as written, and is the covering assertion genuinely present (not
   paraphrased away)? Name any clause or row with no real covering assertion.
2. **Store/API invariants the story depends on** — verify the claimed code homes carry the
   properties this story builds on: the store-layer enumeration reads the SQLite `rooms` /
   `direct_members` truth with the Broadcast Room's AD-14 implicit membership (an Actor with zero
   `direct_members` rows still gets the Broadcast Room, and never a Direct Room it does not belong
   to); deterministic ordering holds at the SQL level, not just in one happy-path row order; the
   wire projection is applied before anything leaves the store/route layer; identity comes from
   the session token and the route's field gate rejects unknown query keys; the two knobs exist
   exactly once in `server/constants.mjs` and no server, client, or test code restates a numeric
   literal for them (the `tests/constants.test.mjs` scan is what enforces AD-9 — check it covers
   the new constants); the backoff rides the existing transport-unreachable branch without
   widening it; `probeHealth` in `server/client/ensure-server.mjs` is the pre-existing behavior
   merely exported (no staleness-rule, lock, or boot-order change) and the recovery probe is
   read-only — it never writes, reclaims, or boots; `ensureServer` still boots on the attempt
   itself. A property the tests assert but whose code home does not hold is a finding.
3. **The tests' ability to fail** — could `tests/reconnection.test.mjs` pass vacuously? Are the
   servers real spawned children with real keypairs, real 0600 token files, and real
   `createAgentRoomClient` instances (zero mocks of the server, the store, or the HTTP path; the
   injected seams pace time, they do not fake any component)? Are expected values literal oracles
   built in the test file (never computed from a production helper, so a producer regression
   cannot make both sides drift together)? Does the suite actually exercise the escalation
   schedule (1→60 s through the seven waits) via the injected seams rather than wall-clock luck,
   and does it assert the FIRST attempt is immediate? Is a recovery detected only on
   `agentRoom === true` (would a probe returning `{reachable: true, agentRoom: false}` be
   accepted)? Is the loop bounded, and would an unbounded or widened-trigger regression fail the
   tests? Is the abort-signal rule covered? Is the ACL edge covered (no Direct Room leak to a
   non-member; Broadcast Room present for a member-less Actor)? Are vocabulary/ordering
   projections asserted exactly, or could a softened comparison pass? Is there any skip / `.only`
   / todo / host-conditional escape hatch? Would the suite actually fail if a knob literal were
   restated, a non-member room leaked into the enumeration, the ordering drifted, the projection
   grew a field, or the first recovery attempt were delayed?

## Output format (write to the outbox)

```markdown
# Story 2-2 Audit — codex-advisor[luna] (gpt-6-luna[max])

# Verdict
SHIP | FIX-FIRST

# Findings
- [high|medium|low] <short claim>
  Evidence: <file:line, or the command and its output>
  Why: <why it matters>

# Checks
1..3 — PASS or FINDING reference, with per-clause/per-row notes for check 1

TEAM_DONE story-2-2-audit-luna
```

## Hard constraints

- Evidence must cite file:line you actually read, or a command you actually ran with its output.
- READ-ONLY: do not modify, create, or delete any repository file, and do not run anything that
  mutates the repo. (Running the new test file itself is allowed if you judge it necessary — it
  uses `mkdtemp` outside the repository — but say so and report the exact command and outcome.)
- Findings only about this story's change; pre-existing behavior is in scope only where this
  change relies on it.
