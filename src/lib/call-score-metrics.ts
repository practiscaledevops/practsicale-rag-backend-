// Call scores → Performance Memory.
//
// The call-scoring connector ingests one document per scored call (source_type
// "call_score") with rich structured metadata: consultant, overall_score, ten
// phase_scores, call_outcome/status, performance_band, practice_type, talk_ratio,
// duration. That data is searchable as text, but the Brain reasons far better
// when it also has the NUMBERS. This turns those calls into:
//   • entities        — one person per consultant (+ market entities per segment)
//   • metrics         — company / per-consultant / per-segment aggregates
//   • one knowledge object — "Sales Call Performance — Team Snapshot" (business
//                       reality / sales / report, authority A2), so the aggregate
//                       is a first-class, retrievable, cite-able object too.
//
// Idempotent: rebuilds replace the prior call_scores metrics and update the same
// snapshot object in place. Called by the rebuild endpoint and the cron after a
// call-scoring sync. Server-only.

import type { SupabaseClient } from "@supabase/supabase-js";
import { ingestOne, reingestDocument } from "@/lib/ingest";
import { embed } from "@/lib/embeddings";
import {
  upsertEntity,
  nextRef,
  buildFrontmatter,
  assembleMarkdown,
  splitSections,
  objectContextLine,
  objectEmbeddingText,
  OBJECT_COLUMNS,
  type MarkdownSection,
  type KnowledgeObjectRow,
} from "@/lib/knowledge-store";
import { slugify, humanize } from "@/lib/intelligence-taxonomy";

// The ten scoring phases, in the order PractiScale's call model runs them.
const PHASES = [
  "open_and_frame",
  "discovery",
  "feel_the_gap",
  "consequence",
  "reframe",
  "social_proof",
  "anchor_and_buildout",
  "objection_handling",
  "withdraw_and_qualify",
  "close",
] as const;

interface CallRow {
  consultant: string;
  consultantId: string | null;
  score: number | null;
  won: boolean;
  outcome: string;
  band: string;
  practice: string;
  phases: Record<string, number>;
  durationMin: number | null;
  consultantTalkPct: number | null;
}

interface Agg {
  calls: number;
  scoreSum: number;
  scoreN: number;
  won: number;
  phaseSum: Record<string, number>;
  phaseN: Record<string, number>;
  bands: Record<string, number>;
  durSum: number;
  durN: number;
  talkSum: number;
  talkN: number;
}
type ConsultantAgg = Agg & { id: string | null; name: string };
type SegmentAgg = Agg & { name: string };

function num(v: unknown): number | null {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}
function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : v == null ? "" : String(v);
}
/** A call counts as WON when the pipeline marks it closed/won (not a follow-up). */
function isWon(status: string, outcome: string): boolean {
  const s = (status + " " + outcome).toLowerCase();
  if (/follow.?up|not.?clos|no.?show|lost|reschedul|pending|disqualif/.test(s)) return false;
  return /clos|won|deal|signed|booked|converted/.test(s);
}
function avg(sum: number, n: number): number {
  return n > 0 ? sum / n : 0;
}
function round(n: number, d = 1): number {
  const f = 10 ** d;
  return Math.round(n * f) / f;
}

export interface CallMetricsResult {
  calls: number;
  consultants: number;
  segments: number;
  metricsWritten: number;
  entitiesUpserted: number;
  snapshotRef: string | null;
  closeRate: number;
  avgScore: number;
}

/**
 * Rebuild Performance Memory from every call_score document for an org.
 */
export async function rebuildCallScoreMetrics(
  db: SupabaseClient,
  orgId: string,
  opts: { createdBy?: string | null } = {}
): Promise<CallMetricsResult> {
  // 1. Pull every call_score document's metadata (paginated).
  const rows: CallRow[] = [];
  const pageSize = 1000;
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await db
      .from("documents")
      .select("metadata")
      .eq("org_id", orgId)
      .eq("source_type", "call_score")
      .range(from, from + pageSize - 1);
    if (error) throw new Error(error.message);
    const batch = (data ?? []) as { metadata: Record<string, unknown> }[];
    for (const d of batch) {
      const m = d.metadata ?? {};
      const consultant = str(m.consultant_name) || str(m.consultant) || "Unknown";
      const phases: Record<string, number> = {};
      const ps = (m.phase_scores ?? {}) as Record<string, unknown>;
      for (const p of Object.keys(ps)) {
        const n = num(ps[p]);
        if (n != null) phases[p] = n;
      }
      const talk = (m.talk_ratio ?? {}) as Record<string, unknown>;
      rows.push({
        consultant,
        consultantId: str(m.consultant_id) || null,
        score: num(m.overall_score),
        won: isWon(str(m.call_status), str(m.call_outcome)),
        outcome: str(m.call_outcome),
        band: str(m.performance_band) || "Unrated",
        practice: str(m.practice_type) || "Unspecified",
        phases,
        durationMin: num(m.call_duration_minutes),
        consultantTalkPct: num(talk.consultant_pct),
      });
    }
    if (batch.length < pageSize) break;
  }

  const calls = rows.length;
  if (calls === 0) {
    return { calls: 0, consultants: 0, segments: 0, metricsWritten: 0, entitiesUpserted: 0, snapshotRef: null, closeRate: 0, avgScore: 0 };
  }

  // 2. Aggregate.
  const blank = (): Agg => ({ calls: 0, scoreSum: 0, scoreN: 0, won: 0, phaseSum: {}, phaseN: {}, bands: {}, durSum: 0, durN: 0, talkSum: 0, talkN: 0 });
  const add = (a: Agg, r: CallRow) => {
    a.calls++;
    if (r.score != null) { a.scoreSum += r.score; a.scoreN++; }
    if (r.won) a.won++;
    for (const [p, v] of Object.entries(r.phases)) { a.phaseSum[p] = (a.phaseSum[p] ?? 0) + v; a.phaseN[p] = (a.phaseN[p] ?? 0) + 1; }
    a.bands[r.band] = (a.bands[r.band] ?? 0) + 1;
    if (r.durationMin != null) { a.durSum += r.durationMin; a.durN++; }
    if (r.consultantTalkPct != null) { a.talkSum += r.consultantTalkPct; a.talkN++; }
  };

  const company = blank();
  const byConsultant = new Map<string, ConsultantAgg>();
  const bySegment = new Map<string, SegmentAgg>();
  for (const r of rows) {
    add(company, r);
    const ck = slugify(r.consultant) || "unknown";
    if (!byConsultant.has(ck)) byConsultant.set(ck, Object.assign(blank(), { id: r.consultantId, name: r.consultant }));
    add(byConsultant.get(ck)!, r);
    const sk = slugify(r.practice) || "unspecified";
    if (!bySegment.has(sk)) bySegment.set(sk, Object.assign(blank(), { name: r.practice }));
    add(bySegment.get(sk)!, r);
  }

  const phaseAvg = (a: Agg) => Object.fromEntries(PHASES.filter((p) => a.phaseN[p]).map((p) => [p, round(avg(a.phaseSum[p], a.phaseN[p]), 1)]));
  const weakestPhases = (a: Agg, k = 3) => Object.entries(phaseAvg(a)).sort((x, y) => x[1] - y[1]).slice(0, k);
  const strongestPhases = (a: Agg, k = 3) => Object.entries(phaseAvg(a)).sort((x, y) => y[1] - x[1]).slice(0, k);

  const companyAvgScore = round(avg(company.scoreSum, company.scoreN), 1);
  const companyCloseRate = round((company.won / company.calls) * 100, 1);

  // 3. Consultant entities.
  let entitiesUpserted = 0;
  const consultantEntityId = new Map<string, string | null>();
  for (const [ck, a] of byConsultant) {
    const id = await upsertEntity(db, orgId, {
      kind: "person",
      name: a.name,
      attributes: {
        role: "consultant",
        consultant_id: a.id ?? undefined,
        calls_scored: a.calls,
        avg_score: round(avg(a.scoreSum, a.scoreN), 1),
        close_rate_pct: round((a.won / a.calls) * 100, 1),
      },
    });
    consultantEntityId.set(ck, id);
    if (id) entitiesUpserted++;
  }
  for (const [, a] of bySegment) {
    const id = await upsertEntity(db, orgId, { kind: "market", name: a.name, attributes: { calls: a.calls } });
    if (id) entitiesUpserted++;
  }

  // 4. Metrics — replace the prior call_scores set (idempotent), then bulk insert.
  await db.from("metrics").delete().eq("org_id", orgId).eq("source", "call_scores");
  const now = new Date().toISOString().slice(0, 10);
  const M: Record<string, unknown>[] = [];
  const metric = (metric_key: string, value: number, extra: Record<string, unknown> = {}) =>
    // dimensions is NOT NULL: always supply it (a bulk insert of mixed rows would
    // otherwise send null for rows that omit the key, overriding the DB default).
    M.push({ org_id: orgId, metric_key, value, source: "call_scores", period_end: now, created_by: opts.createdBy ?? null, dimensions: {}, ...extra });

  // Company-wide
  metric("avg_call_score", companyAvgScore, { label: "Average call score (all consultants)", unit: "/100" });
  metric("close_rate", companyCloseRate, { label: "Close rate (all calls)", unit: "%" });
  metric("calls_scored", company.calls, { label: "Calls scored", unit: "calls" });
  if (company.durN) metric("avg_call_duration", round(avg(company.durSum, company.durN), 0), { label: "Average call duration", unit: "min" });
  if (company.talkN) metric("avg_consultant_talk_ratio", round(avg(company.talkSum, company.talkN), 0), { label: "Average consultant talk ratio", unit: "%" });
  for (const [p, v] of Object.entries(phaseAvg(company))) metric(`phase_${p}`, v, { label: `Phase score — ${humanize(p)} (team avg)`, unit: "/10" });
  for (const [band, n] of Object.entries(company.bands)) metric("performance_band_share", round((n / company.calls) * 100, 1), { label: `Consultants in band: ${band}`, unit: "%", dimensions: { band } });

  // Per consultant
  for (const [ck, a] of byConsultant) {
    const dims = { consultant: a.name, calls: a.calls, weakest_phase: weakestPhases(a, 1)[0]?.[0] ?? null };
    const eid = consultantEntityId.get(ck) ?? null;
    metric("consultant_avg_score", round(avg(a.scoreSum, a.scoreN), 1), { label: `${a.name} — average call score`, unit: "/100", entity_id: eid, dimensions: dims });
    metric("consultant_close_rate", round((a.won / a.calls) * 100, 1), { label: `${a.name} — close rate`, unit: "%", entity_id: eid, dimensions: dims });
  }

  // Per segment (practice type)
  for (const [, a] of bySegment) {
    const dims = { practice_type: a.name, calls: a.calls };
    metric("segment_close_rate", round((a.won / a.calls) * 100, 1), { label: `${a.name} — close rate`, unit: "%", dimensions: dims });
    metric("segment_avg_score", round(avg(a.scoreSum, a.scoreN), 1), { label: `${a.name} — average call score`, unit: "/100", dimensions: dims });
  }

  if (M.length) {
    const { error } = await db.from("metrics").insert(M);
    if (error) throw new Error(`metrics insert: ${error.message}`);
  }

  // 5. The snapshot knowledge object (deterministic markdown → retrievable + cite-able).
  const snapshotRef = await upsertSnapshotObject(db, orgId, {
    company,
    companyAvgScore,
    companyCloseRate,
    phaseAvg: phaseAvg(company),
    weakest: weakestPhases(company),
    strongest: strongestPhases(company),
    byConsultant,
    bySegment,
    weakestFor: (a: Agg) => weakestPhases(a, 1)[0]?.[0] ?? null,
    createdBy: opts.createdBy ?? null,
  });

  return {
    calls,
    consultants: byConsultant.size,
    segments: bySegment.size,
    metricsWritten: M.length,
    entitiesUpserted,
    snapshotRef,
    closeRate: companyCloseRate,
    avgScore: companyAvgScore,
  };
}

// ---------------------------------------------------------------------------
// Snapshot knowledge object
// ---------------------------------------------------------------------------

interface SnapshotInput {
  company: Agg;
  companyAvgScore: number;
  companyCloseRate: number;
  phaseAvg: Record<string, number>;
  weakest: [string, number][];
  strongest: [string, number][];
  byConsultant: Map<string, ConsultantAgg>;
  bySegment: Map<string, SegmentAgg>;
  weakestFor: (a: Agg) => string | null;
  createdBy: string | null;
}

async function upsertSnapshotObject(db: SupabaseClient, orgId: string, d: SnapshotInput): Promise<string | null> {
  const phaseRows = (Object.entries(d.phaseAvg) as [string, number][])
    .sort((a, b) => b[1] - a[1])
    .map(([p, v]) => `| ${humanize(p)} | ${v} / 10 |`)
    .join("\n");

  const consultantRows = Array.from(d.byConsultant.values())
    .map((a) => ({
      name: a.name,
      calls: a.calls,
      score: round(avg(a.scoreSum, a.scoreN), 1),
      close: round((a.won / a.calls) * 100, 1),
      band: Object.entries(a.bands).sort((x, y) => y[1] - x[1])[0]?.[0] ?? "—",
      weakest: humanize(d.weakestFor(a) ?? ""),
    }))
    .sort((x, y) => y.score - x.score)
    .map((c) => `| ${c.name} | ${c.calls} | ${c.score} | ${c.close}% | ${c.band} | ${c.weakest} |`)
    .join("\n");

  const segmentRows = Array.from(d.bySegment.values())
    .map((a) => `| ${a.name} | ${a.calls} | ${round((a.won / a.calls) * 100, 1)}% | ${round(avg(a.scoreSum, a.scoreN), 1)} |`)
    .join("\n");

  const sections: MarkdownSection[] = [
    {
      heading: "Summary",
      body: `Current team performance from ${d.company.calls} scored sales calls. Team average call score ${d.companyAvgScore}/100; close rate ${d.companyCloseRate}%. Weakest phases across the team: ${d.weakest.map((w) => `${humanize(w[0])} (${w[1]}/10)`).join(", ")}. This is an auto-generated snapshot from the call-scoring data; the numbers are current as of the generation date.`,
    },
    {
      heading: "Key Facts",
      body: [
        `- Calls scored: ${d.company.calls}`,
        `- Team average call score: ${d.companyAvgScore} / 100`,
        `- Close rate: ${d.companyCloseRate}%`,
        d.company.durN ? `- Average call duration: ${round(avg(d.company.durSum, d.company.durN), 0)} min` : "",
        d.company.talkN ? `- Average consultant talk ratio: ${round(avg(d.company.talkSum, d.company.talkN), 0)}%` : "",
        `- Strongest phases: ${d.strongest.map((s) => `${humanize(s[0])} (${s[1]}/10)`).join(", ")}`,
        `- Weakest phases: ${d.weakest.map((w) => `${humanize(w[0])} (${w[1]}/10)`).join(", ")}`,
      ].filter(Boolean).join("\n"),
    },
    { heading: "Phase Performance", body: `Average score per call phase (0–10), team-wide:\n\n| Phase | Team average |\n|---|---|\n${phaseRows}` },
    { heading: "Consultant Scorecard", body: `Per-consultant performance, best average first:\n\n| Consultant | Calls | Avg score | Close rate | Top band | Weakest phase |\n|---|---|---|---|---|---|\n${consultantRows}` },
    { heading: "Segment Performance", body: `Performance by practice type / market segment:\n\n| Segment | Calls | Close rate | Avg score |\n|---|---|---|---|\n${segmentRows}` },
    { heading: "Evidence Notes", body: "Aggregated from the individual scored-call records in the call-scoring data (source_type call_score). Each call carries its own detailed QA report, cited separately. Treat these numbers as the current team baseline; they refresh whenever call scores are re-synced." },
  ];

  const name = "Sales Call Performance — Team Snapshot";
  const meta: Partial<KnowledgeObjectRow> & { intelligence_class: "business_reality" } = {
    intelligence_class: "business_reality",
    domain: "sales",
    object_type: "report",
    subtype: "call_performance",
    status: "active",
    priority: "core",
    founder_endorsement: null,
    implementation_status: "not_tested",
    internal_validation: "validated",
    evidence_level: "internal_data",
    authority: "A2",
    applies_to: ["sales", "consultants", "management"],
    goals: ["coaching", "training", "performance_review"],
    business_functions: ["sales"],
    tags: ["call_scores", "performance", "coaching", "close_rate", "phase_scores"],
    source_type: "internal_report",
    source_platform: "call-scoring",
  };
  const summary = `Team average call score ${d.companyAvgScore}/100, close rate ${d.companyCloseRate}% across ${d.company.calls} scored calls; weakest phases ${d.weakest.map((w) => humanize(w[0])).join(", ")}.`;
  const nowIso = new Date().toISOString();

  // Existing snapshot object? (attributes.snapshot = 'call_scores')
  const { data: existingRow } = await db
    .from("knowledge_objects")
    .select("id, ref, document_id, version")
    .eq("org_id", orgId)
    .eq("attributes->>snapshot", "call_scores")
    .limit(1)
    .maybeSingle();
  const existing = existingRow as { id: string; ref: string; document_id: string | null; version: number } | null;

  const ref = existing?.ref ?? (await nextRef(db, orgId, "BR-SAL"));
  const version = (existing?.version ?? 0) + 1;
  const fm = buildFrontmatter({ ...meta, ref, name, version, last_verified_at: nowIso });
  const md = assembleMarkdown(fm, name, sections);
  const contextPrefix = objectContextLine({ ref, name, ...meta });
  const emb = await embed(objectEmbeddingText(name, summary, sections));
  const objectPatch: Record<string, unknown> = {
    ...meta,
    ref,
    name,
    summary,
    compiled_markdown: md,
    version,
    last_verified_at: nowIso,
    attributes: { snapshot: "call_scores", generated_at: nowIso },
    ...(emb.some((v) => v !== 0) ? { embedding: emb } : {}),
    created_by: d.createdBy,
  };

  let objectId: string;
  let documentId: string | null = existing?.document_id ?? null;
  if (existing) {
    objectId = existing.id;
    await db.from("knowledge_objects").update(objectPatch).eq("id", objectId).eq("org_id", orgId);
  } else {
    const { data: ins, error } = await db.from("knowledge_objects").insert({ org_id: orgId, ...objectPatch, embedding: emb.some((v) => v !== 0) ? emb : null }).select(OBJECT_COLUMNS).single();
    if (error || !ins) throw new Error(error?.message ?? "snapshot object insert failed");
    objectId = (ins as unknown as KnowledgeObjectRow).id;
  }

  // (Re)chunk the compiled markdown so it's retrievable, tagged to the object.
  const laneMeta = { is_knowledge_object: true, object_id: objectId, object_ref: ref, intelligence_class: "business_reality", domain: "sales", object_type: "report", subtype: "call_performance", authority: "A2", category: "sales_intelligence" };
  if (documentId) {
    const r = await reingestDocument(db, { orgId, documentId, text: md, title: name, metadata: { object_version: version }, chunkStrategy: "knowledge_object", contextPrefix, intelligenceClass: "business_reality", domain: "sales", objectId });
    void r;
  } else {
    const doc = await ingestOne(db, { orgId, sourceType: "document", title: name, text: md, metadata: laneMeta, intelligenceClass: "business_reality", domain: "sales", objectId, chunkStrategy: "knowledge_object", contextPrefix, contextualize: false, allowDuplicate: true });
    documentId = doc.documentId;
    await db.from("knowledge_objects").update({ document_id: documentId }).eq("id", objectId).eq("org_id", orgId);
  }
  return ref;
}
