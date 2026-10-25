import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAccessController } from "../engine/access.mjs";
import { createDeck } from "../engine/registry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const owner = { id: "local:owner@example.com", email: "owner@example.com", name: "owner", type: "human" };
const agentOf = (email) => ({
  id: `agent:local-cli:${email}`, email, name: `agent of ${email}`, type: "agent", clientId: "local-cli",
  delegatedPrincipalId: `local:${email}`, delegatedSubject: email, scopes: ["decks:read", "decks:write"],
});

test("access controller: owner's agent may share; non-owner agents and humans may not", () => {
  const root = mkdtempSync(path.join(tmpdir(), "decks-share-"));
  try {
    const access = createAccessController({
      file: path.join(root, "access.json"), documentId: "doc-123456789", bootstrapOwner: "owner@example.com",
    });
    const ownerAgent = agentOf("owner@example.com");
    const editorAgent = agentOf("editor@example.com");

    // Owner's agent grants and re-grants on the owner's behalf.
    access.grant(ownerAgent, { type: "user", email: "joi@ito.com", role: "editor" });
    access.grant(ownerAgent, { type: "user", email: "joi@ito.com", role: "commenter" });
    const listed = access.list(ownerAgent);
    const granted = listed.permissions.find((p) => p.principal.email === "joi@ito.com");
    assert.equal(granted.role, "commenter");
    assert.equal(granted.createdBy, ownerAgent.id); // attributed to the agent principal

    // Ownership is never grantable; unknown roles rejected.
    assert.throws(() => access.grant(ownerAgent, { type: "user", email: "x@y.z", role: "owner" }), /invalid permission/);

    // Agent of a non-owner: no sharing authority even though its person can edit.
    access.grant(owner, { type: "user", email: "editor@example.com", role: "editor" });
    assert.throws(() => access.grant(editorAgent, { type: "user", email: "someone@else.x", role: "viewer" }), /owner/);
    assert.throws(() => access.list(editorAgent), /owner/);
    // Human editor: unchanged denial.
    assert.throws(() => access.grant({ id: "local:editor@example.com", email: "editor@example.com", name: "editor", type: "human" }, { type: "user", email: "a@b.c", role: "viewer" }), /owner/);

    // Owner's agent revokes; the person's own editing role is untouched.
    access.revoke(ownerAgent, granted.id);
    assert.equal(access.list(ownerAgent).permissions.length, 1); // editor@example.com remains
    assert.equal(access.role({ id: "local:editor@example.com", email: "editor@example.com", name: "editor", type: "human" }), "editor");

    // Bootstrap owner human retains full authority.
    access.grant(owner, { type: "user", email: "direct@grant.x", role: "viewer" });
    assert.equal(access.list(owner).permissions.length, 2);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const mcpCall = async (base, documentId, email, name, args = {}) => {
  const headers = {
    authorization: `Bearer local:${email}`, "x-decks-agent-client": "test-client",
    "content-type": "application/json", accept: "application/json, text/event-stream",
  };
  const endpoint = `${base}/mcp/d/${documentId}`;
  const init = await fetch(endpoint, {
    method: "POST", headers, body: JSON.stringify({
      jsonrpc: "2.0", id: 0, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "share-test", version: "1" } },
    }),
  });
  const session = init.headers.get("mcp-session-id") || "";
  await fetch(endpoint, { method: "POST", headers: { ...headers, "mcp-session-id": session }, body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
  const response = await fetch(endpoint, {
    method: "POST", headers: { ...headers, "mcp-session-id": session },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: name ? { name, arguments: args } : undefined }),
  });
  const text = await response.text();
  const line = text.startsWith("{") ? text : text.split("\n").find((row) => row.startsWith("data: "))?.slice(6);
  return JSON.parse(line || "{}");
};

test("MCP: owner's agent grants headlessly; non-owner's agent denied end to end", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "decks-share-mcp-"));
  const theme = path.join(root, "themes", "starter");
  mkdirSync(theme, { recursive: true });
  writeFileSync(path.join(theme, "theme.css"), ".slide { width: 1280px; height: 720px; }\n");
  const port = 8351, base = `http://127.0.0.1:${port}`;
  const created = createDeck({ contentRoot: root, name: "shared-deck", owner });
  const child = spawn(process.execPath, ["engine/edit.mjs", created.documentId, "--port", String(port)], {
    cwd: ROOT, env: { ...process.env, DECKS_CONTENT_ROOT: root }, stdio: "ignore",
  });
  try {
    const end = Date.now() + 15_000;
    let healthy = false;
    while (Date.now() < end) {
      try { if ((await fetch(`${base}/healthz`)).status === 200) { healthy = true; break; } } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(healthy, "server did not start");

    // Owner's agent grants editor to joi@ito.com through the MCP tool.
    const grant = await mcpCall(base, created.documentId, "owner@example.com", "grant_permission", { email: "joi@ito.com", role: "editor" });
    assert.ok(!grant.error, grant.error?.message);
    const data = JSON.parse(grant.result.content[0].text);
    const permission = data.permissions.find((p) => p.principal.email === "joi@ito.com");
    assert.equal(permission.role, "editor");

    // Readback through list_permissions.
    const list = await mcpCall(base, created.documentId, "owner@example.com", "list_permissions", {});
    assert.ok(!list.error, list.error?.message);
    assert.ok(JSON.parse(list.result.content[0].text).permissions.some((p) => p.principal.email === "joi@ito.com" && p.role === "editor"));

    // A second person is granted editor by the owner's agent, then that
    // person's agent is denied sharing authority.
    await mcpCall(base, created.documentId, "owner@example.com", "grant_permission", { email: "helper@example.com", role: "editor" });
    const denied = await mcpCall(base, created.documentId, "helper@example.com", "grant_permission", { email: "x@y.z", role: "viewer" });
    assert.ok(denied.result.isError, "agent of a non-owner must be denied");
    assert.match(denied.result.content[0].text, /owner/);

    // Persistence: the grant survives in access.json on disk.
    const stored = JSON.parse(readFileSync(path.join(root, "decks", "shared-deck", ".history", "access.json"), "utf8"));
    assert.ok(stored.permissions.some((p) => p.principal.email === "joi@ito.com" && p.role === "editor"));
  } finally {
    child.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  }
});
