export const title = "Identity - who is this sender?";
export const state = (v) => {
  if (v.sessionHolder !== "nobody") return "Live session";
  if (v.aliasOwner !== "nobody") return "Alias claimed";
  if ((v.enrolled ?? []).length > 0) return "Key enrolled";
  return "Not enrolled";
};
export const step = (action, from, to) => {
  switch (action) {
    case "EnrollYou": return "your key is enrolled";
    case "EnrollPeer": return "the peer's key is enrolled";
    case "ClaimAlias": return to.aliasOwner === "You" ? "you claim the alias" : "the peer claims the alias first";
    case "BindSession": return to.sessionHolder === "You" ? "your client binds the alias" : "the peer's client binds the alias";
    case "ReleaseSession": return "the client session ends (the claim remains)";
    case "ReleaseAlias": return "the alias claim is released";
    case "Done": return "the modeled lifecycle is complete";
    default: return null;
  }
};
export const group = (v) => v.sessionHolder !== "nobody" ? "Session" : v.aliasOwner !== "nobody" ? "Directory" : "Enrollment";
export const colors = { Enrollment: "blue", Directory: "orange", Session: "teal" };
