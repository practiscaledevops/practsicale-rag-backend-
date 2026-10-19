import { describe, expect, it } from "vitest";
import { renderCallReport, wantsStructuredCallReport } from "@/lib/call-report";
import { fetchCallsByFilter } from "@/lib/call-review";
import type { SupabaseClient } from "@supabase/supabase-js";
describe("model-independent call reports", () => {
  it.each(["check yesterdaycalls", "check yesterdays calls", "yesterdaycalls", "give me report of yesterday calls", "how many calls yesterday"])("routes %s", q => expect(wantsStructuredCallReport(q)).toBe(true));
  it.each(["give me tips for calls", "write a post about yesterday's calls", "analyze James calls yesterday", "why did this call fail"])("preserves analysis and creative intent: %s", q => expect(wantsStructuredCallReport(q)).toBe(false));
  it("never turns a failed read into zero calls", () => {
    const text = renderCallReport([], { isReview: true, date: "2026-10-19" }, "Asia/Karachi", false);
    expect(text).toContain("couldn't verify"); expect(text).not.toContain("| Total | 0");
  });
  it("renders valid Markdown with exact current fields and escaped names", () => {
    const text = renderCallReport([{ consultant: "A|B", prospect: "C", date: "2026-10-19", time: "20:00", practice: "Home Care", score: 42, band: null, outcome: "Pending", closingType: "High Ticket", originalOutcome: "Follow Up", callSequence: "Call 2", duration: 21 }], { isReview: true, date: "2026-10-19" }, "Asia/Karachi");
    expect(text).toContain("|---|---|"); expect(text).toContain("A\\|B");
    expect(text).toContain("| Total | 1 | 1 | 0 | 0 | 0 | 0 | 1 |");
    expect(text).toContain("2026-10-19 20:00"); expect(text).not.toContain("2026-10-18");
  });
  it("pages the one-row-per-call roster and distinguishes database failure from no matches", async () => {
    const documents = Array.from({ length: 501 }, (_, i) => ({ id: `doc-${i}`, metadata: { consultant_name: "A", created_at: "2026-10-19T12:00:00Z" } }));
    let fail = false;
    const db = { from: (table: string) => {
      let start = 0, end = 499;
      const q: Record<string, unknown> = {};
      for (const name of ["select", "eq", "ilike", "or", "gte", "lte", "lt", "order", "in"]) q[name] = () => q;
      q.range = (s: number, e: number) => { start = s; end = e; return q; };
      q.then = (resolve: (v: unknown) => unknown) => Promise.resolve({ data: table === "documents" ? documents.slice(start, end + 1) : [], error: fail ? { message: "unavailable" } : null }).then(resolve);
      return q;
    } } as unknown as SupabaseClient;
    const filter = { isReview: true, date: "2026-10-19" };
    const result = await fetchCallsByFilter(db, "org", filter, { maxCalls: 1, maxTokens: 1000 });
    expect(result.totalMatched).toBe(501); expect(result.scorecard).toHaveLength(501);
    fail = true;
    const failure = await fetchCallsByFilter(db, "org", filter, { maxCalls: 1, maxTokens: 1000 });
    expect(failure.complete).toBe(false); expect(failure.note).toContain("does not mean");
  });
});
