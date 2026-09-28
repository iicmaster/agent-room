# Story 2-1 Audit Brief — codex-advisor[luna]

## Role

Independent auditor for Story 2-1 of the agent-room v0.2 build (Epic 2's first story: ordinary
restart survival). READ-ONLY: do not modify any file. **Your outbox file is the deliverable** —
write the full audit to `/Users/ngs/agent-skills/plugins/agent-room/.mailbox-out/story-2-1-audit-luna`;
a chat answer alone is not acceptable.

**Independence rule:** your Verdict is your own judgment and must NOT be reconciled into other
voices' opinions. Do not read, seek, or incorporate any other reviewer's or lane's opinions —
other files under `docs/implementation/reviews/` and other outboxes are out of scope. Decide from
the change, the contract, and the code alone.

## The contract

The contract under audit is `docs/implementation/spec-2-1-ordinary-restart-survival.md`. Read its
`<intent-contract>` in full — Intent, Boundaries & Constraints (Always / Block If / Never), and the
I/O & Edge-Case Matrix — plus its Code Map. The matrix rows are the acceptance surface.

## What changed

The change under review is every file differing from baseline
`80cd417109e619649492d2ce686711092a78543b`:

- `docs/implementation/ac-evidence.yaml` — the seeded 2.1 entry filled in (the story's one
  documentation task).
- `docs/implementation/spec-2-1-ordinary-restart-survival.md` — the contract itself (new file).
- `tests/integration/restart-survival.test.mjs` — the entire proof: one new zero-mock integration
  test that spawns a real server, drives acknowledged traffic through three real MCP children,
  SIGKILLs the server, restarts on the same data dir, and proves the survival matrix.

Factual note from `git diff --name-status 80cd417109e619649492d2ce686711092a78543b HEAD`: one more
file also differs from baseline — `docs/implementation/workflows/agent-room-story-build.ts` (the
lane tooling that dispatches this audit). It is outside the enumerated review set above; flag it
only if it materially contradicts the story. No production module (`server/**`) may differ —
verify that claim yourself; if any does, that is a high finding.

## Audit checks (report each PASS / FINDING with file:line evidence)

1. **Intent-contract, clause by clause** — walk every clause of the spec's `<intent-contract>`:
   each Intent claim, each Always, each Block If trigger, each Never, and each I/O matrix row.
   For each: is it implemented in the test file as written, and is the covering assertion
   genuinely present (not paraphrased away)? Name any clause or row with no real covering assertion.
2. **Store/API invariants the story depends on** — the story asserts "no production change is
   needed; every property already has a code home." Verify the claimed code homes carry the
   properties: ack returned only after `COMMIT` (`server/store/room-log.mjs` transaction
   discipline), room-local `MAX(seq)+1` inside `BEGIN IMMEDIATE`, WAL + `synchronous=FULL`
   re-asserted on the restarted connection, the reply-link FK, `runtime.json` staleness/readiness
   semantics in `ensureServer`, durable `chat_id_claims`, cursor files, and the 0700/0600
   permission posture. A property the test asserts but whose code home does not hold is a finding.
3. **The tests' ability to fail** — could this test pass vacuously? Is the kill a real `SIGKILL`
   against the real server child (not SIGTERM, not `server.close()`)? Are expected values literal
   oracles built in the test file (never computed from a production helper, so a producer
   regression cannot make both sides drift together)? Is readiness polled until `runtime.json`
   names the NEW pid (never accepted from S1's stale record)? Are byte-equality, seq contiguity,
   cursor strictly-forward, and no-re-delivery asserted exactly, or could a softened comparison
   pass? Is there any skip / `.only` / todo / host-conditional escape hatch? Would the test
   actually fail if the substrate lost an acknowledged message, reused or gapped a seq, dropped a
   reply link, minted a second realm, or reset a cursor?

## Output format (write to the outbox)

```markdown
# Story 2-1 Audit — codex-advisor[luna] (gpt-6-luna[max])

# Verdict
SHIP | FIX-FIRST

# Findings
- [high|medium|low] <short claim>
  Evidence: <file:line, or the command and its output>
  Why: <why it matters>

# Checks
1..3 — PASS or FINDING reference, with per-clause/per-row notes for check 1

TEAM_DONE story-2-1-audit-luna
```

## Hard constraints

- Evidence must cite file:line you actually read, or a command you actually ran with its output.
- READ-ONLY: do not modify, create, or delete any repository file, and do not run anything that
  mutates the repo. (Running the new test file itself is allowed if you judge it necessary — it
  uses `mkdtemp` outside the repository — but say so and report the exact command and outcome.)
- Findings only about this story's change; pre-existing behavior is in scope only where this
  change relies on it.
