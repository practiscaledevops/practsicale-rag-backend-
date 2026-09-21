import { describe, it, expect } from "vitest";
import {
  slugify,
  reconcileValue,
  refPrefix,
  formatRef,
  defaultAuthority,
  isCurrent,
  realityBucketOf,
  typesFor,
  domainsForClass,
  authorityWeight,
} from "@/lib/intelligence-taxonomy";
import {
  normalizeMode,
  modeDef,
  detectWorkModeHeuristic,
  resolveEffectiveMode,
  effectivePolicy,
  WORK_MODE_DEFS,
  RESTRICTED_MODES,
} from "@/lib/work-modes";
import { chunkKnowledgeObject, stripFrontmatter } from "@/lib/chunking";
import { buildFrontmatter, parseFrontmatter, assembleMarkdown, splitSections, objectContextLine } from "@/lib/knowledge-store";
import { extractJson } from "@/lib/structured";
import { modeInstruction, WORK_MODES, MODE_LABELS } from "@/lib/prompts";

describe("taxonomy helpers", () => {
  it("slugifies and reconciles near-duplicate taxonomy values", () => {
    expect(slugify("Management Leverage")).toBe("management_leverage");
    expect(slugify("Talent & Hiring")).toBe("talent_and_hiring");
    // Exact (after slugging) wins with similarity 1.
    expect(reconcileValue("Management leverage", ["management_leverage", "delegation"])).toEqual({ value: "management_leverage", similarity: 1 });
    // Containment / token overlap reconciles "delegation rights" → "delegation".
    const hit = reconcileValue("delegation rights", ["delegation", "accountability"]);
    expect(hit?.value).toBe("delegation");
    // Nothing close → null (so the compiler proposes a new value).
    expect(reconcileValue("decision rights", ["accountability", "ownership"])).toBeNull();
  });

  it("builds stable refs per class/domain", () => {
    expect(refPrefix({ intelligence_class: "playbook", domain: "management" })).toBe("MG");
    expect(refPrefix({ intelligence_class: "business_reality", domain: "sales" })).toBe("BR-SAL");
    expect(refPrefix({ intelligence_class: "organizational_learning", object_type: "decision" })).toBe("DEC");
    expect(refPrefix({ intelligence_class: "platform_intelligence", domain: "linkedin" })).toBe("PI-LI");
    expect(formatRef("MG", 7)).toBe("MG-007");
    expect(formatRef("DEC", 1234)).toBe("DEC-1234");
  });

  it("derives authority from class + governance, and currency from temporal fields", () => {
    expect(defaultAuthority({ intelligence_class: "playbook" })).toBe("B3");
    expect(defaultAuthority({ intelligence_class: "playbook", founder_endorsement: "approved" })).toBe("B2");
    expect(defaultAuthority({ intelligence_class: "playbook", founder_endorsement: "practiscale_standard" })).toBe("B1");
    expect(defaultAuthority({ intelligence_class: "business_reality", domain: "company", object_type: "pricing" })).toBe("A1");
    expect(defaultAuthority({ intelligence_class: "business_reality", domain: "sales", object_type: "call" })).toBe("A4");
    expect(defaultAuthority({ intelligence_class: "business_reality", domain: "company", status: "historical" })).toBe("C1");
    expect(defaultAuthority({ intelligence_class: "raw_archive" })).toBe("C2");
    expect(authorityWeight("A1")).toBeGreaterThan(authorityWeight("B3"));
    expect(authorityWeight("C3")).toBeLessThan(0);

    expect(isCurrent({})).toBe(true);
    expect(isCurrent({ effective_until: "2020-01-01T00:00:00Z" })).toBe(false);
    expect(isCurrent({ effective_from: "2999-01-01T00:00:00Z" })).toBe(false);
    expect(isCurrent({ status: "historical" })).toBe(false);
  });

  it("maps reality objects into human buckets without a second taxonomy", () => {
    expect(realityBucketOf({ domain: "customer", object_type: "testimonial" })).toBe("proof_evidence");
    expect(realityBucketOf({ domain: "founder", object_type: "belief" })).toBe("founder_brain");
    expect(realityBucketOf({ domain: "sales", object_type: "call" })).toBe("sales_intelligence");
    expect(realityBucketOf({ domain: "company", object_type: "pricing", status: "historical" })).toBe("historical_archive");
  });

  it("offers content-only types only for the content domain", () => {
    expect(typesFor("playbook", "content").some((t) => t.id === "hook")).toBe(true);
    expect(typesFor("playbook", "management").some((t) => t.id === "hook")).toBe(false);
    expect(typesFor("playbook", "management").some((t) => t.id === "framework")).toBe(true);
    expect(domainsForClass("platform_intelligence").map((d) => d.id)).toEqual(["platform"]);
  });
});

describe("work modes", () => {
  it("normalizes legacy aliases to canonical modes", () => {
    expect(normalizeMode("ceo")).toBe("ceo_advisor");
    expect(normalizeMode("sales")).toBe("sales_coach");
    expect(normalizeMode("media")).toBe("content_strategist");
    expect(normalizeMode("decision_maker")).toBe("decision_memo");
    expect(normalizeMode("Training_Builder")).toBe("training_builder");
    expect(normalizeMode("nope")).toBeNull();
    expect(modeDef("strategy")?.id).toBe("strategy_advisor");
  });

  it("every mode has a label, a policy and an instruction; restricted set is explicit", () => {
    for (const m of WORK_MODE_DEFS) {
      expect(m.label.length).toBeGreaterThan(0);
      expect(m.instruction.length).toBeGreaterThan(20);
      expect(Object.keys(m.policy.lanes)).toEqual(["reality", "learning", "playbook", "platform", "performance"]);
    }
    expect(RESTRICTED_MODES).toEqual(expect.arrayContaining(["ceo_advisor", "ceo_content", "decision_memo"]));
    // prompts.ts re-exports the registry: every canonical mode has an overlay naming it.
    for (const mode of WORK_MODES) {
      expect(modeInstruction(mode)).toContain(`ACTIVE WORK MODE: ${MODE_LABELS[mode]}`);
    }
  });

  it("detects the expert job heuristically (Auto fallback)", () => {
    expect(detectWorkModeHeuristic("Build a 90-minute accountability training for my managers")).toBe("training_builder");
    expect(detectWorkModeHeuristic("Write the SOP for client onboarding handoff")).toBe("sop_builder");
    expect(detectWorkModeHeuristic("Why does my manager keep doing everyone's work?")).toBe("management_coach");
    expect(detectWorkModeHeuristic("Turn this experience into 10 LinkedIn posts about my story")).toBe("ceo_content");
    expect(detectWorkModeHeuristic("Give me 20 reel ideas")).toBe("content_strategist");
    expect(detectWorkModeHeuristic("Help me improve my high-ticket close rate")).toBe("sales_coach");
    expect(detectWorkModeHeuristic("Should we expand into home health? Decide.")).toBe("decision_memo");
    expect(detectWorkModeHeuristic("hello there")).toBe("general");
  });

  it("manual selection overrides Auto; Auto resolves to the detected mode", () => {
    expect(resolveEffectiveMode("sales", "management_coach")).toEqual({ mode: "sales_coach", auto: false });
    expect(resolveEffectiveMode("auto", "management_coach")).toEqual({ mode: "management_coach", auto: true });
    expect(resolveEffectiveMode(undefined, null)).toEqual({ mode: "general", auto: true });
    const p = effectivePolicy("management_coach", ["talent_hiring"]);
    expect(p.preferredDomains[0]).toBe("talent_hiring");
    expect(p.preferredDomains).toContain("management");
    expect(p.lanes.playbook).toBe(1);
  });
});

describe("semantic chunking of knowledge objects", () => {
  const md = `---
id: MG-001
name: Source of Energy Accountability
class: playbook
---

# Source of Energy Accountability

## Definition

The person who needs constant reminders does not own the outcome.

## Diagnostic

Ask: who chases whom?

### Sub-point

Detail here.

## Guardrails

Do not delegate QA authority too early.
`;

  it("strips frontmatter and makes one chunk per heading section, inheriting metadata", () => {
    expect(stripFrontmatter(md).startsWith("# Source")).toBe(true);
    const chunks = chunkKnowledgeObject(md, { object_ref: "MG-001", domain: "management" });
    const sections = chunks.map((c) => c.metadata.section);
    expect(sections).toEqual(["Definition", "Diagnostic", "Sub-point", "Guardrails"]);
    // Title line is carried into the first section for context.
    expect(chunks[0].content.startsWith("# Source of Energy Accountability")).toBe(true);
    expect(chunks[0].content).toContain("## Definition");
    for (const c of chunks) {
      expect(c.metadata.object_ref).toBe("MG-001");
      expect(c.metadata.domain).toBe("management");
      expect(c.metadata.is_object_section).toBe(true);
    }
    expect(chunks.some((c) => c.content.includes("id: MG-001"))).toBe(false);
  });

  it("sub-splits only an unusually long section (safety boundary) into parent + children", () => {
    const long = "## Framework\n\n" + Array.from({ length: 400 }, (_, i) => `Rule ${i}: keep decisions close to the work.`).join(" ");
    const chunks = chunkKnowledgeObject(`# T\n\n${long}\n\n## Short\n\nOne line.`);
    const parents = chunks.filter((c) => c.metadata.is_parent);
    expect(parents.length).toBe(1);
    expect(chunks.filter((c) => c.parentKey === parents[0].key).length).toBeGreaterThan(1);
    expect(chunks.filter((c) => c.metadata.section === "Short").length).toBe(1);
  });
});

describe("frontmatter codec", () => {
  it("round-trips an object's frontmatter and sections", () => {
    const fm = buildFrontmatter({
      ref: "MG-001",
      name: "Source of Energy",
      intelligence_class: "playbook",
      domain: "management",
      object_type: "framework",
      subtype: "accountability",
      status: "active",
      priority: "core",
      founder_endorsement: "approved",
      authority: "B2",
      applies_to: ["managers", "team_leaders"],
      goals: ["accountability"],
      tags: ["ownership", "initiative"],
      source_expert: "Creator: Name",
      source_platform: "instagram",
      version: 1,
    });
    const md = assembleMarkdown(fm, "Source of Energy", [
      { heading: "Definition", body: "Who chases whom." },
      { heading: "Guardrails", body: "Keep QA central." },
    ]);
    const { data, body } = parseFrontmatter(md);
    expect(data.id).toBe("MG-001");
    expect(data.applies_to).toEqual(["managers", "team_leaders"]);
    expect((data.source as Record<string, unknown>).platform).toBe("instagram");
    expect((data.source as Record<string, unknown>).expert).toBe("Creator: Name");
    expect(data.version).toBe(1);
    expect(body.trim().startsWith("# Source of Energy")).toBe(true);
    const parts = splitSections(md);
    expect(parts.title).toBe("Source of Energy");
    expect(parts.sections.map((s) => s.heading)).toEqual(["Definition", "Guardrails"]);
  });

  it("parses related_objects lists from user-supplied markdown", () => {
    const md = `---
id: MG-009
related_objects:
  - id: MG-002
    relationship: complements
  - id: TAL-001
    relationship: related_to
tags: [a, b]
---
# X
`;
    const { data } = parseFrontmatter(md);
    expect(data.related_objects).toEqual([
      { id: "MG-002", relationship: "complements" },
      { id: "TAL-001", relationship: "related_to" },
    ]);
    expect(data.tags).toEqual(["a", "b"]);
  });

  it("builds the deterministic context line", () => {
    expect(
      objectContextLine({ ref: "MG-001", name: "Source of Energy", intelligence_class: "playbook", domain: "management", object_type: "framework", subtype: "accountability", authority: "B2", founder_endorsement: "approved" })
    ).toBe("MG-001 Source of Energy · playbook/management/framework/accountability · authority B2, endorsement approved");
  });
});

describe("structured JSON extraction", () => {
  it("pulls JSON out of fences and prose", () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! Here it is: {"a":[1,2]} hope that helps')).toEqual({ a: [1, 2] });
    expect(extractJson("no json here")).toBeNull();
  });
});
