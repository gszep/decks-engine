# Editor tools — hot-reloadable plugins for the design harness

Two kinds of tools share this contract:

- **Built-in tools** live here, in git, and load for everyone.
- **Agent-made tools** are written through the MCP `write_editor_tool` tool (or
  edited in the editor) and stored under the content root's `tools/`. Each person
  enables one explicitly, seeing its author and code first, because a tool runs
  in their editor with their permissions. Approval is tied to that exact code: a
  changed tool must be enabled again, except
  by its creator: once they have enabled their own tool, updates from their
  agent load straight away. New and updated tools appear in open editors
  without a reload. Only the creator, in the editor or through
  their own agent, can edit or delete it.

Dragging elements with the mouse is built into the editor, not a tool.

Drop a `.js` file in this directory and every open editor loads it **live**
(no restart, no reload). Delete the file and the tool disappears. This is the
"ask a coding agent to build me a tool" workflow: tools can be ephemeral
(one-time fixups, then deleted), personal (prefix with your name, e.g.
`yuki-kerning-sweep.js`), or shared.

## Contract

A tool file is plain vanilla JS (no imports, no build step) that calls:

```js
harness.registerTool({
  id: "my-tool",            // required, unique — re-registering replaces
  name: "🔧 My tool",       // sidebar button label

  // EITHER a one-shot action…
  run(h) { /* do the thing */ },

  // …OR a long-lived toggle:
  activate(h) { /* turn on */ },
  deactivate(h) { /* turn off */ },

  // optional hooks:
  slideLoaded(h) {},          // after each slide loads into the canvas
  inspector(box, h) {},       // append extra UI to the inspector panel
  dispose(h) {},              // before unload/replacement — clean up!
});
```

`h` (the harness) is the stable API:

| member | meaning |
|---|---|
| `h.sel` | currently selected element (in the slide iframe) |
| `h.doc()` / `h.slideRoot()` | the slide's document / its `.slide` root |
| `h.select(el)` | change selection |
| `h.applyStyle(prop, value)` | style the selection — undo/provenance/locale-scope aware |
| `h.nudge(el, dx, dy)` | move an element |
| `h.pushUndo()` / `h.undo()` | snapshot / restore (call `pushUndo` before raw DOM writes) |
| `h.touched(el)` | stamp `data-modified` + `data-author` and mark dirty — call after raw DOM writes |
| `h.tokens` | theme colour tokens `[{name, value, resolved}]` — use these, never hex |
| `h.locale`, `h.defaultLocale`, `h.slideName`, `h.manifest`, `h.owner` | context |
| `h.status(msg, warn?)` | status-bar message |
| `h.saveCurrent()` | save the current slide |
| `h.refreshInspector()` | re-render the inspector |

## Rules

- **Ephemeral scaffolding must use `__`-prefixed classes and ids** (e.g.
  `__qa-flag`). The serializer strips everything `__`-prefixed on save, so
  well-behaved tools can never leak into the ground-truth HTML.
- **Real edits go through `applyStyle`/`nudge`/`touched`** so they get undo
  support and `data-modified`/`data-author` provenance. A tool that mutates the
  DOM without `touched()` produces unstamped (agent-attributed) edits.
- **Theme tokens only** — a tool that writes hex colours violates the design
  system. Use `h.tokens`.
- **Clean up in `dispose()`** — hot reload calls it before replacing you.
- Keep tools single-file and dependency-free, like everything else here.
