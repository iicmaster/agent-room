// The view module: the chart speaks the reader's words - an agent-room
// operator watching one installation live its life against one room.
export const title = "agent-room v0.7.0 - one installation, one room, wake policy checked (TLC)";

export const state = (v) => {
  const heldUnread = (v.heldRows ?? []).filter(seq => seq > v.cursor).length;
  if (v.wake === "watching") {
    return heldUnread > 0
      ? ["Always-on watch", "Watching - a held repeat is silenced by policy"]
      : ["Always-on watch", "Watching for messages"];
  }
  if (v.wake === "woken") {
    return v.lastWakeKind === "first-contact"
      ? ["Always-on watch", "Woken by a stranger (first contact)"]
      : ["Always-on watch", "Woken by someone else"];
  }
  const holderPart =
    v.holder === "you" ? "Chat ID bound"
    : v.holder === "peer" ? "Name held by another key"
    : "Name free";
  const unread = v.sent - v.cursor;
  const held = (v.heldRows ?? []).length;
  const roomPart =
    unread === 0 ? "caught up"
    : held > 0 ? "held message waiting" : "unread message waiting";
  return ["The room", `${holderPart}, ${roomPart}`];
};

export const step = (action, from, to) => {
  switch (action) {
    case "YouBind": return "your client binds the Chat ID and the notifier arms";
    case "PeerClaims": return "another key claims the name first";
    case "PeerReleases": return "the other key lets the name go";
    case "YouUnbind": return "your host closes the session";
    case "YouSend": return "you send a message [you are not woken]";
    case "PeerTrustedSends":
      return to.wake === "woken"
        ? "someone trusted writes - you wake"
        : "someone trusted writes to the room [nobody is watching]";
    case "PeerHeldSends":
      if (to.wake === "woken") return "a stranger's first message - you wake";
      if (from.wake === "watching") return "a held repeat arrives [the policy silences it]";
      return "someone else writes to the room [nobody is watching]";
    case "CooldownExpires": return null; // the 300 s window passing: no chart state changes
    case "YouAllowAll": return "you allow the sender - held rows release";
    case "YouRead": return from.wake === "woken" ? "you read what you were woken for" : "you read the room";
    case "YouReArm": return "you re-arm the watcher";
    case "Done": return "the bounded story ends (no step left)";
    default: return null;
  }
};

export const group = (v) => (v.wake === "watching" || v.wake === "woken" ? "Wake loop" : "Room life");

export const colors = { "Wake loop": "teal", "Room life": "blue" };
