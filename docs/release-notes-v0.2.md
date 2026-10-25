# Agent Room v0.2 — Release Notes (v0.2.0, released)

Status: **RELEASED**. Every gate below ran against the materialized
artifacts recorded in `docs/release-evidence/v0.2.0-candidate.json`. Per the Epic 6
execution consensus (`docs/implementation/reviews/epic-6-execution-agy.md`,
`-luna.md`), the formal endurance soak (Story 6.2 / REL-3 — a twelve-hour run, amended and pre-registered after the first attempts showed the eight-hour profile measured the process EQUILIBRATING rather than settled) and the physical
two-machine demonstration (Story 6.1 / REL-1) pin THIS candidate: any code change
voids it and restarts the gate chain. Both gates returned their verdicts (REL-3
attempt 6 `status: pass` with the host window adjudicated `eligible`; REL-1
verified, `rel1-verify-evidence.mjs` exit 0), and the two-lane release-gate
review of 2026-10-25 (`docs/implementation/reviews/epic-6-release-gate-2026-10-25-{codex,agy,resolution}.md`)
judged the release act — the verdict history is exactly this: the codex lane
refused the first plan 3–1 and the agy lane approved the frozen bytes 4–1;
the resolution record then made the explicit threshold decision and erratum
the refusals named, and the confirmation round that followed it approved the
revised act 4–0 with one recorded threshold dissent.

## What v0.2 is

Local-first agent chat rooms over MCP, rebuilt on v0.2 foundations: Direct Rooms
addressed by Chat ID (DM-first), named identities with durable claims, presence,
a per-realm trust allowlist with the human-owned held pipeline, Remote Mode
(HTTPS + invite-token enrollment), an authenticated read-only live web viewer,
and an in-place upgrade path from v0.1 data. Zero external runtime dependencies;
Node >= 24.15, SQLite >= 3.51.3.

## Upgrading from v0.1: the one-time v1→v2 cursor reset

The first boot against a v0.1 data directory upgrades the file in place inside a
single transaction: rooms keep ids, titles, and timestamps; reply threads are
remapped; sequences are renumbered room-local starting from 1; the realm id is
preserved (an in-place upgrade is the same realm). v0.1 actor ids become derived
key fingerprints. v0.1 had no DMs and no fingerprints, so no DM history exists to
migrate — recorded honestly in the migration's mapping decisions
(`docs/implementation/spec-2-3-the-v0-1-v0-2-migration-one-time.md`).

**The cursor reset is structural and belongs to this upgrade only.** Client read
cursors are not migrated and not consulted: they were keyed to v0.1's global
message sequence, while v0.2 sequences are room-local from 1 and the upgrade
mints the realm's key that v0.2 cursors live under
(`PLUGIN_DATA/realms/<realm_id>/cursors.json`). Every pre-upgrade cursor value is
out of service; clients resume from `after_seq` 0 and will re-see already-read
history as unread, exactly once. Ordinary restarts never reset cursors (FR-11,
proven in Story 2.1). The production documentation lives in exactly one place —
the migration module's header — enforced by a suite scan
(`tests/migration.test.mjs`, "the one-time cursor reset is documented exactly
once in production code").

## First conversation, measured: SM-C1 re-measurement

SM-C1 (PRD `docs/prds/prd-agent-room-2026-09-20/prd.md:364`): Local Mode
first-use friction must not regress vs v0.1.0 **beyond the single required Chat
ID choice** — v0.2 passes with no additional step beyond the Chat ID choice and
no time regression beyond it. The v0.1 anchor is
`docs/v01-baseline.md` (measured 2026-09-25 on the packaged v0.1.0 artifact,
five fresh installs, per-run 0.351 / 0.342 / 0.347 / 0.366 / 0.353 s, mean
0.352 s). The re-measurement ran in `tests/release-smoke.test.mjs` ("SM-C1
re-measurement: five fresh installs of the materialized package reach the first
exchanged message") against the materialized Claude Code package, wall-clock
from install start to the first exchanged message, on the same machine.

Measured 2026-10-06, Node v24.18.1 / SQLite 3.53.4, macOS (darwin arm64),
three consecutive five-install runs, 0 failures in any run. Milestones in
execution order — a DM addresses the peer's claimed Chat ID, so Bob's choice
precedes Alice's open (medians are per-milestone, cumulative from install
start):

| Milestone (cumulative median, s) | v0.1 (baseline) | v0.2 (frozen run) |
|---|---|---|
| install (copy package) | ~0.003 | 0.009 |
| A initialized (MCP handshake) | ~0.085 | 0.120 |
| A Chat ID chosen (`agent-room setup`; boots the shared server) | — (not in v0.1) | 0.301 |
| B initialized | ~0.345 | 0.412 |
| B Chat ID chosen | — (not in v0.1) | 0.426 |
| A DM opened (`room_direct_open`; v0.1's room-create/join pair) | (A room created ~0.257) | 0.440 |
| A message sent | ~0.260 | 0.441 |
| B DM opened | (B joined ~0.348) | 0.454 |
| **B received A's message (end-to-end)** | **~0.351** | **0.458** |

Per-run end-to-end across the three consecutive runs that fixed the first
frozen record (seconds):

- run 1: 0.459 / 0.477 / 0.466 / 0.461 / 0.464 (mean 0.465)
- run 2: 0.462 / 0.463 / 0.461 / 0.454 / 0.456 (mean 0.459)
- run 3 (frozen, the pre-6.4 tree): 0.458 / 0.458 / 0.463 / 0.458 / 0.457 (mean 0.459, spread 0.005)

Three further five-install verification runs of that gate recorded means
0.497 / 0.500 / 0.489 s (adjusted 0.296 / 0.291 / 0.289 s) — the same verdict,
slightly busier machine. Across those six runs: thirty fresh installs, zero
failures, every run inside the rule.

**The frozen run of THIS candidate** (the tree that carries the reconnect
recovery — the repair landed in commit `6d6b45f`, re-cut and frozen at
`3929cc7`) was measured again, on a quiet machine, before the
REL-1 round: 0.454 / 0.463 / 0.472 / 0.458 / 0.455 s (mean **0.460 s**, median
0.458), adjusted 0.257 / 0.268 / 0.279 / 0.261 / 0.259 s (mean **0.265 s**),
zero failures across five fresh installs. The numbers below are that run's.

**Verdict per SM-C1's rule: pass.**

- Steps: the v0.2 ladder's delta versus v0.1's is exactly the two Chat ID
  choices — one per installation, performed once by the real `agent-room setup`
  command. v0.1's explicit `room_create` / `room_join` pair collapses into the
  two `room_direct_open` calls (DM addressing replaces manual room plumbing;
  room ids still come from tool results, never guessed). No other step exists.
- Failures: 0 across every fresh install of the final gate (thirty across the
  first candidate's six runs, five more on this candidate's frozen run).
- Time beyond the choice: the two added setup rows cost 0.181 s and 0.014 s
  (median) in the frozen run. Price them out and v0.2's ladder is
  **0.265 s mean (adjusted per-run 0.257–0.279 s) — faster than v0.1's
  0.352 s anchor**. The raw end-to-end mean (0.460 s) sits above the anchor
  only because the ladder now contains a step v0.1 never paid; everything
  v0.1's ladder paid, v0.2 pays faster. The one-time server cold start is
  still paid exactly once per install and remains invisible inside the Chat
  ID choice (v0.1 hid the same cost inside its first tool call).

Measurement-noise bounds declared in the gate: the executable time assertions
run inside `node --test` beside every other suite file's children, so both the
adjusted comparison and the raw mean carry declared noise factors
(3× and 5× the anchor respectively; measured concurrent-with-suite raw means
reach ~1.26 s). They exist to catch structural regressions — never to replace
the recorded numbers above, which are the human-verdict comparison.

## Reconnect recovery: taking a Chat ID back (Story 6.4)

A client's Chat ID is held by a live session row, and that row outlives the
process that created it: a client that was killed, crashed, or lost its host
keeps the name until the row's lease expires, while presence shows the holder
offline. In v0.1 the server could not tell a dead process from a quiet one, so
the plain re-bind was refused with `chat_id_taken` and the restarted client was
unrecoverable under its own name — the physical two-machine demonstration hit
exactly this.

v0.2.0 closes it with three things:

- **An orderly exit hands the name back.** The MCP adapter releases its session
  when its host closes its channel, so a client that ended normally does not
  squat its name — with one honest caveat the REL-1 run found: a vendor CLI
  that tears its MCP child down kills it while that release is still crossing
  the internet, so a one-shot CLI can still leave its name reserved. The
  takeover below is the recovery for exactly that, and closing the race
  properly is open work for the next release.
- **An explicit takeover recovers a name that IS squatted.** `agent-room
  session replace` authenticates as that installation and asks the server for
  the handoff. The server grants it only when the live holder is the SAME key
  (a different key's session is never displaced), moves the name atomically
  (the durable claim write first, the memory transfer second), and ends the
  displaced session's authority AT the handoff: its token stops authenticating
  at once, and a request it had already sent is refused at the authorization
  stage. It cannot take the name back by reconnecting either — an automatic
  re-authentication never carries the takeover intent, so a plain re-bind is
  refused with the ordinary collision error. The command asks for an interactive
  confirmation and refuses a piped stdin.

  Five honest limits, all recorded in the Epic 6 retrospective as open work:
  the authorization-stage check happens BEFORE the request body is read, so a
  request whose body was still streaming when the handoff happened can still
  reach the handler (the takeover is for a DEAD session, which has no
  in-flight request; the window matters only if an operator takes over a LIVE
  one, which the command warns against); the takeover displaces whoever holds
  the name AT THE MOMENT it runs, not an incumbent the operator observed
  earlier, so a name that changed hands in between is displaced too; the
  displaced-session fence the server keeps is bounded at 1,000 entries, so a
  1,001st supersession can forget a predecessor whose request was still
  admitted (the bound is a count, not an age, so it proves nothing about
  in-flight requests); a shutdown during the client's INITIAL bind can race
  the first token assignment — stdin can close while the first
  authentication/bind is still pending, leaving the name reserved rather than
  released; and the `isTTY` gate stops an ACCIDENTAL non-interactive
  invocation — it is not proof of human consent, because a shell-capable agent
  can allocate a pseudo-TTY and answer the prompt itself (the REL-1 run
  recorded exactly that).
- **The client says so.** A `chat_id_taken` collision now names the command
  that recovers the name, instead of leaving the operator to read a coded
  error.

Automatic, unattended crash recovery is NOT part of this: identifying the
rightful successor process needs session-resume ownership evidence that the
Actor key alone cannot provide. A killed client therefore recovers by an
explicit operator action, and that is stated here rather than implied.

## Claimed clients: what each smoke proved

Both smokes install the MATERIALIZED artifact (a fresh copy of the
`scripts/package-release.mjs` output in a fresh plugin directory), resolve the
installed manifest exactly as the host would, and drive one DM round-trip
(A→B and B→A) through real MCP child processes spawned from the installed
entrypoint — including the real one-time `agent-room setup` flow (TTY-fixture
keystrokes, everything else real: keypair, local token, server boot, claimable
probe, 0600 config write). NFR-2's candidates-become-claims rule: with this
story, Claude Code and Zcode are claims.

| Client | Artifact installed | Install contract exercised | What the smoke proved | What is NOT claimed here |
|---|---|---|---|---|
| Claude Code | `agent-room-claude-code/` (materialized) | `.mcp.json`: `node ${CLAUDE_PLUGIN_ROOT}/server/mcp-stdio.mjs`, cwd `${CLAUDE_PLUGIN_DATA}` | `claude plugin validate --strict` passes on the materialized package (real CLI, machine-readable report, strict honored); the installed package completes a full DM round-trip through two installed sessions (distinct keypairs, one realm, both online in presence, converging pair room, untrusted-envelope delivery, committed sends) | Nothing material: this IS the Claude Code install contract |
| Zcode | `agent-room-agent-plugin/` (portable, materialized) | `mcp.json`: `node ${PLUGIN_ROOT}/server/mcp-stdio.mjs`, cwd `${PLUGIN_DATA}` | The portable package's installed entrypoint speaks the identical MCP wire: same install-resolution contract, same setup flow, same DM round-trip end to end | The real Zcode HOST loading the package (vendor install layout, host-side MCP client behaviour). Zcode's in-process install layout is not reproducible in this suite; that physical evidence belongs to REL-1's human demonstration and is claimed nowhere here |

Both packages materialize deterministically (two independent runs of the
packager agree byte-for-byte), so the frozen hashes below are reproducible from
the source tree at any time.

## The frozen candidate

`docs/release-evidence/v0.2.0-candidate.json` records: the git commit the tree
is built from, both package SHA-256 tree digests (46 files each — 3.5x the
v0.1 package's 13 files), Node and SQLite versions, the validator identity, the
SM-C1 numbers above, and the binding statement for Stories 6.2 and 6.1.

## Where the changelog is, and why

`CHANGELOG.md` ships inside both packages, so it is part of the artifact's bytes: editing it after the
candidate is frozen changes the digest, voids the candidate, and costs another full qualification
run. That is why the release notes are long and the packaged changelog is a summary.

**This release's packaged changelog is complete.** Its top section is the versioned
`0.2.0 - 2026-10-21` heading, and it carries the Story 6.4 entry — the continuity repair, the takeover
command, and the one limit the fence has. The packaged README carries the recovery section: what the
command does, what it refuses, and the window. (The date in that heading is the FREEZE date — the day the
release's bytes were settled. The tag carries the publication date.)

**The process rule that made that possible** is the thing worth keeping: every story's changelog entry and
README section land WITH the story, before the candidate is frozen, so a release never ships a changelog
that is missing its own headline fix. The re-cut that carried the Story 6.4 repair did not follow that
rule — its changelog entry and its heading would each have voided a qualification run — and the
release-gate review found it (the Epic 6 retro, finding F8 and action A1). The third re-cut fixed it.

## Notes for the RC window

- The plugin manifest version is `0.2.0` in `plugin.json` (the packager
  validates the manifest against a frozen canonical shape; the version literal
  moved with the release). The stamp is applied **before** the candidate is
  re-cut, so the frozen artifact and the shipped artifact are the same bytes —
  stamping after the soak would have voided the candidate a second time.
- Package size grew from v0.1's 136 KiB / 13 files to 772 KiB / 46 files per
  package (remote mode, viewer assets, trust/held pipeline, migration, drills'
  runtime surface) — no external dependencies were added.

## Release erratum (2026-10-25, from the two-lane release-gate review)

Full record: `docs/implementation/reviews/epic-6-release-gate-2026-10-25-resolution.md`.
Zero packaged bytes are affected; these are publication-accuracy corrections.

- **Attempt 6's retained-state diagnostic is RISING (~0.65%/hour** — post-GC
  used heap 9.2 → 9.3 MiB over 46 natural major collections in the final
  four-hour window). Per the ratified REL-3 amendment it is reported, never
  gated, and is carried to v0.3; no leak-free claim is made.
- **REL-1 viewer freshness, authoritative figures:** 0.150 s same-machine
  (no clock term) and 0.276 s cross-machine (raw 0.172 s + the measured clock
  offset 104 ms; ±~0.9 s Date-header quantization uncertainty) — both far
  inside the 5 s bound. The canaries are seq 3 and seq 4, and the viewer
  rendered FOUR distinct broadcast texts. Superseded: the passage in the
  REL-1 `VERIFICATION.md` narrating "eight broadcasts, canaries seq 7/8,
  0.107 s / 0.217 s" (the raw evidence files were never edited; the evidence
  verifier's structural checks are unaffected).
- **Two shipped source comments in `server/api/session.mjs` overstate the
  session-fence guarantee** (one calls the 1,000-entry bound an age-style
  guarantee about in-flight requests; one places the fence check "immediately
  before the handler runs" when it runs before a body-carrying request's body
  is read). The behavior is exactly as disclosed in the honest limits above —
  A5 and A7 — and the comments are corrected in v0.3 with the A5 fix. The
  acceptance of these two comment occurrences for v0.2.0 is recorded as an
  explicit new threshold decision in the resolution record, not claimed as
  prior approval.
