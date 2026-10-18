import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import {
  createCollaborationServer, importSourceFile, initializeDeckDocument, materializeDeckDocument, parseCatalogSource,
} from "../engine/collaboration.mjs";

const catalog = (locale, value) => `window.I18N = {\n  "title.h1": ${JSON.stringify(value)}\n};\nwindow.I18N_META = {};\n`;
const waitFor = async (check, timeout = 4000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail("condition did not converge");
};

function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "decks-collab-"));
  const deckDir = path.join(root, "deck");
  const i18n = path.join(deckDir, "slides", "i18n");
  mkdirSync(i18n, { recursive: true });
  writeFileSync(path.join(i18n, "en.js"), catalog("en", "Hello"));
  writeFileSync(path.join(i18n, "ja.js"), catalog("ja", "こんにちは"));
  const css = path.join(deckDir, "slides", "deck.css");
  writeFileSync(css, ".slide { color: black; }\n");
  return { root, deckDir, css, assets: [["decks/test/slides/deck.css", css]] };
}

test("materializes catalog and asset shared types", () => {
  const f = fixture();
  try {
    const document = new Y.Doc();
    initializeDeckDocument(document, { deckDir: f.deckDir, deckId: "test", locales: ["en", "ja"], assetFiles: f.assets });
    document.getMap("catalogs").get("en:title.h1").insert(5, " together");
    document.getMap("assets").get("decks/test/slides/deck.css").insert(0, "/* shared */\n");
    importSourceFile(document, {
      relative: "decks/test/slides/i18n/ja.js", source: catalog("ja", "外部編集"), deckId: "test", locales: ["en", "ja"],
    });
    materializeDeckDocument(document, {
      deckDir: f.deckDir, deckId: "test", locales: ["en", "ja"], assetFiles: f.assets,
      write(file, content) { const before = readFileSync(file, "utf8"); if (before === content) return false; writeFileSync(file, content); return true; },
    });
    assert.equal(parseCatalogSource(readFileSync(path.join(f.deckDir, "slides/i18n/en.js"), "utf8")).i18n["title.h1"], "Hello together");
    assert.match(readFileSync(f.css, "utf8"), /^\/\* shared \*\//);
    assert.equal(parseCatalogSource(readFileSync(path.join(f.deckDir, "slides/i18n/ja.js"), "utf8")).i18n["title.h1"], "外部編集");
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("a client that outlives two cold starts does not duplicate imported text", async () => {
  const f = fixture();
  const stateFile = path.join(f.deckDir, ".history", "collaboration.bin");
  const options = {
    deckDir: f.deckDir, deckId: "test", locales: ["en", "ja"], assetFiles: f.assets, stateFile, port: 0,
    write(file, content) { const before = readFileSync(file, "utf8"); if (before === content) return false; writeFileSync(file, content); return true; },
  };
  const document = new Y.Doc();
  const connect = async (server) => {
    const provider = new HocuspocusProvider({ url: `ws://127.0.0.1:${server.address.port}`, name: "test", document, token: '{"name":"Alice"}' });
    await new Promise((resolve) => provider.on("synced", ({ state }) => state && resolve()));
    return provider;
  };
  let server, provider;
  try {
    server = await createCollaborationServer(options);
    provider = await connect(server);
    provider.destroy(); await server.destroy();
    writeFileSync(path.join(f.deckDir, "slides/i18n/en.js"), catalog("en", "Hello, resynced"));
    for (let start = 0; start < 2; start++) {
      server = await createCollaborationServer(options);
      provider = await connect(server);
      await new Promise((resolve) => setTimeout(resolve, 100));
      assert.equal(document.getMap("catalogs").get("en:title.h1").toString(), "Hello, resynced");
      provider.destroy(); provider = null;
      await server.destroy(); server = null;
    }
  } finally {
    provider?.destroy();
    await server?.destroy();
    rmSync(f.root, { recursive: true, force: true });
  }
});

test("restores collaboration and imports source edits made while stopped", async () => {
  const f = fixture();
  const stateFile = path.join(f.deckDir, ".history", "collaboration.bin");
  const options = {
    deckDir: f.deckDir, deckId: "test", locales: ["en", "ja"], assetFiles: f.assets, stateFile,
    write(file, content) { const before = readFileSync(file, "utf8"); if (before === content) return false; writeFileSync(file, content); return true; },
  };
  let server, provider;
  try {
    server = await createCollaborationServer({ ...options, port: 0 });
    const document = new Y.Doc();
    provider = new HocuspocusProvider({ url: `ws://127.0.0.1:${server.address.port}`, name: "test", document, token: '{"name":"Alice"}' });
    await new Promise((resolve) => provider.on("synced", ({ state }) => state && resolve()));
    const text = document.getMap("catalogs").get("en:title.h1");
    text.insert(text.length, " world");
    await waitFor(() => parseCatalogSource(readFileSync(path.join(f.deckDir, "slides/i18n/en.js"), "utf8")).i18n["title.h1"] === "Hello world");
    provider.destroy(); provider = null;
    await server.destroy(); server = null;
    writeFileSync(path.join(f.deckDir, "slides/i18n/en.js"), catalog("en", "Edited while stopped"));

    server = await createCollaborationServer({ ...options, port: 0 });
    const restored = new Y.Doc();
    provider = new HocuspocusProvider({ url: `ws://127.0.0.1:${server.address.port}`, name: "test", document: restored, token: '{"name":"Bob"}' });
    await new Promise((resolve) => provider.on("synced", ({ state }) => state && resolve()));
    assert.equal(restored.getMap("catalogs").get("en:title.h1").toString(), "Edited while stopped");
  } finally {
    provider?.destroy();
    await server?.destroy();
    rmSync(f.root, { recursive: true, force: true });
  }
});
