export type WidgetDragMotion = {
  left: number;
  top: number;
  velocityX: number;
  velocityY: number;
  settled: boolean;
};

const SPRING_FREQUENCY = 15;
const POSITION_EPSILON = 0.18;
const VELOCITY_EPSILON = 2;

/** Advance a critically damped pointer follower using its exact constant-target solution. */
export function stepWidgetDragMotion(
  motion: WidgetDragMotion,
  targetLeft: number,
  targetTop: number,
  elapsedSeconds: number,
  maxLag = 24,
): WidgetDragMotion {
  const omega = SPRING_FREQUENCY;
  const dt = Number.isFinite(elapsedSeconds) ? Math.max(0, elapsedSeconds) : 0;
  let left = motion.left;
  let top = motion.top;
  let velocityX = motion.velocityX;
  let velocityY = motion.velocityY;

  const capLag = () => {
    const offsetX = left - targetLeft;
    const offsetY = top - targetTop;
    const distance = Math.hypot(offsetX, offsetY);
    if (distance <= maxLag || distance === 0) return;

    const normalX = offsetX / distance;
    const normalY = offsetY / distance;
    left = targetLeft + normalX * maxLag;
    top = targetTop + normalY * maxLag;

    // Keep the velocity tangent to the cap when it would otherwise move farther away.
    const outwardVelocity = velocityX * normalX + velocityY * normalY;
    if (outwardVelocity > 0) {
      velocityX -= outwardVelocity * normalX;
      velocityY -= outwardVelocity * normalY;
    }
  };

  capLag();

  if (dt > 0) {
    const decay = Math.exp(-omega * dt);
    const errorX = left - targetLeft;
    const errorY = top - targetTop;
    const coupledX = velocityX + omega * errorX;
    const coupledY = velocityY + omega * errorY;

    left = targetLeft + (errorX + coupledX * dt) * decay;
    top = targetTop + (errorY + coupledY * dt) * decay;
    velocityX = (velocityX - omega * coupledX * dt) * decay;
    velocityY = (velocityY - omega * coupledY * dt) * decay;
    capLag();
  }

  const remainingDistance = Math.hypot(left - targetLeft, top - targetTop);
  const speed = Math.hypot(velocityX, velocityY);
  const settled = remainingDistance <= POSITION_EPSILON && speed <= VELOCITY_EPSILON;
  if (settled) {
    left = targetLeft;
    top = targetTop;
    velocityX = 0;
    velocityY = 0;
  }

  return { left, top, velocityX, velocityY, settled };
}
