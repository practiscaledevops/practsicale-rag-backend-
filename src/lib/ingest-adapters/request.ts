// The HTTP half of extraction, shared by the admin route
// (/api/admin/knowledge/extract) and the public one (/api/v1/extract). Each
// route does its own auth first and then hands the request here, so the
// body contract and the error mapping are identical for the wizard and for a
// spoke (the chatbot) that extracts what a user attached.
//
//   multipart/form-data  file=<upload>   or   url=<link>
//   application/json     { "url": "https://…" }
//
//   ADMIN ROUTE ONLY (opts.admin — the public route never passes it):
//   application/json     { "storagePath": "org/<orgId>/…", "name": "book.pdf", "mime"?: "…", "full"?: true }
//                        a big file the wizard uploaded to secure storage (src/lib/knowledge-uploads.ts):
//                        downloaded from the caller's own org prefix, extracted, then DELETED
//   `full` (JSON field or multipart field)  lifts the 60k text cap to 2M chars for the long-source mode
//
//   200 → { name, kind, title, text, chars, truncated, meta }
//   4xx/5xx → { error }        (ExtractError.status; 500 for anything unexpected)
//
// Lives in lib/ because Next.js route modules may only export HTTP handlers.

import type { SupabaseClient } from "@supabase/supabase-js";
import { extractAny, ExtractError, type ExtractInput } from "./index";
import { MAX_DIRECT_UPLOAD_BYTES } from "./pure";
import { downloadUpload, removeUpload, assertOrgPath, UploadError } from "@/lib/knowledge-uploads";

/**
 * Largest upload accepted at the door. Vercel functions reject request bodies
 * over ~4.5 MB before the handler runs (FUNCTION_PAYLOAD_TOO_LARGE), so a
 * bigger promise would only surface as an opaque 413; bigger files (to 50 MB)
 * arrive via secure storage on the admin route, where the adapters' own caps
 * apply (50 MB PDF, 25 MB audio, 10 MB images).
 */
export const MAX_UPLOAD_BYTES = MAX_DIRECT_UPLOAD_BYTES;

export interface ExtractRequestOptions {
  /**
   * Set by the ADMIN route only: enables `{ storagePath }` and `full`. `orgId`
   * comes from the admin session — never from the request — and the storage
   * path must sit under that org's prefix.
   */
  admin?: { orgId: string; db: SupabaseClient };
}

const truthy = (v: unknown) => v === true || v === "true" || v === "1";

export async function handleExtractRequest(req: Request, opts?: ExtractRequestOptions): Promise<Response> {
  const contentType = req.headers.get("content-type") ?? "";
  let input: ExtractInput | null;
  let full = false;
  /** A storage object to delete once extraction is over (success or failure). */
  let uploaded: string | null = null;

  try {
    if (contentType.includes("multipart/form-data")) {
      let form: FormData;
      try {
        form = await req.formData();
      } catch {
        return Response.json({ error: "Expected multipart/form-data with a `file` or a `url` field." }, { status: 400 });
      }
      const file = form.get("file");
      const url = form.get("url");
      full = !!opts?.admin && truthy(form.get("full"));
      if (file instanceof File) {
        if (file.size === 0) return Response.json({ error: "The uploaded file is empty." }, { status: 400 });
        if (file.size > MAX_UPLOAD_BYTES) return Response.json({ error: "File too large (max 4 MB for a direct upload). Trim the audio or split the PDF." }, { status: 413 });
        input = { file: { name: file.name || "upload", mime: file.type || null, buffer: Buffer.from(await file.arrayBuffer()) } };
      } else if (typeof url === "string" && url.trim()) {
        input = { url: url.trim() };
      } else {
        return Response.json({ error: "Attach a `file` or provide a `url`." }, { status: 400 });
      }
    } else {
      const body = (await req.json().catch(() => null)) as { url?: unknown; storagePath?: unknown; name?: unknown; mime?: unknown; full?: unknown } | null;
      full = !!opts?.admin && truthy(body?.full);
      if (opts?.admin && body && typeof body.storagePath === "string" && body.storagePath.trim()) {
        // Verify the org prefix BEFORE anything is scheduled for deletion.
        const path = assertOrgPath(opts.admin.orgId, body.storagePath.trim());
        uploaded = path;
        const name = typeof body.name === "string" && body.name.trim() ? body.name.trim().slice(0, 300) : path.split("/").pop() ?? "upload";
        const mime = typeof body.mime === "string" ? body.mime.trim().slice(0, 120) : null;
        input = { file: { name, mime: mime || null, buffer: await downloadUpload(opts.admin.db, opts.admin.orgId, path) } };
      } else {
        const url = body && typeof body.url === "string" ? body.url.trim() : "";
        if (!url) return Response.json({ error: "url (string) is required — or send multipart/form-data with a file." }, { status: 400 });
        if (url.length > 2048) return Response.json({ error: "url is too long." }, { status: 400 });
        input = { url };
      }
    }

    const pending = extractAny(input, { full });
    // The adapter holds the only reference it needs; drop ours so a 50 MB
    // buffer can be collected as soon as parsing is done.
    input = null;
    return Response.json(await pending);
  } catch (e) {
    if (e instanceof ExtractError || e instanceof UploadError) return Response.json({ error: e.message }, { status: e.status });
    // Unexpected failures: log the detail, never echo internals to the caller.
    console.error("[extract] failed:", e instanceof Error ? e.message : e);
    return Response.json({ error: "Extraction failed. Please try again." }, { status: 500 });
  } finally {
    // Uploads are ephemeral: gone after extraction, whatever the outcome.
    if (uploaded && opts?.admin) await removeUpload(opts.admin.db, uploaded);
  }
}
