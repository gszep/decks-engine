import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const ROLES = new Set(["viewer", "commenter", "editor"]);
const rank = { viewer: 1, commenter: 2, editor: 3, owner: 4 };
const normalizeEmail = (value) => String(value || "").trim().toLowerCase();

export function createAccessController({ file, documentId, bootstrapOwner = "", privateOnly = false }) {
  const empty = () => ({ documentId, owner: null, permissions: [], identities: [] });
  const read = () => {
    if (!existsSync(file)) return empty();
    try {
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (data.documentId !== documentId || !Array.isArray(data.permissions)) return empty();
      if (!Array.isArray(data.identities)) data.identities = [];
      return data;
    } catch { return empty(); }
  };
  const write = (data) => {
    mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.tmp-${process.pid}`;
    writeFileSync(temporary, JSON.stringify(data, null, 2) + "\n");
    renameSync(temporary, file);
  };
  const bootstrap = (principal) => {
    const data = read();
    if (data.owner || !principal || principal.type !== "human") return data;
    const required = normalizeEmail(bootstrapOwner);
    if (required && principal.email !== required) return data;
    data.owner = { id: principal.id, email: normalizeEmail(principal.email), name: principal.name, type: "human" };
    write(data);
    return data;
  };
  const role = (principal, inherited = false) => {
    if (!principal) return null;
    const data = inherited ? read() : bootstrap(principal);
    if (principal.type === "agent") {
      // An agent acts for the person who signed it in: their access, capped at editor.
      if (!principal.delegatedPrincipalId && !principal.delegatedSubject) return null;
      const person = role({ ...principal, id: principal.delegatedPrincipalId || "", type: "human" }, true);
      return person && rank[person] > rank.editor ? "editor" : person;
    }
    if (data.owner?.id === principal.id || (principal.email && data.owner?.email === principal.email)
      || (principal.delegatedSubject && data.owner?.id.endsWith(`|${principal.delegatedSubject}`))) return "owner";
    const delegated = principal.delegatedSubject
      ? data.identities.find((identity) => identity.id.endsWith(`|${principal.delegatedSubject}`)) : null;
    const email = principal.email || delegated?.email || "";
    const domain = email.split("@")[1] || "";
    const matches = data.permissions.filter((permission) =>
      (permission.principal.type === "user" && (permission.principal.id === principal.id || permission.principal.email === email))
      || (permission.principal.type === "domain" && permission.principal.domain === domain)
      || permission.principal.type === "anyone");
    return matches.sort((a, b) => rank[b.role] - rank[a.role])[0]?.role || null;
  };
  const requireRole = (principal, needed) => {
    const actual = role(principal);
    if (!actual || rank[actual] < rank[needed]) {
      const error = new Error(actual ? "insufficient permission" : "document access denied");
      error.statusCode = actual ? 403 : 404;
      throw error;
    }
    return actual;
  };

  return {
    remember(principal) {
      if (!principal || principal.type !== "human") return;
      const data = read();
      const current = data.identities.find((identity) => identity.id === principal.id);
      const identity = { id: principal.id, email: normalizeEmail(principal.email), name: principal.name };
      if (current && current.email === identity.email && current.name === identity.name) return;
      if (current) Object.assign(current, identity); else data.identities.push(identity);
      write(data);
    },
    role,
    requireView: (principal) => requireRole(principal, "viewer"),
    requireEdit: (principal) => requireRole(principal, "editor"),
    requireOwner: (principal) => requireRole(principal, "owner"),
    list(principal) {
      requireRole(principal, "owner");
      return read();
    },
    grant(principal, input) {
      requireRole(principal, "owner");
      const type = input.type;
      if (!["user", "domain", "anyone"].includes(type) || !ROLES.has(input.role)) throw new Error("invalid permission");
      if (privateOnly && type !== "user") throw new Error("dogfood access must name an individual user");
      const target = type === "user"
        ? { type, email: normalizeEmail(input.email) }
        : type === "domain" ? { type, domain: normalizeEmail(input.domain).replace(/^@/, "") } : { type };
      if (type === "user" && !target.email.includes("@")) throw new Error("valid email required");
      if (type === "domain" && !target.domain.includes(".")) throw new Error("valid domain required");
      const data = read();
      const same = (permission) => permission.principal.type === type && (type === "anyone"
        || (type === "user" && permission.principal.email === target.email)
        || (type === "domain" && permission.principal.domain === target.domain));
      const existing = data.permissions.find(same);
      if (existing) existing.role = input.role;
      else data.permissions.push({ id: randomUUID(), principal: target, role: input.role, createdBy: principal.id, createdAt: new Date().toISOString() });
      write(data);
      return data;
    },
    revoke(principal, id) {
      requireRole(principal, "owner");
      const data = read(), before = data.permissions.length;
      data.permissions = data.permissions.filter((permission) => permission.id !== id);
      if (data.permissions.length === before) throw new Error("permission not found");
      write(data);
      return data;
    },
  };
}
