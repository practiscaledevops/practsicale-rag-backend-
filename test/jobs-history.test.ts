import { describe, it, expect, vi, beforeEach } from "vitest";

// POST /api/v1/jobs with `history`: a follow-up ("analyse all calls do audit")
// builds the job from the earlier turn's filter. Key lookup, roster read and the
// job engine are mocked (no network).
const m = vi.hoisted(() => ({
  resolveContext: vi.fn(),
  createJob: vi.fn(),
  planJob: vi.fn(),
  dispatchJob: vi.fn(),
}));

vi.mock("@/lib/auth/context", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/context")>()),
  resolveContext: m.resolveContext,
}));
vi.mock("@/lib/jobs/engine", () => ({ createJob: m.createJob, planJob: m.planJob }));
vi.mock("@/lib/jobs/dispatch", () => ({ dispatchJob: m.dispatchJob }));
vi.mock("@/lib/call-review", async (orig) => ({
  ...(await orig<typeof import("@/lib/call-review")>()),
  knownConsultants: vi.fn(async () => ["David Miller", "James Ephrim"]),
}));

import { POST } from "@/app/api/v1/jobs/route";
import { businessDay } from "@/lib/call-review";

function post(body: unknown): Request {
  return new Request("http://localhost/api/v1/jobs", {
    method: "POST",
    headers: { authorization: "Bearer psk_test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function shift(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}
const today = () => businessDay(new Date().toISOString()) ?? new Date().toISOString().slice(0, 10);

beforeEach(() => {
  vi.clearAllMocks();
  m.resolveContext.mockResolvedValue({ orgId: "org-1", key: { id: "k1", capabilities: ["chat"], source_types: [] } });
  m.createJob.mockImplementation(async (input: { title: string }) => ({ id: "job-1", title: input.title }));
  m.planJob.mockResolvedValue(3);
  m.dispatchJob.mockResolvedValue(undefined);
});

describe("POST /api/v1/jobs — history", () => {
  it("'analyse all calls do audit' after 'list yesterday consultants calls' builds a job for yesterday", async () => {
    const res = await POST(
      post({
        query: "analyse all calls do audit",
        history: [
          { role: "user", content: "list yesterday consultants calls" },
          { role: "assistant", content: "Here are yesterday's 12 calls …" },
        ],
      })
    );
    expect(res.status).toBe(201);
    const input = m.createJob.mock.calls[0][0] as { orgId: string; params: Record<string, unknown> };
    expect(input.orgId).toBe("org-1");
    expect(input.params.date).toBe(shift(today(), -1));
    expect(input.params.consultants).toBeUndefined();
    expect(await res.json()).toEqual({ job: { id: "job-1", title: expect.stringContaining("Deep audit"), status: "running", total_tasks: 3 } });
  });

  it("the same follow-up WITHOUT history is still a 400 (no usable filter)", async () => {
    const res = await POST(post({ query: "analyse all calls do audit" }));
    expect(res.status).toBe(400);
    expect(m.createJob).not.toHaveBeenCalled();
  });

  it("a consultant follow-up keeps the earlier date", async () => {
    const res = await POST(
      post({ query: "and david's?", history: [{ role: "user", content: "review yesterday's calls" }, { role: "assistant", content: "…" }] })
    );
    expect(res.status).toBe(201);
    const { params } = m.createJob.mock.calls[0][0] as { params: Record<string, unknown> };
    expect(params).toMatchObject({ date: shift(today(), -1), consultants: ["david"] });
  });

  it("a history turn's createdAt anchors its 'yesterday' to the day it was sent", async () => {
    // The listing was asked two days ago; "yesterday" then is three days before today.
    const sentAt = new Date(Date.now() - 2 * 86_400_000).toISOString();
    const res = await POST(
      post({
        query: "deep audit of them",
        history: [
          { role: "user", content: "list yesterday's calls", createdAt: sentAt },
          { role: "assistant", content: "Here are the calls …", createdAt: sentAt },
        ],
      })
    );
    expect(res.status).toBe(201);
    const { params } = m.createJob.mock.calls[0][0] as { params: Record<string, unknown> };
    expect(params.date).toBe(shift(businessDay(sentAt)!, -1));
    expect(params.date).not.toBe(shift(today(), -1));
  });

  it("validates history: ≤12 items, known roles, ≤4000 chars", async () => {
    const turn = { role: "user", content: "x" };
    expect((await POST(post({ query: "audit them", history: Array.from({ length: 13 }, () => turn) }))).status).toBe(400);
    expect((await POST(post({ query: "audit them", history: [{ role: "tool", content: "x" }] }))).status).toBe(400);
    expect((await POST(post({ query: "audit them", history: [{ role: "user", content: "x".repeat(4001) }] }))).status).toBe(400);
    expect((await POST(post({ query: "audit them", history: "list yesterday's calls" }))).status).toBe(400);
    expect(m.createJob).not.toHaveBeenCalled();
  });

  it("a missing query is a 400", async () => {
    expect((await POST(post({ history: [] }))).status).toBe(400);
  });

  it("still refuses a key that cannot read transcripts", async () => {
    m.resolveContext.mockResolvedValueOnce({ orgId: "org-1", key: { id: "k1", capabilities: ["chat"], source_types: ["pdf"] } });
    expect((await POST(post({ query: "audit yesterday's calls" }))).status).toBe(403);
  });
});
