// Pull-connector runner.
//
// The Brain PULLS data by calling GET endpoints that source systems (e.g. the
// call-scoring service) expose. Given a `data_sources` row it:
//   1. builds the request (method, headers, query params, auth from an env-ref),
//   2. fetches and extracts the records array via `records_path` (a dot path),
//   3. serializes each record to text and ingests it through the SHARED ingestOne()
//      code path (same redaction / hashing / provenance as /api/ingest),
//   4. advances the source cursor and stamps last_run_at / last_status,
//   5. writes ONE ingestion_runs row summarising the whole sync.
//
// Idempotent: ingestOne skips a record whose content hash already exists.
//
// SECURITY: secrets are never stored in the data_sources row — only a REFERENCE
// (auth_secret_ref) to the env var that holds the secret, read here server-side.

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase";
import { serializeRecord } from "@/lib/chunking";
import { ingestOne } from "@/lib/ingest";

export interface DataSourceRow {
  id: string;
  org_id: string;
  name: string;
  slug?: string | null;
  source_type: string;
  kind: string;
  endpoint_url: string | null;
  http_method: string | null;
  auth_type: string | null;
  auth_secret_ref: string | null;
  headers: Record<string, string> | null;
  query_params: Record<string, string> | null;
  records_path: string | null;
  record_id_field: string | null;
  cursor_field: string | null;
  cursor_value: string | null;
}

export interface PullResult {
  runId: string | null;
  status: "success" | "error";
  recordsFetched: number;
  documentsIngested: number;
  documentsSkipped: number;
  chunksIngested: number;
  cursorValue: string | null;
  error?: string;
}

export type PullTrigger = "manual" | "schedule" | "webhook";

/**
 * Run a pull sync for one data source. Creates and finalises its own
 * ingestion_runs row and updates the source's cursor/last-run bookkeeping.
 */
export async function runPull(
  source: DataSourceRow,
  opts: { trigger?: PullTrigger; db?: SupabaseClient } = {}
): Promise<PullResult> {
  const db = opts.db ?? supabaseAdmin();
  const trigger = opts.trigger ?? "manual";

  // Provenance row for the whole sync.
  const { data: run } = await db
    .from("ingestion_runs")
    .insert({
      org_id: source.org_id,
      data_source_id: source.id,
      trigger,
      status: "running",
    })
    .select("id")
    .single();
  const runId: string | null = run?.id ?? null;

  const result: PullResult = {
    runId,
    status: "success",
    recordsFetched: 0,
    documentsIngested: 0,
    documentsSkipped: 0,
    chunksIngested: 0,
    cursorValue: source.cursor_value ?? null,
  };

  try {
    if (source.kind !== "pull_http") {
      throw new Error(`data source '${source.name}' is not a pull_http source (kind=${source.kind})`);
    }
    if (!source.endpoint_url) {
      throw new Error(`data source '${source.name}' has no endpoint_url`);
    }

    const records = await fetchRecords(source);
    result.recordsFetched = records.length;

    let newCursor = source.cursor_value ?? null;

    for (const record of records) {
      if (!record || typeof record !== "object") continue;

      const rec = record as Record<string, unknown>;
      const recordId =
        source.record_id_field && rec[source.record_id_field] != null
          ? String(rec[source.record_id_field])
          : undefined;

      const text = serializeRecord(rec);
      if (!text.trim()) continue;

      const title = recordId ? `${source.source_type} ${recordId}` : source.name;

      const res = await ingestOne(db, {
        orgId: source.org_id,
        sourceType: source.source_type,
        title,
        text,
        // Provenance in metadata; kept structurally separate from any instruction.
        metadata: {
          data_source: source.name,
          data_source_slug: source.slug ?? null,
          source_record_id: recordId ?? null,
        },
        dataSourceId: source.id,
      });

      if (res.skipped) result.documentsSkipped += 1;
      else result.documentsIngested += 1;
      result.chunksIngested += res.chunks;

      // Advance the watermark to the largest cursor value seen this run.
      if (source.cursor_field && rec[source.cursor_field] != null) {
        newCursor = maxCursor(newCursor, String(rec[source.cursor_field]));
      }
    }

    result.cursorValue = newCursor;

    // Update the source: cursor + last-run bookkeeping.
    await db
      .from("data_sources")
      .update({
        cursor_value: newCursor,
        last_run_at: new Date().toISOString(),
        last_status: "success",
        updated_at: new Date().toISOString(),
      })
      .eq("id", source.id)
      .eq("org_id", source.org_id);

    await db
      .from("ingestion_runs")
      .update({
        status: "success",
        documents_ingested: result.documentsIngested,
        documents_skipped: result.documentsSkipped,
        chunks_ingested: result.chunksIngested,
        finished_at: new Date().toISOString(),
      })
      .eq("id", runId);

    return result;
  } catch (e) {
    const message = e instanceof Error ? e.message : "pull failed";
    result.status = "error";
    result.error = message;

    await db
      .from("data_sources")
      .update({ last_run_at: new Date().toISOString(), last_status: "error", updated_at: new Date().toISOString() })
      .eq("id", source.id)
      .eq("org_id", source.org_id);

    await db
      .from("ingestion_runs")
      .update({ status: "error", error: message, finished_at: new Date().toISOString() })
      .eq("id", runId);

    return result;
  }
}

// ---- HTTP + extraction helpers -----------------------------------------------

async function fetchRecords(source: DataSourceRow): Promise<unknown[]> {
  const url = new URL(source.endpoint_url as string);

  // Static query params from config.
  for (const [k, v] of Object.entries(source.query_params ?? {})) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  // Incremental cursor: pass the last watermark as a query param named for the
  // cursor field, so the source can return only newer rows.
  if (source.cursor_field && source.cursor_value) {
    url.searchParams.set(source.cursor_field, source.cursor_value);
  }

  const headers = buildHeaders(source);
  const method = (source.http_method ?? "GET").toUpperCase();

  const res = await fetch(url.toString(), { method, headers });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`pull request failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
  }

  const json: unknown = await res.json();
  const extracted = getPath(json, source.records_path);

  if (Array.isArray(extracted)) return extracted;
  if (extracted && typeof extracted === "object") return [extracted]; // single-object response
  throw new Error(
    `records_path '${source.records_path ?? "(root)"}' did not resolve to an array or object`
  );
}

function buildHeaders(source: DataSourceRow): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json", ...(source.headers ?? {}) };

  const authType = source.auth_type ?? "none";
  if (authType === "none") return headers;

  const secret = source.auth_secret_ref ? process.env[source.auth_secret_ref] : undefined;
  if (!secret) {
    throw new Error(
      `auth_type '${authType}' requires a secret; env var '${source.auth_secret_ref ?? "(unset)"}' is empty`
    );
  }

  switch (authType) {
    case "bearer":
      headers.authorization = `Bearer ${secret}`;
      break;
    case "api_key":
      // Convention: send the secret as x-api-key unless config already set a header.
      if (!("x-api-key" in headers)) headers["x-api-key"] = secret;
      break;
    case "basic":
      // Secret is expected as "user:password"; encode for HTTP Basic.
      headers.authorization = `Basic ${Buffer.from(secret).toString("base64")}`;
      break;
    default:
      throw new Error(`unsupported auth_type '${authType}'`);
  }
  return headers;
}

// Resolve a dot path (e.g. "data.records") against a parsed JSON value.
// An empty/undefined path returns the root value.
function getPath(obj: unknown, path?: string | null): unknown {
  if (!path) return obj;
  return path.split(".").reduce<unknown>((acc, key) => {
    if (acc == null || typeof acc !== "object") return undefined;
    return (acc as Record<string, unknown>)[key];
  }, obj);
}

// Return the larger of two cursor values. Numeric when both parse as numbers,
// lexicographic otherwise (works for ISO-8601 timestamps).
function maxCursor(a: string | null, b: string): string {
  if (a == null) return b;
  const na = Number(a);
  const nb = Number(b);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return nb > na ? b : a;
  return b > a ? b : a;
}
