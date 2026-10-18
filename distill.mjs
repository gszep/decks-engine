#!/usr/bin/env node
import { mountContentRoot } from "./launcher.mjs";
mountContentRoot(import.meta.url);
await import("./engine/distill.mjs");
