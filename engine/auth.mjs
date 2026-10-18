const header = (request, name) => {
  const value = request?.headers?.get?.(name) ?? request?.headers?.[name];
  return Array.isArray(value) ? value[0] || "" : String(value || "");
};
const iapValue = (value) => String(value || "").replace(/^[^:]+:/, "").trim();

export async function createAuthenticator({ publicOrigin, local, defaultName = "designer" }) {
  const publicViewOnly = process.env.DECKS_PUBLIC_VIEW_ONLY === "true";
  const iap = process.env.DECKS_IAP_ENABLED === "true";
  if (!local && !publicViewOnly && !iap) throw new Error("hosted access requires DECKS_IAP_ENABLED=true");
  if (iap && !publicOrigin) throw new Error("DECKS_PUBLIC_ORIGIN is required with IAP");

  const principal = (request) => {
    if (local) {
      const match = header(request, "cookie").match(/(?:^|;\s*)decks_local=([^;]+)/);
      if (!match) return null;
      const name = decodeURIComponent(match[1]);
      return { id: `local:${name.toLowerCase()}`, email: name.includes("@") ? name.toLowerCase() : "", name, type: "human" };
    }
    if (!iap) return null;
    const email = iapValue(header(request, "x-goog-authenticated-user-email")).toLowerCase();
    const subject = iapValue(header(request, "x-goog-authenticated-user-id"));
    if (!email || !subject) return null;
    if (email.endsWith(".gserviceaccount.com")) return null;
    return { id: `iap-human:${subject}`, email, name: email.split("@")[0], type: "human" };
  };

  return {
    configured: iap,
    principal,
    assertOrigin(request) {
      const origin = header(request, "origin");
      if (iap && origin && origin !== publicOrigin) {
        const error = new Error("origin denied"); error.statusCode = 403; throw error;
      }
    },
    async bearerPrincipal(request) {
      if (local) {
        const authorization = header(request, "authorization");
        if (!authorization.startsWith("Bearer local:")) return null;
        const subject = authorization.slice(13).trim().toLowerCase();
        return subject ? {
          id: `agent:local-cli:${subject}`, email: subject.includes("@") ? subject : "",
          name: `Local agent for ${subject}`, type: "agent", clientId: "local-cli",
          delegatedSubject: subject, delegatedPrincipalId: `local:${subject}`, scopes: ["decks:read", "decks:write"],
        } : null;
      }
      const identity = principal(request);
      const clientId = header(request, "x-decks-agent-client").trim();
      return identity?.type === "human" && clientId ? {
        id: `iap-agent:${clientId}:${identity.id}`, email: identity.email,
        name: `agent of ${identity.email}`, type: "agent", clientId,
        delegatedPrincipalId: identity.id, scopes: ["decks:read", "decks:write"],
      } : null;
    },
    async browserPrincipal(request, response, url) {
      const identity = principal(request);
      if (identity?.type === "human") return identity;
      if (local) {
        const name = (url.searchParams.get("user") || defaultName).trim().slice(0, 80) || "designer";
        response.setHeader?.("set-cookie", `decks_local=${encodeURIComponent(name)}; Path=/; HttpOnly; SameSite=Lax`);
        return { id: `local:${name.toLowerCase()}`, email: name.includes("@") ? name.toLowerCase() : "", name, type: "human" };
      }
      response.writeHead(identity ? 403 : 401, { "content-type": "text/plain; charset=utf-8" });
      response.end(identity ? "Human browser identity required." : "IAP identity required."); return null;
    },
    async route() { return false; },
  };
}
