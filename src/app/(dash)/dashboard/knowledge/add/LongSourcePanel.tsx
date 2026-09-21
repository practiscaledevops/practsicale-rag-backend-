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
import { AlertTriangle, BookOpen, Check, ChevronDown, ChevronRight, ListTree, Loader2, Pause, Play, RotateCcw } from "lucide-react";
import { C, Chip, KBtn, KInput, KSelect, Field, ErrorNote, Spinner, api, fmtDate, type Tone } from "@/components/ui/brain-ui";
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

const STATUS_CHIP: Record<SectionStatus, { tone: Tone; label: string }> = {
  idle: { tone: "muted", label: "" },
  queued: { tone: "muted", label: "queued" },
  compiling: { tone: "info", label: "compiling…" },
  new: { tone: "green", label: "NEW" },
  enriched: { tone: "info", label: "ENRICHED" },
  duplicate: { tone: "amber", label: "DUPLICATE" },
  conflict: { tone: "red", label: "CONFLICT" },
  blocked: { tone: "amber", label: "BLOCKED" },
  failed: { tone: "red", label: "failed" },
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

  const box: React.CSSProperties = { background: C.bg, border: `1px solid ${C.border}` };
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
      <div className="space-y-3 rounded-lg p-3" style={box}>
        <div className="flex items-start gap-2">
          <BookOpen size={16} className="mt-0.5 shrink-0" style={{ color: C.green }} />
          <div className="min-w-0 text-xs" style={{ color: C.muted }}>
            <p className="text-sm font-semibold" style={{ color: C.text }}>Long source</p>
            <p className="mt-0.5">
              This looks like a long source ({Math.round(text.length / 1000).toLocaleString()}k characters). The Brain can split it into chapters and compile each one as its own object — one framework per object, de-duplicated against what it already knows.
            </p>
          </div>
        </div>
        {saved && savedDone > 0 && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-xs" style={{ background: "rgba(117,191,255,0.08)", border: "1px solid rgba(117,191,255,0.35)", color: C.text }}>
            <RotateCcw size={13} style={{ color: C.info }} />
            <span>
              You already started on this source ({fmtDate(saved.savedAt)}): {savedDone} of {Object.keys(saved.sections).length} sections compiled.
            </span>
            <KBtn size="xs" variant="primary" disabled={outlining || busy} onClick={resumeSaved}>Resume where you left off</KBtn>
            <KBtn size="xs" variant="ghost" disabled={outlining || busy} onClick={() => { clearSaved(key); setSaved(null); }}>Start over</KBtn>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <KBtn variant="primary" loading={outlining} disabled={outlining || busy} onClick={runOutline}><ListTree size={14} /> Outline it</KBtn>
          <KBtn loading={busy} disabled={outlining || busy} onClick={onSingle}>Compile as one object anyway</KBtn>
          <span className="text-[11px]" style={{ color: C.muted }}>
            {text.length > MAX_TEXT_CHARS ? `One object uses only the first ${MAX_TEXT_CHARS.toLocaleString()} characters — the rest is dropped.` : "One object reads the whole source at once."}
          </span>
        </div>
        <div aria-live="polite">{outlining && <Spinner label="Finding the chapters… (about 10–20 s)" />}</div>
        <ErrorNote message={error} />
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
    <div className="space-y-3 rounded-lg p-3" style={box}>
      <div className="flex flex-wrap items-center gap-2">
        <BookOpen size={16} style={{ color: C.green }} />
        <span className="text-sm font-semibold" style={{ color: C.text }}>{sections.length} sections</span>
        <Chip tone={outlined.via === "model" ? "green" : "amber"}>{outlined.via === "model" ? "Outlined by the Brain" : "Split by size"}</Chip>
        <span className="text-xs" style={{ color: C.muted }}>{Math.round(text.length / 1000).toLocaleString()}k characters</span>
        {!locked && !inFlight && (
          <button type="button" className="ml-auto text-xs underline" style={{ color: C.muted }} onClick={discardOutline}>discard outline · back to the text</button>
        )}
      </div>
      {notice && <p className="text-xs" style={{ color: C.amber }}>{notice}</p>}

      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Work title"><KInput value={workTitle} disabled={locked} onChange={(e) => setWorkTitle(e.target.value)} placeholder="The book / course / report" /></Field>
        <Field label="Author"><KInput value={author} disabled={locked} onChange={(e) => setAuthor(e.target.value)} placeholder="Who wrote or taught it" /></Field>
        <Field label="Kind of source"><KSelect value={kind} disabled={locked} onChange={(e) => setKind(e.target.value)} options={KIND_OPTIONS} /></Field>
      </div>

      {!started && (
        <div className="flex flex-wrap items-center gap-2 text-[11px]" style={{ color: C.muted }}>
          <button type="button" className="underline" onClick={() => commitSections(secRef.current.map((s) => ({ ...s, checked: true })))}>select all</button>
          <button type="button" className="underline" onClick={() => commitSections(secRef.current.map((s) => ({ ...s, checked: false })))}>none</button>
          <span>Each ticked section becomes its own {humanize(cls).toLowerCase()} object — or enriches one the Brain already has.</span>
        </div>
      )}

      <ul className="max-h-[28rem] space-y-1 overflow-auto pr-1">
        {sections.map((s) => {
          const chip = STATUS_CHIP[s.status];
          const editable = s.status === "idle" && !locked;
          return (
            <li key={s.index} className="rounded-lg px-2 py-1.5" style={{ background: C.surface, border: `1px solid ${C.border}`, opacity: s.status === "idle" && !s.checked ? 0.6 : 1 }}>
              <div className="flex flex-wrap items-center gap-2">
                <input type="checkbox" aria-label={`Include ${s.title}`} checked={s.checked} disabled={!editable} onChange={(e) => patch(s.index, { checked: e.target.checked })} />
                <button type="button" aria-label={s.open ? "Hide preview" : "Show preview"} aria-expanded={s.open} onClick={() => patch(s.index, { open: !s.open })} style={{ color: C.muted }}>
                  {s.open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </button>
                <span className="w-6 text-right text-[11px]" style={{ color: C.muted }}>{s.index + 1}</span>
                <div className="min-w-[10rem] flex-1" title={s.preview}>
                  <KInput value={s.title} disabled={!editable} onChange={(e) => patch(s.index, { title: e.target.value })} className="h-7 text-xs" aria-label={`Title of section ${s.index + 1}`} />
                </div>
                <span className="text-[11px]" style={{ color: C.muted }}>{s.chars.toLocaleString()} chars</span>
                {s.status !== "idle" && (
                  <Chip tone={chip.tone} title={s.note}>
                    {s.status === "compiling" && <Loader2 size={11} className="animate-spin" />}
                    {FINISHED.includes(s.status) && <Check size={11} />}
                    {chip.label}
                    {s.ref && s.status !== "duplicate" ? <span className="font-mono">{s.ref}</span> : null}
                  </Chip>
                )}
                {s.id && (
                  <Link href={`/dashboard/knowledge/${s.id}`} target="_blank" className="font-mono text-[11px] underline" style={{ color: C.green }}>
                    {s.status === "duplicate" ? `${s.ref ?? "open"}` : "open"}
                  </Link>
                )}
                {(s.status === "failed" || s.status === "blocked") && (
                  <KBtn size="xs" onClick={() => enqueue((x) => x.index === s.index)}><RotateCcw size={11} /> Retry</KBtn>
                )}
              </div>
              {s.note && (s.status === "failed" || s.status === "blocked") && (
                <p className="mt-1 flex items-start gap-1 pl-12 text-[11px]" style={{ color: s.status === "failed" ? C.red : C.amber }}>
                  <AlertTriangle size={11} className="mt-0.5 shrink-0" /> {s.note}
                </p>
              )}
              {s.open && <p className="mt-1 pl-12 text-[11px]" style={{ color: C.muted }}>{s.preview || "(no preview)"}</p>}
            </li>
          );
        })}
      </ul>

      {started && (
        <div aria-live="polite">
          <div className="h-1.5 overflow-hidden rounded-full" style={{ background: C.raised }} role="progressbar" aria-valuemin={0} aria-valuemax={inBatch.length} aria-valuenow={settled.length}>
            <div className="h-full rounded-full transition-all" style={{ width: `${inBatch.length ? (settled.length / inBatch.length) * 100 : 0}%`, background: C.green }} />
          </div>
          <p className="mt-1 text-xs" style={{ color: C.text }}>
            {settled.length} / {inBatch.length}{summary ? ` · ${summary}` : ""}
            {paused && queued ? <span style={{ color: C.amber }}> · paused{inFlight ? " (finishing the sections in flight)" : ""}</span> : null}
          </p>
        </div>
      )}

      <ErrorNote message={error} />

      <div className="flex flex-wrap items-center gap-2">
        {!locked && toCompile.length > 0 && (
          <KBtn variant="primary" onClick={() => enqueue((s) => s.checked && s.status === "idle")}>
            <Play size={14} /> Compile {toCompile.length} {started ? "more " : ""}section{toCompile.length === 1 ? "" : "s"}
          </KBtn>
        )}
        {running && <KBtn onClick={pause}><Pause size={14} /> Pause</KBtn>}
        {paused && queued && <KBtn variant="primary" onClick={resume}><Play size={14} /> Resume</KBtn>}
        {!running && failed > 0 && <KBtn onClick={() => enqueue((s) => s.status === "failed")}><RotateCcw size={14} /> Retry failed ({failed})</KBtn>}
        {!locked && toCompile.length > 0 && (
          <span className="text-[11px]" style={{ color: C.muted }}>
            ~45–60 s per section, two at a time — about {minutes(45)}–{minutes(60)} min. Keep this tab open; progress is saved in this browser, and re-running a source is safe (the Brain answers DUPLICATE / ENRICH for what it already holds).
          </span>
        )}
      </div>

      {done && (
        <div className="space-y-2 rounded-lg p-3 text-xs" style={{ background: "rgba(0,191,174,0.08)", border: "1px solid rgba(0,191,174,0.35)", color: C.text }}>
          <p>
            <Check size={13} className="mr-1 inline" style={{ color: C.green }} />
            {workTitle ? <span className="font-semibold">{workTitle}</span> : "The source"}: {settled.length} section{settled.length === 1 ? "" : "s"} processed{summary ? ` — ${summary}` : ""}.
            {failed > 0 ? " Retry the failed ones above — the rest is already in the Brain." : ""}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Link href="/dashboard/knowledge"><KBtn variant="primary">Open Knowledge objects</KBtn></Link>
            <Link href="/dashboard/taxonomy"><KBtn>Review taxonomy proposals{proposals ? ` (${proposals})` : ""}</KBtn></Link>
            <KBtn variant="ghost" onClick={onReset}>Add another</KBtn>
          </div>
        </div>
      )}
    </div>
  );
}
