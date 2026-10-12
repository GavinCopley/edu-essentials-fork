export type WidgetMotionRect = Pick<DOMRectReadOnly, "left" | "top" | "width" | "height">;

export const WIDGET_RESIZE_SETTLE_DURATION_MS = 420;
export const WIDGET_RESIZE_SETTLE_FRAME_COUNT = 31;
export const WIDGET_RESIZE_SETTLE_EASING = "linear";
export const WIDGET_RESIZE_CONTENT_REVEAL_DURATION_MS = 220;

export function createWidgetResizeSettleFrames(from: WidgetMotionRect, to: WidgetMotionRect, damping = 7): Keyframe[] {
  const x = from.left - to.left;
  const y = from.top - to.top;
  return Array.from({ length: WIDGET_RESIZE_SETTLE_FRAME_COUNT }, (_, index) => {
    const offset = index / (WIDGET_RESIZE_SETTLE_FRAME_COUNT - 1);
    const progress = index === WIDGET_RESIZE_SETTLE_FRAME_COUNT - 1
      ? 1
      : 1 - Math.exp(-damping * offset) * (Math.cos(11 * offset) + damping / 11 * Math.sin(11 * offset));
    return {
      offset,
      width: `${Math.max(1, from.width + (to.width - from.width) * progress)}px`,
      height: `${Math.max(1, from.height + (to.height - from.height) * progress)}px`,
      transform: `translate(${x * (1 - progress)}px, ${y * (1 - progress)}px)`,
      transformOrigin: "top left",
    };
  });
}
