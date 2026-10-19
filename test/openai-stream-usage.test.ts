import { afterEach, describe, expect, it, vi } from "vitest";
import { getModel } from "@/lib/llm";

vi.mock("@/lib/secrets", () => ({ getProviderKey: vi.fn(async () => "test-key") }));
afterEach(() => vi.unstubAllGlobals());

describe("OpenAI streaming usage", () => {
  it("adapts GPT-6 helper calls to a reasoning budget without unsupported sampling parameters", async () => {
    let sent: any;
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      sent = JSON.parse(init.body);
      return Response.json({ id: "test", model: sent.model, created: 1,
        choices: [{ index: 0, message: { role: "assistant", content: '{"ok":true}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 10, completion_tokens: 5 } });
    }));
    const model = await getModel("gpt-6.1-sol");
    await model.doGenerate({ mode: { type: "object-json", schema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"], additionalProperties: false } },
      inputFormat: "prompt", prompt: [{ role: "user", content: [{ type: "text", text: "OK?" }] }],
      temperature: 0.3, topP: 0.5, maxTokens: 40 });
    expect(sent.model).toBe("gpt-6.1-sol");
    expect(sent.max_tokens).toBeUndefined();
    expect(sent.max_completion_tokens).toBe(2088);
    expect(sent.reasoning_effort).toBe("low");
    expect(sent.temperature).toBeUndefined();
    expect(sent.top_p).toBeUndefined();
    expect(sent.response_format.type).toBe("json_schema");
  });
  it("requests and preserves token counts for models using a dashboard key", async () => {
    const requests: Record<string, any>[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      requests.push(body);
      const chunk = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
      const events = [
        chunk({ id: "test", model: "gpt-4o-mini", choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] }),
        chunk({ id: "test", model: "gpt-4o-mini", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
      ];
      // OpenAI sends the usage-only chunk only when the caller requests it.
      if (body.stream_options?.include_usage) {
        events.push(chunk({ id: "test", model: "gpt-4o-mini", choices: [], usage: { prompt_tokens: 11, completion_tokens: 2, total_tokens: 13 } }));
      }
      return new Response(events.join("") + "data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } });
    }));
    const model = await getModel("gpt-4o-mini");
    const result = await model.doStream({ mode: { type: "regular" }, inputFormat: "prompt",
      prompt: [{ role: "user", content: [{ type: "text", text: "Hello" }] }], maxTokens: 8 });
    const reader = result.stream.getReader();
    const parts = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      parts.push(value);
    }
    expect(parts).toContainEqual({ type: "text-delta", textDelta: "OK" });
    expect(parts.find((part) => part.type === "finish")?.usage).toEqual({ promptTokens: 11, completionTokens: 2 });
    expect(requests[0].stream_options).toEqual({ include_usage: true });
  });
});
