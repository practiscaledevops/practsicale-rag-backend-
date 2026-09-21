"use client";

// Add Knowledge wizard: CLASS → SOURCE → AI REVIEW → SAVED.
//   1. What are you adding? Playbook · Business Reality (bucket) · Platform
//      Intelligence (+ Organizational Learning / Performance Memory pointers),
//      then CLASSIFICATION: Auto (the Brain decides) or choose Domain → Type →
//      Subtype yourself — every value in the taxonomy, plus "+ New" for each.
//   2. The source — paste text, upload a file (PDF / text / audio / screenshot)
//      or give a link / YouTube video; the Brain extracts the text itself via
//      /api/admin/knowledge/extract — + light provenance hints (pre-filled
//      from the extraction where known). A file up to 4 MB is POSTed directly;
//      a bigger one (to 50 MB) goes through secure storage: upload-url → PUT to
//      the signed URL (XHR, real progress + Cancel) → extract { storagePath }.
//      A LONG source (> 40k chars — a book, a course) gets the long-source
//      panel instead of the single-object path: outline → one object per
//      chapter (LongSourcePanel.tsx).
//   3. The compiler's proposal: taxonomy, governance, dedup verdict, entities,
//      relationships and the compiled markdown — every field editable
//   4. Saved: ref + links

import * as React from "react";
import Link from "next/link";
import { BookOpen, Building2, Globe2, ArrowLeft, ArrowRight, Check, AlertTriangle, Sparkles, Lightbulb, LineChart, Plus, Wand2, ListChecks, ClipboardPaste, FileUp, Link2, Youtube, RotateCcw, X } from "lucide-react";
import {
  DOMAINS,
  REALITY_BUCKETS,
  PLATFORMS,
  FORMATS,
  CONTENT_JOBS,
  FUNNEL_STAGES,
  BRANDS,
  LENGTHS,
  SOURCE_TYPES,
  FOUNDER_ENDORSEMENTS,
  PRIORITIES,
  OBJECT_STATUSES,
  INTELLIGENCE_CLASSES,
  typesFor,
  domainsForClass,
  suggestedSubtypes,
  humanize,
  slugify,
  type IntelligenceClass,
  type RealityBucket,
} from "@/lib/intelligence-taxonomy";
import { C, Chip, KBtn, KInput, KSelect, KTextarea, Field, Panel, ErrorNote, Spinner, api, type SelectOption } from "@/components/ui/brain-ui";
import { kindOfFile, isYouTubeUrl, fmtBytes, capText, PROGRESS_LABEL, MAX_TEXT_CHARS, MAX_LONG_TEXT_CHARS, MAX_DIRECT_UPLOAD_BYTES, MAX_STORAGE_UPLOAD_BYTES, MAX_BYTES_BY_KIND, type ExtractKind } from "@/lib/ingest-adapters/pure";
import { LONG_SOURCE_CHARS, sourceKey } from "@/lib/long-source-pure";
import { LongSourcePanel } from "./LongSourcePanel";

type Step = 1 | 2 | 3 | 4;
type SourceMode = "paste" | "file" | "link";

/** What /api/admin/knowledge/extract returns (text kept in the textarea, the rest shown as chips). */
interface ExtractInfo {
  name: string;
  kind: ExtractKind;
  title: string | null;
  chars: number;
  truncated: boolean;
  meta: { source_type?: string; source_platform?: string; source_url?: string; duration_s?: number; pages?: number };
  /** Upload size, for the chip (files only). */
  size?: number;
  /** The cap that trimmed the text (2M from the extractor; 60k once "compile as one object" cut it). */
  cap?: number;
}
/** What /api/admin/knowledge/upload-url returns. */
interface UploadTarget {
  bucket: string;
  path: string;
  signedUrl: string;
  token: string;
}

class UploadCancelled extends Error {}

/**
 * PUT a file to a Supabase signed upload URL — the same request
 * `storage.from(bucket).uploadToSignedUrl(path, token, file)` makes (PUT,
 * multipart body with `cacheControl` + the file, `x-upsert`), but over
 * XMLHttpRequest: `fetch` has no upload progress, and a 50 MB upload takes
 * minutes. The token in the URL is the authorisation; the anon key (public by
 * design) rides along exactly as supabase-js sends it.
 */
function putToSignedUrl(signedUrl: string, file: File, onProgress: (loaded: number, total: number) => void, hold: (xhr: XMLHttpRequest | null) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    hold(xhr);
    xhr.open("PUT", signedUrl);
    xhr.setRequestHeader("x-upsert", "false");
    const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (anon) {
      xhr.setRequestHeader("apikey", anon);
      xhr.setRequestHeader("authorization", `Bearer ${anon}`);
    }
    xhr.upload.onprogress = (e) => onProgress(e.loaded, e.lengthComputable ? e.total : file.size);
    xhr.onload = () => {
      hold(null);
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let msg = "";
      try { msg = (JSON.parse(xhr.responseText) as { message?: string; error?: string }).message ?? ""; } catch { /* not JSON */ }
      reject(new Error(`The upload was refused (${xhr.status}${msg ? ` — ${msg}` : ""}).`));
    };
    xhr.onerror = () => { hold(null); reject(new Error("The upload failed — check your connection and retry.")); };
    xhr.onabort = () => { hold(null); reject(new UploadCancelled("Upload cancelled.")); };
    const body = new FormData();
    body.append("cacheControl", "3600");
    body.append("", file);
    xhr.send(body);
  });
}
interface ExtractResponse extends ExtractInfo {
  text: string;
  error?: string;
}

const KIND_LABEL: Record<ExtractKind, string> = { url: "Web page", youtube: "YouTube", pdf: "PDF", audio: "Audio transcript", image: "Screenshot", text: "Text file" };
const FILE_ACCEPT = ".pdf,.txt,.text,.md,.markdown,.csv,.json,.mp3,.m4a,.wav,.mp4,.webm,.ogg,.mpeg,.mpga,audio/*,.png,.jpg,.jpeg,.webp,.gif,image/*";

interface Draft {
  ref: string;
  name: string;
  intelligence_class: IntelligenceClass;
  domain: string;
  object_type: string;
  subtype: string | null;
  status: string;
  priority: string;
  founder_endorsement: string | null;
  evidence_level: string | null;
  authority: string;
  applies_to: string[];
  goals: string[];
  applies_to_platforms: string[];
  tags: string[];
  content_format: string | null;
  content_job: string | null;
  funnel_stage: string | null;
  brand: string | null;
  audiences: string[];
  content_length: string | null;
  source_expert: string | null;
  source_type: string | null;
  source_platform: string | null;
  source_url: string | null;
  source_date: string | null;
  source_claims: { claim: string; kind?: string }[];
  effective_from: string | null;
  effective_until: string | null;
  summary: string;
  teaching_core: string;
  sections: { heading: string; body: string }[];
  compiled_markdown: string;
  bucket: RealityBucket | null;
}

interface CompileResponse {
  blocked: { reason: string } | null;
  draft: Draft;
  entities: { kind: string; name: string; role?: string | null }[];
  keyConcepts: string[];
  taxonomy: { kind: string; proposed: string; value: string; status: string; reconciledFrom?: string }[];
  neighbors: { id: string; ref: string; name: string; similarity: number; domain: string; object_type: string }[];
  dedup: { decision: "new" | "enrich" | "duplicate" | "conflict"; targetRef: string | null; targetName: string | null; similarity: number | null; rationale: string; conflictSummary: string | null; enrichment: { heading: string; body: string }[] };
  suggestedRelationships: { targetRef: string; targetName: string; type: string; confidence: number; reason: string }[];
  warnings: string[];
  models: Record<string, string>;
  object: { id: string; ref: string; name: string } | null;
  target: { id: string; ref: string; name: string } | null;
  chunks: number;
  error?: string;
  migrationMissing?: boolean;
}

/** A taxonomy value the org added (domain / object_type / subtype …). */
interface TaxValue {
  id: string;
  kind: string;
  intelligence_class: string | null;
  domain: string | null;
  object_type: string | null;
  value: string;
  label: string | null;
  status: "approved" | "proposed" | "rejected";
}

const CLASS_CARDS: { id: IntelligenceClass; icon: React.ReactNode; title: string; question: string; hint: string }[] = [
  { id: "playbook", icon: <BookOpen size={20} />, title: "Playbook", question: "How should we think / what should work?", hint: "A framework, principle, tactic, system, hook, structure… from an expert, a book, a course or our own discovery." },
  { id: "business_reality", icon: <Building2 size={20} />, title: "Business Reality", question: "What is true / what happened?", hint: "Company truth, founder thinking, customer evidence, calls, reports, SOPs, proof, brand voice, approved content." },
  { id: "platform_intelligence", icon: <Globe2 size={20} />, title: "Platform Intelligence", question: "How does a platform work?", hint: "Formats, audience behaviour, hooks, distribution mechanics, constraints and tested learnings for one platform." },
];

function csv(v: string[]): string {
  return v.join(", ");
}
function fromCsv(s: string): string[] {
  return s.split(",").map((x) => x.trim()).filter(Boolean);
}
const opt = (id: string, label?: string): SelectOption => ({ value: id, label: label ?? humanize(id) });

export function AddKnowledgeWizard() {
  const [step, setStep] = React.useState<Step>(1);
  const [cls, setCls] = React.useState<IntelligenceClass | null>(null);
  const [bucket, setBucket] = React.useState<RealityBucket | null>(null);
  const [text, setText] = React.useState("");
  // Source step: paste, or let the Brain extract the text from a file / link.
  const [sourceMode, setSourceMode] = React.useState<SourceMode>("paste");
  const [link, setLink] = React.useState("");
  const [extracting, setExtracting] = React.useState<ExtractKind | null>(null);
  const [extractError, setExtractError] = React.useState<string | null>(null);
  const [extracted, setExtracted] = React.useState<ExtractInfo | null>(null);
  // Big files (> 4 MB) travel through secure storage: real progress, Cancel, Retry.
  const [upload, setUpload] = React.useState<{ loaded: number; total: number } | null>(null);
  const [retryFile, setRetryFile] = React.useState<File | null>(null);
  const xhrRef = React.useRef<XMLHttpRequest | null>(null);
  // Long sources (> 40k chars): outline → one object per chapter, unless the human insists on one object.
  const [singleAnyway, setSingleAnyway] = React.useState(false);
  const [longActive, setLongActive] = React.useState(false);
  const [longRunning, setLongRunning] = React.useState(false);
  const [title, setTitle] = React.useState("");
  const [hints, setHints] = React.useState({ sourceExpert: "", sourcePlatform: "", sourceType: "", sourceUrl: "", sourceDate: "", isFounderVoice: false });
  // Classification: Auto (the Brain decides) or the human's own Domain → Type → Subtype.
  const [classify, setClassify] = React.useState<"auto" | "manual">("auto");
  const [pick, setPick] = React.useState({ domain: "", objectType: "", subtype: "" });
  const [taxonomy, setTaxonomy] = React.useState<TaxValue[]>([]);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<CompileResponse | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [forceNew, setForceNew] = React.useState(false);
  const [confirmTruth, setConfirmTruth] = React.useState(false);
  const [blocked, setBlocked] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<CompileResponse | null>(null);

  const loadTaxonomy = React.useCallback(async () => {
    try {
      const t = await api<{ values: TaxValue[] }>("/api/admin/knowledge/taxonomy");
      setTaxonomy((t.values ?? []).filter((v) => v.status !== "rejected"));
    } catch {
      /* pre-migration: predefined values only */
    }
  }, []);
  React.useEffect(() => { void loadTaxonomy(); }, [loadTaxonomy]);

  const customDomains = React.useMemo(() => taxonomy.filter((v) => v.kind === "domain").map((v) => v.value), [taxonomy]);
  const customTypes = React.useCallback(
    (c: IntelligenceClass | null) => taxonomy.filter((v) => v.kind === "object_type" && (!v.intelligence_class || v.intelligence_class === c)).map((v) => v.value),
    [taxonomy]
  );
  const dbSubtypes = React.useCallback(
    (domain: string, type: string) => taxonomy.filter((v) => v.kind === "subtype" && (!v.domain || v.domain === domain) && (!v.object_type || v.object_type === type)).map((v) => v.value),
    [taxonomy]
  );

  /** The classification hints the compiler honours (manual choices only). */
  const effectiveHints = React.useCallback(
    () => ({
      ...hints,
      ...(classify === "manual"
        ? { domain: pick.domain || undefined, objectType: pick.objectType || undefined, subtype: pick.subtype || undefined }
        : {}),
    }),
    [hints, classify, pick]
  );

  const canContinue2 = !!cls && (cls !== "business_reality" || !!bucket) && text.trim().length > 20 && !extracting;
  // A long source gets the long-source panel instead of the single-object button.
  const isLong = text.length > LONG_SOURCE_CHARS && !singleAnyway;
  // The source's OWN name (PDF title / filename) — stable across reloads, so it can key the saved progress.
  const sourceName = extracted?.title || extracted?.name || "";
  const longKey = React.useMemo(() => (isLong ? sourceKey(sourceName, text) : ""), [isLong, sourceName, text]);

  /** Extracted text → the textarea; provenance → the hint fields that are still empty (a human's choice is never overwritten). */
  function applyExtracted(res: ExtractResponse, size?: number) {
    setSingleAnyway(false);
    setText(res.text);
    setExtracted({ name: res.name, kind: res.kind, title: res.title, chars: res.chars, truncated: res.truncated, meta: res.meta ?? {}, size });
    setHints((h) => ({
      ...h,
      sourceUrl: h.sourceUrl || res.meta?.source_url || "",
      sourcePlatform: h.sourcePlatform || res.meta?.source_platform || "",
      sourceType: h.sourceType || res.meta?.source_type || "",
    }));
    const nameHint = res.kind === "url" || res.kind === "youtube" ? res.title || res.name : res.name;
    setTitle((t) => (t.trim() ? t : nameHint));
  }

  async function extractFile(f: File) {
    const kind = kindOfFile(f.name, f.type);
    if (!kind) {
      setExtractError(`Unsupported file type "${f.name}". Use a PDF, text (.txt .md .csv .json), audio (mp3, m4a, wav, mp4, webm, ogg) or an image (png, jpg, webp, gif).`);
      return;
    }
    setRetryFile(null);
    if (f.size > MAX_STORAGE_UPLOAD_BYTES || f.size > MAX_BYTES_BY_KIND[kind]) {
      setExtractError(
        f.size > MAX_STORAGE_UPLOAD_BYTES || kind === "pdf"
          ? `"${f.name}" is ${fmtBytes(f.size)} — files up to 50 MB are supported.`
          : `"${f.name}" is ${fmtBytes(f.size)} — ${kind} files are limited to ${Math.round(MAX_BYTES_BY_KIND[kind] / (1024 * 1024))} MB.`
      );
      return;
    }
    setExtracting(kind);
    setExtractError(null);
    setExtracted(null);
    try {
      let res: ExtractResponse;
      if (f.size <= MAX_DIRECT_UPLOAD_BYTES) {
        // Small file: straight to the extract route (`full` lifts the 60k cap for the long-source mode).
        const fd = new FormData();
        fd.append("file", f);
        fd.append("full", "true");
        const r = await fetch("/api/admin/knowledge/extract", { method: "POST", body: fd });
        res = (await r.json().catch(() => ({}))) as ExtractResponse;
        if (!r.ok) throw new Error(res.error ?? `Extraction failed (${r.status})`);
      } else {
        // Big file: the hosting platform rejects bodies over ~4.5 MB, so it goes to
        // secure storage first and the extract route reads (then deletes) it there.
        setUpload({ loaded: 0, total: f.size });
        const target = await api<UploadTarget>("/api/admin/knowledge/upload-url", { method: "POST", body: JSON.stringify({ name: f.name, size: f.size, mime: f.type }) });
        await putToSignedUrl(target.signedUrl, f, (loaded, total) => setUpload({ loaded, total }), (x) => { xhrRef.current = x; });
        setUpload(null);
        res = await api<ExtractResponse>("/api/admin/knowledge/extract", { method: "POST", body: JSON.stringify({ storagePath: target.path, name: f.name, mime: f.type, full: true }) });
      }
      applyExtracted(res, f.size);
    } catch (e) {
      if (e instanceof UploadCancelled) setExtractError(null);
      else {
        setExtractError(e instanceof Error ? e.message : "Extraction failed");
        // Retry asks for a FRESH upload URL (the old one may be spent or expired).
        if (f.size > MAX_DIRECT_UPLOAD_BYTES) setRetryFile(f);
      }
    } finally {
      setUpload(null);
      xhrRef.current = null;
      setExtracting(null);
    }
  }

  async function extractLink() {
    const url = link.trim();
    if (!url) return;
    setExtracting(isYouTubeUrl(url) ? "youtube" : "url");
    setExtractError(null);
    setExtracted(null);
    try {
      const res = await api<ExtractResponse>("/api/admin/knowledge/extract", { method: "POST", body: JSON.stringify({ url, full: true }) });
      applyExtracted(res);
    } catch (e) {
      setExtractError(e instanceof Error ? e.message : "Could not fetch the link");
    } finally {
      setExtracting(null);
    }
  }

  /** "Compile as one object anyway": the single-object path reads at most 60k chars — cut here so the box shows what is used. */
  function compileAsOne() {
    const capped = capText(text, MAX_TEXT_CHARS);
    setSingleAnyway(true);
    setText(capped.text);
    if (capped.truncated) setExtracted((x) => (x ? { ...x, truncated: true, cap: MAX_TEXT_CHARS } : x));
    void runPreview(capped.text);
  }

  async function runPreview(sourceText: string = text) {
    if (!cls) return;
    setBusy(true);
    setError(null);
    setBlocked(null);
    const h = effectiveHints();
    try {
      const res = await api<CompileResponse>("/api/admin/knowledge/compile", {
        method: "POST",
        body: JSON.stringify({ mode: "preview", class: cls, bucket, text: sourceText, title, hints: h, confirmTruth }),
      });
      if (res.blocked) {
        setBlocked(res.blocked.reason);
        return;
      }
      setPreview(res);
      setDraft(res.draft);
      setForceNew(false);
      setStep(3);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Compile failed");
    } finally {
      setBusy(false);
    }
  }

  async function commit() {
    if (!cls || !preview || !draft) return;
    setBusy(true);
    setError(null);
    try {
      const overrides = {
        name: draft.name,
        domain: draft.domain,
        object_type: draft.object_type,
        subtype: draft.subtype,
        status: draft.status,
        priority: draft.priority,
        founder_endorsement: draft.founder_endorsement,
        applies_to: draft.applies_to,
        goals: draft.goals,
        applies_to_platforms: draft.applies_to_platforms,
        tags: draft.tags,
        content_format: draft.content_format,
        content_job: draft.content_job,
        funnel_stage: draft.funnel_stage,
        brand: draft.brand,
        audiences: draft.audiences,
        content_length: draft.content_length,
        source_expert: draft.source_expert,
        source_type: draft.source_type,
        source_platform: draft.source_platform,
        source_url: draft.source_url,
        source_date: draft.source_date,
        effective_from: draft.effective_from,
        effective_until: draft.effective_until,
        summary: draft.summary,
        compiled_markdown: draft.compiled_markdown,
      };
      const res = await api<CompileResponse>("/api/admin/knowledge/compile", {
        method: "POST",
        body: JSON.stringify({
          mode: "commit",
          class: cls,
          bucket,
          text: text || preview.draft.teaching_core,
          title,
          hints: effectiveHints(),
          preview,
          overrides,
          forceNew,
          dedupTargetRef: !forceNew && preview.dedup.decision === "enrich" ? preview.dedup.targetRef : null,
          confirmTruth,
        }),
      });
      if (res.blocked) {
        setBlocked(res.blocked.reason);
        return;
      }
      setResult(res);
      setStep(4);
      void loadTaxonomy();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setStep(1); setCls(null); setBucket(null); setText(""); setTitle("");
    setSourceMode("paste"); setLink(""); setExtracting(null); setExtractError(null); setExtracted(null);
    setUpload(null); setRetryFile(null); setSingleAnyway(false); setLongActive(false); setLongRunning(false);
    setHints({ sourceExpert: "", sourcePlatform: "", sourceType: "", sourceUrl: "", sourceDate: "", isFounderVoice: false });
    setClassify("auto"); setPick({ domain: "", objectType: "", subtype: "" });
    setPreview(null); setDraft(null); setResult(null); setError(null); setBlocked(null); setForceNew(false); setConfirmTruth(false);
  }

  const set = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => (d ? { ...d, [k]: v } : d));

  return (
    <div className="space-y-4">
      <Stepper step={step} />

      {step === 1 && (
        <div className="space-y-4">
          <div className="grid gap-3 md:grid-cols-3">
            {CLASS_CARDS.map((c) => {
              const active = cls === c.id;
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => { setCls(c.id); setPick({ domain: "", objectType: "", subtype: "" }); if (c.id !== "business_reality") setBucket(null); }}
                  className="rounded-xl p-4 text-left transition-colors"
                  style={{ background: active ? "rgba(0,191,174,0.10)" : C.surface, border: `1px solid ${active ? C.green : C.border}` }}
                >
                  <div className="flex items-center gap-2" style={{ color: active ? C.green : C.text }}>{c.icon}<span className="text-sm font-semibold">{c.title}</span></div>
                  <p className="mt-1 text-xs font-medium" style={{ color: C.text }}>{c.question}</p>
                  <p className="mt-1 text-xs" style={{ color: C.muted }}>{c.hint}</p>
                </button>
              );
            })}
          </div>
          {/* The other two classes are fed differently — point at their homes. */}
          <div className="grid gap-3 md:grid-cols-2">
            <Link href="/dashboard/learning" className="rounded-xl p-3 transition-colors hover:bg-white/[0.03]" style={{ background: C.surface, border: `1px dashed ${C.border}` }}>
              <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: C.violet }}><Lightbulb size={16} /> Organizational Learning</div>
              <p className="text-xs" style={{ color: C.text }}>What have WE learned? — decisions, implementations, experiments, results, learnings.</p>
              <p className="text-xs" style={{ color: C.muted }}>Recorded in the Learning Lab (or proposed automatically in chat), not uploaded as documents.</p>
            </Link>
            <Link href="/dashboard/performance" className="rounded-xl p-3 transition-colors hover:bg-white/[0.03]" style={{ background: C.surface, border: `1px dashed ${C.border}` }}>
              <div className="flex items-center gap-2 text-sm font-semibold" style={{ color: C.amber }}><LineChart size={16} /> Performance Memory</div>
              <p className="text-xs" style={{ color: C.text }}>What results occurred? — close rate, show rate, content and campaign numbers.</p>
              <p className="text-xs" style={{ color: C.muted }}>Structured metrics, recorded on the Performance memory page.</p>
            </Link>
          </div>

          {cls === "business_reality" && (
            <Panel title="Which kind of reality?" subtitle="Company Truth carries the highest authority and is guarded: an external clip cannot establish it directly.">
              <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {REALITY_BUCKETS.map((b) => {
                  const active = bucket === b.id;
                  return (
                    <button key={b.id} type="button" onClick={() => setBucket(b.id)} className="rounded-lg px-3 py-2 text-left" style={{ background: active ? "rgba(0,191,174,0.10)" : C.bg, border: `1px solid ${active ? C.green : C.border}` }}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-medium" style={{ color: active ? C.green : C.text }}>{b.label}</span>
                        <Chip tone={b.authority.startsWith("A") ? "green" : "amber"}>{b.authority}</Chip>
                      </div>
                      <p className="mt-0.5 text-xs" style={{ color: C.muted }}>{b.description}</p>
                    </button>
                  );
                })}
              </div>
            </Panel>
          )}

          {cls && (
            <ClassificationPanel
              cls={cls}
              mode={classify}
              setMode={setClassify}
              pick={pick}
              setPick={setPick}
              customDomains={customDomains}
              customTypes={customTypes(cls)}
              dbSubtypes={dbSubtypes}
              onAdded={loadTaxonomy}
            />
          )}

          <div className="flex items-center justify-between gap-3">
            <span className="inline-flex items-center gap-1.5 text-xs" style={{ color: C.muted }}>
              <Lightbulb size={13} /> Recording a decision, experiment or result? Use the <Link href="/dashboard/learning" style={{ color: C.green }}>Learning Lab</Link>.
            </span>
            <KBtn variant="primary" disabled={!cls || (cls === "business_reality" && !bucket)} onClick={() => setStep(2)}>
              Continue <ArrowRight size={14} />
            </KBtn>
          </div>
        </div>
      )}

      {step === 2 && cls && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Panel className="lg:col-span-2" title="The source" subtitle="Paste it, upload it or link it — the Brain extracts the text. Promotional noise is removed automatically; numbers and names are kept exactly.">
            <div className="space-y-3">
              <SourceSwitch mode={sourceMode} setMode={(m) => { setSourceMode(m); setExtractError(null); setRetryFile(null); }} disabled={!!extracting || longRunning} />

              {sourceMode === "file" && (
                <label className="flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg px-4 py-5 text-center text-xs focus-within:ring-2 focus-within:ring-[#00BFAE]" style={{ border: `1px dashed ${extracting ? C.green : C.border}`, color: C.muted }}>
                  <FileUp size={18} style={{ color: C.green }} />
                  <span style={{ color: C.text }}>Choose a file — PDF · .txt .md .csv .json · audio (mp3, m4a, wav, mp4, webm, ogg) · image (png, jpg, webp, gif)</span>
                  <span className="text-[11px]">Up to 4 MB uploads directly; larger files (to 50 MB) upload through secure storage automatically. Audio (to 25 MB) is transcribed; screenshots are read by the vision model.</span>
                  {/* sr-only (not display:none) keeps the picker reachable from the keyboard. */}
                  <input type="file" accept={FILE_ACCEPT} className="sr-only" disabled={!!extracting || longRunning} onChange={(e) => { const f = e.target.files?.[0]; if (f) void extractFile(f); e.target.value = ""; }} />
                </label>
              )}

              {sourceMode === "link" && (
                <div className="flex flex-wrap items-center gap-2">
                  <div className="min-w-0 flex-1">
                    <KInput
                      value={link}
                      onChange={(e) => setLink(e.target.value)}
                      placeholder="https://… — an article, a LinkedIn / Instagram / X post, or a YouTube video"
                      disabled={!!extracting}
                      onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void extractLink(); } }}
                    />
                  </div>
                  <KBtn variant="primary" loading={!!extracting} disabled={!link.trim() || !!extracting} onClick={extractLink}>
                    {isYouTubeUrl(link) ? <Youtube size={14} /> : <Link2 size={14} />} Fetch
                  </KBtn>
                </div>
              )}

              <div aria-live="polite" className="space-y-2">
                {extracting && upload && (
                  <div className="space-y-1 py-2">
                    <div className="flex flex-wrap items-center gap-2 text-sm" style={{ color: C.muted }}>
                      <span>
                        Uploading {fmtBytes(upload.loaded)} of {fmtBytes(upload.total)} · {upload.total ? Math.min(100, Math.round((upload.loaded / upload.total) * 100)) : 0}%
                      </span>
                      <KBtn size="xs" variant="ghost" onClick={() => xhrRef.current?.abort()}><X size={11} /> Cancel</KBtn>
                    </div>
                    <div className="h-1.5 overflow-hidden rounded-full" style={{ background: C.raised }} role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={upload.total ? Math.round((upload.loaded / upload.total) * 100) : 0}>
                      <div className="h-full rounded-full transition-all" style={{ width: `${upload.total ? (upload.loaded / upload.total) * 100 : 0}%`, background: C.green }} />
                    </div>
                  </div>
                )}
                {extracting && !upload && <Spinner label={PROGRESS_LABEL[extracting]} />}
                <ErrorNote message={extractError} />
                {retryFile && !extracting && (
                  <KBtn size="xs" onClick={() => void extractFile(retryFile)}><RotateCcw size={11} /> Retry {retryFile.name.length > 40 ? `${retryFile.name.slice(0, 40)}…` : retryFile.name}</KBtn>
                )}
              </div>
              {extracted && !extracting && (
                <div className="flex flex-wrap items-center gap-1.5 text-xs" style={{ color: C.muted }}>
                  <Chip tone="green"><Check size={11} /> {KIND_LABEL[extracted.kind]}</Chip>
                  <span className="max-w-[24rem] truncate" title={extracted.name} style={{ color: C.text }}>{extracted.name}</span>
                  {typeof extracted.size === "number" && <Chip tone="muted">{fmtBytes(extracted.size)}</Chip>}
                  {extracted.meta.pages ? <Chip tone="muted">{extracted.meta.pages} pages</Chip> : null}
                  {extracted.meta.duration_s ? <Chip tone="muted">{fmtDuration(extracted.meta.duration_s)}</Chip> : null}
                  {extracted.meta.source_platform && <Chip tone="info">{humanize(extracted.meta.source_platform)}</Chip>}
                  {extracted.truncated && <Chip tone="amber" title="The source is longer than the Brain reads in one go — the rest was left out."><AlertTriangle size={11} /> Trimmed to {(extracted.cap ?? MAX_LONG_TEXT_CHARS).toLocaleString("en-US")} characters</Chip>}
                  {!longRunning && <button type="button" className="underline" onClick={() => { setExtracted(null); setText(""); setSingleAnyway(false); }}>clear</button>}
                </div>
              )}

              {isLong && (
                <LongSourcePanel
                  key={longKey}
                  resumeKey={longKey}
                  text={text}
                  sourceName={sourceName || title}
                  cls={cls}
                  bucket={bucket}
                  hints={effectiveHints()}
                  confirmTruth={confirmTruth}
                  busy={busy}
                  onSingle={compileAsOne}
                  onActive={setLongActive}
                  onRunning={setLongRunning}
                  onReset={reset}
                />
              )}

              {/* Once a long source is outlined, its sections replace the raw text box (the offsets must not move). */}
              {!(isLong && longActive) && (
                <>
                  <KTextarea
                    rows={isLong ? 8 : 14}
                    value={text}
                    onChange={(e) => {
                      const v = e.target.value;
                      setText(v);
                      // "One object anyway" holds for the text it cut (≤ 60k + the note); a different source gets the choice again.
                      if (v.length <= LONG_SOURCE_CHARS || v.length > MAX_TEXT_CHARS + 500) setSingleAnyway(false);
                    }}
                    placeholder={sourceMode === "paste" ? "Paste the raw source here… (a canonical .md with frontmatter is also accepted)" : "The extracted text appears here — trim it before compiling if you like."}
                    disabled={!!extracting}
                  />
                  <div className="flex flex-wrap items-center gap-3">
                    <span className="ml-auto text-xs" style={{ color: C.muted }}>{text.length.toLocaleString()} chars</span>
                  </div>
                  <Field label="Title (optional)"><KInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Leave empty to let the Brain name it" /></Field>
                </>
              )}
              <div className="flex flex-wrap items-center gap-1.5 text-xs" style={{ color: C.muted }}>
                Classification:
                {classify === "auto" ? (
                  <Chip tone="green"><Sparkles size={11} /> Auto — the Brain decides domain, type and subtype</Chip>
                ) : (
                  <>
                    <Chip tone="info">{pick.domain ? `Domain: ${humanize(pick.domain)}` : "Domain: Auto"}</Chip>
                    <Chip tone="info">{pick.objectType ? `Type: ${humanize(pick.objectType)}` : "Type: Auto"}</Chip>
                    <Chip tone="info">{pick.subtype ? `Subtype: ${humanize(pick.subtype)}` : "Subtype: Auto"}</Chip>
                  </>
                )}
                <button type="button" className="underline" onClick={() => setStep(1)}>change</button>
              </div>
            </div>
          </Panel>
          <Panel title="Provenance" subtitle="Where this came from. Optional, but it keeps claims traceable.">
            <div className="space-y-3">
              <Field label="Source expert / author"><KInput value={hints.sourceExpert} onChange={(e) => setHints({ ...hints, sourceExpert: e.target.value })} placeholder="Creator, book, consultant, employee…" /></Field>
              <Field label="Found on (platform)">
                <KSelect value={hints.sourcePlatform} onChange={(e) => setHints({ ...hints, sourcePlatform: e.target.value })} placeholder="—" options={[...PLATFORMS.filter((p) => p !== "universal"), "book", "course", "article", "internal"].map((p) => opt(p))} />
              </Field>
              <Field label="Source type">
                <KSelect value={hints.sourceType} onChange={(e) => setHints({ ...hints, sourceType: e.target.value })} placeholder="—" options={SOURCE_TYPES.map((s) => opt(s))} />
              </Field>
              <Field label="URL"><KInput value={hints.sourceUrl} onChange={(e) => setHints({ ...hints, sourceUrl: e.target.value })} placeholder="https://…" /></Field>
              <Field label="Date"><KInput type="date" value={hints.sourceDate} onChange={(e) => setHints({ ...hints, sourceDate: e.target.value })} /></Field>
              {cls === "business_reality" && (
                <label className="flex items-center gap-2 text-xs" style={{ color: C.text }}>
                  <input type="checkbox" checked={hints.isFounderVoice} onChange={(e) => setHints({ ...hints, isFounderVoice: e.target.checked })} />
                  These are the founder&apos;s own words (Founder Brain)
                </label>
              )}
              {blocked && (
                <div className="space-y-2 rounded-lg p-3 text-xs" style={{ background: "rgba(243,182,97,0.10)", border: "1px solid rgba(243,182,97,0.4)", color: C.amber }}>
                  <div className="flex items-start gap-2"><AlertTriangle size={14} className="mt-0.5 shrink-0" /><span>{blocked}</span></div>
                  <label className="flex items-center gap-2" style={{ color: C.text }}>
                    <input type="checkbox" checked={confirmTruth} onChange={(e) => setConfirmTruth(e.target.checked)} />
                    I confirm this is verified company information
                  </label>
                </div>
              )}
              <ErrorNote message={error} />
            </div>
          </Panel>
          <div className="flex items-center justify-between gap-3 lg:col-span-3">
            <KBtn variant="ghost" disabled={longRunning} onClick={() => setStep(1)}><ArrowLeft size={14} /> Back</KBtn>
            {/* A long source is driven from its own panel (outline → compile each section). */}
            {!isLong && (
              <KBtn variant="primary" disabled={!canContinue2 || busy} loading={busy} onClick={() => void runPreview()}>
                <Sparkles size={14} /> {busy ? "Understanding the source…" : classify === "auto" ? "Let the Brain classify it" : "Compile with my classification"}
              </KBtn>
            )}
          </div>
          {busy && <div className="lg:col-span-3"><Spinner label="Extracting the substance, classifying, checking for duplicates and compiling the object… (20–60s)" /></div>}
        </div>
      )}

      {step === 3 && preview && draft && cls && (
        <ReviewStep
          cls={cls}
          preview={preview}
          draft={draft}
          set={set}
          forceNew={forceNew}
          setForceNew={setForceNew}
          busy={busy}
          error={error}
          blocked={blocked}
          confirmTruth={confirmTruth}
          setConfirmTruth={setConfirmTruth}
          customDomains={customDomains}
          customTypes={customTypes(cls)}
          dbSubtypes={dbSubtypes}
          onBack={() => setStep(2)}
          onSave={commit}
        />
      )}

      {step === 4 && result && (
        <Panel title="Saved to the Brain">
          <div className="space-y-3">
            {result.object ? (
              <p className="text-sm" style={{ color: C.text }}>
                <Check size={14} className="mr-1 inline" style={{ color: C.green }} />
                Created <span className="font-mono" style={{ color: C.green }}>{result.object.ref}</span> — {result.object.name} ({result.chunks} semantic chunks embedded).
              </p>
            ) : result.target ? (
              <p className="text-sm" style={{ color: C.text }}>
                <Check size={14} className="mr-1 inline" style={{ color: C.green }} />
                {preview?.dedup.decision === "duplicate" ? "Recorded as an additional source on" : "Enriched"} <span className="font-mono" style={{ color: C.green }}>{result.target.ref}</span> — {result.target.name}
                {result.chunks ? ` (${result.chunks} chunks re-embedded)` : ""}.
              </p>
            ) : (
              <p className="text-sm" style={{ color: C.text }}>Done.</p>
            )}
            {result.suggestedRelationships.length > 0 && (
              <p className="text-xs" style={{ color: C.muted }}>{result.suggestedRelationships.length} relationship suggestion(s) are waiting in <Link href="/dashboard/relationships" style={{ color: C.green }}>Relationships</Link>.</p>
            )}
            {result.taxonomy.some((t) => t.status === "proposed") && (
              <p className="text-xs" style={{ color: C.muted }}>A new taxonomy value was proposed — approve it in <Link href="/dashboard/taxonomy" style={{ color: C.green }}>Taxonomy</Link>.</p>
            )}
            <div className="flex gap-2">
              {(result.object ?? result.target) && (
                <Link href={`/dashboard/knowledge/${(result.object ?? result.target)!.id}`}><KBtn variant="primary">Open the object</KBtn></Link>
              )}
              <KBtn onClick={reset}>Add another</KBtn>
            </div>
          </div>
        </Panel>
      )}
    </div>
  );
}

function fmtDuration(s: number): string {
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  return m >= 60 ? `${Math.floor(m / 60)}:${String(m % 60).padStart(2, "0")}:${String(sec).padStart(2, "0")}` : `${m}:${String(sec).padStart(2, "0")}`;
}

const SOURCE_MODES: { id: SourceMode; icon: React.ReactNode; title: string; hint: string }[] = [
  { id: "paste", icon: <ClipboardPaste size={15} />, title: "Paste text", hint: "A transcript, caption, article, report or note." },
  { id: "file", icon: <FileUp size={15} />, title: "Upload a file", hint: "PDF, text, a voice note or call recording, a screenshot." },
  { id: "link", icon: <Link2 size={15} />, title: "From a link", hint: "A web page, a public post, or a YouTube video (captions)." },
];

/** Segmented switch for how the source arrives (same look as the classification switch). */
function SourceSwitch({ mode, setMode, disabled }: { mode: SourceMode; setMode: (m: SourceMode) => void; disabled?: boolean }) {
  return (
    <div className="flex flex-col gap-2 sm:flex-row">
      {SOURCE_MODES.map((m) => {
        const active = mode === m.id;
        return (
          <button key={m.id} type="button" disabled={disabled} onClick={() => setMode(m.id)} className="flex-1 rounded-lg px-3 py-2 text-left disabled:opacity-60" style={{ background: active ? "rgba(0,191,174,0.10)" : C.bg, border: `1px solid ${active ? C.green : C.border}` }}>
            <div className="flex items-center gap-2 text-sm font-medium" style={{ color: active ? C.green : C.text }}>{m.icon}{m.title}</div>
            <p className="text-xs" style={{ color: C.muted }}>{m.hint}</p>
          </button>
        );
      })}
    </div>
  );
}

function Stepper({ step }: { step: Step }) {
  const items = ["What is it?", "Source", "Review", "Saved"];
  return (
    <ol className="flex flex-wrap items-center gap-2 text-xs">
      {items.map((label, i) => {
        const n = (i + 1) as Step;
        const active = n === step;
        const done = n < step;
        return (
          <li key={label} className="flex items-center gap-2">
            <span className="grid h-6 w-6 place-items-center rounded-full text-[11px] font-semibold" style={{ background: active || done ? "rgba(0,191,174,0.18)" : C.raised, color: active || done ? C.green : C.muted, border: `1px solid ${active ? C.green : C.border}` }}>
              {done ? <Check size={12} /> : n}
            </span>
            <span style={{ color: active ? C.text : C.muted }}>{label}</span>
            {i < items.length - 1 && <span style={{ color: C.border }}>—</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** Inline "+ New" for a taxonomy value: POSTs to the taxonomy API, then selects it. */
function AddValue({
  kind,
  label,
  extra,
  onAdded,
}: {
  kind: "domain" | "object_type" | "subtype";
  label: string;
  extra?: Record<string, string | null | undefined>;
  onAdded: (value: string, note: string | null) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [value, setValue] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [err, setErr] = React.useState<string | null>(null);
  async function add() {
    if (!value.trim()) return;
    setBusy(true);
    setErr(null);
    try {
      const r = await api<{ value: string; status: string; created: boolean; reconciledFrom?: string; predefined?: boolean }>("/api/admin/knowledge/taxonomy", {
        method: "POST",
        body: JSON.stringify({ kind, value, label: value, ...extra }),
      });
      const note = !r.created ? `Using the existing value "${humanize(r.value)}" (matches what you typed).` : null;
      onAdded(r.value, note);
      setValue("");
      setOpen(false);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Could not add");
    } finally {
      setBusy(false);
    }
  }
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="inline-flex items-center gap-1 text-[11px]" style={{ color: C.green }}>
        <Plus size={11} /> New {label}
      </button>
    );
  }
  return (
    <div className="mt-1 flex items-center gap-1.5">
      <KInput value={value} onChange={(e) => setValue(e.target.value)} placeholder={`New ${label}…`} className="h-8 text-xs" onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void add(); } }} />
      <KBtn size="xs" variant="primary" loading={busy} disabled={!value.trim() || busy} onClick={add}>Add</KBtn>
      <KBtn size="xs" variant="ghost" onClick={() => { setOpen(false); setErr(null); }}>Cancel</KBtn>
      {err && <span className="text-[11px]" style={{ color: C.red }}>{err}</span>}
    </div>
  );
}

function domainGroups(cls: IntelligenceClass, customDomains: string[]): { label: string; options: SelectOption[] }[] {
  const typical = domainsForClass(cls).map((d) => d.id);
  return [
    { label: `Typical for ${INTELLIGENCE_CLASSES.find((c) => c.id === cls)?.label ?? cls}`, options: DOMAINS.filter((d) => typical.includes(d.id)).map((d) => opt(d.id, d.label)) },
    { label: "All domains", options: DOMAINS.filter((d) => !typical.includes(d.id)).map((d) => opt(d.id, d.label)) },
    { label: "Added by you", options: customDomains.map((d) => opt(d)) },
  ];
}

function typeGroups(cls: IntelligenceClass, customTypes: string[]): { label: string; options: SelectOption[] }[] {
  const all = typesFor(cls, "content");
  return [
    { label: `Types for ${INTELLIGENCE_CLASSES.find((c) => c.id === cls)?.label ?? cls}`, options: all.filter((t) => !t.contentOnly).map((t) => opt(t.id, t.label)) },
    { label: "Content-specialised", options: all.filter((t) => t.contentOnly).map((t) => opt(t.id, t.label)) },
    { label: "Added by you", options: customTypes.map((t) => opt(t)) },
  ];
}

function ClassificationPanel({
  cls,
  mode,
  setMode,
  pick,
  setPick,
  customDomains,
  customTypes,
  dbSubtypes,
  onAdded,
}: {
  cls: IntelligenceClass;
  mode: "auto" | "manual";
  setMode: (m: "auto" | "manual") => void;
  pick: { domain: string; objectType: string; subtype: string };
  setPick: (p: { domain: string; objectType: string; subtype: string }) => void;
  customDomains: string[];
  customTypes: string[];
  dbSubtypes: (domain: string, type: string) => string[];
  onAdded: () => Promise<void> | void;
}) {
  const [note, setNote] = React.useState<string | null>(null);
  const subtypeOptions = React.useMemo(
    () => Array.from(new Set([...suggestedSubtypes(pick.domain, pick.objectType), ...dbSubtypes(pick.domain, pick.objectType)])),
    [pick.domain, pick.objectType, dbSubtypes]
  );
  const seg = (id: "auto" | "manual", icon: React.ReactNode, title: string, hint: string) => {
    const active = mode === id;
    return (
      <button type="button" onClick={() => setMode(id)} className="flex-1 rounded-lg px-3 py-2 text-left" style={{ background: active ? "rgba(0,191,174,0.10)" : C.bg, border: `1px solid ${active ? C.green : C.border}` }}>
        <div className="flex items-center gap-2 text-sm font-medium" style={{ color: active ? C.green : C.text }}>{icon}{title}</div>
        <p className="text-xs" style={{ color: C.muted }}>{hint}</p>
      </button>
    );
  };
  return (
    <Panel title="Classification" subtitle="CLASS → DOMAIN → TYPE → SUBTYPE. Domain is what the knowledge is ABOUT (not where you found it).">
      <div className="space-y-3">
        <div className="flex flex-col gap-2 sm:flex-row">
          {seg("auto", <Sparkles size={15} />, "Auto — the Brain decides", "It reads the source and picks domain, type and subtype (reusing your taxonomy). You review before saving.")}
          {seg("manual", <ListChecks size={15} />, "Choose myself", "Pick any domain, type and subtype — or add new ones. Leave a field blank to let the Brain decide that one.")}
        </div>
        {mode === "manual" && (
          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <Field label="Domain">
                <KSelect value={pick.domain} onChange={(e) => setPick({ ...pick, domain: e.target.value, subtype: "" })} placeholder="Auto (let the Brain decide)" groups={domainGroups(cls, customDomains)} />
              </Field>
              <AddValue kind="domain" label="domain" onAdded={async (v, n) => { await onAdded(); setPick({ ...pick, domain: v }); setNote(n); }} />
            </div>
            <div>
              <Field label="Type">
                <KSelect value={pick.objectType} onChange={(e) => setPick({ ...pick, objectType: e.target.value, subtype: "" })} placeholder="Auto (let the Brain decide)" groups={typeGroups(cls, customTypes)} />
              </Field>
              <AddValue kind="object_type" label="type" extra={{ intelligenceClass: cls }} onAdded={async (v, n) => { await onAdded(); setPick({ ...pick, objectType: v }); setNote(n); }} />
            </div>
            <div>
              <Field label="Subtype" hint={subtypeOptions.length ? `Suggested: ${subtypeOptions.slice(0, 6).map(humanize).join(", ")}` : "Pick domain + type to see suggestions, or type a new one"}>
                <KInput value={pick.subtype} onChange={(e) => setPick({ ...pick, subtype: slugify(e.target.value) || e.target.value })} list="wizard-subtypes" placeholder="Auto, or type e.g. accountability" />
                <datalist id="wizard-subtypes">{subtypeOptions.map((s) => <option key={s} value={s} />)}</datalist>
              </Field>
              <AddValue kind="subtype" label="subtype" extra={{ domain: pick.domain || null, objectType: pick.objectType || null, intelligenceClass: cls }} onAdded={async (v, n) => { await onAdded(); setPick({ ...pick, subtype: v }); setNote(n); }} />
            </div>
          </div>
        )}
        {note && <p className="text-[11px]" style={{ color: C.amber }}>{note}</p>}
        {mode === "manual" && (
          <p className="flex items-center gap-1 text-[11px]" style={{ color: C.muted }}>
            <Wand2 size={11} /> Your choices are locked in; the Brain still extracts the summary, entities, tags and provenance, checks for duplicates and compiles the object.
          </p>
        )}
      </div>
    </Panel>
  );
}

function ReviewStep({
  cls, preview, draft, set, forceNew, setForceNew, busy, error, blocked, confirmTruth, setConfirmTruth, customDomains, customTypes, dbSubtypes, onBack, onSave,
}: {
  cls: IntelligenceClass;
  preview: CompileResponse;
  draft: Draft;
  set: <K extends keyof Draft>(k: K, v: Draft[K]) => void;
  forceNew: boolean;
  setForceNew: (v: boolean) => void;
  busy: boolean;
  error: string | null;
  blocked: string | null;
  confirmTruth: boolean;
  setConfirmTruth: (v: boolean) => void;
  customDomains: string[];
  customTypes: string[];
  dbSubtypes: (domain: string, type: string) => string[];
  onBack: () => void;
  onSave: () => void;
}) {
  const d = preview.dedup;
  const isContent = draft.domain === "content";
  const subtypeSeeds = Array.from(new Set([...suggestedSubtypes(draft.domain, draft.object_type), ...dbSubtypes(draft.domain, draft.object_type)]));
  const verdictTone = d.decision === "new" ? "green" : d.decision === "enrich" ? "info" : d.decision === "duplicate" ? "amber" : "red";
  const saveLabel = forceNew || d.decision === "new" || d.decision === "conflict" ? "Save as new object" : d.decision === "enrich" ? `Enrich ${d.targetRef}` : `Add source to ${d.targetRef}`;

  return (
    <div className="space-y-4">
      {/* Dedup verdict */}
      <div className="rounded-xl p-4" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={verdictTone}>{d.decision.toUpperCase()}</Chip>
          {d.targetRef && (
            <span className="text-sm" style={{ color: C.text }}>
              {d.decision === "conflict" ? "Contradicts" : "Matches"} <span className="font-mono" style={{ color: C.green }}>{d.targetRef}</span> — {d.targetName}
              {typeof d.similarity === "number" && <span style={{ color: C.muted }}> ({Math.round(d.similarity * 100)}% similar)</span>}
            </span>
          )}
          {d.decision === "new" && !d.targetRef && <span className="text-sm" style={{ color: C.muted }}>No existing object covers this — it will be created.</span>}
          {preview.models.classify && <span className="ml-auto text-[11px]" style={{ color: C.muted }}>classified by {preview.models.classify}</span>}
        </div>
        {d.rationale && <p className="mt-1 text-xs" style={{ color: C.muted }}>{d.rationale}</p>}
        {d.conflictSummary && <p className="mt-1 text-xs" style={{ color: C.red }}>{d.conflictSummary}</p>}
        {d.decision === "enrich" && d.enrichment.length > 0 && (
          <div className="mt-2 text-xs" style={{ color: C.text }}>
            Will add to {d.targetRef}: {d.enrichment.map((e) => e.heading).join(" · ")}
          </div>
        )}
        {(d.decision === "enrich" || d.decision === "duplicate") && (
          <label className="mt-2 flex items-center gap-2 text-xs" style={{ color: C.text }}>
            <input type="checkbox" checked={forceNew} onChange={(e) => setForceNew(e.target.checked)} /> Create as a separate new object anyway
          </label>
        )}
        {preview.warnings.length > 0 && (
          <ul className="mt-2 space-y-0.5 text-xs" style={{ color: C.amber }}>
            {preview.warnings.map((w, i) => <li key={i}>• {w}</li>)}
          </ul>
        )}
      </div>

      <div className="grid gap-4 lg:grid-cols-3">
        {/* Classification + governance */}
        <Panel title="Classification" subtitle="CLASS → DOMAIN → TYPE → SUBTYPE. Reuse first; a new subtype goes to the approval queue.">
          <div className="space-y-3">
            <Field label="Name"><KInput value={draft.name} onChange={(e) => set("name", e.target.value)} /></Field>
            <Field label="Domain"><KSelect value={draft.domain} onChange={(e) => set("domain", e.target.value)} groups={domainGroups(cls, customDomains)} /></Field>
            <Field label="Type"><KSelect value={draft.object_type} onChange={(e) => set("object_type", e.target.value)} groups={typeGroups(cls, customTypes)} /></Field>
            <Field label="Subtype" hint={preview.taxonomy.find((t) => t.kind === "subtype")?.status === "proposed" ? "New value — will be proposed for approval." : subtypeSeeds.length ? `Suggested: ${subtypeSeeds.slice(0, 5).map(humanize).join(", ")}` : undefined}>
              <KInput value={draft.subtype ?? ""} onChange={(e) => set("subtype", e.target.value || null)} list="subtype-seeds" placeholder="e.g. accountability" />
              <datalist id="subtype-seeds">{subtypeSeeds.map((s) => <option key={s} value={s} />)}</datalist>
            </Field>
            <Field label="Applies to" hint="comma separated"><KInput value={csv(draft.applies_to)} onChange={(e) => set("applies_to", fromCsv(e.target.value))} placeholder="managers, team_leaders" /></Field>
            <Field label="Goals"><KInput value={csv(draft.goals)} onChange={(e) => set("goals", fromCsv(e.target.value))} placeholder="accountability, ownership" /></Field>
            <Field label="Applies to platforms" hint="Only when the teaching itself is platform-specific"><KInput value={csv(draft.applies_to_platforms)} onChange={(e) => set("applies_to_platforms", fromCsv(e.target.value))} placeholder="linkedin" /></Field>
            <Field label="Tags"><KInput value={csv(draft.tags)} onChange={(e) => set("tags", fromCsv(e.target.value))} /></Field>
            {isContent && (
              <div className="grid grid-cols-2 gap-2 rounded-lg p-2" style={{ border: `1px solid ${C.border}` }}>
                <Field label="Format"><KSelect value={draft.content_format ?? ""} onChange={(e) => set("content_format", e.target.value || null)} placeholder="—" options={FORMATS.map((f) => opt(f))} /></Field>
                <Field label="Content job"><KSelect value={draft.content_job ?? ""} onChange={(e) => set("content_job", e.target.value || null)} placeholder="—" options={CONTENT_JOBS.map((f) => opt(f))} /></Field>
                <Field label="Funnel stage"><KSelect value={draft.funnel_stage ?? ""} onChange={(e) => set("funnel_stage", e.target.value || null)} placeholder="—" options={FUNNEL_STAGES.map((f) => ({ value: f, label: f.toUpperCase() }))} /></Field>
                <Field label="Brand"><KSelect value={draft.brand ?? ""} onChange={(e) => set("brand", e.target.value || null)} placeholder="—" options={BRANDS.map((f) => opt(f))} /></Field>
                <Field label="Audiences" className="col-span-2"><KInput value={csv(draft.audiences)} onChange={(e) => set("audiences", fromCsv(e.target.value))} placeholder="healthcare_practice_owner" /></Field>
                <Field label="Length"><KSelect value={draft.content_length ?? ""} onChange={(e) => set("content_length", e.target.value || null)} placeholder="—" options={LENGTHS.map((f) => opt(f))} /></Field>
              </div>
            )}
          </div>
        </Panel>

        <Panel title="Governance & provenance" subtitle="Do I believe in it? Have we used it? Did it work? Kept as three separate questions.">
          <div className="space-y-3">
            {(cls === "playbook" || cls === "platform_intelligence") && (
              <Field label="Founder endorsement">
                <KSelect value={draft.founder_endorsement ?? "interested"} onChange={(e) => set("founder_endorsement", e.target.value || null)} options={FOUNDER_ENDORSEMENTS.map((x) => ({ value: x.id, label: `${x.label} — ${x.hint}` }))} />
              </Field>
            )}
            <div className="grid grid-cols-2 gap-2">
              <Field label="Priority"><KSelect value={draft.priority} onChange={(e) => set("priority", e.target.value)} options={PRIORITIES.map((p) => ({ value: p.id, label: p.label }))} /></Field>
              <Field label="Status"><KSelect value={draft.status} onChange={(e) => set("status", e.target.value)} options={OBJECT_STATUSES.map((s) => ({ value: s.id, label: s.label }))} /></Field>
            </div>
            <div className="flex items-center gap-2 text-xs" style={{ color: C.muted }}>
              Authority <Chip tone={draft.authority.startsWith("A") ? "green" : draft.authority.startsWith("B") ? "info" : "amber"}>{draft.authority}</Chip>
              {draft.evidence_level && <Chip tone="muted">{humanize(draft.evidence_level)}</Chip>}
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Effective from"><KInput type="date" value={draft.effective_from?.slice(0, 10) ?? ""} onChange={(e) => set("effective_from", e.target.value || null)} /></Field>
              <Field label="Effective until"><KInput type="date" value={draft.effective_until?.slice(0, 10) ?? ""} onChange={(e) => set("effective_until", e.target.value || null)} /></Field>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <Field label="Source expert"><KInput value={draft.source_expert ?? ""} onChange={(e) => set("source_expert", e.target.value || null)} /></Field>
              <Field label="Found on"><KInput value={draft.source_platform ?? ""} onChange={(e) => set("source_platform", e.target.value || null)} /></Field>
              <Field label="Source type"><KInput value={draft.source_type ?? ""} onChange={(e) => set("source_type", e.target.value || null)} /></Field>
              <Field label="Source date"><KInput type="date" value={draft.source_date ?? ""} onChange={(e) => set("source_date", e.target.value || null)} /></Field>
              <Field label="URL" className="col-span-2"><KInput value={draft.source_url ?? ""} onChange={(e) => set("source_url", e.target.value || null)} /></Field>
            </div>
            {draft.source_claims.length > 0 && (
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider" style={{ color: C.muted }}>Source claims (kept as claims, never facts)</p>
                <ul className="space-y-1 text-xs" style={{ color: C.text }}>
                  {draft.source_claims.slice(0, 8).map((c, i) => <li key={i}>• {c.claim} <span style={{ color: C.muted }}>({c.kind ?? "claim"}, unverified)</span></li>)}
                </ul>
              </div>
            )}
            {preview.entities.length > 0 && (
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider" style={{ color: C.muted }}>Entities found</p>
                <div className="flex flex-wrap gap-1">{preview.entities.slice(0, 20).map((e, i) => <Chip key={i} tone="muted" title={e.role ?? undefined}>{humanize(e.kind)}: {e.name}</Chip>)}</div>
              </div>
            )}
            {preview.suggestedRelationships.length > 0 && (
              <div>
                <p className="mb-1 text-[11px] font-semibold uppercase tracking-wider" style={{ color: C.muted }}>Possible relationships (saved as suggestions to review)</p>
                <ul className="space-y-1 text-xs" style={{ color: C.text }}>
                  {preview.suggestedRelationships.map((r, i) => <li key={i}>• {humanize(r.type)} <span className="font-mono" style={{ color: C.green }}>{r.targetRef}</span> {r.targetName} <span style={{ color: C.muted }}>({Math.round(r.confidence * 100)}%)</span></li>)}
                </ul>
              </div>
            )}
          </div>
        </Panel>

        <Panel title="Compiled object" subtitle="The canonical markdown the Brain will chunk by section. Edit freely." padded={false}>
          <div className="p-3">
            <Field label="Summary"><KTextarea rows={3} value={draft.summary} onChange={(e) => set("summary", e.target.value)} /></Field>
          </div>
          <KTextarea rows={26} value={draft.compiled_markdown} onChange={(e) => set("compiled_markdown", e.target.value)} className="rounded-none border-0 border-t font-mono text-xs" style={{ background: C.bg }} />
        </Panel>
      </div>

      {blocked && (
        <div className="space-y-2 rounded-lg p-3 text-xs" style={{ background: "rgba(243,182,97,0.10)", border: "1px solid rgba(243,182,97,0.4)", color: C.amber }}>
          <div className="flex items-start gap-2"><AlertTriangle size={14} className="mt-0.5 shrink-0" /><span>{blocked}</span></div>
          <label className="flex items-center gap-2" style={{ color: C.text }}>
            <input type="checkbox" checked={confirmTruth} onChange={(e) => setConfirmTruth(e.target.checked)} /> I confirm this is verified company information
          </label>
        </div>
      )}
      <ErrorNote message={error} />
      <div className="flex items-center justify-between gap-3">
        <KBtn variant="ghost" onClick={onBack}><ArrowLeft size={14} /> Back to source</KBtn>
        <KBtn variant="primary" loading={busy} disabled={busy || !draft.name.trim()} onClick={onSave}><Check size={14} /> {saveLabel}</KBtn>
      </div>
    </div>
  );
}
