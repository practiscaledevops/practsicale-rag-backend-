// Large uploads for the Add-knowledge wizard, via Supabase Storage.
//
// The hosting platform rejects request bodies over ~4.5 MB before a handler
// runs, so a book-sized PDF or a long recording cannot be POSTed to the
// extract route. Instead the browser uploads it STRAIGHT to a private storage
// bucket with a short-lived signed URL, then hands the extract route only the
// object path:
//
//   POST /api/admin/knowledge/upload-url  → createUploadTarget()  { path, signedUrl, token }
//   PUT  signedUrl                         (browser → storage, no function in between)
//   POST /api/admin/knowledge/extract      { storagePath } → downloadUpload() → adapters → removeUpload()
//
// Tenancy: every path is `org/<orgId>/<uuid>-<safe filename>`; the org comes
// from the admin session, never from the request, and the prefix is verified
// again server-side before a download. Uploads are EPHEMERAL — the object is
// deleted right after extraction, success or failure. Server-only (takes the
// service-role client); the pure parts are unit-tested.

import type { SupabaseClient } from "@supabase/supabase-js";
// Largest file the storage path accepts — 50 MB; the bucket enforces it too.
import { MAX_STORAGE_UPLOAD_BYTES } from "@/lib/ingest-adapters/pure";

export { MAX_STORAGE_UPLOAD_BYTES };
export const UPLOAD_BUCKET = "knowledge-uploads";

/** A readable upload failure; `status` is the HTTP status the routes reply with. */
export class UploadError extends Error {
  status: number;
  constructor(message: string, status = 400) {
    super(message);
    this.name = "UploadError";
    this.status = status;
  }
}

/**
 * A storage-safe object name: the base name only (no directories), ASCII
 * letters / digits / `. _ -`, everything else → `-`, no leading dots, ≤ 80
 * chars with the extension kept.
 */
export function safeFilename(name: string): string {
  const base = (name.split(/[\\/]/).pop() ?? "").normalize("NFKD").replace(/[̀-ͯ]/g, "");
  const cleaned = base.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/-{2,}/g, "-").replace(/\.{2,}/g, ".").replace(/^[.-]+|[.-]+$/g, "");
  if (!cleaned) return "upload";
  if (cleaned.length <= 80) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const ext = dot > 0 && cleaned.length - dot <= 10 ? cleaned.slice(dot) : "";
  return `${cleaned.slice(0, 80 - ext.length).replace(/[.-]+$/, "")}${ext}`;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** `org/<orgId>/<uuid>-<safe filename>` */
export function uploadPath(orgId: string, filename: string, id: string = crypto.randomUUID()): string {
  if (!orgId || /[\\/]/.test(orgId) || orgId.includes("..")) throw new UploadError("Invalid organisation.", 400);
  return `org/${orgId}/${id}-${safeFilename(filename)}`;
}

/**
 * The guard before any download/delete: the path must be exactly the shape
 * uploadPath() produces, under THIS org's prefix. Anything else — another
 * org's prefix, `..`, a backslash, an absolute path — is refused (403).
 */
export function assertOrgPath(orgId: string, path: unknown): string {
  const p = typeof path === "string" ? path : "";
  const prefix = `org/${orgId}/`;
  const rest = p.startsWith(prefix) ? p.slice(prefix.length) : "";
  const ok =
    !!orgId &&
    p.length <= 300 &&
    !!rest &&
    !/[\\/]/.test(rest) &&
    !p.includes("..") &&
    UUID_RE.test(rest.slice(0, 36)) &&
    /^-[A-Za-z0-9._-]+$/.test(rest.slice(36));
  if (!ok) throw new UploadError("This upload does not belong to your organisation.", 403);
  return p;
}

function storageOf(db: SupabaseClient) {
  // The in-memory demo client has no storage.
  if (!(db as { storage?: unknown }).storage) throw new UploadError("Large uploads need the live Supabase project (unavailable in demo mode). Use a file up to 4 MB.", 503);
  return db.storage;
}

/** Create the private bucket if it is missing ("already exists" is fine). */
export async function ensureUploadBucket(db: SupabaseClient): Promise<void> {
  const { error } = await storageOf(db).createBucket(UPLOAD_BUCKET, { public: false, fileSizeLimit: MAX_STORAGE_UPLOAD_BYTES });
  if (error && !/already exists|duplicate/i.test(error.message)) throw new UploadError(`Could not prepare upload storage (${error.message}).`, 502);
}

export interface UploadTarget {
  bucket: string;
  path: string;
  signedUrl: string;
  token: string;
}

const STALE_UPLOAD_MS = 24 * 60 * 60 * 1000;

/**
 * Best-effort sweep of the org's leftovers: an upload whose extraction never
 * ran (tab closed mid-way, cancelled) would otherwise sit in the bucket.
 */
export async function sweepStaleUploads(db: SupabaseClient, orgId: string, now = Date.now()): Promise<void> {
  try {
    const { data } = await storageOf(db).from(UPLOAD_BUCKET).list(`org/${orgId}`, { limit: 100, sortBy: { column: "created_at", order: "asc" } });
    const stale = (data ?? []).filter((o) => o.created_at && now - Date.parse(o.created_at) > STALE_UPLOAD_MS).map((o) => `org/${orgId}/${o.name}`);
    if (stale.length) await storageOf(db).from(UPLOAD_BUCKET).remove(stale);
  } catch {
    /* best-effort */
  }
}

/** A signed upload URL (valid 2 h, single object) under the org's prefix. */
export async function createUploadTarget(db: SupabaseClient, orgId: string, filename: string): Promise<UploadTarget> {
  await ensureUploadBucket(db);
  await sweepStaleUploads(db, orgId);
  const path = uploadPath(orgId, filename);
  const { data, error } = await storageOf(db).from(UPLOAD_BUCKET).createSignedUploadUrl(path);
  if (error || !data) throw new UploadError(`Could not create an upload URL (${error?.message ?? "no data"}).`, 502);
  return { bucket: UPLOAD_BUCKET, path, signedUrl: data.signedUrl, token: data.token };
}

/** Download an upload to a Buffer — only from the caller's own org prefix. */
export async function downloadUpload(db: SupabaseClient, orgId: string, path: string): Promise<Buffer> {
  const p = assertOrgPath(orgId, path);
  const { data, error } = await storageOf(db).from(UPLOAD_BUCKET).download(p);
  if (error || !data) throw new UploadError("The uploaded file was not found — it may have expired. Upload it again.", 404);
  if (data.size > MAX_STORAGE_UPLOAD_BYTES) throw new UploadError("Files up to 50 MB are supported.", 413);
  return Buffer.from(await data.arrayBuffer());
}

/** Delete an upload (best-effort; uploads are ephemeral). */
export async function removeUpload(db: SupabaseClient, path: string): Promise<void> {
  try {
    await storageOf(db).from(UPLOAD_BUCKET).remove([path]);
  } catch {
    /* best-effort */
  }
}
