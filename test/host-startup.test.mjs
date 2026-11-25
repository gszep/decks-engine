import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createDeck } from "../engine/registry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const owner = { id: "local:owner@example.com", email: "owner@example.com", name: "owner", type: "human" };
const reservePort = async () => {
  const server = net.createServer();
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
};

test("an unavailable deck cannot block host startup, agent discovery or another deck", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "decks-host-startup-"));
  const theme = path.join(root, "themes", "starter");
  mkdirSync(theme, { recursive: true });
  for (const [name, content] of Object.entries({
    "theme.css": ".slide { width:1280px; height:720px; }", "tokens.css": ":root {}",
    "GUIDANCE.md": "# Test theme", "guidance.json": '{"rules":[]}',
  })) writeFileSync(path.join(theme, name), content);
  const good = createDeck({ contentRoot: root, name: "healthy", owner });
  const bad = createDeck({ contentRoot: root, name: "unavailable", owner });
  const socketDeck = createDeck({ contentRoot: root, name: "socket-first", owner });
  const badDir = path.join(root, "decks", bad.deckId);
  rmSync(path.join(badDir, "theme"), { recursive: true });
  const manifest = JSON.parse(readFileSync(path.join(badDir, "deck.json"), "utf8"));
  manifest.theme = "missing-theme";
  writeFileSync(path.join(badDir, "deck.json"), JSON.stringify(manifest));
  const port = await reservePort(), childPort = await reservePort();
  const iap = { "x-goog-authenticated-user-email": "accounts.google.com:owner@example.com", "x-goog-authenticated-user-id": "accounts.google.com:fixture-owner" };
  const child = spawn(process.execPath, ["engine/host.mjs"], {
    cwd: ROOT, env: { ...process.env, DECKS_CONTENT_ROOT: root, DECKS_HOST: "127.0.0.1",
      PORT: String(port), DECKS_CHILD_PORT_START: String(childPort), DECKS_PUBLIC_VIEW_ONLY: "false",
      DECKS_IAP_ENABLED: "true", DECKS_PUBLIC_ORIGIN: `http://127.0.0.1:${port}` },
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
  });
  let log = ""; child.stdout.on("data", data => { log += data; }); child.stderr.on("data", data => { log += data; });
  const base = `http://127.0.0.1:${port}`;
  try {
    const deadline = Date.now() + 10_000;
    let healthy = false;
    while (Date.now() < deadline && child.exitCode === null && child.signalCode === null) {
      try { healthy = (await fetch(base + "/healthz", { signal: AbortSignal.timeout(500) })).ok; } catch {}
      if (healthy) break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert(healthy, `host did not open its front door independently:\n${log}`);
    assert(!log.includes("decks design harness"), "discovery must not eagerly launch document processes");
    const discovery = await fetch(base + "/agents/decks", { headers: { authorization: "Bearer local:owner@example.com" }, signal: AbortSignal.timeout(2000) });
    assert.equal(discovery.status, 200);
    assert.equal((await discovery.json()).decks.length, 3);
    assert.equal((await fetch(base + "/agents/decks")).status, 401);

    const missing = await fetch(`${base}/d/${bad.documentId}`, { headers: iap, signal: AbortSignal.timeout(10_000) });
    assert.equal(missing.status, 503, "a failed document gets a scoped availability response");
    assert.equal((await fetch(base + "/healthz")).status, 200);
    const pages = await Promise.all(Array.from({ length: 4 }, () => fetch(`${base}/d/${good.documentId}`, { headers: iap, signal: AbortSignal.timeout(15_000) })));
    assert(pages.every(response => response.status === 200));
    assert.equal((log.match(/decks design harness — healthy/g) || []).length, 1, "concurrent requests share one child startup");
    assert.equal((await fetch(base + "/healthz")).status, 200);
    assert.equal(child.exitCode, null);
    const upgrade = await new Promise((resolve, reject) => {
      const socket = net.connect(port, "127.0.0.1"); let response = "";
      socket.setTimeout(10_000, () => { socket.destroy(); reject(new Error("cold WebSocket startup timed out")); });
      socket.on("error", reject);
      socket.on("connect", () => socket.write([
        "GET /collaboration HTTP/1.1", `Host: 127.0.0.1:${port}`, "Upgrade: websocket", "Connection: Upgrade",
        "Sec-WebSocket-Version: 13", "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==",
        `Cookie: decks_document=${socketDeck.documentId}`, ...Object.entries(iap).map(([key, value]) => `${key}: ${value}`), "", "",
      ].join("\r\n")));
      socket.on("data", chunk => { response += chunk.toString(); if (response.includes("\r\n\r\n")) { socket.destroy(); resolve(response.split("\r\n")[0]); } });
    });
    assert.match(upgrade, /^HTTP\/1\.1 101 /);
    assert.equal((log.match(/decks design harness — socket-first/g) || []).length, 1);
  } finally {
    const exited = child.exitCode === null && child.signalCode === null ? once(child, "exit") : null;
    try { process.platform === "win32" ? child.kill("SIGTERM") : process.kill(-child.pid, "SIGTERM"); } catch {}
    if (exited) await exited;
    rmSync(root, { recursive: true, force: true });
  }
});
