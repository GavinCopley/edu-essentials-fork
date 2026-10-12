"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { getWidgetResizeContentFilter } from "../lib/widget-resize";
import {
  createWidgetResizeSettleFrames,
  WIDGET_RESIZE_CONTENT_REVEAL_DURATION_MS,
  WIDGET_RESIZE_SETTLE_DURATION_MS,
  WIDGET_RESIZE_SETTLE_EASING,
  type WidgetMotionRect,
} from "../lib/widget-resize-motion";
import "./class-card-expansion.css";

type Props = {
  courseId: string;
  onClose: () => void;
  suspended: boolean;
  children: (close: () => void) => ReactNode;
};

function ExpansionContent({ render, close }: { render: Props["children"]; close: () => void }) {
  return <>{render(close)}</>;
}

type SavedProperty = { value: string; priority: string };
type SavedAttribute = { present: boolean; value: string };
type SourceSnapshot = {
  element: HTMLElement;
  visibility: SavedProperty;
  ariaHidden: SavedAttribute;
  inert: SavedAttribute;
};

const focusableSelector = "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])";

function reducedMotion() {
  return document.documentElement.dataset.motion === "reduced"
    || (typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

function readAttribute(element: Element, name: string): SavedAttribute {
  return { present: element.hasAttribute(name), value: element.getAttribute(name) ?? "" };
}

function restoreAttribute(element: Element, name: string, saved: SavedAttribute) {
  if (saved.present) element.setAttribute(name, saved.value);
  else element.removeAttribute(name);
}

function restoreStyleProperty(element: HTMLElement, name: string, saved: SavedProperty) {
  if (saved.value) element.style.setProperty(name, saved.value, saved.priority);
  else element.style.removeProperty(name);
}

function applyRect(element: HTMLElement, rect: WidgetMotionRect) {
  element.style.left = `${rect.left}px`;
  element.style.top = `${rect.top}px`;
  element.style.width = `${rect.width}px`;
  element.style.height = `${rect.height}px`;
}

function hasArea(rect: WidgetMotionRect): boolean {
  return Number.isFinite(rect.left) && Number.isFinite(rect.top)
    && Number.isFinite(rect.width) && Number.isFinite(rect.height)
    && rect.width > 0 && rect.height > 0;
}

function getMobileNavTop(): number {
  const nav = document.querySelector<HTMLElement>(".mobile-bottom-nav");
  if (!nav || window.getComputedStyle(nav).display === "none") return window.innerHeight;
  const rect = nav.getBoundingClientRect();
  return rect.height > 0 && rect.top < window.innerHeight && rect.bottom > 0 ? rect.top : window.innerHeight;
}

function isVisibleAnchor(rect: WidgetMotionRect): boolean {
  const navTop = getMobileNavTop();
  return hasArea(rect) && rect.left < window.innerWidth && rect.left + rect.width > 0
    && rect.top < navTop && rect.top + rect.height > 0;
}

function getExpansionRect(anchor: WidgetMotionRect | null): WidgetMotionRect {
  const viewportWidth = Math.max(1, window.innerWidth);
  const viewportHeight = Math.max(1, window.innerHeight);
  const margin = viewportWidth <= 600 ? 12 : 18;
  const availableBottom = Math.min(viewportHeight, getMobileNavTop());
  const width = Math.max(1, Math.min(840, viewportWidth - margin * 2));
  const height = Math.max(1, Math.min(740, availableBottom - margin * 2));
  const maxLeft = Math.max(margin, viewportWidth - margin - width);
  const maxTop = Math.max(margin, availableBottom - margin - height);
  const left = anchor
    ? Math.min(maxLeft, Math.max(margin, anchor.left))
    : (viewportWidth - width) / 2;
  const top = anchor
    ? Math.min(maxTop, Math.max(margin, anchor.top + anchor.height - height))
    : margin + (maxTop - margin) / 2;
  return { left, top, width, height };
}

function makeStaticPreview(source: HTMLElement): HTMLElement {
  const clone = source.cloneNode(true) as HTMLElement;
  const makeStatic = (element: HTMLElement, root: boolean) => {
    const tag = element.tagName.toLowerCase();
    const interactive = root || ["button", "a", "input", "select", "textarea", "option"].includes(tag);
    let result = element;
    if (interactive) {
      const replacement = document.createElement(root || tag === "button" ? "div" : "span");
      for (const attribute of Array.from(element.attributes)) {
        if (attribute.name === "class" || attribute.name === "style" || attribute.name.startsWith("data-")) {
          if (attribute.name !== "data-course-card-id") replacement.setAttribute(attribute.name, attribute.value);
        }
      }
      while (element.firstChild) replacement.appendChild(element.firstChild);
      element.replaceWith(replacement);
      result = replacement;
    }
    for (const attribute of Array.from(result.attributes)) {
      if (attribute.name === "id" || attribute.name === "role" || attribute.name === "tabindex"
        || attribute.name === "contenteditable" || attribute.name.startsWith("aria-") || attribute.name.startsWith("on")) result.removeAttribute(attribute.name);
    }
    result.removeAttribute("data-course-card-id");
    return result;
  };

  const staticRoot = makeStatic(clone, true);
  for (const element of Array.from(staticRoot.querySelectorAll<HTMLElement>("button, a, input, select, textarea, option, [tabindex], [contenteditable='true']"))) {
    if (element.isConnected || element.parentElement) makeStatic(element, false);
  }
  for (const element of [staticRoot, ...Array.from(staticRoot.querySelectorAll<HTMLElement>("*"))]) {
    for (const attribute of Array.from(element.attributes)) {
      if (attribute.name === "id" || attribute.name === "role" || attribute.name === "tabindex"
        || attribute.name === "contenteditable" || attribute.name.startsWith("aria-") || attribute.name.startsWith("on")) element.removeAttribute(attribute.name);
    }
    element.removeAttribute("data-course-card-id");
  }
  staticRoot.setAttribute("aria-hidden", "true");
  staticRoot.setAttribute("inert", "");
  staticRoot.style.width = "100%";
  staticRoot.style.height = "100%";
  staticRoot.style.maxWidth = "none";
  staticRoot.style.maxHeight = "none";
  staticRoot.style.boxSizing = "border-box";
  staticRoot.style.pointerEvents = "none";
  staticRoot.style.transition = "none";
  staticRoot.style.animation = "none";
  staticRoot.style.transform = "none";
  return staticRoot;
}

function getFocusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector)).filter((element) =>
    !element.closest("[hidden], [inert], [aria-hidden='true']")
      && window.getComputedStyle(element).visibility !== "hidden"
      && window.getComputedStyle(element).display !== "none",
  );
}

function focusDialog(dialog: HTMLElement) {
  const focusable = getFocusableElements(dialog);
  const closeControl = focusable.find((element) => {
    const label = `${element.getAttribute("aria-label") ?? ""} ${element.textContent ?? ""}`;
    return /\bclose\b/i.test(label);
  });
  (closeControl ?? focusable[0] ?? dialog).focus({ preventScroll: true });
}

function findActiveNestedDialog(parent: HTMLElement): HTMLElement | null {
  return Array.from(document.querySelectorAll<HTMLElement>("[role='dialog'][aria-modal='true']"))
    .filter((candidate) => candidate !== parent
      && !candidate.closest("[hidden], [inert], [aria-hidden='true']")
      && window.getComputedStyle(candidate).visibility !== "hidden"
      && window.getComputedStyle(candidate).display !== "none")
    .at(-1) ?? null;
}

export default function ClassCardExpansion({ courseId, onClose, suspended, children }: Props) {
  const [visible, setVisible] = useState(true);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const sourceRef = useRef<HTMLElement | null>(null);
  const closeRef = useRef<() => void>(() => {});
  const suspendedFocusRef = useRef<HTMLElement | null>(null);
  const nestedDialogRef = useRef<HTMLElement | null>(null);
  const wasSuspendedRef = useRef(suspended);
  const onCloseRef = useRef(onClose);

  useLayoutEffect(() => {
    onCloseRef.current = onClose;
  }, [onClose]);

  const close = useCallback(() => closeRef.current(), []);

  useLayoutEffect(() => {
    if (!visible) return;
    const dialog = dialogRef.current;
    const preview = previewRef.current;
    const content = contentRef.current;
    if (!dialog || !preview || !content) return;
    const expansionDialog = dialog;
    const previewLayer = preview;
    const detailContent = content;

    let released = false;
    let closing = false;
    let sourceSnapshot: SourceSnapshot | null = null;
    let bodyOverflow: SavedProperty | null = null;
    let shapeAnimation: Animation | null = null;
    const contentAnimations = new Set<Animation>();
    const source = Array.from(document.querySelectorAll<HTMLElement>("[data-course-card-id]"))
      .find((candidate) => candidate.getAttribute("data-course-card-id") === courseId) ?? null;
    const active = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const trigger = source ?? (active && active !== document.body ? active : null);
    sourceRef.current = source;
    triggerRef.current = trigger;
    const sourceRect = source?.getBoundingClientRect() ?? null;
    const triggerRect = trigger?.getBoundingClientRect() ?? null;
    const anchor = source
      ? sourceRect && isVisibleAnchor(sourceRect) ? sourceRect : null
      : triggerRect && isVisibleAnchor(triggerRect) ? triggerRect : null;
    const destination = getExpansionRect(anchor);
    const startRect = anchor ?? destination;

    if (source) {
      sourceSnapshot = {
        element: source,
        visibility: { value: source.style.getPropertyValue("visibility"), priority: source.style.getPropertyPriority("visibility") },
        ariaHidden: readAttribute(source, "aria-hidden"),
        inert: readAttribute(source, "inert"),
      };
      previewLayer.appendChild(makeStaticPreview(source));
      source.style.setProperty("visibility", "hidden");
      source.setAttribute("aria-hidden", "true");
      source.setAttribute("inert", "");
    }

    bodyOverflow = { value: document.body.style.getPropertyValue("overflow"), priority: document.body.style.getPropertyPriority("overflow") };
    document.body.style.setProperty("overflow", "hidden");
    applyRect(expansionDialog, destination);
    previewLayer.hidden = !source || !anchor;
    const canAnimate = !reducedMotion() && typeof expansionDialog.animate === "function";

    const cancelShape = () => {
      const animation = shapeAnimation;
      shapeAnimation = null;
      if (!animation) return;
      animation.onfinish = null;
      animation.oncancel = null;
      animation.cancel();
    };

    const cancelContent = () => {
      for (const animation of contentAnimations) {
        animation.onfinish = null;
        animation.oncancel = null;
        animation.cancel();
      }
      contentAnimations.clear();
    };

    const animateShape = (from: WidgetMotionRect, to: WidgetMotionRect, onFinish?: () => void) => {
      cancelShape();
      applyRect(expansionDialog, to);
      if (!canAnimate || typeof expansionDialog.animate !== "function") {
        onFinish?.();
        return;
      }
      const animation = expansionDialog.animate(createWidgetResizeSettleFrames(from, to, 9), {
        duration: WIDGET_RESIZE_SETTLE_DURATION_MS,
        easing: WIDGET_RESIZE_SETTLE_EASING,
        fill: "both",
      });
      shapeAnimation = animation;
      animation.onfinish = () => {
        if (shapeAnimation !== animation) return;
        shapeAnimation = null;
        animation.onfinish = null;
        animation.oncancel = null;
        animation.cancel();
        onFinish?.();
      };
      animation.oncancel = () => {
        if (shapeAnimation === animation) shapeAnimation = null;
      };
    };

    const animateContent = (element: HTMLElement, frames: Keyframe[], onFinish: () => void) => {
      if (typeof element.animate !== "function") {
        onFinish();
        return;
      }
      const animation = element.animate(frames, {
        duration: WIDGET_RESIZE_CONTENT_REVEAL_DURATION_MS,
        easing: "ease-out",
        fill: "both",
      });
      contentAnimations.add(animation);
      const finish = () => {
        if (!contentAnimations.delete(animation)) return;
        animation.onfinish = null;
        animation.oncancel = null;
        animation.cancel();
        onFinish();
      };
      animation.onfinish = finish;
      animation.oncancel = () => contentAnimations.delete(animation);
    };

    const revealContent = () => {
      const clearVisualStyles = () => {
        previewLayer.hidden = true;
        previewLayer.style.opacity = "1";
        previewLayer.style.filter = "none";
        detailContent.style.opacity = "1";
        detailContent.style.filter = "none";
      };
      if (!canAnimate || !anchor) {
        clearVisualStyles();
        return;
      }
      const clearFilter = getWidgetResizeContentFilter(0);
      const blurFilter = getWidgetResizeContentFilter(8);
      detailContent.style.opacity = "0";
      detailContent.style.filter = blurFilter;
      if (!previewLayer.hidden) {
        previewLayer.style.opacity = "1";
        previewLayer.style.filter = clearFilter;
        animateContent(previewLayer, [
          { opacity: 1, filter: clearFilter },
          { opacity: 0, filter: blurFilter },
        ], () => {
          previewLayer.hidden = true;
          previewLayer.style.opacity = "1";
          previewLayer.style.filter = "none";
        });
      }
      animateContent(detailContent, [
        { opacity: 0, filter: blurFilter },
        { opacity: 1, filter: clearFilter },
      ], () => {
        detailContent.style.opacity = "1";
        detailContent.style.filter = "none";
      });
    };

    const currentReturnRect = (): WidgetMotionRect | null => {
      const element = sourceRef.current ?? triggerRef.current;
      if (!element?.isConnected) return null;
      const rect = element.getBoundingClientRect();
      return isVisibleAnchor(rect) ? rect : null;
    };

    const restoreSource = () => {
      if (!sourceSnapshot) return;
      restoreStyleProperty(sourceSnapshot.element, "visibility", sourceSnapshot.visibility);
      restoreAttribute(sourceSnapshot.element, "aria-hidden", sourceSnapshot.ariaHidden);
      restoreAttribute(sourceSnapshot.element, "inert", sourceSnapshot.inert);
      sourceSnapshot = null;
    };

    const restoreBody = () => {
      if (!bodyOverflow) return;
      restoreStyleProperty(document.body, "overflow", bodyOverflow);
      bodyOverflow = null;
    };

    const restoreFocusIfAppropriate = () => {
      const target = triggerRef.current;
      if (!target?.isConnected) return;
      const current = document.activeElement;
      const wasInside = current === document.body || current === expansionDialog || expansionDialog.contains(current);
      if (!wasInside) return;
      const restoreFocus = (): boolean => {
        if (!target.isConnected) return true;
        const activeElement = document.activeElement;
        const triggerDialog = target.closest<HTMLElement>("[role='dialog']");
        const otherDialogs = Array.from(document.querySelectorAll<HTMLElement>("[role='dialog']"))
          .filter((candidate) => candidate !== expansionDialog && candidate !== triggerDialog
            && !candidate.closest("[hidden], [inert], [aria-hidden='true']")
            && window.getComputedStyle(candidate).visibility !== "hidden"
            && window.getComputedStyle(candidate).display !== "none");
        if (otherDialogs.length) return true;
        if (activeElement && activeElement !== document.body && activeElement !== target && !expansionDialog.contains(activeElement)) return true;
        const targetStyle = window.getComputedStyle(target);
        if (target.closest("[hidden], [inert], [aria-hidden='true']")
          || target.matches(":disabled") || targetStyle.visibility === "hidden" || targetStyle.display === "none") return false;
        target.focus({ preventScroll: true });
        return document.activeElement === target;
      };
      restoreFocus();
      let focusRetries = 0;
      const restoreAfterDetach = () => {
        if (expansionDialog.isConnected || !restoreFocus()) {
          if (focusRetries >= 40) return;
          focusRetries += 1;
          window.setTimeout(restoreAfterDetach, 16);
        }
      };
      window.setTimeout(restoreAfterDetach, 0);
    };

    function release() {
      if (released) return;
      released = true;
      cancelShape();
      cancelContent();
      window.removeEventListener("resize", handleResize);
      restoreSource();
      restoreBody();
      restoreFocusIfAppropriate();
      previewLayer.replaceChildren();
      if (closeRef.current === requestClose) closeRef.current = () => {};
    }

    function finishClose() {
      expansionDialog.style.visibility = "hidden";
      release();
      setVisible(false);
      onCloseRef.current();
    }

    function requestClose() {
      if (released || closing) return;
      closing = true;
      const from = expansionDialog.getBoundingClientRect();
      const to = currentReturnRect();
      if (!to || !canAnimate || typeof expansionDialog.animate !== "function") {
        finishClose();
        return;
      }
      const detailStyle = window.getComputedStyle(detailContent);
      const detailOpacity = detailStyle.opacity;
      const detailFilter = detailStyle.filter;
      const previewStyle = window.getComputedStyle(previewLayer);
      const previewOpacity = previewLayer.hidden ? "0" : previewStyle.opacity;
      const previewFilter = previewLayer.hidden ? getWidgetResizeContentFilter(8) : previewStyle.filter;
      cancelShape();
      cancelContent();
      previewLayer.hidden = !sourceRef.current;
      previewLayer.style.opacity = previewOpacity;
      previewLayer.style.filter = previewFilter;
      detailContent.style.opacity = detailOpacity;
      detailContent.style.filter = detailFilter;
      const blurFilter = getWidgetResizeContentFilter(8);
      const clearFilter = getWidgetResizeContentFilter(0);
      if (!previewLayer.hidden) {
        animateContent(previewLayer, [
          { opacity: previewOpacity, filter: previewFilter },
          { opacity: 1, filter: clearFilter },
        ], () => {
          previewLayer.style.opacity = "1";
          previewLayer.style.filter = "none";
        });
      }
      animateContent(detailContent, [
        { opacity: detailOpacity, filter: detailFilter },
        { opacity: 0, filter: blurFilter },
      ], () => {
        detailContent.style.opacity = "0";
        detailContent.style.filter = blurFilter;
      });
      animateShape(from, to, finishClose);
    }

    function handleResize() {
      if (released) return;
      const from = expansionDialog.getBoundingClientRect();
      if (closing) {
        const to = currentReturnRect();
        if (!to || !canAnimate) {
          finishClose();
          return;
        }
        animateShape(from, to, finishClose);
        return;
      }
      const anchorElement = sourceRef.current ?? triggerRef.current;
      const anchorRect = anchorElement?.isConnected ? anchorElement.getBoundingClientRect() : null;
      const nextAnchor = anchorRect && isVisibleAnchor(anchorRect) ? anchorRect : null;
      const to = getExpansionRect(nextAnchor);
      if (!canAnimate) {
        cancelShape();
        applyRect(expansionDialog, to);
        return;
      }
      animateShape(from, to);
    }

    closeRef.current = requestClose;
    window.addEventListener("resize", handleResize);
    if (canAnimate && anchor) animateShape(startRect, destination);
    else applyRect(expansionDialog, destination);
    revealContent();
    return release;
  }, [courseId, visible]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!visible || !dialog) {
      wasSuspendedRef.current = suspended;
      return;
    }
    if (suspended) {
      const active = document.activeElement;
      if (active instanceof HTMLElement && dialog.contains(active)) suspendedFocusRef.current = active;
    } else if (wasSuspendedRef.current) {
      const remembered = suspendedFocusRef.current;
      if (remembered?.isConnected && dialog.contains(remembered)) remembered.focus({ preventScroll: true });
      else focusDialog(dialog);
      suspendedFocusRef.current = null;
    } else focusDialog(dialog);
    wasSuspendedRef.current = suspended;
  }, [suspended, visible]);

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!visible || !suspended || !dialog) {
      nestedDialogRef.current = null;
      return;
    }
    const focusNestedDialog = () => {
      const nested = findActiveNestedDialog(dialog);
      nestedDialogRef.current = nested;
      if (nested && !nested.contains(document.activeElement)) focusDialog(nested);
    };
    focusNestedDialog();
    const observer = typeof window.MutationObserver === "undefined" ? null : new window.MutationObserver(focusNestedDialog);
    observer?.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["aria-modal", "aria-hidden", "hidden", "inert"] });
    return () => {
      observer?.disconnect();
      nestedDialogRef.current = null;
    };
  }, [suspended, visible]);

  useEffect(() => {
    if (!visible) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (suspended) return;
        event.preventDefault();
        event.stopPropagation();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab") return;
      const focusTrap = suspended ? nestedDialogRef.current : dialog;
      if (!focusTrap?.isConnected) return;
      const focusable = getFocusableElements(focusTrap);
      if (!focusable.length) {
        event.preventDefault();
        focusTrap.focus({ preventScroll: true });
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !focusTrap.contains(document.activeElement))) {
        event.preventDefault();
        last.focus({ preventScroll: true });
      } else if (!event.shiftKey && (document.activeElement === last || !focusTrap.contains(document.activeElement))) {
        event.preventDefault();
        first.focus({ preventScroll: true });
      }
    };
    document.addEventListener("keydown", handleKeyDown, true);
    return () => document.removeEventListener("keydown", handleKeyDown, true);
  }, [suspended, visible]);

  if (!visible || typeof document === "undefined") return null;
  return <div
    className="class-card-expansion-backdrop"
    data-suspended={suspended ? "true" : undefined}
  >
    <button
      className="class-card-expansion-dismiss"
      type="button"
      aria-hidden="true"
      tabIndex={-1}
      disabled={suspended}
      onClick={(event) => {
        if (event.target === event.currentTarget && !suspended) close();
      }}
    />
    <div ref={dialogRef} className="class-card-expansion-dialog" role="dialog" aria-modal={suspended ? undefined : "true"} aria-label="Class details" tabIndex={-1} inert={suspended}>
      <div ref={previewRef} className="class-card-expansion-preview" aria-hidden="true" inert hidden />
      <div ref={contentRef} className="class-card-expansion-content"><ExpansionContent render={children} close={close} /></div>
    </div>
  </div>;
}
