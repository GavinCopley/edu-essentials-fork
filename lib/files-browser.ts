import type { PrivateFile } from "./files";
import type { FileFolder, FileItemActivity } from "./file-organization";

export type FilesBrowserView = "my-files" | "recent" | "starred" | "archives" | "trash";
export type FilesBrowserLayout = "list" | "grid";
export type FilesBrowserFileType = "all" | "text" | "pdf" | "image" | "other";
export type FilesBrowserSortBy = "name" | "modified";
export type FilesBrowserSortDirection = "asc" | "desc";

// The existing workspace filter stores a course ID, "all", or "personal".
// Search text remains temporary and is intentionally not stored.
export type FilesBrowserPreferences = {
  filter: string;
  view: FilesBrowserLayout;
  sortBy?: FilesBrowserSortBy;
  sortDirection?: FilesBrowserSortDirection;
  fileType?: FilesBrowserFileType;
  includeArchived?: boolean;
  appearanceVersion?: 2;
};

export const FILES_BROWSER_APPEARANCE_VERSION = 2 as const;

export const DEFAULT_FILES_BROWSER_PREFERENCES: FilesBrowserPreferences = {
  filter: "all",
  view: "grid",
  sortBy: "modified",
  sortDirection: "desc",
  appearanceVersion: FILES_BROWSER_APPEARANCE_VERSION,
};

export function migrateFilesBrowserPreferences(preferences: FilesBrowserPreferences): FilesBrowserPreferences {
  if (preferences.appearanceVersion === FILES_BROWSER_APPEARANCE_VERSION) return preferences;
  return {
    ...preferences,
    view: "grid",
    sortBy: "modified",
    sortDirection: "desc",
    appearanceVersion: FILES_BROWSER_APPEARANCE_VERSION,
  };
}

export type FilesBrowserOptions = {
  query?: string;
  searchScope?: "folder" | "all";
  courseFilter?: string;
  fileType?: FilesBrowserFileType;
  sortBy?: FilesBrowserSortBy;
  sortDirection?: FilesBrowserSortDirection;
  includeArchived?: boolean;
};

export type FilesBrowserLocation = {
  view: FilesBrowserView;
  folderId: string | null;
  layout: FilesBrowserLayout;
};

export type BrowserItem =
  | { type: "file"; id: string; file: PrivateFile }
  | { type: "folder"; id: string; folder: FileFolder };

export type FilesBrowserData = {
  files: PrivateFile[];
  folders: FileFolder[];
  fileActivity: Record<string, FileItemActivity>;
  folderActivity: Record<string, FileItemActivity>;
};

export type FilesBrowserArchiveGroup = { label: string; items: BrowserItem[] };

export type DerivedFilesBrowser = {
  items: BrowserItem[];
  breadcrumbs: FileFolder[];
  folder: FileFolder | null;
  unavailable: boolean;
  archiveGroups?: FilesBrowserArchiveGroup[];
};

export type BrowserItemLocation = {
  label: string;
  folderId: string | null;
  view: "my-files" | "archives" | "trash";
  unavailable: boolean;
};

type FolderState = "active" | "archived" | "trashed" | "invalid";
type FileState = "active" | "archived" | "trashed" | "invalid";
type FolderCourse = { valid: boolean; courseId: string | null };

const validDate = (value: unknown): number | null => {
  if (typeof value !== "string" || value.length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
};

function stringCompare(a: string, b: string) {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

function compareName(a: string, b: string) {
  const left = a.normalize("NFKC").toLocaleLowerCase("und");
  const right = b.normalize("NFKC").toLocaleLowerCase("und");
  return stringCompare(left, right);
}

function normalizeSearch(value: string) {
  return value.normalize("NFKC").toLocaleLowerCase("und");
}

function isTombstone(value: { deleted_at?: string | null; purge_pending_at?: string | null }) {
  return value.deleted_at != null || value.purge_pending_at != null;
}

function folderState(folder: FileFolder, byId: ReadonlyMap<string, FileFolder>): FolderState {
  let current: FileFolder | undefined = folder;
  let archived = false;
  const visited = new Set<string>();

  while (current) {
    if (visited.has(current.id) || isTombstone(current)) return "invalid";
    visited.add(current.id);
    if (current.trashed_at !== null) return "trashed";
    if (current.archived_at !== null) archived = true;
    if (current.parent_id === null) return archived ? "archived" : "active";
    current = byId.get(current.parent_id);
    // An incomplete hierarchy is never treated as a valid root.
    if (!current) return "invalid";
  }
  return "invalid";
}

function fileState(file: PrivateFile, byId: ReadonlyMap<string, FileFolder>): FileState {
  if (isTombstone(file)) return "invalid";
  if (file.trashed_at !== null) return "trashed";
  if (file.folder_id === null) return "active";
  const folder = byId.get(file.folder_id);
  if (!folder) return "invalid";
  return folderState(folder, byId);
}

function folderCourse(folder: FileFolder, byId: ReadonlyMap<string, FileFolder>): FolderCourse {
  let current: FileFolder | undefined = folder;
  const visited = new Set<string>();
  let courseId: string | null = null;
  while (current) {
    if (visited.has(current.id) || isTombstone(current) || current.trashed_at !== null) {
      return { valid: false, courseId: null };
    }
    visited.add(current.id);
    if (current.kind === "course" && current.course_id !== null) courseId = current.course_id;
    if (current.parent_id === null) return { valid: true, courseId };
    current = byId.get(current.parent_id);
  }
  return { valid: false, courseId: null };
}

function folderMatchesCourse(folder: FileFolder, byId: ReadonlyMap<string, FileFolder>, filter?: string) {
  if (!filter || filter === "all") return true;
  const owner = folderCourse(folder, byId);
  if (!owner.valid) return false;
  return filter === "personal" ? owner.courseId === null : owner.courseId === filter;
}

function fileMatchesCourse(file: PrivateFile, filter?: string) {
  if (!filter || filter === "all") return true;
  return filter === "personal" ? file.course_id === null : file.course_id === filter;
}

function fileMatchesType(file: PrivateFile, filter?: FilesBrowserFileType) {
  if (!filter || filter === "all") return true;
  const mime = file.mime_type.toLowerCase().split(";", 1)[0].trim();
  if (filter === "text") return mime.startsWith("text/");
  if (filter === "pdf") return mime === "application/pdf";
  if (filter === "image") return mime.startsWith("image/");
  return !mime.startsWith("text/") && mime !== "application/pdf" && !mime.startsWith("image/");
}

function itemName(item: BrowserItem) {
  return item.type === "folder" ? item.folder.name : item.file.name;
}

function itemUpdatedAt(item: BrowserItem) {
  return item.type === "folder" ? item.folder.updated_at : item.file.updated_at;
}

function sortItems(
  items: BrowserItem[],
  sortBy: FilesBrowserSortBy = "name",
  sortDirection: FilesBrowserSortDirection = "asc",
) {
  const direction = sortDirection === "desc" ? -1 : 1;
  return items.sort((a, b) => {
    // Folders stay ahead of files in either direction so they remain easy to
    // use for navigation.
    if (a.type !== b.type) return a.type === "folder" ? -1 : 1;
    const compared = sortBy === "modified"
      ? (validDate(itemUpdatedAt(a)) ?? 0) - (validDate(itemUpdatedAt(b)) ?? 0)
      : compareName(itemName(a), itemName(b));
    return compared === 0 ? stringCompare(a.id, b.id) : compared * direction;
  });
}

function folderPath(
  folder: FileFolder,
  byId: ReadonlyMap<string, FileFolder>,
  allowedState: "active" | "archived" | "trashed",
): FileFolder[] | null {
  const path: FileFolder[] = [];
  const visited = new Set<string>();
  let current: FileFolder | undefined = folder;
  while (current) {
    if (visited.has(current.id) || isTombstone(current) || current.trashed_at !== null) return null;
    visited.add(current.id);
    path.push(current);
    if (current.parent_id === null) break;
    const parent = byId.get(current.parent_id);
    if (!parent) return null;
    current = parent;
  }
  if (!current || (allowedState !== "trashed" && folderState(folder, byId) !== allowedState)) return null;
  if (allowedState === "trashed" && folder.trashed_at === null) return null;
  return path.reverse();
}

function trashFolderPath(folder: FileFolder, byId: ReadonlyMap<string, FileFolder>): FileFolder[] | null {
  const path: FileFolder[] = [];
  const visited = new Set<string>();
  let current: FileFolder | undefined = folder;
  while (current) {
    if (visited.has(current.id) || isTombstone(current)) return null;
    visited.add(current.id);
    path.push(current);
    if (current.trashed_at === null) break;
    const parentId = current.original_parent_id;
    if (parentId === null) break;
    const parent = byId.get(parentId);
    if (!parent || isTombstone(parent)) break;
    // An original active parent belongs at the Trash root, not in its breadcrumb.
    if (parent.trashed_at === null) break;
    current = parent;
  }
  if (!current || folder.trashed_at === null) return null;
  return path.reverse();
}

function folderIsInSelectedView(
  folder: FileFolder,
  byId: ReadonlyMap<string, FileFolder>,
  location: FilesBrowserLocation,
  data: FilesBrowserData,
  includeArchived: boolean,
) {
  const state = folderState(folder, byId);
  if (location.view === "archives") return state === "archived";
  if (location.view === "trash") return state === "trashed";
  if (location.view === "recent") return false;
  if (location.view === "starred" && !data.folderActivity[folder.id]?.starred_at) return false;
  if (state === "active") return true;
  return includeArchived && state === "archived";
}

function safeTrashOriginalPath(folderId: string | null, byId: ReadonlyMap<string, FileFolder>) {
  const visited = new Set<string>();
  let currentId = folderId;
  while (currentId !== null) {
    if (visited.has(currentId)) return false;
    visited.add(currentId);
    const current = byId.get(currentId);
    // A deleted original location remains recoverable through Trash. Only a
    // cycle is unsafe to navigate; restore supplies its recovery destination.
    if (!current || isTombstone(current)) return true;
    currentId = current.trashed_at === null ? current.parent_id : current.original_parent_id;
  }
  return true;
}

function folderContents(
  folderId: string | null,
  folders: readonly FileFolder[],
  files: readonly PrivateFile[],
  byId: ReadonlyMap<string, FileFolder>,
  view: FilesBrowserView,
  includeArchived: boolean,
): BrowserItem[] {
  if (view === "trash") {
    // A pending purge is still a trashed row the user needs to recover from.
    // Keep it visible here until deletion is acknowledged, while deleted
    // tombstones stay hidden and pending folders remain invalid everywhere
    // else through folderState/isTombstone.
    const folderItems = folders.filter((folder) => folder.trashed_at !== null && folder.deleted_at == null)
      .filter((folder) => safeTrashOriginalPath(folder.original_parent_id, byId))
      .filter((folder) => folder.original_parent_id === folderId || (folderId === null && Boolean(
        folder.original_parent_id &&
        (!byId.has(folder.original_parent_id) || isTombstone(byId.get(folder.original_parent_id)!) || byId.get(folder.original_parent_id)?.trashed_at === null),
      )))
      .map((folder): BrowserItem => ({ type: "folder", id: folder.id, folder }));
    const fileItems = files.filter((file) => file.trashed_at !== null && !isTombstone(file))
      .filter((file) => safeTrashOriginalPath(file.original_folder_id, byId))
      .filter((file) => file.original_folder_id === folderId || (folderId === null && Boolean(
        file.original_folder_id &&
        (!byId.has(file.original_folder_id) || isTombstone(byId.get(file.original_folder_id)!) || byId.get(file.original_folder_id)?.trashed_at === null),
      )))
      .map((file): BrowserItem => ({ type: "file", id: file.id, file }));
    return [...folderItems, ...fileItems];
  }

  const parent = folderId === null ? undefined : byId.get(folderId);
  const parentState = parent ? folderState(parent, byId) : null;
  const allowed = (folder: FileFolder) => {
    const state = folderState(folder, byId);
    if (view === "archives" || (view === "my-files" && parentState === "archived")) return state === "archived";
    return state === "active" || (view === "my-files" && includeArchived && state === "archived");
  };
  const foldersForView = folders.filter((folder) => folder.parent_id === folderId && allowed(folder));
  const filesForView = files.filter((file) => file.trashed_at === null && !isTombstone(file) && file.folder_id === folderId)
    .filter((file) => {
      const state = fileState(file, byId);
      if (view === "archives" || (view === "my-files" && parentState === "archived")) return state === "archived";
      return state === "active" || (view === "my-files" && includeArchived && state === "archived");
    });
  return [
    ...foldersForView.map((folder): BrowserItem => ({ type: "folder", id: folder.id, folder })),
    ...filesForView.map((file): BrowserItem => ({ type: "file", id: file.id, file })),
  ];
}

function allowedSearchState(state: FileState | FolderState, includeArchived: boolean) {
  return state === "active" || (includeArchived && state === "archived");
}

function allSearchItems(
  data: FilesBrowserData,
  byId: ReadonlyMap<string, FileFolder>,
  query: string,
  options: FilesBrowserOptions,
) {
  const needle = normalizeSearch(query);
  const includeArchived = options.includeArchived === true;
  return [
    ...data.folders.filter((folder) => allowedSearchState(folderState(folder, byId), includeArchived))
      .filter((folder) => folderMatchesCourse(folder, byId, options.courseFilter))
      .filter((folder) => normalizeSearch(folder.name).includes(needle))
      .map((folder): BrowserItem => ({ type: "folder", id: folder.id, folder })),
    ...data.files.filter((file) => allowedSearchState(fileState(file, byId), includeArchived))
      .filter((file) => fileMatchesCourse(file, options.courseFilter) && fileMatchesType(file, options.fileType))
      .filter((file) => normalizeSearch(file.name).includes(needle))
      .map((file): BrowserItem => ({ type: "file", id: file.id, file })),
  ];
}

function recentItems(data: FilesBrowserData, byId: ReadonlyMap<string, FileFolder>, includeArchived: boolean) {
  return data.files
    .filter((file) => file.state === "ready" && allowedSearchState(fileState(file, byId), includeArchived))
    .map((file) => ({ file, openedAt: validDate(data.fileActivity[file.id]?.last_opened_at) }))
    .filter((entry): entry is { file: PrivateFile; openedAt: number } => entry.openedAt !== null)
    .sort((a, b) => b.openedAt - a.openedAt || stringCompare(a.file.id, b.file.id))
    .map(({ file }): BrowserItem => ({ type: "file", id: file.id, file }));
}

function rootArchiveGroups(folders: readonly FileFolder[], byId: ReadonlyMap<string, FileFolder>, options: FilesBrowserOptions) {
  const roots = folders.filter((folder) => folder.parent_id === null && folder.archived_at !== null && folderState(folder, byId) === "archived")
    .filter((folder) => folderMatchesCourse(folder, byId, options.courseFilter))
    .map((folder): BrowserItem => ({ type: "folder", id: folder.id, folder }));
  const groups = new Map<string, BrowserItem[]>();
  for (const item of sortItems(roots, options.sortBy, options.sortDirection)) {
    if (item.type !== "folder") continue;
    const label = item.folder.semester_label?.trim() || "Archived";
    const group = groups.get(label) ?? [];
    group.push(item);
    groups.set(label, group);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => compareName(a, b))
    .map(([label, items]) => ({ label, items }));
}

function fileAndFolderFilter(items: BrowserItem[], byId: ReadonlyMap<string, FileFolder>, options: FilesBrowserOptions) {
  return items.filter((item) => item.type === "folder"
    ? folderMatchesCourse(item.folder, byId, options.courseFilter)
    : fileMatchesCourse(item.file, options.courseFilter) && fileMatchesType(item.file, options.fileType));
}

export function deriveFilesBrowser(
  data: FilesBrowserData,
  location: FilesBrowserLocation,
  options: FilesBrowserOptions = {},
): DerivedFilesBrowser {
  const byId = new Map(data.folders.map((folder) => [folder.id, folder]));
  const includeArchived = options.includeArchived === true;
  const query = typeof options.query === "string" ? options.query.trim() : "";
  const searchAll = query.length > 0 && options.searchScope === "all" && location.view !== "trash";
  let folder: FileFolder | null = null;
  let breadcrumbs: FileFolder[] = [];

  if (location.folderId !== null) {
    const candidate = byId.get(location.folderId);
    if (!candidate || !folderIsInSelectedView(candidate, byId, location, data, includeArchived)) {
      return { items: [], breadcrumbs, folder, unavailable: true };
    }
    folder = candidate;
    const state = folderState(candidate, byId);
    const path = state === "trashed"
      ? trashFolderPath(candidate, byId)
      : folderPath(candidate, byId, state === "archived" ? "archived" : "active");
    if (!path) return { items: [], breadcrumbs: [], folder: null, unavailable: true };
    breadcrumbs = path;
  }

  if (searchAll) {
    const items = sortItems(allSearchItems(data, byId, query, options), options.sortBy, options.sortDirection);
    return { items, breadcrumbs, folder, unavailable: false };
  }

  if (location.view === "recent") {
    let items = recentItems(data, byId, includeArchived);
    if (query) items = items.filter((item) => normalizeSearch(itemName(item)).includes(normalizeSearch(query)));
    items = fileAndFolderFilter(items, byId, options);
    // Recent always reflects actual open times; filter and sort preferences do
    // not reorder it.
    return { items, breadcrumbs, folder, unavailable: false };
  }

  let items: BrowserItem[];
  if (location.view === "starred" && location.folderId === null) {
    const folders = data.folders.filter((item) => {
      const state = folderState(item, byId);
      return data.folderActivity[item.id]?.starred_at != null &&
        (state === "active" || (includeArchived && state === "archived")) &&
        folderMatchesCourse(item, byId, options.courseFilter);
    }).map((item): BrowserItem => ({ type: "folder", id: item.id, folder: item }));
    const files = data.files.filter((item) => data.fileActivity[item.id]?.starred_at != null &&
      allowedSearchState(fileState(item, byId), includeArchived) &&
      fileMatchesCourse(item, options.courseFilter) && fileMatchesType(item, options.fileType))
      .map((item): BrowserItem => ({ type: "file", id: item.id, file: item }));
    items = [...folders, ...files];
  } else if (location.view === "archives" && location.folderId === null) {
    const archiveGroups = rootArchiveGroups(data.folders, byId, options);
    const archiveItems = archiveGroups.flatMap((group) => group.items);
    if (query) archiveGroups.forEach((group) => {
      group.items = group.items.filter((item) => normalizeSearch(itemName(item)).includes(normalizeSearch(query)));
    });
    const visibleGroups = archiveGroups.filter((group) => group.items.length > 0);
    return {
      items: sortItems(query ? visibleGroups.flatMap((group) => group.items) : archiveItems, options.sortBy, options.sortDirection),
      breadcrumbs,
      folder,
      unavailable: false,
      archiveGroups: visibleGroups,
    };
  } else {
    const sourceFolders = location.view === "trash"
      ? data.folders
      : data.folders.filter((item) => location.view === "archives"
        ? folderState(item, byId) === "archived"
        : folderState(item, byId) === "active" || (includeArchived && folderState(item, byId) === "archived"));
    items = folderContents(location.folderId, sourceFolders, data.files, byId, location.view, includeArchived);
    if (location.view === "starred" && location.folderId !== null) {
      // The starred root is a shortcut list. Opening a starred folder shows
      // that folder's ordinary contents.
      const state = folder ? folderState(folder, byId) : "invalid";
      const contentView = state === "archived" ? "archives" : "my-files";
      items = folderContents(location.folderId, data.folders, data.files, byId, contentView, includeArchived);
    }
  }

  if (query) {
    const needle = normalizeSearch(query);
    items = items.filter((item) => normalizeSearch(itemName(item)).includes(needle));
  }
  items = fileAndFolderFilter(items, byId, options);
  return {
    items: sortItems(items, options.sortBy, options.sortDirection),
    breadcrumbs,
    folder,
    unavailable: false,
  };
}

function archiveDisplayName(folder: FileFolder) {
  return folder.course_name_snapshot?.trim() || folder.name;
}

function displayFolderPath(path: readonly FileFolder[], archived: boolean) {
  const names = path.map((folder, index) => archived && index === 0 ? archiveDisplayName(folder) : folder.name);
  return archived
    ? ["Archives", path[0]?.semester_label?.trim() || "Archived", ...names].join(" / ")
    : names.length === 0 ? "My files" : ["My files", ...names].join(" / ");
}

function unavailableLocation(view: BrowserItemLocation["view"] = "my-files"): BrowserItemLocation {
  return { label: "Unavailable folder", folderId: null, view, unavailable: true };
}

export function browserItemLocation(item: BrowserItem, folders: readonly FileFolder[]): BrowserItemLocation {
  if (!item || (item.type !== "file" && item.type !== "folder") || item.id !== (item.type === "file" ? item.file?.id : item.folder?.id)) {
    return unavailableLocation();
  }
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  if (item.type === "file" ? isTombstone(item.file) : isTombstone(item.folder)) return unavailableLocation();

  const isTrashed = item.type === "file" ? item.file.trashed_at !== null : item.folder.trashed_at !== null;
  if (isTrashed) {
    const parentId = item.type === "file" ? item.file.original_folder_id : item.folder.original_parent_id;
    const snapshot = item.type === "file"
      ? item.file.original_location_path
      : item.folder.original_location_path;
    if (parentId === null) {
      return { label: typeof snapshot === "string" && snapshot.trim() ? snapshot : "My files", folderId: null, view: "trash", unavailable: false };
    }
    const originalParent = byId.get(parentId);
    if (!originalParent || isTombstone(originalParent)) {
      return {
        label: typeof snapshot === "string" && snapshot.trim() ? snapshot : "Unavailable original folder",
        folderId: null,
        view: "trash",
        unavailable: true,
      };
    }
    if (originalParent.trashed_at === null) {
      const parentPath = folderPath(originalParent, byId, folderState(originalParent, byId) === "archived" ? "archived" : "active");
      return {
        label: typeof snapshot === "string" && snapshot.trim()
          ? snapshot
          : parentPath ? ["My files", ...parentPath.map((folder) => folder.name), itemName(item)].join(" / ") : "Unavailable original folder",
        folderId: null,
        view: "trash",
        unavailable: parentPath === null,
      };
    }
    const visited = new Set<string>();
    let currentId: string | null = parentId;
    const path: FileFolder[] = [];
    while (currentId !== null) {
      if (visited.has(currentId)) {
        return { label: typeof snapshot === "string" && snapshot.trim() ? snapshot : "Unavailable original folder", folderId: null, view: "trash", unavailable: true };
      }
      visited.add(currentId);
      const current = byId.get(currentId);
      if (!current || isTombstone(current)) {
        return { label: typeof snapshot === "string" && snapshot.trim() ? snapshot : "Unavailable original folder", folderId: null, view: "trash", unavailable: true };
      }
      path.push(current);
      currentId = current.trashed_at === null ? current.parent_id : current.original_parent_id;
    }
    const label = typeof snapshot === "string" && snapshot.trim()
      ? snapshot
      : path.length ? ["My files", ...path.reverse().map((folder) => folder.name), itemName(item)].join(" / ") : itemName(item);
    return { label, folderId: parentId, view: "trash", unavailable: false };
  }

  const state = item.type === "folder"
    ? folderState(item.folder, byId)
    : fileState(item.file, byId);
  if (state !== "active" && state !== "archived") return unavailableLocation();
  const folderId = item.type === "file" ? item.file.folder_id : item.folder.parent_id;
  if (folderId === null) {
    const rootLabel = item.type === "folder" && state === "archived"
      ? "Archives / " + (item.folder.semester_label?.trim() || "Archived")
      : "My files";
    return { label: rootLabel, folderId: null, view: state === "archived" ? "archives" : "my-files", unavailable: false };
  }
  const parent = byId.get(folderId);
  if (!parent) return unavailableLocation(state === "archived" ? "archives" : "my-files");
  const parentState = folderState(parent, byId);
  if (parentState !== state) return unavailableLocation(state === "archived" ? "archives" : "my-files");
  const path = folderPath(parent, byId, state);
  if (!path) return unavailableLocation(state === "archived" ? "archives" : "my-files");
  return {
    label: displayFolderPath(path, state === "archived"),
    folderId,
    view: state === "archived" ? "archives" : "my-files",
    unavailable: false,
  };
}
