"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, EyeOff, MoreHorizontal, Pencil, X } from "lucide-react";
import { defaultTodaySections, todaySectionOptions, type TodaySectionId } from "../lib/today-sections";

type TodaySectionProps = {
  hidden: boolean;
  sections: TodaySectionId[];
  children: ReactNode;
  onHiddenChange: (hidden: boolean) => boolean;
  onSectionsChange: (sections: TodaySectionId[]) => boolean;
  onCalendar: () => void;
  onOptionsOpen: () => void;
  onHideFocus?: () => void;
  optionsButtonRef?: RefObject<HTMLButtonElement | null>;
  menuStyle?: CSSProperties;
};

export default function TodaySection({
  hidden,
  sections,
  children,
  onHiddenChange,
  onSectionsChange,
  onCalendar,
  onOptionsOpen,
  onHideFocus,
  optionsButtonRef,
  menuStyle,
}: TodaySectionProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editorOpen, setEditorOpen] = useState(false);
  const [sectionDraft, setSectionDraft] = useState<TodaySectionId[]>(sections);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [portalTarget, setPortalTarget] = useState<HTMLElement | null>(null);
  const [menuPosition, setMenuPosition] = useState<{ left: number; top: number } | null>(null);
  const localTriggerRef = useRef<HTMLButtonElement>(null);
  const triggerRef = optionsButtonRef ?? localTriggerRef;
  const menuRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<HTMLDivElement>(null);
  const applyingRef = useRef(false);
  const sectionRef = useRef<HTMLElement>(null);
  const focusLastItemOnOpenRef = useRef(false);
  const focusOnOpenRef = useRef(false);

  const setTriggerRef = useCallback((element: HTMLButtonElement | null) => {
    localTriggerRef.current = element;
    if (optionsButtonRef) optionsButtonRef.current = element;
  }, [optionsButtonRef]);

  const setSectionElement = useCallback((element: HTMLElement | null) => {
    sectionRef.current = element;
    if (element) setPortalTarget(element.closest<HTMLElement>(".reference-ui") ?? document.body);
  }, []);

  useEffect(() => {
    if (!hidden || !menuOpen) return;
    // Clear stale menu state so an externally hidden section cannot reopen it later.
    // eslint-disable-next-line react-hooks/set-state-in-effect -- A prop transition must dismiss this section's transient menu.
    setMenuOpen(false);
  }, [hidden, menuOpen]);

  const closeMenu = useCallback((returnFocus = false) => {
    focusOnOpenRef.current = false;
    setMenuOpen(false);
    if (returnFocus) triggerRef.current?.focus();
  }, [triggerRef]);

  const closeEditor = (returnFocus = false) => {
    setEditorOpen(false);
    if (returnFocus) window.requestAnimationFrame(() => triggerRef.current?.focus());
  };

  const openEditor = () => {
    setSectionDraft([...sections]);
    setApplyError(null);
    closeMenu();
    setEditorOpen(true);
  };

  useLayoutEffect(() => {
    if (!editorOpen) return;
    const firstEnabledChoice = editorRef.current?.querySelector<HTMLInputElement>('input[type="checkbox"]:not(:disabled)');
    (firstEnabledChoice ?? editorRef.current)?.focus({ preventScroll: true });
  }, [editorOpen]);

  const handleEditorKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeEditor(true);
      return;
    }
    if (event.key !== "Tab" || !editorRef.current) return;
    const focusable = Array.from(editorRef.current.querySelectorAll<HTMLElement>(
      'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])',
    )).filter((element) => element.tabIndex >= 0 && element.getClientRects().length > 0);
    if (focusable.length === 0) {
      event.preventDefault();
      editorRef.current.focus();
      return;
    }
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && (document.activeElement === first || document.activeElement === editorRef.current)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const applySections = () => {
    if (applyingRef.current) return;
    applyingRef.current = true;
    const changed = sections.length !== sectionDraft.length || sections.some((section, index) => section !== sectionDraft[index]);
    try {
      if (changed && !onSectionsChange([...sectionDraft])) {
        setApplyError("Today sections could not be saved. Try again after checking your workspace save status.");
        applyingRef.current = false;
        return;
      }
      closeEditor(true);
    } catch {
      setApplyError("Today sections could not be saved. Try again after checking your workspace save status.");
    } finally {
      applyingRef.current = false;
    }
  };

  const toggleSection = (section: TodaySectionId, checked: boolean) => {
    setApplyError(null);
    setSectionDraft((current) => checked ? [...current, section] : current.filter((item) => item !== section));
  };

  useEffect(() => {
    if (!menuOpen) return;
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (target && !triggerRef.current?.contains(target) && !menuRef.current?.contains(target)) closeMenu();
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    return () => document.removeEventListener("pointerdown", dismissOutside, true);
  }, [menuOpen, closeMenu, triggerRef]);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    const menu = menuRef.current;
    const trigger = triggerRef.current;
    if (!menu || !trigger) return;

    const placeMenu = () => {
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
      const triggerRect = trigger.getBoundingClientRect();
      const width = menu.offsetWidth || Math.min(240, viewportWidth * 0.85);
      const height = menu.offsetHeight;
      const left = Math.max(12, Math.min(triggerRect.right - width, viewportWidth - width - 12));
      const below = triggerRect.bottom + 4;
      const top = below + height <= viewportHeight - 12
        ? below
        : Math.max(12, triggerRect.top - height - 4);
      setMenuPosition((current) => current?.left === left && current.top === top ? current : { left, top });
    };

    placeMenu();
    window.addEventListener("resize", placeMenu);
    document.addEventListener("scroll", placeMenu, true);
    return () => {
      window.removeEventListener("resize", placeMenu);
      document.removeEventListener("scroll", placeMenu, true);
    };
  }, [menuOpen, portalTarget, triggerRef]);

  useLayoutEffect(() => {
    if (!menuOpen || !menuPosition || !focusOnOpenRef.current) return;
    let focusFrame = 0;
    const focusWhenVisible = () => {
      const menu = menuRef.current;
      if (!menu?.isConnected || !focusOnOpenRef.current) return;
      const active = document.activeElement;
      if (active !== triggerRef.current && active !== document.body && !menu.contains(active)) {
        focusOnOpenRef.current = false;
        return;
      }
      // Flush positioning and wait until the browser has applied visibility.
      menu.getBoundingClientRect();
      if (window.getComputedStyle(menu).visibility !== "visible") {
        focusFrame = window.requestAnimationFrame(focusWhenVisible);
        return;
      }
      const items = menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)');
      const initialItem = focusLastItemOnOpenRef.current ? items[items.length - 1] : items[0];
      if (!initialItem) return;
      initialItem.focus({ preventScroll: true });
      if (document.activeElement === initialItem) {
        focusOnOpenRef.current = false;
        focusLastItemOnOpenRef.current = false;
      } else focusFrame = window.requestAnimationFrame(focusWhenVisible);
    };
    focusFrame = window.requestAnimationFrame(focusWhenVisible);
    return () => window.cancelAnimationFrame(focusFrame);
  }, [menuOpen, menuPosition, portalTarget, triggerRef]);

  const openMenu = (focusLastItem = false) => {
    setMenuPosition(null);
    focusOnOpenRef.current = true;
    focusLastItemOnOpenRef.current = focusLastItem;
    onOptionsOpen();
    setMenuOpen(true);
  };

  const handleTriggerKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!menuOpen) openMenu(event.key === "ArrowUp");
    }
  };

  const handleMenuKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const menu = menuRef.current;
    if (!menu) return;
    const items = Array.from(menu.querySelectorAll<HTMLButtonElement>('[role="menuitem"]:not(:disabled)'));
    if (event.key === "Escape") {
      event.preventDefault();
      closeMenu(true);
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      const candidates = Array.from(document.querySelectorAll<HTMLElement>(
        'a[href], button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
      )).filter((element) => element.tabIndex >= 0 && !menuRef.current?.contains(element) && !element.closest("[inert], [aria-hidden='true']") && element.getClientRects().length > 0);
      const triggerIndex = candidates.indexOf(triggerRef.current!);
      const next = candidates[triggerIndex + (event.shiftKey ? -1 : 1)];
      closeMenu();
      (next ?? triggerRef.current)?.focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    if (items.length === 0) return;
    const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
    const offset = event.key === "ArrowDown" ? 1 : -1;
    const nextIndex = currentIndex < 0 ? 0 : (currentIndex + offset + items.length) % items.length;
    items[nextIndex].focus();
  };

  const hide = () => {
    if (!onHiddenChange(true)) return;
    closeMenu();
    onHideFocus?.();
  };

  if (hidden) return null;

  return (
    <section ref={setSectionElement} className="home-today-panel" aria-labelledby="today-panel-title">
      <header className="today-panel-header">
        <h2 id="today-panel-title">Today</h2>
        <div className="today-panel-actions">
          <button className="today-panel-link" onClick={onCalendar}>View calendar <ArrowRight size={14} /></button>
          <button
            ref={setTriggerRef}
            type="button"
            className="icon-button"
            aria-label="Today section options"
            aria-haspopup="menu"
            aria-expanded={menuOpen}
            onClick={() => menuOpen ? closeMenu() : openMenu()}
            onKeyDown={handleTriggerKeyDown}
          ><MoreHorizontal size={22} /></button>
        </div>
      </header>
      {children}
      {menuOpen && createPortal(
        <div
          ref={menuRef}
          className="popover widget-menu today-section-menu"
          role="menu"
          tabIndex={-1}
          aria-label="Today section options"
          onKeyDown={handleMenuKeyDown}
          style={{ ...menuStyle, position: "fixed", left: menuPosition?.left ?? -9999, top: menuPosition?.top ?? -9999, right: "auto", visibility: menuPosition ? "visible" : "hidden" }}
        >
          <button type="button" role="menuitem" onClick={openEditor}><Pencil size={15} /> Edit section</button>
          <button type="button" role="menuitem" onClick={hide}><EyeOff size={15} /> Hide section</button>
        </div>,
        portalTarget ?? document.body,
      )}
      {editorOpen && createPortal(
        <div className="modal-backdrop today-section-editor-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeEditor(true); }}>
          {/* The dialog owns Escape and Tab so focus stays inside while editing. */}
          {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
          <div ref={editorRef} className="small-modal today-section-editor" role="dialog" aria-modal="true" aria-labelledby="today-section-editor-title" aria-describedby="today-section-editor-help" tabIndex={-1} onKeyDown={handleEditorKeyDown}>
            <div className="today-section-editor-header">
              <div><p className="eyebrow">TODAY LAYOUT</p><h2 id="today-section-editor-title">Edit Today sections</h2></div>
              <button type="button" className="icon-button" aria-label="Close Today section editor" onClick={() => closeEditor(true)}><X size={19} /></button>
            </div>
            <p id="today-section-editor-help" className="form-hint">Choose 1–3 sections. To swap a section, remove one first, then add its replacement.</p>
            <fieldset className="today-section-editor-choices">
              <legend>Sections to show</legend>
              {todaySectionOptions.map((option) => {
                const checked = sectionDraft.includes(option.id);
                const disabled = checked ? sectionDraft.length <= 1 : sectionDraft.length >= 3;
                return (
                  <div key={option.id} className="today-section-editor-choice">
                    <input
                      id={`today-section-choice-${option.id}`}
                      type="checkbox"
                      checked={checked}
                      disabled={disabled}
                      aria-label={option.label}
                      aria-describedby={`today-section-description-${option.id}`}
                      onChange={(event) => toggleSection(option.id, event.currentTarget.checked)}
                    />
                    <label htmlFor={`today-section-choice-${option.id}`}><strong>{option.label}</strong><small id={`today-section-description-${option.id}`}>{option.description}</small></label>
                  </div>
                );
              })}
            </fieldset>
            <p className="today-section-editor-count" aria-live="polite">{sectionDraft.length} of 3 selected</p>
            {applyError && <p className="auth-error" role="alert">{applyError}</p>}
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => { setSectionDraft([...defaultTodaySections]); setApplyError(null); }}>Reset to defaults</button>
              <button type="button" className="secondary-button" onClick={() => closeEditor(true)}>Cancel</button>
              <button type="button" className="primary-button" onClick={applySections}>Apply</button>
            </div>
          </div>
        </div>,
        portalTarget ?? document.body,
      )}
    </section>
  );
}
