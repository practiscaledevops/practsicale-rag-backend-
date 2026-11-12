import { expect, it, vi } from "vitest";
const rpc = vi.hoisted(() => vi.fn());
vi.mock("@/lib/supabase", () => ({ supabaseAdmin: () => ({ rpc }) }));
import { hybridSearchLane } from "@/lib/retrieval";

it("retries a timed-out vector search with the same scope and keyword ranking", async () => {
  rpc.mockReturnValueOnce({ abortSignal: async () => ({ error: { code: "57014" } }) })
    .mockReturnValueOnce({ abortSignal: async () => ({ data: [{ id: "a" }, { id: "b" }, { id: "c" }] }) });
  const rows = await hybridSearchLane({
    orgId: "org", query: "sales", queryEmbedding: [1], classes: ["playbook"],
    scope: { sourceTypes: ["document"], dataSourceIds: ["source"], collectionIds: ["collection"] },
  });
  expect(rows).toHaveLength(3);
  expect(rpc.mock.calls[1]).toEqual(["hybrid_search_lane", {
    ...rpc.mock.calls[0][1], semantic_weight: 0, full_text_weight: 1,
  }]);
});
