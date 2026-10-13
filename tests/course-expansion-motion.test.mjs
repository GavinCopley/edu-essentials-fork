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

test("detail content stays at its destination world-left while a source-centered shell expands", () => {
  const { createCourseExpansionHorizontalFrames, getCourseExpansionProgress } = motion;
  const borderLeft = 1;
  const positions = [
    { sourceLeft: 20, destinationLeft: 18, name: "left" },
    { sourceLeft: 480, destinationLeft: 180, name: "middle" },
    { sourceLeft: 1060, destinationLeft: 342, name: "right" },
  ];

  for (const { sourceLeft, destinationLeft, name } of positions) {
    const from = { left: sourceLeft, top: 500, width: 220, height: 120 };
    const to = { left: destinationLeft, top: 80, width: 840, height: 740 };
    const desiredWorldLeft = destinationLeft + borderLeft;
    const frames = createCourseExpansionHorizontalFrames(from, to, desiredWorldLeft, desiredWorldLeft, borderLeft);

    assert.equal(frames.length, 31);
    assert.equal(frames[0].transform, `translateX(${destinationLeft - sourceLeft}px)`, `${name} opening starts over the measured destination`);
    assert.equal(frames.at(-1).transform, "translateX(0px)");
    for (const frame of frames) {
      const progress = getCourseExpansionProgress(frame.offset);
      const parentLeft = from.left + (to.left - from.left) * progress;
      const detailOffset = Number(frame.transform.match(/^translateX\(([-\d.]+)px\)$/)?.[1]);
      const renderedWorldLeft = parentLeft + borderLeft + detailOffset;
      assert.ok(Math.abs(renderedWorldLeft - desiredWorldLeft) < 1e-8, `${name} content remains anchored at its destination`);
    }
  }
});

test("closing keeps the captured detail world-left fixed as the shell returns", () => {
  const { createCourseExpansionHorizontalFrames } = motion;
  const from = { left: 215, top: 90, width: 840, height: 740 };
  const to = { left: 40, top: 610, width: 240, height: 150 };
  const capturedDetailLeft = 603;
  const frames = createCourseExpansionHorizontalFrames(from, to, capturedDetailLeft, capturedDetailLeft, 1);

  assert.equal(frames[0].transform, "translateX(387px)");
  assert.equal(frames.at(-1).transform, "translateX(562px)");
});

test("resize retargeting starts continuously when the expanded width stays equal", () => {
  const { createCourseExpansionHorizontalFrames } = motion;
  const from = { left: 100, top: 80, width: 840, height: 740 };
  const to = { left: 240, top: 80, width: 840, height: 740 };
  const capturedDetailLeft = 305;
  const frames = createCourseExpansionHorizontalFrames(from, to, capturedDetailLeft, to.left + 1, 1);

  assert.equal(from.width, to.width);
  assert.equal(frames[0].transform, "translateX(204px)", "the first frame uses the captured position and current parent bounds");
  assert.equal(frames.at(-1).transform, "translateX(0px)", "the retarget settles at the new destination left edge");
});
