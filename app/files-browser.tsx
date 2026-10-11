"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type DragEvent as ReactDragEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent } from "react";
import {
  Archive,
  ArrowLeft,
  BookOpen,
  ChevronRight,
  ChevronDown,
  Clock3,
  Check,
  CloudUpload,
  Download,
  File as FileIcon,
  FileImage,
  FileText,
  Folder,
  FolderPlus,
  FolderOpen,
  Grid2X2,
  Info,
  LayoutList,
  MoreHorizontal,
  Plus,
  Pencil,
  Pin,
  RotateCcw,
  RefreshCw,
  Move,
  Star,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import { downloadFileName, fileSize, type PrivateFile } from "../lib/files";
import type { FileFolder } from "../lib/file-organization";
import type { Course, CourseDetails } from "../lib/academics";
import type { SavedAssignment } from "../lib/workspace-codec";
import { browserItemLocation, deriveFilesBrowser, type BrowserItem, type FilesBrowserPreferences } from "../lib/files-browser";
import { itemTrashReason, originalDisplayPath, type TrashUndoReceipt } from "../lib/files-trash-operations";
import {
  associationDiffersFromLocation,
  folderCourseId,
  folderDestinationReason,
  moveBrowserItems,
  moveDestinationReason,
  BrowserOrganizationFailure,
} from "../lib/files-browser-operations";
import { setBrowserItemStarred } from "../lib/files-browser-activity";
import { downloadSelectedFilesZip, type SelectedFileDownloadItem } from "../lib/files-download-client";
import { useFilesBrowserData, useFilesBrowserLocation } from "./use-files-browser";
import type { FileStore } from "./use-private-files";
import FileOrganizationDialog, { type OrganizationDialogReport, type OrganizationDialogRequest } from "./file-organization-dialogs";
import { PinnedSyllabus, SyllabusTextPreview } from "./course-syllabus";
import { suggestedTextFileName } from "../lib/native-documents";
import { useSaveProtection } from "./use-save-protection";
import FilesTrashDialog, { type TrashDialogAction, type TrashDialogRequest } from "./files-trash-dialog";
import FilesBrowserTools, { type BrowserFileType, type BrowserSearchScope, type BrowserSortBy, type BrowserSortDirection } from "./files-browser-tools";
import FileArchiveDialog, { type ArchiveDialogRequest } from "./file-archive-dialog";
import FilesCardPreview from "./files-card-preview";
import "./files-browser.css";

type FilesBrowserProps = {
  profileId: string;
  courses: Course[];
  assignments?: Pick<SavedAssignment, "id" | "title" | "courseId">[];
  store: FileStore;
  layout: "list" | "grid";
  layoutMigrationPending?: boolean;
  onLayoutChange: (layout: "list" | "grid") => void;
  onUpload: (folderId: string | null, courseId: string) => void;
  onUploadFolder?: (folderId: string | null, courseId: string) => void;
  onUploadFiles?: (files: File[], folderId: string | null, courseId: string) => void;
  onOpen: (file: PrivateFile, options?: { readOnly?: boolean }) => void;
  onEdit: (file: PrivateFile) => void;
  canWrite: boolean;
  courseDetails?: Record<string, CourseDetails>;
  onAttachSyllabus?: (courseId: string, folderId: string) => void;
  onSyllabusText?: (courseId: string) => void;
  onOpenSyllabus?: (file: PrivateFile) => void;
  onNewTextFile?: (folderId: string | null, courseId: string, name: string) => void;
  onOrganizationSaved?: (signal?: AbortSignal) => Promise<void> | void;
  onOrganizationStateChange?: (report: OrganizationDialogReport | null) => void;
  onTrashCompleted?: (receipt: TrashUndoReceipt) => void;
  preferences?: FilesBrowserPreferences;
  onPreferencesChange?: (next: FilesBrowserPreferences) => void;
  currentTerm?: string;
  onFileOpened?: (file: PrivateFile) => void;
  dataRevision?: number;
};

type FilesView = "my-files" | "recent" | "starred" | "archives" | "trash";

const viewOptions: { id: FilesView; label: string; icon: typeof FolderOpen }[] = [
  { id: "my-files", label: "My files", icon: FolderOpen },
  { id: "recent", label: "Recent", icon: Clock3 },
  { id: "starred", label: "Starred", icon: Star },
  { id: "archives", label: "Archives", icon: Archive },
  { id: "trash", label: "Trash", icon: Trash2 },
];

type FilesMenuTarget = { kind: "item"; item: BrowserItem } | { kind: "new" } | { kind: "background" };
type ActivityRetry = { profileId: string; item: BrowserItem; starred: boolean; committed: boolean };
type DownloadRetry = {
  id: number;
  profileId: string;
  sessionVersion: number;
  items: BrowserItem[];
  error: string;
  busy: boolean;
};

const DRAG_TYPE = "application/x-eduessentials-files-browser";
const EMPTY_BROWSER_ITEMS: BrowserItem[] = [];

function restoreOrganizationFocus(root: HTMLElement | null, trigger: HTMLElement | null) {
  if (trigger?.isConnected && !trigger.matches(":disabled")) {
    trigger.focus({ preventScroll: true });
    return;
  }
  // Dialog reports can remount the toolbar. Recover the same action in its
  // current DOM before falling back to the containing location.
  const action = trigger?.dataset.filesSelectionAction;
  const selector = action === "move" ? '[data-files-selection-action="move"]'
    : action === "trash" ? '[data-files-selection-action="trash"]'
      : action === "restore" ? '[data-files-selection-action="restore"]' : null;
  const replacement = selector ? root?.querySelector<HTMLElement>(selector) : null;
  const target = replacement && !replacement.matches(":disabled")
    ? replacement : root?.querySelector<HTMLElement>(".files-breadcrumbs > button");
  target?.focus({ preventScroll: true });
}

type FileSystemEntryLike = { isDirectory?: boolean };

function isExternalFileTransfer(transfer: DataTransfer) {
  return transfer.files.length > 0 || transfer.types.includes("Files") || Array.from(transfer.items ?? []).some((item) => item.kind === "file");
}

function includesDroppedDirectory(transfer: DataTransfer) {
  for (const item of Array.from(transfer.items ?? [])) {
    const entryItem = item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntryLike | null };
    if (entryItem.webkitGetAsEntry?.()?.isDirectory) return true;
  }
  return Array.from(transfer.files).some((file) => Boolean((file as File & { webkitRelativePath?: string }).webkitRelativePath));
}

function itemKey(item: BrowserItem) {
  return `${item.type}:${item.id}`;
}

function isItemTrashed(item: BrowserItem) {
  return item.type === "file" ? Boolean(item.file.trashed_at) : Boolean(item.folder.trashed_at);
}

function snapshotItem(item: BrowserItem): BrowserItem {
  return item.type === "file"
    ? { type: "file", id: item.id, file: { ...item.file } }
    : { type: "folder", id: item.id, folder: { ...item.folder } };
}

function snapshotFolders(folders: readonly FileFolder[]) {
  return folders.map((folder) => ({ ...folder }));
}

function folderLocationLabel(folderId: string | null, folders: readonly FileFolder[]) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const path: string[] = [];
  const visited = new Set<string>();
  let currentId = folderId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const folder = byId.get(currentId);
    if (!folder) break;
    path.unshift(folder.name);
    currentId = folder.parent_id;
  }
  return path.length ? `My files / ${path.join(" / ")}` : "My files";
}

function displayDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

function displayDateTime(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit" }).format(date);
}

type TrashMetadata = { original_location_path?: string | null; purge_pending_at?: string | null; deleted_at?: string | null };

function itemPurgePending(item: BrowserItem) {
  if (item.type === "file") return item.file.state === "deleting";
  const folder = item.folder as FileFolder & TrashMetadata;
  return Boolean(folder.purge_pending_at);
}

function countTrashSelection(items: readonly BrowserItem[], folders: readonly FileFolder[], files: readonly PrivateFile[]) {
  const included = new Set<string>();
  const folderIds = new Set(items.filter((item) => item.type === "folder").map((item) => item.id));
  for (const item of items) if (item.type === "file") included.add(`file:${item.id}`);
  for (const id of folderIds) included.add(`folder:${id}`);
  let changed = true;
  while (changed) {
    changed = false;
    for (const folder of folders) {
      if (!included.has(`folder:${folder.id}`) && folder.parent_id && folderIds.has(folder.parent_id) &&
          !folder.trashed_at && !folder.deleted_at && !folder.purge_pending_at) {
        included.add(`folder:${folder.id}`);
        folderIds.add(folder.id);
        changed = true;
      }
    }
  }
  for (const file of files) {
    if (!file.trashed_at && !file.deleted_at && folderIds.has(file.folder_id ?? "")) included.add(`file:${file.id}`);
  }
  return included.size;
}

function countRestoreSelection(items: readonly BrowserItem[], folders: readonly FileFolder[], files: readonly PrivateFile[], includeIndependent = false) {
  const included = new Set<string>();
  for (const item of items) {
    if (item.type === "file") {
      included.add(`file:${item.id}`);
      continue;
    }
    const operationId = item.folder.trash_operation_id;
    const folderIds = new Set<string>([item.id]);
    included.add(`folder:${item.id}`);
    let changed = true;
    while (changed) {
      changed = false;
      for (const folder of folders) {
        const parentId = folder.original_parent_id ?? folder.parent_id;
        const sameOperation = includeIndependent || folder.trash_operation_id === operationId;
        if (!folderIds.has(folder.id) && folder.trashed_at && !folder.deleted_at && sameOperation && parentId && folderIds.has(parentId)) {
          folderIds.add(folder.id);
          included.add(`folder:${folder.id}`);
          changed = true;
        }
      }
    }
    for (const file of files) {
      const sameOperation = includeIndependent || file.trash_operation_id === operationId;
      if (file.trashed_at && !file.deleted_at && sameOperation && folderIds.has(file.original_folder_id ?? file.folder_id ?? "")) {
        included.add(`file:${file.id}`);
      }
    }
  }
  return included.size;
}

function downloadRevision(item: BrowserItem): SelectedFileDownloadItem {
  return { type: item.type, id: item.id, revision: item.type === "file" ? item.file.metadata_revision : item.folder.revision };
}

function fileIcon(file: PrivateFile) {
  if (file.mime_type.startsWith("image/")) return FileImage;
  if (file.mime_type === "text/plain" || file.mime_type === "application/pdf") return FileText;
  return FileIcon;
}

function filePreviewColor(file: PrivateFile) {
  const mime = file.mime_type.toLowerCase();
  const name = file.name.toLowerCase();
  if (mime === "application/pdf" || name.endsWith(".pdf")) return "#ff555f";
  if (mime.includes("presentation") || /\.(ppt|pptx|key)$/.test(name)) return "#ff7043";
  if (mime.includes("spreadsheet") || mime.includes("excel") || /\.(xls|xlsx|csv)$/.test(name)) return "#19c981";
  if (mime.startsWith("image/")) return "#a46dff";
  return "#a6c4f4";
}

function displayCardDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function fileCourseName(file: PrivateFile, courses: Course[]) {
  if (!file.course_id) return "Personal";
  const course = courses.find((candidate) => candidate.id === file.course_id);
  return course ? `${course.code || course.name}` : "Personal";
}

function folderCourse(folder: FileFolder, courses: Course[]) {
  return folder.course_id ? courses.find((course) => course.id === folder.course_id) : undefined;
}

function archivedCourseSnapshot(item: BrowserItem, folders: readonly FileFolder[]) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  let folderId = item.type === "folder" ? item.folder.id : item.file.folder_id;
  const visited = new Set<string>();
  while (folderId && !visited.has(folderId)) {
    visited.add(folderId);
    const folder = byId.get(folderId);
    if (!folder) return undefined;
    if (folder.kind === "course" && (folder.archived_at || folder.course_name_snapshot || folder.course_color_snapshot)) return folder;
    folderId = folder.parent_id;
  }
  return undefined;
}

function courseColor(folder: FileFolder, courses: Course[], folders: readonly FileFolder[]) {
  const snapshot = archivedCourseSnapshot({ type: "folder", id: folder.id, folder }, folders);
  if (snapshot) return snapshot.course_color_snapshot || "#8da6cc";
  return folderCourse(folder, courses)?.color || folder.course_color_snapshot || "#8da6cc";
}

function fileColor(file: PrivateFile, courses: Course[], folders: readonly FileFolder[]) {
  const snapshot = archivedCourseSnapshot({ type: "file", id: file.id, file }, folders);
  if (snapshot) return snapshot.course_color_snapshot || "#8da6cc";
  return courses.find((course) => course.id === file.course_id)?.color || "#8da6cc";
}

function describeFileStatus(file: PrivateFile) {
  if (file.state === "deleting") return "Permanent deletion pending";
  if (file.trashed_at) return "In Trash";
  if (file.state === "pending") return "Upload pending";
  return "Ready";
}

function itemName(item: BrowserItem) {
  return item.type === "file" ? item.file.name : item.folder.name;
}

function createProfileSessionStore(initialProfileId: string) {
  let snapshot = { profileId: initialProfileId, version: 0 };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setProfile: (nextProfileId: string) => {
      if (snapshot.profileId === nextProfileId) return snapshot;
      snapshot = { profileId: nextProfileId, version: snapshot.version + 1 };
      listeners.forEach((listener) => listener());
      return snapshot;
    },
  };
}

export default function FilesBrowser({
  profileId,
  courses,
  assignments = [],
  store,
  layout,
  layoutMigrationPending = false,
  onLayoutChange,
  onUpload,
  onUploadFolder,
  onUploadFiles,
  onOpen,
  onEdit,
  canWrite,
  courseDetails,
  onAttachSyllabus,
  onSyllabusText,
  onOpenSyllabus,
  onNewTextFile,
  onOrganizationSaved,
  onOrganizationStateChange,
  onTrashCompleted,
  preferences,
  onPreferencesChange,
  currentTerm,
  onFileOpened,
  dataRevision,
}: FilesBrowserProps) {
  const browserData = useFilesBrowserData(profileId, store.files);
  const refreshBrowserData = browserData.refresh;
  const data = browserData.data;
  const dataRevisionRef = useRef({ profileId, value: dataRevision });
  useEffect(() => {
    const previous = dataRevisionRef.current;
    dataRevisionRef.current = { profileId, value: dataRevision };
    if (previous.profileId === profileId && previous.value !== dataRevision && dataRevision !== undefined) void refreshBrowserData();
  }, [dataRevision, profileId, refreshBrowserData]);
  const { location, navigate, setLayout } = useFilesBrowserLocation(layout, layoutMigrationPending);
  const [profileSessionStore] = useState(() => createProfileSessionStore(profileId));
  const profileSession = useSyncExternalStore(profileSessionStore.subscribe, profileSessionStore.getSnapshot, profileSessionStore.getSnapshot);
  const profileSessionRef = useRef({ profileId, version: 0 });
  const [localPreferences, setLocalPreferences] = useState<FilesBrowserPreferences>(() => ({ filter: "all", view: layout }));
  const activePreferences = preferences ?? localPreferences;
  const latestPreferencesRef = useRef(activePreferences);
  useLayoutEffect(() => { latestPreferencesRef.current = activePreferences; }, [activePreferences]);
  const updatePreferences = (patch: Partial<FilesBrowserPreferences>) => {
    const next = { ...latestPreferencesRef.current, ...patch };
    if (layoutMigrationPending) setLayout(location.layout, true);
    latestPreferencesRef.current = next;
    setLocalPreferences(next);
    onPreferencesChange?.(next);
  };
  const [queryState, setQueryState] = useState<{ profileId: string; value: string }>({ profileId, value: "" });
  const searchQuery = queryState.profileId === profileId ? queryState.value : "";
  const setSearchQuery = (value: string) => setQueryState({ profileId, value });
  const [searchScope, setSearchScope] = useState<BrowserSearchScope>("folder");
  const preferencesFileType: BrowserFileType = activePreferences.fileType ?? "all";
  const preferencesSortBy: BrowserSortBy = activePreferences.sortBy ?? "name";
  const preferencesSortDirection: BrowserSortDirection = activePreferences.sortDirection ?? "asc";
  const includeArchived = Boolean(activePreferences.includeArchived);
  const result = deriveFilesBrowser(data, location, {
    query: searchQuery,
    searchScope: location.view === "my-files" ? searchScope : "folder",
    courseFilter: activePreferences.filter || "all",
    fileType: preferencesFileType,
    sortBy: preferencesSortBy,
    sortDirection: preferencesSortDirection,
    includeArchived,
  });
  const selectionScope = `${profileId}:${profileSession.version}:${location.view}:${location.folderId ?? "root"}`;
  const [menuTarget, setMenuTarget] = useState<FilesMenuTarget | null>(null);
  const [coursesExpanded, setCoursesExpanded] = useState(false);
  const [pinnedPickerOpen, setPinnedPickerOpen] = useState(false);
  const [menuPoint, setMenuPoint] = useState({ x: 0, y: 0 });
  const [detailsItem, setDetailsItem] = useState<BrowserItem | null>(null);
  const [localSyllabusText, setLocalSyllabusText] = useState<{ course: Course; text: string; name: string } | null>(null);
  const [selectionState, setSelectionState] = useState<{ scope: string; items: BrowserItem[] }>({ scope: "", items: [] });
  const selectedItems = selectionState.scope === selectionScope ? selectionState.items : EMPTY_BROWSER_ITEMS;
  const setSelectedItems = (next: BrowserItem[] | ((current: BrowserItem[]) => BrowserItem[])) => {
    setSelectionState((current) => ({ scope: selectionScope, items: typeof next === "function" ? next(current.scope === selectionScope ? current.items : []) : next }));
  };
  const [organizationDialog, setOrganizationDialog] = useState<OrganizationDialogRequest | null>(null);
  const [archiveDialog, setArchiveDialog] = useState<ArchiveDialogRequest | null>(null);
  const [trashDialog, setTrashDialog] = useState<TrashDialogRequest | null>(null);
  const [trashNotice, setTrashNotice] = useState("");
  const [downloadState, setDownloadState] = useState<DownloadRetry | null>(null);
  const [uploadDropMessage, setUploadDropMessage] = useState("");
  const [externalDropActive, setExternalDropActive] = useState(false);
  const [organizationBusy, setOrganizationBusy] = useState(false);
  const [organizationError, setOrganizationError] = useState("");
  const [activityBusy, setActivityBusy] = useState(false);
  const [activityError, setActivityError] = useState("");
  const [activityRetry, setActivityRetry] = useState<ActivityRetry | null>(null);
  const [dropTargetState, setDropTargetState] = useState<{ scope: string; id: string } | null>(null);
  const dropTargetId = dropTargetState?.scope === selectionScope ? dropTargetState.id : null;
  const setDropTargetId = (id: string | null) => setDropTargetState(id === null ? null : { scope: selectionScope, id });
  const menuRef = useRef<HTMLDivElement>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const browserRootRef = useRef<HTMLElement>(null);
  const lastTriggerRef = useRef<HTMLElement | null>(null);
  const triggerForMenuRef = useRef<HTMLElement | null>(null);
  const organizationTriggerRef = useRef<HTMLElement | null>(null);
  const trashTriggerRef = useRef<HTMLElement | null>(null);
  const restoreFocusAfterVisibilityRef = useRef(false);
  const activityReportActiveRef = useRef(false);
  const downloadReportActiveRef = useRef(false);
  const downloadReportSignatureRef = useRef("");
  const profileIdRef = useRef(profileId);
  const organizationStateCallbackRef = useRef(onOrganizationStateChange);
  const dragSessionRef = useRef<{ nonce: string; profileId: string; locationKey: string; items: BrowserItem[]; folders: FileFolder[] } | null>(null);
  const dragAbortRef = useRef<AbortController | null>(null);
  const downloadAbortRef = useRef<{ controller: AbortController; runId: number } | null>(null);
  const downloadRunIdRef = useRef(0);
  const activityAbortRef = useRef<AbortController | null>(null);
  const menuAnchorRef = useRef({ left: 0, top: 0 });

  useLayoutEffect(() => {
    profileIdRef.current = profileId;
    if (profileSessionRef.current.profileId !== profileId) {
      profileSessionRef.current = profileSessionStore.setProfile(profileId);
      activityAbortRef.current?.abort(new DOMException("The active account changed.", "AbortError"));
      const activeDownload = downloadAbortRef.current;
      if (activeDownload) {
        activeDownload.controller.abort(new DOMException("The active account changed.", "AbortError"));
        setDownloadState((current) => current?.busy && current.id === activeDownload.runId
          ? { ...current, busy: false, error: "The active account changed. This download belongs to the previous account; dismiss it and reselect files before downloading." }
          : current);
      }
    }
    organizationStateCallbackRef.current = onOrganizationStateChange;
  }, [onOrganizationStateChange, profileId, profileSessionStore]);

  const courseById = useMemo(() => new Map(courses.map((course) => [course.id, course])), [courses]);
  const folderById = useMemo(() => new Map(data.folders.map((folder) => [folder.id, folder])), [data.folders]);
  const courseFolders = useMemo(() => data.folders
    .filter((folder) => folder.kind === "course" && folder.course_id && folder.parent_id === null && !folder.archived_at && !folder.trashed_at)
    .sort((left, right) => (courseById.get(left.course_id ?? "")?.name || left.name).localeCompare(courseById.get(right.course_id ?? "")?.name || right.name)), [courseById, data.folders]);
  const pinnedFolders = useMemo(() => data.folders
    .filter((folder) => Boolean(data.folderActivity[folder.id]?.starred_at) && !folder.archived_at && !folder.trashed_at && browserItemLocation({ type: "folder", id: folder.id, folder }, data.folders).view === "my-files")
    .sort((left, right) => left.name.localeCompare(right.name)), [data.folderActivity, data.folders]);
  const pinCandidates = useMemo(() => data.folders
    .filter((folder) => !data.folderActivity[folder.id]?.starred_at && !folder.archived_at && !folder.trashed_at && browserItemLocation({ type: "folder", id: folder.id, folder }, data.folders).view === "my-files")
    .sort((left, right) => left.name.localeCompare(right.name)), [data.folderActivity, data.folders]);
  const managedCourse = result.folder?.kind === "course" && result.folder.course_id
    ? courseById.get(result.folder.course_id)
    : undefined;
  const managedCourseDetails = managedCourse ? courseDetails?.[managedCourse.id] : undefined;
  const hasResultHidingFilter = Boolean(searchQuery.trim() || (activePreferences.filter && activePreferences.filter !== "all") || preferencesFileType !== "all" || includeArchived);
  // The pin is an action surface, so only show it when the host can open its attach flow.
  const showSyllabusPin = Boolean(managedCourse && onAttachSyllabus && location.view === "my-files" && !hasResultHidingFilter);
  const pinnedSourceFileId = showSyllabusPin ? managedCourseDetails?.syllabusFileId : undefined;
  const ordinaryItems = pinnedSourceFileId
    ? result.items.filter((item) => item.type !== "file" || item.id !== pinnedSourceFileId)
    : result.items;
  const currentLocationArchived = Boolean(result.folder && browserItemLocation({ type: "folder", id: result.folder.id, folder: result.folder }, data.folders).view === "archives");
  const archivedCourseFolder = Boolean(currentLocationArchived || result.folder?.trashed_at || location.view === "archives" || location.view === "trash");
  const activeMyFilesLocation = location.view === "my-files" && !result.unavailable && !archivedCourseFolder;
  const trashDialogOpen = trashDialog !== null;
  const anyFilesDialogOpen = organizationDialog !== null || archiveDialog !== null || trashDialogOpen;
  const trashCount = data.files.filter((file) => Boolean(file.trashed_at) && file.deleted_at == null).length +
    data.folders.filter((folder) => Boolean(folder.trashed_at) && folder.deleted_at == null).length;
  const syllabusPinCount = ordinaryItems.length + (showSyllabusPin ? 1 : 0);
  const allActiveSearch = location.view === "my-files" && searchScope === "all" && Boolean(searchQuery.trim());
  const uploadDisabledReason = location.view === "archives" || currentLocationArchived
    ? "Upload files from My files."
    : location.view === "trash"
      ? "Trash is read-only."
    : browserData.loading
        ? "Files are still loading."
        : browserData.error
          ? "Reload your files before uploading."
          : result.unavailable || (location.folderId && !result.folder)
            ? "This folder is unavailable. Return to a folder that can be opened before uploading."
            : organizationBusy
              ? "Wait for the current Files change to finish before uploading."
              : store.busy
              ? "Wait for the current file operation to finish before uploading."
              : !canWrite
                ? "Uploads are unavailable while this workspace is read-only."
                : "";
  const currentTitle = allActiveSearch ? includeArchived ? "All files" : "All active files" : location.folderId ? result.folder?.name || (browserData.loading ? "Loading folder…" : "Unavailable folder") : viewOptions.find((option) => option.id === location.view)?.label || "My files";
  const rootHasActiveItems = data.folders.some((folder) => folder.parent_id === null && !folder.archived_at && !folder.trashed_at && !folder.deleted_at) ||
    data.files.some((file) => file.folder_id === null && !file.trashed_at && !file.deleted_at && file.state !== "deleting");
  const showEmptyWelcome = location.view === "my-files" && location.folderId === null && ordinaryItems.length === 0 && !showSyllabusPin &&
    !browserData.loading && !browserData.error && !result.unavailable && !hasResultHidingFilter && !rootHasActiveItems;
  const canOrganizeAtCurrentLocation = Boolean(canWrite && activeMyFilesLocation && !browserData.loading && !browserData.error && !store.busy && !organizationBusy && !anyFilesDialogOpen);
  const canCreateTextFile = Boolean(onNewTextFile && canOrganizeAtCurrentLocation);
  const canCreateFolder = canOrganizeAtCurrentLocation;
  const canUpload = !uploadDisabledReason && !organizationBusy;
  const canOpenNewMenu = !anyFilesDialogOpen && (canCreateTextFile || canCreateFolder || !uploadDisabledReason);
  const selectedKeySet = useMemo(() => new Set(selectedItems.map(itemKey)), [selectedItems]);
  const assignmentById = useMemo(() => new Map(assignments.map((assignment) => [assignment.id, assignment])), [assignments]);
  const menuOpen = menuTarget !== null;
  const menuItem = menuTarget?.kind === "item" ? menuTarget.item : null;

  useSaveProtection(organizationBusy || Boolean(downloadState));

  useEffect(() => {
    dragSessionRef.current = null;
  }, [location.view, location.folderId, profileId]);

  if (queryState.profileId !== profileId) {
    setQueryState({ profileId, value: "" });
    setSearchScope("folder");
    setActivityRetry(null);
    setActivityError("");
  }

  useEffect(() => {
    dragAbortRef.current?.abort(new DOMException("The active account changed.", "AbortError"));
    activityAbortRef.current?.abort(new DOMException("The active account changed.", "AbortError"));
  }, [profileId]);

  useEffect(() => {
    const browserRoot = browserRootRef.current;
    if (!browserRoot) return;
    const ancestors: HTMLElement[] = [];
    let ancestor = browserRoot.parentElement;
    while (ancestor) { ancestors.push(ancestor); ancestor = ancestor.parentElement; }
    const restoreWhenVisible = () => {
      if (anyFilesDialogOpen || browserRoot.closest("[hidden]") || !restoreFocusAfterVisibilityRef.current) return;
      restoreFocusAfterVisibilityRef.current = false;
      window.requestAnimationFrame(() => {
        restoreOrganizationFocus(browserRoot, organizationTriggerRef.current);
      });
    };
    const observer = new MutationObserver(restoreWhenVisible);
    for (const element of ancestors) observer.observe(element, { attributes: true, attributeFilter: ["hidden"] });
    return () => observer.disconnect();
  }, [anyFilesDialogOpen]);

  const handleOrganizationStateChange = useCallback((report: OrganizationDialogReport | null) => {
    organizationStateCallbackRef.current?.(report);
  }, []);

  const publishDownloadReport = useCallback((reportState: DownloadRetry | null) => {
    if (!reportState) {
      if (!downloadReportActiveRef.current) return;
      downloadReportActiveRef.current = false;
      downloadReportSignatureRef.current = "";
      handleOrganizationStateChange(null);
      return;
    }
    const draft = {
      kind: "files-download",
      capturedProfileId: reportState.profileId,
      items: reportState.items.map((item) => ({
        type: item.type,
        id: item.id,
        name: itemName(item),
        revision: item.type === "file" ? item.file.metadata_revision : item.folder.revision,
      })),
      error: reportState.error,
    };
    const signature = JSON.stringify({ busy: reportState.busy, dirty: !reportState.busy, draft });
    if (signature === downloadReportSignatureRef.current) return;
    downloadReportActiveRef.current = true;
    downloadReportSignatureRef.current = signature;
    handleOrganizationStateChange({ busy: reportState.busy, dirty: !reportState.busy, draft });
  }, [handleOrganizationStateChange]);

  useEffect(() => {
    publishDownloadReport(downloadState);
  }, [downloadState, publishDownloadReport]);

  useEffect(() => () => {
    downloadAbortRef.current?.controller.abort(new DOMException("The Files browser closed.", "AbortError"));
    if (downloadReportActiveRef.current) handleOrganizationStateChange(null);
  }, [handleOrganizationStateChange]);

  useEffect(() => {
    if (activityBusy) {
      activityReportActiveRef.current = true;
      handleOrganizationStateChange({ busy: true, dirty: false, draft: { kind: "files-activity", capturedProfileId: profileId } });
    } else if (activityReportActiveRef.current) {
      activityReportActiveRef.current = false;
      handleOrganizationStateChange(null);
    }
  }, [activityBusy, handleOrganizationStateChange, profileId]);
  useEffect(() => () => {
    if (activityReportActiveRef.current) handleOrganizationStateChange(null);
  }, [handleOrganizationStateChange]);

  const closeTrashDialog = useCallback(() => {
    setTrashDialog(null);
    organizationTriggerRef.current = trashTriggerRef.current;
    restoreFocusAfterVisibilityRef.current = true;
  }, []);

  const closeArchiveDialog = useCallback(() => {
    setArchiveDialog(null);
    handleOrganizationStateChange(null);
    restoreFocusAfterVisibilityRef.current = true;
  }, [handleOrganizationStateChange]);

  const closeMenu = useCallback(() => setMenuTarget(null), []);

  const closeOrganizationDialog = useCallback(() => {
    setOrganizationDialog(null);
    handleOrganizationStateChange(null);
    restoreFocusAfterVisibilityRef.current = true;
  }, [handleOrganizationStateChange]);

  useLayoutEffect(() => {
    if (organizationDialog || archiveDialog || trashDialog || !restoreFocusAfterVisibilityRef.current || browserRootRef.current?.closest("[hidden]")) return;
    restoreFocusAfterVisibilityRef.current = false;
    restoreOrganizationFocus(browserRootRef.current, organizationTriggerRef.current);
  }, [organizationDialog, archiveDialog, trashDialog]);

  const saveOrganizationAndRefresh = useCallback(async (capturedProfileId: string, signal: AbortSignal) => {
    if (profileIdRef.current !== capturedProfileId || signal.aborted) return;
    await refreshBrowserData(true, signal);
    if (profileIdRef.current !== capturedProfileId || signal.aborted) return;
    await onOrganizationSaved?.(signal);
  }, [refreshBrowserData, onOrganizationSaved]);

  const beginCreateFolder = (parentId: string | null) => {
    if (!canCreateFolder || folderDestinationReason(parentId, data.folders)) return;
    const parent = parentId ? folderById.get(parentId) : undefined;
    if (parentId && !parent) return;
    setMenuTarget(null);
    setOrganizationError("");
    setOrganizationDialog({
      kind: "create",
      profileId,
      id: crypto.randomUUID(),
      parentId,
      parentLabel: parentId ? folderLocationLabel(parentId, data.folders) : "My files",
      folders: snapshotFolders(data.folders),
    });
  };

  const canRenameItem = (item: BrowserItem) => activeMyFilesLocation && canWrite && !browserData.loading && !browserData.error && !store.busy && !organizationBusy && !anyFilesDialogOpen &&
    browserItemLocation(item, data.folders).view === "my-files" &&
    (item.type === "folder" ? item.folder.kind === "custom" && !item.folder.archived_at && !item.folder.trashed_at : item.file.state === "ready" && !item.file.trashed_at);

  const canMoveItem = (item: BrowserItem) => canRenameItem(item) && !moveDestinationReason([item], null, data.folders);
  const protectedSyllabusReason = (item: BrowserItem) => {
    const protectedIds = new Set(Object.values(courseDetails ?? {}).flatMap((details) => details.syllabusFileId ? [details.syllabusFileId] : []));
    if (item.type === "file") return protectedIds.has(item.id) ? "This file is attached as a syllabus. Replace or detach it before moving it to Trash." : "";
    const byId = new Map(data.folders.map((folder) => [folder.id, folder]));
    for (const fileId of protectedIds) {
      const file = data.files.find((candidate) => candidate.id === fileId);
      if (!file) continue;
      let currentId = file.folder_id;
      const visited = new Set<string>();
      while (currentId && !visited.has(currentId)) {
        if (currentId === item.id) return "This folder contains a file attached as a syllabus. Replace or detach it before moving the folder to Trash.";
        visited.add(currentId);
        currentId = byId.get(currentId)?.parent_id ?? null;
      }
    }
    return "";
  };
  const trashItemReason = (item: BrowserItem) => itemTrashReason(item, data.folders) || protectedSyllabusReason(item);
  const canTrashItem = (item: BrowserItem) => (location.view === "my-files" || location.view === "recent" || location.view === "starred") && browserItemLocation(item, data.folders).view === "my-files" && !result.unavailable && !archivedCourseFolder && canWrite && !browserData.loading && !browserData.error && !store.busy && !organizationBusy && !anyFilesDialogOpen && !trashItemReason(item) &&
    (item.type === "folder" ? item.folder.kind === "custom" && !item.folder.archived_at && !item.folder.trashed_at : item.file.state === "ready" && !item.file.trashed_at);

  const itemIsStarred = (item: BrowserItem) => Boolean((item.type === "file" ? data.fileActivity[item.id] : data.folderActivity[item.id])?.starred_at);
  const canChangeStar = (item: BrowserItem) => canWrite && !browserData.loading && !browserData.error && !store.busy && !activityBusy && !organizationBusy && !anyFilesDialogOpen &&
    browserItemLocation(item, data.folders).view === "my-files" && (item.type === "folder" ? !item.folder.trashed_at : item.file.state === "ready" && !item.file.trashed_at);
  const canArchiveFolder = (item: BrowserItem) => item.type === "folder" && location.view === "my-files" && item.folder.parent_id === null &&
    item.folder.archived_at === null && item.folder.trashed_at === null && canWrite && !browserData.loading && !browserData.error && !store.busy && !organizationBusy && !activityBusy && !anyFilesDialogOpen;
  const canUnarchiveFolder = (item: BrowserItem) => item.type === "folder" && location.view === "archives" && item.folder.parent_id === null &&
    item.folder.archived_at !== null && item.folder.trashed_at === null && canWrite && !browserData.loading && !browserData.error && !store.busy && !organizationBusy && !activityBusy && !anyFilesDialogOpen;

  const runStarChange = async (item: BrowserItem, starred: boolean, retry?: ActivityRetry) => {
    if (activityBusy || !canWrite || store.busy || organizationBusy || anyFilesDialogOpen) return;
    const attempt: ActivityRetry = retry ?? { profileId, item: snapshotItem(item), starred, committed: false };
    if (attempt.profileId !== profileId) return;
    const sessionVersion = profileSessionRef.current.version;
    const controller = new AbortController();
    activityAbortRef.current?.abort();
    activityAbortRef.current = controller;
    setActivityBusy(true);
    setActivityError("");
    const isCurrentSession = () => !controller.signal.aborted && profileIdRef.current === attempt.profileId && profileSessionRef.current.version === sessionVersion;
    try {
      if (!attempt.committed) {
        await setBrowserItemStarred(attempt.profileId, attempt.item, attempt.starred, { signal: controller.signal });
        if (!isCurrentSession()) return;
        attempt.committed = true;
        setActivityRetry(attempt);
      }
      await browserData.refresh(true, controller.signal);
      if (!isCurrentSession()) return;
      setActivityRetry(null);
      setActivityError("");
    } catch (cause) {
      if (!isCurrentSession()) return;
      setActivityRetry({ ...attempt, item: snapshotItem(attempt.item) });
      setActivityError(cause instanceof Error && cause.message ? cause.message : "The Starred change could not be saved. Please retry.");
    } finally {
      if (activityAbortRef.current === controller) activityAbortRef.current = null;
      setActivityBusy(false);
    }
  };

  const beginArchiveDialog = (action: "archive" | "unarchive", item: BrowserItem) => {
    if (item.type !== "folder" || (action === "archive" ? !canArchiveFolder(item) : !canUnarchiveFolder(item))) return;
    organizationTriggerRef.current = triggerForMenuRef.current;
    closeMenu();
    setOrganizationError("");
    const folder = { ...item.folder };
    setArchiveDialog(action === "archive"
      ? { action, profileId, folder, defaultLabel: (currentTerm ?? "").trim().slice(0, 120) || "Archived" }
      : { action, profileId, folder });
  };

  const beginRenameItem = (item: BrowserItem) => {
    if (!canRenameItem(item)) return;
    closeMenu();
    setOrganizationDialog({ kind: "rename", profileId, item: snapshotItem(item), folders: snapshotFolders(data.folders) });
  };

  const beginMoveDialog = (items: readonly BrowserItem[], trigger?: HTMLElement) => {
    if (!canWrite || browserData.loading || browserData.error || store.busy || organizationBusy || anyFilesDialogOpen ||
        !["my-files", "recent", "starred"].includes(location.view) || !items.length ||
        selectionRevisionReason(items) || moveDestinationReason(items, null, data.folders)) return;
    organizationTriggerRef.current = trigger ?? triggerForMenuRef.current;
    closeMenu();
    setOrganizationDialog({ kind: "move", profileId, items: items.map(snapshotItem), folders: snapshotFolders(data.folders) });
  };

  const beginTrashDialog = (action: TrashDialogAction, item?: BrowserItem | readonly BrowserItem[], trigger?: HTMLElement) => {
    if (trashDialog || organizationDialog || archiveDialog || organizationBusy || store.busy || !canWrite || browserData.loading || browserData.error) return;
    const items = Array.isArray(item) ? item : item ? [item] : [];
    if (action === "trash" && (!items.length || items.some((candidate) => !canTrashItem(candidate)))) return;
    if ((action === "restore" || action === "permanent-delete") && (location.view !== "trash" || !items.length || items.some((candidate) => !isItemTrashed(candidate)))) return;
    if (action === "restore" && items.some(itemPurgePending)) return;
    if (action === "empty-trash" && (location.view !== "trash" || trashCount === 0)) return;
    const capturedItems = items.map(snapshotItem);
    const count = action === "empty-trash"
      ? trashCount
      : capturedItems.length
        ? action === "trash"
          ? countTrashSelection(capturedItems, data.folders, data.files)
          : countRestoreSelection(capturedItems, data.folders, data.files, action === "permanent-delete")
        : 0;
    const request: TrashDialogRequest = {
      action,
      profileId,
      items: capturedItems,
      folders: snapshotFolders(data.folders),
      ...(action === "permanent-delete" || action === "empty-trash" ? { requestId: crypto.randomUUID() } : {}),
      count,
    };
    trashTriggerRef.current = trigger ?? triggerForMenuRef.current;
    organizationTriggerRef.current = trashTriggerRef.current;
    closeMenu();
    setOrganizationError("");
    setTrashNotice("");
    setTrashDialog(request);
  };

  const downloadableViews: FilesView[] = ["my-files", "recent", "starred", "archives"];
  const selectionViewAvailable = downloadableViews.includes(location.view) || (location.view === "trash" && canWrite);
  const selectionAreaAvailable = selectionViewAvailable && !browserData.loading && !browserData.error && !result.unavailable && !anyFilesDialogOpen;
  const selectionControlsVisible = selectionAreaAvailable && !downloadState?.busy;
  const selectionViewAllowsItem = (item: BrowserItem) => {
    const itemView = browserItemLocation(item, data.folders).view;
    if (location.view === "trash") return itemView === "trash" && (item.type === "file" ? item.file.trashed_at !== null : item.folder.trashed_at !== null);
    if (location.view === "archives") return itemView === "archives";
    return itemView === "my-files" || (includeArchived && itemView === "archives");
  };
  const canSelectItem = (item: BrowserItem) => selectionControlsVisible && !store.busy && !organizationBusy && !downloadState?.busy && selectionViewAllowsItem(item) &&
    (item.type === "file"
      ? location.view === "trash" ? item.file.trashed_at !== null && !item.file.deleted_at : item.file.state === "ready" && !item.file.trashed_at && !item.file.deleted_at
      : location.view === "trash" ? item.folder.trashed_at !== null && !item.folder.deleted_at : !item.folder.trashed_at && !item.folder.deleted_at && !item.folder.purge_pending_at);

  const toggleSelectedItem = (item: BrowserItem, checked: boolean) => {
    if (checked && !canSelectItem(item)) return;
    const key = itemKey(item);
    setSelectedItems((current) => {
      const exists = current.some((selected) => itemKey(selected) === key);
      if (!checked) return exists ? current.filter((selected) => itemKey(selected) !== key) : current;
      return exists ? current : [...current, snapshotItem(item)];
    });
  };

  const selectVisibleItems = () => {
    setSelectedItems(ordinaryItems.filter(canSelectItem).map(snapshotItem));
  };

  const clearSelection = () => setSelectedItems([]);

  const selectionRevisionReason = (items: readonly BrowserItem[]) => {
    for (const item of items) {
      const current = item.type === "file"
        ? data.files.find((file) => file.id === item.id)
        : data.folders.find((folder) => folder.id === item.id);
      if (!current) return "A selected item is no longer available. Clear selection and reselect the current items.";
      const capturedRevision = item.type === "file" ? item.file.metadata_revision : item.folder.revision;
      const currentRevision = item.type === "file" && "metadata_revision" in current ? current.metadata_revision : "revision" in current ? current.revision : undefined;
      if (currentRevision !== capturedRevision) return "A selected item changed after you selected it. Clear selection and reselect the current items before continuing.";
    }
    return "";
  };

  const selectionMoveReason = selectedItems.length
    ? selectionRevisionReason(selectedItems) || (!canWrite
      ? "Files changes are unavailable while this workspace is read-only."
      : location.view === "trash" || location.view === "archives"
        ? "Restore or unarchive these items before moving them."
        : moveDestinationReason(selectedItems, null, data.folders))
    : "";
  const selectionTrashReason = selectedItems.length
    ? selectionRevisionReason(selectedItems) || (!canWrite
      ? "Files changes are unavailable while this workspace is read-only."
      : !["my-files", "recent", "starred"].includes(location.view)
        ? location.view === "archives" ? "Unarchive these items before moving them to Trash." : "Restore these items before moving them to Trash."
        : selectedItems.map(trashItemReason).find(Boolean) || selectedItems.find((item) => browserItemLocation(item, data.folders).view !== "my-files") && "Archived items must be unarchived before moving them to Trash."
      )
    : "";
  const selectionRestoreReason = selectedItems.length
    ? selectionRevisionReason(selectedItems) || (location.view !== "trash"
      ? "Restore is available only in Trash."
      : !canWrite
        ? "Files changes are unavailable while this workspace is read-only."
        : selectedItems.some(itemPurgePending)
          ? "An item in this selection is being permanently deleted and cannot be restored."
          : selectedItems.some((item) => item.type === "file" && item.file.state !== "ready")
            ? "Only ready files can be restored."
            : selectedItems.some((item) => !isItemTrashed(item))
              ? "A selected item is no longer in Trash. Refresh Trash and reselect it."
              : "")
    : "";
  const selectionDownloadReason = selectedItems.length
    ? selectionRevisionReason(selectedItems) || (location.view === "trash"
      ? "Downloads are available in My files, Recent, Starred, and Archives."
      : selectedItems.some((item) => item.type === "file" && item.file.state !== "ready")
        ? "Only ready files can be downloaded."
        : selectedItems.some((item) => isItemTrashed(item) || (item.type === "folder" && (item.folder.deleted_at || item.folder.purge_pending_at)))
          ? "Restore these items before downloading them."
          : "")
    : "";
  const showSelectionToolbar = Boolean(downloadState) || (selectionAreaAvailable && selectedItems.length > 0);
  const selectionActionBusy = organizationBusy || store.busy || activityBusy || anyFilesDialogOpen || browserData.loading || Boolean(browserData.error) || Boolean(downloadState?.busy);

  const beginSelectedTrashDialog = (action: "trash" | "restore", trigger?: HTMLElement) => {
    const reason = action === "trash" ? selectionTrashReason : selectionRestoreReason;
    if (!selectedItems.length || reason || downloadState?.busy || organizationBusy || store.busy || anyFilesDialogOpen) return;
    beginTrashDialog(action, selectedItems, trigger);
  };

  const runSelectedDownload = async (retry?: DownloadRetry) => {
    if (downloadState?.busy || organizationBusy || store.busy || anyFilesDialogOpen) return;
    const attempt = retry ?? {
      id: ++downloadRunIdRef.current,
      profileId,
      sessionVersion: profileSessionRef.current.version,
      items: selectedItems.map(snapshotItem),
      error: "",
      busy: false,
    };
    if (!attempt.items.length) return;
    if (attempt.profileId !== profileId || attempt.sessionVersion !== profileSessionRef.current.version) {
      setDownloadState({ ...attempt, busy: false, error: "This download belongs to an earlier account session. Dismiss it and reselect files before downloading." });
      return;
    }
    const staleReason = selectionRevisionReason(attempt.items);
    if (staleReason) {
      setDownloadState({ ...attempt, busy: false, error: staleReason });
      return;
    }
    const runId = ++downloadRunIdRef.current;
    const captured: DownloadRetry = { ...attempt, id: runId, busy: true, error: "" };
    const controller = new AbortController();
    downloadAbortRef.current?.controller.abort();
    downloadAbortRef.current = { controller, runId };
    setDownloadState(captured);
    publishDownloadReport(captured);
    const isCurrent = () => !controller.signal.aborted && downloadAbortRef.current?.runId === runId &&
      profileIdRef.current === captured.profileId && profileSessionRef.current.version === captured.sessionVersion;
    try {
      await downloadSelectedFilesZip(captured.profileId, captured.items.map(downloadRevision), { signal: controller.signal, isCurrent });
      if (!isCurrent()) return;
      setDownloadState(null);
      publishDownloadReport(null);
      clearSelection();
    } catch (cause) {
      if (!isCurrent()) return;
      const failed = { ...captured, busy: false, error: cause instanceof Error && cause.message ? cause.message : "The selected files could not be downloaded. Your selection is still here; retry the download." };
      setDownloadState(failed);
      publishDownloadReport(failed);
    } finally {
      if (downloadAbortRef.current?.runId === runId) downloadAbortRef.current = null;
    }
  };

  const dismissDownloadRecovery = () => {
    setDownloadState(null);
    publishDownloadReport(null);
  };

  const performDropMove = async (items: readonly BrowserItem[], folders: readonly FileFolder[], destinationId: string | null, capturedProfileId: string) => {
    if (organizationBusy || store.busy || anyFilesDialogOpen || profileIdRef.current !== capturedProfileId || !canWrite) return;
    const itemSnapshot = items.map(snapshotItem);
    const folderSnapshot = snapshotFolders(folders);
    const reason = moveDestinationReason(itemSnapshot, destinationId, folderSnapshot);
    if (reason) { setOrganizationError(reason); return; }
    const controller = new AbortController();
    dragAbortRef.current?.abort();
    dragAbortRef.current = controller;
    setOrganizationBusy(true);
    setOrganizationError("");
    handleOrganizationStateChange({
      busy: true,
      dirty: false,
      draft: {
        capturedProfileId,
        action: "move",
        items: itemSnapshot.map((item) => item.type === "file"
          ? { type: item.type, id: item.id, revision: item.file.metadata_revision, name: item.file.name }
          : { type: item.type, id: item.id, revision: item.folder.revision, name: item.folder.name }),
        destinationId,
      },
    });
    try {
      await moveBrowserItems(capturedProfileId, itemSnapshot, destinationId, { signal: controller.signal, folders: folderSnapshot });
      if (controller.signal.aborted || profileIdRef.current !== capturedProfileId) return;
      await browserData.refresh();
      if (controller.signal.aborted || profileIdRef.current !== capturedProfileId) return;
      await onOrganizationSaved?.();
      if (controller.signal.aborted || profileIdRef.current !== capturedProfileId) return;
      const movedKeys = new Set(itemSnapshot.map(itemKey));
      setSelectedItems((current) => current.filter((item) => !movedKeys.has(itemKey(item))));
    } catch (cause) {
      if (controller.signal.aborted) return;
      const message = cause instanceof BrowserOrganizationFailure ? cause.message : cause instanceof Error ? cause.message : "The selected items could not be moved.";
      setOrganizationError(`${message} Refresh Files, then reselect the items to use their latest saved revisions.`);
    } finally {
      if (dragAbortRef.current === controller) dragAbortRef.current = null;
      setOrganizationBusy(false);
      handleOrganizationStateChange(null);
    }
  };

  const localDragSession = (event: ReactDragEvent<HTMLElement>) => {
    const session = dragSessionRef.current;
    if (!session || session.profileId !== profileIdRef.current || session.locationKey !== selectionScope || !event.dataTransfer.types.includes(DRAG_TYPE)) return null;
    return session;
  };

  const startItemDrag = (event: ReactDragEvent<HTMLElement>, item: BrowserItem) => {
    if (!canSelectItem(item) || !canWrite) { event.preventDefault(); return; }
    const items = selectedKeySet.has(itemKey(item)) ? selectedItems : [snapshotItem(item)];
    const session = { nonce: crypto.randomUUID(), profileId, locationKey: selectionScope, items: items.map(snapshotItem), folders: snapshotFolders(data.folders) };
    dragSessionRef.current = session;
    event.dataTransfer.setData(DRAG_TYPE, session.nonce);
    event.dataTransfer.effectAllowed = "move";
  };

  const dragOverTarget = (event: ReactDragEvent<HTMLElement>, destinationId: string | null) => {
    if (event.dataTransfer.files.length || event.dataTransfer.types.includes("Files") || organizationBusy || store.busy) return;
    const session = localDragSession(event);
    if (!session || folderDestinationReason(destinationId, session.folders) || moveDestinationReason(session.items, destinationId, session.folders)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTargetId(destinationId ?? "root");
  };

  const dropOnTarget = (event: ReactDragEvent<HTMLElement>, destinationId: string | null) => {
    if (event.dataTransfer.files.length || event.dataTransfer.types.includes("Files")) return;
    const session = localDragSession(event);
    if (!session || event.dataTransfer.getData(DRAG_TYPE) !== session.nonce || profileIdRef.current !== session.profileId) return;
    const reason = moveDestinationReason(session.items, destinationId, session.folders);
    if (reason || folderDestinationReason(destinationId, session.folders)) return;
    event.preventDefault();
    event.stopPropagation();
    dragSessionRef.current = null;
    setDropTargetId(null);
    void performDropMove(session.items, session.folders, destinationId, session.profileId);
  };

  const externalDropReason = () => {
    if (location.view !== "my-files" || currentLocationArchived || result.unavailable) return "Drop files into an active folder in My files.";
    return uploadDisabledReason || "";
  };

  const handleExternalDragOver = (event: ReactDragEvent<HTMLElement>) => {
    const session = localDragSession(event);
    if (session && event.dataTransfer.getData(DRAG_TYPE) === session.nonce) return;
    if (!isExternalFileTransfer(event.dataTransfer)) return;
    if (!onUploadFiles) return;
    event.preventDefault();
    const reason = includesDroppedDirectory(event.dataTransfer) ? "Choose Upload folder from New to add a folder." : externalDropReason();
    setUploadDropMessage(reason);
    setExternalDropActive(!reason);
    event.dataTransfer.dropEffect = reason ? "none" : "copy";
  };

  const handleExternalDrop = (event: ReactDragEvent<HTMLElement>) => {
    const session = localDragSession(event);
    if (session && event.dataTransfer.getData(DRAG_TYPE) === session.nonce) return;
    if (!isExternalFileTransfer(event.dataTransfer)) return;
    if (!onUploadFiles) return;
    event.preventDefault();
    event.stopPropagation();
    setExternalDropActive(false);
    if (includesDroppedDirectory(event.dataTransfer)) {
      setUploadDropMessage("Choose Upload folder from New to add a folder.");
      return;
    }
    const reason = externalDropReason();
    if (reason) {
      setUploadDropMessage(reason);
      return;
    }
    const files = Array.from(event.dataTransfer.files);
    if (!files.length) {
      setUploadDropMessage("The dropped items could not be read. Drop individual files from your device.");
      return;
    }
    const folderId = location.folderId ? result.folder?.id ?? null : null;
    const courseId = folderCourseId(folderId, data.folders);
    setUploadDropMessage("");
    try {
      onUploadFiles(files, folderId, courseId);
    } catch (cause) {
      setUploadDropMessage(cause instanceof Error && cause.message ? cause.message : "The dropped files could not be added. Try Upload file from New.");
    }
  };

  const menuPointFor = useCallback((x: number, y: number) => {
    const maxX = Math.max(8, window.innerWidth - 248);
    const maxY = Math.max(8, window.innerHeight - 320);
    setMenuPoint({ x: Math.max(8, Math.min(x, maxX)), y: Math.max(8, Math.min(y, maxY)) });
  }, []);

  const showMenu = useCallback((item: BrowserItem, trigger: HTMLElement, point?: { x: number; y: number }) => {
    if (trashDialogOpen || organizationDialog) return;
    triggerForMenuRef.current = trigger;
    lastTriggerRef.current = trigger;
    organizationTriggerRef.current = trigger;
    const rect = trigger.getBoundingClientRect();
    menuAnchorRef.current = { left: rect.left, top: rect.top };
    if (point) menuPointFor(point.x, point.y);
    else {
      menuPointFor(rect.right - 216, rect.bottom + 4);
    }
    setMenuTarget({ kind: "item", item });
  }, [menuPointFor, organizationDialog, trashDialogOpen]);

  const showCreationMenu = useCallback((kind: "new" | "background", trigger: HTMLElement, point?: { x: number; y: number }) => {
    if (trashDialogOpen || organizationDialog) return;
    triggerForMenuRef.current = trigger;
    organizationTriggerRef.current = trigger;
    const rect = trigger.getBoundingClientRect();
    menuAnchorRef.current = { left: rect.left, top: rect.top };
    menuPointFor(point?.x ?? (kind === "new" && window.innerWidth > 900 ? rect.right - 54 : rect.right - 216), point?.y ?? rect.bottom + 4);
    setMenuTarget({ kind });
  }, [menuPointFor, organizationDialog, trashDialogOpen]);

  useLayoutEffect(() => {
    if (!menuOpen) return;
    window.requestAnimationFrame(() => menuRef.current?.querySelector<HTMLElement>("[role='menuitem']:not([aria-disabled='true'])")?.focus({ preventScroll: true }));
  }, [menuOpen, menuTarget]);

  useLayoutEffect(() => {
    if (!menuOpen || !menuRef.current) return;
    const rect = menuRef.current.getBoundingClientRect();
    menuPointFor(Math.min(menuPoint.x, window.innerWidth - rect.width - 8), Math.min(menuPoint.y, window.innerHeight - rect.height - 8));
  }, [menuOpen, menuPoint.x, menuPoint.y, menuPointFor]);

  useEffect(() => {
    if (!menuOpen) return;
    const dismissOutside = (event: PointerEvent) => {
      const target = event.target as Node | null;
      if (!menuRef.current?.contains(target) && !triggerForMenuRef.current?.contains(target)) closeMenu();
    };
    const dismissOnScroll = (event: Event) => {
      if (event.target instanceof Node && menuRef.current?.contains(event.target)) return;
      const rect = triggerForMenuRef.current?.getBoundingClientRect();
      // Opening after a click can leave an already completed auto-scroll event queued.
      // Dismiss only when the anchor actually moves after the menu has opened.
      if (!rect || Math.abs(rect.left - menuAnchorRef.current.left) > 1 || Math.abs(rect.top - menuAnchorRef.current.top) > 1) closeMenu();
    };
    const dismissOnResize = () => closeMenu();
    const dismissEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      closeMenu();
      window.requestAnimationFrame(() => triggerForMenuRef.current?.focus({ preventScroll: true }));
    };
    document.addEventListener("pointerdown", dismissOutside, true);
    document.addEventListener("scroll", dismissOnScroll, true);
    document.addEventListener("keydown", dismissEscape, true);
    window.addEventListener("resize", dismissOnResize);
    return () => {
      document.removeEventListener("pointerdown", dismissOutside, true);
      document.removeEventListener("scroll", dismissOnScroll, true);
      document.removeEventListener("keydown", dismissEscape, true);
      window.removeEventListener("resize", dismissOnResize);
    };
  }, [menuOpen, closeMenu]);

  useEffect(() => {
    if (!detailsItem) return;
    dialogRef.current?.querySelector<HTMLElement>("button")?.focus({ preventScroll: true });
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setDetailsItem(null);
        window.requestAnimationFrame(() => lastTriggerRef.current?.focus({ preventScroll: true }));
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), a[href]")];
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handleKey);
    return () => document.removeEventListener("keydown", handleKey);
  }, [detailsItem]);

  const handleLayout = (nextLayout: "list" | "grid") => {
    setLayout(nextLayout);
    onLayoutChange(nextLayout);
  };

  const handleUpload = () => {
    if (uploadDisabledReason || organizationBusy || anyFilesDialogOpen) return;
    const courseId = folderCourseId(location.folderId ? result.folder?.id ?? null : null, data.folders);
    onUpload(location.folderId ? result.folder?.id ?? null : null, courseId);
  };

  const uploadFromMenu = () => {
    closeMenu();
    handleUpload();
  };

  const uploadFolderFromMenu = () => {
    closeMenu();
    if (!onUploadFolder || uploadDisabledReason || organizationBusy || anyFilesDialogOpen) return;
    const folderId = location.folderId ? result.folder?.id ?? null : null;
    onUploadFolder(folderId, folderCourseId(folderId, data.folders));
  };

  const courseForFolder = (folderId: string | null) => {
    return folderCourseId(folderId, data.folders);
  };

  const beginNewTextFile = (folderId: string | null) => {
    if (!canCreateTextFile || !onNewTextFile) return;
    if (folderDestinationReason(folderId, data.folders)) return;
    const siblingFiles = data.files.filter((file) => !file.trashed_at && file.folder_id === folderId);
    const siblingFolders = data.folders.filter((folder) => !folder.trashed_at && !folder.archived_at && folder.parent_id === folderId);
    const name = suggestedTextFileName([...siblingFiles, ...siblingFolders]);
    closeMenu();
    onNewTextFile(folderId, courseForFolder(folderId), name);
  };

  const openItemMenu = (event: MouseEvent<HTMLElement>, item: BrowserItem) => {
    event.preventDefault();
    event.stopPropagation();
    showMenu(item, event.currentTarget, { x: event.clientX, y: event.clientY });
  };

  const openKeyboardMenu = (event: ReactKeyboardEvent<HTMLElement>, item: BrowserItem) => {
    if (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey)) return;
    event.preventDefault();
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : event.currentTarget;
    showMenu(item, trigger, { x: trigger.getBoundingClientRect().right - 216, y: trigger.getBoundingClientRect().bottom + 4 });
  };

  const openBackgroundMenu = (event: MouseEvent<HTMLElement>) => {
    if (!canCreateTextFile && !canCreateFolder) return;
    const target = event.target;
    if (!(target instanceof Element) || target.closest("button, a, input, select, textarea, [role='button'], [role='listitem'], [role='menu'], .files-syllabus-pin")) return;
    event.preventDefault();
    showCreationMenu("background", event.currentTarget, { x: event.clientX, y: event.clientY });
  };

  const openAccessibleBackgroundMenu = (event: MouseEvent<HTMLElement>) => {
    event.preventDefault();
    event.stopPropagation();
    showCreationMenu("background", event.currentTarget, { x: event.clientX, y: event.clientY });
  };

  const openKeyboardBackgroundMenu = (event: ReactKeyboardEvent<HTMLElement>) => {
    if ((!canCreateTextFile && !canCreateFolder) || event.target !== event.currentTarget || (event.key !== "ContextMenu" && !(event.key === "F10" && event.shiftKey))) return;
    event.preventDefault();
    showCreationMenu("background", event.currentTarget);
  };

  const showDetails = (item: BrowserItem, trigger?: HTMLElement) => {
    lastTriggerRef.current = trigger ?? triggerForMenuRef.current;
    closeMenu();
    setDetailsItem(item);
  };

  const performMenuAction = (action: "open" | "preview" | "edit" | "details" | "containing", item: BrowserItem) => {
    closeMenu();
    if (action === "details") setDetailsItem(item);
    else if (action === "containing") {
      const target = browserItemLocation(item, data.folders);
      if (target.unavailable) return;
      setQueryState({ profileId, value: "" });
      setSearchScope("folder");
      navigate(target.view, target.folderId);
    }
    else if (item.type === "folder" && action === "open") {
      const itemView = browserItemLocation(item, data.folders).view;
      navigate(location.view === "trash" ? "trash" : itemView === "archives" ? "archives" : "my-files", item.id);
    }
    else if (item.type === "file" && action === "preview") onOpen(item.file, { readOnly: browserItemLocation(item, data.folders).view === "archives" });
    else if (item.type === "file" && action === "edit") onEdit(item.file);
  };

  const handleItemActivate = (item: BrowserItem, trigger?: HTMLElement) => {
    if (location.view === "trash" && item.type === "folder" && !itemPurgePending(item)) navigate("trash", item.id);
    else if (location.view === "trash" || isItemTrashed(item)) showDetails(item, trigger);
    else if (item.type === "folder") {
      const itemView = browserItemLocation(item, data.folders).view;
      navigate(itemView === "archives" ? "archives" : "my-files", item.id);
    }
    else if (item.file.state === "ready") onOpen(item.file, { readOnly: browserItemLocation(item, data.folders).view === "archives" });
    else if (item.file.state === "pending" && canWrite && browserItemLocation(item, data.folders).view !== "archives") onEdit(item.file);
    else showDetails(item, trigger);
  };

  const itemCourseLabel = (item: BrowserItem) => {
    const snapshot = archivedCourseSnapshot(item, data.folders);
    if (snapshot?.course_name_snapshot) return snapshot.course_name_snapshot;
    if (item.type === "file") return fileCourseName(item.file, courses);
    return item.folder.kind === "course"
      ? folderCourse(item.folder, courses)?.code || item.folder.course_code || item.folder.course_name_snapshot || "Course folder"
      : item.folder.course_code || item.folder.course_name_snapshot || "Personal";
  };
  const itemCourseSecondaryLabel = (item: BrowserItem) => {
    const snapshot = archivedCourseSnapshot(item, data.folders);
    if (!snapshot?.course_code) return "";
    return snapshot.course_code;
  };

  const itemModified = (item: BrowserItem) => item.type === "file" ? item.file.updated_at : item.folder.updated_at;
  const menuLabel = menuItem ? itemName(menuItem) : menuTarget?.kind === "new" ? "New" : currentTitle;
  const showOpenContainingFolder = (item: BrowserItem) => {
    const target = browserItemLocation(item, data.folders);
    if (target.unavailable) return false;
    return location.view === "recent" || location.view === "starred" ||
      Boolean(searchQuery.trim() && (target.view !== location.view || target.folderId !== location.folderId));
  };
  const renderStarMenuItem = (item: BrowserItem) => <button role="menuitem" type="button" disabled={!canChangeStar(item)} onClick={() => { closeMenu(); void runStarChange(item, !itemIsStarred(item)); }}><Star size={15} /> {itemIsStarred(item) ? "Remove from Starred" : "Add to Starred"}</button>;
  const createAtCurrentLocation = () => beginNewTextFile(location.folderId ? result.folder?.id ?? null : null);
  const renderCreationMenu = () => <>
    {menuTarget?.kind === "new" && <>
      <button role="menuitem" type="button" disabled={!canUpload} title={uploadDisabledReason || undefined} onClick={uploadFromMenu}><Upload size={15} /> Upload files</button>
      <button role="menuitem" type="button" disabled={!canUpload || !onUploadFolder} aria-disabled={!canUpload || !onUploadFolder} title={!onUploadFolder ? "Folder uploads are unavailable." : uploadDisabledReason || undefined} onClick={uploadFolderFromMenu}><FolderOpen size={15} /> Upload folder</button>
      <div className="files-context-menu-separator" role="separator" />
    </>}
    {menuTarget?.kind === "background" && ordinaryItems.some(canSelectItem) && <>
      <button role="menuitem" type="button" disabled={selectionActionBusy} onClick={() => { closeMenu(); selectVisibleItems(); }}><Check size={15} /> Select visible</button>
      {(canCreateFolder || canCreateTextFile) && <div className="files-context-menu-separator" role="separator" />}
    </>}
    {canCreateFolder && <button role="menuitem" type="button" onClick={() => beginCreateFolder(location.folderId ? result.folder?.id ?? null : null)}><FolderPlus size={15} /> New folder</button>}
    {canCreateTextFile && <button role="menuitem" type="button" onClick={createAtCurrentLocation}><FileText size={15} /> Text document</button>}
  </>;

  const renderMenu = (item: BrowserItem) => {
    if (location.view === "trash") return <>
      {item.type === "folder" && !itemPurgePending(item) && <button role="menuitem" type="button" onClick={() => { closeMenu(); navigate("trash", item.id); }}><FolderOpen size={15} /> Open folder</button>}
      {!itemPurgePending(item) && <button role="menuitem" type="button" disabled={!canWrite || organizationBusy || store.busy} onClick={() => beginTrashDialog("restore", item)}><RotateCcw size={15} /> Restore</button>}
      {itemPurgePending(item) && <span role="note" className="files-context-note">Permanent deletion is pending. This item can’t be restored until cleanup completes.</span>}
      <button role="menuitem" type="button" disabled={!canWrite || organizationBusy || store.busy} onClick={() => beginTrashDialog("permanent-delete", item)}><Trash2 size={15} /> {itemPurgePending(item) ? "Retry permanent deletion" : "Delete permanently"}</button>
      <button role="menuitem" type="button" onClick={() => performMenuAction("details", item)}><Info size={15} /> Details</button>
    </>;
    if (item.type === "folder") return <>
      <button role="menuitem" type="button" onClick={() => performMenuAction("open", item)}><FolderOpen size={15} /> Open folder</button>
      {showOpenContainingFolder(item) && <button role="menuitem" type="button" onClick={() => performMenuAction("containing", item)}><FolderOpen size={15} /> Open containing folder</button>}
      {canChangeStar(item) && renderStarMenuItem(item)}
      {canArchiveFolder(item) && <button role="menuitem" type="button" onClick={() => beginArchiveDialog("archive", item)}><Archive size={15} /> Archive folder…</button>}
      {canUnarchiveFolder(item) && <button role="menuitem" type="button" onClick={() => beginArchiveDialog("unarchive", item)}><Archive size={15} /> Unarchive folder…</button>}
      {canCreateTextFile && folderDestinationReason(item.folder.id, data.folders) === "" && <button role="menuitem" type="button" onClick={() => beginNewTextFile(item.folder.id)}><FileText size={15} /> New text file</button>}
      {canCreateFolder && folderDestinationReason(item.folder.id, data.folders) === "" && <button role="menuitem" type="button" onClick={() => beginCreateFolder(item.folder.id)}><FolderPlus size={15} /> New folder</button>}
      {canRenameItem(item) && <button role="menuitem" type="button" onClick={() => beginRenameItem(item)}><Pencil size={15} /> Rename folder</button>}
      {canMoveItem(item) && <button role="menuitem" type="button" onClick={() => beginMoveDialog([item])}><Move size={15} /> Move to…</button>}
      {canTrashItem(item) && <button role="menuitem" type="button" onClick={() => beginTrashDialog("trash", item)}><Trash2 size={15} /> Move to Trash</button>}
      {item.folder.kind === "course" && <span role="note" className="files-context-note">Course folder names follow your Courses.</span>}
      <button role="menuitem" type="button" onClick={() => performMenuAction("details", item)}><Info size={15} /> Details</button>
    </>;
    if (item.file.trashed_at) return <button role="menuitem" type="button" onClick={() => performMenuAction("details", item)}><Info size={15} /> Details</button>;
    if (item.file.state === "pending" && canWrite && browserItemLocation(item, data.folders).view !== "archives") return <>
      <button role="menuitem" type="button" onClick={() => performMenuAction("edit", item)}><RefreshCw size={15} /> Edit / retry upload</button>
      <button role="menuitem" type="button" onClick={() => performMenuAction("details", item)}><Info size={15} /> Details</button>
    </>;
    if (item.file.state === "ready") return <>
      {showOpenContainingFolder(item) && <button role="menuitem" type="button" onClick={() => performMenuAction("containing", item)}><FolderOpen size={15} /> Open containing folder</button>}
      {canChangeStar(item) && renderStarMenuItem(item)}
      <button role="menuitem" type="button" onClick={() => performMenuAction("preview", item)}><FileText size={15} /> {browserItemLocation(item, data.folders).view === "archives" ? "View file" : item.file.content_backend === "native-text" ? "Edit text" : "Preview"}</button>
      <a role="menuitem" href={store.url(item.file)} download={downloadFileName(item.file)} onClick={() => closeMenu()}><Download size={15} /> Download</a>
      {canRenameItem(item) && <button role="menuitem" type="button" onClick={() => beginRenameItem(item)}><Pencil size={15} /> Rename file</button>}
      {canMoveItem(item) && <button role="menuitem" type="button" onClick={() => beginMoveDialog([item])}><Move size={15} /> Move to…</button>}
      {canTrashItem(item) && <button role="menuitem" type="button" onClick={() => beginTrashDialog("trash", item)}><Trash2 size={15} /> Move to Trash</button>}
      {canWrite && browserItemLocation(item, data.folders).view !== "archives" && item.file.content_backend !== "native-text" && <button role="menuitem" type="button" onClick={() => performMenuAction("edit", item)}><Info size={15} /> Edit details</button>}
      <button role="menuitem" type="button" onClick={() => performMenuAction("details", item)}><Info size={15} /> Details</button>
    </>;
    return <button role="menuitem" type="button" onClick={() => performMenuAction("details", item)}><Info size={15} /> Details</button>;
  };

  const renderItem = (item: BrowserItem) => {
    const folder = item.type === "folder" ? item.folder : null;
    const file = item.type === "file" ? item.file : null;
    const itemLocation = browserItemLocation(item, data.folders);
    const itemArchived = itemLocation.view === "archives";
    const accent = folder ? courseColor(folder, courses, data.folders) : file ? fileColor(file, courses, data.folders) : "#8da6cc";
    const associatedCourse = archivedCourseSnapshot(item, data.folders) ? undefined : folder ? folderCourse(folder, courses) : file?.course_id ? courseById.get(file.course_id) : undefined;
    const ItemIcon = folder ? (location.layout === "grid" || folder.kind === "course" ? Folder : FolderOpen) : file ? fileIcon(file) : FileIcon;
    const inTrash = location.view === "trash";
    const locationLabel = inTrash ? originalDisplayPath(item, data.folders) : itemLocation.label || folderLocationLabel(file ? file.folder_id : folder?.parent_id ?? null, data.folders);
    const mismatch = Boolean(file && associationDiffersFromLocation(file, data.folders));
    const assignment = file?.assignment_id ? assignmentById.get(file.assignment_id) : undefined;
    const canSelect = canSelectItem(item);
    const selected = selectedKeySet.has(itemKey(item));
    const isDropTarget = Boolean(folder && dropTargetId === folder.id);
    const folderFileCount = folder ? data.files.filter((candidate) => candidate.folder_id === folder.id && !candidate.trashed_at && !candidate.deleted_at && candidate.state !== "deleting").length : 0;
    const itemStyle = {
      "--file-item-accent": accent,
      "--file-type-accent": file ? filePreviewColor(file) : accent,
      "--file-item-soft": associatedCourse?.soft || `color-mix(in srgb, ${accent} 16%, #10213a)`,
    } as CSSProperties;
    const contextHandlers = {
      onContextMenu: (event: MouseEvent<HTMLElement>) => openItemMenu(event, item),
      onKeyDown: (event: ReactKeyboardEvent<HTMLElement>) => openKeyboardMenu(event, item),
    };
    const activationLabel = folder ? "Open folder" : location.view === "trash" || file?.trashed_at || file?.state === "deleting" || (file?.state === "pending" && (!canWrite || itemArchived)) ? "View file details" : file?.state === "ready" ? itemArchived ? "View file" : file.content_backend === "native-text" ? "Edit text" : "Preview file" : "Edit / retry upload";
    return <article
      className={`files-item ${folder ? "is-folder" : "is-file"} ${selectionControlsVisible ? "has-select" : ""} ${selected ? "is-selected" : ""} ${isDropTarget ? "is-drop-target" : ""}`}
      style={itemStyle}
      key={`${item.type}:${item.id}`}
      role="listitem"
      draggable={canSelect}
      onDragStart={(event) => startItemDrag(event, item)}
      onDragEnd={() => { dragSessionRef.current = null; setDropTargetId(null); }}
      onDragOver={folder ? (event) => dragOverTarget(event, folder.id) : undefined}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null) && folder && dropTargetId === folder.id) setDropTargetId(null); }}
      onDrop={folder ? (event) => dropOnTarget(event, folder.id) : undefined}
      {...contextHandlers}
    >
      {location.layout === "grid" && file && <div className="files-card-preview" role="button" tabIndex={0} onClick={(event) => handleItemActivate(item, event.currentTarget)} onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); handleItemActivate(item, event.currentTarget); }
      }} aria-label={`${activationLabel}: ${itemName(item)}`}>
        <FilesCardPreview file={file} profileId={profileId} sessionVersion={profileSession.version} store={store} />
      </div>}
      {selectionControlsVisible && (selectionViewAllowsItem(item) ? <label className="files-item-select">
        <input type="checkbox" checked={selected} disabled={!canSelect || organizationBusy || Boolean(downloadState?.busy)} onChange={(event) => toggleSelectedItem(item, event.currentTarget.checked)} aria-label={`Select ${itemName(item)} in ${locationLabel}`} title={folder?.kind === "course" ? "Course folders can be downloaded, but cannot be moved or trashed." : canSelect ? undefined : "This item cannot be selected for bulk actions."} />
      </label> : <span className="files-item-select-spacer" aria-hidden="true" />)}
      <button type="button" className="files-item-main" onClick={(event) => handleItemActivate(item, event.currentTarget)} aria-label={`${activationLabel}: ${itemName(item)}`}>
        <span className="files-item-icon" aria-hidden="true"><ItemIcon size={19} /></span>
        <span className="files-item-title">
          <strong title={`${itemName(item)} — ${locationLabel}`}>{itemName(item)}</strong>
          {location.layout === "grid" && file && <span className="files-card-metadata">{displayCardDate(inTrash ? file.trashed_at : itemModified(item))}<span aria-hidden="true"> · </span>{fileSize(Number(file.size_bytes))}</span>}
          <small title={locationLabel}>{location.layout === "grid" && folder ? `${folderFileCount} ${folderFileCount === 1 ? "file" : "files"}` : `${itemCourseLabel(item)}${itemCourseSecondaryLabel(item) ? ` · ${itemCourseSecondaryLabel(item)}` : ""} · ${locationLabel}${file ? ` · ${file.kind}` : folder?.kind === "course" ? " · Course folder" : " · Folder"}`}</small>
          {mismatch && file && <span className="files-association-badges" aria-label="File associations differ from this location">
            <span className="files-association-badge">{fileCourseName(file, courses)}</span>
            {file.assignment_id && <span className="files-association-badge">{assignment?.title || "Assignment"}</span>}
          </span>}
        </span>
      </button>
      <span className="files-item-course">{itemCourseLabel(item)}{itemCourseSecondaryLabel(item) && <small>{itemCourseSecondaryLabel(item)}</small>}</span>
      <span className="files-item-modified" title={inTrash ? displayDateTime(file?.trashed_at ?? folder?.trashed_at) : displayDate(itemModified(item))}>{location.layout === "grid" && file ? displayCardDate(itemModified(item)) : inTrash ? displayDateTime(file?.trashed_at ?? folder?.trashed_at) : displayDate(itemModified(item))}</span>
      <span className="files-item-size">{file ? fileSize(Number(file.size_bytes)) : "—"}</span>
      {file ? <span className={`files-status ${file.trashed_at ? "is-trashed" : `is-${file.state}`}`}>{describeFileStatus(file)}</span> : <span className={`files-status${folder && itemPurgePending(item) ? " is-deleting" : ""}`}>{folder && itemPurgePending(item) ? "Cleanup pending" : folder?.trashed_at ? "In Trash" : folder?.archived_at ? "Archived" : ""}</span>}
      {location.layout === "grid" && file && <button type="button" className="files-item-star-trigger" disabled={!canChangeStar(item)} aria-label={itemIsStarred(item) ? `Remove ${itemName(item)} from Starred` : `Add ${itemName(item)} to Starred`} aria-pressed={itemIsStarred(item)} title={itemIsStarred(item) ? "Remove from Starred" : "Add to Starred"} onClick={() => void runStarChange(item, !itemIsStarred(item))}><Star size={17} fill={itemIsStarred(item) ? "currentColor" : "none"} /></button>}
      <button
        type="button"
        className="files-item-menu-trigger"
        aria-label={`More options for ${itemName(item)}`}
        aria-haspopup="menu"
        aria-expanded={menuItem?.id === item.id && menuItem.type === item.type}
        onClick={(event) => showMenu(item, event.currentTarget)}
        onContextMenu={(event) => openItemMenu(event, item)}
        onKeyDown={(event) => openKeyboardMenu(event, item)}
      ><MoreHorizontal size={18} className={location.layout === "grid" ? "files-grid-more-icon" : undefined} /></button>
    </article>;
  };

  const detailsCourse = (item: BrowserItem) => item.type === "file"
    ? (item.file.course_id ? courseById.get(item.file.course_id) : undefined)
    : folderCourse(item.folder, courses);
  const detailsLocation = (item: BrowserItem) => {
    if (location.view === "trash") return originalDisplayPath(item, data.folders);
    return browserItemLocation(item, data.folders).label;
  };
  const detailsCourseLabel = (item: BrowserItem) => {
    const snapshot = archivedCourseSnapshot(item, data.folders);
    return snapshot?.course_name_snapshot || detailsCourse(item)?.name || (item.type === "folder" ? item.folder.course_name_snapshot : null) || itemCourseLabel(item);
  };

  return <section ref={browserRootRef} className="files-browser" aria-label="Files">
    <div className="files-browser-layout">
      <aside className="files-sidebar" aria-label="File navigation">
        <header className="files-browser-header">
          <div className="files-browser-title"><h1>Files</h1></div>
          <button type="button" className="files-new-button" disabled={!canOpenNewMenu} title={canOpenNewMenu ? "Create or upload a file or folder" : uploadDisabledReason || "Creating files is unavailable."} aria-haspopup="menu" aria-expanded={menuTarget?.kind === "new"} onClick={(event) => showCreationMenu("new", event.currentTarget)}><Plus size={16} /> New</button>
        </header>
        <nav className="files-view-nav" aria-label="File views">
          <div className="files-view-primary">
            <button type="button" className={location.view === "my-files" ? "is-active" : ""} aria-current={location.view === "my-files" ? "page" : undefined} onClick={() => navigate("my-files", null)}><FolderOpen size={19} /><span>Files</span></button>
            <button type="button" className={location.view === "recent" ? "is-active" : ""} aria-current={location.view === "recent" ? "page" : undefined} onClick={() => navigate("recent", null)}><Clock3 size={19} /><span>Recent</span></button>
            <button type="button" className={location.view === "starred" ? "is-active" : ""} aria-current={location.view === "starred" ? "page" : undefined} onClick={() => navigate("starred", null)}><Star size={19} /><span>Starred</span></button>
            <button type="button" className="files-nav-disclosure" aria-expanded={coursesExpanded} aria-controls="files-course-links" onClick={() => setCoursesExpanded((expanded) => !expanded)}><BookOpen size={19} /><span>Courses</span><ChevronDown size={15} className={coursesExpanded ? "is-expanded" : ""} /></button>
            {coursesExpanded && <div className="files-course-links" id="files-course-links" aria-label="Course folders">
              {courseFolders.map((folder) => {
                const course = folder.course_id ? courseById.get(folder.course_id) : undefined;
                return <button type="button" key={folder.id} title={folderLocationLabel(folder.id, data.folders)} onClick={() => navigate("my-files", folder.id)}>{course?.code || folder.course_code || course?.name || folder.name}</button>;
              })}
              {!courseFolders.length && <p>No course folders yet.</p>}
            </div>}
          </div>

          <section className="files-sidebar-pinned" aria-labelledby="files-pinned-heading">
            <h2 id="files-pinned-heading"><Pin size={17} /><span>Pinned</span></h2>
            {pinnedFolders.map((folder) => <button key={folder.id} type="button" className={`files-pinned-folder${location.view === "my-files" && location.folderId === folder.id ? " is-current" : ""}`} title={folderLocationLabel(folder.id, data.folders)} onClick={() => navigate("my-files", folder.id)}><FolderOpen size={16} /><span>{folder.name}</span></button>)}
            <button type="button" className="files-pin-folder-action" aria-expanded={pinnedPickerOpen} aria-controls="files-pinned-picker" onClick={() => setPinnedPickerOpen((open) => !open)}><Plus size={18} /><span>Pin a folder</span></button>
            {pinnedPickerOpen && <div className="files-pinned-picker" id="files-pinned-picker" role="group" aria-label="Choose a folder to pin">
              {pinCandidates.map((folder) => {
                const item: BrowserItem = { type: "folder", id: folder.id, folder };
                return <button type="button" key={folder.id} disabled={!canChangeStar(item)} onClick={() => { setPinnedPickerOpen(false); void runStarChange(item, true); }}><FolderOpen size={15} /><span>{folder.name}</span></button>;
              })}
              {!pinCandidates.length && <p>{pinnedFolders.length ? "All available folders are pinned." : "Create a folder to pin it here."}</p>}
            </div>}
          </section>

          <div className="files-view-secondary">
            <button type="button" className={location.view === "archives" ? "is-active" : ""} aria-current={location.view === "archives" ? "page" : undefined} onClick={() => navigate("archives", null)}><Archive size={19} /><span>Archives</span></button>
            <button type="button" className={location.view === "trash" ? "is-active" : ""} aria-current={location.view === "trash" ? "page" : undefined} onClick={() => navigate("trash", null)}><Trash2 size={19} /><span>Trash</span></button>
          </div>
        </nav>
      </aside>

      <div className={`files-browser-content ${externalDropActive ? "is-external-drop-target" : ""} ${showEmptyWelcome ? "is-empty-welcome" : ""}`} role="region" onContextMenu={openBackgroundMenu} aria-label={`${currentTitle} contents`}
        onDragOver={handleExternalDragOver}
        onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setExternalDropActive(false); }}
        onDrop={handleExternalDrop}>
        {uploadDisabledReason && <p className="files-readonly-note" role="note">{uploadDisabledReason}</p>}

        <FilesBrowserTools
          query={searchQuery}
          onQueryChange={setSearchQuery}
          searchScope={searchScope}
          onSearchScopeChange={setSearchScope}
          courseFilter={activePreferences.filter || "all"}
          onCourseFilterChange={(filter) => updatePreferences({ filter })}
          fileType={preferencesFileType}
          onFileTypeChange={(fileType) => updatePreferences({ fileType })}
          sortBy={preferencesSortBy}
          onSortByChange={(sortBy) => updatePreferences({ sortBy })}
          sortDirection={preferencesSortDirection}
          onSortDirectionChange={(sortDirection) => updatePreferences({ sortDirection })}
          includeArchived={includeArchived}
          onIncludeArchivedChange={(includeArchived) => updatePreferences({ includeArchived })}
          courses={courses}
          searchScopeEnabled={location.view === "my-files"}
          includeArchivedEnabled={location.view !== "archives" && location.view !== "trash"}
          sortDisabled={location.view === "recent"}
          disabled={organizationBusy || activityBusy || anyFilesDialogOpen}
        />

        {!showEmptyWelcome && <div className="files-content-heading">
          <div>
            <div className="files-content-title-line">
              <h2>{location.view === "my-files" && !location.folderId && !allActiveSearch ? "Your files" : currentTitle}</h2>
              {location.view === "my-files" && !location.folderId && !allActiveSearch && <span className="files-content-tagline">A place for everything.</span>}
            </div>
            {(location.folderId !== null || location.view !== "my-files" || allActiveSearch) && <nav className="files-breadcrumbs" aria-label="Folder breadcrumbs">
              <button type="button" className={dropTargetId === "root" ? "is-drop-target" : ""} onClick={() => navigate(location.view, null)} onDragOver={activeMyFilesLocation ? (event) => dragOverTarget(event, null) : undefined} onDragLeave={() => { if (dropTargetId === "root") setDropTargetId(null); }} onDrop={activeMyFilesLocation ? (event) => dropOnTarget(event, null) : undefined}>{location.view === "my-files" ? "My files" : viewOptions.find((option) => option.id === location.view)?.label}</button>
              {!allActiveSearch && result.breadcrumbs.map((crumb, index) => <span className="files-breadcrumb-part" key={crumb.id}>
                <ChevronRight size={14} aria-hidden="true" />
                <button type="button" className={dropTargetId === crumb.id ? "is-drop-target" : ""} aria-current={index === result.breadcrumbs.length - 1 ? "page" : undefined} onClick={() => navigate(location.view, crumb.id)} onDragOver={activeMyFilesLocation ? (event) => dragOverTarget(event, crumb.id) : undefined} onDragLeave={() => { if (dropTargetId === crumb.id) setDropTargetId(null); }} onDrop={activeMyFilesLocation ? (event) => dropOnTarget(event, crumb.id) : undefined}>{crumb.name}</button>
              </span>)}
            </nav>}
          </div>
          <div className="files-content-heading-actions">
            <div className="files-layout-toggle" role="group" aria-label="File layout">
              <button type="button" aria-pressed={location.layout === "list"} className={location.layout === "list" ? "is-active" : ""} onClick={() => handleLayout("list")} aria-label="List view"><LayoutList size={17} /></button>
              <button type="button" aria-pressed={location.layout === "grid"} className={location.layout === "grid" ? "is-active" : ""} onClick={() => handleLayout("grid")} aria-label="Grid view"><Grid2X2 size={17} /></button>
            </div>
            <label className="files-quick-sort"><span className="files-tools-sr-only">Sort files by</span><select aria-label="Sort by" value={preferencesSortBy} onChange={(event) => updatePreferences({ sortBy: event.currentTarget.value as BrowserSortBy })} disabled={organizationBusy || activityBusy || anyFilesDialogOpen || location.view === "recent"}><option value="name">Name</option><option value="modified">Last modified</option></select></label>
            {syllabusPinCount > 0 && <span className="files-count">{syllabusPinCount} {syllabusPinCount === 1 ? "item" : "items"}</span>}
            {location.view === "trash" && <button type="button" className="files-secondary-button files-trash-empty-button" disabled={!canWrite || browserData.loading || Boolean(browserData.error) || organizationBusy || store.busy || trashCount === 0 || anyFilesDialogOpen} onClick={(event) => beginTrashDialog("empty-trash", undefined, event.currentTarget)}><Trash2 size={15} /> Empty Trash{trashCount ? ` (${trashCount})` : ""}</button>}
            {(canCreateTextFile || canCreateFolder || (selectionAreaAvailable && ordinaryItems.some(canSelectItem))) && <button type="button" className="files-icon-button files-location-menu-trigger" aria-label={`Actions for ${currentTitle}`} aria-haspopup="menu" aria-expanded={menuTarget?.kind === "background"} onClick={(event) => showCreationMenu("background", event.currentTarget)} onContextMenu={openAccessibleBackgroundMenu} onKeyDown={openKeyboardBackgroundMenu}><MoreHorizontal size={18} /></button>}
          </div>
        </div>
        }

        {showEmptyWelcome && <section className="files-empty-welcome" aria-labelledby="files-empty-title">
          <div className="files-empty-copy">
            <h2 id="files-empty-title">A place for<br /><span>everything.</span></h2>
            <p>Add your first file. Keep it organized from the start.</p>
            <div className="files-empty-actions">
              <button type="button" className="files-new-button" disabled={Boolean(uploadDisabledReason)} onClick={handleUpload}><Upload size={19} /> Upload files</button>
              <button type="button" className="files-empty-folder-action" disabled={!canCreateFolder} onClick={() => beginCreateFolder(null)}><Folder size={21} /> Create folder</button>
            </div>
          </div>
          <div className="files-empty-art" aria-hidden="true" />
          <div className="files-empty-drop-hint" aria-hidden="true"><span /><CloudUpload size={35} /><span /><p>Or drop files anywhere in this space</p></div>
        </section>}

        {trashNotice && <p className="files-trash-notice" role="status" aria-live="polite">{trashNotice}</p>}
        {uploadDropMessage && <p className="files-upload-drop-notice" role="status" aria-live="polite">{uploadDropMessage}</p>}

        {activityError && activityRetry && <div className="files-activity-inline-error" role="alert" aria-live="polite">
          <span>{activityError}</span>
          <button type="button" className="files-secondary-button" disabled={activityBusy || activityRetry.profileId !== profileId || !canWrite} onClick={() => void runStarChange(activityRetry.item, activityRetry.starred, activityRetry)}>
            <RefreshCw size={14} /> {activityRetry.committed ? "Retry refresh" : "Retry Starred change"}
          </button>
          <button type="button" className="files-secondary-button" onClick={() => { setActivityError(""); setActivityRetry(null); }}>Dismiss</button>
        </div>}

        {showSelectionToolbar && <div className="files-selection-toolbar" role="group" aria-label="Bulk file actions">
          <button type="button" className="files-secondary-button" disabled={!ordinaryItems.some(canSelectItem) || selectionActionBusy} onClick={selectVisibleItems}><Check size={15} /> Select visible</button>
          <button type="button" className="files-secondary-button" disabled={selectedItems.length === 0 || Boolean(downloadState?.busy)} onClick={clearSelection}>Clear selection</button>
          <span aria-live="polite">{selectedItems.length} {selectedItems.length === 1 ? "item" : "items"} selected</span>
          {location.view === "trash" ? <button type="button" className="files-new-button" data-files-selection-action="restore" disabled={!selectedItems.length || Boolean(selectionRestoreReason) || selectionActionBusy} title={selectionRestoreReason || undefined} onClick={(event) => beginSelectedTrashDialog("restore", event.currentTarget)}><RotateCcw size={15} /> Restore</button> : <>
            <button type="button" className="files-secondary-button" data-files-selection-action="move" disabled={!selectedItems.length || Boolean(selectionMoveReason) || selectionActionBusy} title={selectionMoveReason || undefined} onClick={(event) => beginMoveDialog(selectedItems, event.currentTarget)}><Move size={15} /> Move to…</button>
            <button type="button" className="files-secondary-button" data-files-selection-action="trash" disabled={!selectedItems.length || Boolean(selectionTrashReason) || selectionActionBusy} title={selectionTrashReason || undefined} onClick={(event) => beginSelectedTrashDialog("trash", event.currentTarget)}><Trash2 size={15} /> Move to Trash</button>
            {downloadableViews.includes(location.view) && <button type="button" className="files-new-button" disabled={!selectedItems.length || Boolean(selectionDownloadReason) || selectionActionBusy || Boolean(downloadState)} title={selectionDownloadReason || undefined} onClick={() => void runSelectedDownload()}><Download size={15} /> Download ZIP</button>}
          </>}
          {downloadState?.busy && <span className="files-download-status" role="status" aria-live="polite">Preparing your ZIP download…</span>}
          {downloadState && !downloadState.busy && <div className="files-download-error" role="alert">
            <span>{downloadState.error} Captured items: {downloadState.items.map(itemName).join(", ")}.</span>
            <div>
              <button type="button" className="files-secondary-button" disabled={downloadState.profileId !== profileId || downloadState.sessionVersion !== profileSession.version || Boolean(selectionRevisionReason(downloadState.items)) || selectionActionBusy} onClick={() => void runSelectedDownload(downloadState)}><RefreshCw size={14} /> Retry download</button>
              <button type="button" className="files-secondary-button" onClick={dismissDownloadRecovery}>Dismiss</button>
            </div>
          </div>}
          {(selectionMoveReason || selectionTrashReason || selectionRestoreReason || selectionDownloadReason) && <small className="files-selection-guidance" role="note">{selectionMoveReason || selectionTrashReason || selectionRestoreReason || selectionDownloadReason}</small>}
        </div>}

        {organizationError && <div className="files-organization-inline-error" role="alert"><span>{organizationError}</span><button type="button" className="files-secondary-button" disabled={organizationBusy} onClick={() => void browserData.refresh()}><RefreshCw size={14} /> Refresh Files</button><button type="button" className="files-secondary-button" disabled={organizationBusy || selectedItems.length === 0} onClick={clearSelection}>Clear selection</button></div>}

        {browserData.loading ? (
          <div className="files-state-panel" role="status" aria-live="polite"><span className="files-loading-spinner" aria-hidden="true" /><h3>Loading files…</h3><p>Your folders and files will appear here.</p></div>
        ) : browserData.error ? (
          <div className="files-state-panel" role="alert"><span className="files-state-icon"><RefreshCw size={20} /></span><h3>Files couldn’t be loaded</h3><p>{browserData.error}</p><button type="button" className="files-secondary-button" onClick={() => void browserData.refresh()}><RefreshCw size={15} /> Retry loading</button></div>
        ) : result.unavailable ? (
          <div className="files-state-panel" role="status">
            <span className="files-state-icon"><Folder size={21} /></span>
            <h3>This folder is unavailable</h3>
            <p>It may have been removed or is no longer available to this account.</p>
            <button type="button" className="files-secondary-button" onClick={() => navigate(location.view, null)}><ArrowLeft size={15} /> Return to {viewOptions.find((option) => option.id === location.view)?.label || "My files"}</button>
          </div>
        ) : showEmptyWelcome ? null : ordinaryItems.length === 0 && !showSyllabusPin ? (
          <div className="files-state-panel"><span className="files-state-icon"><FolderOpen size={21} /></span><h3>{searchQuery.trim() ? "No files match your search" : location.view === "trash" ? "Trash is empty" : location.view === "starred" ? "No starred files" : location.view === "recent" ? "No recent files" : location.view === "archives" ? "No archived files" : "This folder is empty"}</h3><p>{searchQuery.trim() ? "Try another name or adjust the filters." : location.view === "my-files" && !location.folderId ? "Upload a file to start building your personal library." : "Files and folders in this view will appear here."}</p>{location.view === "my-files" && !location.folderId && !searchQuery.trim() && <button type="button" className="files-new-button" disabled={Boolean(uploadDisabledReason)} onClick={handleUpload}><Upload size={16} /> Upload a file</button>}</div>
        ) : (
          <>
            {location.layout === "list" && <div className={`files-list-heading ${selectionControlsVisible ? "has-select" : ""}`} aria-hidden="true">{selectionControlsVisible && <span /> }<span>Name</span><span>Course</span><span>{location.view === "trash" ? "Deleted" : "Modified"}</span><span>Size</span><span>Status</span><span /></div>}
            {location.view === "archives" && location.folderId === null && result.archiveGroups?.length ? <div className={`files-archive-groups ${location.layout === "grid" ? "is-grid" : "is-list"}`}>
              {result.archiveGroups.map((group, groupIndex) => <section className="files-archive-group" key={`${group.label}:${groupIndex}`} aria-labelledby={`files-archive-group-${groupIndex}`}>
                <h3 id={`files-archive-group-${groupIndex}`}>{group.label}</h3>
                <div className={`files-items ${location.layout === "grid" ? "is-grid" : "is-list"}`} role="list" aria-label={`${group.label} archived folders`}>
                  {group.items.map(renderItem)}
                </div>
              </section>)}
            </div> : <div className={`files-items ${location.layout === "grid" ? "is-grid" : "is-list"}`} role="list" aria-label={`${currentTitle} contents`}>
              {showSyllabusPin && managedCourse && <PinnedSyllabus
                course={managedCourse}
                details={managedCourseDetails ?? { officeHours: "", meetings: [] }}
                file={pinnedSourceFileId ? data.files.find((file) => file.id === pinnedSourceFileId) : undefined}
                onOpen={(file) => (onOpenSyllabus ?? onOpen)(file)}
                onText={() => {
                  if (!managedCourseDetails?.syllabusText) return;
                  if (onSyllabusText) onSyllabusText(managedCourse.id);
                  else setLocalSyllabusText({ course: managedCourse, text: managedCourseDetails.syllabusText, name: managedCourseDetails.syllabusName ?? "" });
                }}
                onAttach={() => onAttachSyllabus?.(managedCourse.id, result.folder!.id)}
                canWrite={canWrite && !archivedCourseFolder}
              />}
              {ordinaryItems.map(renderItem)}
            </div>}
            {location.view === "my-files" && ordinaryItems.length > 0 && <div className="files-populated-drop-hint" aria-hidden="true"><span /><CloudUpload size={31} /><span /><p>Drop files anywhere to upload</p></div>}
          </>
        )}
      </div>
    </div>

    {menuOpen && <div className={`files-context-menu${menuTarget?.kind === "new" ? " files-new-menu" : ""}`} role="menu" aria-label={`${menuLabel} actions`} tabIndex={-1} ref={menuRef} style={{ left: menuPoint.x, top: menuPoint.y }} onKeyDown={(event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const choices = [...(menuRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']:not([aria-disabled='true'])") ?? [])];
        const index = choices.indexOf(document.activeElement as HTMLElement);
        choices[(index + (event.key === "ArrowDown" ? 1 : choices.length - 1)) % choices.length]?.focus();
      }
      if (event.key === "Home" || event.key === "End") {
        event.preventDefault();
        const choices = [...(menuRef.current?.querySelectorAll<HTMLElement>("[role='menuitem']:not([aria-disabled='true'])") ?? [])];
        (event.key === "Home" ? choices[0] : choices[choices.length - 1])?.focus();
      }
    }} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) closeMenu(); }}>{menuItem ? renderMenu(menuItem) : renderCreationMenu()}</div>}

    {organizationDialog && <FileOrganizationDialog
      key={`${organizationDialog.kind}:${organizationDialog.profileId}:${organizationDialog.kind === "create" ? organizationDialog.id : organizationDialog.kind === "rename" ? itemKey(organizationDialog.item) : organizationDialog.items.map(itemKey).join(",")}`}
      request={organizationDialog}
      currentProfileId={profileId}
      canWrite={canWrite}
      onClose={closeOrganizationDialog}
      onReselect={() => setSelectedItems([])}
      onSaved={saveOrganizationAndRefresh}
      onRefresh={async (capturedProfileId) => {
        if (profileIdRef.current !== capturedProfileId) return;
        await browserData.refresh();
      }}
      onStateChange={handleOrganizationStateChange}
      onFileEdited={onFileOpened}
    />}

    {archiveDialog && <FileArchiveDialog
      key={`${archiveDialog.action}:${archiveDialog.profileId}:${archiveDialog.folder.id}:${archiveDialog.folder.revision}`}
      request={archiveDialog}
      currentProfileId={profileId}
      canWrite={canWrite}
      onClose={closeArchiveDialog}
      onSaved={saveOrganizationAndRefresh}
      onRefresh={async (capturedProfileId, signal) => {
        if (profileIdRef.current !== capturedProfileId || signal.aborted) return;
        await saveOrganizationAndRefresh(capturedProfileId, signal);
      }}
      onStateChange={handleOrganizationStateChange}
    />}

    {trashDialog && <FilesTrashDialog
      key={`${trashDialog.action}:${trashDialog.profileId}:${trashDialog.requestId ?? trashDialog.items.map(itemKey).join(",")}`}
      request={trashDialog}
      currentProfileId={profileId}
      canWrite={canWrite}
      onClose={closeTrashDialog}
      onSaved={saveOrganizationAndRefresh}
      onRefresh={async (capturedProfileId) => {
        if (profileIdRef.current !== capturedProfileId) return;
        await browserData.refresh();
      }}
      onStateChange={handleOrganizationStateChange}
      onTrashCompleted={(receipt) => onTrashCompleted?.(receipt)}
      onRestored={(recoveryFolder) => setTrashNotice(recoveryFolder
        ? `Restored to ${recoveryFolder.name} because the original location was unavailable.`
        : "Restored to the original location.")}
    />}

    {detailsItem && <div className="files-dialog-backdrop">
      <section ref={dialogRef} className="files-details-dialog" role="dialog" aria-modal="true" aria-labelledby="files-details-title">
        <div className="files-details-heading"><div><p>{detailsItem.type === "folder" ? "Folder details" : "File details"}</p><h2 id="files-details-title">{itemName(detailsItem)}</h2></div><button type="button" className="files-icon-button" aria-label="Close details" onClick={() => { setDetailsItem(null); window.requestAnimationFrame(() => lastTriggerRef.current?.focus({ preventScroll: true })); }}><X size={18} /></button></div>
        <dl className="files-details-list">
          <div><dt>Type</dt><dd>{detailsItem.type === "file" ? detailsItem.file.kind : detailsItem.folder.kind === "course" ? "Course folder" : "Folder"}</dd></div>
          <div><dt>Course</dt><dd>{detailsCourseLabel(detailsItem)}</dd></div>
          <div><dt>{location.view === "trash" ? "Original location" : "Location"}</dt><dd>{detailsLocation(detailsItem)}</dd></div>
          <div><dt>Modified</dt><dd>{displayDate(itemModified(detailsItem))}</dd></div>
          {location.view === "trash" && <div><dt>Deleted</dt><dd>{displayDateTime(detailsItem.type === "file" ? detailsItem.file.trashed_at : detailsItem.folder.trashed_at)}</dd></div>}
          {detailsItem.type === "file" && <>
            <div><dt>Size</dt><dd>{fileSize(Number(detailsItem.file.size_bytes))}</dd></div>
            <div><dt>Status</dt><dd>{describeFileStatus(detailsItem.file)}</dd></div>
            <div><dt>Created</dt><dd>{displayDate(detailsItem.file.created_at)}</dd></div>
          </>}
          {detailsItem.type === "folder" && <>
            <div><dt>Status</dt><dd>{itemPurgePending(detailsItem) ? "Permanent deletion pending" : detailsItem.folder.trashed_at ? "In Trash" : detailsItem.folder.archived_at ? "Archived" : "Available"}</dd></div>
            <div><dt>Created</dt><dd>{displayDate(detailsItem.folder.created_at)}</dd></div>
          </>}
        </dl>
        <div className="files-details-actions"><button type="button" className="files-secondary-button" onClick={() => { setDetailsItem(null); window.requestAnimationFrame(() => lastTriggerRef.current?.focus({ preventScroll: true })); }}>Close</button></div>
      </section>
    </div>}
    {localSyllabusText && <SyllabusTextPreview course={localSyllabusText.course} text={localSyllabusText.text} name={localSyllabusText.name} onClose={() => setLocalSyllabusText(null)} />}
  </section>;
}
