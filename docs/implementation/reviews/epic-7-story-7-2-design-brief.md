# Story 7.2 design brief — the observed incumbent (A6) — dispatch 2026-10-29

You are READ-ONLY. You advise; you never edit, commit, push, or change any state in this repository. The one file you write is your outbox, at the exact path given at the end.

CONTEXT: agent-room v0.3, Epic 7. Stories 7.1 (total fence), 7.3 (signal-safe teardown), 7.4 (A2 refusal) are DONE. Story 7.4's refusal RELEASED this story's design hold. The recorded requirements (docs/epics.md Story 7.2; retro action A6; the executed finding in docs/implementation/reviews/epic-6-release-gate-codex.md; the design-gate amendments in epic-7-design-gate-{codex,agy}.md — Vex's same-Actor ticket confidentiality and the A→free→A generation question; codex gate John's ordering ruling):

- A takeover intent must bind to an OPAQUE conflict ticket tied to the authenticated Actor, the normalized Chat ID and the OBSERVED incumbent — never a bearer or a token digest — carried UNCHANGED to the takeover (never refreshed on retry), compared at execution against the CURRENT holder: a different incumbent is refused with a coded collision instead of being displaced.
- SAME-ACTOR CONFIDENTIALITY: a foreign Actor colliding with a held name gets the bare 409 chat_id_taken with NO ticket and NO incumbent metadata.
- This is a wire change with its own Architecture Spine amendment, the client confirmation flow amendment, and the flip of the test that currently lets two sequential takeovers both succeed (tests/session-replacement.test.mjs:264-287).

THE DRAFT DESIGN TO RULE ON (refine or refuse each point):
1. **Ticket form:** opaque random id (32 bytes, url-safe) stored SERVER-SIDE in a bounded in-memory map {ticket → {actorFingerprint, chatId, incumbentSessionKey, observedGeneration, issuedAt}}, single-use (burned on consumption), no durable persistence (a server restart voids outstanding tickets — the CLI then re-observes explicitly). Argue memory-vs-durable.
2. **Issuance:** any `POST /api/session` bind refused with 409 chat_id_taken gains a `conflict_ticket` + `observed_generation` in the error envelope's extras — ONLY when the holder's actorFingerprint equals the caller's. Foreign callers see exactly today's envelope.
3. **Occupancy identity:** a monotonic generation counter per chat_id in the live registry, bumped on every claim/transfer/release. The ticket pins the observed (incumbentSessionKey, generation). At execution the takeover proceeds only if the CURRENT (holder, generation) equals the observed pair — this makes A→release→A-rebind (same key, new occupancy) a refusal too, which the A→free→A question demands.
4. **Wire:** the takeover intent becomes `replace_existing: true, conflict_ticket: "<id>"`; a replace_existing WITHOUT a ticket is refused (400, invalid_request — the intent now REQUIRES an observation); a stale/expired/burned ticket is refused with a NEW coded error (`conflict_stale`, 409) — note the frozen wire vocabulary gains a code, which needs the Spine amendment + PUBLIC_ERRORS/PUBLIC_ERRORS_STATUS rows and the contract tests updated (the "frozen vocabularies gain nothing" rule is amended EXPLICITLY by this story's Spine amendment, additively, per A1 landing with the story).
5. **CLI:** `agent-room session replace` observes FIRST (binds nothing — it calls the API unauthenticated? NO — it authenticates as the installation, attempts the plain bind, receives the 409 + ticket, prompts the operator, then sends the intent WITH that ticket). A stale refusal ends the command with the coded reason; a retry is a NEW observation and a NEW prompt.
6. **Replay/theft:** a burned ticket's replay is refused (not in the map); a ticket plus a DIFFERENT Actor's authentication is refused at the actor check (the ticket is not a credential); theft without the Actor key is useless.
7. **Test flips:** the two-sequential-takeovers row becomes: the second takeover with the FIRST's ticket is refused `conflict_stale`; with its own fresh observation it succeeds. New rows: foreign-Actor collision carries no ticket; A→release→A reclaim makes the old ticket stale; ordinary reconnect binds carry no ticket and never refuse on its absence; the unauthenticated-observation question in (5) is settled.

RULE ON EACH POINT (pass/refine/refuse), then answer:
a) Does the execution-time comparison use (sessionKey, generation) or generation alone? Which survives the A→free→A case correctly?
b) Should the ticket observation REQUIRE authentication (i.e., can an unauthenticated caller ever receive a ticket)?
c) Error vocabulary: confirm `conflict_stale` as the new code and its status; anything else the frozen vocabulary needs?
d) Bounded-map eviction: tickets are short-lived — what TTL and what bound (the fence's lesson: never evict a ticket that can still be legally redeemed inside its own window)?
e) Anything that conflicts with prior recorded decisions (release-never-carries-intent; durable-claim-before-memory; the 7.1 fence; FR-15)?

MANDATE:
Answer as a bmad-party-mode round-table. Cast 3-5 named voices with distinct expertise and real disagreements. They address each other, not only me. Do not resolve the clash into consensus; where they cannot agree, say so and say why. End with each voice's own bottom line.
State plainly whatever you could not verify.

OUTPUT: write your complete round-table answer to .mailbox-out/__TASK_ID__ under the repository root. The FILE is the deliverable — a chat answer alone is not.
