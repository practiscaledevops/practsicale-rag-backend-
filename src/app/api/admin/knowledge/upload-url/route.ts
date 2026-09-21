// POST /api/admin/knowledge/upload-url — a signed upload URL for a big source file.
//
// The hosting platform rejects request bodies over ~4.5 MB, so the wizard
// uploads anything larger (a book PDF, a long recording — up to 50 MB)
// straight to the private `knowledge-uploads` bucket and then calls
// /api/admin/knowledge/extract with { storagePath }. See src/lib/knowledge-uploads.ts.
//
// Accepts JSON { name, size, mime? }.
// Returns { bucket, path, signedUrl, token, maxBytes }  ·  413 over 50 MB  ·  415 unsupported kind.
// org_id is resolved server-side (it prefixes the path); needs the documents:write grant.

import { supabaseAdmin } from "@/lib/supabase";
import { kindOfFile, extOf } from "@/lib/ingest-adapters/pure";
import { createUploadTarget, UploadError, MAX_STORAGE_UPLOAD_BYTES } from "@/lib/knowledge-uploads";
import { guard, str, num } from "../_shared";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 30;

export async function POST(req: Request) {
  const g = await guard("documents:write");
  if ("response" in g) return g.response;
  const { admin } = g;

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const name = str(body?.name, 300);
  const mime = str(body?.mime, 120);
  const size = num(body?.size);
  if (!name) return Response.json({ error: "name (string) is required." }, { status: 400 });
  if (size === null || size <= 0) return Response.json({ error: "size (bytes) is required." }, { status: 400 });
  if (size > MAX_STORAGE_UPLOAD_BYTES) return Response.json({ error: "Files up to 50 MB are supported." }, { status: 413 });
  if (!kindOfFile(name, mime)) {
    return Response.json(
      { error: `Unsupported file type '${extOf(name) || mime || name}'. Use a PDF, text (.txt .md .csv .json), audio (.mp3 .m4a .wav .mp4 .webm .ogg) or an image (.png .jpg .webp .gif).` },
      { status: 415 }
    );
  }

  try {
    const target = await createUploadTarget(supabaseAdmin(), admin.orgId, name);
    return Response.json({ ...target, maxBytes: MAX_STORAGE_UPLOAD_BYTES });
  } catch (e) {
    if (e instanceof UploadError) return Response.json({ error: e.message }, { status: e.status });
    // Unexpected failures: log the detail, never echo internals to the caller.
    console.error("[upload-url] failed:", e instanceof Error ? e.message : e);
    return Response.json({ error: "Could not prepare the upload. Please try again." }, { status: 500 });
  }
}
