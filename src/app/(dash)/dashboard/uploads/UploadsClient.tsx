"use client";

import * as React from "react";
import Link from "next/link";
import { Upload, FileText, Loader2, CheckCircle2, XCircle, X } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { Label } from "@/components/ui/Label";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/Card";
import { cn } from "@/lib/utils";

const SOURCE_TYPES: { value: string; label: string }[] = [
  { value: "document", label: "Document" },
  { value: "call_score", label: "Call score" },
  { value: "coaching", label: "Coaching" },
  { value: "transcript", label: "Transcript" },
];

// Text formats we can read in the browser and ingest right now. PDF extraction
// needs a server-side step that is not wired yet, so PDFs are accepted into the
// list but marked "coming soon" and never sent.
const TEXT_EXTENSIONS = [".md", ".markdown", ".txt", ".text"];
const ACCEPT = ".md,.markdown,.txt,.text,.pdf";

type FileStatus = "ready" | "unsupported" | "ingesting" | "done" | "error";

interface FileEntry {
  id: string;
  name: string;
  size: number;
  status: FileStatus;
  text?: string; // populated for readable text files
  result?: { chunks: number; skipped: boolean };
  error?: string;
}

const extOf = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
};
const titleFromName = (name: string) => {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(0, dot) : name;
};
const isPdf = (name: string) => extOf(name) === ".pdf";
const isText = (name: string) => TEXT_EXTENSIONS.includes(extOf(name));

function StatusCell({ entry }: { entry: FileEntry }) {
  switch (entry.status) {
    case "unsupported":
      return <Badge tone="warning">PDF — coming soon</Badge>;
    case "ingesting":
      return (
        <span className="inline-flex items-center gap-1.5 text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Ingesting…
        </span>
      );
    case "done":
      return (
        <span className="inline-flex items-center gap-1.5 text-success">
          <CheckCircle2 className="h-4 w-4" aria-hidden="true" />
          {entry.result?.skipped
            ? "Already ingested"
            : `Ingested (${entry.result?.chunks ?? 0} chunks)`}
        </span>
      );
    case "error":
      return (
        <span className="inline-flex items-center gap-1.5 text-danger" title={entry.error}>
          <XCircle className="h-4 w-4" aria-hidden="true" /> {entry.error ?? "Failed"}
        </span>
      );
    default:
      return <span className="text-muted-foreground">Ready</span>;
  }
}

export function UploadsClient() {
  const [sourceType, setSourceType] = React.useState("document");
  const [entries, setEntries] = React.useState<FileEntry[]>([]);
  const [dragging, setDragging] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const inputRef = React.useRef<HTMLInputElement>(null);

  const addFiles = React.useCallback(async (fileList: FileList | File[]) => {
    const files = Array.from(fileList);
    const next: FileEntry[] = [];
    for (const file of files) {
      const id = `${file.name}-${file.size}-${crypto.randomUUID()}`;
      if (isPdf(file.name)) {
        next.push({ id, name: file.name, size: file.size, status: "unsupported" });
      } else if (isText(file.name)) {
        try {
          const text = await file.text();
          next.push({ id, name: file.name, size: file.size, status: "ready", text });
        } catch {
          next.push({
            id,
            name: file.name,
            size: file.size,
            status: "error",
            error: "Could not read file",
          });
        }
      } else {
        next.push({
          id,
          name: file.name,
          size: file.size,
          status: "unsupported",
        });
      }
    }
    setEntries((prev) => [...prev, ...next]);
  }, []);

  function onDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files?.length) void addFiles(e.dataTransfer.files);
  }

  function onPick(e: React.ChangeEvent<HTMLInputElement>) {
    if (e.target.files?.length) void addFiles(e.target.files);
    e.target.value = ""; // allow re-selecting the same file
  }

  function removeEntry(id: string) {
    setEntries((prev) => prev.filter((x) => x.id !== id));
  }

  const readyCount = entries.filter((e) => e.status === "ready").length;

  async function ingestAll() {
    setBusy(true);
    // Ingest ready files one at a time so a slow embed call can't fan out.
    for (const entry of entries) {
      if (entry.status !== "ready" || !entry.text) continue;
      setEntries((prev) =>
        prev.map((x) => (x.id === entry.id ? { ...x, status: "ingesting" } : x))
      );
      try {
        const res = await fetch("/api/admin/uploads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: titleFromName(entry.name),
            sourceType,
            text: entry.text,
            metadata: { filename: entry.name },
          }),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok) {
          setEntries((prev) =>
            prev.map((x) =>
              x.id === entry.id
                ? { ...x, status: "error", error: json.error ?? `HTTP ${res.status}` }
                : x
            )
          );
          continue;
        }
        setEntries((prev) =>
          prev.map((x) =>
            x.id === entry.id
              ? {
                  ...x,
                  status: "done",
                  result: { chunks: json.chunks ?? 0, skipped: !!json.skipped },
                }
              : x
          )
        );
      } catch {
        setEntries((prev) =>
          prev.map((x) =>
            x.id === entry.id ? { ...x, status: "error", error: "Network error" } : x
          )
        );
      }
    }
    setBusy(false);
  }

  const anyDone = entries.some((e) => e.status === "done");

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Upload documents</CardTitle>
          <CardDescription>
            Add Markdown or plain-text files to the knowledge base. They are chunked,
            embedded, and made searchable. PDF support is coming soon.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="max-w-xs space-y-1.5">
            <Label htmlFor="up-type">Source type</Label>
            <select
              id="up-type"
              className={
                "flex h-9 w-full rounded-lg border border-border bg-surface px-3 py-1 text-sm " +
                "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
                "focus-visible:ring-offset-1 focus-visible:ring-offset-background"
              }
              value={sourceType}
              onChange={(e) => setSourceType(e.target.value)}
            >
              {SOURCE_TYPES.map((t) => (
                <option key={t.value} value={t.value}>
                  {t.label}
                </option>
              ))}
            </select>
          </div>

          {/* Drop zone (also keyboard/click accessible via the button inside). */}
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={onDrop}
            className={cn(
              "flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors",
              dragging ? "border-accent bg-accent/5" : "border-border bg-surface/50"
            )}
          >
            <div className="flex h-11 w-11 items-center justify-center rounded-full bg-surface-muted">
              <Upload className="h-5 w-5 text-muted-foreground" aria-hidden="true" />
            </div>
            <div>
              <p className="text-sm font-medium">Drag &amp; drop files here</p>
              <p className="mt-1 text-sm text-muted-foreground">
                .md and .txt are ingested now · .pdf is accepted but marked coming soon
              </p>
            </div>
            <Button variant="outline" size="sm" onClick={() => inputRef.current?.click()}>
              <FileText className="h-4 w-4" aria-hidden="true" />
              Choose files
            </Button>
            <input
              ref={inputRef}
              type="file"
              accept={ACCEPT}
              multiple
              className="sr-only"
              aria-label="Choose files to upload"
              onChange={onPick}
            />
          </div>
        </CardContent>
      </Card>

      {entries.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle>Files</CardTitle>
            <CardDescription>
              {readyCount > 0
                ? `${readyCount} ready to ingest.`
                : "No text files ready to ingest."}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ul className="divide-y divide-border rounded-lg border border-border">
              {entries.map((entry) => (
                <li key={entry.id} className="flex items-center gap-3 px-3 py-2.5">
                  <FileText className="h-4 w-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{entry.name}</p>
                    <p className="text-xs text-muted-foreground">
                      {(entry.size / 1024).toFixed(1)} KB
                    </p>
                  </div>
                  <div className="shrink-0 text-sm">
                    <StatusCell entry={entry} />
                  </div>
                  {entry.status !== "ingesting" && (
                    <button
                      type="button"
                      onClick={() => removeEntry(entry.id)}
                      className="shrink-0 rounded p-1 text-muted-foreground hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                      aria-label={`Remove ${entry.name}`}
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </li>
              ))}
            </ul>

            {anyDone && (
              <Alert tone="success">
                Ingested files are now searchable.{" "}
                <Link href="/dashboard/documents" className="font-medium text-accent underline">
                  View documents
                </Link>
                .
              </Alert>
            )}

            <div className="flex items-center justify-between gap-3">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setEntries([])}
                disabled={busy}
              >
                Clear list
              </Button>
              <Button onClick={ingestAll} disabled={busy || readyCount === 0}>
                {busy ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  <Upload className="h-4 w-4" aria-hidden="true" />
                )}
                {busy
                  ? "Ingesting…"
                  : readyCount === 1
                    ? "Ingest 1 file"
                    : `Ingest ${readyCount} files`}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
