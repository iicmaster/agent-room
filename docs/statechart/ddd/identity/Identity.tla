---- MODULE Identity ----
(***************************************************************************)
(* DDD context chart: Identity                                                *)
(* Who is this key, which alias does it claim, and is its session live?     *)
(* One realm, two fingerprints, one Chat ID alias. No rooms or message data. *)
(* Identity owns the occupancy rule; Messaging consumes only the validated  *)
(* actor reference. This model does NOT decide whether alias occupancy will  *)
(* be retired — that remains a product decision.                             *)
(***************************************************************************)
EXTENDS FiniteSets

Actors == {"You", "Peer"}
Nobody == "nobody"

VARIABLES enrolled, aliasOwner, sessionHolder
vars == <<enrolled, aliasOwner, sessionHolder>>

Init ==
    /\ enrolled = {}
    /\ aliasOwner = Nobody
    /\ sessionHolder = Nobody

EnrollYou ==
    /\ "You" \notin enrolled
    /\ enrolled' = enrolled \cup {"You"}
    /\ UNCHANGED <<aliasOwner, sessionHolder>>

EnrollPeer ==
    /\ "Peer" \notin enrolled
    /\ enrolled' = enrolled \cup {"Peer"}
    /\ UNCHANGED <<aliasOwner, sessionHolder>>

ClaimAlias(actor) ==
    /\ actor \in enrolled
    /\ aliasOwner = Nobody
    /\ aliasOwner' = actor
    /\ UNCHANGED <<enrolled, sessionHolder>>

BindSession(actor) ==
    /\ actor \in enrolled
    /\ aliasOwner = actor
    /\ sessionHolder = Nobody
    /\ sessionHolder' = actor
    /\ UNCHANGED <<enrolled, aliasOwner>>

ReleaseSession ==
    /\ sessionHolder \in Actors
    /\ sessionHolder' = Nobody
    /\ UNCHANGED <<enrolled, aliasOwner>>

ReleaseAlias ==
    /\ aliasOwner \in Actors
    /\ sessionHolder # aliasOwner
    /\ aliasOwner' = Nobody
    /\ UNCHANGED <<enrolled, sessionHolder>>

Operations ==
    \/ EnrollYou
    \/ EnrollPeer
    \/ ClaimAlias("You")
    \/ ClaimAlias("Peer")
    \/ BindSession("You")
    \/ BindSession("Peer")
    \/ ReleaseSession
    \/ ReleaseAlias

Done == ~ENABLED Operations /\ UNCHANGED vars
Next == Operations \/ Done
Spec == Init /\ [][Next]_vars

TypeOK ==
    /\ enrolled \subseteq Actors
    /\ aliasOwner \in Actors \cup {Nobody}
    /\ sessionHolder \in Actors \cup {Nobody}

AliasClaimHasIdentity == aliasOwner = Nobody \/ aliasOwner \in enrolled
SessionHasIdentity == sessionHolder = Nobody \/ sessionHolder \in enrolled
SessionMatchesAlias == sessionHolder = Nobody \/ sessionHolder = aliasOwner

=============================================================================
