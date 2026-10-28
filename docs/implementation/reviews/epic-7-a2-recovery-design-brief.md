You are READ-ONLY. You advise; you never edit, commit, push, or change any state in this repository. The one file you write is your outbox, at the exact path given at the end.

CONTEXT: agent-room v0.2.0 shipped; Epic 7 (v0.3) is in progress. Stories 7.1 (the total handoff fence) and 7.3 (signal-safe teardown: stdin/SIGTERM/SIGINT/EOF all join ONE bounded shutdown that releases the Chat ID; a pending first bind is coordinated and rolled back) are DONE. Story 7.4 is a DESIGN round-table — it pre-commits to NO mechanism, NO schema, NO implementation. Read docs/epics.md Story 7.4, docs/implementation/epic-6-retro-2026-10-21.md (action A2), docs/implementation/reviews/epic-6-lease-astra.md (the v0.2 design ruling that refused leases/heartbeats), and docs/implementation/reviews/epic-7-design-gate-{codex,agy}.md (the named candidates).

THE QUESTION TO SETTLE: after Story 7.3, the ONLY remaining squat scenarios are SIGKILL, OOM kill, power loss, and a dead remote peer. Is there an ownership-evidence design for automatic unattended recovery that survives the falsification bar, or is the reasoned refusal (keep the explicit `agent-room session replace` takeover) the right answer? EITHER OUTCOME IS ACCEPTABLE — a refusal with reasons is the default baseline.

THE FALSIFICATION BAR (every candidate must clear it): the Two-Tab Co-Tenancy Test — two LIVE processes sharing one `${PLUGIN_DATA}` (two terminal tabs, one keypair) are indistinguishable from a crash-restart pair to any disk-token scheme; a design that would let Tab 2 silently displace live Tab 1 FAILS by construction.

NAMED CANDIDATES (rule PASS/FAIL on each, with reasons):
1. **Disk-only one-time recovery secret** in `${PLUGIN_DATA}` — prior ruling: fails co-tenancy by construction.
2. **Kernel-enforced liveness probe** — a `node:net` Unix domain socket in `${PLUGIN_DATA}` bound by the live holder (kernel closes it on death → `ECONNREFUSED` is the OS's death certificate), paired with a server-bound one-time recovery ticket presented alongside normal Actor authentication on `POST /api/session`. Judge: macOS `sockaddr_un` ~104-byte path limit vs deep `PLUGIN_DATA` paths; concurrent-start unlink races after a crash; `SIGSTOP`/wedged-event-loop false-dead detection; a container rebuild wiping runtime files but keeping the keypair; cross-machine shared keypair (the socket is local-only — is that a feature?); the second local IPC surface re-entering the MCP child after v0.2 retired roomd's socket; and the Architecture Spine amendment a NON-INTERACTIVE resume transition requires (today takeover is explicit-only, interactive-confirmed, and never automatic).
3. **Shortened lease TTL + background heartbeat** — refused by prior recorded decision (idle MCP sessions must not lose their name); confirm or overturn with reasons.
4. **Self-reported process lineage (PID/boot-id)** — prior refusal: unverifiable over Remote Mode, spoofable. Confirm or overturn.

ALSO RULE ON (the record must name these regardless of outcome):
a) **The consent model**: is narrow PRIOR DELEGATION (the operator once grants a trusted supervisor the right to recover this installation's names) a ratifiable NEW policy, or must every displacement remain a per-event explicit decision? What would the delegation record have to contain to be honest consent?
b) **The trust boundary**: what does the server have to be able to PROVE, and what can it never prove (process death vs network partition vs a lied-to server)?
c) **The exact server surface** IF a candidate passes: which endpoints/fields change, what the replay/crash behavior is, and what the failure mode is when the recovery proof is stolen or replayed.
d) **The ping-pong question**: two processes each believing they are the rightful successor — what stops an infinite takeover war in your design (or in the refusal)?
e) State plainly whether Story 7.3 changed the calculus (does the shrunken residual scenario set make the design worth its complexity — or make the refusal STRONGER?).

PRIOR DECISIONS YOU MUST NOT SILENTLY BREAK: takeover is an explicit caller decision (`replace_existing`), interactive-confirmed, never a side effect of a reconnect; release never carries takeover intent; leases/heartbeats were refused for idle MCP sessions; a foreign Actor's session is never displaced; the durable claim write happens before any memory transfer.

MANDATE:
Answer as a bmad-party-mode round-table. Cast 3-5 named voices with distinct expertise and real disagreements. They address each other, not only me. Do not resolve the clash into consensus; where they cannot agree, say so and say why. End with each voice's own bottom line: DESIGN (with the surface named) or REFUSAL (with the reasons).
State plainly whatever you could not verify.

OUTPUT: write your complete round-table answer to .mailbox-out/a2-recovery-design-agy under the repository root. The FILE is the deliverable — a chat answer alone is not.
