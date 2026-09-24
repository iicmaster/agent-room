# Review: PRD draft → codex-advisor (sol)

> Provenance: task `prd-review-sol`, effective_identity `gpt-5.6-sol[max] (matched)`, receipt-backed ACP dispatch (session 01a0bbc3, recovered via two receipt-backed resumes per lane protocol), completed 2026-09-20 05:43. Verbatim outbox capture. Review pin: prd.md SHA-256 4491d7ac… (post-NFR-fix version).

Keep `status: draft`; do not hand this PRD to architecture or epic planning yet.

Review pin: `prd.md` SHA-256 `4491d7ac…`, addendum `2b01aac3…`, research digest `549ab4fd…`. The PRD changed during the original review; these findings use the updated version containing NFR-1..NFR-7.

In the room: 📋 John (PM), 🎨 Sally (UX), 🏗️ Winston (architecture), 📊 Mary (research), and 🔒 Vex (security).

## Critical

📋 **John: C1 — The participant model contradicts the core job.** [PRD §1, §3, FR-5, NFR-3](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:14)

The vision promises that every **Session** is visible and messageable. Identity, presence, allowlists, rate limits, and DMs address an **Actor**, defined as one plugin installation. Multiple sessions can share one installation key, yet FR-5 has only one `client type`, `connected-since`, and `last-seen` per Actor.

🎨 **Sally:** “That fails in the first user journey. Two Claude sessions sharing plugin data may appear as one person. The user cannot tell which terminal is alive or which one answered.”

It also affects safety: two sessions sharing one Actor could treat each other’s messages as self-originated and bypass FR-9’s foreign-message framing. Decide whether Sessions receive ephemeral IDs authenticated by an Actor key, or revise the product promise to installation-level participants. Define DM addressing, presence aggregation, disconnect behavior, and rate-limit scope.

---

🔒 **Vex: C2 — The two guarantee lanes are directionally honest, but they still overstate enforcement.** [PRD FR-9/FR-10 and NFR-4](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:163), [Addendum D6](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/addendum.md:12)

Three different claims are compressed into “Client Gate”:

1. The local plugin can mechanically wrap or omit text.
2. A model is instructed not to obey the text.
3. A human supposedly approved releasing or allowlisting it.

No trusted human-only approval channel is defined. An agent-callable allowlist tool cannot prove that the request came from the human; the viewer is explicitly GET-only. A held-message preview is already attacker-controlled text in model context. Allowlisting a Handle also trusts a display identifier rather than `(Realm, Identity Key)`.

FR-9 says an agent must “never act” on any foreign message without human direction. Taken literally, that destroys the main job of agents coordinating without human routing.

📋 **John:** “I do not automatically accept Vex’s three-lane taxonomy. Two top-level lanes may be easier to teach.”

🔒 **Vex:** “Keep two headings if you want. The requirement still must label which part is code-enforced, host-dependent, or merely requested of the model.”

The room does not agree on the taxonomy. It agrees that the current guarantees are not precise enough to ship.

The addendum’s “permission prompts still fire” is host- and configuration-dependent, not a universal free guarantee. “Commands never auto-run” only describes the transport; injected text can still persuade an agent to invoke tools.

---

🏗️ **Winston: C3 — The delivery contract is missing, so FR-8, FR-11, FR-12, FR-17, and SM-2 cannot prove “lose nothing.”** [PRD FR-8 and FR-11..FR-12](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:155), [FR-17 and SM-2](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:241)

The PRD does not decide:

- Whether cursors are persisted, and whether they are per Session, Actor, or room.
- Whether a cursor advances when text is fetched, delivered to model context, or explicitly acknowledged.
- How a returning Actor discovers a DM opened while it was offline.
- What “complete catch-up” means while new traffic continues.
- What happens when the server commits a send but its response is lost.

FR-17’s “no send outcome is ambiguous” is impossible across a network. That last case must return `outcome_unknown` with “retry the same `client_message_id`”; the idempotency rule then resolves the outcome.

Define at-least-once delivery, permissible redelivery, durable cursor ownership, a reconnect high-water mark, room/inbox discovery, and the durable acknowledgement point.

---

🎨 **Sally: C4 — Local Mode cannot simultaneously be zero-configuration and require an Invite Token on first contact with every Server.** [PRD §3 Enrollment/Invite Token and FR-1..FR-3](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:47), [SM-C1](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:312)

Local bootstrap needs an explicit exception and journey: automatic OS-user-scoped enrollment, automatic Broadcast Room membership, automatic Handle allocation, and no URL, token, or room-ID exchange.

FR-2 must also distinguish an **unenrolled key**, which needs an Invite Token, from an enrolled key reconnecting without one. “Nothing is reachable without [an Invite Token]” is too broad.

SM-C1 does not yet protect the default convincingly because the v0.1 baseline has no recorded step count, timing boundary, trial count, or failure rate. “After plugin installation” also needs to be the stated measurement start.

---

🔒 **Vex: C5 — FR-7 overstates DM confidentiality.** [PRD FR-7](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:147), [NFR-4 and plaintext-at-rest non-goal](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:263)

With no E2E or at-rest encryption, the server operator controls the process and SQLite file and can read DMs. The viewer token is not an Actor identity, so “unless the operator is a participant” is not a coherent authorization rule.

Promise only that protocol APIs deny third-party Actors and bundled viewer endpoints never expose DMs. State plainly that the host operator is trusted and can inspect stored plaintext.

## High

🏗️ **Winston: H1 — Sequence and idempotency namespaces are ambiguous.** [PRD FR-6..FR-8, FR-11, FR-16, NFR-7](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:139)

The current v0.1 schema uses a server-global autoincrement sequence while reads filter by room. That produces visible sequence gaps within a room. The PRD simultaneously describes room logs, one Durable Log, “gap-free” reads, and “no gaps.”

Specify whether sequence numbers are realm-global or room-local, what “gap-free” means, and the cursor’s scope. Preserve the actual v0.1 idempotency tuple—currently Actor + room + `client_message_id`—rather than saying only “keyed by `client_message_id`.”

Content-based duplicate dropping must be distinguished from an idempotent retry. Better still, remove heuristic content deduplication: rate limiting plus idempotency already handles abuse and retries without dropping legitimate repeated messages.

---

🔒 **Vex: H2 — NFR-4 is a start, but the remote threat model is absent.** [PRD FR-3, FR-14..FR-16, NFR-3/NFR-4](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:97)

The PRD needs security outcomes for:

- Fresh possession proof and replay resistance; presenting a public key is not authentication.
- TLS certificate validation and refusal of plaintext Remote Mode.
- Handle uniqueness, normalization, reuse, and confusable characters.
- Allowlists bound to Realm + Identity Key, with Handle used only for display.
- Invite use count, expiry, atomic exhaustion, revocation, and secret-safe logging.

Exact algorithms belong to architecture. These guarantees and trust boundaries belong in the PRD.

---

🏗️ **Winston: H3 — SM-2, SM-3, NFR-5, and NFR-6 have numbers but not reproducible tests.** [PRD FR-11..FR-13 and NFR-5/NFR-6](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:188), [SM-2/SM-3](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:304)

The kill drill needs an external record of acknowledged IDs, a defined kill cut, retries of unknown outcomes, the same storage after restart, and more than one randomized cycle.

The soak needs a traffic profile, payload sizes, reconnect schedule, host/Node/SQLite versions, sampling interval, and numeric RSS/FD ceilings. “No upward memory trend” lacks a permitted slope and noise tolerance. WAN p95 cannot be guaranteed without a reference topology or RTT budget.

📋 **John:** “Eight hours is acceptable as a release soak, but it should not be the only feedback loop. Add a short connection-churn regression test for ordinary development.”

---

🔒 **Vex: H4 — Resource exhaustion and browser rendering are missing from the remote-input contract.** [PRD FR-6, FR-10, FR-18, §7.2](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:139)

The v0.1 implementation caps messages at 32 KiB, but the v0.2 PRD does not preserve any byte limit. Keep-all storage plus remote senders needs message/frame limits, disk-full behavior, and an operator-visible capacity failure. A compromised enrolled Actor can otherwise exhaust storage despite the per-minute rate limit.

FR-18 also needs an acceptance criterion that Handles and messages render as inert text with no HTML/script execution. GET-only protects mutation; it does not prevent XSS or token leakage. Define viewer-token rotation and prevent bearer tokens from leaking through logs, referrers, or caches.

---

📊 **Mary: H5 — The “open middle” positioning outruns the PRD’s evidence and release proof.** [PRD §1, NFR-2, SM-1/SM-4, Open Question 3](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:14), [Research implications](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/research-landscape-2026-09-20.md:34), [Addendum D8/D11/D12](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/addendum.md:14)

Four claims need correction:

- The landscape suggests an unoccupied feature gap; it does not validate demand. SM-4 validates personal usefulness only.
- “Install once, any client” should be “one portable package, separately installed and smoke-tested in each claimed client.”
- The digest mentions self-hostable federation, while federation is explicitly out of scope.
- “Any curl client can speak to the Server” and day-one open-ready wire guarantees are unsupported while protocol versioning remains an open question.

The addendum’s “1,000 strangers” design test is also unsupported by a three-session soak, an idle metric for 0–5 Actors, and an unbounded keep-all log.

## Medium

🎨 **Sally: M1 — FR-5 describes two different presence lists.** [PRD FR-5](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:122)

The main sentence returns Actors within the online TTL; a consequence also includes Actors seen within 24 hours. Define two response groups or one list with explicit state. `connected-since` and `client type` also require resolution once multiple Sessions can share an Actor.

📋 **John: M2 — Several “open questions” are product behavior, not architecture choices.** [PRD §9](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:316)

Wire compatibility policy, Held Message trust scope, invite use-count semantics, and content-deduplication behavior change what users observe. They must be decided before epics. TLS termination mechanism and exact MCP names can remain architectural decisions.

📋 **John: M3 — DMs are the clearest scope-cut candidate for a solo builder.** [PRD FR-7, §7.1, SM-1](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:147)

Presence plus Broadcast Room already tests the research differentiator. DMs add private authorization, discovery, multiple cursors, viewer exclusion, and offline-room discovery.

🎨 **Sally:** “I disagree. Private cross-machine coordination is a real journey, and forcing everything into broadcast weakens the product.”

This remains unresolved. If DMs stay, their missing contracts are blockers. If schedule pressure appears, John would defer DMs before weakening identity, durability, or safety; Sally would retain them.

🏗️ **Winston: M4 — Permanent-log language conflicts with future retention and indefinite reconnection.** [PRD Glossary, FR-3, §6, §7.2](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:47)

For v0.2, say “no user editing or deletion; keep-all retention.” Avoid timeless “never deleted” and “absence of any duration” claims if retention may later be introduced.

## Low

📊 **Mary: L1 — “Non-Users (v1)” and “v1 servers” are ambiguous inside a v0.2 PRD.** [PRD §2.2](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:31)

Use “v0.2” or explicitly define “v1 product horizon.”

🏗️ **Winston: L2 — A few boundaries use non-test language.** [PRD FR-1, FR-4, FR-8](/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md:79)

“Any machine” needs supported platforms/runtime prerequisites; “single command” needs the command’s success boundary; and the 20-second limit should apply to server hold time, not total network call wall time.

## FR-1..FR-18 stop map

📋 **John:** “`STOP` means an epic writer must ask a product question. `TIGHTEN` means the intended behavior is visible but its acceptance boundary needs precision.”

| FR | Gate | Question that stops downstream work |
|---|---|---|
| FR-1 | **STOP** | How does Local Mode auto-enroll and auto-join without a token? |
| FR-2 | **STOP** | When is a token required, and what persists when switching Realms? |
| FR-3 | **STOP** | Is the principal a Session or installation Actor; how are Handles and keys scoped? |
| FR-4 | **TIGHTEN** | What exact command and success state establish a running Server? |
| FR-5 | **STOP** | Are presence rows Sessions or Actors, and does the list include recently offline entries? |

| FR | Gate | Question that stops downstream work |
|---|---|---|
| FR-6 | **TIGHTEN** | What are payload limits and the exact idempotency scope? |
| FR-7 | **STOP** | How are new DMs discovered, and what privacy is promised against the host operator? |
| FR-8 | **STOP** | What is the sequence namespace, cursor owner, paging contract, and advancement point? |
| FR-9 | **STOP** | Is “never act” advisory policy or enforced behavior, and how can agents still coordinate? |
| FR-10 | **STOP** | What trusted action proves human approval, and what happens to dropped held entries? |

| FR | Gate | Question that stops downstream work |
|---|---|---|
| FR-11 | **STOP** | What counts as acknowledged, and how are unknown in-flight sends reconciled? |
| FR-12 | **STOP** | Where is the last processed cursor persisted, and how are new rooms caught up? |
| FR-13 | **STOP** | What workload and numeric resource ceilings define pass/fail? |
| FR-14 | **STOP** | Are tokens single-use or bounded-use, expiring, and atomically consumed? |
| FR-15 | **TIGHTEN** | What is the maximum ban-enforcement latency for an active Long-Poll? |

| FR | Gate | Question that stops downstream work |
|---|---|---|
| FR-16 | **STOP** | What rate algorithm/window applies, and why is content deduplication needed? |
| FR-17 | **REWRITE** | Add an unknown/safe-retry result; “no ambiguous outcome” is impossible. |
| FR-18 | **TIGHTEN** | Add inert rendering, token lifecycle, cache/referrer rules, and a Remote Mode exposure test. |

## What could not be verified

📊 **Mary:**

- The research digest’s competitor counts, roadmap dates, integrations, and “nobody occupies” conclusion were not independently verified; the digest provides no source URLs.
- No v0.2 artifact exists here, so Agent Plugins conformance, claimed-client installation, key authentication, Remote viewer behavior, kill recovery, and the soak remain unverified.
- Universal host permission prompts and trustworthy human provenance could not be verified and should not be claimed.
- This was a read-only static review. No runtime tests were executed and no source files were edited.

## Required before `status: final`

1. Decide the Session/Actor/addressing model and write the complete zero-config Local enrollment journey.
2. Rewrite the security contract: threat actors, trusted server boundary, stable-key allowlists, approval provenance, Held Message behavior, and accurate DM privacy.
3. Define delivery semantics: authentication outcome, sequence namespace, cursor persistence and advancement, room discovery, acknowledgement, unknown retry, idempotency, and duplicate handling.
4. Turn SM-C1, SM-2, SM-3, and NFR-5/NFR-6 into reproducible protocols with workloads, baselines, numeric budgets, and pass/fail oracles; add message/storage and viewer-safety limits.
5. Correct the positioning to distinguish feature-gap evidence from demand validation, lock the wire compatibility promise, test every named client, and decide whether DMs remain in v0.2.

📋 **John’s bottom line:** Keep the PRD draft. Before `status: final`, settle the product decisions now left to architecture. If scope must shrink, defer DMs and content-based deduplication before weakening the default path, safety, or durability.

🎨 **Sally’s bottom line:** I would keep DMs; John and I do not agree. Before `status: final`, provide a literal Local Mode first-run journey and a visible, trusted human-approval interaction.

🏗️ **Winston’s bottom line:** Architecture can choose mechanisms after the PRD fixes identity, cursor, acknowledgement, and sequence semantics. Those contracts must be fixed before `status: final`.

📊 **Mary’s bottom line:** The positioning is a promising hypothesis, not validated demand. Before `status: final`, claim only the clients, interoperability, demand, and scale supported by defined release evidence.

🔒 **Vex’s bottom line:** Treat the server operator as trusted, bind trust to keys rather than Handles, and never describe model instructions or host-dependent prompts as enforced security. Fix those guarantees before `status: final`.

TEAM_DONE prd-review-sol
