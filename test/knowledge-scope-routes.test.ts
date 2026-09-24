import { describe, it, expect, vi, beforeEach } from "vitest";

// GET /api/v1/collections (scopes advertised per key) and POST /api/v1/chat
// (`knowledgeScope` validated, narrowed, threaded into the orchestrator), with
// the key lookup, the DB, the model and the orchestrator mocked (no network).
const m = vi.hoisted(() => ({
  resolveContext: vi.fn(),
  orchestrate: vi.fn(),
  insert: vi.fn(),
  collectionsIn: vi.fn(),
  collections: [] as { id: string; name: string | null }[],
}));

vi.mock("@/lib/auth/context", async (orig) => ({
  ...(await orig<typeof import("@/lib/auth/context")>()),
  resolveContext: m.resolveContext,
}));
vi.mock("@/lib/supabase", () => ({
  supabaseAdmin: () => ({
    from: (table: string) => {
      if (table === "collections") {
        const q: Record<string, unknown> = {};
        Object.assign(q, {
          select: () => q,
          eq: () => q,
          order: () => q,
          in: (...args: unknown[]) => {
            m.collectionsIn(...args);
            return q;
          },
          then: (res: (v: unknown) => unknown, rej: (e: unknown) => unknown) =>
            Promise.resolve({ data: m.collections, error: null }).then(res, rej),
        });
        return q;
      }
      return { insert: m.insert };
    },
  }),
}));
// The route also uses the orchestrator's pure capability helpers: keep them real.
vi.mock("@/lib/orchestrator", async (orig) => ({
  ...(await orig<typeof import("@/lib/orchestrator")>()),
  runOrchestratedRetrieval: m.orchestrate,
}));
vi.mock("@/lib/llm", () => ({ getModel: vi.fn(async () => ({ modelId: "claude-haiku-4-5" })) }));
vi.mock("@/lib/prompts-db", () => ({ getActivePrompt: vi.fn(async () => "Answer only from the context.") }));
vi.mock("@/lib/query-log", () => ({ logQuery: vi.fn(async () => {}) }));
vi.mock("@vercel/functions", () => ({ waitUntil: vi.fn() }));
vi.mock("@/lib/settings", async (orig) => {
  const real = await orig<typeof import("@/lib/settings")>();
  const settings = {
    ...real.DEFAULT_SETTINGS,
    features: { ...real.DEFAULT_SETTINGS.features, orchestrator: true, groundOrRefuse: true, learningDetection: false },
  };
  return { ...real, loadSettings: vi.fn(async () => ({ settings, updatedAt: null })) };
});

import { GET as getCollections } from "@/app/api/v1/collections/route";
import { POST as chat } from "@/app/api/v1/chat/route";
import { AuthError } from "@/lib/auth/context";

let keySeq = 0;
function ctx(source_types: string[] = [], collection_ids: string[] = []) {
  // A fresh key id per test so the in-memory rate limiter never interferes.
  return {
    orgId: "org-1",
    key: { id: `key-${++keySeq}`, capabilities: ["chat"], rate_limit_per_min: 100, source_types, data_source_ids: [], collection_ids },
  };
}
const QUESTION = "What did our consultants say about pricing objections?";
function post(body: Record<string, unknown>): Request {
  return new Request("http://localhost/api/v1/chat", {
    method: "POST",
    headers: { authorization: "Bearer psk_test", "content-type": "application/json" },
    body: JSON.stringify({ messages: [{ role: "user", content: QUESTION }], ...body }),
  });
}
function emptyRetrieval(sourceTypes: string[]) {
  return {
    chunks: [],
    effectiveQuery: QUESTION,
    rewritten: false,
    sourceTypes,
    confidence: null,
    intent: { workMode: "general", intentKind: "advise", primaryDomain: null, relatedDomains: [], problem: "", goal: "", keyConcepts: [], entities: [], needsNumbers: false, timeScope: "any", lanes: { reality: 1, learning: 0.6, playbook: 0.6, platform: 0.2, performance: 0.4 }, searchQueries: [], via: "heuristic" },
    mode: "general",
    auto: true,
    lanes: [],
    contextBlock: "",
    performanceBlock: "",
    performanceMetrics: [],
    conflicts: [],
    objects: [],
    annotated: [],
    fallback: false,
    callReview: undefined,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  m.collections = [
    { id: "c-1", name: "Brand" },
    { id: "c-2", name: null },
  ];
  m.insert.mockResolvedValue({ error: null });
  m.orchestrate.mockImplementation(async (o: { scope: { sourceTypes: string[] } }) => emptyRetrieval(o.scope.sourceTypes));
});

describe("GET /api/v1/collections — scopes", () => {
  it("rejects an invalid key", async () => {
    m.resolveContext.mockRejectedValueOnce(new AuthError("Invalid API key"));
    const res = await getCollections(new Request("http://localhost/api/v1/collections"));
    expect(res.status).toBe(401);
  });

  it("keeps collections unchanged and adds every scope for an unrestricted key", async () => {
    m.resolveContext.mockResolvedValueOnce(ctx([]));
    const json = await (await getCollections(new Request("http://localhost/api/v1/collections"))).json();
    expect(json.collections).toEqual([
      { id: "c-1", name: "Brand" },
      { id: "c-2", name: "Untitled" },
    ]);
    expect(json.scopes.map((s: { id: string }) => s.id)).toEqual(["auto", "all", "reality", "playbook", "learning", "calls"]);
    expect(json.scopes.find((s: { id: string }) => s.id === "calls")).toEqual({
      id: "calls",
      label: "Consultant calls",
      description: expect.any(String),
      sensitive: true,
    });
    expect(m.collectionsIn).not.toHaveBeenCalled();
  });

  it("hides the calls scope from a key that can never reach call data", async () => {
    m.resolveContext.mockResolvedValueOnce(ctx(["document"], ["c-1"]));
    const json = await (await getCollections(new Request("http://localhost/api/v1/collections"))).json();
    expect(json.scopes.map((s: { id: string }) => s.id)).toEqual(["auto", "all", "reality", "playbook", "learning"]);
    expect(m.collectionsIn).toHaveBeenCalledWith("id", ["c-1"]);
  });

  it("offers calls to a key scoped to transcripts", async () => {
    m.resolveContext.mockResolvedValueOnce(ctx(["document", "transcript"]));
    const json = await (await getCollections(new Request("http://localhost/api/v1/collections"))).json();
    expect(json.scopes.map((s: { id: string }) => s.id)).toContain("calls");
  });
});

describe("POST /api/v1/chat — knowledgeScope", () => {
  it("rejects an unknown scope id", async () => {
    m.resolveContext.mockResolvedValueOnce(ctx());
    const res = await chat(post({ knowledgeScope: "everything" }));
    expect(res.status).toBe(400);
    expect(m.orchestrate).not.toHaveBeenCalled();
  });

  it("defaults to auto with the key scope untouched", async () => {
    m.resolveContext.mockResolvedValueOnce(ctx(["document"]));
    await (await chat(post({}))).text();
    expect(m.orchestrate).toHaveBeenCalledTimes(1);
    const opts = m.orchestrate.mock.calls[0][0];
    expect(opts.knowledgeScope).toBe("auto");
    expect(opts.scope.sourceTypes).toEqual(["document"]);
  });

  it("threads a lane scope into the orchestrator without touching source types", async () => {
    m.resolveContext.mockResolvedValueOnce(ctx([]));
    await (await chat(post({ knowledgeScope: "playbook" }))).text();
    const opts = m.orchestrate.mock.calls[0][0];
    expect(opts.knowledgeScope).toBe("playbook");
    expect(opts.scope.sourceTypes).toEqual([]);
  });

  it("calls: narrows an unrestricted key to the call data", async () => {
    m.resolveContext.mockResolvedValueOnce(ctx([]));
    await (await chat(post({ knowledgeScope: "calls" }))).text();
    const opts = m.orchestrate.mock.calls[0][0];
    expect(opts.knowledgeScope).toBe("calls");
    expect(opts.scope.sourceTypes).toEqual(["call_score", "transcript"]);
  });

  it("calls: intersects with a restricted key (never widens)", async () => {
    m.resolveContext.mockResolvedValueOnce(ctx(["document", "call_score"]));
    await (await chat(post({ knowledgeScope: "calls" }))).text();
    expect(m.orchestrate.mock.calls[0][0].scope.sourceTypes).toEqual(["call_score"]);
  });

  it("calls: a key without call data gets a plain answer and no retrieval", async () => {
    m.resolveContext.mockResolvedValueOnce(ctx(["document"]));
    const res = await chat(post({ knowledgeScope: "calls" }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toMatch(/No consultant call data is available to you/);
    expect(m.orchestrate).not.toHaveBeenCalled();
  });

  it("calls: a spoke user narrowed away from call data gets the same answer", async () => {
    m.resolveContext.mockResolvedValueOnce(ctx([]));
    const text = await (await chat(post({ knowledgeScope: "calls", sourceTypes: ["document"] }))).text();
    expect(text).toMatch(/No consultant call data is available to you/);
    expect(m.orchestrate).not.toHaveBeenCalled();
  });
});
