import { describe, it, expect } from "vitest";
import { scoreCandidate, heuristicIntent, buildLaneContext, type ObjectMeta, type OrchestratedChunk } from "@/lib/orchestrator";
import { effectivePolicy } from "@/lib/work-modes";

const policy = effectivePolicy("management_coach", ["management"]);
const intent = { primaryDomain: "management", relatedDomains: ["talent_hiring"], timeScope: "any" as const };

function meta(over: Partial<ObjectMeta> = {}): ObjectMeta {
  return {
    ref: "MG-001",
    name: "Source of Energy",
    intelligence_class: "playbook",
    domain: "management",
    object_type: "framework",
    subtype: "accountability",
    authority: "B3",
    founder_endorsement: "interested",
    internal_validation: "unvalidated",
    priority: "normal",
    status: "active",
    effective_from: null,
    effective_until: null,
    current: true,
    ...over,
  };
}

describe("orchestrator scoring (soft metadata boosts)", () => {
  it("rank drives relevance; metadata only nudges", () => {
    const a = scoreCandidate({ rank: 1, laneWeight: 1, lane: "playbook", chunkDomain: "management", object: meta(), policy, intent, via: "search" });
    const b = scoreCandidate({ rank: 5, laneWeight: 1, lane: "playbook", chunkDomain: "management", object: meta(), policy, intent, via: "search" });
    expect(a.finalScore).toBeGreaterThan(b.finalScore);
    // A strong endorsement + authority cannot flip a rank-1 vs rank-2 ordering by itself…
    const standard = scoreCandidate({ rank: 2, laneWeight: 1, lane: "playbook", chunkDomain: "management", object: meta({ founder_endorsement: "practiscale_standard", authority: "B1", internal_validation: "validated" }), policy, intent, via: "search" });
    expect(standard.boost).toBeGreaterThan(a.boost);
    // …but a PractiScale standard at rank 2 does outrank an "interested" external claim at rank 1 in a different domain.
    const offDomain = scoreCandidate({ rank: 1, laneWeight: 1, lane: "playbook", chunkDomain: "content", object: meta({ domain: "content" }), policy, intent, via: "search" });
    expect(standard.finalScore).toBeGreaterThan(offDomain.finalScore);
  });

  it("domain fit, endorsement, validation, authority and priority raise the boost", () => {
    const base = scoreCandidate({ rank: 3, laneWeight: 1, lane: "playbook", chunkDomain: "content", object: meta({ domain: "content" }), policy, intent, via: "search" }).boost;
    const primary = scoreCandidate({ rank: 3, laneWeight: 1, lane: "playbook", chunkDomain: "management", object: meta(), policy, intent, via: "search" }).boost;
    const related = scoreCandidate({ rank: 3, laneWeight: 1, lane: "playbook", chunkDomain: "talent_hiring", object: meta({ domain: "talent_hiring" }), policy, intent, via: "search" }).boost;
    expect(primary).toBeGreaterThan(related);
    expect(related).toBeGreaterThan(base);
    const approved = scoreCandidate({ rank: 3, laneWeight: 1, lane: "playbook", chunkDomain: "management", object: meta({ founder_endorsement: "approved" }), policy, intent, via: "search" }).boost;
    expect(approved).toBeGreaterThan(primary);
    const a1 = scoreCandidate({ rank: 3, laneWeight: 1, lane: "reality", chunkDomain: "management", object: meta({ intelligence_class: "business_reality", authority: "A1" }), policy, intent, via: "search" }).boost;
    const c1 = scoreCandidate({ rank: 3, laneWeight: 1, lane: "reality", chunkDomain: "management", object: meta({ intelligence_class: "business_reality", authority: "C1", status: "historical", current: false }), policy, intent, via: "search" }).boost;
    expect(a1).toBeGreaterThan(c1);
  });

  it("expired / historical knowledge is penalised for current asks and tolerated for historical ones", () => {
    const expiredNow = scoreCandidate({ rank: 2, laneWeight: 1, lane: "reality", chunkDomain: "company", object: meta({ intelligence_class: "business_reality", current: false }), policy, intent: { ...intent, timeScope: "current" }, via: "search" });
    const expiredHist = scoreCandidate({ rank: 2, laneWeight: 1, lane: "reality", chunkDomain: "company", object: meta({ intelligence_class: "business_reality", current: false }), policy, intent: { ...intent, timeScope: "historical" }, via: "search" });
    expect(expiredHist.boost).toBeGreaterThan(expiredNow.boost);
  });

  it("legacy chunks (no object) still score by rank + chunk domain", () => {
    const s = scoreCandidate({ rank: 1, laneWeight: 1, lane: "reality", chunkDomain: "management", object: null, policy, intent, via: "search" });
    expect(s.finalScore).toBeGreaterThan(0.05);
    expect(s.boost).toBeGreaterThan(0);
  });
});

describe("heuristic intent", () => {
  it("detects mode, numbers and time scope without a model", () => {
    const i = heuristicIntent("How did our close rate trend when we had 100 clients?");
    expect(i.via).toBe("heuristic");
    expect(i.needsNumbers).toBe(true);
    expect(i.timeScope).toBe("historical");
    expect(i.workMode).toBe("sales_coach");
    expect(i.lanes.reality).toBe(1);
  });
});

describe("lane-grouped context", () => {
  it("groups by lane with headers and labels each chunk with its object identity", () => {
    const chunk = (over: Partial<OrchestratedChunk>): OrchestratedChunk => ({
      id: "c1",
      content: "text",
      metadata: {},
      document_id: "d1",
      parent_id: null,
      source_type: "document",
      object_id: null,
      intelligence_class: "business_reality",
      domain: null,
      rrf_score: 0,
      lane: "reality",
      object: null,
      rank: 1,
      boost: 0,
      finalScore: 0.1,
      via: "search",
      ...over,
    });
    const ctx = buildLaneContext([
      chunk({ id: "r1", content: "Manager report", metadata: { title: "Task breakdown" }, source_type: "document" }),
      chunk({ id: "p1", content: "Framework text", lane: "playbook", object: meta({ founder_endorsement: "approved", authority: "B2" }) }),
      chunk({ id: "l1", content: "We tried it", lane: "learning", object: meta({ ref: "LRN-004", name: "CRM redesign", intelligence_class: "organizational_learning", object_type: "learning", authority: "A5", founder_endorsement: null }), via: "relationship", relatedTo: "MG-001" }),
    ]);
    expect(ctx.indexOf("BUSINESS REALITY")).toBeLessThan(ctx.indexOf("ORGANIZATIONAL LEARNING"));
    expect(ctx.indexOf("ORGANIZATIONAL LEARNING")).toBeLessThan(ctx.indexOf("PLAYBOOKS"));
    expect(ctx).toContain("[p1] ⟨MG-001 · Source of Energy · playbook/management/framework/accountability · authority B2 · endorsement approved · current⟩");
    expect(ctx).toContain("[l1] ⟨LRN-004 · CRM redesign");
    expect(ctx).toContain("connected via MG-001");
    expect(ctx).toContain("[r1] ⟨business reality · document · Task breakdown⟩");
  });
});
