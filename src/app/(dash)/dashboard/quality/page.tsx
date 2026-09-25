import { requireAdmin } from "@/lib/auth/admin";
import { getRagQuality } from "@/lib/rag-quality";
import { getKnowledgeInsights } from "@/lib/knowledge-insights";
import { QualityClient } from "./QualityClient";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Query intelligence" };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_DAYS = [7, 30, 90];

/**
 * /dashboard/quality — Query intelligence: RAG answer-quality metrics (grounded
 * rate, refusals, fabricated citations, latency) computed from usage_events. Org
 * resolved server-side; the range comes from ?days (validated). The client
 * renders the page header so the range control can sit in its actions.
 */
export default async function QualityPage({
  searchParams,
}: {
  searchParams: Promise<{ days?: string }>;
}) {
  const admin = await requireAdmin();
  const sp = await searchParams;
  const days = ALLOWED_DAYS.includes(Number(sp.days)) ? Number(sp.days) : 30;
  const [data, insights] = await Promise.all([
    getRagQuality(admin.orgId, days),
    getKnowledgeInsights(admin.orgId, days),
  ]);

  return <QualityClient data={data} insights={insights} />;
}
