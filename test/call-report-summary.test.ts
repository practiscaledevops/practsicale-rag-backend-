import { describe, expect, it } from "vitest";
import { consultantSummaryContext, summarizeConsultantCalls } from "@/lib/call-report-summary";
import type { ScorecardRow } from "@/lib/call-review";

const call = (patch: Partial<ScorecardRow> = {}): ScorecardRow => ({ date: "2026-10-19", time: "21:00",
  consultant: "Alex", consultantId: "alex-id", prospect: "Prospect", practice: "Home Care",
  score: 50, band: null, outcome: "Pending", closingType: "Unclassified", originalOutcome: "Unknown", duration: 10, ...patch });

describe("consultant call report summaries", () => {
  it("separates historical follow-up outcomes from current CRM status and confirmed ticket closes", () => {
    const result = summarizeConsultantCalls([
      call({ outcome: "Closed", closingType: "High Ticket", originalOutcome: "Follow Up", callSequence: "Call 1 (initial call)" }),
      call({ closingType: "Low Ticket", originalOutcome: "Closed", callSequence: "Call 2 (follow-up call)" }),
      call({ outcome: "Not Closed", closingType: "High Ticket", originalOutcome: "Follow Up" }),
      call({ outcome: "Closed", closingType: "Low Ticket" }),
      call({ outcome: "Closed" }), call({ outcome: "Disqualified" }),
      call({ consultant: "Blair", consultantId: "blair-id", outcome: null, originalOutcome: "Follow Up" }),
    ]);
    expect(result.consultants[0]).toEqual({ consultant: "Alex", totalCalls: 6, followUps: 2,
      highTicketClosings: 1, lowTicketClosings: 1, closed: 3, notClosed: 1, pending: 1,
      disqualified: 1, otherStatus: 0, unclassifiedClosings: 1 });
    expect(result.total).toMatchObject({ totalCalls: 7, followUps: 3, highTicketClosings: 1,
      lowTicketClosings: 1, closed: 3, notClosed: 1, pending: 2, disqualified: 1 });
    expect(result.total.closed + result.total.notClosed + result.total.pending + result.total.disqualified).toBe(result.total.totalCalls);
  });

  it("groups by stable consultant identity and keeps different people with the same name separate", () => {
    const result = summarizeConsultantCalls([
      call(), call({ consultant: " ALEX  " }), call({ consultantId: "other-alex" }),
      call({ consultantId: undefined, consultant: " Blair " }), call({ consultantId: undefined, consultant: "blair" }),
    ]);
    expect(result.consultants.map(r => r.totalCalls).sort()).toEqual([1, 2, 2]);
    expect(result.total.totalCalls).toBe(5);
  });

  it("renders all requested columns and adds reconciling columns only when needed", () => {
    const context = consultantSummaryContext([call({ consultant: "Alex|Team\nA", outcome: "Closed" }), call({ outcome: "Disqualified" })]);
    expect(context).toContain("| Consultant | Total Calls | Follow Ups | High Ticket Closings | Low Ticket Closings | Closed | Not Closed | Pending | Disqualified | Unclassified Closings |");
    expect(context).toContain("Alex\\|Team A");
    expect(context).toContain("complete matching scorecard");
    expect(context).toContain("| Total | 2 | 0 | 0 | 0 | 1 | 0 | 0 | 1 | 1 |");
    expect(consultantSummaryContext([call()])).not.toContain("| Disqualified |");
  });

  it("does not turn an unknown CRM status into Pending or silently lose it from totals", () => {
    const result = summarizeConsultantCalls([call({ outcome: "Future Status" })]);
    expect(result.total).toMatchObject({ totalCalls: 1, otherStatus: 1, pending: 0, closed: 0 });
    expect(consultantSummaryContext([call({ outcome: "Future Status" })])).toContain("Other Status");
  });

  it("has no invented consultant rows when the call set is empty", () => {
    expect(summarizeConsultantCalls([]).consultants).toEqual([]);
    expect(consultantSummaryContext([])).toBe("");
  });
});
