import { describe, it, expect } from "vitest";
import {
  BUSINESS_TIME_ZONE,
  DEFAULT_TIME_ZONE,
  callerTimeZone,
  currentDateLine,
  defaultTimeZone,
  isValidTimeZone,
  localDate,
  localDateTime,
  normalizeTimeZone,
  offsetLabel,
  offsetMinutes,
  resolveTimeZone,
  todayIn,
  weekday,
  zonedDayBoundsUTC,
  zonedRangeBoundsUTC,
  zoneForLegacyOffset,
} from "@/lib/timezone";
import {
  businessDay,
  fetchCallsByFilter,
  matchingCallDocs,
  parseCallReviewFilter,
  resolveReviewFilterWithHistory,
  type CallReviewFilter,
  type ReviewHistoryTurn,
} from "@/lib/call-review";
import type { SupabaseClient } from "@supabase/supabase-js";

// The asking user's time zone decides "today". The CEO asks from New York at
// 20:00 EDT on Thursday 2026-09-24 — that instant is already 05:00 on Friday
// 2026-09-25 in Karachi, where the office (and the scoring app) are.
const NY = "America/New_York";
const PK = "Asia/Karachi";
const LA = "America/Los_Angeles";
const EVENING_NY = Date.parse("2026-09-25T00:00:00Z"); // 20:00 EDT 24th = 05:00 PKT 25th

const hours = (b: { startISO: string; endISO: string }) => (Date.parse(b.endISO) - Date.parse(b.startISO)) / 3_600_000;

describe("zonedDayBoundsUTC — exact UTC bounds of a local day", () => {
  it("Asia/Karachi (UTC+5, no DST)", () => {
    expect(zonedDayBoundsUTC("2026-09-24", PK)).toEqual({ startISO: "2026-09-23T19:00:00.000Z", endISO: "2026-09-24T19:00:00.000Z" });
  });

  it("America/New_York on a normal (EDT) day", () => {
    const b = zonedDayBoundsUTC("2026-09-24", NY);
    expect(b).toEqual({ startISO: "2026-09-24T04:00:00.000Z", endISO: "2026-09-25T04:00:00.000Z" });
    expect(hours(b)).toBe(24);
  });

  it("America/New_York in winter (EST)", () => {
    expect(zonedDayBoundsUTC("2026-01-15", NY)).toEqual({ startISO: "2026-01-15T05:00:00.000Z", endISO: "2026-01-16T05:00:00.000Z" });
  });

  it("America/New_York spring-forward day (2026-03-08) is 23 hours", () => {
    const b = zonedDayBoundsUTC("2026-03-08", NY);
    expect(b).toEqual({ startISO: "2026-03-08T05:00:00.000Z", endISO: "2026-03-09T04:00:00.000Z" });
    expect(hours(b)).toBe(23);
  });

  it("America/New_York fall-back day (2026-11-01) is 25 hours", () => {
    const b = zonedDayBoundsUTC("2026-11-01", NY);
    expect(b).toEqual({ startISO: "2026-11-01T04:00:00.000Z", endISO: "2026-11-02T05:00:00.000Z" });
    expect(hours(b)).toBe(25);
  });

  it("America/Los_Angeles: normal day and both DST days", () => {
    expect(zonedDayBoundsUTC("2026-09-24", LA)).toEqual({ startISO: "2026-09-24T07:00:00.000Z", endISO: "2026-09-25T07:00:00.000Z" });
    const spring = zonedDayBoundsUTC("2026-03-08", LA);
    expect(spring).toEqual({ startISO: "2026-03-08T08:00:00.000Z", endISO: "2026-03-09T07:00:00.000Z" });
    expect(hours(spring)).toBe(23);
    const fall = zonedDayBoundsUTC("2026-11-01", LA);
    expect(fall).toEqual({ startISO: "2026-11-01T07:00:00.000Z", endISO: "2026-11-02T08:00:00.000Z" });
    expect(hours(fall)).toBe(25);
  });

  it("a zone whose DST change skips midnight still starts the day at its first instant", () => {
    // Chile springs forward at 24:00 → 01:00: 2026-09-06 begins at 01:00 local (04:00Z).
    const b = zonedDayBoundsUTC("2026-09-06", "America/Santiago");
    expect(b.startISO).toBe("2026-09-06T04:00:00.000Z");
    expect(hours(b)).toBe(23);
    expect(localDate(b.startISO, "America/Santiago")).toBe("2026-09-06");
    expect(localDate(Date.parse(b.startISO) - 1000, "America/Santiago")).toBe("2026-09-05");
  });

  it("a range spans the first day's start to the last day's end", () => {
    expect(zonedRangeBoundsUTC("2026-09-22", "2026-09-24", NY)).toEqual({
      startISO: "2026-09-22T04:00:00.000Z",
      endISO: "2026-09-25T04:00:00.000Z",
    });
  });

  it("a malformed date throws; an unknown zone uses the default zone", () => {
    expect(() => zonedDayBoundsUTC("24 Sep", NY)).toThrow(RangeError);
    expect(zonedDayBoundsUTC("2026-09-24", "Mars/Olympus_Mons")).toEqual(zonedDayBoundsUTC("2026-09-24", DEFAULT_TIME_ZONE));
  });
});

describe("local dates, offsets and labels", () => {
  it("the same instant is a different calendar day in New York and Karachi", () => {
    expect(localDate(EVENING_NY, NY)).toBe("2026-09-24");
    expect(localDate(EVENING_NY, PK)).toBe("2026-09-25");
    expect(localDate(new Date(EVENING_NY), LA)).toBe("2026-09-24");
    expect(localDateTime(EVENING_NY, NY)).toBe("2026-09-24 20:00");
    expect(localDateTime("2026-09-25T00:00:00Z", PK)).toBe("2026-09-25 05:00");
    expect(todayIn(NY, EVENING_NY)).toBe("2026-09-24");
    expect(businessDay("2026-09-25T00:00:00Z", NY)).toBe("2026-09-24");
    expect(businessDay("2026-09-25T00:00:00Z")).toBe(localDate(EVENING_NY, DEFAULT_TIME_ZONE));
    expect(businessDay("not a date", NY)).toBeNull();
  });

  it("offsets follow DST", () => {
    expect(offsetMinutes(EVENING_NY, NY)).toBe(-240);
    expect(offsetMinutes("2026-01-15T12:00:00Z", NY)).toBe(-300);
    expect(offsetMinutes(EVENING_NY, PK)).toBe(300);
    expect(offsetLabel(EVENING_NY, NY)).toBe("UTC−04:00");
    expect(offsetLabel("2026-01-15T12:00:00Z", NY)).toBe("UTC−05:00");
    expect(offsetLabel(EVENING_NY, PK)).toBe("UTC+05:00");
    expect(offsetLabel(EVENING_NY, "Asia/Kolkata")).toBe("UTC+05:30");
    expect(offsetLabel(EVENING_NY, "UTC")).toBe("UTC+00:00");
  });

  it("weekday: a calendar date is zone-independent; an instant is read in the zone", () => {
    expect(weekday("2026-09-24")).toBe("Thursday");
    expect(weekday("2026-09-24", PK)).toBe("Thursday");
    expect(weekday(EVENING_NY, NY)).toBe("Thursday");
    expect(weekday(EVENING_NY, PK)).toBe("Friday");
  });

  it("the CURRENT DATE line names the user's date, weekday, zone and offset", () => {
    expect(currentDateLine(NY, EVENING_NY)).toBe("CURRENT DATE: 2026-09-24 (Thursday), America/New_York, UTC−04:00");
    expect(currentDateLine(PK, EVENING_NY)).toBe("CURRENT DATE: 2026-09-25 (Friday), Asia/Karachi, UTC+05:00");
  });
});

describe("validation and the default zone", () => {
  it("isValidTimeZone accepts IANA ids only (≤ 64 chars)", () => {
    for (const tz of [NY, PK, LA, "UTC", "Etc/GMT+5", "America/Argentina/Buenos_Aires", "America/Port-au-Prince"]) {
      expect(isValidTimeZone(tz)).toBe(true);
    }
    for (const tz of ["", "Mars/Olympus_Mons", "+05:00", "UTC+5", " America/New_York", "America/New_York;DROP", "x".repeat(65), 5, null, undefined, {}]) {
      expect(isValidTimeZone(tz)).toBe(false);
    }
  });

  it("resolveTimeZone: valid → the runtime's spelling (trimmed); invalid → the default", () => {
    expect(resolveTimeZone(NY)).toBe(NY);
    expect(resolveTimeZone("  america/new_york ")).toBe(NY);
    expect(normalizeTimeZone("asia/karachi")).toBe(PK);
    for (const bad of ["Mars/Olympus_Mons", "", "x".repeat(200), 42, null, undefined, ["America/New_York"]]) {
      expect(resolveTimeZone(bad)).toBe(DEFAULT_TIME_ZONE);
    }
    expect(resolveTimeZone("nope", LA)).toBe(LA);
  });

  it("callerTimeZone: the caller's own zone (same trim + spelling as resolveTimeZone), else null", () => {
    expect(callerTimeZone(NY)).toBe(NY);
    expect(callerTimeZone("  america/new_york ")).toBe(NY);
    for (const bad of ["Mars/Olympus_Mons", "", "+05:00", "x".repeat(200), 42, null, undefined, ["America/New_York"]]) {
      expect(callerTimeZone(bad)).toBeNull();
      // Defaulted exactly when resolveTimeZone falls back.
      expect(resolveTimeZone(bad, LA)).toBe(LA);
    }
  });

  it("the default is the business zone unless configured", () => {
    expect(BUSINESS_TIME_ZONE).toBe(PK);
    expect(defaultTimeZone({})).toBe(PK);
    expect(defaultTimeZone({ SCORING_TIME_ZONE: "America/Chicago" })).toBe("America/Chicago");
    // An invalid IANA value is not a configured zone.
    expect(defaultTimeZone({ SCORING_TIME_ZONE: "Nowhere/Land" })).toBe(PK);
  });

  it("legacy SCORING_TZ_OFFSET_MIN applies only when no IANA zone is configured", () => {
    expect(defaultTimeZone({ SCORING_TZ_OFFSET_MIN: "300" })).toBe(PK);
    expect(defaultTimeZone({ SCORING_TZ_OFFSET_MIN: "330" })).toBe("Asia/Kolkata");
    expect(defaultTimeZone({ SCORING_TZ_OFFSET_MIN: "-300" })).toBe("Etc/GMT+5");
    expect(defaultTimeZone({ SCORING_TZ_OFFSET_MIN: "330", SCORING_TIME_ZONE: NY })).toBe(NY);
    expect(defaultTimeZone({ SCORING_TZ_OFFSET_MIN: "330", SCORING_TIME_ZONE: "Nowhere/Land" })).toBe("Asia/Kolkata");
    // No fixed-offset zone for +0:17 / junk → the business zone.
    expect(defaultTimeZone({ SCORING_TZ_OFFSET_MIN: "17" })).toBe(PK);
    expect(defaultTimeZone({ SCORING_TZ_OFFSET_MIN: "abc" })).toBe(PK);
    expect(zoneForLegacyOffset(0)).toBe("UTC");
    expect(zoneForLegacyOffset(60 * 14)).toBe("Etc/GMT-14");
    expect(zoneForLegacyOffset(60 * 15)).toBeNull();
  });
});

describe("call-review dates resolve in the asking user's zone", () => {
  // What the chat / jobs routes do: today = the user's local date at the request instant.
  const opts = (tz: string) => ({ referenceDate: todayIn(tz, EVENING_NY), knownConsultants: [], timeZone: tz });

  it("'list all today's calls' — New York user at 20:00 EDT → New York's date, not Karachi's", () => {
    expect(parseCallReviewFilter("list all today's calls", opts(NY))).toEqual({ isReview: true, date: "2026-09-24" });
    expect(parseCallReviewFilter("list all today's calls", opts(PK))).toEqual({ isReview: true, date: "2026-09-25" });
  });

  it("'yesterday' and 'last 3 days'", () => {
    expect(parseCallReviewFilter("review yesterday's calls", opts(NY))).toEqual({ isReview: true, date: "2026-09-23" });
    expect(parseCallReviewFilter("review yesterday's calls", opts(PK))).toEqual({ isReview: true, date: "2026-09-24" });
    expect(parseCallReviewFilter("review the calls from the last 3 days", opts(NY))).toEqual({
      isReview: true,
      dateFrom: "2026-09-22",
      dateTo: "2026-09-24",
    });
    expect(parseCallReviewFilter("review the calls from the last 3 days", opts(PK))).toEqual({
      isReview: true,
      dateFrom: "2026-09-23",
      dateTo: "2026-09-25",
    });
  });

  it("without a referenceDate, today comes from the given zone", () => {
    const today = localDate(Date.now(), NY);
    expect(parseCallReviewFilter("list today's calls", { timeZone: NY })).toEqual({ isReview: true, date: today });
  });

  it("a history turn's createdAt is read in the user's zone", () => {
    // Sent 21:00 EDT on the 24th (01:00Z on the 25th, 06:00 on the 25th in Karachi).
    const h: ReviewHistoryTurn[] = [
      { role: "user", content: "list yesterday's calls", createdAt: "2026-09-25T01:00:00Z" },
      { role: "assistant", content: "Here are the calls …" },
    ];
    const next = { knownConsultants: [], referenceDate: "2026-09-26" };
    expect(resolveReviewFilterWithHistory("audit them", h, { ...next, timeZone: NY })).toEqual({ isReview: true, date: "2026-09-23" });
    expect(resolveReviewFilterWithHistory("audit them", h, { ...next, timeZone: PK })).toEqual({ isReview: true, date: "2026-09-24" });
    // No zone → the default (business) zone, the previous behaviour.
    const sentDay = localDate("2026-09-25T01:00:00Z", DEFAULT_TIME_ZONE);
    const dayBefore = new Date(Date.parse(`${sentDay}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
    expect(resolveReviewFilterWithHistory("audit them", h, next)).toEqual({ isReview: true, date: dayBefore });
  });
});

// ---------------------------------------------------------------------------
// DB filters: a fake query builder records the created_at bounds
// ---------------------------------------------------------------------------

type Call = { method: string; args: unknown[] };

/** A Supabase stand-in: records every builder call; the match scan returns `idRows`, the chunk fetch `rows`. */
function fakeDb(idRows: unknown[], rows: unknown[] = []) {
  const calls: Call[][] = [];
  const db = {
    from: () => {
      const log: Call[] = [];
      calls.push(log);
      let selected = "";
      const q: Record<string, unknown> = {};
      for (const method of ["eq", "ilike", "or", "gte", "lt", "lte", "order", "limit", "in", "not"]) {
        q[method] = (...args: unknown[]) => {
          log.push({ method, args });
          return q;
        };
      }
      q.select = (cols: string) => {
        selected = cols;
        return q;
      };
      q.then = (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
        Promise.resolve({ data: selected.startsWith("id,") ? rows : idRows, error: null }).then(res, rej);
      return q;
    },
  };
  const bounds = (i = 0) => ({
    gte: calls[i].find((c) => c.method === "gte" && c.args[0] === "metadata->>created_at")?.args[1],
    lt: calls[i].find((c) => c.method === "lt" && c.args[0] === "metadata->>created_at")?.args[1],
  });
  return { db: db as unknown as SupabaseClient, calls, bounds };
}

// One call created 02:30Z on the 25th: 22:30 EDT on the 24th, 07:30 PKT on the 25th.
const CALL_ROW = {
  document_id: "doc-1",
  created_at: "2026-09-25T02:30:00Z",
  metadata: { created_at: "2026-09-25T02:30:00Z", call_date: "2026-09-25", consultant_name: "James Ephrim", prospect_name: "Acme", practice_type: "NEMT", overall_score: 82 },
};
const CHUNK_ROW = { id: "c-1", content: "summary", metadata: { tokens: 10 }, document_id: "doc-1", created_at: "2026-09-25T02:30:00Z" };

describe("fetchCallsByFilter / matchingCallDocs — day bounds + scorecard dates in the user's zone", () => {
  const sep24: CallReviewFilter = parseCallReviewFilter("review the calls from 24 sep", { referenceDate: "2026-09-25" });

  it("the explicit '24 sep' parses to the calendar date (zone-independent)", () => {
    expect(sep24).toEqual({ isReview: true, date: "2026-09-24" });
  });

  for (const [tz, gte, lt] of [
    [NY, "2026-09-24T04:00:00.000Z", "2026-09-25T04:00:00.000Z"],
    [PK, "2026-09-23T19:00:00.000Z", "2026-09-24T19:00:00.000Z"],
    [LA, "2026-09-24T07:00:00.000Z", "2026-09-25T07:00:00.000Z"],
  ] as const) {
    it(`'24 sep' for a ${tz} user filters created_at to that zone's day`, async () => {
      const f = fakeDb([CALL_ROW], [CHUNK_ROW]);
      await fetchCallsByFilter(f.db, "org-1", sep24, { maxCalls: 25, maxTokens: 140_000, timeZone: tz });
      expect(f.bounds(0)).toEqual({ gte, lt });
      const m = fakeDb([CALL_ROW]);
      await matchingCallDocs(m.db, "org-1", sep24, { timeZone: tz });
      expect(m.bounds(0)).toEqual({ gte, lt });
    });
  }

  it("a DST day's filter covers the whole 25-hour day", async () => {
    const f = fakeDb([]);
    await fetchCallsByFilter(f.db, "org-1", { isReview: true, date: "2026-11-01" }, { maxCalls: 25, maxTokens: 1000, timeZone: NY });
    expect(f.bounds(0)).toEqual({ gte: "2026-11-01T04:00:00.000Z", lt: "2026-11-02T05:00:00.000Z" });
  });

  it("a range filter runs from the first day's start to the last day's end", async () => {
    const f = fakeDb([]);
    await fetchCallsByFilter(f.db, "org-1", { isReview: true, dateFrom: "2026-09-22", dateTo: "2026-09-24" }, { maxCalls: 25, maxTokens: 1000, timeZone: NY });
    expect(f.bounds(0)).toEqual({ gte: "2026-09-22T04:00:00.000Z", lt: "2026-09-25T04:00:00.000Z" });
  });

  it("scorecard dates and times are the call's local day and clock time in the user's zone", async () => {
    const ny = await fetchCallsByFilter(fakeDb([CALL_ROW], [CHUNK_ROW]).db, "org-1", sep24, { maxCalls: 25, maxTokens: 140_000, timeZone: NY });
    expect(ny.scorecard.map((r) => [r.date, r.time])).toEqual([["2026-09-24", "22:30"]]);
    const pk = await fetchCallsByFilter(fakeDb([CALL_ROW], [CHUNK_ROW]).db, "org-1", sep24, { maxCalls: 25, maxTokens: 140_000, timeZone: PK });
    expect(pk.scorecard.map((r) => [r.date, r.time])).toEqual([["2026-09-25", "07:30"]]);
    const plan = await matchingCallDocs(fakeDb([CALL_ROW]).db, "org-1", sep24, { timeZone: NY });
    expect(plan).toEqual({ docIds: ["doc-1"], scorecard: [expect.objectContaining({ date: "2026-09-24", time: "22:30", consultant: "James Ephrim" })] });
  });

  it("each call's FIRST chunk leads with its date/time in the user's zone (the stored 'Call date:' is UTC)", async () => {
    // The summary's own "Call date: 2026-09-25" is the UTC date; the NY user's call was the 24th at 22:30.
    const summary = { ...CHUNK_ROW, content: "Call transcript — James Ephrim → Acme\nCall date: 2026-09-25", metadata: { tokens: 10, created_at: "2026-09-25T02:30:00Z", call_date: "2026-09-25" } };
    const body = { ...summary, id: "c-2", content: "[James Ephrim → Acme · NEMT · 2026-09-25]\nHello", created_at: "2026-09-25T02:30:01Z" };
    const ny = await fetchCallsByFilter(fakeDb([CALL_ROW], [summary, body]).db, "org-1", sep24, { maxCalls: 25, maxTokens: 140_000, timeZone: NY });
    expect(ny.chunks.map((c) => c.content)).toEqual([
      "Call date/time (America/New_York): 2026-09-24 22:30\nCall transcript — James Ephrim → Acme\nCall date: 2026-09-25",
      "[James Ephrim → Acme · NEMT · 2026-09-25]\nHello",
    ]);
    const pk = await fetchCallsByFilter(fakeDb([CALL_ROW], [summary, body]).db, "org-1", sep24, { maxCalls: 25, maxTokens: 140_000, timeZone: PK });
    expect(pk.chunks[0].content.startsWith("Call date/time (Asia/Karachi): 2026-09-25 07:30\n")).toBe(true);
  });

  it("an unusable created_at (PII-mangled) never throws: no stamp, the stored call_date, no time", async () => {
    const mangled = { ...CALL_ROW, metadata: { ...CALL_ROW.metadata, created_at: "[PHONE]" } };
    const chunk = { ...CHUNK_ROW, metadata: { tokens: 10, created_at: "[PHONE]" } };
    const out = await fetchCallsByFilter(fakeDb([mangled], [chunk]).db, "org-1", sep24, { maxCalls: 25, maxTokens: 140_000, timeZone: NY });
    expect(out.callCount).toBe(1);
    expect(out.chunks.map((c) => c.content)).toEqual(["summary"]);
    expect(out.scorecard.map((r) => [r.date, r.time])).toEqual([["2026-09-25", null]]);
  });

  it("no zone / an invalid zone → the default zone's day (the previous behaviour)", async () => {
    const expected = zonedDayBoundsUTC("2026-09-24", DEFAULT_TIME_ZONE);
    for (const timeZone of [undefined, "Mars/Olympus_Mons"]) {
      const f = fakeDb([]);
      await fetchCallsByFilter(f.db, "org-1", sep24, { maxCalls: 25, maxTokens: 1000, timeZone });
      expect(f.bounds(0)).toEqual({ gte: expected.startISO, lt: expected.endISO });
    }
    const m = fakeDb([]);
    await matchingCallDocs(m.db, "org-1", sep24);
    expect(m.bounds(0)).toEqual({ gte: expected.startISO, lt: expected.endISO });
  });
});
