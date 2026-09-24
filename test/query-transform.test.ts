import { describe, it, expect, vi, beforeEach } from "vitest";

// The query rewriter's prompt stays bounded however long the conversation's
// turns are (the chat route hands over the untrimmed recent window).
const m = vi.hoisted(() => ({ generateText: vi.fn() }));

vi.mock("ai", async (orig) => ({ ...(await orig<typeof import("ai")>()), generateText: m.generateText }));
vi.mock("@/lib/llm", () => ({ getModel: vi.fn(async () => ({ modelId: "claude-haiku-4-5" })) }));
vi.mock("@/lib/demo/mode", () => ({ isDemo: () => false }));

import { rewriteQueries, rewriteQuery, type ChatTurn } from "@/lib/query-transform";

const longTurns: ChatTurn[] = Array.from({ length: 8 }, (_, i) => ({
  role: i % 2 ? "assistant" : "user",
  content: `turn-${i} ` + "x".repeat(40_000),
}));

beforeEach(() => {
  vi.clearAllMocks();
  m.generateText.mockResolvedValue({ text: "pricing tiers" });
});

describe("query rewriter prompt size", () => {
  it("rewriteQueries clips each history turn and the question", async () => {
    await rewriteQueries("q ".repeat(20_000), longTurns, "sys");
    const { prompt } = m.generateText.mock.calls[0][0] as { prompt: string };
    expect(prompt.length).toBeLessThan(20_000);
    expect(prompt).toContain("turn-7 "); // the newest turns are still there
    expect(prompt).not.toContain("turn-1 "); // only the last six
  });

  it("rewriteQuery clips each history turn and the question", async () => {
    await rewriteQuery("q ".repeat(20_000), longTurns, "sys");
    const { prompt } = m.generateText.mock.calls[0][0] as { prompt: string };
    expect(prompt.length).toBeLessThan(20_000);
    expect(prompt).toContain("turn-7 ");
  });
});
