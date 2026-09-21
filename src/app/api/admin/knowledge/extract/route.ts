// POST /api/admin/knowledge/extract — turn a source into text for the Add-knowledge wizard.
//
// A link (web page or YouTube video), a PDF, a voice note / call recording or a
// screenshot goes in; plain text + light provenance (title, platform, url,
// duration, pages) comes out, ready for the Knowledge Compiler. The adapters
// live in src/lib/ingest-adapters; every outbound fetch is SSRF-guarded.
//
// Accepts multipart  file=<upload ≤ 4 MB> | url=<link>  (+ full=true)
//      or JSON       { url, full? }
//      or JSON       { storagePath, name, mime?, full? } — a file (≤ 50 MB) the wizard put in
//                    secure storage via /api/admin/knowledge/upload-url; it is read from the
//                    caller's own org prefix and deleted after extraction.
// `full: true` lifts the 60k text cap to 2M chars (long-source mode). Admin route only —
// the public /api/v1/extract accepts neither `storagePath` nor `full`.
// Returns { name, kind: url|youtube|pdf|audio|image|text, title, text, chars, truncated, meta }.
// org_id is resolved server-side; needs the documents:write grant.

import { supabaseAdmin } from "@/lib/supabase";
import { guard } from "../_shared";
import { handleExtractRequest } from "@/lib/ingest-adapters/request";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
// A 15 MB PDF parses in ~2 s; a long recording's transcription can take minutes.
export const maxDuration = 300;

export async function POST(req: Request) {
  const g = await guard("documents:write");
  if ("response" in g) return g.response;
  return handleExtractRequest(req, { admin: { orgId: g.admin.orgId, db: supabaseAdmin() } });
}
