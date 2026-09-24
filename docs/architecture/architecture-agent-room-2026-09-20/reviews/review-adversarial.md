# Adversarial Review — Architecture Spine `agent-room-v0.2`

- **Reviewer lens:** adversarial divergence hunt (architecture-spine reviewer gate)
- **Target:** `docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md` (status: draft)
- **Supporting:** `docs/prds/prd-agent-room-2026-09-20/prd.md` (final), `addendum.md` (D1–D19)
- **Date:** 2026-09-20
- **Method:** the two-builder test. For each hole, name two units one level down (epic/story teams), quote the ADs each side can cite in good faith, and exhibit the artifacts they would each ship while obeying every AD to the letter. Every hole ends with the AD to add or tighten.

## Verdict

The paradigm, invariants AD-2/AD-4 (one writer, room-local sequences), AD-9 (single constants module), and AD-11 hold up under attack. But the spine's contract surface is **path-deep, field-shallow**: AD-8 freezes route *paths* and the envelope while leaving per-route *payloads*, *credential mechanics*, and *code vocabulary* to two teams that will pick differently. Add one silent security hole (operator authentication does not exist anywhere in the spine or PRD) and one flagship-journey hole (cross-client Local Mode bootstrapping), and the spine is not yet sufficient to hand to independently-staffed epics.

**13 holes found: 4 critical, 6 high, 3 medium.** Top blockers: H1 (wire payloads not frozen), H4/H5 (credential mechanics & auth-exempt set), H6 (operator authentication absent — AD-3's own diagram contradicts AD-8), H10 (cross-client first boot).

| # | Hole | Severity | Units that diverge | Fix |
|---|---|---|---|---|
| H1 | Per-route wire payload schemas not frozen | Critical | API team vs MCP adapter team | tighten AD-8 |
| H2 | Long-poll wait contract (param shape, timeout result) | High | API team vs MCP adapter team | tighten AD-8/AD-9 |
| H3 | Cursor request semantics (param, omitted-vs-0, head detection) | Medium | api-client/cursors vs API team | tighten AD-4/AD-8 |
| H4 | Local Mode credential mechanics (local token vs session token, header, TTL) | Critical | api-client team vs auth middleware team | tighten AD-1/AD-5 |
| H5 | Auth-exempt route set vs AD-7's "every request" | High | middleware team vs enrollment & readiness stories | tighten AD-7 |
| H6 | Operator authentication absent; AD-3 diagram (cli→core) vs AD-8 operator routes | Critical | operator CLI team vs API routes team | new AD-13 |
| H7 | Viewer credential routing (FR-18 vs Deferred vs AD-7) | High | viewer web team vs middleware team | tighten AD-7/AD-8, fix Deferred |
| H8 | Realm identity key for plugin-local state | High | client state team vs server (`/api/status`) team | tighten AD-12 |
| H9 | Broadcast Room membership/enumeration semantics | Medium | core/rooms team vs reconnect story | tighten AD-6/AD-8 |
| H10 | Multi-session first boot; cross-client shared data dir | Critical | ensureServer story vs runtime story | tighten AD-1/AD-10 |
| H11 | Migration v1→v2 vs live v0.1 daemon; crash ordering | High | bootstrap story vs store/migration story | tighten AD-4, re-scope Deferred |
| H12 | Idempotent retry vs 5 s duplicate gate ordering; `duplicate_dropped` lane | High | send-route team vs MCP retry story | tighten AD-7/AD-8 |
| H13 | Error-code vocabulary and code→status map unpinned | High | API team vs MCP adapter team | tighten AD-8 |

---

## H1 — AD-8 freezes route paths and the envelope, but no route's payload schema

**Pair:** Room Server API epic (`server/api/`) vs MCP adapter + api-client epic (`server/mcp-stdio.mjs`, `server/client/`).

**Both comply with:** AD-8 — "JSON envelope `{ok, result|error:{code,message}}`, snake_case error codes from a `PUBLIC_ERRORS` whitelist, unknown → `request_failed` (v0.1 ratified). Resource routes …: `GET|POST /api/rooms/:id/messages` …". AD-1 — same wire protocol for everyone. Neither AD names a single request or response *field* of any route.

**Divergence:** The API team, inheriting v0.1's `after_seq`/`limit` query vocabulary from the codebase, ships:

```
GET /api/rooms/:id/messages?after_seq=41&limit=50&wait=true
→ {ok:true, result:{messages:[{seq, room_id, sender_chat_id, actor_fingerprint, sent_at, text}]}}
```

The MCP adapter team, building from the spine alone (the spine's `binds` are FR-1..FR-22/NFR-1..NFR-8; v0.1 source is *not* normative to it — and note AD-4/AD-9 never mention `after_seq`), ships a client that calls `?cursor=41&count=50&hold=true` and reads `result.items[].sequence`. Every read fails against a fully AD-8-compliant server. Same story for `GET /api/rooms` (room list), `GET /api/presence`, `POST /api/session` (what field carries the Chat ID? `chat_id`? `name`?), and `GET /api/status`. FR-21 even requires the client to parse `ambiguous_chat_id` "with candidate key fingerprints and last-seen times" — a structured payload whose field names appear nowhere.

**Why the spine permits both:** D12 in the addendum says "Exact shapes belong to architecture" — and the architecture declined to give them. NFR-8's additive-only policy ("clients tolerate unknown response metadata") presupposes a *known* v1 vocabulary to be additive on top of; no such vocabulary exists in the spine. AD-8's own claim — "**Prevents:** route/shape drift between server versions and independently-built clients" — is asserted, not achieved: the routes are frozen; the shapes are not.

**Fix:** Tighten AD-8 with a per-route v1 field dictionary (request params, response fields, types, optionality) for every route it lists — or add **AD-13 "Wire schema v1 is enumerated, not implicit"** with the table inline or in a bound companion the epics must treat as normative. Until then, AD-1's "one wire protocol" is one protocol name, zero protocol bytes.

## H2 — Long-poll wait behavior: parameter shape and timeout result are unpinned

**Pair:** API team vs MCP adapter team (the `message_read` long-poll story, FR-8/D4).

**Both comply with:** AD-9 — "long-poll hold ≤ 20,000 ms (server hold time)". FR-8 — "optionally waiting while the server holds the call at most 20 seconds".

**Divergence:** Four independent binary choices, none pinned:
1. Wait parameter: boolean (`wait=true`) vs requested milliseconds (`wait_ms=20000`) — AD-9 names a *server* bound, not the *request* shape.
2. Timeout result: server A returns `200 {ok:true, result:{messages:[], …}}`; server B returns an error envelope `4xx {ok:false, error:{code:"longpoll_empty"}}`. Both are snake_case whitelist codes; AD-7 pins statuses only for pipeline rejections (400/401/403/429), not handler outcomes.
3. Does a non-empty first page return immediately or fill the page and then hold for more?
4. FR-16: "long-polls count at admission" for the request budget — counted before or after the 20 s hold changes a client's polling cadence math under the 120/min budget.

A client built against A treats B's timeout envelope as a hard failure of every idle poll; a client built against B hangs on A waiting for an error that never comes.

**Fix:** Tighten AD-8 (payload schema, per H1) and add one sentence to AD-9: wait is requested as a boolean; timeout is a success with an empty page, never an error; a non-empty page returns immediately; budget admission happens before the hold.

## H3 — Cursor request semantics: parameter, omitted-vs-zero, and head detection

**Pair:** client state epic (`server/client/cursors`, AD-12 story) vs API read-route story.

**Both comply with:** AD-4 — "cursors live in plugin data per `(installation, realm, room)`"; FR-8 — "read messages after a Seq Cursor"; FR-20 — "advancing a cursor is a client-side act after a successful read".

**Divergence:**
1. Neither the spine nor AD-9 names the cursor parameter (`after_seq` exists only in v0.1 code/AGENTS.md, outside the spine's binds) — covered by H1 but worth naming here because it is the cursor contract itself.
2. First read of a room: client A sends `after_seq=0`; client B omits the parameter. Server A' treats omitted as "from the beginning"; server B' treats omitted as "latest page" (a defensible reading of reconnect-discovery ergonomics). B against A' silently re-reads a room from the start; A against B' gets a 400 for `after_seq=0` if B' requires `seq ≥ 1`. Both servers satisfy AD-4 ("reads after any cursor return a contiguous, ordered suffix").
3. Head detection: FR-12 requires "catch-up is complete when every room … has been read to the head at read time". The page-short heuristic (received < `limit` ⇒ at head) is race-prone under concurrent writes; a `has_more`/`head_seq` response field is the robust shape. One server includes it, the other doesn't; the client relying on the field breaks on the server without it.

**Fix:** In AD-4 or AD-8: cursor is an integer `after_seq ≥ 0`, always sent; `0` = from the room's beginning; the read response carries `head_seq` (and optionally `has_more`) so catch-up termination is server-computed, not client-guessed.

## H4 — Local Mode credential mechanics: what the local token file *is*, and how it is presented

**Pair:** api-client epic vs authentication middleware epic.

**Both comply with:** AD-1 — Local Mode is "authenticated by a local token file (0600) in the shared data dir". AD-5 — "every subsequent request authenticates via that token … Local Mode skips the challenge". AD-7 — pipeline stage 3 is "authentication (session token)".

**Divergence:** Three unpinned choices:
1. **Exchange vs identity:** Reading A: the local token file *is* the bearer credential, forever (no session tokens in Local Mode; "skips the challenge" ⇒ skips the token dance). Reading B: the local token is a bootstrap credential exchanged at `POST /api/session` for a short-lived session bearer exactly like remote ("skips the challenge" skips only the nonce/signature step). Client A against server B leaks nothing but starts receiving 401s at hour 12 of the SM-3 8-hour soak; client B against server A is merely wasteful — and both teams are citing AD-5 correctly.
2. **Presentation:** Which header and scheme? `Authorization: Bearer …` vs a custom `Agent-Room-Session` header. The conventions table pins snake_case fields, not auth headers.
3. **Expiry in Local Mode:** if reading B holds, AD-5's bracketed "[ASSUMPTION: TTL 12 h, sliding refresh on activity]" applies locally too — does a 20 s long-poll completion count as activity? Two middleware builders answer differently; one of them expires idle-but-polling local sessions.

**Fix:** Tighten AD-5/AD-1: one rule for both modes — every request carries `Authorization: Bearer <token>`; in Local Mode the local token file is accepted as a session credential directly (no exchange, no TTL), and session tokens exist only where challenge-issued. State it as one sentence; it is currently one ambiguity spanning three ADs.

## H5 — AD-7 says "every request" through authentication; enrollment and health checks exist

**Pair:** middleware pipeline epic vs (a) the enrollment story (FR-14, `POST /api/auth/enroll`, `POST /api/auth/challenge`) and (b) the readiness/health story (AD-10 readiness poll; FR-4 "success means the health endpoint answers").

**Both comply with:** AD-7 — "Every API request passes through exactly one pipeline, ordered: … authentication (session token) → …". The enrollment story complies with AD-5, which requires `POST /api/auth/challenge` to issue a nonce *before any token exists* — logically impossible behind a session-token gate.

**Divergence:** Server A hard-codes AD-7's "every": enroll/challenge/answer require a token ⇒ enrollment is unreachable ⇒ FR-1/FR-2 cannot pass (the team "satisfies" AD-7 and fails the PRD, discovering it at integration). Server B exempts `POST /api/auth/*` — and then must decide, unpinned, whether `GET /api/status` is also exempt (operator monitoring per FR-4 has no actor account; AD-10's readiness poll runs before enrollment) and whether the exemption list is part of the frozen surface. Two B-teams pick different exempt sets; a monitoring story built against one 401s against the other.

**Fix:** Tighten AD-7: name the auth-exempt route set (`POST /api/auth/challenge`, `POST /api/auth/answer`, `POST /api/auth/enroll`, `GET /api/status`, and decide `/events` per H7), and state that exempt routes still pass protocol/transport/rate stages. "Every request passes through the pipeline" stays true; the authentication *stage* is a no-op pass-through for the enumerated set.

## H6 — Operator authentication does not exist; the spine's own diagram contradicts its route list

**Pair:** operator CLI epic (`server/cli/`) vs API routes epic (`server/api/` operator routes), with the store epic dragged in.

**Both comply with:** AD-3 — its diagram literally wires `cli["operator cli (adapter)"] --> core`, bypassing the HTTP pipeline; the rule text says "Adapters (HTTP API, MCP tools, operator CLI) translate". AD-8 — "`operator: POST /api/invites`, `GET /api/invites`, `DELETE /api/invites/:id`, `POST /api/bans`, `DELETE /api/bans/:id`". AD-7 — the authorization stage covers "(ban, room ACL)" only; there is no operator role, and no operator credential exists anywhere in the spine, the PRD, or the addendum (the *viewer* gets a token; the *operator* gets nothing).

**Divergence:** Three incompatible builds, all citable:
- CLI A embeds core per the AD-3 diagram and opens the SQLite file directly on-host — a second process touching one realm's database while the server runs, in direct tension with AD-2 ("no realm has two processes", single writer), and incapable of remote operation at all.
- Routes B, forced to authenticate the operator routes somehow under AD-7 with no role model available, make any enrolled actor an operator: every stranger an invite ever admitted can mint invites and ban the operator (FR-14's "the operator keeps the realm clean" inverts).
- Routes C invent an operator token file on the server host — a third credential system the spine never mentions, with its own 0600 path, header, and rotation story diverging per builder.

The Deferred list compounds it: "Operator CLI UX details — … the routes (AD-8) and semantics (FR-14/15) are fixed, the packaging is not" files operator *authentication* under "UX" — it is not UX, and it is not fixed.

**Fix:** New **AD-13 — Operator authority is a server-held credential, exercised over the wire**: an operator token generated at first server boot (0600, in the realm data dir, rotatable), accepted by the AD-8 operator routes only; the CLI is an HTTP client of those routes, never a direct core/DB consumer; amend the AD-3 diagram (`cli --> http`, not `cli --> core`) and rewrite the Deferred bullet.

## H7 — Viewer credential routing: FR-18, the Deferred list, and AD-7 cannot all be true

**Pair:** viewer web epic (`web/` + SSE) vs middleware epic.

**Both comply with:** FR-18 (PRD) — "the viewer token never authorizes API writes and is never accepted by the API". The spine's Deferred — "viewer uses existing GET routes + SSE". AD-8 — `GET /api/rooms/:id/events` "(SSE, viewer/back-compat)" is an `/api` route. AD-7 — authentication is "session token".

**Divergence:** Middleware A takes "never accepted by the API" literally: all `/api` GET+SSE routes require session tokens; the viewer 401s on every request — the viewer story cannot be built at all without violating A. Middleware B accepts the viewer token on `/events`, `/presence`, and the messages GET — violating FR-18's letter, and silently widening: B must then also decide whether the viewer-token-scoped messages GET can see Direct Rooms (FR-7's "the viewer excludes Direct Rooms" becomes a per-credential visibility filter nobody pinned). A third team reads "back-compat" and assumes `/events` is actor-facing SSE left from v0.1 — AD-8 freezes the route with three plausible clienteles and one credential rule that excludes all of them.

**Fix:** Tighten AD-7/AD-8 (and rewrite the Deferred bullet): define the viewer surface explicitly — either dedicated non-`/api` GET+SSE routes (`/view/...`) authenticated by the viewer token with Direct Rooms excluded by construction, or an enumerated read-only `/api` subset the viewer token opens, with FR-18's sentence corrected to "never accepted for writes and never outside the enumerated viewer subset".

## H8 — AD-12 says "per realm" but never says what a realm *is* in plugin data

**Pair:** client state epic (cursors/allowlist/held cache, AD-12 story) vs server epic owning `GET /api/status`.

**Both comply with:** AD-12 — "The plugin (PLUGIN_DATA) owns, per realm: session cursors, the Allowlist …". FR-20 — cursors persisted "per (installation, realm, room) — qualified by realm because a plugin may switch Servers".

**Divergence:** The realm key is unnamed. Client A keys by normalized server origin (`cursors/https_chat_example_com/<room_id>`); client B keys by a server-assigned stable realm id obtainable only from `GET /api/status` — a field whose existence is itself unpinned (H1). The two produce mutually unreadable plugin-data trees; worse, they *behave* differently in the exact scenario FR-20 names: the operator moves the realm to a new domain. A's cursors and allowlist orphan (the user re-approves every peer; held messages re-hold); B's follow seamlessly. Also unresolved: URL normalization (trailing slash, default port, case) — two A-builders diverge from each other on `https://x.example/` vs `https://x.example`. Note the addendum's D16 says "cursors (one per realm per room)" while FR-20 says "per (installation, realm, room)" — the realm element is new in v0.2 (v0.1 had one implicit server) and nothing defines it.

**Fix:** Tighten AD-12: the realm key is a server-issued stable opaque id (`realm_id`), exposed on `GET /api/status`, never the URL; local state directories are `<realm_id>/…`; URL normalization is pinned for config storage only.

## H9 — Broadcast Room membership vs enumeration

**Pair:** core/rooms epic vs the FR-12 reconnection story (client-side room enumeration).

**Both comply with:** AD-8 — "`GET /api/rooms` (rooms the Actor belongs to — reconnect discovery)". FR-1 — "joins the Broadcast Room automatically". FR-12 — after reconnect a session enumerates "Broadcast Room plus every Direct Room of its Actor pairs".

**Divergence:** "Belongs to" is unpinned at the store level: server A writes a membership row for the Broadcast Room at enrollment (it appears in `GET /api/rooms`); server B makes broadcast access implicit-by-enrollment and lists only Direct Rooms, expecting the client to learn the Broadcast Room id from `room_status` (FR-21). Client C enumerates via `GET /api/rooms` only — on B it never discovers the Broadcast Room and FR-12's consequence fails. Both cite AD-8 correctly; the PRD constrains the *outcome* but not the *mechanism*, and the two mechanisms produce different wire payloads (overlapping with H1, but the membership-row question is a core/store divergence that survives any payload freeze). Additionally: whether Direct Rooms are created lazily at first message vs at `room_direct_open` (FR-21 says the open "returns the existing-or-created pair room's ID") determines whether a B-style enumeration ever shows an empty DM — two core builders differ, and the client's DM list rendering differs accordingly.

**Fix:** Tighten AD-6 or AD-8: enrollment atomically grants Broadcast Room membership (it is listed by `GET /api/rooms` like any other room, flagged `kind: broadcast|direct`); Direct Rooms are created at `room_direct_open`/`POST /api/rooms/direct`, never at first message.

## H10 — Multi-session first boot: the shared data dir is load-bearing and undefined; the spawn race is under-specified

**Pair:** ensureServer story (MCP adapter epic, AD-10) vs runtime/identity story (`runtime.mjs`, AD-1) — with a *second client vendor* (UJ-1's Zcode session) as the silent third unit.

**Both comply with:** AD-10 — "The MCP adapter's `ensureServer` (evolved from `ensureDaemon`: startup lock, detached spawn, readiness poll — ratified pattern) boots it on first use and reuses a running one." AD-1 — "a Room Server bound to `127.0.0.1` with an ephemeral port published in `runtime.json`, authenticated by a local token file (0600) in the shared data dir."

**Divergence:**
1. **Which dir is "the shared data dir"?** The resolution rule (`AGENT_ROOM_DATA_DIR` → `~/.agent-room`) lives only in v0.1's AGENTS.md — the spine never restates it, and v0.1 was single-vendor. PLUGIN_DATA *differs per client vendor* (Claude Code vs Zcode plugin caches). A builder who scopes server state under the spawning installation's PLUGIN_DATA (a plausible misreading of AD-12's "The plugin (PLUGIN_DATA) owns … local config") ships: Claude Code session spawns server #1 under its plugin data; Zcode session finds nothing in `~/.agent-room`, spawns server #2 with a second SQLite file. Two realms on one machine; FR-1's consequence test — "two fresh sessions of different clients on one machine exchange messages" — fails silently, each side seeing an empty presence list. This is the flagship journey (UJ-1), broken by two teams each following the spine.
2. **Race loser behavior:** "startup lock" serializes spawn, but the spine does not pin the lock's contents or the loser's duty: re-read `runtime.json` and adopt the winner (correct) vs proceed to spawn and crash on the SQLite lock (AD-2 makes server #2 fail at open — the error path back to "reuse a running one" is unspecified).
3. **Publication ordering:** is the token file written before the port binds, atomically (rename)? A readiness poll that authenticates `/api/status` needs both artifacts; a half-published `runtime.json` yields a compliant-but-unusable boot.
4. **Stale detection:** "reuses a running one" — probe `/api/status` on the recorded port, or check a pid from `runtime.json`? Against a crashed prior server the two produce different recovery paths (respawn vs retry-forever).

**Fix:** Tighten AD-1/AD-10: pin the shared data dir and its resolution (`AGENT_ROOM_DATA_DIR` → `~/.agent-room`; never PLUGIN_DATA, which is per-installation client state per AD-12), pin the lock file's contents (winner pid, port, token path) and the loser's adopt-after-lock rule, and pin readiness = token file readable + `GET /api/status` 200 + atomic-write publication.

## H11 — Migration v1→v2 against a live v0.1 daemon, and crash ordering the spine doesn't pin

**Pair:** bootstrap story (ensureServer/upgrade path) vs store/migration story.

**Both comply with:** AD-4 — "Migration v1→v2 re-sequences each room's existing messages 1..n — a one-time, documented cursor reset at upgrade". The Deferred list — "Database internals beyond AD-4's contract — index choices, WAL tuning, exact migration SQL (store adapter owns them)".

**Divergence:** Four orderings, none pinned:
1. **Live v0.1 daemon:** the upgraded plugin starts while a v0.1 daemon still holds the SQLite file (WAL) and its unix socket. Builder A detects the socket/pid and stops the old daemon before migrating; B refuses with a manual-action error — which breaks FR-1's zero-config first boot *exactly on upgrade day*; C opens and migrates under the running writer, risking lock failures mid-DDL. All three "satisfy" AD-4, which never mentions the old process at all.
2. **Transaction scope:** one `BEGIN IMMEDIATE` over all rooms vs per-room commits. Crash mid-migration under per-room commits leaves a half-resequenced database.
3. **Version-stamp order:** `user_version` bumped before vs after re-sequencing. Bump-last + crash ⇒ v2 data under a v1 stamp ⇒ restart re-runs re-sequencing on already-resequenced rooms ⇒ sequences shift a second time — silent corruption that still looks "contiguous 1..n" per room, so AD-4's own invariant check passes.
4. **Mixed versions:** an un-upgraded v0.1 plugin session on the same machine spawns a v0.1 daemon against the migrated data dir; nothing in the spine says v0.2 must make coexistence detectable (socket file vs port in `runtime.json` is at least a distinguishing artifact — but only if someone pins that v0.2 must not create the old socket path).

The Deferred item's carve-out ("exact migration SQL") is legitimate for SQL text; *ordering, atomicity, and crash-resume* are contract, and the deferral currently swallows them. This is the checklist's "Deferred must be divergence-free by construction" failing its first test.

**Fix:** Extend AD-4 with the upgrade protocol: detect-and-stop v0.1 daemon → migrate inside one transaction → bump schema version within that transaction → readiness only after commit; idempotent on re-run. Re-scope the Deferred bullet to SQL text and index choices only.

## H12 — Idempotent retry vs the 5 s duplicate gate: two PRD rules collide, and the spine doesn't order them

**Pair:** send-route story (API epic, FR-16 enforcement) vs MCP adapter's `outcome_unknown → resolved-by-retry` story (FR-20/FR-17).

**Both comply with:** FR-16 — "a byte-identical payload from one Actor in one room within a 5-second window returns `duplicate_dropped` naming the original sequence". FR-20 — "retrying the same `client_message_id`: identical payload returns the original committed message (no double send)". AD-7 orders the *pipeline*, not the checks inside the handler; AD-8 freezes neither the ordering nor the lane.

**Divergence:** A lost-response retry *is* byte-identical, same actor, same room, within 5 s, with the same `client_message_id` — both rules match simultaneously. Server A checks the idempotency tuple first: returns `200` committed original (FR-20 wins). Server B checks the duplicate gate first: returns `duplicate_dropped` (FR-16/D18 wins). Both teams quote their FR. Then the lane question: FR-16 calls `duplicate_dropped` "an explicit notice"; FR-17 lists it among "actionable statuses" — error envelope (`ok:false`, 4xx?) or success result (`ok:true`, 200, `status:"duplicate_dropped"`)? Semantically the message *was* committed (the response names the original sequence), so shaping it as an error makes the MCP retry story report a delivered send as failed. The client built for A ("stop on committed, conflict, or error") loops or false-fails against B; both servers are spine-compliant.

**Fix:** Tighten AD-7 or AD-8 with the send-path check order: idempotency-tuple lookup precedes the duplicate gate — an identical-tuple+payload hit returns the original committed message and can *never* return `duplicate_dropped`; the duplicate gate applies only to distinct `client_message_id`s. Pin `duplicate_dropped`'s lane: success-shaped result carrying the original sequence, distinct from the `rate_limited` error envelope.

## H13 — `PUBLIC_ERRORS` is a mechanism, not a list: code names and code→status mappings are unpinned

**Pair:** API epic vs MCP adapter epic (client branching on error codes).

**Both comply with:** AD-8 — "snake_case error codes from a `PUBLIC_ERRORS` whitelist, unknown → `request_failed`". AD-7 — pins HTTP statuses for four *pipeline stages* only (400/401/403/429).

**Divergence:** The whitelist's contents are nowhere enumerated. Codes two teams must independently agree on, with no pin: the Chat-ID-taken refusal (FR-19 says only "refused with an explicit error" — server A `chat_id_taken`, server B `chat_id_in_use`; a client matching one string renders the other as a raw `request_failed`, and FR-1's connect flow degrades); `room_not_found` vs `not_a_member` vs a bare ACL `forbidden` (even where AD-7 pins *403*, the *code string* is free, and the client cannot distinguish "banned" from "wrong room"); `storage_low` (FR-22) — 503? 429? 200-with-error-envelope?; `client_message_id_conflict` — 409 or 400? Each pair of builders coins a different vocabulary; every code-branched client behavior (rename prompts, retry logic, SM-2 drills) becomes server-specific.

**Fix:** Tighten AD-8: enumerate `PUBLIC_ERRORS` v1 as a frozen table — code, HTTP status, retryable yes/no, per-code payload fields (e.g., `ambiguous_chat_id.candidates[].fingerprint|chat_id|last_seen`) — additive-only per NFR-8, exactly like routes.

---

## Deferred audit (the checklist requires divergence-free by construction)

| Deferred bullet | Verdict |
|---|---|
| "Database internals beyond AD-4's contract — … exact migration SQL" | **Divergent as written** — migration *ordering/atomicity/crash-resume* is contract but currently swallowed here (H11). Carve it out. |
| "Operator CLI UX details — … the routes (AD-8) and semantics (FR-14/15) are fixed, the packaging is not" | **Divergent as written** — operator *authentication* is neither UX nor fixed (H6); the bullet's "are fixed" claim is false until AD-13 exists. |
| "SSE for MCP clients — v0.2 keeps MCP reads as long-poll (D4)" | Safe for the deferral itself; but `/api/rooms/:id/events` sits in AD-8's frozen list with an undecided credential/clientele (H7). |
| "Deployment automation — systemd, Dockerfile, Caddyfile" | Safe — no second unit builds against it; FR-4's guide contents remain PRD-scoped. |
| "Multi-process/embedded variants — … possible later, no consumer now" | **Contradicted by the spine itself** — AD-3's diagram makes the operator CLI a direct core consumer (a second process per realm) *now* (H6). Either the diagram changes or this deferral is false. |
| "Wire API for viewer↔server — viewer uses existing GET routes + SSE" | **Divergent as written** — collides with FR-18's "never accepted by the API" (H7). |

## Open Questions audit (divergence potential if split across epics)

1. **Token lifetime/refresh** — already feeds H4 (does a Local Mode credential expire at all?) and H2.4 (does long-poll completion refresh?); if left open, the token-issuing epic and the reconnect epic *will* diverge. Decide before epics, or assign both stories to one team.
2. **Pair-id encoding** (`direct:<min,max>`) — server-internal and single-writer, low risk; but note the mild internal tension with the conventions table ("ids opaque base64url strings (rooms…)"): if `GET /api/rooms` ever exposes the structured `direct:` id, pin that clients must treat room ids as opaque regardless.
3. **Presence SSE vs 5 s polling** — genuinely divergence-free (FR-18's bound holds either way); fine to leave open.

## What held up under attack

AD-2/AD-4's writer+sequence model rebuffed every multi-writer scenario I constructed; AD-9's single constants module correctly kills the limits-drift class; AD-11's boring-crypto rule leaves no fork room; NFR-8's reject-unknown-fields plus additive-only policy is sound *once* the v1 vocabulary it operates on actually exists (H1/H13). The held-message/allowlist split (AD-12 vs AD-7's "Client Gates … never duplicated server-side") survived the trust-boundary attacks I tried — cursor-advance-on-held and the 100-entry cache semantics are pinned tightly enough in FR-10/FR-20 that two builders converge.

## Recommended disposition

Block progression to epics on the four criticals (H1, H4, H5 folded into H4's fix if desired, H6, H10) — each is a one-AD tightening plus the AD-8 schema table. The highs (H2, H7, H8, H11, H12, H13) are all closable in the same editing pass; H3 and H9 ride along with the H1 schema freeze. Total new ADs needed: one (AD-13, operator authority); everything else is tightening existing text.
