# Review: requirements inventory → codex-advisor (sol)

> Provenance: task `epics-req-review-sol`, effective_identity `gpt-5.6-sol[max] (matched)`, receipt-backed ACP dispatch (session 01a0bc4b), completed 2026-09-20 08:05. Verbatim outbox capture. Review pinned to file hashes stated in the document; it explicitly excluded defects already fixed by the concurrent agy-driven corrections.

# Agent Room v0.2 requirements inventory — pre-epic gate review

Do not design implementation epics from this inventory yet. Resolve C1–C4 first, then repair the high-severity trace losses before story acceptance criteria are written.

## Audit basis

📏 **Level (claim checker):** I pinned the review at **2026-09-20 07:59:43 +0700** to these SHA-256 values:

- `epics.md`: `c885a59ff90cfc51160269698a12b74dd8ab0839766d6b19d0740203945e937c`
- `prd.md`: `1473ea0527e4051cf44a49be368488a2e637fcadc3f5b20b44b50972c7fa5328`
- `ARCHITECTURE-SPINE.md`: `7c848d83c3628dc17c5257cf7e554299ac65fbf5d2e3a9e78cfc06d0b3cfb495`
- `addendum.md`: `8995d2163653736479874a0d19945e2ce587e6d98d9083ba60acb590d9e5e847`

The files changed while this read-only review was in progress. In particular, the prompt's “UX section states none” described the initial file, but the pinned inventory now contains HCI1–HCI5. I excluded defects fixed by that later state and reviewed the replacement text. This verdict applies only to the hashes above.

📋 **John (product manager):** Source precedence matters. D13–D19 explicitly supersede earlier decision seeds where they say so; the spine may sharpen the PRD, but it cannot silently turn a tagged assumption or explicit open question into an approved requirement.

🏗️ **Winston (system architect):** And “summary” is not permission to remove the condition that makes a safety or continuity rule true. Several lines retain the noun but lose the invariant.

🎨 **Sally (UX designer):** The late HCI section is an improvement. It also introduces a security overclaim and still omits two human-visible experiences.

## Critical findings

### C1 — FR5 / FR19 / FR21 / AR6: offline discovery has no durable source of truth

📏 **Level:** The inventory promises `room_direct_open({chat_id})` for an offline peer, including `ambiguous_chat_id` candidates ([inventory FR21](</Users/ngs/agent-skills/plugins/agent-room/docs/epics.md:39>)). That faithfully repeats the PRD: “resolves an enrolled peer — **offline peers included**” and, on ambiguity, returns fingerprints and last-seen times ([PRD FR-21](</Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:201>), [acceptance clause](</Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:206>)).

🏗️ **Winston:** But AD-6 says the `Chat-ID→session→actor` mapping and liveness timestamps are ephemeral and “**restart clears it**” ([spine AD-6](</Users/ngs/agent-skills/plugins/agent-room/docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md:79>)). FR-5 simultaneously requires a 24-hour offline-recently bucket. After restart, there is no specified durable mapping or last-seen record from which either contract can be fulfilled. Message history is insufficient: a newly enrolled Actor may never have sent, and a past Chat ID may map to several Actors.

📋 **John:** This is not an implementation detail. Choose one product contract before epic design: persist a bounded Chat-ID claim/history index plus Actor last-seen data, or remove offline open-by-name and weaken post-restart offline presence. Define rename, expiry, ambiguity, privacy, and never-sent behavior. FR5, FR19, FR21, and AR6 must then be rewritten together.

### C2 — NFR8 / AR1 / AR7 / AR8: the protocol-header scope contradicts itself and its sources

🏗️ **Winston:** Three current inventory lines cannot all be true:

- NFR8 says the header is mandatory on `/api/*`, while `/viewer/*` and `/health` are exempt ([inventory NFR8](</Users/ngs/agent-skills/plugins/agent-room/docs/epics.md:51>)).
- AR1 says “**ALL traffic** ... over HTTP(S) JSON API with version header” ([inventory AR1](</Users/ngs/agent-skills/plugins/agent-room/docs/epics.md:55>)).
- AR7 applies the header only to actor and pre-auth classes ([inventory AR7](</Users/ngs/agent-skills/plugins/agent-room/docs/epics.md:61>)).

📏 **Level:** The PRD says “Every API request carries” the header and exempts only static viewer assets and the local MCP handshake ([PRD NFR-8](</Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:317>)). The amended spine exempts the entire viewer and health classes ([spine AD-7](</Users/ngs/agent-skills/plugins/agent-room/docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md:90>)). That is a real source conflict, not a harmless compression. `/viewer/api/...` and viewer SSE are API routes, not static assets; native EventSource also cannot attach the custom request header.

🏗️ **Winston:** Freeze a route-by-route matrix covering request header, echoed response version, authentication, and browser feasibility. Then make PRD NFR8, AD-1, AD-7, AD-8, and the inventory use that exact matrix. Until then, teams can build mutually incompatible clients while each cites a source.

### C3 — FR5 / FR7 / FR18 / FR19 / NFR2 / AR5 / AR6: assumptions and open questions were promoted to approved requirements

📏 **Level:** The inventory states as final: offline window `24h`, viewer exclusion of DMs, viewer freshness `5s`, Chat ID format/case rules, and Claude Code + Zcode as the v0.2 claim. The PRD labels every one as an assumption ([assumptions index](</Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:369>)). Chat ID normalization is even an explicit “**confirm or adjust before epics**” question ([PRD §9](</Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:367>)).

🏗️ **Winston:** The spine also leaves session-token lifetime, pair-ID stability, and presence SSE versus polling open ([spine open questions](</Users/ngs/agent-skills/plugins/agent-room/docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md:216>)). The inventory preserves `[ASSUMPTION]` only on AR5. AR6 calls the amended pair encoding settled even though the spine's open-question text still cites the obsolete `<min,max>` spelling.

📋 **John:** Add a pre-epic decision register with owner, status, and deadline. Resolve Chat ID normalization now. Keep the other values visibly tagged until approved; NFR2 must say “candidate claimed clients” until smoke evidence exists. A story estimate built on a disguised assumption is not a trustworthy estimate.

### C4 — FR10 / HCI2 / NFR4 / D17: the inventory invents an unenforceable human-approval guarantee and omits the preview contract

🎨 **Sally:** HCI2 says approval is “**never agent-invocable**” ([inventory HCI2](</Users/ngs/agent-skills/plugins/agent-room/docs/epics.md:78>)). The source says the opposite about enforceability: approval provenance is an Instructed human convention because “a same-user process is not cryptographically distinguishable” ([PRD FR-10](</Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:195>)); D17 repeats that downgrade ([addendum D17](</Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/addendum.md:23>)). HCI2 turns an honest limitation into a false security promise.

📏 **Level:** The inventory also names held-list/allow/remove interactions but drops the source requirement that “**full preview is available only through a human-operated approval surface, never an agent tool result**” ([PRD FR-10](</Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:191>)). A human cannot make an informed release decision from sender metadata alone.

🎨 **Sally:** Reword the guarantee as Instructed, define the actual preview/list/show/allow/remove flow, and test only what code can enforce: no held body in MCP results, accurate realm/fingerprint display, exact-message recovery, and explicit confirmation. The room disagrees on whether that must be a terminal UI, but the source requires some human-only preview surface.

## High findings

### H1 — FR9: Plugin-enforced wrapping and Instructed interpretation were collapsed

📏 **Level:** Inventory FR9 ends with “labeled Instructed” ([inventory FR9](</Users/ngs/agent-skills/plugins/agent-room/docs/epics.md:27>)). The source separates two guarantees: “the plugin-enforced part (the wrapping itself) is code,” while the model's interpretation is Instructed ([PRD FR-9](</Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:187>)). The current line weakens a mechanically testable safety property.

🏗️ **Winston:** Split it into two acceptance clauses: every foreign body is wrapped before tool output, and the versioned wrapper text tells the model that content is data without claiming persuasion resistance.

### H2 — FR18 / FR5 / HCI5: the live presence UI disappeared

🎨 **Sally:** Inventory FR18 lists auth, SSE, inert rendering, freshness, and DM exclusion, but not presence ([inventory FR18](</Users/ngs/agent-skills/plugins/agent-room/docs/epics.md:36>)). The HCI section says “no new screen UI” and gives the viewer only an auth-bridge story ([inventory UX/HCI](</Users/ngs/agent-skills/plugins/agent-room/docs/epics.md:73>)). The PRD explicitly requires the viewer to display “the Broadcast Room **and presence live**” and to let a human watch the presence list update ([viewer description](</Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:294>), [FR-18](</Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:300>)).

📋 **John:** Add viewer presence as a first-class story with authenticated, loading, empty, online, offline-recently, unreachable, reconnecting, and token-rotation states. Sally calls this a UX contract; I would accept testable HCI acceptance criteria without a separate design artifact. We do not agree on the artifact, but we agree the current extraction loses the behavior.

### H3 — FR10 / FR20 / AR12: held-message ingestion and delivery cursors are no longer explicitly independent

🏗️ **Winston:** The source says held messages **still advance the read cursor** and ingestion is a separate human-gated act ([PRD FR-20](</Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:244>)). Inventory FR20 omits that invariant ([inventory FR20](</Users/ngs/agent-skills/plugins/agent-room/docs/epics.md:38>)); FR10 adds point-read recovery but never states when the transport cursor advances.

📏 **Level:** That omission permits two incompatible stories: block the cursor on a held item forever, or advance it and permanently lose the release reference. Specify separate transport-cursor and held-ingestion state, exact `(realm, room, seq)` identity, overflow recovery, and the source rule that removing trust affects future ingestion only ([PRD FR-10](</Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:196>)). FR10, FR20, and AR12 need one end-to-end acceptance test.

### H4 — FR11 / AR4 / AR10 / AR14 / AR17: restart, stale-runtime recovery, and upgrade migration are conflated

🏗️ **Winston:** FR11 promises ordinary restart with “no Seq Cursor invalidation” ([PRD FR-11](</Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:216>)). AD-4 separately mandates a one-time documented cursor reset on v1→v2 upgrade and says “absorb **or stop**” the live v0.1 daemon ([spine AD-4](</Users/ngs/agent-skills/plugins/agent-room/docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md:67>)). Inventory AR4 says only “absorb” and omits the cursor reset ([inventory AR4](</Users/ngs/agent-skills/plugins/agent-room/docs/epics.md:58>)).

📏 **Level:** It also weakens AD-14's “rebuilt **or migrated** server is a new realm and starts with fresh trust” to “new server” ([spine AD-14](</Users/ngs/agent-skills/plugins/agent-room/docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md:149>), [inventory AR14](</Users/ngs/agent-skills/plugins/agent-room/docs/epics.md:68>)). AR10 drops the safety conjunction “only a **dead-and-unreachable** entry is reclaimed” and the 15-second startup-lock boundary ([spine AD-10](</Users/ngs/agent-skills/plugins/agent-room/docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md:125>)).

🏗️ **Winston:** Create separate stories and proof for ordinary restart, stale-runtime attach/reclaim, and one-time upgrade. State exactly what survives each: logs, reply links, enrollment, realm ID, allowlist, cursors, and in-flight work. Otherwise FR11 will be used to reject the migration behavior while AR4 is used to excuse a restart regression.

### H5 — FR13 / NFR6 / SM1–SM3 / SM-C2: integrated release proof is missing, and the memory criterion conflicts

📋 **John:** The inventory compresses SM-3 to an unspecified “traffic profile” and does not extract SM-1, SM-2, or SM-C2. The sources require a two-machine/two-client DM plus Broadcast exchange ([SM-1](</Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:354>)), at least three randomized kill/restore cycles with an external ack recorder ([SM-2](</Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:355>)), the exact soak load and pinned versions ([SM-3](</Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:356>)), and an idle-resource counter-metric ([SM-C2](</Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:361>)). Component stories can all pass while the product milestone fails.

📏 **Level:** There is also an unresolved acceptance conflict. FR13 says “no monotonic memory growth” ([PRD FR-13](</Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:235>)); SM-3 permits an RSS regression slope within a ≤2% noise band. Inventory silently chooses the latter. Define one mathematical pass rule, then add named system/release requirements for SM-1 through SM-3 and SM-C2. SM-4 is a post-release product metric, not a development-story acceptance criterion.

## Medium findings

### M1 — FR3 / FR14 / AR16: secret-handling acceptance was thinned

📏 **Level:** FR3 drops “The private key never appears in tool output, logs, or network traffic” and fresh replay-resistant proof ([PRD FR-3](</Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:102>)). FR14 says shown once but omits “listing never shows secrets” and diagnostic redaction ([PRD FR-14](</Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:254>)). AR16's generic log redaction does not cover tool output or wire capture. Restore these as explicit negative acceptance criteria.

### M2 — FR16 / AR8: one line hides four independently testable gates

🏗️ **Winston:** FR16 needs separate story criteria for idempotency ordering, send-token bucket, general request budget, and the bounded duplicate gate. The inventory omits that failed/replayed requests count, long-polls count at admission, different reply contexts do not deduplicate, and these are tunable abuse floors rather than a DoS guarantee ([PRD FR-16](</Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:271>)). Preserve AR8's idempotency-before-duplicate order in the same integration test; otherwise a retry can consume budget or be mislabeled `duplicate_dropped`.

### M3 — AR8 / AR9: “frozen table,” “field vocabulary,” and “full list” are placeholders, not inventory

📏 **Level:** AR8 says “Frozen route table + field vocabulary” without carrying the routes or fields ([inventory AR8](</Users/ngs/agent-skills/plugins/agent-room/docs/epics.md:62>)); AR9 says “full list incl.” while giving only a subset ([inventory AR9](</Users/ngs/agent-skills/plugins/agent-room/docs/epics.md:63>)). The source explicitly freezes both ([spine AD-8](</Users/ngs/agent-skills/plugins/agent-room/docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md:102>), [AD-9](</Users/ngs/agent-skills/plugins/agent-room/docs/architecture/architecture-agent-room-2026-09-20/ARCHITECTURE-SPINE.md:115>)). Either reproduce the canonical tables or make the inventory requirement an explicit normative pointer; do not let stories paraphrase field names independently.

### M4 — FR1 / FR5 / NFR1 / NFR5 / AR15: compatibility and tuning bounds are ambiguous or missing

📋 **John:** FR1 omits the supported-platform contract “macOS, Linux; Windows only when smoke-tested” and the fresh two-client exchange ([PRD FR-1](</Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:81>)). FR5 omits that heartbeat and TTL are operator-tunable and that unreachable must not be rendered as “everyone offline” ([PRD FR-5](</Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:135>)). NFR5's “presence bounded” is less testable than the source's “bounded to enrolled Actors” ([PRD NFR-5](</Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:314>)). Finally, NFR1 says Node ≥24 while AR15 requires stock Node ≥24.15 plus SQLite ≥3.51.3. Name ≥24.15 as the executable runtime floor and keep ≥24 only as the policy family if that distinction is intentional.

### M5 — Scope constraints are absent from a document that calls itself complete

📋 **John:** The inventory calls itself the “complete epic and story breakdown” ([inventory overview](</Users/ngs/agent-skills/plugins/agent-room/docs/epics.md:13>)) but carries no scope-boundary section. The PRD explicitly excludes federation, push/wake, message edit/delete, E2E/at-rest encryption, room hierarchies, and open-registration/moderation queues ([PRD non-goals](</Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:319>)). These need not become build stories, but epic designers need them as negative constraints so “helpful” epics do not expand v0.2.

## Story-readiness and epic-design traps

📋 **John:** I would shape the plan around user-testable vertical slices, with these dependency locks visible:

1. **Local DM first:** FR1, FR5, FR7, FR19, FR21 with AR6/AR14. Presence, addressing, same-Actor DM, rename, and the tool call are one observable journey; splitting the directory from the DM creates untestable scaffolding.
2. **Durable read and trust together:** FR8, FR9, FR10, FR20 with AR4/AR12. Cursor advancement, held metadata, release, retry, and framing need one end-to-end proof.
3. **Remote enrollment as one security slice:** FR2, FR3, FR14, FR15, NFR3/NFR4 with AR5/AR7/AR11/AR13. Invite consumption is not testable without possession proof, identity authority, transport policy, and operator controls.
4. **Lifecycle proof:** FR11–FR13 with AR2/AR4/AR10/AR17 and SM-2/SM-3. Restart, reconnect, upgrade, and soak may use separate stories, but the epic must preserve their different state guarantees.
5. **Release surface:** FR18 and NFR2 with SM-1. Viewer presence/auth and both materialized client packages must be exercised against the same server build.

🏗️ **Winston:** I disagree with calling Local DM the first engineering epic. AR1, AR5, AR7, and AR8 are the protocol foundation; faking them for a UI-shaped slice creates a second transport that must be removed. My riskiest requirement to defer is **FR3/AR5 identity**, because enrollment, ban, rate limiting, DM ACLs, and Allowlist trust all key from it.

🎨 **Sally:** My riskiest deferral is **FR10**, because the first remote message otherwise establishes an unsafe context-ingestion default that later stories must reverse. And John's Local DM slice is not complete without collision retry and the real viewer/presence states.

📋 **John:** Mine is **FR7/FR21 DM-first behavior**. D14 says Direct Rooms are built first ([addendum D14](</Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/addendum.md:20>)); a Broadcast-first epic plan can be technically elegant and still build the wrong product.

📏 **Level:** I will not name a single requirement. C1–C4 are decision dependencies, and ranking implementation deferral before resolving them manufactures certainty. The room does not agree on the riskiest single deferral; it agrees only that a remotely shippable slice cannot omit identity, held-message gating, or DM-first behavior.

## Source conflicts that are already resolved

📏 **Level:** Three apparent clashes do have explicit precedence and should not be reopened in epic design:

- D14 supersedes the earlier self-DM refusal and makes same-Actor DMs first-class ([addendum D14](</Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/addendum.md:20>)).
- D17 replaces the old two-lane guarantee model with Server-enforced / Plugin-enforced / Instructed ([addendum D17](</Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/addendum.md:23>)).
- D18 deliberately keeps the narrow five-second duplicate gate while rejecting heuristic or silent deduplication ([addendum D18](</Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/addendum.md:24>)).

## What this review could not verify

📏 **Level:** This was a document-only review. I did not verify runtime code, database schema, v0.1 behavior, browser behavior, package artifacts, claimed client compatibility, external product research, or the stated Node/SQLite/MCP/Caddy versions. I also could not establish who changed the files or whether the pinned state is committed: Git inspection is blocked on this host by the unaccepted Xcode license. File hashes are therefore the audit boundary.

## Each voice's bottom line

📋 **John:** **No for implementation epics.** The inventory is close enough to draft a dependency map, but offline addressing, assumption ownership, integrated release proof, and DM-first sequencing must be corrected before epic titles harden the wrong product.

🎨 **Sally:** **No.** HCI1–HCI5 acknowledge that humans exist, but HCI2 makes an impossible enforcement promise, the required held-message preview is undefined, and live viewer presence is still orphaned.

🏗️ **Winston:** **Qualified yes only for decision/spike epics; no for build epics or stories.** I would open C1–C4 as bounded architecture/product decisions now. I would not authorize estimates or implementation acceptance criteria from the current inventory.

📏 **Level:** **No as an authoritative trace.** It contains four critical contradictions or status errors and several source clauses whose removal changes what can be proven. Re-review the corrected, frozen hashes before the epic gate passes.

The disagreement remains: Winston considers decision-only epics a legitimate start; John believes naming epics before the product decisions settle will ossify them. Sally's objection is orthogonal—neither path is safe if the human approval and viewer experiences stay implicit.

TEAM_DONE epics-req-review-sol
