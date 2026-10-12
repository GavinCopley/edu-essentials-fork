"use client";

import { useLayoutEffect, useRef, type CSSProperties } from "react";
import {
  getHomeSkeletonPlacements,
  type HomeSkeletonLayout,
} from "../lib/home-skeleton";

type HomeSkeletonProps = {
  layout: HomeSkeletonLayout;
  greeting: HomeSkeletonGreeting;
  reducedMotion?: boolean;
};

export type HomeSkeletonGreeting = {
  greeting: string;
  studentName: string;
  dateLabel: string;
};

/** Shared with the live Home header so the pending silhouette follows its wrapping. */
export function HomeGreeting({ greeting, studentName, dateLabel }: HomeSkeletonGreeting) {
  return (
    <header className="home-greeting">
      <h1>{greeting}, {studentName}.</h1>
      <p>{dateLabel}</p>
    </header>
  );
}

type PlacementStyle = CSSProperties & Record<`--${string}`, string | number>;

function HomeSkeletonCard({
  widget,
  desktop,
  phone,
  index,
}: {
  widget: HomeSkeletonLayout["widgets"][number];
  desktop: ReturnType<typeof getHomeSkeletonPlacements>["desktop"][number];
  phone: ReturnType<typeof getHomeSkeletonPlacements>["phone"][number];
  index: number;
}) {
  const style: PlacementStyle = {
    "--desktop-column": desktop.column,
    "--desktop-column-span": desktop.columnSpan,
    "--desktop-row": desktop.row,
    "--desktop-row-span": desktop.rowSpan,
    "--phone-column": phone.column,
    "--phone-column-span": phone.columnSpan,
    "--phone-row": phone.row,
    "--phone-row-span": phone.rowSpan,
    "--home-skeleton-delay": `${Math.min(index, 7) * 75}ms`,
  };

  return (
    <article
      className="home-skeleton__card"
      data-size={widget.size}
      data-mini-start={widget.size === "mini" && widget.startsNewMiniBlock ? "true" : undefined}
      style={style}
    />
  );
}

export function HomeSkeleton({ layout, greeting, reducedMotion = false }: HomeSkeletonProps) {
  const placements = getHomeSkeletonPlacements(layout);
  const style = { "--home-skeleton-gap": `calc(${layout.gap} * var(--desktop-density-unit, 1px))` } as CSSProperties;
  const rootRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const root = rootRef.current;
    const geometry = layout.geometry;
    if (!root || !geometry) return;

    const updateMeasuredGeometry = () => {
      const sameViewport = Math.abs(window.innerWidth - geometry.viewportWidth) <= 1;
      const sameContent = Math.abs(root.getBoundingClientRect().width - geometry.contentWidth) <= 1;
      if (sameViewport && sameContent) {
        root.style.setProperty("--home-skeleton-measured-today-height", `${geometry.todayHeight}px`);
        root.style.setProperty("--home-skeleton-measured-toolbar-height", `${geometry.toolbarHeight}px`);
      } else {
        root.style.removeProperty("--home-skeleton-measured-today-height");
        root.style.removeProperty("--home-skeleton-measured-toolbar-height");
      }
    };

    updateMeasuredGeometry();
    window.addEventListener("resize", updateMeasuredGeometry);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateMeasuredGeometry);
    observer?.observe(root);
    return () => {
      window.removeEventListener("resize", updateMeasuredGeometry);
      observer?.disconnect();
      root.style.removeProperty("--home-skeleton-measured-today-height");
      root.style.removeProperty("--home-skeleton-measured-toolbar-height");
    };
  }, [layout.geometry]);

  return (
    <div
      ref={rootRef}
      className={`page home-page home-skeleton${reducedMotion ? " home-skeleton--reduced" : ""}`}
      data-today-hidden={String(layout.todayHidden)}
      data-today-sections={layout.todaySectionCount ?? 3}
      style={style}
      role="status"
      aria-label="Loading Home workspace"
      aria-busy="true"
    >
      <span className="home-skeleton__status">Loading Home workspace</span>
      <div className="home-skeleton__decoration" aria-hidden="true" inert>
        <div className="home-skeleton__intro" aria-hidden="true" inert>
          <HomeGreeting {...greeting} />
        </div>

        {!layout.todayHidden && <section className="home-skeleton__today" />}

        <div className="home-skeleton__toolbar">
          <div className="home-skeleton__tabs">
            <span className="home-skeleton__tab is-current" />
            <span className="home-skeleton__tab" />
          </div>
          <div className="home-skeleton__actions">
            <span className="home-skeleton__action" data-control="save-status" />
            <span className="home-skeleton__action" data-control="widget-customization" />
            <span className="home-skeleton__action" data-control="customize" />
            <span className="home-skeleton__action" data-control="add-widget" />
          </div>
        </div>

        <div className="home-skeleton__grid">
          {layout.widgets.map((widget, index) => (
            <HomeSkeletonCard
              key={`${widget.size}-${index}`}
              widget={widget}
              desktop={placements.desktop[index]}
              phone={placements.phone[index]}
              index={index}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

export default HomeSkeleton;
