import assert from "node:assert/strict";
import test from "node:test";
import { resizeGeometry } from "../engine/editor/resize.mjs";

test("all resize edges anchor the opposite side and snap to CSS pixels", () => {
  for (const edge of ["n", "s", "e", "w", "nw", "ne", "sw", "se"]) {
    const box = resizeGeometry({ edge, width: 200, height: 100 }, 30.2, 20.4);
    const w = edge.includes("w") ? 170 : edge.includes("e") ? 230 : 200;
    const h = edge.includes("n") ? 80 : edge.includes("s") ? 120 : 100;
    assert.deepEqual(box, { width: w, height: h, x: edge.includes("w") ? 200 - w : 0, y: edge.includes("n") ? 100 - h : 0 });
  }
});

test("resize clamps at minimum sizes without flipping edges", () => {
  assert.deepEqual(resizeGeometry({ edge: "nw", width: 200, height: 100 }, 1000, 1000), { width: 24, height: 24, x: 176, y: 76 });
  assert.equal(resizeGeometry({ edge: "e", width: 200, height: 100, minWidth: 80 }, -1000, 0).width, 80);
});

test("Shift aspect lock works on image edges and corners, including minimums", () => {
  for (const edge of ["n", "s", "e", "w", "nw", "ne", "sw", "se"]) {
    for (const delta of [-1000, -20, 40, 1000]) {
      const box = resizeGeometry({ edge, width: 200, height: 100 }, delta, delta, true);
      assert.ok(box.width >= 24 && box.height >= 24);
      assert.equal(box.width / box.height, 2);
    }
  }
});
