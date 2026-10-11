"use client";

import { useCallback, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type RefObject } from "react";

type UseWidgetDoubleTapOptions = {
  host: RefObject<HTMLDivElement | null>;
  enabled: boolean;
  contextKey: string;
  onDoubleTap?: () => void;
  isBusy?: () => boolean;
};

type WidgetTap = {
  widgetId: string;
  pointerType: string;
  x: number;
  y: number;
  releasedAt: number;
};

type ActiveWidgetTap = {
  pointerId: number;
  widgetId: string;
  pointerType: string;
  startX: number;
  startY: number;
  startedAt: number;
};

const MAX_TAP_DURATION_MS = 300;
const MAX_TAP_INTERVAL_MS = 350;
const MAX_TAP_DISTANCE_PX = 24;
const DRAG_DISTANCE_PX = 5;

export function useWidgetDoubleTap({ host, enabled, contextKey, onDoubleTap, isBusy }: UseWidgetDoubleTapOptions) {
  const activeTapRef = useRef<ActiveWidgetTap | null>(null);
  const previousTapRef = useRef<WidgetTap | null>(null);
  const latestRef = useRef({ enabled, onDoubleTap, isBusy });

  useLayoutEffect(() => {
    latestRef.current = { enabled, onDoubleTap, isBusy };
  }, [enabled, isBusy, onDoubleTap]);

  const clearTaps = useCallback(() => {
    activeTapRef.current = null;
    previousTapRef.current = null;
  }, []);

  useLayoutEffect(() => {
    const captureTarget = host.current;
    if (!captureTarget || !enabled) {
      clearTaps();
      return;
    }

    const pointerMove = (event: PointerEvent) => {
      const activeTap = activeTapRef.current;
      if (!activeTap || event.pointerId !== activeTap.pointerId) return;
      if (Math.hypot(event.clientX - activeTap.startX, event.clientY - activeTap.startY) >= DRAG_DISTANCE_PX) {
        clearTaps();
      }
    };

    // Window capture runs before the grid's document capture pointerup handler,
    // which releases capture and may retarget the event away from the widget.
    const pointerUp = (event: PointerEvent) => {
      const activeTap = activeTapRef.current;
      if (!activeTap || event.pointerId !== activeTap.pointerId) return;
      activeTapRef.current = null;

      const releasedAt = performance.now();
      const duration = releasedAt - activeTap.startedAt;
      const moved = Math.hypot(event.clientX - activeTap.startX, event.clientY - activeTap.startY) >= DRAG_DISTANCE_PX;
      if (moved || duration >= MAX_TAP_DURATION_MS || latestRef.current.isBusy?.()) {
        previousTapRef.current = null;
        return;
      }

      const previousTap = previousTapRef.current;
      const isSecondTap = Boolean(previousTap
        && previousTap.widgetId === activeTap.widgetId
        && previousTap.pointerType === activeTap.pointerType
        && releasedAt - previousTap.releasedAt <= MAX_TAP_INTERVAL_MS
        && Math.hypot(activeTap.startX - previousTap.x, activeTap.startY - previousTap.y) <= MAX_TAP_DISTANCE_PX);

      if (isSecondTap) {
        previousTapRef.current = null;
        latestRef.current.onDoubleTap?.();
        return;
      }

      previousTapRef.current = {
        widgetId: activeTap.widgetId,
        pointerType: activeTap.pointerType,
        x: activeTap.startX,
        y: activeTap.startY,
        releasedAt,
      };
    };

    const pointerCancel = (event: PointerEvent) => {
      if (activeTapRef.current?.pointerId === event.pointerId) clearTaps();
    };
    const lostPointerCapture = (event: PointerEvent) => {
      // A normal pointerup has already cleared the held tap before this event.
      // Only loss during an active press invalidates the previous tap chain.
      if (activeTapRef.current?.pointerId === event.pointerId) clearTaps();
    };
    const reset = () => clearTaps();
    const keyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") clearTaps();
    };

    window.addEventListener("pointermove", pointerMove, true);
    window.addEventListener("pointerup", pointerUp, true);
    window.addEventListener("pointercancel", pointerCancel, true);
    window.addEventListener("blur", reset);
    window.addEventListener("keydown", keyDown, true);
    captureTarget.addEventListener("lostpointercapture", lostPointerCapture);

    return () => {
      clearTaps();
      window.removeEventListener("pointermove", pointerMove, true);
      window.removeEventListener("pointerup", pointerUp, true);
      window.removeEventListener("pointercancel", pointerCancel, true);
      window.removeEventListener("blur", reset);
      window.removeEventListener("keydown", keyDown, true);
      captureTarget.removeEventListener("lostpointercapture", lostPointerCapture);
    };
  }, [clearTaps, contextKey, enabled, host]);

  return (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0) {
      clearTaps();
      return;
    }

    const target = event.target instanceof Element ? event.target : null;
    const captureTarget = host.current;
    const widget = target?.closest<HTMLElement>("[data-widget-id]");
    if (!enabled || !captureTarget || !widget || !captureTarget.contains(widget) || latestRef.current.isBusy?.()) {
      clearTaps();
      return;
    }

    if (target?.closest("[data-widget-resize-handle]")) {
      clearTaps();
      return;
    }
    const reorderHandle = target?.closest("[data-widget-reorder-handle]");
    if (!reorderHandle && target?.closest("button, a, input, textarea, select, [role='button'], [contenteditable]:not([contenteditable='false'])")) {
      clearTaps();
      return;
    }

    const widgetId = widget.dataset.widgetId;
    if (!widgetId) {
      clearTaps();
      return;
    }

    activeTapRef.current = {
      pointerId: event.pointerId,
      widgetId,
      pointerType: event.pointerType,
      startX: event.clientX,
      startY: event.clientY,
      startedAt: performance.now(),
    };
  };
}
