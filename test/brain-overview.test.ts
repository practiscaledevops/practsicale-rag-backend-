import { describe, it, expect } from "vitest";
import {
  aggregateObjects,
  lifecycleFunnel,
  summarizeQueries,
  healthChecklist,
  REQUIRED_PROMPTS,
  STALE_DAYS,
  type ObjectRowLite,
  type LearningRowLite,
} from "@/lib/brain-overview";

const NOW = new Date("2026-09-21T00:00:00Z");
const daysAgo = (d: number) => new Date(NOW.getTime() - d * 86_400_000).toISOString();

function obj(over: Partial<ObjectRowLite> = {}): ObjectRowLite {
  return {
    ref: "MG-001",
    name: "Source of Energy",
    intelligence_class: "playbook",
    domain: "management",
    object_type: "framework",
    authority: "B2",
    founder_endorsement: "approved",
    implementation_status: "testing",
    internal_validation: "unvalidated",
    status: "active",
    effective_from: null,
    effective_until: null,
    last_verified_at: daysAgo(10),
    updated_at: daysAgo(1),
    ...over,
  };
}

describe("aggregateObjects", () => {
  it("returns zeros for every class and authority level on an empty Brain", () => {
    const a = aggregateObjects([], { now: NOW });
    expect(a.total).toBe(0);
    expect(Object.keys(a.byClass)).toHaveLength(6);
    expect(Object.values(a.byClass).every((v) => v === 0)).toBe(true);
    expect(a.authority.map((x) => x.id)).toEqual(["A1", "A2", "A3", "A4", "A5", "B1", "B2", "B3", "C1", "C2", "C3"]);
    expect(a.authority.every((x) => x.count === 0)).toBe(true);
    expect(a.byDomain).toEqual([]);
    expect(a.needsVerification).toEqual({ count: 0, examples: [] });
    expect(a.newest).toEqual([]);
    expect(a.capped).toBe(false);
  });

  it("counts classes, domains, types, authority and governance", () => {
    const rows = [
      obj(),
      obj({ ref: "MG-002", name: "Delegation", founder_endorsement: "practiscale_standard", authority: "B1", internal_validation: "validated", implementation_status: "implemented" }),
      obj({ ref: "BR-CO-001", name: "Pricing", intelligence_class: "business_reality", domain: "company", object_type: "pricing", authority: "A1", founder_endorsement: null }),
      obj({ ref: "SAL-001", name: "Discovery", domain: "sales", object_type: "script", authority: "B3", founder_endorsement: "interested" }),
    ];
    const a = aggregateObjects(rows, { now: NOW, total: 4 });
    expect(a.total).toBe(4);
    expect(a.byClass.playbook).toBe(3);
    expect(a.byClass.business_reality).toBe(1);
    expect(a.byClass.organizational_learning).toBe(0);
    // Domains sorted by count desc, then label.
    expect(a.byDomain[0]).toEqual({ id: "management", label: "Management", count: 2 });
    expect(a.byDomain.map((d) => d.id)).toEqual(["management", "company", "sales"]);
    expect(a.byType.find((t) => t.id === "framework")?.count).toBe(2);
    expect(a.byType.find((t) => t.id === "pricing")?.label).toBe("Pricing");
    expect(a.authority.find((x) => x.id === "A1")?.count).toBe(1);
    expect(a.authority.find((x) => x.id === "B2")?.count).toBe(1);
    expect(a.endorsement).toEqual({ interested: 1, approved: 1, practiscale_standard: 1, none: 1 });
    expect(a.implementation).toMatchObject({ testing: 3, implemented: 1, not_tested: 0 });
    expect(a.validation).toMatchObject({ unvalidated: 3, validated: 1 });
    expect(a.topDomainsByClass.playbook.map((d) => d.id)).toEqual(["management", "sales"]);
    expect(a.topDomainsByClass.business_reality[0].id).toBe("company");
  });

  it("splits currency into current / expired / historical and flags stale objects", () => {
    const rows = [
      obj({ ref: "A-1", name: "Current" }),
      obj({ ref: "A-2", name: "Expired", effective_until: daysAgo(3) }),
      obj({ ref: "A-3", name: "Future", effective_from: daysAgo(-3) }),
      obj({ ref: "A-4", name: "Old", status: "historical", last_verified_at: null }),
      obj({ ref: "A-5", name: "Gone", status: "archived", last_verified_at: null }),
      obj({ ref: "A-6", name: "Never verified", last_verified_at: null }),
      obj({ ref: "A-7", name: "Verified long ago", last_verified_at: daysAgo(STALE_DAYS + 1) }),
      obj({ ref: "A-8", name: "Verified recently", last_verified_at: daysAgo(STALE_DAYS - 1) }),
    ];
    const a = aggregateObjects(rows, { now: NOW });
    expect(a.currency).toEqual({ current: 4, expired: 2, historical: 2 });
    // Historical / archived objects never count as stale; null or >90d do.
    expect(a.needsVerification.count).toBe(2);
    expect(a.needsVerification.examples.map((e) => e.ref)).toEqual(["A-6", "A-7"]);
    expect(a.needsVerification.examples[0].lastVerifiedAt).toBeNull();
    expect(a.byStatus).toEqual({ active: 6, historical: 1, archived: 1 });
  });

  it("keeps at most five stale examples and the five newest objects", () => {
    const rows = Array.from({ length: 8 }, (_, i) => obj({ ref: `X-${i}`, name: `Obj ${i}`, last_verified_at: null, updated_at: daysAgo(i) }));
    const a = aggregateObjects(rows, { now: NOW });
    expect(a.needsVerification.count).toBe(8);
    expect(a.needsVerification.examples).toHaveLength(5);
    expect(a.newest.map((o) => o.ref)).toEqual(["X-0", "X-1", "X-2", "X-3", "X-4"]);
    expect(a.newest[0]).toMatchObject({ intelligence_class: "playbook", updated_at: daysAgo(0) });
  });

  it("marks the aggregation as capped when the total exceeds the sampled rows", () => {
    const rows = Array.from({ length: 5000 }, (_, i) => obj({ ref: `X-${i}` }));
    expect(aggregateObjects(rows, { now: NOW, total: 5000 }).capped).toBe(false);
    expect(aggregateObjects(rows, { now: NOW, total: 5001 }).capped).toBe(true);
  });
});

describe("lifecycleFunnel", () => {
  it("returns every stage in lifecycle order with zero counts when empty", () => {
    const f = lifecycleFunnel([]);
    expect(f.total).toBe(0);
    expect(f.funnel.map((s) => s.id)).toEqual(["decision", "implementation", "experiment", "result", "learning", "adaptation", "standard", "postmortem"]);
    expect(f.funnel.every((s) => s.count === 0)).toBe(true);
    expect(f.open).toBe(0);
    expect(f.pendingFollowUps).toBe(0);
  });

  it("counts stages, statuses, open work and follow-ups missing evidence", () => {
    const rows: LearningRowLite[] = [
      { record_type: "decision", lifecycle_status: "completed" },
      { record_type: "experiment", lifecycle_status: "measuring", missing_evidence: ["show-up rate after 30 days"] },
      { record_type: "experiment", lifecycle_status: "open", missing_evidence: [] },
      { record_type: "result", lifecycle_status: "validated" },
      { record_type: "learning", lifecycle_status: "implementing", missing_evidence: ["before metric"] },
      { record_type: "learning", lifecycle_status: "rejected", missing_evidence: ["anything"] },
      { record_type: "standard", lifecycle_status: null },
    ];
    const f = lifecycleFunnel(rows);
    expect(f.total).toBe(7);
    expect(f.funnel.find((s) => s.id === "experiment")?.count).toBe(2);
    expect(f.funnel.find((s) => s.id === "standard")).toEqual({ id: "standard", label: "PractiScale Standard", count: 1 });
    expect(f.byStatus).toEqual({ completed: 1, measuring: 1, open: 2, validated: 1, implementing: 1, rejected: 1 });
    // open / implementing / measuring (a null status defaults to open).
    expect(f.open).toBe(4);
    // Only OPEN records with missing evidence are follow-ups (the rejected one is not).
    expect(f.pendingFollowUps).toBe(2);
  });
});

describe("summarizeQueries", () => {
  it("computes refusals, grounded rate, top modes and average latency", () => {
    const r = summarizeQueries(
      [
        { mode: "sales_coach", grounded: true, refused: false },
        { mode: "sales_coach", grounded: false, refused: false },
        { mode: "ceo_advisor", grounded: true, refused: false },
        { mode: "sales", grounded: null, refused: true }, // legacy alias → Sales Coach
        { mode: null, grounded: true, refused: false }, // no mode logged → auto
      ],
      [1200, 800, Number.NaN, -5]
    );
    expect(r.days).toBe(7);
    expect(r.queries).toBe(5);
    expect(r.refusals).toBe(1);
    expect(r.groundedRate).toBeCloseTo(3 / 4);
    expect(r.byMode[0]).toEqual({ id: "sales_coach", label: "Sales Coach", count: 2 });
    expect(r.byMode.find((m) => m.id === "sales")?.label).toBe("Sales Coach");
    expect(r.byMode.find((m) => m.id === "auto")?.label).toBe("Auto");
    expect(r.avgLatencyMs).toBe(1000);
    expect(r.answersWithLatency).toBe(2);
  });

  it("handles an empty week", () => {
    const r = summarizeQueries([], []);
    expect(r).toMatchObject({ queries: 0, refusals: 0, groundedRate: null, byMode: [], avgLatencyMs: null, answersWithLatency: 0 });
  });
});

describe("healthChecklist", () => {
  const healthy = {
    migration: true,
    objectsTotal: 42,
    promptsMissing: [],
    pendingTaxonomy: 0,
    pendingRelationships: 0,
    pendingFollowUps: 0,
    staleObjects: 0,
    orchestrator: true,
    openaiKey: true,
    anthropicKey: true,
  };

  it("is all green for a healthy Brain and never carries a fix on a green row", () => {
    const rows = healthChecklist(healthy);
    expect(rows).toHaveLength(10);
    expect(rows.every((r) => r.status === "ok")).toBe(true);
    expect(rows.every((r) => r.fix === undefined)).toBe(true);
    expect(rows.map((r) => r.id)).toEqual(["migration", "prompts", "objects", "taxonomy", "relationships", "followups", "stale", "orchestrator", "openai", "anthropic"]);
  });

  it("turns rows amber with a fix action when something needs attention", () => {
    const rows = healthChecklist({
      migration: false,
      objectsTotal: null,
      promptsMissing: null,
      pendingTaxonomy: 3,
      pendingRelationships: 1,
      pendingFollowUps: 2,
      staleObjects: 7,
      orchestrator: false,
      openaiKey: false,
      anthropicKey: false,
    });
    expect(rows.every((r) => r.status === "warn")).toBe(true);
    expect(rows.every((r) => r.fix && r.fix.href.startsWith("/dashboard"))).toBe(true);
    const by = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(by.migration.detail).toContain("0017");
    // Unknown prompt state (pre-migration) reports every required prompt as missing.
    for (const p of REQUIRED_PROMPTS) expect(by.prompts.detail).toContain(p);
    expect(by.prompts.fix?.href).toBe("/dashboard/prompts");
    expect(by.objects.fix?.href).toBe("/dashboard/knowledge/add");
    expect(by.taxonomy.detail).toContain("3 proposed values");
    expect(by.relationships.detail).toContain("1 suggested link ");
    expect(by.followups.fix?.href).toBe("/dashboard/learning");
    expect(by.stale.detail).toContain("7 objects");
    expect(by.orchestrator.fix?.href).toBe("/dashboard/settings");
    expect(by.openai.fix?.href).toBe("/dashboard/settings");
  });

  it("lists only the prompts that are actually missing", () => {
    const rows = healthChecklist({ ...healthy, promptsMissing: ["dedup_judge"] });
    const prompts = rows.find((r) => r.id === "prompts")!;
    expect(prompts.status).toBe("warn");
    expect(prompts.detail).toContain("dedup_judge");
    expect(prompts.detail).not.toContain("intent_classify");
  });
});
