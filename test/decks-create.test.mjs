import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createDeck } from "../engine/registry.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = 8321;
const HOST_PORT = 8322;
const owner = { id: "iap-human:11223344556677889900", email: "owner@example.com", name: "owner", type: "human" };
const IAP = {
  "x-goog-authenticated-user-email": "accounts.google.com:owner@example.com",
  "x-goog-authenticated-user-id": "accounts.google.com:11223344556677889900",
};

const fixtureRoot = () => {
  const root = mkdtempSync(path.join(tmpdir(), "decks-create-"));
  const theme = path.join(root, "themes", "starter");
  mkdirSync(theme, { recursive: true });
  writeFileSync(path.join(theme, "theme.css"), "@import url(\"tokens.css\");\n.slide { width: 1280px; height: 720px; }\n");
  writeFileSync(path.join(theme, "tokens.css"), ":root { --ct-black: #000000; }\n");
  writeFileSync(path.join(theme, "chrome.css"), ".eyebrow { font-weight: 700; }\n");
  writeFileSync(path.join(theme, "GUIDANCE.md"), "# Guidance\n");
  writeFileSync(path.join(theme, "guidance.json"), "{\n  \"rules\": []\n}\n");
  return root;
};

test("createDeck scaffolds an i18n deck with a private theme and its owner", () => {
  const root = fixtureRoot();
  try {
    const created = createDeck({ contentRoot: root, name: "Playground", owner });
    assert.match(created.deckId, /^playground$/);
    assert.match(created.documentId, /^[A-Za-z0-9_-]{12,128}$/);
    const deckDir = path.join(root, "decks", created.deckId);
    const manifest = JSON.parse(readFileSync(path.join(deckDir, "deck.json"), "utf8"));
    assert.equal(manifest.name, "playground");
    assert.equal(manifest.documentId, created.documentId);
    assert.deepEqual(manifest.slides, ["title"]);
    assert.deepEqual(manifest.locales, ["en", "ja"]);
    // Private theme copy — the shared tree stays untouched.
    assert.equal(readFileSync(path.join(deckDir, "theme", "GUIDANCE.md"), "utf8"), "# Guidance\n");
    assert.deepEqual(JSON.parse(readFileSync(path.join(deckDir, "theme", "guidance.json"), "utf8")), { rules: [] });
    // Owner-only access, recorded at creation.
    const access = JSON.parse(readFileSync(path.join(deckDir, ".history", "access.json"), "utf8"));
    assert.equal(access.documentId, created.documentId);
    assert.equal(access.owner.email, "owner@example.com");
    assert.deepEqual(access.permissions, []);
    // Starter slide keys exist in every locale catalog.
    const html = readFileSync(path.join(deckDir, "slides", "title.html"), "utf8");
    for (const locale of ["en", "ja"]) {
      const catalog = readFileSync(path.join(deckDir, "slides", "i18n", `${locale}.js`), "utf8");
      for (const key of ["title.eyebrow", "title.h1", "title.lede"]) {
        assert.match(html, new RegExp(`data-i18n=["']${key}["']`));
        assert.match(catalog, new RegExp(`"${key.replace(/\./g, "\\.")}":`));
      }
    }
    assert.match(readFileSync(path.join(deckDir, "slides", "deck.css"), "utf8"), /@import url\("..\/..\/..\/themes\/starter\/theme.css"\)/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("createDeck deduplicates slugs and validates the name", () => {
  const root = fixtureRoot();
  try {
    const first = createDeck({ contentRoot: root, name: "playground", owner });
    const second = createDeck({ contentRoot: root, name: "playground", owner });
    assert.equal(second.deckId, "playground-2");
    assert.notEqual(first.documentId, second.documentId);
    assert.throws(() => createDeck({ contentRoot: root, name: "!!!", owner }), /letter or digit/);
    assert.throws(() => createDeck({ contentRoot: root, name: "ok", theme: "missing" }), /unknown theme/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

const PORT_SPLIT = 8323;
test("editor runs against a separate content repo and journals to its git history", async () => {
  const root = fixtureRoot();
  const created = createDeck({ contentRoot: root, name: "remote", owner });
  // Content root as its own repository, separate from the engine checkout:
  // this is the hosted-split shape the engine must support.
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "content@example.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Content Repo"], { cwd: root });
  execFileSync("git", ["add", "."], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", "seed content"], { cwd: root });
  const child = spawn(process.execPath, ["engine/edit.mjs", created.documentId, "--port", String(PORT_SPLIT)], {
    cwd: ROOT, env: { ...process.env, DECKS_CONTENT_ROOT: root }, stdio: "ignore",
  });
  const base = `http://127.0.0.1:${PORT_SPLIT}`;
  try {
    const waitFor = async (check, timeout = 15_000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.fail("server did not start");
    };
    let cookie = "";
    await waitFor(async () => {
      try {
        const response = await fetch(`${base}/presentation/d/${created.documentId}?user=owner@example.com`);
        cookie = (response.headers.get("set-cookie") || "").split(";")[0];
        return response.status === 200;
      } catch { return false; }
    });
    const headers = { cookie };

    // Theme served from the separate content root.
    const theme = await fetch(`${base}/themes/starter/tokens.css`, { headers });
    assert.match(await theme.text(), /--ct-black/);

    // A slide edit lands in the content repo's git history, not the engine's.
    const slideFile = `decks/remote/slides/title.html`;
    const html = readFileSync(path.join(root, slideFile), "utf8");
    const response = await fetch(`${base}/api/save`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ file: slideFile, html: html.replace("</div></body>", "<!-- edited --></div></body>") }),
    });
    assert.equal(response.status, 200);
    const changed = execFileSync("git", ["status", "--porcelain"], { cwd: root }).toString();
    assert.match(changed, new RegExp(escapeRegExp(slideFile)));
    const log = execFileSync("git", ["log", "--oneline", "-3"], { cwd: root }).toString();
    assert.match(log, /seed content/); // history lives in the content repo
    const engineLog = execFileSync("git", ["status", "--porcelain"], { cwd: ROOT }).toString();
    assert.ok(!engineLog.includes("remote/"), "engine repo must stay untouched");
  } finally {
    child.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  }
});

const escapeRegExp = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("hosted editor: creates slides, private theme files, never touches the shared theme", async () => {
  const root = fixtureRoot();
  const created = createDeck({ contentRoot: root, name: "sandbox", owner });
  const child = spawn(process.execPath, ["engine/edit.mjs", created.documentId, "--port", String(PORT)], {
    cwd: ROOT, env: { ...process.env, DECKS_CONTENT_ROOT: root }, stdio: "ignore",
  });
  const base = `http://127.0.0.1:${PORT}`;
  try {
    const deckDir = path.join(root, "decks", created.deckId);
    const waitFor = async (check, timeout = 15_000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.fail("server did not start");
    };
    let cookie = "";
    await waitFor(async () => {
      try {
        const response = await fetch(`${base}/presentation/d/${created.documentId}?user=owner@example.com`);
        cookie = (response.headers.get("set-cookie") || "").split(";")[0];
        return response.status === 200;
      } catch { return false; }
    });
    const post = async (pathname, body) => await fetch(`${base}${pathname}`, {
      method: "POST", headers: { "content-type": "application/json", cookie },
      body: JSON.stringify(body),
    });

    // A blank slide lands in the manifest and in every locale catalog.
    let response = await post("/api/slides", { name: "about" });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).slides, ["title", "about"]);
    assert.ok(existsSync(path.join(deckDir, "slides", "about.html")));
    for (const locale of ["en", "ja"]) {
      const catalog = readFileSync(path.join(deckDir, "slides", "i18n", `${locale}.js`), "utf8");
      assert.match(catalog, /"about\.h1":/);
    }
    assert.match(readFileSync(path.join(deckDir, "slides", "about.html"), "utf8"), /data-i18n="about\.h1"/);

    // A duplicate namespaces its keys so the two slides never share text.
    response = await post("/api/slides", { name: "title-copy", from: "title" });
    assert.equal(response.status, 200);
    const copy = readFileSync(path.join(deckDir, "slides", "title-copy.html"), "utf8");
    assert.match(copy, /data-i18n="title-copy\.title\.h1"/);
    assert.doesNotMatch(copy, /data-author=/);
    const en = readFileSync(path.join(deckDir, "slides", "i18n", "en.js"), "utf8");
    assert.match(en, /"title-copy\.title\.h1":/);

    // Validation: duplicate name, invalid name, unknown source.
    assert.equal((await post("/api/slides", { name: "about" })).status, 409);
    assert.equal((await post("/api/slides", { name: "Bad Name" })).status, 400);
    assert.equal((await post("/api/slides", { name: "extra", from: "nope" })).status, 400);

    // New files land in the deck's PRIVATE theme, never the shared tree.
    response = await post("/api/asset", { file: "themes/starter/notes.md", text: "my notes\n" });
    assert.equal(response.status, 200);
    assert.equal(readFileSync(path.join(deckDir, "theme", "notes.md"), "utf8"), "my notes\n");
    assert.ok(!existsSync(path.join(root, "themes", "starter", "notes.md")));

    // Editing through the shared URL scheme writes the private copy.
    response = await post("/api/asset", { file: "themes/starter/GUIDANCE.md", text: "# Mine\n" });
    assert.equal(response.status, 200);
    assert.equal(readFileSync(path.join(deckDir, "theme", "GUIDANCE.md"), "utf8"), "# Mine\n");
    assert.equal(readFileSync(path.join(root, "themes", "starter", "GUIDANCE.md"), "utf8"), "# Guidance\n");

    // And /themes/... reads resolve to the private copy.
    const served = await fetch(`${base}/themes/starter/GUIDANCE.md`, { headers: { cookie } });
    assert.equal(await served.text(), "# Mine\n");

    // New deck CSS is allowed; other slides tree paths stay checked.
    response = await post("/api/asset", { file: "decks/sandbox/slides/extra.css", text: ".x {}\n" });
    assert.equal(response.status, 200);
    assert.ok(existsSync(path.join(deckDir, "slides", "extra.css")));
  } finally {
    child.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  }
});

test("host: POST /api/decks creates, discovers and serves a deck owned by its creator", async () => {
  const root = fixtureRoot();
  createDeck({ contentRoot: root, name: "seeded", owner }); // an existing deck at boot
  const child = spawn(process.execPath, ["engine/host.mjs"], {
    cwd: ROOT,
    env: {
      ...process.env, DECKS_CONTENT_ROOT: root, PORT: String(HOST_PORT),
      DECKS_CHILD_PORT_START: "9330", DECKS_IAP_ENABLED: "true", DECKS_PUBLIC_ORIGIN: "https://decks.example",
    },
    stdio: "ignore",
  });
  const base = `http://127.0.0.1:${HOST_PORT}`;
  try {
    const waitFor = async (check, timeout = 20_000) => {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        if (await check()) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      assert.fail("host did not start");
    };
    await waitFor(async () => {
      try { return (await fetch(`${base}/healthz`)).status === 200; } catch { return false; }
    });

    // Anonymous index: no creation form.
    const anonymous = await (await fetch(`${base}/`)).text();
    assert.ok(!anonymous.includes('id="newdeck"'));

    // Signed-in human sees the form and can create a deck.
    const headers = { ...IAP, "origin": "https://decks.example" };
    let page = await (await fetch(`${base}/`, { headers })).text();
    assert.ok(page.includes('id="newdeck"'));

    let response = await fetch(`${base}/api/decks`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "playground" }),
    });
    assert.equal(response.status, 201);
    const created = await response.json();
    assert.match(created.documentId, /^[A-Za-z0-9_-]{12,128}$/);

    // The host discovered and started it — index lists it, editor serves it,
    // and the creator is the owner without any manual sharing step. Deck-level
    // requests need document context (Referer/cookie) like any browser sends.
    page = await (await fetch(`${base}/`, { headers })).text();
    assert.ok(page.includes(`/d/${created.documentId}`));
    const editor = await fetch(`${base}/presentation/d/${created.documentId}`, { headers });
    assert.equal(editor.status, 200);
    const docHeaders = { ...headers, referer: `${base}/presentation/d/${created.documentId}` };
    const deckInfo = await (await fetch(`${base}/api/deck`, { headers: docHeaders })).json();
    assert.equal(deckInfo.deckId, created.deckId);
    assert.equal(deckInfo.document.id, created.documentId);
    assert.equal(deckInfo.permission.role, "owner");
    assert.equal(deckInfo.themeLocal, true);

    // Slide creation through the host proxy, on the freshly spawned child.
    response = await fetch(`${base}/api/slides`, {
      method: "POST", headers: { ...docHeaders, "content-type": "application/json" },
      body: JSON.stringify({ name: "second" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).slides, ["title", "second"]);

    // Unknown theme / bad name → clean 400.
    response = await fetch(`${base}/api/decks`, {
      method: "POST", headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ name: "!!!" }),
    });
    assert.equal(response.status, 400);
  } finally {
    child.kill("SIGTERM");
    rmSync(root, { recursive: true, force: true });
  }
});
