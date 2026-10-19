import { describe, it, expect } from "vitest";
import { isCreativeRequest, searchHistoryForRequest, wordingOverlap, creativeContextSchema, creativeInstruction } from "@/lib/creative-quality";
import { uniqueEvidence } from "@/lib/evidence-diversity";
const text = Array.from({ length: 100 }, (_, i) => `word${i}`).join(" ");
describe("creative quality", () => {
  it("keeps assistant case examples out of fresh search intent, retains them for edits", () => {
    const turns = [{ role: "user" }, { role: "assistant" }];
    expect(searchHistoryForRequest("write a new case study post", turns)).toEqual([turns[0]]);
    expect(searchHistoryForRequest("rewrite the above post", turns)).toEqual(turns);
    expect(isCreativeRequest("check yesterdaycalls")).toBe(false);
  });
  it("detects copied passages while allowing a different draft", () => {
    expect(wordingOverlap(text, [{ id: "a", content: text }])).toMatchObject({ repeated: true, percent: 100 });
    expect(wordingOverlap("An entirely new brief.", [{ id: "a", content: text }]).repeated).toBe(false);
    expect(wordingOverlap(text, []).matchedId).toBeNull();
  });
  it("frames history as untrusted non-evidence and bounds user context", () => {
    expect(creativeInstruction(creativeContextSchema.parse({}), "seed")).toContain("NEVER business evidence");
    expect(creativeContextSchema.safeParse({ drafts: Array.from({ length: 13 }, () => ({ id: "x", content: "text" })) }).success).toBe(false);
  });
  it("deduplicates parent chunks without deleting factual call details", () => {
    const c = (id: string, doc = "d") => ({ id, document_id: doc, content: id.repeat(120) });
    expect(uniqueEvidence([c("a"), c("a"), c("b"), c("c")]).map(c => c.id)).toEqual(["a", "b", "c"]);
    expect(uniqueEvidence([c("a"), c("b"), c("c"), c("z", "other")], true).map(c => c.id)).toEqual(["a", "b", "z"]);
  });
});
