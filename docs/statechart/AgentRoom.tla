---- MODULE AgentRoom ----
(***************************************************************************)
(* A TLA+ model of agent-room's one-installation story, drawn from the     *)
(* shipped rules (v0.6.0, docs/prds + README + the party record):          *)
(*                                                                         *)
(*   - one Chat ID, one live session; another key can claim the name       *)
(*     first, and nothing of yours ever displaces a foreign holder         *)
(*   - the trust matrix: an untrusted sender's rows are HELD — metadata    *)
(*     only, never a body; allow-all releases them and delivers the bodies *)
(*   - the read cursor never rewinds; message_read is the authoritative    *)
(*     read path and delivers bodies only for rows that are not held       *)
(*   - the wake: the always-on notifier / `agent-room wait` wakes the      *)
(*     agent when SOMEONE ELSE writes — an own send never wakes (issue #4) *)
(*                                                                         *)
(* The model is deliberately small: one room, at most MaxSeq rows, two     *)
(* actors ("you" — this installation — and "peer"). The room is an open    *)
(* loop: every reachable state has a step out, so NoDeadlock is real.      *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

MaxSeq == 2
NULL == "nobody"

VARIABLES
    \* the name's live holder: NULL, "you" (this installation's key), "peer"
    holder,
    \* the trust matrix: is the peer allowlisted (allow-all is monotone)
    trusted,
    \* the room's durable log: how many rows, and which the peer sent
    sent,
    peerRows,
    \* rows currently held (untrusted at send; allow-all empties the set)
    heldRows,
    \* whether this installation has seen a peer BODY (delivered text)
    sawPeerBody,
    \* the agent's read cursor (message_read, strictly increasing)
    cursor,
    \* the wake: "idle" | "watching" (notifier/wait armed) | "woken"
    wake

vars == <<holder, trusted, sent, peerRows, heldRows, sawPeerBody, cursor, wake>>

Init ==
    /\ holder = NULL
    /\ trusted = FALSE
    /\ sent = 0
    /\ peerRows = {}
    /\ heldRows = {}
    /\ sawPeerBody = FALSE
    /\ cursor = 0
    /\ wake = "idle"

DeliveredRows == (1..sent) \ heldRows

(* Your client binds the free name; on success the notifier arms. *)
YouBind ==
    /\ holder = NULL
    /\ holder' = "you"
    /\ wake' = "watching"
    /\ UNCHANGED <<trusted, sent, peerRows, heldRows, sawPeerBody, cursor>>

(* A foreign key claimed the name first: your binds are refused, and no    *)
(* action of yours ever takes the name back from a foreign holder (the     *)
(* own-key-only rule — `session replace` displaces a session of YOUR key   *)
(* only, which at this abstraction is the YouBind refusal).                *)
PeerClaims ==
    /\ holder = NULL
    /\ holder' = "peer"
    /\ wake' = "idle"
    /\ UNCHANGED <<trusted, sent, peerRows, heldRows, sawPeerBody, cursor>>

PeerReleases ==
    /\ holder = "peer"
    /\ holder' = NULL
    /\ UNCHANGED <<trusted, sent, peerRows, heldRows, sawPeerBody, cursor, wake>>

YouUnbind ==
    /\ holder = "you"
    /\ holder' = NULL
    /\ wake' = "idle"
    /\ UNCHANGED <<trusted, sent, peerRows, heldRows, sawPeerBody, cursor>>

(* Your own send allocates a row and never wakes you (issue #4). *)
YouSend ==
    /\ holder = "you"
    /\ sent < MaxSeq
    /\ sent' = sent + 1
    /\ wake' = wake
    /\ UNCHANGED <<holder, trusted, peerRows, heldRows, sawPeerBody, cursor>>

(* Someone else writes. An armed watcher wakes — even on a HELD row (the   *)
(* wake is metadata-only; the held pipeline stays message_read's).         *)
PeerSends ==
    /\ sent < MaxSeq
    /\ sent' = sent + 1
    /\ peerRows' = peerRows \cup {sent'}
    /\ heldRows' = IF trusted THEN heldRows ELSE heldRows \cup {sent'}
    /\ wake' = IF wake = "watching" THEN "woken" ELSE wake
    /\ UNCHANGED <<holder, trusted, sawPeerBody, cursor>>

(* allow-all: monotone; the held rows release and their bodies deliver. *)
YouAllowAll ==
    /\ ~trusted
    /\ trusted' = TRUE
    /\ heldRows' = {}
    /\ sawPeerBody' = (sawPeerBody \/ (peerRows # {}))
    /\ UNCHANGED <<holder, sent, peerRows, cursor, wake>>

(* message_read: the authoritative read; the cursor never rewinds; held    *)
(* rows deliver metadata only — no body. Reading clears a stale wake (the  *)
(* agent consumed what it was woken for, and the watcher re-arms).         *)
YouRead ==
    /\ cursor < sent
    /\ cursor' = sent
    /\ sawPeerBody' = (sawPeerBody \/ (\E i \in DeliveredRows : i \in peerRows))
    /\ wake' = IF wake = "woken" THEN "watching" ELSE wake
    /\ UNCHANGED <<holder, trusted, sent, peerRows, heldRows>>

(* The host wakes, acts, and arms the watcher again. *)
YouReArm ==
    /\ wake = "woken"
    /\ wake' = "watching"
    /\ UNCHANGED <<holder, trusted, sent, peerRows, heldRows, sawPeerBody, cursor>>

AnyStep ==
    \/ YouBind
    \/ PeerClaims
    \/ PeerReleases
    \/ YouUnbind
    \/ YouSend
    \/ PeerSends
    \/ YouAllowAll
    \/ YouRead
    \/ YouReArm

(* The room is an open loop: every reachable state has a step out (a bind, *)
(* a release, a send, a read, or a re-arm), so NoDeadlock is checked on    *)
(* the real graph — no Done action, no weakened deadlock check. *)
Next == AnyStep

Spec == Init /\ [][Next]_vars

(* THE RULES — each is a rule the reader agrees to. Never weakened. *)

(* 1. A foreign body is never seen while the sender is untrusted: a held   *)
(*    row delivers metadata only, and allow-all releases it together with  *)
(*    the trust it needs. *)
NoBodyWithoutTrust ==
    sawPeerBody => trusted

(* 2. A wake is always FOR someone else: the woken agent has an unread     *)
(*    row from the peer. (The v0.5.0 wait woke on its own sends — issue    *)
(*    #4; this rule is its regression test.) *)
ForeignUnreadExists ==
    \E i \in (cursor + 1)..sent : i \in peerRows
WokenIsForSomeoneElse ==
    wake = "woken" => ForeignUnreadExists

(* 3. The read cursor never rewinds — the durable log makes every catch-up *)
(*    exact and gap-free. *)
CursorMonotonic == [][cursor' >= cursor]_cursor

(* 4. A foreign holder is never displaced by anything of yours: the only   *)
(*    action that moves the name to "you" is YouBind, which requires a     *)
(*    free name. (Structural above; restated as the reader's rule.) *)
ForeignHolderNeverDisplaced ==
    holder = "peer" => wake # "watching"
    \* a foreign holder coexisting with an armed watcher is the impossibility
    \* the one-session rule forbids: the watcher arms only through YouBind,
    \* which needs a free name, and stays armed only while YOUR session lives.

=============================================================================
