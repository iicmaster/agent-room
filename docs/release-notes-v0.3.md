# Agent Room v0.3 — Release Notes (Release Candidate)

Status: **release candidate, re-cut twice** (`docs/release-evidence/v0.3.0-candidate.json`,
commit `a0c345f`, portable digest `f680085e…`, claude_code digest `657c02d4…`,
47 files each, `claude plugin validate --strict` clean). The first two-vendor
release gate refused the initial cut (its findings — an unbounded history
map, a missed runtime version stamp, and upgrade-text gaps — are repaired
in this re-cut; both verdicts archived); the confirmation round on this
candidate is the last gate before tagging.

v0.3 is **the session authority, hardened** — every defect the v0.2 release
gates executed or recorded is repaired at the root or carries a recorded
disposition, plus the two instrument debts. No new features; no new external
dependencies; Node ≥ 24.15.

## The takeover names the holder you saw (A6 — the observed incumbent)

v0.2.0's takeover displaced whoever held the name at the moment it landed.
Now a plain bind that collides with a LIVE session of your own Actor is
refused with an opaque, single-use **conflict ticket**; `agent-room session
replace` observes first, prompts only against a real incumbent, and the
takeover presents that ticket. If the holder changed while you were reading
the prompt — anyone else took the name, the name went free even briefly, or
the same key re-claimed it after a release — the takeover is refused with
the coded `conflict_stale`, and re-running observes the new holder. A
foreign Actor's collision keeps the bare legacy refusal and learns nothing.

**Wire change (deliberate, dated in the Architecture Spine):**
`replace_existing: true` now REQUIRES `conflict_ticket` — v0.2.0 clients
sending the blind shape get a 400 `invalid_request`.

## The fence is total (A5 + A7)

A request the takeover displaced is refused whether its body arrives before
or after the handoff (the post-input revalidation, synchronous before the
handler); the displaced session's fence entry survives while any of its
requests can still be in flight (request-counted retention — no number of
takeovers can forget a still-admitted predecessor); a displaced long-poll
stops at its next wake. Every shipped comment and doc now states exactly
this behavior.

## Teardown that lets go (A8 + A9)

SIGTERM, SIGINT, stdin close, and programmatic close all join ONE bounded
shutdown (a 2,000 ms total wall-clock budget) that releases the Chat ID
before the process exits — a one-shot vendor CLI no longer leaves its name
reserved behind the kill race. A shutdown during the very first bind is
coordinated and rolled back; a release that cannot complete is recorded
(`release_failed` / `timeout`) and the process still exits inside the bound.
SIGKILL, OOM kills, and power loss remain honestly outside any teardown
path's reach — the explicit takeover is the recovery for those.

## Automatic recovery: answered with a recorded refusal (A2)

The design round-table refused all four candidate mechanisms — the
strongest of them (a kernel-enforced liveness probe) on primary-source
evidence: `ECONNREFUSED` is not a death certificate on macOS (a LIVE
listener can return it). The supported recovery remains the explicit
takeover; narrow prior delegation to a named supervisor is recorded as a
possible future policy, not ratified.

## Instruments that recompute (A4 + A10); the heap, dispositioned (A11)

The REL-1 flight kit now has ONE freshness observer (`scripts/rel1-freshness-observe.mjs`)
— and the evidence verifier RECOMPUTES the captured arithmetic and parses
the recording's own container bytes instead of grepping. The v0.2 soak's
"rising 0.65%/h" retained-state reading is dispositioned from the archived
trace: below the instrument's own resolution (core slope 0.00 %/h, endpoint
never moves a display bucket, the 9.2-MiB mode held for nine-plus hours) —
a recorded non-defect, with the threshold calibrated for the next trace.

## Upgrading from v0.2.0 — a coordinated server+client step

- Data and rooms are untouched: same schema, same realm, same durable claims.
- **Upgrade the SERVER first and restart it** (the local daemon or the
  remote server): a v0.3 client whose takeover observation reaches a v0.2
  server sees the bare `chat_id_taken` (the v0.2 server never issues
  tickets) and reads it as a foreign holder — the versions must move
  together. Verify the serving version with `GET /health` before switching
  clients.
- If you scripted the takeover API: add the two-step (observe → present the
  ticket); the blind shape is a 400. A server restart voids outstanding
  observations — re-observe after any restart.
- The full changelog: `CHANGELOG.md` (0.3.0 - 2026-10-29).
