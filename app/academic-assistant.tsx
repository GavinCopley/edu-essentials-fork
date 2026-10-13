"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { BookOpen, Check, MessageSquare, Plus, Send, X } from "lucide-react";
import type { Answer, Citation } from "../lib/ai/contracts";
import type { Change } from "../lib/ai/academic-tools";
import { downloadDraft } from "./use-save-protection";
import "./assistant.css";

type Conversation = { id: string; title: string };
type Message = { id: string; question: string; status: string; error?: string; created_at: string; result?: { answer: Answer; citations: Citation[]; proposalId: string | null } };
type Source = { id: string; label: string; enabled: boolean; state: string; error: string | null };
type Proposal = { id: string; status: string; preview: { changes: Change[]; warnings: string[]; timezone: string; courseLabels?: Record<string, string> }; receipt?: { appliedAt: string }; expires_at: string };
type Access = { eligible: boolean; enabled?: boolean; mode: string };
export type AssistantPrompt = { id: string; question: string; send: boolean };
type Props = { profileId: string; prepare: () => Promise<void>; apply: (id: string) => Promise<void>; experimental: boolean; initialPrompt?: AssistantPrompt | null; onPromptConsumed?: (id: string) => void };

function changeSummary(value: Change["after"], labels: Record<string, string> = {}) {
  return [value.title, `Class: ${value.courseId ? labels[value.courseId] ?? value.courseId : "Personal"}`, `Date: ${value.dateKey}`, "time" in value ? `Time: ${value.time || "All day"}\nDuration: ${value.durationMinutes ?? "Unknown"}${value.durationMinutes ? " minutes" : ""}` : `Due time: ${value.dueTime || "Not specified"}\nStatus: ${value.status}\nProgress: ${value.progress}%`, value.description ? `Notes: ${value.description}` : ""].filter(Boolean).join("\n");
}

export default function AcademicAssistant({ profileId, prepare, apply, experimental, initialPrompt, onPromptConsumed }: Props) {
  const [access, setAccess] = useState<Access | null>(null), [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationId, setConversationId] = useState(""), [messages, setMessages] = useState<Message[]>([]);
  const [draft, setDraft] = useState(initialPrompt?.question ?? ""), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const consumedPrompt = useRef<string | null>(null);
  const [adult, setAdult] = useState(false), [synthetic, setSynthetic] = useState(false);
  const [sources, setSources] = useState<Source[]>([]), [sourceOpen, setSourceOpen] = useState(false);
  const [citation, setCitation] = useState<(Citation & { historical?: boolean; unavailable?: boolean; message?: string }) | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const mounted = useRef(true), controller = useRef<AbortController | null>(null);
  const api = useCallback(async <T,>(resource: string, init?: RequestInit): Promise<T> => {
    const response = await fetch(`/api/ai/${resource}`, { ...init, cache: "no-store", headers: { "content-type": "application/json", "x-profile-id": profileId, ...init?.headers } });
    const data = await response.json() as { error?: string }; if (!response.ok) throw new Error(data.error || "Assistant request failed."); return data as T;
  }, [profileId]);
  const loadConversations = useCallback(async () => { const result = await api<{ conversations: Conversation[] }>("conversations"); if (mounted.current) setConversations(result.conversations); }, [api]);
  const loadMessages = useCallback(async (id: string) => { const result = await api<{ messages: Message[] }>(`messages?conversationId=${id}`); if (mounted.current) setMessages(result.messages); }, [api]);
  useEffect(() => {
    mounted.current = true;
    void api<Access>("access").then((data) => { if (mounted.current) { setAccess(data); if (data.enabled) void loadConversations().catch((e) => setError(e.message)); } }).catch((e) => { if (mounted.current) setError(e.message); });
    return () => { mounted.current = false; controller.current?.abort(); };
  }, [api, loadConversations]);
  const running = messages.some((m) => m.status === "running");
  useEffect(() => {
    if (!running || !conversationId || busy) return;
    const timer = setTimeout(() => { void loadMessages(conversationId).catch((e) => setError(e.message)); }, 5000);
    return () => clearTimeout(timer);
  }, [running, conversationId, busy, messages, loadMessages]);
  const action = useCallback(async (task: () => Promise<void>) => {
    setError(""); setBusy(true);
    try { await task(); } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "Assistant request failed."); }
    finally { if (mounted.current) setBusy(false); }
  }, []);
  const send = useCallback((question = draft) => {
    if (!question.trim() || experimental || !access?.eligible || !access.enabled || busy || running) return;
    return action(async () => {
    await prepare();
    if (!mounted.current) return;
    let id = conversationId;
    if (!id) { const created = await api<Conversation>("conversations", { method: "POST", body: JSON.stringify({ title: question.trim().slice(0, 100) }) }); id = created.id; setConversationId(id); await loadConversations(); }
    if (!mounted.current) return;
    const requestId = crypto.randomUUID();
    setMessages((old) => [...old, { id: requestId, question, status: "running", created_at: new Date().toISOString() }]); setDraft("");
    controller.current = new AbortController();
    try { await api("messages", { method: "POST", body: JSON.stringify({ conversationId: id, requestId, message: question }), signal: controller.current.signal }); }
    finally { if (mounted.current) await loadMessages(id); }
    });
  }, [action, draft, experimental, access, busy, running, prepare, conversationId, api, loadConversations, loadMessages]);
  useEffect(() => {
    if (!initialPrompt || consumedPrompt.current === initialPrompt.id) return;
    if (initialPrompt.send && (!access?.eligible || !access.enabled || experimental || busy || running)) return;
    consumedPrompt.current = initialPrompt.id;
    onPromptConsumed?.(initialPrompt.id);
    if (initialPrompt.send) void send(initialPrompt.question);
  }, [initialPrompt, onPromptConsumed, access, experimental, busy, running, send]);
  const openProposal = (id: string) => action(async () => { setProposal(await api<Proposal>(`proposals?id=${id}`)); });

  return <div className="page assistant-page">
    <div className="page-heading"><div><p className="eyebrow">Your academic assistant</p><h1>Ask Edu</h1><p>Answers from your saved classes, tasks, and materials. Changes start with a preview.</p></div><BookOpen size={30} aria-hidden="true" /></div>
    {experimental && <p className="assistant-notice">Exit experimental mode to use the assistant with a saved test account.</p>}
    {error && <p className="auth-error" role="alert">{error}</p>}
    {!access && !error && <p role="status">Checking assistant access…</p>}
    {access && !access.eligible && <section className="assistant-empty"><MessageSquare size={32} /><h2>Assistant setup is pending</h2><p>The administrator must install the AI database setup and enable this account for the pilot.</p></section>}
    {access?.eligible && !access.enabled && <form className="assistant-consent" onSubmit={(e) => { e.preventDefault(); void action(async () => {
      await api("access", { method: "POST", body: JSON.stringify({ enabled: true, adultConfirmed: adult, syntheticConfirmed: synthetic }) });
      setAccess({ ...access, enabled: true }); await loadConversations();
    }); }}><h2>Enable your academic assistant</h2><p>Relevant saved academic records and document passages are sent to Google to answer your questions. Conversations are retained for up to 30 days. You can delete them and exclude documents.</p>
      <label><input type="checkbox" checked={adult} onChange={(e) => setAdult(e.target.checked)} required /> I am 18 or older.</label>
      {access.mode !== "paid" && <><p className="assistant-notice">This is a free-API test environment. Use fictional academic data and non-sensitive sample documents only. Google may use submitted content to improve its products.</p><label><input type="checkbox" checked={synthetic} onChange={(e) => setSynthetic(e.target.checked)} required /> This account contains only synthetic test data, and I will not enter personal or confidential information.</label></>}
      <button className="primary-button" disabled={busy || experimental}>Enable assistant</button></form>}
    {access?.enabled && <div className="assistant-layout">
      <aside className="assistant-history" aria-label="Conversations"><button className="secondary-button" disabled={busy || running} onClick={() => { setConversationId(""); setMessages([]); setProposal(null); }}><Plus size={16} /> New conversation</button>
        {conversations.map((c) => <button key={c.id} className={c.id === conversationId ? "active" : ""} disabled={busy || running} onClick={() => void action(async () => { setConversationId(c.id); setProposal(null); await loadMessages(c.id); })}>{c.title}</button>)}
        <button disabled={busy} onClick={() => void action(async () => { const result = await api<{ sources: Source[] }>("sources"); setSources(result.sources); setSourceOpen(!sourceOpen); })}>Manage sources</button>
        <button disabled={busy} onClick={() => void action(async () => downloadDraft("edu-assistant-conversations.json", await api("export")))}>Export conversations</button>
        {conversationId && <button disabled={busy || running} onClick={() => { if (window.confirm("Delete this conversation and its pending proposals?")) void action(async () => { await api("conversations", { method: "DELETE", body: JSON.stringify({ id: conversationId }) }); setConversationId(""); setMessages([]); setProposal(null); await loadConversations(); }); }}>Delete conversation</button>}
        <button disabled={busy || running} onClick={() => void action(async () => { await api("access", { method: "POST", body: JSON.stringify({ enabled: false, adultConfirmed: true, syntheticConfirmed: access.mode !== "paid" }) }); setAccess({ ...access, enabled: false }); setMessages([]); })}>Turn off assistant</button>
      </aside>
      <section className="assistant-chat" aria-label="Academic chat">
        {!messages.length && <div className="assistant-empty"><MessageSquare size={36} /><h2>What would help today?</h2><p>Ask about a deadline, find a policy in your syllabus, or prepare an assignment change.</p><div className="assistant-prompts">{["What assignments are due this week?", "What should I work on first?", "Find the late-work policy in my syllabi."].map((q) => <button key={q} className="secondary-button" onClick={() => setDraft(q)}>{q}</button>)}</div></div>}
        <div className="assistant-messages" aria-live="polite">{messages.map((m) => <article key={m.id} className="assistant-turn"><div className="assistant-question">{m.question}</div>
          <div className="assistant-answer"><small>Edu · {new Date(m.created_at).toLocaleString()}</small>
            {m.status === "running" && <p role="status">Reading your saved academic context…</p>}
            {m.status === "failed" && <p role="alert">{m.error}</p>}
            {m.result?.answer.blocks.map((block, i) => <div key={i}><span className={`assistant-kind ${block.kind}`}>{block.kind === "fact" ? "From your records" : block.kind === "unknown" ? "Missing information" : block.kind === "general" ? "General explanation" : "Suggestion"}</span><p>{block.text}</p><div className="assistant-citations">{block.citations.map((id) => <button key={id} disabled={busy} onClick={() => void action(async () => setCitation(await api(`citations?messageId=${m.id}&id=${encodeURIComponent(id)}`)))}>{m.result?.citations.find((c) => c.id === id)?.label ?? "Source"}</button>)}</div></div>)}
            {m.result?.proposalId && <button className="secondary-button" disabled={busy} onClick={() => void openProposal(m.result!.proposalId!)}>Review proposed changes</button>}
          </div></article>)}</div>
        <form className="assistant-composer" onSubmit={(e) => { e.preventDefault(); void send(); }}><label className="sr-only" htmlFor="assistant-message">Ask your academic assistant</label><textarea id="assistant-message" value={draft} maxLength={8000} rows={3} placeholder="Ask about your academic work…" onChange={(e) => setDraft(e.target.value)} disabled={busy || running || experimental} /><button className="primary-button" disabled={busy || running || experimental || !draft.trim()}><Send size={17} />{busy || running ? "Working…" : "Send"}</button></form>
        <p className="assistant-footnote">Edu can make mistakes. Check source records. Nothing changes until you review and Apply.</p>
        {running && <button className="secondary-button" disabled={busy} onClick={() => void action(() => loadMessages(conversationId))}>Refresh request status</button>}
      </section>
    </div>}
    {sourceOpen && <section className="assistant-sources"><div className="modal-header"><h2>Academic sources</h2><button className="secondary-button" onClick={() => setSourceOpen(false)}>Close sources</button></div><p>TXT, Markdown, and selectable-text PDFs up to 10 MB and 100 pages. Scans and images are not read. Excluding a source stops future retrieval; existing conversation answers remain until deleted.</p>{!sources.length && <p>No document sources yet. Upload files or save notes to add them.</p>}{sources.map((s) => <div className="assistant-source-row" key={s.id}><div><strong>{s.label}</strong><small>{s.enabled ? s.state : "Excluded"}{s.error ? ` · ${s.error}` : ""}</small></div><button disabled={busy} onClick={() => void action(async () => { await api("sources", { method: "POST", body: JSON.stringify({ id: s.id, action: s.enabled ? "exclude" : "include" }) }); setSources((await api<{ sources: Source[] }>("sources")).sources); })}>{s.enabled ? "Exclude" : "Include"}</button>{s.enabled && <button disabled={busy} onClick={() => void action(async () => { await api("sources", { method: "POST", body: JSON.stringify({ id: s.id, action: "retry" }) }); setSources((await api<{ sources: Source[] }>("sources")).sources); })}>Retry indexing</button>}</div>)}</section>}
    {citation && <div className="modal-backdrop"><section className="assistant-dialog" role="dialog" aria-modal="true" aria-label="Source excerpt"><div className="modal-header"><h2>{citation.label || "Source unavailable"}</h2><button className="secondary-button" onClick={() => setCitation(null)}><X size={16} /> Close</button></div>{citation.historical && <p className="assistant-notice">This excerpt is from the saved revision used for that answer. Your workspace has since changed.</p>}<pre>{citation.unavailable ? citation.message : citation.text}</pre></section></div>}
    {proposal && <div className="modal-backdrop"><section className="assistant-dialog" role="dialog" aria-modal="true" aria-label="Review proposed changes"><div className="modal-header"><h2>{proposal.status === "applied" ? "Applied changes" : "Review proposed changes"}</h2><button className="secondary-button" disabled={busy} onClick={() => setProposal(null)}>Close</button></div><p>Times use {proposal.preview.timezone}. Review every change before applying.</p>{proposal.preview.changes.map((c, i) => <div key={i} className="assistant-change"><strong>{c.after.title}</strong><div className="assistant-diff"><div><small>Before</small><pre>{c.before ? changeSummary(c.before, proposal.preview.courseLabels) : "New item"}</pre></div><div><small>After</small><pre>{changeSummary(c.after, proposal.preview.courseLabels)}</pre></div></div></div>)}{proposal.preview.warnings.map((w) => <p className="assistant-notice" key={w}>{w}</p>)}{proposal.status === "applied" ? <p role="status"><Check size={16} /> Saved successfully{proposal.receipt?.appliedAt ? ` at ${new Date(proposal.receipt.appliedAt).toLocaleString()}` : ""}.</p> : proposal.status === "pending" ? <div className="modal-actions"><button className="secondary-button" disabled={busy} onClick={() => void action(async () => { await api("proposals", { method: "POST", body: JSON.stringify({ id: proposal.id, action: "dismiss" }) }); setProposal({ ...proposal, status: "dismissed" }); })}>Dismiss</button><button className="primary-button" disabled={busy || experimental} onClick={() => void action(async () => { await apply(proposal.id); setProposal(await api<Proposal>(`proposals?id=${proposal.id}`)); })}>{busy ? "Applying…" : "Apply changes"}</button></div> : <p>This proposal is dismissed or expired. Request a new preview.</p>}{error && <p role="alert" className="auth-error">{error}</p>}</section></div>}
  </div>;
}
