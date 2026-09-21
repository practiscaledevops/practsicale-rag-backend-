// The HTTP half of extraction, shared by the admin route
// (/api/admin/knowledge/extract) and the public one (/api/v1/extract). Each
// route does its own auth first and then hands the request here, so the
// body contract and the error mapping are identical for the wizard and for a
// spoke (the chatbot) that extracts what a user attached.
//
//   multipart/form-data  file=<upload>   or   url=<link>
//   application/json     { "url": "https://…" }
//
//   200 → { name, kind, title, text, chars, truncated, meta }
//   4xx/5xx → { error }        (ExtractError.status; 500 for anything unexpected)
//
// Lives in lib/ because Next.js route modules may only export HTTP handlers.

import { extractAny, ExtractError, type ExtractInput } from "./index";

/**
 * Largest upload accepted at the door. Vercel functions reject request bodies
 * over ~4.5 MB before the handler runs (FUNCTION_PAYLOAD_TOO_LARGE), so a
 * bigger promise would only surface as an opaque 413; the adapters' own caps
 * (25 MB audio, 10 MB images) apply once uploads arrive via storage instead.
 */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

export async function handleExtractRequest(req: Request): Promise<Response> {
  const contentType = req.headers.get("content-type") ?? "";
  let input: ExtractInput;

  if (contentType.includes("multipart/form-data")) {
    let form: FormData;
    try {
      form = await req.formData();
    } catch {
      return Response.json({ error: "Expected multipart/form-data with a `file` or a `url` field." }, { status: 400 });
    }
    const file = form.get("file");
    const url = form.get("url");
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
    const body = (await req.json().catch(() => null)) as { url?: unknown } | null;
    const url = body && typeof body.url === "string" ? body.url.trim() : "";
    if (!url) return Response.json({ error: "url (string) is required — or send multipart/form-data with a file." }, { status: 400 });
    if (url.length > 2048) return Response.json({ error: "url is too long." }, { status: 400 });
    input = { url };
  }

  try {
    const result = await extractAny(input);
    return Response.json(result);
  } catch (e) {
    if (e instanceof ExtractError) return Response.json({ error: e.message }, { status: e.status });
    // Unexpected failures: log the detail, never echo internals to the caller.
    console.error("[extract] failed:", e instanceof Error ? e.message : e);
    return Response.json({ error: "Extraction failed. Please try again." }, { status: 500 });
  }
}
