"use client";
import { useEffect, useLayoutEffect, useRef, useState, type ChangeEvent, type Dispatch, type DragEvent as ReactDragEvent, type SetStateAction } from "react";
import { Folder, FolderOpen, Link2, ShieldCheck, Upload, X } from "lucide-react";
import { folderCourseId, folderDestinationReason } from "../lib/files-browser-operations";
import type { FileFolder } from "../lib/file-organization";
import type { Course } from "../lib/academics";
import { fileSize, type PrivateFile } from "../lib/files";
import { downloadDraft } from "./use-save-protection";
import type { FileUploadDefaults, FileUploadQueue, FileUploadRow } from "./use-file-uploads";
import { useFilesBrowserData } from "./use-files-browser";
import { buildFolderUploadPlan, ensureFolderUploadHierarchy, type FolderUploadPlan } from "../lib/files-folder-upload";
import "./file-upload-dialog.css";

export type PendingFolderUpload = FolderUploadPlan & {
  status: "ready" | "creating" | "error";
  error: string;
};

export type FileUploadDialogProps = {
  queue: FileUploadQueue;
  currentProfileId: string;
  currentSessionGeneration?: number;
  defaults: FileUploadDefaults & { profileId?: string; generation?: number };
  mode?: "files" | "folder";
  courses?: Course[];
  changeToken?: readonly PrivateFile[];
  folderUpload?: PendingFolderUpload | null;
  onFolderUploadChange?: Dispatch<SetStateAction<PendingFolderUpload | null>>;
  canWrite: boolean;
  onClose: () => void;
};

function statusLabel(row: FileUploadRow, currentProfileId: string): string {
  if (row.status === "uploading") return `Uploading · ${Math.min(99, Math.round(row.progress * 100))}%`;
  if (row.status === "refreshing") return "Upload confirmed · refreshing Files";
  if (row.status === "complete") return "Uploaded and verified";
  if (row.status === "refresh-error") return "Upload confirmed · refresh needs retry";
  if (row.status === "error") return "Upload needs attention";
  if (row.profileId !== currentProfileId) return "Waiting for the original account";
  return "Waiting to upload";
}

function safeDraftName(id: string): string {
  return `eduessentials-upload-${id}.json`;
}

function downloadOriginal(row: FileUploadRow) {
  const url = URL.createObjectURL(row.file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = row.file.name || "original-file";
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadRequest(row: FileUploadRow) {
  downloadDraft(safeDraftName(row.id), {
    version: 1,
    id: row.id,
    profileId: row.profileId,
    originalSession: row.originalSession,
    lastAttempt: row.attemptSession,
    file: { name: row.file.name, size: row.file.size, type: row.file.type, lastModified: row.file.lastModified },
    metadata: row.metadata,
    status: row.status,
    progress: row.progress,
    acknowledged: row.acknowledged,
    uploadedFile: row.uploaded ?? null,
    error: row.error,
  });
}

function downloadFolderOriginal(entry: PendingFolderUpload["files"][number]) {
  const url = URL.createObjectURL(entry.file);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = entry.relativePath.split("/").join(" — ");
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function relativeFileName(file: File): string {
  const path = (file as File & { webkitRelativePath?: string }).webkitRelativePath;
  return path || file.name || "Unnamed file";
}

function folderLabel(folderId: string | null, folders: readonly FileFolder[]): string {
  if (!folderId) return "My files";
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const segments: string[] = [];
  const visited = new Set<string>();
  let currentId: string | null = folderId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const folder = byId.get(currentId);
    if (!folder) return "Unavailable folder";
    segments.unshift(folder.name);
    currentId = folder.parent_id;
  }
  if (currentId) return "Unavailable folder";
  return `My files / ${segments.join(" / ")}`;
}

function activeFolders(folders: readonly FileFolder[]): FileFolder[] {
  return folders.filter((folder) => folderDestinationReason(folder.id, folders) === "");
}

function folderDepth(folder: FileFolder, folders: readonly FileFolder[]): number {
  let currentId = folder.parent_id;
  let depth = 1;
  const byId = new Map(folders.map((candidate) => [candidate.id, candidate]));
  const visited = new Set<string>();
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const parent = byId.get(currentId);
    if (!parent) break;
    depth += 1;
    currentId = parent.parent_id;
  }
  return depth;
}

function isActiveDestination(folderId: string | null, folders: readonly FileFolder[], loading: boolean, error: string): boolean {
  if (folderId === null) return true;
  if (loading || error) return false;
  return folders.some((folder) => folder.id === folderId && folderDestinationReason(folder.id, folders) === "");
}

export function FileUploadDialog({
  queue,
  currentProfileId,
  currentSessionGeneration = 0,
  defaults,
  mode = "files",
  courses = [],
  changeToken,
  folderUpload = null,
  onFolderUploadChange,
  canWrite,
  onClose,
}: FileUploadDialogProps) {
  const dialogRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const chooseButtonRef = useRef<HTMLButtonElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef(onClose);
  const activeFolderUploadRef = useRef<AbortController | null>(null);
  const currentStateRef = useRef({ currentProfileId, currentSessionGeneration, canWrite });
  const capturedProfileId = defaults.profileId ?? currentProfileId;
  const [destinationId, setDestinationId] = useState<string | null>(defaults.folderId);
  const [courseId, setCourseId] = useState(defaults.courseId);
  const [courseWasChosen, setCourseWasChosen] = useState(false);
  const [showDestinationPicker, setShowDestinationPicker] = useState(false);
  const [pickerError, setPickerError] = useState("");
  const [folderSelectionError, setFolderSelectionError] = useState("");
  const browserData = useFilesBrowserData(capturedProfileId, changeToken);
  const folders = activeFolders(browserData.data.folders);
  const uploadMode = folderUpload ? "folder" : mode;
  const planBusy = folderUpload?.status === "creating";
  const folderHasCreated = Boolean(folderUpload?.directories.some((directory) => directory.created));
  const destinationValid = isActiveDestination(destinationId, folders, browserData.loading, browserData.error);
  const courseValid = !courseId || courses.some((course) => course.id === courseId);
  const destinationLabel = destinationId ? folderLabel(destinationId, folders) : "Files";

  useLayoutEffect(() => { currentStateRef.current = { currentProfileId, currentSessionGeneration, canWrite }; }, [canWrite, currentProfileId, currentSessionGeneration]);
  useLayoutEffect(() => { closeRef.current = onClose; }, [onClose]);

  useEffect(() => () => activeFolderUploadRef.current?.abort(new DOMException("The folder upload panel was closed.", "AbortError")), []);

  useLayoutEffect(() => {
    inputRef.current?.toggleAttribute("webkitdirectory", uploadMode === "folder");
    inputRef.current?.toggleAttribute("directory", uploadMode === "folder");
  }, [uploadMode]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const focusTarget = chooseButtonRef.current?.disabled ? closeButtonRef.current : chooseButtonRef.current;
    window.requestAnimationFrame(() => focusTarget?.focus({ preventScroll: true }));
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialogRef.current) return;
      event.stopImmediatePropagation();
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])",
      )].filter((element) => {
        if (element.closest("[hidden], [inert], [aria-hidden='true']")) return false;
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      });
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && (document.activeElement === first || !dialogRef.current.contains(document.activeElement))) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || !dialogRef.current.contains(document.activeElement))) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => {
      window.removeEventListener("keydown", handleKeyDown, true);
      window.requestAnimationFrame(() => {
        const visibleAndEnabled = previousFocus && previousFocus !== document.body && previousFocus.isConnected &&
          !previousFocus.matches(":disabled") && previousFocus.getAttribute("aria-hidden") !== "true" &&
          !previousFocus.closest("[inert], [aria-hidden='true']") &&
          getComputedStyle(previousFocus).display !== "none" && getComputedStyle(previousFocus).visibility !== "hidden";
        const fallback = document.querySelector<HTMLElement>(".files-browser .files-new-button:not(:disabled)");
        if (visibleAndEnabled) previousFocus.focus({ preventScroll: true });
        else if (fallback?.isConnected) fallback.focus({ preventScroll: true });
      });
    };
  }, []);

  const acceptFiles = (selected: File[]) => {
    if (!selected.length) return;
    setPickerError("");
    setFolderSelectionError("");
    if (uploadMode === "folder") {
      if (!destinationValid || !courseValid) {
        setPickerError(!destinationValid ? "Choose an active Files destination first." : "Choose an active course for this upload.");
        return;
      }
      try {
        const plan = buildFolderUploadPlan(selected, {
          profileId: capturedProfileId,
          sessionGeneration: currentSessionGeneration,
          folderId: destinationId,
          courseId,
        });
        onFolderUploadChange?.({ ...plan, status: "ready", error: "" });
      } catch (error) {
        setFolderSelectionError(error instanceof Error ? error.message : "Choose a folder with supported relative paths.");
      }
      return;
    }
    if (!destinationValid || !courseValid) {
      setPickerError(!destinationValid ? "Choose an active Files destination first." : "Choose an active course for this upload.");
      return;
    }
    queue.enqueue(selected, { folderId: destinationId, courseId });
  };

  const handleFiles = (event: ChangeEvent<HTMLInputElement>) => {
    acceptFiles(Array.from(event.currentTarget.files ?? []));
    event.currentTarget.value = "";
  };

  const handleUploadDrop = (event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    if (!canWrite) return;
    acceptFiles(Array.from(event.dataTransfer.files ?? []));
  };

  const selectDestination = (value: string) => {
    const nextDestination = value || null;
    setDestinationId(nextDestination);
    if (!courseWasChosen) setCourseId(folderCourseId(nextDestination, folders));
    setPickerError("");
  };

  const updatePlan = (id: string, patch: Partial<PendingFolderUpload>) => {
    onFolderUploadChange?.((current) => current?.id === id ? { ...current, ...patch } : current);
  };

  const downloadFolderPlan = () => {
    if (!folderUpload) return;
    downloadDraft("eduessentials-folder-upload-draft.json", {
      version: 1,
      planId: folderUpload.id,
      profileId: folderUpload.profileId,
      sessionGeneration: folderUpload.sessionGeneration,
      folderId: folderUpload.folderId,
      courseId: folderUpload.courseId,
      files: folderUpload.files.map(({ file, relativePath, targetPath }) => ({
        name: file.name,
        size: file.size,
        type: file.type,
        lastModified: file.lastModified,
        relativePath,
        targetPath,
      })),
      directories: folderUpload.directories.map(({ id, path, name, parentPath, created }) => ({ id, path, name, parentPath, created })),
      status: folderUpload.status,
      error: folderUpload.error,
    });
  };

  const dismissFolderUpload = () => {
    if (!folderUpload || planBusy) return;
    if (folderHasCreated && !window.confirm("Remove this folder selection? Folders already created in Files will stay in place.")) return;
    onFolderUploadChange?.(null);
  };

  const runFolderUpload = async () => {
    if (!folderUpload || planBusy || !onFolderUploadChange) return;
    const current = currentStateRef.current;
    if (!current.canWrite || current.currentProfileId !== folderUpload.profileId) return;
    const attempt: PendingFolderUpload = {
      ...folderUpload,
      sessionGeneration: current.currentSessionGeneration,
      status: "creating",
      error: "",
    };
    onFolderUploadChange(attempt);
    const controller = new AbortController();
    activeFolderUploadRef.current?.abort();
    activeFolderUploadRef.current = controller;
    const isCurrent = (profileId: string, sessionGeneration: number) => {
      const latest = currentStateRef.current;
      return !controller.signal.aborted && latest.canWrite && latest.currentProfileId === profileId && latest.currentSessionGeneration === sessionGeneration;
    };
    try {
      const folderIds = await ensureFolderUploadHierarchy(attempt.profileId, attempt, {
        signal: controller.signal,
        isCurrent,
        onCreated: (directory) => {
          onFolderUploadChange((previous) => previous?.id === attempt.id
            ? { ...previous, directories: previous.directories.map((candidate) => candidate.path === directory.path ? { ...candidate, created: true } : candidate) }
            : previous);
        },
      });
      if (!isCurrent(attempt.profileId, attempt.sessionGeneration)) throw new DOMException("The account session changed before the folder upload could continue.", "AbortError");
      const byDestination = new Map<string | null, File[]>();
      for (const entry of attempt.files) {
        let targetFolderId: string | null;
        if (entry.targetPath === null) targetFolderId = attempt.folderId;
        else {
          const resolvedFolderId = folderIds.get(entry.targetPath);
          if (!resolvedFolderId) throw new Error(`The folder ${entry.targetPath} could not be confirmed. Retry folder setup before uploading files.`);
          targetFolderId = resolvedFolderId;
        }
        const group = byDestination.get(targetFolderId) ?? [];
        group.push(entry.file);
        byDestination.set(targetFolderId, group);
      }
      for (const [folderId, files] of byDestination) queue.enqueue(files, { folderId, courseId: attempt.courseId ?? "" });
      onFolderUploadChange((previous) => previous?.id === attempt.id ? null : previous);
    } catch (error) {
      const latest = currentStateRef.current;
      const sessionPaused = latest.currentProfileId !== attempt.profileId || latest.currentSessionGeneration !== attempt.sessionGeneration || error instanceof Error && error.name === "AbortError";
      updatePlan(attempt.id, {
        status: "error",
        error: sessionPaused
          ? "Folder setup paused after the account session changed. Return to the original account and retry; created folder IDs and selected files are kept."
          : error instanceof Error && error.message ? error.message : "The folder structure could not be created. Retry to continue with this selection.",
      });
    } finally {
      if (activeFolderUploadRef.current === controller) activeFolderUploadRef.current = null;
    }
  };

  return <div className="files-upload-backdrop files-action-sheet-backdrop">
    <section className={`files-upload-dialog files-action-sheet${uploadMode === "folder" ? " is-folder-upload" : ""}`} ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="files-upload-title" tabIndex={-1}>
      <header className="files-upload-header">
        <div><h2 id="files-upload-title">{uploadMode === "folder" ? "Upload folder" : "Upload files"}</h2><p>Add files to your library.</p></div>
        <button ref={closeButtonRef} type="button" className="files-upload-close" onClick={onClose} aria-label="Close upload panel"><X size={22} /></button>
      </header>

      <div className="files-upload-body">
        <div
          className={`files-upload-dropzone${canWrite ? "" : " is-disabled"}`}
          onDragOver={(event) => { event.preventDefault(); }}
          onDrop={handleUploadDrop}
          aria-label={uploadMode === "folder" ? "Folder upload dropzone" : "File upload dropzone"}
        >
          <Upload size={54} strokeWidth={1.8} aria-hidden="true" />
          <strong>{uploadMode === "folder" ? "Choose a folder to upload" : "Drop files here"}</strong>
          <span className="files-upload-drop-divider">or</span>
          <button ref={chooseButtonRef} type="button" className="files-upload-choose" disabled={!canWrite || Boolean(folderUpload && (planBusy || folderHasCreated))} onClick={() => inputRef.current?.click()}>
            {uploadMode === "folder" ? "Choose folder" : "Choose files"}
          </button>
          <small>{uploadMode === "folder" ? "Folder structure stays intact · up to 25 MiB per file" : "Multiple files · up to 25 MiB each"}</small>
          <input
            ref={inputRef}
            type="file"
            multiple={uploadMode === "files"}
            disabled={!canWrite || Boolean(folderUpload && (planBusy || folderHasCreated))}
            onChange={handleFiles}
            aria-hidden="true"
            tabIndex={-1}
          />
        </div>
        {!canWrite && <p className="files-upload-gate" role="status">Uploads are paused. Return to the account that selected these files, then retry.</p>}

        <section className="files-upload-destination" aria-label="Upload destination">
          <span className="files-upload-control-label">Destination</span>
          <div className="files-upload-destination-card">
            <Folder size={19} aria-hidden="true" />
            <span><strong>{destinationLabel}</strong>{(destinationId || browserData.loading || browserData.error) && <small>{browserData.loading ? "Loading active folders…" : browserData.error ? "Folder list unavailable" : "Active folder"}</small>}</span>
            <button type="button" disabled={!canWrite || planBusy || Boolean(folderUpload)} onClick={() => setShowDestinationPicker((visible) => !visible)}>{showDestinationPicker ? "Done" : "Change"}</button>
          </div>
          {showDestinationPicker && <label className="files-upload-select-wrap"><span>Choose a destination folder</span>
            <select aria-label="Destination folder" value={destinationId ?? ""} disabled={!canWrite || browserData.loading || Boolean(browserData.error) || Boolean(folderUpload)} onChange={(event) => selectDestination(event.currentTarget.value)}>
              <option value="">Files</option>
              {folders.slice().sort((left, right) => folderLabel(left.id, folders).localeCompare(folderLabel(right.id, folders))).map((folder) => <option key={folder.id} value={folder.id}>{"　".repeat(Math.min(8, folderDepth(folder, folders) - 1))}{folderLabel(folder.id, folders)}</option>)}
            </select>
          </label>}
          {browserData.error && destinationId !== null && <p className="files-upload-error" role="alert">{browserData.error} Retry from Files to refresh available destinations.</p>}
          {!destinationValid && <p className="files-upload-error" role="alert">This destination is no longer active. Choose My files or another active folder.</p>}
        </section>

        <section className="files-upload-course" aria-label="Optional course link">
          <label className="files-upload-select-wrap"><span>Course link (optional)</span>
            <span className="files-upload-course-card"><Link2 size={19} aria-hidden="true" />
              <select aria-label="Course link" value={courseId} disabled={!canWrite || Boolean(folderUpload)} onChange={(event) => { setCourseWasChosen(true); setCourseId(event.currentTarget.value); setPickerError(""); }}>
                <option value="">Add after upload</option>
                {courseId && !courseValid && <option value={courseId} disabled>Course unavailable</option>}
                {courses.map((course) => <option key={course.id} value={course.id}>{course.code || course.name}</option>)}
              </select>
              <span aria-hidden="true">›</span>
            </span>
          </label>
        </section>

        {(pickerError || folderSelectionError) && <p className="files-upload-error" role="alert">{folderSelectionError || pickerError}</p>}

        {folderUpload && <section className={`files-folder-upload-plan is-${folderUpload.status}`} aria-live="polite">
          <div className="files-folder-upload-heading"><FolderOpen size={18} aria-hidden="true" /><div><strong>{folderUpload.files[0]?.relativePath.split("/")[0] || "Selected folder"}</strong><small>{folderUpload.files.length} {folderUpload.files.length === 1 ? "file" : "files"} · {folderUpload.directories.filter((directory) => directory.created).length} / {folderUpload.directories.length} folders ready</small></div></div>
          {folderUpload.status === "creating" && <p role="status">Preparing the folder structure…</p>}
          {folderUpload.error && <p className="files-upload-error" role="alert">{folderUpload.error}</p>}
          <div className="files-folder-upload-actions">
            <button type="button" className="files-upload-choose" disabled={!canWrite || currentProfileId !== folderUpload.profileId || planBusy} onClick={() => void runFolderUpload()}>
              {folderUpload.status === "error" ? "Retry folder setup" : folderUpload.directories.some((directory) => directory.created) ? "Continue folder upload" : "Upload folder"}
            </button>
            {!planBusy && <button type="button" className="files-upload-dismiss" onClick={dismissFolderUpload}>Dismiss selection</button>}
          </div>
          <div className="files-folder-upload-recovery">
            <button type="button" className="files-upload-secondary" disabled={planBusy} onClick={downloadFolderPlan}>Download folder plan</button>
            <button type="button" className="files-upload-secondary" disabled={planBusy} onClick={() => folderUpload.files.forEach(downloadFolderOriginal)}>Download selected files individually</button>
          </div>
          <small className="files-folder-upload-disclaimer">Individual downloads do not include the folder structure. The plan keeps each original path. Dismissing this selection leaves created folders in Files.</small>
          {currentProfileId !== folderUpload.profileId && <p className="files-upload-gate" role="status">This folder belongs to the account that selected it.</p>}
        </section>}

        {!queue.rows.length && !folderUpload && <p className="files-upload-empty">No files selected yet.</p>}
        <div className="files-upload-list" aria-live="polite">
          {queue.rows.map((row) => {
            const inProgress = row.status === "uploading" || row.status === "refreshing";
            const retryableState = row.status === "error" || row.status === "refresh-error";
            const onOriginalAccount = row.profileId === currentProfileId;
            const progressValue = row.status === "complete" ? 100 : Math.min(99, Math.round(row.progress * 100));
            const displayName = relativeFileName(row.file);
            return <article className={`files-upload-row is-${row.status}`} key={row.id} data-upload-id={row.id}>
              <div className="files-upload-row-main">
                <div className="files-upload-file-heading"><strong title={displayName}>{displayName}</strong><span>{fileSize(row.file.size)}</span></div>
                <p className="files-upload-status" role="status">{statusLabel(row, currentProfileId)}</p>
                {row.error && <p className="files-upload-error">{row.error}</p>}
                {(inProgress || row.status === "error" || row.status === "refresh-error") && <progress aria-label={`${displayName} upload progress`} max={100} value={progressValue}>{progressValue}%</progress>}
              </div>
              <div className="files-upload-actions">
                {retryableState && <button type="button" className="files-upload-secondary" disabled={!canWrite || !onOriginalAccount || !row.retryable} title={!onOriginalAccount ? "Return to the account that selected this file." : !canWrite ? "Uploads are temporarily unavailable." : undefined} onClick={() => { void queue.retry(row.id).catch(() => {}); }}>Retry upload</button>}
                <button type="button" className="files-upload-secondary" onClick={() => downloadOriginal(row)}>Download original</button>
                <button type="button" className="files-upload-secondary" onClick={() => downloadRequest(row)}>Download request draft</button>
                <button type="button" className="files-upload-dismiss" disabled={inProgress} onClick={() => queue.dismiss(row.id)} aria-label={`Dismiss upload ${displayName}`}>Dismiss</button>
              </div>
            </article>;
          })}
        </div>
      </div>

      <footer className="files-upload-footer">
        <span><ShieldCheck size={16} aria-hidden="true" /> Your files stay private.</span>
        {(queue.rows.length > 0 || folderUpload) && <button type="button" className="files-upload-close-action" onClick={onClose}>Close</button>}
      </footer>
    </section>
  </div>;
}

export default FileUploadDialog;
