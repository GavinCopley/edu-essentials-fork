"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type ReactNode, type RefObject } from "react";
import { flushSync } from "react-dom";
import type { WidgetInstance } from "../lib/workspace-codec";
import { calculateWidgetUnit } from "./animated-widget-grid";
import AnimatedWidgetGrid from "./animated-widget-grid";
import { getWidgetInsertionCandidate, reorderWidgetIds } from "../lib/widget-reorder";
import { stepWidgetDragMotion, type WidgetDragMotion } from "../lib/widget-drag-motion";
import { useWidgetShake, type WidgetShakePreviewBounds } from "./use-widget-shake";
import { useWidgetResize } from "./use-widget-resize";
import { useWidgetDoubleTap } from "./use-widget-double-tap";
import type { WidgetResizePriority, WidgetSize } from "../lib/widget-layout";

type Props = {
  items: readonly WidgetInstance[];
  workspaceId: string;
  label: string;
  layoutKey: string;
  reflowKey?: string;
  enabled: boolean;
  style?: CSSProperties;
  addTile: ReactNode;
  renderWidget: (widget: WidgetInstance, index: number, isDragged: boolean, isResizing: boolean) => ReactNode;
  onReorder: (ids: string[], miniBlockChange?: { widgetId: string; startsNewMiniBlock: boolean }) => boolean;
  onReorderStart?: () => void;
  onCustomize?: () => void;
  onFinishCustomize?: () => void;
  onResize?: (widgetId: string, size: WidgetSize, priority?: WidgetResizePriority) => boolean;
  resizePriorities?: readonly WidgetResizePriority[];
  removeTargetRef?: RefObject<HTMLElement | null>;
  removeTargetHitRef?: RefObject<HTMLElement | null>;
  removeTargetNearEnabled?: boolean;
  onRemove?: (widgetId: string) => boolean;
  onRemoveDragStateChange?: (active: boolean, over: boolean, near: boolean) => void;
};

type DragPhase = "pending" | "active" | "settling";

type DragSession = {
  pointerId: number;
  captureTarget: HTMLElement;
  source: HTMLElement;
  draggedId: string;
  workspaceId: string;
  layoutKey: string;
  itemDataKey: string;
  originIds: string[];
  currentOrder: string[];
  expectedOrder: string[] | null;
  sizes: Record<string, string>;
  miniStarts: Record<string, boolean>;
  currentMiniStart: boolean;
  expectedItemDataKey: string | null;
  phase: DragPhase;
  valid: boolean;
  previewIndex: number | null;
  startX: number;
  startY: number;
  latestX: number;
  latestY: number;
  projectionDirty: boolean;
  grabOffsetX: number;
  grabOffsetY: number;
  previewBounds: WidgetShakePreviewBounds | null;
  overlay: HTMLDivElement | null;
  overlayCard: HTMLElement | null;
  frame: number | null;
  followerEnabled: boolean;
  follower: WidgetDragMotion | null;
  followerTime: number | null;
  listeners: {
    pointerMove: (event: PointerEvent) => void;
    pointerUp: (event: PointerEvent) => void;
    pointerCancel: (event: PointerEvent) => void;
    lostCapture: (event: PointerEvent) => void;
    blur: () => void;
    keyDown: (event: KeyboardEvent) => void;
    resize: () => void;
    scroll: () => void;
  } | null;
  animations: Set<Animation>;
  handoffAnimations: Set<Animation>;
  handoffCardAnimation: Animation | null;
  removeTargetActive: boolean;
  removeTargetOver: boolean;
  removeTargetNear: boolean;
  removeTargetMotionUntil: number;
};

function sameIds(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((id, index) => id === right[index]);
}

function sameIdSet(left: readonly string[], right: readonly string[]) {
  return left.length === right.length && left.every((id) => right.includes(id));
}

function freezeWidgetShakeHandoff(session: DragSession) {
  const overlay = session.overlay;
  const card = session.overlayCard;
  if (overlay && session.handoffAnimations.size) {
    const rect = overlay.getBoundingClientRect();
    overlay.style.left = `${rect.left}px`;
    overlay.style.top = `${rect.top}px`;
  }

  const cardTransform = card && session.handoffCardAnimation
    ? window.getComputedStyle(card).transform
    : null;
  for (const animation of session.handoffAnimations) {
    animation.onfinish = null;
    animation.oncancel = null;
    animation.cancel();
    session.animations.delete(animation);
  }
  session.handoffAnimations.clear();
  session.handoffCardAnimation = null;
  if (card && cardTransform) {
    card.style.transform = cardTransform;
    card.classList.remove("widget-reorder-shake-lift");
  }
}

function copyLiveFormState(source: HTMLElement, clone: HTMLElement) {
  const sourceNodes = [source, ...source.querySelectorAll<HTMLElement>("*")];
  const cloneNodes = [clone, ...clone.querySelectorAll<HTMLElement>("*")];

  sourceNodes.forEach((sourceNode, index) => {
    const cloneNode = cloneNodes[index];
    if (!cloneNode) return;
    cloneNode.removeAttribute("id");
    cloneNode.removeAttribute("data-widget-id");
    cloneNode.removeAttribute("data-widget-reorder-handle");
    cloneNode.removeAttribute("data-widget-shake-preview");
    cloneNode.style.removeProperty("--widget-shake-x");
    cloneNode.style.removeProperty("--widget-shake-y");
    cloneNode.style.removeProperty("--widget-shake-duration");

    if (sourceNode instanceof HTMLInputElement && cloneNode instanceof HTMLInputElement) {
      cloneNode.value = sourceNode.value;
      cloneNode.checked = sourceNode.checked;
    } else if (sourceNode instanceof HTMLTextAreaElement && cloneNode instanceof HTMLTextAreaElement) {
      cloneNode.value = sourceNode.value;
      cloneNode.scrollTop = sourceNode.scrollTop;
      cloneNode.scrollLeft = sourceNode.scrollLeft;
    } else if (sourceNode instanceof HTMLSelectElement && cloneNode instanceof HTMLSelectElement) {
      cloneNode.selectedIndex = sourceNode.selectedIndex;
    }
    cloneNode.scrollTop = sourceNode.scrollTop;
    cloneNode.scrollLeft = sourceNode.scrollLeft;
  });
}

function prefersReducedMotion() {
  return document.documentElement.dataset.motion === "reduced"
    || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function itemDataKey(items: readonly WidgetInstance[]) {
  return JSON.stringify(items.map((item) => [item.instanceId, JSON.stringify(item)] as const).sort(([left], [right]) => left.localeCompare(right)));
}

export default function ReorderableWidgetGrid({
  items,
  workspaceId,
  label,
  layoutKey,
  reflowKey,
  enabled,
  style,
  addTile,
  renderWidget,
  onReorder,
  onReorderStart,
  onCustomize,
  onFinishCustomize,
  onResize,
  resizePriorities,
  removeTargetRef,
  removeTargetHitRef,
  removeTargetNearEnabled,
  onRemove,
  onRemoveDragStateChange,
}: Props) {
  const [previewOrder, setPreviewOrder] = useState<string[] | null>(null);
  const [previewMiniStart, setPreviewMiniStart] = useState<boolean | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [isReorderSettling, setIsReorderSettling] = useState(false);
  const [invalidDrop, setInvalidDrop] = useState(false);
  const [settleTick, setSettleTick] = useState(0);
  const host = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<DragSession | null>(null);
  const boardScrollOffsets = useRef(new Map<HTMLElement, { top: number; left: number }>());
  const fadingOverlays = useRef(new Map<HTMLDivElement, Animation>());
  const processPointerRef = useRef<(session: DragSession, timestamp: number) => void>(() => undefined);
  const latestProps = useRef({ workspaceId, layoutKey, enabled, items, onReorder, onReorderStart, removeTargetRef, removeTargetHitRef, removeTargetNearEnabled, onRemove, onRemoveDragStateChange });

  const ids = items.map((item) => item.instanceId);
  const itemData = itemDataKey(items);
  const currentOrder = previewOrder && sameIdSet(previewOrder, ids) ? previewOrder : ids;
  const itemsById = new Map(items.map((item) => [item.instanceId, item]));

  useLayoutEffect(() => {
    latestProps.current = { workspaceId, layoutKey, enabled, items, onReorder, onReorderStart, removeTargetRef, removeTargetHitRef, removeTargetNearEnabled, onRemove, onRemoveDragStateChange };
  }, [enabled, items, layoutKey, onReorder, onReorderStart, onRemove, onRemoveDragStateChange, removeTargetHitRef, removeTargetNearEnabled, removeTargetRef, workspaceId]);

  const updateRemoveTargetState = useCallback((session: DragSession, active: boolean, over: boolean, near = active ? session.removeTargetNear : false) => {
    if (session.removeTargetActive === active && session.removeTargetOver === over && session.removeTargetNear === near) return;
    if (!active) session.removeTargetMotionUntil = 0;
    else if (latestProps.current.removeTargetNearEnabled && (session.removeTargetActive !== active || session.removeTargetNear !== near)) {
      // Keep hover aligned with the visual surface while the dock bounces.
      session.removeTargetMotionUntil = window.performance.now() + 450;
    }
    session.removeTargetActive = active;
    session.removeTargetOver = over;
    session.removeTargetNear = near;
    session.overlay?.classList.toggle("is-removal-hover", over);
    latestProps.current.onRemoveDragStateChange?.(active, over, near);
  }, []);

  const updateRemoveTargetNear = useCallback((session: DragSession) => {
    const current = latestProps.current;
    const target = current.enabled && current.removeTargetNearEnabled ? current.removeTargetRef?.current : null;
    const targetRect = target?.isConnected ? target.getBoundingClientRect() : null;
    const overlayRect = session.overlay?.isConnected ? session.overlay.getBoundingClientRect() : null;
    const expansion = 72;
    const near = Boolean(targetRect && overlayRect && targetRect.width > 0 && targetRect.height > 0
      && overlayRect.right >= targetRect.left - expansion
      && overlayRect.left <= targetRect.right + expansion
      && overlayRect.bottom >= targetRect.top - expansion
      && overlayRect.top <= targetRect.bottom + expansion);
    updateRemoveTargetState(session, session.phase === "active", session.removeTargetOver, near);
  }, [updateRemoveTargetState]);

  const restoreBoardScroll = useCallback((clear: boolean) => {
    // Browsers may reset nested scroll positions when a keyed card moves in
    // the DOM. Preserve the viewport through preview, drop, and cancellation.
    for (const [node, offset] of boardScrollOffsets.current) {
      if (node.isConnected) {
        node.scrollTop = offset.top;
        node.scrollLeft = offset.left;
      }
    }
    if (clear) boardScrollOffsets.current.clear();
  }, []);

  useLayoutEffect(() => restoreBoardScroll(!sessionRef.current));

  const removeOverlay = useCallback((session: DragSession) => {
    for (const animation of session.animations) animation.cancel();
    session.animations.clear();
    session.handoffAnimations.clear();
    session.handoffCardAnimation = null;
    session.overlay?.remove();
    session.overlay = null;
    session.overlayCard = null;
  }, []);

  const removePointerListeners = useCallback((session: DragSession) => {
    const listeners = session.listeners;
    if (!listeners) return;
    document.removeEventListener("pointermove", listeners.pointerMove, true);
    document.removeEventListener("pointerup", listeners.pointerUp, true);
    document.removeEventListener("pointercancel", listeners.pointerCancel, true);
    window.removeEventListener("blur", listeners.blur);
    window.removeEventListener("keydown", listeners.keyDown, true);
    window.removeEventListener("resize", listeners.resize);
    window.removeEventListener("scroll", listeners.scroll, true);
    session.captureTarget.removeEventListener("lostpointercapture", listeners.lostCapture);
    try {
      if (session.captureTarget.hasPointerCapture(session.pointerId)) session.captureTarget.releasePointerCapture(session.pointerId);
    } catch { /* The browser may already have released capture. */ }
    session.listeners = null;
  }, []);

  const cancelSession = useCallback((session: DragSession, fadeOverlay: boolean) => {
    if (sessionRef.current !== session) return;
    if (fadeOverlay) freezeWidgetShakeHandoff(session);
    sessionRef.current = null;
    updateRemoveTargetState(session, false, false);
    removePointerListeners(session);
    if (session.frame !== null) window.cancelAnimationFrame(session.frame);
    session.frame = null;
    if (session.phase === "pending") restoreBoardScroll(true);
    setPreviewOrder(null);
    setPreviewMiniStart(null);
    setInvalidDrop(false);
    setDraggedId(null);

    const configuredDuration = session.overlayCard
      ? Number.parseFloat(window.getComputedStyle(session.overlayCard).getPropertyValue("--wa-transition-ms"))
      : Number.NaN;
    if (fadeOverlay && session.overlay && configuredDuration !== 0 && !prefersReducedMotion() && typeof session.overlay.animate === "function") {
      for (const animation of session.animations) animation.cancel();
      session.animations.clear();
      session.handoffAnimations.clear();
      session.handoffCardAnimation = null;
      const overlay = session.overlay;
      session.overlay = null;
      session.overlayCard = null;
      const animation = overlay.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 120, easing: "ease-out" });
      fadingOverlays.current.set(overlay, animation);
      const removeFadedOverlay = () => {
        if (fadingOverlays.current.get(overlay) !== animation) return;
        fadingOverlays.current.delete(overlay);
        overlay.remove();
      };
      animation.onfinish = animation.oncancel = removeFadedOverlay;
      return;
    }

    removeOverlay(session);
  }, [removeOverlay, removePointerListeners, restoreBoardScroll, updateRemoveTargetState]);

  const { preview: resizePreview, beginResize, cancelResize } = useWidgetResize({
    host,
    items,
    enabled,
    contextKey: `${workspaceId}:${layoutKey}:${JSON.stringify(resizePriorities ?? [])}`,
    onResize,
    onResizeStart: () => {
      const session = sessionRef.current;
      if (session) cancelSession(session, false);
      onReorderStart?.();
    },
  });
  const trackWidgetDoubleTap = useWidgetDoubleTap({
    host,
    enabled: enabled && Boolean(onFinishCustomize),
    contextKey: `${workspaceId}:${layoutKey}:${itemData}`,
    onDoubleTap: onFinishCustomize,
    isBusy: () => Boolean(sessionRef.current && sessionRef.current.phase !== "pending") || Boolean(resizePreview),
  });
  const orderedItems = currentOrder.map((id) => itemsById.get(id)).filter((item): item is WidgetInstance => Boolean(item)).map((item) => {
    if (item.instanceId === resizePreview?.widgetId) {
      const next = { ...item, size: resizePreview.size };
      if (next.size !== "mini") delete next.startsNewMiniBlock;
      return next;
    }
    return item.instanceId === draggedId && item.size === "mini" && previewMiniStart !== null
      ? { ...item, startsNewMiniBlock: previewMiniStart || undefined } : item;
  });
  const activeResizePriorities = draggedId && !isReorderSettling ? undefined : resizePreview?.priority
    ? [...(resizePriorities ?? []).filter((priority) => priority.columns !== resizePreview.priority!.columns), resizePreview.priority]
    : resizePriorities;
  const gridLayoutKey = `${layoutKey}:${orderedItems.map((item) => `${item.instanceId}:${item.size}:${Boolean(item.startsNewMiniBlock)}`).join(",")}:${JSON.stringify(activeResizePriorities ?? [])}`;

  const positionOverlay = useCallback((session: DragSession, timestamp: number) => {
    if (!session.overlay) return false;
    const targetLeft = session.latestX - session.grabOffsetX;
    const targetTop = session.latestY - session.grabOffsetY;
    if (!session.followerEnabled || !session.follower) {
      session.overlay.style.left = `${targetLeft}px`;
      session.overlay.style.top = `${targetTop}px`;
      return false;
    }

    if (session.followerTime === null) {
      session.followerTime = timestamp;
    } else {
      const elapsedSeconds = Math.max(0, (timestamp - session.followerTime) / 1000);
      session.followerTime = timestamp;
      session.follower = stepWidgetDragMotion(session.follower, targetLeft, targetTop, elapsedSeconds);
    }

    session.overlay.style.left = `${session.follower.left}px`;
    session.overlay.style.top = `${session.follower.top}px`;
    return !session.follower.settled;
  }, []);

  const updateProjection = useCallback((session: DragSession) => {
    const removeTarget = latestProps.current.enabled ? (latestProps.current.removeTargetHitRef ?? latestProps.current.removeTargetRef)?.current : null;
    const removeTargetRect = removeTarget?.isConnected ? removeTarget.getBoundingClientRect() : null;
    const overRemoveTarget = Boolean(removeTargetRect && removeTargetRect.width > 0 && removeTargetRect.height > 0
      && session.latestX >= removeTargetRect.left
      && session.latestX <= removeTargetRect.right
      && session.latestY >= removeTargetRect.top
      && session.latestY <= removeTargetRect.bottom);
    if (overRemoveTarget) {
      updateRemoveTargetState(session, true, true);
      session.valid = true;
      session.previewIndex = null;
      session.currentOrder = session.originIds;
      session.currentMiniStart = session.miniStarts[session.draggedId];
      setPreviewOrder(null);
      setPreviewMiniStart(null);
      setInvalidDrop(false);
      return;
    }
    updateRemoveTargetState(session, true, false);

    const wrapper = host.current;
    const grid = wrapper?.querySelector<HTMLElement>(".widget-grid");
    if (!grid || session.phase !== "active") return;

    const rect = grid.getBoundingClientRect();
    const gridStyle = window.getComputedStyle(grid);
    const configuredColumns = Number.parseInt(gridStyle.getPropertyValue("--widget-columns"), 10);
    const columns: 2 | 4 = configuredColumns === 2 || configuredColumns === 4
      ? configuredColumns
      : window.innerWidth <= 600 ? 2 : 4;
    const parsedGap = Number.parseFloat(gridStyle.columnGap);
    const gap = Number.isFinite(parsedGap) ? parsedGap : 16;
    const parsedUnit = Number.parseFloat(gridStyle.getPropertyValue("--widget-unit"));
    const unit = parsedUnit > 0 ? parsedUnit : calculateWidgetUnit({ gridWidth: rect.width, gap, columns });
    const insertion = getWidgetInsertionCandidate({
      ids: session.originIds,
      sizes: session.sizes,
      miniStarts: session.miniStarts,
      draggedId: session.draggedId,
      columns,
      gridRect: rect,
      unit,
      gap,
      pointerX: session.latestX,
      pointerY: session.latestY,
      grabOffsetX: session.grabOffsetX,
      grabOffsetY: session.grabOffsetY,
      previousIndex: session.previewIndex,
      previousStartsNewMiniBlock: session.currentMiniStart,
    });

    if (insertion === null) {
      session.valid = false;
      session.previewIndex = null;
      session.currentOrder = session.originIds;
      setPreviewOrder(null);
      setPreviewMiniStart(null);
      setInvalidDrop(true);
      return;
    }

    session.valid = true;
    session.previewIndex = insertion.index;
    session.currentMiniStart = insertion.startsNewMiniBlock;
    const candidate = reorderWidgetIds(session.originIds, session.draggedId, insertion.index);
    session.currentOrder = candidate;
    setInvalidDrop(false);
    setPreviewOrder((previous) => sameIds(previous ?? session.originIds, candidate) ? previous : candidate);
    setPreviewMiniStart(insertion.startsNewMiniBlock);
  }, [updateRemoveTargetState]);

  const processPointer = useCallback((session: DragSession, timestamp = window.performance.now()) => {
    if (session.phase !== "active") return;
    const edge = 54;
    const viewportHeight = window.innerHeight;
    const nearEdge = session.latestY < edge || session.latestY > viewportHeight - edge;
    if (session.latestY < edge) {
      window.scrollBy(0, -Math.ceil(Math.min(22, (edge - session.latestY) * 0.28)));
    } else if (session.latestY > viewportHeight - edge) {
      window.scrollBy(0, Math.ceil(Math.min(22, (session.latestY - (viewportHeight - edge)) * 0.28)));
    }
    const followerUnsettled = positionOverlay(session, timestamp);
    const removeTargetMoving = timestamp < session.removeTargetMotionUntil;
    if (session.projectionDirty || nearEdge || removeTargetMoving) {
      session.projectionDirty = false;
      updateProjection(session);
    }
    updateRemoveTargetNear(session);
    if ((nearEdge || followerUnsettled || timestamp < session.removeTargetMotionUntil) && session.frame === null) {
      session.frame = window.requestAnimationFrame((nextTimestamp) => {
        session.frame = null;
        if (sessionRef.current === session && session.phase === "active") processPointerRef.current(session, nextTimestamp);
      });
    }
  }, [positionOverlay, updateProjection, updateRemoveTargetNear]);

  useLayoutEffect(() => {
    processPointerRef.current = processPointer;
  }, [processPointer]);

  const schedulePointer = useCallback((session: DragSession) => {
    if (session.frame !== null) return;
    session.frame = window.requestAnimationFrame((timestamp) => {
      session.frame = null;
      processPointer(session, timestamp);
    });
  }, [processPointer]);

  const activateSession = useCallback((session: DragSession) => {
    const appShell = session.source.closest<HTMLElement>(".app-shell.reference-ui")
      ?? document.querySelector<HTMLElement>(".app-shell.reference-ui");
    if (!appShell) {
      cancelSession(session, false);
      return;
    }

    const rect = session.previewBounds?.visualRect ?? session.source.getBoundingClientRect();
    const desiredLeft = session.latestX - session.grabOffsetX;
    const desiredTop = session.latestY - session.grabOffsetY;
    const board = host.current?.querySelector<HTMLElement>(".widget-grid");
    for (const node of board?.querySelectorAll<HTMLElement>("*") ?? []) {
      // Moving any keyed card can reset its nested viewport, including cards
      // displaced by this drag. Keep the original offsets across a redrag.
      if (!boardScrollOffsets.current.has(node) && (node.scrollTop || node.scrollLeft)) {
        boardScrollOffsets.current.set(node, { top: node.scrollTop, left: node.scrollLeft });
      }
    }
    const overlay = document.createElement("div");
    overlay.className = "widget-reorder-overlay";
    overlay.setAttribute("aria-hidden", "true");
    overlay.setAttribute("inert", "");
    overlay.style.left = `${session.previewBounds ? desiredLeft : rect.left}px`;
    overlay.style.top = `${session.previewBounds ? desiredTop : rect.top}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    overlay.style.opacity = "1";

    const clone = session.source.cloneNode(true) as HTMLElement;
    clone.classList.remove("dragging", "widget-reorder-placeholder");
    clone.classList.add("widget-reorder-lift");
    clone.removeAttribute("data-widget-shake-preview");
    clone.style.removeProperty("--widget-shake-x");
    clone.style.removeProperty("--widget-shake-y");
    clone.style.removeProperty("--widget-shake-duration");
    const reduced = prefersReducedMotion();
    clone.querySelectorAll(".widget-menu").forEach((menu) => menu.remove());
    clone.style.gridColumn = "auto";
    clone.style.gridRow = "auto";
    clone.style.width = "100%";
    clone.style.height = "100%";
    clone.style.maxHeight = "none";
    clone.style.transformOrigin = `${session.grabOffsetX}px ${session.grabOffsetY}px`;
    if (session.previewBounds) {
      // The captured visual bounds already include the source card's translate
      // and transform, so the overlay clone starts with a clean effect stack.
      clone.style.removeProperty("translate");
      clone.style.removeProperty("transform");
    }
    copyLiveFormState(session.source, clone);
    overlay.appendChild(clone);
    appShell.appendChild(overlay);
    // Scroll setters clamp to zero on detached nodes. Restore offsets once the
    // clone has its actual sized CSS box, including nested frames and textareas.
    copyLiveFormState(session.source, clone);

    session.overlay = overlay;
    session.overlayCard = clone;
    session.phase = "active";
    const configuredDuration = Number.parseFloat(window.getComputedStyle(clone).getPropertyValue("--wa-transition-ms"));
    const handoffDuration = Number.isFinite(configuredDuration) ? Math.max(0, Math.min(180, configuredDuration)) : 180;
    session.followerEnabled = Boolean(!reduced && handoffDuration > 0
      && typeof overlay.animate === "function" && typeof clone.animate === "function");
    if (session.previewBounds && session.followerEnabled) clone.classList.add("widget-reorder-shake-lift");
    session.follower = {
      left: desiredLeft,
      top: desiredTop,
      velocityX: 0,
      velocityY: 0,
      settled: true,
    };
    session.followerTime = null;
    session.projectionDirty = true;
    updateRemoveTargetState(session, true, false);
    setIsReorderSettling(false);
    positionOverlay(session, window.performance.now());
    if (session.previewBounds && session.followerEnabled) {
      const trackHandoffAnimation = (animation: Animation, onFinish?: () => void) => {
        session.animations.add(animation);
        session.handoffAnimations.add(animation);
        const removeAnimation = () => {
          session.animations.delete(animation);
          session.handoffAnimations.delete(animation);
          if (session.handoffCardAnimation === animation) session.handoffCardAnimation = null;
        };
        animation.onfinish = () => {
          onFinish?.();
          removeAnimation();
          animation.onfinish = null;
          animation.oncancel = null;
          animation.cancel();
        };
        animation.oncancel = removeAnimation;
      };
      const offsetX = rect.left - desiredLeft;
      const offsetY = rect.top - desiredTop;
      if (offsetX || offsetY) {
        const positionAnimation = overlay.animate([
          { transform: `translate3d(${offsetX}px, ${offsetY}px, 0)` },
          { transform: "translate3d(0, 0, 0)" },
        ], { duration: handoffDuration, easing: "ease-out", fill: "both" });
        trackHandoffAnimation(positionAnimation);
      }
      const scaleAnimation = clone.animate([
        { transform: "scale(1)" },
        { transform: "scale(1.025)" },
      ], { duration: handoffDuration, easing: "ease-out", fill: "forwards" });
      session.handoffCardAnimation = scaleAnimation;
      trackHandoffAnimation(scaleAnimation, () => clone.classList.remove("widget-reorder-shake-lift"));
    }
    setDraggedId(session.draggedId);
    setPreviewMiniStart(session.currentMiniStart);
    latestProps.current.onReorderStart?.();
  }, [cancelSession, positionOverlay, updateRemoveTargetState]);

  const animateDrop = useCallback((session: DragSession) => {
    if (sessionRef.current !== session || session.phase !== "settling") return;
    freezeWidgetShakeHandoff(session);
    const grid = host.current?.querySelector<HTMLElement>(".widget-grid");
    const target = [...(grid?.querySelectorAll<HTMLElement>("[data-widget-id]") ?? [])]
      .find((card) => card.dataset.widgetId === session.draggedId);
    const gridRect = grid?.getBoundingClientRect();
    const destination = target && grid && gridRect ? {
      left: gridRect.left + target.offsetLeft - grid.clientLeft,
      top: gridRect.top + target.offsetTop - grid.clientTop,
      width: target.offsetWidth,
      height: target.offsetHeight,
    } : null;
    const overlay = session.overlay;
    const card = session.overlayCard;
    const reduced = prefersReducedMotion();

    if (!overlay || !destination?.width || !destination.height || reduced || typeof overlay.animate !== "function") {
      removeOverlay(session);
      sessionRef.current = null;
      setDraggedId(null);
      setPreviewOrder(null);
      setPreviewMiniStart(null);
      setInvalidDrop(false);
      return;
    }

    const configuredDuration = card
      ? Number.parseFloat(window.getComputedStyle(card).getPropertyValue("--wa-transition-ms"))
      : Number.NaN;
    const duration = Number.isFinite(configuredDuration) ? Math.max(0, Math.min(240, configuredDuration)) : 210;
    if (duration === 0) {
      removeOverlay(session);
      sessionRef.current = null;
      setDraggedId(null);
      setPreviewOrder(null);
      setPreviewMiniStart(null);
      setInvalidDrop(false);
      return;
    }
    const positionAnimation = overlay.animate([
      { transform: "translate3d(0, 0, 0) scale(1, 1)" },
      {
        transform: `translate3d(${destination.left - Number.parseFloat(overlay.style.left)}px, ${destination.top - Number.parseFloat(overlay.style.top)}px, 0) scale(${destination.width / Number.parseFloat(overlay.style.width)}, ${destination.height / Number.parseFloat(overlay.style.height)})`,
      },
    ], { duration, easing: "cubic-bezier(0.22, 1, 0.36, 1)", fill: "forwards" });
    session.animations.add(positionAnimation);
    positionAnimation.onfinish = positionAnimation.oncancel = () => session.animations.delete(positionAnimation);
    if (card && typeof card.animate === "function") {
      const currentTransform = window.getComputedStyle(card).transform;
      const settleAnimation = card.animate([
        { transform: currentTransform },
        { transform: "scale(1)" },
      ], { duration, easing: "cubic-bezier(0.22, 1, 0.36, 1)" });
      session.animations.add(settleAnimation);
      settleAnimation.onfinish = settleAnimation.oncancel = () => session.animations.delete(settleAnimation);
    }

    void positionAnimation.finished.catch(() => undefined).then(() => {
      if (sessionRef.current !== session) return;
      removeOverlay(session);
      sessionRef.current = null;
      setDraggedId(null);
      setPreviewOrder(null);
      setPreviewMiniStart(null);
      setInvalidDrop(false);
    });
  }, [removeOverlay]);

  useLayoutEffect(() => {
    const session = sessionRef.current;
    if (session?.phase === "settling") animateDrop(session);
  }, [animateDrop, settleTick]);

  const beginSession = useCallback((
    event: Pick<PointerEvent, "target" | "button" | "isPrimary" | "pointerId" | "clientX" | "clientY">,
    activePointer?: PointerEvent,
    previewBounds?: WidgetShakePreviewBounds,
  ) => {
    if (!latestProps.current.enabled || event.button !== 0 || !event.isPrimary) return;
    const target = event.target instanceof Element ? event.target : null;
    const handle = target?.closest<HTMLElement>("[data-widget-reorder-handle]");
    const header = target?.closest<HTMLElement>(".widget-header");
    const source = (handle ?? header)?.closest<HTMLElement>("[data-widget-id]");
    if (!source || !host.current?.contains(source)) return;
    if (!handle && target?.closest("button, a, input, textarea, select, [role='button'], [contenteditable]:not([contenteditable='false'])")) return;
    cancelResize();

    const previousSession = sessionRef.current;
    if (previousSession) cancelSession(previousSession, false);
    const captureTarget = host.current;
    if (!captureTarget) return;

    const draggedId = source.dataset.widgetId;
    const sourceItem = items.find((item) => item.instanceId === draggedId);
    if (!draggedId || !sourceItem) return;

    const rect = previewBounds?.originRect ?? source.getBoundingClientRect();
    const originIds = items.map((item) => item.instanceId);
    const session: DragSession = {
      pointerId: event.pointerId,
      captureTarget,
      source,
      draggedId,
      workspaceId,
      layoutKey,
      itemDataKey: itemData,
      originIds,
      currentOrder: originIds,
      expectedOrder: null,
      sizes: Object.fromEntries(items.map((item) => [item.instanceId, item.size])),
      miniStarts: Object.fromEntries(items.map((item) => [item.instanceId, Boolean(item.startsNewMiniBlock)])),
      currentMiniStart: Boolean(sourceItem.startsNewMiniBlock),
      expectedItemDataKey: null,
      phase: "pending",
      valid: true,
      previewIndex: items.findIndex((item) => item.instanceId === draggedId),
      startX: event.clientX,
      startY: event.clientY,
      latestX: activePointer?.clientX ?? event.clientX,
      latestY: activePointer?.clientY ?? event.clientY,
      projectionDirty: false,
      grabOffsetX: event.clientX - rect.left,
      grabOffsetY: event.clientY - rect.top,
      previewBounds: previewBounds ?? null,
      overlay: null,
      overlayCard: null,
      frame: null,
      followerEnabled: false,
      follower: null,
      followerTime: null,
      listeners: null,
      animations: new Set(),
      handoffAnimations: new Set(),
      handoffCardAnimation: null,
      removeTargetActive: false,
      removeTargetOver: false,
      removeTargetNear: false,
      removeTargetMotionUntil: 0,
    };
    sessionRef.current = session;

    const pointerMove = (nativeEvent: PointerEvent) => {
      if (nativeEvent.pointerId !== session.pointerId || sessionRef.current !== session) return;
      session.latestX = nativeEvent.clientX;
      session.latestY = nativeEvent.clientY;
      if (session.phase === "pending") {
        if (Math.hypot(session.latestX - session.startX, session.latestY - session.startY) < 5) return;
        activateSession(session);
      }
      if (session.phase === "active") {
        nativeEvent.preventDefault();
        if (session.follower?.settled) session.followerTime = window.performance.now();
        session.projectionDirty = true;
        schedulePointer(session);
      }
    };
    const pointerUp = (nativeEvent: PointerEvent) => {
      if (nativeEvent.pointerId !== session.pointerId || sessionRef.current !== session) return;
      session.latestX = nativeEvent.clientX;
      session.latestY = nativeEvent.clientY;
      if (session.phase === "pending") {
        cancelSession(session, false);
        return;
      }

      if (session.frame !== null) window.cancelAnimationFrame(session.frame);
      session.frame = null;
      // Resolve the final cursor target without advancing the follower. The
      // drop animation should start from the position the user last saw.
      updateProjection(session);
      const current = latestProps.current;
      const currentIds = current.items.map((item) => item.instanceId);
      if (!session.valid
        || current.workspaceId !== session.workspaceId
        || current.layoutKey !== session.layoutKey
        || !current.enabled
        || itemDataKey(current.items) !== session.itemDataKey
        || !sameIds(currentIds, session.originIds)) {
        cancelSession(session, true);
        return;
      }

      if (session.removeTargetOver) {
        // Clear all drag state and native listeners before a removal callback
        // can open a blocking confirmation dialog and blur the window.
        cancelSession(session, false);
        current.onRemove?.(session.draggedId);
        return;
      }

      // The target is no longer active once a normal drop starts settling.
      updateRemoveTargetState(session, false, false);

      const miniChanged = session.sizes[session.draggedId] === "mini"
        && session.currentMiniStart !== session.miniStarts[session.draggedId];
      const changed = !sameIds(session.currentOrder, session.originIds) || miniChanged;
      const accepted = !changed || current.onReorder([...session.currentOrder], session.sizes[session.draggedId] === "mini"
        ? { widgetId: session.draggedId, startsNewMiniBlock: session.currentMiniStart } : undefined);
      if (!accepted) {
        session.currentOrder = session.originIds;
        session.currentMiniStart = session.miniStarts[session.draggedId];
      }
      session.expectedOrder = accepted ? session.currentOrder : session.originIds;
      session.expectedItemDataKey = itemDataKey(current.items.map((item) => {
        if (item.instanceId !== session.draggedId || item.size !== "mini") return item;
        const next = { ...item };
        delete next.startsNewMiniBlock;
        if (session.currentMiniStart) next.startsNewMiniBlock = true;
        return next;
      }));
      session.phase = "settling";
      setIsReorderSettling(true);
      removePointerListeners(session);
      setPreviewOrder(accepted && changed ? [...session.currentOrder] : null);
      setPreviewMiniStart(accepted ? session.currentMiniStart : null);
      setInvalidDrop(false);
      setSettleTick((value) => value + 1);
    };
    const pointerCancel = (nativeEvent: PointerEvent) => {
      if (nativeEvent.pointerId === session.pointerId) cancelSession(session, true);
    };
    const lostCapture = (nativeEvent: PointerEvent) => {
      if (nativeEvent.target !== captureTarget || nativeEvent.pointerId !== session.pointerId) return;
      if (session.phase !== "settling") cancelSession(session, session.phase === "active");
    };
    const blur = () => cancelSession(session, session.phase === "active");
    const resize = () => cancelSession(session, session.phase === "active");
    const scroll = () => {
      if (sessionRef.current === session && session.phase === "active") {
        session.projectionDirty = true;
        schedulePointer(session);
      }
    };
    const keyDown = (nativeEvent: KeyboardEvent) => {
      if (nativeEvent.key !== "Escape") return;
      nativeEvent.preventDefault();
      cancelSession(session, session.phase === "active");
    };
    session.listeners = { pointerMove, pointerUp, pointerCancel, lostCapture, blur, keyDown, resize, scroll };
    document.addEventListener("pointermove", pointerMove, { capture: true, passive: false });
    document.addEventListener("pointerup", pointerUp, true);
    document.addEventListener("pointercancel", pointerCancel, true);
    window.addEventListener("blur", blur);
    window.addEventListener("keydown", keyDown, true);
    window.addEventListener("resize", resize);
    window.addEventListener("scroll", scroll, true);
    captureTarget.addEventListener("lostpointercapture", lostCapture);
    try { captureTarget.setPointerCapture(event.pointerId); } catch { /* Document listeners still track the pointer. */ }
    if (activePointer) {
      activateSession(session);
      if (session.phase === "active") {
        session.projectionDirty = true;
        schedulePointer(session);
      }
    }
  }, [activateSession, cancelResize, cancelSession, itemData, items, layoutKey, removePointerListeners, schedulePointer, updateProjection, updateRemoveTargetState, workspaceId]);

  const beginShake = useWidgetShake(`${workspaceId}:${layoutKey}:${itemData}`, !enabled && onCustomize ? (start, current, previewBounds) => {
    flushSync(() => onCustomize());
    beginSession(start, current, previewBounds);
  } : undefined);

  useEffect(() => {
    const session = sessionRef.current;
    if (!session) return;
    const currentIds = items.map((item) => item.instanceId);
    const identityChanged = workspaceId !== session.workspaceId
      || layoutKey !== session.layoutKey
      || !enabled
      || itemData !== (session.phase === "settling" ? session.expectedItemDataKey : session.itemDataKey);
    const expectedOrder = session.phase === "settling" ? session.expectedOrder : session.originIds;
    const orderChanged = !expectedOrder || !sameIds(currentIds, expectedOrder);
    if (identityChanged || orderChanged) cancelSession(session, false);
  }, [cancelSession, enabled, itemData, items, layoutKey, workspaceId]);

  useEffect(() => () => {
    const session = sessionRef.current;
    if (session) {
      sessionRef.current = null;
      updateRemoveTargetState(session, false, false);
      removePointerListeners(session);
      if (session.frame !== null) window.cancelAnimationFrame(session.frame);
      removeOverlay(session);
    }
    for (const [overlay, animation] of fadingOverlays.current) {
      animation.cancel();
      overlay.remove();
    }
    fadingOverlays.current.clear();
    boardScrollOffsets.current.clear();
  }, [removeOverlay, removePointerListeners, updateRemoveTargetState]);

  return (
    <div
      ref={host}
      className={`reorderable-widget-grid${enabled ? " is-reorder-enabled" : ""}${invalidDrop ? " is-reorder-invalid" : ""}${resizePreview ? " is-widget-resizing" : ""}`}
      onPointerDownCapture={(event) => {
        trackWidgetDoubleTap(event);
        if (beginResize(event)) return;
        beginShake(event);
        beginSession(event);
      }}
    >
      <AnimatedWidgetGrid
        label={label}
        className="reorder-widget-grid"
        style={style}
        layoutKey={gridLayoutKey}
        reflowKey={reflowKey}
        resizeMotion={Boolean(resizePreview)}
        resizePreview={resizePreview}
        resizePriorities={activeResizePriorities}
      >
        {orderedItems.map((widget, index) => renderWidget(widget, index, draggedId === widget.instanceId, resizePreview?.widgetId === widget.instanceId))}
        {addTile}
      </AnimatedWidgetGrid>
    </div>
  );
}
