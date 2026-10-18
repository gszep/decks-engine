import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { deckPath } from "../e2e-paths.mjs";
import { parseCatalogSource } from "../../engine/collaboration.mjs";

test.setTimeout(60_000);

const openEditor = async (page) => {
  await page.goto("/presentation/d/e2eDeckDocument0001?user=alice@example.com");
  await page.locator("#slidelist button").filter({ hasText: "editing" }).click();
  await expect(page.frameLocator("#frame").locator(".editable-text")).not.toBeEmpty();
};
const enterLines = async (text, lines) => {
  await text.dblclick();
  await expect(text).toHaveAttribute("contenteditable", "plaintext-only");
  await text.press("ControlOrMeta+a");
  await text.pressSequentially(lines[0]);
  await text.press("Enter");
  await text.pressSequentially(lines[1]);
  await text.press("Shift+Enter");
  await text.pressSequentially(lines[2]);
  await text.press("Escape");
};
const expectLines = async (text, lines) => {
  await expect(text).toHaveJSProperty("innerHTML", lines.join("<br>"));
  await expect(text).toHaveJSProperty("innerText", lines.join("\n"));
};
const catalog = (locale) => parseCatalogSource(readFileSync(deckPath(`slides/i18n/${locale}.js`), "utf8")).i18n;

test("Return and Shift+Return persist across locales, collaboration, reload and presentation", async ({ page, browser }) => {
  await openEditor(page);
  const other = await browser.newPage();
  await openEditor(other);
  for (const [locale, lines] of [["en", ["First", "Second", "Third"]], ["ja", ["一行目です", "二行目です", "三行目です"]]]) {
    await page.locator("#locales button").filter({ hasText: locale }).click();
    await other.locator("#locales button").filter({ hasText: locale }).click();
    await expect(page.frameLocator("#frame").locator("html")).toHaveAttribute("lang", locale);
    await expect(other.frameLocator("#frame").locator("html")).toHaveAttribute("lang", locale);
    const text = page.frameLocator("#frame").locator(".editable-text");
    await expect(text).not.toBeEmpty();
    await enterLines(text, lines);
    await expectLines(text, lines);
    await expectLines(other.frameLocator("#frame").locator(".editable-text"), lines);
    await expect.poll(() => catalog(locale)["editing.text"]).toBe(lines.join("<br>"));
    // Deselect, undo and redo use the text transaction even with no selection.
    await text.press("Escape");
    await page.keyboard.press("ControlOrMeta+z");
    await expect(text).not.toHaveJSProperty("innerHTML", lines.join("<br>"));
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await expectLines(text, lines);
    await expect.poll(() => catalog(locale)["editing.text"]).toBe(lines.join("<br>"));
    const present = await page.context().newPage();
    await present.goto(`/presentation/d/e2eDeckDocument0001?mode=present&lang=${locale}`);
    await expectLines(present.frameLocator('iframe').nth(1).locator(".editable-text"), lines);
    await present.close();
  }
  await page.reload();
  await page.locator("#slidelist button").filter({ hasText: "editing" }).click();
  await expectLines(page.frameLocator("#frame").locator(".editable-text"), ["First", "Second", "Third"]);
  await other.close();
});

test("plain text saves breaks and HTML-looking input stays text", async ({ page }) => {
  await openEditor(page);
  const text = page.frameLocator("#frame").locator(".plain-text");
  await enterLines(text, ["Plain", "Saved", "Lines"]);
  await expectLines(text, ["Plain", "Saved", "Lines"]);
  await page.locator("#saveBtn").click();
  await expect.poll(() => readFileSync(deckPath("slides/editing.html"), "utf8")).toContain("Plain<br>Saved<br>Lines");
  const localized = page.frameLocator("#frame").locator(".editable-text");
  await localized.dblclick();
  await localized.press("ControlOrMeta+a");
  await localized.pressSequentially('<img src=x onerror="alert(1)">');
  await localized.press("Enter");
  await localized.pressSequentially("Safe & sound");
  await localized.press("Escape");
  await expect(localized.locator("img,script")).toHaveCount(0);
  await expect.poll(() => catalog("en")["editing.text"]).toBe('&lt;img src=x onerror="alert(1)"&gt;<br>Safe &amp; sound');
  // Keep the visual fixture useful for the later scratch PDF build.
  await enterLines(localized, ["First", "Second", "Third"]);
  await expect.poll(() => catalog("en")["editing.text"]).toBe("First<br>Second<br>Third");
});

test("small labels inside an SVG diagram select and edit instead of resizing", async ({ page }) => {
  await openEditor(page);
  const label = page.frameLocator("#frame").locator(".diagram-label");
  const r = await label.boundingBox();
  // Near the label's top edge, where unselected edge bands used to start a resize.
  await page.mouse.move(r.x + r.width / 2, r.y + 2);
  await expect(label).not.toHaveCSS("cursor", /resize/);
  await label.click();
  await expect(label).toHaveClass(/__ed-sel/);
  await expect(page.frameLocator("#frame").locator("[data-resize]")).toHaveCount(0);
  await label.dblclick();
  await expect(label).toHaveAttribute("contenteditable", "plaintext-only");
  await label.press("ControlOrMeta+a");
  await label.pressSequentially("to seconds");
  await label.press("Escape");
  await expect.poll(() => catalog("en")["editing.label"]).toBe("to seconds");
  expect(await label.getAttribute("style")).toBeNull();
});

const resize = async (page, selector, edge, dx, dy, shift = false) => {
  const el = page.frameLocator("#frame").locator(selector);
  const r = await el.boundingBox();
  await page.mouse.click(r.x + r.width / 2, r.y + r.height / 2);
  const x = edge.includes("w") ? r.x : edge.includes("e") ? r.x + r.width : r.x + r.width / 2;
  const y = edge.includes("n") ? r.y : edge.includes("s") ? r.y + r.height : r.y + r.height / 2;
  const scale = await page.evaluate(() => frame.getBoundingClientRect().width / 1280);
  await page.mouse.move(x, y);
  if (shift) await page.keyboard.down("Shift");
  await page.mouse.down();
  await page.mouse.move(x + dx * scale, y + dy * scale, { steps: 5 });
  await page.mouse.up();
  if (shift) await page.keyboard.up("Shift");
};

test("edge/corner resize cursors, save, collaboration, undo/redo and reload", async ({ page, browser }) => {
  await openEditor(page);
  const other = await browser.newPage();
  await openEditor(other);
  const box = page.frameLocator("#frame").locator(".resize-box");
  await box.click();
  for (const [edge, cursor] of Object.entries({ n: "ns-resize", s: "ns-resize", e: "ew-resize", w: "ew-resize", nw: "nwse-resize", se: "nwse-resize", ne: "nesw-resize", sw: "nesw-resize" })) {
    const handle = page.frameLocator("#frame").locator(`[data-resize="${edge}"]`).last();
    await handle.hover();
    await expect(handle).toHaveCSS("cursor", cursor);
  }
  await resize(page, ".resize-box", "se", 80, 60);
  await expect(box).toHaveCSS("width", "320px");
  await expect(box).toHaveCSS("height", "200px");
  await expect.poll(() => readFileSync(deckPath("slides/editing.html"), "utf8")).toContain("width: 320px");
  await expect(other.frameLocator("#frame").locator(".resize-box")).toHaveCSS("width", "320px");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(box).toHaveCSS("width", "240px");
  await expect(other.frameLocator("#frame").locator(".resize-box")).toHaveCSS("width", "240px");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(box).toHaveCSS("width", "320px");
  await expect(other.frameLocator("#frame").locator(".resize-box")).toHaveCSS("width", "320px");
  await resize(page, ".resize-box", "nw", -40, -20);
  await expect(box).toHaveCSS("width", "360px");
  await expect(box).toHaveCSS("left", "40px");
  await expect(box).toHaveCSS("top", "330px");
  await expect.poll(() => readFileSync(deckPath("slides/editing.html"), "utf8")).toContain("width: 360px");
  await page.reload();
  await page.locator("#slidelist button").filter({ hasText: "editing" }).click();
  await expect(box).toHaveCSS("width", "360px");
  await resize(page, ".resize-image", "se", 100, 20, true);
  const image = page.frameLocator("#frame").locator(".resize-image");
  await expect(image).toHaveCSS("width", "300px");
  await expect(image).toHaveCSS("height", "150px");
  const html = () => readFileSync(deckPath("slides/editing.html"), "utf8");
  await expect.poll(html).toContain("height: 150px");
  expect(html()).not.toMatch(/__ed-|data-resize|contenteditable/);
  await page.locator("#presentBtn").click();
  await expect(page.frameLocator("iframe").nth(1).locator(".resize-box")).toHaveCSS("width", "360px");
  await expect(page.frameLocator("iframe").nth(1).locator(".resize-image")).toHaveCSS("height", "150px");
  await other.close();
});

test("frames, minimum sizes, canceled gestures and locale-only resizing", async ({ page }) => {
  await openEditor(page);
  const box = page.frameLocator("#frame").locator(".resize-box");
  // Edges work before selection as well as through the visible handles.
  const r = await box.boundingBox();
  await page.mouse.move(r.x + r.width, r.y + r.height / 2);
  await expect(box).toHaveCSS("cursor", "ew-resize");
  const before = await box.evaluate((el) => el.getAttribute("style"));
  await page.mouse.down();
  await page.mouse.move(r.x + r.width + 30, r.y + r.height / 2);
  await box.evaluate((el) => el.ownerDocument.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 1, bubbles: true })));
  await page.mouse.up();
  await expect.poll(() => box.getAttribute("style")).toBe(before);
  await resize(page, ".resize-box", "e", -1000, 0);
  await expect(box).toHaveCSS("width", "38px"); // padding + borders are larger than the 24px floor
  await expect.poll(() => readFileSync(deckPath("slides/editing.html"), "utf8")).toContain("width: 38px");
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => box.getAttribute("style")).toBe(before);
  await expect.poll(() => readFileSync(deckPath("slides/editing.html"), "utf8")).not.toContain("width: 38px");

  const embedded = page.frameLocator("#frame").locator(".resize-frame");
  const width = await embedded.evaluate((el) => el.getBoundingClientRect().width);
  await resize(page, ".resize-frame", "e", 40, 0);
  await expect(embedded).toHaveCSS("width", `${width + 40}px`);
  await expect.poll(() => readFileSync(deckPath("slides/editing.html"), "utf8")).toContain(`width: ${width + 40}px`);

  const text = page.frameLocator("#frame").locator(".editable-text");
  await text.click();
  await page.locator("#iScope").check();
  await resize(page, ".editable-text", "e", 80, 0);
  await expect(text).toHaveCSS("width", "580px");
  await expect.poll(() => readFileSync(deckPath("slides/editing.html"), "utf8")).toContain("width: 580px !important");
  // A keyed text container must undo geometry, not its collaborative text.
  const content = await text.innerHTML();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(text).toHaveCSS("width", "500px");
  await expect(text).toHaveJSProperty("innerHTML", content);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(text).toHaveCSS("width", "580px");
  await expect.poll(() => readFileSync(deckPath("slides/editing.html"), "utf8")).toContain("width: 580px !important");
  await page.locator("#locales button").filter({ hasText: "ja" }).click();
  await expect(page.frameLocator("#frame").locator("html")).toHaveAttribute("lang", "ja");
  await expect(text).toHaveCSS("width", "500px");
});

test("line breaks also save without the collaboration client and preserve inline markup", async ({ page }) => {
  await page.route("**/editor/collaboration.js", (route) => route.abort());
  await openEditor(page);
  const text = page.frameLocator("#frame").locator(".editable-text");
  const previous = await text.innerHTML();
  await enterLines(text, ["Fallback", "", "Saved"]);
  await page.locator("#saveBtn").click();
  await expect.poll(() => catalog("en")["editing.text"]).toBe("Fallback<br><br>Saved");
  await page.keyboard.press("ControlOrMeta+z");
  await page.locator("#saveBtn").click();
  await expect.poll(() => catalog("en")["editing.text"]).toBe(previous);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await page.locator("#saveBtn").click();
  await expect.poll(() => catalog("en")["editing.text"]).toBe("Fallback<br><br>Saved");
  await page.reload();
  await page.locator("#slidelist button").filter({ hasText: "editing" }).click();
  await expectLines(text, ["Fallback", "", "Saved"]);
  // Exercise the real normalization routine on a rich inline fragment, including
  // literal markup characters. Only new BR nodes may be introduced.
  expect(await page.evaluate(() => {
    const p = doc().createElement("p"), strong = doc().createElement("strong");
    strong.textContent = "Bold\nline";
    p.append(strong, doc().createTextNode("\r\n<img onerror=alert(1)>"));
    return editedClone(p).innerHTML;
  })).toBe("<strong>Bold<br>line</strong><br>&lt;img onerror=alert(1)&gt;");
});

test("Present flushes text immediately and consecutive resizes cannot lose the last release", async ({ page }) => {
  await openEditor(page);
  // Hold the first response so a second release happens before its acknowledgement.
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let saves = 0;
  await page.route("**/api/save", async (route) => {
    const response = await route.fetch();
    if (++saves === 1) await held;
    await route.fulfill({ response });
  });
  const box = page.frameLocator("#frame").locator(".resize-box");
  const original = await box.evaluate((el) => el.getBoundingClientRect().width);
  await resize(page, ".resize-box", "e", 20, 0);
  await expect.poll(() => saves).toBe(1);
  await resize(page, ".resize-box", "e", 20, 0);
  release();
  await expect.poll(() => saves).toBe(2);
  await expect.poll(() => readFileSync(deckPath("slides/editing.html"), "utf8")).toContain(`width: ${original + 40}px`);
  const text = page.frameLocator("#frame").locator(".editable-text");
  await enterLines(text, ["Immediate", "Present", "Breaks"]);
  await page.locator("#presentBtn").click();
  await expectLines(page.frameLocator("iframe").nth(1).locator(".editable-text"), ["Immediate", "Present", "Breaks"]);
  await expect(page.frameLocator("iframe").nth(1).locator(".resize-box")).toHaveCSS("width", `${original + 40}px`);
});
