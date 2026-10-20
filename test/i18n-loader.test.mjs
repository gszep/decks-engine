import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { I18N_LOADER, withI18nLoader } from '../engine/i18n-loader.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const loaders = (html) => html.split('engine/i18n.js').length - 1;
const keyed = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><style>.a{}</style></head><body><div class="slide"><h2 data-i18n="x.h"></h2></div></body></html>';

test('a keyed slide without the loader gets exactly one, and nothing else changes', () => {
  const out = withI18nLoader(keyed);
  assert.equal(loaders(out), 1);
  assert.equal(out.replace(I18N_LOADER, ''), keyed);
  assert.equal(withI18nLoader(out), out);
});

test('existing loaders, unkeyed slides and headless documents', () => {
  const existing = keyed.replace('</head>', '<script src="../../../engine/i18n.js?v=2"></script></head>');
  assert.equal(withI18nLoader(existing), existing);
  const plain = '<!DOCTYPE html><html><head></head><body><h1>Static</h1></body></html>';
  assert.equal(withI18nLoader(plain), plain);
  const noHead = '<html><body><p data-i18n="k"></p></body></html>';
  assert.equal(loaders(withI18nLoader(noHead)), 1);
  assert.match(withI18nLoader(noHead), /i18n\.js"><\/script><body>/);
});

test('plain PDF export serves editor-created keyed slides with the loader', () => {
  const content = mkdtempSync(path.join(tmpdir(), 'decks-loader-'));
  try {
    const deck = path.join(content, 'decks', 'fixture');
    cpSync(path.join(root, 'test', 'fixtures', 'deck'), deck, { recursive: true });
    cpSync(path.join(root, 'themes'), path.join(content, 'themes'), { recursive: true });
    writeFileSync(path.join(deck, 'slides', 'agent-made.html'), keyed.replace('x.h', 'title.h1'));
    const manifest = JSON.parse(readFileSync(path.join(deck, 'deck.json'), 'utf8'));
    manifest.slides.push('agent-made');
    writeFileSync(path.join(deck, 'deck.json'), JSON.stringify(manifest));
    // Stand-in browser: saves the HTML each slide URL serves instead of a screenshot.
    const chrome = path.join(content, 'fake-chrome.mjs');
    writeFileSync(chrome, `#!${process.execPath}
import { writeFileSync } from 'node:fs';
const args = process.argv.slice(2), shot = args.find((a) => a.startsWith('--screenshot='));
const pdf = args.find((a) => a.startsWith('--print-to-pdf='));
if (shot) writeFileSync(shot.slice(13), await (await fetch(args.at(-1))).text());
if (pdf) writeFileSync(pdf.slice(15), '%PDF-1.4');
`);
    chmodSync(chrome, 0o755);
    execFileSync(process.execPath, [path.join(root, 'engine', 'build.mjs'), 'fixture', '--keep-pngs'], {
      cwd: root, env: { ...process.env, CHROME: chrome, DECKS_CONTENT_ROOT: content }, stdio: 'pipe',
    });
    const served = (n, name) => readFileSync(path.join(deck, 'dist', 'render', `slide-0${n}-${name}.png`), 'utf8');
    assert.equal(loaders(served(3, 'agent-made')), 1);
    assert.equal(loaders(served(1, 'title')), 1);
    assert.equal(loaders(readFileSync(path.join(deck, 'slides', 'agent-made.html'), 'utf8')), 0, 'export never rewrites the source');
  } finally {
    rmSync(content, { recursive: true, force: true });
  }
});
