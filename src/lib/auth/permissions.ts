// Permission catalogue — the SINGLE SOURCE OF TRUTH for the Brain's RBAC surface.
//
// One place declares every grantable resource, its actions (with which ones are
// destructive), the dashboard routes each governs, and the one-click presets.
// Everything else derives from here:
//   - members/route.ts     → GRANTABLE_PERMISSIONS + sanitizePermissions (the
//                            surface a member can be granted; drops the unknown)
//   - dashboard/admins UI  → the checkbox groups + preset picker
//   - AppShell.tsx         → nav filtering (navItemsFor / canAccessRoute)
//   - PermissionGate       → per-page "you don't have access" gating
//   - session.hasPermission→ the read-implied-by-write/delete rule (hasAction)
//
// Add a resource or an action ONCE here and it appears everywhere. Because this
// module is imported by client components (the Admins page, AppShell), it must
// stay PURE and free of server-only imports — it takes only TYPES from session.
//
// KEY RULE — "read is implied by any write-like action": holding write, delete
// (or revoke) on a resource implies read of it. So a member granted only
// documents:[write] can still open the Documents pages and hit the read GETs,
// and presets never need to list "read" beside "write" to avoid locking a member
// out. super_admin bypasses every check (handled in session/can()).

import type { AdminRole, AdminSession, Permissions } from "@/lib/auth/session";

// ---------------------------------------------------------------------------
// Catalogue types
// ---------------------------------------------------------------------------

export interface CatalogueAction {
  id: string;
  label: string;
  description: string;
  /** Destroys data. Surfaced with a danger tone + warning in the Admins UI. */
  destructive?: boolean;
}

export interface CatalogueNavItem {
  href: string;
  label: string;
  /** The action the route needs; defaults to "read" (view). */
  action?: string;
}

export interface CatalogueResource {
  id: string;
  label: string;
  description: string;
  actions: CatalogueAction[];
  /** Dashboard routes this resource governs (the nav items filtered by it). */
  nav: CatalogueNavItem[];
}

// ---------------------------------------------------------------------------
// The catalogue
// ---------------------------------------------------------------------------

const READ: CatalogueAction = { id: "read", label: "Read", description: "View this section." };

export const PERMISSION_CATALOGUE: CatalogueResource[] = [
  {
    id: "documents",
    label: "Knowledge & documents",
    description:
      "Documents, knowledge objects, entities, the taxonomy, relationships, learning, performance memory, ingestion decisions and uploads.",
    actions: [
      READ,
      { id: "write", label: "Write", description: "Upload, create, edit, curate and confirm knowledge." },
      {
        id: "delete",
        label: "Delete",
        description: "Permanently delete documents, knowledge objects and entities (single and in bulk).",
        destructive: true,
      },
    ],
    nav: [
      { href: "/dashboard/knowledge/add", label: "Add knowledge", action: "write" },
      { href: "/dashboard/knowledge", label: "Knowledge objects" },
      { href: "/dashboard/documents", label: "Documents" },
      { href: "/dashboard/learning", label: "Learning Lab" },
      { href: "/dashboard/performance", label: "Performance memory" },
      { href: "/dashboard/taxonomy", label: "Taxonomy" },
      { href: "/dashboard/relationships", label: "Relationships" },
      { href: "/dashboard/entities", label: "Entities" },
      { href: "/dashboard/uploads", label: "Bulk upload", action: "write" },
      { href: "/dashboard/decisions", label: "Ingestion decisions" },
      { href: "/dashboard/quality-data", label: "Data quality" },
      { href: "/dashboard/playground", label: "Playground" },
    ],
  },
  {
    id: "collections",
    label: "Collections",
    description: "Group documents into collections and move documents between them.",
    actions: [
      READ,
      { id: "write", label: "Write", description: "Create and rename collections; add or remove documents." },
      {
        id: "delete",
        label: "Delete",
        description: "Permanently delete a collection (single and in bulk).",
        destructive: true,
      },
    ],
    nav: [{ href: "/dashboard/collections", label: "Collections" }],
  },
  {
    id: "data_sources",
    label: "Data sources",
    description: "Pull connectors and upload sources, their sync runs and processing jobs.",
    actions: [
      READ,
      { id: "write", label: "Write", description: "Create, edit, sync, backfill and repair sources." },
    ],
    nav: [
      { href: "/dashboard/sources", label: "Sources" },
      { href: "/dashboard/processing", label: "Processing runs" },
    ],
  },
  {
    id: "prompts",
    label: "Prompts",
    description: "The prompt studio — the Brain's editable, versioned system prompts.",
    actions: [
      READ,
      { id: "write", label: "Write", description: "Create, edit and activate prompt versions." },
    ],
    nav: [{ href: "/dashboard/prompts", label: "Prompts" }],
  },
  {
    id: "api_keys",
    label: "API keys",
    description: "Scoped keys consumer apps use to read the Brain.",
    actions: [
      READ,
      { id: "write", label: "Write", description: "Mint scoped keys." },
      {
        id: "revoke",
        label: "Revoke",
        description: "Permanently revoke keys (single and in bulk). Apps lose access at once.",
        destructive: true,
      },
    ],
    nav: [{ href: "/dashboard/keys", label: "API keys" }],
  },
  {
    id: "connectors",
    label: "Connectors",
    description: "External integrations (MCP servers, HTTP APIs) and the keys granted to them.",
    actions: [
      READ,
      { id: "write", label: "Write", description: "Register connectors and grant them to keys." },
      {
        id: "delete",
        label: "Delete",
        description: "Revoke a connector grant (single and in bulk).",
        destructive: true,
      },
    ],
    nav: [{ href: "/dashboard/connectors", label: "Connectors" }],
  },
  {
    id: "members",
    label: "Admins",
    description: "The people who can sign in to the Brain and what each can do.",
    actions: [
      READ,
      {
        id: "write",
        label: "Write",
        description: "Edit members' permissions and (de)activate them. Inviting and role changes stay super-admin only.",
      },
    ],
    nav: [{ href: "/dashboard/admins", label: "Admins" }],
  },
  {
    id: "settings",
    label: "Settings & policy",
    description: "Org settings, the model policy and the retrieval policy.",
    actions: [
      READ,
      { id: "write", label: "Write", description: "Change settings and policies." },
    ],
    nav: [
      { href: "/dashboard/settings", label: "Settings" },
      { href: "/dashboard/model-policy", label: "Model policy" },
      { href: "/dashboard/retrieval-policy", label: "Retrieval policy" },
    ],
  },
  {
    id: "analytics",
    label: "Analytics",
    description: "Usage, cost and latency analytics, and query intelligence.",
    actions: [READ],
    nav: [
      { href: "/dashboard/analytics", label: "Analytics" },
      { href: "/dashboard/quality", label: "Query intelligence" },
    ],
  },
];

/** Routes visible to any signed-in admin, regardless of grants (the home/overview). */
/** Minimum length for a password a super-admin sets, or a member changes. */
export const MIN_PASSWORD_LENGTH = 8;

export const ALWAYS_VISIBLE_ROUTES: readonly string[] = ["/dashboard"];

// ---------------------------------------------------------------------------
// Derived surfaces
// ---------------------------------------------------------------------------

/** The permission surface a member can be granted: { resource: [actions] }. */
export const GRANTABLE_PERMISSIONS: Record<string, string[]> = Object.fromEntries(
  PERMISSION_CATALOGUE.map((r) => [r.id, r.actions.map((a) => a.id)])
);

/** href → required permission key (e.g. "documents:read"); routes not here are always visible. */
export const NAV_PERMISSIONS: Record<string, string> = Object.fromEntries(
  PERMISSION_CATALOGUE.flatMap((r) => r.nav.map((n) => [n.href, `${r.id}:${n.action ?? "read"}`]))
);

/** Actions on a resource that are destructive — used to warn in the UI. */
export const DESTRUCTIVE_ACTIONS: Record<string, string[]> = Object.fromEntries(
  PERMISSION_CATALOGUE.map((r) => [r.id, r.actions.filter((a) => a.destructive).map((a) => a.id)])
);

// ---------------------------------------------------------------------------
// Pure permission helpers
// ---------------------------------------------------------------------------

/** A caller we can evaluate permissions for: a full session, or a role+permissions pair. */
export type PermissionSubject = Pick<AdminSession, "role" | "permissions">;

/**
 * Does this permissions map hold `action` on `resource`?
 * Read is implied by any write-like (non-read) action: holding write/delete/revoke
 * on a resource grants read of it. Does NOT know about super_admin — callers that
 * carry a role (can(), hasPermission()) apply the super_admin bypass themselves.
 */
export function hasAction(permissions: Permissions | undefined, resource: string, action: string): boolean {
  const actions = permissions?.[resource];
  if (!Array.isArray(actions)) return false;
  if (actions.includes(action)) return true;
  if (action === "read") return actions.some((a) => a !== "read");
  return false;
}

/** Does the subject satisfy a "<resource>:<action>" key? super_admin bypasses all. */
export function can(subject: PermissionSubject, permissionKey: string): boolean {
  if (subject.role === "super_admin") return true;
  const [resource, action = "read"] = permissionKey.split(":");
  return hasAction(subject.permissions, resource, action);
}

export const canRead = (subject: PermissionSubject, resource: string): boolean => can(subject, `${resource}:read`);
export const canWrite = (subject: PermissionSubject, resource: string): boolean => can(subject, `${resource}:write`);
export const canDelete = (subject: PermissionSubject, resource: string): boolean => can(subject, `${resource}:delete`);

/** Can this subject see/open a dashboard route? Unknown + always-visible routes show. */
export function canAccessRoute(subject: PermissionSubject, href: string): boolean {
  if (subject.role === "super_admin") return true;
  if (ALWAYS_VISIBLE_ROUTES.includes(href)) return true;
  const key = NAV_PERMISSIONS[href];
  if (!key) return true;
  return can(subject, key);
}

/** Filter a list of nav items ({ href }) down to the ones this subject can see. */
export function navItemsFor<T extends { href: string }>(subject: PermissionSubject, items: T[]): T[] {
  return items.filter((it) => canAccessRoute(subject, it.href));
}

/**
 * Keep only known resources/actions from arbitrary input — the strict grant
 * surface. Drops unknown resources and actions (e.g. "delete" on data_sources).
 */
export function sanitizePermissions(input: unknown): Permissions {
  const out: Permissions = {};
  if (!input || typeof input !== "object") return out;
  for (const [resource, allowedActions] of Object.entries(GRANTABLE_PERMISSIONS)) {
    const requested = (input as Record<string, unknown>)[resource];
    if (!Array.isArray(requested)) continue;
    const actions = allowedActions.filter((a) => requested.includes(a));
    if (actions.length > 0) out[resource] = actions;
  }
  return out;
}

/**
 * Clamp a requested grant to what the granter themselves holds, so a non-super
 * admin can never grant a permission they lack (privilege escalation via the
 * members PATCH/POST). super_admin passes everything through. Read-implied means
 * a granter with documents:[write] may still grant documents:read.
 */
export function clampToGranter(requested: Permissions, granter: PermissionSubject): Permissions {
  if (granter.role === "super_admin") return requested;
  const out: Permissions = {};
  for (const [resource, actions] of Object.entries(requested)) {
    if (!Array.isArray(actions)) continue;
    const kept = actions.filter((a) => hasAction(granter.permissions, resource, a));
    if (kept.length > 0) out[resource] = kept;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Presets — one-click permission bundles applied on invite and editable after.
// Role stays 'admin' unless "Super admin" is chosen (that is a role, not a preset,
// and bypasses all). Presets list "read" explicitly for clarity even though it is
// implied by write/delete.
// ---------------------------------------------------------------------------

export interface Preset {
  id: string;
  label: string;
  description: string;
  permissions: Permissions;
}

export const PRESETS: Preset[] = [
  {
    id: "knowledge_uploader",
    label: "Knowledge uploader",
    description:
      "Upload and curate knowledge, and organize it into collections. Cannot delete anything, and has no access to keys, connectors, members, prompts or settings.",
    permissions: {
      documents: ["read", "write"],
      collections: ["read", "write"],
      data_sources: ["read"],
      analytics: ["read"],
    },
  },
  {
    id: "content_copywriter",
    label: "Content copywriter",
    description:
      "Write and curate knowledge and collections, and read the brand-voice prompts. No deletes, and no access to sources, keys, connectors, members or settings.",
    permissions: {
      documents: ["read", "write"],
      collections: ["read", "write"],
      prompts: ["read"],
      analytics: ["read"],
    },
  },
  {
    id: "readonly_analyst",
    label: "Read-only analyst",
    description: "Read knowledge, collections, sources and analytics. Cannot change anything.",
    permissions: {
      documents: ["read"],
      collections: ["read"],
      data_sources: ["read"],
      analytics: ["read"],
    },
  },
  {
    id: "operator_admin",
    label: "Admin",
    description:
      "Full operational access, including deletes — everything except members, API keys and settings. For a full owner, choose the Super admin role instead.",
    permissions: {
      documents: ["read", "write", "delete"],
      collections: ["read", "write", "delete"],
      data_sources: ["read", "write"],
      prompts: ["read", "write"],
      connectors: ["read", "write", "delete"],
      analytics: ["read"],
    },
  },
];

export const presetById = (id: string): Preset | null => PRESETS.find((p) => p.id === id) ?? null;

export type { AdminRole };
