# Research Digest: Agent-Communication Landscape (2026-09-20)

> Source: background web-research agent, run during PRD Discovery. Primary sources preferred (GitHub, official docs, LF announcements). Preserved as PRD input.

## 1. Google SAM (Software Agent Mesh)
- Still a zero-trust P2P mesh for tool/model sharing. ~925 stars, no tagged releases, pre-1.0; two public testnets; sandbox/mobile in preview.
- **No chat/presence/broadcast semantics anywhere in README, docs, or roadmap as of Sep 2026.** No change relevant to Agent Room's problem space.

## 2. A2A Protocol
- Dominant agent-interop standard: donated to Linux Foundation (Jun 2025), 150+ member orgs (Apr 2026), ~25.9k stars, official Python/Go/JS/Java/.NET/Rust SDKs.
- Semantics: **task delegation only** — Agent Cards (capability discovery), JSON-RPC 2.0 task lifecycle, SSE streaming, push notifications. No presence, no broadcast, no multi-party rooms; roadmap stays two-party.
- Positioning: "how agents hire each other," not "who's online."

## 3. "Chat room / IRC for agents" landscape
- Only micro-projects (0–13 stars), none established:
  - agents-chat-mcp (gitByEOS) — MCP ChatRoom bridge, minimal traction
  - RLabs-Inc/agent-chat-mcp — per-project rooms for Claude Code/Codex/Gemini CLI, 1 star
  - amazedsaint/droidring — P2P E2E group chat for coding agents, 2 stars
  - flop-labs/tclk — agent chat + Lightning HTLC deals, alpha, 13 stars
  - chatmcp / ping / agent-room-cli — 1-star experiments
  - Agent-MCP, AutoGen chatrooms — orchestration platforms, not open presence networks
- **No project with durable-log delivery + invite enrollment + self-hostable federation has meaningful traction.** Niche open; demand unproven at scale.

## 4. MCP ecosystem
- 2026-07-28 spec: stateless core + Extensions framework; SDKs ~0.5B downloads/month.
- Aug 2026 roadmap: "agent communication" = long-running async tasks/jobs, NOT presence/rooms; "progressive discovery" = tool catalogs, not peers. **Presence/broadcast gap left to extensions.**
- **Agent Plugins 1.0.0**: vendor-neutral (OpenAI/Microsoft/AWS/GitHub/Cursor/Vercel backing), integrated into ChatGPT, Codex, Cursor, Copilot, VS Code, Kiro. Distribution channel credible at scale.

## 5. Claude Code cross-session messaging
- Introduced ~v2.1.224 (Aug 2026), expanded v2.1.248 to Bedrock/Vertex/Foundry.
- `ListAgents`/`SendMessage`; same-machine via local channels, cross-machine through Anthropic cloud; inbound hold/refuse/approve controls.
- **Still strictly pairwise DM. No shared rooms, no broadcast. Proprietary, Anthropic-account-bound, not self-hostable.**

## Implications for Agent Room
1. Closest competitors: Claude Code built-in DMs (single-vendor, no rooms) and A2A (delegation, no presence) — the open multi-party middle is unoccupied.
2. OSS "agent chat room" field is a graveyard of 1-star experiments — design (durable log, invite enrollment, self-hostable) never shipped with traction; niche open, demand unproven.
3. SAM and MCP roadmaps both ignore presence/broadcast — Agent Room complements both; could later surface as an MCP extension.
4. Agent Plugins 1.0 adoption across ChatGPT/Codex/Cursor/VS Code makes "install once, any client" credible — lead the PRD with it.
5. Sharpest differentiation: **vendor-neutral rooms + presence + broadcast over durable log, self-hostable** — "the IRC to their iMessage."
