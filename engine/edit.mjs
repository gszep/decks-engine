#!/usr/bin/env node
// decks design harness — WYSIWYG editor server for a deck's HTML slides.
//
// Serves the repo statically plus a Figma-like editor shell that loads each
// slide (the REAL slide HTML + theme CSS, pixel-identical to the PDF render)
// in a 1280x720 iframe. Designer edits are written straight back to the slide
// HTML files — HTML stays the ground truth. No npm dependencies.
//
//   node engine/edit.mjs <deck> [--port 8000]     # open http://localhost:8000/edit
//
// API:
//   GET  /edit        editor shell
//   GET  /api/deck    { deckId, manifest, owner, cssFiles, themeFiles }
//   POST /api/save    { file, html, author }      write a slide file (path-checked)
//   POST /api/slides  { name, from? }             create a slide (blank or a copy)
//   POST /api/asset   { file, text, author }      write a design-harness asset
//                     (theme md/json/css or deck css — the designer's escape
//                     hatch: rules and tokens are editable from the UI)
//   POST /api/lint/markdown { file, text }         markdownlint diagnostics
//   GET  /vendor/monaco/vs/*                       local Monaco runtime/workers
//   GET  /api/i18n?locale=ja                      parsed catalog { i18n, meta }
//   POST /api/i18n    { locale, entries, meta, author }  merge keys into the catalog
//   GET  /api/tools                               tool files in engine/editor/tools/
//   GET  /api/history?file=<rel>                  journal entries for a file (newest first)
//   POST /api/revert  { id, author }              restore a journal entry's "after" state
//   GET  /api/events                              SSE: tools | editor | guidance | slide
//
// Provenance contract (see AGENTS.md):
//   data-author + data-modified are written ONLY by this harness — in-file
//   authorship means "a human finalized this; agents may not revert it".
//   Everything else (agent CLIs, hand edits) is authorless in-file; git
//   attributes it. The journal (decks/<deck>/.history/, gitignored) is local
//   working memory for undo/redo and person/date revert — git is the durable
//   history.
//
// Live bridge: fs.watch on slides/ journals *external* edits (agents working
// from a CLI) and pushes them to open editors over SSE — the designer sees
// agent edits land on the canvas live, and can revert them from the history
// panel. Tools (engine/editor/tools/*.js) and theme guidance hot-reload the
// same way.
import { createServer } from "node:http";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync, readFileSync, writeFileSync, renameSync, mkdirSync, readdirSync, watch, statSync, unlinkSync,
} from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { createCollaborationServer, importSourceFile, parseCatalogSource, addAsset } from "./collaboration.mjs";
import { createAuthenticator } from "./auth.mjs";
import { createAccessController } from "./access.mjs";
import { createDeckMcp, serveMcp } from "./mcp.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The engine (this checkout) and the content (decks/, themes/, tools/) are
// separable: hosting mounts DECKS_CONTENT_ROOT while the engine stays a
// versioned, deck-agnostic program. Everything content-side resolves through
// CONTENT_ROOT; everything engine-side (editor shell, Monaco, i18n runtime)
// through ROOT.
const ENGINE_ROOT = ROOT;
const CONTENT_ROOT = path.resolve(process.env.DECKS_CONTENT_ROOT || ENGINE_ROOT);
const require = createRequire(import.meta.url);
// Public view-only hosting: presentation and slide assets only, never writes to
// the content root, optionally behind a shared view password.
const PUBLIC_VIEW_ONLY = process.env.DECKS_PUBLIC_VIEW_ONLY === "true";
const VIEW_PASSWORD = PUBLIC_VIEW_ONLY ? process.env.DECKS_VIEW_PASSWORD || "" : "";

// ---- CLI ----
const args = process.argv.slice(2);
const selector = args[0] || process.env.DECKS_DOCUMENT;
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const HOST = flag("host") || process.env.DECKS_HOST || "127.0.0.1";
const PORT = Number(flag("port") || process.env.PORT || 8000);
if (!selector) {
  console.error("usage: node engine/edit.mjs <deck-or-document-id> [--host 127.0.0.1] [--port 8000]");
  process.exit(1);
}
const deckRoot = path.join(CONTENT_ROOT, "decks");
const directDeck = path.join(deckRoot, selector);
const deckId = existsSync(path.join(directDeck, "deck.json")) ? selector : readdirSync(deckRoot)
  .find((candidate) => {
    const file = path.join(deckRoot, candidate, "deck.json");
    if (!existsSync(file)) return false;
    try { return JSON.parse(readFileSync(file, "utf8")).documentId === selector; } catch { return false; }
  });
if (!deckId) { console.error(`no deck or document id "${selector}"`); process.exit(1); }
const DECK_DIR = path.join(deckRoot, deckId);
const SLIDES_DIR = path.join(DECK_DIR, "slides");
const MONACO_DIR = path.join(ROOT, "node_modules", "monaco-editor", "min", "vs");
const HAS_MONACO = existsSync(path.join(MONACO_DIR, "loader.js"));
const HAS_MARKDOWNLINT = existsSync(path.join(ROOT, "node_modules", "markdownlint"));
let collaborationBundle = null;
if (!PUBLIC_VIEW_ONLY) try {
  const { build } = require("esbuild");
  collaborationBundle = (await build({
    entryPoints: [path.join(ROOT, "engine", "editor", "collaboration.ts")],
    bundle: true,
    write: false,
    platform: "browser",
    format: "iife",
    globalName: "DeckCollab",
    plugins: [{
      name: "monaco-global",
      setup(build) {
        build.onResolve({ filter: /^monaco-editor\/esm\/vs\/editor\/editor\.api\.js$/ }, () => ({ path: "monaco", namespace: "global" }));
        build.onLoad({ filter: /.*/, namespace: "global" }, () => ({
          contents: "export const Selection=globalThis.monaco.Selection; export const Range=globalThis.monaco.Range; export const SelectionDirection=globalThis.monaco.SelectionDirection; export const editor=globalThis.monaco.editor;",
          loader: "js",
        }));
      },
    }],
  })).outputFiles[0].text;
} catch (error) {
  console.warn(`collaboration disabled: ${error.message}`);
}
const manifestPath = path.join(DECK_DIR, "deck.json");
if (!existsSync(manifestPath)) {
  console.error(`no manifest at ${path.relative(process.cwd(), manifestPath)}`);
  process.exit(1);
}

// Git history is the content repo's durable record: journal ids like git:<hash>
// and provenance lookups run against the repository that contains CONTENT_ROOT
// (the engine checkout itself when content lives with the engine).
const gitPath = (file) => {
  const abs = path.isAbsolute(file) ? file : path.resolve(CONTENT_ROOT, file);
  return path.relative(GIT_ROOT, abs).split(path.sep).join("/");
};
const git = (...a) => {
  try { return execFileSync("git", a, { cwd: GIT_ROOT, stdio: ["ignore", "pipe", "ignore"] }).toString(); }
  catch { return null; }
};
const GIT_ROOT = path.resolve(git("-C", CONTENT_ROOT, "rev-parse", "--show-toplevel")?.trim() || CONTENT_ROOT);
const owner = (git("config", "user.name") || "").trim();
const publicOrigin = (process.env.DECKS_PUBLIC_ORIGIN || "").replace(/\/$/, "");
const localAuth = HOST === "127.0.0.1" || HOST === "localhost";
const authenticator = await createAuthenticator({ publicOrigin, local: localAuth, defaultName: owner });

// git blob hash of arbitrary content — lets us match journal states to commits
// without shelling out per comparison.
const blobSha = (content) =>
  createHash("sha1").update(`blob ${Buffer.byteLength(content)}\0`).update(content).digest("hex");

// Last commits touching a file (hash, date, author, subject, blob sha),
// memoized until HEAD moves.
let gitCache = { head: null, byFile: new Map() };
const gitCommitsFor = (file) => {
  const head = git("rev-parse", "HEAD")?.trim();
  if (!head) return null; // not a git repo (or no commits)
  if (gitCache.head !== head) gitCache = { head, byFile: new Map() };
  const repoFile = gitPath(file);
  if (gitCache.byFile.has(repoFile)) return gitCache.byFile.get(repoFile);
  const commits = [];
  const log = git("log", "-n", "20", "--format=%h%x00%cI%x00%an%x00%s", "--", repoFile);
  if (log) for (const line of log.trim().split("\n").filter(Boolean)) {
    const [hash, ts, author, subject] = line.split("\0");
    const blob = git("rev-parse", `${hash}:${repoFile}`)?.trim();
    if (blob) commits.push({ hash, ts, author, subject, blob });
  }
  gitCache.byFile.set(repoFile, commits);
  return commits;
};

const readManifest = () => JSON.parse(readFileSync(manifestPath, "utf8"));
// A deck may own a PRIVATE copy of its theme (decks/<deckId>/theme/) — created
// with the deck (see registry.mjs) so its guidance, tokens and chrome are
// editable without touching the shared themes/ tree other decks render from.
const localThemeDir = path.join(DECK_DIR, "theme");
const hasLocalTheme = () => existsSync(localThemeDir);
const themeDir = () => hasLocalTheme() ? localThemeDir : path.join(CONTENT_ROOT, "themes", readManifest().theme || "");

const frameSources = (readManifest().frameSources || []).map((value) => {
  try { const origin = new URL(value).origin; return origin.startsWith("https://") ? origin : null; }
  catch { return null; }
}).filter(Boolean);
const { localRendererPolicy } = await import('./slide-policy.mjs');
const SLIDE_CSP = `default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data:; ${localRendererPolicy(readManifest())} frame-src 'self' ${frameSources.join(" ")}; object-src 'none'; base-uri 'self'; form-action 'none'; frame-ancestors 'self'`;
const MIME = {
  ".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8", ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json", ".png": "image/png", ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml",
  ".webp": "image/webp", ".woff2": "font/woff2", ".woff": "font/woff", ".ttf": "font/ttf",
  ".pdf": "application/pdf", ".ico": "image/x-icon", ".mp4": "video/mp4",
};

const json = (res, code, obj) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
};
const readBody = (req) =>
  new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });

// A saved slide file must live inside this deck's slides/ tree.
const safeSlidePath = (rel, exts = [".html"]) => {
  if (typeof rel !== "string" || !exts.some((e) => rel.endsWith(e))) return null;
  const abs = path.resolve(CONTENT_ROOT, rel);
  return abs.startsWith(SLIDES_DIR + path.sep) ? abs : null;
};

// Design-harness assets the UI may edit: the theme's guidance/tokens/chrome
// (md/json/css) and the deck's own CSS. Nothing else.
const safeCatalogPath = (rel) => {
  if (typeof rel !== "string" || !/\/slides\/i18n\/[^/]+\.js$/.test(rel)) return null;
  return safeSlidePath(rel, [".js"]);
};

const safeAssetPath = (rel) => {
  if (typeof rel !== "string" || !/\.(md|json|css)$/.test(rel)) return null;
  // Editor asset paths use the shared URL scheme (themes/<theme>/<file>); with
  // a deck-local theme those resolve into the deck's private copy, so a deck
  // can never read or write the shared theme other decks render from.
  const themeMatch = rel.match(/^themes\/[^/]+\/(.+)$/);
  if (themeMatch && hasLocalTheme()) {
    const local = path.resolve(localThemeDir, themeMatch[1]);
    return local.startsWith(localThemeDir + path.sep) ? local : null;
  }
  const abs = path.resolve(CONTENT_ROOT, rel);
  if (abs.startsWith(path.resolve(themeDir()) + path.sep)) return abs;
  if (abs.startsWith(SLIDES_DIR + path.sep) && rel.endsWith(".css")) return abs;
  return null;
};

// ---- journal: rolling, local, gitignored — undo/redo + person/date revert ----
const HISTORY_DIR = path.join(DECK_DIR, ".history");
const JOURNAL = path.join(HISTORY_DIR, "journal.ndjson");
const DOCUMENT_META = path.join(HISTORY_DIR, "document.json");
const documentId = readManifest().documentId;
if (!/^[A-Za-z0-9_-]{12,128}$/.test(documentId || "")) {
  console.error(`${path.relative(CONTENT_ROOT, manifestPath)} needs a stable documentId`);
  process.exit(1);
}
const documentIdOwners = readdirSync(deckRoot).filter((candidate) => {
  const file = path.join(deckRoot, candidate, "deck.json");
  if (!existsSync(file)) return false;
  try { return JSON.parse(readFileSync(file, "utf8")).documentId === documentId; } catch { return false; }
});
if (documentIdOwners.length !== 1) {
  console.error(`documentId ${documentId} is not unique: ${documentIdOwners.join(", ")}`);
  process.exit(1);
}
const defaultDocumentTitle = () => readManifest().name.replace(/[_-]+/g, " ");
const readDocument = () => {
  if (!existsSync(DOCUMENT_META)) return { id: documentId, title: defaultDocumentTitle() };
  try {
    const value = JSON.parse(readFileSync(DOCUMENT_META, "utf8"));
    return { id: documentId, title: String(value.title || defaultDocumentTitle()) };
  } catch { return { id: documentId, title: defaultDocumentTitle() }; }
};
const access = createAccessController({
  file: path.join(HISTORY_DIR, "access.json"), documentId,
  bootstrapOwner: process.env.DECKS_BOOTSTRAP_OWNER || "",
  privateOnly: process.env.DECKS_PRIVATE_DOGFOOD === "true",
});
const writeDocumentTitle = (title) => {
  title = String(title || "").trim();
  if (!title || title.length > 200) throw new Error("title must be 1–200 characters");
  mkdirSync(HISTORY_DIR, { recursive: true });
  const temporary = `${DOCUMENT_META}.tmp-${process.pid}`;
  writeFileSync(temporary, JSON.stringify({ title }, null, 2) + "\n");
  renameSync(temporary, DOCUMENT_META);
  return readDocument();
};
const MAX_ENTRIES = 100;
const MAX_BYTES = 5 * 1024 * 1024;
let seq = 0;

const readJournal = () => {
  if (!existsSync(JOURNAL)) return [];
  return readFileSync(JOURNAL, "utf8").split("\n").filter(Boolean).map((l) => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
};
const appendJournal = (entry) => {
  mkdirSync(HISTORY_DIR, { recursive: true });
  let entries = readJournal();
  entries.push(entry);
  entries = entries.slice(-MAX_ENTRIES);
  let out = entries.map((e) => JSON.stringify(e));
  while (out.join("\n").length > MAX_BYTES && out.length > 1) out.shift();
  writeFileSync(JOURNAL, out.join("\n") + "\n");
};
const journalEntry = (via, author, relFile, before, after) => ({
  id: `${Date.now()}-${seq++}`,
  ts: new Date().toISOString().replace(/\.\d{3}/, ""),
  via, author: author || "", file: relFile, before, after,
});

// ---- file cache + tracked writes (so the watcher can tell self from other) ----
const fileCache = new Map();   // rel path -> last known content
const binaryCache = new Map(); // hosted image/font assets — avoid repeated GCS reads while switching slides
let collaborationServer = null;
const rel = (abs) => path.relative(CONTENT_ROOT, abs);

const primeCache = (dir) => {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, f.name);
    if (f.isDirectory()) primeCache(abs);
    else if (/\.(html|js|css)$/.test(f.name)) fileCache.set(rel(abs), readFileSync(abs, "utf8"));
  }
};
primeCache(SLIDES_DIR);
if (existsSync(themeDir())) primeCache(themeDir());

const staticCacheControl = (ext, abs = "") => {
  if ([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".woff", ".woff2", ".ttf"].includes(ext))
    return "private, max-age=86400";
  // Editable source must be fresh on reload/present and on an SSE catalog refresh.
  if (ext === ".html" || /[/\\]slides[/\\]i18n[/\\][^/\\]+\.js$/.test(abs)) return "private, no-cache";
  if ([".css", ".js", ".mjs", ".json"].includes(ext)) return "private, max-age=5";
  return "no-store";
};
const readStaticFile = (abs) => {
  const cachedText = PUBLIC_VIEW_ONLY ? null : fileCache.get(rel(abs));
  if (cachedText != null) return cachedText;
  if (binaryCache.has(abs)) return binaryCache.get(abs);
  const body = readFileSync(abs);
  if (CONTENT_ROOT !== ROOT && [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".woff", ".woff2", ".ttf"].includes(path.extname(abs).toLowerCase()))
    binaryCache.set(abs, body);
  return body;
};

const writeTracked = (abs, content, via, author) => {
  const r = rel(abs);
  const before = fileCache.get(r) ?? (existsSync(abs) ? readFileSync(abs, "utf8") : "");
  if (before === content) return false; // null diff: no write, journal entry, or watcher churn
  const temporary = `${abs}.tmp-${process.pid}`;
  writeFileSync(temporary, content);
  renameSync(temporary, abs);
  fileCache.set(r, content);
  if (via !== "collab") {
    const document = collaborationServer?.hocuspocus.documents.get(documentId);
    // Collab asset keys use the URL scheme (themes/<theme>/<file>); map
    // deck-local theme writes onto that key so they converge like shared ones.
    const localMatch = hasLocalTheme() && r.startsWith(`decks/${deckId}/theme/`)
      ? `themes/${readManifest().theme}/${r.slice(`decks/${deckId}/theme/`.length)}` : r;
    if (document) importSourceFile(document, { relative: localMatch, source: content, deckId, locales: readManifest().locales });
  }
  appendJournal(journalEntry(via, author, r, before, content));
  return true;
};

// Provenance timestamps are consequences of a real edit, not edits by
// themselves. If a designer changes something and changes it back before
// saving, ignore stamp-only differences and leave both disk and history alone.
const withoutProvenance = (html) => html
  .replace(/\sdata-(?:author|modified)=(?:"[^"]*"|'[^']*')/g, "");

// ---- catalog helpers ----
const catPath = (loc) => path.join(SLIDES_DIR, "i18n", `${loc}.js`);
const parseCatalog = (loc) => {
  if (!existsSync(catPath(loc))) return { i18n: {}, meta: {} };
  const src = readFileSync(catPath(loc), "utf8");
  const grab = (name) => {
    const m = src.match(new RegExp(`window\\.${name}\\s*=\\s*(\\{[\\s\\S]*?\\n\\});`))
      || src.match(new RegExp(`window\\.${name}\\s*=\\s*(\\{\\});`));
    try { return m ? JSON.parse(m[1]) : {}; } catch { return {}; }
  };
  return { i18n: grab("I18N"), meta: grab("I18N_META") };
};
// All locales are equal — every one (including the default) has a catalog.
const validLocale = (loc) => {
  const m = readManifest();
  return Array.isArray(m.locales) && m.locales.includes(loc) && /^[\w-]+$/.test(loc);
};
const writeCatalog = (loc, cat, via, author) => {
  const sorted = (value) => Object.fromEntries(Object.keys(value).sort().map((key) => [key, value[key]]));
  return writeTracked(catPath(loc),
    `// ${loc} strings for ${deckId} — keys match data-i18n attributes in slides/*.html.\n` +
    `// I18N_META records provenance per key: { modified, author } — author absent ⇒ agent edit.\n` +
    `window.I18N = ${JSON.stringify(sorted(cat.i18n), null, 2)};\n` +
    `window.I18N_META = ${JSON.stringify(sorted(cat.meta), null, 2)};\n`, via, author);
};

const slideKeys = (file) => {
  const abs = safeSlidePath(file);
  if (!abs || !existsSync(abs)) return [];
  return [...readFileSync(abs, "utf8").matchAll(/data-i18n=["']([^"']+)["']/g)].map((m) => m[1]);
};
const changedCatalogKeys = (entry) => {
  if (!safeCatalogPath(entry.file)) return [];
  const before = parseCatalogSource(entry.before || "");
  const after = parseCatalogSource(entry.after || "");
  return [...new Set([...Object.keys(before.i18n), ...Object.keys(after.i18n)])]
    .filter((key) => before.i18n[key] !== after.i18n[key]);
};
const catalogStateAt = (id, catalogFile) => {
  if (!safeCatalogPath(catalogFile)) return null;
  const repoFile = gitPath(catalogFile);
  if (id.startsWith("gitcat:")) return git("show", `${id.slice(7)}:${repoFile}`);
  if (id.startsWith("git:")) return git("show", `${id.slice(4)}:${repoFile}`);
  const journal = readJournal();
  const index = journal.findIndex((entry) => entry.id === id);
  if (index < 0) return null;
  const selected = journal[index];
  if (selected.file === catalogFile) return selected.after || "";
  for (let i = index; i >= 0; i--)
    if (journal[i].file === catalogFile) return journal[i].after || "";
  return git("show", `HEAD:${repoFile}`) || readFileSync(safeCatalogPath(catalogFile), "utf8");
};

// Agent slide edits: anything goes except changing or removing what a person
// has edited (stamped elements, authored catalog keys).
const SLIDE_NAME = /^[a-z0-9][a-z0-9-]{0,48}$/;
const stampedTags = (html) => html.match(/<[a-zA-Z][^>]*\sdata-author=["'][^"']*["'][^>]*>/g) || [];
// An agent may change its own person's edits, never anyone else's. Stamps hold
// the editor's display name (the email's local part on the hosted service).
const tagAuthor = (tag) => (tag.match(/\sdata-author=["']([^"']*)["']/) || [])[1] || "";
const ownedBy = (principal) => (author) => {
  const email = String(principal?.email || "").toLowerCase(), name = String(author || "").toLowerCase();
  return Boolean(email && name) && (name === email || name === email.split("@")[0]);
};
const othersTags = (html, principal) => stampedTags(html).filter((tag) => !ownedBy(principal)(tagAuthor(tag)));
const agentAuthor = (principal) => `agent of ${principal.email || principal.name}`;
const deckLocales = () => readManifest().locales || [readManifest().defaultLocale || "en"];
const slideAbs = (name) => path.join(SLIDES_DIR, `${name}.html`);
// Blank themed starter for editor-created slides; keys are namespaced by the
// slide name so catalogs stay conflict-free.
const BLANK_COPY = {
  en: { eyebrow: "New slide", h1: "Heading", lede: "Describe this slide." },
  ja: { eyebrow: "新しいスライド", h1: "見出し", lede: "このスライドの説明。" },
};
const blankSlide = (name) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="deck.css">
<script src="../../../engine/i18n.js"></script>
</head>
<body><div class="slide">
  <span class="eyebrow" data-i18n="${name}.eyebrow"></span>
  <h1 class="t" data-i18n="${name}.h1"></h1>
  <p class="lede" data-i18n="${name}.lede"></p>
  <div class="spacer"></div>
  <div class="foot"><span class="wordmark">${name}</span></div>
</div></body></html>
`;
const humanContent = (name, principal) => {
  const html = existsSync(slideAbs(name)) ? readFileSync(slideAbs(name), "utf8") : "";
  const keys = slideKeys(`decks/${deckId}/slides/${name}.html`);
  const mine = ownedBy(principal);
  const authoredKeys = deckLocales().flatMap((loc) => keys.filter((key) => {
    const author = parseCatalog(loc).meta[key]?.author;
    return author && !mine(author);
  }));
  return { tags: othersTags(html, principal), keys: [...new Set(authoredKeys)] };
};
// Agent-written editor tools live with the content (persistent, shared by every
// deck on the host) and only run for people who enable them in their editor.
const AGENT_TOOLS_DIR = path.join(CONTENT_ROOT, "tools");
const TOOL_NAME = /^[a-z0-9][a-z0-9-]{0,48}$/;
const agentTools = () => existsSync(AGENT_TOOLS_DIR)
  ? readdirSync(AGENT_TOOLS_DIR).filter((file) => file.endsWith(".js")).sort().map((file) => {
    const code = readFileSync(path.join(AGENT_TOOLS_DIR, file), "utf8");
    let info = {};
    try { info = JSON.parse(readFileSync(path.join(AGENT_TOOLS_DIR, file.replace(/\.js$/, ".json")), "utf8")); } catch {}
    return { file, author: info.author || "agent", owner: info.owner || "", modified: info.modified || "", sha256: createHash("sha256").update(code).digest("hex") };
  }) : [];
// Only a tool's creator (in the editor, or through their own agent) may change or delete it.
const saveAgentTool = ({ name, code, remove, email, author }) => {
  if (!TOOL_NAME.test(name)) throw new Error("tool names are lowercase letters, digits and dashes");
  const file = path.join(AGENT_TOOLS_DIR, `${name}.js`), meta = file.replace(/\.js$/, ".json");
  const current = agentTools().find((tool) => tool.file === `${name}.js`);
  if (current?.owner && current.owner !== normalize(email)) throw new Error(`only ${current.owner} or their agent can change "${name}"`);
  mkdirSync(AGENT_TOOLS_DIR, { recursive: true });
  if (remove) {
    for (const target of [file, meta]) if (existsSync(target)) unlinkSync(target);
    broadcast("tools");
    return { name, removed: true };
  }
  if (!code.includes("registerTool")) throw new Error("a tool must call harness.registerTool({...}); see the editor tools contract");
  if (code.length > 200_000) throw new Error("tools must be under 200 kB");
  writeTracked(file, code, "agent", author);
  writeFileSync(meta, JSON.stringify({ author, owner: normalize(email), modified: new Date().toISOString() }, null, 2) + "\n");
  broadcast("tools");
  return { name, note: "People must enable it in their editor before it runs." };
};
const normalize = (email) => String(email || "").trim().toLowerCase();
const GUIDANCE_FILES = new Set(["GUIDANCE.md", "guidance.json"]);
const writeManifest = (manifest, principal) => {
  writeTracked(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "agent", agentAuthor(principal));
  broadcast("manifest");
};

const mcpHandler = createDeckMcp({
  documentId,
  title: () => readDocument().title,
  manifest: readManifest,
  readSlide(name) {
    if (!readManifest().slides.includes(name)) throw new Error("unknown slide");
    return readFileSync(path.join(SLIDES_DIR, `${name}.html`), "utf8");
  },
  readCatalog(locale, slide) {
    if (!validLocale(locale) || !readManifest().slides.includes(slide)) throw new Error("unknown slide or locale");
    const cat = parseCatalog(locale), values = {};
    for (const key of slideKeys(`decks/${deckId}/slides/${slide}.html`)) values[key] = cat.i18n[key] ?? "";
    return values;
  },
  updateCatalogText({ locale, key, value, expectedCurrent, principal }) {
    access.requireEdit(principal);
    if (!validLocale(locale)) throw new Error("unknown locale");
    const known = readManifest().slides.some((slide) => slideKeys(`decks/${deckId}/slides/${slide}.html`).includes(key));
    if (!known) throw new Error("unknown catalog key");
    const cat = parseCatalog(locale);
    const author = cat.meta[key]?.author;
    if (author && !ownedBy(principal)(author)) throw new Error(`"${key}" was edited by ${author}; only they or their agent can change it`);
    if (cat.i18n[key] !== expectedCurrent) throw new Error("text changed concurrently; read the slide again");
    if (value === expectedCurrent) return { changed: false, locale, key };
    cat.i18n[key] = value;
    if (author) cat.meta[key] = { modified: new Date().toISOString(), author };
    else delete cat.meta[key];
    writeCatalog(locale, cat, "agent", agentAuthor(principal));
    return { changed: true, locale, key, value };
  },
  readStyles() {
    return Object.fromEntries(readdirSync(SLIDES_DIR).filter((file) => file.endsWith(".css"))
      .map((file) => [file, readFileSync(path.join(SLIDES_DIR, file), "utf8")]));
  },
  writeSlide({ slide, html, strings = {}, position, principal }) {
    access.requireEdit(principal);
    if (!SLIDE_NAME.test(slide)) throw new Error("slide names are lowercase letters, digits and dashes");
    if (!/<html[\s>]/i.test(html)) throw new Error("html must be a full document, like read_slide returns");
    const existing = existsSync(slideAbs(slide)) ? readFileSync(slideAbs(slide), "utf8") : "";
    const mine = ownedBy(principal);
    const kept = othersTags(existing, principal);
    const lost = kept.filter((tag) => !html.includes(tag));
    if (lost.length) throw new Error(`these elements were edited by someone else and must stay exactly as they are: ${lost.join(" ")}`);
    if (othersTags(html, principal).some((tag) => !kept.includes(tag))) throw new Error("an agent can only carry its own person's data-author stamp");
    const keys = [...html.matchAll(/data-i18n=["']([^"']+)["']/g)].map((m) => m[1]);
    const catalogs = Object.fromEntries(deckLocales().map((loc) => [loc, parseCatalog(loc)]));
    for (const [loc, entries] of Object.entries(strings)) {
      if (!catalogs[loc]) throw new Error(`unknown locale ${loc}`);
      for (const [key, value] of Object.entries(entries)) {
        const author = catalogs[loc].meta[key]?.author;
        if (author && !mine(author) && catalogs[loc].i18n[key] !== value) throw new Error(`"${key}" was edited by ${author}; only they or their agent can change it`);
      }
    }
    for (const [loc, cat] of Object.entries(catalogs)) {
      const missing = keys.filter((key) => !(key in cat.i18n) && !(key in (strings[loc] || {})));
      if (missing.length) throw new Error(`provide ${loc} text for: ${missing.join(", ")}`);
    }
    for (const [loc, entries] of Object.entries(strings)) {
      const cat = catalogs[loc];
      for (const [key, value] of Object.entries(entries)) if (cat.i18n[key] !== value) {
        const author = cat.meta[key]?.author;
        cat.i18n[key] = value;
        if (author) cat.meta[key] = { modified: new Date().toISOString(), author }; else delete cat.meta[key];
      }
      writeCatalog(loc, cat, "agent", agentAuthor(principal));
    }
    writeTracked(slideAbs(slide), html, "agent", agentAuthor(principal));
    broadcast("slide", { file: rel(slideAbs(slide)) });
    const manifest = readManifest();
    if (!manifest.slides.includes(slide)) {
      const at = Number.isInteger(position) ? Math.max(0, Math.min(position, manifest.slides.length)) : manifest.slides.length;
      manifest.slides.splice(at, 0, slide);
      writeManifest(manifest, principal);
    }
    return { slide, created: !existing, slides: readManifest().slides };
  },
  readGuidance() {
    return Object.fromEntries([...GUIDANCE_FILES].filter((file) => existsSync(path.join(themeDir(), file)))
      .map((file) => [file, readFileSync(path.join(themeDir(), file), "utf8")]));
  },
  writeGuidance({ file, content, principal }) {
    access.requireEdit(principal);
    if (!GUIDANCE_FILES.has(file)) throw new Error(`guidance files are ${[...GUIDANCE_FILES].join(" and ")}`);
    if (file.endsWith(".json")) JSON.parse(content);
    const changed = writeTracked(path.join(themeDir(), file), content, "agent", agentAuthor(principal));
    if (changed) broadcast("guidance");
    return { file, changed };
  },
  writeEditorTool({ name, code, remove = false, principal }) {
    access.requireEdit(principal);
    return saveAgentTool({ name, code, remove, email: principal.email, author: agentAuthor(principal) });
  },
  setSlideOrder({ slides, principal }) {
    access.requireEdit(principal);
    const manifest = readManifest();
    if (new Set(slides).size !== slides.length) throw new Error("each slide may appear once");
    const unknown = slides.filter((name) => !SLIDE_NAME.test(name) || !existsSync(slideAbs(name)));
    if (unknown.length) throw new Error(`no such slides: ${unknown.join(", ")}`);
    const removed = manifest.slides.filter((name) => !slides.includes(name));
    // Removing a slide is fine unless a person's edit would disappear from the deck.
    const remainingKeys = new Set(slides.flatMap((name) => slideKeys(`decks/${deckId}/slides/${name}.html`)));
    const protectedSlides = removed.filter((name) => {
      const human = humanContent(name, principal);
      return human.tags.length || human.keys.some((key) => !remainingKeys.has(key));
    });
    if (protectedSlides.length) throw new Error(`these slides contain other people's edits and can't be removed: ${protectedSlides.join(", ")}`);
    manifest.slides = slides;
    writeManifest(manifest, principal);
    return { slides, removed };
  },
});

// The public copy carries no authorship: stamps on elements and catalog META
// name the editors, so they stay on the private host.
const publicCopy = (abs, body) => {
  if (abs.endsWith(".html")) return String(body).replace(/\sdata-(?:author|modified)=(?:"[^"]*"|'[^']*')/g, "");
  if (abs.startsWith(path.join(SLIDES_DIR, "i18n") + path.sep) && abs.endsWith(".js"))
    return String(body).replace(/window\.I18N_META\s*=\s*\{[\s\S]*?\n\};|window\.I18N_META\s*=\s*\{\};/, "window.I18N_META = {};");
  return body;
};
const VIEW_COOKIE = `decks_view_${documentId}`;
const viewDigest = (password) => createHmac("sha256", String(password || "")).update(documentId).digest();
const viewToken = VIEW_PASSWORD ? viewDigest(VIEW_PASSWORD).toString("hex") : "";
const viewUnlocked = (req) => {
  const match = String(req.headers.cookie || "").match(new RegExp(`(?:^|;\\s*)${VIEW_COOKIE}=([0-9a-f]{64})`));
  return Boolean(match) && timingSafeEqual(Buffer.from(match[1], "hex"), Buffer.from(viewToken, "hex"));
};
const readForm = (req) => new Promise((resolve) => {
  let data = "";
  req.on("data", (chunk) => { data += chunk; if (data.length > 4096) req.destroy(); });
  req.on("end", () => resolve(new URLSearchParams(data)));
});
const gateHtml = (failed) => {
  const title = readDocument().title.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
*{box-sizing:border-box}body{margin:0;min-height:100dvh;display:flex;align-items:center;justify-content:center;background:#fff;color:#000;font:16px/1.4 "Helvetica Neue",Arial,sans-serif}
form{width:min(420px,90vw);border-top:3px solid #000;padding-top:14px}h1{margin:0 0 24px;font-size:34px;line-height:1;letter-spacing:-.04em}
input,button{width:100%;height:48px;border:3px solid #000;border-radius:0;font:inherit;padding:0 12px}button{margin-top:10px;background:#000;color:#fff;font-weight:700;cursor:pointer}
p{margin:10px 0 0;font:700 12px/1.3 monospace;text-transform:uppercase;color:#2c40d3}
</style></head><body><form method="post" action="/presentation/d/${documentId}/gate"><h1>${title}</h1>
<input type="password" name="password" placeholder="Password" autocomplete="current-password" autofocus required><button type="submit">View</button>${failed ? "<p>Incorrect password</p>" : ""}</form></body></html>`;
};

const presentationHtml = () => {
  const manifest = readManifest(), document = readDocument();
  const data = JSON.stringify({
    title: document.title, deckId, documentId, slides: manifest.slides,
    locales: manifest.locales || [manifest.defaultLocale || "en"], defaultLocale: manifest.defaultLocale || "en",
  }).replaceAll("<", "\\u003c");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Ctext y='.9em' font-size='90'%3E%F0%9F%8E%AC%3C/text%3E%3C/svg%3E">
<title>${document.title.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</title><style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;height:100dvh;overflow:hidden;background:#111;color:#fff;font:12px system-ui,sans-serif;overscroll-behavior:none}
#viewport{position:absolute;inset:0;overflow:hidden}#stage{position:absolute;left:50%;top:50%;width:1280px;height:720px;margin:-360px 0 0 -640px;transform-origin:center;touch-action:pan-y}
iframe{position:absolute;inset:0;width:1280px;height:720px;border:0;background:#fff;visibility:hidden;opacity:0;transition:opacity 80ms linear}iframe.active{visibility:visible;opacity:1}
#controls{position:fixed;z-index:2;left:50%;bottom:max(8px,env(safe-area-inset-bottom));display:flex;transform:translateX(-50%);background:rgba(0,0,0,.82);border:1px solid #555}button{min-width:48px;height:48px;border:0;border-right:1px solid #555;border-radius:0;background:transparent;color:#fff;padding:0 12px;font:600 18px/48px system-ui,sans-serif;text-align:center;touch-action:manipulation}button:last-child{border-right:0}button:hover{background:#333}button:focus-visible{position:relative;outline:2px solid #fff;outline-offset:-2px}:fullscreen #controls{display:none}
@media(max-width:700px),(max-height:500px){#controls{bottom:max(6px,env(safe-area-inset-bottom))}button{min-width:56px;height:56px;font-size:22px;line-height:56px;padding:0 14px}}
</style></head><body><main id="viewport"><div id="stage"></div></main>
<nav id="controls" aria-label="Presentation controls"><button id="prev" title="Previous slide (←)" aria-label="Previous slide">←</button><button id="next" title="Next slide (→ or Space)" aria-label="Next slide">→</button><button id="locale" title="Switch language (Tab)" aria-label="Switch language"></button>${PUBLIC_VIEW_ONLY ? "" : '<button id="edit" title="Open edit mode" aria-label="Open edit mode">✎</button>'}<button id="full" title="Full screen (F)" aria-label="Full screen">⛶</button></nav>
<script>const deck=${data},params=new URLSearchParams(location.search);function localeLabel(code){return({en:'EN',ja:'JP'})[code]||code.toUpperCase()}function pickLocale(){const asked=params.get('lang');if(deck.locales.includes(asked))return asked;for(const tag of navigator.languages||[navigator.language||'']){const base=String(tag).toLowerCase().split('-')[0];if(deck.locales.includes(base))return base}return deck.defaultLocale}let index=0,lang=pickLocale();const stage=document.querySelector('#stage'),viewport=document.querySelector('#viewport'),controls=document.querySelector('#controls'),frames=[];
const requested=Number(params.get('slide'));if(Number.isInteger(requested)&&requested>0&&requested<=deck.slides.length)index=requested-1;
function bindSwipe(target){let x=0,y=0,time=0;target.addEventListener('touchstart',event=>{if(event.touches.length!==1)return;const touch=event.touches[0];x=touch.clientX;y=touch.clientY;time=Date.now()},{passive:true});target.addEventListener('touchend',event=>{if(!time||!event.changedTouches.length)return;const touch=event.changedTouches[0],dx=touch.clientX-x,dy=touch.clientY-y,elapsed=Date.now()-time;time=0;if(elapsed<900&&Math.abs(dx)>=50&&Math.abs(dx)>Math.abs(dy)*1.2)step(dx<0?1:-1)},{passive:true});target.addEventListener('touchcancel',()=>{time=0},{passive:true})}
for(let i=0;i<deck.slides.length;i++){const frame=document.createElement('iframe');frame.title='Slide '+(i+1)+' of '+deck.slides.length;frame.ready=new Promise(resolve=>frame.onload=()=>{frame.contentWindow.addEventListener('keydown',onKey);bindSwipe(frame.contentDocument);resolve()});frame.src='/decks/'+encodeURIComponent(deck.deckId)+'/slides/'+encodeURIComponent(deck.slides[i])+'.html?lang='+encodeURIComponent(lang);frames.push(frame);stage.append(frame)}
function updateUrl(){history.replaceState(null,'','?mode=present&slide='+(index+1)+'&lang='+encodeURIComponent(lang))}
function step(direction){try{const view=frames[index]&&frames[index].contentWindow;if(view&&typeof view.deckStep==='function'&&view.deckStep(direction))return}catch{}show(index+direction)}
function show(next){index=Math.max(0,Math.min(frames.length-1,next));for(let i=0;i<frames.length;i++)frames[i].classList.toggle('active',i===index);updateUrl()}
async function switchLocale(){const target=deck.locales[(deck.locales.indexOf(lang)+1)%deck.locales.length];lang=target;document.querySelector('#locale').textContent=localeLabel(target);const active=frames[index];await active.ready;await active.contentWindow.setI18nLocale(target);for(let i=0;i<frames.length;i++)if(i!==index)frames[i].ready.then(()=>frames[i].contentWindow.setI18nLocale(target));updateUrl()}
function fit(){const reserved=document.fullscreenElement?0:controls.getBoundingClientRect().height+16+parseFloat(getComputedStyle(controls).bottom||0);viewport.style.bottom=reserved+'px';stage.style.transform='scale('+Math.min(viewport.clientWidth/1280,Math.max(1,viewport.clientHeight)/720)+')'}
function toggleFull(){document.fullscreenElement?document.exitFullscreen():document.documentElement.requestFullscreen()}
function onKey(event){const key=event.key;if(['ArrowRight','ArrowDown','PageDown',' ','Enter'].includes(key)){event.preventDefault();step(1)}else if(['ArrowLeft','ArrowUp','PageUp','Backspace'].includes(key)){event.preventDefault();step(-1)}else if(key==='Home'){event.preventDefault();show(0)}else if(key==='End'){event.preventDefault();show(frames.length-1)}else if(key.toLowerCase()==='f'){event.preventDefault();toggleFull()}else if(key==='Tab'||key.toLowerCase()==='l'){event.preventDefault();switchLocale()}}
document.querySelector('#prev').onclick=()=>step(-1);document.querySelector('#next').onclick=()=>step(1);document.querySelector('#locale').onclick=switchLocale;document.querySelector('#locale').textContent=localeLabel(lang);document.querySelector('#locale').hidden=deck.locales.length<2;if(document.querySelector('#edit'))document.querySelector('#edit').onclick=()=>location.assign('/presentation/d/'+encodeURIComponent(deck.documentId));document.querySelector('#full').onclick=toggleFull;
bindSwipe(viewport);addEventListener('resize',fit);addEventListener('orientationchange',fit);addEventListener('fullscreenchange',fit);addEventListener('keydown',onKey);fit();show(index);</script></body></html>`;
};

// ---- server ----
const handleHttp = async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  let p = decodeURIComponent(url.pathname);
  // With a deck-local theme, /themes/<theme>/<file> URLs resolve into the
  // deck's private copy — one rewrite covers static serving and asset reads.
  if (hasLocalTheme() && p.startsWith("/themes/")) p = p.replace(/^\/themes\/[^/]+(?=\/)/, `/decks/${deckId}/theme`);

  try {
    if (await authenticator.route(req, res, url)) return;
    if (req.method === "GET" && p === "/healthz") { json(res, 200, { ok: true }); return; }
    const canonicalDocumentPath = `/presentation/d/${documentId}`;
    const presentationLocation = () => {
      const query = new URLSearchParams(url.searchParams); query.set("mode", "present");
      return `${canonicalDocumentPath}?${query}`;
    };
    if (VIEW_PASSWORD && !viewUnlocked(req)) {
      if (req.method === "POST" && p === `${canonicalDocumentPath}/gate`) {
        const password = (await readForm(req)).get("password");
        if (timingSafeEqual(viewDigest(password), viewDigest(VIEW_PASSWORD))) {
          res.writeHead(303, {
            location: `/d/${documentId}`, "cache-control": "no-store",
            "set-cookie": `${VIEW_COOKIE}=${viewToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=2592000`,
          });
          res.end(); return;
        }
        res.writeHead(401, { "content-type": MIME[".html"], "cache-control": "no-store" }); res.end(gateHtml(true)); return;
      }
      if (req.method === "GET" && (p === "/" || p === canonicalDocumentPath)) {
        res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" }); res.end(gateHtml(false)); return;
      }
      res.writeHead(401, { "content-type": "text/plain; charset=utf-8" }); res.end("password required"); return;
    }
    if (PUBLIC_VIEW_ONLY && req.method === "GET" && p === "/") {
      res.writeHead(302, { location: presentationLocation() }); res.end(); return;
    }
    if (PUBLIC_VIEW_ONLY && req.method === "GET" && p === canonicalDocumentPath) {
      res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
      res.end(presentationHtml()); return;
    }
    const publicAsset = PUBLIC_VIEW_ONLY && req.method === "GET" && (
      p === "/engine/i18n.js" || p.startsWith(`/decks/${deckId}/slides/`)
      || p.startsWith(`/decks/${deckId}/theme/`) || p.startsWith(`/themes/${readManifest().theme}/`)
    );
    if (publicAsset) {
      const base = p.startsWith("/engine/") ? ROOT : CONTENT_ROOT, abs = path.resolve(base, "." + p);
      const allowedRoot = p.startsWith("/engine/") ? path.join(ROOT, "engine")
        : p.startsWith(`/decks/${deckId}/slides/`) ? SLIDES_DIR
        : p.startsWith(`/decks/${deckId}/theme/`) ? localThemeDir : themeDir();
      const cached = fileCache.has(rel(abs)) || binaryCache.has(abs);
      if (abs.startsWith(allowedRoot + path.sep) && (cached || (existsSync(abs) && statSync(abs).isFile()))) {
        const ext = path.extname(abs).toLowerCase(), headers = { "content-type": MIME[ext] || "application/octet-stream", "cache-control": staticCacheControl(ext, abs) };
        if (ext === ".html") headers["content-security-policy"] = SLIDE_CSP;
        res.writeHead(200, headers); res.end(publicCopy(abs, readStaticFile(abs))); return;
      }
    }
    const origin = publicOrigin || `http://${req.headers.host || `${HOST}:${PORT}`}`;
    const scopedMcpPath = `/mcp/d/${documentId}`;
    const mcpPath = p === scopedMcpPath ? scopedMcpPath : "/mcp";
    const metadataPaths = new Set([
      "/.well-known/oauth-protected-resource",
      "/.well-known/oauth-protected-resource/mcp",
      `/.well-known/oauth-protected-resource${scopedMcpPath}`,
    ]);
    if (req.method === "GET" && metadataPaths.has(p)) {
      json(res, 200, {
        resource: `${origin}${mcpPath}`, authorization_servers: ["https://accounts.google.com"],
        bearer_methods_supported: ["header"],
      });
      return;
    }
    if (p === "/mcp" || p === scopedMcpPath) {
      let agent = null;
      try { agent = await authenticator.bearerPrincipal(req); } catch {}
      if (!agent || !agent.scopes.includes("decks:read")) {
        res.writeHead(401, { "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource${mcpPath}"` });
        res.end(); return;
      }
      let role;
      try { role = access.requireView(agent); }
      catch {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "this deck is not shared with the agent's person" })); return;
      }
      const token = String(req.headers.authorization || "").slice(7);
      await serveMcp(mcpHandler, req, res, {
        origin, authInfo: { token, clientId: agent.clientId || agent.id, scopes: agent.scopes, resource: new URL(`${origin}${mcpPath}`), extra: { principal: agent, role } },
      });
      return;
    }
    if (!PUBLIC_VIEW_ONLY && req.method === "GET" && p === "/") {
      res.writeHead(302, { location: canonicalDocumentPath + url.search }); res.end(); return;
    }
    if (req.method === "GET" && p === canonicalDocumentPath) {
      const identity = await authenticator.browserPrincipal(req, res, url);
      if (!identity) return;
      access.remember(identity);
      access.requireView(identity);
      res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store" });
      res.end(url.searchParams.get("mode") === "present"
        ? presentationHtml() : readFileSync(path.join(ROOT, "engine", "editor", "editor.html")));
      return;
    }

    const identity = authenticator.principal(req);
    access.requireView(identity);
    if (!["GET", "HEAD"].includes(req.method)) authenticator.assertOrigin(req);

    if (req.method === "GET" && p === "/api/deck") {
      const manifest = readManifest();
      const cssFiles = readdirSync(SLIDES_DIR).filter((f) => f.endsWith(".css"));
      const themeFiles = existsSync(themeDir())
        ? readdirSync(themeDir()).filter((f) => /\.(md|json|css)$/.test(f)).sort()
        : [];
      json(res, 200, {
        deckId, manifest, document: readDocument(), owner: identity.name, user: identity,
        permission: {
          role: access.role(identity), canShare: access.role(identity) === "owner",
          privateOnly: process.env.DECKS_PRIVATE_DOGFOOD === "true",
        }, cssFiles, themeFiles, themeLocal: hasLocalTheme(),
        languageTools: { monaco: HAS_MONACO, markdownlint: HAS_MARKDOWNLINT },
        collaboration: collaborationBundle ? { enabled: true, path: "/collaboration" } : { enabled: false },
      });
      return;
    }

    if (req.method === "POST" && p === "/api/lint/markdown") {
      const { file, text } = await readBody(req);
      const abs = safeAssetPath(file);
      if (!abs || !abs.endsWith(".md") || typeof text !== "string") {
        json(res, 400, { error: "invalid Markdown asset or payload" }); return;
      }
      if (!HAS_MARKDOWNLINT) {
        json(res, 503, { error: "markdownlint is unavailable — run npm install" }); return;
      }
      const { lint } = await import("markdownlint/promise");
      const result = await lint({
        strings: { [file]: text },
        // Keep semantic/style checks, but let prose lines flow naturally.
        config: { default: true, MD013: false },
      });
      json(res, 200, { diagnostics: result[file] || [] });
      return;
    }

    if (req.method === "POST" && p === "/api/asset") {
      access.requireEdit(identity);
      const { file, text } = await readBody(req);
      const abs = safeAssetPath(file);
      if (!abs || typeof text !== "string") { json(res, 400, { error: "invalid asset path or payload" }); return; }
      if (!existsSync(abs)) {
        // Creating files is allowed only where the deck owns the tree: its
        // private theme copy (guidance, tokens, chrome) and its own CSS.
        // Shared themes stay read-only — other decks render from them.
        const creatable = abs.startsWith(localThemeDir + path.sep)
          || (abs.startsWith(SLIDES_DIR + path.sep) && abs.endsWith(".css"));
        if (!creatable) { json(res, 400, { error: "refusing to create files outside this deck's own theme and slides" }); return; }
      }
      if (abs.endsWith(".json")) {
        try { JSON.parse(text); } catch (e) { json(res, 400, { error: `invalid JSON: ${e.message}` }); return; }
      }
      const existedBefore = existsSync(abs);
      const changed = writeTracked(abs, text, "editor", identity.name);
      if (changed) {
        console.log("saved asset", rel(abs), `(${identity.name})`);
        // A brand-new theme file isn't in the collaboration asset map yet —
        // register it so it converges and materializes like the rest.
        if (!existedBefore && abs.startsWith(localThemeDir + path.sep)) {
          const document = collaborationServer?.hocuspocus.documents.get(documentId);
          if (document) addAsset(document, rel(abs).replace(new RegExp(`^decks/${deckId}/theme/`), `themes/${readManifest().theme}/`), text);
        }
        broadcast("guidance", { file: rel(abs) });
      }
      json(res, 200, { ok: true, changed, file: rel(abs) });
      return;
    }

    if (req.method === "POST" && p === "/api/save") {
      access.requireEdit(identity);
      const { file, html, clientId } = await readBody(req);
      const abs = safeSlidePath(file);
      if (!abs || typeof html !== "string" || !html.trimStart().startsWith("<!DOCTYPE")) {
        json(res, 400, { error: "invalid file path or html payload" });
        return;
      }
      if (!existsSync(abs)) {
        json(res, 400, { error: "refusing to create new slide files from the editor" });
        return;
      }
      const before = fileCache.get(rel(abs)) ?? readFileSync(abs, "utf8");
      const changed = withoutProvenance(before) !== withoutProvenance(html)
        ? writeTracked(abs, html, "editor", identity.name)
        : false;
      if (changed) {
        console.log("saved", rel(abs), `(${identity.name})`);
        broadcast("slide", { file: rel(abs), clientId: typeof clientId === "string" ? clientId.slice(0, 64) : undefined });
      }
      json(res, 200, { ok: true, changed, file: rel(abs) });
      return;
    }

    // Create a slide from the editor: a blank themed starter, or a copy of an
    // existing slide whose catalog keys are namespaced so the two never share
    // text. Every locale gets its entries in the same write — catalogs are
    // equal. Copied provenance stamps are stripped: a copy is new content.
    if (req.method === "POST" && p === "/api/slides") {
      access.requireEdit(identity);
      const { name, from } = await readBody(req);
      if (!Array.isArray(readManifest().locales)) { json(res, 400, { error: "slide creation requires i18n mode (locales as an array)" }); return; }
      if (!SLIDE_NAME.test(String(name || ""))) { json(res, 400, { error: "slide names are lowercase letters, digits and dashes" }); return; }
      if (existsSync(slideAbs(name))) { json(res, 409, { error: `slide "${name}" already exists` }); return; }
      const manifest = readManifest();
      let html;
      if (from) {
        if (!manifest.slides.includes(from)) { json(res, 400, { error: `no slide "${from}" to copy` }); return; }
        html = withoutProvenance(readFileSync(slideAbs(from), "utf8")).replaceAll(
          /data-i18n=(["'])([^"']+)\1/g, (m, q, key_) => `data-i18n=${q}${name}.${key_}${q}`);
        const sourceKeys = slideKeys(`decks/${deckId}/slides/${from}.html`);
        for (const loc of deckLocales()) {
          const cat = parseCatalog(loc);
          for (const key_ of sourceKeys) {
            const value = cat.i18n[key_];
            if (value !== undefined) cat.i18n[`${name}.${key_}`] = value;
          }
          writeCatalog(loc, cat, "editor", identity.name);
        }
      } else {
        html = blankSlide(name);
        for (const loc of deckLocales()) {
          const copy = BLANK_COPY[loc] || BLANK_COPY.en, cat = parseCatalog(loc);
          for (const [suffix, value] of Object.entries(copy)) cat.i18n[`${name}.${suffix}`] = value;
          writeCatalog(loc, cat, "editor", identity.name);
        }
      }
      writeTracked(slideAbs(name), html, "editor", identity.name);
      broadcast("slide", { file: rel(slideAbs(name)) });
      manifest.slides.push(name);
      writeTracked(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "editor", identity.name);
      broadcast("manifest");
      console.log(`created slide ${name} (${identity.name}${from ? `, copy of ${from}` : ""})`);
      json(res, 200, { ok: true, slide: name, slides: readManifest().slides });
      return;
    }

    if (p === "/api/i18n") {
      if (req.method === "GET") {
        const loc = url.searchParams.get("locale");
        if (!validLocale(loc)) { json(res, 400, { error: `invalid locale "${loc}"` }); return; }
        json(res, 200, parseCatalog(loc));
        return;
      }
      if (req.method === "POST") {
        access.requireEdit(identity);
        const { locale: loc, entries = {} } = await readBody(req);
        if (!validLocale(loc)) { json(res, 400, { error: `invalid locale "${loc}"` }); return; }
        const cat = parseCatalog(loc);
        // Only changed strings earn new provenance. Editing text and putting it
        // back before Save is a semantic no-op: no catalog write or history.
        const changedKeys = Object.keys(entries).filter((k) => cat.i18n[k] !== entries[k]);
        for (const k of changedKeys) {
          cat.i18n[k] = entries[k];
          cat.meta[k] = { modified: new Date().toISOString().replace(/\.\d{3}/, ""), author: identity.name };
        }
        let changed = false;
        if (changedKeys.length) {
          mkdirSync(path.join(SLIDES_DIR, "i18n"), { recursive: true });
          changed = writeCatalog(loc, cat, "editor", identity.name);
        }
        if (changed) console.log(`saved slides/i18n/${loc}.js (${changedKeys.length} key(s))`);
        json(res, 200, { ok: true, changed, changedKeys });
        return;
      }
    }

    if (req.method === "PATCH" && p === "/api/document") {
      access.requireEdit(identity);
      const { title } = await readBody(req);
      const document = writeDocumentTitle(title);
      broadcast("document", document);
      json(res, 200, document);
      return;
    }

    if (p === "/api/access" && req.method === "GET") {
      json(res, 200, access.list(identity));
      return;
    }
    if (p === "/api/access" && req.method === "POST") {
      json(res, 200, access.grant(identity, await readBody(req)));
      return;
    }
    if (p.startsWith("/api/access/") && req.method === "DELETE") {
      const result = access.revoke(identity, p.slice("/api/access/".length));
      collaborationServer?.hocuspocus.closeConnections(documentId);
      json(res, 200, result);
      return;
    }

    if (req.method === "GET" && p === "/api/tools") {
      const files = existsSync(TOOLS_DIR)
        ? readdirSync(TOOLS_DIR).filter((f) => f.endsWith(".js")).sort()
        : [];
      json(res, 200, { builtin: files, agent: agentTools() });
      return;
    }
    if (["PUT", "DELETE"].includes(req.method) && p.startsWith("/api/tools/agent/")) {
      access.requireEdit(identity);
      const name = p.slice("/api/tools/agent/".length).replace(/\.js$/, "");
      const code = req.method === "PUT" ? String((await readBody(req)).code || "") : "";
      json(res, 200, saveAgentTool({ name, code, remove: req.method === "DELETE", email: identity.email, author: identity.name }));
      return;
    }
    if (req.method === "GET" && p.startsWith("/api/tools/agent/")) {
      const file = p.slice("/api/tools/agent/".length);
      if (!/^[a-z0-9][a-z0-9-]{0,48}\.js$/.test(file) || !existsSync(path.join(AGENT_TOOLS_DIR, file))) { json(res, 404, { error: "no such tool" }); return; }
      const wanted = url.searchParams.get("sha256");
      if (wanted && agentTools().find((tool) => tool.file === file)?.sha256 !== wanted) { json(res, 409, { error: "tool changed since you enabled it" }); return; }
      res.writeHead(200, { "content-type": MIME[".js"], "cache-control": "no-store" });
      res.end(readFileSync(path.join(AGENT_TOOLS_DIR, file), "utf8"));
      return;
    }

    if (req.method === "GET" && p === "/api/history/catalog") {
      const source = catalogStateAt(url.searchParams.get("id") || "", url.searchParams.get("catalog") || "");
      if (source == null) { json(res, 404, { error: "no such catalog state" }); return; }
      res.writeHead(200, { "content-type": MIME[".js"], "cache-control": "no-store" });
      res.end(source);
      return;
    }

    if (req.method === "GET" && p === "/api/history/preview") {
      const id = url.searchParams.get("id") || "";
      const file = url.searchParams.get("file") || "";
      const catalog = url.searchParams.get("catalog") || "";
      if (!safeSlidePath(file) || (catalog && !safeCatalogPath(catalog))) {
        json(res, 400, { error: "invalid history path" }); return;
      }
      let html;
      if (id.startsWith("git:")) html = git("show", `${id.slice(4)}:${gitPath(file)}`);
      else if (id.startsWith("gitcat:")) html = readFileSync(safeSlidePath(file), "utf8");
      else {
        const entry = readJournal().find((candidate) => candidate.id === id);
        if (!entry) { json(res, 404, { error: "no such history entry" }); return; }
        html = entry.file === file ? entry.after || "" : readFileSync(safeSlidePath(file), "utf8");
      }
      if (html == null) { json(res, 404, { error: "no such slide state" }); return; }
      const dir = path.posix.dirname("/" + file.split(path.sep).join("/")) + "/";
      html = html.replace(/<head([^>]*)>/i, `<head$1><base id="__preview-base" href="${dir}">`);
      res.writeHead(200, { "content-type": MIME[".html"], "cache-control": "no-store", "content-security-policy": SLIDE_CSP });
      res.end(html);
      return;
    }

    if (req.method === "GET" && p === "/api/history") {
      const file = url.searchParams.get("file");
      const locale = url.searchParams.get("locale");
      const catalog = file && validLocale(locale) ? rel(catPath(locale)) : null;
      const keys = new Set(file ? slideKeys(file) : []);
      const commits = file ? gitCommitsFor(file) : null;
      const keysBySlide = new Map(readManifest().slides.map((name) => [name,
        new Set(slideKeys(`decks/${deckId}/slides/${name}.html`)),
      ]));
      const entries = readJournal()
        .filter((entry) => !file || entry.file === file
          || (entry.file === catalog && changedCatalogKeys(entry).some((key) => keys.has(key))))
        .map((entry) => {
          const changedKeys = changedCatalogKeys(entry);
          const directSlide = entry.file.startsWith(`decks/${deckId}/slides/`) && entry.file.endsWith(".html")
            ? path.basename(entry.file, ".html") : null;
          const slides = directSlide ? [directSlide] : [...keysBySlide]
            .filter(([, candidateKeys]) => changedKeys.some((key) => candidateKeys.has(key)))
            .map(([name]) => name);
          const out = {
            id: entry.id, ts: entry.ts, via: entry.via, author: entry.author, file: entry.file,
            type: safeCatalogPath(entry.file) ? "text" : "slide", keys: changedKeys, slides,
          };
          const match = entry.file === file && commits?.find((commit) => commit.blob === blobSha(entry.after ?? ""));
          if (match) out.commit = { hash: match.hash, subject: match.subject };
          return out;
        })
        .reverse()
        .slice(0, 30);
      const h = commits?.[0];
      const head = h ? {
        id: `git:${h.hash}`, ts: h.ts, via: "git", author: h.author,
        commit: { hash: h.hash, subject: h.subject }, type: "slide",
      } : null;
      let catalogHead = null;
      if (catalog && keys.size) {
        const line = git("log", "-1", "--format=%h%x00%cI%x00%an", "--", gitPath(catalog))?.trim();
        if (line) {
          const [hash, ts, author] = line.split("\0");
          catalogHead = { id: `gitcat:${hash}`, ts, via: "git", author, type: "text", commit: { hash, subject: "catalog" } };
        }
      }
      json(res, 200, { head, catalogHead, entries });
      return;
    }

    if (req.method === "POST" && p === "/api/revert") {
      access.requireEdit(identity);
      const { id } = await readBody(req);
      const entry = readJournal().find((e) => e.id === id);
      if (!entry) { json(res, 404, { error: "no such history entry" }); return; }
      const abs = safeSlidePath(entry.file, [".html", ".js", ".css"]);
      if (!abs) { json(res, 400, { error: "entry points outside slides/" }); return; }
      // Reverting is an edit: journaled, authored, broadcast like any other.
      writeTracked(abs, entry.after, "revert", identity.name);
      console.log(`reverted ${entry.file} to ${entry.ts} (${entry.author || "agent"}) by ${identity.name}`);
      broadcast("slide", { file: entry.file });
      json(res, 200, { ok: true });
      return;
    }

    if (req.method === "GET" && p === "/api/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        connection: "keep-alive",
      });
      res.write("retry: 500\n\n");
      sseClients.add(res);
      req.on("close", () => sseClients.delete(res));
      return;
    }

    if (req.method === "GET" && p === "/editor/collaboration.js" && collaborationBundle) {
      res.writeHead(200, { "content-type": MIME[".js"], "cache-control": "no-store" });
      res.end(collaborationBundle);
      return;
    }

    // Monaco is an optional, pinned editor dependency. Expose only its
    // distributable runtime under a stable same-origin URL (workers require
    // same-origin loading); never expose node_modules generally.
    if (req.method === "GET" && p.startsWith("/vendor/monaco/vs/") && HAS_MONACO) {
      const sub = p.slice("/vendor/monaco/vs/".length);
      const abs = path.resolve(MONACO_DIR, sub);
      if (abs.startsWith(MONACO_DIR + path.sep) && existsSync(abs) && statSync(abs).isFile()) {
        const ext = path.extname(abs).toLowerCase();
        res.writeHead(200, { "content-type": MIME[ext] || "application/octet-stream", "cache-control": "no-store" });
        res.end(readFileSync(abs));
        return;
      }
    }

    // ---- static files (slides, themes, assets) ----
    if (req.method === "GET" && !p.startsWith("/node_modules/") && !p.startsWith("/.git/")) {
      const contentPath = p.startsWith("/decks/") || p.startsWith("/themes/");
      const base = contentPath ? CONTENT_ROOT : ROOT;
      const abs = path.resolve(base, "." + p);
      const cached = contentPath && (fileCache.has(rel(abs)) || binaryCache.has(abs));
      if (abs.startsWith(base + path.sep) && (cached || (existsSync(abs) && statSync(abs).isFile()))) {
        const ext = path.extname(abs).toLowerCase();
        const headers = {
          "content-type": MIME[ext] || "application/octet-stream",
          "cache-control": contentPath ? staticCacheControl(ext, abs) : "no-store",
        };
        if (ext === ".html" && contentPath) headers["content-security-policy"] = SLIDE_CSP;
        res.writeHead(200, headers);
        res.end(contentPath ? readStaticFile(abs) : readFileSync(abs));
        return;
      }
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    if (!res.headersSent) json(res, e.statusCode || 500, { error: String(e.message || e) });
    else res.end();
  }
};

// ---- hot reload: tools, the editor itself, theme guidance, and slide files ----
const TOOLS_DIR = path.join(ROOT, "engine", "editor", "tools");
mkdirSync(TOOLS_DIR, { recursive: true });
const sseClients = new Set();
const timers = {};
const broadcast = (event, data = {}) => {
  const k = event + JSON.stringify(data);
  clearTimeout(timers[k]);
  timers[k] = setTimeout(() => {
    for (const c of sseClients) c.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    console.log(`hot-reload → ${event} (${sseClients.size} client(s))`);
  }, 150);
};

const watchSafe = (...options) => {
  try { return watch(...options); }
  catch (error) { console.warn(`file watching unavailable: ${error.message}`); return null; }
};
if (!PUBLIC_VIEW_ONLY) {
  watchSafe(TOOLS_DIR, () => broadcast("tools"));
  watchSafe(path.join(ROOT, "engine", "editor"), (ev, f) => { if (f === "editor.html") broadcast("editor"); });
  if (existsSync(themeDir()))
    watchSafe(themeDir(), (ev, f) => {
      if (!/\.(json|css|md)$/.test(f || "")) return;
      setTimeout(() => checkExternal(path.join(themeDir(), f)), 200);
      broadcast("guidance");
    });

  // External edits (agents on a CLI, hand edits): journal them and push to open
  // editors — the live bridge between agentic and WYSIWYG workflows.
  // Content comparison distinguishes self from other: writeTracked updates
  // fileCache before events fire, so our own writes are no-ops here.
  const checkExternal = (abs) => {
    if (!existsSync(abs)) return;
    const r = rel(abs);
    const now = readFileSync(abs, "utf8");
    if (fileCache.get(r) === now) return;
    appendJournal(journalEntry("cli", "", r, fileCache.get(r) ?? "", now));
    fileCache.set(r, now);
    const document = collaborationServer?.hocuspocus.documents.get(documentId);
    const imported = document
      ? importSourceFile(document, { relative: r, source: now, deckId, locales: readManifest().locales })
      : false;
    console.log("external edit →", r);
    if (!imported) broadcast("slide", { file: r });
  };
  watchSafe(SLIDES_DIR, { recursive: true }, (ev, f) => {
    if (!f || !/\.(html|js|css)$/.test(f)) return;
    const abs = path.join(SLIDES_DIR, f);
    setTimeout(() => checkExternal(abs), 200);
  });
  // fs.watch (recursive) misses events on Linux under load — reconcile by mtime
  // sweep as a safety net (cheap: a handful of stats every 2s).
  const mtimes = new Map();
  setInterval(() => {
    for (const r of fileCache.keys()) {
      const abs = path.join(CONTENT_ROOT, r);
      try {
        const mt = statSync(abs).mtimeMs;
        if (mtimes.get(r) !== undefined && mtimes.get(r) !== mt) checkExternal(abs);
        mtimes.set(r, mt);
      } catch {}
    }
  }, 2000).unref();
}

const currentManifest = readManifest();
let server;
if (collaborationBundle && Array.isArray(currentManifest.locales)) {
  const assets = [
    ...readdirSync(themeDir()).filter((file) => /\.(md|json|css)$/.test(file)).map((file) => [
      `themes/${currentManifest.theme}/${file}`, path.join(themeDir(), file),
    ]),
    ...readdirSync(SLIDES_DIR).filter((file) => file.endsWith(".css")).map((file) => [
      `decks/${deckId}/slides/${file}`, path.join(SLIDES_DIR, file),
    ]),
  ];
  collaborationServer = await createCollaborationServer({
    port: PORT,
    host: HOST,
    deckDir: DECK_DIR,
    deckId,
    documentId,
    locales: currentManifest.locales,
    assetFiles: assets,
    stateFile: path.join(HISTORY_DIR, "collaboration.bin"),
    debounce: CONTENT_ROOT === ROOT ? 120 : 1000,
    maxDebounce: CONTENT_ROOT === ROOT ? 1000 : 5000,
    write: (file, content, author) => writeTracked(file, content, "collab", author),
    onMaterialize: ({ assetsChanged, catalogsChanged }) => {
      if (assetsChanged) broadcast("guidance");
      if (catalogsChanged) broadcast("slide", { catalog: true });
    },
    httpHandler: handleHttp,
    websocketPath: "/collaboration",
    authenticateConnection(request) {
      authenticator.assertOrigin(request);
      const identity = authenticator.principal(request);
      access.requireEdit(identity);
      return { id: identity.id, name: identity.name, kind: identity.type };
    },
  });
  server = collaborationServer.httpServer;
} else {
  server = createServer(handleHttp);
  await new Promise((resolve) => server.listen(PORT, HOST, resolve));
}

console.log(`decks design harness — ${currentManifest.name} (${deckId})`);
console.log(`owner: ${owner || "(unset — editor will ask)"}`);
const displayOrigin = publicOrigin || `http://${HOST}:${PORT}`;
console.log(`document → ${displayOrigin}/presentation/d/${documentId}`);
if (collaborationServer) console.log(`collaboration → ${displayOrigin.replace(/^http/, "ws")}/collaboration`);

let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  if (collaborationServer) await collaborationServer.destroy();
  else await new Promise((resolve) => server.close(resolve));
  process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
