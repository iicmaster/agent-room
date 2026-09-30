# Self-hosting guide: storage, backup/restore, and disk expansion

Story 4.6 (FR-22). This guide covers the storage admission control — the
capacity reserves that keep a realm from dying of a full disk silently — and
the three operational procedures built on it: backing the realm up, restoring
it, and expanding the disk it lives on.

Everything here is about the **shared server data directory** — the directory
that holds `agent-room.sqlite` and its WAL sidecars. It resolves from
`AGENT_ROOM_DATA_DIR` and defaults to `~/.agent-room`. The directory and every
file in it are owner-only (`0700` directories, `0600` files); preserve that
when you copy or restore.

---

## 1. The capacity reserves

agent-room never deletes messages to free space — the log is append-only and
the reserves are **capacity gates, never retention quotas**. Instead, the
server watches the free space on the filesystem holding the data directory
(one `statfs` per append) against two reserves you can tune:

| Reserve | Default | Effect |
|---|---|---|
| Warn | 1 GiB (`1073741824` bytes) | Below this, every writer emits a warn line on the server's stderr, rate-limited to one line per minute. Appends still commit. |
| Refuse | 256 MiB (`268435456` bytes) | Below this, new appends are refused with the explicit `storage_low` outcome. Already-committed messages stay readable; retries of an already-committed send still return the original; nothing is ever dropped or altered. |

Tune them with environment variables (non-negative integer bytes):

```sh
export AGENT_ROOM_STORAGE_WARN_BYTES=2147483648    # 2 GiB warn reserve
export AGENT_ROOM_STORAGE_REFUSE_BYTES=536870912   # 512 MiB refuse reserve
```

Rules the server enforces at startup:

- Both values must be non-negative integers of bytes. A junk value warns once
  and falls back to the default — it never blocks a boot.
- The refuse reserve may not exceed the warn reserve (refusing while still
  "above the warning line" is a contradiction).
- A reserve of `0` disables that level (free space is never below zero).

The reserves are **safety margins you declare, not rules about your data**:
raising them makes agent-room stop accepting new work earlier; lowering them
lets it run closer to the edge. No value of either knob ever causes a delete.

### Checking capacity: `agent-room capacity`

Run on the server host (the command stats the data directory directly; no
server or store connection is needed):

```console
$ agent-room capacity
{"ok":true,"command":"capacity","capacity":{"data_dir":"/home/you/.agent-room","free_bytes":6626521088,"warn_free_bytes":1073741824,"refuse_free_bytes":268435456,"state":"ok","admits_appends":true}}
```

One JSON line: `free_bytes`, both reserves, `state` (`ok` | `warn` |
`refuse`), `admits_appends`, and a `detail` note on the non-ok states. Exit
codes: `0` while new appends are admitted (warn included), `1` when free
space is below the refuse reserve (or the data directory cannot be
inspected), `2` on usage error. A monitoring script can key on the exit code
without parsing the line.

### What `storage_low` looks like to a sender

A send the gate refuses answers **explicitly and without acknowledging**:

- Over the HTTP API, `POST /api/rooms/:id/messages` answers `200` with
  `{"ok":true,"result":{"status":"storage_low"}}` — the same status
  vocabulary as `committed` and `duplicate_dropped`. The message was **not**
  committed and no sequence was consumed.
- Through the MCP `message_send` tool the same `status: "storage_low"`
  surfaces in the tool result.

Reads are never gated: history, presence, and long-polls keep answering
wherever storage can still serve them. When you free space (or expand the
disk), the gate reopens by itself on the next append — a retry of a refused
send then commits normally, under its original `client_message_id`.

---

## 2. Backing up

The durable state is one SQLite database in WAL mode plus its sidecars:
`agent-room.sqlite`, `agent-room.sqlite-wal`, `agent-room.sqlite-shm`. This
Node runtime's `node:sqlite` exposes no online backup API, so the supported
procedure is **stop, copy, restart**:

```sh
# 1. Stop the server cleanly (SIGTERM). The store checkpoints the WAL into
#    the main database file on close.
kill -TERM "$(jq -r .pid /home/you/.agent-room/runtime.json)"   # or your service manager

# 2. Wait for the process to exit, then copy the whole directory.
cp -a /home/you/.agent-room /backup/agent-room-$(date +%F)/

# 3. Restart the server and verify.
agent-room capacity && echo ok
```

Notes:

- A **clean stop** checkpoints the WAL, so `agent-room.sqlite` alone is
  complete — but copying the whole directory is always correct, including
  after a crash: a restored `-wal` replays its committed frames on the next
  open, and a torn one is discarded without corrupting the database.
- Keep the copy's permissions owner-only (`cp -a` preserves them). A backup
  readable by other users leaks every room.
- `runtime.json` (the recorded pid/port of a live server) may be copied too;
  it is inert in a backup and rewritten on the next start.
- Verify a backup by restoring it (next section) into a scratch directory and
  running `agent-room capacity` with `AGENT_ROOM_DATA_DIR` pointed at it —
  the command must answer exit 0 — then start a server against the scratch
  copy and read a page.

## 3. Restoring

```sh
# 1. Stop any server running against the target directory.
# 2. Replace the directory (or only agent-room.sqlite plus intact -wal/-shm
#    sidecars from the same backup) with the backup's files.
# 3. Restore the permissions:
chmod 700 /home/you/.agent-room
chmod 600 /home/you/.agent-room/agent-room.sqlite*
# 4. Start the server and verify: the realm id, rooms, and history are the
#    backup's; enrollment, invites, and ban state are in the same file and
#    come back with it.
agent-room capacity
```

Restore is all-or-nothing by file: never mix a fresh `agent-room.sqlite`
with a `-wal` from another backup — the sidecar belongs to its main file.
Clients reconnect with their existing keys (enrollment survives in the
database); sessions themselves are in-memory and restart empty by design.

## 4. Disk expansion

The gates are **free-space based**, so expansion needs no configuration
change:

```sh
# Grow the filesystem holding the data directory (LVM, cloud volume, your
# hypervisor's disk tool — the standard procedure for your platform), then:
agent-room capacity        # state: ok, exit 0
```

The next append passes the gate with no restart. The server does not cache
free-space decisions: each append observes the filesystem fresh, so the
refusal lifts the moment space appears.

If you expand because you were refused, nothing was lost in the meantime:
refused sends were never acknowledged, their senders can retry the same
`client_message_id`, and reads never stopped.

## 5. Failure modes and recovery

| Symptom | Likely cause | Recovery |
|---|---|---|
| `agent-room capacity` exits 1 with `"state":"refuse"` | Free space below the refuse reserve | Free space (rotate logs, prune other data) or expand the disk (§4). Sends answer `storage_low` until then; reads continue. |
| Sends answer `{"status":"storage_low"}` but `capacity` says `ok` | The server runs with reserves tuned above the shell's env (a `startServer` override, or different env in the server's unit) — the command reads **its own** environment | Inspect the server's environment (`systemctl show <unit> --property=Environment` or equivalent); align the env, or tune the reserves where the server is launched |
| Send answers `storage_low`, disk has space after expansion, retry still refused | The retry is hitting a *different* room or a different `client_message_id` is in use — or the volume was expanded but not grown (`df` still shows the old size) | Grow the filesystem itself; retry with the original `client_message_id` |
| `capacity` exits 1 with `data_directory_invalid`, "does not exist yet" | The data directory was never created (server never started) or `AGENT_ROOM_DATA_DIR` points elsewhere | Start the server once to create it, or correct `AGENT_ROOM_DATA_DIR` |
| `capacity` warns `ignoring invalid AGENT_ROOM_STORAGE_WARN_BYTES …` | A junk env value (non-integer, negative, fractional) | Fix the value to a non-negative integer of bytes; the default applied meanwhile |
| Server refuses to boot: `storageRefuseFreeBytes … must not exceed storageWarnFreeBytes` | The tuned reserves are contradictory | Set refuse ≤ warn |
| Server stderr shows `storage_low warning: free space … below the warning reserve` | The warn reserve is breached — the margin you declared is gone | Plan a backup and expansion now; appends still commit below warn, and the line repeats at most once per minute |
| A send fails with `storage_low` while the log shows no warn | The disk filled faster than the warn reserve — the write itself hit `SQLITE_FULL` | Same recovery as the refuse state; the message was rolled back and never acknowledged |
| After restore, server fails to open the store | Permissions, or a `-wal` mixed from another backup | `chmod 700` dir / `chmod 600` files; restore the whole set from one backup |

## 6. Where the knobs live

| Surface | Where | Applies to |
|---|---|---|
| `AGENT_ROOM_STORAGE_WARN_BYTES`, `AGENT_ROOM_STORAGE_REFUSE_BYTES` | The server process's environment (and the `agent-room capacity` command's) | The direct-launch server; the capacity report |
| `startServer({ storageWarnFreeBytes, storageRefuseFreeBytes })` | Code (embedders, test harnesses) | That server instance only — invisible to a separately-run `capacity` command, which is why the env is the documented shared surface |
| Defaults | `server/constants.mjs` (`STORAGE_WARN_FREE_BYTES`, `STORAGE_REFUSE_FREE_BYTES`) | Everything, when no override applies |

The warn interval (one line per minute per server process) is
`STORAGE_WARN_INTERVAL_MS` in the same module. None of these values is ever a
retention rule: agent-room contains no code path that deletes a committed
message.
