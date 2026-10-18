# decks — agent contract

A deck-building pipeline: HTML slides + theme CSS are the ground truth;
headless Chrome renders them into PDFs. See README.md for layout and commands.

## Rules

- **HTML is ground truth.** Never hand-edit anything in `dist/` — PDFs and QA
  PNGs are build artifacts and are gitignored. Rebuild instead. Realtime Yjs
  state under `.history/` is operational merge state: every accepted edit must
  materialize back to HTML/catalog/CSS, and source edits must import into an
  active room rather than being overwritten by it.
- **Locales are catalogs, not mirrors — and all locales are equal.** In i18n
  mode (`locales` is an array in `deck.json`) each slide is ONE structural
  HTML file whose `data-i18n` elements are empty; ALL text (every locale,
  including the default) lives in `slides/i18n/<locale>.js` — the single
  source of truth. When you change keyed text, update every catalog's key in
  the same commit (the engine warns on missing/unused keys). Locale-specific
  *layout* goes in `html[lang=".."]`-scoped CSS, never in a copied file.
- **Bilingual by default: English and Japanese.** New decks start in i18n
  mode with `"locales": ["en", "ja"]`; neither language is primary in the file
  structure, and every text change lands in both catalogs in the same commit.
  The presentation viewer shows each reader their browser's language (an
  explicit `?lang=` wins; `defaultLocale` is only the fallback). Japanese copy
  is friendly and polite: natural です/ます, short sentences, everyday words.
  Keep people's names, products, organisations, repositories and handles in
  Latin script; use katakana for tech words as Japanese speakers say them.
  Preserve inline HTML; headings may add `<br>` where Japanese reads better
  split. Size Japanese with the ×0.86 bridge in `html[lang="ja"]` CSS and
  check both languages' renders for overflow.
- **No hex in slides.** Colours and fonts come from theme tokens
  (`var(--ct-*)`). If a slide needs a colour the theme lacks, add a token.
- **Zero-dependency builds; established editor tooling.** PDF rendering uses
  only Node builtins + Chrome and must never require npm packages. The
  optional design editor may use pinned, audited, MIT-licensed
  browser/language tooling with a lockfile and a dependency-free fallback.
  Serve it locally (no CDN), keep it editor-scoped, and prefer established
  VS Code tooling over custom parsers or code editors. New editor
  dependencies require explicit discussion.
- **No version numbers.** Provenance is `data-modified` (ISO datetime) +
  `data-author` + git — never invent version fields. Rebuild every locale
  whenever content changes; there is exactly one latest PDF per locale
  (`dist/<Name>.pdf`, `dist/<Name>-<locale>.pdf`), overwritten in place.
- **Authorization is deterministic.** Humans, domains, and agents are separate
  principals. Enforce document role and token scope on every HTTP mutation,
  MCP tool, and WebSocket handshake—never in prompts or UI alone. Private
  hosting fails closed without IAP identity headers; agents cannot own, share,
  or directly overwrite human-finalized content.
- **Manifest is authoritative.** Slide order and the stable opaque `documentId`
  live in `deck.json`, not in the engine. The editable presentation title is
  operational metadata in ignored `.history/document.json`; URLs and indexes
  use `documentId`, so renaming never breaks a path. The engine stays
  deck-agnostic — no deck names, slide names, or narrative hardcoded in it.
  The engine checkout and the content root are separable:
  `DECKS_CONTENT_ROOT` points at the content (default: this checkout), and git
  journal/provenance history belongs to the repository containing the content
  root — never to the engine install.
- **Design language is per theme.** Each theme's `GUIDANCE.md` +
  `guidance.json` define its system (both bundled themes share the same
  skeleton: mostly B&W, one accent at a time, square corners, hard 3px rules,
  tight negative-kerned headings; JP type uses the JP font stack and the
  ×0.86 EN→JP size bridge). A deck may extend `--ct-*` tokens in its own CSS.
- **Verify visually.** After slide edits, build with `--keep-pngs` and read
  the rendered PNGs — overflow and clipping are invisible in the HTML source.
- **Respect human-finalized elements.** Designers make finishing touches
  through the WYSIWYG harness (`node engine/edit.mjs <deck>`), which stamps
  every element they touch with `data-author="<name>"` +
  `data-modified="<ISO datetime>"` (and per-key `{author, modified}` in i18n
  catalog META). **Only the harness writes these attributes** — never add,
  copy, or fake them. Agents must **never** remove, revert, or restyle an
  authored element's stamped inline styles or edited text unless the user
  explicitly asks for that element to change. Content edits inside an authored
  element are allowed when requested, but keep the stamps and inline styles
  intact. When an authored inline style becomes a recurring pattern, run
  `node engine/distill.mjs <deck>` and propose promoting it into theme/deck
  CSS (keeping the rendered result identical) rather than deleting it.
- **Guidance is the constitution.** `themes/<theme>/GUIDANCE.md` (prose) and
  `themes/<theme>/guidance.json` (machine-checkable rules) define the design
  system. If a request conflicts with a rule, say so and propose a rule change
  (a small, reviewable diff) instead of silently violating it. Deck-scoped
  variants are legitimate: decks may extend `--ct-*` tokens in their own CSS.
- **Editor tools are hot-reloadable.** Custom tools for the design harness go
  in `engine/editor/tools/` (contract in its README.md); open editors load,
  replace, and drop them live. Ephemeral one-shot tools are fine — delete them
  after use. While an editor is open, external edits to `slides/**` appear on
  the designer's canvas live and land in their history panel — prefer small,
  file-complete writes.
