"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { Download, Folder, FolderOpen, X } from "lucide-react";
import type { FileFolder } from "../lib/file-organization";
import type { BrowserItem } from "../lib/files-browser";
import { safeFileItemName } from "../lib/file-organization";
import {
  BrowserOrganizationFailure,
  createCustomFolder,
  folderDestinationReason,
  moveBrowserItems,
  moveDestinationReason,
  renameBrowserItem,
} from "../lib/files-browser-operations";
import { downloadDraft, useSaveProtection } from "./use-save-protection";
import "./file-organization-dialogs.css";

export type OrganizationDialogRequest =
  | { kind: "create"; profileId: string; id: string; parentId: string | null; parentLabel: string; folders: FileFolder[] }
  | { kind: "rename"; profileId: string; item: BrowserItem; folders: FileFolder[] }
  | { kind: "move"; profileId: string; items: BrowserItem[]; folders: FileFolder[] };

export type OrganizationDialogReport = { busy: boolean; dirty: boolean; draft: unknown };

type Props = {
  request: OrganizationDialogRequest;
  currentProfileId: string;
  canWrite: boolean;
  onClose: () => void;
  onReselect: () => void;
  onSaved: (profileId: string, signal: AbortSignal) => Promise<void>;
  onFileEdited?: (file: import("../lib/files").PrivateFile) => void;
  onRefresh: (profileId: string) => Promise<void>;
  onStateChange: (report: OrganizationDialogReport | null) => void;
};

function itemName(item: BrowserItem) {
  return item.type === "file" ? item.file.name : item.folder.name;
}

function itemLocation(item: BrowserItem, folders: readonly FileFolder[]) {
  let parentId = item.type === "file" ? item.file.folder_id : item.folder.parent_id;
  const segments: string[] = [];
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const visited = new Set<string>();
  while (parentId && !visited.has(parentId)) {
    visited.add(parentId);
    const folder = byId.get(parentId);
    if (!folder) break;
    segments.unshift(folder.name);
    parentId = folder.parent_id;
  }
  return segments.length ? `My files / ${segments.join(" / ")}` : "My files";
}

function folderPath(folderId: string | null, folders: readonly FileFolder[]) {
  const byId = new Map(folders.map((folder) => [folder.id, folder]));
  const path: FileFolder[] = [];
  const visited = new Set<string>();
  let currentId = folderId;
  while (currentId && !visited.has(currentId)) {
    visited.add(currentId);
    const folder = byId.get(currentId);
    if (!folder) break;
    path.unshift(folder);
    currentId = folder.parent_id;
  }
  return path;
}

function isActiveFolder(folder: FileFolder, folders: readonly FileFolder[]) {
  return folderDestinationReason(folder.id, folders) === "";
}

function failureMessage(error: unknown) {
  return error instanceof Error && error.message ? error.message : "The Files change could not be saved. Please retry.";
}

function displayDate(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(date);
}

export default function FileOrganizationDialog({
  request,
  currentProfileId,
  canWrite,
  onClose,
  onReselect,
  onSaved,
  onFileEdited,
  onRefresh,
  onStateChange,
}: Props) {
  const dialogRef = useRef<HTMLElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const abortRef = useRef<AbortController | null>(null);
  const [name, setName] = useState(request.kind === "rename" ? itemName(request.item) : "");
  const [browseId, setBrowseId] = useState<string | null>(null);
  const [destinationId, setDestinationId] = useState<string | null | undefined>(undefined);
  const [createAttempt, setCreateAttempt] = useState<{ id: string; name: string; parentId: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [showReselect, setShowReselect] = useState(false);
  const profileChanged = currentProfileId !== request.profileId;
  const initialName = request.kind === "rename" ? itemName(request.item) : "";
  const dirty = request.kind === "create"
    ? Boolean(name.trim() || error || createAttempt)
    : request.kind === "rename"
      ? name !== initialName || Boolean(error)
      : destinationId !== undefined || Boolean(error);
  const snapshotDraft = useMemo(() => ({
    capturedProfileId: request.profileId,
    action: request.kind,
    ...(request.kind === "create" ? { id: createAttempt?.id ?? request.id, name: createAttempt?.name ?? name, parentId: createAttempt?.parentId ?? request.parentId } : {}),
    ...(request.kind === "rename" ? {
      item: request.item.type === "file"
        ? { type: "file", id: request.item.id, name, revision: request.item.file.metadata_revision, folderId: request.item.file.folder_id }
        : { type: "folder", id: request.item.id, name, revision: request.item.folder.revision, parentId: request.item.folder.parent_id },
    } : {}),
    ...(request.kind === "move" ? {
      items: request.items.map((item) => item.type === "file"
        ? { type: item.type, id: item.id, revision: item.file.metadata_revision, name: item.file.name, folderId: item.file.folder_id }
        : { type: item.type, id: item.id, revision: item.folder.revision, name: item.folder.name, parentId: item.folder.parent_id }),
      destinationId: destinationId === undefined ? "not-selected" : destinationId,
    } : {}),
  }), [createAttempt, destinationId, name, request]);
  useSaveProtection(dirty || busy);

  useEffect(() => {
    const report: OrganizationDialogReport = { busy, dirty, draft: snapshotDraft };
    onStateChange(report);
  }, [busy, dirty, onStateChange, snapshotDraft]);

  useEffect(() => () => onStateChange(null), [onStateChange]);

  useLayoutEffect(() => {
    window.requestAnimationFrame(() => {
      if (dialogRef.current?.closest("[hidden]")) return;
      if (request.kind === "move") dialogRef.current?.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled)")?.focus({ preventScroll: true });
      else nameInputRef.current?.focus({ preventScroll: true });
    });
  }, [request]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const ancestors: HTMLElement[] = [];
    let ancestor = dialog.parentElement;
    while (ancestor) { ancestors.push(ancestor); ancestor = ancestor.parentElement; }
    const focusWhenVisible = () => {
      if (dialog.closest("[hidden]")) return;
      const target = request.kind === "move"
        ? dialog.querySelector<HTMLElement>("button:not(:disabled), input:not(:disabled)")
        : nameInputRef.current;
      target?.focus({ preventScroll: true });
    };
    const observer = new MutationObserver(focusWhenVisible);
    for (const element of ancestors) observer.observe(element, { attributes: true, attributeFilter: ["hidden"] });
    return () => observer.disconnect();
  }, [request]);

  useEffect(() => {
    if (!profileChanged) return;
    abortRef.current?.abort(new DOMException("The active account changed.", "AbortError"));
  }, [profileChanged]);

  useEffect(() => {
    if (!busy) return;
    const controller = abortRef.current;
    return () => controller?.abort();
  }, [busy]);

  const close = useCallback((force = false) => {
    if (busy) return;
    if (!force && dirty && !window.confirm("Discard this Files change? Download a draft first if you want to keep it.")) return;
    onClose();
  }, [busy, dirty, onClose]);

  useEffect(() => {
    const handleKey = (event: globalThis.KeyboardEvent) => {
      if (!dialogRef.current || dialogRef.current.closest("[hidden]")) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>(
        "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex='-1'])",
      )].filter((element) => {
        if (element.closest("[hidden], [inert], [aria-hidden='true']")) return false;
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      });
      if (!focusable.length) return;
      const first = focusable[0], last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    document.addEventListener("keydown", handleKey, true);
    return () => document.removeEventListener("keydown", handleKey, true);
    // The close function intentionally reads the latest form state.
  }, [close]);

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy || !canWrite || profileChanged) return;
    const controller = new AbortController();
    abortRef.current?.abort();
    abortRef.current = controller;
    setBusy(true);
    setError("");
    setConflict(false);
    setShowReselect(false);
    let editedFile: import("../lib/files").PrivateFile | undefined;
    try {
      if (request.kind === "create") {
        let attempt = createAttempt;
        if (!attempt) {
          const safeName = safeFileItemName(name);
          attempt = { id: request.id, name: safeName, parentId: request.parentId };
          setCreateAttempt(attempt);
        }
        const parentReason = folderDestinationReason(request.parentId, request.folders);
        if (parentReason) throw new BrowserOrganizationFailure(parentReason, "conflict");
        await createCustomFolder(request.profileId, attempt, { signal: controller.signal });
      } else if (request.kind === "rename") {
        const renamed = await renameBrowserItem(request.profileId, request.item, name, { signal: controller.signal });
        if (renamed.type === "file") editedFile = renamed.file;
      } else {
        if (destinationId === undefined) throw new BrowserOrganizationFailure("Choose a destination folder.");
        const reason = moveDestinationReason(request.items, destinationId, request.folders);
        if (reason) throw new BrowserOrganizationFailure(reason, "conflict");
        await moveBrowserItems(request.profileId, request.items, destinationId, { signal: controller.signal, folders: request.folders });
      }
      if (controller.signal.aborted || currentProfileId !== request.profileId) return;
      try { await onSaved(request.profileId, controller.signal); }
      finally {
        // Dispatch activity after the organization refresh settles so its own
        // metadata refresh cannot interrupt the saved-name acknowledgement.
        if (editedFile && !controller.signal.aborted && currentProfileId === request.profileId) onFileEdited?.(editedFile);
      }
      if (!controller.signal.aborted && currentProfileId === request.profileId) onClose();
    } catch (cause) {
      if (controller.signal.aborted) return;
      const failure = cause instanceof BrowserOrganizationFailure ? cause : null;
      setError(failureMessage(cause));
      setConflict(failure?.kind === "conflict");
      setShowReselect(request.kind === "move" && failure?.kind === "conflict");
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setBusy(false);
    }
  };

  const movePath = request.kind === "move" ? folderPath(browseId, request.folders) : [];
  const children = request.kind === "move" ? request.folders.filter((folder) => folder.parent_id === browseId) : [];
  const chosenReason = request.kind === "move" && destinationId !== undefined
    ? moveDestinationReason(request.items, destinationId, request.folders)
    : "";
  const moveAllowed = request.kind === "move" && destinationId !== undefined && !chosenReason;
  const title = request.kind === "create"
    ? "Create folder"
    : request.kind === "move"
      ? "Move to…"
      : `Rename ${request.item.type}`;

  return <div className="files-dialog-backdrop file-organization-backdrop files-action-sheet-backdrop" role="presentation" onMouseDown={(event) => {
    if (event.target === event.currentTarget && !busy) close();
  }}>
    <section ref={dialogRef} className="files-details-dialog file-organization-dialog files-action-sheet" role="dialog" aria-modal="true" aria-labelledby="file-organization-title" aria-describedby="file-organization-description">
      <div className="files-details-heading">
        <div><p>Files</p><h2 id="file-organization-title">{title}</h2></div>
        <button type="button" className="files-icon-button" aria-label="Close Files dialog" disabled={busy} onClick={() => close()}><X size={18} /></button>
      </div>
      <p id="file-organization-description" className="file-organization-intro">
        {request.kind === "create" ? `Create a folder in ${request.parentLabel}. Folder names can repeat.`
          : request.kind === "rename" ? `Rename ${request.item.type === "folder" && request.item.folder.kind === "course" ? "managed course folders by changing the course" : `this ${request.item.type}`}. Its location and associations stay the same.`
            : `Choose a destination for ${request.items.length} selected ${request.items.length === 1 ? "item" : "items"}. Course and assignment links stay with each file.`}
      </p>

      {request.kind === "move" ? (
        <form onSubmit={(event) => void save(event)}>
          {profileChanged && <p className="file-organization-error" role="alert">The active account changed. This draft is saved for the previous account.</p>}
          <nav className="file-organization-breadcrumbs" aria-label="Move destination folders">
            <button type="button" onClick={() => setBrowseId(null)}>My files</button>
            {movePath.map((folder) => <span key={folder.id}><span aria-hidden="true">›</span><button type="button" onClick={() => setBrowseId(folder.id)}>{folder.name}</button></span>)}
          </nav>
          <div className="file-organization-destination-list" role="list" aria-label="Folders in this location">
            <div className={`file-organization-destination ${destinationId === null ? "is-selected" : ""}`} role="listitem">
              <span className="file-organization-destination-icon"><FolderOpen size={17} /></span>
              <span className="file-organization-destination-copy"><strong>My files</strong><small>Root folder</small></span>
              <button type="button" className="files-secondary-button" disabled={!canWrite || profileChanged} onClick={() => setDestinationId(null)}>Move here</button>
            </div>
            {children.map((folder) => {
              const destinationReason = moveDestinationReason(request.items, folder.id, request.folders);
              const activeReason = folderDestinationReason(folder.id, request.folders);
              const browseAllowed = isActiveFolder(folder, request.folders);
              const pathLabel = [...movePath.map((part) => part.name), folder.name].join(" / ");
              return <div className={`file-organization-destination ${destinationId === folder.id ? "is-selected" : ""} ${destinationReason ? "is-disabled" : ""}`} role="listitem" key={folder.id}>
                <span className="file-organization-destination-icon"><Folder size={17} /></span>
                <span className="file-organization-destination-copy"><strong>{folder.name}</strong><small title={`My files / ${pathLabel}`}>My files / {pathLabel} · {folder.kind === "course" ? "Course folder" : "Folder"} · Created {displayDate(folder.created_at)}</small>{destinationReason && <em>{destinationReason}</em>}{!destinationReason && activeReason && <em>{activeReason}</em>}</span>
                <button type="button" className="file-organization-open-folder" aria-label={`Open folder: ${folder.name}`} disabled={!browseAllowed || profileChanged} onClick={() => setBrowseId(folder.id)}>Open</button>
                <button type="button" className="files-secondary-button" disabled={Boolean(destinationReason) || !canWrite || profileChanged} title={destinationReason || undefined} onClick={() => setDestinationId(folder.id)}>Move here</button>
              </div>;
            })}
            {children.length === 0 && <p className="file-organization-empty">No folders in this location.</p>}
          </div>
          {destinationId !== undefined && chosenReason && <p className="file-organization-error" role="alert">{chosenReason}</p>}
          <p className="file-organization-selection-note">{request.items.length} {request.items.length === 1 ? "item" : "items"} selected. Items inside selected folders stay together.</p>
          {error && <p className="file-organization-error" role="alert">{error}{showReselect ? " Refresh Files, then close and reselect the items to use their latest saved revisions." : ""}</p>}
          <OrganizationActions
            busy={busy}
            dirty={dirty}
            saveLabel="Move items"
            saveDisabled={!canWrite || profileChanged || !moveAllowed}
            onClose={() => close()}
            onDownload={() => downloadDraft("eduessentials-file-move-draft.json", snapshotDraft)}
            onRefresh={() => void onRefresh(request.profileId)}
          />
          {showReselect && <button type="button" className="file-organization-reselect" onClick={() => { onClose(); onReselect(); }}>Close and reselect items</button>}
        </form>
      ) : (
        <form onSubmit={(event) => void save(event)}>
          {profileChanged && <p className="file-organization-error" role="alert">The active account changed. This draft is saved for the previous account.</p>}
          {request.kind === "rename" && request.item.type === "folder" && request.item.folder.kind === "course" && <p className="file-organization-note">Managed course folder names follow your course list and can’t be changed here.</p>}
          {request.kind === "create" && <p className="file-organization-note">Location: <strong>{request.parentLabel}</strong></p>}
          {request.kind === "rename" && <p className="file-organization-note">Location: <strong>{itemLocation(request.item, request.folders)}</strong></p>}
          <label className="file-organization-field">
            <span>{request.kind === "create" ? "Folder name" : "Name"}</span>
            <input ref={nameInputRef} autoComplete="off" maxLength={255} value={name} onChange={(event) => setName(event.target.value)} disabled={busy || profileChanged || (request.kind === "create" && Boolean(createAttempt)) || (request.kind === "rename" && request.item.type === "folder" && request.item.folder.kind === "course")} required aria-label={request.kind === "create" ? "Folder name" : "Name"} />
          </label>
          {error && <p className="file-organization-error" role="alert">{error}{request.kind === "create" ? createAttempt ? " This same folder creation attempt is kept for retry." : " Correct the name and try again." : conflict ? " Your entered name is kept. Download the draft, refresh Files, then close and reopen Rename to use the latest item." : " Your entered name is still here. You can retry this saved attempt."}</p>}
          <OrganizationActions
            busy={busy}
            dirty={dirty}
            saveLabel={request.kind === "create" ? "Create folder" : "Rename"}
            saveDisabled={!canWrite || profileChanged || (request.kind === "rename" && request.item.type === "folder" && request.item.folder.kind === "course") || !name.trim() || (request.kind === "rename" && name === initialName)}
            onClose={() => close()}
            onDownload={() => downloadDraft(request.kind === "create" ? "eduessentials-folder-create-draft.json" : "eduessentials-item-rename-draft.json", snapshotDraft)}
            onRefresh={() => void onRefresh(request.profileId)}
          />
        </form>
      )}
      {busy && <p className="file-organization-pending" role="status" aria-live="polite">Saving this Files change… The dialog will stay open until the request finishes.</p>}
    </section>
  </div>;
}

function OrganizationActions({
  busy,
  dirty,
  saveLabel,
  saveDisabled,
  onClose,
  onDownload,
  onRefresh,
}: {
  busy: boolean;
  dirty: boolean;
  saveLabel: string;
  saveDisabled: boolean;
  onClose: () => void;
  onDownload: () => void;
  onRefresh: () => void;
}) {
  return <div className="file-organization-actions">
    <button type="button" className="files-secondary-button" disabled={busy} onClick={onDownload}><Download size={15} /> Download draft</button>
    <button type="button" className="files-secondary-button" disabled={busy} onClick={onRefresh}>Refresh Files</button>
    <button type="button" className="files-secondary-button" disabled={busy} onClick={onClose}>{dirty ? "Discard draft…" : "Cancel"}</button>
    <button type="submit" className="files-new-button" disabled={busy || saveDisabled}>{busy ? "Saving…" : saveLabel}</button>
  </div>;
}
