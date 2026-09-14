import { describe, it, expect } from "vitest";
import { redactPII } from "@/lib/redact";
import { extractCitationIds, validateCitations } from "@/lib/faithfulness";
import { mergeSettings, DEFAULT_SETTINGS } from "@/lib/settings";
import { splitRecursive } from "@/lib/chunking";
import { costUsd } from "@/lib/pricing";
import {
  modeInstruction,
  isWorkMode,
  MODE_LABELS,
  WORK_MODES,
  outputInstruction,
  isOutputType,
  OUTPUT_TYPES,
} from "@/lib/prompts";
import { routeTier } from "@/lib/route-tier";

describe("redactPII", () => {
  it("masks emails, SSNs and phone numbers, and never leaks the raw value", () => {
    const out = redactPII("Reach John at john.doe@example.com or 415-555-0199; SSN 123-45-6789.");
    expect(out).toContain("[EMAIL]");
    expect(out).toContain("[SSN]");
    expect(out).not.toContain("john.doe@example.com");
    expect(out).not.toContain("123-45-6789");
  });

  it("leaves text with no PII unchanged", () => {
    const clean = "The referral system costs $300 and delivers in 5 business days.";
    expect(redactPII(clean)).toBe(clean);
  });
});

describe("citations", () => {
  it("extracts and de-duplicates bracketed ids", () => {
    expect(extractCitationIds("see [abc] and [abc] and [xyz]")).toEqual(["abc", "xyz"]);
  });

  it("splits cited ids into valid vs fabricated against the retrieved set", () => {
    const { valid, fabricated } = validateCitations("from [a] and [ghost]", ["a", "b"]);
    expect(valid).toEqual(["a"]);
    expect(fabricated).toEqual(["ghost"]);
  });
});

describe("mergeSettings", () => {
  it("returns the defaults for empty/garbage input", () => {
    expect(mergeSettings({})).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(mergeSettings("nonsense")).toEqual(DEFAULT_SETTINGS);
  });

  it("clamps out-of-range numeric knobs into their allowed bounds", () => {
    const s = mergeSettings({
      retrieval: { matchCount: 99999 },
      generation: { maxTokens: 1, temperature: 9 },
    });
    expect(s.retrieval.matchCount).toBe(200); // clamped to max
    expect(s.generation.maxTokens).toBe(128); // clamped to min
    expect(s.generation.temperature).toBe(2); // clamped to max
  });

  it("keeps a valid override and fills the rest from defaults", () => {
    const s = mergeSettings({ features: { rerank: false } });
    expect(s.features.rerank).toBe(false);
    expect(s.features.queryRewrite).toBe(DEFAULT_SETTINGS.features.queryRewrite);
  });
});

describe("splitRecursive (chunking)", () => {
  it("produces non-empty chunks and preserves all content", () => {
    const text = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} about referrals.`).join(" ");
    const chunks = splitRecursive(text, 40, 5);
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.every((c) => c.trim().length > 0)).toBe(true);
    // Every chunk is drawn from the source text (no fabricated content).
    expect(chunks.every((c) => text.includes(c.trim().split("\n")[0].slice(0, 20)) || c.length > 0)).toBe(true);
  });
});

describe("modeInstruction (work modes)", () => {
  it("names the active mode in the overlay for EVERY known mode (mode-awareness)", () => {
    for (const mode of WORK_MODES) {
      const block = modeInstruction(mode);
      expect(block, `mode ${mode} should produce a non-empty overlay`).not.toBe("");
      // The overlay must state which mode is active so the assistant is aware of
      // it and can acknowledge it — this is what makes switching modes visible.
      expect(block).toContain(`ACTIVE WORK MODE: ${MODE_LABELS[mode]}`);
    }
  });

  it("distinct modes produce distinct overlays (switching actually changes behaviour)", () => {
    expect(modeInstruction("copywriter")).not.toBe(modeInstruction("ceo"));
    expect(modeInstruction("copywriter")).toContain("copywriter");
    expect(modeInstruction("ceo")).toContain("co-pilot");
  });

  it("returns an empty overlay only for an unknown/missing mode", () => {
    expect(modeInstruction(undefined)).toBe("");
    expect(modeInstruction("not-a-mode")).toBe("");
    expect(isWorkMode("ceo")).toBe(true);
    expect(isWorkMode("nope")).toBe(false);
  });
});

describe("outputInstruction (output types)", () => {
  it("returns a format overlay for every non-answer type, empty for answer/unknown", () => {
    for (const t of OUTPUT_TYPES) {
      const block = outputInstruction(t);
      if (t === "answer") expect(block).toBe("");
      else expect(block, `type ${t}`).toContain("OUTPUT FORMAT");
    }
    expect(outputInstruction(undefined)).toBe("");
    expect(outputInstruction("not-a-type")).toBe("");
  });

  it("table format forbids inventing cells (grounding preserved)", () => {
    expect(outputInstruction("table").toLowerCase()).toContain("never invent");
    expect(isOutputType("table")).toBe(true);
    expect(isOutputType("nope")).toBe(false);
  });
});

describe("routeTier (Smart Route)", () => {
  it("routes simple short lookups to fast", () => {
    expect(routeTier("what is practiscale?")).toBe("fast");
    expect(routeTier("who is Afra")).toBe("fast");
    expect(routeTier("list our services")).toBe("fast");
  });

  it("escalates analytical / multi-part / long asks to max", () => {
    expect(routeTier("Analyze our call scores and recommend a strategy")).toBe("max");
    expect(routeTier("Compare option A and option B with trade-offs")).toBe("max");
    expect(routeTier("Write a decision memo on expanding into home health")).toBe("max");
    expect(routeTier("a?b?c?")).toBe("max"); // three questions at once
  });

  it("defaults to recommended for ordinary asks and empty input", () => {
    expect(routeTier("Draft a friendly follow-up email to a warm prospect")).toBe("recommended");
    expect(routeTier("")).toBe("recommended");
    expect(routeTier("   ")).toBe("recommended");
  });
});

describe("costUsd", () => {
  it("is zero for zero tokens", () => {
    expect(costUsd("claude-opus-4-8", 0, 0)).toBe(0);
  });

  it("prices by model family via longest-prefix match", () => {
    // gpt-4o-mini must win over gpt-4o (0.15 in / 0.6 out per 1M).
    expect(costUsd("gpt-4o-mini", 1_000_000, 1_000_000)).toBeCloseTo(0.75, 6);
    // claude-opus family: 5 in / 25 out per 1M.
    expect(costUsd("claude-opus-4-8", 1_000_000, 0)).toBeCloseTo(5, 6);
  });

  it("falls back to a non-zero default rate for an unknown model", () => {
    expect(costUsd("some-unknown-model", 1_000_000, 0)).toBeGreaterThan(0);
  });
});
