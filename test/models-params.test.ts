import { describe, it, expect } from "vitest";
import { supportsTemperature, generationParams } from "@/lib/models-catalog";

// Regression guard for the model-switch bug: the newest Anthropic models reject
// `temperature`, so it must be stripped for them and kept for everything else.
describe("supportsTemperature", () => {
  it("returns false for the models that reject temperature", () => {
    expect(supportsTemperature("claude-opus-4-8")).toBe(false);
    expect(supportsTemperature("claude-sonnet-5")).toBe(false);
    expect(supportsTemperature("claude-opus-5")).toBe(false);
  });

  it("returns false for any future Claude 5+ id (pattern guard)", () => {
    expect(supportsTemperature("claude-haiku-5")).toBe(false);
    expect(supportsTemperature("claude-sonnet-6")).toBe(false);
    expect(supportsTemperature("claude-opus-10")).toBe(false);
  });

  it("returns true for the models that still accept temperature", () => {
    expect(supportsTemperature("claude-haiku-4-5")).toBe(true);
    expect(supportsTemperature("claude-sonnet-4-6")).toBe(true);
    expect(supportsTemperature("gpt-4o")).toBe(true);
    expect(supportsTemperature("gpt-5")).toBe(true);
  });

  it("defaults to true for unknown/empty ids", () => {
    expect(supportsTemperature(undefined)).toBe(true);
    expect(supportsTemperature("")).toBe(true);
    expect(supportsTemperature("some-new-model")).toBe(true);
  });
});

describe("generationParams", () => {
  it("omits temperature for no-temperature models but keeps maxTokens", () => {
    const p = generationParams("claude-opus-4-8", { temperature: 0, maxTokens: 1024 });
    expect(p).toEqual({ maxTokens: 1024 });
    expect("temperature" in p).toBe(false);
  });

  it("keeps temperature for models that support it", () => {
    const p = generationParams("claude-sonnet-4-6", { temperature: 0.2, maxTokens: 512 });
    expect(p).toEqual({ temperature: 0.2, maxTokens: 512 });
  });

  it("only includes maxTokens when it is a number", () => {
    expect(generationParams("gpt-4o", {})).toEqual({});
    expect(generationParams("gpt-4o", { maxTokens: 256 })).toEqual({ maxTokens: 256 });
  });
});
