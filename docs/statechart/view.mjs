// The view module: the chart speaks the reader's words - an agent-room
// operator watching one installation live its life against one room.
export const title = "agent-room - one installation, one room (TLC-checked)";

export const state = (v) => {
  if (v.wake === "watching") return ["Always-on watch", "Watching for messages"];
  if (v.wake === "woken") return ["Always-on watch", "Woken by someone else"];
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
    case "PeerSends":
      return to.wake === "woken"
        ? "someone else writes - you wake"
        : "someone else writes to the room [nobody is watching]";
    case "YouAllowAll": return "you allow the sender - held rows release";
    case "YouRead": return from.wake === "woken" ? "you read what you were woken for" : "you read the room";
    case "YouReArm": return "you re-arm the watcher";
    case "Done": return "the bounded story ends (no step left)";
    default: return null;
  }
};

export const group = (v) => (v.wake === "watching" || v.wake === "woken" ? "Wake loop" : "Room life");

export const colors = { "Wake loop": "teal", "Room life": "blue" };
