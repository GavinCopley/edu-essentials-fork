"use client";

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { AlertTriangle, Download, FileText, RefreshCw, Save, X } from "lucide-react";
import type { PrivateFile } from "../lib/files";
import { safeFileItemName, validateDocumentBody } from "../lib/file-organization";
import { DocumentAutosave } from "../lib/document-autosave";
import {
  createNativeDocument,
  DocumentSaveFailure,
  downloadTextDraft,
  readNativeDocument,
  saveNativeDocument,
  type DocumentDraft,
  type NativeDocumentCreate,
  type NativeDocumentResult,
} from "../lib/native-documents";
import { useSaveProtection } from "./use-save-protection";
import "./native-document-editor.css";

export type NativeDocumentDraftReport = {
  fileId: string | null;
  name: string;
  body: string;
  dirty: boolean;
};

type NativeDocumentEditorProps = {
  profileId: string;
  file?: PrivateFile;
  create?: NativeDocumentCreate;
  canWrite: boolean;
  onSaved: (file: PrivateFile) => void;
  onClose: () => void;
  onDraftChange?: (draft: NativeDocumentDraftReport | null) => void;
};

type EditorPhase = "loading" | "creating" | "ready" | "load-failed" | "create-failed" | "loading-latest" | "copying" | "copy-failed" | "account-changed";
type AutosaveSnapshot = ReturnType<DocumentAutosave["getSnapshot"]>;

function initialDraft(file?: PrivateFile, create?: NativeDocumentCreate): DocumentDraft {
  return { name: create?.name ?? file?.name ?? "Untitled.txt", body: create?.body ?? "" };
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

export function NativeDocumentEditor({ profileId, file, create, canWrite, onSaved, onClose, onDraftChange }: NativeDocumentEditorProps) {
  // These values define this editor session. Parent refreshes may replace the file object;
  // reads and writes still stay tied to the account and ID that opened the dialog.
  const [identity] = useState(() => ({
    profileId,
    file: file ? { ...file } : undefined,
    create: create ? { ...create } : undefined,
  }));
  const capturedId = identity.file?.id ?? identity.create?.id ?? null;
  const [phase, setPhaseState] = useState<EditorPhase>(identity.file ? "loading" : "creating");
  const [snapshot, setSnapshot] = useState<AutosaveSnapshot | null>(null);
  const [draft, setDraftState] = useState<DocumentDraft>(() => initialDraft(identity.file, identity.create));
  const [savedDraft, setSavedDraft] = useState<DocumentDraft | null>(null);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);
  const [copyAttempt, setCopyAttempt] = useState<NativeDocumentCreate | null>(null);
  const dialogRef = useRef<HTMLElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);
  const focusedEditorRef = useRef(false);
  const autosaveRef = useRef<DocumentAutosave | null>(null);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const copyAbortRef = useRef<AbortController | null>(null);
  const initialAbortRef = useRef<AbortController | null>(null);
  const accountChangeDirtyRef = useRef(false);
  const phaseRef = useRef<EditorPhase>(identity.file ? "loading" : "creating");
  const snapshotRef = useRef<AutosaveSnapshot | null>(null);
  const draftRef = useRef<DocumentDraft>(initialDraft(identity.file, identity.create));
  const activeFileIdRef = useRef<string | null>(capturedId);
  const copyAttemptRef = useRef<NativeDocumentCreate | null>(null);
  const copyInFlightRef = useRef(false);
  const mountedRef = useRef(true);
  const latestCanWriteRef = useRef(canWrite && profileId === identity.profileId);
  const accountChangedRef = useRef(profileId !== identity.profileId);
  const onSavedRef = useRef(onSaved);
  const onCloseRef = useRef(onClose);
  const onDraftChangeRef = useRef(onDraftChange);
  const lastNotifiedRevisionRef = useRef("");

  useLayoutEffect(() => {
    onSavedRef.current = onSaved;
    onCloseRef.current = onClose;
    onDraftChangeRef.current = onDraftChange;
    latestCanWriteRef.current = canWrite && profileId === identity.profileId;
    accountChangedRef.current = profileId !== identity.profileId;
    if (accountChangedRef.current) {
      accountChangeDirtyRef.current ||= Boolean(snapshotRef.current?.dirty || phaseRef.current === "creating" || phaseRef.current === "copying");
      phaseRef.current = "account-changed";
    }
  }, [canWrite, identity.profileId, onClose, onDraftChange, onSaved, profileId]);

  const setPhase = useCallback((next: EditorPhase) => {
    phaseRef.current = next;
    setPhaseState(next);
  }, []);

  const reportDraft = useCallback((nextSnapshot?: AutosaveSnapshot | null) => {
    const currentSnapshot = nextSnapshot === undefined ? snapshotRef.current : nextSnapshot;
    const currentPhase = phaseRef.current;
    const saving = currentSnapshot?.status === "saving";
    const uncertainFailure = currentPhase === "create-failed" || currentPhase === "copy-failed" ||
      currentSnapshot?.status === "save-error" || currentSnapshot?.status === "conflict" || currentSnapshot?.status === "session-error";
    const dirty = Boolean(currentSnapshot?.dirty || saving || uncertainFailure || currentPhase === "creating" || currentPhase === "copying" || (accountChangedRef.current && accountChangeDirtyRef.current));
    onDraftChangeRef.current?.({
      fileId: activeFileIdRef.current,
      name: draftRef.current.name,
      body: draftRef.current.body,
      dirty,
    });
  }, []);

  const setPhaseAndReport = useCallback((next: EditorPhase) => {
    setPhase(next);
    reportDraft();
  }, [reportDraft, setPhase]);

  const notifySaved = useCallback((result: NativeDocumentResult) => {
    const revisionKey = `${result.file.id}:${result.file.content_revision}:${result.file.metadata_revision}:${result.file.updated_at}`;
    if (lastNotifiedRevisionRef.current === revisionKey) return;
    lastNotifiedRevisionRef.current = revisionKey;
    onSavedRef.current(result.file);
  }, []);

  const installResult = useCallback((result: NativeDocumentResult, preserveLocal = false) => {
    if (!mountedRef.current || accountChangedRef.current) return;
    const nextDraft = preserveLocal ? draftRef.current : { name: result.file.name, body: result.document.body };
    const autosave = autosaveRef.current;
    if (!autosave) {
      const writer = async (snapshot: DocumentDraft, targetFile: PrivateFile, requestId: string) => {
        if (!latestCanWriteRef.current || accountChangedRef.current) {
          throw new DocumentSaveFailure("This workspace is read-only. Download the draft or restore write access before saving.", "session-error");
        }
        safeFileItemName(snapshot.name);
        validateDocumentBody(snapshot.body);
        return saveNativeDocument(identity.profileId, targetFile, snapshot, requestId);
      };
      const created = new DocumentAutosave(writer, 750);
      const unsubscribe = created.subscribe(() => {
        if (!mountedRef.current) return;
        const nextSnapshot = created.getSnapshot();
        snapshotRef.current = nextSnapshot;
        setSnapshot(nextSnapshot);
        // The autosave controller owns the canonical latest draft, including a
        // server-side rename adopted while a newer body is still queued.
        const canonicalDraft = { ...nextSnapshot.draft };
        draftRef.current = canonicalDraft;
        setDraftState(canonicalDraft);
        if (!accountChangedRef.current && nextSnapshot.savedDraft) setSavedDraft({ ...nextSnapshot.savedDraft });
        if (!accountChangedRef.current && nextSnapshot.file) notifySaved({ file: nextSnapshot.file, document: { file_id: nextSnapshot.file.id, body: nextSnapshot.draft.body, content_revision: nextSnapshot.file.content_revision } });
        reportDraft(nextSnapshot);
      });
      autosaveRef.current = created;
      unsubscribeRef.current = unsubscribe;
    }

    activeFileIdRef.current = result.file.id;
    draftRef.current = nextDraft;
    setDraftState(nextDraft);
    setSavedDraft({ name: result.file.name, body: result.document.body });
    const controller = autosaveRef.current!;
    controller.hydrate(result);
    if (preserveLocal) {
      if (nextDraft.name !== result.file.name || nextDraft.body !== result.document.body) controller.change(nextDraft);
      // hydrate() publishes the copied base and its listener can briefly restore that
      // base into React state. Reapply the latest conflicted draft after the fence.
      draftRef.current = nextDraft;
      setDraftState(nextDraft);
    }
    setSnapshot(controller.getSnapshot());
    snapshotRef.current = controller.getSnapshot();
    setPhase("ready");
    setError("");
    notifySaved(result);
    reportDraft(controller.getSnapshot());
  }, [identity.profileId, notifySaved, reportDraft, setPhase]);

  useEffect(() => {
    mountedRef.current = true;
    const abortController = new AbortController();
    initialAbortRef.current = abortController;
    let current = true;

    const load = async () => {
      if (accountChangedRef.current) {
        setPhaseAndReport("account-changed");
        setError("The signed-in account changed. Close this editor and reopen the document from Files.");
        return;
      }
      if (identity.file) {
        setPhaseAndReport("loading");
        try {
          const result = await readNativeDocument(identity.profileId, identity.file.id, { signal: abortController.signal });
          if (!current || !mountedRef.current || accountChangedRef.current) return;
          installResult(result);
        } catch (loadError) {
          if (!current || abortController.signal.aborted || accountChangedRef.current) return;
          setError(errorMessage(loadError, "Unable to load this document."));
          setPhaseAndReport("load-failed");
        }
        return;
      }
      if (!identity.create) {
        setError("This editor did not receive a document to open.");
        setPhaseAndReport("load-failed");
        return;
      }
      setPhaseAndReport("creating");
      try {
        safeFileItemName(identity.create.name);
        validateDocumentBody(identity.create.body);
        const result = await createNativeDocument(identity.profileId, identity.create, { signal: abortController.signal });
        if (!current || !mountedRef.current || accountChangedRef.current) return;
        installResult(result);
      } catch (createError) {
        if (!current || abortController.signal.aborted || accountChangedRef.current) return;
        setError(errorMessage(createError, "Unable to create this text document."));
        setPhaseAndReport("create-failed");
      }
    };

    void load();
    return () => {
      current = false;
      abortController.abort();
      if (initialAbortRef.current === abortController) initialAbortRef.current = null;
      mountedRef.current = false;
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
      copyAbortRef.current?.abort();
      copyAbortRef.current = null;
      autosaveRef.current?.stop();
      autosaveRef.current = null;
      onDraftChangeRef.current?.(null);
    };
  }, [attempt, identity, installResult, setPhaseAndReport]);

  useLayoutEffect(() => {
    if (returnFocusRef.current === null && document.activeElement instanceof HTMLElement) returnFocusRef.current = document.activeElement;
    titleRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (phase !== "ready" || focusedEditorRef.current || accountChangedRef.current) return;
    focusedEditorRef.current = true;
    window.requestAnimationFrame(() => nameInputRef.current?.focus({ preventScroll: true }));
  }, [phase]);

  const accountChanged = profileId !== identity.profileId;
  useEffect(() => {
    if (!accountChanged) return;
    initialAbortRef.current?.abort();
    copyAbortRef.current?.abort();
    autosaveRef.current?.stop();
    reportDraft();
  }, [accountChanged, reportDraft]);
  const status = snapshot?.status;
  const saving = status === "saving";
  const conflict = status === "conflict";
  const saveFailed = status === "save-error" || status === "session-error";
  const operationBusy = !accountChanged && (phase === "creating" || phase === "copying" || phase === "loading-latest" || saving);
  const unsaved = Boolean(snapshot?.dirty || saving || phase === "creating" || phase === "create-failed" || phase === "copying" || phase === "copy-failed");
  const ready = (phase === "ready" || phase === "copy-failed") && snapshot?.ready && !accountChanged;
  const fieldsBusy = phase === "creating" || phase === "copying" || phase === "loading-latest";
  const canEdit = Boolean(ready && canWrite && !fieldsBusy);
  useSaveProtection(unsaved);

  const updateDraft = (patch: Partial<DocumentDraft>) => {
    if (!canEdit || copyInFlightRef.current) return;
    const nextDraft = { ...draftRef.current, ...patch };
    draftRef.current = nextDraft;
    setDraftState(nextDraft);
    autosaveRef.current?.change(nextDraft);
    reportDraft();
  };

  const saveLatest = () => {
    const autosave = autosaveRef.current;
    if (!autosave || !canWrite || accountChanged || conflict) return;
    if (saveFailed) void autosave.retry();
    else void autosave.flushLatest();
  };

  const discardAndReload = async () => {
    if (!ready || operationBusy || !window.confirm("Discard your local text and load the latest saved version?")) return;
    const currentFileId = snapshotRef.current?.file?.id;
    if (!currentFileId) return;
    setError("");
    setPhaseAndReport("loading-latest");
    const controller = new AbortController();
    try {
      const result = await readNativeDocument(identity.profileId, currentFileId, { signal: controller.signal });
      if (!mountedRef.current || accountChangedRef.current) return;
      copyAttemptRef.current = null;
      setCopyAttempt(null);
      installResult(result);
    } catch (reloadError) {
      if (!mountedRef.current || accountChangedRef.current) return;
      setError(errorMessage(reloadError, "The saved version could not be loaded. Your local draft is still here."));
      setPhaseAndReport("ready");
    }
  };

  const saveAsNewDocument = async () => {
    if (!ready || !canWrite || operationBusy || !conflict) return;
    const currentFile = snapshotRef.current?.file;
    if (!currentFile) return;
    let descriptor = copyAttemptRef.current;
    if (!descriptor) {
      try {
        safeFileItemName(draftRef.current.name);
        validateDocumentBody(draftRef.current.body);
      } catch (validationError) {
        setError(errorMessage(validationError, "Review the document name and text before copying."));
        return;
      }
      try {
        descriptor = {
          id: crypto.randomUUID(),
          name: draftRef.current.name,
          body: draftRef.current.body,
          folderId: currentFile.folder_id,
          courseId: currentFile.course_id ?? "",
        };
      } catch {
        setError("This browser could not create a stable document ID. Keep or download the local draft and try again.");
        return;
      }
      copyAttemptRef.current = descriptor;
      setCopyAttempt(descriptor);
    }
    copyInFlightRef.current = true;
    setError("");
    setPhaseAndReport("copying");
    const controller = new AbortController();
    copyAbortRef.current = controller;
    try {
      const result = await createNativeDocument(identity.profileId, descriptor, { signal: controller.signal });
      if (!mountedRef.current || accountChangedRef.current) return;
      copyAbortRef.current = null;
      const latestLocalDraft = draftRef.current;
      copyAttemptRef.current = null;
      setCopyAttempt(null);
      copyInFlightRef.current = false;
      installResult(result, true);
      // A retry uses the exact original create descriptor so a lost response is idempotent.
      // If the user edited after a failed copy, those newer edits remain queued on the copy.
      if (latestLocalDraft.name !== descriptor.name || latestLocalDraft.body !== descriptor.body) {
        draftRef.current = latestLocalDraft;
        setDraftState(latestLocalDraft);
        autosaveRef.current?.change(latestLocalDraft);
        reportDraft();
      }
    } catch (copyError) {
      if (!mountedRef.current || accountChangedRef.current) return;
      copyAbortRef.current = null;
      copyInFlightRef.current = false;
      setError(`${errorMessage(copyError, "The draft could not be copied.")} Your latest local draft is still here; retry this copy or download the draft.`);
      setPhaseAndReport("copy-failed");
    }
  };

  const closeEditor = () => {
    if (operationBusy) return;
    if (unsaved && !window.confirm("You have unsaved text. Download the draft first if you want to keep a copy. Close this editor anyway?")) return;
    onDraftChangeRef.current?.(null);
    onCloseRef.current();
    window.requestAnimationFrame(() => {
      if (returnFocusRef.current?.isConnected) returnFocusRef.current.focus({ preventScroll: true });
    });
  };

  const handleDialogKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveLatest();
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      closeEditor();
      return;
    }
    if (event.key !== "Tab" || !dialogRef.current) return;
    const focusable = [...dialogRef.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href]")]
      .filter((element) => {
        if (element.closest("[hidden], [inert], [aria-hidden='true']")) return false;
        const style = getComputedStyle(element);
        return style.display !== "none" && style.visibility !== "hidden";
      });
    if (!focusable.length) return;
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (!focusable.includes(document.activeElement as HTMLElement)) { event.preventDefault(); (event.shiftKey ? last : first).focus(); }
    else if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
  };

  const statusText = accountChanged
    ? "This document belongs to the previous account session."
    : phase === "loading" ? "Loading saved text…"
      : phase === "creating" ? "Creating document…"
        : phase === "load-failed" ? "Could not load this document."
          : phase === "create-failed" ? "Could not create this document."
            : phase === "loading-latest" ? "Loading the latest saved version…"
              : phase === "copying" ? "Saving a copy…"
                : phase === "copy-failed" ? "Copy failed. Your local draft is still here."
                  : status === "saving" ? "Saving…"
                    : status === "saved" ? "Saved"
                      : status === "save-error" || status === "session-error" ? "Failed to save"
                        : status === "conflict" ? "This document changed elsewhere"
                          : status === "dirty" ? "Changes will save shortly"
                            : "Ready";

  return <div className="files-dialog-backdrop native-document-backdrop files-action-sheet-backdrop">
    {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions -- The modal handles Escape, save shortcuts, and keyboard focus trapping. */}
    <section ref={dialogRef} className="files-details-dialog native-document-dialog files-action-sheet" role="dialog" tabIndex={-1} aria-modal="true" aria-labelledby="native-document-title" aria-describedby="native-document-help" onKeyDown={handleDialogKeyDown}>
      <div className="files-details-heading native-document-heading">
        <div><p>Plain text document</p><h2 ref={titleRef} id="native-document-title" tabIndex={-1}>{identity.create ? "Text document" : "Edit text file"}</h2></div>
        <button type="button" className="files-icon-button" aria-label="Close text editor" disabled={operationBusy} onClick={closeEditor}><X size={18} /></button>
      </div>

      <div className={`native-document-status is-${status === "save-error" || status === "session-error" || status === "conflict" || phase.endsWith("failed") ? "error" : status === "saving" || operationBusy ? "saving" : "saved"}`} role="status" aria-live="polite">
        {status === "conflict" || phase === "copy-failed" ? <AlertTriangle size={16} aria-hidden="true" /> : status === "saving" || operationBusy ? <RefreshCw size={15} aria-hidden="true" /> : <FileText size={15} aria-hidden="true" />}
        <span>{statusText}</span>
      </div>

      <fieldset className="native-document-fields" disabled={!canEdit}>
        <label>File name<input ref={nameInputRef} type="text" required maxLength={255} value={draft.name} onChange={(event) => updateDraft({ name: event.currentTarget.value })} /></label>
        <label>Text<textarea spellCheck value={draft.body} onChange={(event) => updateDraft({ body: event.currentTarget.value })} /></label>
      </fieldset>

      {phase === "account-changed" || accountChanged ? <p className="native-document-error" role="alert">{error || "The signed-in account changed. Close this editor and reopen the document from Files."}</p> : null}
      {error && phase !== "account-changed" && !accountChanged && <p className="native-document-error" role="alert">{error}</p>}
      {(snapshot?.message && status !== "saved" && !error) && <p className="native-document-error" role={conflict ? "alert" : "status"}>{snapshot.message}</p>}

      {conflict && <div className="native-document-conflict" role="group" aria-label="Resolve document conflict">
        <p>Another tab saved changes to this document. Keep your text as a new document, or discard it and load the saved version.</p>
        <button type="button" className="files-secondary-button" disabled={!canWrite || operationBusy} onClick={() => void saveAsNewDocument()}><FileText size={15} /> {phase === "copy-failed" && copyAttempt ? "Retry saving this copy" : "Save local draft as new document"}</button>
        <button type="button" className="files-secondary-button" disabled={operationBusy} onClick={() => void discardAndReload()}><RefreshCw size={15} /> Discard local draft and load saved version</button>
      </div>}

      {!accountChanged && (phase === "load-failed" || phase === "create-failed") && <button type="button" className="files-secondary-button native-document-retry-initial" onClick={() => { setError(""); setAttempt((current) => current + 1); }}><RefreshCw size={15} /> Retry {phase === "load-failed" ? "loading" : "creation"}</button>}

      <div className="files-details-actions native-document-actions">
        {savedDraft && <button type="button" className="files-secondary-button" onClick={() => downloadTextDraft(savedDraft)}><Download size={15} /> Download saved text</button>}
        {unsaved && <button type="button" className="files-secondary-button" onClick={() => downloadTextDraft(draftRef.current)}><Download size={15} /> Download draft</button>}
        {saveFailed && !conflict && <button type="button" className="files-secondary-button" disabled={!canWrite || !ready || operationBusy} onClick={() => void autosaveRef.current?.retry()}><RefreshCw size={15} /> Retry save</button>}
        <button type="button" className="files-secondary-button" disabled={!ready || !canWrite || operationBusy || conflict || !snapshot?.dirty} onClick={saveLatest}><Save size={15} /> {saving ? "Saving…" : "Save"}</button>
        <button type="button" className="files-secondary-button native-document-close" disabled={operationBusy} onClick={closeEditor}>Close editor</button>
      </div>
      <p id="native-document-help" className="native-document-help">Plain text · up to 1 MiB of UTF-8 text · changes save automatically. Use Ctrl/⌘+S to save now.</p>
    </section>
  </div>;
}

export default NativeDocumentEditor;
