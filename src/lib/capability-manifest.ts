// The capability manifest — what the Brain can do for a consumer app's USERS,
// as a versioned, machine-readable list a spoke renders its permission editor
// from (GET /api/v1/capabilities).
//
// It is BUILT FROM THE BRAIN'S OWN REGISTRIES, never hand-maintained per spoke:
//   • work modes           → src/lib/work-modes.ts        WORK_MODE_DEFS   → "modes.<id>"
//   • source types         → src/lib/source-types.ts      SOURCE_TYPE_DEFS → "data.<id>"   (+ sensitive flag)
//   • background job types → src/lib/jobs/handlers.ts     JOB_HANDLERS     → "jobs.<…>"
//   • extraction kinds     → src/lib/ingest-adapters/pure PROGRESS_LABEL   → "extract.<kind>"
//   • model tiers          → src/lib/models-catalog.ts    MODELS (tier tags) → "models.<tier>"
//   • connectors granted to the calling key (DB)          → "tools.connector.<slug>"
// plus a handful of fixed features (grounded chat, source scoping, call reviews,
// compaction, the Brain map, performance metrics, conflicts, learning).
// Adding a mode / source type / job type / extraction kind / tier-tagged model
// in the Brain therefore shows up in every spoke's admin panel automatically.
//
// Ids are STABLE and human-meaningful ("chat.knowledge", "modes.ceo_advisor",
// "data.call_score", "jobs.deep_audit", "learning.write", "knowledge.map",
// "extract.audio"). Never rename one: spokes store grants by id. Retire an id by
// removing it (spokes then drop it); add a new one for new behaviour.
//
// The manifest carries no secrets and no org content: labels, one-line
// descriptions, defaults and dependencies only. When a key scope is given it is
// FILTERED to what that key could ever grant (a key without transcripts in its
// scope is never offered call reviews or deep audits, a retrieve-only key is not
// offered chat features, …), so a spoke never advertises a capability its own
// key lacks.
//
// Defaults: `defaultForMembers` / `defaultForAdmins` are what a user with no
// stored grants gets. Sensitive capabilities (raw call material — AI call
// scores, QA transcripts, coaching, performance metrics, deep audits — and the
// private executive experts) are OFF for members by default.

import { WORK_MODE_DEFS, MODE_GROUP_LABELS } from "@/lib/work-modes";
import { SOURCE_TYPE_DEFS } from "@/lib/source-types";
import { MODELS, type ModelTier } from "@/lib/models-catalog";
import { PROGRESS_LABEL, type ExtractKind } from "@/lib/ingest-adapters/pure";
import { JOB_HANDLERS } from "@/lib/jobs/handlers";

/** Bump when the manifest SHAPE changes incompatibly (not when capabilities are added). */
export const CAPABILITY_MANIFEST_VERSION = 1;

export type CapabilityKind = "feature" | "mode" | "source_type" | "tool";

export interface CapabilityGroup {
  id: string;
  label: string;
}

export interface Capability {
  /** Stable id, "<group>.<name>" — spokes store grants by it. */
  id: string;
  label: string;
  /** One line, written for the admin deciding who gets it. */
  description: string;
  /** A CapabilityGroup id. */
  group: string;
  kind: CapabilityKind;
  /** Raw call material / private executive context. */
  sensitive?: boolean;
  /** Granted to an ordinary member who has no stored grants. */
  defaultForMembers: boolean;
  /** Granted to an admin who has no stored grants. */
  defaultForAdmins: boolean;
  /** Capability ids that must also be granted for this one to work. */
  requires?: string[];
  /** ISO date the Brain gained this capability (spokes may badge recent ones). */
  since?: string;
  /** Optional sub-heading inside the group (e.g. a work mode's expert family). */
  section?: string;
}

export interface CapabilityManifest {
  version: number;
  generatedAt: string;
  groups: CapabilityGroup[];
  capabilities: Capability[];
}

/** What a scoped key can reach — the manifest never offers more than this. */
export interface ManifestKeyScope {
  /** Key capabilities: "chat" | "retrieve" | "generate". */
  capabilities: readonly string[];
  /** Key source_types; empty = every source type. */
  sourceTypes: readonly string[];
  /** Key data-source narrowing; empty = none. */
  dataSourceIds?: readonly string[];
  /** Key collection narrowing; empty = none. */
  collectionIds?: readonly string[];
  /** Active connectors granted to the key (connector_grants → connectors). */
  connectors?: readonly ManifestConnector[];
}

export interface ManifestConnector {
  slug: string;
  name: string;
  kind: string;
}

// ---------------------------------------------------------------------------
// Groups (display order)
// ---------------------------------------------------------------------------

export const CAPABILITY_GROUPS: readonly CapabilityGroup[] = [
  { id: "chat", label: "Chat" },
  { id: "modes", label: "Work modes" },
  { id: "data", label: "Knowledge sources" },
  { id: "knowledge", label: "Brain map & insight" },
  { id: "learning", label: "Organizational learning" },
  { id: "jobs", label: "Background jobs" },
  { id: "extract", label: "Files & media" },
  { id: "models", label: "Models" },
  { id: "tools", label: "Connectors" },
];

// ---------------------------------------------------------------------------
// Registry metadata the registries themselves don't carry (labels written for
// an admin). Anything missing here still appears, with a humanized fallback.
// ---------------------------------------------------------------------------

interface JobMeta {
  id: string;
  label: string;
  description: string;
  sensitive: boolean;
  /** Source types the job reads — the key must have them in scope. */
  reads: string[];
  since?: string;
}

const JOB_META: Record<string, JobMeta> = {
  deep_call_audit: {
    id: "jobs.deep_audit",
    label: "Deep call audits",
    description: "Background audits that read every matching call transcript and build a per-call QA report.",
    sensitive: true,
    reads: ["transcript"],
    since: "2026-09-24",
  },
};

const EXTRACT_META: Record<string, { label: string; description: string }> = {
  pdf: { label: "PDFs", description: "Read attached PDF documents." },
  image: { label: "Images & screenshots", description: "Read the text and content of attached images and screenshots." },
  audio: { label: "Voice notes & audio", description: "Transcribe voice dictation and attached audio files." },
  text: { label: "Text files", description: "Read attached text, Markdown, CSV and JSON files." },
  url: { label: "Web links", description: "Read a web page from a link." },
  youtube: { label: "YouTube videos", description: "Pull a YouTube video's captions from a link." },
};

const TIER_ORDER: ModelTier[] = ["fast", "recommended", "max"];
const TIER_META: Record<ModelTier, { label: string; blurb: string }> = {
  fast: { label: "Fast", blurb: "quick, low-cost answers" },
  recommended: { label: "Recommended", blurb: "the default for most work" },
  max: { label: "Max quality", blurb: "the strongest model for hard, high-stakes work" },
};

function humanize(id: string): string {
  const s = id.replace(/[_-]+/g, " ").trim();
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : id;
}

/** A connector slug as a capability-id segment: lowercase [a-z0-9_-]. */
export function connectorCapabilityId(slug: string): string {
  const seg = slug.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
  return `tools.connector.${seg || "unnamed"}`;
}

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

/** Resolved view of a key scope used by the per-capability gates. */
interface KeyView {
  chat: boolean;
  read: boolean;
  source: (t: string) => boolean;
  /** No data-source / collection narrowing (the structured call-review path needs it). */
  unnarrowed: boolean;
}

interface Entry extends Capability {
  /** Whether a key with this scope could ever grant the capability. */
  needs: (k: KeyView) => boolean;
}

const ALL_KEY: KeyView = { chat: true, read: true, source: () => true, unnarrowed: true };

function keyView(scope: ManifestKeyScope): KeyView {
  const caps = scope.capabilities ?? [];
  const st = scope.sourceTypes ?? [];
  const chat = caps.includes("chat");
  return {
    chat,
    read: chat || caps.includes("retrieve"),
    source: (t) => st.length === 0 || st.includes(t),
    unnarrowed: (scope.dataSourceIds?.length ?? 0) === 0 && (scope.collectionIds?.length ?? 0) === 0,
  };
}

function entries(connectors: readonly ManifestConnector[]): Entry[] {
  const out: Entry[] = [];

  // ---- Chat -----------------------------------------------------------------
  out.push(
    {
      id: "chat.knowledge",
      label: "Ask the Brain",
      description: "Grounded, cited answers from the company knowledge the Brain holds.",
      group: "chat",
      kind: "feature",
      defaultForMembers: true,
      defaultForAdmins: true,
      needs: (k) => k.chat,
    },
    {
      id: "chat.source_scope",
      label: "Source scoping",
      description: "Narrow a question with the Search-in picker: one knowledge lane or chosen collections.",
      group: "chat",
      kind: "feature",
      defaultForMembers: true,
      defaultForAdmins: true,
      requires: ["chat.knowledge"],
      needs: (k) => k.chat,
    },
    {
      id: "chat.call_review",
      label: "Call reviews",
      description: "Review every call for a named day, range, consultant or practice type, each call read in full.",
      group: "chat",
      kind: "feature",
      sensitive: true,
      defaultForMembers: false,
      defaultForAdmins: true,
      requires: ["chat.knowledge", "data.transcript"],
      since: "2026-09-24",
      // The structured review path runs only when transcripts are in scope and
      // the key has no data-source / collection narrowing (see orchestrator.ts).
      needs: (k) => k.chat && k.source("transcript") && k.unnarrowed,
    },
    {
      id: "chat.compaction",
      label: "Long-chat compaction",
      description: "Summarize a long conversation so it can keep going past the model's context window.",
      group: "chat",
      kind: "feature",
      defaultForMembers: true,
      defaultForAdmins: true,
      requires: ["chat.knowledge"],
      since: "2026-09-25",
      needs: (k) => k.chat,
    }
  );

  // ---- Work modes (registry) -------------------------------------------------
  // "auto" is the router, not an expert: it is always available and only ever
  // resolves to a mode the user may use (the spoke forwards allowedModes).
  for (const m of WORK_MODE_DEFS) {
    if (m.id === "auto") continue;
    out.push({
      id: `modes.${m.id}`,
      label: m.label,
      description: m.hint,
      group: "modes",
      kind: "mode",
      section: MODE_GROUP_LABELS[m.group] ?? humanize(m.group),
      ...(m.restricted ? { sensitive: true } : {}),
      defaultForMembers: !m.restricted,
      defaultForAdmins: true,
      requires: ["chat.knowledge"],
      needs: (k) => k.chat,
    });
  }

  // ---- Knowledge sources (registry) -------------------------------------------
  for (const s of SOURCE_TYPE_DEFS) {
    out.push({
      id: `data.${s.id}`,
      label: s.label,
      description: s.description,
      group: "data",
      kind: "source_type",
      ...(s.sensitive ? { sensitive: true } : {}),
      defaultForMembers: !s.sensitive,
      defaultForAdmins: true,
      needs: (k) => k.read && k.source(s.id),
    });
  }

  // ---- Brain map & insight ----------------------------------------------------
  out.push(
    {
      id: "knowledge.map",
      label: "Brain map",
      description: "Browse what the Brain knows: knowledge objects, their relationships and refs.",
      group: "knowledge",
      kind: "feature",
      defaultForMembers: true,
      defaultForAdmins: true,
      since: "2026-09-21",
      needs: (k) => k.read,
    },
    {
      id: "knowledge.performance",
      label: "Performance metrics",
      description: "Structured numbers in answers: team and per-consultant scores, close rates and KPIs.",
      group: "knowledge",
      kind: "feature",
      sensitive: true,
      defaultForMembers: false,
      defaultForAdmins: true,
      requires: ["chat.knowledge", "data.call_score"],
      since: "2026-09-21",
      needs: (k) => k.chat && k.source("call_score"),
    },
    {
      id: "knowledge.conflicts",
      label: "Source disagreements",
      description: "Flag when the sources behind an answer contradict each other, and which carries more authority.",
      group: "knowledge",
      kind: "feature",
      defaultForMembers: true,
      defaultForAdmins: true,
      requires: ["chat.knowledge"],
      since: "2026-09-21",
      needs: (k) => k.chat,
    }
  );

  // ---- Organizational learning -------------------------------------------------
  out.push(
    {
      id: "learning.read",
      label: "View learnings",
      description: "Read the organization's learning records: decisions, experiments, results and lessons.",
      group: "learning",
      kind: "feature",
      defaultForMembers: true,
      defaultForAdmins: true,
      since: "2026-09-21",
      needs: (k) => k.read,
    },
    {
      id: "learning.write",
      label: "Save learnings",
      description: "Save a learning the Brain spotted in chat after confirming it, or record one by hand.",
      group: "learning",
      kind: "feature",
      defaultForMembers: true,
      defaultForAdmins: true,
      since: "2026-09-21",
      needs: (k) => k.chat,
    }
  );

  // ---- Background jobs (registry) -----------------------------------------------
  for (const type of Object.keys(JOB_HANDLERS)) {
    const meta = JOB_META[type];
    const reads = meta?.reads ?? [];
    // An unknown job type defaults to the cautious setting: off for members.
    const sensitive = meta?.sensitive ?? true;
    out.push({
      id: meta?.id ?? `jobs.${type}`,
      label: meta?.label ?? humanize(type),
      description: meta?.description ?? `Run "${humanize(type).toLowerCase()}" background jobs.`,
      group: "jobs",
      kind: "feature",
      ...(sensitive ? { sensitive: true } : {}),
      defaultForMembers: !sensitive,
      defaultForAdmins: true,
      ...(reads.length ? { requires: reads.map((t) => `data.${t}`) } : {}),
      ...(meta?.since ? { since: meta.since } : {}),
      needs: (k) => k.chat && reads.every((t) => k.source(t)),
    });
  }

  // ---- Files & media (extraction adapters) ---------------------------------------
  for (const kind of Object.keys(PROGRESS_LABEL) as ExtractKind[]) {
    const meta = EXTRACT_META[kind];
    out.push({
      id: `extract.${kind}`,
      label: meta?.label ?? humanize(kind),
      description: meta?.description ?? `Extract text from ${humanize(kind).toLowerCase()} sources.`,
      group: "extract",
      kind: "feature",
      defaultForMembers: true,
      defaultForAdmins: true,
      since: "2026-09-21",
      needs: (k) => k.chat,
    });
  }

  // ---- Models (tier-tagged catalog entries) ---------------------------------------
  const tiers = TIER_ORDER.filter((t) => MODELS.some((m) => m.tier === t));
  for (const t of tiers) {
    const model = MODELS.find((m) => m.tier === t);
    out.push({
      id: `models.${t}`,
      label: TIER_META[t].label,
      description: `${model ? `${model.label}: ` : ""}${TIER_META[t].blurb}.`,
      group: "models",
      kind: "feature",
      defaultForMembers: true,
      defaultForAdmins: true,
      needs: (k) => k.chat,
    });
  }
  if (tiers.length === TIER_ORDER.length) {
    out.push({
      id: "models.smart_route",
      label: "Smart Route",
      description: "Let the Brain pick the tier for each question (it may use any tier).",
      group: "models",
      kind: "feature",
      defaultForMembers: true,
      defaultForAdmins: true,
      requires: tiers.map((t) => `models.${t}`),
      since: "2026-09-14",
      needs: (k) => k.chat,
    });
  }
  if (tiers.includes("max")) {
    out.push({
      id: "models.deep_analysis",
      label: "Deep analysis",
      description: "Max-quality model with a longer, more thorough analysis budget.",
      group: "models",
      kind: "feature",
      defaultForMembers: true,
      defaultForAdmins: true,
      requires: ["models.max"],
      since: "2026-09-14",
      needs: (k) => k.chat,
    });
  }

  // ---- Connectors (registry + per-key grants) ----------------------------------------
  out.push({
    id: "tools.connectors",
    label: "Connectors",
    description: "Use the MCP servers and third-party integrations the Brain grants this app.",
    group: "tools",
    kind: "tool",
    defaultForMembers: true,
    defaultForAdmins: true,
    needs: (k) => k.chat,
  });
  const seen = new Set<string>();
  for (const c of connectors) {
    const id = connectorCapabilityId(c.slug);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({
      id,
      label: c.name.trim().slice(0, 80) || humanize(c.slug),
      description: `${c.kind === "mcp" ? "MCP server" : "Third-party API"} integration granted to this app.`,
      group: "tools",
      kind: "tool",
      defaultForMembers: true,
      defaultForAdmins: true,
      requires: ["tools.connectors"],
      needs: (k) => k.chat,
    });
  }

  return out;
}

/**
 * Build the manifest. With `scope`, only capabilities that key could ever grant
 * are included (and anything whose `requires` would then be missing is dropped
 * too); without it, the Brain's full capability set.
 */
export function buildCapabilityManifest(scope?: ManifestKeyScope, now: Date = new Date()): CapabilityManifest {
  const view = scope ? keyView(scope) : ALL_KEY;
  let caps: Entry[] = entries(scope?.connectors ?? []).filter((e) => e.needs(view));

  // Dependency closure: a capability whose prerequisite is not offered can never
  // be granted, so it is not offered either (repeat until stable).
  for (let changed = true; changed; ) {
    const ids = new Set(caps.map((c) => c.id));
    const next = caps.filter((c) => (c.requires ?? []).every((r) => ids.has(r)));
    changed = next.length !== caps.length;
    caps = next;
  }

  const used = new Set(caps.map((c) => c.group));
  return {
    version: CAPABILITY_MANIFEST_VERSION,
    generatedAt: now.toISOString(),
    groups: CAPABILITY_GROUPS.filter((g) => used.has(g.id)).map((g) => ({ ...g })),
    capabilities: caps.map(toCapability),
  };
}

/** Strip the internal gate; copy arrays so callers can't mutate the registry. */
function toCapability(e: Entry): Capability {
  const c: Capability = {
    id: e.id,
    label: e.label,
    description: e.description,
    group: e.group,
    kind: e.kind,
    defaultForMembers: e.defaultForMembers,
    defaultForAdmins: e.defaultForAdmins,
  };
  if (e.sensitive) c.sensitive = true;
  if (e.requires?.length) c.requires = [...e.requires];
  if (e.since) c.since = e.since;
  if (e.section) c.section = e.section;
  return c;
}
