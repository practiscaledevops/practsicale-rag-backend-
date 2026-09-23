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
import { ingestOne, type IngestResult } from "@/lib/ingest";
import { redactPII } from "@/lib/redact";
import { assertPublicUrl } from "@/lib/net-guard";
import { isAllowedSecretRef } from "@/lib/connectors/secret-ref";

// Big free-text fields belong in the chunked BODY, not in metadata. The raw
// `transcript` is a ~46 KB field that gets its own document (see runPull), so it
// never bloats a report doc's body or metadata.
const OMIT_FROM_META = new Set(["full_report", "report", "full_report_md", "analysis", "transcript"]);

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
const NO_REDACT_KEY = /(^|_)(id|date|at|slug|url|links|status|band|outcome|type|version|count|score|scores|ratio|duration|pct|percent)$/i;

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
  // Surface the call's practice type as the generic `category` the Documents
  // table + Collections control centre already render and filter on, so every
  // call and transcript groups by practice type (NEMT, Phlebotomy, Home Care…).
  // Only when the record actually carries one — otherwise leave it unset ("—").
  if (typeof out.practice_type === "string" && out.practice_type) out.category = out.practice_type;
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

// ---- transcript document -----------------------------------------------------

const str = (v: unknown): string => (v == null ? "" : String(v).trim());

/** First recording URL from a record's `recording_links` (array or string). */
function firstRecording(rec: Record<string, unknown>): string {
  const links = rec.recording_links;
  if (Array.isArray(links)) {
    const first = links.find((l) => typeof l === "string" && l.trim());
    return typeof first === "string" ? first.trim() : "";
  }
  return typeof links === "string" ? links.trim() : "";
}

/**
 * Ingest a call's RAW TRANSCRIPT as its own document, linked to the call_score
 * doc by the shared record id. The body is a short readable header (consultant,
 * prospect, practice type, call date, outcome, score/band, duration, recording)
 * followed by the verbatim transcript; chunkDocument("transcript") then splits
 * it by speaker turn. Structured fields ride in metadata (consultant/date/
 * outcome/score/band/category…) so retrieval can filter by date + consultant +
 * practice type. Redaction (emails → [EMAIL]) happens on ingest, as intended —
 * names stay (they're in the metadata and speaker labels). `rec` must already
 * have `transcript` stripped. Returns null when there is no transcript text.
 */
async function ingestTranscript(
  db: SupabaseClient,
  source: DataSourceRow,
  rec: Record<string, unknown>,
  transcript: string,
  recordId: string | undefined
): Promise<IngestResult | null> {
  if (!transcript.trim()) return null;

  const consultant = str(rec.consultant_name) || str(rec.consultant) || "Unknown consultant";
  const prospect = str(rec.prospect_name) || "Unknown prospect";
  const practice = str(rec.practice_type);
  const callDate = str(rec.call_date) || str(rec.created_at);
  const score = str(rec.overall_score);
  const band = str(rec.performance_band);
  const recording = firstRecording(rec);

  const header = [
    `Call transcript — ${consultant} → ${prospect}`,
    `Consultant: ${consultant}`,
    `Prospect: ${prospect}`,
    practice ? `Practice type: ${practice}` : "",
    callDate ? `Call date: ${callDate}` : "",
    str(rec.call_outcome) ? `Outcome: ${str(rec.call_outcome)}` : "",
    score ? `Score: ${score}/100${band ? ` (${band})` : ""}` : band ? `Band: ${band}` : "",
    str(rec.call_duration_minutes) ? `Duration: ${str(rec.call_duration_minutes)} min` : "",
    recording ? `Recording: ${recording}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const title = `Transcript — ${consultant} → ${prospect}${callDate ? ` (${callDate})` : ""}`;

  return ingestOne(db, {
    orgId: source.org_id,
    sourceType: "transcript",
    // Transcripts are lived experience, not doctrine → Business Reality / sales.
    intelligenceClass: "business_reality",
    domain: "sales",
    title,
    text: `${header}\n\n${transcript}`,
    metadata: {
      data_source: source.name,
      data_source_slug: source.slug ?? null,
      source_record_id: recordId ?? null,
      ...recordMetadata(rec),
      kind: "transcript",
      // Both docs share the record id, linking transcript ↔ call_score.
      linked_call_score_id: recordId ?? null,
    },
    dataSourceId: source.id,
  });
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
  /** Raw call transcripts ingested as their own linked document this run. */
  transcriptsIngested: number;
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
  opts: { trigger?: PullTrigger; db?: SupabaseClient; deadlineAt?: number } = {}
): Promise<PullResult> {
  const db = opts.db ?? supabaseAdmin();
  const trigger = opts.trigger ?? "manual";
  // A wall-clock budget (epoch ms). Past it, the run stops cleanly after the
  // current record and records what it did — instead of being killed by the
  // function timeout with the run stuck in "running" and the cursor unmoved.
  const deadlineAt = opts.deadlineAt;
  let partial = false;

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
    transcriptsIngested: 0,
    cursorValue: source.cursor_value ?? null,
  };

  try {
    if (source.kind !== "pull_http") {
      throw new Error(`data source '${source.name}' is not a pull_http source (kind=${source.kind})`);
    }
    if (!source.endpoint_url) {
      throw new Error(`data source '${source.name}' has no endpoint_url`);
    }

    const records = await fetchRecords(source, deadlineAt);
    result.recordsFetched = records.length;

    let newCursor = source.cursor_value ?? null;

    for (const record of records) {
      if (deadlineAt && Date.now() > deadlineAt) {
        partial = true;
        break;
      }
      if (!record || typeof record !== "object") continue;

      const rec = record as Record<string, unknown>;
      const recordId =
        source.record_id_field && rec[source.record_id_field] != null
          ? String(rec[source.record_id_field])
          : undefined;

      // The raw transcript (present when include_transcript=true) gets its OWN
      // document below; strip it here so the report doc's body + metadata stay
      // lean (a 46 KB transcript would otherwise bloat both).
      const transcript = typeof rec.transcript === "string" ? rec.transcript.trim() : "";
      const { transcript: _omitTranscript, ...recNoTx } = rec;

      const text = serializeRecord(recNoTx);
      if (!text.trim()) continue;

      const title = buildTitle(recNoTx, source.source_type, recordId);

      const res = await ingestOne(db, {
        orgId: source.org_id,
        sourceType: source.source_type,
        title,
        text,
        // Provenance + the record's structured fields (consultant, score, band,
        // outcome, phase_scores, practice type as `category`…). Kept structurally
        // separate from any instruction; string values are PII-redacted in
        // recordMetadata().
        metadata: {
          data_source: source.name,
          data_source_slug: source.slug ?? null,
          source_record_id: recordId ?? null,
          ...recordMetadata(recNoTx),
        },
        dataSourceId: source.id,
      });

      if (res.skipped) result.documentsSkipped += 1;
      else result.documentsIngested += 1;
      result.chunksIngested += res.chunks;

      // Second document: the raw transcript, if the record carried one. Linked to
      // the report doc by the shared record id; chunked by speaker turn.
      if (transcript) {
        const tRes = await ingestTranscript(db, source, recNoTx, transcript, recordId);
        if (tRes && !tRes.skipped) result.transcriptsIngested += 1;
        if (tRes) result.chunksIngested += tRes.chunks;
      }

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
        ...(partial ? { error: "partial: time budget reached; the next run resumes from the cursor" } : {}),
        finished_at: new Date().toISOString(),
      })
      .eq("id", runId);

    if (partial) result.error = "partial: time budget reached";
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

// ---- transcript back-fill ----------------------------------------------------

export interface BackfillResult {
  /** Reports seen that carried a transcript (the ones we attempted to ingest). */
  calls: number;
  transcriptsCreated: number;
  transcriptsSkipped: number;
}

/**
 * Back-fill transcript documents for EVERY call a source can return. Pages all
 * reports with include_transcript=true (ignoring the incremental cursor) and
 * ingests a `transcript` document for each call that has one. Idempotent — a
 * call whose transcript is already stored (by content hash) is skipped. Shared
 * by the CLI script and the admin route so both behave identically.
 */
export async function backfillTranscripts(
  source: DataSourceRow,
  opts: {
    db?: SupabaseClient;
    deadlineAt?: number;
    onProgress?: (p: { done: number; total: number; created: number; skipped: number }) => void;
  } = {}
): Promise<BackfillResult> {
  const db = opts.db ?? supabaseAdmin();
  const out: BackfillResult = { calls: 0, transcriptsCreated: 0, transcriptsSkipped: 0 };

  const records = await fetchRecords(source, opts.deadlineAt, {
    ignoreCursor: true,
    forceTranscript: true,
    limit: 500,
  });

  // Only records that actually carry a transcript.
  const withTranscript = records.filter(
    (r): r is Record<string, unknown> =>
      !!r && typeof r === "object" && typeof (r as Record<string, unknown>).transcript === "string" &&
      ((r as Record<string, unknown>).transcript as string).trim().length > 0
  );
  const total = withTranscript.length;

  for (const rec of withTranscript) {
    if (opts.deadlineAt && Date.now() > opts.deadlineAt) break;
    const recordId =
      source.record_id_field && rec[source.record_id_field] != null
        ? String(rec[source.record_id_field])
        : undefined;
    const transcript = (rec.transcript as string).trim();
    const { transcript: _omit, ...recNoTx } = rec;

    const res = await ingestTranscript(db, source, recNoTx, transcript, recordId);
    out.calls += 1;
    if (res?.skipped) out.transcriptsSkipped += 1;
    else if (res) out.transcriptsCreated += 1;

    opts.onProgress?.({ done: out.calls, total, created: out.transcriptsCreated, skipped: out.transcriptsSkipped });
  }

  return out;
}

// ---- HTTP + extraction helpers -----------------------------------------------

const MAX_PAGES = 40; // safety cap: MAX_PAGES * limit records per sync
const FETCH_TIMEOUT_MS = 20_000;
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // one page of records

/** Read a response body as text, refusing anything over `maxBytes`. */
async function readBounded(res: Response, maxBytes: number): Promise<string> {
  const declared = Number(res.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`pull response too large (${declared} bytes; limit ${maxBytes})`);
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      throw new Error(`pull response too large (over ${maxBytes} bytes)`);
    }
    parts.push(value);
  }
  return Buffer.concat(parts).toString("utf8");
}

/** Options that let the back-fill reuse this fetcher: sweep every record
 *  (ignore the cursor) and force the transcript to come down on every page. */
interface FetchOpts {
  ignoreCursor?: boolean;
  forceTranscript?: boolean;
  limit?: number;
}

async function fetchRecords(source: DataSourceRow, deadlineAt?: number, opts: FetchOpts = {}): Promise<unknown[]> {
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
  // Ask the call-scoring API to include each call's raw transcript, so the run
  // can also store it as its own document. Forced for the transcript back-fill.
  if (source.source_type === "call_score" || opts.forceTranscript) {
    baseParams.set("include_transcript", "true");
  }
  if (opts.limit && opts.limit > 0) baseParams.set("limit", String(opts.limit));
  const cursorParamName = source.cursor_param ?? source.cursor_field;
  if (!opts.ignoreCursor && cursorParamName && source.cursor_value) {
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

    // No redirects: a public host answering 302 → http://10.0.0.5/… would walk
    // straight past the SSRF guard, which only checked the original URL. A hard
    // timeout and a bounded body keep one slow/huge upstream from pinning the run.
    const res = await fetch(url.toString(), {
      method,
      headers,
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (res.status >= 300 && res.status < 400) {
      throw new Error(`pull request was redirected (${res.status}); redirects are not followed — configure the final URL`);
    }
    if (!res.ok) {
      const body = await readBounded(res, 4_096).catch(() => "");
      throw new Error(`pull request failed: ${res.status} ${res.statusText} ${body.slice(0, 200)}`);
    }
    const raw = await readBounded(res, MAX_RESPONSE_BYTES);
    let json: unknown;
    try {
      json = JSON.parse(raw);
    } catch {
      throw new Error("pull response was not valid JSON");
    }
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
    // Out of time for this run: stop paging. Records are ingested in order and
    // the cursor advances to the last one processed, so the next run resumes.
    if (deadlineAt && Date.now() > deadlineAt) break;
    offset += limit;
  }

  return all;
}

function buildHeaders(source: DataSourceRow): Record<string, string> {
  const headers: Record<string, string> = { accept: "application/json", ...(source.headers ?? {}) };

  const authType = source.auth_type ?? "none";
  if (authType === "none") return headers;

  // The reference is validated on save too; re-checking here means a row edited
  // outside the API can still never read a platform secret.
  if (!source.auth_secret_ref || !isAllowedSecretRef(source.auth_secret_ref)) {
    throw new Error(`auth_secret_ref '${source.auth_secret_ref ?? "(unset)"}' is not an allowed connector credential`);
  }
  const secret = process.env[source.auth_secret_ref];
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
