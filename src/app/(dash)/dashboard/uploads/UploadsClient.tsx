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
import { UploadCloud, FileText, Loader2, CheckCircle2, XCircle, X, RotateCcw, Tags } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Field,
  IconButton,
  Input,
  Meter,
  SectionCard,
  Select,
  TableCard,
} from "@/components/ui";
import { CATEGORIES, ACCESS_LEVELS, DEPARTMENTS } from "@/lib/knowledge-taxonomy";
import { fmtBytes } from "@/lib/format";
import { statusTone } from "@/lib/ui-labels";
import { cn } from "@/lib/utils";

export interface CollectionOption {
  id: string;
  name: string;
}

/** The classification applied to a batch of uploads (all optional). */
interface Classification {
  collectionId: string;
  category: string;
  department: string;
  access: string;
  owner: string;
  reviewDate: string;
  tags: string;
}

const EMPTY_CLASSIFICATION: Classification = {
  collectionId: "",
  category: "",
  department: "",
  access: "",
  owner: "",
  reviewDate: "",
  tags: "",
};

const CATEGORY_OPTIONS = CATEGORIES.map((c) => ({ value: c, label: c }));
const ACCESS_OPTIONS = ACCESS_LEVELS.map((a) => ({ value: a.value, label: `${a.label} — ${a.scope}` }));
const DEPARTMENT_OPTIONS = DEPARTMENTS.map((d) => ({ value: d, label: d }));

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

// Tolerant JSON parse for XHR response bodies (never throws).
function parseJson(text: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(text);
    return v && typeof v === "object" ? (v as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

// Each upload status in the shared status vocabulary (queued = neutral,
// in flight = accent, done = success, failed = danger).
const STATUS_KEY: Record<Status, string> = {
  queued: "queued",
  uploading: "in_progress",
  processing: "processing",
  done: "done",
  error: "failed",
};

function StatusPill({ entry }: { entry: FileEntry }) {
  const tone = statusTone(STATUS_KEY[entry.status]);
  switch (entry.status) {
    case "queued":
      return <Badge tone={tone}>Queued</Badge>;
    case "uploading":
      return (
        <Badge tone={tone}>
          <Loader2 size={12} className="animate-spin" aria-hidden="true" />
          Uploading {entry.progress}%
        </Badge>
      );
    case "processing":
      return (
        <Badge tone={tone}>
          <Loader2 size={12} className="animate-spin" aria-hidden="true" />
          Processing…
        </Badge>
      );
    case "done":
      return (
        <Badge tone={tone}>
          <CheckCircle2 size={12} aria-hidden="true" />
          {entry.result?.skipped
            ? "Already ingested"
            : `Done · ${entry.result?.chunks ?? 0} chunks`}
        </Badge>
      );
    case "error":
      return (
        <Badge tone={tone}>
          <XCircle size={12} aria-hidden="true" />
          Failed
        </Badge>
      );
  }
}

export function UploadsClient({ collections = [] }: { collections?: CollectionOption[] }) {
  const [entries, setEntries] = React.useState<FileEntry[]>([]);
  const [dragging, setDragging] = React.useState(false);
  const [live, setLive] = React.useState(""); // announced via aria-live

  // Classification applied to every file in the batch. Kept in a ref too so an
  // in-flight upload always reads the latest values at send time.
  const [classify, setClassify] = React.useState<Classification>(EMPTY_CLASSIFICATION);
  const classifyRef = React.useRef(classify);
  React.useEffect(() => {
    classifyRef.current = classify;
  }, [classify]);
  const setField = (k: keyof Classification, v: string) =>
    setClassify((c) => ({ ...c, [k]: v }));

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
      // Attach the batch classification (only non-empty fields).
      const c = classifyRef.current;
      if (c.collectionId) fd.append("collection_id", c.collectionId);
      if (c.category) fd.append("category", c.category);
      if (c.department) fd.append("department", c.department);
      if (c.access) fd.append("access", c.access);
      if (c.owner) fd.append("owner", c.owner);
      if (c.reviewDate) fd.append("review_date", c.reviewDate);
      if (c.tags) fd.append("tags", c.tags);
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
    <div className="space-y-5">
      {/* Screen-reader announcements for status changes. */}
      <p className="sr-only" role="status" aria-live="polite">
        {live}
      </p>

      {/* Step 1 — classify the batch. Applied to every file uploaded below. */}
      <SectionCard
        icon={Tags}
        title="Classify this batch"
        description="Applied to every file you upload next, and shown in Documents and the governance views. All optional: set what you know."
        actions={
          (classify.collectionId || classify.category || classify.access) ? (
            <Button variant="ghost" size="sm" onClick={() => setClassify(EMPTY_CLASSIFICATION)}>
              Clear
            </Button>
          ) : undefined
        }
      >
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Collection">
            <Select
              id="up-collection"
              value={classify.collectionId}
              onChange={(e) => setField("collectionId", e.target.value)}
              placeholder="No collection"
              options={collections.map((c) => ({ value: c.id, label: c.name }))}
            />
          </Field>

          <Field label="Category">
            <Select
              id="up-category"
              value={classify.category}
              onChange={(e) => setField("category", e.target.value)}
              placeholder="Uncategorized"
              options={CATEGORY_OPTIONS}
            />
          </Field>

          <Field label="Access level">
            <Select
              id="up-access"
              value={classify.access}
              onChange={(e) => setField("access", e.target.value)}
              placeholder="Team (default)"
              options={ACCESS_OPTIONS}
            />
          </Field>

          <Field label="Department">
            <Select
              id="up-department"
              value={classify.department}
              onChange={(e) => setField("department", e.target.value)}
              placeholder="Any"
              options={DEPARTMENT_OPTIONS}
            />
          </Field>

          <Field label="Source owner">
            <Input id="up-owner" placeholder="e.g. Afra" value={classify.owner} onChange={(e) => setField("owner", e.target.value)} />
          </Field>

          <Field label="Review date">
            <Input id="up-review" type="date" value={classify.reviewDate} onChange={(e) => setField("reviewDate", e.target.value)} />
          </Field>

          <Field label="Tags" hint="Comma-separated." className="sm:col-span-2 lg:col-span-3">
            <Input id="up-tags" placeholder="pricing, onboarding, q3" value={classify.tags} onChange={(e) => setField("tags", e.target.value)} />
          </Field>
        </div>

        {(classify.collectionId || classify.category || classify.access) && (
          <p className="mt-3 text-xs text-muted-foreground">New uploads inherit this classification.</p>
        )}
      </SectionCard>

      {/* Step 2 — upload the files. */}
      <SectionCard
        icon={UploadCloud}
        title="Upload files"
        description="Each file is extracted, redacted, chunked, embedded and indexed so it can be retrieved."
      >
        {/* The whole drop zone is a single focusable button: keyboard-activatable
            (Enter/Space open the picker) with no nested interactive controls. */}
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          onDragEnter={onDragEnter}
          onDragOver={onDragOver}
          onDragLeave={onDragLeave}
          onDrop={onDrop}
          className={cn(
            "flex w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-surface-muted/40 px-4 py-8 text-center text-[13px] text-muted-foreground transition-colors hover:border-accent/40 hover:bg-accent-softer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            dragging && "border-accent/60 bg-accent-softer"
          )}
        >
          <span aria-hidden className="grid h-10 w-10 place-items-center rounded-full bg-accent-soft text-accent">
            <UploadCloud size={18} />
          </span>
          <span className="block text-sm font-medium text-foreground">
            {dragging ? "Drop to upload" : "Drag and drop files here"}
          </span>
          <span className="block">or click to browse · .md, .txt, .pdf · multiple files welcome</span>
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
      </SectionCard>

      {entries.length > 0 && (
        <TableCard
          title="Files"
          meta={
            inFlight > 0
              ? `${inFlight} in progress…`
              : `${doneCount} done${errorCount ? `, ${errorCount} failed` : ""} · ${totalChunks} chunks added`
          }
          actions={
            <Button variant="ghost" size="sm" onClick={clearFinished} disabled={doneCount + errorCount === 0}>
              Clear finished
            </Button>
          }
        >
          <ul>
            {entries.map((entry) => (
              <li key={entry.id} className="flex items-start gap-3 border-t border-border px-4 py-2.5 first:border-t-0">
                <FileText size={16} className="mt-0.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate text-[13px] font-medium text-foreground">{entry.name}</p>
                    <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                      {fmtBytes(entry.size)}
                    </span>
                  </div>

                  {(entry.status === "uploading" || entry.status === "processing") && (
                    <Meter
                      className="mt-2"
                      value={entry.progress}
                      tone="accent"
                      indeterminate={entry.status === "processing"}
                      label={`Upload progress for ${entry.name}`}
                    />
                  )}

                  <div className="mt-1.5 flex min-w-0 items-start gap-2">
                    <StatusPill entry={entry} />
                    {entry.status === "error" && entry.error && (
                      <span className="min-w-0 break-words text-xs text-muted-foreground">
                        {entry.error}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex shrink-0 items-center gap-1">
                  {entry.status === "error" && isSupported(entry.name) && (
                    <Button variant="ghost" size="sm" onClick={() => retry(entry)}>
                      <RotateCcw size={14} aria-hidden="true" />
                      Retry
                    </Button>
                  )}
                  {entry.status !== "uploading" && entry.status !== "processing" && (
                    <IconButton size="sm" onClick={() => removeEntry(entry.id)} aria-label={`Remove ${entry.name}`}>
                      <X size={14} aria-hidden="true" />
                    </IconButton>
                  )}
                </div>
              </li>
            ))}
          </ul>

          {doneCount > 0 && (
            <div className="border-t border-border p-4">
              <Alert tone="success">
                Ingested files are now searchable.{" "}
                <Link href="/dashboard/documents" className="font-medium text-accent-strong underline underline-offset-2">
                  View documents
                </Link>
                .
              </Alert>
            </div>
          )}
        </TableCard>
      )}
    </div>
  );
}
