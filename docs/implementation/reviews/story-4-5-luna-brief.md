# Story 4-5 Audit Brief — codex-advisor[luna]

## Role

Independent auditor for Story 4-5 of the agent-room build (Ban by identity key: the durable
`banned_actors` registry, the three enforcement faces — the per-request authz-stage gate, the
long-poll loop's per-iteration re-check, the enrollment transaction's post-proof
pre-consumption gate — and the operator's `ban`/`unban` commands on the Story 4.2 CLI host).
READ-ONLY: do not modify any file — do not modify, create, or delete anything in the
repository. **Your outbox file is the deliverable** — write the full audit to
`/Users/ngs/agent-skills/plugins/agent-room/.mailbox-out/story-4-5-audit-luna`; a chat answer
alone is not acceptable.

**Independence rule:** your Verdict is your own judgment and must NOT be reconciled into other
voices' opinions. Do not read, seek, or incorporate any other reviewer's or lane's opinions —
other files under `docs/implementation/reviews/` and other outboxes are out of scope. Decide
from the change, the contract, and the code alone.

## The contract

The contract under audit is
`docs/implementation/spec-4-5-ban-by-identity-key.md`. Read its
`<intent-contract>` in full — Intent (Problem + Approach), Always, Block If (8 halt
triggers), Never, and the I/O & Edge-Case Matrix (15 rows) — plus its Planning Note —
Backfill, Code Map, Tasks & Acceptance, Spec Change Log, Design Notes, and Verification. The
matrix rows are the acceptance surface.

**This is a BACKFILL spec** (its Planning Note says so): the implementation already landed in
commit `658744f`, an ancestor of this audit's baseline `7bd1438`, and the spec was authored
afterward FROM the landed code and the binding AC (`docs/epics.md:492`). Consequences for you:
- The contract's intent-contract DESCRIBES the shipped design. Your job is to verify the
  description is honest — that the landed code actually carries every property the contract
  claims for it, and that every matrix row has a real covering assertion in
  `tests/ban.test.mjs`. A contract claim the code does not hold is a finding, exactly as if
  the spec had come first.
- The story's one AUTHORED delta (its Task 2) is the architecture spine's dated amendment —
  that amendment is the working-tree change you are reviewing. Tasks 1 and 3 are verification
  passes; the landed implementation is never silently rewritten in this story, so do not
  propose rewrites as a condition of SHIP unless you find a real contract breach.

## What changed

The change under review is every file differing from baseline
`7bd14385190dd96a06b6e760643fc979cec4be31` (which is also HEAD — `git rev-parse HEAD`
confirmed at brief-writing time):

- `docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md` — one line
  changed (+1/−1, `git diff 7bd1438 --stat`): AD-5's Rule gains a second dated amendment,
  `*(Amended 2026-09-30 by Story 4.5 implementation — ...)*`, appended beside the Story 4.1
  `enrolled_actors` amendment it mirrors. The amendment records, additively: the
  `banned_actors` table (STRICT, keyed by the canonical fingerprint, no FK into
  `enrolled_actors` because preemptive bans of never-seen keys are first-class), the same
  additive open path with no schema-version bump, the three enforcement faces all reading the
  registry per request and never a cached set (the authz stage on the request's own store
  connection — the operator CLI is a separate process writing the same SQLite file; the
  long-poll loop's per-iteration re-check inside the 20 s hold window, never killing the
  connection; the enrollment transaction's post-proof, pre-consumption refusal), and the
  deliberately unban-gated local credential exchange (the ban holds at the resource boundary).
  The frozen vocabularies gain nothing.
- `docs/implementation/spec-4-5-ban-by-identity-key.md` — the contract itself (untracked at
  planning time; this is the backfill record).

Factual note from `git status --porcelain` and `git diff 7bd1438 --stat` (run while preparing
this brief, at HEAD = baseline `7bd1438`): no other tracked file differs, and the only other
untracked file is this brief itself (`docs/implementation/reviews/story-4-5-luna-brief.md` —
lane tooling that dispatches this audit; outside the review set, flag it only if it materially
contradicts the story). Everything else the story touches — `server/store/bans.mjs`,
`server/cli/ban-commands.mjs`, `tests/ban.test.mjs`, the extensions to `room-log.mjs`,
`invites.mjs`, `pipeline.mjs`, `server.mjs`, `constants.mjs`, `agent-room.mjs`,
`CHANGELOG.md`, `docs/implementation/ac-evidence.yaml` — is already INSIDE the baseline
(landed at `658744f`); you audit those files as the landed implementation the contract
describes, not as working-tree diff. Verify the diff claims yourself; if any tracked file
beyond the spine differs from baseline, that is a finding.

## Audit checks (report each PASS / FINDING with file:line evidence)

1. **Intent-contract, clause by clause** — walk every clause of the spec's
   `<intent-contract>` against the landed code: each Intent claim (the reserved seams — the
   authz stage's structural pass-through at `server/api/pipeline.mjs`, the `banned` send-status
   wired by name in `server/constants.mjs` since 4.4, the 4.2 CLI host's one JSON-lines
   grammar, the B1 boundary's deferred ban-persistence proof); every Always (ban keyed ONLY by
   the canonical `sha256:` + 64-lowercase-hex fingerprint from the constants module's single
   pattern — never a chat id, claim, or presented name; the gate read per request on the
   request's own store connection, never a cached in-process set; the stage gate scoped to the
   actor class answering coded `banned` 403 from `PUBLIC_ERROR_STATUS`; the re-enroll refusal
   INSIDE the enrollment transaction, after the possession proof and before the reattach check
   or any use consumption; the challenge route privilegeless-open and `POST /api/auth/local`
   unban-gated; the long-poll re-check on every iteration terminating at the next wake ≤ 250 ms,
   never past the 20 s window, never by killing the connection; preemptive bans first-class
   with no FK; re-ban idempotent keeping the FIRST `banned_at` and reason; unban a row-deleting
   success reporting `removed` honestly; reason stored as non-empty string or NULL, never `''`;
   additive convergence with column-set verification refusing divergence as coded
   `database_schema_invalid`, no version bump; every registry write inside the store's
   `withImmediateTransaction`; the operator surface on the 4.2 host with exit codes 0/1/2 and
   the argv fingerprint gate on the same constants pattern the CHECK enforces; canonical ISO
   8601 timestamps through the injectable clock); every Block If trigger (a banned request
   reaching a handler; a CLI-committed ban invisible at the server's next request; a long-poll
   held past 20 s or killed; a banned re-enroll consuming an invite use / reattaching / creating
   a row; ban state revealed to a caller failing possession; a ban keyed by anything but the
   canonical fingerprint; a schema-version bump; an operator HTTP route or `actor_id` from
   arguments; a rate-based auto-ban; a re-ban overwriting the first timestamp/reason); and each
   of the 15 I/O & Edge-Case Matrix rows against its named test in `tests/ban.test.mjs` (store
   semantics rows 1-4; the stage row 5; the wire rows 6-11; the restart row 12; the CLI rows
   13-14; the one-pattern pin 15). For each: is it implemented as the contract describes, and
   is the covering assertion genuinely present (not paraphrased away)? Name any clause or row
   with no real covering assertion.
2. **The authored delta — the spine amendment** — the working-tree change is one paragraph;
   audit it as a record, against the code it records: is the AD-5 amendment dated 2026-09-30 by
   Story 4.5, placed beside the enrolled_actors amendment it mirrors (spine ~:73), additive
   (the prior text byte-identical — `git diff 7bd1438` shows one line replaced by itself plus
   the appended amendment)? Is every claim in it true of the code: the table STRICT and keyed
   by the canonical fingerprint with no FK into `enrolled_actors` (`server/store/bans.mjs`);
   convergence additive, no version bump, column-set verified (`server/store/room-log.mjs`);
   the three faces per-request and uncached (`pipeline.mjs` authz stage; `server.mjs` long-poll
   loop; `invites.mjs` post-proof pre-consumption gate); the local exchange unban-gated; the
   20 s window and ≤ 250 ms wake claims matching `READ_HOLD_MAX_MS` and
   `LONGPOLL_POLL_INTERVAL_MS` in `server/constants.mjs`? And the frozen vocabularies: AD-7's
   stage table already names banned keys rejected at authorization, AD-8's status set already
   includes `banned`, AD-13's host rule already names ban/unban — the amendment must VERIFY,
   not duplicate (do the existing lines carry it?).
3. **The landed implementation vs the Code Map** — the backfill verification pass: every Code
   Map home exists and carries the claimed property (`server/store/bans.mjs` — the DDL with its
   CHECK on the constants pattern, `BANNED_ACTORS_COLUMNS`, `banActor` INSERT … DO NOTHING
   first-ban-wins, `unbanActor` honest `removed`, `isActorBanned` one indexed SELECT;
   `room-log.mjs` — the convergence list, the open-path add + verification, the enrollment
   seam's `isBanned`, the store surface `banActor`/`unbanActor`/`isActorBanned`;
   `invites.mjs` — the gate after `verifyWithRawPublicKey`, before the reattach check and any
   consumption; `pipeline.mjs` — the actor-class-scoped stage reading the fingerprint from
   `context.session`, never a request argument; `server.mjs` — the per-iteration poll
   re-check and the send-status comment; `constants.mjs` — `PUBLIC_ERRORS.banned`,
   `PUBLIC_ERROR_STATUS.banned: 403`, no numeric invention; `cli/ban-commands.mjs` — strict
   argv, usage→2 / refusal→1 through the single JSON-error printer; `agent-room.mjs` — the
   dispatch and the help entries; `tests/ban.test.mjs` — 13 tests, real CLI and server CHILD
   processes for the cross-process rows, read-only disk inspection). Then the tests' ability
   to fail: could `tests/ban.test.mjs` pass vacuously? Are the cross-process rows real
   children (a regression to in-process calls must fail)? Is cross-process visibility asserted
   through a REAL CLI child writing while a REAL server child refuses at next request? Is the
   restart row a SIGKILL? Is the no-leak row a genuinely correct proof from the WRONG key
   answered `signature_invalid`? Is the mid-hold row asserting the refusal arrives at a wake
   INSIDE the window, not at the deadline? Is idempotence asserted on the FIRST timestamp/reason
   surviving? Any skip / `.only` / todo / host-conditional escape hatch? Finally the
   housekeeping the spec's Task 3 names: `CHANGELOG.md`'s 4.5 entry (~:168-189) naming the
   registry, the gate, the long-poll re-check, the persistence proof; the
   `docs/implementation/ac-evidence.yaml` 4.5 entry (~:1043-1089) with all nine test pointers
   resolving to real test names in `tests/ban.test.mjs`; `README.md` consistent (operator
   families document themselves via `agent-room help` — flag only real drift). You may run
   `node --test tests/ban.test.mjs --test-timeout=120000` (it uses `mkdtemp` outside the
   repository) — if you do, report the exact command and outcome; the full suite
   `node --test` remains the story pipeline's own gate, not yours.

## Output format (write to the outbox)

```markdown
# Story 4-5 Audit — codex-advisor[luna] (gpt-6-luna[max])

# Verdict
SHIP | FIX-FIRST

# Findings
- [high|medium|low] <short claim>
  Evidence: <file:line, or the command and its output>
  Why: <why it matters>

# Checks
1..3 — PASS or FINDING reference, with per-clause/per-row notes for check 1

TEAM_DONE story-4-5-audit-luna
```

## Hard constraints

- Evidence must cite file:line you actually read, or a command you actually ran with its
  output.
- READ-ONLY: do not modify, create, or delete any repository file, and do not run anything
  that mutates the repo. (Running the test file itself is allowed if you judge it necessary —
  it uses `mkdtemp` outside the repository — but say so and report the exact command and
  outcome.)
- Findings only about this story's change and the landed implementation its contract
  describes; pre-existing behavior is in scope only where this change relies on it.
