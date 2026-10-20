#!/usr/bin/env bash
# The three-vendor interoperability lab (single machine).
#
# Story 6.1's REL-1 is the PHYSICAL two-machine, two-vendor demonstration — it cannot be
# simulated, and this script does not simulate it. What this script DOES is exercise the
# plugin's MCP surface against three INDEPENDENT real agent hosts on one machine:
# Claude Code, Codex, and Gemini (agy). It is the run behind
# docs/release-evidence/v0.2.0-three-vendor/.
#
# The seam it proves: one agent-room realm, three client installations with distinct
# Chat IDs and distinct Ed25519 keypairs (D13 — identity binds keys, never names), each
# vendor reaching the plugin over its own MCP client, messages crossing vendor
# boundaries with the untrusted envelope intact, and DMs staying out of the broadcast
# room.
#
# Usage:
#   scripts/three-vendor-lab.sh [--keep]
#
# `--keep` retains the lab world (default) so the room state can be read back; pass
# nothing to keep it. The lab writes only under $LAB (default .vendor-lab/) and never
# touches the operator's global MCP registries: claude gets a --mcp-config file, codex
# gets a private CODEX_HOME, agy gets a private HOME with symlinked credentials.
#
# The lab needs: node >= 24, tmux, and the three CLIs on PATH (claude, codex, agy).
# It materializes the release candidate first, so the artifact under test is the same
# bytes the soak and the release gate pinned.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAB="${AGENT_ROOM_LAB_DIR:-$REPO_ROOT/.vendor-lab}"
PKG_PORTABLE="$LAB/pkg/agent-room-agent-plugin"
PKG_CLAUDE="$LAB/pkg/agent-room-claude-code"
SERVER_PORT="${AGENT_ROOM_LAB_PORT:-57311}"
SESSION="agent-room-3vendor"

KEEP=0
for arg in "$@"; do
  case "$arg" in
    --keep) KEEP=1 ;;
    *) echo "usage: $0 [--keep]" >&2; exit 2 ;;
  esac
done

say() { printf '\n\033[1m== %s\033[0m\n' "$*"; }
die() { printf '\033[31mfail: %s\033[0m\n' "$*" >&2; exit 1; }

command -v tmux >/dev/null || die "tmux is required"
for cli in claude codex agy; do
  command -v "$cli" >/dev/null || die "$cli is not on PATH"
done

say "materializing the release candidate (the bytes under test)"
rm -rf "$LAB/pkg"
mkdir -p "$LAB/pkg"
node "$REPO_ROOT/scripts/package-release.mjs" --out "$LAB/pkg" >/dev/null
[ -d "$PKG_CLAUDE" ] || die "the claude-code package did not materialize"
[ -d "$PKG_PORTABLE" ] || die "the portable package did not materialize"

say "preparing isolated client installations (one realm, three identities)"
mkdir -p "$LAB/shared" "$LAB/claude" "$LAB/codex" "$LAB/agy" "$LAB/cfg" "$LAB/evidence"
chmod 700 "$LAB" "$LAB/shared" "$LAB/claude" "$LAB/codex" "$LAB/agy"

# The one-time Chat ID choice runs the REAL `agent-room setup` command, which needs a
# TTY — that is why this whole lab is driven through tmux.
setup_client() {
  local slot="$1" chat_id="$2" session="$SESSION-setup-$1"
  tmux kill-session -t "$session" 2>/dev/null || true
  tmux new-session -d -s "$session" -c "$LAB" -x 200 -y 50
  sleep 1
  tmux send-keys -t "$session" \
    "cd '$LAB' && PLUGIN_DATA='$LAB/$slot' AGENT_ROOM_DATA_DIR='$LAB/shared' node '$PKG_CLAUDE/server/cli/agent-room.mjs' setup" Enter
  sleep 6
  tmux send-keys -t "$session" "$chat_id" Enter
  sleep 5
  tmux kill-session -t "$session" 2>/dev/null || true
  [ -f "$LAB/$slot/config.json" ] || die "$slot setup did not write a config"
}

setup_client claude CLAUDE-TMUX
setup_client codex  CODEX-TMUX
setup_client agy    AGY-TMUX

say "starting the realm server on a pinned port ($SERVER_PORT)"
rm -f "$LAB/shared/runtime.json"
AGENT_ROOM_DATA_DIR="$LAB/shared" AGENT_ROOM_PORT="$SERVER_PORT" \
  nohup node "$PKG_CLAUDE/server/api/server.mjs" >"$LAB/shared/server.log" 2>&1 &
sleep 4
[ -f "$LAB/shared/runtime.json" ] || die "the realm server did not publish a runtime record"

say "wiring each vendor's MCP client to the plugin"
write_mcp() {
  local slot="$1" out="$2"
  cat >"$out" <<JSON
{
  "mcpServers": {
    "agent-room": {
      "type": "stdio",
      "command": "node",
      "args": ["$PKG_CLAUDE/server/mcp-stdio.mjs"],
      "cwd": "$LAB/$slot",
      "env": { "PLUGIN_DATA": "$LAB/$slot", "AGENT_ROOM_DATA_DIR": "$LAB/shared" }
    }
  }
}
JSON
}
write_mcp claude "$LAB/cfg/claude-mcp.json"
write_mcp codex  "$LAB/cfg/codex-mcp.json"
write_mcp agy    "$LAB/cfg/agy-mcp.json"

# codex: a private CODEX_HOME so the operator's ~/.codex/config.toml is never touched.
# The auth file is symlinked, not copied — the credential stays where it is.
mkdir -p "$LAB/codex-home"
ln -sf "$HOME/.codex/auth.json" "$LAB/codex-home/auth.json"
cat >"$LAB/codex-home/config.toml" <<TOML
[mcp_servers.agent-room]
command = "node"
args = ["$PKG_CLAUDE/server/mcp-stdio.mjs"]
env = { PLUGIN_DATA = "$LAB/codex", AGENT_ROOM_DATA_DIR = "$LAB/shared" }
TOML

# agy: a private HOME, so the operator's ~/.gemini MCP registry is untouched. Every
# ~/.gemini entry except config/ and plugins/ is symlinked; config/ is ours.
mkdir -p "$LAB/agy-home/.gemini/config"
for entry in "$HOME"/.gemini/*; do
  base="$(basename "$entry")"
  case "$base" in config|plugins) continue ;; esac
  ln -sfn "$entry" "$LAB/agy-home/.gemini/$base"
done
cp "$LAB/cfg/agy-mcp.json" "$LAB/agy-home/.gemini/config/mcp_config.json"

say "starting the three vendors in tmux windows"
tmux kill-session -t "$SESSION" 2>/dev/null || true
tmux new-session -d -s "$SESSION" -c "$LAB" -x 220 -y 55
tmux new-window -t "$SESSION" -n codex
tmux new-window -t "$SESSION" -n agy
tmux rename-window -t "$SESSION":0 claude
tmux rename-window -t "$SESSION":1 codex

tmux select-window -t "$SESSION":claude
tmux send-keys -t "$SESSION":claude \
  "claude --mcp-config '$LAB/cfg/claude-mcp.json' --strict-mcp-config" Enter
sleep 2
tmux select-window -t "$SESSION":codex
tmux send-keys -t "$SESSION":codex \
  "CODEX_HOME='$LAB/codex-home' codex --dangerously-bypass-approvals-and-sandbox" Enter
sleep 2
tmux select-window -t "$SESSION":agy
tmux send-keys -t "$SESSION":agy \
  "HOME='$LAB/agy-home' agy --dangerously-skip-permissions" Enter
sleep 25

say "the exchange: each vendor opens a pair room and sends to the next"
# The prompts are deliberately mechanical. The interesting assertion is not what an
# agent DECIDES to say — it is that a message written by one vendor's model is
# delivered to, and read by, a DIFFERENT vendor's model through the plugin, with the
# untrusted envelope intact.
send_prompt() {
  local window="$1" text="$2"
  tmux select-window -t "$SESSION":"$window"
  tmux send-keys -t "$SESSION":"$window" "$text"
  sleep 2
  tmux send-keys -t "$SESSION":"$window" Enter
  sleep 25
}

send_prompt claude "Call the agent-room MCP tool room_status, then room_presence. Report every agent (chat_id, fingerprint) verbatim, then stop."
send_prompt codex  "Call the agent-room MCP tool room_status. Report chat_id and fingerprint verbatim, then stop."
send_prompt agy    "Call the agent-room MCP tool room_status. Report chat_id and fingerprint verbatim, then stop."
send_prompt claude "Call agent-room room_presence again and report every agent listed verbatim, then stop."

send_prompt claude "Call agent-room room_direct_open with chat_id CODEX-TMUX. Call agent-room message_send on that room_id with client_message_id claude-msg-001 and text 'MSG-1-CLAUDE: hello from Claude Code via agent-room'. Report status and seq verbatim, then stop."
send_prompt codex  "Call agent-room room_direct_open with chat_id CLAUDE-TMUX. Call agent-room message_read on that room_id with wait_ms 5000. Report every message (sender, text) verbatim, then stop."
send_prompt codex  "Call agent-room message_send on that pair room with client_message_id codex-msg-001 and text 'MSG-2-CODEX: reply from Codex via agent-room'. Report status and seq verbatim, then stop."

send_prompt agy    "Call agent-room room_direct_open with chat_id CODEX-TMUX. Call agent-room message_send on that room_id with client_message_id agy-msg-001 and text 'MSG-3-AGY: hello from Gemini via agent-room'. Report status and seq verbatim, then stop."
send_prompt codex  "Call agent-room message_read on the room with AGY-TMUX and report every message verbatim, then stop."

send_prompt agy    "Call agent-room room_direct_open with chat_id CLAUDE-TMUX. Call agent-room message_send on that room_id with client_message_id agy-msg-002 and text 'MSG-4-AGY: hello from Gemini to Claude Code via agent-room'. Report room_id, status and seq verbatim, then stop."
send_prompt claude "Call agent-room message_read on the room with AGY-TMUX and report every message verbatim, then stop."

send_prompt claude "Call agent-room message_send on the broadcast room with client_message_id claude-bc-001 and text 'BCAST-1-CLAUDE: broadcast from Claude Code'. Report status and seq verbatim, then stop."
send_prompt agy    "Call agent-room message_read on the broadcast room and report every message verbatim, then stop."

say "capturing evidence"
for window in claude codex agy; do
  tmux capture-pane -t "$SESSION":"$window" -p -S -400 >"$LAB/evidence/transcript-$window.txt" 2>/dev/null || true
done
node -e '
const { DatabaseSync } = require("node:sqlite")
const { writeFileSync } = require("node:fs")
const db = new DatabaseSync(process.argv[1] + "/shared/agent-room.sqlite")
const state = {
  rooms: db.prepare("SELECT id, kind FROM rooms").all(),
  direct_members: db.prepare("SELECT room_id, actor_fingerprint FROM direct_members").all(),
  messages: db.prepare("SELECT seq, room_id, chat_id, client_message_id, text FROM messages ORDER BY room_id, seq").all(),
  claims: db.prepare("SELECT chat_id_normalized, actor_fingerprint FROM chat_id_claims").all(),
}
writeFileSync(process.argv[2] + "/evidence/room-state.json", JSON.stringify(state, null, 2) + "\n")
const dm = db.prepare("SELECT COUNT(*) c FROM messages WHERE room_id = (SELECT id FROM rooms WHERE kind = ?) AND text LIKE ?").get("broadcast", "MSG-%")
const bcast = db.prepare("SELECT COUNT(*) c FROM messages WHERE room_id = (SELECT id FROM rooms WHERE kind = ?)").get("broadcast")
console.log("DM rows in the broadcast room:", dm.c, "| broadcast rows:", bcast.c)
if (dm.c !== 0) { console.error("DM EXCLUSION VIOLATED"); process.exit(1) }
' "$LAB" "$LAB"

say "done — the lab world is at $LAB (evidence under $LAB/evidence)"
echo "   the realm server is still running; stop it with:"
echo "   kill \$(python3 -c \"import json;print(json.load(open('$LAB/shared/runtime.json'))['pid'])\")"
[ "$KEEP" -eq 1 ] || true
