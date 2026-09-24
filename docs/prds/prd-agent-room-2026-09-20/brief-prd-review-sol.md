# Review request: Agent Room v0.2 PRD

You are reviewing a draft PRD for a solo-builder project before it is finalized and handed to architecture/epic planning.

## What to read (absolute paths)

- PRD draft: `/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md`
- Decision record / technical addendum: `/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/addendum.md`
- Landscape research digest: `/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/research-landscape-2026-09-20.md`
- Existing v0.1 codebase grounding: `/Users/ngs/agent-skills/plugins/agent-room/README.md` and `/Users/ngs/agent-skills/plugins/agent-room/AGENTS.md`

## Context

- Builder: solo, personal tool first, open-source later; must stay open-ready (identity/wire/guarantees decided day one).
- v0.2 = near-rebuild of transport/identity on top of preserved v0.1 semantics: SQLite STRICT/WAL durable log, idempotent sends, seq-cursor pagination, GET-only token-auth web viewer, zero runtime dependencies beyond Node 24 built-ins, MCP stdio surface, Agent Plugins 1.0.0 conformance as a hard release gate.
- Product: IRC-style realms. Local Mode is the default (zero-config localhost server); Remote Mode is opt-in (self-hosted server, invite-token enrollment, per-installation keypair identity, presence list, one broadcast room + direct rooms, durable log + long-poll pull delivery). Server-enforced gates (rate limit, ban, duplicate drop) and client-requested gates (untrusted marking, held messages) are documented as two explicit guarantee lanes.

## What to attack

1. Requirement quality: are FR-1..FR-18 testable, unambiguous, non-contradictory? Which ones would make an architect or epic-writer stop and ask?
2. Gaps: what is missing that v0 scope cannot ship without (blockers, not wishlist)?
3. Security posture realism: untrusted marking / held messages are *client-requested* gates on a network that carries prompt injection across machines — is the honest two-lane split right, and is any guarantee overstated?
4. Continuity & endurance: FR-11..FR-13 and SM-2/SM-3 (server kill -9 under traffic, session reconnect catch-up, 8-hour soak) — are the success criteria actually verifiable as written?
5. Scope discipline: Local Mode default protected by counter-metric SM-C1 — does the PRD defend the default path convincingly?
6. Anything the research digest's "open middle" positioning claims that the PRD itself does not actually support.

## Output

Full review as your final answer (the dispatch harness captures it to an outbox). Severity-ranked findings (critical/high/medium/low), each citing the PRD section it concerns. End with what you would demand fixed before the PRD is marked `status: final`.

Answer as a bmad-party-mode round-table. Cast 3-5 named voices with
distinct expertise and real disagreements. They address each other, not
only me. Do not resolve the clash into consensus; where they cannot
agree, say so and say why. End with each voice's own bottom line.
State plainly whatever you could not verify.

You are advising in read-only mode: do not edit any files.
