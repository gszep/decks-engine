/* Overflow check — flags elements that clip outside the 1280×720 slide.
 * One-shot QA tool: run it, fix the yellow-flagged elements, run again.
 * All instrumentation is __-prefixed, so it can never leak into a save. */
harness.registerTool({
  id: "overflow-check",
  name: "⚠ Overflow check",
  run(h) {
    const d = h.doc();
    d.querySelectorAll(".__qa-overflow").forEach((el) => el.classList.remove("__qa-overflow"));
    if (!d.getElementById("__qa-overflow-style")) {
      const st = d.createElement("style");
      st.id = "__qa-overflow-style";
      st.textContent = ".__qa-overflow { outline: 3px solid #f9e81e !important; outline-offset: -3px; }";
      d.head.appendChild(st);
    }
    const hits = [];
    for (const el of h.slideRoot().querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width && r.height && (r.right > 1280.5 || r.bottom > 720.5 || r.left < -0.5 || r.top < -0.5)) {
        el.classList.add("__qa-overflow");
        hits.push(el.tagName.toLowerCase() + (el.className && typeof el.className === "string"
          ? "." + el.className.split(" ").filter((c) => !c.startsWith("__"))[0] : ""));
      }
    }
    h.status(hits.length
      ? `overflow: ${hits.length} element(s) flagged in yellow — ${hits.slice(0, 5).join(", ")}${hits.length > 5 ? "…" : ""}`
      : "no overflow — slide is clean", hits.length > 0);
  },
  dispose(h) {
    const d = h.doc?.();
    if (!d) return;
    d.getElementById("__qa-overflow-style")?.remove();
    d.querySelectorAll(".__qa-overflow").forEach((el) => el.classList.remove("__qa-overflow"));
  },
});
