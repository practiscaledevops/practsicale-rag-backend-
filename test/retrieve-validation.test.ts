import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ resolveContext: vi.fn(), retrieve: vi.fn() }));
vi.mock("@/lib/auth/context", async (original) => ({ ...(await original<typeof import("@/lib/auth/context")>()), resolveContext: mocks.resolveContext }));
vi.mock("@/lib/pipeline", () => ({ runRetrieval: mocks.retrieve }));
vi.mock("@/lib/ratelimit", () => ({ checkRateLimit: () => ({ ok: true }), rateLimitHeaders: () => ({}) }));
vi.mock("@/lib/settings", async (original) => {
  const real = await original<typeof import("@/lib/settings")>();
  return { ...real, loadSettings: vi.fn(async () => ({ settings: real.DEFAULT_SETTINGS })) };
});
import { POST } from "@/app/api/v1/retrieve/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.resolveContext.mockResolvedValue({ orgId: "org", key: { capabilities: ["retrieve"] } });
  mocks.retrieve.mockResolvedValue({ chunks: [], effectiveQuery: "company", rewritten: false, confidence: null });
});

describe("public retrieval request validation", () => {
  it.each(["{", "null", "[]", "42", "{}", '{"query":12}', '{"query":"  "}'])("rejects malformed JSON or query: %s", async (body) => {
    const res = await POST(new Request("http://localhost/api/v1/retrieve", { method: "POST", headers: { "content-type": "application/json" }, body }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBeTruthy();
    expect(mocks.retrieve).not.toHaveBeenCalled();
  });

  it("keeps valid scoped retrieval working and clamps the candidate count", async () => {
    const res = await POST(new Request("http://localhost/api/v1/retrieve", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ query: "  company  ", matchCount: 100000, expandParents: false }) }));
    expect(res.status).toBe(200);
    expect(mocks.retrieve).toHaveBeenCalledWith(expect.objectContaining({ orgId: "org", query: "company",
      settings: expect.objectContaining({ retrieval: expect.objectContaining({ matchCount: 200, expandParents: false }) }) }));
  });
});
