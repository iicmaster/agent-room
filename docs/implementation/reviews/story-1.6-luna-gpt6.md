# Story 1.6 Audit — codex-advisor[luna] (gpt-6-luna[max])

## Verdict
FIX-FIRST — `/api/presence` emits fields missing from AD-8's frozen response vocabulary; FR-5's operator-tuning requirement is also unresolved.

## Findings
- [blocker] F1 — Presence output is outside the frozen response vocabulary — `server/core/session-registry.mjs:320-354` emits `online`, `offline_recently`, `chat_id`, and `client_type`; `tests/presence.test.mjs:260-269` asserts these exact keys. AD-8's response list at `ARCHITECTURE-SPINE.md:113` and `server/api/routes.mjs:107-122` omits all four (the row fields appear only in the request vocabulary). `tests/api-contract.test.mjs:99-105` compares the arrays to the spine but never checks an endpoint payload against that vocabulary. This leaves the new API shape unfrozen for Story 1.7 clients. Add the four names in a dated additive AD-8 response amendment, mirror them in the route vocabulary, and assert the actual presence response against it.
- [warning] F2 — FR-5 operator tuning is not exposed — `prd.md:135` says heartbeat cadence and online TTL are operator-tunable. `server/constants.mjs:27-31,286-294` holds fixed values; `presenceSnapshot` always uses `PRESENCE_TTL_MS` (`session-registry.mjs:298-318`), and `startServer` has no presence-TTL option (`server/api/server.mjs:432-443`). The client heartbeat belongs to 1.7, but no operator-facing tuning path is defined there either. Add a supported configuration path or record an explicit contract deferral before claiming FR-5 complete.
- [warning] F3 — A clock rollback can surface a future offline `last_seen` — `upsertChatIdClaim` deliberately keeps the greatest timestamp (`room-log.mjs:1120-1125`), while `recentClaims` filters only `last_seen_at >= cutoff` and has no `last_seen_at <= now` bound (`room-log.mjs:1174-1193`). If the system clock moves backward, a stored future claim still enters `offline_recently`, although it is not within the past 24 hours. Bound the query above by the same `now` and cover a forward-then-backward clock case.

**Inline panel (advisory, not an external approval):**
- John (PM): Bottom line: F1 blocks the story handoff because the 1.7 adapter needs a frozen response contract; resolve F2 before calling FR-5 complete.
- Sally (UX): Bottom line: keep `client_type` optional for additive compatibility; the 1.7 adapter should bind as `mcp`. I would keep F2 a warning if operator tuning has a named follow-up, while John treats the normative FR-5 gap as a ship gate.
- Quinn (SQLite): Bottom line: F1 is a ship gate; per-request durable writes are semantically justified, but measure writer contention in 1.8 and guard the clock-window query.

## Checks
1. FINDING F1 — Every I/O row has corresponding implementation and targeted test coverage by inspection: row/type `tests/presence.test.mjs:239-327`; touch/TTL `:331-391`; offline boundaries, dedupe, self-exclusion `:393-500`; restart/viewer/unreachable `:504-579`; 401/query allowlist `:583-660`. The unreachable case proves raw `ECONNREFUSED` (`:567-579`), not a future API client's error mapping. The emitted row shape is tested, but not admitted by AD-8 (F1). Tests were inspected, not executed.
2. PASS — The session verifier wraps each authenticated actor-class request and attempts `touch`; only a bound live row causes a durable claim write (`server/api/server.mjs:528-544`, `server/core/session-registry.mjs:248-259`). There is no server heartbeat timer; the interval in `server/api/server.mjs:552-575` prunes claims only. Viewer/pre-auth/health routes bypass session verification (`server/api/pipeline.mjs:184-203`). Each bound request synchronously performs `BEGIN IMMEDIATE` plus upsert/read (`room-log.mjs:290-312,1107-1140`); binds/renames can also write their new claim. A generic store failure aborts the request as `request_failed` 500 (`server/api/server.mjs:418-426`, `constants.mjs:195`). Auth expiry has already slid before touch (`server/api/session.mjs:97-104`), so that failure leaves the auth slide but does not advance live/durable presence; no touch-failure test was found. This write cost and fail-closed behavior are the right 1.6 trade for FR-5's “any authenticated request” freshness; measure it under 1.8 polling/heartbeat load. Unbound authenticated sessions have no claim row to persist.
3. FINDING F3 — Online rows are swept only when strictly older than the TTL, and the read sweep frees names (`session-registry.mjs:148-155,315-329`; boundary/reclaim test `tests/presence.test.mjs:353-391`). Offline uses an inclusive lower boundary, excludes online and reader Actors, and chooses the most recent claim (`session-registry.mjs:333-354`; tests `tests/presence.test.mjs:393-500`). SQL tie order is deterministic (`room-log.mjs:1188-1193`), though equal-time tie behavior is not separately asserted. The upper-bound clock case is F3.
4. FINDING F1; F2 — The 2026-09-25 AD-8 amendments for optional `client_type` and `broadcast_room_id` are dated (`ARCHITECTURE-SPINE.md:113`) and parsed by the live contract test (`tests/api-contract.test.mjs:43-85,99-105`). Absent `client_type` becomes `null`, while present values use the closed set (`session-registry.mjs:89-97`; `tests/presence.test.mjs:280-327`). Keeping it optional is safe for additive compatibility; 1.7 should send `mcp`. Production limits are imported/derived from constants (`constants.mjs:278-294`); the unresolved issue is runtime tunability (F2), not duplicated enforcement numbers.
5. PASS — `recentClaims` has an inclusive time-window predicate and deterministic ordering (`room-log.mjs:1164-1200`); pruning deletes strictly older-than-TTL rows transactionally (`room-log.mjs:1202-1227`) and the server prunes on boot and interval (`server/api/server.mjs:552-575`). A test proves touched claims survive the seven-day prune while an untouched claim ages out (`tests/presence.test.mjs:696-730`). Presence clocks are injectable through both registries and the store (`tests/presence.test.mjs:227-234`; `session-registry.mjs:120-125,298-318`). Retention bounds age, not claim count; the table key is `(chat_id_normalized, actor_fingerprint)` (`room-log.mjs:578-590`) and there is no `last_seen_at` index, so include-offline reads scan/materialize claims in the window before Actor dedupe. This is a workload caveat, not a separate blocker for the stated story.
6. FINDING F1/F2; prior-decision alignment otherwise PASS — D13's one-Session/one-Chat-ID model matches the live row (`addendum.md:19`); AD-6's ephemeral live registry plus durable claims and restart behavior match (`ARCHITECTURE-SPINE.md:75-79`; `tests/presence.test.mjs:504-529`); AD-14's realm-scoped `GET /api/status` is implemented (`ARCHITECTURE-SPINE.md:145-149`; `server/api/server.mjs:301-313`). For 1.7, send the 60 s ±10% adapter heartbeat, preserve the two-group `room_presence({include_offline?})` shape, and re-bind after a read-time TTL sweep: a later authenticated touch returns null and does not recreate the evicted row (`session-registry.mjs:248-259`; reclaim test `tests/presence.test.mjs:384-390`). For 1.8, retain the blocking two-participant real MCP/server/WAL checkpoint from `epic-1-context.md:58-59`; these 1.6 tests exercise direct HTTP, not the MCP path.

### Evidence boundary
Read-only source, diff, and test inspection; no tests were run. Git status/diff were readable, with macOS Xcode cache warnings. No product, implementation, or test source was changed for this audit.

### Evidence snapshot (SHA-256)
```text
docs/implementation/spec-1-6-presence-online-offline-recently.md b51825d738aab9888587dfaf9c207e474f8fd18efef9bb43dd56c7fc0784736a
docs/implementation/reviews/story-1.6-luna-brief.md 51926fcd91dba55c812dc147c975cd65dd51e977f147e6e01b682b8bcd36a87c
docs/implementation/epic-1-context.md 86e96ee4861c1191fec85d07414350a30bdcd3c324d507e7c9476de80fcb6d7f
docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md 1847280c61466266799a8c1bf446c34a92860b1adfd2778822b3b02d45e463dd
docs/prds/prd-agent-room-2026-09-20/prd.md 65cfaaa3fb906c8bc2ce095ab09ce9f648e962c3e964c8d7bc9ac8ad69db3c1b
docs/prds/prd-agent-room-2026-09-20/addendum.md 8995d2163653736479874a0d19945e2ce587e6d98d9083ba60acb590d9e5e847
server/core/session-registry.mjs 4f83dc107202595079cecbe7910c5803ed2e005e4d85e23e54e95adcd7b2c838
server/api/server.mjs 5cb3a64fbd56eca1cc7a85a36889efa3dc2d0835f7cffbbf0fdaa7bdfc5addb2
server/api/routes.mjs ad22d1805f33f9c9f7e86971ac9466b2e85c899c4ca3e2e051ba1bffe9732587
server/api/session.mjs c5f3e41a5687fa2ac42fefec954d95eb55148d8f4ba80ce024ea3654c5446357
server/api/pipeline.mjs 72b987f24961fba9bfdb8200450cf9efbe4741e1a18e84b6f208a194b0710fef
server/store/room-log.mjs daae5a71905ae4e6eab93f7d103dcb9db2c07dab1bee02dada6bf229cf359071
server/constants.mjs b956df927d151423abeef66c50478e0b7fb526dcf8ffe129e4ef3a34eb346901
tests/presence.test.mjs bff3d338b2b6012390b3ec1c924c042bebbb6e2f7e361db1c5a2880d02dd9313
tests/api-contract.test.mjs 072f5d1ab48863e6f5139215af037da465566691587663eb3b2ff88e205f751a
tests/constants.test.mjs 40c26fce6df901e90410283dd8f5695d6dde5318295ae51d805a3490551642a2
tests/session-routes.test.mjs c0bf1c176c104933a846b49b8196f02fe82c5b244f5781eb703d73e517359bfa
tests/local-auth.test.mjs 91f52bf497d0e3b99ab2fb7ec7f625a972470a63b1eb9b3a46892b4dc8d2fd63
tests/api-host.test.mjs 1e54371cda391f6f03f3560980c8b60177dc520f42d3e931208c853c02384c3a
tests/chat-id-claims.test.mjs bd435899a78eabf73634c64d21990a22d56ed38f7d846dc6f5f8a374b62aac49
```

TEAM_DONE story-1-6-audit-luna
