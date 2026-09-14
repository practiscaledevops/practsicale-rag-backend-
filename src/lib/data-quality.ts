// Data-quality signals for the knowledge base — freshness, ownership, processing
// health, and searchability. Server-only, org-scoped, computed from existing rows
// (no new schema). Powers the Operations "Data quality" page and feeds the CEO
// attention list.

import { supabaseAdmin } from "@/lib/supabase";

const STALE_DAYS = 90;
const AGING_DAYS = 60;
const LIST_CAP = 25;

export interface QualityDoc {
  id: string;
  title: string | null;
  sourceType: string;
  updatedAt: string;
  reason: string;
}

export interface FailedRun {
  id: string;
  trigger: string;
  error: string | null;
  startedAt: string;
  dataSourceId: string | null;
}

export interface DataQuality {
  totalDocuments: number;
  stale: QualityDoc[];
  aging: number;
  unsearchable: QualityDoc[];
  reviewDue: QualityDoc[];
  collectionsNoOwner: { id: string; name: string }[];
  failedRuns: FailedRun[];
  counts: { stale: number; unsearchable: number; reviewDue: number; noOwner: number; failedRuns: number };
}

function metaStr(m: Record<string, unknown> | null, ...keys: string[]): string | null {
  if (!m) return null;
  for (const k of keys) {
    const v = m[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return null;
}

function ageDays(iso: string): number {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return 0;
  return Math.floor((Date.now() - t) / 86_400_000);
}

export async function getDataQuality(orgId: string): Promise<DataQuality> {
  const db = supabaseAdmin();

  const [docsRes, colsRes, runsRes] = await Promise.all([
    db
      .from("documents")
      .select("id, title, source_type, updated_at, metadata, chunks(count)")
      .eq("org_id", orgId)
      .order("updated_at", { ascending: true })
      .limit(2000),
    db.from("collections").select("id, name, settings").eq("org_id", orgId),
    db
      .from("ingestion_runs")
      .select("id, trigger, error, started_at, data_source_id, status")
      .eq("org_id", orgId)
      .eq("status", "error")
      .order("started_at", { ascending: false })
      .limit(LIST_CAP),
  ]);

  const docs = (docsRes.data ?? []) as {
    id: string;
    title: string | null;
    source_type: string;
    updated_at: string;
    metadata: Record<string, unknown> | null;
    chunks: { count: number }[] | null;
  }[];

  const stale: QualityDoc[] = [];
  const unsearchable: QualityDoc[] = [];
  const reviewDue: QualityDoc[] = [];
  let aging = 0;

  for (const d of docs) {
    const chunkCount = d.chunks?.[0]?.count ?? 0;
    const updatedAt = d.updated_at;
    const age = ageDays(updatedAt);
    const reviewDate = metaStr(d.metadata, "review_date", "expiry_date");

    if (chunkCount === 0) {
      unsearchable.push({ id: d.id, title: d.title, sourceType: d.source_type, updatedAt, reason: "No embedded chunks" });
      continue; // an unsearchable doc's freshness is moot
    }
    if (reviewDate) {
      const r = new Date(reviewDate).getTime();
      if (!Number.isNaN(r) && r < Date.now()) {
        reviewDue.push({ id: d.id, title: d.title, sourceType: d.source_type, updatedAt, reason: `Review date passed (${reviewDate.slice(0, 10)})` });
        continue;
      }
    }
    if (age >= STALE_DAYS) {
      stale.push({ id: d.id, title: d.title, sourceType: d.source_type, updatedAt, reason: `Not updated in ${age} days` });
    } else if (age >= AGING_DAYS) {
      aging += 1;
    }
  }

  const cols = (colsRes.data ?? []) as { id: string; name: string; settings: Record<string, unknown> | null }[];
  const collectionsNoOwner = cols
    .filter((c) => !metaStr(c.settings, "owner"))
    .map((c) => ({ id: c.id, name: c.name }));

  const failedRuns: FailedRun[] = ((runsRes.data ?? []) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    trigger: String(r.trigger ?? "manual"),
    error: (r.error as string) ?? null,
    startedAt: String(r.started_at ?? ""),
    dataSourceId: (r.data_source_id as string) ?? null,
  }));

  return {
    totalDocuments: docs.length,
    stale: stale.slice(0, LIST_CAP),
    aging,
    unsearchable: unsearchable.slice(0, LIST_CAP),
    reviewDue: reviewDue.slice(0, LIST_CAP),
    collectionsNoOwner: collectionsNoOwner.slice(0, LIST_CAP),
    failedRuns,
    counts: {
      stale: stale.length,
      unsearchable: unsearchable.length,
      reviewDue: reviewDue.length,
      noOwner: collectionsNoOwner.length,
      failedRuns: failedRuns.length,
    },
  };
}
