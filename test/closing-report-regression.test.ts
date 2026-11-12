import { describe, expect, it } from "vitest";
import { wantsStructuredCallReport, renderCallReport } from "@/lib/call-report";
import { applyCallReviewFilter, parseCallReviewFilter, resolveReviewFilterWithHistory } from "@/lib/call-review";
import { recordedCallDate, outcomeTimestamp } from "@/lib/call-dates";
const query = "Give me names of clients closed on HT For the month of November";
describe("November client closing regression", () => {
  it.each([query, "List high-ticket clients closed in November", "Which prospects are pending on LT?", "Show won deals this month", "How many clients closed on HT in November?"])("uses complete database reporting for %s", q => expect(wantsStructuredCallReport(q)).toBe(true));
  it.each(["Write an email to clients closed on HT", "Give me tips to close high ticket clients", "Analyze why clients closed on HT"])("preserves non-report intent: %s", q => expect(wantsStructuredCallReport(q)).toBe(false));
  it("parses the screenshot without inventing a consultant or losing the month", () => {
    expect(parseCallReviewFilter(query, { referenceDate: "2026-11-12" })).toEqual({ isReview:true,dateFrom:"2026-11-01",dateTo:"2026-11-12",crmStatus:"closed",ticketCategory:"high_ticket",dateBasis:"outcome" });
    expect(parseCallReviewFilter("show closed HT calls in November 2025", { referenceDate:"2026-11-12" })).toMatchObject({dateFrom:"2025-11-01",dateTo:"2025-11-30"});
  });
  it("inherits outcome basis for follow-ups but switches back for explicit call rosters", () => {
    const history=[{role:"user",content:query}];
    expect(resolveReviewFilterWithHistory("and LT?",history,{referenceDate:"2026-11-12",knownConsultants:[]})).toMatchObject({dateBasis:"outcome",ticketCategory:"low_ticket"});
    expect(resolveReviewFilterWithHistory("all calls yesterday",history,{referenceDate:"2026-11-12",knownConsultants:[]})).not.toHaveProperty("dateBasis");
  });
  it("filters outcome timestamps by timezone including DST, never import timestamps",()=>{
    const calls:unknown[][]=[];const q:any={};for(const key of ["eq","gte","lt","lte","or","ilike"])q[key]=(...args:unknown[])=>{calls.push([key,...args]);return q;};
    applyCallReviewFilter(q,"tenant",{isReview:true,date:"2026-11-01",dateBasis:"outcome",crmStatus:"closed"},"America/New_York");
    expect(calls).toContainEqual(["gte","metadata->>outcome_event_at","2026-11-01T04:00:00.000Z"]);
    expect(calls).toContainEqual(["lt","metadata->>outcome_event_at","2026-11-02T05:00:00.000Z"]);
    expect(JSON.stringify(calls)).not.toContain("created_at");
  });
  it("keeps undated records unknown and does not silently bless legacy import dates",()=>{
    expect(recordedCallDate({call_date:"2026-11-11",created_at:"2026-11-11T10:00:00Z"})).toBeNull();
    expect(recordedCallDate({call_date:"2026-11-11",reported_call_date:"2026-07-02"})).toBe("2026-07-02");
    expect(recordedCallDate({call_date_basis:"source",call_date:"2026-02-30"})).toBeNull();
    expect(outcomeTimestamp(null)).toBeNull();
    const text=renderCallReport([],{isReview:true,dateBasis:"outcome",dateFrom:"2026-11-01",dateTo:"2026-11-12"},"Asia/Karachi",true,12);
    expect(text).toContain("12 otherwise matching closed call record(s) have no recorded outcome date");
    expect(text).not.toContain("| Total | 0");
  });
});
