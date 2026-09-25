// Shared user-facing labels and status tones for the Brain back office.
// One map per concept, so every page says the same thing for the same value.
// Pure data + functions (no React): safe anywhere, including tests.

import type { BadgeTone } from "@/components/ui/Badge";
import { humanize } from "@/lib/format";
import { INTELLIGENCE_CLASSES } from "@/lib/intelligence-taxonomy";

// ---------------------------------------------------------------------------
// Source types (documents.source_type)
// ---------------------------------------------------------------------------

/**
 * `document` is everything not synced from an API: uploads, pasted text,
 * links and compiled knowledge objects. (The Collections workspace used to
 * call it "Manual"; every other page said "Document".)
 */
export const SOURCE_TYPE_LABELS: Record<string, string> = {
  document: "Document",
  call_score: "Call score",
  coaching: "Coaching",
  transcript: "Transcript",
};

/** Friendly source-type label; unknown values are humanized, empty ones read "—". */
export function sourceTypeLabel(v: string | null | undefined): string {
  if (!v) return humanize(v);
  return SOURCE_TYPE_LABELS[v] ?? SOURCE_TYPE_LABELS[v.toLowerCase()] ?? humanize(v);
}

// ---------------------------------------------------------------------------
// Access levels (documents.access)
// ---------------------------------------------------------------------------

export const ACCESS_LABELS: Record<string, string> = {
  public: "Public",
  team: "Team",
  restricted: "Restricted",
  confidential: "Confidential",
  ceo_only: "CEO only",
};

// ---------------------------------------------------------------------------
// Model tiers
// ---------------------------------------------------------------------------

export type Tier = "fast" | "recommended" | "max";

export const TIER_LABELS: Record<Tier, string> = {
  fast: "Fast",
  recommended: "Recommended",
  max: "Max",
};

/** One-line help per tier (merges the old "Balanced" / "Best quality" labels). */
export const TIER_HINTS: Record<Tier, string> = {
  fast: "Lowest cost and latency, for quick everyday answers.",
  recommended: "Balanced quality and speed for most work.",
  max: "Best quality, for hard or high-stakes questions.",
};

// ---------------------------------------------------------------------------
// Knowledge classes (categorical, not status)
// ---------------------------------------------------------------------------

/** Class labels come from the taxonomy (one source of truth for every page). */
export const CLASS_LABEL: Record<string, string> = Object.fromEntries(
  INTELLIGENCE_CLASSES.map((c) => [c.id, c.label])
);

/** Dot colour per knowledge class: the chatbot's folder accent bars. */
export const CLASS_DOT: Record<string, string> = {
  business_reality: "bg-folder-5",
  playbook: "bg-folder-1",
  organizational_learning: "bg-folder-3",
  platform_intelligence: "bg-folder-4",
  performance_memory: "bg-folder-2",
  raw_archive: "bg-muted-foreground/40",
};

/**
 * Base classes for a class dot. The hairline ring keeps the pale folder colours
 * (folder-2 yellow, folder-4 tea) visible on white and muted surfaces.
 */
export const CLASS_DOT_BASE = "h-2 w-2 shrink-0 rounded-full ring-1 ring-foreground/10";

// ---------------------------------------------------------------------------
// Processing-run triggers
// ---------------------------------------------------------------------------

export const TRIGGER_LABELS: Record<string, string> = {
  manual: "Manual sync",
  schedule: "Scheduled",
  webhook: "Webhook",
  upload: "Upload",
};

/** Friendly run-trigger label; unknown values are humanized, empty ones read "—". */
export const triggerLabel = (v: string | null | undefined): string => (v && TRIGGER_LABELS[v]) || humanize(v);

// ---------------------------------------------------------------------------
// Status tones
// ---------------------------------------------------------------------------

/** The tones statusTone can return (never the outlined "strong"), so it also fits StatusDot. */
export type StatusTone = Exclude<BadgeTone, "strong">;

const TONE_BY_STATUS: Record<string, StatusTone> = {};
const addTone = (tone: StatusTone, values: string[]) => {
  for (const v of values) TONE_BY_STATUS[v] = tone;
};
addTone("success", [
  "success", "succeeded", "completed", "complete", "done", "ready", "active",
  "approved", "connected", "healthy", "ok", "indexed", "published",
]);
addTone("accent", ["running", "processing", "in_progress", "syncing", "ingesting", "compiling"]);
addTone("warning", [
  "partial", "warning", "stale", "aging", "draft", "needs_review",
  "changes_requested", "pending_review",
]);
addTone("danger", ["failed", "failure", "error", "errored", "rejected", "blocked"]);
addTone("neutral", [
  "queued", "pending", "scheduled", "archived", "historical", "cancelled",
  "canceled", "paused", "disabled", "revoked", "never",
]);

/**
 * Badge tone for any status-like value. Case-insensitive; "-" and "_" are
 * treated the same. success = healthy/done, accent = in progress,
 * warning = needs attention, danger = failed, neutral = everything else
 * (queued, archived, paused, never synced, unknown values).
 */
export function statusTone(value: string | null | undefined): StatusTone {
  if (!value) return "neutral";
  const key = value.trim().toLowerCase().replace(/[\s-]+/g, "_");
  return TONE_BY_STATUS[key] ?? "neutral";
}

/** Display label for a status value ("needs_review" -> "Needs review"). */
export const statusLabel = humanize;

// ---------------------------------------------------------------------------
// Dedup / compile outcomes: the wizard verdict, LongSource sections and the
// Decisions log all colour the same verdict the same way.
// ---------------------------------------------------------------------------

/**
 * new = success, enrich = info, duplicate = neutral, conflict / blocked =
 * warning (needs review), failed = danger. Failure and conflict are checked
 * first, so compound values like "new_conflict" and "raw_failed" read right.
 */
export function dedupTone(value: string): StatusTone {
  const v = value.toLowerCase();
  if (v.includes("fail")) return "danger";
  if (v.includes("conflict") || v.includes("blocked")) return "warning";
  if (v.includes("enrich")) return "info";
  if (v.includes("duplicate")) return "neutral";
  if (v.includes("new")) return "success";
  return "neutral";
}
