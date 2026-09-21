// POST /api/admin/knowledge/extract — turn a source into text for the Add-knowledge wizard.
//
// A link (web page or YouTube video), a PDF, a voice note / call recording or a
// screenshot goes in; plain text + light provenance (title, platform, url,
// duration, pages) comes out, ready for the Knowledge Compiler. The adapters
// live in src/lib/ingest-adapters; every outbound fetch is SSRF-guarded.
//
// Accepts multipart  file=<upload> | url=<link>   or JSON { url }.
// Returns { name, kind: url|youtube|pdf|audio|image|text, title, text, chars, truncated, meta }.
// org_id is resolved server-side; needs the documents:write grant.

import { guard } from "../_shared";
import { handleExtractRequest } from "@/lib/ingest-adapters/request";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 120;

export async function POST(req: Request) {
  const g = await guard("documents:write");
  if ("response" in g) return g.response;
  return handleExtractRequest(req);
}
