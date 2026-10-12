"use client";

import { Component, createRef, type ReactNode, type CSSProperties } from "react";
import { calculateWidgetPlacements, type WidgetResizePriority } from "../lib/widget-layout";
import { getWidgetResizeContentFilter } from "../lib/widget-resize";
import {
  createWidgetResizeSettleFrames,
  WIDGET_RESIZE_CONTENT_REVEAL_DURATION_MS,
  WIDGET_RESIZE_SETTLE_DURATION_MS,
  WIDGET_RESIZE_SETTLE_EASING,
} from "../lib/widget-resize-motion";
import type { WidgetResizePreview } from "./use-widget-resize";

export { calculateWidgetPlacements };
export type { WidgetPlacement } from "../lib/widget-layout";

type Props = { layoutKey: string; reflowKey?: string; label: string; children: ReactNode; style?: CSSProperties; className?: string; animateLayout?: boolean; resizeMotion?: boolean; resizePriorities?: readonly WidgetResizePriority[]; resizePreview?: WidgetResizePreview | null };
type Snapshot = Map<string, DOMRect> | null;

export type WidgetUnitInput = {
  gridWidth: number;
  gap: number;
  columns: 2 | 4;
};

/** The base cell is square and uses the exact available width after column gaps. */
export function calculateWidgetUnit({ gridWidth, gap, columns }: WidgetUnitInput): number {
  return Math.max(0, (gridWidth - gap * (columns - 1)) / columns);
}

/** FLIP measures the old layout before React changes it, including interrupted motion. */
export default class AnimatedWidgetGrid extends Component<Props, Record<string, never>, Snapshot> {
  private grid = createRef<HTMLDivElement>();
  private animations = new Set<Animation>();
  private settlingAnimations = new Map<HTMLElement, Animation>();
  private layoutObserver: ResizeObserver | null = null;
  private observedLayoutTargets = new Set<Element>();
  private measurementFrame: number | null = null;
  private resizeStyles: { card: HTMLElement; values: Map<string, { value: string; priority: string }> } | null = null;

  private restoreResizeStyles() {
    if (!this.resizeStyles) return;
    const { card, values } = this.resizeStyles;
    for (const [property, { value, priority }] of values) {
      if (value) card.style.setProperty(property, value, priority);
      else card.style.removeProperty(property);
    }
    delete card.dataset.widgetResizeLive;
    this.resizeStyles = null;
  }

  private updateResizePreview() {
    const preview = this.props.resizePreview;
    const card = preview ? [...this.cards()].find((candidate) => candidate.dataset.widgetId === preview.widgetId) : undefined;
    if (this.resizeStyles?.card !== card) this.restoreResizeStyles();
    if (!preview || !card) return;
    if (!this.resizeStyles) {
      this.resizeStyles = {
        card,
        values: new Map(["width", "height", "max-height", "translate", "--widget-resize-blur", "--widget-resize-filter"].map((property) => [property, {
          value: card.style.getPropertyValue(property),
          priority: card.style.getPropertyPriority(property),
        }])),
      };
    }
    card.dataset.widgetResizeLive = "true";
    card.style.width = `${preview.width}px`;
    card.style.height = `${preview.height}px`;
    card.style.maxHeight = "none";
    const column = Number.parseInt(card.style.gridColumn, 10) || 1;
    const row = Number.parseInt(card.style.gridRow, 10) || 1;
    card.style.translate = `${(preview.sourceOffsetX ?? 0) + (preview.sourceColumn - column) * (preview.unit + preview.gap)}px ${(preview.sourceOffsetY ?? 0) + (preview.sourceRow - row) * (preview.unit + preview.gap) / 2}px`;
    const blurPx = this.reducedMotion() ? 0 : preview.blurPx;
    card.style.setProperty("--widget-resize-blur", `${blurPx}px`);
    card.style.setProperty("--widget-resize-filter", getWidgetResizeContentFilter(blurPx));
  }

  private updateBoardUnit = () => {
    const grid = this.grid.current;
    if (!grid) return;

    const gridStyle = window.getComputedStyle(grid);
    const configuredColumns = Number.parseInt(gridStyle.getPropertyValue("--widget-columns"), 10);
    const columns: 2 | 4 = configuredColumns === 2 || configuredColumns === 4
      ? configuredColumns
      : window.innerWidth <= 600 ? 2 : 4;
    const computedGap = Number.parseFloat(gridStyle.columnGap);
    const gap = Number.isFinite(computedGap) ? computedGap : 16;
    const isPreview = grid.classList.contains("wa-preview-cards");
    const computedWidth = Number.parseFloat(gridStyle.width);
    const rectWidth = grid.getBoundingClientRect().width;
    // DeviceStage scales preview frames with transform. Computed width stays in
    // the frame's CSS pixels, while the rectangle is correct for the live board.
    const gridWidth = isPreview && computedWidth > 0
      ? computedWidth
      : rectWidth || grid.clientWidth;
    const unit = calculateWidgetUnit({
      gridWidth,
      gap,
      columns,
    });
    const value = `${unit}px`;
    if (grid.style.getPropertyValue("--widget-unit") !== value) grid.style.setProperty("--widget-unit", value);
  };

  private scheduleBoardUnitUpdate = () => {
    if (this.measurementFrame !== null) return;
    this.measurementFrame = window.requestAnimationFrame(() => {
      this.measurementFrame = null;
      this.updateBoardLayout();
    });
  };

  private handleResize = () => {
    this.observeLayout();
    this.scheduleBoardUnitUpdate();
  };

  private observeLayout = () => {
    const grid = this.grid.current;
    if (!grid) return;
    const targets = new Set<Element>([grid]);
    if (targets.size === this.observedLayoutTargets.size && [...targets].every((target) => this.observedLayoutTargets.has(target))) return;
    this.layoutObserver?.disconnect();
    this.layoutObserver = null;
    this.observedLayoutTargets = targets;
    if (typeof ResizeObserver === "undefined") return;
    this.layoutObserver = new ResizeObserver(this.scheduleBoardUnitUpdate);
    for (const target of targets) this.layoutObserver.observe(target);
  };

  private reducedMotion() {
    return document.documentElement.dataset.motion === "reduced"
      || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  }

  private cards() {
    return this.grid.current?.querySelectorAll<HTMLElement>("[data-widget-id]") ?? [];
  }

  private updateCardPlacements() {
    const grid = this.grid.current;
    if (!grid) return;

    const gridStyle = window.getComputedStyle(grid);
    const configuredColumns = Number.parseInt(gridStyle.getPropertyValue("--widget-columns"), 10);
    const columns: 2 | 4 = configuredColumns === 2 || configuredColumns === 4
      ? configuredColumns
      : window.innerWidth <= 600 ? 2 : 4;
    const cards = (Array.from(grid.children) as HTMLElement[]).filter((card) =>
      card.hasAttribute("data-widget-id") || card.classList.contains("wa-preview-card"),
    );
    const priority = this.props.resizePriorities?.find((candidate) => candidate.columns === columns);
    const priorityIndex = priority ? cards.findIndex((card) => card.dataset.widgetId === priority.widgetId) : -1;
    const placements = calculateWidgetPlacements(cards.map((card) => card.dataset.size ?? "small"), columns,
      cards.map((card) => card.dataset.miniStart === "true"),
      priority && priorityIndex >= 0 ? { index: priorityIndex, column: priority.column, row: priority.row } : undefined);

    cards.forEach((card, index) => {
      const placement = placements[index];
      card.style.gridColumn = `${placement.column} / span ${placement.columnSpan}`;
      card.style.gridRow = `${placement.row} / span ${placement.rowSpan}`;
    });
  }

  private updateBoardLayout = () => {
    this.updateBoardUnit();
    this.updateCardPlacements();
  };

  getSnapshotBeforeUpdate(previous: Props): Snapshot {
    if (previous.reflowKey !== this.props.reflowKey
      || this.props.animateLayout === false
      || previous.layoutKey === this.props.layoutKey && !(previous.resizePreview && !this.props.resizePreview)
      || this.reducedMotion()) return null;
    return new Map([...this.cards()].map((card) => [card.dataset.widgetId!, card.getBoundingClientRect()]));
  }

  componentDidUpdate(previous: Props, _state: Record<string, never>, snapshot: Snapshot) {
    const releasingId = previous.resizePreview && !this.props.resizePreview ? previous.resizePreview.widgetId : undefined;
    if (snapshot || previous.resizePreview?.widgetId !== this.props.resizePreview?.widgetId) this.cancelAnimations();
    const releasingCard = releasingId ? [...this.cards()].find((card) => card.dataset.widgetId === releasingId) : undefined;
    if (releasingCard) releasingCard.dataset.widgetResizeSettling = "true";
    this.updateBoardLayout();
    this.updateResizePreview();
    this.observeLayout();
    const reflowChanged = previous.reflowKey !== this.props.reflowKey;
    if (reflowChanged) this.cancelAnimations();
    if (this.props.animateLayout === false || this.reducedMotion() || reflowChanged || !snapshot) {
      if (this.props.animateLayout === false || this.reducedMotion()) this.cancelAnimations();
      if (releasingCard) delete releasingCard.dataset.widgetResizeSettling;
      return;
    }
    this.cancelAnimations();
    // Read every destination before animating, so one card cannot affect another's measurement.
    const destinations = [...this.cards()].map((card) => ({ card, rect: card.getBoundingClientRect() }));
    for (const { card, rect } of destinations) {
      if (card.dataset.widgetId === this.props.resizePreview?.widgetId) continue;
      const old = snapshot.get(card.dataset.widgetId!);
      if (!old || !rect.width || !rect.height || !old.width || !old.height || typeof card.animate !== "function") {
        delete card.dataset.widgetResizeSettling;
        continue;
      }
      const configuredDuration = Number.parseFloat(window.getComputedStyle(card).getPropertyValue("--wa-transition-ms"));
      const resizeMotion = this.props.resizeMotion || previous.resizeMotion;
      const configuredTiming = Number.isFinite(configuredDuration) ? configuredDuration : 280;
      const settling = card.dataset.widgetId === releasingId;
      const duration = settling ? WIDGET_RESIZE_SETTLE_DURATION_MS : resizeMotion ? Math.min(configuredTiming, 260) : configuredTiming;
      if (configuredTiming <= 0) { delete card.dataset.widgetResizeSettling; continue; }
      const x = old.left - rect.left, y = old.top - rect.top;
      const sx = old.width / rect.width, sy = old.height / rect.height;
      if (Math.abs(x) < 0.5 && Math.abs(y) < 0.5 && Math.abs(old.width - rect.width) < 0.5 && Math.abs(old.height - rect.height) < 0.5) {
        delete card.dataset.widgetResizeSettling;
        continue;
      }
      const frames: Keyframe[] = settling ? createWidgetResizeSettleFrames(old, rect) : [
        { transform: `translate(${x}px, ${y}px) scale(${sx}, ${sy})`, transformOrigin: "top left" },
        { transform: "none", transformOrigin: "top left" },
      ];
      const animation = card.animate(frames, { duration, easing: settling ? WIDGET_RESIZE_SETTLE_EASING : resizeMotion ? "cubic-bezier(0.22, 1.18, 0.36, 1)" : "cubic-bezier(0.22, 1, 0.36, 1)" });
      this.animations.add(animation);
      if (settling) this.settlingAnimations.set(card, animation);
      animation.onfinish = animation.oncancel = () => {
        this.animations.delete(animation);
        if (settling && this.settlingAnimations.get(card) === animation) {
          this.settlingAnimations.delete(card);
          delete card.dataset.widgetResizeSettling;
        }
      };
      const frame = card.querySelector<HTMLElement>(".widget-frame");
      if (settling && frame && previous.resizePreview?.blurPx) {
        const unblur = frame.animate([{ filter: getWidgetResizeContentFilter(previous.resizePreview.blurPx) }, { filter: getWidgetResizeContentFilter(0) }], { duration: WIDGET_RESIZE_CONTENT_REVEAL_DURATION_MS, easing: "ease-out" });
        this.animations.add(unblur);
        unblur.onfinish = unblur.oncancel = () => this.animations.delete(unblur);
      }
    }
  }

  private cancelAnimations() {
    for (const animation of this.animations) animation.cancel();
    this.animations.clear();
    for (const card of this.settlingAnimations.keys()) delete card.dataset.widgetResizeSettling;
    this.settlingAnimations.clear();
  }

  componentDidMount() {
    this.updateBoardLayout();
    this.updateResizePreview();
    this.observeLayout();
    window.addEventListener("resize", this.handleResize);
  }

  componentWillUnmount() {
    this.cancelAnimations();
    this.restoreResizeStyles();
    this.layoutObserver?.disconnect();
    this.layoutObserver = null;
    this.observedLayoutTargets.clear();
    if (this.measurementFrame !== null) window.cancelAnimationFrame(this.measurementFrame);
    this.measurementFrame = null;
    window.removeEventListener("resize", this.handleResize);
  }

  render() {
    const className = this.props.className ? `widget-grid ${this.props.className}` : "widget-grid";
    return <div ref={this.grid} className={className} style={this.props.style} aria-label={this.props.label}>{this.props.children}</div>;
  }
}
