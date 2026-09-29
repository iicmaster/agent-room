# Story 3-4 Audit Brief — codex-advisor[luna]

## Role

Independent auditor for Story 3-4 of the agent-room build (the human CLI surface, HCI-2:
held list / held show / allow / allow-all). READ-ONLY: do not modify any file — do not
modify, create, or delete anything in the repository. **Your outbox file is the deliverable** —
write the full audit to `/Users/ngs/agent-skills/plugins/agent-room/.mailbox-out/story-3-4-audit-luna`;
a chat answer alone is not acceptable.

**Independence rule:** your Verdict is your own judgment and must NOT be reconciled into other
voices' opinions. Do not read, seek, or incorporate any other reviewer's or lane's opinions —
other files under `docs/implementation/reviews/` and other outboxes are out of scope. Decide from
the change, the contract, and the code alone.

## The contract

The contract under audit is `docs/implementation/spec-3-4-the-human-cli-surface-hci-2.md`.
Read its `<intent-contract>` in full — Intent, Boundaries & Constraints (Always / Block If /
Never), and the I/O & Edge-Case Matrix (21 rows) — plus its Code Map, Design Notes, and
Recorded decisions. The matrix rows are the acceptance surface.

## What changed

The change under review is every file differing from baseline
`42c89c945dfa8792908720573c6eeb08ebe9c0ad`:

- `CHANGELOG.md` — Added entries for the command family; the human-flow paragraph.
- `README.md` — the held/trust sections gain the human-flow paragraph (held show as the only
  body surface, allow's resolution sources, allow-all's confirmation, the Instructed statement).
- `docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md` — the dated,
  strictly-additive AD-12 amendment (the human CLI surface joins the decision).
- `docs/implementation/ac-evidence.yaml` — the seeded 3.4 entry filled in with real test titles
  and the does-not-prove note.
- `server/cli/agent-room.mjs` — `main()` rewired into a dispatch table (`setup`, `held list`,
  `held show`, `allow`, `allow-all`, `help`); the local `httpJson`/`bearerHeaders` moved out;
  the runtime gate and launched-directly tail keep their shape; `runSetup` and
  `SETUP_REQUIRES_TTY_MESSAGE` stay exported.
- `docs/implementation/spec-3-4-the-human-cli-surface-hci-2.md` — the contract itself.
- `server/cli/held-commands.mjs` — new: the command bodies (`runHeldList`/`runHeldShow`/
  `runAllow`/`runAllowAll`), the unbound CLI session exchange (never `POST /api/session`),
  `resolveRealmId` behind the `REALM_KEY_PATTERN` guard, `parseHeldId` (last-colon), the
  candidate resolution over held records + presence, and the envelope-applying point-read seam.
- `server/cli/http.mjs` — new: `cliHttpJson`/`cliBearerHeaders` extracted verbatim from the
  setup command — the single bounded round-trip home.
- `tests/cli-surface.test.mjs` — the entire behavioral proof: ten tests covering every matrix
  row, real spawned server children, real state files, injected stream fixtures, literal
  oracles.

Factual note from `git diff --name-only 42c89c945dfa8792908720573c6eeb08ebe9c0ad HEAD` (run
while preparing this brief, at HEAD `a4267d9`): one more file also differs from baseline —
`docs/implementation/workflows/agent-room-story-build.ts` (+14 lines; the lane tooling that
dispatches this audit). It is outside the enumerated review set above; flag it only if it
materially contradicts the story. `server/mcp-stdio.mjs` must NOT differ — verify that claim
yourself; if it does, that is a Block If, and a high finding.

## Audit checks (report each PASS / FINDING with file:line evidence)

1. **Intent-contract, clause by clause** — walk every clause of the spec's `<intent-contract>`:
   each Intent claim; every Always (held body text confined to `held show`'s stdout — metadata
   at most everywhere else; release keyed on the FINGERPRINT never the name, null-fingerprint
   records never matched; chat ids resolved ONLY from the current realm's held records plus
   `GET /api/presence?include_offline=true`, case-insensitive per DR-1, merged by fingerprint,
   zero candidates refuses, several refuse with the candidate list, one proceeds; `--fingerprint`
   must be well-formed AND among the name's candidates; release through `heldClear` per
   (room, seq), allowlist through `setAllowlistEntry`, accept-all through `setAcceptAll`,
   preview through `heldBody` with the point-read seam exactly `after_seq = seq − 1, limit = 1`
   and `applyUntrustedEnvelope(page, keypair.fingerprint)` re-applied so the recovered body
   byte-matches the cached artifact; the CLI session UNBOUND — no `POST /api/session`, no
   presence touch, no durable claim, no Chat ID printed, `config.json` never read; realm
   resolution via `GET /api/status` through the `REALM_KEY_PATTERN` guard; the help text states
   approval is a human convention (Instructed) and that same-user processes are not
   cryptographically distinguishable, and the literal phrase "never agent-invocable" appears
   NOWHERE; `allow-all` requires interactive TTY y/N and refuses non-TTY stdin while
   `allow-all --remove` and `allow --remove` run without confirmation; failures exit non-zero
   with one coded `agent-room <command> failed: <code>: <message>` stderr line naming the
   failing input, grammar errors quoting `CHAT_ID_INVALID_MESSAGE`, never a bare "invalid";
   async bodies await the pipeline's rejected promises so refusals surface as coded errors;
   the runtime gate and launched-directly discipline keep their shape; tests in the house
   style); every Block If trigger and every Never; and each of the 21 I/O & Edge-Case Matrix
   rows. For each: is it implemented as written, and is the covering assertion genuinely
   present (not paraphrased away)? Name any clause or row with no real covering assertion.
2. **Store/API invariants the story depends on** — verify the claimed code homes carry the
   properties this story builds on: `server/client/held.mjs` exports `heldList`/`heldCount`/
   `heldBody`/`heldClear` unchanged with `heldBody`'s `pointRead` seam still injectable and
   `heldClear` releasing record + cached body together; `server/client/trust.mjs` exports
   `setAllowlistEntry` (idempotent, preserves the original `added_at`), `setAcceptAll`, and
   `loadAllowlist` unchanged, with a missing/corrupt allowlist file still evaluating to
   distrust; `server/mcp-stdio.mjs` still imports only the metadata trio and the nine-tool
   surface is untouched (the `tests/held.test.mjs` source scan must stay green untouched);
   `server/api/server.mjs`'s `POST /api/auth/local` issues a token bound only to the Actor
   fingerprint, the post-auth presence touch no-ops for an unbound session, `GET /api/presence`
   returns `{online, offline_recently}` rows carrying `chat_id`/`fingerprint`/`last_seen`,
   `GET /api/status` answers `realm_id`, and the messages GET serves the point read under the
   same Actor-member ACL; `server/constants.mjs` provides `CHAT_ID_INVALID_MESSAGE`,
   `FINGERPRINT_PATTERN`, and `REALM_KEY_PATTERN` with NO new constant added anywhere (AD-9)
   and no numeric literal or error message restated outside it; the CLI writes state only
   through `setAllowlistEntry`/`setAcceptAll`/`heldClear` (the 0600 atomic state-file
   discipline is theirs, not the CLI's); the point read is never re-cached and never serves a
   released record. A property the tests assert but whose code home does not hold is a finding.
3. **The tests' ability to fail** — could `tests/cli-surface.test.mjs` pass vacuously? Are the
   servers real spawned children with real state files written by the real pipeline functions
   (the composed-layer hold production of `tests/held.test.mjs`), injected stream fixtures for
   the confirmations, and zero wire mocks? Are expected values literal oracles built in the
   test file (never computed from a production module, so a producer regression cannot make
   both sides drift together)? Is ZERO-body-bytes-in-`held-list`-stdout actually asserted (an
   envelope leak regression must fail)? Is the cached-vs-recovered byte-match asserted against
   the real server (row 5, eviction + point read, not re-cached)? Do the ambiguity rows really
   require two fingerprints for one name, and would a silent guess or an outside-candidates
   `--fingerprint` acceptance fail? Is the non-TTY `allow-all` refusal asserted (a pipe must
   never flip accept-all), and `--remove` prompt-free? Is the unbound-session discipline
   asserted against a live MCP child holding the name (no `POST /api/session` sent, no
   `chat_id_taken`, no presence row)? Is the help statement's presence AND the "never
   agent-invocable" absence asserted? Are exit codes and the coded stderr shape asserted with
   no token or secret in any output? Is there any skip / `.only` / todo / host-conditional
   escape hatch? Would the suite actually fail if release matched by name instead of
   fingerprint, the point-read shape drifted from `after_seq = seq − 1, limit = 1`, the
   envelope were not re-applied on recovery, `--remove` deleted held records, or a new
   constant were restated?

## Output format (write to the outbox)

```markdown
# Story 3-4 Audit — codex-advisor[luna] (gpt-6-luna[max])

# Verdict
SHIP | FIX-FIRST

# Findings
- [high|medium|low] <short claim>
  Evidence: <file:line, or the command and its output>
  Why: <why it matters>

# Checks
1..3 — PASS or FINDING reference, with per-clause/per-row notes for check 1

TEAM_DONE story-3-4-audit-luna
```

## Hard constraints

- Evidence must cite file:line you actually read, or a command you actually ran with its output.
- READ-ONLY: do not modify, create, or delete any repository file, and do not run anything that
  mutates the repo. (Running the new test file itself is allowed if you judge it necessary — it
  uses `mkdtemp` outside the repository — but say so and report the exact command and outcome.)
- Findings only about this story's change; pre-existing behavior is in scope only where this
  change relies on it.
