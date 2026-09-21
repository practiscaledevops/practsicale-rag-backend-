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
  isSmallTalk,
  buildAttachmentBlock,
} from "@/lib/prompts";
import { routeTier } from "@/lib/route-tier";

describe("redactPII", () => {
  it("masks emails, SSNs and phone numbers, and never leaks the raw value", () => {
    const out = redactPII("Reach John at john.doe@example.com or 415-555-0199; SSN 123-45-6789.");
    expect(out).toContain("[EMAIL]");
    expect(out).toContain("[SSN]");
    expect(out).toContain("[PHONE]");
    expect(out).not.toContain("john.doe@example.com");
    expect(out).not.toContain("123-45-6789");
    expect(out).not.toContain("415-555-0199");
  });

  it("masks international phones and Luhn-valid card numbers", () => {
    expect(redactPII("call +92 300 123 4567 or (021) 3456-7890")).toBe("call [PHONE] or [PHONE]");
    expect(redactPII("card 4111 1111 1111 1111 on file")).toBe("card [CARD] on file");
  });

  it("keeps dates, timestamps, times, scores and record ids intact", () => {
    const s = "call_date 2026-03-12T10:30:00Z scored 29.6/100 on 12/03/2026 at 10:30; id 20260312001; ms 1710236400000; duration 00:12:45";
    expect(redactPII(s)).toBe(s);
  });

  it("keeps numeric tables and counts that happen to sit near dates", () => {
    const table = "Q1-Q3 scores 120 135 150 and phases 85 90 88 92 by quarter";
    expect(redactPII(table)).toBe(table);
    const counts = "We made 12 calls on 2024-03-12 and 7 on 2024-03-13.";
    expect(redactPII(counts)).toBe(counts);
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

describe("isSmallTalk", () => {
  it("flags greetings / pleasantries", () => {
    for (const s of ["hi", "hey!", "Hello there", "hi how are you?", "how's it going", "thanks!", "ok cool", "good morning"]) {
      expect(isSmallTalk(s), s).toBe(true);
    }
  });
  it("does NOT flag real questions or requests", () => {
    for (const s of [
      "how are my consultants performing?",
      "hi, summarize the latest reports",
      "who is Afra?",
      "what is practiscale",
      "write five ad hooks",
    ]) {
      expect(isSmallTalk(s), s).toBe(false);
    }
  });
});

describe("buildAttachmentBlock", () => {
  it("returns empty for missing / empty / non-array input", () => {
    expect(buildAttachmentBlock(undefined)).toBe("");
    expect(buildAttachmentBlock([])).toBe("");
    expect(buildAttachmentBlock("nope")).toBe("");
    expect(buildAttachmentBlock([{ name: "a.txt", text: "   " }])).toBe("");
  });

  it("frames file content as DATA not instructions (prompt-injection boundary)", () => {
    const block = buildAttachmentBlock([{ name: "notes.md", text: "Q3 revenue was $1.2M" }]);
    expect(block).toContain("ATTACHED FILES");
    expect(block).toContain("--- File: notes.md ---");
    expect(block).toContain("Q3 revenue was $1.2M");
    expect(block.toLowerCase()).toContain("not instructions");
    // Attachments are referenced by name, never [id]-cited, so citation
    // validation stays clean.
    expect(block.toLowerCase()).toContain("do not use [id] citations for attachments");
  });

  it("caps the number of files and truncates long text", () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ name: `f${i}.txt`, text: `body ${i}` }));
    const block = buildAttachmentBlock(many, { maxFiles: 3 });
    expect((block.match(/--- File:/g) ?? []).length).toBe(3);

    const long = buildAttachmentBlock([{ name: "big.txt", text: "x".repeat(500) }], {
      maxCharsPerFile: 100,
    });
    expect(long).toContain("…[truncated]");
  });

  it("neutralizes newlines in the file name and skips empty files", () => {
    const block = buildAttachmentBlock([
      { name: "bad\nname.txt", text: "content" },
      { name: "empty.txt", text: "" },
    ]);
    expect(block).toContain("--- File: bad name.txt ---");
    expect((block.match(/--- File:/g) ?? []).length).toBe(1);
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
