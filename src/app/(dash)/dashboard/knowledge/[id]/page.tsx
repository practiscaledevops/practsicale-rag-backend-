import { redirect } from "next/navigation";
import { pageAccess } from "@/lib/auth/page-guard";
import { NoAccessNotice } from "@/components/auth/PermissionGate";
import { ObjectDetailClient } from "./ObjectDetailClient";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Knowledge object" };

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** /dashboard/knowledge/[id] — one intelligence object: sections, governance,
 *  provenance, relationships, entities, learning chain, decision log, markdown. */
export default async function KnowledgeObjectPage({ params }: { params: Promise<{ id: string }> }) {
  const { session, allowed } = await pageAccess("documents:read");
  if (!session) redirect("/login");
  if (!allowed) return <NoAccessNotice />;
  const { id } = await params;
  return <ObjectDetailClient id={id} />;
}
