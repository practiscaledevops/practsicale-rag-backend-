// Time zones for "today", "yesterday", "this week", "Sep 24" — resolved in the
// ASKING USER's IANA time zone (DST-aware), never the server clock or a fixed
// offset.
//
// Why: the team works in Pakistan (Asia/Karachi, UTC+5) and the scoring app
// shows call dates there, but the CEO asks from the USA. "List all today's calls"
// at 20:00 in New York is already tomorrow in Karachi, so a fixed business
// offset answered with the wrong day. The chat / compact / jobs APIs now accept
// the caller's `timeZone`; when none (or an invalid one) is given, the business
// zone below is used.
//
// Default zone (DEFAULT_TIME_ZONE, read once at startup):
//   1. SCORING_TIME_ZONE — an IANA name ("Asia/Karachi", "America/New_York").
//   2. Legacy SCORING_TZ_OFFSET_MIN (minutes east of UTC, e.g. 300) — honoured
//      ONLY when it is set and SCORING_TIME_ZONE does not name a valid zone. It
//      maps to a fixed-offset IANA zone (300 → Asia/Karachi, 330 → Asia/Kolkata,
//      345 → Asia/Kathmandu, 0 → UTC, other whole hours → Etc/GMT∓h); an offset
//      with no such zone falls through to 3. Prefer SCORING_TIME_ZONE: a fixed
//      offset cannot follow DST.
//   3. "Asia/Karachi" — the office zone the scoring app displays.
//
// Every helper is pure and uses Intl.DateTimeFormat offset lookups, so day
// bounds are exact on DST days (23- and 25-hour days). A zone the runtime does
// not know is treated as DEFAULT_TIME_ZONE (helpers never throw on a bad zone).

/** The office zone the scoring app displays call dates in. */
export const BUSINESS_TIME_ZONE = "Asia/Karachi";

/** Longest zone name accepted from a caller (the longest IANA id is ~32 chars). */
export const MAX_TIME_ZONE_LENGTH = 64;

// IANA ids: letters first, then letters / digits / "_" "+" "-" "/" (e.g.
// "America/Port-au-Prince", "Etc/GMT+5"). Offset strings ("+05:00") are not
// IANA ids and are rejected even where the runtime would accept them.
const TZ_NAME_RE = /^[A-Za-z][A-Za-z0-9_+\-/]*$/;

type Instant = Date | number | string;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}
function pad4(n: number): string {
  return String(n).padStart(4, "0");
}
function isoOfUTC(ms: number): string {
  const d = new Date(ms);
  return `${pad4(d.getUTCFullYear())}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}
function toMs(instant: Instant): number {
  const ms = instant instanceof Date ? instant.getTime() : typeof instant === "number" ? instant : Date.parse(instant);
  if (!Number.isFinite(ms)) throw new RangeError("Invalid time value");
  return ms;
}

// ---------------------------------------------------------------------------
// Validation + defaults
// ---------------------------------------------------------------------------

/** True when `tz` is an IANA time-zone id this runtime knows (≤ 64 chars). */
export function isValidTimeZone(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0 || tz.length > MAX_TIME_ZONE_LENGTH || !TZ_NAME_RE.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** The runtime's spelling of a valid zone ("america/new_york" → "America/New_York"), else null. */
export function normalizeTimeZone(tz: unknown): string | null {
  if (!isValidTimeZone(tz)) return null;
  try {
    return new Intl.DateTimeFormat("en-US", { timeZone: tz }).resolvedOptions().timeZone || tz;
  } catch {
    return null;
  }
}

// Fixed offsets (minutes east of UTC) → an IANA zone with that offset and no DST.
const LEGACY_OFFSET_ZONES: Record<number, string> = {
  0: "UTC",
  270: "Asia/Kabul",
  300: "Asia/Karachi",
  330: "Asia/Kolkata",
  345: "Asia/Kathmandu",
  390: "Asia/Yangon",
  570: "Australia/Darwin",
};

/** The IANA zone for a legacy SCORING_TZ_OFFSET_MIN value, or null when there is none. */
export function zoneForLegacyOffset(minutes: number): string | null {
  if (!Number.isInteger(minutes)) return null;
  const named = LEGACY_OFFSET_ZONES[minutes];
  if (named) return named;
  // Etc/GMT zones use the POSIX sign: Etc/GMT-5 is UTC+5. They span −12h … +14h.
  if (minutes % 60 === 0 && minutes >= -12 * 60 && minutes <= 14 * 60) {
    const h = minutes / 60;
    const zone = `Etc/GMT${h > 0 ? "-" : "+"}${Math.abs(h)}`;
    return isValidTimeZone(zone) ? zone : null;
  }
  return null;
}

/**
 * The default zone from the environment: SCORING_TIME_ZONE (IANA), else the
 * legacy SCORING_TZ_OFFSET_MIN when set (mapped by zoneForLegacyOffset), else
 * Asia/Karachi. See the header for the full rule.
 */
export function defaultTimeZone(env: Record<string, string | undefined> = process.env): string {
  const configured = normalizeTimeZone((env.SCORING_TIME_ZONE ?? "").trim());
  if (configured) return configured;
  const legacy = (env.SCORING_TZ_OFFSET_MIN ?? "").trim();
  if (legacy && /^[+-]?\d{1,4}$/.test(legacy)) {
    const zone = zoneForLegacyOffset(Number(legacy));
    if (zone) return zone;
  }
  return BUSINESS_TIME_ZONE;
}

/** The zone used when a request names none (or an invalid one). */
export const DEFAULT_TIME_ZONE: string = defaultTimeZone();

/**
 * The zone to use for a caller-supplied value: a valid IANA id (trimmed, in the
 * runtime's spelling), else `fallback` (DEFAULT_TIME_ZONE). Never throws.
 */
export function resolveTimeZone(input: unknown, fallback: string = DEFAULT_TIME_ZONE): string {
  return callerTimeZone(input) ?? fallback;
}

/**
 * The caller's own zone (trimmed, in the runtime's spelling) when `input` names a
 * valid one, else null — i.e. whether resolveTimeZone used the caller's zone or
 * fell back to the default. Never throws.
 */
export function callerTimeZone(input: unknown): string | null {
  return normalizeTimeZone(typeof input === "string" ? input.trim() : "");
}

// ---------------------------------------------------------------------------
// Wall-clock lookups (cached formatters, bounded)
// ---------------------------------------------------------------------------

const MAX_CACHED_ZONES = 256;
const zoneOk = new Map<string, boolean>();
const partFormatters = new Map<string, Intl.DateTimeFormat>();

/** `tz` when the runtime knows it, else DEFAULT_TIME_ZONE (validity cached). */
function zoneOrDefault(tz: string | undefined): string {
  if (!tz) return DEFAULT_TIME_ZONE;
  let ok = zoneOk.get(tz);
  if (ok === undefined) {
    ok = isValidTimeZone(tz);
    if (zoneOk.size >= MAX_CACHED_ZONES) zoneOk.clear();
    zoneOk.set(tz, ok);
  }
  return ok ? tz : DEFAULT_TIME_ZONE;
}

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = partFormatters.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    if (partFormatters.size >= MAX_CACHED_ZONES) partFormatters.clear();
    partFormatters.set(tz, f);
  }
  return f;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

/** The local calendar date + clock time of an instant in a (known-valid) zone. */
function wallClock(ms: number, tz: string): WallClock {
  const out: WallClock = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const p of partsFormatter(tz).formatToParts(ms)) {
    if (p.type === "year" || p.type === "month" || p.type === "day" || p.type === "hour" || p.type === "minute" || p.type === "second") {
      out[p.type] = Number(p.value);
    }
  }
  // Some engines render midnight as "24" of the same day; it is 00 of that day.
  if (out.hour === 24) out.hour = 0;
  return out;
}

/** Minutes east of UTC that `tz` observes at `instant` (DST-aware; −240 for New York in summer). */
export function offsetMinutes(instant: Instant, tz?: string): number {
  const zone = zoneOrDefault(tz);
  const ms = toMs(instant);
  const w = wallClock(ms, zone);
  const asUTC = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  const wholeSecond = ms - (((ms % 1000) + 1000) % 1000);
  return Math.round((asUTC - wholeSecond) / 60_000);
}

// ---------------------------------------------------------------------------
// Public helpers
// ---------------------------------------------------------------------------

/** The local calendar date ("YYYY-MM-DD") of an instant in `tz`. Throws RangeError on an invalid instant. */
export function localDate(instant: Instant, tz?: string): string {
  const w = wallClock(toMs(instant), zoneOrDefault(tz));
  return `${pad4(w.year)}-${pad2(w.month)}-${pad2(w.day)}`;
}

/** The local date and 24-hour time ("YYYY-MM-DD HH:mm") of an instant in `tz`. */
export function localDateTime(instant: Instant, tz?: string): string {
  const w = wallClock(toMs(instant), zoneOrDefault(tz));
  return `${pad4(w.year)}-${pad2(w.month)}-${pad2(w.day)} ${pad2(w.hour)}:${pad2(w.minute)}`;
}

/** Today's local date in `tz` (the user's "today"). */
export function todayIn(tz?: string, now: Instant = Date.now()): string {
  return localDate(now, tz);
}

/** Midnight UTC of a "YYYY-MM-DD" date (out-of-range days such as "2026-02-31" roll over like Date.UTC). */
function utcMidnightOf(dateISO: string): number {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(typeof dateISO === "string" ? dateISO : "");
  if (!m) throw new RangeError(`Invalid date '${String(dateISO).slice(0, 20)}' (expected YYYY-MM-DD)`);
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

/** The first instant (ms) of the local calendar day that starts at UTC-midnight `wall`, in a (known-valid) zone. */
function startOfLocalDayMs(wall: number, zone: string): number {
  const target = isoOfUTC(wall);
  const reached = (ms: number) => localDate(ms, zone) >= target;
  // Fast path: local midnight exists exactly once → wall time minus the offset in force then.
  let guess = wall - offsetMinutes(wall, zone) * 60_000;
  guess = wall - offsetMinutes(guess, zone) * 60_000;
  if (reached(guess) && !reached(guess - 1000)) return guess;
  // A transition skipped or repeated midnight: binary-search the first second of that date.
  // Offsets lie within −12h … +14h, so the local date is before `target` at lo and on/after it at hi.
  let lo = wall - 18 * 3_600_000;
  let hi = wall + 18 * 3_600_000;
  while (hi - lo > 1000) {
    const mid = lo + Math.floor((hi - lo) / 2000) * 1000;
    if (reached(mid)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/**
 * The UTC half-open bounds [startISO, endISO) of the local calendar day `dateISO`
 * in `tz` — for filtering timestamps. Exact on DST days: a spring-forward day is
 * 23 hours long, a fall-back day 25. Throws RangeError on a malformed date.
 */
export function zonedDayBoundsUTC(dateISO: string, tz?: string): { startISO: string; endISO: string } {
  const zone = zoneOrDefault(tz);
  const wall = utcMidnightOf(dateISO);
  const start = startOfLocalDayMs(wall, zone);
  const end = startOfLocalDayMs(wall + 86_400_000, zone);
  return { startISO: new Date(start).toISOString(), endISO: new Date(end).toISOString() };
}

/** The UTC bounds [startISO, endISO) covering the inclusive local-date range fromISO … toISO in `tz`. */
export function zonedRangeBoundsUTC(fromISO: string, toISO: string, tz?: string): { startISO: string; endISO: string } {
  return { startISO: zonedDayBoundsUTC(fromISO, tz).startISO, endISO: zonedDayBoundsUTC(toISO, tz).endISO };
}

/** The UTC offset `tz` observes at `instant`, as "UTC+05:00" / "UTC−04:00" (U+2212 minus). */
export function offsetLabel(instant: Instant, tz?: string): string {
  const off = offsetMinutes(instant, tz);
  const abs = Math.abs(off);
  return `UTC${off < 0 ? "−" : "+"}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

const WEEKDAY_UTC = new Intl.DateTimeFormat("en-US", { weekday: "long", timeZone: "UTC" });

/**
 * The weekday name ("Thursday"). A calendar date ("YYYY-MM-DD") has the same
 * weekday in every zone; an instant (Date / ms / timestamp) is read in `tz`.
 */
export function weekday(dateOrInstant: Instant, tz?: string): string {
  if (typeof dateOrInstant === "string" && /^\d{4}-\d{2}-\d{2}$/.test(dateOrInstant)) {
    const [y, m, d] = dateOrInstant.split("-").map(Number);
    return WEEKDAY_UTC.format(Date.UTC(y, m - 1, d, 12));
  }
  return weekday(localDate(dateOrInstant, tz));
}

/**
 * The line that tells a model what "today" is for this user:
 * "CURRENT DATE: 2026-09-24 (Thursday), America/New_York, UTC−04:00".
 */
export function currentDateLine(tz?: string, now: Instant = Date.now()): string {
  const zone = zoneOrDefault(tz);
  const today = localDate(now, zone);
  return `CURRENT DATE: ${today} (${weekday(today)}), ${zone}, ${offsetLabel(now, zone)}`;
}
