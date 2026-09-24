# Consultation: Open Questions → codex-advisor (astra)

> Provenance: task `prd-open-questions-astra`, effective_identity `gpt-6-astra[max] (matched)`, receipt-backed ACP dispatch, completed 2026-09-20 05:39. Verbatim outbox capture. Advisory only — nothing applied to the PRD until the builder approves.

Review the seven “Paste into PRD” blocks as proposed decisions; the named objections remain unresolved.

# Agent Room v0.2 — seven open questions

Task: prd-open-questions-astra. Consultation date: 2026-09-20. Read-only advisory; these are recommendations, not newly accepted entries in D1–D12.

**Round-table:** John (PM: scope and solo-builder cost), Sally (UX: discoverability and interruption cost), Winston (architecture: protocol and durability), and Maya (security/operations: trust boundaries and failure behavior). The discussion follows [bmad-party-mode](/Users/ngs/agent-skills/.agents/skills/bmad-party-mode/SKILL.md).

**Grounding:** [PRD, including FRs, §5 NFRs, §9 and §10](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md), [D1–D12 and mechanism notes](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/addendum.md), [v0.1 README](/Users/ngs/agent-skills/plugins/agent-room/README.md), and [project policy](/Users/ngs/agent-skills/plugins/agent-room/AGENTS.md). Relevant tool schemas, database operations, long-poll code, existing MCP tests, and manifests were also read directly. CLI names below are proposed UX, not commands verified to exist in v0.1.

## 1. TLS termination

**Real options.** Native HTTPS with operator-supplied certificates keeps one application process but leaves issuance, renewal and replacement with the operator. A reverse proxy handles those operations but adds an optional service to the VPS. An SSH tunnel or private-network deployment can suit a personal installation, but does not replace a documented public HTTPS deployment; a managed tunnel also introduces an external service.

🏗️ **Winston:** “Use Caddy as the primary public-VPS guide. Certificate lifecycle is the recurring operational work. Caddy documents automatic issuance and renewal; Node supplies the TLS server primitive. The relevant built-in is `node:https`, backed by `node:tls`—`node:http` alone does not terminate TLS.” [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https), [Node HTTPS](https://nodejs.org/api/https.html).

📋 **John:** “Winston, the promise is a server that starts with one command and no runtime dependencies. Your first installation page now has another daemon. I prefer native HTTPS first for that reason.”

🛡️ **Maya:** “John, supplying a certificate file does not solve renewal. But I reject making Caddy mandatory. Ship standalone native HTTPS, and keep every enrollment, identity, ban and rate gate inside Agent Room. A proxy's loopback address is never evidence that the remote sender is local.”

**Paste into PRD — recommended primary story:**

> The recommended public-VPS deployment terminates TLS at an operator-managed reverse proxy, with one documented Caddy recipe. Agent Room remains independently runnable with Node built-ins only, including native `node:https` using an operator-supplied certificate chain and private key. No proxy, ACME library, or hosted service is a required application dependency. Native HTTPS and the proxy backend use the same API request handler. The proxy backend binds only to loopback on the same VPS; a backend crossing machines requires authenticated TLS. Remote clients require HTTPS and normal certificate/hostname verification. TLS termination stays inside the Server operator's trust boundary; document the same-host loopback proxy hop as the only plaintext backend exception, and use TLS for any backend hop leaving that host. Local Mode retains its zero-config, OS-user-scoped local transport.
>
> The native-HTTPS guide must cover certificate acquisition and renewal responsibility, full-chain and key paths, owner-only key permissions, hostname/private-CA trust, and certificate replacement through a documented restart. Reconnection after that restart preserves enrollment, message IDs and cursors. v0.2 does not implement ACME or require hot certificate reload.

**Documentation required for the primary recipe:** one working hostname/DNS/firewall and service-start example; a private backend; preservation of authorization and protocol headers; long-poll timeouts above 20 seconds, starting at 30 seconds; SSE streaming without unintended buffering; and a certificate-renewal check. Do not log invite secrets or viewer tokens. The docs must distinguish the GET-only viewer from the authenticated JSON messaging API. [Caddy proxy quick-start](https://caddyserver.com/docs/quick-starts/reverse-proxy), [proxy controls](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).

**Disagreement retained:** John still prefers native-first documentation because the extra VPS service raises initial setup cost. Winston prioritizes the recurring certificate workload. The recommendation chooses Winston's operating model without making the proxy a dependency.

**Decision compatibility:** No D1–D12 conflict under this optional-proxy interpretation; D9 and D12 remain intact. This replaces the native-first assumption at FR-4/§10. A mandatory external proxy would conflict with the zero-dependency requirement. FR-18's phrase “no mutator endpoint ... in the HTTP surface” must apply to the viewer surface: applying it to the entire server would contradict D12's remotely writable JSON API. The viewer token must never authorize API writes. The revised NFR-4 should make the same-host proxy exception explicit; if its TLS wording is intended to cover every backend hop too, configure proxy-to-Node HTTPS as well.

**Change trigger:** Prefer native-first if the builder already has reliable certificate provisioning/renewal or deployment rules prohibit an extra service. **Acceptance check to specify:** standalone native HTTPS and the documented proxy route both complete enrollment and a 20-second read; Local Mode needs neither certificates nor a proxy.

## 2. MCP names for presence and Direct Rooms

**Real options.** `list_agents` is familiar but semantically close to Claude's native agent registry. `room_presence` fits the existing room vocabulary; `actor_list` is identity-accurate but less obvious to a first-time agent. Renaming everything to `agent_room_*` improves standalone labels but breaks established callers. Separate `dm_send`/`dm_read` tools make DMs visible while duplicating the messaging contract; opening a Direct Room and reusing message tools needs only one new operation.

🎨 **Sally:** “Winston, `list_agents` is what an agent will look for. ‘Presence’ also sounds online-only, yet someone needs to message an enrolled Actor whose laptop is asleep.”

🏗️ **Winston:** “Then make the description say exactly that, and offer an offline filter. Claude's native registry is a different address space. The persistent object here is an installation's Actor, not an individual running task. Existing `message_send` and `message_read` already take `room_id`.” [Existing tool schemas](/Users/ngs/agent-skills/plugins/agent-room/server/mcp-stdio.mjs:51).

📋 **John:** “Keep those two names. No alias family and no second DM implementation. The Direct Room opener is the discovery point.”

**Paste into PRD — recommended surface:**

> Keep the MCP server name `agent-room` and the existing `message_send` and `message_read` names and core arguments. Add `room_presence({include_offline?: boolean})`, defaulting to online Actors, with descriptions containing “list agents,” “current Agent Room realm,” and “enrolled offline Actors.” Return the current realm, Actor handle, stable key fingerprint, online state, connected-since and last-seen; show live sessions/client types under their Actor rather than inventing separate Actor identities. Preserve FR-5's recently-seen-within-24-hours bucket when including offline presence; that display window never expires enrollment or prevents opening a DM to an older known peer.
>
> Add `room_direct_open({peer_handle})`. It resolves an enrolled peer on the current realm, including an offline peer, and returns the existing-or-created pair room's `room_id`, `kind: direct`, and peer identity. `peer_handle` selects the recipient; it never supplies sender authority. Concurrent/repeated opens return the same room for that unordered pair. Both Broadcast and Direct Rooms use the same `message_send`/`message_read` contracts, with cursors stored per realm and room. `room_status` identifies the current realm and Broadcast Room ID.
>
> Every tool description identifies Agent Room explicitly. The plugin's usage instructions distinguish these tools from Claude Code's native `ListAgents`/`SendMessage` when present. Do not ship aliases named `ListAgents`, `SendMessage`, `list_agents`, or a separate DM send/read family.

**Discoverability and conventions:** Use MCP tool descriptions and titles as well as names; host namespace rendering varies. A logical `agent-room / room_presence` server/tool pair is portable intent, not a promised UI spelling. Agent Plugins specifies packaging and MCP configuration; it does not prescribe Agent Room's domain verbs. Keep root manifests, MCP stdio and the dual-package conformance gate. [MCP tool discovery and definitions](https://modelcontextprotocol.io/specification/2025-06-18/server/tools), [Agent Plugins MCP configuration](https://agent-plugins.org/plugin-authors/mcp-servers).

**Disagreement retained:** Sally prefers the plain verb `list_agents` for first-use discovery and does not consider descriptions equivalent to a recognizable name. John and Winston choose vocabulary separation and existing-call stability.

**Decision compatibility:** No D1–D12 conflict. D3's “ListAgents → SendMessage” describes the flow, not mandatory tool identifiers. D5 still prohibits caller-supplied sender authority; a recipient selector is a different role. Clarify the revised NFR-3's broad phrase “no tool argument ever carries actor identity” to mean caller authority: literal prohibition of every recipient reference would make Direct Rooms unaddressable. This recommendation does not add arbitrary room creation beyond the PRD's Broadcast/Direct scope. Server ACLs, not obscure room IDs or viewer UI hiding, enforce FR-7.

**Change trigger:** Reconsider a stronger `agent_room_*` prefix if actual supported-client trials show unqualified-name collisions or persistent wrong-tool selection. **Acceptance check to specify:** with both native and plugin tools present, an agent finds realm presence, opens a DM to an offline enrolled peer and exchanges messages through the existing message tools; a third Actor and a nonparticipant viewer cannot read that DM.

## 3. Wire protocol versioning

**Real options.** An integer HTTP header is uniform for GETs and writes. A JSON `protocol_version` field makes bodies self-describing but needs a separate rule for bodyless requests. `/v1/...` routes are easy to inspect but put compatibility into every URL. Semver or a negotiated version range supports more variation at the cost of negotiation and upgrade policy the solo builder does not yet need.

📋 **John:** “Use `/v1`. I can inspect a curl example and see the version without remembering a header.”

🏗️ **Winston:** “I prefer one mandatory header and one supported wire version. The application release `0.2.0`, SQLite schema version, Agent Plugins schema `1.0.0`, and MCP's protocol date already have different jobs. None should silently become the realm wire version.”

🛡️ **Maya:** “Winston, ‘ignore unknown fields’ needs a boundary. Ignoring a future restriction in a write request could produce a broader action than the client authorized.”

**Paste into PRD — recommended mechanism:**

> The Agent Room JSON-over-HTTPS API requires `Agent-Room-Protocol: 1` on every API request, including enrollment, and echoes that header on API responses. Its value is a positive decimal integer identifying the wire contract, independent of application semver, database schema, Agent Plugins schema and MCP protocol version. Static viewer pages and the local MCP stdio handshake are outside this header contract. Do not duplicate the version in JSON bodies or versioned paths.
>
> Missing or malformed versions return HTTP 400 with `protocol_required` or `invalid_protocol`. Unsupported versions return HTTP 400 with a stable JSON error such as `{"error":{"code":"unsupported_protocol","supported":[1]}}`. A version rejection makes no state change, consumes no invite use and advances no cursor. The client reports the mismatch and the need for a compatible release; there is no implicit downgrade.
>
> Wire version 1 remains additive throughout compatible v0.x releases: existing fields, defaults, authorization meaning, ordering and idempotency stay unchanged; additions may be optional response metadata or new operations. Clients tolerate unknown response metadata and treat unknown errors as failures. Servers reject unknown request fields rather than silently ignoring possible constraints. A newer client must retain the version-1 baseline when an older server lacks an optional operation or field. Breaking changes require a new wire integer and an explicit upgrade note. v0.2 serves only version 1 and promises no parallel support for multiple breaking versions.

**Disagreement retained:** John still prefers the URL version for manual operability. Winston chooses a header to keep GET and write behavior uniform without coupling resource URLs to release numbers. Maya rejects the broader interpretation of additive-only that would silently discard unknown input.

**Decision compatibility:** No D1–D12 conflict; D12 delegates exact wire shapes to architecture. This makes §9's additive-only assumption precise. Adding an optional field is not compatible if omission changes privacy, delivery or authorization semantics.

**Change trigger:** Introduce explicit capability discovery or overlapping version support only when independently maintained clients require optional features or rolling upgrades. **Acceptance check to specify:** missing/wrong versions are rejected before mutation; an old client tolerates added response metadata; unknown write fields fail explicitly; an old/new pair still exchanges the baseline messages.

## 4. Keep-all retention and year-long VPS operation

**Real options.** Keep-all plus capacity visibility preserves every cursor. A fixed byte quota with write refusal preserves old data but creates an arbitrary service-stop point. Age/count deletion or rotating/truncating the database invalidates the current permanent-log promise. Archival tiers could preserve logical history but add migration, retrieval and backup semantics unsuitable for this release.

📋 **John:** “Keep every committed message. An expiry policy would turn a working log into another delivery problem.”

🛡️ **Maya:** “John, ‘30 sends a minute’ is not a storage budget. One enrolled key can fill a small disk without exceeding that limit. I would set a realm byte quota before sharing it.”

🏗️ **Winston:** “I want free-space admission control, not an arbitrary log quota. Also, the addendum's ‘one reader per waiting session’ must not mean an open SQLite read transaction for the entire poll. Overlapping read transactions can prevent WAL recycling. v0.1 already queries, releases the read, waits, then queries again.” [Existing poll path](/Users/ngs/agent-skills/plugins/agent-room/server/roomd.mjs:444), [SQLite checkpoint starvation](https://sqlite.org/wal.html#avoiding_excessively_large_wal_files).

**Capacity illustration — calculated payload only, not measured database size:**

| Assumed traffic for 365 days | Raw message text | What the number means |
|---|---:|---|
| 5 Actors × 200 messages/day × 2 KiB | 0.70 GiB | Ordinary personal-use planning example. |
| 1 Actor × sustained 30/min × 2 KiB | 30.08 GiB | A small VPS can fill without a rate violation. |
| 1 Actor × sustained 30/min × 32 KiB | 481.20 GiB | Long permitted messages dominate capacity. |

Actual storage additionally includes rows, indexes, WAL, operational logs and backups. The existing message limit is 32,768 characters, not 32 KiB of UTF-8, so the last row is not a worst-case upper bound. The current daemon also bounds frames/results at 1 MiB and pages at 200 messages. [Database limits](/Users/ngs/agent-skills/plugins/agent-room/server/database.mjs:14), [bounded responses](/Users/ngs/agent-skills/plugins/agent-room/server/roomd.mjs:230).

**Paste into PRD — recommended retention policy:**

> v0.2 keeps all committed messages indefinitely. There is no automatic age/count deletion, log-size quota, compaction that removes messages, or archival tier. Keep the existing bounded message, request/response and page limits. Long-poll waits retain no open SQLite read transaction; preserve automatic WAL checkpointing and bounded in-memory queues.
>
> Operator status exposes database/WAL bytes and available filesystem space. The initial operating defaults warn below 1 GiB free and refuse new message appends below 256 MiB free with `storage_low`; the thresholds are operator-configurable capacity reserves, not retention quotas. A preflight free-space check is advisory: commit failures, including disk-full errors, must still return an explicit failure and must never acknowledge an uncommitted message. Existing logs and cursors remain intact; reads continue wherever the storage backend can serve them.
>
> The operator guide includes a consistent SQLite backup/restore procedure, backup-space budgeting and disk expansion. Backup copy rotation is separate from live-message retention. The plugin reads catch-up in bounded pages and never loads a year of history into one tool result.

**What breaks first:** At the illustrated personal-use load, there is no evidence that log row count or cursor range is the limiting factor. Large catch-up context is an immediate client cost. On a small VPS, the likely storage failure is available disk—possibly WAL growth, accumulated diagnostics or backup copies before the main database. With implementation faults, leaked connections or retained poll state can fail earlier. This is a risk ordering, not a year-long benchmark. A quota does not fix those faults.

**Disagreement retained:** Maya considers the ability of one permitted Actor to exhaust disk enough reason for a realm byte budget before inviting others. John and Winston accept operator monitoring, explicit low-space refusal and ban for a small invite-only realm. There is no agreement that these controls suffice for broad shared hosting.

**Decision compatibility:** No D1–D12 conflict; this preserves D4/D10 and §7.2 keep-all. Automatic pruning would conflict with the PRD's permanent append-only log and complete catch-up. The 256 MiB admission reserve can refuse new work but never drops accepted work. FR-10's held-list cap must be a recoverable display/cache cap, not deletion of durable messages; see question 6.

**Change trigger:** Add a documented capacity quota if measured growth, storage cost or repeated abuse shows the operator cannot maintain usable free space; prefer explicit write refusal over deletion. Any future retention that loses history requires changing the product contract first. **Acceptance check to specify:** long-poll soak shows bounded WAL/resources; low-space sends fail explicitly; messages acknowledged before a crash remain readable afterward.

## 5. Heartbeat, online TTL and abuse defaults

**Real options.** A 30-second heartbeat/90-second TTL gives quicker presence changes but more idle traffic; 60/180 is a compromise; 120/360 favors fewer wakeups but shows departed sessions for longer. Activity-only presence avoids separate timers but labels an agent offline while it is still generating. Sliding-window send limits provide a strict per-minute maximum; token buckets permit a stated short burst with a sustained rate.

🎨 **Sally:** “John, three minutes is long enough to DM a session that has already gone. I prefer 30/90.”

📋 **John:** “Presence does not promise an immediate response. A sleeping peer can still receive a durable DM. I would spend that extra traffic only if people actually misunderstand last-seen.”

🛡️ **Maya:** “Neither timer is an abuse control. Reads, failed authentication and duplicate retries can be expensive without creating messages. The send bucket needs separate request budgets.”

**Paste into PRD — recommended defaults:**

> Heartbeat every 60 seconds while the MCP Session is alive and awake, with ±10% jitter; the Server's online TTL is 180 seconds since the last authenticated live-session activity. An authenticated Session read or send may refresh the same timestamp, allowing the client to skip a redundant heartbeat. Heartbeats run in the plugin process without model/tool turns and stop when its Session ends. Viewer activity and an otherwise idle shared daemon never keep an Actor online. An Actor is online if any of its Sessions is within TTL; an unavailable Server is shown as unreachable rather than declaring all Actors offline.
>
> Do not prevent laptop sleep or replay missed heartbeat ticks. On resume, refresh presence and resume message reads from saved cursors. Reconnect uses exponential backoff starting at 1 second and capped at 60 seconds with jitter; a detected resume/network recovery permits an immediate attempt. Heartbeat and TTL are operator-tunable, with TTL defaulting to three times the configured base heartbeat interval.
>
> The default send limiter is a token bucket per enrolled identity key across all its rooms and Sessions: refill 0.5 tokens/second, capacity 10. This means 30 sends/minute sustained plus a burst of 10, not a strict maximum of 30 in every rolling minute. Refusal returns `rate_limited` and a retry delay. Existing same-ID/same-payload replay returns its original committed message without consuming another send token; a conflicting payload remains `client_message_id_conflict`. Authentication, ban and room authorization still apply.
>
> As initial Remote Mode request budgets, allow 120 authenticated requests/minute/key with burst 30, independently of the send bucket, and 5 enrollment attempts/minute/source IP with burst 5. Request budgets include failed, duplicate and replayed attempts; long-polls count at admission, not for each second held. The source-IP rule uses the socket address, or a forwarded address only from an explicitly trusted proxy; identity-key limits never rely on IP. Bound request bodies, outstanding requests and expiring limiter entries. These are abuse floors for an invite-only realm, not a volumetric-DoS guarantee.

**Timer reasoning:** An otherwise idle awake Session sends about 60 heartbeat requests/hour; activity coalescing can reduce that. This does not imply a measured battery cost, and timers must not inhibit sleep. A 20-second active long-poll already creates more frequent traffic than the heartbeat; reconnecting an expired TCP connection is normal. No universal NAT timeout supports a guarantee that 60 seconds keeps every path alive. RFC 5382's established-TCP timeout requirement is at least 2 hours 4 minutes under its stated conditions; actual networks and proxies still need measurement. [RFC 5382 §4.3](https://www.rfc-editor.org/rfc/rfc5382.html#section-4.3).

**Dedupe boundary:** Preserve idempotency before rapid-post suppression. For FR-16's separate rapid-duplicate gate, use a 5-second window for the same Actor, same room and identical message payload, including reply target; return `duplicate_dropped` with the original sequence reference, not a silent success. Identical text in different rooms or reply contexts is not the same operation. A retry flood can still hit the general request budget.

**Disagreement retained:** Sally still wants 30/90 for more truthful-looking presence. John accepts 60/180 only with visible last-seen and no implication that online means attentive. Maya regards the stated request budgets as a starting floor and would lower exposure before a large invitation batch.

**Decision compatibility:** No D1–D12 conflict. This resolves FR-5/FR-16 assumptions, preserves D5/D7 per-key enforcement and D4 pull delivery. Timer-driven presence does not push messages into or wake the agent. **Change trigger:** change timers after observed false-offline episodes, battery measurements or repeated user confusion; change buckets after legitimate burst/refusal data. **Acceptance check to specify:** sleep/return restores identity and cursor; one surviving Session keeps an Actor online; a dead Session cannot be kept alive by its daemon; send replays, bursts and limit responses preserve their stated semantics.

## 6. Held-message defaults and one-step allowlisting

**Real options.** A global allowlist minimizes setup but transfers trust across independent realms. Per-Server key allowlists match realm authority but require trust choices on each realm. Accept-all reduces friction while allowing immediate foreign text into context. Per-message approval is narrow but too repetitive for normal collaboration. Server-enforced withholding would be a different guarantee lane and still would not make arbitrary foreign text safe.

🎨 **Sally:** “Maya, requiring approval between my own laptop's clients is a regression. The same-machine exception has to mean something.”

🛡️ **Maya:** “It means the authenticated, same-OS-user Local Mode boundary. It cannot mean ‘same public IP,’ matching hostnames, a caller-supplied `local` flag, or every request forwarded through loopback. A remote realm cannot infer machine ownership from those.”

🏗️ **Winston:** “And a preview in an MCP tool result is already in the agent's context. FR-10 currently promises both a sender-plus-preview result and withheld content. We need metadata-only held results.”

**Recommended default matrix:**

| Sender situation | Delivery into the agent's context | Treatment after release |
|---|---|---|
| Another same-OS-user Actor admitted through the trusted Local Mode transport | Automatic | Foreign-Actor text still has untrusted framing. |
| Remote Actor whose key is allowlisted for this receiving installation on this realm | Automatic | Untrusted framing remains; allowlisting is not permission to execute instructions. |
| Enrolled stranger on the Remote realm | Held; safe metadata only | Human approval/allowlisting releases text with untrusted framing. |
| A claimed same-machine Actor seen only through Remote Mode | Held unless already allowlisted | No automatic exception based on IP, handle or claimed machine metadata. |

An unenrolled or banned sender is rejected by Server gates; it never becomes a client-held stranger. A message from the receiving Actor's own key is not foreign-Actor content.

**Paste into PRD — recommended policy and UX:**

> Each receiving installation stores an allowlist per enrolled Server/realm, shared by that installation's Sessions. Entries bind the realm and sender's enrolled identity-key fingerprint; handles are display/lookup labels, never the trust key. Do not inherit trust globally, from another realm or merely because a Server URL/handle is reused. A replaced realm identity or different sender key starts untrusted.
>
> Local Mode automatically admits same-OS-user Actors established through its trusted local transport, preserving zero-config collaboration. Remote Mode holds every non-allowlisted foreign Actor by default, including a different installation claimed to be on the same machine when no trusted local provenance is available. v0.2 does not add a device-attestation system to manufacture this exception. A human may explicitly select accept-all for one realm; foreign-content framing always remains.
>
> A held result contains realm, sender handle/key fingerprint, room, sequence, time, size and held count, with sanitized metadata and no message-body preview. Full preview is available only through a human-operated local approval surface, not the agent's tool result. The one-step terminal action `agent-room allow @alice` resolves the current realm's enrolled key, saves that per-realm allowlist entry, and releases that key's currently held and future messages. The command reports the realm, fingerprint and scope it allowed. A corresponding remove action affects future ingestion, not text already in context. Approval state is not accepted as an agent-supplied `approved: true` claim.
>
> The 100-entry held cap bounds a local listing/cache. Overflow is shown explicitly and remains retrievable from the durable log using pending cursors/references; dropping a cache entry is not approving, deleting or permanently skipping its message. Receiving/scan progress is separate from human-approved ingestion progress.

**Guarantee boundary:** The plugin can omit text from the results it emits and persist the human's local policy. D6 still classifies this as a Client-requested gate: it cannot prove human intent against an arbitrary client, a same-user process changing policy files, or a harness that permits an agent to run the approval command. Untrusted framing is an instruction, not a guarantee against prompt injection. Neither an allowlist nor an invitation grants the message authority over the receiver. [D6 and the two lanes](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/addendum.md:12).

**Disagreement retained:** Sally objects to the extra Remote Mode approval between her own installations. Maya will not endorse unconditional remote same-machine trust without a verifiable local binding. The recommendation accepts that friction rather than claiming a proof the current architecture does not have.

**Decision compatibility:** No D1–D12 conflict; D6/D9 are preserved. This explicitly narrows §9/§10's same-machine assumption to a verifiable trust boundary, replaces FR-10's agent-visible preview, and clarifies “oldest dropped” as recoverable cache eviction. Promoting held delivery to a Server-enforced safety claim would conflict with D6; that is not recommended.

**Change trigger:** Allow automatic Remote Mode sibling trust when a real, owner-only local identity registry can prove both installations without trusting remote assertions; reconsider a global layer only if the product gains an explicit cross-realm trust model. **Acceptance check to specify:** stranger text never appears in any supported held tool result, handle reuse does not inherit trust, one human allow action releases the intended key only, and overflow cannot lose unread history.

## 7. Invite format, use count, expiry and rotation

**Real options.** An opaque random token plus a server record makes revocation and use counting straightforward. A self-contained signed token/JWT still needs state for revocation and consumption, adding crypto/format work without a stateless benefit here. A short human code needs tighter guessing defenses and usually a confirmation exchange. A token pre-bound to a known public key reduces the harm of forwarding but makes first enrollment a two-stage key exchange.

🛡️ **Maya:** “Use an opaque, single-use, 24-hour secret. The invite bootstraps an identity; it must not become the identity's password forever.”

🎨 **Sally:** “Twenty-four hours expires before an asynchronous friend tries it. I prefer 72 hours. And a builder enrolling a laptop and desktop should not need to discover token exhaustion by failing on the second machine.”

📋 **John:** “Default single-use, with an explicit bounded-use override. We already need SQLite state for revocation. No JWT library, no signing-key rotation system, no invite-management web app.”

**Paste into PRD — recommended token lifecycle:**

> Invite Tokens have the form `ar_inv1_` followed by the unpadded base64url encoding of 32 cryptographically random bytes: 43 secret characters, 51 characters total. Generate the secret with `node:crypto.randomBytes(32)`. The prefix versions the token format only. Treat the token as an opaque bearer bootstrap secret, not a JWT, Actor credential, viewer token or operator capability.
>
> Persist a SHA-256 digest of the canonical token, plus a nonsecret invite ID, label, created/expires timestamps, maximum uses, consumed uses and revoked state. Show the raw token once to the operator. Never put it in normal logs, a URL query, agent tool results or a shell-history command. Enrollment accepts it through a human configuration helper/secret input and HTTPS; the server redacts it from diagnostics.
>
> The default is one successful new identity enrollment and expiry 24 hours after minting, using Server time. An operator may explicitly choose a finite positive `--uses N` and a different finite `--ttl`; omit unlimited-use and never-expiring modes in v0.2. Reconnects and additional Sessions of an already enrolled key do not consume uses. The token grants ordinary realm enrollment only, with no operator rights and no automatic recipient allowlisting.
>
> Validate the enrolling key's proof of possession before entering the write transaction. In one durable SQLite transaction, check that the invite is unrevoked, unexpired and unexhausted, bind the key/handle and consume exactly one use. Never hold the transaction open while waiting for a network challenge response. Failed or rolled-back enrollment consumes none. Concurrent uses cannot exceed the bound. After a committed enrollment whose response was lost, proof of the same existing key reattaches to that enrollment without needing another invite use; a banned key remains rejected.
>
> Operator CLI supports `invite mint`, `invite list` and `invite revoke <invite-id>`. Listing shows IDs, labels, expiry, remaining uses, revoked/exhausted state and the keys enrolled through each invite, never the secret. Rotation means revoke the old invite and mint a replacement, using the same primitives; no scheduled global-secret rotation is required. Revocation, expiry and exhaustion block new enrollment only. If a leaked invite was already redeemed, the operator must separately ban the unwanted enrolled keys. Existing legitimate Actors reconnect using their identity keys, not the invite.

Node 24 provides the required random-byte generation and unpadded base64url encoding. A read-only local check on Node v24.18.1 confirmed the proposed length and 32-byte decode; it did not exercise an enrollment implementation. Hashing a 256-bit random secret is appropriate lookup protection here; it is not a recommendation to use bare SHA-256 for human passwords. [Node crypto](https://nodejs.org/docs/latest-v24.x/api/crypto.html#cryptorandombytessize-callback), [Node base64url](https://nodejs.org/docs/latest-v24.x/api/buffer.html#buffers-and-character-encodings).

**Disagreement retained:** Sally still favors 72-hour defaults to avoid asynchronous onboarding failures. Maya prefers single-use-only invites because bounded multi-use tokens are easier to forward accidentally. John chooses the finite-use override for the builder's own multi-installation setup; neither objection disappears.

**Decision compatibility:** No D1–D12 conflict. Single-use default and explicit bounded use match D1's bootstrap posture and the PRD's Invite Token glossary; D5 keeps identity separate from bootstrap enrollment. Making old Actors re-enroll on routine invite rotation would conflict with D5/D10 and FR-12 and is explicitly excluded.

**Change trigger:** Extend the default expiry after observed onboarding failures; add public-key-bound invitations if forwarding/misdelivery becomes a real problem. Signed self-contained tokens become worth reconsidering only with an actual offline verification or federation requirement, both absent here. **Acceptance check to specify:** two different keys racing a single-use invite yield one enrollment; a lost-response retry of the winning key returns its existing enrollment; revoke/expiry survive restart; revoking an invite neither silently bans existing Actors nor admits a new one.

## Evidence limits and review scope

1. **Verified by reading:** all four requested documents; the existing MCP names/arguments; character, frame and page limits; key/idempotency lookup behavior; SQL read/transaction paths; manifests and the relevant existing MCP test assertions. Existing tests were inspected, not executed.
2. **Verified without application writes:** Node v24.18.1 exposes `node:https.createServer`; the proposed invite shape is 51 characters and decodes to 32 secret bytes; the capacity figures were calculated from the stated workload assumptions. Primary Node, SQLite, Caddy, MCP and Agent Plugins documentation was consulted. Node's v24 HTTPS page was unavailable through the browser, so the HTTPS citation uses the current API page and the local Node-24 primitive check.
3. **Not verified:** a v0.2 implementation, TLS renewal on the builder's VPS, enrollment/authentication protocol security, battery consumption, actual NAT/proxy timeouts, one-year capacity, crash/soak results, held-message behavior in any host, or package/client conformance. Each section's acceptance check is proposed future evidence, not a passing result.
4. **Host/PRD limits:** official Claude documentation confirms `SendMessage` usage, but this review did not verify the exact `ListAgents` surface in the builder's installed host or every client version; the supplied collision scenario is a design requirement. [Claude agent-team documentation](https://code.claude.com/docs/en/agent-teams). The PRD changed during the consultation; its revised §5 NFR-1–NFR-7 were read before finalization, and its Open Questions/Assumptions Index are now §9/§10. The revised TLS and identity wording is addressed in questions 1 and 2. Direct Room privacy remains server ACL privacy, not protection from an operator reading plaintext database files.
5. **File boundary:** no PRD, addendum, source, configuration, test, runtime-state or memory edits were requested or made by this consultation; the flat outbox is the requested reporting exception. Git status was unavailable because the system Git wrapper hit the Xcode-license/cache failure; no clean-worktree claim is made. BMAD's project-local resolver infrastructure was absent, so the skill's documented session-mode fallback was used with this four-voice cast.

**Executed read-only probe — exit 0:**

```sh
node -e 'const h=require("node:https"); const c=require("node:crypto"); const token="ar_inv1_"+c.randomBytes(32).toString("base64url"); console.log(JSON.stringify({node:process.version,nativeTlsServer:typeof h.createServer,inviteLength:token.length,inviteShape:/^ar_inv1_[A-Za-z0-9_-]{43}$/.test(token),decodedSecretBytes:Buffer.from(token.slice(8),"base64url").length}));'
```

Result: `node=v24.18.1`, `nativeTlsServer=function`, `inviteLength=51`, `inviteShape=true`, `decodedSecretBytes=32`. No server was started and the generated test secret was not printed or persisted.

**Document snapshot:** re-read PRD SHA-256 `4491d7aca67921b425ea83d2d2bd08cdefc2e3bd0a9579123fb47b25ce288c99`; addendum SHA-256 `2b01aac398a2bf17426d9444d352bddd4fedd627c698adf195798def01096a6d`. The other 10 inspected project files matched their initial hashes. The PRD's earlier hash was `85fede4a8f217262b435ffcb68831d6fd5dd6515e55079dcece2b2fca4484439`; this external change was re-read, not overwritten. Final hash checks concern the reviewed snapshot only, not a clean-worktree or release claim.

## Each voice's closing position

📋 **John:** “Ship one message model, one wire version, keep-all history and finite invites. I still prefer native-first hosting docs. I will not turn a personal realm into a hosted messaging platform to settle hypothetical scale concerns.”

🎨 **Sally:** “I still want faster presence expiry, a more obvious discovery verb and 72-hour invites. The selected defaults are workable only when current realm, last-seen, held state and the allow action are unmistakable. Remote trust friction between my own machines remains a cost.”

🏗️ **Winston:** “Keep the boundaries precise: Actor versus Session, product version versus wire version, held HTTP request versus SQLite transaction, and scan cursor versus approved ingestion. Proxy-first hosting and a small native-TLS fallback are the combination I would build.”

🛡️ **Maya:** “Keep unauthenticated callers outside the realm, foreign previews outside held tool results and machine claims outside trust decisions. I still want a realm byte budget before broad sharing and single-use-only invites. The recommended small-realm defaults do not establish resistance to a hostile high-volume deployment.”

## Per-question decision summary

| # | Recommended PRD decision | Unresolved objection / compatibility note |
|---|---|---|
| 1 | Caddy reverse-proxy guide first; standalone native `node:https` remains supported. | John prefers native-first; changes FR-4/§10 assumption, no D conflict while proxy stays optional. |
| 2 | `room_presence` + `room_direct_open`; retain `message_send`/`message_read`. | Sally favors `list_agents`; distinguish native tools and recipient selection from sender authority. |
| 3 | Mandatory integer `Agent-Room-Protocol: 1`; HTTP 400 on mismatch; additive wire-1 policy. | John prefers `/v1`; no automatic downgrade or silent unknown-input acceptance. |
| 4 | Keep-all; no log quota; bounded I/O, free-space warning and explicit low-space refusal. | Maya wants a realm byte budget before sharing; no deletion or cursor invalidation. |
| 5 | 60s heartbeat ±10%, 180s TTL; 30 sends/min sustained, burst 10, separate request budgets. | Sally wants 30/90; defaults are unmeasured and tunable, not a strict rolling 30/min cap. |
| 6 | Per-realm key allowlists; trusted Local Mode auto-delivers; other foreign keys held, no text preview. | Sally objects to remote sibling friction; narrows same-machine assumption and clarifies FR-10, preserving D6. |
| 7 | 256-bit opaque invite; one use/24h default; finite override; revoke then mint to rotate. | Sally prefers 72h, Maya single-use-only; invite revocation does not revoke enrolled keys. |

TEAM_DONE prd-open-questions-astra
