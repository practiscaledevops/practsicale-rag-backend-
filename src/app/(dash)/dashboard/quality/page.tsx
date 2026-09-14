import { requireAdmin } from "@/lib/auth/admin";
import { getRagQuality } from "@/lib/rag-quality";
import { getKnowledgeInsights } from "@/lib/knowledge-insights";
import { PageHeader } from "@/components/ui/PageHeader";
import { QualityClient } from "./QualityClient";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ALLOWED_DAYS = [7, 30, 90];

/**
 * /dashboard/quality — Query intelligence: RAG answer-quality metrics (grounded
 * rate, refusals, fabricated citations, latency) computed from usage_events. Org
 * resolved server-side; the range comes from ?days (validated).
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

  return (
    <div>
      <PageHeader
        title="Query intelligence"
        description="Answer quality signals from real chatbot usage: how often answers are grounded, refused, or cite something that wasn't retrieved — plus the most-used sources and the questions we can't answer yet."
      />
      <QualityClient data={data} insights={insights} />
    </div>
  );
}
