# Ruling request: five epic-structure decisions — you decide for the builder

The builder has delegated these five decisions to you. Rule on each. The builder adopts your rulings as-is unless they later override. Argue as a round-table first, then deliver a decision table — voices may dissent on the record, but a ruling must land for every item.

## Context to read (absolute paths)

- Epic structure under construction (Requirements Inventory + Negative Constraints + Release-Proof sections): `/Users/ngs/agent-skills/plugins/agent-room/docs/epics.md`
- PRD (final): `/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md` (esp. §6 Non-Goals, §8 metrics)
- Architecture spine (final): `/Users/ngs/agent-skills/plugins/agent-room/docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md`

## The proposed 6-epic structure (under review)

1. **Epic 1 — First Conversation** (local, DM-first): FR-1, 5, 6, 7, 8, 19, 20, 21 + all foundation (schema v2, core, HTTP API, middleware, local bootstrap) as ordered stories. Demo value: two agent clients on one machine DM each other with durable history.
2. **Epic 2 — Nothing Is Lost** (continuity): FR-11, 12, 13 + v1→v2 migration + stale-runtime recovery + kill-drill (REL-2).
3. **Epic 3 — Safe to Talk to Strangers** (client-side trust): FR-9 untrusted marking, FR-10 held messages + human approval CLI + allowlist (fingerprint-bound).
4. **Epic 4 — The Wider Room** (remote + governance): FR-2, 3, 4, 14, 15, 16, 17 (full), 22 + operator CLI. Server joins across machines/clients; invites, ban, rate gates.
5. **Epic 5 — Watch from Outside** (viewer): FR-18, cookie auth, live presence states.
6. **Epic 6 — Prove It & Ship**: REL-1 (two-machine/two-vendor demo), REL-2 drills, REL-3 soak, dual-package validate, client smoke tests.

Hard constraints (NOT open for relitigation): each epic must be standalone and enable later epics without requiring them; epics are user-value slices, not technical layers; DM-first (D14) is the product's primary surface; zero-dep Node ≥24.15; decisions D1–D19 and DR-1 stand.

## The five decisions to rule on

**Q1 — Epic order 2↔3.** Grumbal argues trust (3) should precede continuity (2) because the earliest unsafe ingestion default scars the product; others note 3 only needs to land before 4 (strangers), and 2↔3 share no dependencies, so either order is safe. Rule: keep 2→3, swap to 3→2, or declare it genuinely indifferent (and say what should break the tie).

**Q2 — Pull Epic 5 (viewer) earlier?** It depends only on Epic 1. Splinter notes its fifth position is planning convenience, not dependency. For a solo builder who will personally use the viewer to watch sessions work, earlier = daily-feedback value. Rule: keep at 5, or name the slot (after 1 / after 3 / after 4) and why.

**Q3 — Mid-Epic-1 demo checkpoint + post-Epic-4 dress rehearsal.** Dana wants a demonstrable "two sessions chatting" milestone inside Epic 1 before its remaining polish stories; Wildcard wants a local-only SM-1 dress rehearsal right after Epic 4 (two processes simulating two machines over real loopback) so integration holes surface before Epic 6. Rule: adopt both, one, or neither — and what each adopted item must include to avoid becoming theater.

**Q4 — validate --strict from Epic 1, and the anti-dumping-ground rule.** Level: `claude plugin validate --strict` is cheap and must run from Epic 1's first packaging story, not wait for Epic 6. Dana: Epic 6 must not become a QA dumping ground — REL-2 drill acceptance should live inside Epic 2's stories, soak pieces inside Epic 2/4 as appropriate, leaving Epic 6 as integration proof + packaging only. Rule: adopt/modify/reject each half.

**Q5 — Grumbal's rider: basic untrusted marking inside Epic 1.** Should Epic 1's messaging stories include the simplest honest version of FR-9 (every foreign-actor message wrapped in untrusted framing), with FR-9's full versioning/labeling rigor completed in Epic 3? Or does any FR-9 presence in Epic 1 create half-built safety theater? Rule precisely: what exactly ships in Epic 1, what waits for Epic 3.

## Output format

For each of Q1–Q5: the argument among your voices (they address each other, real disagreement permitted), then a **ruling** line. End with a summary decision table (Q# → ruling → dissenting voice(s) → the one-line reason). State plainly anything you could not verify.

Answer as a bmad-party-mode round-table. Cast 3-5 named voices with
distinct expertise and real disagreements. They address each other, not
me. Do not reconcile them into one recommendation.

John (PM), Sally (UX) and Grumbal (The Adversary) are mandatory; add others as the topic needs. You are deciding on the builder's behalf — rule crisply. You are advising in read-only mode: do not edit any files.
