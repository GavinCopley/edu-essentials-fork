"use client";

import { Cloud } from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { SaveStatus } from "../lib/autosave";
import "./workspace-save-status.css";

type Props = {
  status: SaveStatus;
  message: string;
  popupMessage: string;
  actions: ReactNode;
  onOpenChange?: (open: boolean) => void;
};

function isFailure(status: SaveStatus) {
  return status === "load-error" || status === "save-error" || status === "conflict" || status === "session-error";
}

function statusLabel(status: SaveStatus) {
  if (status === "saved") return "Workspace saved";
  if (isFailure(status)) return "Unable to save workspace";
  return "Saving workspace";
}

function announcementFor(status: SaveStatus, message: string) {
  if (status === "saved") return "Workspace saved.";
  if (status === "dirty") return "Workspace changes are waiting to save.";
  if (status === "saving") return "Saving workspace.";
  if (isFailure(status)) return message || "Unable to save workspace.";
  return "";
}

export default function WorkspaceSaveStatus({ status, message, popupMessage, actions, onOpenChange }: Props) {
  const [open, setOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const [position, setPosition] = useState<{ top: number; left: number } | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popupRef = useRef<HTMLDivElement>(null);
  const previousStatus = useRef<{ status: SaveStatus; message: string } | null>(null);
  const failed = isFailure(status);
  const dataSaveState = status === "saved" ? "saved" : failed ? "error" : "saving";
  const label = statusLabel(status);

  const finishClosing = useCallback(() => {
    setOpen(false);
    setClosing(false);
    setPosition(null);
  }, []);

  const closePopup = useCallback((restoreFocus = false) => {
    const reducedMotion = document.documentElement.dataset.motion === "reduced"
      || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reducedMotion) finishClosing();
    else setClosing(true);
    onOpenChange?.(false);
    if (restoreFocus) triggerRef.current?.focus();
  }, [finishClosing, onOpenChange]);

  useEffect(() => {
    if (!open || !closing) return;
    // Match the widget menu's fallback when animation events are interrupted.
    const timeout = window.setTimeout(finishClosing, 130);
    return () => window.clearTimeout(timeout);
  }, [closing, finishClosing, open]);

  useEffect(() => {
    const previous = previousStatus.current;
    previousStatus.current = { status, message };
    if (!previous || (previous.status === status && previous.message === message)) return;

    setAnnouncement(announcementFor(status, message));
  }, [status, message]);

  useEffect(() => {
    if (!open || closing || failed) return;
    const frame = window.requestAnimationFrame(() => closePopup(true));
    return () => window.cancelAnimationFrame(frame);
  }, [closePopup, closing, failed, open]);

  useEffect(() => {
    if (!open || closing) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      closePopup(true);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closePopup();
    };
    const onFocusIn = (event: FocusEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) closePopup();
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("focusin", onFocusIn);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("focusin", onFocusIn);
    };
  }, [closePopup, closing, open]);

  useLayoutEffect(() => {
    if (!open || closing) return;
    const popup = popupRef.current;
    const trigger = triggerRef.current;
    if (!popup || !trigger) return;

    let focusFrame = 0;
    const updatePosition = () => {
      const anchor = trigger.getBoundingClientRect();
      // Measure layout dimensions so the entrance scale cannot shift the anchor.
      const popupWidth = popup.offsetWidth;
      const popupHeight = popup.offsetHeight;
      const margin = 12;
      const gap = 8;
      const left = Math.max(margin, Math.min(window.innerWidth - popupWidth - margin, anchor.right - popupWidth));
      let top = anchor.bottom + gap;
      if (top + popupHeight > window.innerHeight - margin) top = anchor.top - popupHeight - gap;
      top = Math.max(margin, Math.min(window.innerHeight - popupHeight - margin, top));
      setPosition({ top, left });
    };

    updatePosition();
    focusFrame = window.requestAnimationFrame(() => {
      const firstAction = popup.querySelector<HTMLElement>('button:not(:disabled), a[href], [tabindex="0"]');
      (firstAction ?? popup.querySelector<HTMLElement>("[data-save-status-heading]"))?.focus();
    });
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    const resizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updatePosition);
    resizeObserver?.observe(popup);
    resizeObserver?.observe(trigger);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
      resizeObserver?.disconnect();
    };
  }, [closing, open]);

  const togglePopup = () => {
    if (open && !closing) {
      closePopup();
      triggerRef.current?.focus();
      return;
    }
    if (!failed) return;
    setClosing(false);
    if (!open) setPosition(null);
    setOpen(true);
    onOpenChange?.(true);
  };

  return (
    <div className="workspace-save-status" ref={rootRef} data-save-state={dataSaveState}>
      <button
        ref={triggerRef}
        type="button"
        className="workspace-save-status-trigger"
        data-save-state={dataSaveState}
        aria-label={label}
        aria-haspopup={failed || (open && !closing) ? "dialog" : undefined}
        aria-expanded={open && !closing}
        aria-controls={open && !closing ? "workspace-save-error-dialog" : undefined}
        title={label}
        onClick={togglePopup}
      >
        <Cloud size={19} aria-hidden="true">
          {failed ? <><path d="M12 10v3" /><path d="M12 16h.01" /></>
            : status === "saved" ? <path d="m8.5 13 2.5 2.5 4.5-4.5" />
              : <><path d="M12 16v-6" /><path d="m9 13 3-3 3 3" /></>}
        </Cloud>
      </button>
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{announcement}</span>
      {open && (
        <div
          ref={popupRef}
          id="workspace-save-error-dialog"
          className={`workspace-save-status-popover${closing ? " is-closing" : position ? " is-opening" : ""}`}
          role="dialog"
          aria-labelledby="workspace-save-error-title"
          aria-hidden={closing || undefined}
          inert={closing || undefined}
          style={{ top: position?.top ?? 0, left: position?.left ?? 0, visibility: position ? "visible" : "hidden" }}
          onAnimationEnd={(event) => {
            if (closing && event.target === event.currentTarget && event.animationName === "widget-menu-dismiss") finishClosing();
          }}
          onClickCapture={(event) => {
            if ((event.target as Element).closest("button, a[href]")) triggerRef.current?.focus();
          }}
        >
          <h2 id="workspace-save-error-title" data-save-status-heading tabIndex={-1}>Workspace save needs attention</h2>
          <p>{popupMessage || message || "Something went wrong while saving your workspace."}</p>
          <div className="workspace-save-status-actions">{actions}</div>
        </div>
      )}
    </div>
  );
}
