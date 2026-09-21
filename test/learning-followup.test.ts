import { describe, it, expect } from "vitest";
import {
  cosine,
  parseEmbedding,
  scoreFollowupCandidate,
  emptySignals,
  fallbackResult,
  FALLBACK_RESULT_SUMMARY,
  metricsAfterObject,
  resultRecordMarkdown,
  type FollowupSignals,
  type LearningRecordRow,
} from "@/lib/learning-followup";
import { parseFrontmatter, splitSections, type KnowledgeObjectRow } from "@/lib/knowledge-store";

const THRESHOLD = 0.62; // settings.intelligence.suggestThreshold default

function signals(over: Partial<FollowupSignals> = {}): FollowupSignals {
  return { ...emptySignals(), ...over };
}

describe("follow-up candidate scoring", () => {
  it("cosine + pgvector parsing", () => {
    expect(cosine([1, 0, 0], [1, 0, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
    expect(cosine([], [1])).toBe(0);
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(parseEmbedding("[0.1,0.2,0.3]")).toEqual([0.1, 0.2, 0.3]);
    expect(parseEmbedding([0, 1])).toEqual([0, 1]);
    expect(parseEmbedding([0, 0])).toBeNull(); // a zero vector is "no embedding"
    expect(parseEmbedding("not json")).toBeNull();
    expect(parseEmbedding(null)).toBeNull();
  });

  it("similarity carries most of the weight; a strong semantic match alone clears the threshold", () => {
    const strong = scoreFollowupCandidate({ similarity: 0.85, evidence: signals(), record: signals(), department: null });
    expect(strong.score).toBeGreaterThanOrEqual(THRESHOLD);
    expect(strong.overlap).toBe(0);
    expect(strong.reasons).toEqual(["Semantically similar (85%)"]);
    const weak = scoreFollowupCandidate({ similarity: 0.5, evidence: signals(), record: signals(), department: null });
    expect(weak.score).toBeLessThan(THRESHOLD);
  });

  it("domain, department, shared entities and shared concepts lift a middling match over the line", () => {
    const evidence = signals({
      domain: "sales",
      tags: ["close_rate", "nemt", "q2"],
      keyConcepts: ["close rate"],
      entityIds: ["e-nemt", "e-close"],
      entitySlugs: ["nemt", "close_rate", "crm"],
      entityNames: { "e-nemt": "NEMT", "e-close": "Close rate" },
    });
    const record = signals({ domain: "sales", tags: ["close_rate"], appliesTo: ["nemt"], entityIds: ["e-nemt", "e-close", "e-other"], entityNames: { "e-other": "Other" } });
    const bare = scoreFollowupCandidate({ similarity: 0.6, evidence: signals(), record: signals(), department: null });
    const rich = scoreFollowupCandidate({ similarity: 0.6, evidence, record, department: "CRM" });
    expect(bare.score).toBeLessThan(THRESHOLD);
    expect(rich.score).toBeGreaterThanOrEqual(THRESHOLD);
    expect(rich.overlap).toBeGreaterThan(0.5);
    expect(rich.reasons).toContain("same domain (sales)");
    expect(rich.reasons).toContain('department "CRM" mentioned');
    expect(rich.reasons.some((r) => r.startsWith("shares 2 entities (NEMT, Close rate)"))).toBe(true);
    expect(rich.reasons.some((r) => r.startsWith("shares 2 concepts"))).toBe(true);
  });

  it("overlap is capped and never substitutes for meaning", () => {
    const tags = ["sop", "handoff", "queue", "backlog", "sla", "escalation"];
    const evidence = signals({ domain: "ops", tags, entityIds: ["1", "2", "3", "4", "5"], entitySlugs: ["ops"] });
    const record = signals({ domain: "ops", tags, entityIds: ["1", "2", "3", "4", "5"] });
    const s = scoreFollowupCandidate({ similarity: 0, evidence, record, department: "Ops" });
    expect(s.overlap).toBe(1);
    expect(s.score).toBeCloseTo(0.25, 3);
    expect(s.score).toBeLessThan(THRESHOLD);
  });

  it("department matches on a token of a mentioned entity or facet, not on unrelated words", () => {
    const hit = scoreFollowupCandidate({ similarity: 0, evidence: signals({ entitySlugs: ["sales_crm_team"] }), record: signals(), department: "CRM" });
    expect(hit.reasons).toContain('department "CRM" mentioned');
    const miss = scoreFollowupCandidate({ similarity: 0, evidence: signals({ entitySlugs: ["marketing"] }), record: signals(), department: "CRM" });
    expect(miss.overlap).toBe(0);
  });
});

describe("computed result", () => {
  const record: LearningRecordRow = {
    id: "rec-1",
    org_id: "org",
    object_id: "obj-dec",
    record_type: "implementation",
    lifecycle_status: "measuring",
    department: "CRM",
    owner: null,
    changes: { what: "Daily recurring tasks → 175 min" },
    metrics_before: { manager_involvement: "63%" },
    metrics_after: {},
    confidence: null,
    related_playbook_refs: ["MG-001"],
    evidence_document_ids: [],
    missing_evidence: [],
    parent_record_id: null,
    source: "manual",
    created_by: null,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
  };
  const obj = (over: Partial<KnowledgeObjectRow>): KnowledgeObjectRow =>
    ({ id: "x", ref: "X-001", name: "X", intelligence_class: "business_reality", domain: "management", tags: [], summary: null, compiled_markdown: null, ...over }) as KnowledgeObjectRow;

  it("the deterministic fallback is a proposed result the human completes", () => {
    const f = fallbackResult();
    expect(f.summary).toBe(FALLBACK_RESULT_SUMMARY);
    expect(f.summary).toBe("Evidence attached — fill in the numbers");
    expect(f.metricsAfter).toEqual([]);
    expect(f.confidence).toBe("low");
    expect(f.via).toBe("fallback");
  });

  it("metrics_after is stored keyed by metric", () => {
    expect(metricsAfterObject([{ key: "close_rate", value: 11.8, unit: "%" }, { key: "", value: 1, unit: null }])).toEqual({ close_rate: { value: 11.8, unit: "%" } });
  });

  it("renders canonical markdown the compiler stores without a model call (frontmatter + sections)", () => {
    const { name, markdown } = resultRecordMarkdown({
      record,
      recordObject: obj({ id: "obj-dec", ref: "IMP-002", name: "Manager workload redesign", intelligence_class: "organizational_learning", tags: ["delegation"] }),
      evidence: obj({ id: "obj-ev", ref: "BR-MG-004", name: "Q2 manager time report", summary: "Manager involvement fell to 31%." }),
      computed: { summary: "Involvement fell from 63% to 31%.", metricsAfter: [{ key: "manager_involvement", value: 31, unit: "%" }], confidence: "high", interpretation: "It worked.", model: "claude-x", via: "llm" },
    });
    expect(name).toBe("Result: Manager workload redesign");
    const { data } = parseFrontmatter(markdown);
    expect(data.class).toBe("organizational_learning");
    expect(data.type).toBe("result");
    expect(data.domain).toBe("management");
    expect(data.name).toBe(name);
    expect(data.tags).toEqual(expect.arrayContaining(["delegation", "result", "auto_computed"]));
    const { title, sections } = splitSections(markdown);
    expect(title).toBe(name);
    const headings = sections.map((s) => s.heading);
    expect(headings).toEqual(["Summary", "Metrics After", "Metrics Before", "Interpretation", "Evidence"]);
    expect(sections[1].body).toContain("- manager_involvement: 31 %");
    expect(sections[2].body).toContain("- manager_involvement: 63%");
    expect(sections[4].body).toContain("BR-MG-004 — Q2 manager time report");
    expect(sections[4].body).toContain("Follows IMP-002");
    expect(sections[4].body).toContain("confidence high");
  });

  it("the fallback markdown keeps only what is known and asks for the numbers", () => {
    const { markdown } = resultRecordMarkdown({
      record: { ...record, metrics_before: {} },
      recordObject: obj({ ref: "DEC-001", name: "Decision", intelligence_class: "organizational_learning" }),
      evidence: obj({ ref: "BR-CO-001", name: "Report" }),
      computed: fallbackResult(),
    });
    const { sections } = splitSections(markdown);
    expect(sections.map((s) => s.heading)).toEqual(["Summary", "Metrics After", "Evidence"]);
    expect(sections[0].body).toBe(FALLBACK_RESULT_SUMMARY);
    expect(sections[1].body).toContain("Not extracted");
    expect(sections[2].body).toContain("deterministic fallback");
  });
});
