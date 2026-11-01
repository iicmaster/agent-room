export const title = "Notification - first contact, repeat cooldown, wake outlets";
export const state = (v) => {
  if (!v.watch) return ["Watcher off", "No host wake armed"];
  if (v.wake) {
    return v.wakeKind === "first-contact"
      ? ["Host woken", "First held contact - metadata signal"]
      : ["Host woken", "Trusted message signal"];
  }
  if (v.cooled) return ["Watcher on", "Repeat held row silenced until cooldown expires"];
  return ["Watcher on", v.observed > 0 ? "Ready for the next message" : "Watching the room"];
};
export const step = (action, from, to) => {
  switch (action) {
    case "ArmWatch": return "the live host arms the watcher";
    case "DisarmWatch": return "the host session ends";
    case "YouSends": return null;
    case "PeerSendsTrusted": return to.wake ? "a trusted sender writes - the host wakes" : "a trusted sender writes [no host watching]";
    case "PeerSendsHeld":
      if (to.wake) return "a stranger's first message - wake with metadata only";
      if (from.watch && from.cooled) return "the held repeat arrives - cooldown silences it";
      return "a held message is logged [no host watching]";
    case "CooldownExpires": return from.wake ? null : "the 300 s cooldown elapses";
    case "AgentReadsAndRearms": return "the agent handles the hint and arms again";
    case "AllowPeer": return "the recipient allows the sender";
    case "Done": return "the modeled watch cycle ends";
    default: return null;
  }
};
export const group = (v) => !v.watch ? "Unarmed" : v.wake ? "Waking" : v.cooled ? "Cooldown" : "Watching";
export const colors = { Unarmed: "tan", Waking: "teal", Cooldown: "orange", Watching: "blue" };
