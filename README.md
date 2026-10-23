# decks

A reusable, zero/low-dependency deck-building pipeline: **HTML slides + theme
CSS are the ground truth**; headless Chrome renders them into 16:9 PDFs. An
optional WYSIWYG design editor with realtime collaboration writes edits
straight back to the HTML and per-locale text catalogs — the browser is the
design tool, the files stay yours.

- **PDF builds have no npm dependencies** — only Node builtins and Chrome.
- **The optional editor** uses pinned VS Code-derived tooling (Monaco,
  markdownlint) with a plain-textarea fallback when not installed.
- **Bilingual by default** (English + Japanese): one structural HTML per
  slide, ALL text lives in per-locale catalogs (`slides/i18n/<locale>.js`).
- **Design guidance is checkable**: each theme ships `GUIDANCE.md` (prose) and
  `guidance.json` (machine-checkable rules the editor enforces — the escape
  hatch is editing the rule, an explicit reviewable diff).
- **Human edits are protected**: elements a designer finalized are stamped
  `data-author` + `data-modified`; agents may change anything except them.
- **Agents are first-class editors**: a per-deck MCP server exposes read/write
  tools; agents act for a person, capped at editor, and never inherit
  ownership.

## Quickstart

```bash
npm install                     # editor tooling only; PDF builds work without it
node engine/build.mjs demo --keep-pngs   # → decks/demo/dist/demo.pdf + QA PNGs
node engine/edit.mjs demo       # → http://localhost:8000 (WYSIWYG editor)
```

Chrome is auto-discovered; override with `CHROME=/path/to/chrome`.

## Layout

```
engine/build.mjs        the pipeline: manifest → Chrome renders → 16:9 PDF
engine/edit.mjs         the design harness HTTP server
engine/host.mjs         multi-document front door (hosting)
engine/collaboration.mjs realtime state, persistence, source materialization
engine/editor/          the editor shell + collaboration client + tools
engine/i18n.js          slide-side loader: ?lang=x → swap [data-i18n] strings
engine/distill.mjs      mine human edits → propose guidance/token updates
engine/registry.mjs     createDeck: scaffold a new deck (private theme copy)
themes/<theme>/         theme.css entry + tokens/chrome + GUIDANCE.md/json
decks/<deck>/
  deck.json             manifest: stable documentId, name, theme, slides, locales
  slides/*.html         ground truth — one structural file per slide
  slides/i18n/<loc>.js  string catalogs — ALL locales, incl. the default
  slides/<deck>.css     deck chrome: @imports the theme + deck-specific rules
  .history/             journal, collaboration state, title (gitignored)
  dist/                 generated PDFs + QA PNGs (gitignored)
```

## Engine and content are separable

The engine is a deck-agnostic program; decks, themes and tools form a
**content root**. Here they live together for development, but
`DECKS_CONTENT_ROOT` can point anywhere — a mounted bucket (hosted), a
standalone content checkout, or a private repo you never publish. Every entry
point honors it, and the git journal/provenance runs against **the repository
containing the content root**, so durable history follows the content, not the
engine install. The Docker image carries the engine only.

This repo ships `themes/starter` (an original generic theme) and
`themes/chibatech` (a denser, darker take on the same structural rules) plus
the `demo` deck. Your real content stays wherever you keep it.

## Hosting (optional)

`engine/host.mjs` serves many decks from one content root: it discovers every
`decks/*/deck.json`, isolates each document in its own child process (ACLs,
Yjs state and materialization included), and routes `/d/<documentId>`
(presentation), `/presentation/d/<documentId>` (editor) and
`/mcp/d/<documentId>` (agent MCP). Access control is deterministic:
humans, domains, and agents are separate principals; every HTTP mutation and
WebSocket handshake is authorized server-side; private hosting fails closed
without identity headers (Google IAP is supported end to end). Anyone signed
in can create a deck they own; agents get `create_deck` through the connector.

On public view-only hosts, decks can be gated: the host-wide
`DECKS_VIEW_PASSWORD` applies to every listed deck, and a deck's **owner may
set a per-deck view password** (editor → Share → *Public talks site*; stored
only as a salted verifier in gitignored `.history/view.json` — never plain-
text). A per-deck password overrides the global one for that deck alone;
unlock cookies are document-bound, so unlocking one deck never unlocks
another, and changing a deck's password invalidates its prior unlock state.
Owners may also toggle whether the deck is listed publicly. Agents and
editors can never set passwords or change publication — that is owner-only,
enforced server-side.

`Dockerfile` builds the hosted image (engine only, content mounted at
`/content`).

## Agent access (MCP)

`POST /mcp/d/<documentId>` is served by the official MCP TypeScript SDK;
protected-resource metadata lives at
`/.well-known/oauth-protected-resource/mcp/d/<documentId>`. Tools:
`get_presentation`, `read_slide`, `read_styles`, `read_guidance`,
`update_catalog_text` (optimistic expected-value check), `write_slide`,
`set_slide_order`, `write_guidance`, `write_editor_tool`.

A standalone connector (`engine/agent.mjs`) signs a person in with Google
device sign-in and runs as a stdio MCP server spanning every deck shared with
that person — see the instructions your host serves at `/agents`.

## Test

```bash
npm test            # unit: ACL, auth, collaboration, slides, creation
npm run test:e2e    # two isolated Chrome users: presence, text, Monaco, reconnect, agent edits
```

## License

MIT — see [LICENSE](LICENSE).
