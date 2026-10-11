"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { PrivateFile } from "../lib/files";
import type { FileFolder, FileItemActivity } from "../lib/file-organization";
import type { FilesBrowserData, FilesBrowserLayout, FilesBrowserLocation, FilesBrowserView } from "../lib/files-browser";

const EMPTY_DATA: FilesBrowserData = { files: [], folders: [], fileActivity: {}, folderActivity: {} };
const views = new Set<FilesBrowserView>(["my-files", "recent", "starred", "archives", "trash"]);
const layouts = new Set<FilesBrowserLayout>(["list", "grid"]);

export type FilesBrowserDataState = {
  data: FilesBrowserData;
  loading: boolean;
  error: string;
  refresh: (throwOnError?: boolean, signal?: AbortSignal) => Promise<void>;
};

type BrowserRequestState = {
  profileId: string | null;
  data: FilesBrowserData;
  loading: boolean;
  error: string;
};

function errorMessage(error: unknown) {
  if (error instanceof Error && error.name === "TimeoutError") return "Loading your files took too long. Please retry.";
  return error instanceof Error && error.message ? error.message : "File browser request failed. Please retry.";
}

async function readResponse<T>(url: string, profileId: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    signal,
    headers: { "x-profile-id": profileId },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({})) as { error?: unknown };
    throw new Error(response.status === 401
      ? "Sign in to the original account in a new tab, then retry."
      : typeof body.error === "string" ? body.error : "File browser request failed. Please retry.");
  }
  return await response.json() as T;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requiredRows<T>(value: unknown, label: string): T[] {
  if (!Array.isArray(value)) throw new Error(`Unable to load ${label}.`);
  return value as T[];
}

function activityRows(value: unknown, key: "file_id" | "folder_id") {
  const root = record(value), activities = record(root.activities);
  const rows = activities[key === "file_id" ? "files" : "folders"];
  return Array.isArray(rows) ? rows.map(record) : [];
}

function mergeActivity(
  rows: Record<string, unknown>[],
  idKey: "file_id" | "folder_id",
  itemIds: string[],
): Record<string, FileItemActivity> {
  const result: Record<string, FileItemActivity> = Object.create(null) as Record<string, FileItemActivity>;
  for (const id of itemIds) result[id] = { starred_at: null, last_opened_at: null };
  for (const row of rows) {
    const id = row[idKey];
    if (typeof id !== "string" || !Object.prototype.hasOwnProperty.call(result, id)) continue;
    const previous = result[id];
    result[id] = {
      starred_at: row.starred_at === null ? null : typeof row.starred_at === "string" ? row.starred_at : previous.starred_at,
      last_opened_at: row.last_opened_at === null ? null : typeof row.last_opened_at === "string" ? row.last_opened_at : previous.last_opened_at,
    };
  }
  return result;
}

function uniqueById<T extends { id: string }>(groups: T[][]): T[] {
  const records = new Map<string, T>();
  for (const group of groups) {
    for (const item of group) if (!records.has(item.id)) records.set(item.id, item);
  }
  return [...records.values()];
}

async function loadFilesBrowserData(profileId: string, signal: AbortSignal): Promise<FilesBrowserData> {
  const [activeFilePayload, trashFilePayload, activeFolderPayload, archiveFolderPayload, trashFolderPayload] = await Promise.all([
    readResponse<unknown>("/api/files?view=active", profileId, signal),
    readResponse<unknown>("/api/files?view=trash", profileId, signal),
    readResponse<unknown>("/api/file-folders?view=active", profileId, signal),
    readResponse<unknown>("/api/file-folders?view=archives", profileId, signal),
    readResponse<unknown>("/api/file-folders?view=trash", profileId, signal),
  ]);
  if (signal.aborted) {
    if (signal.reason instanceof Error && signal.reason.name === "TimeoutError") throw signal.reason;
    throw new DOMException("The request was aborted.", "AbortError");
  }

  const activeFiles = requiredRows<PrivateFile>(record(activeFilePayload).files, "your files");
  const trashedFiles = requiredRows<PrivateFile>(record(trashFilePayload).files, "Trash");
  const activeFolders = requiredRows<FileFolder>(record(activeFolderPayload).folders, "your folders");
  const archivedFolders = requiredRows<FileFolder>(record(archiveFolderPayload).folders, "Archives");
  const trashedFolders = requiredRows<FileFolder>(record(trashFolderPayload).folders, "Trash");
  const files = uniqueById([activeFiles, trashedFiles]);
  const folders = uniqueById([activeFolders, archivedFolders, trashedFolders]);
  const fileActivityRows = [
    ...activityRows(activeFilePayload, "file_id"),
    ...activityRows(trashFilePayload, "file_id"),
  ];
  const folderActivityRows = [
    ...activityRows(activeFolderPayload, "folder_id"),
    ...activityRows(archiveFolderPayload, "folder_id"),
    ...activityRows(trashFolderPayload, "folder_id"),
  ];
  return {
    files,
    folders,
    fileActivity: mergeActivity(fileActivityRows, "file_id", files.map((file) => file.id)),
    folderActivity: mergeActivity(folderActivityRows, "folder_id", folders.map((folder) => folder.id)),
  };
}

export function useFilesBrowserData(profileId: string, changeToken?: readonly PrivateFile[]): FilesBrowserDataState {
  const [state, setState] = useState<BrowserRequestState>(() => ({
    profileId: null,
    data: EMPTY_DATA,
    loading: true,
    error: "",
  }));
  const generation = useRef(0);
  const activeController = useRef<AbortController | null>(null);

  const refresh = useCallback(async (throwOnError = false, signal?: AbortSignal) => {
    const version = ++generation.current;
    activeController.current?.abort();
    const controller = new AbortController();
    activeController.current = controller;
    const requestSignal = AbortSignal.any([controller.signal, AbortSignal.timeout(120000), ...(signal ? [signal] : [])]);
    setState((current) => current.profileId === profileId
      ? { ...current, loading: true, error: "" }
      : { profileId, data: EMPTY_DATA, loading: true, error: "" });
    try {
      const data = await loadFilesBrowserData(profileId, requestSignal);
      if (!requestSignal.aborted && version === generation.current) {
        setState({ profileId, data, loading: false, error: "" });
      } else if (throwOnError) throw new DOMException("The Files refresh was interrupted.", "AbortError");
    } catch (error) {
      if (!controller.signal.aborted && version === generation.current) {
        setState((current) => ({
          profileId,
          data: current.profileId === profileId ? current.data : EMPTY_DATA,
          loading: false,
          error: errorMessage(error),
        }));
      }
      if (throwOnError) throw error;
    } finally {
      if (version === generation.current && activeController.current === controller) activeController.current = null;
    }
  }, [profileId]);

  useEffect(() => {
    void refresh();
    return () => {
      generation.current += 1;
      activeController.current?.abort();
      activeController.current = null;
    };
  }, [refresh, changeToken]);

  if (state.profileId !== profileId) return { data: EMPTY_DATA, loading: true, error: "", refresh };
  return { data: state.data, loading: state.loading, error: state.error, refresh };
}

function parsedView(value: string | null): FilesBrowserView {
  return value && views.has(value as FilesBrowserView) ? value as FilesBrowserView : "my-files";
}

function parsedLayout(value: string | null, initialLayout: FilesBrowserLayout): FilesBrowserLayout {
  return value && layouts.has(value as FilesBrowserLayout) ? value as FilesBrowserLayout : initialLayout;
}

function href(pathname: string, params: URLSearchParams) {
  const query = params.toString();
  return query ? `${pathname}?${query}` : pathname;
}

export function useFilesBrowserLocation(initialLayout: FilesBrowserLayout = "list", ignoreUrlLayout = false) {
  const pathname = usePathname() || "/files";
  const router = useRouter();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const safeInitialLayout = layouts.has(initialLayout) ? initialLayout : "list";
  const location: FilesBrowserLocation = {
    view: parsedView(searchParams.get("view")),
    folderId: searchParams.get("folder") || null,
    layout: ignoreUrlLayout ? safeInitialLayout : parsedLayout(searchParams.get("layout"), safeInitialLayout),
  };

  const navigate = useCallback((view: FilesBrowserView, folderId?: string | null) => {
    const params = new URLSearchParams(search);
    params.set("view", view);
    params.set("layout", location.layout);
    if (folderId) params.set("folder", folderId);
    else params.delete("folder");
    router.push(href(pathname, params));
  }, [location.layout, pathname, router, search]);

  const setLayout = useCallback((layout: FilesBrowserLayout, replace = false) => {
    const safeLayout = layouts.has(layout) ? layout : safeInitialLayout;
    const params = new URLSearchParams(search);
    params.set("layout", safeLayout);
    const target = href(pathname, params);
    if (replace) router.replace(target);
    else router.push(target);
  }, [pathname, router, safeInitialLayout, search]);

  return { location, navigate, setLayout };
}
