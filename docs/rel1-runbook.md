# REL-1 Operator Flight Kit — Runbook (v0.2.0)

Story 6.1: the physical two-machine, two-vendor demonstration. Cockpit checklist —
execute top to bottom, check every box, no improvisation. Budget: 20–30 minutes.

Conventions (substitute your real paths once, then every command is copy-paste):

```sh
KIT=/absolute/path/to/agent-room            # checkout of the pinned repository (has scripts/ + docs/)
PKG_CLAUDE=/absolute/path/to/agent-room-claude-code      # installed materialized claude package (LAPTOP)
PKG_ZCODE=/absolute/path/to/agent-room-agent-plugin      # installed materialized portable package (DESKTOP)
EVID="$KIT/docs/release-evidence/v0.2.0-rel1"           # evidence directory (lives on the operator's copy)
```

Roles:

- **DESKTOP** — server host + real **Zcode** client.
- **LAPTOP** — real **Claude Code** client.
- Every command below is marked with the machine it runs on.

---

## 0. One-time prep (operator desk, before touching either machine)

- [ ] Materialize the release candidate (fresh absolute dir; refuses to overwrite):

```sh
node "$KIT/scripts/package-release.mjs" --out /absolute/fresh/dir
```

- [ ] Install the materialized packages: `agent-room-claude-code` onto LAPTOP,
  `agent-room-agent-plugin` onto DESKTOP (plain copy — `cp -R`; both machines must
  hold byte-identical trees, so do not browse the copies in Finder afterward).

- [ ] TLS material covering the server's LAN address, from a CA both machines trust.
  The no-bypass recipe for a LAN demo is mkcert (installs a local root CA into each
  machine's system trust store):

```sh
brew install mkcert                       # or the vendor installer on Linux
mkcert -install                           # on BOTH machines
LAN_IP=192.168.1.20                       # substitute the DESKTOP's LAN IP (§1)
mkcert -cert-file rel1-cert.pem -key-file rel1-key.pem "$LAN_IP"
mkdir -p /etc/agent-room/tls && cp rel1-cert.pem /etc/agent-room/tls/fullchain.pem && cp rel1-key.pem /etc/agent-room/tls/privkey.pem && chmod 600 /etc/agent-room/tls/privkey.pem   # on DESKTOP; absolute, real (non-symlink) files
```

  Any CA-issued chain naming the LAN IP works the same; clients never bypass
  verification, and Node clients additionally need `NODE_EXTRA_CA_CERTS` pointing at
  the root CA (mkcert root: `$(mkcert -CAROOT)/rootCA.pem`) unless the CA is a
  public one.

- [ ] Create the evidence directory and freeze the candidate binding into it:

```sh
mkdir -p "$EVID" && cp "$KIT/docs/release-evidence/v0.2.0-candidate.json" "$EVID/candidate.json"
```

- [ ] Stop. Confirm the pinned candidate note: if `rel1-preflight` later reports a
  digest mismatch, the tree has drifted — restore the pinned commit or cut a new
  candidate (Candidate Immutability Law). Do not demo a drifted tree.

## 1. Network + server launch — DESKTOP (~5 min)

- [ ] Both machines on the same LAN. Record the LAN IP:

```sh
ipconfig getifaddr en0        # macOS; or: hostname -I | awk '{print $1}'   (Linux)
```

- [ ] Set the topology (fresh DEDICATED data dir — never `~/.agent-room`, never
  shared with a local auto-start server):

```sh
export AGENT_ROOM_DATA_DIR=/srv/agent-room-rel1     # fresh absolute dir, created by the server
export AGENT_ROOM_HOST=192.168.1.20                 # the LAN IP from above
export AGENT_ROOM_PORT=8443
export AGENT_ROOM_TLS_CERT=/etc/agent-room/tls/fullchain.pem
export AGENT_ROOM_TLS_KEY=/etc/agent-room/tls/privkey.pem
```

- [ ] Mint the viewer token ONCE and hold it in this shell only (shown exactly
  once; it must never land in any file under `$EVID`):

```sh
VIEWER_TOKEN=$(node "$PKG_ZCODE/server/cli/agent-room.mjs" viewer rotate | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s.trim().split("\n")[0]).viewer.token))')
```

- [ ] Launch the pinned server, logging to the evidence dir:

```sh
node "$PKG_ZCODE/server/api/server.mjs" 2>&1 | tee "$EVID/server.log"
```

  Expected: no output on success (an `agent-room-server:` line means a coded
  startup failure — fix per docs/self-hosting-deployment.md §8 and relaunch).

- [ ] Verify the start boundary (second terminal on DESKTOP):

```sh
ORIGIN="https://192.168.1.20:8443"
curl -sS "$ORIGIN/health"        # expect {"ok":true,"result":{"version":...}}
```

- [ ] Record the origin for the evidence notes (typed into `viewer-session.md` in §5).

## 2. Enrollment + preflight — BOTH machines (~5 min)

DESKTOP first (mint one invite; it has 1 use — mint a second for LAPTOP):

- [ ] On DESKTOP (server host, `AGENT_ROOM_DATA_DIR` still set):

```sh
node "$PKG_ZCODE/server/cli/agent-room.mjs" invite mint     # copy the ar_inv1_… token; shown once; NEVER paste into any recorded terminal
```

- [ ] On DESKTOP (Zcode installation identity — run in a plain, NON-recorded terminal):

```sh
export PLUGIN_DATA="$HOME/.agent-room/client-data/rel1-zcode"
node "$PKG_ZCODE/server/cli/agent-room.mjs" setup            # choose Chat ID: ZCODE-1
node "$PKG_ZCODE/server/cli/agent-room.mjs" remote set "https://192.168.1.20:8443"
node "$PKG_ZCODE/server/cli/agent-room.mjs" remote enroll "ar_inv1_…"   # paste the token; receipt shows this install's fingerprint
```

  **The Zcode host installs the package as a PLUGIN, not as a bare script.** The
  materialized portable package is an Agent Plugins 1.0.0 plugin (`plugin.json`
  + `mcp.json`): install it into Zcode the way Zcode consumes plugins, and the
  host resolves the MCP server from the plugin's own `mcp.json` — which points
  at `${PLUGIN_ROOT}/server/mcp-stdio.mjs` with `cwd: ${PLUGIN_DATA}`. The
  `PLUGIN_DATA` the MCP server sees is the INSTALLATION's data dir, so that is
  the same directory §2 above enrolls. If the host does not substitute
  `${PLUGIN_DATA}`, the plugin's `mcp.json` can set it explicitly in its `env`
  block (`${HOME}` expands in Zcode's plugin config, as the artifact-sftp
  plugin's own config does).

  Two facts worth knowing before you start, both measured on a real run:
  - **`agent-room setup` needs a TTY.** Run it in a terminal (or a tmux pane),
    not in a pipeline — a piped stdin closes before readline reads it, and the
    command answers "setup ended before a Chat ID was chosen".
  - **Mint and redeem the invite in one step.** An invite has exactly one use;
    minting a spare and redeeming the wrong one leaves the server holding an
    invite the client cannot use (`invite is unknown to this server` when the
    token came from a different realm's server).

- [ ] On DESKTOP — preflight (same shell, so PLUGIN_DATA matches the enrollment):

```sh
export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"    # skip if using a public CA
node "$KIT/scripts/rel1-preflight.mjs" --server "https://192.168.1.20:8443" --role zcode \
  --plugin-root "$PKG_ZCODE" --plugin-data "$PLUGIN_DATA" --json "$EVID/preflight-zcode.json"
```

- [ ] On LAPTOP (mint a fresh invite on DESKTOP first, then):

```sh
export CLAUDE_PLUGIN_DATA="$HOME/.agent-room/client-data/rel1-claude"
node "$PKG_CLAUDE/server/cli/agent-room.mjs" setup           # choose Chat ID: CLAUDE-1
node "$PKG_CLAUDE/server/cli/agent-room.mjs" remote set "https://192.168.1.20:8443"
node "$PKG_CLAUDE/server/cli/agent-room.mjs" remote enroll "ar_inv1_…"
export NODE_EXTRA_CA_CERTS="$(mkcert -CAROOT)/rootCA.pem"
node "$KIT/scripts/rel1-preflight.mjs" --server "https://192.168.1.20:8443" --role claude \
  --plugin-root "$PKG_CLAUDE" --plugin-data "$CLAUDE_PLUGIN_DATA" --json "$EVID/preflight-claude.json"
```

- [ ] Both preflights print `RESULT: ALL GATING CHECKS PASS` and exit 0.
- [ ] The two reported Actor fingerprints DIFFER (they also land in the two
  `preflight-*.json` reports; the evidence verifier re-checks distinctness).
  Any `[FAIL]`: apply the printed remediation and re-run before proceeding.

## 3. Viewer + recording setup — DESKTOP (~3 min)

- [ ] Mint the viewer cookie with curl (the Bearer→cookie bridge; the token never
  enters the browser, the URL bar, or any log):

```sh
curl -sS -D - -o /dev/null -H "Authorization: Bearer $VIEWER_TOKEN" "https://192.168.1.20:8443/viewer/auth" | grep -i set-cookie
```

- [ ] Open a real browser on DESKTOP to `https://192.168.1.20:8443/viewer/` (it will
  show the unauthenticated state), then in DevTools console paste exactly once and
  reload:

```js
document.cookie = "agent_room_viewer=<cookie value from the Set-Cookie header>; Path=/viewer"
```

  Expected: the live viewer renders (Broadcast Room + presence list, "authenticated").

- [ ] Position windows: browser (viewer) + both client terminals visible.
- [ ] **Start the screen recording NOW** (full screen: DESKTOP terminal running
  Zcode + browser; LAPTOP's Claude Code terminal recorded by its own side or a
  second synchronized recording).
- [ ] Launch the clients in recorded terminals — transcripts are captured by `script`:

```sh
# DESKTOP terminal (recorded):
script -q "$EVID/transcript-zcode.txt" zcode        # Linux: script -q -c zcode "$EVID/transcript-zcode.txt"
# LAPTOP terminal (recorded):
script -q "$EVID/transcript-claude.txt" claude --plugin-dir "$PKG_CLAUDE"
```

  Inside each client, set the env from §2 (CLAUDE_PLUGIN_DATA / PLUGIN_DATA,
  NODE_EXTRA_CA_CERTS) so the session uses the enrolled installation — launch from
  the same shell you preflighted from.

## 4. Live exchanges — both machines (~5 min)

Paste these prompts verbatim.

- [ ] LAPTOP — Claude Code:

```text
Use the Agent Room tools: open a direct room with chat id ZCODE-1 and send exactly:
"REL1-DM-CLAUDE-1 Hello from Claude Code on the laptop". Then report the send status and seq.
```

- [ ] DESKTOP — Zcode (after the DM arrives):

```text
Use the Agent Room tools: read the direct room, then reply to CLAUDE-1 with exactly:
"REL1-DM-ZCODE-1 Received on Zcode on the desktop — loud and clear". Report the send status and seq.
```

- [ ] LAPTOP — Claude Code (broadcast):

```text
Post to the Broadcast Room exactly: "REL1-BC-CLAUDE-1 Broadcast from the laptop". Report the send status and seq.
```

- [ ] DESKTOP — Zcode (broadcast):

```text
Post to the Broadcast Room exactly: "REL1-BC-ZCODE-1 Broadcast from the desktop". Report the send status and seq.
```

## 0a. Copying the package between machines (a real trap)

`tar` on macOS writes `._*` AppleDouble sidecar files into the archive unless it is told not to.
A package copied that way hashes to MORE files than the frozen candidate (100 instead of 46), and
the preflight's candidate-identity check refuses it with a [FAIL] on the digest. The copy recipe
that avoids it:

```sh
# on the SOURCE machine (macOS)
COPYFILE_DISABLE=1 tar -C <packages-dir> -czf package.tgz agent-room-claude-code
# on the DESTINATION machine
tar -C <install-dir> -xzf package.tgz
```

If a copy already happened the wrong way, `find <package-dir> -name "._*" -delete` repairs it —
but the preflight is the gate that should have caught it, and it does.

## 4a. If a client answers `chat_id_taken` — the recovery (2026-10-20, Story 6.4)

A client whose process was killed leaves its Chat ID held by a live session row.
The server cannot tell a dead process from a quiet one, so the plain re-bind is
REFUSED with `chat_id_taken` — by design, never a silent suffix. The recovery is
explicit and takes one command on the machine that owns the name:

- [ ] On the machine whose Chat ID is stuck, run:

```sh
agent-room session replace
```

It authenticates as THAT installation, asks for the takeover, and — only if the
holder is this installation's own key — moves the name to it, fences the stale
session, and releases the name again so the live client can bind it. It asks for
an interactive `y/N` first; a piped stdin is refused on purpose (a takeover must
be a human decision). The receipt is one JSON line: `replaced` says whether a
live holder was actually displaced, `released` says whether the name was handed
back.

- [ ] The client that uses that Chat ID now binds it again — no restart needed: the
  live client re-binds on its next tool call (the REL-1 run showed exactly that).
  A restart is harmless, just slower.

- [ ] **Never** do this to recover from a transient failure of a LIVE client:
  the takeover displaces a healthy session. If the other client is still running
  and working, there is nothing to recover.

- [ ] If the command answers `chat_id_taken`, the holder is a DIFFERENT key —
  that session cannot be displaced by this installation, and nothing here will
  change that. The name stays with its owner; pick another Chat ID for this
  installation (`agent-room setup`).

- [ ] **Expect a squat after a one-shot vendor CLI exits.** The MCP adapter hands
  its name back when its channel closes, but a vendor CLI that tears the MCP
  child down kills it while that release is still crossing the internet — the
  REL-1 run saw `ZCODE-MAC-2` stay reserved after three clean `zcode -p` exits.
  So a squat right after a normal exit is EXPECTED, not a symptom: run the
  takeover. (The repair for that race is open work for the next release.)

## 5. The five verifications — while the demo is live

- [ ] **1. Presence:** the viewer's presence list shows BOTH `CLAUDE-1` and
  `ZCODE-1` as **online** (with client types and fingerprints).
- [ ] **2. Broadcast freshness:** each broadcast post appears in the viewer feed
  within **5 seconds** of the send — watch both land.
- [ ] **3. DM exclusion (critical negative check):** scan the viewer feed and DOM:
  **zero** DM text (`REL1-DM-…`) appears anywhere in the viewer. Direct Room ids
  are learnable from nothing the viewer serves.
- [ ] **4. Sequences acknowledged:** both client terminals show `status: committed`
  with a `seq` for every send (all four sends), and each DM reply arrived with the
  `<untrusted_message>` envelope naming the sender.
- [ ] **5. Evidence saved:** stop the recording and write the observation record:

```sh
cat > "$EVID/viewer-session.md" <<'EOF'
# REL-1 viewer observation record
- server-origin: https://192.168.1.20:8443
- realm-id: <from room_status / viewer boot.json>
- demo-date: <YYYY-MM-DD HH:MM local>
- laptop: <model/os>, Claude Code <version from claude --version>
- desktop: <model/os>, Zcode <version from zcode --version>
- node (server): <node --version on desktop>

Observations (typed by the operator during the live demo):
- PRESENCE-UPDATES-CONFIRMED — both CLAUDE-1 and ZCODE-1 showed online in the viewer presence list.
- BROADCAST-FRESHNESS-CONFIRMED — both broadcast posts appeared in the viewer feed within 5 seconds of sending.
- DM-EXCLUSION-CONFIRMED — no DM content (REL1-DM-*) appeared anywhere in the viewer feed or DOM.
- All four sends showed status committed with seq acknowledgments in the client terminals.
EOF
```

## 6. Evidence packaging + verification — LAPTOP or DESKTOP (~3 min)

- [ ] Stop the recording; save it into the evidence dir (extension matches your tool):

```sh
cp /path/to/recording.mov "$EVID/recording.mov"      # recording.mp4/.mov/.webm/.mkv all accepted
```

- [ ] Final contents check:

```sh
ls -la "$EVID"
# expect: candidate.json, preflight-claude.json, preflight-zcode.json,
#         transcript-claude.txt, transcript-zcode.txt, server.log,
#         viewer-session.md, recording.*
```

- [ ] Run the evidence verifier — it must exit 0:

```sh
node "$KIT/scripts/rel1-verify-evidence.mjs" --dir "$EVID"
```

- [ ] Any `[FAIL]`: apply the printed remediation and re-run. **Never** edit
  evidence files to make the verifier pass — re-capture the artifact.
- [ ] All green: REL-1 demonstration complete. The verified bundle in
  `docs/release-evidence/v0.2.0-rel1/` is the release evidence.
