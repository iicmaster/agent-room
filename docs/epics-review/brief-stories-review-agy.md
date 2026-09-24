# Review request: complete story breakdown (33 stories, 6 epics) — review on the builder's behalf

The builder has delegated this review to you. You are the acceptance gate for the complete epic-and-story breakdown before it goes to development.

## What to read (absolute paths)

- The document under review: `/Users/ngs/agent-skills/plugins/agent-room/docs/epics.md` — read it ALL: Requirements Inventory, Decision Register, Negative Constraints, Release-Proof Requirements, FR Coverage Map, Epic List, and every story section (Epic 1: Stories 1.1–1.9 · Epic 2: 2.1–2.5 · Epic 3: 3.1–3.5 · Epic 4: 4.1–4.8 · Epic 5: 5.1–5.3 · Epic 6: 6.1–6.3)
- Authority sources: PRD `/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md` · spine `/Users/ngs/agent-skills/plugins/agent-room/docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md` · decisions D1–D19 in `/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/addendum.md` · binding epic rulings `/Users/ngs/agent-skills/plugins/agent-room/docs/epics-review/ruling-structure-agy.md`

## What to check (severity-ranked findings, cite story IDs)

1. **Template compliance** — every story has As a/I want/So that + Given/When/Then ACs that are independently testable.
2. **Sizing & dependency order** — each story completable by ONE dev agent; no story depends on a later story in its epic; tables/entities created only when the story needs them.
3. **Coverage completeness** — walk every FR (1–22), AR (1–17), HCI (1–5), REL (1–5), and the ruling-mandated gates: is each covered by ≥1 story with REAL acceptance criteria (not a mention)? Flag nominal coverage. Specifically verify: untrusted envelope in 1.7 and frozen-schema rule; checkpoint contract 1.8 (zero mocks, real processes); blocking REL-2 drill 2.5; migration idempotency 2.3; FR-10 decomposed ≥4 stories (3.1–3.4) per the inventory note; the FR-10+FR-20+AR-12 end-to-end test 3.5; dress-rehearsal contract 4.8 (no local-auth bypass, full governance flow, ban verified); validate-from-Epic-1 (1.9); Epic 6 contains zero deferred component QA.
4. **AC quality** — edge/error conditions present where the sources demand them (collision refusal, ambiguous_chat_id, outcome_unknown retry, storage_low, ban latency bound, cookie-not-query-string, inert rendering, plaintext-refused).
5. **Anything harmful** — a story that, if built as written, violates an AD, a Non-Goal, or the DM-first ordering; scope creep beyond Negative Constraints.

## Output

Full review as your final answer (captured to an outbox). Per-epic verdict (safe / fix-first) + severity-ranked findings citing story IDs, then each voice's bottom line on: "safe to hand to dev agents?"

Answer as a bmad-party-mode round-table. Cast 3-5 named voices with
distinct expertise and real disagreements. They address each other, not
only me. Do not resolve the clash into consensus; where they cannot
agree, say so and say why. End with each voice's own bottom line.
State plainly whatever you could not verify.

You are advising in read-only mode: do not edit any files.
