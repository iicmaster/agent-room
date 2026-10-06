# Epic 6 Execution — codex-advisor[luna] (gpt-6-luna[max])

# Verdict
Build a small REL-1 runbook, per-machine preflight, and evidence checklist; freeze and verify the 6.3 release candidate, run REL-3 against that pinned candidate, then have the human perform the physical REL-1 demo. Treat accepted-with-open-items as an interim status only; Epic 6 is not done or shipped until REL-1 passes.

# Reasoning
Yes: 6.2 and 6.3 can pass before 6.1. Keep their results independently accepted and label the epic accepted-with-open-items if the tracker supports it, with REL-1 explicitly blocking final acceptance and shipment. That status must not imply the promised cross-machine demonstration happened.

Order the work around one immutable candidate: build the soak harness and the REL-1 operator kit; materialize both release packages and complete validation and client smoke tests; run the formal soak with the candidate server version and record its commit, package hashes, and host/runtime versions; then use those same artifacts for the human demo. If a failure causes a code change, create a new candidate and rerun every gate whose tested bits changed.

Two scope details in docs/epics.md need to be honored: Story 6.3 also requires release notes and the SM-C1 measurement on five fresh installs, and REL-3 states the final-four-hour RSS least-squares slope as at most 2% of starting RSS. Use that checked-in criterion; “2%/s” in the question is not the documented threshold.

For 6.1, build a concise copy/paste runbook, one read-only preflight command to run on each client machine, and a no-secrets evidence manifest. Each preflight should verify the pinned client artifact, actual vendor installation, TLS/health reachability at the same non-loopback server origin, and compatible build metadata. A single command cannot truthfully certify an offline second machine, so collect and compare both reports. Do not build a distributed demo orchestrator: the named vendors, physical network path, live human/browser observation, and evidence capture are the proof. Local multi-process or browser automation is useful rehearsal, never REL-1 acceptance.

# The human's personal checklist
1. Put the laptop and desktop on the intended network; start the pinned self-hosted server and record its non-loopback HTTPS origin and candidate hash.
2. Run the preflight on both machines. Start real Claude Code on one and real Zcode on the other, using distinct enrolled identities and that same server origin.
3. Open the authenticated viewer in a real browser and begin the recording and transcript capture. Keep credentials and viewer tokens out of evidence.
4. Have the two real sessions exchange a live DM in both directions, then exchange messages in the Broadcast Room.
5. While the demo is live, observe presence updates and broadcast freshness within 5 seconds; confirm no DM content appears in the viewer.
6. Save the transcript, recording, browser-session evidence, both preflight reports, timestamps, machine/client/server versions, and candidate hashes. Mark REL-1 passed only if all required observations and artifacts are present.

TEAM_DONE epic-6-execution-luna
