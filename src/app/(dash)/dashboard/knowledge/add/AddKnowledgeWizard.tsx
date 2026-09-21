"use client";

// Add Knowledge wizard: CLASS → SOURCE → AI REVIEW → SAVED.
//   1. What are you adding? Playbook · Business Reality (bucket) · Platform Intelligence
//   2. The source (paste or file) + light provenance hints
//   3. The compiler's proposal: taxonomy, governance, dedup verdict, entities,
//      relationships and the compiled markdown — every field editable
//   4. Saved: ref + links

import * as React from "react";
import Link from "next/link";
import { BookOpen, Building2, Globe2, Upload, ArrowLeft, ArrowRight, Check, AlertTriangle, Sparkles, Lightbulb } from "lucide-react";
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
  typesFor,
  domainsForClass,
  suggestedSubtypes,
  humanize,
  type IntelligenceClass,
  type RealityBucket,
} from "@/lib/intelligence-taxonomy";
import { C, Chip, KBtn, KInput, KSelect, KTextarea, Field, Panel, ErrorNote, Spinner, api } from "@/components/ui/brain-ui";

type Step = 1 | 2 | 3 | 4;

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

export function AddKnowledgeWizard() {
  const [step, setStep] = React.useState<Step>(1);
  const [cls, setCls] = React.useState<IntelligenceClass | null>(null);
  const [bucket, setBucket] = React.useState<RealityBucket | null>(null);
  const [text, setText] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const [title, setTitle] = React.useState("");
  const [hints, setHints] = React.useState({ sourceExpert: "", sourcePlatform: "", sourceType: "", sourceUrl: "", sourceDate: "", isFounderVoice: false });
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<CompileResponse | null>(null);
  const [draft, setDraft] = React.useState<Draft | null>(null);
  const [forceNew, setForceNew] = React.useState(false);
  const [confirmTruth, setConfirmTruth] = React.useState(false);
  const [blocked, setBlocked] = React.useState<string | null>(null);
  const [result, setResult] = React.useState<CompileResponse | null>(null);

  const canContinue2 = !!cls && (cls !== "business_reality" || !!bucket) && (text.trim().length > 20 || !!file);

  async function runPreview() {
    if (!cls) return;
    setBusy(true);
    setError(null);
    setBlocked(null);
    try {
      let res: CompileResponse;
      if (file) {
        const fd = new FormData();
        fd.append("file", file);
        fd.append("mode", "preview");
        fd.append("class", cls);
        if (bucket) fd.append("bucket", bucket);
        if (title) fd.append("title", title);
        fd.append("hints", JSON.stringify(hints));
        if (confirmTruth) fd.append("confirmTruth", "true");
        const r = await fetch("/api/admin/knowledge/compile", { method: "POST", body: fd });
        res = (await r.json()) as CompileResponse;
        if (!r.ok) throw new Error(res.error ?? "Compile failed");
        // Keep the extracted text for commit (raw source).
        if (res.draft?.teaching_core && !text) setText(res.draft.teaching_core);
      } else {
        res = await api<CompileResponse>("/api/admin/knowledge/compile", {
          method: "POST",
          body: JSON.stringify({ mode: "preview", class: cls, bucket, text, title, hints, confirmTruth }),
        });
      }
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
          hints,
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
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  function reset() {
    setStep(1); setCls(null); setBucket(null); setText(""); setFile(null); setTitle("");
    setHints({ sourceExpert: "", sourcePlatform: "", sourceType: "", sourceUrl: "", sourceDate: "", isFounderVoice: false });
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
                  onClick={() => { setCls(c.id); if (c.id !== "business_reality") setBucket(null); }}
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
          <div className="flex items-center justify-between gap-3">
            <Link href="/dashboard/learning" className="inline-flex items-center gap-1.5 text-xs" style={{ color: C.muted }}>
              <Lightbulb size={13} /> Recording a decision, experiment or result? Use the Learning Lab.
            </Link>
            <KBtn variant="primary" disabled={!cls || (cls === "business_reality" && !bucket)} onClick={() => setStep(2)}>
              Continue <ArrowRight size={14} />
            </KBtn>
          </div>
        </div>
      )}

      {step === 2 && cls && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Panel className="lg:col-span-2" title="The source" subtitle="Paste the transcript, caption, article, report or note. Promotional noise is removed automatically; numbers and names are kept exactly.">
            <div className="space-y-3">
              <KTextarea rows={14} value={text} onChange={(e) => setText(e.target.value)} placeholder="Paste the raw source here… (a canonical .md with frontmatter is also accepted)" disabled={!!file} />
              <div className="flex flex-wrap items-center gap-3">
                <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg px-3 py-2 text-xs" style={{ border: `1px dashed ${C.border}`, color: C.muted }}>
                  <Upload size={14} /> {file ? file.name : "…or upload .md / .txt / .pdf / .csv"}
                  <input type="file" accept=".md,.markdown,.txt,.text,.pdf,.csv,.json" className="hidden" onChange={(e) => setFile(e.target.files?.[0] ?? null)} />
                </label>
                {file && <KBtn size="xs" variant="ghost" onClick={() => setFile(null)}>Remove file</KBtn>}
                <span className="ml-auto text-xs" style={{ color: C.muted }}>{text.length.toLocaleString()} chars</span>
              </div>
              <Field label="Title (optional)"><KInput value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Leave empty to let the Brain name it" /></Field>
            </div>
          </Panel>
          <Panel title="Provenance" subtitle="Where this came from. Optional, but it keeps claims traceable.">
            <div className="space-y-3">
              <Field label="Source expert / author"><KInput value={hints.sourceExpert} onChange={(e) => setHints({ ...hints, sourceExpert: e.target.value })} placeholder="Creator, book, consultant, employee…" /></Field>
              <Field label="Found on (platform)">
                <KSelect value={hints.sourcePlatform} onChange={(e) => setHints({ ...hints, sourcePlatform: e.target.value })} placeholder="—" options={[...PLATFORMS.filter((p) => p !== "universal"), "book", "course", "article", "internal"].map((p) => ({ value: p, label: humanize(p) }))} />
              </Field>
              <Field label="Source type">
                <KSelect value={hints.sourceType} onChange={(e) => setHints({ ...hints, sourceType: e.target.value })} placeholder="—" options={SOURCE_TYPES.map((s) => ({ value: s, label: humanize(s) }))} />
              </Field>
              <Field label="URL"><KInput value={hints.sourceUrl} onChange={(e) => setHints({ ...hints, sourceUrl: e.target.value })} placeholder="https://…" /></Field>
              <Field label="Date"><KInput type="date" value={hints.sourceDate} onChange={(e) => setHints({ ...hints, sourceDate: e.target.value })} /></Field>
              {(bucket === "founder_brain" || cls === "business_reality") && (
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
            <KBtn variant="ghost" onClick={() => setStep(1)}><ArrowLeft size={14} /> Back</KBtn>
            <KBtn variant="primary" disabled={!canContinue2 || busy} loading={busy} onClick={runPreview}>
              <Sparkles size={14} /> {busy ? "Understanding the source…" : "Let the Brain classify it"}
            </KBtn>
          </div>
          {busy && <div className="lg:col-span-3"><Spinner label="Extracting the teaching, classifying, checking for duplicates and compiling the object… (20–60s)" /></div>}
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

function ReviewStep({
  cls, preview, draft, set, forceNew, setForceNew, busy, error, blocked, confirmTruth, setConfirmTruth, onBack, onSave,
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
  onBack: () => void;
  onSave: () => void;
}) {
  const d = preview.dedup;
  const isContent = draft.domain === "content";
  const types = typesFor(cls, draft.domain);
  const subtypeSeeds = suggestedSubtypes(draft.domain, draft.object_type);
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
            <Field label="Domain"><KSelect value={draft.domain} onChange={(e) => set("domain", e.target.value)} options={domainsForClass(cls).map((x) => ({ value: x.id, label: x.label }))} /></Field>
            <Field label="Type"><KSelect value={draft.object_type} onChange={(e) => set("object_type", e.target.value)} options={types.map((t) => ({ value: t.id, label: t.label }))} /></Field>
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
                <Field label="Format"><KSelect value={draft.content_format ?? ""} onChange={(e) => set("content_format", e.target.value || null)} placeholder="—" options={FORMATS.map((f) => ({ value: f, label: humanize(f) }))} /></Field>
                <Field label="Content job"><KSelect value={draft.content_job ?? ""} onChange={(e) => set("content_job", e.target.value || null)} placeholder="—" options={CONTENT_JOBS.map((f) => ({ value: f, label: humanize(f) }))} /></Field>
                <Field label="Funnel stage"><KSelect value={draft.funnel_stage ?? ""} onChange={(e) => set("funnel_stage", e.target.value || null)} placeholder="—" options={FUNNEL_STAGES.map((f) => ({ value: f, label: f.toUpperCase() }))} /></Field>
                <Field label="Brand"><KSelect value={draft.brand ?? ""} onChange={(e) => set("brand", e.target.value || null)} placeholder="—" options={BRANDS.map((f) => ({ value: f, label: humanize(f) }))} /></Field>
                <Field label="Audiences" className="col-span-2"><KInput value={csv(draft.audiences)} onChange={(e) => set("audiences", fromCsv(e.target.value))} placeholder="healthcare_practice_owner" /></Field>
                <Field label="Length"><KSelect value={draft.content_length ?? ""} onChange={(e) => set("content_length", e.target.value || null)} placeholder="—" options={LENGTHS.map((f) => ({ value: f, label: humanize(f) }))} /></Field>
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
