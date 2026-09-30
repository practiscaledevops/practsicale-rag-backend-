import { describe, it, expect } from "vitest";
import {
  PERMISSION_CATALOGUE,
  GRANTABLE_PERMISSIONS,
  NAV_PERMISSIONS,
  PRESETS,
  presetById,
  hasAction,
  can,
  canRead,
  canWrite,
  canDelete,
  canAccessRoute,
  navItemsFor,
  sanitizePermissions,
  clampToGranter,
  type PermissionSubject,
} from "@/lib/auth/permissions";

// The catalogue is the single source of truth for the Brain's RBAC. These tests
// pin the non-negotiable rules: read is implied by any write-like action, the
// grant surface is exactly the catalogue (data_sources has NO delete), presets
// (esp. the Knowledge uploader that saleh gets) grant no destructive actions, and
// a non-super-admin can never grant a permission they don't hold.

const admin = (permissions: Record<string, string[]>): PermissionSubject => ({ role: "admin", permissions });
const SUPER: PermissionSubject = { role: "super_admin", permissions: {} };

describe("hasAction — read implied by write-like actions", () => {
  it("grants the exact action held", () => {
    expect(hasAction({ documents: ["write"] }, "documents", "write")).toBe(true);
    expect(hasAction({ documents: ["read"] }, "documents", "read")).toBe(true);
  });

  it("implies read from write / delete / revoke", () => {
    expect(hasAction({ documents: ["write"] }, "documents", "read")).toBe(true);
    expect(hasAction({ documents: ["delete"] }, "documents", "read")).toBe(true);
    expect(hasAction({ api_keys: ["revoke"] }, "api_keys", "read")).toBe(true);
  });

  it("never implies write or delete from read", () => {
    expect(hasAction({ documents: ["read"] }, "documents", "write")).toBe(false);
    expect(hasAction({ documents: ["read"] }, "documents", "delete")).toBe(false);
    expect(hasAction({ documents: ["read", "write"] }, "documents", "delete")).toBe(false);
  });

  it("is false for an ungranted resource or an empty map", () => {
    expect(hasAction({}, "documents", "read")).toBe(false);
    expect(hasAction({ collections: ["read"] }, "documents", "read")).toBe(false);
  });
});

describe("can / canRead / canWrite / canDelete", () => {
  it("super_admin bypasses everything", () => {
    expect(can(SUPER, "settings:write")).toBe(true);
    expect(canDelete(SUPER, "documents")).toBe(true);
    expect(canAccessRoute(SUPER, "/dashboard/admins")).toBe(true);
  });

  it("defaults a bare key to read", () => {
    expect(can(admin({ analytics: ["read"] }), "analytics")).toBe(true);
  });

  it("reflects read-implied for a writer", () => {
    const s = admin({ documents: ["write"] });
    expect(canRead(s, "documents")).toBe(true);
    expect(canWrite(s, "documents")).toBe(true);
    expect(canDelete(s, "documents")).toBe(false);
  });
});

describe("canAccessRoute + navItemsFor", () => {
  const uploader = admin(presetById("knowledge_uploader")!.permissions);

  it("always shows the overview home", () => {
    expect(canAccessRoute(admin({}), "/dashboard")).toBe(true);
  });

  it("lets the Knowledge uploader reach knowledge, uploads, collections, sources and analytics", () => {
    for (const href of [
      "/dashboard/knowledge",
      "/dashboard/documents",
      "/dashboard/knowledge/add",
      "/dashboard/uploads",
      "/dashboard/collections",
      "/dashboard/sources",
      "/dashboard/analytics",
      "/dashboard/entities",
    ]) {
      expect(canAccessRoute(uploader, href), href).toBe(true);
    }
  });

  it("hides prompts, keys, connectors, admins and settings from the uploader", () => {
    for (const href of [
      "/dashboard/prompts",
      "/dashboard/keys",
      "/dashboard/connectors",
      "/dashboard/admins",
      "/dashboard/settings",
      "/dashboard/model-policy",
      "/dashboard/retrieval-policy",
    ]) {
      expect(canAccessRoute(uploader, href), href).toBe(false);
    }
  });

  it("navItemsFor filters a list to the visible hrefs", () => {
    const items = [{ href: "/dashboard/documents" }, { href: "/dashboard/keys" }, { href: "/dashboard" }];
    expect(navItemsFor(uploader, items).map((i) => i.href)).toEqual(["/dashboard/documents", "/dashboard"]);
    expect(navItemsFor(SUPER, items)).toHaveLength(3);
  });
});

describe("grant surface (GRANTABLE_PERMISSIONS + sanitize)", () => {
  it("exposes delete on documents/collections/connectors and revoke on api_keys", () => {
    expect(GRANTABLE_PERMISSIONS.documents).toContain("delete");
    expect(GRANTABLE_PERMISSIONS.collections).toContain("delete");
    expect(GRANTABLE_PERMISSIONS.connectors).toContain("delete");
    expect(GRANTABLE_PERMISSIONS.api_keys).toContain("revoke");
  });

  it("has NO delete on data_sources or analytics", () => {
    expect(GRANTABLE_PERMISSIONS.data_sources).toEqual(["read", "write"]);
    expect(GRANTABLE_PERMISSIONS.analytics).toEqual(["read"]);
  });

  it("drops unknown resources and unknown actions", () => {
    const dirty = {
      documents: ["read", "write", "nuke"],
      data_sources: ["read", "delete"], // delete is not a data_sources action
      made_up: ["read"],
      collections: "not-an-array" as unknown as string[],
    };
    expect(sanitizePermissions(dirty)).toEqual({
      documents: ["read", "write"],
      data_sources: ["read"],
    });
  });

  it("returns {} for non-object input", () => {
    expect(sanitizePermissions(null)).toEqual({});
    expect(sanitizePermissions("x")).toEqual({});
  });

  it("every preset survives sanitize unchanged (all grants are valid)", () => {
    for (const p of PRESETS) expect(sanitizePermissions(p.permissions)).toEqual(p.permissions);
  });
});

describe("presets", () => {
  it("Knowledge uploader is saleh's grant: write on knowledge + collections, read only elsewhere, NO delete", () => {
    const p = presetById("knowledge_uploader")!;
    expect(p.permissions).toEqual({
      documents: ["read", "write"],
      collections: ["read", "write"],
      data_sources: ["read"],
      analytics: ["read"],
    });
    // No destructive action anywhere in the preset.
    const all = Object.values(p.permissions).flat();
    expect(all).not.toContain("delete");
    expect(all).not.toContain("revoke");
    // No access to the sensitive surfaces.
    for (const r of ["members", "api_keys", "settings", "prompts", "connectors"]) {
      expect(p.permissions).not.toHaveProperty(r);
    }
  });

  it("Read-only analyst has no writes at all", () => {
    const p = presetById("readonly_analyst")!;
    expect(Object.values(p.permissions).flat().every((a) => a === "read")).toBe(true);
  });

  it("Admin preset has deletes but not members/api_keys/settings", () => {
    const p = presetById("operator_admin")!;
    expect(p.permissions.documents).toContain("delete");
    for (const r of ["members", "api_keys", "settings"]) expect(p.permissions).not.toHaveProperty(r);
  });

  it("has a stable set of preset ids", () => {
    expect(PRESETS.map((p) => p.id)).toEqual([
      "knowledge_uploader",
      "content_copywriter",
      "readonly_analyst",
      "operator_admin",
    ]);
  });
});

describe("clampToGranter — no privilege escalation", () => {
  it("passes everything through for a super_admin", () => {
    const req = { documents: ["read", "write", "delete"], members: ["read", "write"] };
    expect(clampToGranter(req, SUPER)).toEqual(req);
  });

  it("drops actions the granter does not hold", () => {
    const granter = admin({ documents: ["read", "write"], members: ["read", "write"] });
    const req = { documents: ["read", "write", "delete"], connectors: ["read"] };
    // delete dropped (granter lacks it); connectors dropped entirely (not held).
    expect(clampToGranter(req, granter)).toEqual({ documents: ["read", "write"] });
  });

  it("lets a writer grant read (read is implied by their write)", () => {
    const granter = admin({ documents: ["write"] });
    expect(clampToGranter({ documents: ["read"] }, granter)).toEqual({ documents: ["read"] });
  });
});

describe("catalogue integrity", () => {
  it("every nav href maps to a known resource:action in the grant surface", () => {
    for (const [href, key] of Object.entries(NAV_PERMISSIONS)) {
      const [resource, action] = key.split(":");
      expect(GRANTABLE_PERMISSIONS[resource], `${href} → ${key}`).toBeDefined();
      expect(GRANTABLE_PERMISSIONS[resource]).toContain(action);
    }
  });

  it("every resource has a read action", () => {
    for (const r of PERMISSION_CATALOGUE) expect(r.actions.map((a) => a.id)).toContain("read");
  });
});
