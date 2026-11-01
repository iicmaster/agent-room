---- MODULE Notification ----
(***************************************************************************)
(* DDD context chart: Notification                                           *)
(* Observes message rows; it does NOT consume them. Its progress is a       *)
(* wake watermark, distinct from Messaging's consumed read cursor.           *)
(* Policy: first held contact wakes; repeats while cooled are silenced;    *)
(* trusted messages always wake. CooldownExpires abstracts 300 s as a      *)
(* nondeterministic time passage; the 10/min aggregate budget is omitted.    *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

MaxSeq == 2
Actors == {"You", "Peer"}

VARIABLES seq, peerRows, heldRows, trusted, watch, wake, cooled, wakeKind, observed
vars == <<seq, peerRows, heldRows, trusted, watch, wake, cooled, wakeKind, observed>>

Init ==
    /\ seq = 0
    /\ peerRows = {}
    /\ heldRows = {}
    /\ trusted = FALSE
    /\ watch = FALSE
    /\ wake = FALSE
    /\ cooled = FALSE
    /\ wakeKind = "none"
    /\ observed = 0

ArmWatch ==
    /\ ~watch
    /\ watch' = TRUE
    /\ UNCHANGED <<seq, peerRows, heldRows, trusted, wake, cooled, wakeKind, observed>>

DisarmWatch ==
    /\ watch
    /\ watch' = FALSE
    /\ wake' = FALSE
    /\ wakeKind' = "none"
    /\ UNCHANGED <<seq, peerRows, heldRows, trusted, cooled, observed>>

YouSends ==
    /\ seq < MaxSeq
    /\ seq' = seq + 1
    /\ UNCHANGED <<peerRows, heldRows, trusted, watch, wake, cooled, wakeKind, observed>>

PeerSendsTrusted ==
    /\ trusted
    /\ seq < MaxSeq
    /\ seq' = seq + 1
    /\ peerRows' = peerRows \cup {seq'}
    /\ wake' = watch
    /\ wakeKind' = IF watch THEN "trusted" ELSE wakeKind
    /\ observed' = IF watch THEN seq' ELSE observed
    /\ UNCHANGED <<heldRows, trusted, watch, cooled>>

PeerSendsHeld ==
    /\ ~trusted
    /\ seq < MaxSeq
    /\ seq' = seq + 1
    /\ peerRows' = peerRows \cup {seq'}
    /\ heldRows' = heldRows \cup {seq'}
    /\ wake' = IF watch /\ ~cooled THEN TRUE ELSE wake
    /\ wakeKind' = IF watch /\ ~cooled THEN "first-contact" ELSE wakeKind
    /\ observed' = IF watch /\ ~cooled THEN seq' ELSE observed
    /\ cooled' = IF watch /\ ~cooled THEN TRUE ELSE cooled
    /\ UNCHANGED <<trusted, watch>>

(* The 300 s cooldown elapses. This is a timed abstraction, NOT a 300 s     *)
(* proof: time passage is nondeterministic, the aggregate budget is omitted. *)
CooldownExpires ==
    /\ cooled
    /\ cooled' = FALSE
    /\ UNCHANGED <<seq, peerRows, heldRows, trusted, watch, wake, wakeKind, observed>>

AgentReadsAndRearms ==
    /\ wake
    /\ wake' = FALSE
    /\ wakeKind' = "none"
    /\ UNCHANGED <<seq, peerRows, heldRows, trusted, watch, cooled, observed>>

AllowPeer ==
    /\ ~trusted
    /\ trusted' = TRUE
    /\ heldRows' = {}
    /\ cooled' = FALSE
    /\ wake' = IF wakeKind = "first-contact" THEN FALSE ELSE wake
    /\ wakeKind' = IF wakeKind = "first-contact" THEN "none" ELSE wakeKind
    /\ observed' = IF wakeKind = "first-contact" THEN 0 ELSE observed
    /\ UNCHANGED <<seq, peerRows, watch>>

Operations ==
    \/ ArmWatch
    \/ DisarmWatch
    \/ YouSends
    \/ PeerSendsTrusted
    \/ PeerSendsHeld
    \/ CooldownExpires
    \/ AgentReadsAndRearms
    \/ AllowPeer
Done == ~ENABLED Operations /\ UNCHANGED vars
Next == Operations \/ Done
Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ seq \in 0..MaxSeq
    /\ peerRows \subseteq 1..MaxSeq
    /\ heldRows \subseteq 1..MaxSeq
    /\ trusted \in BOOLEAN
    /\ watch \in BOOLEAN
    /\ wake \in BOOLEAN
    /\ cooled \in BOOLEAN
    /\ wakeKind \in {"none", "trusted", "first-contact"}
    /\ observed \in 0..MaxSeq
    /\ ~cooled \/ ~trusted
    /\ ~wake \/ (wakeKind # "none" /\ observed > 0)

WakeHasForeignRow == wake => observed \in peerRows
FirstContactWakeHasHeldRow == (wake /\ wakeKind = "first-contact") => observed \in heldRows
CooldownIsHeldOnly == cooled => ~trusted
HeldRepeatIsSilenced == [][(watch /\ cooled /\ ~trusted /\ seq < MaxSeq) => ~PeerSendsHeld]_vars
FirstHeldContactWakes == [][(watch /\ ~trusted /\ ~cooled /\ seq < MaxSeq) => (PeerSendsHeld => (wake' /\ wakeKind' = "first-contact"))]_vars
TrustedSenderWakes == [][(watch /\ trusted /\ seq < MaxSeq) => (PeerSendsTrusted => (wake' /\ wakeKind' = "trusted"))]_vars
WokenIsForSomeoneElse == wake => wakeKind \in {"trusted", "first-contact"}

=============================================================================
