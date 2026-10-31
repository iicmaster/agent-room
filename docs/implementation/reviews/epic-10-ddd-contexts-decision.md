# Epic 10 decision record — DDD bounded contexts (2026-11-01)

Inputs: the operator's directive ("ยืนยันตัวตน, ส่งข้อความ, แจ้งเตือน — ถ้าแยกแบบนี้ระบบจะเรียบง่ายขึ้นมาก"),
the brief (`epic-10-ddd-contexts-brief.md`), and two advisor round-tables
seated as the operator's own Anti-Consensus Club: codex `gpt-6.1-sol[ultra]`
(`.mailbox-out/ddd-contexts-codex`, identity matched) and agy
`gemini-3.8-flash-high` (`.mailbox-out/ddd-contexts-agy`, identity matched;
per the 2026-10-29 seat directive).

## Cross-vendor agreement (worth more than agreement inside one family)

1. **The three contexts are right as a working model.** Identity (enrollment,
   claims, sessions/liveness, bans, presence-as-projection), Messaging
   (rooms, membership, the durable log, pages — plus, on the CLIENT, the
   delivery policy), Notification (wake signals, hint outlets).
2. **Trust/allowlist/held = client-side delivery policy, not a server
   context.** The server has ZERO allowlist tables (verified: trust.mjs +
   held.mjs are client modules; the same fingerprint can be deliverable for
   installation A and held for B). `banned_actors` = Identity (server
   admission); presence = an Identity liveness read projection (the MCP tool
   name `room_presence` is the misnomer that made it look like Messaging).
3. **Quarantine the occupancy machinery inside Identity; do NOT retire it
   now.** DDD justifies moving rule OWNERS, not deleting rules. Retirement
   is a product decision (what does one alias with two live sessions mean?)
   — recorded as the operator's future call, with agy naming a candidate
   trigger (a v0.7 wire decision on stateless bearer sessions) and codex
   requiring the two-sessions-one-alias semantics decided first. The
   2026-11-01 freeze ruling stands.
4. **"One cursor authority" is rejected by both — and replaced with the
   real model:** there are THREE progress semantics, and they are
   legitimately different: consumed-through (the agent's read cursor —
   Messaging consumer state), observed/hinted (what the watcher has scanned
   and hinted — Notification's own), and the wait CLI's baseline. Collapsing
   them into one number either skips unread rows or re-wakes forever
   (Level's read-cursor=10 / notifier-saw-11 example). The wake substrate
   MAY share one page-scan/skip-own contract; the semantics stay separate.
5. **Held-row wake policy (the operator's open question): first contact
   wakes, repeats are cooled.** Both vendors converged: keep the first
   metadata hint from a stranger (the open-DM journey the operator defined
   the chat by), add a per-sender cooldown for untrusted senders' repeat
   wakes plus an aggregate installation wake budget (a per-sender gate alone
   does not stop N keys), state kept client-side only. NOT shipped in this
   decision — it is a behavior change awaiting the operator's word.
6. **Migration = C now, A (strangler) per slice when justified; B refused.**
   No three-directory split; wire protocol unchanged; the 674-test suite is
   the harness. First extraction candidates named: the wait overflow probe
   fix (below), then the shared page-scan for notifier+wait (when both call
   it with the same semantics), then the sender seam (send stops knowing
   occupancy details) before any bind move. agy adds: the SQLite store
   boundary (claims/enrolled vs messages) split at MODULE level even inside
   one database file.
7. **What the release notes may not claim** during any migration: "three
   cursors became one", "trust moved into Identity", "ghost/takeover
   retired", "TLC certifies the runtime", all-rooms wake coverage, wake as
   guaranteed delivery, notifier-on soak qualification (the FD corridor is
   still pull-only-calibrated).

## The cross-vendor conflict, resolved

agy's Killjoy proposed REMOVING the fence revalidation from the messaging
pipeline ("finish the check at the auth stage; handlers trust the
principal"). codex's Splinter refused: ownership and enforcement point are
different things, and the post-input recheck exists because Story 7.1
PROVED a pre-await check leaves a body-arrival window. **Resolution: the
codex position stands** — the shipped history is the evidence; the fence
stays exactly where it is, and Identity takes ownership of its
IMPLEMENTATION without moving the enforcement point. Recorded as the gap
that neither lane could have shown alone.

## The bug both advisors' review surfaced (and this decision ships)

**Confirmed static defect in the v0.6.0 wait CLI:** overflow rooms (the 7th+
room) were never actually head-checked — `holdMs: 0` made `holdForRoom`
return null at its `remaining <= 0` gate BEFORE issuing any request, while
the timeout hint claimed `unwatched: []`. Found by codex Level at
`server/cli/wait-commands.mjs:141-148` + `:404-408`. Fixed with a regression
test (the 7th room's unread foreign row must fire the hint) — the acceptance
both vendors stated: ≤ 6 concurrent long-polls, own-only pages never wake,
bodies never reach stdout.

## Corrections to `docs/statechart/findings.md` accepted

- The wake-fatigue rate math: the request budget is 120/min/key with burst
  10, but the SUSTAINED new-send refill is 0.5/s (30/min/key) — the "N×120
  wakes/min" line overstated it; wakes ∝ rows, not requests (idempotent
  retries create no rows).
- The three-cursor framing: three progress SEMANTICS, not three accidental
  copies of one number.

## Standing practice

Re-run the TLA+ wake model after any change to wait/notifier logic. The
model proves the ORDER rules of the modeled story — never timing, scale, or
runtime interleavings; findings.md keeps the honest evidence classes.
