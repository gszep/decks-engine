#!/usr/bin/env node
// Decks agent connector: lets any MCP-capable coding agent edit the decks shared
// with one person's Google account, as that person (at most editor).
// Instructions for agents: served by your decks host at /agents
//
//   node decks-agent.mjs login                      # one-time Google device sign-in
//   node decks-agent.mjs decks                      # list reachable decks
//   node decks-agent.mjs tools                      # list tools and their arguments
//   node decks-agent.mjs call <tool> key=value ...  # run one tool without MCP
//   node decks-agent.mjs mcp                        # stdio MCP server for your agent
//   node decks-agent.mjs token                      # print a short-lived ID token
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";

const EMBEDDED = {};
const config = {
  origin: (process.env.DECKS_ORIGIN || EMBEDDED.origin || "").replace(/\/+$/, ""),
  clientId: process.env.DECKS_AGENT_CLIENT_ID || EMBEDDED.clientId,
  clientSecret: process.env.DECKS_AGENT_CLIENT_SECRET || EMBEDDED.clientSecret,
};
const tokenFile = path.join(homedir(), ".config", "decks", "agent-token.json");
const log = (message) => process.stderr.write(`${message}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const oauth = async (url, fields) => {
  const response = await fetch(url, {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ client_id: config.clientId, client_secret: config.clientSecret, ...fields }),
  });
  return { ok: response.ok, value: await response.json() };
};
const save = (token) => {
  mkdirSync(path.dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, JSON.stringify(token, null, 2), { mode: 0o600 });
  chmodSync(tokenFile, 0o600);
};

async function login() {
  const start = await oauth("https://oauth2.googleapis.com/device/code", { scope: "openid email" });
  if (!start.ok) throw new Error(start.value.error_description || start.value.error || "device sign-in failed");
  const { device_code, user_code, verification_url, expires_in } = start.value;
  let interval = (start.value.interval || 5) * 1000;
  log(`Ask your person to open ${verification_url}, sign in with the Google account the decks are shared with, and enter: ${user_code}`);
  const deadline = Date.now() + expires_in * 1000;
  while (Date.now() < deadline) {
    await sleep(interval);
    const { ok, value } = await oauth("https://oauth2.googleapis.com/token", {
      device_code, grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    });
    if (ok) {
      save({ idToken: value.id_token, refreshToken: value.refresh_token, expiresAt: Date.now() + value.expires_in * 1000 });
      const email = JSON.parse(Buffer.from(value.id_token.split(".")[1], "base64url").toString()).email;
      log(`Signed in as ${email}.`);
      return;
    }
    if (value.error === "slow_down") interval += 5000;
    else if (value.error !== "authorization_pending") throw new Error(value.error_description || value.error);
  }
  throw new Error("the code expired; run login again");
}

async function idToken() {
  let token;
  try { token = JSON.parse(readFileSync(tokenFile, "utf8")); } catch { throw new Error("not signed in: run `node decks-agent.mjs login`"); }
  if (token.expiresAt > Date.now() + 60_000) return token.idToken;
  const { ok, value } = await oauth("https://oauth2.googleapis.com/token", { refresh_token: token.refreshToken, grant_type: "refresh_token" });
  if (!ok) throw new Error(`sign-in expired (${value.error}): run \`node decks-agent.mjs login\``);
  token = { ...token, idToken: value.id_token, expiresAt: Date.now() + value.expires_in * 1000 };
  save(token);
  return token.idToken;
}

const request = async (pathname, { body, session } = {}) => {
  const headers = { authorization: `Bearer ${await idToken()}`, "x-decks-agent-client": config.clientId };
  if (body) Object.assign(headers, { "content-type": "application/json", accept: "application/json, text/event-stream" });
  if (session) headers["mcp-session-id"] = session;
  const response = await fetch(`${config.origin}${pathname}`, { method: body ? "POST" : "GET", headers, body: body && JSON.stringify(body) });
  const text = await response.text();
  if (!response.ok) throw new Error(response.status === 403 || response.status === 404
    ? "this deck is not shared with your person's Google account" : `HTTP ${response.status}: ${text.slice(0, 200)}`);
  return { response, text };
};
const listDecks = async () => JSON.parse((await request("/agents/decks")).text).decks;
// Plain JSON API call (not MCP) for host-level operations like deck creation.
const apiJson = async (pathname, body) => {
  const response = await fetch(`${config.origin}${pathname}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${await idToken()}`, "x-decks-agent-client": config.clientId,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(value.error || `HTTP ${response.status}`);
  return value;
};

// One MCP session per deck, opened lazily.
const sessions = new Map();
const rpc = async (documentId, method, params) => {
  const endpoint = `/mcp/d/${encodeURIComponent(documentId)}`;
  if (!sessions.has(documentId)) {
    const { response } = await request(endpoint, { body: { jsonrpc: "2.0", id: 0, method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "decks-agent", version: "1" } } } });
    const session = response.headers.get("mcp-session-id") || "";
    await request(endpoint, { body: { jsonrpc: "2.0", method: "notifications/initialized" }, session });
    sessions.set(documentId, session);
  }
  const { text } = await request(endpoint, { body: { jsonrpc: "2.0", id: 1, method, params }, session: sessions.get(documentId) });
  const line = text.startsWith("{") ? text : text.split("\n").find((row) => row.startsWith("data: "))?.slice(6);
  const message = JSON.parse(line || "{}");
  if (message.error) throw new Error(message.error.message);
  return message.result;
};

const listDecksTool = {
  name: "list_decks", title: "List decks",
  description: "List the decks shared with your person's Google account, with document IDs and your role.",
  inputSchema: { type: "object", properties: {} },
};
const createDeckTool = {
  name: "create_deck", title: "Create deck",
  description: "Create a new slide deck owned by your person: a starter title slide (bilingual English + Japanese) with a private copy of the Chiba Tech theme whose guidance and tokens your person can edit freely. Returns the documentId and URLs; then use the other tools with that documentId.",
  inputSchema: { type: "object", properties: { name: { type: "string", description: "Deck name; becomes its URL slug (lowercase letters, digits, dashes)" } }, required: ["name"] },
};
const withDocument = (tool) => ({
  ...tool,
  inputSchema: {
    ...tool.inputSchema,
    properties: { documentId: { type: "string", description: "Deck document ID from list_decks" }, ...(tool.inputSchema?.properties || {}) },
    required: ["documentId", ...(tool.inputSchema?.required || [])],
  },
});

async function handle(message) {
  const { method, params = {} } = message;
  if (method === "initialize") return {
    protocolVersion: params.protocolVersion || "2025-06-18", capabilities: { tools: {} },
    serverInfo: { name: "decks", version: "1" },
    instructions: "Edit decks shared with your person. Human-edited text is protected; read before writing and pass expectedCurrent.",
  };
  if (method === "ping") return {};
  if (method === "tools/list") {
    const decks = await listDecks();
    const remote = decks.length ? (await rpc(decks[0].documentId, "tools/list", {})).tools : [];
    return { tools: [listDecksTool, createDeckTool, ...remote.map(withDocument)] };
  }
  if (method === "tools/call") {
    if (params.name === "list_decks") return { content: [{ type: "text", text: JSON.stringify(await listDecks(), null, 2) }] };
    if (params.name === "create_deck") {
      const name = params.arguments?.name;
      if (!name) throw new Error("name is required (lowercase letters, digits, dashes)");
      const value = await apiJson("/api/decks", { name });
      return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
    }
    const { documentId, ...args } = params.arguments || {};
    if (!documentId) throw new Error("documentId is required; call list_decks first");
    return rpc(documentId, "tools/call", { name: params.name, arguments: args });
  }
  throw Object.assign(new Error(`method not found: ${method}`), { code: -32601 });
}

function serve() {
  let queue = Promise.resolve();
  createInterface({ input: process.stdin }).on("line", (line) => {
    if (!line.trim()) return;
    queue = queue.then(async () => {
      const message = JSON.parse(line);
      if (message.id === undefined) return;
      try { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: await handle(message) }) + "\n"); }
      catch (error) {
        process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: error.code || -32000, message: String(error.message || error) } }) + "\n");
      }
    }).catch((error) => log(String(error.message || error)));
  });
}

// Tool calls from any shell: `call read_slide documentId=... slide=title locale=en`,
// or a single JSON object argument.
const parseArgs = (rest) => rest.length === 1 && rest[0].trim().startsWith("{") ? JSON.parse(rest[0])
  : Object.fromEntries(rest.map((pair) => {
    const i = pair.indexOf("=");
    if (i < 1) throw new Error(`expected key=value, got "${pair}"`);
    return [pair.slice(0, i), pair.slice(i + 1)];
  }));
async function callTool(name, rest) {
  if (!name) throw new Error("usage: node decks-agent.mjs call <tool> key=value ...  (see: node decks-agent.mjs tools)");
  const result = await handle({ method: "tools/call", params: { name, arguments: parseArgs(rest) } });
  process.stdout.write((result.content || []).map((part) => part.text ?? "").join("\n") + "\n");
  if (result.isError) process.exit(1);
}
async function listTools() {
  for (const tool of (await handle({ method: "tools/list" })).tools) {
    const props = tool.inputSchema?.properties || {}, required = new Set(tool.inputSchema?.required || []);
    const args = Object.keys(props).map((key) => required.has(key) ? key : `[${key}]`).join(" ");
    process.stdout.write(`${tool.name} ${args}\n  ${tool.description || ""}\n`);
  }
}

const [command, ...rest] = process.argv.slice(2);
if (!config.clientId || !config.clientSecret) { log("missing agent client configuration; download the connector from your decks service at /agents/decks-agent.mjs"); process.exit(1); }
if (!config.origin) { log("set DECKS_ORIGIN to your decks service URL (the connector downloaded from it embeds this)"); process.exit(1); }
try {
  if (command === "login") await login();
  else if (command === "decks") process.stdout.write(JSON.stringify(await listDecks(), null, 2) + "\n");
  else if (command === "token") process.stdout.write(`${await idToken()}\n`);
  else if (command === "tools") await listTools();
  else if (command === "call") await callTool(rest[0], rest.slice(1));
  else if (command === "mcp") serve();
  else { log("usage: node decks-agent.mjs login | decks | tools | call <tool> key=value ... | mcp | token"); process.exit(1); }
} catch (error) { log(String(error.message || error)); process.exit(1); }
