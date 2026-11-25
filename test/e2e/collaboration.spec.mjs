import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { deckPath } from "../e2e-paths.mjs";

test.setTimeout(60_000);

const openUser = async (browser, name, expectedTitle = "Shared title", expectedDocumentTitle = "Collaboration Test") => {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(`/presentation/d/e2eDeckDocument0001?user=${name}`);
  await expect(page).toHaveURL(/\/presentation\/d\/e2eDeckDocument0001\?user=/);
  await expect(page).toHaveTitle(expectedDocumentTitle);
  await expect(page.locator("#deckLabel")).toHaveValue(expectedDocumentTitle);
  await expect(page.frameLocator("#frame").locator('[data-i18n="title.h1"]')).toHaveText(expectedTitle);
  return { context, page };
};

const mcpCall = async (email, method, params = {}) => {
  const response = await fetch("http://127.0.0.1:8310/mcp/d/e2eDeckDocument0001", {
    method: "POST",
    headers: { authorization: `Bearer local:${email}`, "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.text();
  const payload = body.startsWith("event:") ? JSON.parse(body.match(/data: (.*)/)[1]) : JSON.parse(body);
  return { status: response.status, ...payload };
};

const appendToEditable = async (locator, text) => {
  await locator.dblclick();
  await locator.press("End");
  await locator.type(text);
  await locator.press("Escape");
};

test("two users share presence, catalog text and a Monaco asset", async ({ browser }) => {
  const alice = await openUser(browser, "alice@example.com");
  const slideResponse = await alice.page.request.get("/decks/__e2e/slides/title.html");
  expect(slideResponse.headers()["content-security-policy"]).toContain("connect-src 'none'");
  const tools = await mcpCall("alice@example.com", "tools/list");
  expect(tools.result.tools.map((tool) => tool.name)).toEqual([
    "get_presentation", "read_slide", "update_catalog_text", "read_styles", "write_slide",
    "set_slide_order", "read_guidance", "write_guidance", "write_editor_tool",
    "list_permissions", "grant_permission", "revoke_permission",
  ]);
  const presentation = await mcpCall("alice@example.com", "tools/call", { name: "get_presentation", arguments: {} });
  expect(JSON.parse(presentation.result.content[0].text).documentId).toBe("e2eDeckDocument0001");
  expect((await mcpCall("outsider@example.com", "tools/list")).status).toBe(403);

  await alice.page.locator("#shareBtn").click();
  await expect(alice.page.locator(".agents-note")).toContainText("/agents");
  await alice.page.locator("#shareTarget").fill("bob@example.com");
  await alice.page.locator("#shareRole").selectOption("editor");
  await alice.page.locator("#shareForm").evaluate((form) => form.requestSubmit());
  await expect(alice.page.locator("#shareList")).toContainText("bob@example.com");
  await alice.page.locator("#shareTarget").fill("viewer@example.com");
  await alice.page.locator("#shareRole").selectOption("viewer");
  await alice.page.locator("#shareForm").evaluate((form) => form.requestSubmit());
  await expect(alice.page.locator("#shareList")).toContainText("viewer@example.com");
  await alice.page.locator("#shareClose").click();
  let bob = await openUser(browser, "bob@example.com");
  const viewer = await openUser(browser, "viewer@example.com");
  await expect(viewer.page.locator("#saveBtn")).toHaveText("View only");
  await viewer.page.frameLocator("#frame").locator(".mark").click();
  await expect(viewer.page.frameLocator("#frame").locator("[data-resize]")).toHaveCount(0);
  expect(await viewer.page.evaluate(() => fetch("/api/document", {
    method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: "Denied" }),
  }).then((response) => response.status))).toBe(403);
  const readByAgent = await mcpCall("alice@example.com", "tools/call", {
    name: "read_slide", arguments: { slide: "title", locale: "ja" },
  });
  expect(readByAgent.result.structuredContent.strings["title.h1"]).toBe("共有タイトル");
  const editedByAgent = await mcpCall("alice@example.com", "tools/call", {
    name: "update_catalog_text", arguments: {
      locale: "ja", key: "title.h1", expectedCurrent: "共有タイトル", value: "エージェントによる編集",
    },
  });
  expect(editedByAgent.result.structuredContent.changed).toBe(true);
  await expect.poll(() => readFileSync(deckPath("slides/i18n/ja.js"), "utf8")).toContain("エージェントによる編集");

  await expect(alice.page.locator("#presence .avatar")).toHaveCount(2);
  await expect(bob.page.locator("#presence .avatar")).toHaveCount(2);

  await alice.page.locator("#deckLabel").fill("Renamed without a path change");
  await alice.page.locator("#deckLabel").press("Enter");
  await expect(bob.page.locator("#deckLabel")).toHaveValue("Renamed without a path change");
  await expect(alice.page).toHaveURL(/\/presentation\/d\/e2eDeckDocument0001/);

  await alice.page.frameLocator("#frame").locator(".mark").click();
  await expect(bob.page.frameLocator("#frame").locator('[id^="__presence-"]')).toHaveCount(1);

  const aliceTitle = alice.page.frameLocator("#frame").locator('[data-i18n="title.h1"]');
  await appendToEditable(aliceTitle, " from Alice");
  const bobTitle = bob.page.frameLocator("#frame").locator('[data-i18n="title.h1"]');
  await expect(bobTitle).toHaveText("Shared title from Alice");
  await expect(viewer.page.frameLocator("#frame").locator('[data-i18n="title.h1"]')).toHaveText("Shared title from Alice");
  await viewer.context.close();
  await alice.page.keyboard.press("Control+z");
  await expect(bobTitle).toHaveText("Shared title");
  await alice.page.keyboard.press("Control+Shift+z");
  await expect(bobTitle).toHaveText("Shared title from Alice");
  const catalogFile = deckPath("slides/i18n/en.js");
  await expect.poll(() => readFileSync(catalogFile, "utf8")).toContain("Shared title from Alice");
  const protectedEdit = await mcpCall("bob@example.com", "tools/call", {
    name: "update_catalog_text", arguments: {
      locale: "en", key: "title.h1", expectedCurrent: "Shared title from Alice", value: "Agent overwrite",
    },
  });
  expect(protectedEdit.result.isError).toBe(true);
  expect(protectedEdit.result.content[0].text).toContain("only they or their agent can change it");

  await bob.context.close();
  await expect(alice.page.locator("#presence .avatar")).toHaveCount(1);
  await appendToEditable(aliceTitle, " while offline");
  bob = await openUser(browser, "bob@example.com", "Shared title from Alice while offline", "Renamed without a path change");
  await expect(bob.page.frameLocator("#frame").locator('[data-i18n="title.h1"]')).toHaveText("Shared title from Alice while offline");

  const textHistory = alice.page.locator("#history button").filter({ hasText: "Text ·" });
  await expect(textHistory).toHaveCount(2);
  await textHistory.nth(1).click();
  await expect(alice.page.frameLocator("#frame").locator('[data-i18n="title.h1"]')).toHaveText("Shared title from Alice");
  await alice.page.locator("#saveBtn").click();
  await expect.poll(() => readFileSync(catalogFile, "utf8")).toContain('"title.h1": "Shared title from Alice"');
  await expect(bob.page.frameLocator("#frame").locator('[data-i18n="title.h1"]')).toHaveText("Shared title from Alice");
  await alice.page.locator('#historyScope [data-scope="all"]').click();
  await expect(alice.page.locator("#history")).toContainText("en.js");
  await alice.page.locator('#historyScope [data-scope="slide"]').click();

  const external = readFileSync(catalogFile, "utf8").replace("Two people, one source.", "Agent edit from disk.");
  writeFileSync(catalogFile, external);
  await expect(alice.page.frameLocator("#frame").locator('[data-i18n="title.lede"]')).toHaveText("Agent edit from disk.");
  await expect(bob.page.frameLocator("#frame").locator('[data-i18n="title.lede"]')).toHaveText("Agent edit from disk.");

  const cssButton = '[title="decks/__e2e/slides/test.css"]';
  await alice.page.locator(cssButton).click();
  await bob.page.locator(cssButton).click();
  await expect.poll(() => alice.page.evaluate(() => codeModel?.getLanguageId())).toBe("css");
  await expect.poll(() => bob.page.evaluate(() => codeModel?.getLanguageId())).toBe("css");
  await alice.page.evaluate(() => {
    const line = codeModel.getLineCount();
    const column = codeModel.getLineMaxColumn(line);
    codeEditor.executeEdits("e2e", [{ range: new monaco.Range(line, column, line, column), text: "\n/* Alice */" }]);
  });
  await expect.poll(() => bob.page.evaluate(() => codeModel.getValue())).toContain("/* Alice */");

  const cssFile = deckPath("slides/test.css");
  const documentFile = deckPath(".history/document.json");
  await expect.poll(() => JSON.parse(readFileSync(documentFile, "utf8")).title).toBe("Renamed without a path change");
  expect(JSON.parse(readFileSync(deckPath("deck.json"), "utf8")).title).toBeUndefined();
  await expect.poll(() => readFileSync(catalogFile, "utf8")).toContain("Shared title from Alice");
  await expect.poll(() => readFileSync(cssFile, "utf8")).toContain("/* Alice */");

  await alice.context.close();
  await bob.context.close();
});
