import assert from "node:assert/strict";
import test from "node:test";
import { clientModule } from "./helpers/client-modules.mjs";

const motion = await import(await clientModule("lib/widget-resize-motion.ts"));
const { getWidgetResizeContentFilter } = await import(await clientModule("lib/widget-resize.ts"));

test("widget settle frames preserve the 31-frame physical resize curve", () => {
  const from = { left: 10, top: 20, width: 100, height: 60 };
  const to = { left: 40, top: 70, width: 300, height: 240 };
  const frames = motion.createWidgetResizeSettleFrames(from, to);

  assert.equal(motion.WIDGET_RESIZE_SETTLE_DURATION_MS, 420);
  assert.equal(motion.WIDGET_RESIZE_SETTLE_FRAME_COUNT, 31);
  assert.equal(motion.WIDGET_RESIZE_SETTLE_EASING, "linear");
  assert.equal(motion.WIDGET_RESIZE_CONTENT_REVEAL_DURATION_MS, 220);
  assert.equal(frames.length, 31);
  assert.deepEqual(frames[0], {
    offset: 0,
    width: "100px",
    height: "60px",
    transform: "translate(-30px, -50px)",
    transformOrigin: "top left",
  });
  assert.deepEqual(frames.at(-1), {
    offset: 1,
    width: "300px",
    height: "240px",
    transform: "translate(0px, 0px)",
    transformOrigin: "top left",
  });
  const progress = 1 - Math.exp(-7 * 0.5) * (Math.cos(5.5) + 7 / 11 * Math.sin(5.5));
  assert.equal(frames[15].offset, 0.5);
  assert.equal(frames[15].width, `${Math.max(1, from.width + (to.width - from.width) * progress)}px`);
  assert.equal(frames[15].height, `${Math.max(1, from.height + (to.height - from.height) * progress)}px`);
});

test("settle frames land exactly and clamp interpolated dimensions to one pixel", () => {
  const frames = motion.createWidgetResizeSettleFrames(
    { left: 100, top: 80, width: 2, height: 1 },
    { left: 0, top: 0, width: 0, height: 0 },
  );

  assert.deepEqual(frames.at(-1), {
    offset: 1,
    width: "1px",
    height: "1px",
    transform: "translate(0px, 0px)",
    transformOrigin: "top left",
  });
  assert.equal(getWidgetResizeContentFilter(8), "blur(8px) saturate(1.24) brightness(1.1)");
  assert.equal(getWidgetResizeContentFilter(0), "blur(0px) saturate(1) brightness(1)");
});

test("increased course damping reduces overshoot in both directions without changing endpoints", () => {
  const small = { left: 30, top: 500, width: 260, height: 200 };
  const large = { left: 30, top: 40, width: 840, height: 740 };
  for (const [from, to] of [[small, large], [large, small]]) {
    const original = motion.createWidgetResizeSettleFrames(from, to);
    const softened = motion.createWidgetResizeSettleFrames(from, to, 9);
    const overshoot = (frames) => Math.max(...frames.map((frame) => (Number.parseFloat(frame.width) - to.width) / (to.width - from.width)));
    assert.ok(overshoot(softened) > 0);
    assert.ok(overshoot(softened) < overshoot(original) * 0.65);
    assert.deepEqual(softened[0], original[0]);
    assert.deepEqual(softened.at(-1), original.at(-1));
  }
});
