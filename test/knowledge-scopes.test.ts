import { describe, it, expect } from "vitest";
import {
  KNOWLEDGE_SCOPE_DEFS,
  KNOWLEDGE_SCOPE_IDS,
  DEFAULT_KNOWLEDGE_SCOPE,
  CALL_SOURCE_TYPES,
  isKnowledgeScope,
  knowledgeScopeDef,
  planLaneWeights,
  scopeReachableByKey,
  scopesForKey,
  scopeUnavailableMessage,
} from "@/lib/knowledge-scopes";
import { LANES, effectivePolicy, type Lane } from "@/lib/work-modes";
import { SOURCE_TYPE_DEFS, SOURCE_TYPE_IDS } from "@/lib/source-types";
import { keyAllowsSensitive } from "@/lib/knowledge-read";
import { narrowSourceTypes, matchesNoSourceType, type ScopeFilters } from "@/lib/auth/scope";

const lanes = (reality: number, learning: number, playbook: number, platform: number, performance: number): Record<Lane, number> => ({
  reality,
  learning,
  playbook,
  platform,
  performance,
});

describe("knowledge scope catalogue", () => {
  it("has the owner's scopes, in picker order, Auto first and default", () => {
    expect(KNOWLEDGE_SCOPE_IDS).toEqual(["auto", "all", "reality", "playbook", "learning", "calls"]);
    expect(DEFAULT_KNOWLEDGE_SCOPE).toBe("auto");
    expect(KNOWLEDGE_SCOPE_DEFS.map((s) => s.label)).toEqual(["Auto", "All Brain", "Reality", "Playbooks", "Learnings", "Consultant calls"]);
  });

  it("ids are unique and safe (a spoke's future-id pattern accepts them)", () => {
    expect(new Set(KNOWLEDGE_SCOPE_IDS).size).toBe(KNOWLEDGE_SCOPE_IDS.length);
    for (const id of KNOWLEDGE_SCOPE_IDS) expect(id).toMatch(/^[a-z_]{1,32}$/);
  });

  it("every scope has a one-line label and description", () => {
    for (const s of KNOWLEDGE_SCOPE_DEFS) {
      expect(s.label.trim().length, s.id).toBeGreaterThan(0);
      expect(s.description.trim().length, s.id).toBeGreaterThan(10);
      expect(s.description.length, s.id).toBeLessThanOrEqual(100);
      expect(s.description, s.id).not.toMatch(/\n/);
    }
  });

  it("fixed lanes name real search lanes with weights in [0,1]", () => {
    for (const s of KNOWLEDGE_SCOPE_DEFS) {
      if (!s.retrieval.lanes) continue;
      const entries = Object.entries(s.retrieval.lanes);
      expect(entries.length, s.id).toBeGreaterThan(0);
      for (const [lane, w] of entries) {
        expect(LANES.includes(lane as Lane) && lane !== "performance", `${s.id}.${lane}`).toBe(true);
        expect(w).toBeGreaterThan(0);
        expect(w).toBeLessThanOrEqual(1);
      }
    }
  });

  it("source-type restrictions use real source types; sensitive = restricted to sensitive call material", () => {
    expect(CALL_SOURCE_TYPES).toEqual(["call_score", "transcript"]);
    for (const s of KNOWLEDGE_SCOPE_DEFS) {
      const st = s.retrieval.sourceTypes ?? [];
      for (const t of st) expect(SOURCE_TYPE_IDS, `${s.id}: ${t}`).toContain(t);
      const allSensitive = st.length > 0 && st.every((t) => SOURCE_TYPE_DEFS.find((d) => d.id === t)?.sensitive);
      expect(s.sensitive, s.id).toBe(allSensitive);
    }
    const calls = knowledgeScopeDef("calls");
    expect(calls.sensitive).toBe(true);
    expect(calls.retrieval.sourceTypes).toEqual(CALL_SOURCE_TYPES);
  });

  it("unknown / missing ids fall back to Auto", () => {
    expect(isKnowledgeScope("playbook")).toBe(true);
    expect(isKnowledgeScope("everything")).toBe(false);
    expect(isKnowledgeScope(undefined)).toBe(false);
    expect(knowledgeScopeDef("nope").id).toBe("auto");
    expect(knowledgeScopeDef(null).id).toBe("auto");
    expect(knowledgeScopeDef(42).id).toBe("auto");
  });

  it("says plainly when the calls scope has no data for the caller", () => {
    expect(scopeUnavailableMessage(knowledgeScopeDef("calls"))).toMatch(/no consultant call data is available to you/i);
    expect(scopeUnavailableMessage(knowledgeScopeDef("reality"))).toMatch(/Reality/);
  });
});

describe("scopes advertised to a key", () => {
  const ids = (st: string[] | null) => scopesForKey({ source_types: st }).map((s) => s.id);

  it("an unrestricted key sees every scope, calls included", () => {
    expect(ids([])).toEqual(["auto", "all", "reality", "playbook", "learning", "calls"]);
    expect(ids(null)).toContain("calls");
  });

  it("calls only when the key can reach call_score or transcript", () => {
    expect(ids(["document"])).toEqual(["auto", "all", "reality", "playbook", "learning"]);
    expect(ids(["document", "transcript"])).toContain("calls");
    expect(ids(["call_score"])).toContain("calls");
    // Coaching notes are sensitive but are not the call data this scope searches.
    expect(ids(["coaching"])).not.toContain("calls");
  });

  it("agrees with keyAllowsSensitive for the call source types", () => {
    const calls = knowledgeScopeDef("calls");
    for (const st of [[], ["document"], ["call_score"], ["transcript"], ["document", "call_score"]]) {
      expect(scopeReachableByKey(calls, st), st.join(",")).toBe(keyAllowsSensitive({ source_types: st }));
    }
  });

  it("returns only the public projection", () => {
    const s = scopesForKey({ source_types: [] }).find((x) => x.id === "calls")!;
    expect(Object.keys(s).sort()).toEqual(["description", "id", "label", "sensitive"]);
    expect(s.sensitive).toBe(true);
  });
});

describe("planLaneWeights", () => {
  const general = effectivePolicy("general");
  const analyst = effectivePolicy("research_analyst");
  const intent = (over: Partial<{ lanes: Record<Lane, number>; intentKind: "create" | "advise" | "build" | "analyze" | "lookup"; needsNumbers: boolean }> = {}) => ({
    lanes: lanes(1, 0.6, 0.6, 0.2, 0.4),
    intentKind: "advise" as const,
    needsNumbers: false,
    ...over,
  });

  it("auto = policy × intent (sqrt), reality floored at 0.5 — today's behaviour", () => {
    const i = intent({ lanes: lanes(0.1, 0.9, 0.4, 0, 0.1) });
    const p = planLaneWeights("auto", general, i);
    for (const l of LANES) {
      const expected = Math.max(0, Math.min(1, Math.sqrt(general.lanes[l] * i.lanes[l])));
      expect(p.weights[l], l).toBeCloseTo(l === "reality" ? Math.max(expected, 0.5) : expected, 10);
    }
    expect(p.weights.reality).toBe(0.5);
    expect(p.active).toEqual(LANES.filter((l) => l !== "performance" && p.weights[l] >= 0.15));
    expect(p.active).not.toContain("platform");
    expect(p.restrictToActive).toBe(false);
    expect(p.callReview).toBe("gated");
    // performance weight sqrt(0.4 × 0.1) = 0.2 < 0.3 and no numbers → no block.
    expect(p.wantsPerformance).toBe(false);
    expect(planLaneWeights("auto", general, { ...i, needsNumbers: true }).wantsPerformance).toBe(true);
  });

  it("auto: a missing intent weight counts as 0.5; undefined / unknown scope = auto", () => {
    const partial = { lanes: { reality: 1 } as Partial<Record<Lane, number>>, intentKind: "advise" as const, needsNumbers: false };
    const p = planLaneWeights(undefined, general, partial);
    expect(p.weights.learning).toBeCloseTo(Math.sqrt(0.6 * 0.5), 10);
    expect(planLaneWeights("bogus", general, intent())).toEqual(planLaneWeights("auto", general, intent()));
  });

  it("auto: raw archive only for an analyst policy on an analyze ask", () => {
    expect(planLaneWeights("auto", analyst, intent({ intentKind: "analyze" })).includeRaw).toBe(true);
    expect(planLaneWeights("auto", analyst, intent({ intentKind: "advise" })).includeRaw).toBe(false);
    expect(planLaneWeights("auto", general, intent({ intentKind: "analyze" })).includeRaw).toBe(false);
  });

  it("all: every search lane at full weight, raw archive on, performance per the usual rule", () => {
    const i = intent({ lanes: lanes(0.2, 0, 0, 0, 1) });
    const p = planLaneWeights("all", general, i);
    expect(p.weights).toMatchObject({ reality: 1, learning: 1, playbook: 1, platform: 1 });
    expect(p.weights.performance).toBeCloseTo(Math.sqrt(general.lanes.performance * 1), 10);
    expect(p.active).toEqual(["reality", "learning", "playbook", "platform"]);
    expect(p.includeRaw).toBe(true);
    expect(p.wantsPerformance).toBe(true); // sqrt(0.4) ≈ 0.63 ≥ 0.3
    expect(p.callReview).toBe("gated");
    expect(p.restrictToActive).toBe(true);
  });

  it("reality: Business Reality only + raw archive; numbers only when asked; call review gated", () => {
    const p = planLaneWeights("reality", general, intent({ lanes: lanes(0, 1, 1, 1, 1) }));
    expect(p.weights).toEqual(lanes(1, 0, 0, 0, 0));
    expect(p.active).toEqual(["reality"]);
    expect(p.includeRaw).toBe(true);
    expect(p.wantsPerformance).toBe(false);
    expect(planLaneWeights("reality", general, intent({ needsNumbers: true })).wantsPerformance).toBe(true);
    expect(p.callReview).toBe("gated");
  });

  it("playbook: Playbooks only — no reality floor, no raw, no numbers, no call review", () => {
    const p = planLaneWeights("playbook", analyst, intent({ intentKind: "analyze", needsNumbers: true }));
    expect(p.weights).toEqual(lanes(0, 0, 1, 0, 0));
    expect(p.active).toEqual(["playbook"]);
    expect(p.includeRaw).toBe(false);
    expect(p.wantsPerformance).toBe(false);
    expect(p.callReview).toBe("off");
    expect(p.restrictToActive).toBe(true);
  });

  it("learning: Organizational Learning only — no reality floor, no raw, no numbers, no call review", () => {
    const p = planLaneWeights("learning", analyst, intent({ intentKind: "analyze", needsNumbers: true }));
    expect(p.weights).toEqual(lanes(0, 1, 0, 0, 0));
    expect(p.active).toEqual(["learning"]);
    expect(p.includeRaw).toBe(false);
    expect(p.wantsPerformance).toBe(false);
    expect(p.callReview).toBe("off");
  });

  it("calls: the lane the call documents live in, review path forced, nothing else", () => {
    const p = planLaneWeights("calls", general, intent({ needsNumbers: true }));
    expect(p.weights).toEqual(lanes(1, 0, 0, 0, 0));
    expect(p.active).toEqual(["reality"]);
    expect(p.includeRaw).toBe(false);
    expect(p.wantsPerformance).toBe(false);
    expect(p.callReview).toBe("forced");
  });
});

describe("source-type narrowing by a knowledge scope", () => {
  const scope = (sourceTypes: string[]): ScopeFilters => ({ sourceTypes, dataSourceIds: [], collectionIds: [] });

  it("restricts an unrestricted key to the scope's types", () => {
    expect(narrowSourceTypes(scope([]), CALL_SOURCE_TYPES).sourceTypes).toEqual(["call_score", "transcript"]);
  });

  it("intersects with a restricted key — never widens", () => {
    expect(narrowSourceTypes(scope(["document", "call_score"]), CALL_SOURCE_TYPES).sourceTypes).toEqual(["call_score"]);
    const none = narrowSourceTypes(scope(["document"]), CALL_SOURCE_TYPES);
    expect(none.sourceTypes).not.toEqual([]);
    expect(matchesNoSourceType(none)).toBe(true);
    // Already narrowed to nothing (a spoke user without data) stays nothing.
    expect(matchesNoSourceType(narrowSourceTypes(scope(["__none__"]), CALL_SOURCE_TYPES))).toBe(true);
  });

  it("no restriction leaves the scope unchanged", () => {
    const s = scope(["document"]);
    expect(narrowSourceTypes(s, undefined)).toBe(s);
    expect(narrowSourceTypes(s, [])).toBe(s);
    expect(matchesNoSourceType(scope([]))).toBe(false);
    expect(matchesNoSourceType(scope(["document"]))).toBe(false);
  });
});
