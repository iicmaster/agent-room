# Consultation request: seven open questions blocking PRD finalization

You are advising the builder of Agent Room v0.2 (solo developer, personal tool first, open-source later). The PRD draft is nearly final; seven open questions remain. For each, give a concrete recommendation the builder can paste into the PRD as a decision.

## Read first (absolute paths)

- PRD draft — especially §8 Open Questions, §4 Features/FRs, §9 Assumptions Index: `/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/prd.md`
- Decision record D1–D12, two-lane guarantee table, polling analysis: `/Users/ngs/agent-skills/plugins/agent-room/docs/prds/prd-agent-room-2026-09-20/addendum.md`
- Existing v0.1 grounding: `/Users/ngs/agent-skills/plugins/agent-room/README.md` and `/Users/ngs/agent-skills/plugins/agent-room/AGENTS.md`

## Hard constraints (non-negotiable, per decision log D1–D12)

- Zero external runtime dependencies: Node 24+ built-ins only (`node:http` with TLS, `node:crypto`, `node:sqlite` STRICT/WAL, `node:fs`).
- MCP stdio tool surface; Agent Plugins 1.0.0 conformance is a hard release gate.
- Append-only durable log, monotonic seq cursors, idempotent sends (v0.1 semantics preserved).
- Local Mode is the default and must stay zero-config; Remote Mode is opt-in.
- Invite-only realms; server-enforced gates (rate limit, ban, dedupe) and client-requested gates (untrusted marking, held messages) from day one.
- Solo builder; v0.2 must be shippable, not gold-plated; keep-all unless you can argue a cap is *necessary*.

## The seven questions (current assumption in parentheses)

1. **TLS termination** — Server-native TLS via `node:http` built-ins vs a documented reverse-proxy pattern. (Assumed both viable; architecture decides.) Recommend one as the *primary* story for a solo operator running a realm on a VPS, and say what the docs must cover for the other.
2. **MCP tool surface naming for presence and DMs** — e.g. `room_presence` vs `list_agents`; whether to keep `message_send`/`message_read` and how Direct Rooms appear in the tool surface. (No assumption.) Consider: collision/confusion with Claude Code's native `ListAgents`/`SendMessage` tools when both are present in one session; discoverability by the agent; Agent Plugins conventions.
3. **Wire protocol versioning** — version field shape and v0.x compatibility policy. (Additive-only assumed.) Recommend the concrete mechanism (header vs field, integer vs semver, behavior on mismatch).
4. **Log retention/size caps for long-lived realms** — keep-all vs caps. (Keep-all for v0.2.) A realm left running for a year on a VPS: what actually breaks first, and is any cap needed *now*?
5. **Heartbeat / online TTL / rate-limit defaults** — (60s / 3×heartbeat / ~30 sends·min⁻¹·Actor). Recommend concrete numbers with reasoning about battery laptops, sleep cycles, NAT timeouts, and abuse floors.
6. **Held-message default policy granularity** — per-Server allowlist vs global; same-machine Actors always allowed. (Per-Server assumed.) Recommend the exact default matrix (same-machine sender, allowlisted remote, stranger) and the one-step allowlist UX.
7. **Invite Token format, use-count, rotation** — (No assumption.) Recommend format, single-use vs multi-use, expiry, and the operator rotation/revocation UX, under zero-dep constraints.

## Output

For each question: the real options (including any the PRD did not consider), tradeoffs under the constraints above, one concrete recommendation ready to paste into the PRD, and what future fact would change the recommendation. Explicitly flag any recommendation that conflicts with decisions D1–D12. End with a per-question one-line summary table.

Answer as a bmad-party-mode round-table. Cast 3-5 named voices with
distinct expertise and real disagreements. They address each other, not
only me. Do not resolve the clash into consensus; where they cannot
agree, say so and say why. End with each voice's own bottom line.
State plainly whatever you could not verify.

You are advising in read-only mode: do not edit any files.
