import { cpSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { contentRoot, deckPath } from "./e2e-paths.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const target = deckPath();
rmSync(contentRoot, { recursive: true, force: true });
cpSync(path.join(root, "test", "fixtures", "deck"), target, { recursive: true });
cpSync(path.join(root, "themes"), path.join(contentRoot, "themes"), { recursive: true });
cpSync(path.join(root, "engine"), path.join(contentRoot, "engine"), { recursive: true });

const child = spawn(process.execPath, ["engine/edit.mjs", "__e2e", "--port", "8310"], {
  cwd: root, stdio: "inherit", env: { ...process.env, DECKS_CONTENT_ROOT: contentRoot },
});
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  child.kill("SIGTERM");
  rmSync(contentRoot, { recursive: true, force: true });
  setTimeout(() => process.exit(code), 100).unref();
};
process.on("SIGINT", () => stop());
process.on("SIGTERM", () => stop());
child.on("exit", (code) => stop(code || 0));
