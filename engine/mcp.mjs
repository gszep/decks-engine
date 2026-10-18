import { createMcpHandler, McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";

const text = (value) => ({ content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }], structuredContent: typeof value === "object" ? value : undefined });
const failure = (message) => ({ isError: true, content: [{ type: "text", text: message }] });

export function createDeckMcp({ documentId, title, manifest, readSlide, readCatalog, updateCatalogText, readStyles, writeSlide, setSlideOrder, readGuidance, writeGuidance, writeEditorTool }) {
  const factory = ({ authInfo }) => {
    const principal = authInfo?.extra?.principal;
    const server = new McpServer({ name: "decks", version: process.env.K_REVISION || "development" });
    server.registerTool("get_presentation", {
      title: "Get presentation", description: "Read presentation metadata and ordered slide names.", inputSchema: z.object({}),
    }, async () => text({ documentId, title: title(), slides: manifest().slides, locales: manifest().locales, permission: authInfo?.extra?.role }));
    server.registerTool("read_slide", {
      title: "Read slide", description: "Read one slide's structural HTML and localized keyed text.",
      inputSchema: z.object({ slide: z.string().min(1), locale: z.string().min(1) }),
    }, async ({ slide, locale }) => {
      try { return text({ slide, locale, html: readSlide(slide), strings: readCatalog(locale, slide) }); }
      catch (error) { return failure(error.message); }
    });
    server.registerTool("update_catalog_text", {
      title: "Update catalog text",
      description: "Update one non-human-finalized localized string. The expected value prevents overwriting concurrent edits.",
      inputSchema: z.object({
        locale: z.string().min(1), key: z.string().min(1), value: z.string(), expectedCurrent: z.string(),
      }),
    }, async ({ locale, key, value, expectedCurrent }) => {
      if (!authInfo?.scopes.includes("decks:write")) return failure("decks:write scope required");
      try { return text(updateCatalogText({ locale, key, value, expectedCurrent, principal })); }
      catch (error) { return failure(error.message); }
    });
    const write = (run) => async (input) => {
      if (!authInfo?.scopes.includes("decks:write")) return failure("decks:write scope required");
      try { return text(run(input)); } catch (error) { return failure(error.message); }
    };
    server.registerTool("read_styles", {
      title: "Read styles", description: "Read the deck's stylesheets, to reuse its classes and var(--ct-*) tokens in new slides.",
      inputSchema: z.object({}),
    }, async () => text(readStyles()));
    server.registerTool("write_slide", {
      title: "Write slide",
      description: "Create or replace one slide: a full HTML document like read_slide returns, with text in data-i18n keys supplied via strings ({locale: {key: text}}). New slides are inserted at position (0 = first; default last). Elements a person edited (data-author) must be kept exactly; <style> blocks are allowed, scripts are not.",
      inputSchema: z.object({
        slide: z.string().min(1), html: z.string().min(1),
        strings: z.record(z.string(), z.record(z.string(), z.string())).optional(),
        position: z.number().int().min(0).optional(),
      }),
    }, write((input) => writeSlide({ ...input, principal })));
    server.registerTool("set_slide_order", {
      title: "Set slide order",
      description: "Reorder the deck, or leave slides out to remove them. Slides containing a person's edits can't be removed.",
      inputSchema: z.object({ slides: z.array(z.string().min(1)).min(1) }),
    }, write((input) => setSlideOrder({ ...input, principal })));
    server.registerTool("read_guidance", {
      title: "Read design guidance", description: "Read the theme's design guidance (GUIDANCE.md prose and guidance.json rules) that the editor checks slides against.",
      inputSchema: z.object({}),
    }, async () => text(readGuidance()));
    server.registerTool("write_guidance", {
      title: "Write design guidance", description: "Replace GUIDANCE.md or guidance.json for this deck's theme (shared by every deck using the theme). guidance.json must be valid JSON.",
      inputSchema: z.object({ file: z.enum(["GUIDANCE.md", "guidance.json"]), content: z.string() }),
    }, write((input) => writeGuidance({ ...input, principal })));
    server.registerTool("write_editor_tool", {
      title: "Write editor tool",
      description: "Add, replace or remove (remove: true) a sidebar tool for the browser editor: plain JS calling harness.registerTool({ id, name, run(h) | activate(h)/deactivate(h), slideLoaded, inspector, dispose }). The harness h offers sel, doc(), slideRoot(), select(el), applyStyle(prop, value), nudge(el, dx, dy), pushUndo(), undo(), touched(el), tokens, locale, slideName, manifest, status(msg), saveCurrent(). Use __-prefixed classes for scaffolding and theme tokens, never hex. Each person must enable the tool before it runs for them.",
      inputSchema: z.object({ name: z.string().min(1), code: z.string().default(""), remove: z.boolean().optional() }),
    }, write((input) => writeEditorTool({ ...input, principal })));
    return server;
  };
  return createMcpHandler(factory, { legacy: "stateless" });
}

export async function serveMcp(handler, request, response, { authInfo, origin }) {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? Buffer.concat(chunks) : undefined;
  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers))
    if (value != null) headers.set(name, Array.isArray(value) ? value.join(", ") : value);
  const webRequest = new Request(new URL(request.url, origin), {
    method: request.method, headers, body: ["GET", "HEAD"].includes(request.method) ? undefined : body,
  });
  const result = await handler.fetch(webRequest, { authInfo });
  const resultHeaders = {};
  result.headers.forEach((value, name) => { resultHeaders[name] = value; });
  response.writeHead(result.status, resultHeaders);
  response.end(Buffer.from(await result.arrayBuffer()));
}
