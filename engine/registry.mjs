// Deck creation as a library: the host (and tests) call createDeck to add a
// new document under CONTENT_ROOT/decks. Zero dependencies — hosting must
// never require npm packages.
//
// Every created deck owns a PRIVATE copy of its theme (decks/<slug>/theme/):
// guidance, tokens and chrome are editable by the deck's owner without
// touching the shared themes/ tree other decks render from. Slides follow the
// i18n-mode constitution: one structural HTML per slide, all text in per-locale
// catalogs (en + ja by default), deck CSS imports the theme by URL.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

const SLUG = /^[a-z0-9][a-z0-9-]{0,48}$/;

export const newDocumentId = () => randomBytes(24).toString("base64url");

export const slugify = (name) => {
  const slug = String(name || "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  if (!SLUG.test(slug)) throw new Error("deck name needs at least one letter or digit (a-z, 0-9, dashes)");
  return slug;
};

const serializeCatalog = (locale, deckId, i18n) =>
  `// ${locale} strings for ${deckId} — keys match data-i18n attributes in slides/*.html.\n` +
  `// I18N_META records provenance per key: { modified, author } — author absent ⇒ agent edit.\n` +
  `window.I18N = ${JSON.stringify(i18n, null, 2)};\n` +
  `window.I18N_META = {};\n`;

const starterSlide = (name) => `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8">
<link rel="stylesheet" href="deck.css">
<script src="../../../engine/i18n.js"></script>
</head>
<body><div class="slide">
  <span class="eyebrow" data-i18n="title.eyebrow"></span>
  <h1 class="t" data-i18n="title.h1"></h1>
  <p class="lede" data-i18n="title.lede"></p>
  <div class="spacer"></div>
  <div class="foot"><span class="wordmark">${name}</span></div>
</div></body></html>
`;

const STARTER_COPY = {
  en: { "title.eyebrow": "New deck", "title.h1": "Your first slide", "title.lede": "Edit this text in the editor — or ask your agent." },
  ja: { "title.eyebrow": "新しいデッキ", "title.h1": "最初のスライド", "title.lede": "エディタで編集するか、エージェントに頼んでみてください。" },
};

// Create a deck directory and return its identifiers. `owner` is the human
// principal (id/email/name) who becomes the document owner in access.json —
// nobody else, not even the creator's agent, inherits ownership.
export function createDeck({ contentRoot, name, owner, theme = process.env.DECKS_DEFAULT_THEME || "starter", locales = ["en", "ja"], defaultLocale = "en" }) {
  const deckRoot = path.join(contentRoot, "decks");
  const themesDir = path.join(contentRoot, "themes", theme);
  if (!existsSync(path.join(themesDir, "theme.css"))) throw new Error(`unknown theme "${theme}"`);
  const base = slugify(name);
  let deckId = base;
  for (let n = 2; existsSync(path.join(deckRoot, deckId)); n++) deckId = `${base}-${n}`;
  const dir = path.join(deckRoot, deckId);
  const documentId = newDocumentId();
  const locales_ = Array.isArray(locales) && locales.length ? locales : ["en"];

  mkdirSync(path.join(dir, "slides", "i18n"), { recursive: true });
  // Private theme copy — the deck's own design constitution.
  cpSync(themesDir, path.join(dir, "theme"), { recursive: true });
  writeFileSync(path.join(dir, "deck.json"), JSON.stringify({
    name: deckId, documentId, theme, slides: ["title"], locales: locales_, defaultLocale,
  }, null, 2) + "\n");
  writeFileSync(path.join(dir, "slides", "deck.css"),
    `/* ${deckId} — deck styles on top of the ${theme} theme. */\n@import url("../../../themes/${theme}/theme.css");\n`);
  writeFileSync(path.join(dir, "slides", "title.html"), starterSlide(deckId));
  for (const locale of locales_) {
    const copy = STARTER_COPY[locale] || STARTER_COPY.en;
    writeFileSync(path.join(dir, "slides", "i18n", `${locale}.js`), serializeCatalog(locale, deckId, copy));
  }
  mkdirSync(path.join(dir, ".history"), { recursive: true });
  writeFileSync(path.join(dir, ".history", "access.json"), JSON.stringify({
    documentId,
    owner: { id: owner.id, email: String(owner.email || "").toLowerCase(), name: owner.name, type: "human" },
    permissions: [],
    identities: [{ id: owner.id, email: String(owner.email || "").toLowerCase(), name: owner.name }],
  }, null, 2) + "\n");
  return { deckId, documentId, dir, files: readdirSync(dir) };
}
