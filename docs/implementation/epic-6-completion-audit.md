# Epic 6 Completion Audit — Ship It

Date: 2026-10-20 · Commit range `247681c` (post-Epic-5) → `d96b491` · Suite: **554 tests** · AC sweep: **clean** (3 stories, 5 criteria, 11 evidence pointers)

> **Status: the audit below is written against the re-cut candidate while the
> replacement soak is still running.** The soak's verdict and the REL-1 human
> demonstration are the two open gates; every other line here is settled by
> evidence that exists today. The sections marked **[PENDING]** are the ones
> that wait for those two results.

## Verdict

**Epic 6 is not yet complete — it is one gate short and one gate running.** The
release candidate is frozen, validated, and reproducible; the shipped artifact
was proven against three real agent hosts on one machine and against two real
machines over the public internet; the viewer bug that the cross-machine run
exposed is fixed with a regression test that runs the shipped script. What
remains is the endurance verdict against the re-cut candidate (running now) and
the operator's physical REL-1 demonstration with the real Zcode host.

**A real defect was found and fixed inside this epic.** The cross-machine
demonstration showed the shipped web viewer reporting "Room server unreachable"
on every load against a healthy server: the client half read the boot
descriptor at the wrong level of the API's `{ok, result}` envelope. Nothing in
the suite ran the shipped `web/app.js`, so the mismatch survived the whole
viewer epic. The fix (`cc7eb6e`) and its regression test
(`tests/viewer-app.test.mjs`) are the most consequential changes in this epic —
more consequential than any story that was planned.

## Story ledger

| Story | Commit | Proof |
|---|---|---|
| 6.3 release packaging & client smoke tests | `48bbf0d`, re-cut `2c9cfe7` | `tests/release-smoke.test.mjs` (5 rows) — deterministic dual-package materialization (byte-identical tree digests, reproducible forever), the real `claude plugin validate --strict` on the materialized artifact, both claimed clients INSTALLING the materialized package and completing a full DM round-trip through the installed entrypoint, and SM-C1 re-measured across five fresh installs (zero failures; the choice-priced-out ladder at 0.318 s mean, below v0.1's 0.352 s anchor) |
| 6.2 REL-3 — the formal soak | `33c7ec1` (harness), first run `3aec7ed` | `tests/soak/rel3-soak.mjs` (a long-runner, deliberately not a node:test file) + `tests/soak/rel3-soak.test.mjs` (the compressed validation of the same runner). The first 8-hour run PASSED against candidate `7dc980f`: 481.5 min tracked, candidate-exact, zero loss over 22,625 messages, FD stable, final-window RSS pass, 47 bursts, 7 reconnect cycles, 481 samples. **[PENDING]** the re-run against the re-cut candidate `89c8477` |
| 6.1 REL-1 — the cross-everything demonstration | `33c7ec1` (flight kit), `d96b491` (evidence) | `scripts/rel1-preflight.mjs`, `docs/rel1-runbook.md`, `scripts/rel1-verify-evidence.mjs` — the operator's kit, hand-verified against real fixtures. Plus a REAL two-machine run in `docs/release-evidence/v0.2.0-cross-machine/`. **[PENDING]** the operator's physical demo with the real Zcode host and the recorded session |

## The re-cut, and why

Two changes to **packaged runtime inputs** landed after the first candidate was
frozen, and the candidate-immutability law then did exactly what it exists to do:

1. **The viewer fix** (`web/app.js`) — the shipped viewer could never connect.
2. **The v0.2.0 version stamp** (`plugin.json`, `package.json`,
   `server/runtime.mjs`'s `APP_VERSION`).

The soak's identity proof refused the run with the drift named, rather than
silently soaking a different artifact. The candidate was re-cut once, at
`89c8477`, with **both** changes folded in first: the version stamp was applied
BEFORE the re-cut precisely so that stamping the release would not void the
candidate a second time — the advisor review of the re-cut caught that ordering
trap before it cost another night. All five Story 6.3 gate rows pass against
the re-cut artifact, and both package tree digests re-materialize byte-identically.

**The first soak's PASS was not deleted and not relabelled.** It stays in git
history and in `docs/release-evidence/v0.2.0-soak-results.{json,md}` as that
artifact's record, and the state record names it as superseded.

## What the cross-machine run proved

Three real machines, the public internet, TLS with a private CA and no
verification bypass on any client:

| Fact | Evidence |
|---|---|
| The Room Server ran in Docker on ngs-2 (Ubuntu) and was reachable at its public IP | `https://43.229.78.103:18443/health` → 200; the container's own runtime record |
| Two clients on two other machines enrolled over the wire | one-use invites minted on the server host, redeemed through the challenge/answer lane; distinct Ed25519 fingerprints `sha256:fd512406…` (Mac) and `sha256:7dd9617b…` (staging) |
| One realm across machines | both clients' `room_status` returned realm `5e8240d3…` and the same broadcast room |
| Presence crosses the wire | `room_presence` listed both clients as online, `client_type: mcp` |
| DMs cross the wire in BOTH directions | the same pair room `faldgKkz…`, seq 1 Mac→staging and seq 2 staging→Mac, both `status: committed`; the receiving side read the body inside the full `<untrusted_message version="1">` envelope naming the sender's chat id and fingerprint |
| The trust matrix held a cross-machine message | the first staging→Mac message arrived HELD — metadata only, body withheld, `reason: not_allowlisted` — and arrived WITH its body after `room_trust_set` added the fingerprint |
| Broadcasts cross the wire | four broadcast messages, two from each machine |
| The viewer excluded DMs | the browser's rendered page contained zero DM content (`dmLeak: null`) |
| The authenticated viewer was live | presence updating in the browser, a newly sent broadcast visible 3.87 s after the send (REL-1's rule is 5 s) |

## What the reviews found

- **The advisor review of the re-cut** (`docs/implementation/reviews/` — the
  round-table archived with this audit) caught the version-stamp ordering trap:
  the release notes had deferred the stamp to the closeout, which would have
  voided the candidate a second time. It also corrected the scope of the
  old soak's PASS — the server-endurance evidence is technically sound for the
  unchanged server bytes, but it does not qualify the changed package.
- **The packaged-viewer preflight** the same review asked for was run BEFORE
  the replacement soak: the materialized candidate's viewer, in a real browser,
  reached `Live` on the first load after the cookie, presence listed the
  enrolled client, a broadcast rendered, and no DM content appeared. Against the
  previous candidate the same page reported unreachable on every load — which is
  how the bug was found in the first place.
- **Two suite failures are load-sensitive, not regressions** — the churn
  memory-pass and the SM-C1 re-measurement both pass when run alone and fail
  under the parallel suite's load. That diagnosis is stated, not hidden, and the
  SM-C1 numbers in the candidate record are from a quiet-machine run (the
  loaded run is recorded beside it).

## Known limits at Epic 6 close

- **[PENDING] The endurance verdict for the re-cut candidate.** The first run's
  PASS belongs to `7dc980f`.
- **[PENDING] The physical REL-1 demonstration with the real Zcode host**, the
  recorded session, and the REL-1 evidence bundle's own verifier
  (`scripts/rel1-verify-evidence.mjs`) — the operator's step, over two physical
  machines, on the re-cut candidate.
- The cross-machine run's two clients were **Claude Code and Codex**, not the
  named Claude Code + Zcode pair: Zcode has no CLI on either remote host. The
  vendor-neutrality claim is proven across three real vendors (Claude Code,
  Codex, Gemini) on one machine and across two vendors on two machines; the
  Zcode host itself remains REL-1's evidence.
- The browser in the cross-machine run used a per-session certificate-ignore
  flag (the demo CA is not in the OS trust store). Every agent-room **client**
  used the real CA with full verification; the flag touched the browser only.
- The staging client was driven by that host's own 9Router (a local model seat),
  not a cloud model: the vendor host, the MCP path, and the wire are real; the
  model is local to that machine.
- No screen recording exists for the cross-machine run — its evidence is the
  two client transcripts, the browser screenshots, and the server's own durable
  state.
- The story-build workflow's unattended proof phases (8–10) remain unproven
  through a third carry; every story in this epic was hand-looped.
