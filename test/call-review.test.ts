import { describe, it, expect } from "vitest";
import {
  parseCallReviewFilter,
  resolveDate,
  detectPracticeType,
  detectConsultants,
  describeFilter,
  assembleCallSet,
} from "@/lib/call-review";
import type { RetrievedChunk } from "@/lib/retrieval";

// The data's newest call_date, used as the anchor for "today"/"yesterday" and
// an omitted year (calls are dated in the data, not by the wall clock).
const REF = "2026-09-22";
const parse = (q: string) => parseCallReviewFilter(q, { referenceDate: REF });

describe("resolveDate — every accepted format resolves to the call_date shape", () => {
  it("ISO", () => expect(resolveDate("review 2026-09-22 calls", REF)).toBe("2026-09-22"));
  it("Month Day", () => expect(resolveDate("review the September 22 calls", REF)).toBe("2026-09-22"));
  it("Month Day, Year (explicit year wins over the reference)", () =>
    expect(resolveDate("calls on September 22, 2025", REF)).toBe("2025-09-22"));
  it("abbreviated month + ordinal", () => expect(resolveDate("Sept 22nd calls", REF)).toBe("2026-09-22"));
  it("Day Month", () => expect(resolveDate("review the calls from 22 September", REF)).toBe("2026-09-22"));
  it("Day-ordinal Month", () => expect(resolveDate("the 22nd September calls", REF)).toBe("2026-09-22"));
  it("Day abbreviated-month", () => expect(resolveDate("22 Sept calls", REF)).toBe("2026-09-22"));
  it("numeric M/D", () => expect(resolveDate("go through the 9/22 calls", REF)).toBe("2026-09-22"));
  it("numeric M/D/YYYY", () => expect(resolveDate("9/22/2025", REF)).toBe("2025-09-22"));
  it("tolerates D/M when the first number can't be a month", () => expect(resolveDate("22/9", REF)).toBe("2026-09-22"));
  it("relative today → the reference (newest call_date)", () => expect(resolveDate("review today's calls", REF)).toBe("2026-09-22"));
  it("relative yesterday → reference − 1 day (UTC, crosses no month here)", () =>
    expect(resolveDate("review yesterday's calls", REF)).toBe("2026-09-21"));
  it("omitted year uses the reference year, not the wall clock", () =>
    expect(resolveDate("June 29 calls", "2026-09-22")).toBe("2026-06-29"));
  it("no date present → undefined", () => expect(resolveDate("review the NEMT calls", REF)).toBeUndefined());
  it("a clock time is not mistaken for a date", () => expect(resolveDate("the 9:22 mark", REF)).toBeUndefined());
});

describe("detectPracticeType — the six known values, case-insensitive", () => {
  it("NEMT", () => expect(detectPracticeType("review the NEMT calls")).toBe("NEMT"));
  it("lower-case nemt", () => expect(detectPracticeType("the nemt ones")).toBe("NEMT"));
  it("Home Health", () => expect(detectPracticeType("home health calls")).toBe("Home Health"));
  it("Home Care (not confused with Home Health)", () => expect(detectPracticeType("the home care calls")).toBe("Home Care"));
  it("Assisted Living", () => expect(detectPracticeType("assisted living calls")).toBe("Assisted Living"));
  it("Phlebotomy", () => expect(detectPracticeType("phlebotomy")).toBe("Phlebotomy"));
  it("Other only when it clearly names a practice", () => {
    expect(detectPracticeType("review the Other calls")).toBe("Other");
    expect(detectPracticeType("practice type: other")).toBe("Other");
  });
  it("does not treat a bare 'other' as a practice type", () =>
    expect(detectPracticeType("review the other stuff too")).toBeUndefined());
  it("none present → undefined", () => expect(detectPracticeType("review James's calls")).toBeUndefined());
});

describe("detectConsultants — raw capitalised phrases in a consultant context", () => {
  it("possessive multi-word name", () => expect(detectConsultants("review James Ephrim's calls")).toEqual(["James Ephrim"]));
  it("single-name possessive", () => expect(detectConsultants("go through James's calls")).toEqual(["James"]));
  it("after the word consultant", () => expect(detectConsultants("which consultant Sherman Mathews called")).toEqual(["Sherman Mathews"]));
  it("name before 'calls'", () => expect(detectConsultants("list Kate Melody calls")).toEqual(["Kate Melody"]));
  it("calls for/by <name>", () => expect(detectConsultants("all calls by David Miller")).toEqual(["David Miller"]));
  it("ignores month names and practice-type words", () => {
    expect(detectConsultants("review the calls from 22 September")).toEqual([]);
    expect(detectConsultants("review the NEMT calls")).toEqual([]);
    expect(detectConsultants("review the Home Care calls")).toEqual([]);
  });
});

describe("parseCallReviewFilter — the isReview gate (review intent AND ≥1 filter dim)", () => {
  it("date + review verb", () => {
    expect(parse("review the calls from 22 September")).toEqual({ isReview: true, date: "2026-09-22" });
  });
  it("consultant + review verb", () => {
    expect(parse("review James Ephrim's calls")).toEqual({ isReview: true, consultants: ["James Ephrim"] });
  });
  it("practice type + review verb", () => {
    expect(parse("review the NEMT calls")).toEqual({ isReview: true, practiceType: "NEMT" });
  });
  it("all three dims combine", () => {
    expect(parse("go through James Ephrim's NEMT calls on 9/22")).toEqual({
      isReview: true,
      date: "2026-09-22",
      consultants: ["James Ephrim"],
      practiceType: "NEMT",
    });
  });
  it("review verb but NO filter dim → not a structured review (falls back to semantic)", () => {
    expect(parse("review our pricing strategy")).toEqual({ isReview: false });
    expect(parse("go through the calls").isReview).toBe(false); // "the calls" but no date/consultant/practice
  });
  it("filter dim present but NO review intent → not a structured review", () => {
    // A normal sales question that happens to mention a consultant is not a review.
    expect(parse("what did James Ephrim's call cover about pricing").isReview).toBe(false);
  });
  it("empty query → { isReview: false }", () => {
    expect(parse("")).toEqual({ isReview: false });
  });
  it("relative 'yesterday' is anchored to the data, not the wall clock", () => {
    expect(parse("analyse yesterday's calls")).toEqual({ isReview: true, date: "2026-09-21" });
  });
});

describe("describeFilter", () => {
  it("joins the present dimensions", () => {
    expect(describeFilter({ isReview: true, date: "2026-09-22", consultants: ["James Ephrim"], practiceType: "NEMT" })).toBe(
      "2026-09-22 · James Ephrim · NEMT calls"
    );
    expect(describeFilter({ isReview: true, practiceType: "NEMT" })).toBe("NEMT calls");
  });
});

// ---- assembleCallSet (pure budget/exhaustiveness core) -----------------------

function chunk(over: Partial<RetrievedChunk> & { id: string; document_id: string }): RetrievedChunk {
  return { content: over.id, metadata: {}, parent_id: null, source_type: "transcript", ...over };
}
/** A full call in reading order: summary first, then body chunks. */
function call(doc: string, bodyCount: number, tk = 500): RetrievedChunk[] {
  const out = [chunk({ id: `${doc}-sum`, document_id: doc, metadata: { is_summary: true, tokens: tk } })];
  for (let i = 1; i <= bodyCount; i++) out.push(chunk({ id: `${doc}-b${i}`, document_id: doc, metadata: { tokens: tk } }));
  return out;
}
const ids = (chunks: RetrievedChunk[]) => chunks.map((c) => c.id);
const mapOf = (...calls: RetrievedChunk[][]) => new Map(calls.map((c) => [c[0].document_id, c]));

describe("assembleCallSet", () => {
  it("includes EVERY matching call in full when they fit", () => {
    const out = assembleCallSet(mapOf(call("A", 2), call("B", 1), call("C", 2)), 12, 200_000);
    expect(out.callCount).toBe(3);
    expect(out.totalMatched).toBe(3);
    expect(out.note).toBeNull();
    expect(ids(out.chunks)).toEqual(["A-sum", "A-b1", "A-b2", "B-sum", "B-b1", "C-sum", "C-b1", "C-b2"]);
  });

  it("caps at maxCalls and notes 'N of M' when more calls match", () => {
    const out = assembleCallSet(mapOf(call("A", 1), call("B", 1), call("C", 1), call("D", 1), call("E", 1)), 3, 200_000);
    expect(out.callCount).toBe(3);
    expect(out.totalMatched).toBe(5);
    expect(out.note).toBe(
      "Showing 3 of 5 matching calls (the largest set that fits); ask for a specific consultant or a narrower window for the rest."
    );
    expect(ids(out.chunks)).toEqual(["A-sum", "A-b1", "B-sum", "B-b1", "C-sum", "C-b1"]);
  });

  it("caps each call at its fair token share but always keeps summary + 1 body", () => {
    // 1 call, share = maxTokens = 1000; tokens 300 each. 300+300+300=900 ≤ 1000;
    // adding b3 (1200) exceeds → stop at b2.
    const out = assembleCallSet(mapOf(call("A", 3, 300)), 12, 1000);
    expect(ids(out.chunks)).toEqual(["A-sum", "A-b1", "A-b2"]);
    expect(out.note).toBeNull();
  });

  it("keeps summary + 1 even when the summary alone blows the share", () => {
    const A = [
      chunk({ id: "A-sum", document_id: "A", metadata: { is_summary: true, tokens: 5000 } }),
      chunk({ id: "A-b1", document_id: "A", metadata: { tokens: 5000 } }),
      chunk({ id: "A-b2", document_id: "A", metadata: { tokens: 5000 } }),
    ];
    const out = assembleCallSet(new Map([["A", A]]), 12, 100);
    expect(ids(out.chunks)).toEqual(["A-sum", "A-b1"]);
  });

  it("divides the budget fairly across several calls", () => {
    // 3 calls, budget 3000 → share 1000 each; tokens 500 → keep summary + b1 per call.
    const out = assembleCallSet(mapOf(call("A", 3, 500), call("B", 3, 500), call("C", 3, 500)), 12, 3000);
    expect(ids(out.chunks)).toEqual(["A-sum", "A-b1", "B-sum", "B-b1", "C-sum", "C-b1"]);
    expect(out.callCount).toBe(3);
  });

  it("stops including calls once even a summary+body would blow the TOTAL budget, and notes it", () => {
    // 4 huge calls (summary+body = 10k each), total budget 8k → only 1 call fits.
    const huge = (doc: string) => [
      chunk({ id: `${doc}-sum`, document_id: doc, metadata: { is_summary: true, tokens: 5000 } }),
      chunk({ id: `${doc}-b1`, document_id: doc, metadata: { tokens: 5000 } }),
      chunk({ id: `${doc}-b2`, document_id: doc, metadata: { tokens: 5000 } }),
    ];
    const out = assembleCallSet(mapOf(huge("A"), huge("B"), huge("C"), huge("D")), 12, 8000);
    expect(out.callCount).toBe(1);
    expect(out.totalMatched).toBe(4);
    expect(ids(out.chunks)).toEqual(["A-sum", "A-b1"]);
    expect(out.note).toContain("Showing 1 of 4 matching calls");
  });

  it("falls back to content length when a chunk carries no token count", () => {
    const A = [
      chunk({ id: "A-sum", document_id: "A", content: "x".repeat(2000), metadata: { is_summary: true } }), // ~500 tok
      chunk({ id: "A-b1", document_id: "A", content: "x".repeat(2000), metadata: {} }), // ~500 tok
      chunk({ id: "A-b2", document_id: "A", content: "x".repeat(2000), metadata: {} }), // ~500 tok
    ];
    // Budget 1100: 500 + 500 = 1000 ≤ 1100; adding b2 (1500) exceeds → stop.
    const out = assembleCallSet(new Map([["A", A]]), 12, 1100);
    expect(ids(out.chunks)).toEqual(["A-sum", "A-b1"]);
  });

  it("empty match set → no chunks, no note", () => {
    const out = assembleCallSet(new Map(), 12, 120_000);
    expect(out).toEqual({ chunks: [], callCount: 0, totalMatched: 0, note: null });
  });
});
