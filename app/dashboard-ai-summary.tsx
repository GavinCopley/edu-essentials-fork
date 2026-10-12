"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Sparkles } from "lucide-react";
import type { Answer, Citation } from "../lib/ai/contracts";

type Props = { profileId: string; prepare: () => Promise<void>; experimental: boolean; snapshotKey: string; onOpenAssistant: () => void };
type Access = { eligible: boolean; enabled?: boolean; mode: string };
type AccessState = { profileId: string; access: Access | null; checking: boolean; error: string };
type SnapshotState<T> = { profileId: string; snapshotKey: string; value: T };
type SummaryCitation = Citation & { historical?: boolean; unavailable?: boolean; message?: string };
type CheckedCitation = Partial<Citation> & { historical?: boolean; unavailable?: boolean; message?: string };
type CitationCheck = { status: "loading" | "ready" | "error"; citation?: CheckedCitation; error?: string };
type SummaryResult = { answer: Answer; citations: SummaryCitation[]; proposalId: string | null };
type Message = { id: string; status: string; error?: string; result?: SummaryResult };
type Api = <T,>(resource: string, init?: RequestInit) => Promise<T>;

const SUMMARY_QUESTION = "Summarize my outstanding assignments and suggest what I should work on next. Give advice only; do not create proposals or changes.";
const POLL_ATTEMPTS = 12;
const POLL_INTERVAL_MS = 1000;

function waitForNextPoll(signal: AbortSignal) {
  return new Promise<boolean>((resolve) => {
    if (signal.aborted) return resolve(false);
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve(true);
    }, POLL_INTERVAL_MS);
    const cancel = () => {
      clearTimeout(timer);
      resolve(false);
    };
    signal.addEventListener("abort", cancel, { once: true });
  });
}

async function pollForSummary(api: Api, conversationId: string, requestId: string, signal: AbortSignal, isCurrent: () => boolean) {
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt += 1) {
    if (!isCurrent()) return null;
    const response = await api<{ messages: Message[] }>(`messages?conversationId=${encodeURIComponent(conversationId)}`, { signal });
    if (!isCurrent()) return null;
    const message = response.messages.find((candidate) => candidate.id === requestId);
    if (message?.status === "failed") throw new Error(message.error || "The summary could not be generated. Try again.");
    if (message?.status === "complete") {
      if (!message.result) throw new Error("The assistant returned an empty summary. Try again.");
      return message.result;
    }
    if (attempt < POLL_ATTEMPTS - 1 && !await waitForNextPoll(signal)) return null;
  }
  if (isCurrent()) throw new Error("The summary is taking longer than expected. Try again.");
  return null;
}

export default function DashboardAiSummary({ profileId, prepare, experimental, snapshotKey, onOpenAssistant }: Props) {
  const [accessState, setAccessState] = useState<AccessState>({ profileId, access: null, checking: false, error: "" });
  const [busyState, setBusyState] = useState<SnapshotState<boolean> & { experimental: boolean }>({ profileId, snapshotKey, experimental, value: false });
  const [statusState, setStatusState] = useState<SnapshotState<string>>({ profileId, snapshotKey, value: "" });
  const [generationErrorState, setGenerationErrorState] = useState<SnapshotState<string>>({ profileId, snapshotKey, value: "" });
  const [summary, setSummary] = useState<{ profileId: string; snapshotKey: string; requestId: string; result: SummaryResult } | null>(null);
  const [citationChecks, setCitationChecks] = useState<Record<string, CitationCheck>>({});
  const mounted = useRef(false);
  const activeGeneration = useRef<AbortController | null>(null);
  const accessController = useRef<AbortController | null>(null);
  const citationControllers = useRef(new Map<string, AbortController>());
  const busyRef = useRef(false);
  const currentSnapshotKey = useRef(snapshotKey);
  const currentProfileId = useRef(profileId);
  if (busyState.profileId !== profileId || busyState.snapshotKey !== snapshotKey || busyState.experimental !== experimental) {
    setBusyState({ profileId, snapshotKey, experimental, value: false });
    setStatusState({ profileId, snapshotKey, value: "" });
    setGenerationErrorState({ profileId, snapshotKey, value: "" });
  }
  const activeAccess = accessState.profileId === profileId ? accessState : null;
  const access = activeAccess?.access ?? null;
  const checkingAccess = !experimental && (!activeAccess || activeAccess.checking || (!activeAccess.access && !activeAccess.error));
  const accessError = !experimental ? activeAccess?.error ?? "" : "";
  const busy = busyState.profileId === profileId && busyState.snapshotKey === snapshotKey && busyState.value;
  const status = statusState.profileId === profileId && statusState.snapshotKey === snapshotKey ? statusState.value : "";
  const generationError = generationErrorState.profileId === profileId && generationErrorState.snapshotKey === snapshotKey ? generationErrorState.value : "";

  const checkCitation = async (messageId: string, citationId: string) => {
    const key = `${messageId}:${citationId}`;
    if (citationControllers.current.has(key)) return;
    const controller = new AbortController();
    citationControllers.current.set(key, controller);
    setCitationChecks((previous) => ({ ...previous, [key]: { status: "loading" } }));
    try {
      const citation = await api<CheckedCitation>(`citations?messageId=${encodeURIComponent(messageId)}&id=${encodeURIComponent(citationId)}`, { signal: controller.signal });
      if (mounted.current && !controller.signal.aborted && citationControllers.current.get(key) === controller) {
        setCitationChecks((previous) => ({ ...previous, [key]: { status: "ready", citation } }));
      }
    } catch (error) {
      if (mounted.current && !controller.signal.aborted && citationControllers.current.get(key) === controller) {
        setCitationChecks((previous) => ({ ...previous, [key]: { status: "error", error: error instanceof Error ? error.message : "Could not verify this source." } }));
      }
    } finally {
      if (citationControllers.current.get(key) === controller) citationControllers.current.delete(key);
    }
  };

  const api = useCallback(async <T,>(resource: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`/api/ai/${resource}`, {
      ...init,
      cache: "no-store",
      headers: { "content-type": "application/json", "x-profile-id": profileId, ...init?.headers },
    });
    const data = await response.json() as { error?: string };
    if (!response.ok) throw new Error(data.error || "Assistant request failed.");
    return data as T;
  }, [profileId]);

  const checkAccess = useCallback(async (controller = new AbortController()) => {
    accessController.current?.abort();
    accessController.current = controller;
    setAccessState({ profileId, access: null, checking: true, error: "" });
    try {
      const result = await api<Access>("access", { signal: controller.signal });
      if (mounted.current && accessController.current === controller) setAccessState({ profileId, access: result, checking: true, error: "" });
    } catch (error) {
      if (mounted.current && accessController.current === controller && !controller.signal.aborted) {
        setAccessState({ profileId, access: null, checking: true, error: error instanceof Error ? error.message : "Could not check assistant access." });
      }
    } finally {
      if (accessController.current === controller) {
        accessController.current = null;
        if (mounted.current) setAccessState((current) => current.profileId === profileId ? { ...current, checking: false } : current);
      }
    }
  }, [api, profileId]);

  useEffect(() => {
    const pendingCitationControllers = citationControllers.current;
    mounted.current = true;
    return () => {
      mounted.current = false;
      accessController.current?.abort();
      activeGeneration.current?.abort();
      pendingCitationControllers.forEach((controller) => controller.abort());
      pendingCitationControllers.clear();
      activeGeneration.current = null;
      busyRef.current = false;
    };
  }, []);

  useEffect(() => {
    currentProfileId.current = profileId;
    activeGeneration.current?.abort();
    activeGeneration.current = null;
    busyRef.current = false;
    if (experimental) {
      return;
    }
    const controller = new AbortController();
    const pendingCitationControllers = citationControllers.current;
    accessController.current?.abort();
    accessController.current = controller;
    const loadAccess = async () => {
      try {
        const result = await api<Access>("access", { signal: controller.signal });
        if (mounted.current && accessController.current === controller) setAccessState({ profileId, access: result, checking: false, error: "" });
      } catch (error) {
        if (mounted.current && accessController.current === controller && !controller.signal.aborted) {
          setAccessState({ profileId, access: null, checking: false, error: error instanceof Error ? error.message : "Could not check assistant access." });
        }
      }
    };
    void loadAccess();
    return () => {
      controller.abort();
      if (accessController.current === controller) accessController.current = null;
      activeGeneration.current?.abort();
      pendingCitationControllers.forEach((citationController) => citationController.abort());
      pendingCitationControllers.clear();
      activeGeneration.current = null;
      busyRef.current = false;
    };
  }, [api, experimental, profileId]);

  useEffect(() => {
    currentSnapshotKey.current = snapshotKey;
    activeGeneration.current?.abort();
    citationControllers.current.forEach((controller) => controller.abort());
    citationControllers.current.clear();
    activeGeneration.current = null;
    busyRef.current = false;
  }, [snapshotKey]);

  const generate = async () => {
    if (experimental) return;
    if (!access?.eligible || !access.enabled) {
      onOpenAssistant();
      return;
    }
    if (busyRef.current) return;

    const controller = new AbortController();
    const generationSnapshot = currentSnapshotKey.current;
    activeGeneration.current = controller;
    busyRef.current = true;
    setBusyState({ profileId, snapshotKey: generationSnapshot, experimental, value: true });
    setStatusState({ profileId, snapshotKey: generationSnapshot, value: "Preparing your workspace…" });
    setGenerationErrorState({ profileId, snapshotKey: generationSnapshot, value: "" });
    setSummary(null);
    setCitationChecks({});
    citationControllers.current.forEach((citationController) => citationController.abort());
    citationControllers.current.clear();
    const isCurrent = () => mounted.current
      && activeGeneration.current === controller
      && !controller.signal.aborted
      && currentProfileId.current === profileId
      && currentSnapshotKey.current === generationSnapshot;

    try {
      await prepare();
      if (!isCurrent()) return;
      setStatusState({ profileId, snapshotKey: generationSnapshot, value: "Creating your study brief…" });
      const conversation = await api<{ id: string }>("conversations", {
        method: "POST",
        body: JSON.stringify({ title: "AI study brief" }),
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      const requestId = crypto.randomUUID();
      const posted = await api<Message>("messages", {
        method: "POST",
        body: JSON.stringify({ conversationId: conversation.id, requestId, message: SUMMARY_QUESTION }),
        signal: controller.signal,
      });
      if (!isCurrent()) return;
      setStatusState({ profileId, snapshotKey: generationSnapshot, value: "Generating your study brief…" });
      if (posted.id === requestId && posted.status === "failed") {
        throw new Error(posted.error || "The summary could not be generated. Try again.");
      }
      const result = posted.id === requestId && posted.status === "complete"
        ? posted.result ?? null
        : await pollForSummary(api, conversation.id, requestId, controller.signal, isCurrent);
      if (!result && isCurrent() && posted.id === requestId && posted.status === "complete") {
        throw new Error("The assistant returned an empty summary. Try again.");
      }
      if (result && isCurrent()) setSummary({ profileId, snapshotKey: generationSnapshot, requestId, result });
    } catch (error) {
      if (isCurrent()) setGenerationErrorState({ profileId, snapshotKey: generationSnapshot, value: error instanceof Error ? error.message : "The summary could not be generated. Try again." });
    } finally {
      if (activeGeneration.current === controller) {
        activeGeneration.current = null;
        busyRef.current = false;
        if (mounted.current && currentProfileId.current === profileId && currentSnapshotKey.current === generationSnapshot) {
          setBusyState({ profileId, snapshotKey: generationSnapshot, experimental, value: false });
          setStatusState({ profileId, snapshotKey: generationSnapshot, value: "" });
        }
      }
    }
  };

  const visibleSummary = summary?.profileId === profileId && summary.snapshotKey === snapshotKey ? summary.result : null;
  const canGenerate = !!access?.eligible && !!access.enabled;

  return <div className="dashboard-summary-copy">
      <p className="dashboard-eyebrow"><Sparkles size={15} aria-hidden="true" /> AI STUDY BRIEF</p>
      <h1 id="dashboard-summary-title">A clear place to start.</h1>
      <p>Turn your assignments into a practical plan. Generate a brief from your saved work, then choose your next step.</p>
      <div className="dashboard-summary-actions">
        <button className="primary-button" disabled={busy || experimental || (access === null && !accessError)} onClick={() => void generate()}>
          Generate AI summary
        </button>
        <button className="text-button" type="button" onClick={onOpenAssistant}>Open assistant</button>
      </div>
      <p className="assistant-footnote">With assistant access enabled, choosing Generate sends your saved academic context to the AI service for this brief.</p>
      {experimental && <p className="assistant-notice" role="status">AI summaries are unavailable in experimental mode. Switch to your saved account to use AI features.</p>}
      {!experimental && access && !canGenerate && <p className="form-hint">Open the assistant to review setup and consent before generating a summary.</p>}
      {!experimental && checkingAccess && <p role="status">Checking assistant access…</p>}
      {accessError && <div><p className="auth-error" role="alert">{accessError}</p><button className="text-button" type="button" disabled={checkingAccess} onClick={() => void checkAccess()}>Retry access check</button></div>}
      {busy && <p role="status">{status}</p>}
      {generationError && <div><p className="auth-error" role="alert">{generationError}</p><button className="text-button" type="button" disabled={busy} onClick={() => void generate()}>Try again</button></div>}
        {visibleSummary && summary && <div className="dashboard-ai-answer" aria-live="polite">
        {visibleSummary.answer.blocks.map((block, index) => {
          const citations = visibleSummary.citations.filter((citation) => block.citations.includes(citation.id));
          return <article className="dashboard-summary-answer-block" key={`${block.kind}-${index}`}>
            <p className="dashboard-summary-answer-kind">{block.kind === "fact" ? "From your records" : block.kind === "recommendation" ? "Next step" : block.kind === "unknown" ? "Missing information" : "General guidance"}</p>
            <p>{block.text}</p>
            {!!citations.length && <div className="dashboard-summary-citations">{citations.map((citation) => {
              const key = `${summary.requestId}:${citation.id}`;
              const check = citationChecks[key];
              return <details className="dashboard-summary-citation" key={citation.id} onToggle={(event) => {
                if (event.currentTarget.open) void checkCitation(summary.requestId, citation.id);
              }}>
                <summary>{check?.status === "ready" ? check.citation?.label || citation.label : citation.label}</summary>
                {check?.status === "loading" && <p role="status">Checking source…</p>}
                {check?.status === "error" && <><p className="auth-error" role="alert">{check.error}</p><button className="text-button" type="button" onClick={() => void checkCitation(summary.requestId, citation.id)}>Retry source check</button></>}
                {check?.status === "ready" && check.citation?.unavailable && <p>{check.citation.message || "This source is unavailable or has changed."}</p>}
                {check?.status === "ready" && !check.citation?.unavailable && <>
                  {check.citation?.historical && <p className="assistant-notice">This excerpt is from the saved revision used for that answer. Your workspace has since changed.</p>}
                  {check.citation?.text ? <p>{check.citation.text}</p> : <p>Source excerpt unavailable.</p>}
                </>}
              </details>;
            })}</div>}
          </article>;
        })}
        <p className="assistant-footnote">This brief is advice only. Check assignment details before acting; sources may reflect the saved revision used for the answer.</p>
      </div>}
  </div>;
}
