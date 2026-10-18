import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// Keep all editable fixtures outside the checkout, including concurrent deck work.
export const contentRoot = process.env.DECKS_E2E_ROOT || path.join(tmpdir(), `decks-e2e-${createHash("sha256").update(repo).digest("hex").slice(0, 12)}`);
export const deckPath = (...parts) => path.join(contentRoot, "decks", "__e2e", ...parts);
