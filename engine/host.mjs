#!/usr/bin/env node
// Multi-document front door for hosted Decks.
//
// Discovers every manifest under DECKS_CONTENT_ROOT/decks, starts one isolated
// edit.mjs process per document, and routes friendly /d/<documentId> viewer URLs
// plus the existing /presentation/d/<documentId> editor URLs. The root is a
// read-only index. Per-document child processes keep ACLs, Yjs state and source
// materialisation isolated exactly as in the single-deck server.
import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createAccessController } from "./access.mjs";
import { createAuthenticator } from "./auth.mjs";
import { createDeck } from "./registry.mjs";

// ENGINE_ROOT: the engine program (this checkout). CONTENT_ROOT: decks/,
// themes/ and tools/ — a mountable content tree, defaulting to the engine
// checkout for development.
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT_ROOT = path.resolve(process.env.DECKS_CONTENT_ROOT || ROOT);
const HOST = process.env.DECKS_HOST || "0.0.0.0";
const PORT = Number(process.env.PORT || 8000);
const CHILD_PORT_START = Number(process.env.DECKS_CHILD_PORT_START || 9100);
const deckRoot = path.join(CONTENT_ROOT, "decks");
const PUBLIC_VIEW_ONLY = process.env.DECKS_PUBLIC_VIEW_ONLY === "true";
const SITE = (process.env.DECKS_PUBLIC_ORIGIN || "").replace(/^https?:\/\//, "").replace(/\/$/, "") || "decks";
const escapeHtml = (value) => String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const byDocument = new Map();
const byDeck = new Map();
const decks = [];
const discoverDeck = (deckId) => {
  const file = path.join(deckRoot, deckId, "deck.json");
  if (!existsSync(file) || byDeck.has(deckId)) return null;
  try {
    const manifest = JSON.parse(readFileSync(file, "utf8"));
    if (!/^[A-Za-z0-9_-]{12,128}$/.test(manifest.documentId || "")) return null;
    if (byDocument.has(manifest.documentId)) {
      console.error(`skipping ${deckId}: documentId ${manifest.documentId} is already served`);
      return null;
    }
    // A public view-only host serves only decks whose manifest opts in.
    if (PUBLIC_VIEW_ONLY && manifest.public !== true) return null;
    return { deckId, documentId: manifest.documentId, manifest, port: 0, child: null };
  } catch { return null; }
};
for (const entry of readdirSync(deckRoot).map(discoverDeck)) {
  if (entry) { decks.push(entry); byDocument.set(entry.documentId, entry); byDeck.set(entry.deckId, entry); }
}
decks.sort((a, b) => String(a.manifest.name).localeCompare(String(b.manifest.name)));

if (!decks.length) {
  console.error(`no deck manifests under ${deckRoot}`);
  process.exit(1);
}
const preferred = byDocument.get(process.env.DECKS_DOCUMENT) || byDeck.get(process.env.DECKS_DOCUMENT) || decks[0];
let stopping = false;

const waitForPort = (port) => new Promise((resolve, reject) => {
  const deadline = Date.now() + 60_000;
  const attempt = () => {
    const socket = net.connect(port, "127.0.0.1");
    socket.once("connect", () => { socket.destroy(); resolve(); });
    socket.once("error", () => {
      socket.destroy();
      if (Date.now() >= deadline) reject(new Error(`child on ${port} did not start`));
      else setTimeout(attempt, 100);
    });
  };
  attempt();
});

let nextPort = CHILD_PORT_START;
const startDeck = async (deck) => {
  deck.port = nextPort++;
  deck.child = spawn(process.execPath, [path.join(ROOT, "engine", "edit.mjs"), deck.documentId, "--host", "0.0.0.0", "--port", String(deck.port)], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(deck.port), DECKS_DOCUMENT: deck.documentId },
    stdio: ["ignore", "inherit", "inherit"],
  });
  deck.child.once("exit", (code, signal) => {
    if (!stopping) {
      console.error(`deck child ${deck.deckId} exited (${code ?? signal})`);
      process.kill(process.pid, "SIGTERM");
    }
  });
  await waitForPort(deck.port);
};

// Pick up decks added out-of-band (bucket seeds, API-created documents) and
// start an isolated child for each new manifest.
const rescan = async () => {
  const fresh = readdirSync(deckRoot).map(discoverDeck).filter(Boolean);
  if (!fresh.length) return;
  for (const deck of fresh) { decks.push(deck); byDocument.set(deck.documentId, deck); byDeck.set(deck.deckId, deck); }
  decks.sort((a, b) => String(a.manifest.name).localeCompare(String(b.manifest.name)));
  console.log(`discovered ${fresh.length} new deck(s): ${fresh.map((deck) => deck.deckId).join(", ")}`);
  await Promise.all(fresh.map(startDeck));
};

await Promise.all(decks.map(startDeck));

const documentFromPath = (pathname) => {
  const match = pathname.match(/^\/(?:d|presentation\/d|mcp\/d)\/([A-Za-z0-9_-]{12,128})(?:\/|$)/);
  return match && byDocument.get(match[1]);
};
const documentFromReferer = (req) => {
  try { return documentFromPath(new URL(req.headers.referer || "").pathname); } catch { return null; }
};
const documentFromCookie = (req) => {
  const match = String(req.headers.cookie || "").match(/(?:^|;\s*)decks_document=([^;]+)/);
  return match && byDocument.get(decodeURIComponent(match[1]));
};
const routeDeck = (req, pathname) => {
  const explicit = documentFromPath(pathname);
  if (explicit) return explicit;
  const asset = pathname.match(/^\/decks\/([^/]+)\//);
  if (asset && byDeck.has(asset[1])) return byDeck.get(asset[1]);
  return documentFromReferer(req) || documentFromCookie(req) || preferred;
};

const indexHtml = (canCreate = false) => `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Decks</title><style>
*{box-sizing:border-box}body{margin:0;background:#f4f4f4;color:#000;font:16px/1.4 Arial,sans-serif}main{max-width:1100px;margin:auto;padding:64px 32px}h1{margin:0 0 10px;font-size:72px;line-height:.85;letter-spacing:-.06em}header{border-top:3px solid #000;padding-top:12px;margin-bottom:52px}header p{max-width:620px;color:#555}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(300px,1fr));gap:18px}a{display:flex;min-height:190px;padding:24px;border:3px solid #000;background:#fff;color:#000;text-decoration:none;flex-direction:column}a:hover{background:#000;color:#fff}a b{font-size:30px;line-height:1;letter-spacing:-.04em}a span{margin-top:auto;font:12px monospace;text-transform:uppercase}footer{margin-top:48px;border-top:3px solid #000;padding-top:10px;font:12px monospace}
#newdeck{margin:0 0 40px;display:flex;gap:12px;max-width:620px}#newdeck input{flex:1;padding:12px 14px;border:3px solid #000;background:#fff;font:inherit}#newdeck button{padding:12px 20px;border:3px solid #000;background:#000;color:#fff;font:700 14px/1 Arial,sans-serif;letter-spacing:.04em;text-transform:uppercase;cursor:pointer}#newdeck button:hover{background:#fff;color:#000}#newdeck .err{color:#000;background:#ffe3e2;border:3px solid #000;padding:8px 12px;display:none}
</style></head><body><main><header><h1>Decks</h1><p>Presentations built from ordinary HTML, shared as durable documents.</p></header>
${canCreate ? `<form id="newdeck"><input name="name" placeholder="my-new-deck" aria-label="New deck name" autocomplete="off" required><button type="submit">New deck</button><span class="err" id="newdeckerr"></span></form>` : ""}
<section class="grid">${decks.map((deck) => `<a href="/d/${encodeURIComponent(deck.documentId)}"><b>${escapeHtml(deckTitle(deck))}</b><span>${deck.manifest.slides?.length || 0} slides · ${escapeHtml((deck.manifest.locales || [deck.manifest.defaultLocale || "en"]).join(" / "))}</span></a>`).join("")}</section><footer>${escapeHtml(SITE)} · HTML is ground truth</footer></main>
${canCreate ? `<script>
document.getElementById("newdeck").addEventListener("submit", async (event) => {
  event.preventDefault();
  const input = event.target.elements.name, err = document.getElementById("newdeckerr");
  err.style.display = "none";
  const response = await fetch("/api/decks", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: input.value }) });
  const result = await response.json().catch(() => ({}));
  if (!response.ok) { err.textContent = result.error || "could not create the deck"; err.style.display = "inline-block"; return; }
  location.assign("/d/" + encodeURIComponent(result.documentId));
});
</script>` : ""}
</body></html>`;

const proxyHttp = (req, res, deck, targetPath, setDocumentCookie = false) => {
  const headers = { ...req.headers, host: `127.0.0.1:${deck.port}` };
  const upstream = httpRequest({ host: "127.0.0.1", port: deck.port, method: req.method, path: targetPath, headers }, (incoming) => {
    const outgoing = { ...incoming.headers };
    if (setDocumentCookie) {
      const cookie = `decks_document=${encodeURIComponent(deck.documentId)}; Path=/; HttpOnly; SameSite=Lax`;
      outgoing["set-cookie"] = [...(Array.isArray(outgoing["set-cookie"]) ? outgoing["set-cookie"] : outgoing["set-cookie"] ? [outgoing["set-cookie"]] : []), cookie];
    }
    res.writeHead(incoming.statusCode || 502, outgoing);
    incoming.pipe(res);
  });
  upstream.on("error", (error) => {
    if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(`deck unavailable: ${error.message}`);
  });
  req.pipe(upstream);
};

// Agent onboarding: public instructions and connector, and (private host only)
// the decks an agent's signed-in person can reach.
const authenticator = PUBLIC_VIEW_ONLY ? null : await createAuthenticator({
  publicOrigin: (process.env.DECKS_PUBLIC_ORIGIN || "").replace(/\/$/, ""), local: HOST === "127.0.0.1" || HOST === "localhost",
});
const accessFor = (deck) => createAccessController({
  file: path.join(deckRoot, deck.deckId, ".history", "access.json"), documentId: deck.documentId,
  bootstrapOwner: process.env.DECKS_BOOTSTRAP_OWNER || "", privateOnly: process.env.DECKS_PRIVATE_DOGFOOD === "true",
});
const deckTitle = (deck) => {
  try { return JSON.parse(readFileSync(path.join(deckRoot, deck.deckId, ".history", "document.json"), "utf8")).title; }
  catch { return String(deck.manifest.name || deck.deckId).replaceAll("_", " "); }
};
const serveAgents = async (req, res, url) => {
  const onAgentsHost = String(req.headers.host || "").startsWith("agents.");
  if (url.pathname === "/agents" || url.pathname === "/agents/" || (onAgentsHost && url.pathname === "/")) {
    res.writeHead(200, { "content-type": "text/markdown; charset=utf-8", "cache-control": "no-store" });
    res.end(readFileSync(path.join(ROOT, "engine", "agents.md"), "utf8")); return true;
  }
  if (url.pathname === "/agents/decks-agent.mjs") {
    if (!process.env.DECKS_AGENT_CLIENT_ID || !process.env.DECKS_AGENT_CLIENT_SECRET) { res.writeHead(503); res.end("agent sign-in not configured"); return true; }
    const embedded = JSON.stringify({
      origin: process.env.DECKS_PRIVATE_ORIGIN || process.env.DECKS_PUBLIC_ORIGIN || "",
      clientId: process.env.DECKS_AGENT_CLIENT_ID, clientSecret: process.env.DECKS_AGENT_CLIENT_SECRET,
    });
    res.writeHead(200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-store" });
    res.end(readFileSync(path.join(ROOT, "engine", "agent.mjs"), "utf8").replace("const EMBEDDED = {};", `const EMBEDDED = ${embedded};`));
    return true;
  }
  if (url.pathname === "/agents/decks" && authenticator) {
    let agent = null;
    try { agent = await authenticator.bearerPrincipal(req); } catch {}
    if (!agent) { res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "signed-in agent required" })); return true; }
    const reachable = decks.flatMap((deck) => {
      const role = accessFor(deck).role(agent);
      return role ? [{ documentId: deck.documentId, title: deckTitle(deck), role }] : [];
    });
    res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ decks: reachable })); return true;
  }
  return false;
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  if (req.method === "GET" && url.pathname.startsWith("/agents") || (req.method === "GET" && url.pathname === "/" && String(req.headers.host || "").startsWith("agents."))) {
    try { if (await serveAgents(req, res, url)) return; }
    catch (error) { if (!res.headersSent) res.writeHead(500); res.end(String(error.message || error)); return; }
  }
  if (req.method === "GET" && url.pathname === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ ok: true, documents: decks.length })); return;
  }
  if (req.method === "GET" && url.pathname === "/") {
    const identity = authenticator?.principal(req);
    res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
    res.end(indexHtml(!PUBLIC_VIEW_ONLY && identity?.type === "human")); return;
  }

  // Create a deck: any signed-in human (or an agent acting for one) may create
  // a document they own. The deck gets a private copy of the theme, i18n-mode
  // en+ja catalogs, and an access.json naming its owner — nobody else.
  if (req.method === "POST" && url.pathname === "/api/decks") {
    if (PUBLIC_VIEW_ONLY) { res.writeHead(403, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "deck creation is disabled on public view-only hosts" })); return; }
    let ownerPrincipal = authenticator.principal(req);
    if (ownerPrincipal?.type !== "human") {
      try {
        const agent = await authenticator.bearerPrincipal(req);
        if (agent?.type === "agent" && agent.delegatedPrincipalId && agent.email)
          ownerPrincipal = { id: agent.delegatedPrincipalId, email: agent.email, name: agent.email.split("@")[0], type: "human" };
      } catch {}
    }
    if (!ownerPrincipal || ownerPrincipal.type !== "human") {
      res.writeHead(401, { "content-type": "application/json" }); res.end(JSON.stringify({ error: "sign-in required" })); return;
    }
    try { authenticator.assertOrigin(req); } catch (error) {
      res.writeHead(error.statusCode || 403, { "content-type": "application/json" }); res.end(JSON.stringify({ error: String(error.message || error) })); return;
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    let body = {};
    try { body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"); } catch {}
    try {
      const created = createDeck({ contentRoot: CONTENT_ROOT, name: body.name, owner: ownerPrincipal });
      await rescan();
      const deck = byDeck.get(created.deckId);
      console.log(`created deck ${created.deckId} (${created.documentId}) for ${ownerPrincipal.email || ownerPrincipal.name}`);
      res.writeHead(201, { "content-type": "application/json" });
      res.end(JSON.stringify({
        deckId: created.deckId, documentId: created.documentId, port: deck?.port,
        presentation: `/d/${created.documentId}`, editor: `/presentation/d/${created.documentId}`,
      }));
    } catch (error) {
      res.writeHead(400, { "content-type": "application/json" }); res.end(JSON.stringify({ error: String(error.message || error) }));
    }
    return;
  }
  const explicit = documentFromPath(url.pathname);
  if (/^\/(?:d|presentation\/d|mcp\/d)\//.test(url.pathname) && !explicit) {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" }); res.end("Unknown deck"); return;
  }
  if (url.pathname === "/mcp" && decks.length > 1) {
    res.writeHead(400, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: "document-specific MCP endpoint required: /mcp/d/<documentId>" })); return;
  }
  const deck = routeDeck(req, url.pathname);
  let target = req.url;
  let setCookie = false;
  if (url.pathname === `/d/${deck.documentId}` || url.pathname === `/d/${deck.documentId}/`) {
    const query = new URLSearchParams(url.searchParams); query.set("mode", "present");
    target = `/presentation/d/${deck.documentId}?${query}`; setCookie = true;
  } else if (url.pathname === `/presentation/d/${deck.documentId}`) setCookie = true;
  proxyHttp(req, res, deck, target, setCookie);
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const deck = routeDeck(req, url.pathname);
  const upstream = net.connect(deck.port, "127.0.0.1", () => {
    const headers = Object.entries({ ...req.headers, host: `127.0.0.1:${deck.port}` }).map(([key, value]) => `${key}: ${value}`).join("\r\n");
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n${headers}\r\n\r\n`);
    if (head.length) upstream.write(head);
    socket.pipe(upstream).pipe(socket);
  });
  upstream.on("error", () => socket.destroy());
});

await new Promise((resolve) => server.listen(PORT, HOST, resolve));
console.log(`decks host → ${process.env.DECKS_PUBLIC_ORIGIN || `http://${HOST}:${PORT}`} (${decks.length} documents)`);
for (const deck of decks) console.log(`  /d/${deck.documentId} → ${deck.deckId}`);

const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  server.close();
  for (const deck of decks) deck.child?.kill("SIGTERM");
  await Promise.all(decks.map((deck) => new Promise((resolve) => deck.child?.once("exit", resolve) || resolve())));
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
