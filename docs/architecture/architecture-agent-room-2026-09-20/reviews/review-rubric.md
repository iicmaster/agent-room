# Rubric Walk — ARCHITECTURE-SPINE.md (agent-room-v0.2)

- **Reviewer:** architecture-spine rubric walker (gate)
- **Date:** 2026-09-20
- **Target:** `docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md`
- **Driving spec:** `docs/prds/prd-agent-room-2026-09-20/prd.md` (22 FRs, 8 NFRs) + `addendum.md` (D1–D19)
- **Codebase verification:** v0.1 sources read directly (`server/roomd.mjs`, `server/database.mjs`, `server/runtime.mjs`, `server/daemon-client.mjs`, `web/app.js`)

**Gate verdict: pass-with-fixes.** 0 critical / 3 high / 6 medium / 5 low.

---

## Rubric 1 — Does the spine fix the real divergence points for epics/stories, missing none?

**Mostly yes; six divergence points are not fixed.**

Fixed well: transport unification (AD-1), realm/process/writer ownership (AD-2), module boundaries and dependency direction (AD-3), room-local seq allocation (`max(seq)+1` inside the write transaction — safe under the ratified single writer) and the migration cursor reset (AD-4), identity and enrollment flow (AD-5), session registry and direct-room keying (AD-6), gate ordering intent (AD-7), route freeze (AD-8), limits module (AD-9), local-as-config (AD-10), crypto menu (AD-11), client trust state (AD-12).

Not fixed — see H1 (pre-auth route set / enrollment rate limiting), H2 (operator authentication), H3 (viewer authentication path), M2 (`reply_to_seq` remap + whether replies survive at all), M3 (per-route field names), M5 (heartbeat mechanism). Each of these is a seam where two independently written stories would have to guess.

## Rubric 2 — Is every AD enforceable, and does it prevent its stated divergence?

Strong overall — the conventions table even promises "every AD's enforcement point has a test that fails when the AD is violated." Per-AD:

- **AD-1..AD-6, AD-9..AD-12:** enforceable as written (protocol header check + socket-absence test; single-process/single-writer test; import-lint that `core/` pulls no `node:http`; schema + gap-free seq test; auth-middleware tests; constants-module reference check; mode-blindness test; zero-deps check). Stated divergences are the real ones.
- **AD-7 is not implementable as written** (H1 below) — the fixed order has no story for unauthenticated routes, and as ordered it *contradicts* FR-14.
- **AD-8 is half-frozen** (M3): routes and envelope are frozen; request/response field names are not, which is exactly where independently built clients drift.
- **AD-9's enumeration is incomplete** (M1) — the rule ("all numeric limits... referenced by name") is enforceable, but the list as published omits several PRD-mandated numbers.
- **AD-4's migration contract is incomplete** (M2) — see below.

## Rubric 3 — Could anything under Deferred let two independently-built units diverge?

- *DB internals beyond AD-4's contract* — acceptable for index/WAL tuning, but the message row shape (notably `reply_to_seq`) straddles store **and** API (M2). The defer silently includes a contract decision.
- *Operator CLI UX details* — the defer is fine **only because** routes and semantics are fixed; but operator *authentication* is not a UX detail and is undecided (H2).
- *SSE for MCP clients, multi-process variants, viewer read-model API* — clean defers, each with a stated trigger.
- *Deployment automation* — clean defer; contents correctly assigned to FR-4's guide.

## Rubric 4 — Named tech verified current

Nothing stale found; nothing smelled stale either.

- **Node ≥ 24** — appropriate LTS floor for 2026-09 (24 is in active LTS maintenance through 2027+); already asserted by v0.1 `assertSupportedRuntime` (`server/runtime.mjs`).
- **`node:sqlite`** — stable built-in on the 24 line; v0.1 already asserts `≥ 3.51.3` at startup and the suite runs against it, so the floor is inherited, not speculative.
- **Ed25519 in `node:crypto`** — `generateKeyPairSync('ed25519')` + `sign`/`verify` are long-stable core APIs; SHA-256, `randomBytes`, `timingSafeEqual` likewise. Correct choice for zero-dep crypto.
- Nit (L5): the Stack table lists "SSE" as a built-in — SSE is not a Node module; it is hand-rolled over `node:http` (v0.1 does exactly this at `roomd.mjs:348`). Cosmetic, but a story writer should not go looking for an SSE module.

## Rubric 5 — Ratify, not contradict, the brownfield codebase

Verified against source; the spine's ratification claims are **accurate**:

- `PUBLIC_ERRORS` snake_case whitelist with `request_failed` fallback — `roomd.mjs:35–60`. ✓
- STRICT tables, `journal_mode = WAL`, `synchronous = FULL`, `BEGIN IMMEDIATE` — `database.mjs:121–151,166–241`. ✓
- Idempotency tuple `UNIQUE (room_id, actor_id, client_message_id)` — `database.mjs:202`. ✓
- Limits mirrored: `messageText: 32*1024`, `readLimit: 200` in `DATABASE_LIMITS`; `MAX_WAIT_MS = 20_000`; `MAX_FRAME_BYTES = 1 MiB`; duplicated in MCP schema (`mcp-stdio.mjs:75–76,150–151`). ✓ (this duplication is precisely what AD-9 exists to end)
- `ensureDaemon` startup lock / detached spawn / readiness poll — `daemon-client.mjs:221–260`; AD-10's `ensureServer` evolution claim is grounded. ✓
- `runtime.mjs` file gates (regular, non-symlink, size-bounded, 0600/0700), `identity.json`, viewer token file — `runtime.mjs:119–209`. ✓
- AD-4's premise "v0.1's single AUTOINCREMENT" — `database.mjs:194` (`seq INTEGER PRIMARY KEY AUTOINCREMENT`). ✓ And "v0.1 never persisted client cursors" — confirmed: cursors are per-request `after_seq` only; the viewer's cursor is in-memory. ✓
- Viewer: GET-only (405 `method_not_allowed`), restrictive CSP, SSE `/api/rooms/:id/events` — `roomd.mjs:71,273–275,345+`. ✓
- Unix-socket retirement (AD-1) is deliberate and sanctioned — addendum §5 ("near-rebuild of the transport/identity layers") and the PRD's own scope note. Not a contradiction. ✓

Two genuine ratification problems: **M6** (AGENTS.md still says "the HTTP server is strictly GET-only" — the spine introduces authorized writes without explicitly ratifying the narrowing of that policy to the viewer surface) and part of **H3** (calling `/events` "the existing pattern ratified" over-reads: v0.1's viewer accepts `?token=` in the query string, which FR-18 explicitly bans in v0.2).

## Rubric 6 — PRD §4–§7 coverage cross-check (all 22 FRs, 8 NFRs)

Every FR and NFR is **bound** in some AD's `Binds:` line, and the frontmatter claims `binds: [FR-1..FR-22, NFR-1..NFR-8]`. Walking §4–§7:

- Covered and mapped: FR-1 (row 1), FR-2/3 (row 2), FR-19/FR-5 (row 3), FR-6/7 (row 4), FR-8/20 (row 5), FR-9/10 (row 6), FR-14–17 + FR-22 (row 7), FR-11–13 (row 8), FR-18 (row 9), NFR-2 (row 10). NFR-1 (AD-11), NFR-3 (AD-5), NFR-4 (AD-5/AD-11), NFR-5 (AD-9), NFR-7 (AD-2/AD-4), NFR-8 (AD-1/7/8), NFR-6 (tests conventions + seed) are bound in AD lines but have no map rows.
- **FR-4 has no Capability-map row** (bound by AD-2 and AD-10) — and its concrete architectural anchor, the health endpoint, is missing from AD-8's frozen route list (see H3). v0.1 already ships `/health` (`roomd.mjs:271`), so this is a ratified artifact the freeze forgot.
- **FR-21 has no Capability-map row** (bound by AD-8) — the MCP tool surface lives only implicitly in the structural seed (`mcp-stdio.mjs`), and the data source for `room_status`'s realm name is unassigned.
- No FR/NFR is entirely unowned; no capability is silently dropped. The gaps are traceability (M4) plus the two concrete unassigned details above.

## Rubric 7 — Every owned dimension decided / deferred / open?

- **Structural, data, identity, transport, security, client-state:** decided (AD-1..AD-12).
- **Deployment:** explicitly deferred (automation) with environments decided (loopback / TLS / proxy recipe, AD-11, AD-10). ✓
- **Operations:** partially present — restart (FR-11 via AD-2/AD-4), backup guide (assigned to FR-22/PRD), migration reset (AD-4). The holes are the **health endpoint** and **operator authentication** (H3, H2) — operational-envelope items the spine owns but leaves silent. Not a whole silent dimension, but two named gaps inside it.
- **Observability:** logging conventions decided (stderr, redaction); no metrics dimension claimed — acceptable at this altitude.

## Sanity checks

- **AD IDs:** AD-1..AD-12, unique, ascending, each exactly one header. Binds-reference D-numbers (D2, D4, D5, D9, D12–D17) all exist in `addendum.md` and are used consistently with their recorded content. ✓
- **Mermaid:** only **two** diagrams exist (AD-3, AD-7) — see L1 for the orphan fence that suggests a third was lost. Both parse: standard `flowchart LR`, quoted node labels, rhombus decisions `id{"..."}`, chained edges `A --> B -- label --> C`, cylinder `id[("...")]`, quoted edge labels `-- "text" -->`. Hyphenated subgraph ids (`client-side`, `server-side`) parse in current mermaid but are historically fragile — prefer underscores (L1).

---

# Findings (severity-ranked)

## HIGH

### H1 — AD-7's pipeline order cannot implement FR-14 (pre-auth routes don't exist in it)
**Cites:** AD-7; AD-8 routes; FR-14 consequence ("Enrollment attempts are rate-limited (5/minute/source-IP...)"); AD-1 (local token).
The fixed order is `protocol → transport → auth(session token) → budgets → authz → handler`, and the rule says "Every API request passes through exactly one pipeline." But `POST /api/auth/enroll`, `/api/auth/challenge`, `/api/auth/answer` are reached by clients that hold **no session token yet** — stage 3 as written 401s them before stage 4, so the enrollment IP budget is unreachable; exempting them contradicts "exactly one pipeline." The pipeline needs a named pre-auth route class with IP-keyed budgets applied without an actor, and AD-1's local token file is a second auth class the "session token?" diamond doesn't represent (also L2). Fix is small (define the pre-auth set + budget keying per class) but it is load-bearing: the auth middleware story and the enrollment story cannot be built independently from the current text.

### H2 — Operator authentication is undefined, and there are two operator paths
**Cites:** AD-3 diagram (`cli["operator cli"] --> core`), AD-8 operator routes (`POST /api/invites`, `GET /api/invites`, `DELETE /api/invites/:id`, `POST /api/bans`, `DELETE /api/bans/:id`), AD-7.
AD-3's diagram shows the operator CLI as an in-process adapter straight to core; AD-8 freezes operator **HTTP** routes. Nothing says how those routes authenticate: session tokens are actor-scoped, and an operator is not necessarily an enrolled actor. So the CLI story and the API story can diverge (in-process core calls vs. HTTP with an unspecified operator credential), and remote operator use is undefined. Decide: either the CLI is host-local only (talks to core in-process, HTTP operator routes dropped or operator-token-authed), or operator routes carry a distinct operator credential inside AD-7's auth stage.

### H3 — The viewer's path through the spine is unresolved; `/health` missing from the frozen routes
**Cites:** AD-7, AD-8 (`GET /api/rooms/:id/events (SSE, viewer/back-compat)`), Capability map FR-18 row ("api SSE (existing /events pattern ratified)"), FR-18 ("the viewer token... is never accepted by the API"), FR-4 ("the health endpoint answers").
FR-18 forbids the viewer token on the API, yet AD-8 labels a `/api/...` route as viewer-facing and the map routes FR-18 through "api SSE." The spine never says which routes the viewer actually calls (v0.1's viewer is its own token-authed GET-only surface with host/origin checks and `?token=` query acceptance — the latter explicitly banned by FR-18, so "existing pattern ratified" must be scoped carefully), nor how a viewer request passes AD-7's session-token stage. Additionally `/health` — present in v0.1 (`roomd.mjs:271`), required by FR-4's success boundary — is absent from the frozen route list. Name the viewer route set, its token's place in the AD-7 order, the loopback/origin gate, and `/health` (or explicitly scope the freeze to `/api/*` and list the non-API surface).

## MEDIUM

### M1 — AD-9's "all numeric limits" list omits several PRD-mandated numbers
**Cites:** AD-9; FR-16 (5 s duplicate window), FR-22 (warn <1 GiB / refuse <256 MiB), FR-12 (backoff 1–60 s + jitter), FR-10 (100-entry held cap), FR-5 (24 h offline bucket), FR-18 (5 s viewer freshness).
The rule promises all numeric limits live in one module, but the enumeration omits the duplicate-window, storage thresholds, reconnect backoff bounds, held cap, offline-bucket window, and viewer freshness bound. Each omission is a place where client, server, and tests can independently hard-code a different number — the exact divergence AD-9 exists to prevent.

### M2 — AD-4's migration contract is silent on `reply_to_seq`; reply threading's v0.2 fate is undecided
**Cites:** AD-4; AD-8 send route; `database.mjs:200,206–207` (`reply_to_seq` with FK to `messages(room_id, seq)`).
v0.1 messages carry `reply_to_seq` with a self-FK on `(room_id, seq)`. AD-4's "re-sequence each room 1..n" breaks every reply reference unless `reply_to_seq` is remapped in the same migration — the store story can silently skip it. Separately, no AD decides whether v0.2's send/read API keeps reply threading at all (no FR requires it; the PRD only alludes to "reply contexts" in FR-16). Decide keep-or-drop, and if kept, add reply remap to AD-4's migration contract.

### M3 — AD-8 freezes route names but not field names
**Cites:** AD-8 ("frozen contracts" / "Prevents: route/shape drift").
The envelope and routes are fixed; per-route request/response fields (`after_seq` vs v0.1 viewer's `after`, `include_offline`, `wait_ms`, `chat_id`, `client_message_id`, ack shape per FR-20) are not. For an AD whose stated purpose is preventing client/server shape drift, the unfrozen half is the half that drifts. Either enumerate field names per route (most are already determined by v0.1 + PRD) or explicitly delegate field-level freezing to a named story with a conformance test as its enforcement point.

### M4 — Capability→Architecture map is incomplete
**Cites:** Capability map; frontmatter `binds: [FR-1..FR-22, NFR-1..NFR-8]`.
No rows for FR-4 (bound by AD-2/AD-10) or FR-21 (bound by AD-8); NFR-1, NFR-3..NFR-8 appear only in AD `Binds:` lines while only NFR-2 has a row. All capabilities are owned somewhere, but the map is the gate's cross-check surface — add the missing rows (FR-21's row should also assign the `room_status` realm-name source) or state the table's scope explicitly.

### M5 — Heartbeat mechanism is undecided
**Cites:** AD-6 ("heartbeat-driven"), AD-9 (heartbeat 60 s ±10%), AD-8 (no heartbeat/ping route), FR-5.
FR-5 requires periodic heartbeats and refreshes liveness on any authenticated request, but AD-8 defines no ping route and the spine never says which existing request the MCP adapter should use to keep an otherwise-idle session live (presence GET? status?). The MCP-adapter story and the presence story need this named.

### M6 — The spine contradicts the repo's standing GET-only policy without ratifying the change
**Cites:** AD-8; workspace `AGENTS.md` ("the HTTP server is strictly GET-only and requires a viewer token"); FR-18 ("the GET-only rule scopes to the viewer surface").
v0.2's server carries POST/PATCH/DELETE API routes. That evolution is PRD-sanctioned, but AGENTS.md is the instruction file every build agent reads in this repo; left unamended it actively contradicts the spine. Add one ratifying sentence (policy narrows to the viewer surface) and flag AGENTS.md for update in the epics.

## LOW

### L1 — Orphan code fence; only two mermaid diagrams; hyphenated subgraph ids
**Cites:** line 98 (stray ``` between AD-7's diagram and AD-8), AD-3/AD-7 diagrams.
The stray unclosed fence after AD-7 swallows AD-8 through the Stack table in rendered markdown — and suggests a third diagram (the review brief expected three) was lost in editing. Both surviving diagrams parse (standard node/edge syntax; quoted labels; `-- "text" -->` edges; rhombus decisions; cylinder store shape), but prefer underscore subgraph ids (`client_side`) over `client-side` for parser safety.

### L2 — AD-7's diagram shows only "session token?" — the local-token auth class (AD-1) is not represented
Cosmetic inconsistency between AD-1's local trust mechanism and the pipeline diagram; the text of H1's fix resolves it.

### L3 — `cli/` seed omits the human-facing client command
**Cites:** Structural Seed ("cli/ — operator CLI entrypoints (serve, invite, ban)"); FR-10 (`agent-room allow <chat-id>`).
The one-step allow/remove actions are plugin-local (AD-12) but their entrypoint has no named home; a story writer could invent a second CLI surface. Add `allow` (and remove) to the seed's `cli/` comment or to `client/`.

### L4 — Broadcast Room lifecycle unassigned
**Cites:** Capability map FR-6/7 row; FR-1 ("joins the Broadcast Room automatically").
Creation at first boot, auto-join at enrollment, and a stable identifier for the single Broadcast Room are implied (core/rooms) but never assigned. One sentence in AD-6 or the map prevents story-level invention.

### L5 — Stack nit: "SSE" is not a Node built-in module
**Cites:** Stack table. SSE is hand-rolled over `node:http` (v0.1 does so); phrase it as such so nobody hunts for a module. Related viewer nit folded into H3: do not let "existing /events pattern ratified" carry over v0.1's `?token=` query-string acceptance, which FR-18 bans.

---

## Verdict

**pass-with-fixes.** The spine is genuinely good: the twelve ADs target the real divergences, the brownfield ratifications all check out against source, the deliberate unix-socket retirement is sanctioned, tech choices are current, and no capability of the PRD is unowned. But three high findings (AD-7's pre-auth contradiction with FR-14, undefined operator authentication, unresolved viewer path + missing `/health`) sit exactly at the seams where independently built stories would diverge, so they should be fixed before the spine is ratified for epic breakdown. All fixes are amendments, not restructuring.
