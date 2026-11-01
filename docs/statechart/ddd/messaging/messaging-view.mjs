export const title = "Messaging - the durable log and client delivery policy";
export const state = (v) => {
  if (v.seq === 0) return "Empty room";
  if ((v.heldRows ?? []).length > 0 && !v.trusted) return "Message held";
  if (v.cursor < v.seq) return "Unread message";
  return "Caught up";
};
export const step = (action, from, to) => {
  switch (action) {
    case "YouSend": return "you append a message";
    case "PeerSendsHeld": return "a stranger's row is held (metadata only)";
    case "PeerSendsTrusted": return "a trusted row is appended";
    case "AllowPeer": return "the recipient allows the sender";
    case "ReadMessages": return "the agent reads; the consumed cursor advances";
    case "Done": return "the modeled log is complete";
    default: return null;
  }
};
export const group = (v) => v.heldRows.length > 0 && !v.trusted ? "Held delivery" : "Durable log";
export const colors = { "Durable log": "blue", "Held delivery": "orange" };
