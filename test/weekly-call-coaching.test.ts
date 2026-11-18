import { expect, it, vi } from "vitest";
import { attachCoachingEvidence, readWeeklyCoaching } from "@/lib/weekly-call-coaching";

const m = vi.hoisted(() => ({ fetchCallsByFilter: vi.fn(), from: vi.fn(), structured: vi.fn() }));
vi.mock("@/lib/call-review", () => ({ fetchCallsByFilter: m.fetchCallsByFilter }));
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => ({ from: m.from }) }));
vi.mock("@/lib/structured", () => ({ structured: m.structured }));

const example = {
  consultant: "Consultant", date: "2026-11-01", timestamp: "05:41",
  quote: "Can we agree a time to speak tomorrow?", recordId: "source-record",
};
const coaching = { observation: "Asked for a next step.", action: "Confirm a precise time." };

it("only returns existing transcript excerpts and takes one example per call", () => {
  const evidence = [{ ...example, documentId: "call-1" }, { ...example, documentId: "call-1", timestamp: "08:12" }];
  expect(attachCoachingEvidence({ examples: [
    { ...coaching, excerpt: 99 }, { ...coaching, excerpt: 0 }, { ...coaching, excerpt: 1 },
  ] }, evidence)).toEqual([{ ...evidence[0], ...coaching }]);
});

it("counts scorecards while citing only sampled, timestamped transcript bodies", async () => {
  const ready = { consultant: example.consultant, date: example.date, score: 80 };
  const pending = { ...ready, indexingPending: true, score: 60 };
  m.fetchCallsByFilter.mockResolvedValue({
    complete: true, totalMatched: 3, scorecard: [ready, pending, { ...ready, score: null }],
    scorecardByDocument: new Map([["call-1", ready], ["pending-call", pending]]),
  });
  const query = {
    select: vi.fn(() => query), eq: vi.fn(() => query), order: vi.fn(() => query), limit: vi.fn(() => query),
    abortSignal: async () => ({
      data: [{ content: "05:41 - Consultant\n" + example.quote, metadata: { source_record_id: example.recordId } }],
    }),
  };
  m.from.mockReturnValue(query);
  m.structured.mockResolvedValue({ object: { examples: [{ excerpt: 0, ...coaching }] } });

  const review = await readWeeklyCoaching("org", "2026-10-26", "2026-11-01", "Asia/Karachi", new AbortController().signal);
  expect(review).toMatchObject({
    calls: 3, scoredCalls: 2, averageScore: 70, pendingTranscripts: 1, sampledCalls: 1, coachingStatus: "ready",
    examples: [{ ...example, ...coaching, documentId: "call-1" }],
  });
  expect(query.eq).toHaveBeenCalledWith("org_id", "org");
  expect(query.eq).toHaveBeenCalledWith("metadata->>is_transcript_body", "true");
  expect(query.eq).not.toHaveBeenCalledWith("document_id", "pending-call");
});
