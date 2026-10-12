"use client";

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import HomeSkeleton, { type HomeSkeletonGreeting } from "./home-skeleton";
import { layoutsMatch, type HomeSkeletonLayout } from "../lib/home-skeleton";

type HomeLoadTransitionProps = {
  ready: boolean;
  layout: HomeSkeletonLayout;
  greeting: HomeSkeletonGreeting;
  serverLayout?: HomeSkeletonLayout;
  layoutRestored: boolean;
  reducedMotion?: boolean;
  children?: ReactNode;
};

type TransitionPhase = "pending" | "fading-out" | "revealing" | "done";

const fadeDuration = 160;

function hasReducedMotionOverride(reducedMotion: boolean) {
  if (reducedMotion || typeof window === "undefined") return reducedMotion;
  const html = document.documentElement;
  return html.dataset.motion === "reduced"
    || (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

export function HomeLoadTransition({
  ready,
  layout,
  greeting,
  serverLayout,
  layoutRestored,
  reducedMotion = false,
  children,
}: HomeLoadTransitionProps) {
  // Freeze the first restored silhouette for this loading cycle. Server data may
  // refresh the cache while the pending shape stays in place for the fade.
  const [pendingLayout] = useState(layout);
  const [animatePageEntry] = useState(() => ready);
  const [hasBeenPending, setHasBeenPending] = useState(() => !ready);
  const [phase, setPhase] = useState<TransitionPhase>(() => ready ? "done" : "pending");
  const shouldAnimate = ready && layoutRestored && hasBeenPending;
  const phaseForRender: TransitionPhase = !ready || !layoutRestored ? "pending" : phase;
  const contentInactive = ready && phaseForRender !== "done";

  const rootRef = useRef<HTMLDivElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const skeletonRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const completedRef = useRef(false);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const host = hostRef.current;
    const content = contentRef.current;
    if (!root || !host) return;

    if (!ready) {
      completedRef.current = false;
      if (!hasBeenPending) {
        // eslint-disable-next-line react-hooks/set-state-in-effect -- Reset an interrupted loading cycle before its next server response.
        setHasBeenPending(true);
      }
      setPhase("pending");
    }
    if (content) {
      if (contentInactive) {
        content.setAttribute("aria-hidden", "true");
        content.setAttribute("inert", "");
      } else {
        content.removeAttribute("aria-hidden");
        content.removeAttribute("inert");
      }
    }

    if (!ready || !layoutRestored) return;
    if (completedRef.current) {
      setPhase("done");
      return;
    }
    if (!shouldAnimate) {
      completedRef.current = true;
      setPhase("done");
      setHasBeenPending(false);
      return;
    }

    const skeleton = skeletonRef.current;
    if (!content || !skeleton || hasReducedMotionOverride(reducedMotion)
      || typeof skeleton.animate !== "function" || typeof content.animate !== "function") {
      completedRef.current = true;
      setPhase("done");
      setHasBeenPending(false);
      content?.removeAttribute("aria-hidden");
      content?.removeAttribute("inert");
      return;
    }

    let cancelled = false;
    let settled = false;
    let revealFrame: number | null = null;
    let observer: ResizeObserver | null = null;
    let stopMotionListener: () => void = () => undefined;
    const animations: Animation[] = [];
    const cancelAnimations = () => {
      for (const animation of animations) animation.cancel();
      animations.length = 0;
    };
    const revealImmediately = () => {
      if (cancelled || settled) return;
      settled = true;
      completedRef.current = true;
      if (revealFrame !== null) window.cancelAnimationFrame(revealFrame);
      observer?.disconnect();
      stopMotionListener();
      cancelAnimations();
      content.removeAttribute("aria-hidden");
      content.removeAttribute("inert");
      setPhase("done");
      setHasBeenPending(false);
    };

    content.setAttribute("aria-hidden", "true");
    content.setAttribute("inert", "");
    setPhase("fading-out");

    if (typeof window.matchMedia === "function") {
      const motionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
      const handleMotionChange = () => {
        if (motionQuery.matches) revealImmediately();
      };
      if (typeof motionQuery.addEventListener === "function") {
        motionQuery.addEventListener("change", handleMotionChange);
        stopMotionListener = () => motionQuery.removeEventListener("change", handleMotionChange);
      } else {
        motionQuery.addListener(handleMotionChange);
        stopMotionListener = () => motionQuery.removeListener(handleMotionChange);
      }
      if (motionQuery.matches) revealImmediately();
    }

    const initialWidth = host.getBoundingClientRect().width;
    if (typeof ResizeObserver !== "undefined") {
      observer = new ResizeObserver(() => {
        if (!cancelled && Math.abs(host.getBoundingClientRect().width - initialWidth) > 1) revealImmediately();
      });
      observer.observe(host);
    } else {
      const handleResize = () => {
        if (Math.abs(host.getBoundingClientRect().width - initialWidth) > 1) revealImmediately();
      };
      window.addEventListener("resize", handleResize);
      observer = {
        disconnect: () => window.removeEventListener("resize", handleResize),
        observe: () => undefined,
        unobserve: () => undefined,
      } as ResizeObserver;
    }

    const beginReveal = () => {
      revealFrame = null;
      if (cancelled || settled) return;
      setPhase("revealing");
      try {
        const reveal = content.animate(
          [{ opacity: 0 }, { opacity: 1 }],
          { duration: fadeDuration, easing: "ease-out", fill: "forwards" },
        );
        animations.push(reveal);
        void reveal.finished.then(revealImmediately).catch(revealImmediately);
      } catch {
        revealImmediately();
      }
    };

    if (!settled) {
      try {
        const fadeOut = skeleton.animate(
          [{ opacity: 1 }, { opacity: 0 }],
          { duration: fadeDuration, easing: "ease-out", fill: "forwards" },
        );
        animations.push(fadeOut);
        void fadeOut.finished.then(() => {
          if (cancelled || settled) return;
          if (typeof window.requestAnimationFrame === "function") {
            revealFrame = window.requestAnimationFrame(beginReveal);
          } else {
            beginReveal();
          }
        }).catch(revealImmediately);
      } catch {
        revealImmediately();
      }
    }

    return () => {
      cancelled = true;
      if (revealFrame !== null) window.cancelAnimationFrame(revealFrame);
      observer?.disconnect();
      stopMotionListener();
      cancelAnimations();
    };
  }, [contentInactive, hasBeenPending, layoutRestored, ready, reducedMotion, shouldAnimate]);

  return (
    <div
      ref={rootRef}
      className="home-load-transition"
      data-page-entry={String(animatePageEntry)}
      data-phase={phaseForRender}
      data-layout-restored={String(layoutRestored)}
      data-layout-match={String(ready && serverLayout ? layoutsMatch(pendingLayout, serverLayout) : false)}
    >
      <div ref={hostRef} className="home-load-transition__host">
        {(!ready || hasBeenPending) && (
          <div ref={skeletonRef} className="home-load-transition__skeleton">
            <HomeSkeleton layout={pendingLayout} greeting={greeting} reducedMotion={reducedMotion} />
          </div>
        )}
        {ready && (
          <div
            ref={contentRef}
            className="home-load-transition__content"
            aria-hidden={contentInactive ? "true" : undefined}
            inert={contentInactive}
          >
            {children}
          </div>
        )}
      </div>
    </div>
  );
}

export default HomeLoadTransition;
