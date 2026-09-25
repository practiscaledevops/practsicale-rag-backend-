"use client";

// Long-source ("book") mode of the Add-knowledge wizard.
//
// A source over 40k characters (a book, a course transcript, a long report) is
// not ONE knowledge object. This panel outlines it into top-level units and
// compiles each one as its own object through the existing compile route:
//
//   1. intro      "This looks like a long source…"  [Outline it] / [Compile as one object anyway]
//   2. outline    heading candidates are found IN THE BROWSER; only that short list goes to
//                 POST /api/admin/knowledge/outline (one model call picks the chapters); the
//                 browser does the split (src/lib/long-source-pure.ts). Model unavailable →
//                 deterministic split by size.
//   3. checklist  work title + author, sections (title editable, preview, all checked except
//                 "Front matter")
//   4. batch      client-driven, 2 at a time: POST …/knowledge/compile { mode: "commit" } per
//                 section → NEW / ENRICHED / DUPLICATE / CONFLICT / BLOCKED / failed (+ Retry),
//                 Pause / Resume, survives individual failures, warns before the tab closes.
//
// Progress is filed in localStorage under a cheap hash of the source, so a
// reload can "Resume where you left off" (the user re-selects the file;
// extraction is fast). Re-running a source is safe anyway: the compiler's dedup
// answers DUPLICATE / ENRICH for what the Brain already holds.

import * as React from "react";
import Link from "next/link";
import { AlertTriangle, BookOpen, Check, ExternalLink, ListTree, Loader2, Pause, Play, RotateCcw, Undo2 } from "lucide-react";
import { Alert, Badge, Button, buttonClass, Checkbox, Field, Input, Meter, Select, Spinner, type BadgeTone } from "@/components/ui";
import { api } from "@/components/ui/brain-ui";
import { cn } from "@/lib/utils";
import { fmtDate } from "@/lib/format";
import { dedupTone, statusTone } from "@/lib/ui-labels";
import {
  headingCandidates,
  outlineCandidates,
  chaptersFromOutline,
  splitByOutline,
  fallbackChapters,
  isGenericSectionTitle,
  baseSectionTitle,
  FRONT_MATTER_TITLE,
  type ChapterStart,
  type OutlinePick,
} from "@/lib/long-source-pure";
import { MAX_TEXT_CHARS } from "@/lib/ingest-adapters/pure";
import { slugify, humanize, type IntelligenceClass, type RealityBucket } from "@/lib/intelligence-taxonomy";

type SectionStatus = "idle" | "queued" | "compiling" | "new" | "enriched" | "duplicate" | "conflict" | "blocked" | "failed";
const FINISHED: SectionStatus[] = ["new", "enriched", "duplicate", "conflict"];
const CONCURRENCY = 2;

interface BookSection {
  index: number;
  title: string;
  start: number;
  end: number;
  chars: number;
  preview: string;
  checked: boolean;
  open: boolean;
  status: SectionStatus;
  /** The object that was created / enriched / already held this. */
  ref?: string;
  id?: string;
  /** Blocked reason or error message. */
  note?: string;
  /** The compile proposed a new taxonomy value. */
  proposed?: boolean;
}

interface OutlineResponse {
  title: string | null;
  author: string | null;
  chapters: OutlinePick[];
  via: "model" | "fallback";
  /** null = the model never answered (demo mode, no key, outage). */
  model: string | null;
}

/** The slice of the compile route's reply this panel reads. */
interface CompileReply {
  blocked: { reason: string } | null;
  dedup?: { decision: "new" | "enrich" | "duplicate" | "conflict" };
  taxonomy?: { status: string }[];
  object: { id: string; ref: string; name: string } | null;
  target: { id: string; ref: string; name: string } | null;
}

/** What is filed in localStorage per source (no source text — only the outline and the outcomes). */
interface SavedBatch {
  v: 1;
  savedAt: string;
  workTitle: string;
  author: string;
  kind: string;
  via: "model" | "fallback";
  chapters: ChapterStart[];
  sections: Record<string, { title: string; checked: boolean; status: SectionStatus; ref?: string; id?: string; decision?: string; note?: string; proposed?: boolean }>;
}

const STORE_PREFIX = "brain.longsource.";
const STORE_KEEP = 10;

// localStorage can be unavailable (private mode, quota, blocked) — never let it break the batch.
function loadSaved(key: string): SavedBatch | null {
  try {
    const raw = window.localStorage.getItem(STORE_PREFIX + key);
    const v = raw ? (JSON.parse(raw) as SavedBatch) : null;
    return v && v.v === 1 && Array.isArray(v.chapters) && v.sections && typeof v.sections === "object" ? v : null;
  } catch {
    return null;
  }
}
function saveBatch(key: string, value: SavedBatch): void {
  try {
    window.localStorage.setItem(STORE_PREFIX + key, JSON.stringify(value));
    // Keep the newest few sources only.
    const mine: { k: string; at: string }[] = [];
    for (let i = 0; i < window.localStorage.length; i++) {
      const k = window.localStorage.key(i);
      if (!k || !k.startsWith(STORE_PREFIX)) continue;
      let at = "";
      try { at = (JSON.parse(window.localStorage.getItem(k) ?? "{}") as { savedAt?: string }).savedAt ?? ""; } catch { /* unreadable → oldest */ }
      mine.push({ k, at });
    }
    mine.sort((a, b) => (a.at < b.at ? 1 : -1)).slice(STORE_KEEP).forEach((m) => window.localStorage.removeItem(m.k));
  } catch {
    /* storage unavailable — the batch still runs */
  }
}
function clearSaved(key: string): void {
  try {
    window.localStorage.removeItem(STORE_PREFIX + key);
  } catch {
    /* ignore */
  }
}

/** "PreSold-TheBook.pdf" → "PreSold TheBook" (a starting point for the work title). */
function nameToTitle(name: string): string {
  return name.replace(/\.[A-Za-z0-9]{2,5}$/, "").replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

const KIND_OPTIONS = [
  { value: "book", label: "Book" },
  { value: "course", label: "Course" },
  { value: "internal_report", label: "Internal report" },
  { value: "document", label: "Document" },
  { value: "other", label: "Other" },
];

/**
 * Section outcome → badge. Queued / compiling use the shared statusTone
 * (neutral / accent). Outcomes use dedupTone, the same colours as the wizard and
 * the Decisions log: new = success, enriched = info, duplicate = neutral,
 * conflict / blocked (needs review) = warning, failed = danger.
 */
const STATUS_BADGE: Record<SectionStatus, { tone: BadgeTone; label: string }> = {
  idle: { tone: statusTone(null), label: "" },
  queued: { tone: statusTone("queued"), label: "Queued" },
  compiling: { tone: statusTone("compiling"), label: "Compiling…" },
  new: { tone: dedupTone("new"), label: "New" },
  enriched: { tone: dedupTone("enriched"), label: "Enriched" },
  duplicate: { tone: dedupTone("duplicate"), label: "Duplicate" },
  conflict: { tone: dedupTone("conflict"), label: "Conflict" },
  blocked: { tone: dedupTone("blocked"), label: "Blocked" },
  failed: { tone: dedupTone("failed"), label: "Failed" },
};

export function LongSourcePanel({
  resumeKey: key,
  text,
  sourceName,
  cls,
  bucket,
  hints,
  confirmTruth,
  busy,
  onSingle,
  onActive,
  onRunning,
  onReset,
}: {
  /** sourceKey(source name, text): where this source's progress is filed in localStorage. */
  resumeKey: string;
  text: string;
  /** The source's own title / filename — a hint for the outline and the work title's starting point. */
  sourceName: string;
  cls: IntelligenceClass;
  bucket: RealityBucket | null;
  /** The wizard's hints (provenance + the human's classification choice). */
  hints: Record<string, unknown>;
  confirmTruth: boolean;
  /** The wizard is running the single-object preview. */
  busy: boolean;
  onSingle: () => void;
  /** An outline is on screen (the wizard hides the raw text box). */
  onActive: (v: boolean) => void;
  onRunning: (v: boolean) => void;
  onReset: () => void;
}) {
  const [outlined, setOutlined] = React.useState<{ via: "model" | "fallback"; chapters: ChapterStart[] } | null>(null);
  const [sections, setSections] = React.useState<BookSection[]>([]);
  const [workTitle, setWorkTitle] = React.useState("");
  const [author, setAuthor] = React.useState("");
  const [kind, setKind] = React.useState("book");
  const [outlining, setOutlining] = React.useState(false);
  const [paused, setPaused] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

  const [saved, setSaved] = React.useState<SavedBatch | null>(null);
  React.useEffect(() => setSaved(loadSaved(key)), [key]);

  // The batch runs from callbacks that outlive a render: the queue and the
  // inputs live in refs so a worker never reads a stale closure.
  const secRef = React.useRef<BookSection[]>([]);
  const activeRef = React.useRef(0);
  const pausedRef = React.useRef(false);
  const aliveRef = React.useRef(true);
  const cfgRef = React.useRef({ text, cls, bucket, hints, confirmTruth, workTitle, author, kind });
  cfgRef.current = { text, cls, bucket, hints, confirmTruth, workTitle, author, kind };

  const commitSections = React.useCallback((next: BookSection[]) => {
    secRef.current = next;
    setSections(next);
  }, []);
  const patch = React.useCallback(
    (index: number, p: Partial<BookSection>) => commitSections(secRef.current.map((s) => (s.index === index ? { ...s, ...p } : s))),
    [commitSections]
  );

  const inFlight = sections.some((s) => s.status === "compiling");
  const queued = sections.some((s) => s.status === "queued");
  const running = inFlight || (queued && !paused);
  const started = sections.some((s) => s.status !== "idle");
  const locked = running || paused;

  React.useEffect(() => onActive(!!outlined), [outlined, onActive]);
  React.useEffect(() => onRunning(running), [running, onRunning]);
  React.useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
      onActive(false);
      onRunning(false);
    };
  }, [onActive, onRunning]);

  // Closing the tab mid-batch loses the queue (what finished is safe) — warn first.
  React.useEffect(() => {
    if (!running) return;
    const warn = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [running]);

  // File the progress once a batch has begun.
  React.useEffect(() => {
    if (!outlined || !started) return;
    const value: SavedBatch = {
      v: 1,
      savedAt: new Date().toISOString(),
      workTitle,
      author,
      kind,
      via: outlined.via,
      chapters: outlined.chapters,
      sections: Object.fromEntries(
        sections.map((s) => [String(s.index), { title: s.title, checked: s.checked, status: s.status, ref: s.ref, id: s.id, decision: FINISHED.includes(s.status) ? s.status : undefined, note: s.note, proposed: s.proposed }])
      ),
    };
    saveBatch(key, value);
  }, [outlined, started, sections, workTitle, author, kind, key]);

  function showOutline(chapters: ChapterStart[], via: "model" | "fallback", title: string, by: string, from?: SavedBatch) {
    const split = splitByOutline(text, chapters);
    // A saved batch only applies when it describes exactly this split.
    const prior = from && Object.keys(from.sections).length === split.length ? from.sections : null;
    commitSections(
      split.map((s) => {
        const p = prior?.[String(s.index)];
        const done = p && FINISHED.includes(p.status);
        return {
          index: s.index,
          title: p?.title || s.title,
          start: s.start,
          end: s.end,
          chars: s.chars,
          preview: s.preview,
          checked: p ? p.checked : s.title !== FRONT_MATTER_TITLE,
          open: false,
          // Whatever was queued / in flight / failed when the tab closed starts again as idle.
          status: done ? p.status : "idle",
          ref: done ? p.ref : undefined,
          id: done ? p.id : undefined,
          proposed: done ? p.proposed : undefined,
        };
      })
    );
    setWorkTitle(title);
    setAuthor(by);
    setPaused(false);
    pausedRef.current = false;
    setOutlined({ via, chapters });
  }

  async function runOutline() {
    setOutlining(true);
    setError(null);
    setNotice(null);
    try {
      const cands = headingCandidates(text);
      let res: OutlineResponse | null = null;
      try {
        res = await api<OutlineResponse>("/api/admin/knowledge/outline", {
          method: "POST",
          body: JSON.stringify({ candidates: outlineCandidates(text, cands), title: sourceName.slice(0, 200) }),
        });
      } catch (e) {
        setNotice(`The outline model could not be reached (${e instanceof Error ? e.message : "request failed"}) — split by size instead.`);
      }
      const chapters = res && res.via === "model" ? chaptersFromOutline(cands, res.chapters) : [];
      const viaModel = chapters.length >= 3;
      if (res && !viaModel) {
        setNotice(
          res.model
            ? "No clear chapter structure was found — the source was split by size instead. Rename or untick parts as needed."
            : "The outline model is unavailable right now — the source was split by size instead. Rename or untick parts as needed, or discard and try again."
        );
      }
      const by = typeof hints.sourceExpert === "string" && hints.sourceExpert.trim() ? hints.sourceExpert.trim() : res?.author ?? "";
      showOutline(viaModel ? chapters : fallbackChapters(text, cands), viaModel ? "model" : "fallback", res?.title || nameToTitle(sourceName), by);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not outline the source");
    } finally {
      setOutlining(false);
    }
  }

  function resumeSaved() {
    if (!saved) return;
    setKind(saved.kind || "book");
    showOutline(saved.chapters, saved.via, saved.workTitle, saved.author, saved);
  }

  function discardOutline() {
    commitSections([]);
    setOutlined(null);
    setNotice(null);
    setError(null);
    // What this batch filed stays resumable from the intro.
    setSaved(loadSaved(key));
  }

  // ---- the batch ----------------------------------------------------------

  const compileOne = React.useCallback(
    async (s: BookSection) => {
      const cfg = cfgRef.current;
      const name = baseSectionTitle(s.title).trim();
      const tag = slugify(cfg.workTitle).slice(0, 40);
      try {
        const res = await api<CompileReply>("/api/admin/knowledge/compile", {
          method: "POST",
          body: JSON.stringify({
            mode: "commit",
            class: cfg.cls,
            bucket: cfg.bucket,
            text: cfg.text.slice(s.start, s.end),
            // Provenance only (the raw source's title): "<work> — <section>".
            title: [cfg.workTitle.trim(), s.title.trim()].filter(Boolean).join(" — ").slice(0, 200),
            hints: {
              ...cfg.hints,
              sourceType: cfg.kind,
              sourceExpert: cfg.author.trim() || cfg.hints.sourceExpert || "",
              sourcePlatform: cfg.hints.sourcePlatform || (cfg.kind === "book" || cfg.kind === "course" ? cfg.kind : ""),
              // Every object of one work shares a tag, so the whole book stays findable.
              ...(tag ? { tags: [tag] } : {}),
            },
            confirmTruth: cfg.confirmTruth,
            // A real chapter title names the object; "Introduction" / "Part 3" is left to the compiler.
            ...(name && !isGenericSectionTitle(name) ? { overrides: { name } } : {}),
          }),
        });
        const proposed = (res.taxonomy ?? []).some((t) => t.status === "proposed");
        if (res.blocked) patch(s.index, { status: "blocked", note: res.blocked.reason });
        else if (res.object) patch(s.index, { status: res.dedup?.decision === "conflict" ? "conflict" : "new", ref: res.object.ref, id: res.object.id, note: undefined, proposed });
        else if (res.target) patch(s.index, { status: res.dedup?.decision === "duplicate" ? "duplicate" : "enriched", ref: res.target.ref, id: res.target.id, note: undefined, proposed });
        else patch(s.index, { status: "failed", note: "The compiler returned no object." });
      } catch (e) {
        patch(s.index, { status: "failed", note: e instanceof Error ? e.message : "Compile failed" });
      }
    },
    [patch]
  );

  const pump = React.useCallback(() => {
    while (aliveRef.current && !pausedRef.current && activeRef.current < CONCURRENCY) {
      // Two parts of one chapter never run together: the second should meet the first in dedup.
      const busyGroups = new Set(secRef.current.filter((s) => s.status === "compiling").map((s) => baseSectionTitle(s.title)));
      const next = secRef.current.find((s) => s.status === "queued" && !busyGroups.has(baseSectionTitle(s.title)));
      if (!next) break;
      activeRef.current++;
      patch(next.index, { status: "compiling", note: undefined });
      void compileOne(next).finally(() => {
        activeRef.current--;
        pump();
      });
    }
  }, [compileOne, patch]);

  function enqueue(pick: (s: BookSection) => boolean) {
    commitSections(secRef.current.map((s) => (pick(s) ? { ...s, status: "queued" as const, note: undefined, open: false } : s)));
    pausedRef.current = false;
    setPaused(false);
    pump();
  }
  function pause() {
    pausedRef.current = true;
    setPaused(true);
  }
  function resume() {
    pausedRef.current = false;
    setPaused(false);
    pump();
  }

  // ---- render -------------------------------------------------------------

  const box = "space-y-3 rounded-xl border border-border bg-surface-muted/40 p-3";
  const count = (st: SectionStatus) => sections.filter((s) => s.status === st).length;
  const toCompile = sections.filter((s) => s.checked && s.status === "idle");
  const inBatch = sections.filter((s) => s.status !== "idle");
  const settled = inBatch.filter((s) => s.status !== "queued" && s.status !== "compiling");
  const failed = count("failed");
  const done = started && !inFlight && !queued;
  const proposals = sections.filter((s) => s.proposed).length;

  if (!outlined) {
    const savedDone = saved ? Object.values(saved.sections).filter((s) => FINISHED.includes(s.status)).length : 0;
    return (
      <div className={box}>
        <div className="flex items-start gap-2.5">
          <span aria-hidden className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent">
            <BookOpen size={16} />
          </span>
          <div className="min-w-0 text-xs text-muted-foreground">
            <p className="text-sm font-semibold text-foreground">Long source</p>
            <p className="mt-0.5">
              This looks like a long source ({Math.round(text.length / 1000).toLocaleString()}k characters). The Brain can split it into chapters and compile each one as its own object — one framework per object, de-duplicated against what it already knows.
            </p>
          </div>
        </div>
        {saved && savedDone > 0 && (
          <div role="status" className="flex flex-wrap items-center gap-2 rounded-xl border border-info/30 bg-info/10 px-3 py-2 text-xs text-foreground">
            <RotateCcw size={14} aria-hidden className="shrink-0 text-info" />
            <span className="min-w-0 flex-1">
              You already started on this source ({fmtDate(saved.savedAt)}): {savedDone} of {Object.keys(saved.sections).length} sections compiled.
            </span>
            <Button size="sm" disabled={outlining || busy} onClick={resumeSaved}>Resume where you left off</Button>
            <Button size="sm" variant="ghost" disabled={outlining || busy} onClick={() => { clearSaved(key); setSaved(null); }}>Start over</Button>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="toolbar" loading={outlining} disabled={outlining || busy} onClick={runOutline}>{!outlining && <ListTree size={14} aria-hidden />} Outline it</Button>
          <Button size="toolbar" variant="secondary" loading={busy} disabled={outlining || busy} onClick={onSingle}>Compile as one object anyway</Button>
          <span className="text-xs text-muted-foreground">
            {text.length > MAX_TEXT_CHARS ? `One object uses only the first ${MAX_TEXT_CHARS.toLocaleString()} characters — the rest is dropped.` : "One object reads the whole source at once."}
          </span>
        </div>
        <div aria-live="polite">{outlining && <Spinner label="Finding the chapters… (about 10–20 s)" className="py-1" />}</div>
        {error && <Alert tone="danger">{error}</Alert>}
      </div>
    );
  }

  const minutes = (perSection: number) => Math.max(1, Math.round((toCompile.length * perSection) / CONCURRENCY / 60));
  const summary = [
    count("new") ? `${count("new")} new` : "",
    count("enriched") ? `${count("enriched")} enriched` : "",
    count("duplicate") ? `${count("duplicate")} duplicate` : "",
    count("conflict") ? `${count("conflict")} conflict` : "",
    count("blocked") ? `${count("blocked")} blocked` : "",
    failed ? `${failed} failed` : "",
  ].filter(Boolean).join(" · ");

  return (
    <div className={box}>
      <div className="flex flex-wrap items-center gap-2">
        <BookOpen size={16} aria-hidden className="text-accent" />
        <span className="text-sm font-semibold text-foreground">{sections.length} sections</span>
        <Badge tone={outlined.via === "model" ? "accent" : "neutral"}>{outlined.via === "model" ? "Outlined by the Brain" : "Split by size"}</Badge>
        <span className="text-xs text-muted-foreground">{Math.round(text.length / 1000).toLocaleString()}k characters</span>
        {!locked && !inFlight && (
          <Button size="sm" variant="ghost" className="ml-auto" onClick={discardOutline}><Undo2 size={12} aria-hidden /> Discard outline</Button>
        )}
      </div>
      {notice && <Alert tone="warning" role="status">{notice}</Alert>}

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Work title"><Input value={workTitle} disabled={locked} onChange={(e) => setWorkTitle(e.target.value)} placeholder="The book / course / report" /></Field>
        <Field label="Author"><Input value={author} disabled={locked} onChange={(e) => setAuthor(e.target.value)} placeholder="Who wrote or taught it" /></Field>
        <Field label="Kind of source"><Select value={kind} disabled={locked} onChange={(e) => setKind(e.target.value)} options={KIND_OPTIONS} /></Field>
      </div>

      {!started && (
        <div className="flex flex-wrap items-center gap-1 text-xs text-muted-foreground">
          <Button size="sm" variant="ghost" onClick={() => commitSections(secRef.current.map((s) => ({ ...s, checked: true })))}>Select all</Button>
          <Button size="sm" variant="ghost" onClick={() => commitSections(secRef.current.map((s) => ({ ...s, checked: false })))}>Select none</Button>
          <span className="pl-1">Each ticked section becomes its own {humanize(cls).toLowerCase()} object — or enriches one the Brain already has.</span>
        </div>
      )}

      <ul className="max-h-[28rem] space-y-1 overflow-auto p-0.5" aria-label="Sections">
        {sections.map((s) => {
          const badge = STATUS_BADGE[s.status];
          const editable = s.status === "idle" && !locked;
          return (
            <li key={s.index} className={cn("rounded-lg border border-border bg-surface px-2.5 py-1.5", s.status === "idle" && !s.checked && "opacity-60")}>
              <div className="flex flex-wrap items-center gap-2">
                <Checkbox aria-label={`Include ${s.title}`} checked={s.checked} disabled={!editable} onChange={(e) => patch(s.index, { checked: e.target.checked })} />
                <span className="w-6 text-right text-xs tabular-nums text-muted-foreground">{s.index + 1}</span>
                <div className="min-w-[10rem] flex-1">
                  <Input density="compact" value={s.title} disabled={!editable} onChange={(e) => patch(s.index, { title: e.target.value })} aria-label={`Title of section ${s.index + 1}`} />
                </div>
                <span className="text-xs tabular-nums text-muted-foreground">{s.chars.toLocaleString()} chars</span>
                {s.status !== "idle" && (
                  <Badge tone={badge.tone} title={s.note}>
                    {s.status === "compiling" && <Loader2 size={12} aria-hidden className="animate-spin" />}
                    {FINISHED.includes(s.status) && <Check size={12} aria-hidden />}
                    {badge.label}
                    {s.ref && s.status !== "duplicate" ? <span className="font-mono">{s.ref}</span> : null}
                  </Badge>
                )}
                {s.id && (
                  <Link
                    href={`/dashboard/knowledge/${s.id}`}
                    target="_blank"
                    className="inline-flex items-center gap-1 rounded-md font-mono text-xs text-accent-strong underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {s.status === "duplicate" ? `${s.ref ?? "Open"}` : "Open"}
                    <ExternalLink size={12} aria-hidden />
                    <span className="sr-only"> (opens in a new tab)</span>
                  </Link>
                )}
                {(s.status === "failed" || s.status === "blocked") && (
                  <Button size="sm" variant="secondary" aria-label={`Retry ${s.title}`} onClick={() => enqueue((x) => x.index === s.index)}><RotateCcw size={12} aria-hidden /> Retry</Button>
                )}
              </div>
              {s.note && (s.status === "failed" || s.status === "blocked") && (
                <p className={cn("mt-1 flex items-start gap-1.5 pl-8 text-xs", s.status === "failed" ? "text-danger" : "text-foreground")}>
                  <AlertTriangle size={12} aria-hidden className={cn("mt-0.5 shrink-0", s.status === "failed" ? "text-danger" : "text-warning")} /> {s.note}
                </p>
              )}
              <details
                open={s.open}
                onToggle={(e) => { const o = e.currentTarget.open; if (o !== s.open) patch(s.index, { open: o }); }}
                className="mt-1 pl-8"
              >
                <summary className="w-fit cursor-pointer rounded-md text-xs text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                  Preview<span className="sr-only"> of {s.title}</span>
                </summary>
                <p className="mt-1 whitespace-pre-line text-xs text-muted-foreground">{s.preview || "(no preview)"}</p>
              </details>
            </li>
          );
        })}
      </ul>

      {started && (
        <div aria-live="polite" className="space-y-1.5">
          <Meter value={settled.length} max={inBatch.length} label="Sections processed" tone="accent" />
          <p className="text-xs tabular-nums text-foreground">
            {settled.length} / {inBatch.length}{summary ? ` · ${summary}` : ""}
            {paused && queued ? <span className="text-muted-foreground"> · paused{inFlight ? " (finishing the sections in flight)" : ""}</span> : null}
          </p>
        </div>
      )}

      {error && <Alert tone="danger">{error}</Alert>}

      <div className="flex flex-wrap items-center gap-2">
        {!locked && toCompile.length > 0 && (
          <Button size="toolbar" onClick={() => enqueue((s) => s.checked && s.status === "idle")}>
            <Play size={14} aria-hidden /> Compile {toCompile.length} {started ? "more " : ""}section{toCompile.length === 1 ? "" : "s"}
          </Button>
        )}
        {running && <Button size="toolbar" variant="secondary" onClick={pause}><Pause size={14} aria-hidden /> Pause</Button>}
        {paused && queued && <Button size="toolbar" onClick={resume}><Play size={14} aria-hidden /> Resume</Button>}
        {!running && failed > 0 && <Button size="toolbar" variant="secondary" onClick={() => enqueue((s) => s.status === "failed")}><RotateCcw size={14} aria-hidden /> Retry failed ({failed})</Button>}
      </div>
      {!locked && toCompile.length > 0 && (
        <Alert tone="warning" role="note" title="Keep this tab open">
          ~45–60 s per section, two at a time — about {minutes(45)}–{minutes(60)} min. Progress is saved in this browser, and re-running a source is safe (the Brain answers Duplicate / Enrich for what it already holds).
        </Alert>
      )}

      {done && (
        <Alert tone="success">
          <p>
            {workTitle ? <span className="font-semibold">{workTitle}</span> : "The source"}: {settled.length} section{settled.length === 1 ? "" : "s"} processed{summary ? ` — ${summary}` : ""}.
            {failed > 0 ? " Retry the failed ones above — the rest is already in the Brain." : ""}
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <Link href="/dashboard/knowledge" className={buttonClass({ size: "toolbar" })}>Open Knowledge objects</Link>
            <Link href="/dashboard/taxonomy" className={buttonClass({ variant: "secondary", size: "toolbar" })}>Review taxonomy proposals{proposals ? ` (${proposals})` : ""}</Link>
            <Button size="toolbar" variant="ghost" onClick={onReset}>Add another</Button>
          </div>
        </Alert>
      )}
    </div>
  );
}
