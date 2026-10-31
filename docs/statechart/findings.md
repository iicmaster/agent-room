# Statechart findings — what TLC did and did not prove (2026-11-01)

The statechart run (`chart.mmd`, `report.md` — 134 states, 5/5 rules hold)
proves the ORDER properties of the modeled story. It does not prove safety.
This file records what the party analysis found across the model's edges,
with the evidence class of each finding.

## Proven in the model (order rules — TLC, 134 states)

- `NoBodyWithoutTrust` — a held row delivers metadata only; bodies arrive
  only through allow-all, together with the trust they need.
- `WokenIsForSomeoneElse` — every wake has an unread foreign row behind it.
  This is the regression proof of the issue #4 fix: the v0.5.0 behavior
  (waking on own sends) violates it by construction.
- `ForeignHolderNeverDisplaced` — no action of this installation's moves a
  foreign-held name back to "you", and the watcher never arms over a name
  this installation does not hold.
- `CursorMonotonic` — the read cursor never rewinds; catch-ups are exact.
- `NoDeadlock` — the room is a genuine open loop; every state has a step out.

## Demonstrated live (production realm, 2026-10-31)

1. **The wake channel has no trust gate.** An untrusted sender's rows are
   held — and the rows still wake every armed watcher. mcop-coo's two held
   test rows fired the wait twice, delivering nothing consumable. The rate
   gates cap REQUESTS (120/min/key, burst 10 — sustained new-send refill
   0.5/s ≈ 30 rows/min/key; idempotent retries create no rows), not WAKES;
   wakes ∝ rows. N malicious enrolled keys produce N×30 rows/min sustained —
   an earlier "N×120 wakes/min" line in this file overstated the rate and
   was corrected after the 2026-11-01 advisory review. Worst case remains
   alarm fatigue: agents learn to ignore wakes, and the whole wake channel
   degrades. (Decision 2026-11-01, pending the operator's word: first
   contact wakes, per-sender cooldown on untrusted repeats + an aggregate
   installation wake budget — see
   docs/implementation/reviews/epic-10-ddd-contexts-decision.md.)
2. **Re-arm-without-read is an instant re-wake loop.** The wait CLI's
   baseline is the read cursor; re-arming without consuming fires again
   immediately (the 141 ms fires). The model draws this arrow as legal —
   it is; the cost is invisible to a model without time.
3. **The v0.6.0 overflow head-check never ran (found by the advisory
   review, fixed the same day).** Rooms beyond the six held ones were
   supposed to be head-checked (`wait_ms=0`) once per cycle; instead
   `holdForRoom`'s deadline gate returned null before issuing any request,
   so a 7th room's unread rows never fired and the timeout hint claimed
   `unwatched: []`. Fixed with a red→green regression row (a backlog in
   the 7th room must hint on the first cycle); a row landing mid-cycle is
   found one cycle later (~20 s) — that latency is documented, not part of
   the defect.

## Design constraints the chart made visible

3. **Names have no owner.** Claims are first-come-first-served; a squatter
   who claims an established name cannot read the rooms or send as the
   owner (membership and attribution are fingerprint-bound — the trust
   matrix holds), but DM addressing by name becomes `ambiguous_chat_id`
   and every peer must disambiguate by fingerprint. Blast radius:
   addressability confusion, not impersonation, not room theft.
4. **The model's foreign-holder states overstate the damage** (the party's
   correction to its own chart): a foreign claim on the name does NOT take
   the rooms — it takes unambiguous addressing. The chart reads worse than
   reality; the reality reads worse than a user expects.

## Outside the model (where real bugs could still live)

5. **Time is erased**: session leases outliving dead processes (the ghost
   holder — the entire Epic 7 recovery story: fence, observed incumbent,
   120 s conflict tickets), the 20 s holds, 600 ms notifier spacing,
   600 s wait deadlines. An invariant analysis of those needs a timed model.
6. **Scale**: past 20 rooms, DMs quiet for 24 h are unwatched — a message
   there produces no wake (documented limit, still a hole in the wake
   promise). Multi-room dynamics and partial reads (page ≤ 200) are atomic
   in the model.
7. **Three read positions** now exist per installation (MCP adapter's
   in-memory cursor merged over the file, the notifier's per-room cursor,
   the wait CLI's file-only baseline). The 2026-11-01 advisory review
   corrected the framing: these are three PROGRESS SEMANTICS — consumed
   (the agent's read), observed (what the watcher scanned), waited-from —
   which are legitimately different numbers, not three accidental copies of
   one value; collapsing them either skips unread rows or re-wakes forever.
   What they lack is a stated contract (who stores cross-process state,
   what wins on disk/memory disagreement). The wait CLI can still hint on
   rows the adapter already consumed (stale-file duplicate wake) — hard to
   reach, low blast radius, unproven either way.

## Decisions taken and open

- Open (business): should a held row wake? Today yes (the v1 "signal on the
  bus" ruling); the counter-proposal is a per-sender wake cooldown, which
  keeps the signal and removes the fatigue. The alternative (no wake on
  held rows) silences exactly the "a stranger DMs us" case the operator
  defined the chat by.
- Standing practice: re-run this spec (`AgentRoom.tla` + `view.mjs`) after
  any change to the wait/notifier wake logic — ~30 s per run proves the
  wake rules still hold.
