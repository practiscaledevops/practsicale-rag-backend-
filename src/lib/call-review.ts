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
//
// Dates are the ASKING USER's calendar days: "today", "yesterday", "this week",
// "Sep 24" resolve in the caller's IANA time zone (`timeZone`, lib/timezone;
// default = the business zone, Asia/Karachi), and a day filter matches calls
// whose created_at falls inside that zone's day (DST-exact UTC bounds).

import type { SupabaseClient } from "@supabase/supabase-js";
import type { RetrievedChunk } from "@/lib/retrieval";
import { DEFAULT_TIME_ZONE, localDate, localDateTime, resolveTimeZone, zonedDayBoundsUTC } from "@/lib/timezone";

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

/** One row of the complete roster for a review (every matching call, cheap metadata). */
export interface ScorecardRow {
  /** The call's local date ("YYYY-MM-DD") in the review's zone; the stored call_date when created_at is unusable. */
  date: string;
  /** The call's local clock time ("HH:mm") in the review's zone; null when created_at is unusable. */
  time: string | null;
  consultant: string;
  prospect: string;
  practice: string;
  score: number | null;
  band: string | null;
  outcome: string | null;
  duration: number | null;
}

/** The six known practice types (matched case-insensitively). */
export const PRACTICE_TYPES = ["NEMT", "Home Care", "Home Health", "Assisted Living", "Phlebotomy", "Other"] as const;

// ---------------------------------------------------------------------------
// Detection (pure)
// ---------------------------------------------------------------------------

// Review / analyse / list intent over calls or transcripts. Bare "call(s)" is
// NOT a trigger (that is any sales question); an explicit review verb or an
// exhaustive quantifier ("all/each/every … calls", "which consultant") is.
// A listing verb may sit a few words before "calls" ("list yesterday consultants
// calls", "show me James's NEMT calls"); "show up" (the show-up rate) is not one.
// The words in between must point AT calls (a date, name, practice, determiner):
// a question word, preposition or coaching noun makes it a how-to question
// ("give me tips for NEMT calls", "show me how James handles calls").
const LIST_GAP_STOP =
  "(?:how|what|why|when|where|to|for|on|about|with|tips?|advice|ideas?|examples?|scripts?|ways?|best|pointers?|suggestions?|guidance|help|feedback|techniques?|strateg(?:y|ies)|openers?|lines?)";
const REVIEW_RE = new RegExp(
  String.raw`\b(review|reviews|reviewing|analy[sz]e|analy[sz]ing|analysis|assess|evaluate|audit|deep[- ]?dive|go through|going through|walk through|walking through|break ?down|summar(?:y|ise|ize|ies)|which consultant|list (?:the |all )?calls?|list (?:the )?transcripts?|(?:list|show me|pull up|pull|fetch|give me)\s+(?:(?!${LIST_GAP_STOP}\b)[\w'’-]+\s+){0,3}?(?:calls?|transcripts?)|(?:all|each|every|these|those|the) (?:the )?(?:calls?|transcripts?)|transcripts?)\b`,
  "i"
);

/** True when the query carries a review/audit/analyse verb (no filter required). */
export function looksLikeReview(query: string): boolean {
  return REVIEW_RE.test(query ?? "");
}

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

/** Today's date in `timeZone` — the fallback anchor when no valid referenceDate is given. */
function todayISO(timeZone: string | undefined): string {
  return localDate(Date.now(), timeZone ?? DEFAULT_TIME_ZONE);
}

// The scoring app shows each call's date in the OFFICE zone (Asia/Karachi) — a
// call created 2026-09-23T20:22Z shows as Sep 24 there — but the person asking
// may be elsewhere (the CEO asks from the USA). A call's day is read in the
// asker's zone; with no zone it is the business zone (lib/timezone
// DEFAULT_TIME_ZONE: SCORING_TIME_ZONE, legacy SCORING_TZ_OFFSET_MIN, Asia/Karachi).
/** The local YYYY-MM-DD of an ISO timestamp in `timeZone` (default: the business zone), or null. */
export function businessDay(ts: unknown, timeZone: string = DEFAULT_TIME_ZONE): string | null {
  const t = Date.parse(String(ts ?? ""));
  if (Number.isNaN(t)) return null;
  return localDate(t, timeZone);
}
/** UTC [start,end) instants bounding a local day in `timeZone` (DST-exact) — for filtering created_at. */
function dayBoundsUTC(localDateISO: string, timeZone: string): { start: string; end: string } {
  const b = zonedDayBoundsUTC(localDateISO, timeZone);
  return { start: b.startISO, end: b.endISO };
}
/**
 * The local "YYYY-MM-DD HH:mm" of an ISO timestamp in `timeZone`, or null when it
 * is absent / unparseable (a legacy created_at PII-mangled to "[PHONE]" — never
 * throws, localDateTime would).
 */
function localStamp(ts: unknown, timeZone: string): string | null {
  const t = Date.parse(String(ts ?? ""));
  return Number.isNaN(t) ? null : localDateTime(t, timeZone);
}
/** A scorecard row from a transcript summary chunk's metadata (date + time = created_at in `timeZone`). */
function toScorecardRow(m: Record<string, unknown>, timeZone: string): ScorecardRow {
  const local = localStamp(m.created_at, timeZone);
  return {
    date: local ? local.slice(0, 10) : (typeof m.call_date === "string" ? m.call_date : ""),
    time: local ? local.slice(11) : null,
    consultant: typeof m.consultant_name === "string" ? m.consultant_name : "Unknown",
    prospect: typeof m.prospect_name === "string" ? m.prospect_name : "",
    practice: typeof m.practice_type === "string" ? m.practice_type : (typeof m.category === "string" ? m.category : ""),
    score: m.overall_score != null ? Number(m.overall_score) : null,
    band: typeof m.performance_band === "string" ? m.performance_band : null,
    outcome: typeof m.call_outcome === "string" ? m.call_outcome : null,
    duration: m.call_duration_minutes != null ? Number(m.call_duration_minutes) : null,
  };
}

/**
 * Resolve a date the request names to an ISO `call_date` string, or undefined.
 * Formats: ISO (2026-09-22), "September 22"/"Sept 22"/"22 September"/"22 Sept"
 * (± year, ± ordinal), numeric "9/22" (± year), and relative "today"/"yesterday".
 * An omitted year is taken from `referenceDate`'s year; "today"/"yesterday" are
 * anchored to `referenceDate` (the caller passes the user's today in their zone).
 * Without a valid `referenceDate`, today in `timeZone` (default: business zone).
 */
export function resolveDate(query: string, referenceDate: string, timeZone?: string): string | undefined {
  const ref = isISODate(referenceDate) ? referenceDate : todayISO(timeZone);
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
  if (/\byesterdays?\b/i.test(q)) return shiftISO(ref, -1);
  if (/\btodays?\b/i.test(q)) return ref;

  return undefined;
}

/**
 * A relative date RANGE the request names ("last 3 days", "past week", "this
 * week"), inclusive, anchored to `referenceDate` (the caller passes the user's
 * current date in their zone; without one, today in `timeZone`). Returns
 * { from, to } ISO or undefined.
 */
export function resolveDateRange(
  query: string,
  referenceDate: string,
  timeZone?: string
): { from: string; to: string } | undefined {
  const ref = isISODate(referenceDate) ? referenceDate : todayISO(timeZone);
  const q = (query ?? "").toLowerCase();
  const ry = Number(ref.slice(0, 4));
  const rm = Number(ref.slice(5, 7));
  const firstOf = (y: number, mo: number) => `${y}-${pad2(mo)}-01`;
  const lastOf = (y: number, mo: number) => {
    const d = new Date(Date.UTC(y, mo, 0));
    return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
  };
  // Whole-month ranges. "this/current month" or "monthly" -> the present month
  // up to today; "last month" -> the full previous month; "this year".
  if (/\b(this|current)\s+month\b/.test(q) || /\bmonthly\b/.test(q) || /\bthis\s+month/.test(q))
    return { from: firstOf(ry, rm), to: ref };
  if (/\b(last|previous|prior|past)\s+month\b/.test(q)) {
    const py = rm === 1 ? ry - 1 : ry;
    const pm = rm === 1 ? 12 : rm - 1;
    return { from: firstOf(py, pm), to: lastOf(py, pm) };
  }
  if (/\b(this|current)\s+year\b/.test(q)) return { from: `${ry}-01-01`, to: ref };
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
  // Follow-up / conversational openers ("And David's?", "Now James's calls").
  "about", "also", "now", "then", "ok", "okay", "same", "plus", "or", "but", "so", "just", "again",
  "do", "did", "can", "could", "would", "should", "deep", "dive", "score", "scores", "grade", "compare",
  "coach", "them", "these", "those", "both", "everyone", "everybody", "team", "whole",
  "last", "this", "next", "past", "previous", "recent", "current", "week", "month", "year",
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
    // Stop words BEFORE the name are skipped, so a capitalised sentence opener
    // ("And David's?", "Review James's calls") doesn't swallow the name.
    const words = raw.replace(/['’]s?\b/g, "").trim().split(/\s+/);
    const kept: string[] = [];
    for (const w of words) {
      const clean = w.replace(/[.,?!;:]+$/, "");
      const lw = clean.toLowerCase();
      if (!clean || !/^[A-Z]/.test(clean) || /^[A-Z]{2,}$/.test(clean) || NAME_STOPWORDS.has(lw)) {
        if (kept.length === 0 && clean && NAME_STOPWORDS.has(lw)) continue;
        break;
      }
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
 * `opts.referenceDate` (ISO) anchors "today"/"yesterday" and an omitted year —
 * the caller passes the user's today in their zone; it defaults to today in
 * `opts.timeZone` (default: the business zone) so the helper is usable/testable
 * on its own. `isReview` is true only when the request reads
 * as a review/analysis/list of calls AND at least one of date/consultant/practice
 * is present; otherwise `{ isReview: false }` (fall back to semantic retrieval).
 */
export function parseCallReviewFilter(
  query: string,
  opts?: { referenceDate?: string; knownConsultants?: string[]; timeZone?: string }
): CallReviewFilter {
  // Normalize dashed / slashed word-dates ("24-sep-2026", "sep-24-2026") so the
  // month-name parsers below see spaces; digit-digit dates (9/22, 2026-09-24) are
  // left intact.
  const q = (query ?? "")
    .trim()
    .replace(/(\d)[-/](?=[a-z])/gi, "$1 ")
    .replace(/([a-z])[-/](?=\d)/gi, "$1 ");
  if (!q) return { isReview: false };
  const ref = isISODate(opts?.referenceDate) ? (opts!.referenceDate as string) : todayISO(opts?.timeZone);

  const range = resolveDateRange(q, ref);
  const date = range ? undefined : resolveDate(q, ref);
  const practiceType = detectPracticeType(q);
  let consultants = detectConsultants(q);
  // Fallback: match KNOWN consultant names case-insensitively, so a lowercase
  // first name ("audit of james calls") still resolves. The DB match is an
  // ILIKE substring, so "james" correctly covers every "James ...".
  if (consultants.length === 0 && opts?.knownConsultants?.length) {
    const lc = " " + q.toLowerCase().replace(/[^a-z0-9]+/g, " ") + " ";
    const hits = new Set<string>();
    for (const full of opts.knownConsultants) {
      const fl = full.toLowerCase();
      if (lc.includes(" " + fl + " ") || lc.includes(fl)) { hits.add(full); continue; }
      const first = fl.split(" ")[0];
      if (first.length >= 3 && lc.includes(" " + first + " ")) hits.add(first);
    }
    if (hits.size) consultants = [...hits];
  }
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
// Conversation continuity (pure) — follow-ups inherit the earlier filter
// ---------------------------------------------------------------------------
//
// "list yesterday consultants calls" → "analyse all calls do audit" / "audit
// them" / "and David's?" must keep yesterday (and any consultant / practice) from
// the earlier turn. Deterministic and cheap: regex parses only, no model call.

/** A conversation turn as the chat / jobs APIs carry it. */
export interface ReviewHistoryTurn {
  role: string;
  content: string;
  /**
   * When the turn was sent (ISO timestamp), if the caller supplied it. Relative
   * dates in that turn ("yesterday", "last week") are resolved against the day
   * it was sent in the user's time zone, not today's, so a chat continued the
   * next day keeps the same calls.
   */
  createdAt?: string;
}

/** A compaction summary is a system turn whose content starts with this marker. */
export const CONVERSATION_SUMMARY_PREFIX = "[Conversation summary]";

/** True for a compaction-summary system turn ("[Conversation summary] …"). */
export function isConversationSummary(turn: { role?: unknown; content?: unknown } | null | undefined): boolean {
  return (
    !!turn &&
    turn.role === "system" &&
    typeof turn.content === "string" &&
    turn.content.trimStart().startsWith(CONVERSATION_SUMMARY_PREFIX)
  );
}

// An analysis / audit action on results ("audit", "deep dive", "score", "break … down").
const FOLLOW_UP_VERB_RE =
  /\b(audit(?:s|ed|ing)?|analy[sz](?:e|es|ed|ing)|analysis|review(?:s|ed|ing)?|scor(?:e|es|ed|ing)|grad(?:e|es|ed|ing)|summar(?:y|ise|ize|ised|ized|ising|izing)|break(?:ing)?\s+(?:[a-z]+\s+)?down|breakdown|compar(?:e|es|ed|ing|ison)|deep[- ]?dive|evaluat(?:e|es|ed|ing|ion)|assess(?:ment)?|coach(?:ing)?|critique|go(?:ing)? through|walk(?:ing)? (?:me )?through)\b/i;

// A reference to the previous results. Bare "all/each/every" counts only when it
// points at calls / "of them" / ends the request — "compare all our pricing
// plans" is not a reference to earlier calls.
const FOLLOW_UP_REF_RE =
  /\b(?:them|these|those|they|their|both|above|the same|the (?:calls?|transcripts?|ones|list))\b|\b(?:all|each|every)(?=\s*(?:$|[?.!,;:]|(?:of|one|ones|them|these|those)\b|(?:the\s+)?(?:[\w'’-]+\s+)?(?:calls?|transcripts?)\b))/i;

// Content-creation asks are not call reviews even when short ("write David's post").
const GENERATION_RE =
  /\b(write|draft|compose|create|generate|rewrite|translate|linkedin|tweet|post|email|e-mail|blog|newsletter|caption|script|hook|slogan|ad copy|landing page|poem)\b/i;
// Thanks / acknowledgement — "thanks, great review!" must not re-run a review.
const ACK_RE = /\b(thanks?|thank you|thx|appreciated?|great job|good job|nice work|well done|awesome|perfect|love (?:it|this|that))\b/i;

// Explicit widening: drop the inherited consultant / practice / date dimension.
const WIDEN_CONSULTANTS_RE =
  /\b(?:(?:all|every|each|any)\s+(?:(?:of\s+)?(?:the|our)\s+)?(?:consultants?|reps?|closers?|setters?|agents?|sales ?people|team members?)|(?:whole|entire|full)\s+team|everyone|everybody|team[- ]?wide|across the (?:whole |entire )?team|regardless of (?:the )?consultants?)\b/i;
const WIDEN_PRACTICE_RE =
  /\b(?:(?:all|every|each|any)\s+(?:(?:of\s+)?the\s+)?(?:practices?|practice types?|verticals?)|regardless of (?:the )?practice(?: type)?)\b/i;
const WIDEN_DATE_RE = /\b(?:all[- ]time|all dates|any date|every date|ever|since (?:the )?(?:start|beginning))\b/i;

// A turn that is about calls (so its filter can anchor a later follow-up even
// without a review verb — "how did today's calls go?" then "audit james calls").
const CALL_CONTEXT_RE = /\b(calls?|transcripts?|consultants?)\b/i;

// Call-specific analysis verbs. A GENERIC action ("compare / summarise / break
// down these") refers to the immediately preceding answer, so it only reaches
// back past an unrelated turn to an older call review when it uses one of these
// or names calls ("audit them", "compare those calls").
const STRONG_FOLLOW_UP_VERB_RE = /\b(audit(?:s|ed|ing)?|review(?:s|ed|ing)?|scor(?:e|es|ed|ing)|grad(?:e|es|ed|ing)|deep[- ]?dive|coach(?:ing)?)\b/i;

// A short turn right after a review can be a bare follow-up ("and David's?").
const SHORT_FOLLOW_UP_WORDS = 8;
// Bound the text parsed per history turn (a pasted document is not a filter).
const MAX_PARSE_CHARS = 4000;
const MAX_SUMMARY_PARSE_CHARS = 20_000;

function hasFilterDims(f: CallReviewFilter): boolean {
  return !!(f.date || (f.dateFrom && f.dateTo) || f.consultants?.length || f.practiceType);
}

/**
 * True when the request is an analysis / audit ACTION on the previous results
 * rather than a self-contained request: an analysis verb (audit, analyse,
 * review, score, grade, summarise, break down, compare, deep dive, evaluate,
 * coach) plus a reference to earlier results (them / these / those / all /
 * each / every / the calls). Content-creation asks ("summarize them into an
 * email") and thanks ("thanks, can you summarize all of that?") never are.
 * Pure; history-independent.
 */
export function isReviewFollowUp(query: string): boolean {
  const q = (query ?? "").trim().slice(0, MAX_PARSE_CHARS);
  if (!q) return false;
  if (GENERATION_RE.test(q) || ACK_RE.test(q)) return false;
  return FOLLOW_UP_VERB_RE.test(q) && FOLLOW_UP_REF_RE.test(q);
}

// Words a bare filter-swap fragment may carry besides the filter itself
// ("and David's?", "what about NEMT?", "now the NEMT ones", "same for last week").
const FRAGMENT_FILLER = new Set<string>([
  "and", "what", "about", "how", "now", "then", "also", "too", "same", "for", "on", "from", "of", "in", "to",
  "the", "a", "ones", "one", "only", "just", "instead", "again", "plus", "or", "but", "so", "ok", "okay",
  "calls", "call", "transcripts", "transcript", "his", "her", "their", "those", "these", "them", "with",
  "yesterday", "yesterdays", "today", "todays", "last", "this", "past", "previous", "prior", "recent", "current",
  "day", "days", "week", "weeks", "month", "months", "year", "few", "st", "nd", "rd", "th",
]);

/** True when the turn is ONLY a filter swap: nothing but date / consultant / practice + filler words. */
function isBareFilterFragment(query: string, own: CallReviewFilter): boolean {
  let s = " " + query.toLowerCase() + " ";
  for (const n of own.consultants ?? []) s = s.split(n.toLowerCase()).join(" ");
  s = s
    .replace(/\b(?:nemt|home\s*health|home\s*care|assisted\s*living|phlebotomy|other)\b/g, " ")
    .replace(new RegExp(`\\b(?:${MONTH_ALT})\\b`, "g"), " ")
    .replace(/['’]s?\b/g, " ")
    .replace(/[^a-z]+/g, " ");
  return s.split(/\s+/).filter(Boolean).every((w) => FRAGMENT_FILLER.has(w));
}

/** A very short turn that continues the previous review ("and David's?", "what about yesterday?", "do a deep audit"). */
function isShortFollowUp(query: string, own: CallReviewFilter): boolean {
  const q = (query ?? "").trim();
  const words = q.split(/\s+/).filter(Boolean);
  if (!words.length || words.length > SHORT_FOLLOW_UP_WORDS) return false;
  if (GENERATION_RE.test(q)) return false;
  // Naming a date / consultant / practice is a follow-up only when that is ALL the
  // turn says - "what's our NEMT pricing?" is a pricing question, not a review.
  if (hasFilterDims(own)) return isBareFilterFragment(q, own) || (FOLLOW_UP_VERB_RE.test(q) && !ACK_RE.test(q));
  if (WIDEN_CONSULTANTS_RE.test(q) || WIDEN_PRACTICE_RE.test(q)) return true;
  return FOLLOW_UP_VERB_RE.test(q) && !ACK_RE.test(q);
}

/** `own` (what this turn names) over `prior` (the conversation's active filter), minus explicit widenings. */
function mergeFilters(own: CallReviewFilter, prior: CallReviewFilter, query: string): CallReviewFilter {
  const out: CallReviewFilter = { isReview: false };
  const dateSrc = own.date || own.dateFrom ? own : WIDEN_DATE_RE.test(query) ? null : prior;
  if (dateSrc?.dateFrom && dateSrc.dateTo) {
    out.dateFrom = dateSrc.dateFrom;
    out.dateTo = dateSrc.dateTo;
  } else if (dateSrc?.date) out.date = dateSrc.date;
  if (own.consultants?.length) out.consultants = [...own.consultants];
  else if (prior.consultants?.length && !WIDEN_CONSULTANTS_RE.test(query)) out.consultants = [...prior.consultants];
  if (own.practiceType) out.practiceType = own.practiceType;
  else if (prior.practiceType && !WIDEN_PRACTICE_RE.test(query)) out.practiceType = prior.practiceType;
  out.isReview = hasFilterDims(out);
  return out;
}

type ParseOpts = { referenceDate: string; knownConsultants: string[]; timeZone?: string };

/** Resolve one turn against the conversation's active filter (null = none yet). */
function resolveTurn(query: string, active: CallReviewFilter | null, prevWasReview: boolean, opts: ParseOpts): CallReviewFilter {
  const own = parseCallReviewFilter(query, opts);
  if (!active) return own;
  // An action on earlier results continues the review right after it; past an
  // unrelated turn only a call-specific action ("audit them", "compare those calls") does.
  const action =
    isReviewFollowUp(query) && (prevWasReview || CALL_CONTEXT_RE.test(query) || STRONG_FOLLOW_UP_VERB_RE.test(query));
  const followUp = own.isReview || action || (prevWasReview && isShortFollowUp(query, own));
  return followUp ? mergeFilters(own, active, query) : own;
}

const ISO_DATE_G = /\b(20\d{2})-(\d{2})-(\d{2})\b/g;
const FILTER_NONE_RE = /^(?:none|n\/a|na|all|any|everyone|everybody|unspecified|not specified|unknown|-|—)$/i;

function isoDatesIn(s: string): string[] {
  const out: string[] = [];
  for (const m of s.matchAll(ISO_DATE_G)) {
    const iso = toISO(Number(m[1]), Number(m[2]), Number(m[3]));
    if (iso) out.push(iso);
  }
  return out;
}

/**
 * The structured line the compaction prompt asks for:
 *   "Active call-review filter: date=2026-09-24 | range=… to … | consultants=A, B | practice=NEMT"
 * Tolerant of spacing / separators; unknown or "none" parts are ignored.
 */
function parseFilterLine(seg: string): CallReviewFilter | null {
  const s = seg.slice(0, 1000);
  const out: CallReviewFilter = { isReview: false };
  const part = (re: RegExp) => re.exec(s)?.[1]?.trim() ?? "";
  const rangeDates = isoDatesIn(part(/\b(?:range|dates?\s*range|from)\s*[:=]\s*([^|;\n]+)/i)).sort();
  const dateOne = isoDatesIn(part(/\bdate\s*[:=]\s*([^|;\n]+)/i))[0];
  const all = isoDatesIn(s).sort();
  if (rangeDates.length >= 2) {
    out.dateFrom = rangeDates[0];
    out.dateTo = rangeDates[rangeDates.length - 1];
  } else if (dateOne) out.date = dateOne;
  else if (all.length >= 2) {
    out.dateFrom = all[0];
    out.dateTo = all[all.length - 1];
  } else if (all.length === 1) out.date = all[0];
  const names = part(/\bconsultants?\s*[:=]\s*([^|;\n]+)/i)
    .split(/\s*(?:,|\/|&|\band\b)\s*/i)
    .map((n) => n.replace(/[."'`]+$/g, "").trim())
    .filter((n) => n.length >= 2 && n.length <= 60 && /[a-z]/i.test(n) && !FILTER_NONE_RE.test(n));
  if (names.length) out.consultants = names.slice(0, 5);
  const practice = part(/\bpractice(?:[ _-]?type)?\s*[:=]\s*([^|;\n]+)/i);
  if (practice && !FILTER_NONE_RE.test(practice)) {
    const pt = detectPracticeType(practice) ?? PRACTICE_TYPES.find((p) => p.toLowerCase() === practice.toLowerCase());
    if (pt) out.practiceType = pt;
  }
  out.isReview = hasFilterDims(out);
  return out.isReview ? out : null;
}

/**
 * The call filter a compaction summary carries, or null. Prefers the explicit
 * "Active call-review filter:" line; otherwise (last resort) the LAST line that
 * is about CALLS — review intent first, then any call line that is not a
 * content-creation ask. A line that never mentions calls / transcripts /
 * consultants ("an analysis of the SOP revision dated …") is never a filter.
 */
function filterFromSummary(text: string, opts: ParseOpts): CallReviewFilter | null {
  const body = text.trimStart().slice(CONVERSATION_SUMMARY_PREFIX.length).slice(0, MAX_SUMMARY_PARSE_CHARS);
  const lines = body.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /active call[- ]?review filter\s*[:=\-–—]\s*(.*)$/i.exec(lines[i]);
    // An explicit line is authoritative: "none" means no active filter — don't guess.
    if (m) return parseFilterLine(m[1]);
  }
  for (const accept of [
    // "summary" is how every summary talks, not review intent.
    (l: string) => CALL_CONTEXT_RE.test(l) && REVIEW_RE.test(l.replace(/\bsummar(?:y|ise|ize|ies)\b/gi, "")),
    (l: string) => CALL_CONTEXT_RE.test(l) && !GENERATION_RE.test(l),
  ]) {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!accept(lines[i])) continue;
      const f = parseCallReviewFilter(lines[i].slice(0, MAX_PARSE_CHARS), opts);
      if (hasFilterDims(f)) return { ...f, isReview: true };
    }
  }
  return null;
}

/**
 * True when a compaction-summary turn carries a call filter (its explicit
 * "Active call-review filter" line, or a call-review line). The orchestrator's
 * review-thread signal uses this instead of keyword-testing the summary, whose
 * "[Conversation summary]" marker alone reads as review intent.
 */
export function summaryCarriesCallFilter(
  text: string,
  opts: { referenceDate: string; knownConsultants?: string[]; timeZone?: string }
): boolean {
  return !!filterFromSummary(text, { referenceDate: opts.referenceDate, knownConsultants: opts.knownConsultants ?? [], timeZone: opts.timeZone });
}

/**
 * The day a history turn was sent (its ISO `createdAt`, read in the user's
 * `timeZone`), never later than `today`; else `today`. A bare "YYYY-MM-DD" is
 * already a local date and is kept as is.
 */
function turnReferenceDate(createdAt: unknown, today: string, timeZone?: string): string {
  if (typeof createdAt !== "string") return today;
  const ts = createdAt.trim();
  // ISO only ("2026-09-24", "2026-09-24T10:00:00Z", "… +00:00"): Date.parse is
  // lenient enough to read "1" as a year, which must not move the anchor.
  if (!/^\d{4}-\d{2}-\d{2}(?:$|[T ]\d{2}:\d{2})/.test(ts)) return today;
  const day = isISODate(ts) ? (Number.isNaN(Date.parse(ts)) ? null : ts) : businessDay(ts, timeZone ?? DEFAULT_TIME_ZONE);
  return day && day <= today ? day : today;
}

/**
 * Resolve a request's call-review filter WITH the conversation, so follow-ups
 * keep the earlier filters. PURE + unit-tested.
 *
 *  1. Parse the current query on its own (parseCallReviewFilter).
 *  2. The conversation's ACTIVE filter is the most recent earlier USER turn that
 *     resolves as a review (itself resolved against the turns before it, so a
 *     chain "list yesterday's calls" → "and David's?" → "what about NEMT?" keeps
 *     building), or that is about calls and names a date / consultant / practice
 *     ("how did today's calls go?"). A leading compaction summary system turn
 *     ("[Conversation summary] …") is the last resort when no user turn yields one.
 *  3. A current query that is a review by itself inherits each dimension it
 *     does not name (date/range, consultants, practice type). Consultants are
 *     NOT inherited when it widens explicitly ("all consultants", "everyone",
 *     "whole team", "team-wide"); likewise "all practice types" / "all-time".
 *  4. A current query that is NOT a review by itself is still a review
 *     (inheriting the active filter) when it is an action on the previous results
 *     (isReviewFollowUp: "audit them", "analyse all calls", "do a deep audit of
 *     these") or a very short follow-up right after a review that is only a
 *     filter swap or an analysis verb ("and David's?", "what about yesterday?",
 *     "do a deep audit" — not "what's our NEMT pricing?"). Past an unrelated turn,
 *     only a call-specific action ("audit them", "compare those calls") reaches
 *     back. Content-creation asks ("write me a LinkedIn post") and thanks are
 *     never follow-ups, and a content-creation turn expires the active filter.
 *
 * `opts.referenceDate` is the user's today in `opts.timeZone` (the asking
 * user's IANA zone; default: the business zone). A history turn's relative dates
 * resolve against the day of its `createdAt` in that zone (when supplied and not
 * in the future), else `referenceDate`. The chat API's history ends with the
 * current message; that trailing copy is ignored. Returns the standalone parse
 * when nothing is inherited.
 */
export function resolveReviewFilterWithHistory(
  query: string,
  history: ReviewHistoryTurn[],
  opts: { referenceDate: string; knownConsultants: string[]; timeZone?: string }
): CallReviewFilter {
  const parseOpts: ParseOpts = { referenceDate: opts.referenceDate, knownConsultants: opts.knownConsultants ?? [], timeZone: opts.timeZone };
  const q = (query ?? "").trim();
  const turns = (Array.isArray(history) ? history : []).filter(
    (t): t is ReviewHistoryTurn => !!t && typeof t.role === "string" && typeof t.content === "string"
  );
  let end = turns.length;
  if (end > 0 && turns[end - 1].role === "user" && turns[end - 1].content.trim() === q) end--;

  let active: CallReviewFilter | null = null;
  let prevWasReview = false;
  for (let i = 0; i < end; i++) {
    const t = turns[i];
    // Relative dates in an earlier turn mean the day THAT turn was sent ("list
    // yesterday's calls" asked on the 24th is the 23rd, even when the chat is
    // continued on the 25th). `active` then holds absolute ISO dates.
    const turnOpts: ParseOpts = { ...parseOpts, referenceDate: turnReferenceDate(t.createdAt, parseOpts.referenceDate, parseOpts.timeZone) };
    if (t.role === "user") {
      const text = t.content.slice(0, MAX_PARSE_CHARS);
      const r = resolveTurn(text, active, prevWasReview, turnOpts);
      if (r.isReview && hasFilterDims(r)) {
        active = r;
        prevWasReview = true;
      } else if (hasFilterDims(r) && CALL_CONTEXT_RE.test(text) && !GENERATION_RE.test(text)) {
        active = { ...r, isReview: true };
        prevWasReview = true;
      } else {
        prevWasReview = false;
        // A content-creation ask replaces what "these / them" refer to: a later
        // "compare these" is about the new content, not the old call set.
        if (GENERATION_RE.test(text)) active = null;
      }
    } else if (!active && isConversationSummary(t)) {
      const s = filterFromSummary(t.content, turnOpts);
      if (s) {
        active = s;
        prevWasReview = true;
      }
    }
  }
  return resolveTurn(q, active, prevWasReview, parseOpts);
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
/** Every matching call's document_id + a complete scorecard, no transcript fetch
 *  (used to PLAN a background audit job). Filters by created_at's day in
 *  `opts.timeZone` (the requester's zone; default: the business zone). */
export async function matchingCallDocs(
  db: SupabaseClient,
  orgId: string,
  filter: CallReviewFilter,
  opts?: { timeZone?: string }
): Promise<{ docIds: string[]; scorecard: ScorecardRow[] }> {
  const timeZone = resolveTimeZone(opts?.timeZone);
  const apply = <T extends { eq: Function; ilike: Function; or: Function; gte: Function; lt: Function }>(q: T): T => {
    let out = q.eq("org_id", orgId).eq("source_type", "transcript");
    if (filter.date) {
      const b = dayBoundsUTC(filter.date, timeZone);
      out = out.gte("metadata->>created_at", b.start).lt("metadata->>created_at", b.end);
    } else if (filter.dateFrom && filter.dateTo) {
      out = out
        .gte("metadata->>created_at", dayBoundsUTC(filter.dateFrom, timeZone).start)
        .lt("metadata->>created_at", dayBoundsUTC(filter.dateTo, timeZone).end);
    }
    if (filter.practiceType) out = out.ilike("metadata->>practice_type", filter.practiceType);
    const cands = (filter.consultants ?? []).map(sanitizeConsultant).filter(Boolean);
    if (cands.length) out = out.or(cands.map((c) => `metadata->>consultant_name.ilike.%${c}%`).join(","));
    return out;
  };
  try {
    const { data } = await apply(db.from("chunks").select("document_id, metadata, created_at"))
      .order("document_id", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(MAX_MATCH_ROWS);
    const docIds: string[] = [];
    const cardByDoc = new Map<string, ScorecardRow>();
    for (const r of (data ?? []) as { document_id: string; metadata: Record<string, unknown> }[]) {
      if (!r.document_id) continue;
      if (!docIds.includes(r.document_id)) docIds.push(r.document_id);
      if (!cardByDoc.has(r.document_id)) cardByDoc.set(r.document_id, toScorecardRow(r.metadata ?? {}, timeZone));
    }
    return { docIds, scorecard: [...cardByDoc.values()] };
  } catch {
    return { docIds: [], scorecard: [] };
  }
}

/** Distinct consultant names present in the org's transcripts (for name matching). */
export async function knownConsultants(db: SupabaseClient, orgId: string): Promise<string[]> {
  try {
    const { data } = await db
      .from("chunks")
      .select("cn:metadata->>consultant_name")
      .eq("org_id", orgId)
      .eq("source_type", "transcript")
      .not("metadata->>consultant_name", "is", null)
      .limit(4000);
    const set = new Set<string>();
    for (const r of (data ?? []) as { cn?: string | null }[]) {
      const v = (r.cn ?? "").trim();
      if (v && v.length <= 60) set.add(v);
    }
    return [...set];
  } catch {
    return [];
  }
}

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
 * Day filters, scorecard dates/times and the "Call date/time (<zone>)" line that
 * leads each call's first chunk use `opts.timeZone` (the asking user's IANA zone;
 * default: the business zone).
 * No matches → a "No calls found" note; a DB error → empty + log (never throws).
 */
export async function fetchCallsByFilter(
  db: SupabaseClient,
  orgId: string,
  filter: CallReviewFilter,
  opts: { maxCalls: number; maxTokens: number; timeZone?: string }
): Promise<{ chunks: RetrievedChunk[]; callCount: number; note: string | null; scorecard: ScorecardRow[]; totalMatched: number }> {
  const timeZone = resolveTimeZone(opts.timeZone);
  const applyFilters = <T extends { eq: Function; ilike: Function; or: Function; gte: Function; lte: Function; lt: Function }>(q: T): T => {
    let out = q.eq("org_id", orgId).eq("source_type", "transcript");
    // Filter by created_at's day in the user's zone (always clean — the stored
    // call_date is not) via a half-open range on the ISO timestamp, whose bounds
    // come from that zone's real offsets (a DST day is 23 or 25 hours). ISO UTC
    // timestamps compare lexicographically.
    if (filter.date) {
      const b = dayBoundsUTC(filter.date, timeZone);
      out = out.gte("metadata->>created_at", b.start).lt("metadata->>created_at", b.end);
    } else if (filter.dateFrom && filter.dateTo) {
      out = out
        .gte("metadata->>created_at", dayBoundsUTC(filter.dateFrom, timeZone).start)
        .lt("metadata->>created_at", dayBoundsUTC(filter.dateTo, timeZone).end);
    }
    if (filter.practiceType) out = out.ilike("metadata->>practice_type", filter.practiceType);
    const cands = (filter.consultants ?? []).map(sanitizeConsultant).filter(Boolean);
    if (cands.length) out = out.or(cands.map((c) => `metadata->>consultant_name.ilike.%${c}%`).join(","));
    return out;
  };

  try {
    // 1) Which calls match — document_id + summary metadata (never `select *`).
    //    Also builds the COMPLETE scorecard (every matching call), so a 50-call
    //    day is fully enumerated even though we deep-read only a subset.
    const idQuery = applyFilters(db.from("chunks").select("document_id, metadata, created_at"))
      .order("document_id", { ascending: true })
      .order("created_at", { ascending: true })
      .limit(MAX_MATCH_ROWS);
    const { data: idRows, error: idErr } = await idQuery;
    if (idErr) {
      console.error("[call-review] match scan failed:", idErr.message);
      return { chunks: [], callCount: 0, note: null, scorecard: [], totalMatched: 0 };
    }
    const orderedDocs: string[] = [];
    const cardByDoc = new Map<string, ScorecardRow>();
    for (const r of (idRows ?? []) as { document_id: string; metadata: Record<string, unknown>; created_at?: string }[]) {
      if (!r.document_id) continue;
      if (!orderedDocs.includes(r.document_id)) orderedDocs.push(r.document_id);
      if (!cardByDoc.has(r.document_id)) cardByDoc.set(r.document_id, toScorecardRow(r.metadata ?? {}, timeZone));
    }
    const scorecard = [...cardByDoc.values()].sort(
      (a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : a.consultant.localeCompare(b.consultant))
    );
    const totalMatched = orderedDocs.length;
    if (totalMatched === 0) {
      return { chunks: [], callCount: 0, note: `No calls found for ${describeFilter(filter)} in the Brain.`, scorecard: [], totalMatched: 0 };
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
      return { chunks: [], callCount: 0, note: null, scorecard, totalMatched };
    }

    const rowsByDoc = new Map<string, RetrievedChunk[]>();
    for (const r of rows as (RetrievedChunk & { created_at?: string })[]) {
      const md = (r.metadata as Record<string, unknown>) ?? {};
      // Lead each call's first chunk (its summary) with the call's date + time in
      // the user's zone: the stored "Call date:" line is the source's UTC /
      // reported value and can be a day off from the scorecard (a 01:10Z call is
      // the previous evening in New York). Existing chunk text is never rewritten.
      const local = rowsByDoc.has(r.document_id) ? null : localStamp(md.created_at, timeZone);
      const shaped: RetrievedChunk = {
        id: r.id,
        content: local ? `Call date/time (${timeZone}): ${local}\n${r.content}` : r.content,
        metadata: md,
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
    return { chunks: assembled.chunks, callCount: assembled.callCount, note, scorecard, totalMatched };
  } catch (e) {
    console.error("[call-review] fetch error:", e instanceof Error ? e.message : e);
    return { chunks: [], callCount: 0, note: null, scorecard: [], totalMatched: 0 };
  }
}
