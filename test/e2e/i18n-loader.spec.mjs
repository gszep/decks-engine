import { expect, test } from "@playwright/test";
import { readFileSync, writeFileSync } from "node:fs";
import { deckPath } from "../e2e-paths.mjs";

const loaders = (html) => html.split("engine/i18n.js").length - 1;
const keyedSlide = (key) => `<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="test.css"></head><body><div class="slide"><h1 data-i18n="${key}"></h1></div></body></html>`;

const mcpCall = async (method, params = {}) => {
  const response = await fetch("http://127.0.0.1:8310/mcp/d/e2eDeckDocument0001", {
    method: "POST",
    headers: { authorization: "Bearer local:alice@example.com", "content-type": "application/json", accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = await response.text();
  return body.startsWith("event:") ? JSON.parse(body.match(/data: (.*)/)[1]) : JSON.parse(body);
};

const signIn = async (page) => {
  await page.goto("/presentation/d/e2eDeckDocument0001?user=alice@example.com");
  await expect(page.locator("#deckLabel")).toBeVisible();
};

test("an agent-written slide without the text loader still shows its text when presented", async ({ page }) => {
  await signIn(page);
  const written = await mcpCall("tools/call", {
    name: "write_slide", arguments: {
      slide: "agent-loaderless", html: keyedSlide("agent-loaderless.h1"),
      strings: { en: { "agent-loaderless.h1": "Agent heading" }, ja: { "agent-loaderless.h1": "エージェントの見出し" } },
    },
  });
  expect(written.result.structuredContent.created).toBe(true);
  expect(loaders(readFileSync(deckPath("slides/agent-loaderless.html"), "utf8"))).toBe(1);

  const slides = written.result.structuredContent.slides;
  for (const [lang, text] of [["en", "Agent heading"], ["ja", "エージェントの見出し"]]) {
    await page.goto(`/presentation/d/e2eDeckDocument0001?mode=present&lang=${lang}&slide=${slides.indexOf("agent-loaderless") + 1}`);
    await expect(page.frameLocator("iframe").nth(slides.indexOf("agent-loaderless")).locator("h1")).toHaveText(text);
  }
});

test("a loader-less slide already on disk is served with exactly one loader", async ({ page }) => {
  await signIn(page);
  writeFileSync(deckPath("slides/legacy-loaderless.html"), keyedSlide("title.h1"));
  const served = await (await page.request.get("/decks/__e2e/slides/legacy-loaderless.html")).text();
  expect(loaders(served)).toBe(1);
  expect(loaders(await (await page.request.get("/decks/__e2e/slides/title.html")).text())).toBe(1);
  await page.goto("/decks/__e2e/slides/legacy-loaderless.html?lang=en");
  await expect(page.locator("h1")).not.toBeEmpty();
  expect(loaders(readFileSync(deckPath("slides/legacy-loaderless.html"), "utf8"))).toBe(0);
});
