# Story 4-5 Audit — codex-advisor[luna] (gpt-6-luna[max])

# Verdict
FIX-FIRST

# Findings
- [medium] A configured actor budget can return rate_limited before the ban authorization stage, so the contract's unconditional banned-at-next-request response is not guaranteed.
  Evidence: the frozen order places budgets before authz at server/api/pipeline.mjs:26-32 and assemblePipeline constructs them in that order at :451-465. BudgetStage returns rate_limited on an exhausted actor request bucket at :319-329 and on an exhausted new-send bucket at :371-376; runPipeline stops at the first rejection at :568-580. startServer creates both default rate gates at server/api/server.mjs:1123-1135 and passes them to each request at :1253-1257. The ban check is later at server/api/pipeline.mjs:406-415. The acceptance requires banned on every send/read at next request at docs/epics.md:492 and the spec at :30, :45.
  Why: if the actor's request budget is empty, or the send bucket is empty for a new send, the next valid request receives 429 rate_limited before the registry is read. It does not reach a handler, but it violates the specified banned 403 response. The ban tests deliberately widen both gates at tests/ban.test.mjs:67-76, so they cannot expose this case.

- [medium] The spec contradicts itself about whether the ban reason is displayed.
  Evidence: the Never clause bars a ban-reason display surface at docs/implementation/spec-4-5-ban-by-identity-key.md:34, while matrix row 13 requires the successful ban JSON to carry reason at :52. The implementation returns reason in the CLI response at server/cli/ban-commands.mjs:62-74; tests assert that field at tests/ban.test.mjs:728-739. The operator help says the free-text reason is shown to no one but the store at server/cli/agent-room.mjs:357-359.
  Why: the backfill record cannot simultaneously promise no reason display and require the ban command to display the stored reason. A re-ban without a reason also returns the prior stored reason. Clarify the intended meaning before treating this contract as internally consistent.

- [medium] Several matrix assertions do not pin the outcomes they claim to cover.
  Evidence: row 2 only matches error messages and never asserts error.code at tests/ban.test.mjs:354-363; row 4 does not inspect PRAGMA user_version at :385-410; row 5 tests the no-store pass-through and banned key but never runs an unbanned session fingerprint at :414-452; row 10 checks the banned reattach response but not invite uses_remaining after it at :588-616; row 13 counts one stdout line for ban but not unban and has no CLI refusal/exit-1 assertion at :724-773; row 15 checks the regex's sample values but does not pin that the CLI, SQLite CHECK, and session principal use the same shape at :802-810. Current implementation source supports these behaviors, but the listed tests can remain green if those claims regress.
  Why: these are explicit matrix outcomes, including coded errors, no-version-bump, unbanned pass-through, no consumption on reattach, CLI output grammar, and the one-pattern rule. The assertion gaps leave the backfill's claimed test coverage incomplete.

- [low] The tests establish that banned_at parses as a date, not that it is canonical ISO 8601 or uses the injectable clock.
  Evidence: tests/ban.test.mjs:324, :738, and :719 use Date.parse only. server/store/bans.mjs:84-86 exposes now; :110-119 normalizes toISOString, but no ban test injects a fixed clock or compares the canonical output.
  Why: the implementation currently normalizes the timestamp, but the matrix's stronger timestamp guarantee is not regression-pinned.

# Checks
Scope and evidence boundary: HEAD is 7bd14385190dd96a06b6e760643fc979cec4be31. git status showed the spine modified and the backfill spec plus the supplied audit brief untracked; git diff --name-only against HEAD returned only docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md. No other reviews or outboxes were read. The focused test command was not run in this audit; this is direct source and test inspection. The spec records a planning-time 13-pass run at :112, which is not an execution in this audit.

1 — FINDING F-1, F-2, F-3, F-4; clause-by-clause intent and matrix review.

Intent, spec :24-26: PASS for the reserved seams and backfill premise. The authz stage retains structural pass-through when there is no ban surface (server/api/pipeline.mjs:398-415; tests/ban.test.mjs:419-428); banned is already named in SEND_STATUSES and registered as a public 403 at server/constants.mjs:186-204, :313-316; the ban family joins the Story 4.2 host through the existing import/dispatch/printer at server/cli/agent-room.mjs:122, :574-594; store and server restart persistence are exercised at tests/ban.test.mjs:366-383, :639-720. The claim that every next actor request answers banned is subject to F-1.

Always, spec :30: source PASS with F-1/F-3 qualifications. The row key is validated by the constants pattern in server/store/bans.mjs:29-33, :66-70; the STRICT primary-key table check has no enrollment foreign key at :44-54; fingerprints are derived from the raw public key at server/keys.mjs:39-49 and session issue/verify retains only a validated actor fingerprint at server/api/session.mjs:61-84, :120-130. Authz reads context.session.actorFingerprint, never a request field, and only for actor routes at server/api/pipeline.mjs:401-415. The gate performs a primary-key SELECT on its store connection at server/store/bans.mjs:153-168; CLI opens and closes its own store at server/cli/ban-commands.mjs:35-45. Enrollment derives the fingerprint and checks it after proof, before reattach or consumption, inside the transaction at server/store/invites.mjs:295-318, :319-336. Challenge and local credential exchange are pre-auth routes at server/api/routes.mjs:90-100; AuthzStage skips non-actor classes at server/api/pipeline.mjs:406-409. A banned client's local exchange succeeds after restart while later actor routes refuse at tests/ban.test.mjs:670-712. Long-poll checks each loop at server/api/server.mjs:731-738, then sleeps at most LONGPOLL_POLL_INTERVAL_MS and clamps to remaining time at :745-759; constants are READ_HOLD_MAX_MS=20000 at server/constants.mjs:15 and LONGPOLL_POLL_INTERVAL_MS=250 at :503. Each ban/unban write uses the store transaction runner at server/store/bans.mjs:121-150; insert-do-nothing preserves the first timestamp/reason at :121-134; unban reports removed truthfully at :142-150; reason validation/default is at :103-108 and row-1 tests cover NULL and first-write behavior at tests/ban.test.mjs:328-350. Additive table creation and column verification are at server/store/room-log.mjs:793-816, :977-998, without changing the existing schema version. CLI grammar and shared fingerprint gate are at server/cli/ban-commands.mjs:26, :47-61, :78-99, :107-157, with host exit handling at server/cli/agent-room.mjs:582-594. Clock normalization is present in bans.mjs:84-119; its assertion gap is F-4.

Block If, spec :32: PASS for handler refusal, live next-request visibility, long-poll bound/no connection kill, post-proof enrollment refusal, wrong-proof non-disclosure, canonical identity, additive schema, no operator HTTP surface/actor argument, no automatic ban path, and first-write idempotence. Evidence: authz and route scoping at server/api/pipeline.mjs:406-415; real CLI-child write and live server-child refusal at tests/ban.test.mjs:639-660; poll loop/sleep at server/api/server.mjs:731-759 and test at tests/ban.test.mjs:504-535; enrollment order at server/store/invites.mjs:303-336 and proof tests at tests/ban.test.mjs:537-617; schema at server/store/room-log.mjs:793-816; only CLI ban routes at server/cli/agent-room.mjs:574-594; operator-only writes at server/cli/ban-commands.mjs:7-13. F-1 is specifically an error-code precedence failure, not a handler bypass.

Never, spec :34: PASS for no cache, no viewer/health/pre-auth stage gate, no local-auth ban gate, no list command/API wire field, no FK, no added fingerprint/status/timing constants, and no skipped/only/todo tests. The ban-reason display clause conflicts with matrix row 13 and the shipped CLI output (F-2). The constants and status remain centralized at server/constants.mjs:138-146, :186-204, :313-316, :500-503. The static scan found 13 test declarations and no skip/only/todo match.

I/O matrix, spec :40-54:
1. PASS behavior: preemptive write, first timestamp/reason, honest removed true/false, pure read, and NULL reason are asserted at tests/ban.test.mjs:316-350; timestamp strength is F-4.
2. FINDING F-3: malformed key/reason cases are present at :354-362, but only message regexes are asserted, not invalid_actor_id/invalid_request codes.
3. PASS: store close/reopen preserves both ban and unban at :366-383.
4. FINDING F-3: missing-table convergence and database_schema_invalid divergence are asserted at :389-409; unchanged user_version is not asserted.
5. FINDING F-3: banned 403 and no-store structural pass-through are asserted at :419-451; the unbanned actor branch is not run.
6. PASS for route behavior/history/peer isolation at :456-502. This test's runCli and startTestServer helpers are in-process at :105-131 and :204-218; the actual child-process visibility requirement is separately and genuinely proved by row 12 at :639-660.
7. PASS for mid-hold termination inside the 20 s window, under 5 s, and immediate admission refusal at :504-535; implementation's 250 ms wake and deadline clamp are at server/api/server.mjs:754-759.
8. PASS: preemptive ban, proof, 403, unchanged invite uses, and no enrollment row at tests/ban.test.mjs:537-568.
9. PASS: wrong-key signature for a banned fingerprint answers signature_invalid at :569-587.
10. FINDING F-3: banned reattach is refused at :588-616, but uses_remaining is not checked after the refused retry.
11. PASS: send/read work again after unban at :619-635.
12. PASS: real server and CLI children, live next-request refusal, SIGKILL, same-directory respawn, successful local exchange, later bind/status/send/read refusals, and read-only on-disk row inspection at :639-720. The child helpers use spawn at :137-161 and :267-306; disk inspection opens read-only at :163-179.
13. FINDING F-3: ban stdout is checked for one JSON line at :728-739 and ban/re-ban/unban state at :741-766; unban line count and refusal exit code 1 are not asserted. Both help entries are asserted at :768-772.
14. PASS: nine malformed argv cases assert exit 2, empty stdout, one coded stderr line, and no row at :775-800.
15. FINDING F-3: the constants regex rejects uppercase examples at :802-810, but this test does not pin the CLI/DDL/session linkage. Source imports/use are consistent: bans.mjs:29-33, :50-53, :66-68; ban-commands.mjs:26, :51, :82; session.mjs:61-67; the tests do not assert that cross-surface relation.

2 — FINDING F-1/F-2; the authored spine amendment.

The tracked diff contains only the AD-5 Rule line at spine:73. The diff command showed the old line replaced with its original bytes plus one appended amendment; a direct baseline comparison reported current_line_prefix_is_baseline=true and amendment_count=1. The amendment is dated 2026-09-30, sits beside Story 4.1's enrolled_actors amendment, and is additive. Its STRICT keyed registry/no-FK claim matches server/store/bans.mjs:44-54; additive open convergence and column-set verification match room-log.mjs:793-816, :989-998; post-proof transaction gate matches invites.mjs:303-318 and room-log.mjs:1048-1062; poll interval/deadline claim matches constants.mjs:15, :503 and server.mjs:731-759; local exchange remains ungated as shown by pre-auth route classification and the restart test at routes.mjs:90-100 and tests/ban.test.mjs:676-685. The authz per-request promise has F-1's budget-preemption limitation. Existing frozen vocabulary already carries the relevant facts: AD-7 at spine:87, AD-8 at :115, and AD-13 at :152, :154; the amendment adds no duplicate vocabulary.

3 — FINDING F-1/F-3/F-4; landed implementation and Code Map verification.

- Storage and convergence: bans.mjs supplies STRICT DDL, the shape check, BANNED_ACTORS_COLUMNS, first-ban-wins INSERT, truthful unban, and one indexed read at :44-70, :94-168. room-log wires open-path creation/verification at :803-816, :989-998, constructs the operations and enrollment seam at :1044-1062, and exposes banActor/unbanActor/isActorBanned at :1774-1795. No schema bump is introduced.
- Enforcement: invites checks after verifyWithRawPublicKey and before reattach/use writes at :303-336. pipeline scopes to actor class and session fingerprint at :401-415, subject to F-1. server long-poll reads on every iteration and clamps every wake to the deadline at :731-759; constants define banned message/status and hold cadence at constants.mjs:186-204, :313-316, :15, :503.
- Operator host: ban-commands validates the canonical pattern, parses strict positional/option grammar, and returns refusal/usage outcomes at :47-61, :78-99, :107-157. agent-room imports/dispatches the family and applies 0/1/2 output handling at agent-room.mjs:122, :574-594; help documents both commands at :348-365. The help's claim that reasons are shown only to the store conflicts with the CLI response and F-2.
- Tests and housekeeping: all 13 tests are named and substantive; no skip/only/todo or host-conditional escape hatch was found. Row 12 uses real child processes and read-only database inspection. The focused suite was inspected but not executed in this audit. CHANGELOG's 4.5 entry covers registry, authz gate, poll re-check, enrollment proof, and restart persistence at CHANGELOG.md:168-191. The nine AC evidence pointers at ac-evidence.yaml:1072-1089 all resolve to test declarations at tests/ban.test.mjs:311, :366, :414, :456, :504, :537, :619, :639, and :724. README has no conflicting operator-surface claim; operator commands are documented by help at agent-room.mjs:348-365, while README's tool section covers the MCP tools at README.md:39-51.

Source hashes were rechecked before finalizing and remained unchanged:
docs/implementation/spec-4-5-ban-by-identity-key.md 53a10967e7e0eeef63a35a1a0f80aad95133bd5596e1b22e0f3d7995f29adada
docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md cd6ed5ffb325a1023b472b47c4c3ba8b5a945abf057c6de8ef93cd98a2e31376
docs/epics.md c76ff337944228111d65666c69120cf5466b5fdfd6c37955c65acfe55a8639e3
server/store/bans.mjs 1d100c84a66e17c7cab7393bd33a7ec3722a6ab492d16b56854e548fc7bc0f37
server/store/room-log.mjs bdc38ee2ef6ad8fe3e2ffe7999810f89b883e946ac98d94aaa74a6ce374f756b
server/store/invites.mjs 6fd6e22b89e28e6ccd6afa616589b440fc35e98efffebd8381f2e472c4c94f1f
server/api/pipeline.mjs a8b7edd307715b8be78e3c4a400f76c69ea3ea17cd1a17034720ee841148cdd3
server/api/server.mjs dc3364748825610ff6b2b88d305308b22432fe068f6123ad81e5676056623ad9
server/api/routes.mjs 44bd9a530b13b006e02314ce21b129ccbe07d9381304d77dc644fa05128727df
server/api/session.mjs ea43f722ab67d787fbc67faf94febeb3f1d872c8b749dcc0572b7234a4f165fa
server/api/rate-gates.mjs f50fc73948b44823bdf437fb44d14cc1416fa8755265316feb22f1f1af4d3638
server/keys.mjs dbb91cfdb35ccf3ef2f25606f5633708a8de33017154aff4299ed415e0e868cb
server/constants.mjs 993895bb5313b92472e5cc4ef2b247a9a296af221022cb7bc8b57b1c1cec93a9
server/cli/ban-commands.mjs 2f5d4a8961f7b59a379468a6dedc81ff678d3d4aa45cae1a3915b80cbb65e25b
server/cli/agent-room.mjs 29255a0608f58bbc7e89fa618e8af109e303f3304901be9dc084e62c48726c95
tests/ban.test.mjs d7324339f8b01876667f3046b81f988f47e5923159c060641a26fc60a01b4bb0
CHANGELOG.md e40e60bfba8fd049c5a699ca2867d36c264fbaf6b5630add67a60376f7af4314
docs/implementation/ac-evidence.yaml 51fdebaa6aa27a2d0d740cdf065904438581e98e9df63f6b24668b4949eb65c1
README.md 1540150007d649058c6889a2c588c69be10669ed3b749a9c332d841c44bb00ed

TEAM_DONE story-4-5-audit-luna
