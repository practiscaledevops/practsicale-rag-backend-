// Structured "call review" retrieval — the EXHAUSTIVE path for a request that
// names a date, a consultant, and/or a practice type and is about reviewing
// calls. Normal retrieval is SEMANTIC: it surfaces the most relevant few calls,
// not EVERY matching call. When the CEO says "review the calls from 22 September"
// / "review James Ephrim's calls" / "review the NEMT calls", the Brain must pull
// EVERY matching call's full transcript (a structured metadata filter), then
// reason over all of them.
//
// Transcripts are ingested as source_type="transcript" chunks whose `metadata`
// carries call_date ("2026-09-22"), consultant_name ("James Ephrim"),
// practice_type ("NEMT"), category (= practice_type), prospect_name, overall_score
// and more. A call's chunks are stored created_at ASC = reading order (summary →
// turns by timestamp). We filter on those JSON keys with PostgREST JSON-path
// operators — `.eq("metadata->>call_date", …)`, `.ilike("metadata->>practice_type",
// …)`, `.or("metadata->>consultant_name.ilike.%…%")` — the same idiom
// alerts.ts (`metadata->>review_date`) and knowledge-read.ts (`attributes->>snapshot`)
// use, so this stays on the verified filter surface.
//
// The parse helpers are PURE (no DB) and unit-tested; the DB fetch is edge-safe
// (no matches / DB error → empty, never throws) and org-scoped on every query.

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RetrievedChunk } from "@/lib/retrieval";

// ---------------------------------------------------------------------------
// The filter a review request resolves to
// ---------------------------------------------------------------------------

export interface CallReviewFilter {
  /** ISO call_date "YYYY-MM-DD" the request named (exact match), if any. */
  date?: string;
  /** Inclusive ISO range ("last 3 days", "this week") — used instead of `date`. */
  dateFrom?: string;
  dateTo?: string;
  /** Raw candidate consultant name phrases (matched case-insensitively, ANY). */
  consultants?: string[];
  /** One of the six canonical practice types, if named. */
  practiceType?: string;
  /** true = exhaustive review path should run (review intent + ≥1 filter dim). */
  isReview: boolean;
}

/** The six known practice types (matched case-insensitively). */
export const PRACTICE_TYPES = ["NEMT", "Home Care", "Home Health", "Assisted Living", "Phlebotomy", "Other"] as const;

// ---------------------------------------------------------------------------
// Detection (pure)
// ---------------------------------------------------------------------------

// Review / analyse / list intent over calls or transcripts. Bare "call(s)" is
// NOT a trigger (that is any sales question); an explicit review verb or an
// exhaustive quantifier ("all/each/every … calls", "which consultant") is.
const REVIEW_RE =
  /\b(review|reviews|reviewing|analy[sz]e|analy[sz]ing|analysis|assess|evaluate|audit|go through|going through|walk through|walking through|break ?down|summar(?:y|ise|ize|ies)|which consultant|list (?:the |all )?calls?|list (?:the )?transcripts?|(?:all|each|every|these|those|the) (?:the )?(?:calls?|transcripts?)|transcripts?)\b/i;

const MONTHS: Record<string, number> = {
  january: 1, jan: 1, february: 2, feb: 2, march: 3, mar: 3, april: 4, apr: 4, may: 5,
  june: 6, jun: 6, july: 7, jul: 7, august: 8, aug: 8, september: 9, sep: 9, sept: 9,
  october: 10, oct: 10, november: 11, nov: 11, december: 12, dec: 12,
};
const MONTH_ALT = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t|tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function toISO(y: number, m: number, d: number): string | undefined {
  if (m < 1 || m > 12 || d < 1 || d > 31) return undefined;
  return `${y}-${pad2(m)}-${pad2(d)}`;
}
function isISODate(s: string | undefined): s is string {
  return !!s && /^\d{4}-\d{2}-\d{2}$/.test(s);
}
/** referenceDate shifted by `deltaDays` (UTC math, no wall-clock drift). */
function shiftISO(refISO: string, deltaDays: number): string {
  const [y, m, d] = refISO.split("-").map(Number);
  const t = new Date(Date.UTC(y, m - 1, d));
  t.setUTCDate(t.getUTCDate() + deltaDays);
  return `${t.getUTCFullYear()}-${pad2(t.getUTCMonth() + 1)}-${pad2(t.getUTCDate())}`;
}

/**
 * Resolve a date the request names to an ISO `call_date` string, or undefined.
 * Formats: ISO (2026-09-22), "September 22"/"Sept 22"/"22 September"/"22 Sept"
 * (± year, ± ordinal), numeric "9/22" (± year), and relative "today"/"yesterday".
 * An omitted year is taken from `referenceDate`'s year; "today"/"yesterday" are
 * anchored to `referenceDate` (the data's newest call_date, NOT the wall clock).
 */
export function resolveDate(query: string, referenceDate: string): string | undefined {
  const ref = isISODate(referenceDate) ? referenceDate : new Date().toISOString().slice(0, 10);
  const refYear = Number(ref.slice(0, 4));
  const q = query;

  // 1) ISO.
  const iso = /\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/.exec(q);
  if (iso) return toISO(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  // 2) Month name + day  (September 22 / Sept 22nd / September 22, 2026).
  const md = new RegExp(`\\b(${MONTH_ALT})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, "i").exec(q);
  if (md) {
    const m = MONTHS[md[1].toLowerCase().replace(/\.$/, "")];
    if (m) return toISO(md[3] ? Number(md[3]) : refYear, m, Number(md[2]));
  }

  // 3) Day + month name  (22 September / 22nd Sept / 22 September 2026).
  const dm = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH_ALT})\\.?(?:,?\\s+(\\d{4}))?\\b`, "i").exec(q);
  if (dm) {
    const m = MONTHS[dm[2].toLowerCase().replace(/\.$/, "")];
    if (m) return toISO(dm[3] ? Number(dm[3]) : refYear, m, Number(dm[1]));
  }

  // 4) Numeric slash date (9/22 → Sep 22; tolerate 22/9). Colon (times) excluded.
  const slash = /(?<![\d/:])(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?(?![\d/:])/.exec(q);
  if (slash) {
    const a = Number(slash[1]);
    const b = Number(slash[2]);
    let yr = slash[3] ? Number(slash[3]) : refYear;
    if (yr < 100) yr += 2000;
    if (a >= 1 && a <= 12 && b >= 1 && b <= 31) return toISO(yr, a, b);
    if (b >= 1 && b <= 12 && a >= 1 && a <= 31) return toISO(yr, b, a);
  }

  // 5) Relative — anchored to the data's newest call_date, not the wall clock.
  if (/\byesterday\b/i.test(q)) return shiftISO(ref, -1);
  if (/\btoday\b/i.test(q)) return ref;

  return undefined;
}

/**
 * A relative date RANGE the request names ("last 3 days", "past week", "this
 * week"), inclusive, anchored to `referenceDate` (the caller passes the real
 * current date). Returns { from, to } ISO or undefined.
 */
export function resolveDateRange(
  query: string,
  referenceDate: string
): { from: string; to: string } | undefined {
  const ref = isISODate(referenceDate) ? referenceDate : new Date().toISOString().slice(0, 10);
  const q = (query ?? "").toLowerCase();
  const LAST = "(?:last|past|previous|recent)";
  let m = new RegExp(`\\b${LAST}\\s+(\\d{1,2})\\s+days?\\b`).exec(q);
  if (m) { const nn = Math.max(1, Math.min(90, Number(m[1]))); return { from: shiftISO(ref, -(nn - 1)), to: ref }; }
  if (new RegExp(`\\b${LAST}\\s+few\\s+days?\\b`).test(q)) return { from: shiftISO(ref, -2), to: ref };
  m = new RegExp(`\\b${LAST}\\s+(\\d{1,2})\\s+weeks?\\b`).exec(q);
  if (m) { const nn = Math.max(1, Math.min(26, Number(m[1]))); return { from: shiftISO(ref, -(nn * 7 - 1)), to: ref }; }
  if (new RegExp(`\\b${LAST}\\s+weeks?\\b`).test(q)) return { from: shiftISO(ref, -6), to: ref };
  m = new RegExp(`\\b${LAST}\\s+(\\d{1,2})\\s+months?\\b`).exec(q);
  if (m) { const nn = Math.max(1, Math.min(12, Number(m[1]))); return { from: shiftISO(ref, -(nn * 30 - 1)), to: ref }; }
  if (/\bthis\s+week\b/.test(q)) { const dow = (new Date(ref + "T00:00:00Z").getUTCDay() + 6) % 7; return { from: shiftISO(ref, -dow), to: ref }; }
  return undefined;
}

/** The named practice type (canonical casing), or undefined. */
export function detectPracticeType(query: string): string | undefined {
  const q = query;
  // Order: specific multi-word phrases before generic ones.
  if (/\bnemt\b/i.test(q)) return "NEMT";
  if (/\bhome\s*health\b/i.test(q)) return "Home Health";
  if (/\bhome\s*care\b/i.test(q)) return "Home Care";
  if (/\bassisted\s*living\b/i.test(q)) return "Assisted Living";
  if (/\bphlebotomy\b/i.test(q)) return "Phlebotomy";
  // "Other" is a real practice type but a dangerous bare word — only when it is
  // clearly a practice reference ("Other calls", "Other practice type").
  if (/\bother\s+(?:practice|calls?|type|prospects?)\b/i.test(q) || /\b(?:practice(?:\s*type)?|type)\s*:?\s*other\b/i.test(q)) return "Other";
  return undefined;
}

// Tokens a capitalised phrase might be that are NEVER a consultant name.
const NAME_STOPWORDS = new Set<string>([
  ...Object.keys(MONTHS),
  "nemt", "home", "care", "health", "assisted", "living", "phlebotomy", "other",
  "review", "reviews", "reviewing", "analyse", "analyze", "analysis", "assess", "evaluate",
  "audit", "list", "breakdown", "summary", "summarise", "summarize",
  "call", "calls", "transcript", "transcripts", "consultant", "consultants", "prospect", "prospects",
  "brain", "practiscale", "the", "all", "each", "every", "which", "what", "how", "who",
  "show", "me", "please", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday",
  "today", "yesterday", "and", "from", "for", "by", "on", "of",
]);

// A broad run of capitalised tokens (each starts uppercase; possessive marks and
// all-caps tokens allowed). We over-capture here on purpose and TRUNCATE in add()
// to the leading run of real name words — so "James Ephrim's NEMT" → "James Ephrim".
const NAME_CORE = "[A-Z][A-Za-z'’.-]*(?:\\s+[A-Z][A-Za-z'’.-]*)*";

/**
 * Candidate consultant name phrases from the query. Fuzzy on purpose: we return
 * the RAW capitalised phrases seen in a consultant context (a possessive, after
 * "consultant", before "call(s)", or after "calls for/by/from") and let the DB
 * match them case-insensitively against `consultant_name` (an ILIKE substring,
 * so "David" matches "David M"). A candidate is truncated at the first word that
 * is a month/practice/stop word or an ALL-CAPS token (a practice type like NEMT),
 * so possessive + practice noise ("James Ephrim's NEMT") never rides along.
 */
export function detectConsultants(query: string): string[] {
  const out: string[] = [];
  const add = (raw: string | undefined) => {
    if (!raw) return;
    // Drop possessive markers anywhere, then keep only the leading run of proper
    // name words (initial cap, not all-caps, not a stop/month/practice word).
    const words = raw.replace(/['’]s?\b/g, "").trim().split(/\s+/);
    const kept: string[] = [];
    for (const w of words) {
      const clean = w.replace(/[.,]+$/, "");
      const lw = clean.toLowerCase();
      if (!clean || !/^[A-Z]/.test(clean) || /^[A-Z]{2,}$/.test(clean) || NAME_STOPWORDS.has(lw)) break;
      kept.push(clean);
    }
    const name = kept.join(" ").trim();
    if (name.length < 2) return;
    if (!out.some((p) => p.toLowerCase() === name.toLowerCase())) out.push(name);
  };

  const patterns: RegExp[] = [
    // Possessive: "James Ephrim's calls", "James's".
    new RegExp(`\\b(${NAME_CORE})['’]s\\b`, "g"),
    // After a role word: "consultant James Ephrim".
    new RegExp(`\\b(?:consultant|consultants|rep|reps|closer|closers|setter|setters)\\s+(${NAME_CORE})`, "gi"),
    // Before calls: "James Ephrim calls" / "James Ephrim's calls".
    new RegExp(`\\b(${NAME_CORE})['’]?s?\\s+calls?\\b`, "g"),
    // After "calls for/by/from": "calls for James Ephrim".
    new RegExp(`\\bcalls?\\s+(?:for|by|from)\\s+(${NAME_CORE})`, "gi"),
    // After a preposition: "performance of James Ephrim", "for James Ephrim".
    new RegExp(`\\b(?:[Oo]f|[Ff]or|[Aa]bout)\\s+(${NAME_CORE})`, "g"),
  ];
  for (const re of patterns) {
    for (const m of query.matchAll(re)) add(m[1]);
  }
  return out.slice(0, 5);
}

/**
 * Parse a request into a structured call-review filter. PURE + unit-tested.
 * `opts.referenceDate` (ISO) anchors "today"/"yesterday" and an omitted year to
 * the data's newest call_date; it defaults to the wall-clock date so the helper
 * is usable/testable on its own. `isReview` is true only when the request reads
 * as a review/analysis/list of calls AND at least one of date/consultant/practice
 * is present; otherwise `{ isReview: false }` (fall back to semantic retrieval).
 */
export function parseCallReviewFilter(query: string, opts?: { referenceDate?: string }): CallReviewFilter {
  const q = (query ?? "").trim();
  if (!q) return { isReview: false };
  const ref = isISODate(opts?.referenceDate) ? (opts!.referenceDate as string) : new Date().toISOString().slice(0, 10);

  const range = resolveDateRange(q, ref);
  const date = range ? undefined : resolveDate(q, ref);
  const practiceType = detectPracticeType(q);
  const consultants = detectConsultants(q);
  const hasFilter = !!date || !!range || !!practiceType || consultants.length > 0;
  const isReview = hasFilter && REVIEW_RE.test(q);

  const filter: CallReviewFilter = { isReview };
  if (range) { filter.dateFrom = range.from; filter.dateTo = range.to; }
  else if (date) filter.date = date;
  if (consultants.length) filter.consultants = consultants;
  if (practiceType) filter.practiceType = practiceType;
  return filter;
}

/** A short human phrase for the filter (for notes and the status label). */
export function describeFilter(f: CallReviewFilter): string {
  const parts: string[] = [];
  if (f.date) parts.push(f.date);
  else if (f.dateFrom && f.dateTo) parts.push(f.dateFrom === f.dateTo ? f.dateFrom : `${f.dateFrom} to ${f.dateTo}`);
  if (f.consultants?.length) parts.push(f.consultants.join(" / "));
  if (f.practiceType) parts.push(`${f.practiceType} calls`);
  return parts.join(" · ") || "matching calls";
}

// ---------------------------------------------------------------------------
// Assembly (pure core, exported for tests) — like retrieval.assembleFullCalls
// ---------------------------------------------------------------------------

/** Approx token count for a chunk: the ingest-stamped count, else ~4 chars/token. */
function chunkTokens(c: RetrievedChunk): number {
  const md = c.metadata as Record<string, unknown> | null | undefined;
  return Number(md?.tokens) || Math.ceil((c.content?.length ?? 0) / 4);
}

/**
 * Pure core of fetchCallsByFilter. Given every matching call's chunks in reading
 * order (`rowsByDoc`: document_id → chunks, created_at ASC = summary then body),
 * include EVERY matching call up to `maxCalls`, each kept in order until its fair
 * token share is spent, but NEVER below its summary + first body chunk (a review
 * needs more than the ends). If more calls match than `maxCalls`/budget allow,
 * `note` says so and how to narrow. `totalMatched` is the full match count.
 */
export function assembleCallSet(
  rowsByDoc: Map<string, RetrievedChunk[]>,
  maxCalls: number,
  maxTokens: number
): { chunks: RetrievedChunk[]; callCount: number; totalMatched: number; note: string | null } {
  const docs = Array.from(rowsByDoc.keys());
  const totalMatched = docs.length;
  const capped = docs.slice(0, Math.max(0, maxCalls));
  const share = capped.length ? Math.floor(maxTokens / capped.length) : 0;

  const chunks: RetrievedChunk[] = [];
  let included = 0;
  let totalUsed = 0;
  for (const docId of capped) {
    const ordered = rowsByDoc.get(docId);
    if (!ordered || ordered.length === 0) continue;
    // Minimum for a call: its summary + first body chunk (first two, or all if fewer).
    const minKeep = ordered.slice(0, Math.min(2, ordered.length));
    const minTokens = minKeep.reduce((s, c) => s + chunkTokens(c), 0);
    // If even the minimum would blow the TOTAL budget and we already have a call, stop.
    if (included > 0 && totalUsed + minTokens > maxTokens) break;

    const kept: RetrievedChunk[] = [];
    let used = 0;
    for (const c of ordered) {
      const t = chunkTokens(c);
      if (kept.length >= 2 && used + t > share) break;
      kept.push(c);
      used += t;
    }
    chunks.push(...kept);
    used = kept.reduce((s, c) => s + chunkTokens(c), 0);
    totalUsed += used;
    included++;
  }

  const note =
    totalMatched > included
      ? `Showing ${included} of ${totalMatched} matching calls (the largest set that fits); ask for a specific consultant or a narrower window for the rest.`
      : null;
  return { chunks, callCount: included, totalMatched, note };
}

// ---------------------------------------------------------------------------
// DB (edge-safe: org-scoped, never `select *`, never throws)
// ---------------------------------------------------------------------------

/** Strip characters that would break an `.or(...)` ilike clause; bound length. */
function sanitizeConsultant(name: string): string {
  return (name ?? "").replace(/[%,(){}"'\\.]/g, " ").replace(/\s+/g, " ").trim().slice(0, 60);
}

// Bound the lightweight match scan. The whole transcript corpus is ~1,600 chunks,
// so this never truncates a real filter (a single practice type is ≤ ~800 chunks).
const MAX_MATCH_ROWS = 5000;

/**
 * The data's newest transcript `call_date` (ISO), or null. Anchors "today"/
 * "yesterday" and an omitted year to the data, not the wall clock. Best-effort.
 */
export async function newestCallDate(db: SupabaseClient, orgId: string): Promise<string | null> {
  try {
    const { data, error } = await db
      .from("chunks")
      .select("cd:metadata->>call_date")
      .eq("org_id", orgId)
      .eq("source_type", "transcript")
      .not("metadata->>call_date", "is", null)
      .order("metadata->>call_date", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error || !data) return null;
    const cd = (data as { cd?: string | null }).cd ?? null;
    return isISODate(cd ?? undefined) ? (cd as string) : null;
  } catch {
    return null;
  }
}

/**
 * Fetch EVERY call matching the filter, as full transcripts, org-scoped. Two
 * bounded queries: (1) the matching calls' document_ids (light) to count the
 * match and pick the first `maxCalls`; (2) the full chunks of only those calls,
 * in reading order. Grouping/budget is delegated to `assembleCallSet`. Chunks
 * are shaped like `RetrievedChunk` (parent_id null, source_type "transcript").
 * No matches → a "No calls found" note; a DB error → empty + log (never throws).
 */
export async function fetchCallsByFilter(
  db: SupabaseClient,
  orgId: string,
  filter: CallReviewFilter,
  opts: { maxCalls: number; maxTokens: number }
): Promise<{ chunks: RetrievedChunk[]; callCount: number; note: string | null }> {
  const applyFilters = <T extends { eq: Function; ilike: Function; or: Function; gte: Function; lte: Function }>(q: T): T => {
    let out = q.eq("org_id", orgId).eq("source_type", "transcript");
    if (filter.date) out = out.eq("metadata->>call_date", filter.date);
    else if (filter.dateFrom && filter.dateTo) out = out.gte("metadata->>call_date", filter.dateFrom).lte("metadata->>call_date", filter.dateTo);
    if (filter.practiceType) out = out.ilike("metadata->>practice_type", filter.practiceType);
    const cands = (filter.consultants ?? []).map(sanitizeConsultant).filter(Boolean);
    if (cands.length) out = out.or(cands.map((c) => `metadata->>consultant_name.ilike.%${c}%`).join(","));
    return out;
  };

  try {
    // 1) Which calls match — document_ids only (never `select *`).
    const idQuery = applyFilters(db.from("chunks").select("document_id"))
      .order("document_id", { ascending: true })
      .limit(MAX_MATCH_ROWS);
    const { data: idRows, error: idErr } = await idQuery;
    if (idErr) {
      console.error("[call-review] match scan failed:", idErr.message);
      return { chunks: [], callCount: 0, note: null };
    }
    const orderedDocs: string[] = [];
    for (const r of (idRows ?? []) as { document_id: string }[]) {
      if (r.document_id && !orderedDocs.includes(r.document_id)) orderedDocs.push(r.document_id);
    }
    const totalMatched = orderedDocs.length;
    if (totalMatched === 0) {
      return { chunks: [], callCount: 0, note: `No calls found for ${describeFilter(filter)} in the Brain.` };
    }

    // 2) Full chunks for the chosen calls only, in reading order (created_at ASC
    //    = summary → body by timestamp). Select just the pipeline's fields — never
    //    `*`, which would pull the 1024-float embedding. Re-filter by org_id.
    const chosen = orderedDocs.slice(0, Math.max(1, opts.maxCalls));
    const { data: rows, error } = await db
      .from("chunks")
      .select("id, content, metadata, document_id, created_at")
      .eq("org_id", orgId)
      .eq("source_type", "transcript")
      .in("document_id", chosen)
      .order("document_id", { ascending: true })
      .order("created_at", { ascending: true });
    if (error || !rows) {
      console.error("[call-review] chunk fetch failed:", error?.message ?? "no data");
      return { chunks: [], callCount: 0, note: null };
    }

    const rowsByDoc = new Map<string, RetrievedChunk[]>();
    for (const r of rows as (RetrievedChunk & { created_at?: string })[]) {
      const shaped: RetrievedChunk = {
        id: r.id,
        content: r.content,
        metadata: (r.metadata as Record<string, unknown>) ?? {},
        document_id: r.document_id,
        parent_id: null,
        source_type: "transcript",
      };
      rowsByDoc.set(r.document_id, [...(rowsByDoc.get(r.document_id) ?? []), shaped]);
    }

    const assembled = assembleCallSet(rowsByDoc, opts.maxCalls, opts.maxTokens);
    // Note from the AUTHORITATIVE total match count (query 1), which sees calls
    // beyond the ones we fetched in full.
    const note =
      totalMatched > assembled.callCount
        ? `Showing ${assembled.callCount} of ${totalMatched} matching calls (the largest set that fits); ask for a specific consultant or a narrower window for the rest.`
        : null;
    return { chunks: assembled.chunks, callCount: assembled.callCount, note };
  } catch (e) {
    console.error("[call-review] fetch error:", e instanceof Error ? e.message : e);
    return { chunks: [], callCount: 0, note: null };
  }
}
