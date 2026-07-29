"use client";

// Drag-and-drop, multi-file uploader for the knowledge base.
//
// Layman flow: drop one or many files onto the big dashed zone (or press it /
// tab to it and hit Enter to browse). Each file gets a row that moves through
// queued -> uploading (with % progress) -> processing -> done (N chunks) / error.
// Files are POSTed one at a time to /api/admin/uploads as multipart/form-data,
// with a small concurrency so many files don't fan out into the embedder at once.
//
// The server resolves org_id and enforces documents:write; the client sends only
// the raw file. XMLHttpRequest is used (not fetch) so we can show real upload
// progress; once bytes are sent we flip to an indeterminate "processing" bar
// while the server extracts text, embeds, and persists.

import * as React from "react";
import Link from "next/link";
import { UploadCloud, FileText, Loader2, CheckCircle2, XCircle, X, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Badge } from "@/components/ui/Badge";
import { Alert } from "@/components/ui/Alert";
import { EmptyState } from "@/components/ui/EmptyState";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/Card";
import { cn } from "@/lib/utils";

// Formats we can send. .pdf is extracted server-side; the rest are read as UTF-8.
const ACCEPT = ".md,.markdown,.txt,.text,.pdf";
const SUPPORTED = [".md", ".markdown", ".txt", ".text", ".pdf"];
// How many files may be in flight at once (keeps the embedder from being swamped).
const CONCURRENCY = 3;

type Status = "queued" | "uploading" | "processing" | "done" | "error";

interface FileEntry {
  id: string;
  file: File;
  name: string;
  size: number;
  status: Status;
  progress: number; // 0-100 during upload; 100 while processing
  result?: { documentId: string; chunks: number; skipped: boolean };
  error?: string;
}

const extOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
};
const isSupported = (name: string) => SUPPORTED.includes(extOf(name));

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

// Tolerant JSON parse for XHR response bodies (never throws).
function parseJson(text: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function StatusPill({ entry }: { entry: FileEntry }) {
  switch (entry.status) {
    case "queued":
      return <Badge tone="neutral">Queued</Badge>;
    case "uploading":
      return (
        <Badge tone="accent" className="gap-1.5">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          Uploading {entry.progress}%
        </Badge>
      );
    case "processing":
      return (
        <Badge tone="accent" className="gap-1.5">
          <Loader2 className="h-3 w-3 animate-spin" aria-hidden="true" />
          Processing…
        </Badge>
      );
    case "done":
      return (
        <Badge tone="success" className="gap-1.5">
          <CheckCircle2 className="h-3 w-3" aria-hidden="true" />
          {entry.result?.skipped
            ? "Already ingested"
            : `Done · ${entry.result?.chunks ?? 0} chunks`}
        </Badge>
      );
    case "error":
      return (
        <Badge tone="danger" className="gap-1.5" title={entry.error}>
          <XCircle className="h-3 w-3" aria-hidden="true" />
          Failed
        </Badge>
      );
  }
}

export function UploadsClient() {
  const [entries, setEntries] = React.useState<FileEntry[]>([]);
  const [dragging, setDragging] = React.useState(false);
  const [live, setLive] = React.useState(""); // announced via aria-live

  const inputRef = React.useRef<HTMLInputElement>(null);
  const dragDepth = React.useRef(0);
  // Scheduling state kept in refs so it never depends on render timing.
  const queueRef = React.useRef<FileEntry[]>([]);
  const activeRef = React.useRef(0);
  const removedRef = React.useRef<Set<string>>(new Set());
  const scheduleRef = React.useRef<() => void>(() => {});

  // Patch one entry by id. setEntries updater is stable, so this needs no deps.
  const patch = React.useCallback((id: string, p: Partial<FileEntry>) => {
    setEntries((prev) => prev.map((e) => (e.id === id ? { ...e, ...p } : e)));
  }, []);

  // Upload a single entry with XHR; report progress, then processing, then result.
  const uploadOne = React.useCallback(
    (entry: FileEntry) => {
      patch(entry.id, { status: "uploading", progress: 0, error: undefined });
      setLive(`${entry.name}: uploading`);

      const done = () => {
        activeRef.current = Math.max(0, activeRef.current - 1);
        scheduleRef.current();
      };

      const xhr = new XMLHttpRequest();
      xhr.open("POST", "/api/admin/uploads");

      xhr.upload.onprogress = (ev) => {
        if (ev.lengthComputable) {
          patch(entry.id, { progress: Math.round((ev.loaded / ev.total) * 100) });
        }
      };
      // Bytes are on the wire — the server is now extracting/embedding.
      xhr.upload.onload = () => patch(entry.id, { status: "processing", progress: 100 });

      xhr.onload = () => {
        const json = parseJson(xhr.responseText || "");
        if (xhr.status >= 200 && xhr.status < 300) {
          const result = {
            documentId: typeof json.documentId === "string" ? json.documentId : "",
            chunks: typeof json.chunks === "number" ? json.chunks : Number(json.chunks) || 0,
            skipped: json.skipped === true,
          };
          patch(entry.id, { status: "done", progress: 100, result });
          setLive(
            `${entry.name}: done, ${result.skipped ? "already ingested" : `${result.chunks} chunks`}`
          );
        } else {
          const msg =
            typeof json.error === "string" ? json.error : `Upload failed (HTTP ${xhr.status})`;
          patch(entry.id, { status: "error", error: msg });
          setLive(`${entry.name}: error, ${msg}`);
        }
        done();
      };
      xhr.onerror = () => {
        patch(entry.id, { status: "error", error: "Network error" });
        setLive(`${entry.name}: network error`);
        done();
      };

      const fd = new FormData();
      fd.append("file", entry.file, entry.name);
      xhr.send(fd);
    },
    [patch]
  );

  // Pull queued entries into flight up to the concurrency limit.
  const schedule = React.useCallback(() => {
    while (activeRef.current < CONCURRENCY && queueRef.current.length > 0) {
      const entry = queueRef.current.shift()!;
      if (removedRef.current.has(entry.id)) continue; // dropped from the list meanwhile
      activeRef.current += 1;
      uploadOne(entry);
    }
  }, [uploadOne]);

  React.useEffect(() => {
    scheduleRef.current = schedule;
  }, [schedule]);

  const addFiles = React.useCallback((list: FileList | File[]) => {
    const created: FileEntry[] = Array.from(list).map((file) => {
      const supported = isSupported(file.name);
      return {
        id: crypto.randomUUID(),
        file,
        name: file.name,
        size: file.size,
        status: supported ? "queued" : "error",
        progress: 0,
        error: supported ? undefined : "Unsupported file type",
      };
    });
    if (created.length === 0) return;
    setEntries((prev) => [...prev, ...created]);
    queueRef.current.push(...created.filter((e) => e.status === "queued"));
    scheduleRef.current();
  }, []);

  // --- Drag & drop handlers (depth counter avoids flicker over children) -----
  function onDragEnter(e: React.DragEvent) {
    e.preventDefault();
    dragDepth.current += 1;
    setDragging(true);
  }
  function onDragOver(e: React.DragEvent) {
    e.preventDefault();
  }
  function onDragLeave(e: React.DragEvent) {
    e.preventDefault();
    dragDepth.current = Math.max(0, dragDepth.current - 1);
    if (dragDepth.current === 0) setDragging(false);
  }
  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    dragDepth.current = 0;
    setDragging(false);
    if (e.dataTransfer.files?.length) addFiles(e.dataTransfer.files);
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files?.length) addFiles(e.target.files);
    e.target.value = ""; // allow re-selecting the same file
  }

  function removeEntry(id: string) {
    removedRef.current.add(id);
    setEntries((prev) => prev.filter((e) => e.id !== id));
  }

  function retry(entry: FileEntry) {
    patch(entry.id, { status: "queued", progress: 0, error: undefined, result: undefined });
    queueRef.current.push(entry);
    scheduleRef.current();
  }

  function clearFinished() {
    setEntries((prev) =>
      prev.filter((e) => e.status === "queued" || e.status === "uploading" || e.status === "processing")
    );
  }

  const inFlight = entries.filter(
    (e) => e.status === "queued" || e.status === "uploading" || e.status === "processing"
  ).length;
  const doneCount = entries.filter((e) => e.status === "done").length;
  const errorCount = entries.filter((e) => e.status === "error").length;
  const totalChunks = entries.reduce(
    (n, e) => n + (e.result && !e.result.skipped ? e.result.chunks : 0),
    0
  );

  return (
    <div className="space-y-6">
      {/* Screen-reader announcements for status changes. */}
      <p className="sr-only" role="status" aria-live="polite">
        {live}
      </p>

      <Card>
        <CardHeader>
          <CardTitle>Upload documents</CardTitle>
          <CardDescription>
            Drag files onto the box below (or browse) to add them to the knowledge base. They
            are chunked, embedded, and made searchable. Supports Markdown, plain text, and PDF.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {/* The whole drop zone is a single focusable button: keyboard-activatable
              (Enter/Space open the picker) with no nested interactive controls. */}
          <button
            type="button"
            onClick={() => inputRef.current?.click()}
            onDragEnter={onDragEnter}
            onDragOver={onDragOver}
            onDragLeave={onDragLeave}
            onDrop={onDrop}
            aria-label="Upload files: drag and drop here, or activate to browse"
            className={cn(
              "flex w-full flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-12 text-center transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
              dragging
                ? "border-accent bg-accent/10"
                : "border-border bg-surface/50 hover:bg-surface-muted"
            )}
          >
            <div className="flex h-12 w-12 items-center justify-center rounded-full bg-surface-muted">
              <UploadCloud className="h-6 w-6 text-muted-foreground" aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-medium">
                {dragging ? "Drop to upload" : "Drag & drop files here"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                or click to browse · .md, .txt, .pdf · multiple files welcome
              </p>
            </div>
            <span className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-1.5 text-sm font-medium">
              <FileText className="h-4 w-4" aria-hidden="true" />
              Browse files
            </span>
          </button>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            multiple
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            onChange={onPick}
          />
        </CardContent>
      </Card>

      {entries.length === 0 ? (
        <EmptyState
          icon={FileText}
          title="No uploads yet"
          description="Files you drop or choose will appear here with live progress and results."
        />
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Files</CardTitle>
            <CardDescription>
              {inFlight > 0
                ? `${inFlight} in progress…`
                : `${doneCount} done${errorCount ? `, ${errorCount} failed` : ""} · ${totalChunks} chunks added`}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="divide-y divide-border rounded-lg border border-border">
              {entries.map((entry) => (
                <li key={entry.id} className="flex items-start gap-3 px-3 py-3">
                  <FileText
                    className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <p className="truncate text-sm font-medium">{entry.name}</p>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatBytes(entry.size)}
                      </span>
                    </div>

                    {(entry.status === "uploading" || entry.status === "processing") && (
                      <div
                        className="mt-2 h-1.5 w-full overflow-hidden rounded-full bg-surface-muted"
                        role="progressbar"
                        aria-valuenow={entry.status === "processing" ? undefined : entry.progress}
                        aria-valuemin={0}
                        aria-valuemax={100}
                      >
                        <div
                          className={cn(
                            "h-full rounded-full bg-accent transition-all",
                            entry.status === "processing" && "animate-pulse"
                          )}
                          style={{
                            width: entry.status === "processing" ? "100%" : `${entry.progress}%`,
                          }}
                        />
                      </div>
                    )}

                    <div className="mt-2 flex items-center gap-2">
                      <StatusPill entry={entry} />
                      {entry.status === "error" && entry.error && (
                        <span className="truncate text-xs text-muted-foreground" title={entry.error}>
                          {entry.error}
                        </span>
                      )}
                    </div>
                  </div>

                  <div className="flex shrink-0 items-center gap-1">
                    {entry.status === "error" && isSupported(entry.name) && (
                      <Button variant="ghost" size="sm" onClick={() => retry(entry)}>
                        <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                        Retry
                      </Button>
                    )}
                    {entry.status !== "uploading" && entry.status !== "processing" && (
                      <button
                        type="button"
                        onClick={() => removeEntry(entry.id)}
                        className="rounded p-1 text-muted-foreground hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                        aria-label={`Remove ${entry.name}`}
                      >
                        <X className="h-4 w-4" />
                      </button>
                    )}
                  </div>
                </li>
              ))}
            </ul>

            {doneCount > 0 && (
              <Alert tone="success">
                Ingested files are now searchable.{" "}
                <Link href="/dashboard/documents" className="font-medium text-accent underline">
                  View documents
                </Link>
                .
              </Alert>
            )}

            <div className="flex items-center justify-end">
              <Button
                variant="ghost"
                size="sm"
                onClick={clearFinished}
                disabled={doneCount + errorCount === 0}
              >
                Clear finished
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
