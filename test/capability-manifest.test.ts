import { describe, it, expect } from "vitest";
import {
  buildCapabilityManifest,
  connectorCapabilityId,
  CAPABILITY_MANIFEST_VERSION,
  type CapabilityManifest,
} from "@/lib/capability-manifest";
import { WORK_MODE_DEFS } from "@/lib/work-modes";
import { SOURCE_TYPE_DEFS } from "@/lib/source-types";
import { MODELS } from "@/lib/models-catalog";
import { PROGRESS_LABEL } from "@/lib/ingest-adapters/pure";
import { JOB_HANDLERS } from "@/lib/jobs/handlers";
import { keyAllowsSensitive } from "@/lib/knowledge-read";

const full = buildCapabilityManifest(undefined, new Date("2026-09-25T00:00:00Z"));
const ids = (m: CapabilityManifest) => m.capabilities.map((c) => c.id);
const byId = (m: CapabilityManifest, id: string) => m.capabilities.find((c) => c.id === id);

describe("capability manifest — shape", () => {
  it("is versioned, timestamped and JSON-safe", () => {
    expect(full.version).toBe(CAPABILITY_MANIFEST_VERSION);
    expect(full.generatedAt).toBe("2026-09-25T00:00:00.000Z");
    expect(JSON.parse(JSON.stringify(full))).toEqual(full);
  });

  it("has unique, stable-looking ids", () => {
    const list = ids(full);
    expect(new Set(list).size).toBe(list.length);
    for (const id of list) expect(id).toMatch(/^[a-z][a-z0-9_]*(\.[a-z0-9_-]+)+$/);
  });

  it("keeps the documented example ids", () => {
    for (const id of ["chat.knowledge", "modes.ceo_advisor", "data.call_score", "jobs.deep_audit", "learning.write", "knowledge.map", "extract.audio"]) {
      expect(ids(full)).toContain(id);
    }
  });

  it("every capability belongs to a listed group, and every listed group is used", () => {
    const groups = new Set(full.groups.map((g) => g.id));
    expect(groups.size).toBe(full.groups.length);
    for (const c of full.capabilities) expect(groups.has(c.group)).toBe(true);
    for (const g of full.groups) expect(full.capabilities.some((c) => c.group === g.id)).toBe(true);
  });

  it("labels and descriptions are present and one line", () => {
    for (const c of full.capabilities) {
      expect(c.label.trim().length).toBeGreaterThan(0);
      expect(c.description.trim().length).toBeGreaterThan(0);
      expect(c.description).not.toMatch(/\n/);
    }
  });

  it("requires only point at capabilities that exist, with no cycles", () => {
    const all = new Set(ids(full));
    const req = new Map(full.capabilities.map((c) => [c.id, c.requires ?? []]));
    for (const [id, rs] of req) {
      for (const r of rs) {
        expect(all.has(r), `${id} requires missing ${r}`).toBe(true);
        expect(r).not.toBe(id);
      }
    }
    const visiting = new Set<string>();
    const done = new Set<string>();
    const visit = (id: string) => {
      if (done.has(id)) return;
      expect(visiting.has(id), `cycle through ${id}`).toBe(false);
      visiting.add(id);
      for (const r of req.get(id) ?? []) visit(r);
      visiting.delete(id);
      done.add(id);
    };
    for (const id of all) visit(id);
  });
});

describe("capability manifest — built from the registries", () => {
  it("lists every work mode except the Auto router", () => {
    for (const m of WORK_MODE_DEFS) {
      const c = byId(full, `modes.${m.id}`);
      if (m.id === "auto") {
        expect(c).toBeUndefined();
        continue;
      }
      expect(c, m.id).toBeDefined();
      expect(c!.kind).toBe("mode");
      expect(c!.label).toBe(m.label);
    }
  });

  it("restricted (executive) modes are sensitive and off for members", () => {
    for (const m of WORK_MODE_DEFS.filter((d) => d.restricted)) {
      const c = byId(full, `modes.${m.id}`)!;
      expect(c.sensitive).toBe(true);
      expect(c.defaultForMembers).toBe(false);
      expect(c.defaultForAdmins).toBe(true);
    }
    expect(byId(full, "modes.sales_coach")!.defaultForMembers).toBe(true);
  });

  it("lists every source type with its sensitivity", () => {
    for (const s of SOURCE_TYPE_DEFS) {
      const c = byId(full, `data.${s.id}`);
      expect(c, s.id).toBeDefined();
      expect(c!.kind).toBe("source_type");
      expect(Boolean(c!.sensitive)).toBe(s.sensitive);
    }
    // The call material is sensitive; general company knowledge is not.
    for (const id of ["data.call_score", "data.transcript", "data.coaching"]) expect(byId(full, id)!.sensitive).toBe(true);
    expect(byId(full, "data.document")!.sensitive).toBeFalsy();
  });

  it("the source-type registry agrees with the Brain map's key sensitivity rule", () => {
    for (const s of SOURCE_TYPE_DEFS) {
      expect(keyAllowsSensitive({ source_types: [s.id] }), s.id).toBe(s.sensitive);
    }
  });

  it("lists every job type, extraction kind and model tier", () => {
    expect(ids(full).filter((id) => id.startsWith("jobs.")).length).toBe(Object.keys(JOB_HANDLERS).length);
    for (const kind of Object.keys(PROGRESS_LABEL)) expect(ids(full)).toContain(`extract.${kind}`);
    for (const t of new Set(MODELS.map((m) => m.tier).filter(Boolean))) expect(ids(full)).toContain(`models.${t}`);
    expect(byId(full, "models.smart_route")!.requires).toEqual(["models.fast", "models.recommended", "models.max"]);
  });
});

describe("capability manifest — defaults", () => {
  it("sensitive capabilities are never on for members by default", () => {
    for (const c of full.capabilities.filter((x) => x.sensitive)) {
      expect(c.defaultForMembers, c.id).toBe(false);
    }
  });

  it("admins never get less than members", () => {
    for (const c of full.capabilities) {
      if (c.defaultForMembers) expect(c.defaultForAdmins, c.id).toBe(true);
    }
  });

  it("a member's default set is self-consistent (every prerequisite also on)", () => {
    const on = new Set(full.capabilities.filter((c) => c.defaultForMembers).map((c) => c.id));
    for (const id of on) {
      for (const r of byId(full, id)!.requires ?? []) expect(on.has(r), `${id} needs ${r}`).toBe(true);
    }
    expect(on.has("chat.knowledge")).toBe(true);
    expect(on.has("data.document")).toBe(true);
    expect(on.has("jobs.deep_audit")).toBe(false);
    expect(on.has("chat.call_review")).toBe(false);
    expect(on.has("knowledge.performance")).toBe(false);
  });
});

describe("capability manifest — filtered to the calling key", () => {
  it("a full-scope chat+retrieve key sees everything the Brain offers", () => {
    const m = buildCapabilityManifest({ capabilities: ["chat", "retrieve"], sourceTypes: [] });
    expect(ids(m)).toEqual(ids(full));
  });

  it("a retrieve-only key is not offered chat features", () => {
    const m = buildCapabilityManifest({ capabilities: ["retrieve"], sourceTypes: [] });
    expect(ids(m)).toContain("knowledge.map");
    expect(ids(m)).toContain("learning.read");
    expect(ids(m)).toContain("data.document");
    for (const id of ids(m)) {
      expect(id.startsWith("chat.") || id.startsWith("modes.") || id.startsWith("jobs.") || id.startsWith("extract.")).toBe(false);
    }
    expect(ids(m)).not.toContain("learning.write");
  });

  it("a key without call material in scope is never offered it", () => {
    const m = buildCapabilityManifest({ capabilities: ["chat"], sourceTypes: ["document"] });
    expect(ids(m)).toContain("data.document");
    for (const id of ["data.call_score", "data.transcript", "data.coaching", "chat.call_review", "jobs.deep_audit", "knowledge.performance"]) {
      expect(ids(m)).not.toContain(id);
    }
    // Nothing left behind with a missing prerequisite.
    const present = new Set(ids(m));
    for (const c of m.capabilities) for (const r of c.requires ?? []) expect(present.has(r)).toBe(true);
  });

  it("call reviews need an un-narrowed key; deep audits only need transcripts", () => {
    const m = buildCapabilityManifest({ capabilities: ["chat"], sourceTypes: [], collectionIds: ["c1"] });
    expect(ids(m)).not.toContain("chat.call_review");
    expect(ids(m)).toContain("jobs.deep_audit");
  });

  it("lists the connectors granted to the key, with sanitized ids", () => {
    const m = buildCapabilityManifest({
      capabilities: ["chat"],
      sourceTypes: [],
      connectors: [
        { slug: "higgsfield", name: "Higgsfield", kind: "http_api" },
        { slug: "Team Drive!", name: "Team drive", kind: "mcp" },
      ],
    });
    expect(connectorCapabilityId("Team Drive!")).toBe("tools.connector.team_drive");
    const hf = byId(m, "tools.connector.higgsfield")!;
    expect(hf.kind).toBe("tool");
    expect(hf.requires).toEqual(["tools.connectors"]);
    expect(byId(m, "tools.connector.team_drive")!.label).toBe("Team drive");
    // Without grants, only the umbrella capability is offered.
    expect(ids(full).filter((id) => id.startsWith("tools.connector."))).toEqual([]);
  });

  it("a key with no capabilities gets an empty manifest", () => {
    const m = buildCapabilityManifest({ capabilities: [], sourceTypes: [] });
    expect(m.capabilities).toEqual([]);
    expect(m.groups).toEqual([]);
  });
});
