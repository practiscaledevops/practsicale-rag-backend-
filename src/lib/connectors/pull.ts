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
import { redactPII } from "@/lib/redact";
import { assertPublicUrl } from "@/lib/net-guard";

// Big free-text fields belong in the chunked BODY, not in metadata.
const OMIT_FROM_META = new Set(["full_report", "report", "full_report_md", "analysis"]);

/**
 * Structured metadata to stamp on every chunk of a record: the record's scalar
 * fields (consultant, score, band, outcome, dates…) plus small nested objects
 * (phase_scores, talk_ratio). This powers consultant-level retrieval/filtering
 * and scoring analytics. String values are PII-redacted (emails/phones), and the
 * large report text is excluded (it lives in the searchable body).
 */
// Structural string fields (dates, ids, slugs, urls) must NOT be PII-redacted:
// the greedy phone rule otherwise mangles an ISO date / timestamp into "[PHONE]",
// destroying the time dimension for Performance Memory. These are identifiers,
// not personal contact data. (Emails/phones in free-text fields are still redacted.)
const NO_REDACT_KEY = /(^|_)(id|date|at|slug|url|links|status|band|outcome|type|version|count|score|scores|ratio|duration|pct|percent|band)$/i;

function recordMetadata(rec: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec)) {
    if (OMIT_FROM_META.has(k) || v == null || v === "") continue;
    if (typeof v === "string") {
      // Keep structural identifiers verbatim; redact everything else.
      out[k] = NO_REDACT_KEY.test(k) && !k.toLowerCase().includes("email") ? v : redactPII(v);
    } else if (typeof v === "number" || typeof v === "boolean") {
      out[k] = v;
    } else {
      // Keep small nested objects/arrays (e.g. phase_scores); cap the size.
      try {
        if (JSON.stringify(v).length <= 3000) out[k] = v;
      } catch {
        /* skip unserializable */
      }
    }
  }
  return out;
}

/** A readable document title from well-known scoring fields, else a fallback. */
function buildTitle(rec: Record<string, unknown>, sourceType: string, recordId?: string): string {
  const consultant = rec.consultant_name ?? rec.consultant ?? null;
  const prospect = rec.prospect_name ?? null;
  const score = rec.overall_score ?? rec.score ?? null;
  if (consultant || prospect || score != null) {
    const who = [consultant, prospect].filter(Boolean).join(" → ");
    return `${who || sourceType}${score != null ? ` (${score})` : ""}`.trim();
  }
  return recordId ? `${sourceType} ${recordId}` : sourceType;
}

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
  /** Query-param NAME to send the watermark under (falls back to cursor_field). */
  cursor_param: string | null;
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

      const title = buildTitle(rec, source.source_type, recordId);

      const res = await ingestOne(db, {
        orgId: source.org_id,
        sourceType: source.source_type,
        title,
        text,
        // Provenance + the record's structured fields (consultant, score, band,
        // outcome, phase_scores…). Kept structurally separate from any instruction;
        // string values are PII-redacted in recordMetadata().
        metadata: {
          data_source: source.name,
          data_source_slug: source.slug ?? null,
          source_record_id: recordId ?? null,
          ...recordMetadata(rec),
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

const MAX_PAGES = 40; // safety cap: MAX_PAGES * limit records per sync

async function fetchRecords(source: DataSourceRow): Promise<unknown[]> {
  // SSRF guard: never let an admin-configured endpoint point the server at a
  // private/loopback/link-local address (e.g. cloud metadata at 169.254.169.254).
  await assertPublicUrl(source.endpoint_url as string);

  const headers = buildHeaders(source);
  const method = (source.http_method ?? "GET").toUpperCase();

  // Base params: static config + the incremental watermark. The watermark is
  // sent under cursor_param when set, else under cursor_field (back-compat).
  const baseParams = new URLSearchParams();
  for (const [k, v] of Object.entries(source.query_params ?? {})) {
    if (v != null) baseParams.set(k, String(v));
  }
  const cursorParamName = source.cursor_param ?? source.cursor_field;
  if (cursorParamName && source.cursor_value) {
    baseParams.set(cursorParamName, source.cursor_value);
  }

  // Auto-paging: when a numeric `limit` is configured, keep fetching with an
  // increasing `offset` until a short page (or the safety cap) — so a first-run
  // backfill pulls everything, not just the first page.
  const limit = Number(baseParams.get("limit"));
  const paged = Number.isFinite(limit) && limit > 0;
  let offset = Number(baseParams.get("offset")) || 0;

  const all: unknown[] = [];
  for (let page = 0; page < (paged ? MAX_PAGES : 1); page++) {
    const url = new URL(source.endpoint_url as string);
    for (const [k, v] of baseParams) url.searchParams.set(k, v);
    if (paged) url.searchParams.set("offset", String(offset));

    const res = await fetch(url.toString(), { method, headers });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`pull request failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
    }
    const json: unknown = await res.json();
    const extracted = getPath(json, source.records_path);

    const batch = Array.isArray(extracted)
      ? extracted
      : extracted && typeof extracted === "object"
        ? [extracted]
        : null;
    if (batch === null) {
      throw new Error(
        `records_path '${source.records_path ?? "(root)"}' did not resolve to an array or object`
      );
    }

    all.push(...batch);
    if (!paged || batch.length < limit) break; // last page reached
    offset += limit;
  }

  return all;
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
