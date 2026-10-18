// Geometry in unscaled element CSS pixels; the opposite edge stays anchored.
// The editor has no grid/guides. Round to its existing one-pixel nudge grid.
export function resizeGeometry({ edge, width, height, minWidth = 24, minHeight = 24 }, dx, dy, aspect = false) {
  let w = Math.max(minWidth, width + (edge.includes("w") ? -dx : edge.includes("e") ? dx : 0));
  let h = Math.max(minHeight, height + (edge.includes("n") ? -dy : edge.includes("s") ? dy : 0));
  if (aspect) {
    const ratio = width / height;
    if (edge === "n" || edge === "s" || (edge.length === 2 && Math.abs(h - height) / height > Math.abs(w - width) / width)) w = h * ratio;
    else h = w / ratio;
    w = Math.max(w, minWidth, minHeight * ratio);
    h = w / ratio;
  }
  w = Math.round(w); h = Math.round(h);
  return { width: w, height: h, x: edge.includes("w") ? width - w : 0, y: edge.includes("n") ? height - h : 0 };
}
