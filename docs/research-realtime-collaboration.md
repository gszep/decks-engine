# Research: realtime collaborative, HTML-first decks

Status: completed for the MVP vertical-slice decision, updated 2026-08-05.

## Question

What should we reuse to build a browser-hosted deck editor with Google Slides-style collaboration, Figma-like visual control, HTML/CSS as the readable rendering format, and first-class agent participation?

## Findings so far

### No existing project has our exact source-of-truth model

The mature open-source products each solve a neighboring problem:

| Project | Useful evidence | Why we should not adopt it wholesale |
|---|---|---|
| [Penpot](https://github.com/penpot/penpot) (MPL-2.0) | Production collaborative design system; semantic shape operations; presence; plugins; current-page MCP bridge | Its Clojure/ClojureScript/PostgreSQL stack and `.penpot` shape model would replace HTML as the deck representation |
| [Excalidraw](https://github.com/excalidraw/excalidraw) (MIT) | Lean scene-object model, presence, encrypted rooms, embeddable canvas | Whiteboard scene rather than DOM/CSS layout |
| [ONLYOFFICE Document Server](https://github.com/ONLYOFFICE/DocumentServer) (AGPL-3.0) | Mature presentation co-editing, comments and history | OOXML/PPTX and a large office-layout stack become authoritative |
| [HedgeDoc](https://github.com/hedgedoc/hedgedoc) (AGPL-3.0) | Realtime collaborative Markdown with reveal.js presentation output | Source editing rather than Figma-like visual manipulation |
| [Slidev](https://github.com/slidevjs/slidev) (MIT) | Programmable HTML/Vue presentations, presenter mode and exports | No native multiplayer visual editor |
| [Onlook](https://github.com/onlook-dev/onlook) (Apache-2.0) | Runtime DOM-to-source mapping and visual edits written back to code | React/Next/Tailwind-specific and not primarily multiplayer |
| [GrapesJS](https://github.com/GrapesJS/grapesjs) (BSD-3-Clause) | Extensible visual HTML builder | Its component/project JSON is authoritative; arbitrary HTML does not round-trip losslessly |
| [tldraw](https://github.com/tldraw/tldraw) | Excellent canvas and sync engineering | Production SDK is source-available and requires a tldraw license, not free open source |

The product pattern to copy is therefore **Onlook's code/DOM bridge + Penpot/Figma's semantic collaborative operations**, not another application's document format.

### Figma is server-authoritative, not simply “use a CRDT”

Figma's engineering account describes a centralized multiplayer service, optimistic clients, stable object IDs and property-level last-writer-wins behavior. Server order resolves conflicts; tree operations receive additional validation. Figma avoided general OT and a fully decentralized CRDT for its structured design model. It later used a text-specific merge algorithm for code layers because long source text has different conflict behavior.

Sources:

- [How Figma's multiplayer technology works](https://www.figma.com/blog/how-figmas-multiplayer-technology-works/)
- [Making multiplayer more reliable](https://www.figma.com/blog/making-multiplayer-more-reliable/)
- [Building Figma's Code Layers](https://www.figma.com/blog/building-figmas-code-layers/)

This supports separating:

- semantic element/property operations for the visual canvas;
- collaborative text for source/catalog editing;
- ephemeral presence;
- durable checkpoints and a write-ahead journal.

### Yjs currently has the strongest reusable editor ecosystem

[Yjs](https://github.com/yjs/yjs) (MIT) provides shared maps, arrays, text and XML types; commutative/idempotent updates; undo; awareness; and mature bindings. It has direct Monaco support through [y-monaco](https://github.com/yjs/y-monaco) and a conventional WebSocket provider.

[Hocuspocus](https://github.com/ueberdosis/hocuspocus) (MIT) provides a production-oriented Yjs WebSocket server with authentication hooks, debounced persistence, Redis fan-out and database/S3 adapters. Its documentation is explicit that persisted Yjs binary state must be restored as the same collaborative history; reconstructing a new document from text can duplicate state.

Relevant primary documentation:

- [Yjs awareness](https://docs.yjs.dev/getting-started/adding-awareness)
- [y-websocket](https://docs.yjs.dev/ecosystem/connection-provider/y-websocket)
- [Hocuspocus persistence](https://tiptap.dev/docs/hocuspocus/guides/persistence)
- [Hocuspocus database extension](https://tiptap.dev/docs/hocuspocus/server/extensions/database)
- [Hocuspocus scaling](https://tiptap.dev/docs/hocuspocus/guides/scalability)
- [y-monaco](https://github.com/yjs/y-monaco)

Presence belongs in Yjs Awareness and must not be persisted. Persisted content belongs in shared types. Identity and permissions must be supplied by authenticated server context, never trusted from awareness payloads.

### Alternatives considered

| Technology | Strength | Reason not selected for the first spike |
|---|---|---|
| [Fluid SharedTree](https://fluidframework.com/docs/data-structures/tree) (MIT) | Strong typed tree/schema and Microsoft production backing | Larger service/runtime commitment; weaker fit with Monaco and our current DOM editor |
| [Automerge](https://automerge.org/) (MIT) | Excellent offline/local-first and version history | Offline-first is not an MVP requirement; smaller editor/backend ecosystem |
| [ShareDB](https://github.com/share/sharedb) (MIT) | Established server-authoritative OT, middleware and database model | Older JSON0/OT ecosystem; less direct editor integration |

Yjs is the best first experiment, not an irreversible promise that every visual operation should be a CRDT text mutation.

### HTML source truth needs a precise definition

A realtime system cannot safely use Git commits or whole-file rewrites as its network protocol. It needs live operational state. The workable contract is:

- HTML, locale catalogs and CSS remain the canonical readable/renderable projection and build input.
- Live collaboration state is persisted operational data, not a replacement authoring format.
- Every accepted collaborative transaction is materialized atomically into source files.
- Git records reviewed checkpoints, not keystrokes.
- Presence is never materialized or committed.
- Losing collaboration state must not lose the latest materialized deck, although it may lose merge history needed by offline clients.

The first MVP will not promise offline editing. This keeps recovery from source files possible while we validate online collaboration.

### Hosting

GitHub Pages can host only the static presentation/editor shell. It cannot run WebSockets, enforce application authorization or persist collaborative state.

The most direct managed GCP shape is:

```text
Firebase Hosting     static browser application
Cloud Run            Hocuspocus WebSocket + HTTPS API
Identity Platform    Google Workspace authentication
Cloud SQL            durable collaboration state and metadata
Memorystore          cross-instance fan-out only when scaling past one instance
Cloud Storage        media/assets and exports
```

Cloud Run supports WebSockets, but connections have a maximum request duration and clients must reconnect. Session affinity is best-effort only. Multi-instance correctness requires external synchronization; Redis Pub/Sub is fan-out, not durable persistence.

Sources:

- [Cloud Run WebSockets](https://cloud.google.com/run/docs/triggering/websockets)
- [Cloud Run session affinity](https://cloud.google.com/run/docs/configuring/session-affinity)
- [Firebase Hosting with Cloud Run](https://firebase.google.com/docs/hosting/cloud-run)
- [GitHub Pages limits](https://docs.github.com/pages/getting-started-with-github-pages/github-pages-limits)

For a first deployment, one Cloud Run instance plus durable database state is simpler. Add Redis only after load or availability requirements justify multiple instances.

### Security boundary

A hosted editor cannot expose the current same-origin iframe arrangement. Deck HTML may contain scripts, embedded media and agent-authored code, so preview content must be treated as hostile:

- editor and preview on separate origins;
- sandboxed iframe with minimal capabilities;
- restrictive preview CSP;
- exact-origin, schema-validated `postMessage` protocol;
- no authentication credentials on the preview origin;
- server-derived identity and authorization;
- request/message size limits, origin checks and rate limits.

Sources:

- [MDN iframe sandbox](https://developer.mozilla.org/docs/Web/HTML/Element/iframe#sandbox)
- [MDN postMessage security](https://developer.mozilla.org/docs/Web/API/Window/postMessage#security_concerns)
- [MDN CSP](https://developer.mozilla.org/docs/Web/HTTP/CSP)

### Agents should use the same collaboration service, not browser scraping

The shared URL is useful for humans and browser-capable agents, but agents need a typed protocol: snapshot, semantic transactions, awareness/presence and event subscription. Penpot's current MCP architecture is useful precedent: its MCP server delegates into a plugin operating through the same document API as the UI.

Agent identity, human identity and the approving principal must remain distinct in audit records. Agent operations must never create human `data-author` provenance.

Source: [Penpot MCP](https://help.penpot.app/mcp/).

## Provisional stack for a local vertical slice

- Yjs shared document and Awareness
- Hocuspocus WebSocket server and binary persistence
- y-monaco for Guidance assets
- existing DOM canvas, extended with stable element IDs and semantic operations
- Playwright for two isolated browser contexts and WebSocket/reconnect tests
- existing HTML/catalog/CSS materializer and git history

Potential later canvas helpers such as [Moveable](https://github.com/daybrush/moveable) and [Selecto](https://github.com/daybrush/selecto) are deliberately excluded from the collaboration spike.

## Test principles

Tests should protect collaboration invariants, not chase coverage percentages:

1. Two isolated clients converge on the same canonical state.
2. Presence appears and expires without entering durable history.
3. Acknowledged edits survive reload and server restart.
4. Reconnection neither duplicates nor loses changes.
5. Materialized source renders the same state as the collaboration document.
6. No-op edits create no history.
7. Authorization and path boundaries fail closed.

Playwright browser contexts model separate users better than two pages sharing cookies/storage. Assertions should poll for convergence rather than use fixed sleeps.

## MVP decision

A code audit of Yjs 13.6.32, Hocuspocus 4.5.0 and y-monaco 0.1.6 confirmed the APIs used by the vertical slice. The pinned dependency tree reports no production advisories through `npm audit`; the collaboration packages are MIT-licensed.

The smallest useful shared schema is:

```text
Y.Doc per deck
├── catalogs:   Y.Map<"locale:key", Y.Text>
├── catalogMeta:Y.Map<"locale:key", { author, modified }>
├── assets:     Y.Map<repo-relative path, Y.Text>
└── Awareness:  user + current slide/locale/panel + selected element
```

Catalog values use separate `Y.Text` instances so unrelated keys do not contend and text edits can merge. Monaco assets bind directly to their `Y.Text` through y-monaco. Presence is awareness-only. Structural DOM/style collaboration is intentionally excluded until we define stable element IDs and semantic operations; synchronizing whole HTML source strings would be unsafe.

Hocuspocus persists the binary document under the deck's ignored `.history/` directory and materializes catalogs/assets atomically. On restart it restores the binary history, then imports current source files so trusted CLI or git edits made while the service was stopped remain authoritative. While running, watched source edits are imported as Yjs transactions and broadcast to browsers.

The vertical slice is explicitly limited to:

- two browser users;
- presence and remote selection;
- collaborative locale text;
- collaborative Monaco guidance/deck CSS;
- source materialization, restart recovery and live CLI import.

Authentication, hosted deployment, offline editing, structural tree operations, animation semantics and MCP are not part of this slice.
