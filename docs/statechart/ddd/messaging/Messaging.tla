---- MODULE Messaging ----
(***************************************************************************)
(* DDD context chart: Messaging                                               *)
(* A room owns an append-only sequence. Trust delivery is a CLIENT-EDGE     *)
(* policy (here: held vs delivered); reads advance the consumed cursor,     *)
(* never backwards. Notification is NOT modeled as the reader/authority.    *)
(* Small bound: 2 rows, one reader, two actors.                              *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

MaxSeq == 2
Actors == {"You", "Peer"}

VARIABLES seq, peerRows, heldRows, trusted, cursor, bodySeen
vars == <<seq, peerRows, heldRows, trusted, cursor, bodySeen>>

Init ==
    /\ seq = 0
    /\ peerRows = {}
    /\ heldRows = {}
    /\ trusted = FALSE
    /\ cursor = 0
    /\ bodySeen = FALSE

YouSend ==
    /\ seq < MaxSeq
    /\ seq' = seq + 1
    /\ UNCHANGED <<peerRows, heldRows, trusted, cursor, bodySeen>>

PeerSendsHeld ==
    /\ ~trusted
    /\ seq < MaxSeq
    /\ seq' = seq + 1
    /\ peerRows' = peerRows \cup {seq'}
    /\ heldRows' = heldRows \cup {seq'}
    /\ UNCHANGED <<trusted, cursor, bodySeen>>

PeerSendsTrusted ==
    /\ trusted
    /\ seq < MaxSeq
    /\ seq' = seq + 1
    /\ peerRows' = peerRows \cup {seq'}
    /\ UNCHANGED <<heldRows, trusted, cursor, bodySeen>>

AllowPeer ==
    /\ ~trusted
    /\ trusted' = TRUE
    /\ heldRows' = {}
    /\ bodySeen' = (bodySeen \/ (peerRows # {}))
    /\ UNCHANGED <<seq, peerRows, cursor>>

DeliveredRows == (1..seq) \ heldRows

ReadMessages ==
    /\ cursor < seq
    /\ cursor' = seq
    /\ bodySeen' = (bodySeen \/ (\E i \in DeliveredRows : i \in peerRows))
    /\ UNCHANGED <<seq, peerRows, heldRows, trusted>>

Operations == YouSend \/ PeerSendsHeld \/ PeerSendsTrusted \/ AllowPeer \/ ReadMessages
Done == ~ENABLED Operations /\ UNCHANGED vars
Next == Operations \/ Done
Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ seq \in 0..MaxSeq
    /\ peerRows \subseteq 1..MaxSeq
    /\ heldRows \subseteq 1..MaxSeq
    /\ trusted \in BOOLEAN
    /\ cursor \in 0..MaxSeq
    /\ bodySeen \in BOOLEAN

CursorMonotonic == [][cursor' >= cursor]_cursor
NoBodyWithoutTrust == bodySeen => trusted
RowsOrderedAndBounded == heldRows \subseteq peerRows /\ peerRows \subseteq 1..seq

=============================================================================
