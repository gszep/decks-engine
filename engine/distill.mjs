#!/usr/bin/env node
// decks distillation — mine human-authored edits for design-rule candidates.
//
//   node engine/distill.mjs <deck>            # report to stdout (markdown)
//
// Reads the ground truth (slides + i18n catalogs) and the local journal, finds
// everything humans finalized through the design harness (data-author elements,
// authored catalog keys), clusters recurring inline-style corrections, and
// proposes promotions into theme/deck CSS or guidance.json changes.
//
// This is the "compile user corrections into better defaults" loop: run it
// periodically (or hand the report to a coding agent) so the 80% starting
// point rises toward what designers actually do. No npm dependencies.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CONTENT_ROOT = path.resolve(process.env.DECKS_CONTENT_ROOT || ROOT);
const deckId = process.argv[2];
if (!deckId) { console.error("usage: node engine/distill.mjs <deck>"); process.exit(1); }
const DECK_DIR = path.join(CONTENT_ROOT, "decks", deckId);
const SLIDES_DIR = path.join(DECK_DIR, "slides");
const manifest = JSON.parse(readFileSync(path.join(DECK_DIR, "deck.json"), "utf8"));

// ---- collect human-authored element edits from the slide HTML ----
// (regex-parse: elements carrying data-author; enough for a report.)
const edits = []; // {file, tag, classes, author, modified, styles: {prop: value}}
for (const f of readdirSync(SLIDES_DIR).filter((f) => f.endsWith(".html"))) {
  const src = readFileSync(path.join(SLIDES_DIR, f), "utf8");
  for (const m of src.matchAll(/<(\w+)([^>]*?)data-author="([^"]*)"([^>]*?)>/g)) {
    const attrs = m[2] + m[4];
    const cls = (attrs.match(/class="([^"]*)"/) || [])[1] || "";
    const modified = (attrs.match(/data-modified="([^"]*)"/) || [])[1] || "";
    const style = (attrs.match(/style="([^"]*)"/) || [])[1] || "";
    const styles = {};
    for (const decl of style.split(";")) {
      const [p, ...v] = decl.split(":");
      if (p.trim()) styles[p.trim()] = v.join(":").trim();
    }
    edits.push({ file: f, tag: m[1], classes: cls, author: m[3], modified, styles });
  }
}

// ---- collect authored i18n keys ----
const i18nAuthored = [];
const i18nDir = path.join(SLIDES_DIR, "i18n");
if (existsSync(i18nDir)) {
  for (const f of readdirSync(i18nDir).filter((f) => f.endsWith(".js"))) {
    const src = readFileSync(path.join(i18nDir, f), "utf8");
    const m = src.match(/window\.I18N_META\s*=\s*(\{[\s\S]*?\n?\});/);
    if (!m) continue;
    try {
      for (const [key, meta] of Object.entries(JSON.parse(m[1])))
        if (meta.author) i18nAuthored.push({ locale: f.replace(/\.js$/, ""), key, ...meta });
    } catch {}
  }
}

// ---- journal (local, may be absent) ----
const journalPath = path.join(DECK_DIR, ".history", "journal.ndjson");
const journal = existsSync(journalPath)
  ? readFileSync(journalPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];
const humanJournal = journal.filter((e) => e.author);

// ---- cluster recurring style corrections ----
const propCounts = {}; // "prop: value" -> [{file, selectorish}]
for (const e of edits) {
  for (const [p, v] of Object.entries(e.styles)) {
    if (p === "position" || p === "left" || p === "top") continue; // one-off nudges
    const k = `${p}: ${v}`;
    (propCounts[k] ||= []).push(`${e.file} <${e.tag}${e.classes ? "." + e.classes.split(" ")[0] : ""}>`);
  }
}
const nudges = edits.filter((e) => e.styles.left || e.styles.top);

// ---- report ----
const lines = [];
const say = (s = "") => lines.push(s);
say(`# Distillation report — ${manifest.name} (${deckId})`);
say();
say(`Human-finalized elements: **${edits.length}** · authored i18n keys: **${i18nAuthored.length}** · journal entries by humans: **${humanJournal.length}**`);
say();

if (!edits.length && !i18nAuthored.length) {
  say("No human-authored edits found — nothing to distill yet.");
} else {
  const recurring = Object.entries(propCounts).filter(([, sites]) => sites.length >= 2);
  if (recurring.length) {
    say(`## Recurring style corrections (candidates for promotion)`);
    say();
    for (const [decl, sites] of recurring.sort((a, b) => b[1].length - a[1].length)) {
      say(`- \`${decl}\` — ${sites.length}×: ${sites.join(", ")}`);
      say(`  - propose: a theme/deck CSS rule making this the default (keep the rendered result identical), then remove the inline copies **with the designer's sign-off** (they carry data-author).`);
    }
    say();
  }
  const oneOff = Object.entries(propCounts).filter(([, sites]) => sites.length === 1);
  if (oneOff.length) {
    say(`## One-off corrections (watch; promote if repeated in other decks)`);
    say();
    for (const [decl, sites] of oneOff) say(`- \`${decl}\` — ${sites[0]}`);
    say();
  }
  if (nudges.length) {
    say(`## Positional nudges (usually layout smells, not rule candidates)`);
    say();
    for (const e of nudges)
      say(`- ${e.file} <${e.tag}${e.classes ? "." + e.classes.split(" ")[0] : ""}> left:${e.styles.left || "0"} top:${e.styles.top || "0"} (${e.author}, ${e.modified})`);
    say();
    say(`If the same element is nudged in several decks, the theme's layout defaults are wrong — fix the chrome, not the slides.`);
    say();
  }
  if (i18nAuthored.length) {
    say(`## Human-adjusted translations (do not machine-retranslate)`);
    say();
    for (const k of i18nAuthored) say(`- ${k.locale}: \`${k.key}\` (${k.author}, ${k.modified})`);
    say();
  }
}
say(`---`);
say(`Next step: review with the designers, then encode accepted findings in themes/*/guidance.json, GUIDANCE.md, or theme/deck CSS. Rule and token changes hot-reload into open editors.`);
console.log(lines.join("\n"));
