# Resizing and line breaks in the slide editor

## Use

- Hover any selectable box's edge or corner. The cursor shows the resize direction.
- Click–drag–release to resize. Selected boxes show small handles on all eight sides/corners; the entire edge is draggable. Dragging the interior still moves the box.
- Hold **Shift** while resizing an image to keep its current proportions.
- Sizes snap to whole slide CSS pixels, with a 24px minimum (or the box's larger CSS minimum/padding/border). The editor has no separate grid or guides.
- A resize saves on release, stamps the element, and reaches other open editors through the existing slide-save broadcast. **⌘/Ctrl+Z** undoes the gesture; **⌘/Ctrl+Shift+Z** redoes it, including the saved source.
- The inspector's **style edits apply to this locale only** option also applies to resizing. Otherwise the dimensions apply to all locales.
- Double-click text to edit it. **Return** and **Shift+Return** insert line breaks. Both persist in the current locale's catalog (or in HTML for unkeyed text), presentation, and PDF rendering.
- Embedded frames can be selected and resized in the editor; their contents remain interactive in presentation mode. Viewer permissions do not grant resize or text-edit access.

## Implementation

The line-break bug came from `contenteditable="plaintext-only"`: Chrome inserts literal LF text nodes, which were saved as literal newlines. After editing ended, normal HTML whitespace rules collapsed them. The editor now builds `<br>` DOM nodes from those newlines when publishing text and ending the edit. Existing inline markup survives, and typed/pasted HTML remains escaped text. No new HTML parser, dependency, or CSP exception is involved.

Resize geometry is shared with unit tests in `engine/editor/resize.mjs`. Preview styles remain local during a gesture; release commits one stamped source change through `/api/save`. Canceled gestures restore the original inline style. Editor overlays and cursors never reach saved source. Save acknowledgements are serialized, and origin-tagged SSE echoes preserve the saving editor's selection and undo history.

HTML and locale catalogs revalidate rather than briefly serving stale saved content. Entering presentation flushes the current text edits before navigating away from the debounced collaboration room.

## Validation

Run `npm test` and `npm run test:e2e`. Fixtures are copied to an isolated temporary content root, never to the repository's `decks/` directory. The browser suite covers:

- All eight directional cursors; container/image/frame resizing; opposite-edge anchoring; aspect lock and minimum sizes.
- Resize save/reload/presentation, a second user's canvas, undo/redo, locale scope, cancellation, and consecutive releases while an HTTP save is pending.
- Return/Shift+Return in English and Japanese, collaboration, undo/redo, reload, presentation, immediate navigation, and the non-collaborative catalog-save fallback.
- Unkeyed text, blank lines, retained inline markup, escaped HTML-looking input, source cleanliness, and viewer restrictions.

For visual/PDF checks, start `node test/start-e2e.mjs`, use its scratch document in a local Chrome browser, and run the copied `engine/build.mjs` under the temporary content root with `__e2e --locale all --keep-pngs`. Inspect both locales' QA images and PDFs before stopping the fixture server (which removes the scratch root).
