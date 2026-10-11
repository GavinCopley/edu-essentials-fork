"use client";

import { useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from "react";

export type WidgetShakePreviewBounds = {
  originRect: DOMRect;
  visualRect: DOMRect;
};

type InlineStyleValue = { value: string; priority: string };

type PreviewStyleSnapshot = {
  card: HTMLElement;
  shakeAttribute: string | null;
  properties: Map<string, InlineStyleValue>;
  baseTranslate: string[];
  active: boolean;
};

const SHAKE_STYLE_PROPERTIES = ["translate", "--widget-shake-x", "--widget-shake-y", "--widget-shake-duration"];

function prefersReducedMotion() {
  return document.documentElement.dataset.motion === "reduced"
    || window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;
}

function transitionDuration(card: HTMLElement) {
  const configured = Number.parseFloat(window.getComputedStyle(card).getPropertyValue("--wa-transition-ms"));
  return Number.isFinite(configured) ? Math.max(0, Math.min(80, configured)) : 80;
}

function snapshotPreviewStyles(card: HTMLElement): PreviewStyleSnapshot {
  const computedTranslate = window.getComputedStyle(card).getPropertyValue("translate").trim();
  return {
    card,
    shakeAttribute: card.getAttribute("data-widget-shake-preview"),
    properties: new Map(SHAKE_STYLE_PROPERTIES.map((property) => [property, {
      value: card.style.getPropertyValue(property),
      priority: card.style.getPropertyPriority(property),
    }])),
    baseTranslate: splitTranslate(computedTranslate),
    active: false,
  };
}

function splitTranslate(value: string) {
  if (!value || value === "none") return ["0px", "0px", "0px"];
  const components: string[] = [];
  let depth = 0;
  let component = "";
  for (const character of value) {
    if (character === "(") depth += 1;
    if (character === ")") depth -= 1;
    if (/\s/.test(character) && depth === 0) {
      if (component) components.push(component);
      component = "";
    } else {
      component += character;
    }
  }
  if (component) components.push(component);
  return components.length ? [...components, "0px", "0px"].slice(0, 3) : ["0px", "0px", "0px"];
}

function composedTranslate(baseTranslate: string[]) {
  const [baseX, baseY, baseZ] = baseTranslate;
  return `calc(${baseX} + var(--widget-shake-x, 0px)) calc(${baseY} + var(--widget-shake-y, 0px)) ${baseZ}`;
}

function restorePreviewStyles(snapshot: PreviewStyleSnapshot) {
  snapshot.card.removeAttribute("data-widget-shake-preview");
  for (const [property, { value, priority }] of snapshot.properties) {
    if (value) snapshot.card.style.setProperty(property, value, priority);
    else snapshot.card.style.removeProperty(property);
  }
  if (snapshot.shakeAttribute !== null) {
    snapshot.card.setAttribute("data-widget-shake-preview", snapshot.shakeAttribute);
  }
  snapshot.active = false;
}

export function useWidgetShake(
  contextKey: string,
  onActivate?: (start: PointerEvent, current: PointerEvent, preview?: WidgetShakePreviewBounds) => void,
) {
  const activateRef = useRef(onActivate);
  const cleanupRef = useRef<(() => void) | null>(null);
  const settleRef = useRef<(() => void) | null>(null);
  const available = Boolean(onActivate);

  useLayoutEffect(() => {
    activateRef.current = onActivate;
  }, [onActivate]);

  useLayoutEffect(() => () => {
    cleanupRef.current?.();
    settleRef.current?.();
  }, [available, contextKey]);

  return (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!activateRef.current || event.pointerType !== "mouse" || event.button !== 0 || !event.isPrimary) return;
    const target = event.target instanceof Element ? event.target : null;
    const header = target?.closest<HTMLElement>(".widget-header");
    if (!header || !event.currentTarget.contains(header) || !header.closest("[data-widget-id]")) return;
    if (target?.closest("button, a, input, textarea, select, [role='button'], [contenteditable]:not([contenteditable='false'])")) return;

    cleanupRef.current?.();
    settleRef.current?.();
    const card = header.closest<HTMLElement>("[data-widget-id]");
    if (!card) return;

    const startEvent = event.nativeEvent;
    const pointerId = event.pointerId;
    const startedAt = event.timeStamp;
    const originRect = card.getBoundingClientRect();
    const previewStyles = snapshotPreviewStyles(card);
    const canNudge = !prefersReducedMotion();
    let extremeX = event.clientX;
    let extremeY = event.clientY;
    let directionX = 0;
    let directionY = 0;
    let reversals = 0;
    let active = true;
    let settleTimer: number | null = null;

    const releasePointerCapture = () => {
      try {
        if (header.hasPointerCapture?.(pointerId)) header.releasePointerCapture(pointerId);
      } catch { /* The browser may already have released capture. */ }
    };
    const removeListeners = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("resize", cancelOnLayoutChange);
      window.removeEventListener("scroll", cancelOnLayoutChange, true);
      header.removeEventListener("lostpointercapture", end);
      releasePointerCapture();
    };
    const clearSettle = () => {
      if (settleTimer !== null) window.clearTimeout(settleTimer);
      settleTimer = null;
    };
    const restoreImmediately = () => {
      clearSettle();
      restorePreviewStyles(previewStyles);
    };
    const settlePreview = () => {
      clearSettle();
      if (!previewStyles.active || !canNudge || !card.isConnected) {
        restorePreviewStyles(previewStyles);
        return;
      }
      const duration = transitionDuration(card);
      if (duration === 0) {
        restorePreviewStyles(previewStyles);
        return;
      }
      card.style.setProperty("--widget-shake-x", "0px");
      card.style.setProperty("--widget-shake-y", "0px");
      const finishSettle = () => {
        if (settleRef.current !== finishSettle) return;
        if (settleTimer !== null) window.clearTimeout(settleTimer);
        settleTimer = null;
        restorePreviewStyles(previewStyles);
        settleRef.current = null;
      };
      settleRef.current = finishSettle;
      settleTimer = window.setTimeout(finishSettle, duration + 40);
    };
    const stop = (settle: boolean) => {
      if (!active) {
        if (!settle) restoreImmediately();
        return;
      }
      active = false;
      removeListeners();
      if (cleanupRef.current === cancelCurrent) cleanupRef.current = null;
      if (settle) settlePreview();
      else restoreImmediately();
    };
    const cancelCurrent = () => stop(false);
    const cancelOnLayoutChange = () => stop(true);
    const setNudge = (clientX: number, clientY: number) => {
      if (!canNudge || !card.isConnected) return;
      const deltaX = clientX - startEvent.clientX;
      const deltaY = clientY - startEvent.clientY;
      const distance = Math.hypot(deltaX, deltaY);
      if (!distance) {
        if (!previewStyles.active) return;
        card.style.setProperty("--widget-shake-x", "0px");
        card.style.setProperty("--widget-shake-y", "0px");
        return;
      }

      if (!previewStyles.active) {
        card.dataset.widgetShakePreview = "true";
        card.style.setProperty("--widget-shake-duration", `${transitionDuration(card)}ms`);
        card.style.translate = composedTranslate(previewStyles.baseTranslate);
        previewStyles.active = true;
      }
      const amount = 8 * (1 - Math.exp(-distance / 24));
      card.style.setProperty("--widget-shake-x", `${(deltaX / distance * amount).toFixed(2)}px`);
      card.style.setProperty("--widget-shake-y", `${(deltaY / distance * amount).toFixed(2)}px`);
    };
    const move = (nativeEvent: PointerEvent) => {
      if (nativeEvent.pointerId !== pointerId || !active) return;
      if (!(nativeEvent.buttons & 1) || nativeEvent.timeStamp - startedAt > 1200
        || !header.isConnected || !card.isConnected) {
        stop(true);
        return;
      }
      setNudge(nativeEvent.clientX, nativeEvent.clientY);
      const deltaX = nativeEvent.clientX - extremeX;
      const deltaY = nativeEvent.clientY - extremeY;
      const distance = Math.hypot(deltaX, deltaY);
      const hasDirection = directionX !== 0 || directionY !== 0;
      const projection = deltaX * directionX + deltaY * directionY;
      if (hasDirection && projection > 0) {
        extremeX = nativeEvent.clientX;
        extremeY = nativeEvent.clientY;
        return;
      }
      if (distance < 18 || hasDirection && projection / distance > -0.5) return;
      if (hasDirection) reversals += 1;
      directionX = deltaX / distance;
      directionY = deltaY / distance;
      extremeX = nativeEvent.clientX;
      extremeY = nativeEvent.clientY;
      if (reversals < 2) return;

      const preview = {
        originRect,
        visualRect: card.getBoundingClientRect(),
      };
      stop(false);
      activateRef.current?.(startEvent, nativeEvent, preview);
    };
    const end = (nativeEvent: Event) => {
      const pointerEvent = nativeEvent as Event & { pointerId?: number };
      if (typeof pointerEvent.pointerId !== "number" || pointerEvent.pointerId === pointerId) stop(true);
    };
    const keyDown = (nativeEvent: KeyboardEvent) => {
      if (nativeEvent.key === "Escape") stop(true);
    };

    event.preventDefault();
    cleanupRef.current = cancelCurrent;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", end);
    window.addEventListener("keydown", keyDown);
    window.addEventListener("resize", cancelOnLayoutChange);
    window.addEventListener("scroll", cancelOnLayoutChange, true);
    header.addEventListener("lostpointercapture", end);
    try {
      header.setPointerCapture?.(pointerId);
    } catch {
      stop(false);
    }
  };
}
