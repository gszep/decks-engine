// Root-level launchers: run the engine entry points directly from this
// checkout (`node build.mjs demo`), and keep the repository's documented
// commands working when this repo is mounted as a git submodule at `engine/`
// inside a content checkout — there, `node engine/edit.mjs <deck>` must keep
// working with the surrounding checkout as the content root.
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Mounted shape: this directory is named `engine` and its parent holds the
// content (decks/). Guarded so standalone checkouts are never affected.
export const mountContentRoot = (entryUrl) => {
  if (process.env.DECKS_CONTENT_ROOT !== undefined) return;
  const dir = path.dirname(fileURLToPath(entryUrl));
  const parent = path.dirname(dir);
  if (path.basename(dir) === "engine" && existsSync(path.join(parent, "decks")))
    process.env.DECKS_CONTENT_ROOT = parent;
};
