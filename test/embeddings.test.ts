import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("openai", () => ({ default: class { embeddings = { create: mocks.create }; } }));
vi.mock("@/lib/secrets", () => ({ getProviderKey: async () => "test-only-key" }));
vi.mock("@/lib/demo/mode", () => ({ isDemo: () => false }));
const vector = (dimension: number) => Array.from({ length: 1024 }, (_, i) => Number(i === dimension));
beforeEach(() => {
  vi.resetModules(); mocks.create.mockReset(); vi.stubEnv("EMBEDDINGS_STRICT", "1");
  mocks.create.mockImplementation(async ({ input }: { input: string[] }) => ({ data: input.map((_, index) => ({ index, embedding: vector(index % 2) })) }));
});
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });
describe("length-safe ingestion embeddings", () => {
  it("preserves every Unicode character while bounding each segment", async () => {
    const { splitEmbeddingInput } = await import("@/lib/embeddings");
    const text = "Sales 漢字 😀\n".repeat(3000);
    const parts = splitEmbeddingInput(text);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join("")).toBe(text);
    expect(parts.every(p => Buffer.byteLength(p, "utf8") <= 6000 && !p.includes("\uFFFD"))).toBe(true);
  });
  it("pools the entire oversized input and keeps following inputs aligned", async () => {
    const { embedForIngest } = await import("@/lib/embeddings");
    const result = await embedForIngest(["a".repeat(7000), "short"]);
    expect(mocks.create.mock.calls[0][0].input.join("")).toBe("a".repeat(7000) + "short");
    expect(result).toHaveLength(2);
    expect(result[0]![0]).toBeCloseTo(6 / Math.sqrt(37));
    expect(result[0]![1]).toBeCloseTo(1 / Math.sqrt(37));
    expect(result[1]).toEqual(vector(0));
  });
  it("respects both per-input and total request limits without losing text", async () => {
    const { embedForIngest } = await import("@/lib/embeddings");
    const text = "a".repeat(300_001);
    expect(await embedForIngest([text])).toHaveLength(1);
    expect(mocks.create).toHaveBeenCalledTimes(2);
    const batches = mocks.create.mock.calls.map(([p]) => p.input as string[]);
    expect(batches.flat().join("")).toBe(text);
    expect(batches.every(batch => batch.length <= 100 && batch.reduce((n, s) => n + Buffer.byteLength(s, "utf8"), 0) <= 240_000)).toBe(true);
  });
  it("rejects incomplete provider results in strict backfills", async () => {
    const { embedForIngest } = await import("@/lib/embeddings");
    mocks.create.mockResolvedValueOnce({ data: [] });
    await expect(embedForIngest(["important evidence"])).rejects.toThrow("incomplete or invalid");
  });
  it("returns null for the whole long input if one segment fails in graceful mode", async () => {
    vi.stubEnv("EMBEDDINGS_STRICT", "0"); vi.spyOn(console, "warn").mockImplementation(() => {});
    const { embedForIngest } = await import("@/lib/embeddings");
    mocks.create.mockRejectedValueOnce(new Error("provider unavailable"));
    const result = await embedForIngest(["a".repeat(300_001), "short"]);
    expect(result[0]).toBeNull();
    expect(result[1]).not.toBeNull();
  });
});
