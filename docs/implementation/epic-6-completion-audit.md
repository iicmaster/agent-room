# Epic 6 Completion Audit — Prove It & Ship

Date: 2026-10-21 · Commit range `3aec7ed` (post-Epic-5) → `02ea0b9` · Suite: **574 pass / 0 fail / 0 skipped** ·
AC sweep: **clean** (4 stories, 8 criteria, 31 evidence pointers)

> **Status: written against the final candidate while the formal soak is still
> running.** The soak's verdict is the one open gate; every other line here is
> settled by evidence that exists today. The sections marked **[PENDING]** wait
> for that result — and this document will not pre-record a verdict for a run
> that has not finished.

## Verdict

**Epic 6 is one gate short: the formal 8-hour soak is running.** The release
candidate is frozen, validated and reproducible; the physical two-machine
demonstration is captured and verified by its own verifier; and the one defect
the demonstration found — a killed client that could not reclaim its own Chat
ID — is repaired, proven by nineteen acceptance rows, and proven again in the
physical deployment on both machines.

**Two real defects were found and fixed inside this epic**, and neither was
visible to the suite:

1. **The shipped web viewer could never connect.** It reported "Room server
   unreachable" on every load against a healthy server: the client half read
   the boot descriptor at the wrong level of the API's `{ok, result}` envelope.
   Nothing in the suite ran the shipped `web/app.js`, so the mismatch survived
   the whole viewer epic. Fixed in `cc7eb6e` with two regression tests that run
   the shipped script — one against a DOM double, one against a REAL server
   with a really minted viewer cookie.
2. **A killed client could not reclaim its own Chat ID.** Its live row kept
   the name until the 12-hour lease expired while presence showed the holder
   offline, so the restarted client was permanently unrecoverable under its own
   name. The design round-table chose the repair — an explicit, same-Actor,
   operator-authorized takeover with an atomic transfer and a fence — and it
   shipped in `6d6b45f` as `POST /api/session`'s additive `replace_existing`
   intent, the live registry's `transfer`, the session registry's fence, the
   MCP adapter's orderly-exit release, and the operator command
   `agent-room session replace`.

## Story ledger

| Story | Commit | Proof |
|---|---|---|
| 6.1 REL-1 — the cross-everything demonstration | `33c7ec1` (the flight kit), `98a15f8` (the evidence) | `docs/release-evidence/v0.2.0-rel1/` — two physical machines (NSG-Mac-mini and ngs-staging), two vendor hosts (the real Zcode CLI 0.17.0 on the Mac, the real Claude Code 2.1.306 on staging through that host's own model gateway) plus a third installation as the negative control, against one self-hosted Room Server (Docker `node:24-alpine`, TLS with a private CA) on ngs-2. DMs both ways inside the literal `<untrusted_message version="1">` envelope; the trust matrix HELD a cross-machine message (`not_allowlisted`, body withheld) and then RELEASED it; broadcasts both ways; the viewer's freshness MEASURED (0.107 s same-machine, 0.217 s cross-machine with the measured clock offset); zero DM content in the rendered DOM; a browser-session recording, a screenshot, both vendor transcripts, and `scripts/rel1-verify-evidence.mjs` exiting 0 |
| 6.2 REL-3 — the formal soak | `33c7ec1` (harness) | `tests/soak/rel3-soak.mjs` (the long-runner) + `tests/soak/rel3-soak.test.mjs` (the compressed validation of the same runner). Attempt 1 PASSED against the now-superseded `7dc980f` (481.5 min, candidate-exact, zero loss over 22,625 messages, FD stable, final-window RSS pass). Attempt 2 FAILED the final-window RSS rule against `89c8477` — the advisor review's statistical refutation of my own "unlucky phase" explanation showed the real cause was host contention. Attempt 3 was stopped as void on a quiet host, and its flat RSS trace (90–117 MiB, no sawtooth) is the evidence for the contention diagnosis. **[PENDING]** the fresh 8-hour run against the final candidate |
| 6.3 Release packaging & client smoke tests | `865d42e` (the re-cut) | `docs/release-evidence/v0.2.0-candidate.json` — commit `6d6b45f`, version `0.2.0`, both package tree digests (portable `ad08240b…`, claude_code `fe4d2aaa…`, 46 files each), Node/SQLite versions, the validator identity, and all five gate rows green on the re-cut artifacts: deterministic materialization, the real `claude plugin validate --strict` (2.1.305, exit 0), the installed Claude Code smoke, the installed portable smoke, and SM-C1 (five fresh installs, zero failures, 0.460 s raw mean, 0.265 s adjusted against v0.1's 0.352 s anchor) |
| 6.4 Reconnect recovery — the explicit session takeover | `6d6b45f` | `tests/session-replacement.test.mjs` (19 rows) — the squat and its repair, the same-Actor grant, the foreign-Actor refusal, the intent's grammar, the wrong verb, the registry's own incumbent re-check, the failed-write ordering at both the registry and the API level, the late requests, no ping-pong, the durable claim row and the client's cursor file surviving a takeover, the real client's recovery carrying no intent, the authorization stage's fence, a named row pinning the known fence-placement gap, the orderly exit at both the API and the MCP child, and the operator command's three refusals. Spec: `docs/implementation/spec-6-4-reconnect-recovery-takeover.md` |

## The three re-cuts, and why

Three changes to **packaged runtime inputs** landed after the first candidate was
frozen, and the candidate-immutability law then did exactly what it exists to
do — void the candidate and restart the qualification:

1. **The viewer fix** (`web/app.js`) — the shipped viewer could never connect.
2. **The v0.2.0 version stamp** (`plugin.json`, `package.json`,
   `server/runtime.mjs`'s `APP_VERSION`) — applied BEFORE the re-cut, because
   stamping the release after the soak would have voided the candidate a
   second time. The advisor review of the re-cut caught that ordering trap
   before it cost another night.
3. **The Story 6.4 repair** (`server/`, `server/cli/`, `server/client/`) — the
   continuity defect the physical demonstration found.

The soak's identity proof refused each run with the drift named, rather than
silently soaking a different artifact. All five Story 6.3 gate rows pass
against the final artifact, and both package tree digests re-materialize
byte-identically.

**The first soak's PASS was not deleted and not relabelled.** It stays in git
history and in `docs/release-evidence/v0.2.0-soak-results.{json,md}` as that
artifact's record; the state record names it as superseded, and every failed or
voided attempt is kept under its own name in
`docs/release-evidence/v0.2.0-soak-attempts/`.

## What the physical demonstration proved

Two real machines, the public internet, TLS with a private CA and no
verification bypass on any agent-room client (the browser used a per-session
certificate-ignore flag because the demo CA is not in the OS trust store):

| Fact | Evidence |
|---|---|
| The Room Server ran in Docker on ngs-2 and was reachable at its public IP | `https://43.229.78.103:18444/health` → 200; the container's own record in `server.log` |
| Two vendor hosts on two machines enrolled over the wire | one-use invites minted on the server host, redeemed through the challenge/answer lane; distinct Ed25519 fingerprints `sha256:9c7848eb…` (Mac, Zcode) and `sha256:d371a6d7…` (staging, Claude Code); both machine preflights fully green |
| One realm across machines | realm `d50364b3…` and the same broadcast room `nblCruZASN1amIHyewDy2w` on both |
| Presence crosses the wire | the viewer's presence list showed `ZCODE-MAC-2` and `CLAUDE-STAGING-1` online at the SAME time, from the two machines |
| DMs cross the wire in BOTH directions | the pair room `8-tqanTN_jtsel8lOIkZgQ`: Mac→staging seq 1 and seq 3, staging→Mac seq 2 and seq 4, every foreign body inside the full `<untrusted_message version="1">` envelope |
| The trust matrix held a cross-machine message and then released it | the staging→Mac DM arrived HELD — metadata only, body withheld, `held_reason: not_allowlisted` — and arrived WITH its body after `room_trust_set`; the third installation stayed held on both sides, and the allowlist held exactly one fingerprint with `accept_all: false` |
| Broadcasts cross the wire | eight broadcast messages from three installations across two machines; the viewer's cursor read "caught up through #8" |
| The viewer's freshness is measured | 0.107 s (same-machine sender, no clock term) and 0.217 s (cross-machine sender, with the measured clock offset) against the 5 s bound — the method, the raw instants and the uncertainty are in `freshness.json` |
| The viewer excluded DMs | the whole rendered document was scanned: `dmLeak: null`, `dmLeakInWholeDom: false` |
| The continuity repair works in the deployment | the operator takeover recovered a squatted name on BOTH machines, and the live client re-bound on its next call |

## What the reviews found

- **The design round-table** (`docs/implementation/reviews/epic-6-lease-astra.md`)
  chose the repair shape and its five voices disagreed about whether the defect
  belonged to v0.2.0's scope; the facilitator's reading (FR-12 continuity is
  MVP scope) was taken.
- **The release-gate review** — two lanes, `epic-6-release-gate-codex.md`
  (`gpt-6.1-sol[ultra]`) and `epic-6-release-gate-agy.md`
  (`gemini-4-argon-high`) — was asked to judge the implementation and the
  evidence with the power to REFUSE the sign-off. Both refused the blanket
  "6.4 enforces every guarantee" claim, and both were right about the same
  structural gap: the authorization stage runs BEFORE the request body is
  read, so a request admitted before a handoff whose body was still streaming
  can still reach the handler (the codex lane executed that path, and also
  showed the fence's 1,000-entry retention can forget a still-admitted
  predecessor). Both approved the candidate bytes for v0.2.0 with the RECORD
  corrected — and the corrections were made: the freshness arithmetic (the
  clock-offset correction had been subtracted in the wrong direction; the
  cross-machine figure is 0.217 s, not ~0.00 s), the claim scopes (the
  DM-exclusion scan, the transcript provenance, the catch-up-versus-live
  distinction), the "three vendor hosts" wording (two vendor hosts, three
  installations), the spec's fence-placement and TTY claims, and the test
  suite's overstatement (deleting the fence had left every row green).
- **What the reviews also found in the release record** — and the record now
  says: the Claude-side transcript is an idempotent REPLAY verification of the
  original sends, not their first transmission; the viewer's seq 1–6 entered
  the DOM as the page's initial catch-up, and only seq 7–8 are live SSE
  arrivals; the Zcode agent ran the takeover ITSELF through a pseudo-TTY (the
  `isTTY` gate stops an accidental pipe, not a shell-capable agent); and
  `ZCODE-MAC-2` stayed squatted after three clean `zcode -p` exits, because
  the orderly-exit release loses the race against a host that kills the MCP
  child.

## Known limits at Epic 6 close

- **[PENDING] The endurance verdict for the final candidate.** The first run's
  PASS belongs to `7dc980f`; the fresh run is in flight.
- **The takeover's fence is checked before the request body is read** (retro
  A5), **its intent binds to whoever holds the name now rather than to an
  incumbent the operator observed** (A6), **its retention is bounded by a
  count** (A7), **the orderly-exit release loses the race against a host that
  kills the MCP child** (A8), and **a shutdown during the first bind is not
  covered** (A9). None is reachable in the feature's intended use — taking over
  a DEAD session — and all five are open work for the next release with the
  review's executed proofs.
- **The evidence verifier is a structural check**, not an adjudicator: it
  greps transcripts for substrings and checks that files exist; it does not
  recompute the freshness arithmetic, read the recording, or distinguish a
  first transmission from an idempotent replay (A10).
- **The demonstration was driven programmatically** (headless vendor CLIs,
  browser automation): the vendor HOSTS are real, with their own models and
  credentials; no person typed at a keyboard, and the recording is the browser
  session rather than an operator's desktop.
- **The packaged CHANGELOG cannot carry the 6.4 entry** without voiding the
  qualification — the release notes are the changelog for v0.2.0 (retro F8).
- **Automatic unattended crash recovery is not built** and is not promised:
  identifying the rightful successor process needs session-resume ownership
  evidence the Actor key alone cannot provide.
- The story-build workflow's unattended proof phases remain unproven through a
  third carry; every story in this epic was hand-looped.
