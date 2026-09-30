import { redirect } from "next/navigation";
import { pageAccess } from "@/lib/auth/page-guard";
import { supabaseAdmin } from "@/lib/supabase";
import { getBrainOverview, type BrainOverview } from "@/lib/brain-overview";
import { getControlTowerData, type ControlTowerData } from "@/lib/dashboard-metrics";
import { OverviewClient } from "./OverviewClient";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Overview" };

export const runtime = "nodejs";
export const dynamic = "force-dynamic"; // always reflect current numbers

/** A blank Brain overview for a member without documents:read — every data part
 *  null (the client renders each as a friendly "not enabled" note), no health
 *  rows, all feature flags off. The home never hard-fails on a members-only admin. */
function emptyBrain(): BrainOverview {
  return {
    generatedAt: new Date().toISOString(),
    objects: null,
    lanes: null,
    learning: null,
    graph: null,
    taxonomy: null,
    ingestion: null,
    performance: null,
    retrieval: null,
    prompts: null,
    flags: { orchestrator: false, autoWorkMode: false, relationshipExpansion: false, learningDetection: false },
    providers: { openai: false, anthropic: false },
    health: [],
  };
}

/** A blank operations payload matching ControlTowerData, so the Team view renders
 *  its friendly empty state instead of the org's numbers when read is not granted. */
function emptyOperations(): ControlTowerData {
  return {
    documents: null,
    bySourceType: { document: 0, call_score: 0, transcript: 0, coaching: 0 },
    totalChunks: null,
    embeddedChunks: null,
    dataSources: [],
    needsReview: 0,
    runStats: { success: 0, error: 0, running: 0, lastSuccessAt: null },
    usage: { costUsd: 0, inputTokens: 0, outputTokens: 0, byProvider: { anthropic: 0, openai: 0 }, chatCalls: 0 },
  };
}

/**
 * /dashboard — the AI Brain overview (the landing page). pageAccess resolves the
 * session and whether the member holds documents:read (org_id is resolved
 * server-side, never from client input; super_admin/demo always pass).
 *
 * ACCESS SCOPE — the Overview is the one page that stays visible to every admin
 * (see permissions.ts ALWAYS_VISIBLE_ROUTES). Rather than hard-gate it with a
 * "no access" notice, a member without documents:read gets a blank overview: the
 * page still renders (their home never breaks) but shows none of the knowledge
 * numbers, and the client Refresh hits the read-guarded route, which 403s
 * cleanly. A member with read (write/delete imply read) gets the live numbers,
 * computed org-scoped in parallel and handed to the client fully populated so
 * nothing loads on first paint.
 *
 * `?view=team` opens the Team view; the client keeps the URL in sync with
 * history.replaceState, so toggling never re-runs these loaders.
 */
export default async function OverviewPage({
  searchParams,
}: {
  searchParams: Promise<{ view?: string | string[] }>;
}) {
  const { session, allowed } = await pageAccess("documents:read");
  if (!session) redirect("/login");
  const sp = await searchParams;
  const initialView = sp.view === "team" ? "team" : "ceo";
  const [brain, operations] = allowed
    ? await Promise.all([getBrainOverview(supabaseAdmin(), session.orgId), getControlTowerData(session.orgId)])
    : [emptyBrain(), emptyOperations()];
  return <OverviewClient brain={brain} operations={operations} email={session.email} initialView={initialView} />;
}
