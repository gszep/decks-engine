import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createDeck } from "../engine/registry.mjs";
import { createVerifierStore } from "../engine/view-access.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const random = (label) => `${label}-${Math.random().toString(36).slice(2, 10)}`;

const fixtureRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "decks-view-"));
  const theme = path.join(root, "themes", "starter");
  mkdirSync(theme, { recursive: true });
  writeFileSync(path.join(theme, "theme.css"), "@import url(\"tokens.css\");\n.slide { width: 1280px; height: 720px; }\n");
  writeFileSync(path.join(theme, "tokens.css"), ":root { --ct-black: #000000; }\n");
  writeFileSync(path.join(theme, "chrome.css"), ".eyebrow { font-weight: 700; }\n");
  return root;
};

const makeDeck = (root, slug, password) => {
  const created = createDeck({ contentRoot: root, name: slug, owner: { id: "iap-human:test", email: "owner@example.com", name: "owner", type: "human" } });
  const manifestPath = path.join(root, "decks", created.deckId, "deck.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.public = true;
  writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
  if (password) createVerifierStore(path.join(root, "decks", created.deckId), created.documentId).set(password);
  return created;
};

const spawnPublic = (root, documentId, port, globalPassword) => spawn(process.execPath, ["engine/edit.mjs", documentId, "--port", String(port)], {
  cwd: ROOT,
  env: { ...process.env, DECKS_CONTENT_ROOT: root, DECKS_PUBLIC_VIEW_ONLY: "true", DECKS_VIEW_PASSWORD: globalPassword },
  stdio: "ignore",
});

const spawnLocal = (root, documentId, port) => spawn(process.execPath, ["engine/edit.mjs", documentId, "--port", String(port)], {
  cwd: ROOT, env: { ...process.env, DECKS_CONTENT_ROOT: root }, stdio: "ignore",
});

const waitHealthy = async (base, timeout = 15_000) => {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { if ((await fetch(`${base}/healthz`)).status === 200) return; } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`server at ${base} did not start`);
};

// redirect:"manual": the gate answers 303+Set-Cookie; Node's fetch has no
// cookie jar, so a followed redirect would arrive unauthenticated and mask
// the gate's own status.
const postForm = async (base, documentId, password) => await fetch(`${base}/presentation/d/${documentId}/gate`, {
  method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams({ password }),
});

const cookieFrom = (response) => (response.headers.get("set-cookie") || "").split(";")[0];

test("per-deck view passwords: gating, cross-deck isolation, legacy fallback", async () => {
  const root = fixtureRoot();
  const globalPassword = random("global");
  const passA = random("alpha"), passB = random("beta");
  const deckA = makeDeck(root, "deck-a", passA);
  const deckB = makeDeck(root, "deck-b", passB);
  const deckC = makeDeck(root, "deck-c", null);
  const baseA = `http://127.0.0.1:8341`, baseB = `http://127.0.0.1:8342`, baseC = `http://127.0.0.1:8343`;
  const childA = spawnPublic(root, deckA.documentId, 8341, globalPassword);
  const childB = spawnPublic(root, deckB.documentId, 8342, globalPassword);
  const childC = spawnPublic(root, deckC.documentId, 8343, globalPassword);
  try {
    await Promise.all([waitHealthy(baseA), waitHealthy(baseB), waitHealthy(baseC)]);

    // Gate serves the form; wrong password rejected.
    const gate = await fetch(`${baseA}/presentation/d/${deckA.documentId}`);
    assert.equal(gate.status, 200);
    assert.match(await gate.text(), /name="password"/);
    assert.equal((await postForm(baseA, deckA.documentId, "wrong-guess")).status, 401);

    // Correct per-deck password unlocks with a document-bound cookie.
    const unlocked = await postForm(baseA, deckA.documentId, passA);
    assert.equal(unlocked.status, 303);
    const cookieA = cookieFrom(unlocked);
    assert.match(cookieA, new RegExp(`decks_view_${deckA.documentId}=`));

    // Presentation and deck-specific assets gated consistently.
    const headers = { cookie: cookieA };
    const presentation = await fetch(`${baseA}/presentation/d/${deckA.documentId}`, { headers });
    assert.equal(presentation.status, 200);
    const body = await presentation.text();
    assert.match(body, /mode=present/); // the presentation, not the gate
    assert.doesNotMatch(body, /Open edit mode/); // no editor controls on public view
    for (const asset of [`/decks/deck-a/slides/title.html`, `/decks/deck-a/slides/i18n/en.js`, `/themes/starter/theme.css`]) {
      assert.equal((await fetch(`${baseA}${asset}`)).status, 401, `locked without cookie: ${asset}`);
      assert.equal((await fetch(`${baseA}${asset}`, { headers })).status, 200, `unlocked with cookie: ${asset}`);
    }

    // Cross-deck rejection: A's cookie never unlocks B — B serves its gate.
    const crossDeck = await fetch(`${baseB}/presentation/d/${deckB.documentId}`, { headers });
    assert.equal(crossDeck.status, 200);
    assert.match(await crossDeck.text(), /name="password"/); // locked: gate form, not the presentation
    // Per-deck override: the global password does not open deck A.
    assert.equal((await postForm(baseA, deckA.documentId, globalPassword)).status, 401);

    // Legacy fallback: deck C still opens with the global password, and its
    // document-bound cookie does not leak into deck A.
    const legacy = await postForm(baseC, deckC.documentId, globalPassword);
    assert.equal(legacy.status, 303);
    const cookieC = cookieFrom(legacy);
    assert.equal((await fetch(`${baseC}/presentation/d/${deckC.documentId}`, { headers: { cookie: cookieC } })).status, 200);
    const crossMode = await fetch(`${baseA}/presentation/d/${deckA.documentId}`, { headers: { cookie: cookieC } });
    assert.equal(crossMode.status, 200);
    assert.match(await crossMode.text(), /name="password"/); // legacy cookie never unlocks a per-deck deck

    // Runtime password change invalidates deck A's prior unlock state only.
    const store = createVerifierStore(path.join(root, "decks", deckA.deckId), deckA.documentId);
    store.set(random("rotated"));
    const stale = await fetch(`${baseA}/presentation/d/${deckA.documentId}`, { headers });
    assert.equal(stale.status, 200);
    assert.match(await stale.text(), /name="password"/); // old cookie now locked out
  } finally {
    for (const child of [childA, childB, childC]) child.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  }
});

test("owner-only password/publication API; verifier never exposes plaintext; editor and agent denied", async () => {
  const root = fixtureRoot();
  const passA = random("original");
  const deckA = makeDeck(root, "owned", passA);
  const base = `http://127.0.0.1:8344`;
  const child = spawnLocal(root, deckA.documentId, 8344);
  try {
    await waitHealthy(base);
    const signIn = async (user) => cookieFrom(await fetch(`${base}/presentation/d/${deckA.documentId}?user=${user}`));
    const ownerCookie = await signIn("owner@example.com");
    const post = (pathname, body, cookie) => fetch(`${base}${pathname}`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: body ? JSON.stringify(body) : undefined,
    });

    // A second person must be granted editor by the owner (owner-only op).
    assert.equal((await post("/api/access", { type: "user", email: "editor@example.com", role: "editor" }, ownerCookie)).status, 200);
    const editorCookie = await signIn("editor@example.com");

    // Owner sets and reads state — never the secret.
    assert.equal((await post("/api/view", { password: random("changed") }, ownerCookie)).status, 200);
    const state = await (await fetch(`${base}/api/view`, { headers: { cookie: ownerCookie } })).json();
    assert.equal(state.configured, true);
    assert.ok(!("hash" in state) && !("salt" in state) && !("password" in state));

    // Editor denied; agent bearer denied (agents are editor-capped, and this
    // is an owner operation).
    assert.equal((await post("/api/view", { password: random("editor-try") }, editorCookie)).status, 403);
    const agent = await fetch(`${base}/api/view`, {
      method: "POST", headers: {
        authorization: "Bearer local:editor@example.com", "x-decks-agent-client": "test-client",
        "content-type": "application/json",
      }, body: JSON.stringify({ password: random("agent-try") }),
    });
    assert.ok([401, 403, 404].includes(agent.status), `agent must not set the password (got ${agent.status})`);

    // No plaintext anywhere: verifier file and manifest stay clean.
    const viewJson = readFileSync(path.join(root, "decks", "owned", ".history", "view.json"), "utf8");
    assert.doesNotMatch(viewJson, /original|changed|editor-try|agent-try/);
    const deckJson = readFileSync(path.join(root, "decks", "owned", "deck.json"), "utf8");
    assert.doesNotMatch(deckJson, /original|changed/);

    // Publication flag: manifest-only toggle, slides untouched; editor denied.
    const before = JSON.parse(deckJson);
    assert.equal((await post("/api/public", { public: false }, ownerCookie)).status, 200);
    assert.equal(JSON.parse(readFileSync(path.join(root, "decks", "owned", "deck.json"), "utf8")).public, undefined);
    assert.equal((await post("/api/public", { public: true }, ownerCookie)).status, 200);
    const after = JSON.parse(readFileSync(path.join(root, "decks", "owned", "deck.json"), "utf8"));
    assert.deepEqual(after.slides, before.slides);
    assert.equal(after.public, true);
    assert.equal((await post("/api/public", { public: false }, editorCookie)).status, 403);
  } finally {
    child.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  }
});
