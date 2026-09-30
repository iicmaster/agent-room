# Story 4-6 Audit Brief — codex-advisor[luna]

## Role

Independent auditor for Story 4-6 of the agent-room build (Storage admission control: one
`statfs` mechanism with three faces — the store's in-transaction admission gate refusing new
appends with coded `storage_low` below the refuse reserve, the send route's 200 RESULT
`{status:'storage_low'}` wire face, the operator's `agent-room capacity` command — plus the
rate-limited warn line between the reserves and FR-22's backup/restore + disk-expansion
guide). READ-ONLY: do not modify any file — do not modify, create, or delete anything in the
repository. **Your outbox file is the deliverable** — write the full audit to
`/Users/ngs/agent-skills/plugins/agent-room/.mailbox-out/story-4-6-audit-luna`; a chat answer
alone is not acceptable.

**Independence rule:** your Verdict is your own judgment and must NOT be reconciled into other
voices' opinions. Do not read, seek, or incorporate any other reviewer's or lane's opinions —
other files under `docs/implementation/reviews/` and other outboxes are out of scope. Decide
from the change, the contract, and the code alone. (This brief and the spec's own Deferred
Review Findings list are your materials; no other review file is.)

## The contract

The contract under audit is
`docs/implementation/spec-4-6-storage-admission-control.md`. Read its
`<intent-contract>` in full — Intent (Problem + Approach), Always, Block If (11 halt
triggers), Never, and the I/O & Edge-Case Matrix (14 rows) — plus its Planning sections:
Code Map, Tasks & Acceptance (the binding epic text at `docs/epics.md:494-505` and FR-22 at
`docs/prds/prd-agent-room-2026-09-20/prd.md:288-293`), Spec Change Log, the **Deferred Review
Findings** section (18 carried findings), and Verification. The matrix rows are the
acceptance surface.

**Context you need:** the story's base implementation and the spec itself landed in commit
`8dfd2d2` (feat: story 4.6 storage admission control), an ancestor of this audit's baseline
`b9327bb`; stories 4.5's finalization (`b9327bb`) and a workflow fix (`7bd1438`) sit between.
The spec's Spec Change Log and Deferred Review Findings section describe an earlier moment
(when the delta was uncommitted on `658744f`) — read them as history, and bind instead to
what the files say now. This audit is the story's **re-run**: the working-tree change under
review is the hardening pass that closes the 18 deferred findings the spec carries (numbered
1-18, strongest first — internal-2-1 the SQLITE_FULL proof gap, internal-2-2 the spawned-env
gap, internal-4-3 the auto-start whitelist gap, internal-1-4 the warn-under-lock shape,
internal-1-6/2-7/4-4 the name-only index verification, and eleven more). So your job is
two-sided: (a) verify the hardening delta genuinely closes each finding it claims — a claim
of closure the code or tests do not bear out is a finding, exactly as if the gap had never
been fixed; and (b) re-walk the full intent-contract against the landed implementation the
delta touches, because a hardening pass can regress what it did not mean to touch.

## What changed

The change under review is every file differing from baseline
`b9327bb33058579f1f9bdf8e12175017849e1452` (which is also HEAD — `git rev-parse HEAD`
confirmed at brief-writing time). `git diff b9327bb --stat` shows 13 files, +694/−45:

- `server/store/room-log.mjs` (+88/−...) — the re-run's center: `configureConnection` gains
  an opt-in `maxPageCount` pragma (the disk-full simulation seam — a connection-local page
  ceiling that makes the next page allocation answer SQLITE_FULL (13), applied last among
  the pragmas and asserted after setting); `openRoomLog` validates `maxPageCount` at open
  (positive safe integer or coded `invalid_argument`) and threads it through; the duplicate-
  gate index verification is extended from name-presence to the exact column set via
  `pragma_index_info` (`room_id, actor_fingerprint, text, seq` — a same-name squatter is now
  a coded `database_schema_invalid` at open); the index comment's citation is corrected to
  `tests/rate-gates.test.mjs` (was the nonexistent `tests/store.test.mjs` rows) and gains a
  storage-cost note (the index holds a second copy of every message body); and the storage
  warn sink now DEFERS — the in-transaction gate's warn line is captured and emitted only
  after `withImmediateTransaction` returns (never synchronous I/O under the write lock), and
  a captured line whose transaction rolled back is dropped.
- `server/api/server.mjs` (+8) — `startServer` gains the `maxPageCount` override, validated
  at startup (positive safe integer or coded `invalid_argument`), threaded into
  `openRoomLog`.
- `server/client/ensure-server.mjs` (+24/−...) — the auto-start child's spawn env whitelist
  now passes `AGENT_ROOM_STORAGE_WARN_BYTES` and `AGENT_ROOM_STORAGE_REFUSE_BYTES` through
  when set (only these two names, as opaque strings; the child's own startup re-validates).
- `server/constants.mjs` (+11/−...) — comment-only: `storage_low: 507` reworded to
  "reserved for" language (the deferred internal-1-2 fix — today the append path is the
  code's only producer).
- `server/store/storage-gate.mjs` (+15/−...) — comment-only: the real-source test's 2%
  tolerance rationale (bavail-vs-bfree on reservation-bearing filesystems) and the env
  parser's per-key fallback + resolved-pair validation semantics stated explicitly.
- `tests/storage-gates.test.mjs` (+313) — new rows: the SQLITE_FULL mapping through the real
  `appendMessage` (store-level: the mapped coded refusal names the disk, the warn sink stayed
  silent, the rollback wrote nothing, a fresh connection takes the gap-free next seq, an
  exact retry keeps resolving); the same over the wire (200 `{status:'storage_low'}`, never a
  raw SQLite error, absence after a full stop/reopen); the direct launch honoring a raised
  refuse reserve over the wire and surviving junk env with exactly one stderr warning line
  and declared defaults; capacity's negative rows (store file corrupt/absent → one JSON line,
  exit 0; non-ENOENT statfs failure → coded `data_directory_invalid`, exit 1). Suite is now
  25 tests (was 20).
- `tests/mcp-tools.test.mjs` (+42) — `message_send` surfaces a storage_low refusal as the
  TOOL result (the 200-result passthrough), never an error envelope, with an empty-log read
  proving nothing was acknowledged.
- `tests/ensure-server.test.mjs` (+90) — the plugin-managed auto-start child inherits the two
  knobs from the starting process (raised refuse → sends refused over the wire).
- `tests/rate-gates.test.mjs` (+41) — the duplicate-gate index squatter fixture (same-name
  index over a different column set → coded `database_schema_invalid` at open; dropping the
  squatter lets the next open converge) and the column-set pin.
- `docs/self-hosting-storage.md` (+29/−...) — the warn row narrowed to "every message
  append"; the per-knob junk fallback and the resolved-pair validation rule (refuse > warn
  after fallback fails startup / capacity coded); the auto-start inheritance documented in
  §1 and the §6 surface table; the 2N-bytes sizing note; a §5 failure-mode row for the
  upgrade-time open on a full disk (schema convergence write needs space).
- `docs/implementation/ac-evidence.yaml` (+65/−...) — the 4.6 entry rewritten: internal-2-1
  and internal-2-2 moved from NOT-proven to PROVEN with the mechanism named, and eight new
  evidence pointers added.
- `CHANGELOG.md` (+11/−...) — the Added entry gains the re-run hardening paragraph (the
  SQLITE_FULL proof, the env whitelist, the deferred warn, the column-set verification).
- `docs/implementation/workflows/.unattended-proven.json` (+1/−1) — run bookkeeping
  (`last_story` 4-1 → 4-5, commit pointer to this baseline). Lane/workflow mechanics, not
  story substance — flag it only if it materially contradicts the story.

Factual note from `git status --porcelain` and `git diff b9327bb --stat` (run while preparing
this brief, at HEAD = baseline `b9327bb`): no untracked files and no other tracked files
differ. This brief itself (`docs/implementation/reviews/story-4-6-luna-brief.md`) is lane
tooling that dispatches this audit; outside the review set, flag it only if it materially
contradicts the story. Verify the diff claims yourself; if any tracked file beyond the
thirteen differs from baseline, that is a finding.

## Audit checks (report each PASS / FINDING with file:line evidence)

1. **Intent-contract, clause by clause** — walk every clause of the spec's
   `<intent-contract>` against the landed code (the base implementation inside the baseline
   plus this delta): each Intent claim (the single `statfsSync` of the data directory using
   `bavail * bsize`, not `bfree`; the two operator-tunable reserves declared once in
   `server/constants.mjs`; the gate INSIDE `appendMessage`'s `BEGIN IMMEDIATE`, ordered after
   the idempotency lookup and the duplicate gate, immediately before the insert; the coded
   `storage_low` refusal and rollback having written nothing; exact retries / duplicate drops
   / reads resolving before the gate and never touching it; the raced SQLITE_FULL write
   mapping to the same coded refusal after the rollback; the wire face as the 200 RESULT
   `{status:'storage_low', room_id}` matching `duplicate_dropped`'s shape, never an error
   envelope, never an acknowledgment; `agent-room capacity` on the Story 4.2 host opening NO
   store and sharing the gate's own thresholds resolution; the warn line rate-limited to one
   per `STORAGE_WARN_INTERVAL_MS` per store connection on the append's own clock; free-space
   source, warn sink, and clock injectable at every layer; the real `statfs` proven against
   the live filesystem in its own row; validated thresholds at open/startup with refuse ≤
   warn; per-knob env parsing with warning fallback that never blocks a boot; and the FR-22
   guide). Every Block If trigger (a refusal or disk-full write ever acknowledged; a refusal
   dropping/altering/re-sequencing accepted work; a read refused because writes are; the gate
   firing for an exact retry or duplicate drop; the gate outside the append transaction; a
   threshold literal outside the constants module; a retention/delete behavior; `capacity`
   opening the store; a second warn line inside one interval; env junk blocking the direct
   launch; a malformed `startServer` override booting). Every Never (read paths/presence/
   claims/sessions/viewer ungated; no delete verb; no new wire fields or error codes — the
   frozen vocabularies gain nothing, the spine amendment additive only; `capacity` store-free;
   no statfs per append beyond the one observation and no timer-gated gate; no per-append
   warn; no CLI/gate thresholds divergence; no test tuning the declared defaults; no
   skip/`.only`/todo; no TLS claims in the guide). And each of the 14 I/O & Edge-Case Matrix
   rows against its named test(s) in `tests/storage-gates.test.mjs` (plus the mcp-tools row,
   the ensure-server row, and the rate-gates squatter row). For each: is it implemented as
   the contract describes, and is the covering assertion genuinely present (not paraphrased
   away)? Name any clause or row with no real covering assertion.
2. **The hardening delta vs the 18 deferred findings** — for each finding the spec's
   Deferred Review Findings section carries, check the delta's claimed closure is real, not
   cosmetic: internal-2-1/4-2 — does the store-level row drive the REAL `appendMessage` into
   a REAL errcode 13 (the `maxPageCount` page ceiling) while the injected free-space source
   stays above every reserve, assert the coded `storage_low` names the disk (not the gate's
   refuse wording), the warn sink silent, the rollback having written nothing (head unmoved,
   no seq consumed), a further NEW append still refused, an exact retry still resolving, and
   gap-free recovery; and does the wire row answer 200 `{status:'storage_low'}` with the
   message absent after a stop/reopen? internal-2-2 — are the spawned direct-launch children
   real (`server/api/server.mjs` as a child with the env knobs), the raised refuse refusing
   sends on the wire, the junk value producing exactly ONE `agent-room-server: ignoring
   invalid …` stderr line with defaults in effect? internal-4-3 — does the whitelist pass
   ONLY the two knobs, only when set, as opaque strings, and does the ensure-server test
   prove a plugin-managed child inherits them (and does the guide now say so)? internal-1-4 —
   is the warn genuinely emitted only after the transaction returns (captured in the gate
   callback, emitted post-commit), and is the dropped-on-rollback choice consistent with the
   matrix (row 3's between-reserves warn fires on an ADMITTED append, whose commit succeeds)?
   internal-1-6/2-7/4-4 — is the column set verified via `pragma_index_info` in the open path
   itself (not only a test), is divergence coded `database_schema_invalid`, is there a
   squatter-fixture test including the recovery-by-convergence half, and is the old
   "refuses a foreign squatter" comment claim now TRUE rather than merely reworded?
   internal-2-3 — the corrupt-store-file row (one JSON line, exit 0, no store open) and the
   non-ENOENT statfs row (coded `data_directory_invalid`, exit 1). internal-2-4/4-6 — the
   MCP row asserting the tool RESULT carries `status:'storage_low'` with an empty log and
   clean stderr. internal-2-5 — the tolerance rationale recorded beside the mechanism
   comment. internal-2-6 — the citation corrected to `tests/rate-gates.test.mjs` (and is the
   corrected citation itself accurate — do those rows exist there?). internal-1-1 — comment +
   guide state the per-key fallback and resolved-pair validation (behavior unchanged, the
   WARN=0-plus-junk contradiction still fails coded). internal-1-2 — the constants comment
   now says "reserved for". internal-1-5 — the storage-cost note (index comment and/or guide
   §1). internal-1-7 — the §5 upgrade-time row. internal-4-5 — the guide's warn row now says
   "every message append", matching the code (only `appendMessage` gates). Any finding whose
   closure is claimed in the CHANGELOG or ac-evidence but not delivered in code/tests is
   HIGH.
3. **No regressions, honest records, testability** — the re-run's other half: do the delta's
   edits preserve the contract's Always/Never (e.g. the `maxPageCount` seam is a store-level
   test seam only — no operator surface reads it; the deferred warn does not reorder or gate
   reads; the whitelist does not weaken the child env's hygiene)? Could the new tests pass
   vacuously (does the SQLITE_FULL row really loop a bounded number of appends until the
   ceiling bites, and would a mapping regression to a raw SqliteError fail it)? Do the
   ac-evidence 4.6 entry's evidence pointers (including the eight new ones) resolve to real
   test names in the named files? Is the CHANGELOG's hardening paragraph honest? Does the
   guide still pin its sections by test (row 14) with knob names matching the constants and
   env surface? No `.only`/`.skip`/todo in the touched test files (verified clean at
   brief-writing time by grep over the four touched files; re-verify). You may run
   `node --test tests/storage-gates.test.mjs --test-timeout=120000` and, if you judge it
   necessary, the touched neighbors (`tests/rate-gates.test.mjs`, `tests/ensure-server.test.mjs`,
   `tests/mcp-tools.test.mjs`) or the full suite `node --test --test-timeout=300000` — they
   use `mkdtemp` temp directories outside the repository. If you run any, report the exact
   command and outcome. The spec's own Verification section claims 494 pass / 0 fail / 0
   skipped on the pre-delta tree — the delta adds rows, so expect more than 494; a full-suite
   run is the story pipeline's gate, not yours, but a failing suite you observed is a finding.

## Output format (write to the outbox)

```markdown
# Story 4-6 Audit — codex-advisor[luna] (gpt-6-luna[max])

# Verdict
SHIP | FIX-FIRST

# Findings
- [high|medium|low] <short claim>
  Evidence: <file:line, or the command and its output>
  Why: <why it matters>

# Checks
1..3 — PASS or FINDING reference, with per-clause/per-row notes for check 1 and
per-finding notes for check 2

TEAM_DONE story-4-6-audit-luna
```

## Hard constraints

- Evidence must cite file:line you actually read, or a command you actually ran with its
  output.
- READ-ONLY: do not modify, create, or delete any repository file, and do not run anything
  that mutates the repo. (Running the named test files is allowed if you judge it necessary —
  they use `mkdtemp` outside the repository — but say so and report the exact command and
  outcome.)
- Findings only about this story's change and the landed implementation its contract
  describes; pre-existing behavior is in scope only where this change relies on it.
