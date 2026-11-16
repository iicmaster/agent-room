#!/usr/bin/env node

// The `agent-room` bin — the human side of this installation (the MCP adapter
// never asks the human anything: its stdin is the JSON-RPC channel and must
// stay pure). Two command families share this one entrypoint:
//
//   setup (Story 1.7)     the one-time Chat ID choice: collect chat_id →
//                         validate the DR-1 grammar (chatIdForms) →
//                         ensureServer + local auth → POST /api/session probe
//                         (a live collision answers 409 and re-prompts;
//                         success is immediately released with
//                         DELETE /api/session, so the name is verified
//                         claimable and then freed) → store
//                         PLUGIN_DATA/config.json at 0600 (atomic write).
//
//   held/allow (Story 3.4) the human trust surface over the held pipeline and
//                         the per-realm allowlist: `held list` (metadata
//                         only), `held show <room_id>:<seq>` (the ONLY surface
//                         where held body text appears), `allow <chat-id>`
//                         (resolve the key fingerprint from this realm's held
//                         records and presence, save the allowlist entry,
//                         release that key's held records) and `allow-all`
//                         (the accept-all flip, interactively confirmed).
//                         Their bodies live in ./held-commands.mjs; the
//                         session they use is UNBOUND — the local token plus
//                         the installation public key are exchanged for a
//                         session token and no Chat ID is ever claimed, so
//                         the commands run collision-free while the live MCP
//                         session holds the name and leave zero presence or
//                         durable-claim footprint.
//
//   invite (Story 4.2)    the OPERATOR family and the CLI host later operator
//                         stories extend (4.5 ban, 4.6 capacity add commands
//                         here, never their own entrypoint): `invite mint`
//                         (raw token printed exactly once — only its SHA-256
//                         digest is stored), `invite list` (digest prefix +
//                         uses remaining + expiry + revoked; never a secret)
//                         and `invite revoke <digest-prefix>`. Unlike the
//                         families above these run on the SERVER HOST and
//                         open the store DIRECTLY, in process — the operator
//                         boundary is the host itself (AR-13: no operator
//                         HTTP route exists), the server need not be running,
//                         and the output grammar is JSON LINES with stable
//                         exit codes (0 ok, 1 refusal, 2 usage — HCI-3's
//                         grammar begins here). Bodies in
//                         ./invite-commands.mjs.
//
//   ban/unban (4.5)       the operator ban family over the SAME host and
//                         grammar: `ban <fingerprint> [--reason <text>]` and
//                         `unban <fingerprint>` write the durable
//                         banned_actors registry directly, in process — a
//                         running server refuses the key's sends, reads,
//                         and re-enrolls with `banned` at next request, and
//                         an in-flight long-poll ends at its next poll wake.
//                         Bodies in ./ban-commands.mjs.
//
//   capacity (4.6)        the operator's storage view over the SAME host and
//                         grammar: `capacity` stats the shared data
//                         directory once against the storage admission
//                         reserves (the store gate's own mechanism — no
//                         store open, so it answers even when the store file
//                         cannot) and prints one JSON line: free bytes, both
//                         reserves, state ok|warn|refuse, admits_appends.
//                         Exit 0 while appends are admitted (warn included),
//                         1 below the refuse reserve, 2 on usage. Thresholds
//                         ride the AGENT_ROOM_STORAGE_* env knobs the direct
//                         launch reads. Bodies in ./capacity-commands.mjs.
//
//   remote (Story 4.3)    the installation's Remote Mode configuration:
//                         `remote set <https-url>` (https required — a
//                         plaintext http:// URL is refused with the coded
//                         transport-policy error and stored never),
//                         `remote show` (the one active server, or local)
//                         and `remote clear` (back to the Local Mode
//                         default). Writes PLUGIN_DATA/remote-config.json —
//                         the same JSON-lines grammar and exit codes as the
//                         invite family. Bodies in ./remote-commands.mjs.
//
//   remote enroll (4.7)   the installation's one-step enrollment with the
//                         configured server through the frozen invite route:
//                         signs the exact invite-token bytes with this
//                         installation's keypair (the route's possession
//                         proof), POSTs once over default-verification
//                         HTTPS, and prints one token-redacted JSON receipt.
//                         Requires a configured origin (run "remote set"
//                         first); enrollment consumes nothing on a refusal
//                         and unlocks the challenge lane for good.
//                         Bodies in ./remote-commands.mjs.
//
// stdin discipline: prompting happens ONLY when stdin is a TTY. A non-TTY
// stdin (pipes, the MCP host, CI) exits with guidance and touches nothing —
// unless every answer was given up front (`setup --chat-id`, `--overwrite`),
// in which case nothing is asked and the command either completes or refuses.
//
// No name is ever stored unless it passed the grammar gate AND the live
// probe; a refused probe writes no config, so a half-finished setup leaves
// no state behind. An existing configuration is never silently overwritten:
// the human confirms the replacement interactively.

import { createInterface } from 'node:readline'
import { existsSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CHAT_ID_INVALID_MESSAGE,
  CHAT_ID_MAX,
  CLIENT_CONFIG_MAX_BYTES,
  CLIENT_REQUEST_TIMEOUT_MS,
  CLI_ERROR_WRITE_FAILED,
  PUBLIC_ERROR_STATUS,
  chatIdForms,
} from '../constants.mjs'
import {
  AgentRoomRuntimeError,
  atomicWriteJson,
  instanceDataDirectory,
  readJsonFile,
  sharedDataDirectory,
} from '../runtime.mjs'
import { assertSupportedRuntime } from '../runtime.mjs'
import { loadOrCreateKeypair } from '../keys.mjs'
import { loadOrCreateLocalToken } from '../api/local-token.mjs'
import { ensureServer } from '../client/ensure-server.mjs'
import { cliHttpJson, cliBearerHeaders } from './http.mjs'
import {
  runHeldList,
  runHeldShow,
  runAllow,
  runAllowAll,
} from './held-commands.mjs'
import { runInviteFamilyCommand } from './invite-commands.mjs'
import { runRemoteFamilyCommand } from './remote-commands.mjs'
import { runBanFamilyCommand } from './ban-commands.mjs'
import { runCapacityFamilyCommand } from './capacity-commands.mjs'
import { runViewerFamilyCommand } from './viewer-commands.mjs'
import { runSessionFamilyCommand } from './session-commands.mjs'
import { runSessionPrincipalsFamilyCommand } from './session-principals-commands.mjs'
import { runWaitFamilyCommand } from './wait-commands.mjs'
import { runWakeResetCommand } from './wake-reset-commands.mjs'
import { runGcCommand } from './gc-commands.mjs'
import { loadRemoteConfig } from '../client/remote-config.mjs'
import { runDmCommand, runReadFamilyCommand, runSendFamilyCommand, runSessionVerify, runSessionsCommand } from './message-commands.mjs'
import { runBootstrapCommand } from './bootstrap-commands.mjs'
import { runDoctorCommand } from './doctor-commands.mjs'

const OK_STATUS = 200
// The collision status is owned by the constants table (chat_id_taken), never restated.
const CONFLICT_STATUS = PUBLIC_ERROR_STATUS.chat_id_taken
export const SETUP_REQUIRES_TTY_MESSAGE = 'agent-room setup asks a human to choose the Chat ID, so it needs an interactive terminal (a TTY). Run it in your own terminal: agent-room setup'

// One claim probe with a fresh session: bind the candidate name, and on
// success release it — the name is verified claimable and then freed for the
// session that will actually use it. The release is best-effort: if it fails,
// the answer says so honestly, because the probe session keeps the name
// live-claimed until its session lease expires. A live collision is the
// caller's signal to re-prompt; any other coded answer is a real failure.
async function probeClaim({ port, localToken, publicKey, chatId, timeoutMs = CLIENT_REQUEST_TIMEOUT_MS }) {
  const exchange = await cliHttpJson(port, 'POST', '/api/auth/local', cliBearerHeaders(localToken), {
    public_key: publicKey,
    session_kind: 'cli_oneshot',
  }, timeoutMs)
  if (exchange.status !== OK_STATUS || exchange.body?.result?.session_token === undefined) {
    throw new AgentRoomRuntimeError(
      exchange.body?.error?.code ?? 'request_failed',
      exchange.body?.error?.message ?? `the agent-room credential exchange answered ${exchange.status}`,
    )
  }
  const sessionToken = exchange.body.result.session_token
  let released = true
  let bind
  try {
    bind = await cliHttpJson(port, 'POST', '/api/session', cliBearerHeaders(sessionToken), {
      chat_id: chatId,
      client_type: 'cli',
    }, timeoutMs)
  } finally {
    try {
      const releasedResponse = await cliHttpJson(port, 'DELETE', '/api/session', cliBearerHeaders(sessionToken), undefined, timeoutMs)
      released = releasedResponse.status === OK_STATUS
    } catch {
      released = false
    }
  }
  if (bind.status === OK_STATUS) {
    return { claimed: true, released }
  }
  if (bind.status === CONFLICT_STATUS && bind.body?.error?.code === 'chat_id_taken') {
    return { claimed: false, released }
  }
  throw new AgentRoomRuntimeError(
    bind.body?.error?.code ?? 'request_failed',
    bind.body?.error?.message ?? `the agent-room session probe answered ${bind.status}`,
  )
}

// The interactive setup flow. Streams and directories are injectable so the
// tests can drive it without a TTY process. Returns a result object:
//   { status: 'configured', chatId, configPath }
//   { status: 'not-a-tty' }              — guidance, nothing touched
//   { status: 'aborted' }                — the human ended the input early
export async function runSetup({
  input = process.stdin,
  output = process.stdout,
  sharedDataDir = sharedDataDirectory(),
  pluginDataDir = instanceDataDirectory(),
  waitMs,
  chatId = null,
  overwrite = false,
} = {}) {
  // Non-interactive mode: the Chat ID arrives as an argument (`--chat-id` or
  // AGENT_ROOM_CHAT_ID), so an agent can finish setup with no human at a
  // terminal. The grammar gate and the live probe are the same; only the
  // questions are gone — every answer a prompt would have asked for is either
  // given up front or the command refuses (status 'refused', nothing written).
  const nonInteractive = chatId !== null
  if (!nonInteractive && !input.isTTY) {
    return { status: 'not-a-tty', message: SETUP_REQUIRES_TTY_MESSAGE }
  }

  const lines = nonInteractive ? null : createInterface({ input, output, terminal: false })
  // One pending ask at a time. When the interface closes (the human pressed
  // Ctrl-D, or the input ended), the pending question resolves with null so
  // the flow can return an honest aborted outcome instead of hanging.
  let pendingAsk = null
  lines?.once('close', () => {
    if (pendingAsk) {
      const resolveAborted = pendingAsk
      pendingAsk = null
      resolveAborted(null)
    }
  })
  const ask = question => new Promise(resolvePromise => {
    pendingAsk = resolvePromise
    lines.question(question, answer => {
      pendingAsk = null
      resolvePromise(answer)
    })
  })
  const say = message => output.write(`${message}\n`)

  // The grammar text is derived from the constants module, never restated.
  say(`Welcome to agent-room setup. This installation needs one Chat ID — ${CHAT_ID_INVALID_MESSAGE} — other agents will use it to find and message you.`)
  const configPath = join(pluginDataDir, 'config.json')

  try {
    // An existing configuration is never silently overwritten: the human
    // confirms the replacement interactively before anything else happens
    // (and before the shared server is even booted).
    if (existsSync(configPath)) {
      let existing = null
      try {
        existing = readJsonFile(configPath, { maxBytes: CLIENT_CONFIG_MAX_BYTES })
      } catch {
        existing = null
      }
      const existingChatId = typeof existing?.chat_id === 'string' ? existing.chat_id : '(unreadable)'
      if (nonInteractive && !overwrite) {
        return { status: 'refused', message: `A Chat ID ("${existingChatId}") is already configured for this installation (${configPath}); pass --overwrite to replace it. Nothing was changed.` }
      }
      const answer = nonInteractive ? 'y' : await ask(`A Chat ID ("${existingChatId}") is already configured for this installation (${configPath}). Overwrite it? [y/N] `)
      if (answer === null) {
        return { status: 'aborted', message: 'agent-room setup ended before an answer was given; no configuration was written' }
      }
      if (!/^(y|yes)$/i.test(String(answer).trim())) {
        return { status: 'aborted', message: 'agent-room setup kept the existing configuration; nothing was changed' }
      }
    }

    // Non-interactive mode already holds the candidate Chat ID: refuse an
    // invalid grammar before booting the local server or touching shared state.
    if (nonInteractive) {
      const candidate = String(chatId).trim()
      if (chatIdForms(candidate) === null) {
        say(`"${candidate.slice(0, CHAT_ID_MAX + 16)}" is not a valid Chat ID: ${CHAT_ID_INVALID_MESSAGE}`)
        return { status: 'refused', message: `"${candidate.slice(0, CHAT_ID_MAX + 16)}" is not a valid Chat ID: ${CHAT_ID_INVALID_MESSAGE}; no configuration was written` }
      }
    }

    // Local Mode bootstrap: the shared server (and, after a boot, the local
    // credential file) exists before the first probe.
    const server = await ensureServer({ dataDir: sharedDataDir, ...(waitMs === undefined ? {} : { waitMs }) })
    const localToken = loadOrCreateLocalToken(sharedDataDir)
    const keypair = loadOrCreateKeypair(pluginDataDir)

    for (;;) {
      const answer = nonInteractive ? chatId : await ask(`Choose a Chat ID: `)
      if (answer === null) {
        return { status: 'aborted', message: 'agent-room setup ended before a Chat ID was chosen; no configuration was written' }
      }
      const candidate = String(answer).trim()
      const forms = chatIdForms(candidate)
      if (forms === null) {
        say(`"${candidate.slice(0, CHAT_ID_MAX + 16)}" is not a valid Chat ID: ${CHAT_ID_INVALID_MESSAGE}`)
        if (nonInteractive) {
          return { status: 'refused', message: `"${candidate.slice(0, CHAT_ID_MAX + 16)}" is not a valid Chat ID: ${CHAT_ID_INVALID_MESSAGE}; no configuration was written` }
        }
        continue
      }

      // The remote-mode honesty note (v0.8.0, the round-2 provisioning item):
      // when a remote origin is configured, this probe answers against the
      // LOCAL server only — it can never certify the name inside the remote
      // realm. The `session verify` availability probe (bind-and-release,
      // not read-only) is the remote check.
      const remoteConfigured = loadRemoteConfig(pluginDataDir) !== null
      if (remoteConfigured) {
        say(`Note: a remote origin is configured for this installation. The availability check below answers against the LOCAL server only — verify the remote realm with: agent-room session verify ${forms.display}`)
      }
      let probe
      try {
        probe = await probeClaim({
          port: server.port,
          localToken,
          publicKey: keypair.publicKey.toString('base64url'),
          chatId: forms.display,
        })
      } catch (error) {
        throw new AgentRoomRuntimeError(
          error?.code ?? 'request_failed',
          `agent-room setup could not verify "${forms.display}": ${error?.message ?? 'probe failed'}`,
        )
      }
      if (!probe.claimed) {
        say(`"${forms.display}" is already claimed live by another connected session. Choose another name.`)
        if (nonInteractive) {
          return { status: 'refused', message: `"${forms.display}" is already claimed live by another connected session; no configuration was written` }
        }
        continue
      }

      // Verified claimable and released. Now — and only now — is the
      // configuration written, atomically, 0600, into PLUGIN_DATA.
      atomicWriteJson(configPath, {
        chat_id: forms.display,
        set_up_at: new Date().toISOString(),
      })
      say(`Done. This installation's Chat ID is "${forms.display}".`)
      if (!probe.released) {
        say(`Warning: the probe session could not be released, so "${forms.display}" stays live-claimed until that session's lease expires; connecting with it may answer chat_id_taken until then.`)
      }
      say(`Stored in ${configPath} — the agent-room tools are ready to use.`)
      return { status: 'configured', chatId: forms.display, configPath }
    }
  } finally {
    lines?.close()
  }
}

function launchedDirectly() {
  if (!process.argv[1]) return false
  try { return realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url)) } catch { return false }
}

// The help text is the single home of the command grammar AND the honesty
// statement; tests/cli-surface.test.mjs pins both as literals and checks the
// AC's negative against this text verbatim.
const HELP_TEXT = `agent-room — the human side of your Agent Room installation.

Commands:

  agent-room bootstrap [--remote <https-origin> --invite <token>] [--harness <name>] [--scope <key>] [--json]
      Initialize private state and bind the session scope (idempotent). HARNESS
      is claude|codex|antigravity|opencode|generic. Add --install or --print to
      wire host MCP config instead: --print writes nothing and shows the snippet,
      install guide, and real gate label; --install backs up and merges only the
      required key into the target settings path. --install and --print are
      mutually exclusive; --json emits one machine-readable line.

  agent-room setup [--chat-id <chat-id>] [--overwrite]
      Choose this installation's Chat ID (one-time). Interactive when run in a
      terminal; with --chat-id (or AGENT_ROOM_CHAT_ID) it needs no terminal and
      no human — an agent can finish setup by itself. An existing Chat ID is
      replaced only with --overwrite.

  agent-room held list [--room <room_id>]
      List held messages — metadata only (id, chat id, key fingerprint, room,
      sequence, time, byte size, reason). Held body text appears nowhere here.

  agent-room held show <room_id>:<seq>
      Preview one held message's full body, exactly the artifact the pipeline
      withheld. This is the only surface where held body text appears. The id
      is printed by "agent-room held list".

  agent-room allow <chat-id> [--fingerprint <fingerprint>] [--remove]
      Allow a sender by Chat ID: the name is resolved to its key fingerprint
      from this realm's held records and presence (case-insensitive, merged by
      fingerprint); when several keys claim the name, disambiguate with
      --fingerprint. Saves the allowlist entry and releases that key's held
      messages. With --remove the entry is removed instead: future messages
      from that key are held again; already-ingested text is untouched.

  agent-room allow-all [--remove] [--yes]
      Allow every future sender in this realm (accept-all). Asks for an
      interactive y/N confirmation; --remove switches it off without one
      (holding messages again is the fail-safe direction).

  agent-room invite mint [--uses N] [--ttl HOURS]
      Mint an enrollment invite. Run this on the SERVER HOST: the command
      opens the server's store directly, in process — there is no operator
      HTTP route (the API cannot mint invites). Prints ONE JSON line in
      which the raw token appears exactly once; only the token's SHA-256
      digest is stored, so the token can never be shown or recovered again.
      Defaults: 1 use, 24 hours to expiry. --uses and --ttl accept finite
      values only; unlimited and never-expiring invites are refused.

  agent-room invite list
      List invites, one JSON line per invite: digest prefix, uses remaining,
      expiry, revoked. Never a token, and never a full digest — a listing
      carries no secret by construction.

  agent-room invite revoke <digest-prefix>
      Revoke an invite by the digest prefix shown in "invite list" (at least
      12 hex characters). Blocks new enrollment only; keys already enrolled
      are untouched. A prefix matching several invites is refused with the
      candidates, never guessed.

  agent-room ban <fingerprint> [--reason <text>]
      Ban an identity key. Run this on the SERVER HOST: the command opens
      the server's store directly, in process — there is no operator HTTP
      route (the API cannot ban). Takes the key's fingerprint ("sha256:"
      followed by 64 lowercase hex characters, as the key holder's
      diagnostics show it); banning a fingerprint nobody has enrolled is
      fine (a preemptive ban). At the next request every send, read, or
      re-enroll from the banned key is refused with the coded refusal
      "banned", and an in-flight long-poll ends at its next poll wake —
      well inside its hold window. The ban survives restarts. An optional
      --reason is stored with the ban (free text, shown to no one but the
      store). Re-banning a banned key is an idempotent success keeping the
      first ban's timestamp.

  agent-room unban <fingerprint>
      Lift a ban: the registry row is deleted and future requests from the
      key flow again immediately. Unbanning a key that holds no ban is
      already the requested state and succeeds.

  agent-room capacity
      Report the shared data directory's free disk space against the storage
      admission reserves. Run this on the SERVER HOST. One statfs of the
      data directory — the store's own append-gate mechanism — against the
      reserves (defaults: warn below 1 GiB free, refuse appends below
      256 MiB free; tune with AGENT_ROOM_STORAGE_WARN_BYTES and
      AGENT_ROOM_STORAGE_REFUSE_BYTES, non-negative integer bytes; the
      refuse reserve may not exceed the warn reserve). Prints ONE JSON line
      on stdout: data_dir, free_bytes, warn_free_bytes, refuse_free_bytes,
      state (ok | warn | refuse), admits_appends, and a detail note on the
      non-ok states. Exit 0 while new appends are admitted (ok and warn
      alike — a reserve breach is a warning, never a refusal), 1 when free
      space is below the refuse reserve (sends answer storage_low until
      space is freed) or the data directory cannot be inspected, 2 on usage
      error. The reserves are capacity gates, NEVER retention quotas:
      nothing is ever deleted to free space. See
      docs/self-hosting-storage.md for backup, restore, and disk expansion.

  agent-room viewer rotate
      Rotate the viewer credential — the Bearer secret the read-only web
      viewer's auth bridge (GET /viewer/auth) exchanges for its HttpOnly
      cookie. Run this on the SERVER HOST. Prints ONE JSON line on stdout
      carrying the NEW credential, shown exactly once (the invite-mint
      pattern): present it as an "Authorization: Bearer" header to
      GET /viewer/auth to mint a fresh viewer session. Every previous
      credential stops minting and every cookie already minted under it is
      invalid at its next presentation — a running server picks the rotation
      up at next request without a restart. No secret ever travels in a URL:
      the viewer is opened at /viewer/ and authenticates entirely by cookie.

  agent-room remote set <https-url>
      Point this installation at a remote agent-room server (Remote Mode).
      The URL must be https:// with a hostname — plaintext (http://) remote
      connections are refused, and normal certificate/hostname verification
      applies on every connection. One server is active at a time: setting a
      new URL replaces the old one. Per-realm trust state this installation
      kept for the old server stays on disk under its realm id but is inert —
      a different server is a different realm and starts with fresh trust.

  agent-room remote show
      Show the configured remote server (one active at a time), or "local"
      when none is set.

  agent-room remote clear
      Remove the remote configuration and return this installation to Local
      Mode (the default loopback server).

  agent-room remote enroll <invite-token>
      Enroll this installation's key with the configured remote server (run
      "agent-room remote set" first — without a configured origin nothing is
      sent and the command refuses, naming it). Pass the ar_inv1_ token
      exactly as "agent-room invite mint" on the SERVER HOST printed it: the
      command signs the exact token bytes with this installation's keypair
      (the server's possession proof), POSTs once to the server's enrollment
      route over normal verified HTTPS, and prints ONE JSON receipt (the
      server origin, this installation's fingerprint, and the token's digest
      prefix — never the token itself). A refused enrollment consumes
      nothing and is retryable with the same token; a committed enrollment
      never needs another invite — reconnecting is automatic.

  agent-room session verify <chat-id>
      Availability probe against the ACTIVE server (local, or the remote
      origin when one is configured): binds the name for the instant of the
      check and releases it again — the receipt says so. verdict:
      unclaimed (free as of that instant; not a reservation),
      claimed_by_self (this key holds it live), or claimed_by_other (a
      different key holds it live — never displacable; choose another
      name). Presence alone cannot answer this: an idle holder drops out of
      the online group, an offline claim lingers after release.

  agent-room send --room <room_id> --text <text> [--reply-to <seq>] [--id <client_message_id>]
      One-shot send over the same wire the MCP adapter uses (the configured
      remote origin, or the local server). The receipt names the status:
      accepted = the durable log committed (NOT a wake receipt),
      duplicate_dropped = the content duplicate gate, storage_low = the store
      refused. The client_message_id (auto-generated when omitted) is printed
      so a lost response can be retried with the identical id. The send never
      binds the Chat ID: the server resolves the sender name from this key's
      most recent claim on the target server (sender_claim_missing means
      bind a name once there first — setup locally, or a first connect in
      the target realm; sender_claim_ambiguous means two names tie — bind
      or re-assert exactly one).

  agent-room send --to <session-address> --text <text> [--id <client_message_id>] [--reply-to <seq>]
      The same one-shot send, addressed to a peer SESSION by its full address
      (base~locator-token@machine — as "agent-room sessions" lists them).
      One wire call resolves the pair room between the two session
      principals and commits; the receipt says committed seq=N and the
      peer's process presence (online/offline) — never delivered or read.
      --room and --to are mutually exclusive.

  agent-room dm --to <session-address> --text <text> [--id <client_message_id>] [--reply-to <seq>]
      Direct-message a peer session by address — the four-step operator
      model in one command. Allocates an ephemeral session principal for
      this invocation (the server issues session id, address and capability),
      sends, and releases the base lease; the durable principal and the
      message persist, so the peer reads it whenever it next reads. Receipt
      vocabulary: committed seq=N, peer presence online|offline — never
      delivered, read, handled, or awakened. A peer address that resolves to
      nothing refuses quietly (peer_not_found, no names, no hints).

  agent-room sessions
      List every session principal in the realm (the explicit enumeration —
      a refused send never names anything, this command does): session_id,
      full address (base~locator-token@machine), machine, generation,
      presence (online iff its 45 s base lease is occupied and unexpired),
      and the lease/retention dispositions. Use an address from this listing
      as dm --to / send --to / message_send to.

  agent-room read --peer <address|agent-id> | --room <room_id>
                  [--after-seq <n>] [--limit <n>] [--wait-ms <ms>]
      Read as THIS session: name exactly one selector — the peer (a full
      session address, or a bare Agent ID when it resolves to one session) or
      a room id. There is no read-everything mode; a room-local seq only means
      something against one room. The receiver-side trust matrix applies
      exactly as in message_read: foreign bodies are wrapped, and a sender
      this installation does not trust arrives as {seq, from_address,
      trusted:false, held:true} with NO text key — a held body is absent, not
      blanked. Reading --peer a session you have never exchanged a message
      with answers an empty page at exit 0; a read never opens a room.
      The session's own read cursor advances to next_after_seq only after the
      receipt is flushed: if stdout fails (EPIPE) the cursor stays put and the
      command exits 1, so a retry cannot silently skip a page. The cursor is
      per session scope, never the MCP adapter's. Wake coverage remains the
      notifier's or wait's job.

  agent-room session replace [<chat-id>] [--yes]
      Take this installation's Chat ID back from the session that still holds
      it. Use it when your client died, was killed, or lost its host and now
      answers "chat id is already claimed by another connected session" for
      its OWN name: the session that holds the name keeps it until its lease
      expires, even when that session's process is gone. The command
      authenticates as THIS installation and OBSERVES first — a plain bind
      whose refusal carries a one-time conflict ticket naming the holder you
      are confirming against (a name that is already free is released again
      without a prompt, and its claim-and-release footprint is disclosed in
      the receipt); only then does it ask the server for the takeover
      explicitly, presenting that ticket; the server grants it only when the holder is this same key,
      then fences the displaced session: its token stops authenticating and
      every request it had in flight is refused — the stage check on the way
      in, or the pipeline's post-input recheck directly before the handler —
      so it cannot act on the name afterwards and cannot take it back by
      reconnecting. (Work already inside a handler is not torn back out: a
      long-poll stops at its next wake.) A session of a DIFFERENT key is
      never displaced. The takeover is never done automatically: the command
      asks for an
      interactive y/N first and refuses a non-interactive stdin unless --yes
      answers it up front (an agent taking its own name back) — that
      confirmation guards against accidents, it is not proof that a human
      answered. When the server acknowledges the release the name is free
      again immediately, so the client that uses it can bind it on its next
      call; if the release cannot complete, the receipt says so and this
      command's lease holds the name until it expires. The optional Chat ID
      defaults to the configured one.

  agent-room wait [--room <room_id>]... [--timeout <seconds>] [--reclaim]
      The companion notifier: block until a NEW message lands in any room of
      this Actor (Broadcast and every Direct Room), then print ONE JSON hint
      line — {ok, command, status:"new_messages", room_id, seq (the FIRST
      unread sequence), elapsed_ms} —
      and exit 0, so an agent that launched it as a BACKGROUND task
      (run_in_background) is woken by its host's completion notification and
      reads the room with its ordinary message_read (the hint never carries
      message bodies; cursors and the trust matrix stay message_read's).
      Rooms are re-enumerated every cycle, so a DM opened mid-wait is
      discovered; a room the agent has never read starts at sequence 0 and
      hints immediately. With --room, watch only the named rooms (repeated
      --room allowed; an unknown room refuses). The deadline defaults to 300
      seconds (max 600): a quiet wait prints {status:"timeout", elapsed_ms,
      watched} and still exits 0 — a clean timeout is a hint, and re-arming
      is the agent's ordinary next action. One wait process per installation
      (a second refuses with wait_already_active). A stale lock FAILS CLOSED:
      the refusal names the lock's path and the recorded pid; when you have
      confirmed no wait is running, take the fence with the force reset
      --reclaim: it removes whatever holds the fence (a live waiter
      included) and starts — run it only with every waiter, launcher and
      competing reclaim quiesced; it is a manual recovery contract, not a
      concurrency-safe protocol. Creates no setup or identity: setup must be complete first (not_set_up
      otherwise), and the wait never claims the Chat ID, never moves read_seq,
      and never changes trust. Each successful trusted wake advances notified_seq
      (the wake watermark) through the loop guard; a hard pause at 8 wakes per
      pair / 25 per scope returns {status:"paused", message:"... run agent-room
      wake-reset ..."} and posts nothing to chat. Honest scope: this wakes a
      LIVE host session; an agent with no live session is woken by nothing — the
      durable log makes the catch-up exact when it returns.

  agent-room wake-reset (--peer <address|agent-id> | --all) [--scope <scope>] [--json]
      Re-enable a hard-paused auto-wake pair (--peer: the same selector as
      read/dm) or every pair in this scope (--all). --all affects the CURRENT
      session scope only; use --scope <k> explicitly for another scope. Exactly
      one of --peer and --all is required (neither/both is a usage error, exit
      2). Clears G1/G2 counters only; never touches notified_seq or Held state.

  agent-room hook <session-start|user-prompt-submit|post-tool-use|stop>
      Claude Code lifecycle hook adapter (Tier 2). Reads one JSON object from
      stdin ({event,session_id,cwd,prompt,stop_hook_active}, <= 64 KiB). All
      four hooks fail open: malformed/oversize stdin, EOF, timeout past 1500 ms,
      or unreadable state exits 0 with a redacted diagnostic and zero state
      change. Unknown subcommand exits 2. session-start writes the scope binding
      only. user-prompt-submit resets G1/G2 only for a genuine human prompt
      (no auto-wake marker, > 5000 ms since the last wake). post-tool-use prints
      a bounded, body-free unread summary without moving read_seq. stop exits 2
      only when stop_hook_active is not true and a Trusted seq > max_notified
      holds the 2-phase lease or a Held message is in budget; it never prints a
      Held body and updates only suppressed_held_seq after Held metadata.

  agent-room gc [--json]
      Housekeeping: collect stale per-session scopes under PLUGIN_DATA/sessions/.
      Skips symlinks, the current scope, and any scope whose wait/cursors/inbox
      lock names a live PID. Deletes only on positive server evidence (revoke,
      or 30-day expiry) or a derived p<ppid>.<pid> scope whose PID is dead past
      24 hours. Offline/401 is NOT a revoke. At most 100 scopes per 100 ms.
      Mutating by design - doctor stays strictly read-only.

  agent-room doctor [--json]
      Read-only one-shot diagnosis of every notification axis (auth, send,
      notify tiers 1A/1B/2/3 + the honest enforced gate, write_queue, nofile,
      held count, loop pause). Each probe <= 1 s, whole report <= 3 s. Never
      touches state — no GC, no mutator endpoints. Exit 0 healthy, 1 degraded,
      2 usage error. Held counts are metadata only — no body text is printed.

  agent-room help
      Show this help.

Approval is a human convention (Instructed) — same-user processes are not
cryptographically distinguishable, so an allowlist entry or accept-all is your
decision about processes running as your own user, never a cryptographic
guarantee. The untrusted envelope stays on every delivered foreign body.
`

// The family's uniform failure outcome: one coded line (plus optional detail
// lines, e.g. the ambiguity candidates) printed by the dispatch's single
// coded-error printer.
function failure(command, code, message, lines) {
  return { ok: false, command, code, message, ...(lines === undefined ? {} : { lines }) }
}

// Strict argv tokens for one command: the flags this command family declares,
// everything else positional; any other --token is refused. `--` is the
// end-of-options marker: everything after it passes through as positionals,
// because the DR-1 grammar makes a leading-hyphen Chat ID legal
// (`agent-room allow -- --alice`). A value-flag never consumes another flag
// as its value: a following --token is a coded refusal, never a silent
// mis-parse.
function parseTokens(tokens, { booleanFlags = [], valueFlags = [] } = {}) {
  const positional = []
  const options = {}
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token === '--') {
      positional.push(...tokens.slice(index + 1))
      break
    }
    if (booleanFlags.includes(token)) {
      options[token] = true
      continue
    }
    if (valueFlags.includes(token)) {
      const value = tokens[index + 1]
      if (value === undefined || value.startsWith('--')) return { error: `${token} needs a value` }
      options[token] = value
      index += 1
      continue
    }
    if (token.startsWith('--')) return { error: `unknown option "${token}"` }
    positional.push(token)
  }
  return { positional, options }
}

// The held/allow command family (Story 3.4). Returns null for an unrecognized
// command shape so the dispatch falls through to the usage error.
async function runHeldFamilyCommand(command, subcommand, tokens, deps) {
  if (command === 'held') {
    if (subcommand === 'list') {
      const parsed = parseTokens(tokens, { valueFlags: ['--room'] })
      if (parsed.error) return failure('held list', 'invalid_request', `${parsed.error}; see "agent-room help"`)
      if (parsed.positional.length > 0) {
        return failure('held list', 'invalid_request', `unexpected argument "${parsed.positional[0]}"; see "agent-room help"`)
      }
      return runHeldList(deps, { roomId: parsed.options['--room'] })
    }
    if (subcommand === 'show') {
      const parsed = parseTokens(tokens)
      if (parsed.error) return failure('held show', 'invalid_request', `${parsed.error}; see "agent-room help"`)
      if (parsed.positional.length !== 1) {
        return failure(
          'held show',
          'invalid_request',
          'expected exactly one held-message id: agent-room held show <room_id>:<seq> — the id as printed by "agent-room held list"',
        )
      }
      return runHeldShow(deps, parsed.positional[0])
    }
    return null
  }
  if (command === 'allow') {
    const parsed = parseTokens(tokens, { booleanFlags: ['--remove'], valueFlags: ['--fingerprint'] })
    if (parsed.error) return failure('allow', 'invalid_request', `${parsed.error}; see "agent-room help"`)
    if (parsed.positional.length !== 1) {
      return failure('allow', 'invalid_request', 'expected exactly one Chat ID: agent-room allow <chat-id> [--fingerprint <fingerprint>] [--remove]')
    }
    return runAllow(deps, parsed.positional[0], {
      remove: parsed.options['--remove'] === true,
      ...(parsed.options['--fingerprint'] === undefined ? {} : { fingerprint: parsed.options['--fingerprint'] }),
    })
  }
  if (command === 'allow-all') {
    const parsed = parseTokens(tokens, { booleanFlags: ['--remove', '--yes'] })
    if (parsed.error) return failure('allow-all', 'invalid_request', `${parsed.error}; see "agent-room help"`)
    if (parsed.positional.length > 0) {
      return failure('allow-all', 'invalid_request', `unexpected argument "${parsed.positional[0]}"; see "agent-room help"`)
    }
    return runAllowAll(deps, { remove: parsed.options['--remove'] === true, yes: parsed.options['--yes'] === true })
  }
  return null
}

export async function main(argv = process.argv.slice(2), {
  input = process.stdin,
  output = process.stdout,
  errorOutput = process.stderr,
  sharedDataDir = sharedDataDirectory(),
  pluginDataDir = instanceDataDirectory(),
  env = process.env,
} = {}) {
  // E9: a closed pipe (EPIPE) emits a stream `error` IN ADDITION to the write
  // callback. Without a listener that becomes an uncaught exception and can
  // replace the coded write_failed line. The write callback path still owns
  // the refusal — this listener only keeps EPIPE non-fatal. Test doubles may
  // not be real streams, so attach only where `.on` exists.
  for (const stream of [output, errorOutput]) {
    if (typeof stream?.on === 'function') stream.on('error', () => {})
  }
  const [command, subcommand] = argv
  if (command === 'help' || command === '--help' || command === '-h') {
    output.write(HELP_TEXT)
    return { status: 'help' }
  }
  const deps = { input, output, errorOutput, sharedDataDir, pluginDataDir, env }
  if (command === 'setup') {
    // The parser answers the PR #1 review nits: `--chat-id=<value>` is the
    // supported form for flag-shaped ids (`--chat-id --alice` reads `--alice`
    // as the flag's own missing value — use `--chat-id=--alice`), and an
    // unknown option or stray positional is a coded usage error, never a
    // silently ignored argument.
    const setupArgs = argv.slice(1)
    let chatId = null
    let overwrite = false
    let parseError = null
    for (let index = 0; index < setupArgs.length; index += 1) {
      const token = setupArgs[index]
      if (token === '--chat-id') {
        const value = setupArgs[index + 1]
        if (value === undefined || value.startsWith('--')) {
          parseError = 'agent-room setup --chat-id needs a value'
          break
        }
        chatId = value
        index += 1
        continue
      }
      if (token.startsWith('--chat-id=')) {
        const value = token.slice('--chat-id='.length)
        if (value === '') {
          parseError = 'agent-room setup --chat-id needs a value'
          break
        }
        chatId = value
        continue
      }
      if (token === '--overwrite') {
        overwrite = true
        continue
      }
      parseError = token.startsWith('--')
        ? `unknown option "${token}"; see "agent-room help"`
        : `unexpected argument "${token}"; agent-room setup takes options only`
      break
    }
    if (parseError !== null) {
      errorOutput.write(`agent-room: ${parseError}\n`)
      process.exitCode = 2
      return { status: 'usage', message: parseError }
    }
    if (chatId === null && typeof env.AGENT_ROOM_CHAT_ID === 'string' && env.AGENT_ROOM_CHAT_ID !== '') {
      chatId = env.AGENT_ROOM_CHAT_ID
    }
    const outcome = await runSetup({ input, output, sharedDataDir, pluginDataDir, chatId, overwrite })
    if (outcome.status === 'not-a-tty' || outcome.status === 'aborted' || outcome.status === 'refused') {
      errorOutput.write(`${outcome.message}\n`)
      process.exitCode = 1
    }
    return outcome
  }
  if (command === 'held' || command === 'allow' || command === 'allow-all') {    let outcome = null
    try {
      outcome = await runHeldFamilyCommand(
        command,
        subcommand,
        command === 'held' ? argv.slice(2) : argv.slice(1),
        deps,
      )
    } catch (error) {
      // The family's one coded-error printer: a thrown or rejected refusal
      // (the mutators reject, never throw past an await) surfaces as the
      // command's coded error, never a bare "invalid" or a stack trace.
      outcome = failure(
        command === 'held' ? `held ${subcommand ?? ''}`.trimEnd() : command,
        error?.code ?? 'request_failed',
        error?.message ?? String(error),
      )
    }
    if (outcome === null) {
      // Coded usage refusal (review patch): the family shape that did not
      // resolve is named, then the help follows.
      const attempted = [command, subcommand].filter(part => part !== undefined).join(' ')
      errorOutput.write(`agent-room: usage_refusal: unknown command "${attempted}"; run "agent-room help" for the command reference\n`)
      errorOutput.write(HELP_TEXT)
      process.exitCode = 1
      return { status: 'usage' }
    }
    if (outcome.ok === false) {
      if (outcome.aborted === true) {
        // The human answered the prompt "no" (or the input ended): the setup
        // command's established abort discipline — one coded line, exit 1,
        // nothing changed.
        errorOutput.write(`agent-room: confirm_declined: ${outcome.message}\n`)
      } else {
        errorOutput.write(`agent-room ${outcome.command} failed: ${outcome.code}: ${outcome.message}\n`)
        for (const line of outcome.lines ?? []) errorOutput.write(`${line}\n`)
      }
      process.exitCode = 1
      return outcome
    }
    output.write(`${outcome.lines.join('\n')}\n`)
    return outcome
  }
  // Stories 4.2, 4.3, 4.5, and 4.6: the machine-readable families (HCI-3's
  // grammar). Success prints one JSON object per line on stdout and exits 0;
  // a refusal or usage error prints ONE JSON object on stderr and exits 1
  // or 2. The invite family is the operator store surface; the remote
  // family is the installation's Remote Mode configuration; the ban family
  // is the operator's ban registry; the capacity command is the storage
  // view — all later operator stories' families extend this dispatch and
  // this printer. (Capacity's refuse state keeps its report on stdout and
  // exits 1 through the outcome's exitCode — the report IS the answer, and
  // the exit code is the severity a script keys on.)
  if (command === 'hook') {
    // Story 4.2: one hook family, one grammar, one fail-open path. The hook
    // outcome owns its exit code (2 only for unknown subcommand / a Stop
    // block); print its bounded stdout and redacted stderr, then return.
    const { runHookCommand } = await import('./hook-commands.mjs')
    const outcome = await runHookCommand(subcommand, { input, env, pluginDataDir, cwd: process.cwd() })
    for (const line of outcome.stdout ?? []) output.write(`${line}\n`)
    for (const line of outcome.stderr ?? []) errorOutput.write(`${line}\n`)
    if (outcome.exitCode !== undefined && outcome.exitCode !== 0) process.exitCode = outcome.exitCode
    return outcome
  }
  if (command === 'doctor') {
    // Story 4.3: diagnosis only — strictly read-only, bounded, no state touched.
    // The doctor outcome owns its exit code (0 healthy / 1 degraded / 2 usage).
    const outcome = await runDoctorCommand(argv.slice(1), deps)
    for (const line of outcome.lines ?? []) output.write(`${line}\n`)
    if (outcome.status !== 'ok') {
      errorOutput.write(`${JSON.stringify({
        ok: false,
        command: 'doctor',
        code: outcome.code,
        message: outcome.message,
      })}\n`)
    }
    process.exitCode = outcome.status === 'usage' ? 2 : (outcome.exitCode ?? (outcome.status === 'ok' ? 0 : 1))
    return outcome
  }
  if (command === 'invite' || command === 'remote' || command === 'ban' || command === 'unban' || command === 'capacity' || command === 'viewer' || command === 'session' || command === 'session-principals' || command === 'wait' || command === 'wake-reset' || command === 'gc' || command === 'send' || command === 'read' || command === 'dm' || command === 'sessions' || command === 'bootstrap') {
    let outcome = command === 'invite'
      ? await runInviteFamilyCommand(subcommand, argv.slice(2), deps)
      : command === 'remote'
        ? await runRemoteFamilyCommand(subcommand, argv.slice(2), deps)
        : command === 'capacity'
          ? await runCapacityFamilyCommand(command, argv.slice(1), deps)
          : command === 'viewer'
            ? await runViewerFamilyCommand(subcommand, argv.slice(2), deps)
            : command === 'session'
              ? (subcommand === 'verify'
                ? await runSessionVerify(deps, argv.slice(2)[0])
                : await runSessionFamilyCommand(subcommand, argv.slice(2), deps))
              : command === 'session-principals'
                ? await runSessionPrincipalsFamilyCommand(subcommand, argv.slice(2), deps)
                : command === 'wait'
                ? await runWaitFamilyCommand(argv.slice(1), deps)
                : command === 'wake-reset'
                  ? await runWakeResetCommand(argv.slice(1), deps)
                : command === 'gc'
                  ? await runGcCommand(argv.slice(1), deps)
                : command === 'send'
                  ? await runSendFamilyCommand(argv.slice(1), deps)
                  : command === 'read'
                    ? await runReadFamilyCommand(argv.slice(1), deps)
                    : command === 'dm'
                      ? await runDmCommand(argv.slice(1), deps)
                      : command === 'sessions'
                        ? await runSessionsCommand(argv.slice(1), deps)
                        : command === 'bootstrap'
                          ? await runBootstrapCommand(argv.slice(1), deps)
                          : await runBanFamilyCommand(command, argv.slice(1), deps)
    if (outcome.status === 'ok') {
      if (typeof outcome.afterFlush === 'function') {
        // Story 2.1's flush-then-advance contract: the receipt reaches stdout
        // FIRST and the post-flush work (the cursor advance) runs only once
        // the write callback fires. A failed write — an EPIPE from a closed
        // pipe, a dead consumer — means the caller never saw this page, so the
        // cursor must not move; exit 1 says so.
        try {
          for (const line of outcome.lines) {
            await new Promise((resolveWrite, rejectWrite) => {
              output.write(`${line}\n`, error => (error ? rejectWrite(error) : resolveWrite()))
            })
          }
        } catch (error) {
          // E9: output.errorOutput already carry no-op `error` listeners, so an
          // EPIPE here reaches THIS callback and no uncaught stream error can
          // replace the coded refusal line below.
          // P10: fall through to the one common refusal emitter, which sets
          // exitCode once from the returned status — no duplicate assignment.
          outcome = {
            status: 'refusal',
            command: outcome.command,
            code: error?.code ?? CLI_ERROR_WRITE_FAILED,
            message: `the ${outcome.command} receipt could not be written to stdout (${error?.code ?? error?.message ?? 'write failed'}); nothing was consumed and the cursor was not advanced`,
          }
        }
        if (outcome.status === 'ok') {
          try {
            await outcome.afterFlush()
          } catch (error) {
            // The page WAS delivered but the position could not be recorded.
            // Say so loudly on stderr and keep exit 0: the data reached the
            // caller, and a non-zero code would invite a re-read of a page
            // already seen.
            errorOutput.write(`${JSON.stringify({
              ok: false,
              command: outcome.command,
              code: error?.code ?? CLI_ERROR_WRITE_FAILED,
              message: `the receipt was delivered but the cursor was not advanced (${error?.code ?? error?.message}); the next read re-delivers this page`,
            })}\n`)
          }
          return outcome
        }
        // Write failure: drop through to the common coded refusal + exit-code
        // assignment below. Cursor advance was skipped (page never delivered).
      }
      if (outcome.status === 'ok') {
        for (const line of outcome.lines) output.write(`${line}\n`)
        if (outcome.exitCode === 1) process.exitCode = 1
        return outcome
      }
      // else: write failure — fall through to the common refusal emitter,
      // which writes the coded line and sets exitCode exactly once.
    }
    errorOutput.write(`${JSON.stringify({
      ok: false,
      command: outcome.command,
      code: outcome.code,
      message: outcome.message,
      ...(outcome.extra === undefined ? {} : outcome.extra),
    })}\n`)
    process.exitCode = outcome.status === 'usage' ? 2 : 1
    return outcome
  }
  // No args or an unknown command: one coded line, then usage plus the
  // honesty statement on stderr, exit 1, no state touched.
  if (command !== undefined) {
    errorOutput.write(`agent-room: unknown_command: unknown command "${command}"; run "agent-room help" for the command reference\n`)
  } else {
    errorOutput.write('agent-room: usage_refusal: no command given; run "agent-room help" for the command reference\n')
  }
  errorOutput.write(HELP_TEXT)
  process.exitCode = 1
  return { status: 'usage' }
}

// Story 1.1's contract gates EVERY entrypoint. This one was added later (the
// setup command) and initially shipped ungated, which the Story 1.1 audit
// caught: on Node < 24.15 the module loaded and printed usage instead of
// refusing. Same shape as mcp-stdio / roomd / the API server: a direct launch
// reports one diagnosable line and exits 1 with no stack trace; an importer
// gets a catchable rejection so harnesses can assert on the failure.
try {
  assertSupportedRuntime()
} catch (error) {
  if (launchedDirectly()) {
    process.stderr.write(`agent-room setup failed: ${error?.code ?? 'startup_failed'}: ${error?.message}\n`)
    process.exit(1)
  }
  throw error
}

if (launchedDirectly()) {
  main().catch(error => {
    process.stderr.write(`agent-room setup failed: ${error?.code ?? 'setup_failed'}: ${error?.message}\n`)
    process.exitCode = 1
  })
}
