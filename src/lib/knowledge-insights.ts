// Knowledge intelligence from the query_log (migration 0014): which sources the
// chatbot leans on most, and the questions it couldn't answer (knowledge gaps).
// Server-only, org-scoped. Degrades gracefully (enabled:false) before the table
// exists. Aggregation is done in JS over a bounded recent window.

import { supabaseAdmin } from "@/lib/supabase";

export interface UsedSource {
  documentId: string;
  title: string | null;
  sourceType: string | null;
  uses: number;
}

export interface KnowledgeGap {
  query: string;
  count: number;
  lastAt: string;
}

export interface KnowledgeInsights {
  enabled: boolean;
  days: number;
  totalLogged: number;
  mostUsedSources: UsedSource[];
  topUnanswered: KnowledgeGap[];
}

const EMPTY = (days: number, enabled: boolean): KnowledgeInsights => ({
  enabled,
  days,
  totalLogged: 0,
  mostUsedSources: [],
  topUnanswered: [],
});

export async function getKnowledgeInsights(orgId: string, days = 30): Promise<KnowledgeInsights> {
  const db = supabaseAdmin();
  const since = new Date(Date.now() - days * 86_400_000).toISOString();

  const { data, error } = await db
    .from("query_log")
    .select("query, retrieved_doc_ids, refused, grounded, created_at")
    .eq("org_id", orgId)
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(5000);

  if (error) {
    // undefined_table / undefined_column before migration 0014 → disabled.
    return EMPTY(days, false);
  }

  const rows = (data ?? []) as {
    query: string;
    retrieved_doc_ids: string[] | null;
    refused: boolean | null;
    grounded: boolean | null;
    created_at: string;
  }[];

  // Most-used sources: count every retrieved doc id across answers.
  const useCounts = new Map<string, number>();
  for (const r of rows) {
    for (const id of r.retrieved_doc_ids ?? []) {
      if (id) useCounts.set(id, (useCounts.get(id) ?? 0) + 1);
    }
  }
  const topIds = [...useCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10);

  const titles = new Map<string, { title: string | null; source_type: string | null }>();
  if (topIds.length) {
    const { data: docs } = await db
      .from("documents")
      .select("id, title, source_type")
      .eq("org_id", orgId)
      .in("id", topIds.map(([id]) => id));
    for (const d of (docs ?? []) as { id: string; title: string | null; source_type: string | null }[]) {
      titles.set(d.id, { title: d.title, source_type: d.source_type });
    }
  }
  const mostUsedSources: UsedSource[] = topIds.map(([id, uses]) => ({
    documentId: id,
    title: titles.get(id)?.title ?? null,
    sourceType: titles.get(id)?.source_type ?? null,
    uses,
  }));

  // Top unanswered: refused or ungrounded answers, grouped by normalized query.
  const gaps = new Map<string, { query: string; count: number; lastAt: string }>();
  for (const r of rows) {
    const isGap = r.refused === true || r.grounded === false;
    if (!isGap) continue;
    const key = r.query.trim().toLowerCase().replace(/\s+/g, " ").slice(0, 200);
    if (!key) continue;
    const existing = gaps.get(key);
    if (existing) {
      existing.count += 1;
      if (r.created_at > existing.lastAt) existing.lastAt = r.created_at;
    } else {
      gaps.set(key, { query: r.query.trim().slice(0, 200), count: 1, lastAt: r.created_at });
    }
  }
  const topUnanswered = [...gaps.values()]
    .sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt))
    .slice(0, 10);

  return {
    enabled: true,
    days,
    totalLogged: rows.length,
    mostUsedSources,
    topUnanswered,
  };
}
