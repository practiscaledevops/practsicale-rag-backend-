import { requireAdmin } from "@/lib/auth/admin";
import { ObjectDetailClient } from "./ObjectDetailClient";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Knowledge object" };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /dashboard/knowledge/[id] — one intelligence object: sections, governance,
 *  provenance, relationships, entities, learning chain, decision log, markdown. */
export default async function KnowledgeObjectPage({ params }: { params: Promise<{ id: string }> }) {
  await requireAdmin();
  const { id } = await params;
  return <ObjectDetailClient id={id} />;
}
