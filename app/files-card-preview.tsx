"use client";

/* eslint-disable @next/next/no-img-element -- These previews use authenticated client-side blob URLs. */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { FileImage, FileText } from "lucide-react";
import type { PrivateFile } from "../lib/files";
import type { FileStore } from "./use-private-files";
import "./files-card-preview.css";

type PreviewState =
  | { key: string; loader?: FileStore["blob"]; kind: "loading" }
  | { key: string; loader?: FileStore["blob"]; kind: "image" | "pdf"; url: string }
  | { key: string; loader?: FileStore["blob"]; kind: "text"; text: string }
  | { key: string; loader?: FileStore["blob"]; kind: "unavailable" };

type Props = { file: PrivateFile; profileId: string; sessionVersion: number; store: Pick<FileStore, "blob"> };

function previewFallbackLabel(file: PrivateFile) {
  const mime = file.mime_type.toLowerCase().split(";", 1)[0].trim();
  const extension = file.name.match(/\.([a-z0-9]{1,8})$/i)?.[1]?.toUpperCase();
  if (mime === "application/pdf" || extension === "PDF") return "PDF";
  if (mime.includes("presentation") || ["PPT", "PPTX", "KEY"].includes(extension ?? "")) return extension || "PPT";
  if (mime.includes("spreadsheet") || mime.includes("excel") || ["XLS", "XLSX", "CSV"].includes(extension ?? "")) return extension || "XLS";
  if (mime.includes("wordprocessing") || mime.includes("msword") || ["DOC", "DOCX", "ODT"].includes(extension ?? "")) return extension || "DOC";
  if (mime.startsWith("image/")) return "IMAGE";
  if (mime.startsWith("text/")) return "TEXT";
  return extension || "FILE";
}

function previewFallbackColor(file: PrivateFile) {
  const mime = file.mime_type.toLowerCase();
  const name = file.name.toLowerCase();
  if (mime === "application/pdf" || name.endsWith(".pdf")) return "#ff555f";
  if (mime.includes("presentation") || /\.(ppt|pptx|key)$/.test(name)) return "#ff7043";
  if (mime.includes("spreadsheet") || mime.includes("excel") || /\.(xls|xlsx|csv)$/.test(name)) return "#19c981";
  if (mime.startsWith("image/")) return "#a46dff";
  return "#a6c4f4";
}

function previewableKind(file: PrivateFile): "image" | "pdf" | "text" | null {
  const mime = file.mime_type.toLowerCase().split(";", 1)[0].trim();
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("text/")) return "text";
  return null;
}

export default function FilesCardPreview({ file, profileId, sessionVersion, store }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(() => typeof IntersectionObserver === "undefined");
  const [state, setState] = useState<PreviewState>({ key: "", kind: "loading" });
  const kind = previewableKind(file);
  const loadBlob = store.blob;
  const previewKey = `${profileId}:${sessionVersion}:${file.id}:${file.content_revision}:${file.updated_at}`;

  useEffect(() => {
    const node = containerRef.current;
    if (!node || visible || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setVisible(true);
        observer.disconnect();
      }
    }, { rootMargin: "180px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, [visible]);

  useEffect(() => {
    if (!visible || !kind || typeof loadBlob !== "function") return;
    const controller = new AbortController();
    let objectUrl = "";
    let pdfLoadingTask: { destroy: () => Promise<void> } | null = null;
    let cancelPdfRender: (() => void) | null = null;
    const disposePdfTask = () => {
      const task = pdfLoadingTask;
      pdfLoadingTask = null;
      if (task) void task.destroy().catch(() => {});
    };
    if (kind === "image" && typeof URL.createObjectURL !== "function") return;
    void loadBlob(file, controller.signal).then(async (blob) => {
      if (controller.signal.aborted) return;
      if (kind === "text") {
        if (blob.size > 1024 * 1024) {
          setState({ key: previewKey, loader: loadBlob, kind: "unavailable" });
          return;
        }
        const text = await blob.text();
        if (!controller.signal.aborted) setState({ key: previewKey, loader: loadBlob, kind, text: text.slice(0, 1250) });
        return;
      }
      if (kind === "pdf") {
        if (blob.size > 20 * 1024 * 1024) {
          setState({ key: previewKey, loader: loadBlob, kind: "unavailable" });
          return;
        }
        const pdfjs = await import("unpdf/pdfjs");
        if (controller.signal.aborted) return;
        const pdfData = new Uint8Array(await blob.arrayBuffer());
        if (controller.signal.aborted) return;
        const loadingTask = pdfjs.getDocument({
          data: pdfData,
          useSystemFonts: true,
          useWasm: false,
          maxImageSize: 5_000_000,
        });
        pdfLoadingTask = loadingTask;
        const pdf = await loadingTask.promise;
        const page = await pdf.getPage(1);
        if (controller.signal.aborted) return;
        const canvas = document.createElement("canvas");
        try {
          if (!canvas.getContext("2d", { alpha: false })) throw new Error("Canvas preview is unavailable.");
          const baseViewport = page.getViewport({ scale: 1 });
          const availableWidth = Math.max(1, containerRef.current?.clientWidth ?? 420);
          const scale = Math.min(availableWidth / baseViewport.width, 1.4, 600 / baseViewport.height);
          const viewport = page.getViewport({ scale });
          const outputScale = Math.min(window.devicePixelRatio || 1, 2);
          canvas.width = Math.ceil(viewport.width * outputScale);
          canvas.height = Math.ceil(viewport.height * outputScale);
          const renderTask = page.render({
            canvas,
            viewport,
            transform: outputScale === 1 ? undefined : [outputScale, 0, 0, outputScale, 0, 0],
          });
          cancelPdfRender = () => renderTask.cancel();
          await renderTask.promise;
          cancelPdfRender = null;
          if (!controller.signal.aborted) setState({ key: previewKey, loader: loadBlob, kind, url: canvas.toDataURL("image/png") });
        } finally {
          cancelPdfRender = null;
          canvas.width = 0;
          canvas.height = 0;
          disposePdfTask();
        }
        return;
      }
      objectUrl = URL.createObjectURL(blob);
      if (!controller.signal.aborted) setState({ key: previewKey, loader: loadBlob, kind, url: objectUrl });
    }).catch(() => {
      disposePdfTask();
      if (!controller.signal.aborted) setState({ key: previewKey, loader: loadBlob, kind: "unavailable" });
    });
    return () => {
      controller.abort();
      cancelPdfRender?.();
      disposePdfTask();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [file, kind, loadBlob, previewKey, visible]);

  const current = !kind || typeof loadBlob !== "function"
    ? { key: previewKey, kind: "unavailable" as const }
    : state.key === previewKey && state.loader === loadBlob ? state : { key: previewKey, kind: "loading" as const };
  return <div className={`files-card-preview-content${current.kind === "loading" ? " is-loading" : ""}`} ref={containerRef} aria-label={`${file.kind} preview`}>
    {current.kind === "image" && <img src={current.url} alt={`Preview of ${file.name}`} loading="lazy" />}
    {current.kind === "pdf" && <img className="files-card-pdf-preview" src={current.url} alt="" loading="lazy" />}
    {current.kind === "text" && <pre>{current.text || "This text document is empty."}</pre>}
    {current.kind === "loading" && <span className="files-card-preview-loading" aria-hidden="true" />}
    {current.kind === "unavailable" && <span className="files-card-preview-fallback" style={{ "--preview-fallback-accent": previewFallbackColor(file) } as CSSProperties} aria-hidden="true">
      {kind === "image" ? <FileImage size={32} /> : <FileText size={32} />}
      <strong>{previewFallbackLabel(file)}</strong>
      <small>Preview unavailable</small>
    </span>}
  </div>;
}
