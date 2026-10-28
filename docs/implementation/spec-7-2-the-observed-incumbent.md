---
title: 'The observed incumbent — A6 conflict ticket (design ratified by both vendors 2026-10-29)'
type: 'feature'
created: '2026-10-29'
status: 'in-progress'
baseline_revision: 'working-tree on 139d47e (stories 7.1/7.3/7.4 done)'
context:
  - '{project-root}/docs/epics.md (Story 7.2)'
  - '{project-root}/docs/implementation/reviews/epic-7-story-7-2-design-{codex,agy}.md (both verdicts, verbatim)'
  - '{project-root}/server/core/session-registry.mjs (transfer/claim/release/sweep — where generations live)'
  - '{project-root}/server/api/server.mjs (bindSession — issuance and redemption)'
problem: |
  A6: a takeover intent displaces whoever holds the name AT THE MOMENT it
  runs, not an incumbent the operator observed. The fix: an opaque conflict
  ticket bound to {authenticated Actor, normalized Chat ID, observed
  incumbentSessionKey, observedGeneration}, carried unchanged to the
  takeover, compared at execution — a moved incumbent is refused with a coded
  collision. Same-Actor confidentiality: foreign collisions get the bare
  legacy 409 with no ticket and no metadata.
design-of-record (both vendors agree unless noted; the executor's recorded
decisions on the two open splits are marked DECIDED):
  1. Ticket: opaque randomBytes(32) base64url; SERVER-SIDE IN-MEMORY map only
     (a restart voids every ticket — re-observe); single-use; burned
     synchronously on first VALID-scoped evaluation; wrong Actor/name never
     burns the rightful ticket; record {actorFingerprint, normalizedChatId,
     incumbentSessionKey, observedGeneration, deadline}.
  2. Issuance: only on a same-Actor 409 chat_id_taken, after the stages; the
     error envelope gains ONE extra `conflict_ticket`. NO observed_generation
     on the wire (DECIDED: codex's stricter ruling; agy allowed it as
     optional — dropping it satisfies both). Foreign collisions: today's
     bare envelope, byte-for-byte.
  3. Occupancy: a GLOBAL monotonic sequence allocator (DECIDED: codex's
     BigInt sequence over agy's per-chat map — same comparisons, no
     unbounded per-name map). Every effective occupancy transition
     (claim/transfer/release/sweep-expiry/rename-away) stamps the next
     sequence value; continuous-tenure refreshes (idempotent same-key
     rebind, display-case rename) do NOT advance it. Execution compares the
     PAIR (incumbentSessionKey, generation) under the same live lease
     semantics the commit uses — a free name is a refusal, never a fallback
     claim.
  4. Wire: `replace_existing: true` REQUIRES `conflict_ticket` (missing/
     malformed → 400 invalid_request); a ticket WITHOUT the intent → 400;
     unknown/expired/consumed/pair-mismatch → NEW code `conflict_stale`
     (409, one code for all six stale shapes — no sub-state leaks);
     PATCH/DELETE reject the field (unknown_field). The frozen vocabulary
     gains exactly {code conflict_stale} + {field conflict_ticket} via this
     story's EXPLICIT additive Spine amendment; contract tests updated
     (A1: packaged docs land with the story).
  5. Observation flow (DECIDED — the codex room split, resolved by the agy
     refinement of John's path): authenticate → plain POST bind →
     409+ticket → prompt y/N → POST intent with THAT ticket → DELETE the
     CLI session as today. Foreign bare 409 → abort immediately. Name FREE
     (200) → DELETE the CLI session immediately, report
     replaced:false/released:true truthfully, NEVER prompt on a free name
     (Sally's amendment). The command's help and README disclose that a
     free-name observation claims-and-releases the CLI session's own name —
     never claim "binds nothing". conflict_stale ends the command; a retry
     is a NEW observation and a NEW prompt; transport failure reports
     outcome unknown, no blind retry.
  6. TTL/bounds (DECIDED on the recorded split): CONFLICT_TICKET_TTL_MS =
     120_000 (codex Winston/Vex's exposure budget; the CAS makes staleness
     safe, and shorter exposure is the security-default), global cap 4_096,
     per-Actor cap 64, PLUS agy's per-(Actor, chatId) slotting: re-observing
     the same pair REPLACES that pair's outstanding unconsumed ticket (so
     per-name churn cannot grow the map), and a full map refuses NEW
     issuance with the existing rate_limited 429 + retry_after_ms — never
     FIFO-evicting an unexpired ticket of another pair (the fence's lesson).
  7. Tests: flip the two-sequential-takeovers row into the
     two-independent-observations proof (B redeems TB against A; C's
     unspent TC → conflict_stale; C re-observes B → succeeds); plus the
     five proof groups from the codex record (occupancy CAS incl.
     A→release→same-key-A and rename/lease paths; confidentiality;
     wire/compatibility; ticket lifetime/atomicity incl. persist-failure;
     CLI observe-first flows).
