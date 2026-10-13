import assert from "node:assert/strict";
import test from "node:test";
import { clientModule } from "./helpers/client-modules.mjs";

const motion = await import(await clientModule("lib/course-expansion-motion.ts"));

test("course expansion uses a slower shared spring through its 420ms settle", () => {
  const { getCourseExpansionProgress, COURSE_EXPANSION_MOTION_DURATION_MS } = motion;

  assert.equal(COURSE_EXPANSION_MOTION_DURATION_MS, 420);
  assert.equal(getCourseExpansionProgress(0), 0);
  assert.equal(getCourseExpansionProgress(1), 1);
  assert.ok(getCourseExpansionProgress(80 / COURSE_EXPANSION_MOTION_DURATION_MS) < 0.7, "the shell is still visibly expanding at 80ms");
  assert.ok(getCourseExpansionProgress(190 / COURSE_EXPANSION_MOTION_DURATION_MS) > 1.03, "the approved spring bounce peaks near 190ms");
  assert.ok(getCourseExpansionProgress(300 / COURSE_EXPANSION_MOTION_DURATION_MS) < 1.02, "the spring settles smoothly before the 420ms endpoint");
});

test("shell geometry reaches the target with aligned size and translation and a small final step", () => {
  const { createCourseExpansionSettleFrames } = motion;
  const from = { left: 40, top: 500, width: 240, height: 140 };
  const to = { left: 100, top: 80, width: 820, height: 700 };
  const geometry = createCourseExpansionSettleFrames(from, to);

  assert.equal(geometry.length, 31);
  assert.equal(geometry[0].width, `${from.width}px`);
  assert.equal(geometry[0].height, `${from.height}px`);
  assert.equal(geometry.at(-1).width, `${to.width}px`);
  assert.equal(geometry.at(-1).height, `${to.height}px`);
  assert.equal(geometry.at(-1).transform, "translate(0px, 0px)");

  for (const frame of geometry) {
    const widthProgress = (Number.parseFloat(frame.width) - from.width) / (to.width - from.width);
    const heightProgress = (Number.parseFloat(frame.height) - from.height) / (to.height - from.height);
    const [, x, y] = frame.transform.match(/^translate\(([-\d.]+)px, ([-\d.]+)px\)$/) ?? [];
    assert.ok(x !== undefined && y !== undefined, "each geometry frame has a concrete translation");
    const xProgress = 1 - Number(x) / (from.left - to.left);
    const yProgress = 1 - Number(y) / (from.top - to.top);
    assert.ok(Math.abs(widthProgress - heightProgress) < 1e-10);
    assert.ok(Math.abs(widthProgress - xProgress) < 1e-10);
    assert.ok(Math.abs(widthProgress - yProgress) < 1e-10);
  }

  const lastWidthStep = Math.abs(Number.parseFloat(geometry.at(-1).width) - Number.parseFloat(geometry.at(-2).width));
  const lastHeightStep = Math.abs(Number.parseFloat(geometry.at(-1).height) - Number.parseFloat(geometry.at(-2).height));
  assert.ok(lastWidthStep < (to.width - from.width) * 0.01, "the final frame closes a small remaining width gap");
  assert.ok(lastHeightStep < (to.height - from.height) * 0.01, "the final frame closes a small remaining height gap");
});
