import { describe, it, expect } from "vitest";
import {
  isSensitiveObject,
  projectObject,
  projectObjectDetail,
  truncateMarkdown,
  aggregateObjectCounts,
  countBy,
  parseKnowledgeListParams,
  parseLearningListParams,
  parseSensitiveFlag,
  sanitizeSearchTerm,
  hasReadCapability,
  isUuid,
  MARKDOWN_MAX_CHARS,
} from "@/lib/knowledge-read";
import type { KnowledgeObjectRow } from "@/lib/knowledge-store";

/** A complete row so the projections are exercised against the real shape. */
function row(over: Partial<KnowledgeObjectRow> = {}): KnowledgeObjectRow {
  return {
    id: "3f2504e0-4f89-11d3-9a0c-0305e82c3301",
    org_id: "org-1",
    ref: "MG-001",
    name: "Source of Energy",
    intelligence_class: "playbook",
    domain: "management",
    object_type: "framework",
    subtype: "accountability",
    status: "active",
    priority: "core",
    founder_endorsement: "approved",
    implementation_status: "testing",
    internal_validation: "unvalidated",
    evidence_level: "source_teaching",
    authority: "B2",
    applies_to: ["managers"],
    goals: ["accountability"],
    business_functions: ["leadership"],
    applies_to_platforms: ["universal"],
    tags: ["ownership", "initiative"],
    content_format: null,
    content_job: null,
    funnel_stage: null,
    brand: null,
    audiences: [],
    content_length: null,
    source_expert: "Creator: Name",
    source_type: "video",
    source_platform: "instagram",
    source_url: "https://example.com/x",
    source_date: "2026-01-01",
    source_claims: [{ claim: "It works", verified: false }],
    sources: [{ platform: "instagram" }],
    effective_from: null,
    effective_until: null,
    last_verified_at: "2026-09-01T00:00:00Z",
    version: 1,
    document_id: null,
    raw_document_id: null,
    compiled_markdown: "# Source of Energy\n\n## Definition\n\nWho chases whom.",
    summary: "Who chases whom.",
    attributes: {},
    created_by: null,
    created_at: "2026-08-01T00:00:00Z",
    updated_at: "2026-09-10T00:00:00Z",
    ...over,
  };
}

describe("isSensitiveObject", () => {
  it("flags business-reality call material and KPI reports", () => {
    for (const t of ["call", "call_score", "transcript", "kpi_report"]) {
      expect(isSensitiveObject({ intelligence_class: "business_reality", object_type: t })).toBe(true);
    }
  });

  it("does not flag the same types outside business reality, nor other reality types", () => {
    expect(isSensitiveObject({ intelligence_class: "playbook", object_type: "call" })).toBe(false);
    expect(isSensitiveObject({ intelligence_class: "business_reality", object_type: "pricing" })).toBe(false);
    expect(isSensitiveObject({ intelligence_class: "business_reality", object_type: "report" })).toBe(false);
    expect(isSensitiveObject({})).toBe(false);
  });

  it("flags the call-score team snapshot in any class via attributes.snapshot", () => {
    expect(isSensitiveObject({ intelligence_class: "business_reality", object_type: "report", attributes: { snapshot: "call_scores" } })).toBe(true);
    expect(isSensitiveObject({ intelligence_class: "performance_memory", object_type: "metric", attributes: { snapshot: "call_scores" } })).toBe(true);
    expect(isSensitiveObject({ intelligence_class: "business_reality", object_type: "report", attributes: { snapshot: "other" } })).toBe(false);
    expect(isSensitiveObject({ intelligence_class: "business_reality", object_type: "report", attributes: null })).toBe(false);
  });
});

describe("projectObject / projectObjectDetail", () => {
  it("projects exactly the list contract (no org_id, no markdown) and computes current", () => {
    const p = projectObject(row(), new Date("2026-09-21T00:00:00Z"));
    expect(Object.keys(p).sort()).toEqual(
      [
        "id", "ref", "name", "summary", "intelligence_class", "domain", "object_type", "subtype", "tags", "authority",
        "founder_endorsement", "implementation_status", "internal_validation", "status", "current", "priority",
        "updated_at", "last_verified_at", "source_platform", "source_expert",
      ].sort()
    );
    expect(p.ref).toBe("MG-001");
    expect(p.tags).toEqual(["ownership", "initiative"]);
    expect(p.current).toBe(true);
    const loose = p as unknown as Record<string, unknown>;
    expect(loose.org_id).toBeUndefined();
    expect(loose.compiled_markdown).toBeUndefined();
  });

  it("marks historical / expired / not-yet-effective objects as not current, and tolerates null arrays", () => {
    const now = new Date("2026-09-21T00:00:00Z");
    expect(projectObject(row({ status: "historical" }), now).current).toBe(false);
    expect(projectObject(row({ effective_until: "2026-01-01T00:00:00Z" }), now).current).toBe(false);
    expect(projectObject(row({ effective_from: "2027-01-01T00:00:00Z" }), now).current).toBe(false);
    expect(projectObject(row({ tags: null as unknown as string[] }), now).tags).toEqual([]);
  });

  it("detail adds content, provenance, temporal fields and the reality bucket", () => {
    const d = projectObjectDetail(row({ intelligence_class: "business_reality", domain: "sales", object_type: "fact", ref: "BR-SAL-001" }));
    expect(d.compiled_markdown).toContain("## Definition");
    expect(d.platforms).toEqual(["universal"]);
    expect(d.applies_to).toEqual(["managers"]);
    expect(d.source_claims).toEqual([{ claim: "It works", verified: false }]);
    expect(d.bucket).toBe("sales_intelligence");
    // Playbooks have no reality bucket.
    expect(projectObjectDetail(row()).bucket).toBeNull();
  });
});

describe("truncateMarkdown", () => {
  it("returns short markdown untouched and cuts long markdown with a marker", () => {
    expect(truncateMarkdown("  # Hi  ")).toBe("# Hi");
    expect(truncateMarkdown(null)).toBe("");
    const long = "x".repeat(MARKDOWN_MAX_CHARS + 500);
    const out = truncateMarkdown(long);
    expect(out.endsWith("(truncated)")).toBe(true);
    expect(out.length).toBeLessThan(long.length);
    expect(out.slice(0, MARKDOWN_MAX_CHARS)).toBe("x".repeat(MARKDOWN_MAX_CHARS));
  });
});

describe("counts aggregation", () => {
  it("aggregates by class / domain / type and skips empty keys", () => {
    const c = aggregateObjectCounts([
      { intelligence_class: "playbook", domain: "management", object_type: "framework" },
      { intelligence_class: "playbook", domain: "sales", object_type: "script" },
      { intelligence_class: "business_reality", domain: "sales", object_type: "call" },
      { intelligence_class: null, domain: "", object_type: undefined },
    ]);
    expect(c.total).toBe(4);
    expect(c.byClass).toEqual({ playbook: 2, business_reality: 1 });
    expect(c.byDomain).toEqual({ management: 1, sales: 2 });
    expect(c.byType).toEqual({ framework: 1, script: 1, call: 1 });
    expect(aggregateObjectCounts([])).toEqual({ total: 0, byClass: {}, byDomain: {}, byType: {} });
  });

  it("countBy is a plain grouped counter", () => {
    expect(countBy([{ k: "person" }, { k: "person" }, { k: "client" }], (r) => r.k)).toEqual({ person: 2, client: 1 });
  });
});

describe("query-string parsing", () => {
  it("applies the documented defaults", () => {
    const p = parseKnowledgeListParams(new URLSearchParams(""));
    expect(p).toEqual({ class: null, domain: null, type: null, q: null, sensitive: true, includeArchive: false, limit: 30, offset: 0 });
  });

  it("clamps limit to 50, offset to ≥ 0, and reads the flags", () => {
    const p = parseKnowledgeListParams(new URLSearchParams("class=playbook&domain=Management&type=framework&limit=500&offset=-4&sensitive=0&includeArchive=1"));
    expect(p.class).toBe("playbook");
    expect(p.domain).toBe("management");
    expect(p.type).toBe("framework");
    expect(p.limit).toBe(50);
    expect(p.offset).toBe(0);
    expect(p.sensitive).toBe(false);
    expect(p.includeArchive).toBe(true);
    expect(parseKnowledgeListParams(new URLSearchParams("limit=0")).limit).toBe(1);
    expect(parseKnowledgeListParams(new URLSearchParams("limit=abc")).limit).toBe(30);
  });

  it("sensitive is only off for the literal 0", () => {
    expect(parseSensitiveFlag(new URLSearchParams("sensitive=0"))).toBe(false);
    expect(parseSensitiveFlag(new URLSearchParams("sensitive=1"))).toBe(true);
    expect(parseSensitiveFlag(new URLSearchParams("sensitive=false"))).toBe(true);
    expect(parseSensitiveFlag(new URLSearchParams(""))).toBe(true);
  });

  it("sanitizes the search term so it cannot break a PostgREST or() filter", () => {
    expect(sanitizeSearchTerm("  price  objection ")).toBe("price objection");
    expect(sanitizeSearchTerm("a%,b(c){d}\"e'f\\g")).toBe("a b c d e f g");
    expect(sanitizeSearchTerm("x".repeat(300)).length).toBe(120);
    expect(parseKnowledgeListParams(new URLSearchParams("q=%25%25")).q).toBeNull();
  });

  it("parses the learning list params", () => {
    expect(parseLearningListParams(new URLSearchParams("status=Validated&type=decision&limit=10&offset=20"))).toEqual({ status: "validated", type: "decision", limit: 10, offset: 20 });
    expect(parseLearningListParams(new URLSearchParams(""))).toEqual({ status: null, type: null, limit: 30, offset: 0 });
  });
});

describe("read capability + ref detection", () => {
  it("accepts chat OR retrieve, rejects generate-only or empty keys", () => {
    expect(hasReadCapability({ capabilities: ["chat"] })).toBe(true);
    expect(hasReadCapability({ capabilities: ["retrieve"] })).toBe(true);
    expect(hasReadCapability({ capabilities: ["chat", "retrieve", "generate"] })).toBe(true);
    expect(hasReadCapability({ capabilities: ["generate"] })).toBe(false);
    expect(hasReadCapability({ capabilities: [] })).toBe(false);
    expect(hasReadCapability({ capabilities: null })).toBe(false);
  });

  it("tells a uuid from a stable ref", () => {
    expect(isUuid("3f2504e0-4f89-11d3-9a0c-0305e82c3301")).toBe(true);
    expect(isUuid("MG-001")).toBe(false);
    expect(isUuid("BR-SAL-003")).toBe(false);
  });
});
