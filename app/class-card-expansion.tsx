"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import {
  createCourseExpansionProgressFrames,
  createCourseExpansionSettleFrames,
  COURSE_EXPANSION_CONTENT_DURATION_MS,
  COURSE_EXPANSION_CONTENT_FADE_IN_START_MS,
  COURSE_EXPANSION_CONTENT_FADE_OUT_END_MS,
  COURSE_EXPANSION_MOTION_DURATION_MS,
  COURSE_EXPANSION_MOTION_EASING,
  getCourseExpansionProgress,
  type CourseExpansionRect as WidgetMotionRect,
} from "../lib/course-expansion-motion";
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
const visualProperties = [
  "borderTopLeftRadius",
  "borderTopRightRadius",
  "borderBottomRightRadius",
  "borderBottomLeftRadius",
  "boxShadow",
] as const;
type VisualProperty = typeof visualProperties[number];
type VisualAppearance = Record<VisualProperty, string>;
type MorphStyle = Record<string, string>;
type MorphPair = {
  key: string;
  source: HTMLElement | SVGElement;
  target: HTMLElement | SVGElement;
  sourcePreview: HTMLElement | SVGElement | null;
  sourceStyles: MorphStyle[];
  targetStyles: MorphStyle[];
  sourcePreviewVisibility: SavedProperty | null;
  targetVisibility: SavedProperty;
  wrapper: HTMLDivElement | null;
  clone: HTMLElement | SVGElement | null;
  backgroundOverlay: HTMLDivElement | null;
  backgroundOverlayRole: "source" | "target" | null;
  backgroundOpacity: number | null;
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

function readVisualAppearance(element: HTMLElement): VisualAppearance {
  const style = window.getComputedStyle(element);
  return {
    borderTopLeftRadius: style.borderTopLeftRadius || "0px",
    borderTopRightRadius: style.borderTopRightRadius || "0px",
    borderBottomRightRadius: style.borderBottomRightRadius || "0px",
    borderBottomLeftRadius: style.borderBottomLeftRadius || "0px",
    boxShadow: style.boxShadow || "none",
  };
}

function applyVisualAppearance(element: HTMLElement, appearance: VisualAppearance) {
  for (const property of visualProperties) element.style[property] = appearance[property];
}

function morphNodes(element: HTMLElement | SVGElement): Array<HTMLElement | SVGElement> {
  return [element, ...Array.from(element.querySelectorAll<HTMLElement | SVGElement>("*"))
    .filter((node) => !node.hasAttribute("data-course-background-overlay"))];
}

function readMorphStyles(element: HTMLElement | SVGElement): MorphStyle[] {
  const nodes = morphNodes(element);
  return nodes.map((node) => {
    const computed = window.getComputedStyle(node);
    const values: MorphStyle = {};
    for (let index = 0; index < computed.length; index += 1) {
      const property = computed.item(index);
      if (property) values[property] = computed.getPropertyValue(property);
    }
    return values;
  });
}

function applyMorphStyles(element: HTMLElement | SVGElement, styles: MorphStyle[]) {
  const nodes = morphNodes(element);
  nodes.forEach((node, index) => {
    const values = styles[index] ?? {};
    for (const [property, value] of Object.entries(values)) node.style.setProperty(property, value);
  });
}

function removeCloneInteraction(element: HTMLElement | SVGElement) {
  for (const node of [element, ...Array.from(element.querySelectorAll<HTMLElement | SVGElement>("*"))]) {
    for (const attribute of Array.from(node.attributes)) {
      if (attribute.name === "id" || attribute.name === "role" || attribute.name === "tabindex"
        || attribute.name === "contenteditable" || attribute.name.startsWith("on")) node.removeAttribute(attribute.name);
    }
  }
}

function morphableStyles(from: MorphStyle, to: MorphStyle): MorphStyle {
  const properties = [
    "background-color", "background-image", "border-color", "border-radius", "color", "font-family",
    "font-size", "font-style", "font-weight", "letter-spacing", "line-height", "opacity", "padding-bottom",
    "padding-left", "padding-right", "padding-top", "text-align", "text-decoration-color", "text-shadow",
  ];
  return Object.fromEntries(properties.flatMap((property) => from[property] !== to[property] && to[property] !== undefined
    ? [[property, to[property]]]
    : []));
}

function interpolateMorphValue(from: string, to: string, progress: number): string {
  const lengthFrom = from.match(/^(-?[\d.]+)([a-z%]*)$/i);
  const lengthTo = to.match(/^(-?[\d.]+)([a-z%]*)$/i);
  if (lengthFrom && lengthTo && lengthFrom[2] === lengthTo[2]) {
    const value = Number(lengthFrom[1]) + (Number(lengthTo[1]) - Number(lengthFrom[1])) * progress;
    return `${Math.max(lengthTo[2] ? 0 : -Infinity, value)}${lengthTo[2]}`;
  }
  const colorPattern = /rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+))?\s*\)/i;
  const colorFrom = from.match(colorPattern);
  const colorTo = to.match(colorPattern);
  if (colorFrom && colorTo) {
    const channels = [1, 2, 3].map((index) => Math.round(Number(colorFrom[index]) + (Number(colorTo[index]) - Number(colorFrom[index])) * progress));
    const alphaFrom = Number(colorFrom[4] ?? 1);
    const alphaTo = Number(colorTo[4] ?? 1);
    const alpha = alphaFrom + (alphaTo - alphaFrom) * progress;
    return `rgba(${channels.join(", ")}, ${alpha})`;
  }
  return progress >= 1 ? to : from;
}

function morphStyleFrames(from: MorphStyle, to: MorphStyle, geometry: Keyframe[], clampToEndpoints = false): Keyframe[] {
  const properties = morphableStyles(from, to);
  return geometry.map((frame) => {
    const offset = Number(frame.offset ?? 0);
    const progress = getCourseExpansionProgress(offset);
    const boundedProgress = Math.min(1, Math.max(0, progress));
    const styleProgress = clampToEndpoints ? boundedProgress : progress;
    const values = Object.fromEntries(Object.keys(properties).map((property) => [
      property.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase()),
      interpolateMorphValue(from[property] ?? "", to[property], /(?:^|-)color$|^opacity$/.test(property) ? boundedProgress : styleProgress),
    ]));
    return { offset, ...values };
  });
}

function boundNameGeometryToEndpoints(frames: Keyframe[], from: WidgetMotionRect, to: WidgetMotionRect): Keyframe[] {
  return frames.map((frame) => {
    const offset = Number(frame.offset ?? 0);
    const progress = Math.min(1, Math.max(0, getCourseExpansionProgress(offset)));
    return {
      ...frame,
      width: `${Math.max(1, from.width + (to.width - from.width) * progress)}px`,
      height: `${Math.max(1, from.height + (to.height - from.height) * progress)}px`,
    };
  });
}

function isInsideClip(element: HTMLElement | SVGElement, boundary: HTMLElement): boolean {
  const rect = element.getBoundingClientRect();
  if (!hasArea(rect)) return false;
  for (let ancestor = element.parentElement; ancestor && ancestor !== boundary.parentElement; ancestor = ancestor.parentElement) {
    const style = window.getComputedStyle(ancestor);
    const ancestorRect = ancestor.getBoundingClientRect();
    if (/(hidden|clip|auto|scroll)/.test(`${style.overflowX} ${style.overflowY}`)
      && (rect.left < ancestorRect.left || rect.top < ancestorRect.top
        || rect.right > ancestorRect.right || rect.bottom > ancestorRect.bottom)) return false;
    if (ancestor === boundary) break;
  }
  return true;
}

function renderedTextLineCount(element: HTMLElement | SVGElement): number {
  const range = document.createRange();
  range.selectNodeContents(element);
  const lineRects = typeof range.getClientRects === "function" ? range.getClientRects() : null;
  if (lineRects?.length) {
    const lineTops: number[] = [];
    for (const rect of Array.from(lineRects)) {
      if (!Number.isFinite(rect.top) || lineTops.some((top) => Math.abs(top - rect.top) <= 1)) continue;
      lineTops.push(rect.top);
    }
    if (lineTops.length) return lineTops.length;
  }

  const height = element.getBoundingClientRect().height;
  const lineHeight = Number.parseFloat(window.getComputedStyle(element).lineHeight);
  return lineHeight > 0 && height > 0 ? Math.max(1, Math.round(height / lineHeight)) : 1;
}

function collectMorphPairs(source: HTMLElement, preview: HTMLElement, content: HTMLElement): MorphPair[] {
  const sourceNodes = new Map(Array.from(source.querySelectorAll<HTMLElement | SVGElement>("[data-course-morph]")).map((node) => [node.getAttribute("data-course-morph")!, node]));
  const previewNodes = new Map(Array.from(preview.querySelectorAll<HTMLElement | SVGElement>("[data-course-morph]")).map((node) => [node.getAttribute("data-course-morph")!, node]));
  const targetNodes = Array.from(content.querySelectorAll<HTMLElement | SVGElement>("[data-course-morph]"));
  return targetNodes.flatMap((target) => {
    const key = target.getAttribute("data-course-morph");
    const compact = key ? sourceNodes.get(key) : null;
    if (!key || !compact || (key !== "watermark" && !isInsideClip(target, content))) return [];
    if (key === "name" && renderedTextLineCount(target) > renderedTextLineCount(compact)) return [];
    const sourceText = compact.textContent?.trim() ?? "";
    const targetText = target.textContent?.trim() ?? "";
    if ((key === "instructor" && !sourceText) || (key !== "visual" && key !== "icon" && sourceText !== targetText)) return [];
    const sourceClone = previewNodes.get(key) ?? null;
    return [{
      key,
      source: compact,
      target,
      sourcePreview: sourceClone,
      sourceStyles: readMorphStyles(compact),
      targetStyles: readMorphStyles(target),
      sourcePreviewVisibility: sourceClone
        ? { value: sourceClone.style.getPropertyValue("visibility"), priority: sourceClone.style.getPropertyPriority("visibility") }
        : null,
      targetVisibility: { value: target.style.getPropertyValue("visibility"), priority: target.style.getPropertyPriority("visibility") },
      wrapper: null,
      clone: null,
      backgroundOverlay: null,
      backgroundOverlayRole: null,
      backgroundOpacity: null,
    }];
  });
}

function isGradientBackground(value: string | undefined): value is string {
  return !!value && /(?:repeating-)?(?:linear|radial|conic)-gradient\(/i.test(value);
}

function backgroundOverlayRole(direction: "opening" | "closing"): "source" | "target" {
  return direction === "opening" ? "target" : "source";
}

function createMorphWrapper(pair: MorphPair, direction: "opening" | "closing", layer: HTMLElement): HTMLDivElement {
  const node = direction === "opening" ? pair.source : pair.target;
  const styles = direction === "opening" ? pair.sourceStyles : pair.targetStyles;
  const clone = node.cloneNode(true) as HTMLElement | SVGElement;
  applyMorphStyles(clone, styles);
  removeCloneInteraction(clone);
  clone.setAttribute("aria-hidden", "true");
  clone.style.setProperty("position", "absolute");
  clone.style.setProperty("inset", "0");
  clone.style.setProperty("width", "100%");
  clone.style.setProperty("height", "100%");
  clone.style.setProperty("min-width", "0");
  clone.style.setProperty("min-height", "0");
  clone.style.setProperty("max-width", "none");
  clone.style.setProperty("max-height", "none");
  clone.style.setProperty("box-sizing", "border-box");
  clone.style.setProperty("margin", "0");
  clone.style.setProperty("transform-origin", "top left");
  if (pair.key === "name") {
    // Match the label's destination wrapping while the wrapper clips to its current bounds.
    const wrappingStyles = direction === "opening" ? pair.targetStyles : pair.sourceStyles;
    clone.style.setProperty("white-space", wrappingStyles[0]?.["white-space"] || "normal");
    clone.style.setProperty("overflow-wrap", wrappingStyles[0]?.["overflow-wrap"] || "anywhere");
    clone.style.setProperty("text-overflow", "clip");
  }
  if (pair.key === "visual") {
    clone.style.setProperty("overflow", "hidden");
    clone.style.setProperty("isolation", "isolate");
    for (const image of clone.querySelectorAll<HTMLImageElement>("img")) {
      image.style.setProperty("position", "absolute");
      image.style.setProperty("inset", "0");
      image.style.setProperty("width", "100%");
      image.style.setProperty("height", "100%");
      image.style.setProperty("object-fit", "cover");
      image.style.setProperty("z-index", "0");
    }
    pair.backgroundOverlay = null;
    pair.backgroundOverlayRole = null;
    pair.backgroundOpacity = null;
    const sourceBackground = pair.sourceStyles[0]?.["background-image"];
    const targetBackground = pair.targetStyles[0]?.["background-image"];
    if (sourceBackground !== targetBackground && isGradientBackground(sourceBackground) && isGradientBackground(targetBackground)) {
      const role = backgroundOverlayRole(direction);
      const overlay = document.createElement("div");
      overlay.dataset.courseBackgroundOverlay = "true";
      overlay.setAttribute("aria-hidden", "true");
      overlay.style.position = "absolute";
      overlay.style.inset = "0";
      overlay.style.zIndex = "-1";
      overlay.style.pointerEvents = "none";
      overlay.style.backgroundImage = role === "target" ? targetBackground : sourceBackground;
      overlay.style.opacity = "0";
      clone.appendChild(overlay);
      pair.backgroundOverlay = overlay;
      pair.backgroundOverlayRole = role;
      pair.backgroundOpacity = 0;
    }
  } else if (clone.namespaceURI === "http://www.w3.org/2000/svg") {
    clone.style.setProperty("display", "block");
  }
  const wrapper = document.createElement("div");
  wrapper.className = "class-card-expansion-morph";
  wrapper.dataset.courseMorph = pair.key;
  wrapper.setAttribute("aria-hidden", "true");
  wrapper.style.zIndex = ["visual"].includes(pair.key) ? "0" : "2";
  wrapper.appendChild(clone);
  layer.appendChild(wrapper);
  pair.wrapper = wrapper;
  pair.clone = clone;
  return wrapper;
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

function getSidebarRight(): number {
  const sidebar = document.querySelector<HTMLElement>(".sidebar");
  if (!sidebar) return 0;
  const style = window.getComputedStyle(sidebar);
  if (style.display === "none" || style.visibility === "hidden") return 0;
  const rect = sidebar.getBoundingClientRect();
  return hasArea(rect) && rect.right > 0 && rect.left < window.innerWidth
    && rect.bottom > 0 && rect.top < window.innerHeight ? rect.right : 0;
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
  const minLeft = getSidebarRight() + margin;
  const availableBottom = Math.min(viewportHeight, getMobileNavTop());
  const width = Math.max(1, Math.min(840, viewportWidth - minLeft - margin));
  const height = Math.max(1, Math.min(740, availableBottom - margin * 2));
  const maxLeft = Math.max(minLeft, viewportWidth - margin - width);
  const maxTop = Math.max(margin, availableBottom - margin - height);
  // Grow equally on both sides, staying between the sidebar and the viewport edge.
  const left = anchor
    ? Math.min(maxLeft, Math.max(minLeft, anchor.left + (anchor.width - width) / 2))
    : minLeft + (maxLeft - minLeft) / 2;
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
  staticRoot.style.boxShadow = "none";
  staticRoot.style.borderWidth = "0";
  staticRoot.style.borderRadius = "inherit";
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

const CONTENT_FADE_OUT_END = COURSE_EXPANSION_CONTENT_FADE_OUT_END_MS / COURSE_EXPANSION_CONTENT_DURATION_MS;
const CONTENT_FADE_IN_START = COURSE_EXPANSION_CONTENT_FADE_IN_START_MS / COURSE_EXPANSION_CONTENT_DURATION_MS;

function fadeOutFrames(fromOpacity: string): Keyframe[] {
  return [
    { offset: 0, opacity: fromOpacity, easing: "ease-out" },
    { offset: CONTENT_FADE_OUT_END, opacity: 0 },
    { offset: 1, opacity: 0 },
  ];
}

function fadeInFrames(fromOpacity: string): Keyframe[] {
  return [
    { offset: 0, opacity: fromOpacity },
    { offset: CONTENT_FADE_IN_START, opacity: fromOpacity, easing: "ease-out" },
    { offset: 1, opacity: 1 },
  ];
}

export default function ClassCardExpansion({ courseId, onClose, suspended, children }: Props) {
  const [visible, setVisible] = useState(true);
  const dialogRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const sharedRef = useRef<HTMLDivElement>(null);
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
    const shared = sharedRef.current;
    const content = contentRef.current;
    if (!dialog || !preview || !shared || !content) return;
    const expansionDialog = dialog;
    const previewLayer = preview;
    const detailContent = content;

    let released = false;
    let closing = false;
    let sourceSnapshot: SourceSnapshot | null = null;
    let bodyOverflow: SavedProperty | null = null;
    let shapeAnimation: Animation | null = null;
    const morphAnimations = new Set<Animation>();
    const imageHandoffCleanups = new Set<() => void>();
    let morphPairs: MorphPair[] = [];
    let openingMorphPending = false;
    let sidebarObserver: ResizeObserver | null = null;
    const sidebar = document.querySelector<HTMLElement>(".sidebar");
    let sidebarRight = getSidebarRight();
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
    const expandedAppearance = readVisualAppearance(expansionDialog);
    const sourceAppearance = source && anchor ? readVisualAppearance(source) : null;
    const canAnimate = !reducedMotion() && typeof expansionDialog.animate === "function";
    applyRect(expansionDialog, destination);
    applyVisualAppearance(expansionDialog, expandedAppearance);

    if (source) {
      sourceSnapshot = {
        element: source,
        visibility: { value: source.style.getPropertyValue("visibility"), priority: source.style.getPropertyPriority("visibility") },
        ariaHidden: readAttribute(source, "aria-hidden"),
        inert: readAttribute(source, "inert"),
      };
      const staticPreview = makeStaticPreview(source);
      previewLayer.appendChild(staticPreview);
      if (anchor && canAnimate) {
        morphPairs = collectMorphPairs(source, staticPreview, detailContent);
        for (const pair of morphPairs) {
          if (pair.sourcePreview) pair.sourcePreview.style.visibility = "hidden";
          pair.target.style.setProperty("visibility", "hidden");
          createMorphWrapper(pair, "opening", shared);
        }
        openingMorphPending = morphPairs.length > 0;
      }
      source.style.setProperty("visibility", "hidden");
      source.setAttribute("aria-hidden", "true");
      source.setAttribute("inert", "");
    }

    bodyOverflow = { value: document.body.style.getPropertyValue("overflow"), priority: document.body.style.getPropertyPriority("overflow") };
    document.body.style.setProperty("overflow", "hidden");
    previewLayer.hidden = !source || !anchor;

    const dialogBorder = () => {
      const style = window.getComputedStyle(expansionDialog);
      return {
        left: Number.parseFloat(style.borderLeftWidth) || 0,
        top: Number.parseFloat(style.borderTopWidth) || 0,
      };
    };

    const captureMorphRects = (): Map<MorphPair, WidgetMotionRect> => new Map(morphPairs.flatMap((pair) => {
      const wrapperRect = pair.wrapper?.getBoundingClientRect();
      const rect = wrapperRect && hasArea(wrapperRect) ? wrapperRect : pair.target.getBoundingClientRect();
      return rect && hasArea(rect) ? [[pair, rect]] : [];
    }));

    const captureMorphStyles = (): Map<MorphPair, MorphStyle[]> => new Map(morphPairs.flatMap((pair) => {
      if (pair.backgroundOverlay) {
        const opacity = Number.parseFloat(window.getComputedStyle(pair.backgroundOverlay).opacity);
        if (Number.isFinite(opacity)) pair.backgroundOpacity = opacity;
      }
      return pair.clone ? [[pair, readMorphStyles(pair.clone)]] : [];
    }));

    const applyMorphProperties = (element: HTMLElement | SVGElement, styles: MorphStyle[]) => {
      const nodes = morphNodes(element);
      const properties = ["background-color", "background-image", "border-color", "border-radius", "color", "font-family", "font-size", "font-style", "font-weight", "letter-spacing", "line-height", "opacity", "padding-bottom", "padding-left", "padding-right", "padding-top", "text-align", "text-decoration-color", "text-shadow"];
      nodes.forEach((node, index) => {
        for (const property of properties) {
          const value = styles[index]?.[property];
          if (value !== undefined) node.style.setProperty(property, value);
        }
      });
    };

    const cancelMorphAnimations = () => {
      for (const animation of morphAnimations) {
        animation.onfinish = null;
        animation.oncancel = null;
        animation.cancel();
      }
      morphAnimations.clear();
    };

    const preserveMorphState = (
      parentRect: WidgetMotionRect,
      rects: Map<MorphPair, WidgetMotionRect>,
      styles: Map<MorphPair, MorphStyle[]>,
    ) => {
      const border = dialogBorder();
      for (const pair of morphPairs) {
        const rect = rects.get(pair);
        if (rect && pair.wrapper) {
          pair.wrapper.style.left = `${rect.left - parentRect.left - border.left}px`;
          pair.wrapper.style.top = `${rect.top - parentRect.top - border.top}px`;
          pair.wrapper.style.width = `${rect.width}px`;
          pair.wrapper.style.height = `${rect.height}px`;
          pair.wrapper.style.transform = "none";
        }
        const style = styles.get(pair);
        if (style && pair.clone) applyMorphProperties(pair.clone, style);
        if (pair.backgroundOverlay && pair.backgroundOpacity !== null) {
          pair.backgroundOverlay.style.opacity = String(pair.backgroundOpacity);
        }
      }
    };

    const localRect = (rect: WidgetMotionRect, parent: WidgetMotionRect): WidgetMotionRect => {
      const border = dialogBorder();
      return { left: rect.left - parent.left - border.left, top: rect.top - parent.top - border.top, width: rect.width, height: rect.height };
    };

    const animateMorphs = (
      direction: "opening" | "closing",
      parentFrom: WidgetMotionRect,
      parentTo: WidgetMotionRect,
      liveRects?: Map<MorphPair, WidgetMotionRect>,
      liveStyles?: Map<MorphPair, MorphStyle[]>,
    ) => {
      if (!canAnimate || !morphPairs.length) return;
      const activePairs = direction === "closing"
        ? morphPairs.filter((pair) => pair.wrapper || pair.key === "watermark" || isInsideClip(pair.target, detailContent))
        : morphPairs;
      for (const pair of activePairs) {
        if (direction === "closing") {
          pair.target.style.setProperty("visibility", "hidden");
          pair.sourcePreview?.style.setProperty("visibility", "hidden");
        }
        const wrapper = pair.wrapper ?? createMorphWrapper(pair, direction, shared);
        const toNode = direction === "opening" ? pair.target : pair.source;
        const toRoot = direction === "opening" ? parentTo : source?.getBoundingClientRect() ?? parentTo;
        const toWorld = toNode.getBoundingClientRect();
        const toRect = localRect(toWorld, toRoot);
        const live = liveRects?.get(pair);
        const currentWorld = live ?? (direction === "opening" ? pair.source.getBoundingClientRect() : pair.target.getBoundingClientRect());
        const fromRect = live ? localRect(currentWorld, parentFrom) : localRect(currentWorld, direction === "opening" ? parentFrom : parentFrom);
        wrapper.style.left = `${toRect.left}px`;
        wrapper.style.top = `${toRect.top}px`;
        wrapper.style.width = `${toRect.width}px`;
        wrapper.style.height = `${toRect.height}px`;
        wrapper.style.transform = "none";
        const geometryFrames = createCourseExpansionSettleFrames(fromRect, toRect);
        const frames = pair.key === "name"
          ? boundNameGeometryToEndpoints(geometryFrames, fromRect, toRect)
          : geometryFrames;
        const wrapperAnimation = wrapper.animate(frames, {
          duration: COURSE_EXPANSION_MOTION_DURATION_MS,
          easing: COURSE_EXPANSION_MOTION_EASING,
          fill: "both",
        });
        morphAnimations.add(wrapperAnimation);
        wrapperAnimation.onfinish = () => {
          if (!morphAnimations.delete(wrapperAnimation)) return;
          wrapper.style.left = `${toRect.left}px`;
          wrapper.style.top = `${toRect.top}px`;
          wrapper.style.width = `${toRect.width}px`;
          wrapper.style.height = `${toRect.height}px`;
          wrapper.style.transform = "none";
          wrapperAnimation.onfinish = null;
          wrapperAnimation.oncancel = null;
          wrapperAnimation.cancel();
        };
        wrapperAnimation.oncancel = () => morphAnimations.delete(wrapperAnimation);

        const overlay = pair.backgroundOverlay;
        if (overlay) {
          const currentOpacity = pair.backgroundOpacity
            ?? Number.parseFloat(window.getComputedStyle(overlay).opacity)
            ?? 0;
          const targetRole = direction === "opening" ? "target" : "source";
          const targetOpacity = pair.backgroundOverlayRole === targetRole ? 1 : 0;
          const fromOpacity = Number.isFinite(currentOpacity) ? currentOpacity : 0;
          overlay.style.opacity = String(fromOpacity);
          const frames = createCourseExpansionProgressFrames().map(({ offset, progress }) => ({
            offset,
            opacity: String(fromOpacity + (targetOpacity - fromOpacity) * Math.min(1, Math.max(0, progress))),
          }));
          const animation = overlay.animate(frames, {
            duration: COURSE_EXPANSION_MOTION_DURATION_MS,
            easing: COURSE_EXPANSION_MOTION_EASING,
            fill: "both",
          });
          morphAnimations.add(animation);
          animation.onfinish = () => {
            if (!morphAnimations.delete(animation)) return;
            overlay.style.opacity = String(targetOpacity);
            pair.backgroundOpacity = targetOpacity;
            animation.onfinish = null;
            animation.oncancel = null;
            animation.cancel();
          };
          animation.oncancel = () => morphAnimations.delete(animation);
        }

        const clone = pair.clone;
        if (clone) {
          const fromStyle = liveStyles?.get(pair) ?? (direction === "opening" ? pair.sourceStyles : pair.targetStyles);
          const toStyle = direction === "opening" ? pair.targetStyles : pair.sourceStyles;
          const animatedNodes = morphNodes(clone);
          animatedNodes.forEach((node, index) => {
            const fromNodeStyle = { ...(fromStyle[index] ?? {}) };
            const toNodeStyle = { ...(toStyle[index] ?? {}) };
            if (pair.backgroundOverlay && index === 0) {
              delete fromNodeStyle["background-image"];
              delete toNodeStyle["background-image"];
            }
            if (!Object.keys(morphableStyles(fromNodeStyle, toNodeStyle)).length || typeof node.animate !== "function") return;
            const animation = node.animate(morphStyleFrames(fromNodeStyle, toNodeStyle, frames, pair.key === "name"), {
              duration: COURSE_EXPANSION_MOTION_DURATION_MS,
              easing: COURSE_EXPANSION_MOTION_EASING,
              fill: "both",
            });
            morphAnimations.add(animation);
            animation.onfinish = () => {
              if (!morphAnimations.delete(animation)) return;
              const properties = ["background-color", "background-image", "border-color", "border-radius", "color", "font-family", "font-size", "font-style", "font-weight", "letter-spacing", "line-height", "opacity", "padding-bottom", "padding-left", "padding-right", "padding-top", "text-align", "text-decoration-color", "text-shadow"];
              for (const property of properties) {
                if (pair.backgroundOverlay && index === 0 && property === "background-image") continue;
                const value = toStyle[index]?.[property];
                if (value !== undefined) node.style.setProperty(property, value);
              }
              animation.onfinish = null;
              animation.oncancel = null;
              animation.cancel();
            };
            animation.oncancel = () => morphAnimations.delete(animation);
          });
        }
      }
    };

    const restorePreviewMorphs = () => {
      for (const pair of morphPairs) {
        if (pair.sourcePreview && pair.sourcePreviewVisibility) restoreStyleProperty(pair.sourcePreview as HTMLElement, "visibility", pair.sourcePreviewVisibility);
      }
    };

    const retainImageUntilReady = (pair: MorphPair): boolean => {
      const sourceImage = pair.source.querySelector("img");
      if (pair.key !== "visual" || !pair.wrapper || !sourceImage?.complete || !sourceImage.naturalWidth) return false;
      const retainedSourceImage = sourceImage;
      const sourceImageSrc = retainedSourceImage.src;
      const wrapper = pair.wrapper;
      wrapper.style.left = "0px";
      wrapper.style.top = "0px";
      wrapper.style.width = "100%";
      wrapper.style.transform = "none";
      const syncHeight = () => {
        wrapper.style.left = "0px";
        wrapper.style.top = "0px";
        wrapper.style.width = "100%";
        wrapper.style.height = `${pair.target.getBoundingClientRect().height}px`;
        wrapper.style.transform = "none";
      };
      syncHeight();
      let watchedImage: HTMLImageElement | null = null;
      let decodingSrc = "";
      let disposed = false;
      const mutationObserver = new window.MutationObserver(checkImage);
      const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(syncHeight);
      function cleanup() {
        disposed = true;
        mutationObserver.disconnect();
        resizeObserver?.disconnect();
        window.removeEventListener("resize", syncHeight);
        watchedImage?.removeEventListener("load", checkImage);
        watchedImage?.removeEventListener("error", checkImage);
        imageHandoffCleanups.delete(cleanup);
      }
      function reveal(image: HTMLImageElement, src: string) {
        if (disposed || released || closing || pair.target.querySelector("img") !== image || image.src !== src) return;
        cleanup();
        restoreStyleProperty(pair.target as HTMLElement, "visibility", pair.targetVisibility);
        wrapper.remove();
        pair.wrapper = null;
        pair.clone = null;
      }
      function releaseRemovedSourceImage() {
        if (disposed || released || closing) return;
        cleanup();
        restoreStyleProperty(pair.target as HTMLElement, "visibility", pair.targetVisibility);
        wrapper.remove();
        pair.wrapper = null;
        pair.clone = null;
      }
      function checkImage() {
        if (disposed || released || closing) return;
        if (!retainedSourceImage.isConnected || pair.source.querySelector("img") !== retainedSourceImage || retainedSourceImage.src !== sourceImageSrc) {
          releaseRemovedSourceImage();
          return;
        }
        const image = pair.target.querySelector("img");
        if (image !== watchedImage) {
          watchedImage?.removeEventListener("load", checkImage);
          watchedImage?.removeEventListener("error", checkImage);
          watchedImage = image;
          decodingSrc = "";
          image?.addEventListener("load", checkImage);
          image?.addEventListener("error", checkImage);
        }
        if (!image?.complete || !image.naturalWidth || decodingSrc === image.src) return;
        const src = image.src;
        decodingSrc = src;
        if (typeof image.decode === "function") void image.decode().then(() => reveal(image, src), () => reveal(image, src));
        else reveal(image, src);
      }
      imageHandoffCleanups.add(cleanup);
      mutationObserver.observe(pair.target, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
      mutationObserver.observe(pair.source, { childList: true, subtree: true, attributes: true, attributeFilter: ["src"] });
      resizeObserver?.observe(pair.target);
      window.addEventListener("resize", syncHeight);
      checkImage();
      return true;
    };

    const finishOpeningMorph = () => {
      if (!openingMorphPending) return;
      openingMorphPending = false;
      cancelMorphAnimations();
      for (const pair of morphPairs) {
        if (pair.backgroundOverlay && pair.backgroundOverlayRole === "target") {
          pair.backgroundOverlay.style.opacity = "1";
          pair.backgroundOpacity = 1;
        }
        if (retainImageUntilReady(pair)) continue;
        restoreStyleProperty(pair.target as HTMLElement, "visibility", pair.targetVisibility);
        pair.wrapper?.remove();
        pair.wrapper = null;
        pair.clone = null;
      }
      if (previewLayer.hidden) restorePreviewMorphs();
    };

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

    const animateShape = (
      from: WidgetMotionRect,
      to: WidgetMotionRect,
      onFinish?: () => void,
      fromAppearance?: VisualAppearance,
      toAppearance: VisualAppearance = expandedAppearance,
    ) => {
      const liveAppearance = fromAppearance ?? readVisualAppearance(expansionDialog);
      cancelShape();
      applyRect(expansionDialog, to);
      applyVisualAppearance(expansionDialog, toAppearance);
      if (!canAnimate || typeof expansionDialog.animate !== "function") {
        onFinish?.();
        return;
      }
      const frames = createCourseExpansionSettleFrames(from, to);
      Object.assign(frames[0], liveAppearance);
      Object.assign(frames.at(-1)!, toAppearance);
      const animation = expansionDialog.animate(frames, {
        duration: COURSE_EXPANSION_MOTION_DURATION_MS,
        easing: COURSE_EXPANSION_MOTION_EASING,
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
        duration: COURSE_EXPANSION_CONTENT_DURATION_MS,
        easing: "linear",
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
      detailContent.style.opacity = "0";
      detailContent.style.filter = "none";
      if (!previewLayer.hidden) {
        previewLayer.style.opacity = "1";
        previewLayer.style.filter = "none";
        animateContent(previewLayer, fadeOutFrames("1"), () => {
          previewLayer.hidden = true;
          previewLayer.style.opacity = "1";
          previewLayer.style.filter = "none";
          restorePreviewMorphs();
        });
      }
      animateContent(detailContent, fadeInFrames("0"), () => {
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
      for (const cleanup of [...imageHandoffCleanups]) cleanup();
      cancelShape();
      cancelMorphAnimations();
      cancelContent();
      window.removeEventListener("resize", handleResize);
      sidebarObserver?.disconnect();
      sidebar?.removeEventListener("transitionend", handleSidebarReflow);
      restoreSource();
      for (const pair of morphPairs) {
        restoreStyleProperty(pair.target as HTMLElement, "visibility", pair.targetVisibility);
        pair.wrapper?.remove();
      }
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
      for (const cleanup of [...imageHandoffCleanups]) cleanup();
      const from = expansionDialog.getBoundingClientRect();
      const to = currentReturnRect();
      if (!to || !canAnimate || typeof expansionDialog.animate !== "function") {
        finishClose();
        return;
      }
      const detailStyle = window.getComputedStyle(detailContent);
      const detailOpacity = detailStyle.opacity;
      const previewStyle = window.getComputedStyle(previewLayer);
      const previewOpacity = previewLayer.hidden ? "0" : previewStyle.opacity;
      const sourceAppearance = sourceRef.current?.isConnected
        ? readVisualAppearance(sourceRef.current)
        : expandedAppearance;
      if (!openingMorphPending) {
        restorePreviewMorphs();
      }
      const liveMorphRects = captureMorphRects();
      const liveMorphStyles = captureMorphStyles();
      preserveMorphState(from, liveMorphRects, liveMorphStyles);
      cancelMorphAnimations();
      cancelContent();
      expansionDialog.dataset.closing = "true";
      previewLayer.hidden = !sourceRef.current;
      previewLayer.style.opacity = previewOpacity;
      previewLayer.style.filter = "none";
      detailContent.style.opacity = detailOpacity;
      detailContent.style.filter = "none";
      if (!previewLayer.hidden) {
        animateContent(previewLayer, fadeInFrames(previewOpacity), () => {
          previewLayer.style.opacity = "1";
          previewLayer.style.filter = "none";
        });
      }
      animateContent(detailContent, fadeOutFrames(detailOpacity), () => {
        detailContent.style.opacity = "0";
        detailContent.style.filter = "none";
      });
      animateMorphs("closing", from, to, liveMorphRects, liveMorphStyles);
      animateShape(from, to, finishClose, undefined, sourceAppearance);
    }

    function currentExpansionRect(): WidgetMotionRect {
      const anchorElement = sourceRef.current ?? triggerRef.current;
      const anchorRect = anchorElement?.isConnected ? anchorElement.getBoundingClientRect() : null;
      return getExpansionRect(anchorRect && isVisibleAnchor(anchorRect) ? anchorRect : null);
    }

    function handleSidebarReflow() {
      if (released || closing) return;
      const nextRight = getSidebarRight();
      if (nextRight === sidebarRight) return;
      sidebarRight = nextRight;
      // Follow the sidebar transition directly so the dialog cannot lag behind its edge.
      const nextRect = currentExpansionRect();
      cancelShape();
      applyRect(expansionDialog, nextRect);
      applyVisualAppearance(expansionDialog, expandedAppearance);
      finishOpeningMorph();
    }

    function handleResize() {
      if (released) return;
      sidebarRight = getSidebarRight();
      const from = expansionDialog.getBoundingClientRect();
      if (closing) {
        const to = currentReturnRect();
        if (!to || !canAnimate) {
          finishClose();
          return;
        }
        const sourceAppearance = sourceRef.current?.isConnected
          ? readVisualAppearance(sourceRef.current)
          : expandedAppearance;
        const liveMorphRects = captureMorphRects();
        const liveMorphStyles = captureMorphStyles();
        preserveMorphState(from, liveMorphRects, liveMorphStyles);
        cancelMorphAnimations();
        animateMorphs("closing", from, to, liveMorphRects, liveMorphStyles);
        animateShape(from, to, finishClose, undefined, sourceAppearance);
        return;
      }
      const to = currentExpansionRect();
      const liveAppearance = readVisualAppearance(expansionDialog);
      const liveMorphRects = captureMorphRects();
      const liveMorphStyles = captureMorphStyles();
      preserveMorphState(from, liveMorphRects, liveMorphStyles);
      cancelMorphAnimations();
      if (!canAnimate) {
        cancelShape();
        applyRect(expansionDialog, to);
        applyVisualAppearance(expansionDialog, expandedAppearance);
        finishOpeningMorph();
        return;
      }
      cancelShape();
      applyRect(expansionDialog, to);
      applyVisualAppearance(expansionDialog, expandedAppearance);
      if (openingMorphPending) animateMorphs("opening", from, to, liveMorphRects, liveMorphStyles);
      animateShape(from, to, openingMorphPending ? finishOpeningMorph : undefined, liveAppearance);
    }

    closeRef.current = requestClose;
    window.addEventListener("resize", handleResize);
    if (sidebar) {
      sidebar.addEventListener("transitionend", handleSidebarReflow);
      if (typeof ResizeObserver !== "undefined") {
        sidebarObserver = new ResizeObserver(handleSidebarReflow);
        sidebarObserver.observe(sidebar);
      }
    }
    if (canAnimate && anchor) {
      if (source && sourceRect && openingMorphPending) animateMorphs("opening", sourceRect, destination);
      animateShape(startRect, destination, openingMorphPending ? finishOpeningMorph : undefined, sourceAppearance ?? undefined);
    } else {
      applyRect(expansionDialog, destination);
      applyVisualAppearance(expansionDialog, expandedAppearance);
    }
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
      <div ref={sharedRef} className="class-card-expansion-shared-layer" aria-hidden="true" inert />
      <div ref={contentRef} className="class-card-expansion-content"><ExpansionContent render={children} close={close} /></div>
    </div>
  </div>;
}
