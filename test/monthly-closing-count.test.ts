import { expect, it } from "vitest";
import { wantsStructuredCallReport, renderCallReport } from "@/lib/call-report";
import { parseCallReviewFilter, type ScorecardRow } from "@/lib/call-review";

it("answers the ambiguous November closing question with the recorded closing count and no revenue claim", () => {
  const query = "How much have we closed in November?";
  expect(wantsStructuredCallReport(query)).toBe(true);
  const filter = parseCallReviewFilter(query, { referenceDate: "2026-11-13" });
  expect(filter).toMatchObject({ dateFrom: "2026-11-01", dateTo: "2026-11-13", crmStatus: "closed", dateBasis: "outcome", closingCountOnly: true });
  const rows = ["High Ticket", "Low Ticket"].map(closingType => ({ closingType }) as ScorecardRow);
  expect(renderCallReport(rows, filter, "Asia/Karachi")).toContain("2 closed call records** (1 high ticket, 1 low ticket)");
  expect(renderCallReport(rows, filter, "Asia/Karachi")).toContain("don’t include deal amounts");
});
