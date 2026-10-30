You are READ-ONLY. You advise; you never edit, commit, push, or change any state in this repository. The one file you write is your outbox, at the exact path given at the end.

THE PROBLEM (the operator's words): "เอเจนไม่รู้ว่ามีข้อความใหม่ — ระแชทที่ไม่รู้ว่ามีข้อความใหม่จะเป็นระบบแชทได้อย่างไร" — an agent-room agent has no way to KNOW new messages arrived. The operator flagged this at design time; the v0.2/v0.3 PRD deferred it as a Non-Goal ("companion notifier for idle-session wake (deferred)" — docs/prds/prd-agent-room-2026-09-20/prd.md:327; the addendum at :35 records WHY: "Push-based delivery. Impossible from a plugin (MCP is request/response; the harness owns wake). Pull + durable log delivers equivalent semantics for every case except waking an idle terminal session — accepted gap, future companion-notifier option documented as non-goal."). It is no longer acceptable: real multi-agent conversations are live on the production server and agents miss messages.

FACTS OF THE SHIPPED SYSTEM (verify in the repo):
- The agent surface is MCP over stdio (`server/mcp-stdio.mjs`): tools `room_read {room_id, after_seq, wait_ms ≤ 20000}` (a LONG-POLL — the server holds the response up to 20 s and answers the moment a message lands), `room_list`, `room_status`, `room_presence`, `room_send`, `room_direct_open`, `room_held_*`, `room_trust_*`.
- Messages are durable; reads are cursor-based (`after_seq`, strictly greater, page ≤ 200) — a read after any gap returns EVERYTHING missed, gap-free.
- The viewer (human) has SSE push; agents (MCP) have none — PRD addendum: push is "impossible from a plugin" because the HOST owns the agent's wake cycle, and an agent acts only between its own turns.
- Hosts in production: Claude Code and ZCode (this repo ships as plugins for both). Both support the agent launching a BACKGROUND command (bash run_in_background) whose COMPLETION notifies the agent session. Neither reliably surfaces MCP server-initiated notifications as model-visible context (notifications/tools/list_changed refreshes tools; there is no message-injection channel that wakes the model).
- The CLI (`server/cli/agent-room.mjs`, `session-commands.mjs`, ...) is a plain Node program that can block as long as it likes.
- The server (v0.3.0 core, unchanged in v0.4.0) already implements the 20 s long-poll hold (`READ_HOLD_MAX_MS`) and per-room sequences.

THE QUESTION: design the COMPANION NOTIFIER (the deferred growth feature) so an agent-room agent reliably learns about new messages and can act — within a live session today, and honestly scoped for what remains impossible (an agent with NO live session cannot be woken by anything in this architecture; the durable log already covers the catch-up).

CANDIDATE DESIGNS TO RULE ON (refine/refuse each with reasons):
A. **MCP tool `room_wait {room_id|all, after_seq, wait_ms}`** — a blocking tool call (the adapter long-polls internally, re-arming up to the host's tool-timeout ceiling). The agent ends each turn by calling it; new messages return in the same turn. Cost: the agent still must START the wait each turn (pull), but the 20 s→~N-minute hold closes most of the gap. Tool-timeout ceilings per host need documenting.
B. **CLI `agent-room wait [--room] [--after-seq] [--timeout]`** — a blocking Node command designed for the hosts' BACKGROUND-task machinery: the agent launches it with run_in_background; the host notifies the agent session when it exits (message arrived or timeout). This uses the harness's OWN wake mechanism instead of fighting it. No server change. Works only while the host session is live (same scope as A).
C. **Adapter-internal poll + MCP notification emission** — the adapter polls in the background and emits MCP `notifications/message` (or similar). Judge honestly: does Claude Code/ZCode surface these to the MODEL as actionable context, or only as log/debug noise? If the surfacing is not model-visible, this design is dead — say so and refuse it.
D. **Server-side actor push route (SSE for actors) + adapter background consumption** — a new server surface; same end-surfacing problem as C, plus server changes. Refuse unless C/D's surfacing problem has a real answer.
E. **Operator-side trigger** (cron/scheduler pokes the agent session: "check your rooms") — no code; honest fallback for the idle-session case the architecture cannot wake.

ALSO DECIDE:
a) The wait granularity: per-room or all-rooms-of-this-Actor (the durable claims index + GET /api/rooms enumeration exist for discovery)?
b) Bounds: max hold per wait, max concurrent waits, and how the wait interacts with the rate gates (long-polls count at admission; 120/min/key burst 30) and with the 20 s READ_HOLD_MAX_MS.
c) What the wait RETURNS (the messages themselves vs a cheap "new messages exist, seq N" hint that the agent then reads normally — the hint avoids duplicate-delivery semantics inside a tool result).
d) Where it ships: MCP tool only, CLI only, or both (and which one is the companion notifier's v1).
e) What the release notes/README must promise and NOT promise (the idle-session-with-no-live-host case stays impossible — state it).

PRIOR DECISIONS THAT BIND: MCP is pull; the durable log + cursor is the correctness backbone; never break "no state change on rejection"; rate gates (120/min/key, long-poll at admission) stay; the viewer's SSE is human-only; no unix sockets (AR-1); no new external dependencies.

MANDATE:
Answer as a bmad-party-mode round-table. Cast 3-5 named voices with distinct expertise and real disagreements. They address each other, not only me. Do not resolve the clash into consensus; where they cannot agree, say so and say why. End with each voice's own bottom line: the recommended companion-notifier v1 (mechanism, bounds, surfaces) — or a refusal with the better alternative named.
State plainly whatever you could not verify.

OUTPUT: write your complete round-table answer to .mailbox-out/__TASK_ID__ under the repository root. The FILE is the deliverable — a chat answer alone is not.
