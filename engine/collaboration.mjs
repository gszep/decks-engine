import { Server } from "@hocuspocus/server";
import * as Y from "yjs";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const parseObject = (source, name) => {
  const match = source.match(new RegExp(`window\\.${name}\\s*=\\s*(\\{[\\s\\S]*?\\n\\});`))
    || source.match(new RegExp(`window\\.${name}\\s*=\\s*(\\{\\});`));
  try { return match ? JSON.parse(match[1]) : {}; } catch { return {}; }
};

export const parseCatalogSource = (source) => ({
  i18n: parseObject(source, "I18N"),
  meta: parseObject(source, "I18N_META"),
});

const sorted = (value) => Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));

export const serializeCatalog = (locale, deckId, i18n, meta) =>
  `// ${locale} strings for ${deckId} — keys match data-i18n attributes in slides/*.html.\n` +
  `// I18N_META records provenance per key: { modified, author } — author absent ⇒ agent edit.\n` +
  `window.I18N = ${JSON.stringify(sorted(i18n), null, 2)};\n` +
  `window.I18N_META = ${JSON.stringify(sorted(meta), null, 2)};\n`;

const atomicWrite = (file, data) => {
  mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  writeFileSync(temporary, data);
  renameSync(temporary, file);
};

const addText = (map, key, value) => {
  const text = new Y.Text();
  if (value) text.insert(0, value);
  map.set(key, text);
};

// Register an asset file created after the collaboration document was
// initialized (e.g. a new guidance file added from the editor).
export const addAsset = (document, relative, value) => addText(document.getMap("assets"), relative, value);

const replaceText = (text, value) => {
  const current = text.toString();
  if (current === value) return;
  let start = 0;
  while (start < current.length && start < value.length && current[start] === value[start]) start++;
  let oldEnd = current.length, newEnd = value.length;
  while (oldEnd > start && newEnd > start && current[oldEnd - 1] === value[newEnd - 1]) { oldEnd--; newEnd--; }
  if (oldEnd > start) text.delete(start, oldEnd - start);
  if (newEnd > start) text.insert(start, value.slice(start, newEnd));
};

export function initializeDeckDocument(document, { deckDir, deckId, locales, assetFiles }) {
  const catalogs = document.getMap("catalogs");
  const metadata = document.getMap("catalogMeta");
  const assets = document.getMap("assets");

  for (const locale of locales) {
    const file = path.join(deckDir, "slides", "i18n", `${locale}.js`);
    const catalog = parseCatalogSource(readFileSync(file, "utf8"));
    for (const [key, value] of Object.entries(catalog.i18n)) addText(catalogs, `${locale}:${key}`, value);
    for (const [key, value] of Object.entries(catalog.meta)) metadata.set(`${locale}:${key}`, value);
  }
  for (const [relative, absolute] of assetFiles) addText(assets, relative, readFileSync(absolute, "utf8"));
}

export function importSourceFile(document, { relative, source, deckId, locales }) {
  const catalogMatch = relative.match(new RegExp(`^decks/${deckId}/slides/i18n/([^/]+)\\.js$`));
  if (catalogMatch && locales.includes(catalogMatch[1])) {
    const locale = catalogMatch[1], parsed = parseCatalogSource(source);
    const catalogs = document.getMap("catalogs"), metadata = document.getMap("catalogMeta");
    document.transact(() => {
      const prefix = `${locale}:`;
      for (const key of [...catalogs.keys()].filter((key) => key.startsWith(prefix) && !(key.slice(prefix.length) in parsed.i18n))) catalogs.delete(key);
      for (const [key, value] of Object.entries(parsed.i18n)) {
        const compound = `${locale}:${key}`, text = catalogs.get(compound);
        if (text) replaceText(text, value); else addText(catalogs, compound, value);
      }
      for (const key of [...metadata.keys()].filter((key) => key.startsWith(prefix) && !(key.slice(prefix.length) in parsed.meta))) metadata.delete(key);
      for (const [key, value] of Object.entries(parsed.meta)) {
        const compound = `${locale}:${key}`;
        if (JSON.stringify(metadata.get(compound)) !== JSON.stringify(value)) metadata.set(compound, value);
      }
    }, "filesystem");
    return true;
  }
  const asset = document.getMap("assets").get(relative);
  if (!asset) return false;
  document.transact(() => replaceText(asset, source), "filesystem");
  return true;
}

export function materializeDeckDocument(document, { deckDir, deckId, locales, assetFiles, write }) {
  const catalogs = document.getMap("catalogs");
  const metadata = document.getMap("catalogMeta");
  const assets = document.getMap("assets");
  let changed = false, assetsChanged = false, catalogsChanged = false;

  for (const locale of locales) {
    const i18n = {}, meta = {};
    for (const [compound, value] of catalogs) {
      if (compound.startsWith(`${locale}:`)) i18n[compound.slice(locale.length + 1)] = value.toString();
    }
    for (const [compound, value] of metadata) {
      if (compound.startsWith(`${locale}:`)) meta[compound.slice(locale.length + 1)] = value;
    }
    const catalogChanged = write(path.join(deckDir, "slides", "i18n", `${locale}.js`), serializeCatalog(locale, deckId, i18n, meta));
    changed = catalogChanged || changed;
    catalogsChanged = catalogChanged || catalogsChanged;
  }
  for (const [relative, absolute] of assetFiles) {
    const value = assets.get(relative);
    if (!value) continue;
    const assetChanged = write(absolute, value.toString());
    changed = assetChanged || changed;
    assetsChanged = assetChanged || assetsChanged;
  }
  return { changed, assetsChanged, catalogsChanged };
}

export async function createCollaborationServer({
  port, host = "127.0.0.1", deckDir, deckId, documentId = deckId, locales, assetFiles, stateFile, write,
  onMaterialize, httpHandler = null, websocketPath = null, authenticateConnection = null,
  debounce = 120, maxDebounce = 1000,
}) {
  const server = new Server({
    port,
    address: host,
    quiet: true,
    stopOnSignals: false,
    debounce,
    maxDebounce,
    websocketOptions: { maxPayload: 1024 * 1024 },
    maxUnauthenticatedQueueSize: 1024 * 1024,
    maxUnauthenticatedQueueMessages: 200,
    maxPendingDocuments: 1,
    async onRequest({ request, response }) {
      if (!httpHandler) return;
      await httpHandler(request, response);
      throw null;
    },
    async onUpgrade({ request, socket }) {
      if (!websocketPath || new URL(request.url || "/", "http://localhost").pathname === websocketPath) return;
      socket.destroy();
      throw null;
    },
    async onAuthenticate({ documentName, token, request }) {
      if (documentName !== documentId) throw new Error("unknown document");
      if (authenticateConnection) return authenticateConnection(request, token);
      let profile = {};
      try { profile = JSON.parse(token || "{}"); } catch {}
      const name = typeof profile.name === "string" ? profile.name.slice(0, 80) : "designer";
      return { name, kind: profile.kind === "agent" ? "agent" : "human" };
    },
    beforeHandleAwareness({ states, context }) {
      for (const state of states.values()) {
        state.user = { ...(state.user || {}), name: context?.name || "designer", kind: context?.kind || "human" };
      }
    },
    onLoadDocument({ document }) {
      if (!existsSync(stateFile)) initializeDeckDocument(document, { deckDir, deckId, locales, assetFiles });
      else {
        Y.applyUpdate(document, readFileSync(stateFile));
        for (const locale of locales) {
          const relative = `decks/${deckId}/slides/i18n/${locale}.js`;
          importSourceFile(document, {
            relative, source: readFileSync(path.join(deckDir, "slides", "i18n", `${locale}.js`), "utf8"), deckId, locales,
          });
        }
        for (const [relative, absolute] of assetFiles)
          importSourceFile(document, { relative, source: readFileSync(absolute, "utf8"), deckId, locales });
      }
      // Persist load-time edits now. Otherwise the next cold start replays them as
      // fresh operations, and a client still holding the previous ones merges both
      // copies, duplicating the imported text.
      atomicWrite(stateFile, Y.encodeStateAsUpdate(document));
    },
    async onStoreDocument({ document, lastContext, lastTransactionOrigin }) {
      atomicWrite(stateFile, Y.encodeStateAsUpdate(document));
      const author = lastTransactionOrigin === "filesystem" ? "" : lastContext?.name || "";
      const result = materializeDeckDocument(document, {
        deckDir, deckId, locales, assetFiles,
        write: (file, content) => write(file, content, author),
      });
      if (result.changed) onMaterialize?.(result);
    },
  });
  await server.listen();
  return server;
}
