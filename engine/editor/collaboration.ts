import * as Y from "yjs";
import { HocuspocusProvider } from "@hocuspocus/provider";
import { MonacoBinding } from "y-monaco";

const palette = ["#2c40d3", "#db23dd", "#008f7a", "#d85a00", "#8b5cf6", "#c0263d"];

function replaceText(text: Y.Text, next: string) {
  const current = text.toString();
  if (current === next) return false;
  let start = 0;
  while (start < current.length && start < next.length && current[start] === next[start]) start++;
  let oldEnd = current.length, newEnd = next.length;
  while (oldEnd > start && newEnd > start && current[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd--; }
  text.doc?.transact(() => {
    if (oldEnd > start) text.delete(start, oldEnd - start);
    if (newEnd > start) text.insert(start, next.slice(start, newEnd));
  }, "editor");
  return true;
}

export function connect(options: any) {
  const document = new Y.Doc();
  const provider = new HocuspocusProvider({
    url: options.url,
    name: options.deckId,
    document,
    token: JSON.stringify({ name: options.name, kind: options.kind || "human" }),
    onStatus: ({ status }: any) => options.onStatus?.(status),
  });
  const catalogs = document.getMap<Y.Text>("catalogs");
  const metadata = document.getMap("catalogMeta");
  const assets = document.getMap<Y.Text>("assets");
  const undoManager = new Y.UndoManager([catalogs], { trackedOrigins: new Set(["editor"]) });
  const color = palette[document.clientID % palette.length];
  let resolveReady: () => void;
  const ready = new Promise<void>((resolve) => { resolveReady = resolve; });

  provider.on("synced", ({ state }: any) => {
    if (!state) return;
    resolveReady();
    options.onCatalogs?.();
    options.onStatus?.("synced");
  });
  catalogs.observeDeep(() => options.onCatalogs?.());
  provider.awareness?.on("change", () => options.onPresence?.(provider.awareness?.getStates()));
  provider.setAwarenessField("user", { name: options.name, kind: options.kind || "human", color });

  return {
    document,
    provider,
    ready,
    color,
    beginTextEdit() { undoManager.stopCapturing(); undoManager.captureTimeout = Infinity; },
    endTextEdit() { undoManager.stopCapturing(); undoManager.captureTimeout = 500; },
    getCatalog(locale: string, key: string) {
      return catalogs.get(`${locale}:${key}`)?.toString();
    },
    setCatalog(locale: string, key: string, value: string, author: string) {
      const compound = `${locale}:${key}`;
      const text = catalogs.get(compound);
      if (!text || !replaceText(text, value)) return false;
      metadata.set(compound, { modified: new Date().toISOString().replace(/\.\d{3}/, ""), author });
      return true;
    },
    setPresence(state: any) {
      provider.setAwarenessField("location", state);
    },
    async bindMonaco(file: string, model: any, editor: any) {
      await ready;
      const text = assets.get(file);
      if (!text) throw new Error(`asset is not collaborative: ${file}`);
      const binding = new MonacoBinding(text, model, new Set([editor]), provider.awareness);
      undoManager.addToScope(text);
      undoManager.trackedOrigins.add(binding);
      return binding;
    },
    undo(locale: string, key: string, author: string) {
      undoManager.undo();
      metadata.set(`${locale}:${key}`, { modified: new Date().toISOString().replace(/\.\d{3}/, ""), author });
    },
    redo(locale: string, key: string, author: string) {
      undoManager.redo();
      metadata.set(`${locale}:${key}`, { modified: new Date().toISOString().replace(/\.\d{3}/, ""), author });
    },
    destroy() {
      undoManager.destroy();
      provider.destroy();
      document.destroy();
    },
  };
}
