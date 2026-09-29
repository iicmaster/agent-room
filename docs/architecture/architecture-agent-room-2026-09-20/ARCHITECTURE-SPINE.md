---
name: agent-room-v0.2
type: architecture-spine
purpose: build-substrate
altitude: feature
paradigm: hexagonal (ports & adapters) around a single realm core
scope: Agent Room v0.2 — MCP plugin + self-hostable Room Server (one server = one realm)
status: final
created: 2026-09-20
updated: 2026-09-20
binds: [FR-1..FR-22, NFR-1..NFR-8]
sources:
  - docs/prds/prd-agent-room-2026-09-20/prd.md
  - docs/prds/prd-agent-room-2026-09-20/addendum.md
companions: []
---

# Architecture Spine — agent-room-v0.2

## Design Paradigm

**Hexagonal (ports & adapters) around a single realm core.** One core — rooms, durable logs, presence, identity, policy — depends on nothing; every transport and the store are adapters around it. The MCP stdio server is an adapter on the *client* side; it is not the system's front door — the wire API is. A realm's entire state lives in one SQLite file owned by one server process.

v0.1's flat modules map onto this without renaming the world: `database.mjs` → store adapter; `roomd.mjs` → HTTP API adapter + host; `mcp-stdio.mjs` → client-side MCP adapter; `runtime.mjs` → runtime/identity facilities shared by both sides; the domain logic currently scattered in `roomd`'s dispatch becomes `core/`.

## Invariants & Rules

### AD-1 — One wire protocol for everyone (single transport)

- **Binds:** FR-2, FR-8, NFR-8, D12; all client↔server traffic
- **Prevents:** dual-transport drift (local and remote clients seeing different contracts, two auth paths, two framings to keep in sync — the divergence v0.1's unix-socket IPC would force under v0.2)
- **Rule:** All client↔server communication — Local Mode included — is the Agent-Room JSON API over HTTP(S) with the `Agent-Room-Protocol: 1` header on actor and pre-auth routes (viewer and health classes are exempt per AD-7; NFR-8). The v0.1 unix-socket daemon protocol (`daemon-client.mjs` framing) is **retired**; Local Mode is a Room Server bound to `127.0.0.1` with an ephemeral port published in `runtime.json`, authenticated by a local token file (0600) in the shared data dir. The MCP stdio adapter is a *client* of this API, exactly like any future non-MCP client. MCP stdio remains the only agent-facing tool surface.

`[ASSUMPTION: localhost HTTP + token file is accepted as the local trust mechanism — equivalent to v0.1's socket-perms model under the same OS-user boundary (FR-1/C4); one extra file, no daemon-client layer.]`

### AD-2 — One process, one realm, one writer

- **Binds:** FR-4, FR-11, NFR-7, D2
- **Prevents:** split-brain state, cross-realm coupling, competing writers on one SQLite file
- **Rule:** A Room Server process owns exactly one realm = one data dir = one SQLite database (single writer via `BEGIN IMMEDIATE`, ratified v0.1). No process serves two realms; no realm has two processes. Multi-realm deployment = multiple processes. Horizontal scale is out of scope by design.

### AD-3 — The core never sees a transport

- **Binds:** paradigm; FR-5..FR-8, FR-14..FR-17, FR-20
- **Prevents:** domain logic forked per transport or smeared across route handlers (v0.1's dispatch-on-method pattern)
- **Rule:** `core/` modules export transport-neutral operations (enroll, connect-session, send, read, presence, rename, open-direct, invite-ops, ban) returning plain results or typed `Error` objects with snake_case codes. Adapters (HTTP API, MCP tools, operator CLI) translate; they contain no policy. Dependency direction is one-way: adapters → core → store. `core/` imports no `node:http`, no MCP SDK, no CLI lib.

```mermaid
flowchart LR
  subgraph client-side["client side (per installation)"]
    mcp["mcp-stdio<br/>(MCP adapter)"] --> apiclient["api-client"]
    mcp --> rt1["runtime: keys, config, cursors"]
  end
  subgraph server-side["Room Server (one process per realm)"]
    http["http api + sse<br/>(adapter)"] --> mw["middleware pipeline<br/>(AD-7)"] --> core["core<br/>(rooms · logs · presence ·<br/>identity · policy)"]
    cli["operator cli<br/>(adapter)"] --> core
    viewer["viewer (static)"] --> http
    core --> store[("store adapter<br/>SQLite WAL")]
  end
  apiclient -- "JSON over HTTP(S)<br/>Agent-Room-Protocol: 1" --> http
```

### AD-4 — Room-local sequences, client-owned cursors

- **Binds:** FR-8, FR-11, FR-20, NFR-7, D16
- **Prevents:** global-sequence coupling between rooms (v0.1's single AUTOINCREMENT), cross-room gap confusion, server-side per-client state
- **Rule:** `messages` is keyed `(room_id, seq)`; `seq` is allocated inside the write transaction as `max(seq)+1` per room (safe under the single writer). Room-local sequences are contiguous from 1. The server stores **no** per-client delivery state; cursors live in plugin data per `(installation, realm, room)`. Reply threading survives (`message_send` keeps `reply_to_seq`, per FR-21's "existing contracts"): the v1→v2 migration builds each room's old→new sequence map and remaps `reply_to_seq` in the same transaction. The migration itself is one startup step on a v0.1 database: absorb or stop any live v0.1 daemon first (pid from `runtime.json`), then a single `BEGIN IMMEDIATE` transaction performs detect (`user_version`) → re-sequence + reply remap → stamp v2 — a crash mid-migration resumes idempotently on next boot. Re-sequencing is a one-time, documented cursor reset at upgrade (v0.1 never persisted client cursors, so only in-flight conversation continuity breaks).

### AD-5 — Identity: one keypair per installation, proven per connection

- **Binds:** FR-3, FR-12, NFR-3, D5, D13
- **Prevents:** self-asserted identity, identity in request bodies, replay of captured credentials
- **Rule:** Each installation holds one Ed25519 keypair (`node:crypto`), stored beside `identity.json` in PLUGIN_DATA; the Actor's fingerprint is **SHA-256 over the raw 32-byte public key** (one canonical input, fixed forever — SPKI-DER digests differently, and AD-6's direct-room pair ids inherit this choice). Remote connection = challenge-response: server issues a nonce, client signs with the private key, server verifies and issues a short-lived session bearer token `[ASSUMPTION: TTL 12 h, sliding refresh on activity — ratified 2026-09-29 by Story 4.1: the 12 h sliding TTL stands as declared; the registry is in-memory so restarts dominate the reconnect cadence the substrate exercises (churn cycles, kill/restore drills, the ECONNREFUSED recovery loop) and every re-auth is single-flight and transparent, so a shorter TTL buys no security]`; every subsequent request authenticates via that token — actor identity is resolved from the token in middleware, never read from a request body. Local Mode issues the **same** session token through `POST /api/auth/local`, using the long-lived local token file (0600, shared data dir) as the bootstrap credential — one session mechanism, two issuance paths (Ed25519 challenge remotely, local token file locally); the local token file itself is never a per-request credential. Enrollment (invite-gated, atomic, per FR-14) registers the public key once; reconnects re-prove it. *(Amended 2026-09-29 by Story 4.1 implementation — the durable enrollment registry joins the decision, additively: the enrolled_actors table (STRICT, additive open-path convergence, no schema-version bump) records each enrolled fingerprint once, its only writer in Story 4.1 being the existing Local Mode auto-enrollment success path; the challenge route issues nonces to any well-formed 32-byte public key — issuing a nonce is privilegeless, and Story 4.2's invite enrollment is itself a challenge-response consumer — while the answer route consumes the nonce before verifying the signature against the challenge-recorded key and gates on the enrollment record, so reconnects re-prove possession without re-enrolling and identity cannot be substituted at answer time.)*

### AD-6 — Session and Chat ID registry is server-resident and ephemeral

- **Binds:** FR-19, FR-5, D13
- **Prevents:** name-collision races, rename ambiguity, presence contradicting the participant model
- **Rule:** Connected state (live sessions, Chat-ID→session→actor mapping, liveness timestamps) is server-resident and heartbeat-driven; it is cache/registry, never the source of truth — restart clears it and presence rebuilds from heartbeats. **Offline identity data is durable:** a bounded `chat_id_claims(chat_id, actor_fingerprint, last_seen_at)` index plus per-Actor `last_seen_at` survive restart (pruned at 7 days, operator-tunable), so FR-5's 24-hour offline bucket and FR-21's open-by-name to offline peers work after a restart; multiple Actors may hold claims on one name — that is exactly what `ambiguous_chat_id` resolves. Chat-ID uniqueness is enforced among *currently connected* sessions only, with explicit-error refusal (no suffixing). Messages persist the sending Chat ID (attribution at send time, never rewritten). Direct Rooms key on the canonical unordered actor-pair id: **`direct:<fp_min>:<fp_max>` — the two key fingerprints colon-joined in lexicographic order; a same-Actor room uses the same fingerprint twice** (D14). *(Amended 2026-09-20 twice after review: the original `<min(fprA,fprB)>` spelling read as a one-operand formula and would collide distinct pairs; the durable claims index was added because ephemeral-only state could not serve FR-5/FR-21 across restarts.)*

### AD-7 — One middleware pipeline over four route classes

- **Binds:** NFR-8, FR-14..FR-16, FR-18, FR-22, D17
- **Prevents:** gates evaluated in different orders per route (e.g., a rate-limited actor burning invite checks; a version-rejected request mutating state) and exempt-route drift (unthrottled enrollment, viewer tokens leaking onto the API)
- **Rule:** Every request passes through exactly one pipeline, ordered: **protocol-version check → transport check (HTTPS required off-loopback) → authentication → budgets → authorization → handler**. Each route declares exactly one class, which fixes how the stages apply:
  - **actor** — session-token authenticated (AD-5); budgets by Actor key; room ACLs apply.
  - **pre-auth** (`/api/auth/*`) — no session token; budgeted per source IP (enrollment 5/min burst 5) plus a global pre-auth floor; banned keys are rejected at authorization.
  - **viewer** (`/viewer/*`, viewer SSE) — authenticated by an HttpOnly, SameSite=Strict cookie minted via `GET /viewer/auth` (presenting the viewer token as a Bearer header). The viewer token and cookie are valid on no other class; session tokens are valid on no viewer route; **no credential ever travels in a query string** (this replaces v0.1's `?token=` acceptance — required by FR-18, and cookies are what make EventSource usable without query strings).
  - **health** (`GET /health`) — unauthenticated, side-effect-free liveness only (ratified from v0.1).
  A rejection at any stage, in any class, changes no state, consumes no invite use, advances no cursor. The **protocol-header stage applies to actor and pre-auth classes only** — viewer and health classes are exempt (browsers and EventSource cannot set custom headers, per PRD NFR-8's carve-out); viewer API versioning rides the minted cookie. Challenge nonces are single-use, ≥16 random bytes, expiring within 60 seconds. Handlers contain no gate logic. The MCP adapter's Client Gates (untrusted framing, held-message metadata) shape *responses* client-side and are never duplicated server-side.

```mermaid
flowchart LR
  req["request"] --> v{"protocol<br/>header?"} -- fail --> e400["400 · no state change"]
  v -- ok --> t{"TLS/loopback?"} -- fail --> eref["refused"]
  t -- ok --> a{"session<br/>token?"} -- fail --> e401["401"]
  a -- ok --> r{"budgets?"} -- fail --> e429["429 · rate_limited"]
  r -- ok --> z{"ban / ACL?"} -- fail --> e403["403"]
  z -- ok --> h["handler → core → store"]
```

### AD-8 — Wire API surface (v1): routes, vocabulary, and envelope are frozen contracts

- **Binds:** NFR-8, FR-17, FR-21, D15
- **Prevents:** route/shape drift between server versions and independently-built clients — including field-name drift (`after_seq` vs `cursor`) between an API team and an MCP-adapter team that each comply with the route list
- **Rule:** JSON envelope `{ok, result|error:{code,message}}`, snake_case error codes from a `PUBLIC_ERRORS` whitelist, unknown → `request_failed` (v0.1 ratified). Route table (unversioned paths; the header carries the version), by class per AD-7:
  - **actor:** `POST /api/session` · `PATCH /api/session` · `DELETE /api/session` · `GET /api/presence` · `GET /api/rooms` · `POST /api/rooms/direct` · `GET|POST /api/rooms/:id/messages` · `GET /api/status`
  - **pre-auth:** `POST /api/auth/enroll` · `POST /api/auth/challenge` · `POST /api/auth/answer` · `POST /api/auth/local` *(Amended 2026-09-25 by Story 1.4 implementation: POST /api/auth/local accepts the frozen-vocabulary request field public_key (additive per NFR-8) — Local Mode auto-enrollment under the OS-user boundary; the local token file remains the bootstrap credential, and public-key presentation is NOT possession proof: no signature check happens locally, challenge-response stays Epic 4's remote path. The session it issues binds the installation's Actor fingerprint — SHA-256 over the raw 32-byte public key.)*
  - **viewer:** `GET /viewer/auth` · `GET /viewer/` + static assets · `GET /viewer/api/rooms/:id/messages` · `GET /viewer/api/rooms/:id/events` (SSE)
  - **health:** `GET /health`
  No operator routes exist (AD-13). Additions only, per NFR-8 additive policy; unknown request fields are rejected, not ignored.

  **Frozen field vocabulary** (canonical names — additive fields may join, names never rename): requests `chat_id`, `client_message_id`, `text`, `reply_to_seq`, `after_seq`, `limit`, `wait_ms`, `include_offline`, `invite_token`, `public_key`, `nonce`, `signature`, `realm_id`, `target_fingerprint` *(added 2026-09-20 after story review — the optional disambiguator for `room_direct_open` when a Chat ID maps to multiple offline Actors; without it `ambiguous_chat_id` is a dead end)*, `client_type` *(added 2026-09-25 by Story 1.6 implementation — the optional client type a session declares at bind time on POST/PATCH /api/session, validated against the closed set mcp, cli, api declared once in the constants module; an omitted declaration stays null on the presence row — v0.1's MCP-client-derived naming is retired, the server never derives or guesses a client type)*; responses `messages[]`, `seq`, `next_after_seq`, `head_seq`, `room_id`, `kind`, `fingerprint`, `last_seen`, `connected_since`, `status` *(Amended 2026-09-25 after review: `version` and `realm_id` join the response vocabulary — realm_id is AD-14's stable realm key exposed by GET /api/status, and version self-describes GET /api/status and GET /health)*, `session_token` *(added 2026-09-25 by Story 1.4 implementation — the local credential exchange POST /api/auth/local returns the session bearer token under this name; the local token file itself never appears on the wire)*, `broadcast_room_id` *(added 2026-09-25 by Story 1.6 implementation — the implicit Broadcast Room's opaque id exposed by GET /api/status for FR-21 and consumed by the Story 1.8 checkpoint; minted at first boot, never fabricated)*, `online`, `offline_recently`, `chat_id`, `client_type` *(added 2026-09-25 by Story 1.6 review — the GET /api/presence response's two explicitly-labeled groups and their per-row fields: online rows carry chat_id in display form, client_type, connected_since, last_seen, and fingerprint; offline_recently rows carry chat_id, fingerprint, and last_seen — the durable claims index holds no client type, so an offline row never carries one; the group labels describe reachability, never enrollment)*, `candidates` *(added 2026-09-25 by Story 1.7 implementation — the optional candidate list the ambiguous_chat_id error carries on POST /api/rooms/direct: one row per Actor holding a durable claim on the requested chat id, most recent first, each carrying fingerprint and last_seen; the error never guesses — target_fingerprint completes resolution)*, `rooms` *(added 2026-09-28 by Story 2.2 implementation — the enumeration GET /api/rooms returns: one row per room the reading Actor belongs to, the Broadcast Room with its implicit AD-14 membership plus every Direct Room whose membership row names the Actor, each row carrying the room id and kind in the store's deterministic created-then-id order; the projection is minimal by design, since pair keys embed member fingerprints and titles, creators, and timestamps serve no discovery purpose, so they never leave the store)*, `nonce` *(added 2026-09-29 by Story 4.1 implementation — the single-use challenge nonce that POST /api/auth/challenge issues and POST /api/auth/answer spends: 32 random bytes carried base64url, bound at issue time to the presented 32-byte public key, expiring within 60 seconds, and burned by the first answer attempt whatever its outcome so a failed answer cannot be retried against it and a captured answer cannot be replayed; the answer route's frozen request fields remain nonce and signature only, so identity binds at challenge time and no key can be substituted there)*. **Read semantics:** `after_seq` is strictly-greater, default 0, page ≤ 200; `wait_ms` ≤ 20,000 default 0, measured as server hold time; a deadline return is a normal page, possibly empty — never a 204. **Send semantics:** response `status` is exactly one of `committed | rate_limited | duplicate_dropped | storage_low | client_message_id_conflict | banned`; on the write path the idempotency tuple is checked **before** the duplicate gate (an exact retry returns the original committed message and consumes nothing; the 5 s gate applies only to new sends). Every error code's HTTP status is declared once in the constants module (AD-9), never per-route.

  *(Amended 2026-09-29 by Story 4.2 implementation — the invite-gated enrollment route joins the live pre-auth surface, additively. The enroll route now carries exactly three frozen request fields, `invite_token`, `public_key`, and `signature`, all already in the vocabulary: the presented token must match the ar_inv1_ shape, the raw 32-byte public key DERIVES the enrolled fingerprint (identity is never claimed), and the Ed25519 signature over the exact token bytes is the possession proof, validated inside the single enrollment transaction before any use is consumed. The response adds no field. The route is rate-limited at the enrollment budget (5/min per client identity, burst 5) by the budgets stage, and forwarded addresses are honored only when the operator explicitly configures a trusted proxy.)*


### AD-9 — Limits are named once and mirrored everywhere

- **Binds:** NFR-5, FR-6, FR-8, FR-16; v0.1 ratified convention
- **Prevents:** the same bound drifting between store, API, client, and tests
- **Rule:** All numeric limits live in one constants module and are referenced by name: message text ≤ 32,768 chars · request/response frames ≤ 1 MiB · read page ≤ 200 · long-poll hold ≤ 20,000 ms (server hold time) · token bucket 0.5/s refill, capacity 10 · request budget 120/min/key burst 30 · enrollment 5/min/IP burst 5 · heartbeat 60 s ±10%, TTL 180 s · invite default 1 use/24 h · session token TTL (per AD-5) · duplicate-gate window 5 s · storage gates warn <1 GiB / refuse appends <256 MiB · reconnect backoff 1 s → 60 s · held cache 100 · offline-recently window 24 h · viewer freshness 5 s · SSE keep-alive comment ≤ 30 s. The same module declares every `PUBLIC_ERRORS` code's HTTP status — one table, never per-route. Changing a limit changes one line and every enforcement point follows. *(Amended 2026-09-25 by Story 1.4 implementation — the local bootstrap limits join the mirror by name: server startup wait 20 s (exceeding the lock window) · startup lock stale 15 s · startup lock file cap 512 bytes · attach poll 50 ms · health probe timeout 750 ms · health probe read cap 64 KiB · owned-child reap grace 2 s · session registry capacity 1000 · session token entropy 256 bits / presented credential cap 256 chars · local token file cap 4 KiB.)* *(Amended 2026-09-28 by Story 2.2 implementation — the reconnect backoff's remaining knobs join the mirror by name: RECONNECT_BACKOFF_JITTER, the uniform ±0.1 fraction around each base delay of the FR-12 schedule, rounded to whole milliseconds · RECONNECT_RECOVERY_PROBE_MS, 250 ms, the cadence at which a backoff wait probes the recorded server's health read-only so a detected agent-room answer cuts the wait and permits an immediate attempt.)*

### AD-10 — Local Mode is a configuration, not a code path

- **Binds:** FR-1, FR-4, SM-C1, D9
- **Prevents:** a special-cased "local mode" fork that drifts from the server the OSS world runs
- **Rule:** Local Mode = the same Room Server binary bound to `127.0.0.1` (ephemeral port in `runtime.json`, as v0.1), automatic enrollment (OS-user boundary), no invite needed, same API. The localhost server **always** uses the shared data dir (`AGENT_ROOM_DATA_DIR` or `~/.agent-room`), never PLUGIN_DATA (client state only) — two clients on one machine always converge on one server and one realm. The MCP adapter's `ensureServer` (evolved from `ensureDaemon`: hardlink startup lock, stale after 15 s, detached spawn, readiness poll — ratified pattern) boots it on first use; the race loser waits, then attaches to the winner via `runtime.json` (pid + port + version). A stale `runtime.json` is detected by pid-liveness plus an unauthenticated `GET /health` probe against the recorded port; only a dead-and-unreachable entry is reclaimed. Remote Mode differs only by: configured URL, TLS required, challenge auth, invite-gated enrollment. Feature checks like `if (local)` are confined to the api-client and enrollment paths; core and store are mode-blind.

### AD-11 — Crypto is boring and built-in

- **Binds:** NFR-1, FR-3, FR-14, NFR-4, D15
- **Prevents:** dependency creep, exotic crypto, home-rolled primitives
- **Rule:** Ed25519 sign/verify (`node:crypto`), SHA-256 digests, `randomBytes` base64url tokens (v0.1 pattern), timing-safe comparisons (v0.1 pattern). Invite tokens per FR-14 (`ar_inv1_` + 43 chars, SHA-256 stored). TLS via `node:https` with operator-supplied certs; the documented reverse-proxy recipe (Caddy) fronts the same handler; plaintext is permitted only on loopback (local server and same-host proxy backend). No JWT, no X.509 machinery, no crypto libraries.

### AD-12 — Client trust state is plugin-local and key-bound

- **Binds:** FR-10, FR-12, FR-20, D13
- **Prevents:** trust decisions leaking into the server's client-request path; handle-based trust
- **Rule:** The plugin (PLUGIN_DATA) owns, per realm: session cursors, the Allowlist (Actor key fingerprints), held-message cache, local config (server URL, enrolled key). None of this is server-resident. Trust binds fingerprints (D13); Chat IDs are labels. The one-step allow/remove actions operate on this local state only. *(Amended 2026-09-28 by Story 3.2 implementation — the Allowlist's concrete form and evaluation point join the decision, additively. The Allowlist lives beside the cursors at `PLUGIN_DATA/realms/<realm_id>/allowlist.json` (0600, atomic writes, same machinery; the realm directory stays 0700) as `{version, accept_all, entries:[{fingerprint, added_at, note?}]}` — fingerprints and human-bookkeeping only; a Chat ID is never stored (D13). The trust matrix is evaluated CLIENT-side by the plugin at message-delivery time, in priority order: own Actor (exact fingerprint equality — Plugin-enforced) → local transport, meaning the receiving installation's own session authenticated through the local token file path so every sender on that loopback realm crossed the same OS-user boundary (deliver, honestly labeled Instructed — same-user processes are not cryptographically distinguishable) → allowlisted remote sender (deliver, Plugin-enforced: the plugin compares the sender's fingerprint against the stored entry) → per-realm accept-all set by a human (deliver, Instructed: a blanket opt-in with no per-sender verification; the untrusted envelope's framing on the delivered body is unchanged) → everything else HELD (Plugin-enforced body withholding: the row keeps its metadata, its text becomes a held marker with the matrix reason recorded, and no body byte reaches the tool result; the full held pipeline — metadata-only surface, held cache, recovery, release — is Story 3.3/3.4's). A remote sender "claiming same-machine" has no branch: names are not an input to the matrix. Removal affects future delivery only — evaluation is at delivery time, so already-ingested text is never retroactively withdrawn and the durable log is never rewritten. The agent-facing surface grows by exactly two additive MCP tools, `room_trust_list` (realm, accept_all, entries) and `room_trust_set {target_fingerprint, allowed}` (idempotent add/remove; `target_fingerprint` reuses the existing vocabulary name for a fingerprint that is an operation's target, never sender identity), both operating on this plugin-local state only and making NO wire-API change — AD-8's route table and frozen field vocabulary are untouched because these tools never cross the wire. Accept-all is deliberately unreachable from any agent tool: the schema closes without it and the storage API that flips it belongs to the human CLI (Story 3.4); its default is false everywhere — a missing or corrupt file degrades to the default, never to trust.)* *(Amended 2026-09-28 by the Story 3.3 implementation — the held-message cache's concrete form joins the decision, additively. The held pipeline lives beside the cursors and the Allowlist at `PLUGIN_DATA/realms/<realm_id>/held.json` (0600, atomic writes) as `{version, entries:[{room_id, seq, chat_id, actor_fingerprint, created_at, size, held_reason, registered_at, body?, cached_at?}]}`, keyed (realm, room, seq). The agent-visible half is a fixed whitelist projection — realm, sender Chat ID, Actor fingerprint, room, sequence, time, byte size, and the realm held count — so no body byte can reach any tool result: the MCP surface grows by exactly two additive tools, `room_held_list {room_id?}` and `room_held_count {}`, and the adapter never imports the pipeline's body-recovery and release functions (the human preview and release belong to Story 3.4's CLI; no auto-approve exists). The body cache holds at most HELD_CACHE_MAX (100) copies, drop-oldest by caching time; eviction drops only the cached BODY COPY — the record is never deleted, approved, or skipped — and recovery after eviction point-reads the room log (`after_seq = seq − 1`, `limit = 1`) through the api-client, byte-identical to the cached artifact. Held state is separate from the cursors (FR-20): the adapter registers held rows AFTER the cursor persists, so a held message never stalls the cursor and a cursor advance never loses the held record.)* *(Amended 2026-09-29 by the Story 3.4 implementation — the human CLI surface joins the decision, additively, and the "settable ONLY through the human CLI surface" promise comes due. The `agent-room` bin's command family is `setup`, `held list [--room <room_id>]`, `held show <room_id>:<seq>`, `allow <chat-id> [--fingerprint <fingerprint>] [--remove]`, `allow-all [--remove]`, and `help`. `held show` is the ONLY surface where held body text appears — the record's metadata plus the exact artifact the delivery pipeline withheld (the cached copy, or the point-read recovery `after_seq = seq − 1`, `limit = 1` with the untrusted envelope re-applied exactly as the api-client applies it, so the recovered preview byte-matches the cached artifact and is never re-cached) — while `held list`, `allow`, `allow-all`, the help text, and every error message carry metadata at most. The CLI session is UNBOUND: every command exchanges the shared data dir's local token plus the installation public key for a session token bound only to the Actor fingerprint and never claims a Chat ID — the session-bind route is never sent — so the commands run collision-free while the live MCP session holds the configured name and leave zero presence or durable-claim footprint; the commands never read `config.json`. `allow` resolves a Chat ID to its key fingerprint from exactly two local-truth sources — this realm's held records and `GET /api/presence?include_offline=true` (online and offline-recently rows, chat id + fingerprint + last-seen) — compared case-insensitively (DR-1) and merged by fingerprint; zero candidates refuses with guidance, several refuse with the candidate list (fingerprint + source/last-seen), one proceeds, and `--fingerprint` must be a well-formed fingerprint AND one of the name's candidates — never a silent guess (HCI-4). A grant saves the entry first, then releases every held record whose `actor_fingerprint` equals the resolved fingerprint via `heldClear` per (room, seq) — matched by fingerprint, never by name (D13); `allow --remove` removes only the entry, affecting future ingestion only. `allow-all` flips `accept_all` through `setAcceptAll` behind an explicit interactive TTY y/N confirmation (non-TTY stdin is refused with guidance), while the `--remove` variants are fail-safe directions and run without confirmation. Approval is stated plainly as a human convention (Instructed) — same-user processes are not cryptographically distinguishable — in the help text and the allow-all report, with no enforcement overclaim anywhere.)*

### AD-13 — Operator surface is in-process CLI, never HTTP

- **Binds:** FR-14, FR-15, FR-22, UJ-4, AD-2
- **Prevents:** two operator paths diverging (in-process CLI vs HTTP routes), and any wire surface on which an enrolled actor could become an operator
- **Rule:** Operator actions (invite mint/list/revoke, ban/unban, capacity status) run via the CLI entrypoint **on the server host**, calling core in process. No operator routes exist in the wire API (AD-8); the API cannot mint invites or ban. Authentication is the host boundary itself: the operator is the OS user who runs the server process. Remote operator APIs are deferred indefinitely.

*(Amended 2026-09-29 by Story 4.2 implementation — the operator CLI host is established with the invite command family, additively: the agent-room bin gains invite mint (the raw token printed exactly once; only its SHA-256 digest persisted), invite list (digest prefix, uses remaining, expiry, revoked — never a secret), and invite revoke by digest prefix. The host opens the store directly, in process, with no operator HTTP route; output is JSON lines with stable exit codes (0 ok, 1 refusal, 2 usage), the grammar later operator stories reuse. Ban (Story 4.5) and capacity (Story 4.6) join this same host.)*


### AD-14 — Broadcast membership is implicit; plugin state is keyed by realm id

- **Binds:** FR-6, FR-7, FR-12, AD-12, D13
- **Prevents:** join/leave verb drift for the commons; per-realm client state colliding or inheriting trust across servers
- **Rule:** Every enrolled Actor is a member of the Broadcast Room from enrollment — no join/leave verbs exist for it (v0.1's `room_create`/`room_join` are retired from the tool surface). The server publishes a stable `realm_id` (random UUID minted at first boot, exposed by `GET /api/status`); all plugin-local per-realm state (cursors, Allowlist, held cache) is stored under that id. A rebuilt or migrated server is a new realm and starts with fresh trust (D13).

## Consistency Conventions

| Concern | Convention |
| --- | --- |
| Naming | files/dirs kebab-case; functions camelCase; error codes, DB columns, API fields snake_case (ratified v0.1) |
| Data & formats | JSON everywhere; ids opaque base64url strings (rooms, invites); fingerprints `sha256:`-prefixed hex; timestamps ISO 8601 UTC; error envelope per AD-8 |
| State & mutation | writes only inside `BEGIN IMMEDIATE` transactions in the store adapter; core never touches SQL strings; append-only message log — no UPDATE/DELETE on messages |
| Errors | typed Error objects carrying a `code` property, built by v0.1's Object.assign pattern; PUBLIC_ERRORS whitelist for anything crossing the wire |
| Files & permissions | dirs 0700, files 0600, sockets/pipes none (no unix socket in v0.2); state files must be regular, non-symlink, size-bounded (ratified `runtime.mjs` gates) |
| Logging | stderr only, `agent-room`-prefixed, silent in steady state, secrets redacted (tokens, invite secrets, private keys never logged) (ratified) |
| Modules | native ESM `.mjs`, zero deps, frozen exports where v0.1 froze them |
| Tests | `node:test` + `node:assert/strict`; real child processes with tmpdir `PLUGIN_DATA`/data dirs (ratified pattern); every AD's enforcement point has a test that fails when the AD is violated |

## Stack

| Name | Version |
| --- | --- |
| Node.js (built-ins only; no npm deps) | ≥ 24.15 on stock builds (bundles SQLite ≥ 3.51.3); the runtime gate asserts the SQLite version regardless |
| SQLite via `node:sqlite` | ≥ 3.51.3 (asserted at startup); node:sqlite is Stability 1.2 (release candidate) since 24.15 — no ExperimentalWarning |
| `node:crypto` (Ed25519, SHA-256, randomBytes) | built-in |
| `node:http` / `node:https` / SSE | built-in; SSE keep-alive comments ≤ 30 s (proxy idle budgets) |
| MCP stdio | spec revision 2026-07-28 |
| Viewer | vanilla HTML/CSS/JS (no framework, no build step) |

## Structural Seed

```text
server/
  core/        # domain + policy: rooms, log, presence, identity, enrollment, gates
  store/       # SQLite adapter (schema, migrations, transactions)  [evolves database.mjs]
  api/         # HTTP+SSE server, middleware pipeline, routes       [evolves roomd.mjs]
  client/      # api-client (local+remote), ensureServer, cursors   [replaces daemon-client.mjs]
  mcp-stdio.mjs# MCP adapter (client side)
  runtime.mjs  # paths, permissions, keypair, identity, limits      [evolves]
  cli/         # operator CLI entrypoints (serve, invite, ban)
web/           # read-only viewer (static)
tests/         # node:test suites per module + cross-cutting drills (kill/soak per SM-2/SM-3)
```

## Capability → Architecture Map

| Capability / Area | Lives in | Governed by |
| --- | --- | --- |
| FR-1 Local Mode default | `client/ensureServer`, `api` (127.0.0.1 bind) | AD-1, AD-10 |
| FR-2/FR-3 Remote join + identity | `client/api-client`, `core/enrollment`, `runtime` keypair | AD-5, AD-11 |
| FR-19 Chat ID + rename · FR-5 presence | `core/sessions` registry, `api` routes | AD-6 |
| FR-6/FR-7 Broadcast + Direct Rooms | `core/rooms` (+ pair ids), `store` | AD-4, AD-6 |
| FR-8/FR-20 reads, cursors, delivery contract | `client/cursors`, `api` read route, `store` | AD-4, AD-1 |
| FR-9/FR-10 marking + held | `mcp-stdio.mjs` response shaping, `client` local state | AD-3, AD-12, D17 |
| FR-14–FR-17, FR-22 gates | `api` middleware, `core/policy`, `cli` | AD-7, AD-8, AD-9 |
| FR-11–FR-13 continuity | `store` (WAL/FULL, migration v2), `client` reconnect/backoff | AD-2, AD-4 |
| FR-18 viewer | `web/` + `api` viewer route class (cookie auth) | AD-7, AD-8 |
| FR-4 self-host + TLS guide | `api` transport check, `cli/` serve | AD-11, AD-10, Deferred (automation) |
| FR-21 MCP tool surface | `mcp-stdio.mjs` + `client/api-client` | AD-8 (vocabulary), AD-1 |
| NFR-2 packaging | `scripts/package-release.mjs` (unchanged shape) | AD-9 (limits), stack |

## Deferred

- **Database internals beyond AD-4's contract** — index choices, WAL tuning, the exact physical migration SQL (ordering, transaction scope, and reply remap are pinned by AD-4; only the SQL text is free).
- **Operator CLI grammar** — argument parsing and output formats; the actions and their semantics are fixed (FR-14/15/22, AD-13), the packaging is not.
- **SSE for MCP clients** — v0.2 keeps MCP reads as long-poll (D4); the viewer's SSE route is pinned (AD-8 viewer class). Extending SSE to actor clients is a v0.3+ additive change.
- **Deployment automation** — systemd units, Dockerfile, the full Caddyfile; the guide's *contents* are PRD FR-4's job, the tooling is not architecture.
- **Multi-process/embedded variants** — a library-mode core for tests or future embedding; possible later, no consumer now.
- **Remote operator access** — any network path for operator actions (AD-13 defers this indefinitely).

## Open Questions

1. ~~Session-token lifetime and refresh semantics~~ — resolved 2026-09-29 by Story 4.1: the AD-5 assumption is ratified as declared — the session TTL stays 12 h sliding; restarts dominate the reconnect cadence the substrate actually exercises and every re-auth is single-flight and transparent, so a shorter TTL buys no security (reasoning recorded in the Story 4.1 spec's Design Notes; `SESSION_TTL_SECONDS` changed by zero lines).
2. ~~Direct-room pair-id encoding~~ — resolved 2026-09-20: `direct:<fp_min>:<fp_max>` (amended AD-6).
3. Whether `/api/presence` needs an SSE companion for the viewer's presence column, or 5 s polling suffices (FR-18's 5 s bound holds either way).
