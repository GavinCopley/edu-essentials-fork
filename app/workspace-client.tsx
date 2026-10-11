"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  AlertOctagon,
  ArrowLeft,
  ArrowRight,
  BarChart3,
  Bell,
  BookOpen,
  CalendarDays,
  CheckCircle2,
  ChevronRight,
  ChevronLeft,
  ChevronDown,
  Circle,
  Clock3,
  Copy,
  FileSearch,
  FileText,
  FlaskConical,
  Flame,
  FolderOpen,
  GraduationCap,
  House,
  LayoutGrid,
  List,
  Maximize2,
  Menu,
  PanelLeftClose,
  PanelLeftOpen,
  MoreHorizontal,
  Pencil,
  PieChart,
  Plus,
  Quote as QuoteIcon,
  Search,
  MessageSquare,
  Send,
  Save,
  Upload,
  Settings,
  SlidersHorizontal,
  StickyNote,
  Sun,
  Target,
  TimerReset,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from "react";
import { Autosave, SaveFailure, canonicalJson } from "../lib/autosave";
import { SIDEBAR_COLLAPSED_STORAGE_KEY } from "../lib/sidebar-preference";
import { downloadDraft, useSaveProtection } from "./use-save-protection";
import { usePreferences } from "./use-preferences";
import AcademicEditor from "./academic-editor";
import SyllabusReview from "./syllabus-review";
import { SyllabusAttachment, SyllabusTextPreview, type SyllabusAttachmentValue } from "./course-syllabus";
import AcademicCalendar from "./academic-calendar";
import { usePrivateFiles } from "./use-private-files";
import { useFileActivity } from "./use-file-activity";
import { useFileUploads } from "./use-file-uploads";
import FileUploadDialog, { type PendingFolderUpload } from "./file-upload-dialog";
import FilesBrowser from "./files-browser";
import {
  DEFAULT_FILES_BROWSER_PREFERENCES,
  FILES_BROWSER_APPEARANCE_VERSION,
  migrateFilesBrowserPreferences,
  type FilesBrowserPreferences,
} from "../lib/files-browser";
import { restoreTrashItems, type TrashUndoReceipt } from "../lib/files-trash-operations";
import { NativeDocumentEditor } from "./native-document-editor";
import type { NativeDocumentCreate } from "../lib/native-documents";
import { FileEditor, FileList, FilePreview, PrivateImage } from "./private-files";
import { fileSize, type PrivateFile, type FileMetadata } from "../lib/files";
import StudyWidget, { studyWidgetTypes } from "./study-widgets";
import ReorderableWidgetGrid from "./reorderable-widget-grid";
import WidgetCustomization from "./widget-customization";
import HomeLoadTransition from "./home-load-transition";
import { HomeGreeting, type HomeSkeletonGreeting } from "./home-skeleton";
import {
  cacheLayoutsMatch,
  createHomeSkeletonLayout,
  DEFAULT_HOME_SKELETON_LAYOUT,
  layoutsMatch,
  readHomeSkeletonLayout,
  writeHomeSkeletonLayout,
  type HomeSkeletonGeometry,
  type HomeSkeletonLayout,
} from "../lib/home-skeleton";
import TodaySection from "./today-section";
import { defaultTodaySections, type TodaySectionId } from "../lib/today-sections";
import { resolveWidgetAppearance, widgetAppearanceStyle, type WidgetAppearance, type WidgetAppearanceState } from "../lib/widget-appearance";
import StudyPanel from "./study-panel";
import { useStudyStats } from "./use-study-stats";
import { emptyStudy, settleTimer, timerAction, goalPercent, durationLabel, completedInWeek, detachStudyCourse, segmentSeconds, type StudyData, type TimerKind } from "../lib/study";
import { academicSnapshot, validateAcademicEdit } from "../lib/academic-snapshot";
import { dayKey, dateLabel, addDays, weekStart, assignmentStatus, legacyEventTime, emptyCourse, emptyCourseDetails, type Course, type CourseDetails, type SyllabusDraft } from "../lib/academics";
import { experimentalData, type ExperimentalDensity } from "../lib/experimental-data";
import OnboardingFlow from "./onboarding-flow";
import type { SavedAssignment, SavedEvent, WorkspaceData } from "../lib/workspace-codec";
import ProfileEditor from "./profile-editor";
import AcademicAssistant from "./academic-assistant";
import SaveToast from "./save-toast";
import type { Profile } from "../lib/profile";
import "./auth.css";
import "./reference-ui.css";
import "./home-skeleton.css";
import "./widget-appearance.css";
import "./widget-block-layout.css";
import "./widget-reorder.css";
import { widgetSizeOptions, type WidgetResizePriority } from "../lib/widget-layout";
import { getWidgetKeyboardResizeSize } from "../lib/widget-resize";
import {
  decodeWorkspaceState,
  encodeWorkspaceState,
  MAX_WORKSPACES,
  MAX_WIDGETS_PER_WORKSPACE,
  MAX_NOTES_LENGTH,
  type WidgetInstance,
  type WidgetSize,
  type WidgetType,
  type Workspace,
} from "../lib/workspace-codec";

type PageId = "home" | "dashboard" | "calendar" | "tasks" | "search" | "files" | "settings" | "assistant";
type Stoplight = "overdue" | "today" | "later" | "done";

type Assignment = SavedAssignment;

function appearanceAttributes(appearance: WidgetAppearance) {
  return {
    "data-wa-icon-style": appearance.iconStyle,
    "data-wa-show-icons": String(appearance.showIcons),
    "data-wa-header-divider": String(appearance.headerDivider),
    "data-wa-accent-edge": appearance.accentEdge,
    "data-wa-hover": appearance.hover,
    "data-wa-content-mode": appearance.contentMode,
    "data-wa-title-align": appearance.titleAlign,
    "data-wa-texture": appearance.texture,
  };
}

type WorkspaceResponse = {
  initialized: boolean;
  courses?: Course[];
  dashboard?: unknown;
  revision?: string | null;
  profile?: Profile;
  error?: string;
};

const navItems: { id: PageId; label: string; icon: typeof House }[] = [
  { id: "home", label: "Home", icon: House },
  { id: "dashboard", label: "Courses", icon: BookOpen },
  { id: "calendar", label: "Calendar", icon: CalendarDays },
  { id: "tasks", label: "Tasks", icon: CheckCircle2 },
  { id: "files", label: "Files", icon: FolderOpen },
  { id: "assistant", label: "Ask Edu", icon: MessageSquare },
];

const pageIds = new Set<PageId>(["home", "dashboard", "calendar", "tasks", "search", "files", "settings", "assistant"]);

function pageFromPathname(pathname: string): PageId {
  const segment = pathname.split("/").filter(Boolean)[0] as PageId | undefined;
  return segment && pageIds.has(segment) ? segment : "home";
}

const widgetTemplates: { type: WidgetType; title: string; description: string; icon: typeof Target; color: string; defaultSize: WidgetSize }[] = [
  { type: "daily-goal", title: "Daily study goal", description: "Progress ring and time remaining", icon: Target, color: "indigo", defaultSize: "medium" },
  { type: "weekly-goal", title: "Weekly study goal", description: "Seven-day progress overview", icon: BarChart3, color: "sky", defaultSize: "medium" },
  { type: "upcoming", title: "Upcoming assignments", description: "Your next deadlines in order", icon: List, color: "violet", defaultSize: "large" },
  { type: "stoplight", title: "Stoplight assignments", description: "Work grouped by urgency", icon: SlidersHorizontal, color: "coral", defaultSize: "medium" },
  { type: "red-alerts", title: "Red-light alerts", description: "Overdue and due today only", icon: AlertOctagon, color: "red", defaultSize: "medium" },
  { type: "mini-calendar", title: "Mini calendar", description: "A compact look at your week", icon: CalendarDays, color: "blue", defaultSize: "medium" },
  { type: "pomodoro", title: "Pomodoro timer", description: "Focused 25-minute sessions", icon: TimerReset, color: "tomato", defaultSize: "small" },
  { type: "focus-timer", title: "Focus timer", description: "Minimal countdown for deep work", icon: Clock3, color: "navy", defaultSize: "small" },
  { type: "task-completion", title: "Task completion", description: "Track work across all classes", icon: CheckCircle2, color: "green", defaultSize: "medium" },
  { type: "assignment-pie", title: "Assignment pie chart", description: "Workload split by class", icon: PieChart, color: "purple", defaultSize: "medium" },
  { type: "gpa", title: "GPA tracker", description: "Current GPA and term trend", icon: GraduationCap, color: "gold", defaultSize: "small" },
  { type: "class-links", title: "Class quick links", description: "Jump into your courses", icon: BookOpen, color: "teal", defaultSize: "medium" },
  { type: "notes", title: "Quick notes", description: "An editable scratchpad", icon: StickyNote, color: "yellow", defaultSize: "medium" },
  { type: "exams", title: "Upcoming exams", description: "Countdowns for important tests", icon: FileSearch, color: "rose", defaultSize: "medium" },
  { type: "streak", title: "Study streak", description: "Keep your momentum going", icon: Flame, color: "orange", defaultSize: "small" },
  { type: "today", title: "Today at a glance", description: "Agenda, classes, and deadlines", icon: Sun, color: "blue", defaultSize: "large" },
  { type: "quote", title: "Daily motivation", description: "A calm reminder to keep going", icon: QuoteIcon, color: "lilac", defaultSize: "medium" },
  { type: "spacer", title: "Empty spacer", description: "Create breathing room in your layout", icon: Maximize2, color: "neutral", defaultSize: "small" },
];

const defaultWorkspaces: Workspace[] = [
  {
    id: "my-day",
    name: "My Day",
    widgets: [
      { instanceId: "w1", type: "daily-goal", size: "medium" },
      { instanceId: "w2", type: "today", size: "large" },
      { instanceId: "w3", type: "red-alerts", size: "medium" },
      { instanceId: "w4", type: "pomodoro", size: "small" },
      { instanceId: "w5", type: "mini-calendar", size: "medium" },
      { instanceId: "w6", type: "task-completion", size: "medium" },
      { instanceId: "w7", type: "notes", size: "medium" },
    ],
  },
  {
    id: "study-mode",
    name: "Study Mode",
    widgets: [
      { instanceId: "w8", type: "pomodoro", size: "medium" },
      { instanceId: "w9", type: "upcoming", size: "large" },
      { instanceId: "w10", type: "weekly-goal", size: "medium" },
      { instanceId: "w11", type: "class-links", size: "medium" },
      { instanceId: "w12", type: "quote", size: "medium" },
    ],
  },
  {
    id: "finals-week",
    name: "Finals Week",
    widgets: [
      { instanceId: "w13", type: "exams", size: "medium" },
      { instanceId: "w14", type: "stoplight", size: "large" },
      { instanceId: "w15", type: "assignment-pie", size: "medium" },
      { instanceId: "w16", type: "streak", size: "small" },
    ],
  },
];

const statusMeta: Record<Stoplight, { label: string; short: string; icon: typeof Circle }> = {
  overdue: { label: "Overdue", short: "Past due", icon: AlertOctagon },
  today: { label: "Due today", short: "Today", icon: Clock3 },
  later: { label: "Due later", short: "Upcoming", icon: Circle },
  done: { label: "Completed", short: "Done", icon: CheckCircle2 },
};

async function workspaceFetch(input: string, init?: RequestInit) {
  const signal = init?.signal ? AbortSignal.any([init.signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000);
  const response = await fetch(input, { ...init, signal });
  if (response.status === 401) throw new SaveFailure("Your session ended or the account changed. Sign in to the same account in a new tab, then retry. Your edits are still here.", "session-error");
  if (response.status === 403) throw new SaveFailure("Your account could not access this workspace. Your edits are still here. Reload after checking your account.", "session-error");
  return response;
}

function uid(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`;
}

function courseFor(courses: Course[], id: string) {
  return courses.find((course) => course.id === id) ?? { id, code: "Personal", name: "Personal", credits: 0, instructor: "", room: "", color: "#5b63e8", soft: "#eef0ff", initials: "P" };
}

function StatusBadge({ status, compact = false }: { status: Stoplight; compact?: boolean }) {
  const meta = statusMeta[status];
  const Icon = meta.icon;
  return (
    <span className={`status-badge status-${status}`} aria-label={meta.label}>
      <Icon size={compact ? 13 : 14} strokeWidth={2.4} aria-hidden="true" />
      {!compact && <span>{meta.short}</span>}
    </span>
  );
}

function CourseStamp({ course, small = false }: { course: Course; small?: boolean }) {
  return (
    <span className={`course-stamp ${small ? "small" : ""}`} style={{ background: course.soft, color: course.color }} aria-hidden="true">
      {course.initials}
    </span>
  );
}

export default function EduEssentialsApp({ initialProfile, children, filesBrowserEnabled = false }: { initialProfile: Profile; children?: React.ReactNode; filesBrowserEnabled?: boolean }) {
  const pathname = usePathname();
  const router = useRouter();
  const page = pageFromPathname(pathname);
  const [profile, setProfile] = useState(initialProfile);
  const [homeSkeletonCache, setHomeSkeletonCache] = useState<{
    accountId: string | null;
    layout: HomeSkeletonLayout;
    readable: boolean;
    cached: boolean;
  }>({ accountId: null, layout: DEFAULT_HOME_SKELETON_LAYOUT, readable: false, cached: false });
  const [homeSkeletonMeasurement, setHomeSkeletonMeasurement] = useState<{
    accountId: string;
    workspaceId: string;
    layout: HomeSkeletonLayout;
    geometry: HomeSkeletonGeometry;
  } | null>(null);
  useLayoutEffect(() => {
    const cached = readHomeSkeletonLayout(initialProfile.id);
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Restore the visual-only cache before the first client paint.
    setHomeSkeletonCache({
      accountId: initialProfile.id,
      layout: cached.layout ?? DEFAULT_HOME_SKELETON_LAYOUT,
      readable: cached.readable,
      cached: cached.layout !== null,
    });
  }, [initialProfile.id]);
  const homeSkeletonRestored = homeSkeletonCache.accountId === initialProfile.id;
  const homeSkeletonLayout = homeSkeletonRestored ? homeSkeletonCache.layout : DEFAULT_HOME_SKELETON_LAYOUT;
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [storedSidebarCollapsed, setStoredSidebarCollapsed] = useState<boolean | null>(null);
  const sidebarCollapsed = storedSidebarCollapsed ?? false;
  useLayoutEffect(() => {
    let collapsed = false;
    try {
      collapsed = window.localStorage.getItem(SIDEBAR_COLLAPSED_STORAGE_KEY) === "true";
    } catch {
      /* Expanded navigation remains available without browser storage. */
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Restore before repaint to match the pre-hydration sidebar state.
    setStoredSidebarCollapsed(collapsed);
  }, []);
  useLayoutEffect(() => {
    if (storedSidebarCollapsed !== null) {
      document.documentElement.removeAttribute("data-sidebar-collapsed");
    }
  }, [storedSidebarCollapsed]);
  const toggleSidebar = () => {
    const collapsed = !sidebarCollapsed;
    setStoredSidebarCollapsed(collapsed);
    try { window.localStorage.setItem(SIDEBAR_COLLAPSED_STORAGE_KEY, String(collapsed)); }
    catch { /* Keep the preference for this session even if it cannot be stored. */ }
  };
  const [experimentalMenuOpen, setExperimentalMenuOpen] = useState(false);
  const [onboardingTest, setOnboardingTest] = useState(false);
  const [experimentalMode, setExperimentalMode] = useState<ExperimentalDensity | null>(null);
  const [experimentalRestoring, setExperimentalRestoring] = useState(false);
  usePreferences(profile.preferences);
  const studentName = profile.display_name;
  const [courses, setCourses] = useState<Course[]>([]);
  const [storedAssignments, setAssignments] = useState<Assignment[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>(defaultWorkspaces);
  const [activeWorkspaceId, setActiveWorkspaceId] = useState("my-day");
  const [widgetPickerOpen, setWidgetPickerOpen] = useState(false);
  const [customizing, setCustomizing] = useState(false);
  const customizeButtonRef = useRef<HTMLButtonElement>(null);
  const workspaceOptionsButtonRef = useRef<HTMLButtonElement>(null);
  const todayOptionsButtonRef = useRef<HTMLButtonElement>(null);
  const todayRemoveTargetRef = useRef<HTMLDivElement>(null);
  const todayRemoveHitRef = useRef<HTMLDivElement>(null);
  const [todayRemoveDragState, setTodayRemoveDragState] = useState({ active: false, over: false, near: false });
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const closeAppearance = useCallback(() => setAppearanceOpen(false), []);
  const [miniWeekOffset, setMiniWeekOffset] = useState(0);
  const [widgetSearch, setWidgetSearch] = useState("");
  const [openWidgetMenu, setOpenWidgetMenu] = useState<string | null>(null);
  const [closingWidgetMenu, setClosingWidgetMenu] = useState(false);
  const closeWidgetMenu = useCallback(() => { setClosingWidgetMenu(false); setOpenWidgetMenu(null); }, []);
  const dismissWidgetMenu = useCallback(() => setClosingWidgetMenu(true), []);
  const widgetMenuRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!openWidgetMenu || !closingWidgetMenu) return;
    // Also clean up when animation events are unavailable or interrupted.
    const timeout = window.setTimeout(closeWidgetMenu, 130);
    return () => window.clearTimeout(timeout);
  }, [openWidgetMenu, closingWidgetMenu, closeWidgetMenu]);
  useLayoutEffect(() => {
    const menu = widgetMenuRef.current;
    if (!openWidgetMenu || !menu) return;
    const card = menu.parentElement;
    const anchor = card?.querySelector<HTMLElement>(".widget-header .menu-wrap > button");
    if (!card || !anchor) return;
    const grid = menu.closest(".widget-grid");
    const referenceRoot = menu.closest(".reference-ui") ?? document;
    const mobileHeader = referenceRoot.querySelector<HTMLElement>(".mobile-header");
    const mobileBottomNav = referenceRoot.querySelector<HTMLElement>(".mobile-bottom-nav");
    const placeMenu = () => {
      const viewportWidth = document.documentElement.clientWidth || window.innerWidth;
      const viewportHeight = document.documentElement.clientHeight || window.innerHeight;
      let minTop = 12;
      let maxBottom = viewportHeight - 12;
      const headerRect = mobileHeader?.getBoundingClientRect();
      if (headerRect && headerRect.height > 0 && headerRect.top <= 0 && headerRect.bottom > 0) {
        minTop = Math.max(minTop, headerRect.bottom + 12);
      }
      const navRect = mobileBottomNav?.getBoundingClientRect();
      if (navRect && navRect.height > 0 && navRect.top < viewportHeight && navRect.bottom >= viewportHeight) {
        maxBottom = Math.min(maxBottom, navRect.top - 12);
      }
      const maxMenuHeight = Math.max(0, maxBottom - minTop);
      menu.style.setProperty("--widget-menu-available-width", `${Math.max(0, viewportWidth - 24)}px`);
      menu.style.maxHeight = `${maxMenuHeight}px`;
      const width = menu.offsetWidth || Math.min(240, Math.max(0, viewportWidth - 24));
      const rect = anchor.getBoundingClientRect();
      const cardRect = card.getBoundingClientRect();
      const gridRect = grid?.getBoundingClientRect();
      const cardCenter = cardRect.left + cardRect.width / 2;
      const gridCenter = gridRect ? gridRect.left + gridRect.width / 2 : viewportWidth / 2;
      const preferredLeft = cardCenter < gridCenter ? rect.left : rect.right - width;
      const left = Math.max(12, Math.min(preferredLeft, viewportWidth - width - 12));
      const belowTop = rect.bottom + 4;
      const belowSpace = Math.max(0, maxBottom - belowTop);
      const aboveTop = rect.top - 4 - menu.offsetHeight;
      const aboveSpace = Math.max(0, rect.top - 4 - minTop);
      let top = belowTop;
      if (belowTop < minTop || belowTop + menu.offsetHeight > maxBottom) {
        top = aboveTop >= minTop
          ? aboveTop
          : (aboveSpace > belowSpace ? aboveTop : belowTop);
      }
      top = Math.max(minTop, Math.min(top, maxBottom - menu.offsetHeight));
      menu.style.left = `${left - cardRect.left - card.clientLeft}px`;
      menu.style.right = "auto";
      menu.style.top = `${top - cardRect.top - card.clientTop}px`;
    };
    const dismissMenu = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!menu.contains(target) && !anchor.contains(target)) dismissWidgetMenu();
    };
    placeMenu();
    document.addEventListener("click", dismissMenu, true);
    window.addEventListener("resize", placeMenu);
    document.addEventListener("scroll", placeMenu, true);
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(placeMenu);
    if (grid) observer?.observe(grid);
    observer?.observe(card);
    observer?.observe(menu);
    return () => { document.removeEventListener("click", dismissMenu, true); window.removeEventListener("resize", placeMenu); document.removeEventListener("scroll", placeMenu, true); observer?.disconnect(); };
  }, [openWidgetMenu, sidebarCollapsed, dismissWidgetMenu]);
  const [workspaceMenuOpen, setWorkspaceMenuOpen] = useState(false);
  const [workspaceDialog, setWorkspaceDialog] = useState<"new" | "rename" | null>(null);
  const [workspaceNameDraft, setWorkspaceNameDraft] = useState("");
  const [studyOpen, setStudyOpen] = useState(false);
  const [aiApplying, setAiApplying] = useState(false);
  const aiApplyLock = useRef(false);
  const [notes, setNotes] = useState("");
  const noteFocusRef = useRef<string | null>(null);
  const [dashboardView, setDashboardView] = useState<"cards" | "list">("cards");
  const [selectedClass, setSelectedClass] = useState<Course | null>(null);
  const [selectedAssignment, setSelectedAssignment] = useState<Assignment | null>(null);
  const [addClassOpen, setAddClassOpen] = useState(false);
  const [editor, setEditor] = useState<{ course?: Course; details?: CourseDetails; assignment?: Assignment; event?: SavedEvent } | null>(null);
  const [syllabusId, setSyllabusId] = useState<string | null>(null);
  const [syllabusAttachment, setSyllabusAttachment] = useState<{ courseId: string; folderId: string | null } | null>(null);
  const [syllabusTextCourseId, setSyllabusTextCourseId] = useState<string | null>(null);
  const [syllabusPreviewFileId, setSyllabusPreviewFileId] = useState<string | null>(null);
  const workspaceLoadGeneration = useRef(0);
  const [extraData, setExtraData] = useState<{ courseDetails: Record<string, CourseDetails>; syllabusDrafts: SyllabusDraft[]; study: StudyData; filePreferences: FilesBrowserPreferences; widgetAppearance?: WidgetAppearanceState }>({ courseDetails: {}, syllabusDrafts: [], study: emptyStudy(), filePreferences: DEFAULT_FILES_BROWSER_PREFERENCES });
  const [now, setNow] = useState(() => new Date());
  const today = dayKey(now, profile.timezone);
  const assignments = storedAssignments.map((item) => ({ ...item, status: assignmentStatus(item, today), due: dateLabel(item.dateKey) })).sort((a, b) => a.dateKey.localeCompare(b.dateKey) || (a.dueTime ?? "").localeCompare(b.dueTime ?? ""));
  const [calendarFilter, setCalendarFilter] = useState("all");
  const [manualEvents, setManualEvents] = useState<SavedEvent[]>([]);
  const [searchQuery, setSearchQuery] = useState("");
  const [fileQuery, setFileQuery] = useState("");
  const [filePreview, setFilePreview] = useState<PrivateFile | null>(null);
  const [filePreviewReadOnly, setFilePreviewReadOnly] = useState(false);
  const [fileDialog, setFileDialog] = useState<{ initial?: PrivateFile; defaults?: Partial<FileMetadata>; reviewId?: string } | null>(null);
  const [uploadDialog, setUploadDialog] = useState<{ profileId: string; folderId: string | null; courseId: string; generation: number; mode?: "files" | "folder" } | null>(null);
  const [pendingFolderUpload, setPendingFolderUpload] = useState<PendingFolderUpload | null>(null);
  const [filesDataRevision, setFilesDataRevision] = useState(0);
  const [nativeDocumentDialog, setNativeDocumentDialog] = useState<{ file?: PrivateFile; create?: NativeDocumentCreate; readOnly?: boolean } | null>(null);
  const [nativeDocumentDraft, setNativeDocumentDraft] = useState<{ fileId: string | null; name: string; body: string; dirty: boolean } | null>(null);
  const handleNativeDocumentDraft = useCallback((draft: typeof nativeDocumentDraft) => setNativeDocumentDraft(draft), []);
  const [organizationState, setOrganizationState] = useState<{ busy: boolean; dirty: boolean; draft: unknown } | null>(null);
  const handleOrganizationState = useCallback((state: typeof organizationState) => setOrganizationState(state), []);
  // A session generation also fences A → B → A account changes while a request is held.
  const [fileActionSession, setFileActionSession] = useState({ profileId: initialProfile.id, generation: 0 });
  if (fileActionSession.profileId !== initialProfile.id) setFileActionSession({ profileId: initialProfile.id, generation: fileActionSession.generation + 1 });
  const fileActionSessionRef = useRef(fileActionSession);
  const undoAbortRef = useRef<AbortController | null>(null);
  const [trashUndo, setTrashUndo] = useState<{ session: typeof fileActionSession; receipt: TrashUndoReceipt; busy: boolean; error: string; restored?: boolean; recovered?: boolean } | null>(null);
  const currentTrashUndo = trashUndo?.session === fileActionSession ? trashUndo : null;
  const undoBusy = !!currentTrashUndo?.busy;
  useLayoutEffect(() => { fileActionSessionRef.current = fileActionSession; undoAbortRef.current?.abort(); }, [fileActionSession]);
  useEffect(() => () => { undoAbortRef.current?.abort(); }, []);
  const handleTrashCompleted = useCallback((receipt: TrashUndoReceipt) => {
    if (fileActionSessionRef.current !== fileActionSession || receipt.profileId !== fileActionSession.profileId) return;
    setTrashUndo({ session: fileActionSession, receipt, busy: false, error: "" });
  }, [fileActionSession]);
  const handleLegacyTrashed = useCallback((file: PrivateFile) => handleTrashCompleted({ profileId: fileActionSession.profileId, items: [{ type: "file", id: file.id, file }], label: file.name }), [fileActionSession, handleTrashCompleted]);
  const fileStore = usePrivateFiles(initialProfile.id);
  const [toast, setToast] = useState<string | null>(null);
  const profileMajor = profile.major;
  const [reloadAttempt, setReloadAttempt] = useState(0);
  const [profilePending, setProfilePending] = useState(false);
  const [profileSaving, setProfileSaving] = useState(false);
  const [profileDraft, setProfileDraft] = useState(initialProfile);
  const handleProfileDraft = useCallback((draft: Profile, pending: boolean, busy: boolean) => { setProfileDraft(draft); setProfilePending(pending); setProfileSaving(busy); }, []);
  const accountFetch = useCallback((input: string, init?: RequestInit) => workspaceFetch(input, {
    ...init, headers: { ...Object.fromEntries(new Headers(init?.headers)), "x-profile-id": initialProfile.id },
  }), [initialProfile.id]);
  const [autosave] = useState(() => new Autosave(async (snapshot, baseRevision) => {
    const response = await accountFetch("/api/workspace", {
      method: "PUT", credentials: "same-origin", headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...JSON.parse(snapshot), baseRevision }),
    });
    if (response.status === 409) {
      const failure = await response.clone().json() as { code?: string; error?: string };
      if (failure.code === "syllabus-preservation") throw new SaveFailure(failure.error || "The old syllabus could not be preserved. Your changes are still here; free file space and retry.");
      // A matching readback acknowledges a lost response. Never adopt a newer
      // revision for different content, which would silently overwrite it.
      const readback = await accountFetch("/api/workspace", { cache: "no-store" });
      if (readback.ok) {
        const saved = await readback.json() as WorkspaceResponse;
        if (saved.dashboard && saved.revision) {
          const decoded = decodeWorkspaceState(saved.dashboard);
          const canonical = canonicalJson(academicSnapshot(saved.courses ?? [], encodeWorkspaceState(decoded.workspaces, decoded.activeWorkspaceId, decoded.notes, decoded.data)));
          if (canonical === snapshot) return saved.revision;
        }
      }
      throw new SaveFailure("Another session saved different changes. Download your unsaved work before reloading the saved workspace.", "conflict");
    }
    const result = await response.json() as { revision?: string; error?: string };
    if (!response.ok || !result.revision) throw new SaveFailure(result.error || "Your changes could not be saved. Retry when your connection is available.");
    return result.revision;
  }));
  const saveState = useSyncExternalStore(autosave.subscribe, autosave.getSnapshot, autosave.getSnapshot);
  const persistenceStatus = saveState.status;
  const canWriteFiles = !experimentalMode && saveState.ready && !saveState.dirty && !undoBusy;
  const refreshFiles = fileStore.refresh;
  const handleUploadSaved = useCallback(async (_file: PrivateFile, signal: AbortSignal) => {
    await refreshFiles(signal, true);
    if (!signal.aborted) setFilesDataRevision((revision) => revision + 1);
  }, [refreshFiles]);
  const fileUploads = useFileUploads(fileActionSession, fileStore, handleUploadSaved, canWriteFiles && !profilePending && !organizationState && !nativeDocumentDialog);
  const fileActivity = useFileActivity(fileActionSession, !experimentalMode && saveState.ready && !profilePending, refreshFiles);
  const handleFileOpened = fileActivity.opened;
  const handleNativeDocumentSaved = useCallback((file: PrivateFile) => { handleFileOpened(file); void refreshFiles(); }, [handleFileOpened, refreshFiles]);
  const closeNativeDocument = useCallback(() => { setNativeDocumentDialog(null); setNativeDocumentDraft(null); void refreshFiles(); }, [refreshFiles]);
  const handleOrganizationSaved = useCallback(async (signal?: AbortSignal) => { await refreshFiles(signal, true); }, [refreshFiles]);
  const undoTrash = async () => {
    if (!currentTrashUndo || undoBusy || !canWriteFiles || profilePending || organizationState || nativeDocumentDialog || fileStore.busy) return;
    const captured = currentTrashUndo;
    let acknowledged = captured;
    const controller = new AbortController(); undoAbortRef.current = controller;
    setTrashUndo({ ...captured, busy: true, error: "" });
    try {
      if (!captured.restored) {
        const result = await restoreTrashItems(captured.receipt.profileId, captured.receipt.items, { signal: controller.signal });
        acknowledged = { ...captured, restored: true, recovered: !!result.recoveryFolder };
      }
      if (controller.signal.aborted || fileActionSessionRef.current !== captured.session) return;
      await refreshFiles(controller.signal, true);
      if (controller.signal.aborted || fileActionSessionRef.current !== captured.session) return;
      setTrashUndo(null);
      setToast(acknowledged.recovered ? "Restored to Restored files because the original location is unavailable." : "Restored from Trash.");
    } catch (error) {
      if (!controller.signal.aborted && fileActionSessionRef.current === captured.session) setTrashUndo({ ...acknowledged, busy: false, error: acknowledged.restored ? "The restore was saved, but Files could not refresh. Retry Files refresh; the restore will not be repeated." : error instanceof Error ? error.message : "Could not restore these items. Retry Undo or review Trash." });
    } finally {
      if (undoAbortRef.current === controller) undoAbortRef.current = null;
      if (controller.signal.aborted && fileActionSessionRef.current === captured.session) setTrashUndo((current) => current?.receipt === captured.receipt ? { ...current, busy: false } : current);
    }
  };
  useEffect(() => { if (saveState.status === "saved") void refreshFiles(); }, [saveState.status, refreshFiles]);
  useSaveProtection(saveState.dirty || profilePending || fileUploads.dirty || fileUploads.busy || !!pendingFolderUpload || !!nativeDocumentDraft?.dirty || !!organizationState?.dirty || !!organizationState?.busy || undoBusy);
  const topSearchRef = useRef<HTMLInputElement | null>(null);
  const study = extraData.study;
  const activeGpaSystem = experimentalMode ? "4.0 scale" : profile.gpa_system;
  const activeTerm = experimentalMode ? "Current term" : profile.current_term;
  const timezone = profile.timezone, monday = profile.week_starts_on === "Monday";
  const localTime = new Intl.DateTimeFormat("en-GB", { timeZone: timezone || undefined, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
  const currentHour = Number(localTime.slice(0, 2));
  const homeGreeting: HomeSkeletonGreeting = {
    greeting: currentHour < 12 ? "Good morning" : currentHour < 18 ? "Good afternoon" : "Good evening",
    studentName,
    dateLabel: dateLabel(today, { weekday: "long", month: "long", day: "numeric", year: "numeric" }),
  };
  const stats = useStudyStats(study.sessions, today, timezone, monday);
  const dailyPercent = goalPercent(stats.dailySeconds, study.dailyMinutes), weeklyPercent = goalPercent(stats.weeklySeconds, study.weeklyMinutes);
  const weeklyCompleted = completedInWeek(assignments, today, profile.timezone, profile.week_starts_on === "Monday");
  useEffect(() => {
    if (onboardingTest) return;
    // Completion consumes the active timer and adds its stable session ID in the
    // same account snapshot. Ticks alone never cause database writes.
    const tick = () => {
      const time = new Date(); setNow(time);
      if (saveState.ready && !aiApplyLock.current) setExtraData((current) => { const next = settleTimer(current.study, time.getTime()); return next === current.study ? current : { ...current, study: next }; });
    };
    const interval = setInterval(tick, 1000);
    window.addEventListener("focus", tick); document.addEventListener("visibilitychange", tick);
    return () => { clearInterval(interval); window.removeEventListener("focus", tick); document.removeEventListener("visibilitychange", tick); };
  }, [saveState.ready, onboardingTest]);

  useEffect(() => {
    if (!toast) return;
    const timeout = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(timeout);
  }, [toast]);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent) => {
      if (page === "files" && filesBrowserEnabled) return;
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        if (!appearanceOpen) topSearchRef.current?.focus();
      }
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, [appearanceOpen, filesBrowserEnabled, page]);

  useEffect(() => {
    const controller = new AbortController();
    const loadGeneration = ++workspaceLoadGeneration.current;
    autosave.loading();
    async function hydrateWorkspace() {
      try {
        const read = async () => {
          const response = await accountFetch("/api/workspace", { cache: "no-store", signal: controller.signal });
          const data = await response.json() as WorkspaceResponse;
          if (!response.ok) throw new Error(data.error || "Unable to load your workspace. Please retry.");
          return data;
        };
        let data = await read();
        if (!data.initialized) {
          const response = await accountFetch("/api/workspace", {
            method: "POST", headers: { "content-type": "application/json" }, signal: controller.signal,
            body: JSON.stringify({ action: "initialize", courses: [], dashboard: encodeWorkspaceState(defaultWorkspaces, "my-day", "", { assignments: [], manualEvents: [], dashboardView: "cards" }) }),
          });
          if (!response.ok) throw new Error("Unable to initialize your workspace. Please retry.");
          data = await read();
        }
        if (controller.signal.aborted) return;
        if (!data.dashboard || !data.profile || data.profile.id !== initialProfile.id) throw new Error("Your saved workspace is incomplete or belongs to another account. Please retry loading.");
        const decoded = decodeWorkspaceState(data.dashboard);
        const loadedDetails = decoded.data ?? { assignments: [], manualEvents: [], dashboardView: "cards" as const };
        const courseIds = new Set((data.courses ?? []).map((c) => c.id));
        const details = { ...loadedDetails, assignments: loadedDetails.assignments.map((a) => ({ ...a, courseId: courseIds.has(a.courseId) ? a.courseId : "" })), manualEvents: loadedDetails.manualEvents.map((e) => ({ ...e, time: legacyEventTime(e.time), courseId: courseIds.has(e.courseId) ? e.courseId : "" })), calendarFilter: (loadedDetails.calendarFilter === "all" || loadedDetails.calendarFilter === "personal") || courseIds.has(loadedDetails.calendarFilter ?? "") ? loadedDetails.calendarFilter! : "all", courseDetails: loadedDetails.courseDetails ?? {}, syllabusDrafts: loadedDetails.syllabusDrafts ?? [], study: loadedDetails.study ?? emptyStudy(), filePreferences: loadedDetails.filePreferences ?? DEFAULT_FILES_BROWSER_PREFERENCES };
        setProfile(data.profile); setProfileDraft(data.profile); setProfilePending(false);
        setCourses(data.courses ?? []); setWorkspaces(decoded.workspaces);
        setActiveWorkspaceId(decoded.activeWorkspaceId); setNotes(decoded.notes);
        setAssignments(details.assignments); setManualEvents(details.manualEvents);
        setDashboardView(details.dashboardView); setCalendarFilter(details.calendarFilter); setExtraData({ courseDetails: details.courseDetails, syllabusDrafts: details.syllabusDrafts, study: settleTimer(details.study, Date.now()), filePreferences: details.filePreferences, widgetAppearance: details.widgetAppearance }); setFileDialog(null); setFilePreview(null); setStudyOpen(false); setAppearanceOpen(false); setEditor(null); setSyllabusId(null);
        setSelectedClass(null); setSelectedAssignment(null); setSyllabusAttachment(null); setSyllabusTextCourseId(null); setSyllabusPreviewFileId(null);
        setExperimentalMode(null); setExperimentalMenuOpen(false); setExperimentalRestoring(false);
        autosave.hydrate(canonicalJson({ courses: [...(data.courses ?? [])].sort((a, b) => a.id.localeCompare(b.id)), dashboard: encodeWorkspaceState(decoded.workspaces, decoded.activeWorkspaceId, decoded.notes, details) }), data.revision ?? null);
      } catch (error) { if (!controller.signal.aborted) { setExperimentalRestoring(false); autosave.loadFailed(error); } }
    }
    void hydrateWorkspace();
    return () => { controller.abort(); workspaceLoadGeneration.current = loadGeneration + 1; autosave.stop(); };
  }, [reloadAttempt, accountFetch, autosave, initialProfile.id]);

  useEffect(() => {
    if (experimentalMode || onboardingTest) return;
    try { autosave.change(canonicalJson(academicSnapshot(courses, encodeWorkspaceState(workspaces, activeWorkspaceId, notes, { assignments: storedAssignments, manualEvents, dashboardView, calendarFilter, ...extraData })))); }
    catch (error) { autosave.invalidate(error instanceof Error ? error.message : "Invalid workspace data."); }
  }, [activeWorkspaceId, notes, workspaces, storedAssignments, manualEvents, dashboardView, calendarFilter, extraData, courses, autosave, experimentalMode, onboardingTest]);

  const downloadUnsavedWork = () => downloadDraft("eduessentials-unsaved-work.json", { profile, settingsDraft: profileDraft, courses, assignments: storedAssignments, manualEvents, workspaces, activeWorkspaceId, notes, dashboardView, calendarFilter, nativeDocumentDraft, fileOrganizationDraft: organizationState?.draft, fileUploads: fileUploads.draft, pendingFolderUpload: pendingFolderUpload && { profileId: pendingFolderUpload.profileId, sessionGeneration: pendingFolderUpload.sessionGeneration, folderId: pendingFolderUpload.folderId, courseId: pendingFolderUpload.courseId, files: pendingFolderUpload.files.map(({ relativePath }) => relativePath), directories: pendingFolderUpload.directories.map(({ id, path, parentPath, created }) => ({ id, path, parentPath, created })) }, ...extraData });
  const reloadWorkspace = () => {
    if (fileUploads.dirty || fileUploads.busy || pendingFolderUpload) { flash("Finish or dismiss retained uploads before reloading. Review uploads to download the original selections."); return; }
    if (nativeDocumentDialog) { flash("Save or download your text draft and close its editor before reloading the workspace."); return; }
    if (organizationState) { flash("Close the Files dialog before reloading the workspace."); return; }
    if (undoBusy) { flash("Wait for Undo to finish before reloading the workspace."); return; }
    if (persistenceStatus === "saving" || profileSaving) return;
    if ((saveState.dirty || profilePending) && !window.confirm("Replace unsaved workspace and settings edits with saved data? Download your unsaved work first to keep a copy.")) return;
    setReloadAttempt((attempt) => attempt + 1);
  };

  const prepareAssistant = async () => {
    if (experimentalMode || profilePending || editor || syllabusId || syllabusAttachment || nativeDocumentDialog || organizationState || fileUploads.dirty || pendingFolderUpload || fileStore.busy || undoBusy) throw new Error("Save and close pending editors before asking the assistant.");
    await autosave.flush();
    const current = autosave.getSnapshot();
    if (!current.ready || current.dirty || current.status !== "saved") throw new Error("Wait for saving to finish, or resolve the workspace save message first.");
  };
  const applyAssistant = async (id: string) => {
    if (aiApplyLock.current) return;
    await prepareAssistant();
    aiApplyLock.current = true; setAiApplying(true);
    try {
      const response = await accountFetch("/api/ai/proposals", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id, action: "apply" }) });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error || "The changes could not be applied.");
      // Stop the old writer before hydration. Other tabs receive ordinary 409 conflicts.
      autosave.loading(); setReloadAttempt((n) => n + 1);
    } finally { aiApplyLock.current = false; setAiApplying(false); }
  };

  const activeWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId) ?? workspaces[0];
  const homeSkeletonBaseLayout = useMemo(
    () => createHomeSkeletonLayout(activeWorkspace, resolveWidgetAppearance(extraData.widgetAppearance).gap),
    [activeWorkspace, extraData.widgetAppearance],
  );
  const homeSkeletonServerLayout = useMemo(() => {
    if (homeSkeletonMeasurement?.accountId !== initialProfile.id
      || homeSkeletonMeasurement.workspaceId !== activeWorkspace.id
      || !layoutsMatch(homeSkeletonMeasurement.layout, homeSkeletonBaseLayout)) return homeSkeletonBaseLayout;
    return { ...homeSkeletonBaseLayout, geometry: homeSkeletonMeasurement.geometry };
  }, [activeWorkspace.id, homeSkeletonBaseLayout, homeSkeletonMeasurement, initialProfile.id]);
  useEffect(() => {
    if (page !== "home"
      || profile.id !== initialProfile.id
      || !saveState.ready
      || customizing
      || experimentalMode
      || onboardingTest
      || experimentalRestoring) return;

    const measureHomeGeometry = () => {
      const home = document.querySelector<HTMLElement>(".home-load-transition__content .home-page");
      const toolbar = home?.querySelector<HTMLElement>(".workspace-bar");
      if (!home || !toolbar) return;
      const homeRect = home.getBoundingClientRect();
      if (!homeRect.width || !toolbar.getBoundingClientRect().height) return;
      const today = home.querySelector<HTMLElement>(".home-today-panel");
      const todayHeight = today?.getBoundingClientRect().height ?? 0;
      const round = (value: number) => Math.round(value * 100) / 100;
      const geometry: HomeSkeletonGeometry = {
        viewportWidth: round(window.innerWidth),
        contentWidth: round(homeRect.width),
        todayHeight: round(todayHeight),
        toolbarHeight: round(toolbar.getBoundingClientRect().height),
      };
      setHomeSkeletonMeasurement((current) => {
        if (current?.accountId === initialProfile.id
          && current.workspaceId === activeWorkspace.id
          && layoutsMatch(current.layout, homeSkeletonBaseLayout)
          && Math.abs(current.geometry.viewportWidth - geometry.viewportWidth) < 0.1
          && Math.abs(current.geometry.contentWidth - geometry.contentWidth) < 0.1
          && Math.abs(current.geometry.todayHeight - geometry.todayHeight) < 0.1
          && Math.abs(current.geometry.toolbarHeight - geometry.toolbarHeight) < 0.1) return current;
        return {
          accountId: initialProfile.id,
          workspaceId: activeWorkspace.id,
          layout: homeSkeletonBaseLayout,
          geometry,
        };
      });
    };

    measureHomeGeometry();
    window.addEventListener("resize", measureHomeGeometry);
    const home = document.querySelector<HTMLElement>(".home-load-transition__content .home-page");
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measureHomeGeometry);
    if (home) observer?.observe(home);
    const toolbar = home?.querySelector<HTMLElement>(".workspace-bar");
    if (toolbar) observer?.observe(toolbar);
    const today = home?.querySelector<HTMLElement>(".home-today-panel");
    if (today) observer?.observe(today);
    return () => {
      window.removeEventListener("resize", measureHomeGeometry);
      observer?.disconnect();
    };
  }, [
    activeWorkspace.id,
    customizing,
    experimentalMode,
    experimentalRestoring,
    initialProfile.id,
    onboardingTest,
    page,
    homeSkeletonBaseLayout,
    profile.id,
    saveState.ready,
  ]);
  useEffect(() => {
    if (profile.id !== initialProfile.id
      || !homeSkeletonRestored
      || !homeSkeletonCache.readable
      || !saveState.ready
      || experimentalMode
      || onboardingTest
      || experimentalRestoring) return;
    const preserveGeometry = homeSkeletonCache.cached
      && layoutsMatch(homeSkeletonCache.layout, homeSkeletonBaseLayout)
      ? homeSkeletonCache.layout.geometry
      : undefined;
    const layoutToWrite = homeSkeletonServerLayout.geometry
      ? homeSkeletonServerLayout
      : preserveGeometry
        ? { ...homeSkeletonBaseLayout, geometry: preserveGeometry }
        : homeSkeletonBaseLayout;
    if (homeSkeletonCache.cached && cacheLayoutsMatch(homeSkeletonCache.layout, layoutToWrite)) return;
    if (!writeHomeSkeletonLayout(initialProfile.id, layoutToWrite)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- Keep same-tab reloads aligned with the snapshot just persisted to local storage.
    setHomeSkeletonCache((current) => current.accountId === initialProfile.id && current.readable
      ? { ...current, layout: layoutToWrite, cached: true }
      : current);
  }, [
    experimentalMode,
    experimentalRestoring,
    homeSkeletonCache,
    homeSkeletonBaseLayout,
    homeSkeletonRestored,
    homeSkeletonServerLayout,
    initialProfile.id,
    onboardingTest,
    profile.id,
    saveState.ready,
  ]);
  const todayAssignments = assignments.filter((assignment) => assignment.status === "today");
  const overdueAssignments = assignments.filter((assignment) => assignment.status === "overdue");

  const navigate = (destination: PageId) => {
    if (nativeDocumentDialog) { flash("Close the text editor before navigating. Your draft is still here."); return; }
    router.push(`/${destination}`);
    setSidebarOpen(false);
    setExperimentalMenuOpen(false);
    setSelectedAssignment(null);
    setSelectedClass(null);
  };

  const flash = (message: string) => setToast(message);

  const applyExperimentalData = (density: ExperimentalDensity) => {
    if (fileUploads.dirty || fileUploads.busy || pendingFolderUpload) { flash("Finish or dismiss retained uploads before loading preview data."); return; }
    if (nativeDocumentDialog) { flash("Close the text editor before loading preview data."); return; }
    if (organizationState) { flash("Close the Files dialog before loading preview data."); return; }
    if (undoBusy) { flash("Wait for Undo to finish before loading preview data."); return; }
    if (!saveState.ready || saveState.dirty || profilePending || fileStore.busy) {
      flash("Wait for your real workspace to finish saving first");
      return;
    }
    const demo = experimentalData(density, today);
    const demoDetails = {
      assignments: demo.assignments,
      manualEvents: demo.manualEvents,
      dashboardView: "cards" as const,
      calendarFilter: "all",
      courseDetails: demo.courseDetails,
      syllabusDrafts: [],
      study: demo.study,
      filePreferences: extraData.filePreferences,
      widgetAppearance: extraData.widgetAppearance,
    };
    try {
      academicSnapshot(demo.courses, encodeWorkspaceState(demo.workspaces, demo.activeWorkspaceId, demo.notes, demoDetails));
    } catch (error) {
      flash(error instanceof Error ? error.message : "Unable to load the preview data");
      return;
    }
    setExperimentalMode(density);
    setCourses(demo.courses);
    setAssignments(demo.assignments);
    setManualEvents(demo.manualEvents);
    setWorkspaces(demo.workspaces);
    setActiveWorkspaceId(demo.activeWorkspaceId);
    setNotes(demo.notes);
    setDashboardView("cards");
    setCalendarFilter("all");
    setExtraData({ courseDetails: demo.courseDetails, syllabusDrafts: [], study: demo.study, filePreferences: extraData.filePreferences, widgetAppearance: extraData.widgetAppearance });
    setExperimentalMenuOpen(false);
    setSelectedAssignment(null); setSelectedClass(null); setEditor(null); setStudyOpen(false); setSyllabusId(null);
    navigate("home");
    flash(`${density.charAt(0).toUpperCase() + density.slice(1)} demo loaded`);
  };

  const exitExperimentalMode = () => {
    if (experimentalRestoring) return;
    setExperimentalRestoring(true);
    setExperimentalMenuOpen(false);
    setReloadAttempt((attempt) => attempt + 1);
  };

  useEffect(() => {
    if (page !== "home" || !noteFocusRef.current) return;
    const input = document.getElementById(`note-${noteFocusRef.current}`);
    if (input) { input.focus(); input.scrollIntoView?.({ block: "center" }); noteFocusRef.current = null; }
  }, [page, activeWorkspaceId, workspaces]);

  // Validate the entire candidate before accepting a change that cannot be saved.
  const commitWorkspaces = (next: Workspace[], active = activeWorkspaceId, recoveredNotes = notes, appearance = extraData.widgetAppearance) => {
    next = next.map((workspace) => ({ ...workspace, resizePriorities: workspace.resizePriorities?.filter((priority) => workspace.widgets.some((widget) => widget.instanceId === priority.widgetId)) }));
    const ids = new Set(next.flatMap((workspace) => workspace.widgets.map((widget) => widget.instanceId)));
    const cleanedAppearance = appearance && { ...appearance, overrides: Object.fromEntries(Object.entries(appearance.overrides).filter(([id]) => ids.has(id))) };
    try { academicSnapshot(courses, encodeWorkspaceState(next, active, recoveredNotes, { assignments: storedAssignments, manualEvents, dashboardView, calendarFilter, ...extraData, widgetAppearance: cleanedAppearance })); }
    catch (error) { flash(error instanceof Error ? error.message : "This layout cannot be saved."); return false; }
    setWorkspaces(next); setActiveWorkspaceId(active); setNotes(recoveredNotes);
    if (appearance) setExtraData((current) => ({ ...current, widgetAppearance: cleanedAppearance }));
    return true;
  };

  const restoreToday = () => {
    if (!commitWorkspaces(workspaces.map((workspace) => workspace.id === activeWorkspaceId ? { ...workspace, todayHidden: false } : workspace))) return;
    setWorkspaceMenuOpen(false);
    window.requestAnimationFrame(() => todayOptionsButtonRef.current?.focus());
  };

  const updateWorkspaceWidgets = (updater: (widgets: WidgetInstance[]) => WidgetInstance[], resetPlacement = false) => {
    return commitWorkspaces(workspaces.map((workspace) => workspace.id === activeWorkspaceId ? { ...workspace, widgets: updater(workspace.widgets), resizePriorities: resetPlacement ? undefined : workspace.resizePriorities } : workspace));
  };

  const addWidget = (type: WidgetType) => {
    const template = widgetTemplates.find((item) => item.type === type)!;
    if (updateWorkspaceWidgets((widgets) => [...widgets, { instanceId: uid("widget"), type, size: template.defaultSize, ...(type === "notes" ? { note: "" } : {}) }])) flash(`${template.title} added`);
  };

  const removeWidget = (instanceId: string) => {
    const widget = activeWorkspace.widgets.find((item) => item.instanceId === instanceId);
    if (!widget) return false;
    if (widget.note && !window.confirm("Remove this notes widget and its text?")) return false;
    if (!updateWorkspaceWidgets((widgets) => widgets.filter((item) => item.instanceId !== instanceId))) return false;
    closeWidgetMenu();
    flash("Widget removed");
    return true;
  };

  const moveWidget = (from: number, to: number) => {
    if (from === to || from < 0 || from >= activeWorkspace.widgets.length || to < 0 || to >= activeWorkspace.widgets.length) return;
    updateWorkspaceWidgets((widgets) => {
      const next = [...widgets];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    }, true);
    closeWidgetMenu();
  };

  const resizeWidget = (instanceId: string, size: WidgetSize, priority?: WidgetResizePriority) => {
    if (activeWorkspace.widgets.find((widget) => widget.instanceId === instanceId)?.size === size) {
      closeWidgetMenu();
      return true;
    }
    if (!priority) {
      const card = Array.from(document.querySelectorAll<HTMLElement>("[data-widget-id]")).find((candidate) => candidate.dataset.widgetId === instanceId);
      const grid = card?.closest<HTMLElement>(".widget-grid");
      if (card && grid) {
        const columns = Number.parseInt(window.getComputedStyle(grid).getPropertyValue("--widget-columns"), 10) === 2 ? 2 : 4;
        priority = { widgetId: instanceId, columns, column: Number.parseInt(card.style.gridColumn, 10) || 1, row: Math.floor(((Number.parseInt(card.style.gridRow, 10) || 1) - 1) / 2) * 2 + 1 };
      }
    }
    const nextPriority = priority;
    const accepted = commitWorkspaces(workspaces.map((workspace) => workspace.id !== activeWorkspaceId ? workspace : { ...workspace,
      resizePriorities: nextPriority ? [...(workspace.resizePriorities ?? []).filter((candidate) => candidate.columns !== nextPriority.columns), nextPriority] : workspace.resizePriorities,
      widgets: workspace.widgets.map((widget) => {
        if (widget.instanceId !== instanceId) return widget;
        const next = { ...widget, size };
        if (size !== "mini") delete next.startsNewMiniBlock;
        return next;
      }) }));
    closeWidgetMenu();
    return accepted;
  };

  const createWorkspace = () => {
    const cleanName = workspaceNameDraft.trim() || "New workspace";
    const id = uid("workspace");
    if (!commitWorkspaces([...workspaces, { id, name: cleanName, widgets: [] }], id)) return;
    setWorkspaceDialog(null);
    setWorkspaceNameDraft("");
    flash(`${cleanName} created`);
  };

  const renameWorkspace = () => {
    const cleanName = workspaceNameDraft.trim();
    if (!cleanName) return;
    if (!commitWorkspaces(workspaces.map((workspace) => workspace.id === activeWorkspaceId ? { ...workspace, name: cleanName } : workspace))) return;
    setWorkspaceDialog(null);
    setWorkspaceNameDraft("");
    flash("Workspace renamed");
  };

  const duplicateWorkspace = () => {
    const id = uid("workspace");
    const copy: Workspace = { ...activeWorkspace, id, name: `${activeWorkspace.name.slice(0, 75)} copy`, widgets: activeWorkspace.widgets.map((widget) => ({ ...widget, instanceId: uid("widget") })) };
    copy.resizePriorities = activeWorkspace.resizePriorities?.map((priority) => ({ ...priority, widgetId: copy.widgets[activeWorkspace.widgets.findIndex((widget) => widget.instanceId === priority.widgetId)].instanceId }));
    const appearance = extraData.widgetAppearance && { ...extraData.widgetAppearance, overrides: { ...extraData.widgetAppearance.overrides } };
    if (appearance) copy.widgets.forEach((widget, index) => {
      const original = appearance.overrides[activeWorkspace.widgets[index].instanceId];
      if (original) appearance.overrides[widget.instanceId] = { ...original };
    });
    if (!commitWorkspaces([...workspaces, copy], id, notes, appearance)) return;
    setWorkspaceMenuOpen(false);
    flash("Workspace duplicated");
  };

  const deleteWorkspace = () => {
    if (workspaces.length === 1) {
      flash("Keep at least one workspace");
      return;
    }
    if (!window.confirm(`Delete ${activeWorkspace.name} and all its widgets and notes?`)) return;
    const next = workspaces.filter((workspace) => workspace.id !== activeWorkspaceId);
    if (!commitWorkspaces(next, next[0].id)) return;
    setWorkspaceMenuOpen(false);
    flash("Workspace deleted");
  };

  const moveWorkspace = (offset: number) => {
    const index = workspaces.findIndex((workspace) => workspace.id === activeWorkspaceId), target = index + offset;
    if (target < 0 || target >= workspaces.length) return;
    const next = [...workspaces]; [next[index], next[target]] = [next[target], next[index]];
    commitWorkspaces(next); setWorkspaceMenuOpen(false);
  };
  const recoverNotes = () => {
    const widget: WidgetInstance = { instanceId: uid("widget"), type: "notes", size: "large", note: notes };
    if (commitWorkspaces(workspaces.map((workspace) => workspace.id === activeWorkspaceId ? { ...workspace, widgets: [...workspace.widgets, widget] } : workspace), activeWorkspaceId, "")) noteFocusRef.current = widget.instanceId;
  };

  const commitAcademic = (nextCourses: Course[], patch: Partial<WorkspaceData>) => {
    const data = { assignments: storedAssignments, manualEvents, dashboardView, calendarFilter, ...extraData, ...patch };
    try { validateAcademicEdit(nextCourses, encodeWorkspaceState(workspaces, activeWorkspaceId, notes, data), { assignments: storedAssignments, manualEvents, dashboardView }); }
    catch (error) { flash(error instanceof Error ? error.message : "Review the academic data."); return false; }
    setCourses(nextCourses); setAssignments(data.assignments); setManualEvents(data.manualEvents); setCalendarFilter(data.calendarFilter);
    setExtraData({ courseDetails: data.courseDetails, syllabusDrafts: data.syllabusDrafts, study: data.study, filePreferences: data.filePreferences, widgetAppearance: data.widgetAppearance }); return true;
  };
  const commitStudy = (patch: Partial<StudyData>) => commitAcademic(courses, { study: { ...study, ...patch } });
  const saveCourseSyllabus = async (courseId: string, value: SyllabusAttachmentValue) => {
    if (experimentalMode || profilePending || !autosave.getSnapshot().ready || !courses.some((course) => course.id === courseId)) throw new Error("Reload the saved course before attaching a syllabus.");
    const generation = workspaceLoadGeneration.current;
    const details = { ...(extraData.courseDetails[courseId] ?? emptyCourseDetails()), syllabusText: value.syllabusText, syllabusName: value.syllabusName };
    if (value.syllabusFileId) details.syllabusFileId = value.syllabusFileId;
    else delete details.syllabusFileId;
    const nextExtra = { ...extraData, courseDetails: { ...extraData.courseDetails, [courseId]: details } };
    const dashboard = encodeWorkspaceState(workspaces, activeWorkspaceId, notes, { assignments: storedAssignments, manualEvents, dashboardView, calendarFilter, ...nextExtra });
    validateAcademicEdit(courses, dashboard, { assignments: storedAssignments, manualEvents, dashboardView });
    const snapshot = canonicalJson(academicSnapshot(courses, dashboard));
    setExtraData(nextExtra);
    autosave.change(snapshot);
    await autosave.flushLatest(true);
    if (generation !== workspaceLoadGeneration.current) throw new Error("The workspace was reloaded. Reopen the saved course to continue.");
    const saved = autosave.getSnapshot();
    if (!saved.ready || saved.dirty || saved.status !== "saved") throw new Error(saved.message || "The syllabus could not be saved. Your draft is still here; retry saving.");
    flash("Syllabus saved");
  };
  const controlTimer = (action: "start" | "pause" | "resume" | "finish" | "reset", kind: TimerKind) => {
    // This callback runs only from StudyPanel/StudyWidget user events.
    // eslint-disable-next-line react-hooks/purity
    try { commitStudy(timerAction(study, action, kind, Date.now(), uid("session"))); setNow(new Date()); }
    catch (error) { flash(error instanceof Error ? error.message : "Unable to update the timer."); }
  };
  const removeClass = (course: Course) => {
    if (!window.confirm("Remove " + course.code + ", its assignments, grades, and class schedule? Study history, timers, calendar events, and files will remain as personal items.")) return;
    const details = { ...extraData.courseDetails }; delete details[course.id];
    if (commitAcademic(courses.filter((c) => c.id !== course.id), { assignments: storedAssignments.filter((a) => a.courseId !== course.id), manualEvents: manualEvents.map((e) => e.courseId === course.id ? { ...e, courseId: "" } : e), courseDetails: details, study: detachStudyCourse(study, course.id), filePreferences: { ...extraData.filePreferences, filter: extraData.filePreferences.filter === course.id ? "all" : extraData.filePreferences.filter }, calendarFilter: calendarFilter === course.id ? "all" : calendarFilter })) { setSelectedClass(null); setEditor(null); }
  };
  const applyEditor = (value: NonNullable<typeof editor>) => {
    let accepted = false;
    if (value.course) accepted = commitAcademic([...courses.filter((c) => c.id !== value.course!.id), value.course], { courseDetails: { ...extraData.courseDetails, [value.course.id]: value.details ?? emptyCourseDetails() } });
    if (value.assignment) accepted = commitAcademic(courses, { assignments: [...storedAssignments.filter((a) => a.id !== value.assignment!.id), value.assignment] });
    if (value.event) accepted = commitAcademic(courses, { manualEvents: [...manualEvents.filter((e) => e.id !== value.event!.id), value.event] });
    if (accepted) { setEditor(null); setSelectedAssignment(null); setSelectedClass(null); }
    return accepted;
  };
  const newAssignment = () => setEditor({ assignment: { id: uid("assignment"), title: "", courseId: "", due: "", dateKey: today, dueTime: "", type: "Assignment", status: "later", progress: 0, description: "", weight: "", notes: "", checklist: [false, false, false] } });
  const newEvent = (date = today) => setEditor({ event: { id: uid("event"), title: "", courseId: "", dateKey: date, time: "", type: "Personal", description: "" } });
  const newReview = () => createReview();
  const createReview = (file?: PrivateFile, sourceText = "") => {
    const draft: SyllabusDraft = { id: uid("review"), sourceText, sourceName: file?.name ?? "", ...(file ? { sourceFileId: file.id } : {}), course: emptyCourse(uid("course")), items: [] };
    if (commitAcademic(courses, { syllabusDrafts: [...extraData.syllabusDrafts, draft] })) { setSyllabusId(draft.id); setAddClassOpen(false); }
  };
  const approveReview = (draft: SyllabusDraft) => {
    const course = { ...draft.course, initials: draft.course.code.slice(0, 2).toUpperCase() };
    const items: Assignment[] = draft.items.map((item) => ({ id: "syllabus-" + item.id, courseId: course.id, title: item.title, type: item.type, dateKey: item.date, due: dateLabel(item.date), status: "later", progress: 0, description: item.description, weight: item.weight, notes: "", checklist: [false, false, false] }));
    const accepted = commitAcademic([...courses.filter((c) => c.id !== course.id), course], { assignments: [...storedAssignments, ...items], syllabusDrafts: extraData.syllabusDrafts.filter((d) => d.id !== draft.id), courseDetails: { ...extraData.courseDetails, [course.id]: { ...emptyCourseDetails(), syllabusText: draft.sourceText, syllabusName: draft.sourceName, ...(draft.sourceFileId ? { syllabusFileId: draft.sourceFileId } : {}) } } });
    if (accepted) setSyllabusId(null); return accepted;
  };
  const toggleAssignmentComplete = (id: string) => {
    const a = storedAssignments.find((a) => a.id === id); if (!a) return;
    const changed: Assignment = a.status === "done" ? { ...a, status: "later", completedAt: null, progress: a.progressBeforeCompletion ?? 0 } : { ...a, status: "done", completedAt: new Date().toISOString(), progressBeforeCompletion: a.progress, progress: 100 };
    if (commitAcademic(courses, { assignments: storedAssignments.map((item) => item.id === id ? changed : item) })) setSelectedAssignment(changed);
  };

  const workspaceError = ["load-error", "save-error", "conflict", "session-error"].includes(persistenceStatus);
  const workspacePending = persistenceStatus === "dirty" || persistenceStatus === "saving";
  const showWorkspaceToast = !experimentalMode && (workspaceError || workspacePending || (profilePending && persistenceStatus === "saved"));
  const workspaceToastTitle = persistenceStatus === "load-error" ? "Couldn't load workspace"
    : persistenceStatus === "save-error" ? ""
      : persistenceStatus === "conflict" ? "Workspace changed elsewhere"
        : persistenceStatus === "session-error" ? "Sign in to continue saving"
          : workspacePending ? "Saving workspace…"
            : profileSaving ? "Saving settings…"
              : "Settings have unsaved changes";
  const workspaceToastMessage = workspaceError ? saveState.message || "Something went wrong while saving your workspace."
    : workspacePending ? undefined
      : profileSaving ? "Your settings changes are being saved."
        : profilePending ? "Your settings changes have not been saved yet."
          : undefined;
  const workspaceToastLoading = workspacePending || (profileSaving && persistenceStatus === "saved");
  const widgetEditingEnabled = customizing && !appearanceOpen && !widgetPickerOpen && !workspaceDialog && !aiApplying && !studyOpen && !editor && !selectedAssignment && !selectedClass && !syllabusId && !syllabusAttachment && !syllabusTextCourseId && !nativeDocumentDialog;

  if (onboardingTest) return <OnboardingFlow initialProfile={profile} preview onExit={() => {
    setOnboardingTest(false);
    window.setTimeout(() => document.querySelector<HTMLButtonElement>(".experimental-trigger")?.focus(), 0);
  }} />;

  return (
    <div className={`app-shell reference-ui ${page === "files" && filesBrowserEnabled ? "files-workspace" : ""} ${customizing ? "is-customizing" : ""} ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <div className="mountain-backdrop" aria-hidden="true" />

      <a className="skip-link" href="#main-content">Skip to main content</a>
      <aside id="workspace-sidebar" className={`sidebar ${sidebarOpen ? "open" : ""}`} aria-label="Primary navigation">
        <div className="brand-row">
          <div className="brand-copy"><strong>EduEssentials</strong></div>
          <button className="icon-button sidebar-toggle" onClick={toggleSidebar} aria-label={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} title={sidebarCollapsed ? "Expand sidebar" : "Collapse sidebar"} aria-expanded={!sidebarCollapsed} aria-controls="workspace-sidebar">{sidebarCollapsed ? <PanelLeftOpen size={19} /> : <PanelLeftClose size={19} />}</button>
          <button className="icon-button sidebar-close" onClick={() => setSidebarOpen(false)} aria-label="Close navigation"><X size={20} /></button>
        </div>

        <nav className="main-nav">
          {navItems.map((item) => {
            const Icon = item.icon;
            return (
              <Link key={item.id} href={`/${item.id}`} className={`nav-item ${page === item.id ? "active" : ""}`} onClick={() => setSidebarOpen(false)} aria-label={item.label} title={item.label} aria-current={page === item.id ? "page" : undefined}>
                <Icon size={19} strokeWidth={2.1} />
                <span>{item.label}</span>
                {item.id === "dashboard" && <span className="nav-count">{courses.length}</span>}
              </Link>
            );
          })}
          <div className="experimental-control">
            <button
              className={`nav-item experimental-trigger ${experimentalMode ? "active" : ""}`}
              type="button"
              aria-label="Experimental mode"
              title="Experimental mode"
              aria-expanded={experimentalMenuOpen}
              aria-controls="experimental-options"
              onClick={() => setExperimentalMenuOpen((open) => !open)}
            >
              <FlaskConical size={19} strokeWidth={2.1} />
              <span>Experimental mode</span>
              <span className="experimental-badge">TEMP</span>
            </button>
            {experimentalMenuOpen && <div className="experimental-menu" id="experimental-options">
              <p>Fake preview data</p>
              {([
                ["clear", "Clear", "0 classes · 0 tasks"],
                ["light", "Light", "2 classes · 6 tasks"],
                ["medium", "Medium", "4 classes · 14 tasks"],
                ["packed", "Packed", "6 classes · 28 tasks"],
              ] as const).map(([value, label, detail]) => <button key={value} type="button" aria-label={`Load ${label} experimental data`} className={experimentalMode === value ? "selected" : ""} disabled={!saveState.ready || saveState.dirty || profilePending || fileStore.busy || experimentalRestoring} onClick={() => applyExperimentalData(value)}><span><strong>{label}</strong><small>{detail}</small></span>{experimentalMode === value && <CheckCircle2 size={15} />}</button>)}
              <button type="button" disabled={!saveState.ready || saveState.dirty || profilePending || fileStore.busy || experimentalRestoring || aiApplying} onClick={() => {
                const current = autosave.getSnapshot();
                if (!current.ready || current.dirty || profilePending || fileStore.busy || experimentalRestoring || aiApplying) return;
                autosave.stop();
                setExperimentalMenuOpen(false); setSidebarOpen(false); setOnboardingTest(true);
              }}><strong>Onboard test</strong></button>
              {experimentalMode && <button className="experimental-exit" type="button" disabled={experimentalRestoring} onClick={exitExperimentalMode}>{experimentalRestoring ? "Restoring…" : "Exit experimental mode"}</button>}
              <small>Your saved workspace stays untouched.</small>
            </div>}
          </div>
        </nav>

        <button className="nav-item syllabus-nav" disabled={!saveState.ready} onClick={newReview} aria-label="Upload syllabus" title="Upload syllabus"><Upload size={22} /><span>Upload syllabus</span></button>
        <div className="sidebar-focus-card">
          <div className="focus-card-top"><span><Flame size={15} /> {stats.streak} day streak</span><strong>{study.dailyMinutes ? `${dailyPercent}%` : "No target"}</strong></div>
          <div className="tiny-progress"><span style={{ width: `${dailyPercent}%` }} /></div>
          <p>{study.dailyMinutes ? `${durationLabel(Math.max(0, study.dailyMinutes * 60 - stats.dailySeconds))} left toward today’s target.` : "Set your study targets."}</p>
          <button disabled={!saveState.ready} onClick={() => setStudyOpen(true)}>Study & grades <ArrowRight size={14} /></button>
        </div>

        <div className="sidebar-bottom">
          <Link href="/settings" className={`nav-item ${page === "settings" ? "active" : ""}`} onClick={() => setSidebarOpen(false)} aria-label="Settings" title="Settings" aria-current={page === "settings" ? "page" : undefined}><Settings size={19} /><span>Settings</span></Link>
          <Link href="/settings" className="profile-card" onClick={() => setSidebarOpen(false)} aria-label={`${studentName} — profile settings`} title={`${studentName} — profile settings`}>
            <span className="avatar">{studentName.slice(0, 1).toUpperCase()}</span>
            <span><strong>{studentName}</strong><small>{profileMajor || "Student workspace"}</small></span>
            <MoreHorizontal size={18} />
          </Link>
        </div>
      </aside>

      {sidebarOpen && <button className="sidebar-scrim" onClick={() => setSidebarOpen(false)} aria-label="Close navigation overlay" />}

      <header className="desktop-topbar">
        <form className="topbar-search" role="search" onSubmit={(event) => { event.preventDefault(); navigate("search"); }}>
          <MessageSquare size={20} aria-hidden="true" />
          <input
            ref={topSearchRef}
            aria-label="Search assignments, classes, and files"
            placeholder="Search your workspace…"
            value={searchQuery}
            onChange={(event) => setSearchQuery(event.target.value)}
          />
          <kbd>Ctrl K</kbd>
          <button type="submit" className="search-send" aria-label="Search"><Send size={18} /><span className="sr-only">Search</span></button>
        </form>
        <div className="topbar-actions">
          <button className="topbar-icon" onClick={() => flash("You’re all caught up")} aria-label="Open notifications">
            <Bell size={18} />
            <span className="notification-dot" />
          </button>
        </div>
      </header>

      <main id="main-content" className="main-content">
        <header className="mobile-header">
          <button className="icon-button" onClick={() => setSidebarOpen(true)} aria-label="Open navigation"><Menu size={22} /></button>
          <span className="mobile-brand"><span className="brand-mark small"><BookOpen size={16} /></span> EduEssentials</span>
          <button className="icon-button" aria-label="Notifications" onClick={() => flash(overdueAssignments.length ? `${overdueAssignments.length} overdue tasks — check Tasks for details` : "You’re all caught up")}><Bell size={20} /></button>
        </header>

        {experimentalMode && <div className="experimental-banner" role="status">
          <FlaskConical size={17} />
          <span><strong>{experimentalMode.charAt(0).toUpperCase() + experimentalMode.slice(1)} experimental mode</strong> — fake data is shown only in this tab and is not saved.</span>
          <button type="button" disabled={experimentalRestoring} onClick={exitExperimentalMode}>{experimentalRestoring ? "Restoring…" : "Exit"}</button>
        </div>}
        {page === "home" && (saveState.ready || persistenceStatus === "loading") && (
          <HomeLoadTransition
            key={`home-load-${reloadAttempt}-${initialProfile.id}-${homeSkeletonRestored}`}
            ready={saveState.ready}
            layout={homeSkeletonLayout}
            greeting={homeGreeting}
            serverLayout={saveState.ready ? homeSkeletonServerLayout : undefined}
            layoutRestored={homeSkeletonRestored}
            reducedMotion={profile.preferences.reducedMotion}
          >
            {saveState.ready ? renderHome() : null}
          </HomeLoadTransition>
        )}
        {!saveState.ready && (persistenceStatus === "loading" ? (page !== "home" && (
          <section className="workspace-loading is-pending" role="status" aria-live="polite">
            <span className="workspace-loading-spinner" aria-hidden="true" />
            <h1>Loading your workspace...</h1>
          </section>
        )) : (
          <section className="workspace-loading"><h1>Your workspace could not be loaded</h1><p>Your saved work will be available here when the connection is restored.</p></section>
        ))}
        {saveState.ready && page === "dashboard" && renderDashboard()}
        {saveState.ready && page === "tasks" && <div className="page">{renderPageHeader("Your coursework", "Tasks", "All your assignments, across every course.", <button className="primary-button" onClick={newAssignment}><Plus size={16} /> Add assignment</button>)}{renderAssignmentTable(assignments)}</div>}
        {saveState.ready && page === "calendar" && renderCalendar()}
        {saveState.ready && page === "search" && renderSearch()}
        {(saveState.ready || organizationState) && (page === "files" || organizationState) && <div hidden={page !== "files"}>{renderFiles()}</div>}
        {page === "assistant" && <AcademicAssistant profileId={initialProfile.id} prepare={prepareAssistant} apply={applyAssistant} experimental={!!experimentalMode} />}
        {saveState.ready && <div key={reloadAttempt} hidden={page !== "settings"}>{renderSettings()}</div>}
      </main>

      <nav className="mobile-bottom-nav" aria-label="Mobile navigation">
        {navItems.slice(0, 4).map((item) => {
          const Icon = item.icon;
          return <Link key={item.id} href={`/${item.id}`} className={page === item.id ? "active" : ""} aria-current={page === item.id ? "page" : undefined}><Icon size={19} /><span>{item.label}</span></Link>;
        })}
        <Link href="/settings" className={page === "settings" ? "active" : ""} aria-current={page === "settings" ? "page" : undefined}><Settings size={19} /><span>Settings</span></Link>
      </nav>

      {children}
      {aiApplying && <div className="assistant-apply-overlay" role="status">Applying your reviewed changes…</div>}
      {studyOpen && <StudyPanel data={study} courses={courses} system={activeGpaSystem} term={activeTerm} studyGoal={profile.study_goal} timezone={profile.timezone} now={now.getTime()} onChange={commitStudy} onTimer={controlTimer} onClose={() => setStudyOpen(false)} />}
      {widgetPickerOpen && renderWidgetPicker()}
      {appearanceOpen && <WidgetCustomization value={extraData.widgetAppearance} widgets={activeWorkspace.widgets.map((widget) => ({ instanceId: widget.instanceId, title: widgetTemplates.find((template) => template.type === widget.type)!.title, size: widget.size, startsNewMiniBlock: widget.startsNewMiniBlock }))} onClose={closeAppearance} onApply={(next) => {
        if (aiApplying || !saveState.ready || !commitAcademic(courses, { widgetAppearance: next })) return false;
        setAppearanceOpen(false); flash(experimentalMode ? "Appearance preview updated — nothing saved to your account" : "Widget appearance applied"); return true;
      }} />}
      {workspaceDialog && renderWorkspaceDialog()}
      {selectedClass && renderClassDetail(selectedClass)}
      {selectedAssignment && renderAssignmentDetail(selectedAssignment)}
      {addClassOpen && renderAddClassDialog()}
      {editor && <AcademicEditor key={(editor.course ?? editor.assignment ?? editor.event)!.id} initial={editor} courses={courses} today={today} onApply={applyEditor} onClose={() => setEditor(null)} onDelete={editor.course && courses.some((c) => c.id === editor.course!.id) ? () => removeClass(editor.course!) : editor.assignment && storedAssignments.some((a) => a.id === editor.assignment!.id) ? () => { if (window.confirm("Delete this assignment and its notes?")) { if (commitAcademic(courses, { assignments: storedAssignments.filter((a) => a.id !== editor.assignment!.id) })) setEditor(null); } } : editor.event && manualEvents.some((e) => e.id === editor.event!.id) ? () => { if (window.confirm("Delete this event?")) { if (commitAcademic(courses, { manualEvents: manualEvents.filter((e) => e.id !== editor.event!.id) })) setEditor(null); } } : undefined} />}
      {syllabusId && extraData.syllabusDrafts.filter((d) => d.id === syllabusId).map((draft) => <SyllabusReview key={draft.id} draft={draft} onUpload={() => setFileDialog({ defaults: { kind: "syllabus" }, reviewId: draft.id })} onFile={() => { const file = fileStore.files.find((f) => f.id === draft.sourceFileId); if (file) setFilePreview(file); else flash("Refresh Files to load this saved source."); }} onChange={(next) => { commitAcademic(courses, { syllabusDrafts: extraData.syllabusDrafts.map((d) => d.id === draft.id ? next : d) }); }} onApprove={() => approveReview(draft)} onClose={() => setSyllabusId(null)} onDelete={() => { if (window.confirm("Discard this syllabus review and its source text?")) { if (commitAcademic(courses, { syllabusDrafts: extraData.syllabusDrafts.filter((d) => d.id !== draft.id) })) setSyllabusId(null); } }} />)}
      {syllabusAttachment && courses.filter((course) => course.id === syllabusAttachment.courseId).map((course) => <SyllabusAttachment key={course.id} courseId={course.id} course={course} details={extraData.courseDetails[course.id] ?? emptyCourseDetails()} folderId={syllabusAttachment.folderId} store={fileStore} canWrite={canWriteFiles} onSave={(value) => saveCourseSyllabus(course.id, value)} onClose={() => setSyllabusAttachment(null)} />)}
      {syllabusTextCourseId && courses.filter((course) => course.id === syllabusTextCourseId).map((course) => <SyllabusTextPreview key={course.id} course={course} text={extraData.courseDetails[course.id]?.syllabusText ?? ""} name={extraData.courseDetails[course.id]?.syllabusName ?? course.code + " syllabus"} onClose={() => setSyllabusTextCourseId(null)} />)}
      {nativeDocumentDialog && <NativeDocumentEditor key={nativeDocumentDialog.file?.id ?? nativeDocumentDialog.create!.id} profileId={initialProfile.id} file={nativeDocumentDialog.file} create={nativeDocumentDialog.create} canWrite={!nativeDocumentDialog.readOnly && !experimentalMode && saveState.ready && !profilePending} onSaved={handleNativeDocumentSaved} onClose={closeNativeDocument} onDraftChange={handleNativeDocumentDraft} />}
      {fileDialog && <FileEditor key={fileDialog.initial?.id ?? fileDialog.reviewId ?? "new-file"} store={fileStore} courses={courses} assignments={assignments} initial={fileDialog.initial} defaults={fileDialog.defaults} canWrite={canWriteFiles} onClose={() => setFileDialog(null)} onSaved={(file) => { if (fileDialog.initial?.state === "ready") handleFileOpened(file); if (fileDialog.reviewId) setExtraData((current) => ({ ...current, syllabusDrafts: current.syllabusDrafts.map((draft) => draft.id === fileDialog.reviewId ? { ...draft, sourceFileId: file.id, sourceName: file.name } : draft) })); }} />}
      {filePreview && <FilePreview key={`${initialProfile.id}-${fileActionSession.generation}-${filePreview.id}`} file={fileStore.files.find((f) => f.id === filePreview.id) ?? filePreview} store={fileStore} onOpened={handleFileOpened} onClose={() => { setFilePreview(null); setFilePreviewReadOnly(false); setSyllabusPreviewFileId(null); }} canWrite={canWriteFiles && !filePreviewReadOnly} onEdit={() => { setFileDialog({ initial: fileStore.files.find((f) => f.id === filePreview.id) ?? filePreview }); setFilePreview(null); setSyllabusPreviewFileId(null); }} onReview={syllabusPreviewFileId === filePreview.id ? undefined : (file, text) => { createReview(file, text); setFilePreview(null); }} />}
      {uploadDialog && <FileUploadDialog
        key={`${uploadDialog.profileId}:${uploadDialog.folderId ?? "root"}:${uploadDialog.courseId}:${uploadDialog.generation}:${uploadDialog.mode ?? "files"}`}
        queue={fileUploads}
        currentProfileId={initialProfile.id}
        currentSessionGeneration={fileActionSession.generation}
        defaults={uploadDialog}
        mode={pendingFolderUpload ? "folder" : uploadDialog.mode}
        courses={courses}
        changeToken={fileStore.files}
        folderUpload={pendingFolderUpload}
        onFolderUploadChange={setPendingFolderUpload}
        canWrite={uploadDialog.profileId === initialProfile.id && canWriteFiles && !profilePending && !organizationState && !nativeDocumentDialog}
        onClose={() => setUploadDialog(null)}
      />}
      <div className="toast-stack">
        <SaveToast active={(fileUploads.rows.length > 0 || !!pendingFolderUpload) && !uploadDialog} title={pendingFolderUpload ? "Folder upload needs attention" : fileUploads.busy ? "Uploading files…" : fileUploads.dirty ? "Uploads need attention" : "Uploads complete"} message={pendingFolderUpload ? "Your selected folder and created folder IDs are retained for retry." : "Review individual results or retry retained selections."} loading={fileUploads.busy || pendingFolderUpload?.status === "creating"}>
          <button type="button" onClick={() => setUploadDialog({ profileId: pendingFolderUpload?.profileId ?? initialProfile.id, folderId: pendingFolderUpload?.folderId ?? null, courseId: pendingFolderUpload?.courseId ?? "", generation: pendingFolderUpload?.sessionGeneration ?? fileActionSession.generation, mode: pendingFolderUpload ? "folder" : "files" })}>Review uploads</button>
        </SaveToast>
        <SaveToast
          active={showWorkspaceToast}
          title={workspaceToastTitle}
          message={workspaceToastMessage}
          error={workspaceError}
          loading={workspaceToastLoading}
        >
          {profilePending && page !== "settings" && (workspaceError || persistenceStatus === "saved") && persistenceStatus !== "save-error" && <button type="button" onClick={() => navigate("settings")}>Review settings</button>}
          {workspaceError && persistenceStatus === "save-error" && <button type="button" onClick={autosave.retry}>Retry save</button>}
          {workspaceError && persistenceStatus === "session-error" && <><a href="/login?error=session" target="_blank" rel="noopener noreferrer">Sign in in a new tab</a><button type="button" onClick={saveState.ready ? autosave.retry : reloadWorkspace}>Retry after signing in</button></>}
          {workspaceError && persistenceStatus === "load-error" && <button type="button" onClick={reloadWorkspace}>Retry loading</button>}
          {workspaceError && saveState.dirty && <button type="button" onClick={downloadUnsavedWork}>Download unsaved work</button>}
          {workspaceError && saveState.dirty && persistenceStatus !== "save-error" && <button type="button" disabled={persistenceStatus === "saving" || profileSaving} onClick={reloadWorkspace}>Reload saved workspace</button>}
        </SaveToast>
        <SaveToast
          active={!experimentalMode && (Boolean(fileStore.error) || fileStore.busy)}
          title={fileStore.error ? "Couldn't update private files" : "Saving private files…"}
          message={fileStore.error || undefined}
          error={Boolean(fileStore.error)}
          loading={!fileStore.error && fileStore.busy}
        >
          {fileStore.error && <><button type="button" onClick={() => void fileStore.refresh()} disabled={fileStore.busy}>Reload files</button><a href="/login" target="_blank" rel="noopener noreferrer">Sign in in a new tab</a></>}
        </SaveToast>
        <SaveToast active={!!currentTrashUndo} title={undoBusy ? "Restoring from Trash…" : currentTrashUndo?.error ? "Couldn't restore from Trash" : `${currentTrashUndo?.receipt.label ?? "Item"} moved to Trash`} message={currentTrashUndo?.error || "Undo restores the saved location and keeps class and assignment links."} error={!!currentTrashUndo?.error} loading={undoBusy}>
          <button type="button" disabled={!canWriteFiles || profilePending || !!organizationState || !!nativeDocumentDialog || fileStore.busy} onClick={() => void undoTrash()}>{currentTrashUndo?.restored ? "Retry Files refresh" : currentTrashUndo?.error ? "Retry Undo" : "Undo"}</button>
          {currentTrashUndo?.error && filesBrowserEnabled && <button type="button" disabled={undoBusy} onClick={() => router.push("/files?view=trash")}>Review Trash</button>}
          <button type="button" disabled={undoBusy} onClick={() => setTrashUndo(null)}>Dismiss Trash notification</button>
        </SaveToast>
        <SaveToast active={!!organizationState && page !== "files"} title="Files changes are still open" message="Return to Files to finish or close the dialog." loading={!!organizationState?.busy}>
          <button type="button" onClick={() => navigate("files")}>Review Files</button>
          <button type="button" onClick={downloadUnsavedWork}>Download current drafts</button>
        </SaveToast>
        <SaveToast active={!!fileActivity.failure} title="Couldn't update Recent" message={fileActivity.failure ? fileActivity.failure.message + (fileActivity.failure.acknowledged ? "" : " Later opens will appear after you retry or dismiss this update.") : undefined} error loading={fileActivity.retrying}>
          <button type="button" disabled={fileActivity.retrying || !!experimentalMode || profilePending || !saveState.ready} onClick={() => void fileActivity.retry()}>{fileActivity.failure?.acknowledged ? "Retry Recent refresh" : "Retry Recent update"}</button>
          <button type="button" disabled={fileActivity.retrying} onClick={fileActivity.dismiss}>Dismiss Recent notification</button>
        </SaveToast>
        {!experimentalMode && persistenceStatus === "saved" && !profilePending && <span className="sr-only" role="status">Workspace saved</span>}
        {toast && <div className="toast" role="status"><CheckCircle2 size={17} /> {toast}</div>}
      </div>
    </div>
  );

  function renderPageHeader(eyebrow: string, title: string, subtitle: string, actions?: React.ReactNode) {
    return (
      <div className="page-heading">
        <div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{subtitle}</p></div>
        {actions && <div className="page-actions">{actions}</div>}
      </div>
    );
  }

  function renderHome() {
    const featuredAssignments = assignments.filter((a) => a.dateKey === today && a.status !== "done");
    const nextClass = courses.flatMap((course) => (extraData.courseDetails[course.id]?.meetings ?? []).filter((meeting) => today >= meeting.from && today <= meeting.until && meeting.days.includes(new Date(today + "T12:00:00Z").getUTCDay()) && meeting.end > localTime).map((meeting) => ({ course, meeting }))).sort((a, b) => a.meeting.start.localeCompare(b.meeting.start))[0];
    const timeLabel = (time: string) => /^\d{2}:\d{2}$/.test(time) ? `${Number(time.slice(0, 2)) % 12 || 12}:${time.slice(3)} ${Number(time.slice(0, 2)) >= 12 ? "PM" : "AM"}` : time;
    const schedule = manualEvents.filter((event) => event.dateKey === today).sort((a, b) => a.time.localeCompare(b.time)).map((event) => {
      const course = courseFor(courses, event.courseId);
      return {
        time: event.time || "All day",
        title: event.title,
        detail: course.code === "Personal" ? event.type : course.code,
        color: course.color,
        onOpen: () => setEditor({ event }),
      };
    });
    for (const course of courses) for (const meeting of extraData.courseDetails[course.id]?.meetings ?? []) {
      if (today >= meeting.from && today <= meeting.until && meeting.days.includes(new Date(today + "T12:00:00Z").getUTCDay())) schedule.push({ time: meeting.start, title: course.name, detail: meeting.location || course.room, color: course.color, onOpen: () => setSelectedClass(course) });
    }
    schedule.sort((a, b) => a.time.localeCompare(b.time));
    const futureAssignments = assignments.filter((assignment) => assignment.dateKey > today && assignment.status !== "done").slice(0, 3);

    const renderTodaySection = (sectionId: TodaySectionId) => {
      switch (sectionId) {
        case "next-class":
          return (
            <section key={sectionId} className="today-panel-section today-next-class" aria-labelledby="next-class-title">
              <div className="today-section-heading"><span className="today-heading-icon"><GraduationCap /></span><h2 id="next-class-title">Next Class</h2></div>
              <div className="next-class-content">{nextClass ? <button onClick={() => setSelectedClass(nextClass.course)}><div className="next-class-title"><strong>{nextClass.course.name}</strong><small>{nextClass.meeting.start <= localTime ? "Now" : "Today"}</small></div><p>{timeLabel(nextClass.meeting.start)} | {nextClass.course.code} · {nextClass.meeting.location || nextClass.course.room}</p></button> : <><strong>No more classes today</strong><p>Enjoy a little breathing room.</p></>}</div>
            </section>
          );
        case "due-today":
          return (
            <section key={sectionId} className="today-panel-section" aria-labelledby="today-tasks-title">
              <div className="today-section-heading"><span className="today-heading-icon"><FileText /></span><h2 id="today-tasks-title">Due Today ({featuredAssignments.length})</h2></div>
              <div className="today-task-list">
                {featuredAssignments.length === 0 && <p className="today-empty">Nothing due today.</p>}
                {featuredAssignments.slice(0, 2).map((assignment) => {
                  const course = courseFor(courses, assignment.courseId);
                  return (
                    <button key={assignment.id} className="today-task-row" onClick={() => setSelectedAssignment(assignment)}>
                      <span className="task-circle" aria-hidden="true" />
                      <span className="today-task-copy"><strong>{assignment.title}</strong><small>{course.name}</small></span>
                      <ChevronRight size={16} aria-hidden="true" />
                    </button>
                  );
                })}
              </div>
            </section>
          );
        case "schedule":
          return (
            <section key={sectionId} className="today-panel-section today-schedule" aria-labelledby="today-schedule-title">
              <div className="today-section-heading"><span className="today-heading-icon"><CalendarDays /></span><h2 id="today-schedule-title">Today’s Schedule</h2></div>
              <div className="today-schedule-list">
                {schedule.length === 0 && <p className="today-empty">No events yet. Your schedule will appear here.</p>}
                {schedule.slice(0, 3).map((item) => (
                  <button key={`${item.time}-${item.title}`} className="today-schedule-row" onClick={item.onOpen}>
                    <time>{timeLabel(item.time)}</time>
                    <span className="today-schedule-copy"><span><i style={{ background: item.color }} aria-hidden="true" />{item.title}</span></span>
                  </button>
                ))}
              </div>
            </section>
          );
        case "study-goal":
          return (
            <section key={sectionId} className="today-panel-section" aria-labelledby="today-study-goal-title">
              <div className="today-section-heading"><span className="today-heading-icon"><Target /></span><h2 id="today-study-goal-title">Study Goal</h2></div>
              <div className="today-metric-content">
                {study.dailyMinutes > 0 ? <>
                  <div className="today-goal-summary"><strong>{dailyPercent}%</strong><span>{durationLabel(stats.dailySeconds)} of {durationLabel(study.dailyMinutes * 60)}</span></div>
                  <div className="today-goal-track" role="progressbar" aria-label="Daily study goal progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={dailyPercent}><span style={{ width: `${dailyPercent}%` }} /></div>
                  <p>{dailyPercent >= 100 ? "Today’s study goal is complete." : `${durationLabel(Math.max(0, study.dailyMinutes * 60 - stats.dailySeconds))} left toward today’s target.`}</p>
                  <button type="button" className="today-inline-action" onClick={() => setStudyOpen(true)}>Study details <ArrowRight size={14} /></button>
                </> : <>
                  <p className="today-empty">No daily study goal is set yet.</p>
                  <button type="button" className="today-inline-action" onClick={() => setStudyOpen(true)}>Set a study goal <ArrowRight size={14} /></button>
                </>}
              </div>
            </section>
          );
        case "upcoming-deadlines":
          return (
            <section key={sectionId} className="today-panel-section" aria-labelledby="today-upcoming-title">
              <div className="today-section-heading"><span className="today-heading-icon"><FileSearch /></span><h2 id="today-upcoming-title">Upcoming Deadlines</h2></div>
              {futureAssignments.length ? <div className="today-task-list">
                {futureAssignments.map((assignment) => {
                  const course = courseFor(courses, assignment.courseId);
                  return (
                    <button key={assignment.id} className="today-task-row" onClick={() => setSelectedAssignment(assignment)}>
                      <span className="task-circle" aria-hidden="true" />
                      <span className="today-task-copy"><strong>{assignment.title}</strong><small>{course.name} · {dateLabel(assignment.dateKey, { month: "short", day: "numeric" })}</small></span>
                      <ChevronRight size={16} aria-hidden="true" />
                    </button>
                  );
                })}
              </div> : <div className="today-metric-content"><p className="today-empty">No future deadlines are scheduled.</p><button type="button" className="today-inline-action" onClick={() => navigate("tasks")}>View assignments <ArrowRight size={14} /></button></div>}
            </section>
          );
        case "study-streak":
          return (
            <section key={sectionId} className="today-panel-section" aria-labelledby="today-streak-title">
              <div className="today-section-heading"><span className="today-heading-icon"><Flame /></span><h2 id="today-streak-title">Study Streak</h2></div>
              <div className="today-metric-content">
                <div className="today-streak-summary"><strong>{stats.streak}</strong><span>{stats.streak === 1 ? "day" : "days"}</span></div>
                <p>{stats.streak > 0 ? "Keep your momentum going with another focused session." : "Start a study session to begin your streak."}</p>
                <button type="button" className="today-inline-action" onClick={() => setStudyOpen(true)}>{stats.streak > 0 ? "View study log" : "Start studying"} <ArrowRight size={14} /></button>
              </div>
            </section>
          );
      }
    };

    return (
      <div className="page home-page">
        <HomeGreeting {...homeGreeting} />
        {activeWorkspace.todayHidden ? (
          <div
            key="today-removal-drawer"
            ref={todayRemoveTargetRef}
            className="today-remove-target-host today-remove-target-dock"
            data-remove-target-active={todayRemoveDragState.active ? "true" : "false"}
            data-remove-target-over={todayRemoveDragState.over ? "true" : "false"}
            data-remove-target-near={todayRemoveDragState.near ? "true" : "false"}
            aria-hidden={!customizing || undefined}
            inert={!customizing || undefined}
          >
            <div ref={todayRemoveHitRef} className="today-remove-target-overlay" aria-hidden="true"><Trash2 size={24} strokeWidth={2.2} /><span>remove widget</span></div>
          </div>
        ) : (
          <div
            key="today-panel"
            ref={todayRemoveTargetRef}
            className="today-remove-target-host is-visible"
            data-remove-target-active={todayRemoveDragState.active ? "true" : "false"}
            data-remove-target-over={todayRemoveDragState.over ? "true" : "false"}
          >
            <div className="today-remove-target-content" inert={todayRemoveDragState.active || undefined}>
              <TodaySection
                key={activeWorkspace.id}
                hidden={Boolean(activeWorkspace.todayHidden)}
                sections={activeWorkspace.todaySections ?? defaultTodaySections}
                optionsButtonRef={todayOptionsButtonRef}
                menuStyle={widgetAppearanceStyle(resolveWidgetAppearance(extraData.widgetAppearance)) as CSSProperties}
                onHiddenChange={(hidden) => commitWorkspaces(workspaces.map((workspace) => workspace.id === activeWorkspaceId ? { ...workspace, todayHidden: hidden } : workspace))}
                onSectionsChange={(sections) => commitWorkspaces(workspaces.map((workspace) => workspace.id === activeWorkspaceId ? { ...workspace, todaySections: sections } : workspace))}
                onCalendar={() => navigate("calendar")}
                onOptionsOpen={() => { closeWidgetMenu(); setWorkspaceMenuOpen(false); }}
                onHideFocus={() => window.requestAnimationFrame(() => {
                  if (customizing) workspaceOptionsButtonRef.current?.focus();
                  else customizeButtonRef.current?.focus();
                })}
              >
                <div className="today-panel-grid" data-section-count={activeWorkspace.todaySections?.length ?? defaultTodaySections.length}>
                  {(activeWorkspace.todaySections ?? defaultTodaySections).map(renderTodaySection)}
                </div>
              </TodaySection>
            </div>
            {todayRemoveDragState.active && <div className="today-remove-target-overlay" aria-hidden="true"><Trash2 size={24} strokeWidth={2.2} /><span>remove widget</span></div>}
          </div>
        )}

        <section className="workspace-section">
          <div className="workspace-bar">
            <div className="workspace-tabs" role="tablist" aria-label="Home workspaces">
              {workspaces.map((workspace) => <button key={workspace.id} role="tab" aria-selected={activeWorkspaceId === workspace.id} className={activeWorkspaceId === workspace.id ? "active" : ""} onClick={() => setActiveWorkspaceId(workspace.id)}>{workspace.name}</button>)}
              <button className="add-tab" disabled={workspaces.length >= MAX_WORKSPACES} title={`Up to ${MAX_WORKSPACES} workspaces`} onClick={() => { setWorkspaceNameDraft(""); setWorkspaceDialog("new"); }} aria-label="Add workspace">More <ChevronDown size={14} /></button>
            </div>
            <div className="workspace-actions">
              <button className="secondary-button widget-customization-trigger" aria-haspopup="dialog" onClick={() => setAppearanceOpen(true)}><SlidersHorizontal size={17} /> Widget customization</button>
              <button ref={customizeButtonRef} className="secondary-button" aria-pressed={customizing} onClick={() => setCustomizing((value) => !value)}><LayoutGrid size={17} />{customizing ? "Done customizing" : "Customize"}</button>
              <button className="secondary-button add-widget-control" onClick={() => setWidgetPickerOpen(true)}><Plus size={16} /> Add widget</button>
              <div className="menu-wrap">
                <button ref={workspaceOptionsButtonRef} className="icon-button" onClick={() => setWorkspaceMenuOpen((open) => !open)} aria-label="Workspace options"><MoreHorizontal size={19} /></button>
                {workspaceMenuOpen && <div className="popover workspace-menu">
                  {customizing && activeWorkspace.todayHidden && <button type="button" aria-label="Restore Today section" onClick={restoreToday}><Sun size={15} /> Restore Today</button>}
                  <button onClick={() => { setWorkspaceNameDraft(activeWorkspace.name); setWorkspaceDialog("rename"); setWorkspaceMenuOpen(false); }}><Pencil size={15} /> Rename</button>
                  <button disabled={workspaces.length >= MAX_WORKSPACES} onClick={duplicateWorkspace}><Copy size={15} /> Duplicate</button>
                  <button disabled={workspaces[0].id === activeWorkspaceId} onClick={() => moveWorkspace(-1)}><ArrowLeft size={15} /> Move left</button>
                  <button disabled={workspaces[workspaces.length - 1].id === activeWorkspaceId} onClick={() => moveWorkspace(1)}><ArrowRight size={15} /> Move right</button>
                  <button className="danger" disabled={workspaces.length === 1} onClick={deleteWorkspace}><Trash2 size={15} /> Delete</button>
                </div>}
              </div>
            </div>
          </div>

          {notes && <div className="workspace-save-bar"><span>Your earlier shared note is saved and available to restore.</span><button disabled={activeWorkspace.widgets.length >= MAX_WIDGETS_PER_WORKSPACE} onClick={recoverNotes}>Add saved note here</button><button onClick={() => downloadDraft("eduessentials-recovered-note.json", { note: notes })}>Download saved note</button></div>}
          {activeWorkspace.widgets.length === 0 ? (
            <div className="empty-workspace">
              <div className="empty-icon"><LayoutGrid size={26} /></div>
              <h2>Make this space yours</h2>
              <p>Add study tools, deadlines, charts, notes, and timers—then arrange them exactly how you like.</p>
              <button className="primary-button" onClick={() => setWidgetPickerOpen(true)}><Plus size={17} /> Browse widgets</button>
            </div>
          ) : (
            <ReorderableWidgetGrid
              items={activeWorkspace.widgets}
              workspaceId={activeWorkspace.id}
              label={`${activeWorkspace.name} widgets`}
              style={widgetAppearanceStyle(resolveWidgetAppearance(extraData.widgetAppearance)) as CSSProperties}
              layoutKey={`${activeWorkspace.id}:${sidebarCollapsed}:${JSON.stringify(extraData.widgetAppearance)}`}
              reflowKey={String(sidebarCollapsed)}
              enabled={widgetEditingEnabled}
              removeTargetRef={activeWorkspace.todayHidden && !customizing ? undefined : todayRemoveTargetRef}
              removeTargetHitRef={activeWorkspace.todayHidden ? todayRemoveHitRef : undefined}
              removeTargetNearEnabled={Boolean(activeWorkspace.todayHidden && customizing)}
              onRemove={removeWidget}
              onRemoveDragStateChange={(active, over, near) => setTodayRemoveDragState((current) => current.active === active && current.over === over && current.near === near ? current : { active, over, near })}
              onResize={resizeWidget}
              resizePriorities={activeWorkspace.resizePriorities}
              onReorderStart={closeWidgetMenu}
              onFinishCustomize={widgetEditingEnabled ? () => {
                closeWidgetMenu();
                setCustomizing(false);
              } : undefined}
              onCustomize={!customizing && !appearanceOpen && !widgetPickerOpen && !workspaceDialog && !aiApplying && !studyOpen && !editor && !selectedAssignment && !selectedClass && !syllabusId && !syllabusAttachment && !syllabusTextCourseId && !nativeDocumentDialog ? () => {
                closeWidgetMenu();
                setCustomizing(true);
              } : undefined}
              onReorder={(orderedIds, miniBlockChange) => {
                const currentWorkspace = workspaces.find((workspace) => workspace.id === activeWorkspaceId);
                if (!currentWorkspace || currentWorkspace.id !== activeWorkspace.id || orderedIds.length !== currentWorkspace.widgets.length) return false;
                const widgetsById = new Map(currentWorkspace.widgets.map((widget) => [widget.instanceId, widget]));
                if (new Set(orderedIds).size !== currentWorkspace.widgets.length || orderedIds.some((id) => !widgetsById.has(id))) return false;
                if (miniBlockChange && widgetsById.get(miniBlockChange.widgetId)?.size !== "mini") return false;
                return updateWorkspaceWidgets(() => orderedIds.map((id) => {
                  const widget = widgetsById.get(id)!;
                  if (id !== miniBlockChange?.widgetId) return widget;
                  const next = { ...widget };
                  delete next.startsNewMiniBlock;
                  if (miniBlockChange.startsNewMiniBlock) next.startsNewMiniBlock = true;
                  return next;
                }), true);
              }}
              renderWidget={(widget, index, isDragged, isResizing) => renderWidget(widget, index, isDragged, isResizing)}
              addTile={<button className="add-widget-tile" onClick={() => setWidgetPickerOpen(true)}><Plus size={22} /><span>Add widget</span></button>}
            />
          )}
        </section>
      </div>
    );
  }

  function renderWidget(widget: WidgetInstance, index: number, isDragged = false, isResizing = false) {
    const template = widgetTemplates.find((item) => item.type === widget.type)!;
    const appearance = resolveWidgetAppearance(extraData.widgetAppearance, widget.instanceId);
    const resizeIndicatorSize = appearance.radius + 10;
    const resizeIndicatorEdge = resizeIndicatorSize - 1.5;
    const resizeIndicatorRadius = Math.max(0, appearance.radius - 0.5);
    const resizeIndicatorCurve = `V ${resizeIndicatorEdge - resizeIndicatorRadius} A ${resizeIndicatorRadius} ${resizeIndicatorRadius} 0 0 1 ${resizeIndicatorEdge - resizeIndicatorRadius} ${resizeIndicatorEdge}`;
    const resizeIndicatorPath = `M ${resizeIndicatorEdge} 1.5 ${resizeIndicatorCurve} H 1.5`;
    const resizeIndicatorHoverPath = `M ${resizeIndicatorEdge} -2.5 ${resizeIndicatorCurve} H -2.5`;
    const TemplateIcon = widget.type === "today" ? BarChart3 : widget.type === "red-alerts" ? Bell : widget.type === "notes" ? FileText : template.icon;
    return (
      <article
        key={widget.instanceId}
        className={`widget-card widget-${widget.type} ${isDragged ? "widget-reorder-placeholder" : ""}${isResizing ? " widget-resizing" : ""}`}
        data-size={widget.size}
        data-mini-start={widget.size === "mini" && widget.startsNewMiniBlock ? "true" : undefined}
        data-widget-id={widget.instanceId}
        aria-hidden={isDragged ? true : undefined}
        inert={isDragged}
        style={widgetAppearanceStyle(appearance) as CSSProperties}
        {...appearanceAttributes(appearance)}
      >
        <div className="widget-frame">
        <div className="widget-header">
          <span className={`widget-icon tone-${template.color}`}><TemplateIcon size={16} /></span>
          <h2 data-widget-reorder-handle>{({ "daily-goal": "Daily Study Goal", today: "At a Glance", "red-alerts": "Alerts", pomodoro: "Pomodoro", "mini-calendar": "Mini Calendar", "task-completion": "Task Completion", notes: "Quick Notes" } as Record<string, string>)[widget.type] ?? template.title}</h2>
          <div className="menu-wrap">
            <button className="icon-button mini" onClick={() => {
              if (openWidgetMenu === widget.instanceId && !closingWidgetMenu) dismissWidgetMenu();
              else { setClosingWidgetMenu(false); setOpenWidgetMenu(widget.instanceId); }
            }} aria-label={`${template.title} options`}><MoreHorizontal size={17} /></button>
          </div>
        </div>
        <div className="widget-body">{renderWidgetBody(widget)}</div>
        </div>
        {widgetEditingEnabled && !isDragged && <button
          type="button"
          className="widget-resize-handle"
          style={{ "--widget-resize-border-width": appearance.borderStyle === "none" ? "0px" : "var(--wa-border-width, 1px)" } as CSSProperties}
          data-widget-resize-handle
          aria-label={`Resize ${template.title}`}
          aria-describedby={`widget-resize-size-${widget.instanceId}`}
          aria-haspopup="true"
          title="Drag to resize. Arrow keys change width or height; Enter opens size choices."
          draggable={false}
          onClick={() => { setClosingWidgetMenu(false); setOpenWidgetMenu(widget.instanceId); }}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown"].includes(event.key)) return;
            event.preventDefault();
            const nextSize = getWidgetKeyboardResizeSize(widget.size, event.key);
            if (nextSize !== widget.size) resizeWidget(widget.instanceId, nextSize);
          }}
        ><svg aria-hidden="true" viewBox={`0 0 ${resizeIndicatorSize} ${resizeIndicatorSize}`} fill="none" stroke="currentColor" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" style={{
          "--widget-resize-rest-path": `path("${resizeIndicatorPath}")`,
          "--widget-resize-hover-path": `path("${resizeIndicatorHoverPath}")`,
        } as CSSProperties}>
          <path d={resizeIndicatorPath} />
        </svg></button>}
        {widgetEditingEnabled && !isDragged && <span id={`widget-resize-size-${widget.instanceId}`} className="widget-resize-status" role="status" aria-live="polite">
          {`${template.title} size: ${widgetSizeOptions.find((option) => option.value === widget.size)?.label}`}
        </span>}
            {openWidgetMenu === widget.instanceId && (
              <div className={`popover widget-menu${closingWidgetMenu ? " is-closing" : ""}`} ref={widgetMenuRef} inert={closingWidgetMenu} aria-hidden={closingWidgetMenu || undefined} onAnimationEnd={(event) => {
                if (closingWidgetMenu && event.target === event.currentTarget && event.animationName === "widget-menu-dismiss") closeWidgetMenu();
              }}>
                <p>Widget size</p>
                <div className="size-options">
                  {widgetSizeOptions.map(({ value, label, footprint }) => <button key={value} aria-label={`${label} widget`} aria-pressed={widget.size === value} className={widget.size === value ? "active" : ""} onClick={() => resizeWidget(widget.instanceId, value)}><span>{label}</span><small>{footprint.width} × {footprint.height === 0.5 ? "½" : footprint.height}</small></button>)}
                </div>
                <button onClick={() => moveWidget(index, index - 1)} disabled={index === 0}><ArrowLeft size={15} /> Move earlier</button>
                <button onClick={() => moveWidget(index, index + 1)} disabled={index === activeWorkspace.widgets.length - 1}><ArrowRight size={15} /> Move later</button>
                <button disabled={activeWorkspace.widgets.length >= MAX_WIDGETS_PER_WORKSPACE} onClick={() => {
                  const copy = { ...widget, instanceId: uid("widget") };
                  const appearance = extraData.widgetAppearance && { ...extraData.widgetAppearance, overrides: { ...extraData.widgetAppearance.overrides } };
                  if (appearance?.overrides[widget.instanceId]) appearance.overrides[copy.instanceId] = { ...appearance.overrides[widget.instanceId] };
                  commitWorkspaces(workspaces.map((workspace) => workspace.id === activeWorkspaceId ? { ...workspace, widgets: [...workspace.widgets, copy] } : workspace), activeWorkspaceId, notes, appearance);
                  closeWidgetMenu();
                }}><Copy size={15} /> Duplicate</button>
                <button className="danger" onClick={() => removeWidget(widget.instanceId)}><Trash2 size={15} /> Remove</button>
              </div>
            )}
      </article>
    );
  }

  function renderWidgetBody(widget: WidgetInstance) {
    const { type } = widget;
    if (type === "today") {
      const time = new Intl.DateTimeFormat("en-GB", { timeZone: timezone || undefined, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
      const classesLeft = courses.filter((c) => (extraData.courseDetails[c.id]?.meetings ?? []).some((m) => today >= m.from && today <= m.until && m.days.includes(new Date(today + "T12:00:00Z").getUTCDay()) && m.end > time)).length;
      const endOfWeek = addDays(weekStart(today, monday), 6);
      const weekTasks = assignments.filter((a) => a.status !== "done" && a.dateKey >= today && a.dateKey <= endOfWeek).length;
      const newFiles = experimentalMode ? 0 : fileStore.files.filter((f) => f.created_at.slice(0, 10) >= weekStart(today, monday)).length;
      return <div className="glance-rows"><button onClick={() => navigate("dashboard")}><span className="glance-icon green"><GraduationCap size={23} /></span><strong>{classesLeft}</strong><span>classes left</span><ChevronRight size={15} /></button><button onClick={() => navigate("tasks")}><span className="glance-icon purple"><FileText size={21} /></span><strong>{weekTasks}</strong><span>tasks this week</span><ChevronRight size={15} /></button><button onClick={() => navigate("files")}><span className="glance-icon pink"><FolderOpen size={22} /></span><strong>{newFiles}</strong><span>new {newFiles === 1 ? "file" : "files"}</span><ChevronRight size={15} /></button></div>;
    }
    if (studyWidgetTypes.includes(type)) return <StudyWidget type={type} data={study} stats={stats} courses={courses} assignments={assignments} events={manualEvents} details={extraData.courseDetails} today={today} now={now.getTime()} system={activeGpaSystem} term={activeTerm} onOpen={() => setStudyOpen(true)} onAssignment={setSelectedAssignment} onEvent={(event) => setEditor({ event })} onCourse={setSelectedClass} onTimer={controlTimer} />;
    if (type === "upcoming") return <div className="compact-list">{assignments.filter((item) => item.status !== "done").slice(0, 4).map((assignment) => { const course = courseFor(courses, assignment.courseId); return <button key={assignment.id} className="compact-assignment" onClick={() => setSelectedAssignment(assignment)}><StatusBadge status={assignment.status} compact /><span><strong>{assignment.title}</strong><small>{course.code} · {assignment.due}</small></span><ChevronRight size={15} /></button>; })}</div>;
    if (type === "stoplight") return <div className="stoplight-summary"><button onClick={() => navigate("dashboard")}><span className="stoplight-count red"><AlertOctagon size={17} />{overdueAssignments.length}</span><span><strong>Overdue</strong><small>Needs attention</small></span></button><button onClick={() => navigate("dashboard")}><span className="stoplight-count amber"><Clock3 size={17} />{todayAssignments.length}</span><span><strong>Due today</strong><small>Before midnight</small></span></button><button onClick={() => navigate("dashboard")}><span className="stoplight-count green"><Circle size={17} />{assignments.filter((item) => item.status === "later").length}</span><span><strong>Upcoming</strong><small>After today</small></span></button></div>;
    if (type === "red-alerts") {
      const next = assignments.find((a) => a.status !== "done" && a.dateKey >= today);
      return <div className="reference-alerts">{next ? <button className="alert-upcoming" onClick={() => setSelectedAssignment(next)}><AlertOctagon size={22} /><span><strong>{next.title}</strong><small>{courseFor(courses, next.courseId).code} · {next.dateKey === today ? "Today" : next.dateKey === addDays(today, 1) ? "Tomorrow" : next.due}</small></span><ChevronRight size={15} /></button> : <div className="alert-upcoming"><Bell size={22} /><span><strong>No upcoming deadlines</strong><small>You’re all caught up</small></span></div>}<button className="alert-status" onClick={() => navigate("tasks")}><CheckCircle2 size={23} /><span>{overdueAssignments.length ? `${overdueAssignments.length} overdue ${overdueAssignments.length === 1 ? "task" : "tasks"}` : "No overdue work"}</span>{overdueAssignments.length > 0 && <ChevronRight size={15} />}</button></div>;
    }
    if (type === "mini-calendar") return <div className="mini-cal"><div className="mini-cal-month"><strong>{dateLabel(addDays(today, miniWeekOffset), { month: "long", year: "numeric" })}</strong><div><button aria-label="Previous week" onClick={() => setMiniWeekOffset((offset) => offset - 7)}><ChevronLeft size={16} /></button><button aria-label="Next week" onClick={() => setMiniWeekOffset((offset) => offset + 7)}><ChevronRight size={16} /></button><button className="mini-today" onClick={() => setMiniWeekOffset(0)}>Today</button></div></div><div className="mini-days">{Array.from({ length: 7 }, (_, i) => addDays(weekStart(today, profile.week_starts_on === "Monday"), i + miniWeekOffset)).map((date) => <button key={date} aria-label={dateLabel(date, { weekday: "long", month: "long", day: "numeric" })} className={date === today ? "today" : ""} onClick={() => navigate("calendar")}><small>{dateLabel(date, { weekday: "short" })}</small><strong>{Number(date.slice(-2))}</strong>{(assignments.some((a) => a.dateKey === date) || manualEvents.some((e) => e.dateKey === date)) && <i />}</button>)}</div></div>;
    if (type === "class-links") return <div className="class-link-grid">{courses.slice(0, 4).map((course) => <button key={course.id} onClick={() => { navigate("dashboard"); setSelectedClass(course); }}><CourseStamp course={course} small /><span><strong>{course.code}</strong><small>{course.name}</small></span><ChevronRight size={14} /></button>)}</div>;
    if (type === "notes") return <div className="notes-widget"><textarea id={`note-${widget.instanceId}`} aria-label="Quick notes" placeholder="Write a quick reminder…" value={widget.note ?? ""} maxLength={MAX_NOTES_LENGTH} onChange={(event) => updateWorkspaceWidgets((widgets) => widgets.map((item) => item.instanceId === widget.instanceId ? { ...item, note: event.target.value } : item))} /><div className="reference-note-footer"><span className="note-label"><FileText size={13} /> Quick note</span><button className="clear-note" disabled={!widget.note} onClick={() => { if (window.confirm("Clear this note's text?")) updateWorkspaceWidgets((widgets) => widgets.map((item) => item.instanceId === widget.instanceId ? { ...item, note: "" } : item)); }} aria-label="Clear notes"><Trash2 size={13} /></button><button className="primary-button save-note" disabled={persistenceStatus === "saving"} onClick={() => experimentalMode ? flash("Preview note updated — nothing saved to your account") : void autosave.flush()}><Save size={14} />{persistenceStatus === "saving" ? "Saving…" : "Save note"}</button></div></div>;
    if (type === "quote") return <div className="quote-widget"><QuoteIcon size={24} /><blockquote>Small, focused steps turn heavy weeks into manageable days.</blockquote><span>— Your Edu AI reminder</span></div>;
    return <div className="spacer-widget"><span>Spacer</span><p>This tile creates breathing room. Resize it to shape your layout.</p></div>;
  }

  function renderDashboard() {
    return (
      <div className="page">
        {renderPageHeader("Academic overview", "Your dashboard", "Classes, deadlines, and progress—without the clutter.", <><div className="view-toggle" role="group" aria-label="Dashboard view"><button className={dashboardView === "cards" ? "active" : ""} onClick={() => setDashboardView("cards")}><LayoutGrid size={16} /> Cards</button><button className={dashboardView === "list" ? "active" : ""} onClick={() => setDashboardView("list")}><List size={16} /> List</button></div><button className="primary-button" onClick={() => { setAddClassOpen(true); }}><Plus size={17} /> Add class</button></>)}

        <div className="summary-strip">
          <div><span className="summary-icon red"><AlertOctagon size={18} /></span><p><strong>{overdueAssignments.length}</strong><small>Overdue</small></p></div>
          <div><span className="summary-icon amber"><Clock3 size={18} /></span><p><strong>{todayAssignments.length}</strong><small>Due today</small></p></div>
          <div><span className="summary-icon green"><CheckCircle2 size={18} /></span><p><strong>{weeklyCompleted}</strong><small>Completed this week</small></p></div>
          <div className="summary-progress"><p><strong>{study.weeklyMinutes ? `${weeklyPercent}%` : "No target"}</strong><small>Weekly study goal</small></p><div className="completion-track"><span style={{ width: `${weeklyPercent}%` }} /></div></div>
        </div>

        <div className="academic-actions"><button className="secondary-button" onClick={() => setStudyOpen(true)}>Study goals, history & grades</button><button className="secondary-button" onClick={newAssignment}>Add assignment</button><button className="secondary-button" onClick={newReview}>Import syllabus</button>{extraData.syllabusDrafts.map((draft) => <button className="secondary-button" key={draft.id} onClick={() => setSyllabusId(draft.id)}>Resume {draft.course.code || "syllabus review"}</button>)}</div>
        {dashboardView === "cards" ? (
          <section>
            <div className="section-title-row"><div><h2>Your classes</h2><p>{courses.length} active courses · {courses.reduce((sum, course) => sum + course.credits, 0)} total credits</p></div><button className="text-button" onClick={() => setDashboardView("list")}>View every assignment <ArrowRight size={14} /></button></div>
            <div className="class-grid">
              {courses.map((course) => {
                const courseAssignments = assignments.filter((assignment) => assignment.courseId === course.id && assignment.status !== "done");
                return <button key={course.id} className="class-card" onClick={() => setSelectedClass(course)}>
                  <div className="class-card-visual" style={{ background: `linear-gradient(135deg, ${course.soft}, color-mix(in srgb, ${course.color} 18%, white))` }}>
                    {fileStore.files.filter((f) => f.course_id === course.id && f.kind === "class-image" && f.state === "ready" && !f.trashed_at).sort((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, 1).map((f) => <PrivateImage key={f.id} file={f} store={fileStore} />)}<span className="course-watermark">{course.initials}</span><span className="course-pill" style={{ color: course.color }}>{course.code}</span><BookOpen size={34} style={{ color: course.color }} />
                  </div>
                  <div className="class-card-body"><div><h3>{course.name}</h3><p>{course.instructor} · {course.credits} credits</p></div><div className="class-statuses"><span className="status-overdue"><AlertOctagon size={14} />{courseAssignments.filter((item) => item.status === "overdue").length}<small>overdue</small></span><span className="status-today"><Clock3 size={14} />{courseAssignments.filter((item) => item.status === "today").length}<small>today</small></span><span className="status-later"><Circle size={14} />{courseAssignments.filter((item) => item.status === "later").length}<small>later</small></span></div></div>
                </button>;
              })}
              <button className="class-card add-class-card" onClick={() => { setAddClassOpen(true); }}><span><Plus size={24} /></span><strong>Add another class</strong><small>Enter it manually or import a syllabus</small></button>
            </div>
          </section>
        ) : renderAssignmentTable(assignments)}

        {dashboardView === "cards" && <section className="dashboard-upcoming"><div className="section-title-row"><div><h2>Coming up</h2><p>Your nearest deadlines across every class.</p></div><button className="text-button" onClick={() => setDashboardView("list")}>See all <ArrowRight size={14} /></button></div>{renderAssignmentTable(assignments.filter((a) => a.status !== "done").slice(0, 5), true)}</section>}
      </div>
    );
  }

  function renderAssignmentTable(items: Assignment[], compact = false) {
    return <div className={`assignment-table ${compact ? "compact" : ""}`}>
      {!compact && <div className="assignment-table-head"><span>Status</span><span>Assignment</span><span>Class</span><span>Due</span><span>Progress</span><span /></div>}
      {!items.length && <p className="form-hint">No assignments yet.</p>}
      {items.map((assignment) => { const course = courseFor(courses, assignment.courseId); return <button className={`assignment-row ${assignment.status === "done" ? "completed" : ""}`} key={assignment.id} onClick={() => setSelectedAssignment(assignment)}>
        <span><StatusBadge status={assignment.status} /></span>
        <span className="assignment-title"><strong>{assignment.title}</strong>{compact && <small>{course.code}</small>}</span>
        {!compact && <span className="assignment-course"><CourseStamp course={course} small /><span><strong>{course.code}</strong><small>{course.name}</small></span></span>}
        <span className="assignment-due"><strong>{assignment.due.split(",")[0]}</strong><small>{assignment.due.includes(",") ? assignment.due.split(",").slice(1).join(",") : ""}</small></span>
        <span className="row-progress"><i><b style={{ width: `${assignment.progress}%` }} /></i><small>{assignment.progress}%</small></span>
        <ChevronRight size={16} />
      </button>; })}
    </div>;
  }

  function renderCalendar() {
    return <AcademicCalendar courses={courses} assignments={assignments} events={manualEvents} details={extraData.courseDetails} today={today} monday={profile.week_starts_on === "Monday"} timezone={profile.timezone} filter={calendarFilter} onFilter={setCalendarFilter} onAssignment={setSelectedAssignment} onEvent={(event) => setEditor({ event })} onCourse={setSelectedClass} onAdd={newEvent} />;
  }

  function renderSearch() {
    const query = searchQuery.toLowerCase().trim();
    const resultGroups = [
      { title: "Assignments", icon: CheckCircle2, items: assignments.filter((assignment) => !query || `${assignment.title} ${assignment.description} ${assignment.notes ?? ""} ${statusMeta[assignment.status].label} ${courseFor(courses, assignment.courseId).code}`.toLowerCase().includes(query)).map((assignment) => ({ id: assignment.id, title: assignment.title, subtitle: `${courseFor(courses, assignment.courseId).code} · ${assignment.due}`, badge: statusMeta[assignment.status].short, action: () => setSelectedAssignment(assignment) })) },
      { title: "Classes", icon: BookOpen, items: courses.filter((course) => !query || `${course.name} ${course.code} ${course.instructor} ${course.room} ${extraData.courseDetails[course.id]?.officeHours ?? ""}`.toLowerCase().includes(query)).map((course) => ({ id: course.id, title: course.name, subtitle: `${course.code} · ${course.instructor}`, badge: `${course.credits} credits`, action: () => setSelectedClass(course) })) },
      { title: "Files", icon: FileText, items: fileStore.files.filter((f) => !query || (f.name + " " + f.kind + " " + f.mime_type + " " + courseFor(courses, f.course_id ?? "").code).toLowerCase().includes(query)).map((f) => ({ id: f.id, title: f.name, subtitle: fileSize(Number(f.size_bytes)) + " · " + f.state, badge: f.kind, action: () => setFilePreview(f) })) },
      { title: "Events", icon: CalendarDays, items: manualEvents.filter((e) => !query || (e.title + " " + e.description + " " + e.type + " " + courseFor(courses, e.courseId).code).toLowerCase().includes(query)).map((e) => ({ id: e.id, title: e.title, subtitle: dateLabel(e.dateKey) + " · " + e.time, badge: e.type, action: () => setEditor({ event: e }) })) },
      { title: "Syllabus text", icon: FileText, items: courses.filter((c) => extraData.courseDetails[c.id]?.syllabusText && (!query || (extraData.courseDetails[c.id].syllabusText + " " + c.code).toLowerCase().includes(query))).map((c) => ({ id: c.id, title: c.code + " syllabus", subtitle: extraData.courseDetails[c.id].syllabusName ?? "Saved text", badge: "Syllabus", action: () => setSelectedClass(c) })) },
      { title: "Syllabus reviews", icon: FileSearch, items: extraData.syllabusDrafts.filter((d) => !query || (d.sourceText + " " + d.sourceName + " " + d.course.code + " " + d.items.map((i) => i.title).join(" ")).toLowerCase().includes(query)).map((d) => ({ id: d.id, title: d.course.code || d.sourceName || "Syllabus review", subtitle: d.sourceName, badge: "Draft", action: () => setSyllabusId(d.id) })) },
      { title: "Grades", icon: GraduationCap, items: study.grades.filter((g) => !query || (courseFor(courses, g.courseId).code + " " + g.term + " " + g.value + " " + g.system).toLowerCase().includes(query)).map((g) => ({ id: g.id, title: courseFor(courses, g.courseId).code + " grade", subtitle: g.value + " / " + g.max + " · " + g.term, badge: g.system, action: () => setStudyOpen(true) })) },
      { title: "Study history", icon: Clock3, items: study.sessions.filter((session) => !query || (session.kind + " " + courseFor(courses, session.courseId).code + " " + session.segments.at(-1)!.end).toLowerCase().includes(query)).map((session) => ({ id: session.id, title: courseFor(courses, session.courseId).code + " study session", subtitle: durationLabel(segmentSeconds(session.segments)) + " · " + session.segments.at(-1)!.end.slice(0, 10), badge: session.kind, action: () => setStudyOpen(true) })) },
      { title: "Notes", icon: StickyNote, items: workspaces.flatMap((workspace) => workspace.widgets.filter((widget) => widget.type === "notes").map((widget, index) => ({ id: widget.instanceId, title: `Quick notes ${index + 1} · ${workspace.name}`, subtitle: (widget.note ?? "").replace(/\n/g, " · "), badge: "Note", action: () => { navigate("home"); setActiveWorkspaceId(workspace.id); noteFocusRef.current = widget.instanceId; } }))).filter((item) => !query || `${item.title} ${item.subtitle}`.toLowerCase().includes(query)) },
    ];
    const resultCount = resultGroups.reduce((total, group) => total + group.items.length, 0);
    return <div className="page search-page">
      {renderPageHeader("Find anything", "Search your workspace", "Search saved text, file names, events, classes, grades, and study history. PDF/image contents are not indexed.")}
      <div className="global-search"><Search size={22} /><input aria-label="Search everything" value={searchQuery} onChange={(event) => setSearchQuery(event.target.value)} placeholder="Try “reflection,” “office hours,” or “MATH 101”…" />{searchQuery && <button onClick={() => setSearchQuery("")} aria-label="Clear search"><X size={18} /></button>}<kbd>⌘ K</kbd></div>
      {!query && <div className="search-suggestions"><span>Try searching</span>{["Due today", "Lab report", "Office hours", "Grading policy"].map((suggestion) => <button key={suggestion} onClick={() => setSearchQuery(suggestion)}>{suggestion}</button>)}</div>}
      <div className="search-meta"><strong>{resultCount} {query ? `results for “${searchQuery}”` : "items ready to search"}</strong><span>Results update as you type</span></div>
      {resultCount === 0 ? <div className="empty-search"><FileSearch size={30} /><h2>No results found</h2><p>Check the spelling or try a broader phrase.</p></div> : <div className="search-results">{resultGroups.filter((group) => group.items.length).map((group) => { const GroupIcon = group.icon; return <section key={group.title}><div className="result-group-title"><span><GroupIcon size={17} /></span><h2>{group.title}</h2><small>{group.items.length}</small></div><div>{group.items.map((item) => <button key={item.id} onClick={item.action}><span className="result-type-icon"><GroupIcon size={18} /></span><span><strong>{item.title}</strong><small>{item.subtitle}</small></span><em>{item.badge}</em><ChevronRight size={16} /></button>)}</div></section>; })}</div>}
    </div>;
  }

  function renderFiles() {
    const storedPreferences = extraData.filePreferences;
    const layoutMigrationPending = filesBrowserEnabled && storedPreferences.appearanceVersion !== FILES_BROWSER_APPEARANCE_VERSION;
    const prefs = filesBrowserEnabled ? migrateFilesBrowserPreferences(storedPreferences) : storedPreferences;
    if (filesBrowserEnabled) return <FilesBrowser
      profileId={initialProfile.id} courses={courses} assignments={storedAssignments} courseDetails={extraData.courseDetails}
      store={fileStore} layout={prefs.view}
      preferences={prefs} layoutMigrationPending={layoutMigrationPending} currentTerm={profile.current_term ?? ""} onFileOpened={handleFileOpened}
      onPreferencesChange={(filePreferences) => commitAcademic(courses, { filePreferences })}
      onLayoutChange={(view) => commitAcademic(courses, { filePreferences: { ...prefs, view } })}
      onOrganizationSaved={handleOrganizationSaved} onOrganizationStateChange={handleOrganizationState}
      dataRevision={filesDataRevision}
      onTrashCompleted={handleTrashCompleted}
      onUpload={(folderId, courseId) => { if (!organizationState && !nativeDocumentDialog) setUploadDialog({ profileId: initialProfile.id, folderId, courseId, generation: fileActionSession.generation, mode: "files" }); }}
      onUploadFolder={(folderId, courseId) => { if (!organizationState && !nativeDocumentDialog) setUploadDialog({ profileId: initialProfile.id, folderId, courseId, generation: fileActionSession.generation, mode: "folder" }); }}
      onUploadFiles={(files, folderId, courseId) => { if (!organizationState && !nativeDocumentDialog && canWriteFiles && !profilePending) { fileUploads.enqueue(files, { folderId, courseId }); setUploadDialog({ profileId: initialProfile.id, folderId, courseId, generation: fileActionSession.generation, mode: "files" }); } }}
      onNewTextFile={(folderId, courseId, name) => { if (canWriteFiles && !profilePending && !nativeDocumentDialog && !organizationState) setNativeDocumentDialog({ create: { id: crypto.randomUUID(), folderId, courseId, name, body: "" } }); }}
      onOpen={(file, options) => { if (nativeDocumentDialog || organizationState) return; if (file.content_backend === "native-text" && file.state === "ready" && !file.trashed_at) setNativeDocumentDialog({ file, readOnly: options?.readOnly }); else { setFilePreviewReadOnly(!!options?.readOnly); setFilePreview(file); } }}
      onEdit={(initial) => { if (!organizationState) setFileDialog({ initial }); }}
      canWrite={canWriteFiles && !profilePending && !nativeDocumentDialog}
      onAttachSyllabus={(courseId, folderId) => { if (canWriteFiles && !profilePending && !organizationState) setSyllabusAttachment({ courseId, folderId }); }}
      onSyllabusText={setSyllabusTextCourseId}
      onOpenSyllabus={(file) => { setSyllabusPreviewFileId(file.id); setFilePreview(file); }}
    />;
    const visible = fileStore.files.filter((f) => (prefs.filter === "all" || (prefs.filter === "personal" ? !f.course_id : f.course_id === prefs.filter)) && (!fileQuery || (f.name + " " + f.kind + " " + courseFor(courses, f.course_id ?? "").code).toLowerCase().includes(fileQuery.toLowerCase())));
    return <div className={"page files-page file-view-" + prefs.view}>{renderPageHeader("Resources", "Your private files", "Original files are stored privately with your account.", <button className="primary-button" disabled={!canWriteFiles} onClick={() => setFileDialog({})}>Upload file</button>)}
      <div className="files-toolbar"><label>Search files<input aria-label="Search files" value={fileQuery} onChange={(e) => setFileQuery(e.target.value)} /></label><label>File class filter<select value={prefs.filter} onChange={(e) => commitAcademic(courses, { filePreferences: { ...prefs, filter: e.target.value } })}><option value="all">All classes and personal</option><option value="personal">Personal</option>{courses.map((c) => <option key={c.id} value={c.id}>{c.code}</option>)}</select></label><label>File view<select value={prefs.view} onChange={(e) => commitAcademic(courses, { filePreferences: { ...prefs, view: e.target.value as "list" | "grid" } })}><option value="list">List</option><option value="grid">Grid</option></select></label><button className="secondary-button" disabled={fileStore.busy} onClick={() => void fileStore.refresh()}>Refresh files</button></div>
      <p>{fileSize(fileStore.files.filter((f) => f.state === "ready").reduce((sum, f) => sum + Number(f.size_bytes), 0))} in ready files · {fileStore.files.length} / 1,000 files · 25 MiB maximum per file</p>
      {fileStore.loading && <p>Loading files…</p>}<FileList files={visible} store={fileStore} onOpen={setFilePreview} onEdit={(initial) => setFileDialog({ initial })} onTrashed={handleLegacyTrashed} canWrite={canWriteFiles} />
    </div>;
  }

  function renderSettings() {
    const accountActionBlocked = profilePending || saveState.dirty || fileStore.busy || fileUploads.dirty || fileUploads.busy || !!pendingFolderUpload || !!nativeDocumentDraft?.dirty || !!organizationState?.dirty || !!organizationState?.busy || undoBusy;
    return <div className="page settings-page">
      {renderPageHeader("Make it yours", "Settings", "Your profile and preferences follow your Google account.")}
      <ProfileEditor initialProfile={profile} onSaved={setProfile} onDraftChange={handleProfileDraft} />
      <section className="settings-card"><h2>Account & data</h2><div className="data-actions">
        <a className="secondary-button" aria-disabled={accountActionBlocked} onClick={(e) => { if (accountActionBlocked) e.preventDefault(); }} href={"/api/export?account=" + encodeURIComponent(initialProfile.id)} target="_blank" rel="noopener noreferrer">Export saved account (.zip)</a>
        <button className="secondary-button" onClick={downloadUnsavedWork}>Download current drafts (.json)</button>
        <form action="/auth/signout" method="post"><button className="secondary-button" disabled={accountActionBlocked}>Sign out</button></form>
      </div>{accountActionBlocked && <p className="form-hint">Save or discard pending edits before signing out. Download a draft first if you want to keep a copy.</p>}</section>
    </div>;
  }

  function renderWidgetPicker() {
    const filtered = widgetTemplates.filter((template) => `${template.title} ${template.description}`.toLowerCase().includes(widgetSearch.toLowerCase()));
    return <div className="modal-backdrop"><div className="widget-picker-modal" role="dialog" aria-modal="true" aria-labelledby="widget-picker-title"><div className="modal-header"><div><p className="eyebrow">Customize {activeWorkspace.name}</p><h2 id="widget-picker-title">Add a widget</h2><p>Choose a study tile, then move and resize it on your grid.</p></div><button className="icon-button" onClick={() => { setWidgetPickerOpen(false); setWidgetSearch(""); }} aria-label="Close widget picker"><X size={20} /></button></div><div className="picker-search"><Search size={17} /><input aria-label="Search widgets" placeholder="Search 18 widgets…" value={widgetSearch} onChange={(event) => setWidgetSearch(event.target.value)} /></div><div className="widget-picker-grid">{filtered.map((template) => { const Icon = template.icon; return <button key={template.type} disabled={activeWorkspace.widgets.length >= MAX_WIDGETS_PER_WORKSPACE} onClick={() => addWidget(template.type)}><span className={`picker-icon tone-${template.color}`}><Icon size={20} /></span><span><strong>{template.title}</strong><small>{template.description}</small></span><Plus size={18} /></button>; })}</div><div className="picker-footer"><span>{activeWorkspace.widgets.length} / {MAX_WIDGETS_PER_WORKSPACE} widgets · Drag or use Move earlier/later</span><button className="primary-button" onClick={() => setWidgetPickerOpen(false)}>Done</button></div></div></div>;
  }

  function renderWorkspaceDialog() {
    return <div className="modal-backdrop"><form className="small-modal" onSubmit={(event) => { event.preventDefault(); if (workspaceDialog === "new") createWorkspace(); else renameWorkspace(); }}><div className="modal-header"><div><p className="eyebrow">Home workspace</p><h2>{workspaceDialog === "new" ? "Create a new workspace" : "Rename workspace"}</h2></div><button type="button" className="icon-button" onClick={() => setWorkspaceDialog(null)}><X size={19} /></button></div><label>Workspace name<input required maxLength={80} value={workspaceNameDraft} onChange={(event) => setWorkspaceNameDraft(event.target.value)} placeholder="e.g. Finals Prep" /></label><p className="form-hint">New workspaces start empty so you can build them exactly how you want.</p><div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setWorkspaceDialog(null)}>Cancel</button><button className="primary-button">{workspaceDialog === "new" ? "Create workspace" : "Save name"}</button></div></form></div>;
  }

  function renderClassDetail(course: Course) {
    const items = assignments.filter((a) => a.courseId === course.id), details = extraData.courseDetails[course.id] ?? emptyCourseDetails();
    const average = study.grades.find((g) => g.courseId === course.id && g.system === activeGpaSystem && g.term === activeTerm);
    const studySeconds = study.sessions.filter((s) => s.courseId === course.id).reduce((sum, s) => sum + segmentSeconds(s.segments), 0);
    return <div className="modal-backdrop side-panel-backdrop"><aside className="detail-panel" role="dialog" aria-modal="true" aria-label="Class details"><div className="modal-header"><h2>{course.code} · {course.name}</h2><button className="secondary-button" onClick={() => setSelectedClass(null)}>Close class</button></div><div className="detail-panel-body"><p>{course.credits} credits · {course.room || "No location entered"}</p><h3>Files and images</h3><button className="secondary-button" disabled={!canWriteFiles} onClick={() => setFileDialog({ defaults: { courseId: course.id } })}>Add class file</button><button className="secondary-button" disabled={!canWriteFiles} onClick={() => setFileDialog({ defaults: { courseId: course.id, kind: "class-image" } })}>Upload class image</button><FileList files={fileStore.files.filter((f) => f.course_id === course.id)} store={fileStore} onOpen={setFilePreview} onEdit={(initial) => setFileDialog({ initial })} onTrashed={handleLegacyTrashed} canWrite={canWriteFiles} />{details.syllabusFileId && <button className="secondary-button" onClick={() => { const next = { ...details }; delete next.syllabusFileId; commitAcademic(courses, { courseDetails: { ...extraData.courseDetails, [course.id]: next } }); }}>Detach syllabus file</button>}<h3>Progress</h3><p>{durationLabel(studySeconds)} recorded study · {items.filter((a) => a.status === "done").length} / {items.length} assignments complete</p><p>{average ? `Grade: ${average.value.toFixed(2)} / ${average.max}` : "No matching grade entered"} · {activeTerm || "Unspecified term"}</p><button className="text-button" onClick={() => { setSelectedClass(null); setStudyOpen(true); }}>Study history & grades</button><h3>Instructor</h3><p>{course.instructor || "No instructor entered"}</p><h3>Office hours</h3><p>{details.officeHours || "No office hours entered"}</p><h3>Schedule</h3>{details.meetings.length ? details.meetings.map((m) => <p key={m.id}>{m.days.map((day) => ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day]).join(", ")} · {m.start}–{m.end} · {m.location || course.room}<br />{dateLabel(m.from)} – {dateLabel(m.until)}</p>) : <p>No recurring meetings entered.</p>}<div className="modal-actions"><button className="primary-button" onClick={() => { setEditor({ course, details }); setSelectedClass(null); }}>Edit class</button><button className="secondary-button" onClick={() => { setCalendarFilter(course.id); setSelectedClass(null); navigate("calendar"); }}>View schedule</button></div><h3>Assignments</h3>{renderAssignmentTable(items, true)}<button className="secondary-button" onClick={() => { setSelectedClass(null); setEditor({ assignment: { id: uid("assignment"), title: "", courseId: course.id, due: "", dateKey: today, type: "Assignment", status: "later", progress: 0, description: "", weight: "" } }); }}>Add assignment</button>{details.syllabusText && <details><summary>Saved syllabus source</summary><pre className="syllabus-source">{details.syllabusText}</pre></details>}<button className="secondary-button full remove-class-button" onClick={() => removeClass(course)}>Remove class</button></div></aside></div>;
  }

  function renderAssignmentDetail(assignment: Assignment) {
    const current = storedAssignments.find((a) => a.id === assignment.id) ?? assignment;
    const course = courseFor(courses, current.courseId);
    return <div className="modal-backdrop"><section className="assignment-modal academic-editor" role="dialog" aria-modal="true" aria-label="Assignment details"><div className="modal-header"><div><p>{course.code} · {current.type ?? "Assignment"}</p><h2>{current.title}</h2></div><button className="secondary-button" onClick={() => setSelectedAssignment(null)}>Close assignment</button></div><p>Due {dateLabel(current.dateKey)} {current.dueTime ?? ""}</p><StatusBadge status={assignmentStatus(current, today)} /><p>{current.description || "No description entered."}</p><p>Weight: {current.weight || "Not entered"} · Progress: {current.progress}%</p><h3>Attachments</h3><button className="secondary-button" disabled={!canWriteFiles} onClick={() => setFileDialog({ defaults: { courseId: current.courseId, assignmentId: current.id, kind: "attachment" } })}>Attach file</button><FileList files={fileStore.files.filter((f) => f.assignment_id === current.id)} store={fileStore} onOpen={setFilePreview} onEdit={(initial) => setFileDialog({ initial })} onTrashed={handleLegacyTrashed} canWrite={canWriteFiles} /><h3>Notes</h3><p className="syllabus-source">{current.notes || "No notes yet."}</p><ul>{["Review instructions and rubric", "Complete first draft", "Proofread and submit"].map((label, i) => <li key={label}>{current.checklist?.[i] ? "✓" : "○"} {label}</li>)}</ul><div className="modal-actions"><button className="primary-button" onClick={() => { setEditor({ assignment: current }); setSelectedAssignment(null); }}>Edit assignment</button><button className="secondary-button" onClick={() => toggleAssignmentComplete(current.id)}>{current.status === "done" ? "Mark incomplete" : "Mark complete"}</button><button className="secondary-button" onClick={() => { if (window.confirm("Delete this assignment and its notes?")) { if (commitAcademic(courses, { assignments: storedAssignments.filter((a) => a.id !== current.id) })) setSelectedAssignment(null); } }}>Delete assignment</button></div></section></div>;
  }

  function renderAddClassDialog() {
    return <div className="modal-backdrop"><section className="small-modal" role="dialog" aria-modal="true" aria-label="Add a class"><div className="modal-header"><h2>Add a class</h2><button className="secondary-button" onClick={() => setAddClassOpen(false)}>Close</button></div><div className="modal-actions"><button className="primary-button" onClick={() => { setEditor({ course: emptyCourse(uid("course")), details: emptyCourseDetails() }); setAddClassOpen(false); }}>Manual entry</button><button className="secondary-button" onClick={newReview}>Import syllabus</button></div><h3>Saved syllabus reviews</h3>{extraData.syllabusDrafts.length ? extraData.syllabusDrafts.map((draft) => <button className="secondary-button" key={draft.id} onClick={() => { setSyllabusId(draft.id); setAddClassOpen(false); }}>{draft.course.code || draft.sourceName || "Untitled review"}</button>) : <p>No pending reviews.</p>}</section></div>;
  }

}
