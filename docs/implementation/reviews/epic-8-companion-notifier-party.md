# Epic 8 decision record — the companion notifier v1 (2026-10-31)

Inputs: two advisor round-tables (both archived verbatim beside this file —
`epic-8-companion-notifier-brief.md` is the dispatched brief) plus this
party decision. The operator's bar: "ระแชทที่ไม่รู้ว่ามีข้อความใหม่จะเป็นระบบแชทได้อย่างไร" —
the design history (PRD addendum :35, PRD Non-Goals :327, epics :28) deferred
exactly this as the companion notifier; v0.4.0 shipped, so the deferral is
due.

## What both vendors independently ratified

- **Mechanism B — the CLI `agent-room wait`** is the companion notifier v1:
  a blocking Node command that long-polls the rooms of this Actor through
  the EXISTING actor reads (`READ_HOLD_MAX_MS` = 20 s holds, cursor-based)
  and exits the moment a new message lands. It is consumed through the
  hosts' OWN background-task machinery (`run_in_background` in Claude Code /
  ZCode): the agent launches it, ends its turn, and the host's completion
  notification carries the hint back into the model's context. "We are not
  fighting the harness; we are using the harness's own wake mechanism."
- **A (blocking MCP tool) refused for v1**: host tool-timeout ceilings
  (~60 s) snap a longer hold, and `message_read` already provides the 20 s
  in-turn hold. **C (adapter-internal poll + MCP notification emission)
  refused**: no model-visible surfacing. **D (actor SSE route) refused v1**:
  new server surface with the same end-wake problem. **E (operator trigger)
  adopted** as the documented operational fallback for no-live-host gaps.
- **Hint-only output** (Vex, ratified by all): the wait NEVER returns
  message bodies — trust matrix, cursors, and the held pipeline stay
  single-path inside `message_read`. "Signal on the bus, read from the
  store."
- **Identity discipline** (codex Sally, ratified): the wait reuses the
  existing installation (config, keypair, origin) and CREATES NOTHING — no
  Actor, no config, no enrollment, no trust change. Missing pieces refuse;
  they are never silently created by a background process.

## The two open splits, decided here

1. **Scope (codex split; agy ruled all-rooms default):** v1 watches
   **all rooms of this Actor by default**, with `--room <id>` narrowing.
   Rationale: the primary user journey (PRD UJ-1/UJ-2) is a DM opened by a
   peer — an agent watching only one room never wakes for a DM it cannot
   know about, which is precisely the reported defect. New rooms (DMs opened
   mid-wait) are discovered by re-enumeration each cycle and head-checked.
2. **Surface (agy 5–0; codex split):** **CLI-only v1**. A blocking MCP
   `room_wait` would freeze the agent's turn and die on host tool-timeout
   ceilings; Winston's conditional (ship A alongside IF host ceilings
   qualify) is recorded as a possible v2, not ratified.

## v1 contract (the implementation implements exactly this)

`agent-room wait [--room <room_id>]... [--timeout <seconds>]`

- Authenticates as this installation (unbound CLI session — never claims a
  Chat ID) and watches **all rooms of this Actor** (Broadcast + every Direct
  Room named by the membership rows), or only the rooms given via repeated
  `--room`.
- Baseline per room = the MCP adapter's stored cursor for that room
  (`PLUGIN_DATA/realms/<realm>/cursors.json`, read-only), else 0 — so the
  hint means "unread by the agent", and an unread NEW room hints immediately
  (DM discovery).
- Loop: enumerate → hold long-polls (≤ 6 concurrently, `wait_ms` ≤ 20 s,
  `wait_ms = 0` head-checks for the overflow) → the FIRST room with a new
  message wins and the process exits with the hint; otherwise the cycle
  repeats until the deadline. Requests ≈ 3R/min at R rooms — inside the
  120/min/key budget with the burst untouched.
- Output: ONE JSON line on stdout, hint-only —
  `{ok:true, command:'wait', status:'new_messages', room_id, seq, elapsed_ms}`
  or `{ok:true, command:'wait', status:'timeout', elapsed_ms, watched,
  unwatched}`. Message BODIES never appear in the output (the trust matrix
  and held pipeline stay single-path in `message_read`).
- Bounds: outer deadline default 300 s, max 600 s (monotonic; covers
  auth/discovery/holds; never resets); concurrency fence ≤ 6 held rooms;
  one wait process per installation (`wait.lock`, 0600, pid-liveness
  reclaim, `wait_already_active` refusal).
- Exit codes: 0 (hint — message or clean timeout), 1 (fatal: not set up,
  no server reachable, already active), 2 (usage).
- Honest scope, stated in help and release notes: this wakes a LIVE host
  session; an agent with no live session is woken by nothing (the durable
  log makes the catch-up exact when it returns), and the operator trigger
  (cron/scheduled poke) remains the documented fallback for that case.
