import { ArrowRight, ArrowUp, CheckCircle2, ChevronLeft, ChevronRight, MessageSquare, Sparkles } from "lucide-react";
import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { FormEvent, MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, ReactNode } from "react";
import type { SavedAssignment } from "../lib/workspace-codec";

const STUDY_SUMMARY = "I’d start with the work that needs your attention most, then give you a head start on the next deadline. Your week looks manageable—let’s take it one priority at a time.";
const STUDY_SUMMARY_TYPING_DURATION_MS = 2500;
const REDUCED_MOTION_QUERY = "(prefers-reduced-motion: reduce)";
const PRIORITIES_PER_PAGE = 2;
const PRIORITY_SWIPE_THRESHOLD = 40;

function subscribeToReducedMotion(onChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return () => {};

  const preference = window.matchMedia(REDUCED_MOTION_QUERY);
  const listener = () => onChange();
  if (preference.addEventListener) {
    preference.addEventListener("change", listener);
    return () => preference.removeEventListener("change", listener);
  }

  preference.addListener(listener);
  return () => preference.removeListener(listener);
}

function getSystemReducedMotion() {
  return typeof window !== "undefined"
    && typeof window.matchMedia === "function"
    && window.matchMedia(REDUCED_MOTION_QUERY).matches;
}

type Props = {
  focusAssignments: SavedAssignment[];
  overdueCount: number;
  dueTodayCount: number;
  completedThisWeek: number;
  courseCount: number;
  courseCodeFor: (courseId: string) => string;
  renderStatusBadge: (status: SavedAssignment["status"]) => ReactNode;
  onSelectAssignment: (assignment: SavedAssignment) => void;
  onAddAssignment: () => void;
  onAddClass: () => void;
  onOpenAssistant: (draft?: string) => void;
  onAskAssistant: (question: string) => boolean | void;
  reducedMotion?: boolean;
};

function priorityAdvice(assignment: SavedAssignment) {
  if (assignment.status === "overdue") return "Clear this first to get back on track.";
  if (assignment.status === "today") return "Make time for this before the day ends.";
  return "Get a head start on your next deadline.";
}

export default function DashboardStudyBrief({
  focusAssignments,
  overdueCount,
  dueTodayCount,
  completedThisWeek,
  courseCount,
  courseCodeFor,
  renderStatusBadge,
  onSelectAssignment,
  onAddAssignment,
  onAddClass,
  onOpenAssistant,
  onAskAssistant,
  reducedMotion = false,
}: Props) {
  const [question, setQuestion] = useState("");
  const systemReducedMotion = useSyncExternalStore(subscribeToReducedMotion, getSystemReducedMotion, () => false);
  const shouldReduceMotion = reducedMotion || systemReducedMotion;
  const [visibleCharacters, setVisibleCharacters] = useState(() => shouldReduceMotion ? STUDY_SUMMARY.length : 0);
  if (shouldReduceMotion && visibleCharacters < STUDY_SUMMARY.length) {
    setVisibleCharacters(STUDY_SUMMARY.length);
  }
  const visibleCharactersRef = useRef(visibleCharacters);

  useEffect(() => {
    visibleCharactersRef.current = visibleCharacters;
  }, [visibleCharacters]);

  useEffect(() => {
    if (shouldReduceMotion || visibleCharactersRef.current >= STUDY_SUMMARY.length) return;

    const tickDuration = 16;
    const elapsedBeforeResume = (visibleCharactersRef.current / STUDY_SUMMARY.length) * STUDY_SUMMARY_TYPING_DURATION_MS;
    const startedAt = window.performance.now() - elapsedBeforeResume;
    const interval = window.setInterval(() => {
      const elapsed = Math.min(window.performance.now() - startedAt, STUDY_SUMMARY_TYPING_DURATION_MS);
      const nextCharacters = Math.min(
        STUDY_SUMMARY.length,
        Math.floor((elapsed / STUDY_SUMMARY_TYPING_DURATION_MS) * STUDY_SUMMARY.length),
      );
      setVisibleCharacters((current) => Math.max(current, nextCharacters));
      if (nextCharacters === STUDY_SUMMARY.length) {
        window.clearInterval(interval);
      }
    }, tickDuration);

    return () => window.clearInterval(interval);
  }, [shouldReduceMotion]);

  const summaryCharacters = shouldReduceMotion ? STUDY_SUMMARY.length : visibleCharacters;
  const assignmentSequence = JSON.stringify(focusAssignments.map((assignment) => assignment.id));
  const [priorityState, setPriorityState] = useState({ sequence: assignmentSequence, page: 0 });
  const priorityPage = priorityState.sequence === assignmentSequence ? priorityState.page : 0;
  if (priorityState.sequence !== assignmentSequence) {
    setPriorityState({ sequence: assignmentSequence, page: 0 });
  }
  const priorityPageCount = Math.ceil(focusAssignments.length / PRIORITIES_PER_PAGE);
  const priorityStartIndex = priorityPage * PRIORITIES_PER_PAGE;
  const visiblePriorities = focusAssignments.slice(priorityStartIndex, priorityStartIndex + PRIORITIES_PER_PAGE);
  const priorityRangeEnd = priorityStartIndex + visiblePriorities.length;
  const priorityRangeLabel = priorityRangeEnd === priorityStartIndex + 1
    ? `${priorityRangeEnd} of ${focusAssignments.length}`
    : `${priorityStartIndex + 1}–${priorityRangeEnd} of ${focusAssignments.length}`;
  const prioritySwipeRef = useRef<{ pointerId: number; x: number; y: number; captured: boolean } | null>(null);
  const suppressSwipeClickRef = useRef(false);

  function handlePriorityPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    suppressSwipeClickRef.current = false;
    if (event.pointerType === "mouse" || event.isPrimary === false || event.button !== 0) {
      prioritySwipeRef.current = null;
      return;
    }

    prioritySwipeRef.current = { pointerId: event.pointerId, x: event.clientX, y: event.clientY, captured: false };
  }

  function handlePriorityPointerMove(event: ReactPointerEvent<HTMLDivElement>) {
    const start = prioritySwipeRef.current;
    if (!start || start.captured || start.pointerId !== event.pointerId) return;

    const deltaX = event.clientX - start.x;
    const deltaY = event.clientY - start.y;
    if (Math.abs(deltaX) < PRIORITY_SWIPE_THRESHOLD || Math.abs(deltaX) <= Math.abs(deltaY)) return;
    if (typeof event.currentTarget.setPointerCapture !== "function") return;

    try {
      event.currentTarget.setPointerCapture(event.pointerId);
      start.captured = true;
    } catch {
      // Pointer capture is unavailable in some DOM implementations.
    }
  }

  function handlePriorityPointerUp(event: ReactPointerEvent<HTMLDivElement>) {
    const start = prioritySwipeRef.current;
    if (!start || start.pointerId !== event.pointerId) return;
    prioritySwipeRef.current = null;

    const deltaX = event.clientX - start.x;
    const deltaY = event.clientY - start.y;
    if (Math.abs(deltaX) < PRIORITY_SWIPE_THRESHOLD || Math.abs(deltaX) <= Math.abs(deltaY)) return;

    suppressSwipeClickRef.current = true;
    shiftPriorityPage(deltaX < 0 ? 1 : -1);
  }

  function shiftPriorityPage(direction: number) {
    setPriorityState((current) => {
      const page = current.sequence === assignmentSequence ? current.page : 0;
      return {
        sequence: assignmentSequence,
        page: Math.max(0, Math.min(priorityPageCount - 1, page + direction)),
      };
    });
  }

  function handlePriorityClickCapture(event: ReactMouseEvent<HTMLDivElement>) {
    if (!suppressSwipeClickRef.current || event.detail === 0) return;
    suppressSwipeClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }

  function handleAskSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submittedQuestion = question.trim();
    if (!submittedQuestion) return;

    if (onAskAssistant(submittedQuestion) === false) return;
    setQuestion("");
  }

  return (
    <section className="dashboard-summary dashboard-study-brief" aria-labelledby="dashboard-summary-title">
      <div className="dashboard-study-summary">
        <div className="dashboard-study-heading">
          <span className="dashboard-study-sparkle"><Sparkles size={18} aria-hidden="true" /></span>
          <span className="dashboard-study-sender">Edu AI</span>
          <span className="dashboard-study-sample">Sample</span>
        </div>
        <h2 id="dashboard-summary-title" className="dashboard-study-title">Your study summary</h2>
        <p className="dashboard-study-lead">
          <span className="dashboard-study-copy-reserve" aria-hidden="true">{STUDY_SUMMARY}</span>
          <span className="dashboard-study-copy-animated" aria-hidden="true">
            {STUDY_SUMMARY.slice(0, summaryCharacters)}
            {summaryCharacters < STUDY_SUMMARY.length && <span className="dashboard-study-caret" />}
          </span>
          <span className="dashboard-study-screen-reader-copy">{STUDY_SUMMARY}</span>
        </p>
        <div className="dashboard-study-footer">
          <form className="dashboard-study-ask" onSubmit={handleAskSubmit}>
            <input
              className="dashboard-study-ask-input"
              type="text"
              aria-label="Ask Edu AI"
              placeholder="Ask Edu AI…"
              maxLength={8000}
              value={question}
              onChange={(event) => setQuestion(event.currentTarget.value)}
            />
            <button className="dashboard-study-ask-submit" type="submit" aria-label="Send question" disabled={!question.trim()}>
              <ArrowUp size={17} aria-hidden="true" />
            </button>
          </form>
          <button
            className="dashboard-study-open"
            type="button"
            title="Open assistant"
            aria-label="Open assistant"
            onClick={() => onOpenAssistant(question.trim())}
          >
            <MessageSquare size={18} aria-hidden="true" />
          </button>
        </div>
      </div>

      <aside className="dashboard-focus" aria-labelledby="dashboard-priorities-title">
        <div className="dashboard-focus-heading">
          <h2 id="dashboard-priorities-title">Your priorities</h2>
          <div className="dashboard-focus-counts" aria-label="Assignment status summary">
            <span><i className="dashboard-dot overdue" />{overdueCount} overdue</span>
            <span><i className="dashboard-dot today" />{dueTodayCount} due today</span>
            <span><i className="dashboard-dot done" />{completedThisWeek} done this week</span>
          </div>
        </div>
        {focusAssignments.length ? (
          <>
            <div
              className="dashboard-focus-viewport"
              onPointerDown={handlePriorityPointerDown}
              onPointerMove={handlePriorityPointerMove}
              onPointerUp={handlePriorityPointerUp}
              onPointerCancel={() => { prioritySwipeRef.current = null; }}
              onClickCapture={handlePriorityClickCapture}
            >
              <ol
                id="dashboard-priority-list"
                className="dashboard-focus-list"
                start={priorityStartIndex + 1}
                aria-label="Prioritized assignments"
              >
                {visiblePriorities.map((assignment, index) => {
                  const globalIndex = priorityStartIndex + index;
                  return (
                    <li
                      key={assignment.id}
                      className={globalIndex === 0 ? "dashboard-focus-priority-first" : undefined}
                      aria-posinset={globalIndex + 1}
                      aria-setsize={focusAssignments.length}
                    >
                      <button type="button" className="dashboard-focus-item" onClick={() => onSelectAssignment(assignment)}>
                        <span className="dashboard-focus-number">{String(globalIndex + 1).padStart(2, "0")}</span>
                        <span className="dashboard-focus-label">
                          <strong>{assignment.title}</strong>
                          <small>{courseCodeFor(assignment.courseId)} · {assignment.dateKey ? assignment.due : "No due date"}</small>
                          <span className="dashboard-focus-rationale">{priorityAdvice(assignment)}</span>
                        </span>
                        {renderStatusBadge(assignment.status)}
                        <ChevronRight size={16} aria-hidden="true" />
                      </button>
                    </li>
                  );
                })}
              </ol>
            </div>
            {focusAssignments.length > PRIORITIES_PER_PAGE && (
              <div className="dashboard-focus-pagination" role="group" aria-label="Priority pages">
                <button
                  type="button"
                  className="dashboard-focus-page-button"
                  aria-label="Previous priorities"
                  aria-controls="dashboard-priority-list"
                  disabled={priorityPage === 0}
                  onClick={() => shiftPriorityPage(-1)}
                >
                  <ChevronLeft size={16} aria-hidden="true" />
                </button>
                <span className="dashboard-focus-range" aria-live="polite" aria-atomic="true">
                  {priorityRangeLabel}
                </span>
                <button
                  type="button"
                  className="dashboard-focus-page-button"
                  aria-label="Next priorities"
                  aria-controls="dashboard-priority-list"
                  disabled={priorityPage >= priorityPageCount - 1}
                  onClick={() => shiftPriorityPage(1)}
                >
                  <ChevronRight size={16} aria-hidden="true" />
                </button>
              </div>
            )}
          </>
        ) : (
          <div className="dashboard-focus-empty">
            <CheckCircle2 size={28} aria-hidden="true" />
            <strong>{courseCount ? "You’re all caught up." : "Let’s get your semester set up."}</strong>
            <p>{courseCount ? "No outstanding assignments. Make room for a little review—or a break." : "Add a class or import a syllabus to see your next steps here."}</p>
            <button className="text-button" type="button" onClick={courseCount ? onAddAssignment : onAddClass}>
              {courseCount ? "Add an assignment" : "Add your first class"}<ArrowRight size={14} aria-hidden="true" />
            </button>
          </div>
        )}
      </aside>
    </section>
  );
}
