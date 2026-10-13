export type CourseExpansionRect = Pick<DOMRectReadOnly, "left" | "top" | "width" | "height">;

export const COURSE_EXPANSION_MOTION_DURATION_MS = 420;
export const COURSE_EXPANSION_MOTION_FRAME_COUNT = 31;
export const COURSE_EXPANSION_MOTION_EASING = "linear";
export const COURSE_EXPANSION_CONTENT_DURATION_MS = 260;
export const COURSE_EXPANSION_CONTENT_FADE_IN_START_MS = 75;
export const COURSE_EXPANSION_CONTENT_FADE_OUT_END_MS = 110;

const SPRING_FREQUENCY = 6.8;
const SPRING_DAMPING = 6.8;

function springResponse(offset: number): number {
  const phase = SPRING_FREQUENCY * offset;
  return 1 - Math.exp(-SPRING_DAMPING * offset)
    * (Math.cos(phase) + SPRING_DAMPING / SPRING_FREQUENCY * Math.sin(phase));
}

const SPRING_ENDPOINT = springResponse(1);

export function getCourseExpansionProgress(offset: number): number {
  if (offset <= 0) return 0;
  if (offset >= 1) return 1;
  return springResponse(offset) / SPRING_ENDPOINT;
}

export function createCourseExpansionProgressFrames(frameCount = COURSE_EXPANSION_MOTION_FRAME_COUNT) {
  return Array.from({ length: frameCount }, (_, index) => {
    const offset = index / (frameCount - 1);
    return { offset, progress: getCourseExpansionProgress(offset) };
  });
}

export function createCourseExpansionSettleFrames(from: CourseExpansionRect, to: CourseExpansionRect): Keyframe[] {
  const x = from.left - to.left;
  const y = from.top - to.top;
  return createCourseExpansionProgressFrames().map(({ offset, progress }) => ({
    offset,
    width: `${Math.max(1, from.width + (to.width - from.width) * progress)}px`,
    height: `${Math.max(1, from.height + (to.height - from.height) * progress)}px`,
    transform: `translate(${x * (1 - progress)}px, ${y * (1 - progress)}px)`,
    transformOrigin: "top left",
  }));
}
