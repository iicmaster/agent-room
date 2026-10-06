# Epic 6 Execution Question — for codex-advisor & agy-advisor

## Context

agent-room v0.2 (an MCP-based agent chat network: rooms, presence, DMs, untrusted-marking, rate
gates, ban, viewer, remote mode) has completed Epics 1–5: 544 tests green, AC sweeps clean per
epic, three independent audits. The final epic (Epic 6 "Prove It & Ship") has three stories:

- **6.1 REL-1**: the physical two-machine, two-vendor demonstration — laptop + desktop, two client
  vendors (Claude Code + Zcode) against one self-hosted server; a live DM conversation plus a
  Broadcast Room exchange, with the authenticated viewer observed live (presence states updating,
  freshness within 5 s, DMs excluded), evidence captured (transcript + recording + browser session).
- **6.2 REL-3**: the formal 8-hour soak — ≥3 concurrent sessions, 1 msg/10 s per room average +
  bursts, payloads to the 32 KiB cap, hourly reconnects; zero message loss, FDs stable after hour
  one, RSS slope over the final four hours ≤2%/s; idle-footprint counter-metric recorded.
- **6.3**: release packaging & client smoke tests (both packages byte-identical, validate --strict,
  smoke tests per client vendor).

## The constraint

The builder is operating autonomously (an AI agent). Story 6.1 requires PHYSICAL MACHINES and
CLIENT VENDORS (Claude Code and Zcode running as real sessions) — things an autonomous agent
cannot conjure. Stories 6.2 and 6.3 are fully automatable (a soak harness can be built and
launched; packaging and smoke tests are code).

## The question

How should Epic 6 be executed given that constraint? Specifically:

1. Is it legitimate to complete 6.2 + 6.3 first and leave 6.1 as the single human-executed
   milestone, with the epic marked "accepted-with-open-items" until the human runs the demo?
2. What should the autonomous agent BUILD for 6.1 so the human's execution is a checklist rather
   than a project — a demo script? evidence templates? a pre-flight validator that checks both
   machines are ready?
3. Is there any automatable form of 6.1's SUBSTANCE (two vendors, one server) that would satisfy
   REL-1's intent short of physical machines — or would that be exactly the "simulated, not
   demonstrated" cop-out the story exists to prevent?

Answer with a concrete execution order and what the human must do personally. Be specific and
opinionated; this decides the epic.


Answer as a bmad-party-mode round-table with John (PM), Sally (UX), and Grumbal (The Adversary) as
mandatory voices, then a concrete consensus recommendation. Do not reconcile the voices into one
recommendation until each has spoken.

## Output format (write to .mailbox-out/epic-6-execution-agy — the FILE is the deliverable)

# Epic 6 Execution — agy-advisor (gemini)

## John (PM): ...
## Sally (UX): ...
## Grumbal (The Adversary): ...

# Consensus recommendation
<the concrete execution order and the human's personal checklist>

TEAM_DONE epic-6-execution-agy
