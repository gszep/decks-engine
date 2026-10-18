#!/usr/bin/env node
// decks engine — render a deck's HTML slides to a PDF with headless Chrome.
//
// Ground truth is the HTML in decks/<deck>/slides/ (+ the theme CSS it imports).
// Each slide is rendered full-bleed at 1280x720 (2x) to PNG, then assembled into
// a 16:9 PDF — one image per page, printed by Chrome. No npm dependencies.
//
//   node engine/build.mjs <deck>                    # default locale → dist/<Name>.pdf
//   node engine/build.mjs <deck> --locale ja        # one locale     → dist/<Name>-ja.pdf
//   node engine/build.mjs <deck> --locale all       # every locale in the manifest
//   node engine/build.mjs <deck> --keep-pngs        # + per-slide QA PNGs in dist/render/
//   CHROME=/path/to/chrome node engine/build.mjs <deck>
//
// The manifest is decks/<deck>/deck.json:
//   { name, theme, slides: [..], locales: ["en", "ja"], defaultLocale }
// i18n mode (locales as array): ALL locales are equal — one structural HTML
// per slide, text only in slides/i18n/<id>.js catalogs, rendered with
// ?lang=<id> via engine/i18n.js. Legacy mode (locales as object of subdirs,
// e.g. { en: ".", ja: "ja" }) still works: full mirrors.
//
// PDFs are generated build artifacts (gitignored); never hand-edit them.
// There are no version numbers: one latest PDF per locale, overwritten in
// place — history and provenance live in git + data-modified/data-author.
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, existsSync, copyFileSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The engine and the content root are separable (see engine/edit.mjs).
const ENGINE_ROOT = ROOT;
const CONTENT_ROOT = path.resolve(process.env.DECKS_CONTENT_ROOT || ENGINE_ROOT);

// ---- CLI ----
const args = process.argv.slice(2);
const deckId = args.find((a) => !a.startsWith("--"));
const flag = (name) => {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? undefined : args[i + 1];
};
const KEEP_PNGS = args.includes("--keep-pngs");
if (!deckId) {
  const available = existsSync(path.join(CONTENT_ROOT, "decks")) ? readdirSync(path.join(CONTENT_ROOT, "decks")).join(", ") : "(none)";
  console.error(`usage: node engine/build.mjs <deck> [--locale <id|all>] [--keep-pngs]\navailable decks: ${available}`);
  process.exit(1);
}

// ---- Manifest ----
const DECK_DIR = path.join(CONTENT_ROOT, "decks", deckId);
const manifestPath = path.join(DECK_DIR, "deck.json");
if (!existsSync(manifestPath)) {
  console.error(`no manifest at ${path.relative(process.cwd(), manifestPath)}`);
  process.exit(1);
}
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const { name, slides, locales = ["en"], defaultLocale = "en" } = manifest;
const I18N_MODE = Array.isArray(locales);
const localeIds = I18N_MODE ? locales : Object.keys(locales);
for (const [key, why] of [["name", name], ["slides", slides?.length]]) {
  if (!why) { console.error(`deck.json is missing "${key}"`); process.exit(1); }
}
const themeDir = manifest.theme && path.join(CONTENT_ROOT, "themes", manifest.theme);
if (themeDir && !existsSync(themeDir)) console.warn(`warning: theme "${manifest.theme}" not found under themes/`);

const localeArg = flag("locale") || defaultLocale;
const targets = localeArg === "all" ? localeIds : [localeArg];
for (const loc of targets) {
  if (!localeIds.includes(loc)) {
    console.error(`locale "${loc}" not in manifest (have: ${localeIds.join(", ")})`);
    process.exit(1);
  }
}

// ---- Chrome ----
const CHROME_CANDIDATES = [
  process.env.CHROME,
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
].filter(Boolean);
const CHROME = CHROME_CANDIDATES.find((p) => existsSync(p));
if (!CHROME) {
  console.error("No Chrome/Chromium found. Set CHROME=/path/to/chrome.");
  process.exit(1);
}

const DIST = path.join(DECK_DIR, "dist");
mkdirSync(DIST, { recursive: true });
const QA_DIR = path.join(DIST, "render");
if (KEEP_PNGS) mkdirSync(QA_DIR, { recursive: true });

// ---- Locale sync check ----
if (I18N_MODE) {
  // Every locale catalog must cover every data-i18n key used by the slides.
  const keysInSlides = new Set();
  for (const s of slides) {
    const f = path.join(DECK_DIR, "slides", `${s}.html`);
    if (!existsSync(f)) continue;
    for (const m of readFileSync(f, "utf8").matchAll(/data-i18n="([^"]+)"/g)) keysInSlides.add(m[1]);
  }
  for (const loc of localeIds) {
    const cat = path.join(DECK_DIR, "slides", "i18n", `${loc}.js`);
    if (!existsSync(cat)) { console.warn(`warning: no catalog at slides/i18n/${loc}.js`); continue; }
    const m = readFileSync(cat, "utf8").match(/window\.I18N\s*=\s*(\{[\s\S]*?\n\});/);
    let keys = [];
    try { keys = Object.keys(JSON.parse(m[1])); }
    catch { console.warn(`warning: could not parse slides/i18n/${loc}.js`); continue; }
    const missing = [...keysInSlides].filter((k) => !keys.includes(k));
    const extra = keys.filter((k) => !keysInSlides.has(k));
    if (missing.length) console.warn(`warning: locale "${loc}" catalog is missing keys: ${missing.join(", ")}`);
    if (extra.length) console.warn(`warning: locale "${loc}" catalog has unused keys: ${extra.join(", ")}`);
  }
} else {
  // Legacy mirrors: every locale should carry the same slide set.
  for (const [loc, sub] of Object.entries(locales)) {
    const dir = path.join(DECK_DIR, "slides", sub);
    const missing = slides.filter((s) => !existsSync(path.join(dir, `${s}.html`)));
    if (missing.length) console.warn(`warning: locale "${loc}" is missing slides: ${missing.join(", ")}`);
    const extra = existsSync(dir)
      ? readdirSync(dir).filter((f) => f.endsWith(".html") && !slides.includes(f.replace(/\.html$/, "")))
      : [];
    if (extra.length) console.warn(`warning: locale "${loc}" has slides not in the manifest: ${extra.join(", ")}`);
  }
}

// ---- Build each requested locale ----
for (const locale of targets) {
  const SRC = I18N_MODE ? path.join(DECK_DIR, "slides") : path.join(DECK_DIR, "slides", locales[locale]);
  const urlSuffix = I18N_MODE ? `?lang=${locale}` : ""; // every locale through the same path
  const suffix = locale === defaultLocale ? "" : `-${locale}`;
  const tmp = mkdtempSync(path.join(tmpdir(), "decks-"));

  // 1) Render each slide HTML to a 2x PNG (these ARE the slides).
  const pngs = [];
  for (const slideName of slides) {
    const html = path.join(SRC, `${slideName}.html`);
    if (!existsSync(html)) { console.warn("skip (missing):", `${locale}/${slideName}`); continue; }
    const png = path.join(tmp, `${slideName}.png`);
    execFileSync(CHROME, [
      "--headless=new", "--no-sandbox", "--hide-scrollbars",
      "--force-device-scale-factor=2", "--window-size=1280,720",
      "--default-background-color=ffffffff", "--virtual-time-budget=4000",
      `--screenshot=${png}`, `file://${html}${urlSuffix}`,
    ], { stdio: "ignore" });
    pngs.push(png);
    if (KEEP_PNGS) {
      const idx = String(slides.indexOf(slideName) + 1).padStart(2, "0");
      copyFileSync(png, path.join(QA_DIR, `slide-${idx}-${slideName}${suffix}.png`));
    }
    console.log("rendered", `${locale}/${slideName}`);
  }
  if (!pngs.length) { console.error(`no slides rendered for locale "${locale}"`); process.exit(1); }

  // 2) Assemble the PDF: one full-bleed image per 16:9 page, printed by Chrome.
  const printHtml = path.join(tmp, "print.html");
  writeFileSync(printHtml, `<!DOCTYPE html>
<html><head><meta charset="utf-8"><style>
  @page { size: 13.333in 7.5in; margin: 0; }
  html, body { margin: 0; padding: 0; }
  .page { width: 13.333in; height: 7.5in; page-break-after: always; overflow: hidden; }
  .page:last-child { page-break-after: auto; }
  .page img { width: 100%; height: 100%; display: block; }
</style></head><body>
${pngs.map((p) => `<div class="page"><img src="file://${p}"></div>`).join("\n")}
</body></html>
`);

  const out = path.join(DIST, `${name}${suffix}.pdf`);
  execFileSync(CHROME, [
    "--headless=new", "--no-sandbox", "--no-pdf-header-footer",
    "--virtual-time-budget=8000",
    `--print-to-pdf=${out}`, `file://${printHtml}`,
  ], { stdio: "ignore" });

  rmSync(tmp, { recursive: true, force: true });
  console.log(`\n✓ generated ${path.relative(process.cwd(), out)} (${pngs.length} slides${suffix ? `, ${locale}` : ""})`);
}
if (KEEP_PNGS) console.log("✓ QA slide images →", path.relative(process.cwd(), QA_DIR));
