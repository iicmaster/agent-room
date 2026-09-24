# PRD Quality Review — Agent Room v0.2 (prd-agent-room-2026-09-20)

Reviewed against `bmad-prd/assets/prd-validation-checklist.md`. Inputs: `prd.md` + `addendum.md`. Calibration: solo-builder developer product (MCP plugin + self-hostable server), chain-top (feeds architecture → epics/stories), draft in `create` intent, finalize phase.

## Overall verdict

This is a coherent, unusually honest PRD: an explicit thesis (local-first durable-log chat; cross-machine/cross-vendor as the killing feature but not the default), disciplined IDs and glossary anchoring, real trade-offs recorded in the addendum, and FRs that almost uniformly carry testable consequences. The one structural defect: the PRD references an NFR section four times (NFR-1, NFR-2, NFR-4, NFR-6) that does not exist anywhere in the document — leaving FR-13's resource budget formally undefined and the glossary's Gate definition pointing at nothing. Fix that, define the "same-machine" semantics FR-10's default policy depends on, and sweep the mechanical drift; nothing else blocks the gate to architecture.

## Decision-readiness — strong

Decisions are stated as decisions, not smoothed to neutral. §1 Vision commits: "Cross-machine, cross-client conversation is the killing feature, but not the default: v0.2 stays local-first." §5 Non-Goals takes stances that could be contested and defends each in one line ("No E2E encryption or encryption at rest in v0.2 — plain text at rest, stated openly"). The IRC-style realm model, append-only-forever log, and invite-only governance are all committed, with the trade-offs — including what was given up — recorded in addendum §2 (single global server rejected as "simpler v0" but a SPOF; push delivery rejected as "impossible from a plugin," the wake gap accepted and documented as a non-goal).

The seven Open Questions (§8) are genuinely open, not rhetorical: each carries a working default so downstream is not blocked ("additive-only assumed," "keep-all assumed for v0.2," "assumed values in FR-5/FR-16"), and the two that matter most for architecture (TLS termination, wire protocol versioning) are explicitly delegated rather than dodged. The single `[NOTE FOR PM]` (§6.2, log retention/size caps before OSS launch) sits at a real tension — keep-all vs long-lived public realms — which is exactly where a note should be. For a solo-builder PRD, one PM note at one genuine tension is the right density; the PM-to-self channel is inherently less load-bearing here.

No red flag of "everything balances": the PRD names an accepted gap (idle-session wake), an inherited weakness (plaintext at rest), and a counter-metric that exists to make the headline feature harder, not easier (SM-C1 guards Local Mode friction against the networked milestone SM-1).

### Findings

(none)

## Substance over theater — strong

No personas, and none needed — the target user is the builder, and §2.1's four JTBDs are concrete and prioritized ("stop being the message router" as primary, every day). No NFR boilerplate appears — notably because no NFR section appears at all (see Done-ness; that is an absence problem, not a theater problem). The Vision is not swappable: "the human becomes a copy-paste router between tabs" and "'offline' does not exist — only 'not yet read'" could only belong to this product.

The differentiation claims are earned, not template furniture: §1's positioning ("the open, vendor-neutral rooms layer nobody occupies") and the addendum's "The IRC to their iMessage" one-liner trace to the research digest, which is present in the doc folder (`research-landscape-2026-09-20.md`) with specific competitive reads (Claude Code as proprietary pairwise DMs, A2A as delegation, SAM as tool mesh). The UJs earn their place: four journeys, each realization-linked to FRs, each carrying an edge case that is a real failure mode (UJ-2's VPS reboot, UJ-3's sleep-and-return), not narrative decoration.

### Findings

(none)

## Strategic coherence — strong

The thesis is explicit and the feature set follows it rather than a wishlist. Local-first default (FR-1, D9) protects the default path; presence is correctly identified as "the genuinely new capability" (D3) and gets its own FR; gates ship on day one (D7) because "'personal tool' ends the day the first friend asks for an invite"; continuity is promoted to a named success dimension (D10) with two dedicated SMs rather than left as an emergent property. §6.1's prioritization order matches the thesis — zero-config parity first, networked opt-in second, deferred items (notifier, server directory) explicitly labeled growth features.

Success Metrics validate the thesis rather than measure activity: SM-1 is the cross-everything milestone (two machines, two vendors, one self-hosted server), SM-2/SM-3 test the durability claim the whole delivery model rests on, and counter-metrics are present and load-bearing — SM-C1 ("networked features must never tax the default path") is a genuine counterweight to SM-1, SM-C2 refuses to optimize for scale v0.2 does not have. This is the metric structure the rubric asks for and rarely gets.

Scope kind is coherent: a problem-solving personal tool built platform-ready (D8's "nothing breaks unfixably if 1,000 strangers show up"), and the scope logic — invite-only governance, no federation, no open registration — matches that posture exactly.

### Findings

- **low** SM-4 has no instrument (§7) — "Builder uses it weekly in real work and does not abandon it (the solo-tool bar)" is the right metric for this product but as written is unfalsifiable and will not survive into stories. *Fix:* define the bar minimally, e.g. "no calendar month in the first quarter with zero sends from the builder's own Actors," or accept it as a directional signal and say so.

## Done-ness clarity — adequate

The PRD's structure bakes done-ness in: every FR carries a "Consequences (testable)" block, and most are genuinely crisp — FR-11's "Messages acknowledged before a kill -9 of the Server are readable after restart," FR-8's "gap-free, strictly ordered suffix" and "never exceeds 20 seconds," FR-6's preserved idempotency semantics, FR-1's "No network interface beyond loopback is bound in Local Mode." An engineer can write acceptance criteria from most of these directly. There is no "handles X gracefully" or "user-friendly" residue anywhere.

The dimension is dragged from strong to adequate by one structural hole and two soft bounds. The structural hole: FR-13's soak consequence promises "exact budget in NFR-6" — and there is no NFR-6, no NFR section at all. "Bounded memory" with no ceiling is exactly the boundless adjective the rubric says to be unforgiving about, made worse because the PRD acknowledges the bound is needed and points somewhere that does not exist. The same phantom section is asked to carry the zero-dependency constraint (FR-4's "see NFR-1") and the two-lane Gate model (glossary's "See NFR-4"), whose actual content lives in addendum §3.1 — a table the addendum itself declares "not part of the PRD's requirement surface."

Second, FR-10's default policy — hold-until-approved "for all senders other than the installation's own Actors on the same machine" — depends on a same-machine attribution that nothing in the PRD defines or assigns ownership of. No glossary term, no mechanism, and §8's Open Question 6 asks about allowlist granularity (per-Server vs global) but not about how same-machineness is ever known in Remote Mode, where a stranger's server cannot trivially tell which sessions share your laptop. The safest fallback (hold everything) is well-defined; the stated default is not.

### Findings

- **critical** Referenced NFR section does not exist (§4.4 FR-13; also §4.1 FR-4, §6.1, §3 Glossary) — Four dangling references (NFR-1, NFR-2, NFR-4, NFR-6) point at a section absent from the document. FR-13's "bounded memory" budget is thereby undefined, so done-ness for the endurance FR — a first-class success dimension per D10 — cannot be evaluated; the Gate lane model the glossary defers to (NFR-4) exists only in addendum §3.1, outside the requirement surface. The referenced-only numbering (1, 2, 4, 6 — never 3 or 5) indicates a drafted section was dropped. *Fix:* add the NFR section — NFR-1 zero external runtime dependencies, NFR-2 Agent Plugins 1.0.0 conformance + `claude plugin validate --strict` as release gate (per D11), NFR-4 the two-lane guarantee table promoted from addendum §3.1 into the requirement surface, NFR-6 soak resource ceilings (memory, FD/connection bounds) — or re-point every reference to where the constraint actually lives.
- **medium** "Same-machine" attribution undefined for FR-10's default (§4.3 FR-10, §8 OQ-6) — The default trust posture ("hold-until-approved for all senders other than the installation's own Actors on the same machine") requires someone — Server or client — to know which Actors share a machine; no term, mechanism, or owner is defined, and Remote Mode makes this non-trivial. *Fix:* either define the mechanism direction (e.g., client-side allowlist seeded from Local Mode handles vs server-side machine tagging at enrollment) or fold it explicitly into OQ-6 so architecture owns it knowingly.
- **low** FR-18 "update live" has no bound (§4.6 FR-18) — "watch the Broadcast Room and presence list update live" is unbounded; a viewer that refreshes every 60s would pass as written. *Fix:* state a liveness bound (e.g., a new message is visible in the viewer within N seconds of commit, without manual refresh).
- **low** FR-5's second presence state is unbounded (§4.2 FR-5) — "The list distinguishes 'online now' from 'enrolled but not seen recently'" — "recently" has no threshold; online is defined via the 3× heartbeat TTL, "seen recently" is not. *Fix:* give the second state a boundary (e.g., heartbeat within the last N hours = "seen," otherwise enrolled-only) or fold into FR-5's existing tunable-values assumption.

## Scope honesty — strong

Omissions are explicit, not inferred. §5 delivers seven Non-Goals each with a rationale that names the territory given up ("that is A2A's and SAM's territory; Agent Room carries conversation, not jobs"); §6.2 lists five MVP exclusions with deferral destinations (notifier, server directory to v0.3+). The most tempting silent omission — encryption — is instead stated twice, openly, with the trust boundary named ("the trust boundary is enrollment + transport"). The addendum extends the honesty to the v0.1 relationship: "architecturally a near-rebuild, product-wise a continuation," accepted by the builder in his own words.

Assumption discipline is good where present: six inline `[ASSUMPTION]` tags, each at a real inference (TLS ownership, heartbeat defaults, viewer invisibility of DMs, hold policy, soak targets, rate limit), each with a sane default. Open-items density — 7 OQs + 6 assumptions + 1 PM note = 14 — would be a blocker on many green-light PRDs, but here every item is parameter-level (defaults, naming, formats) with a working default attached, and the two architectural ones are deliberate handoffs. None blocks architecture from starting; none hides a product decision. For these stakes, that is the right density.

### Findings

(none)

## Downstream usability — adequate

The extraction mechanics are mostly excellent for a chain-top PRD: FR-1–FR-18 and UJ-1–UJ-4 are contiguous and unique; every FR's "Realizes UJ-x" link resolves and all four UJs are covered in both directions; SM validation lists resolve (SM-1's "FR-4–FR-8" is exactly 4,5,6,7,8); §0 declares the vocabulary anchoring ("Vocabulary is anchored in §3 Glossary; FRs are globally numbered"). Sections largely stand alone via glossary terms rather than "see above," and both referenced inputs (`addendum.md`, `research-landscape-2026-09-20.md`) exist in the doc folder.

Two things prevent clean sourcing. First, the phantom NFR references: worst is the glossary Gate entry ending "See NFR-4" — a definitional anchor in the section architecture will lean on hardest, pointing at nothing. An architect source-extracting the Gate model gets a broken link where the requirement surface should be. Second, two load-bearing nouns are used but never glossed: **Realm** (Vision "invite-only realms," UJ-4 "keeps the realm clean," §4.5 "an invite-only realm with ban" — defined only obliquely inside the Room Server entry as "one server = one realm/community") and **Allowlist** (FR-10's entire default policy, OQ-6, "allowlist a Handle through the plugin in one step"). Allowlist is also entangled with the undefined "same-machine" semantics flagged under Done-ness.

### Findings

- **high** Dangling NFR references break source extraction (§3 Glossary line "See NFR-4"; §4.1 FR-4 "see NFR-1"; §4.4 FR-13 "exact budget in NFR-6"; §6.1 "(NFR-2)") — Same root cause as the critical Done-ness finding, but the downstream impact is distinct: any workflow that resolves cross-references mechanically will fail on four links, and the glossary — the vocabulary contract for architecture — is itself an offender. *Fix:* resolve via the restored NFR section (see Done-ness critical), or minimally re-point the glossary Gate entry at FR-9/FR-10/§4.5 and the others at their real homes.
- **medium** Unglossed load-bearing nouns: Realm and Allowlist (§3 Glossary) — Both carry requirement semantics (governance scope; default trust policy) but have no glossary entries, inviting drift the moment architecture and stories start paraphrasing them. *Fix:* add glossary entries for Realm (= the community of one Server) and Allowlist (per-Session or per-Server list of Handles whose messages bypass the hold gate — decide which, since OQ-6 leaves it open and the definition shouldn't).

## Shape fit — strong

The full consumer-grade shape (Vision, JTBD, UJs, FR-consequences, Non-Goals, SMs with counter-metrics, OQs, assumptions index) would be over-formalized for a standalone solo tool — but this PRD is chain-top and says so in §0, so the weight is carried by purpose: the Consequences blocks become story acceptance criteria, the glossary becomes architecture's vocabulary, and the four UJs are few and load-bearing rather than furniture (UJ-1 is even self-annotated "*(Lighter scope: restates the core JTBD.)*" — the PRD polices its own theater).

Brownfield handling is accurate where it makes v0.1 claims: idempotent duplicate-`client_message_id` semantics, `after_seq` cursor pagination bounded 1–200, GET-only token-authenticated viewer, SQLite STRICT/WAL, the plugin-data identity slot — all match the v0.1 codebase, and addendum §5's preserved-semantics list is explicit about what a "near-rebuild" keeps. The near-rebuild framing itself is honest scope communication, not scope smoothing. UJ protagonists are role-named ("Builder") rather than person-named; for a single-operator product whose reader is the builder, that is correct, and the journeys carry their context inline.

### Findings

(none)

## Mechanical notes

- **Broken cross-references (the big one):** NFR-1, NFR-2, NFR-4, NFR-6 referenced (prd.md lines 109, 281, 67, 207) with no NFR section in the document; referenced numbering skips 3 and 5, suggesting a drafted section of at least six items was dropped. Detailed under Done-ness (critical) and Downstream usability (high).
- **Assumptions Index roundtrip:** 7 index entries vs 6 inline `[ASSUMPTION]` tags. The §6.2 "keep-all log retention for v0.2" index entry has no inline tag — the assumption is only voiced in OQ-4 ("keep-all assumed for v0.2") and the §6.2 `[NOTE FOR PM]`. Add the inline tag at §6.2 or drop the index entry.
- **Glossary drift:** "ZCode" (§2.1) vs "Zcode" (UJ-1, UJ-2) — pick one. "Realm" and "Allowlist" used load-bearingly without glossary entries (see Downstream usability medium). "Room Server (or Server)" alias is declared in the glossary, so that abbreviation is fine.
- **ID continuity:** FR-1–18, UJ-1–4, SM-1–4, SM-C1–C2 all contiguous and unique; all Realizes links and SM validation lists resolve. No duplicates or gaps.
- **Referenced inputs present:** `addendum.md` and `research-landscape-2026-09-20.md` both exist alongside `prd.md` in the doc folder. §0's input list is accurate.
- **Required sections for stakes:** present and populated for a chain-top developer-product PRD (Purpose, Vision, Target User, Glossary, Features with testable consequences, Non-Goals, MVP scope with Out-of-Scope, SMs with counter-metrics, Open Questions, Assumptions Index) — except the NFR section its own text relies on.
