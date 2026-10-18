import { rmSync } from "node:fs";
import { contentRoot } from "./e2e-paths.mjs";

export default function cleanup() {
  rmSync(contentRoot, { recursive: true, force: true });
}
