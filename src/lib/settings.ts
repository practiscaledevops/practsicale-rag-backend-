// RAG pipeline settings — the single source of truth for every tunable knob in
// the Brain's retrieval + generation pipeline. Persisted per-org as
// app_settings.data (jsonb) so the dashboard Settings page can change behaviour
// WITHOUT a redeploy — exactly like prompts.
//
// The pure shape/defaults/merge are safe to `import type` from a client
// component. loadSettings()/saveSettings() touch the SERVICE-ROLE client and are
// server-only. Every read is defensive: a missing row or malformed jsonb always
// resolves to DEFAULT_SETTINGS so the pipeline can never be wedged by bad data.

import type { SupabaseClient } from "@supabase/supabase-js";
import { supabaseAdmin } from "@/lib/supabase";

// ---------------------------------------------------------------------------
// Shape (pure — safe to import type from client components)
// ---------------------------------------------------------------------------

export interface RetrievalSettings {
  /** Candidate pool pulled from hybrid search before reranking. 10..200. */
  matchCount: number;
  /** How many chunks the reranker keeps (and the model sees). 1..50. */
  rerankTopN: number;
  /** Expand retrieved children to their parent section for fuller context. */
  expandParents: boolean;
  /** RRF weights + k (advanced). */
  fullTextWeight: number;
  semanticWeight: number;
  rrfK: number;
}

export interface FeatureSettings {
  /** Rewrite/expand the user query before retrieval (recall ↑). */
  queryRewrite: boolean;
  /** Anthropic contextual retrieval: situate each chunk before embed + FTS. */
  contextualRetrieval: boolean;
  /** Use an LLM to pick source_type(s); off ⇒ fast keyword router. */
  llmRouter: boolean;
  /** Verify the answer is grounded in context after generation. */
  faithfulnessCheck: boolean;
  /** Refuse (don't answer) when retrieved context looks insufficient. */
  groundOrRefuse: boolean;
  /** Rerank candidates with Cohere when a key is configured. */
  rerank: boolean;
  /** Retrieval orchestrator: intent → lanes (reality/learning/playbooks…) → boosts → expansion. Off ⇒ classic pipeline. */
  orchestrator: boolean;
  /** Auto work mode: detect the expert job from the request when the caller sends "auto". */
  autoWorkMode: boolean;
  /** 1-hop relationship expansion of retrieved knowledge objects. */
  relationshipExpansion: boolean;
  /** Detect Organizational Learning in chat and offer to save it. */
  learningDetection: boolean;
}

export interface IntelligenceSettings {
  /** Object similarity at/above which the dedup judge runs (NEW/ENRICH/DUPLICATE/CONFLICT). 0.5..0.99 */
  dedupThreshold: number;
  /** Object similarity at/above which an AI relationship is SUGGESTED for review. 0.3..0.95 */
  suggestThreshold: number;
  /** Auto-approve new taxonomy values the compiler proposes (off ⇒ approval queue). */
  taxonomyAutoApprove: boolean;
  /** Tiers for the compiler stages. */
  classifyTier: "fast" | "recommended" | "max";
  compileTier: "fast" | "recommended" | "max";
  /** Tier for the per-request intent classifier (fast keeps time-to-first-token low). */
  intentTier: "fast" | "recommended" | "max";
  /** Candidate pool per lane before boosting. 10..120 */
  laneCandidates: number;
}

export interface GenerationSettings {
  /** Default tier when a request doesn't specify one. */
  defaultTier: "fast" | "recommended" | "max";
  /** Sampling temperature for grounded answers (0 = most faithful). */
  temperature: number;
  /** Hard cap on answer length (tokens). */
  maxTokens: number;
}

export interface ContextualSettings {
  /** Skip context generation for documents with more chunks than this (cost guard). */
  maxChunksPerDoc: number;
  /** Concurrent context-generation calls during ingest. */
  concurrency: number;
  /** Tier used for the cheap per-chunk context generation. */
  tier: "fast" | "recommended" | "max";
}

export interface RagSettings {
  retrieval: RetrievalSettings;
  features: FeatureSettings;
  generation: GenerationSettings;
  contextual: ContextualSettings;
  intelligence: IntelligenceSettings;
}

// ---------------------------------------------------------------------------
// Defaults — the source of truth when a key is absent
// ---------------------------------------------------------------------------

export const DEFAULT_SETTINGS: RagSettings = {
  retrieval: {
    matchCount: 60,
    rerankTopN: 8,
    expandParents: true,
    fullTextWeight: 1.0,
    semanticWeight: 1.0,
    rrfK: 50,
  },
  features: {
    queryRewrite: true,
    contextualRetrieval: true,
    llmRouter: false,
    // Off by default for speed: ground-or-refuse + citation validation already
    // guard hallucination instantly and for free. Turn on in Settings for a
    // stricter (but slower, +1 LLM call per answer) post-generation check.
    faithfulnessCheck: false,
    // Off by default: this is a general-purpose assistant, not a data-only bot.
    // With this off, an empty retrieval doesn't hard-refuse — the assistant still
    // helps (brainstorm, content, ideas) and only avoids fabricating specific
    // company facts (enforced by the prompt). Turn ON for a strict data-only mode.
    groundOrRefuse: false,
    rerank: true,
    orchestrator: true,
    autoWorkMode: true,
    relationshipExpansion: true,
    learningDetection: true,
  },
  generation: {
    defaultTier: "recommended",
    temperature: 0,
    maxTokens: 1024,
  },
  contextual: {
    maxChunksPerDoc: 200,
    concurrency: 5,
    tier: "fast",
  },
  intelligence: {
    dedupThreshold: 0.8,
    suggestThreshold: 0.62,
    taxonomyAutoApprove: false,
    classifyTier: "recommended",
    compileTier: "recommended",
    intentTier: "fast",
    laneCandidates: 40,
  },
};

// ---------------------------------------------------------------------------
// Defensive merge (jsonb from the DB is untrusted-shaped)
// ---------------------------------------------------------------------------

function num(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(hi, Math.max(lo, n));
}

function bool(v: unknown, fallback: boolean): boolean {
  return typeof v === "boolean" ? v : fallback;
}

function tier(v: unknown, fallback: "fast" | "recommended" | "max") {
  return v === "fast" || v === "recommended" || v === "max" ? v : fallback;
}

/** Merge a raw jsonb blob over DEFAULT_SETTINGS into a fully-formed RagSettings. */
export function mergeSettings(raw: unknown): RagSettings {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const ret = (r.retrieval ?? {}) as Record<string, unknown>;
  const feat = (r.features ?? {}) as Record<string, unknown>;
  const gen = (r.generation ?? {}) as Record<string, unknown>;
  const ctx = (r.contextual ?? {}) as Record<string, unknown>;
  const intel = (r.intelligence ?? {}) as Record<string, unknown>;
  const D = DEFAULT_SETTINGS;

  return {
    retrieval: {
      matchCount: num(ret.matchCount, 10, 200, D.retrieval.matchCount),
      rerankTopN: num(ret.rerankTopN, 1, 50, D.retrieval.rerankTopN),
      expandParents: bool(ret.expandParents, D.retrieval.expandParents),
      fullTextWeight: num(ret.fullTextWeight, 0, 10, D.retrieval.fullTextWeight),
      semanticWeight: num(ret.semanticWeight, 0, 10, D.retrieval.semanticWeight),
      rrfK: num(ret.rrfK, 1, 1000, D.retrieval.rrfK),
    },
    features: {
      queryRewrite: bool(feat.queryRewrite, D.features.queryRewrite),
      contextualRetrieval: bool(feat.contextualRetrieval, D.features.contextualRetrieval),
      llmRouter: bool(feat.llmRouter, D.features.llmRouter),
      faithfulnessCheck: bool(feat.faithfulnessCheck, D.features.faithfulnessCheck),
      groundOrRefuse: bool(feat.groundOrRefuse, D.features.groundOrRefuse),
      rerank: bool(feat.rerank, D.features.rerank),
      orchestrator: bool(feat.orchestrator, D.features.orchestrator),
      autoWorkMode: bool(feat.autoWorkMode, D.features.autoWorkMode),
      relationshipExpansion: bool(feat.relationshipExpansion, D.features.relationshipExpansion),
      learningDetection: bool(feat.learningDetection, D.features.learningDetection),
    },
    generation: {
      defaultTier: tier(gen.defaultTier, D.generation.defaultTier),
      temperature: num(gen.temperature, 0, 2, D.generation.temperature),
      maxTokens: num(gen.maxTokens, 128, 8192, D.generation.maxTokens),
    },
    contextual: {
      maxChunksPerDoc: num(ctx.maxChunksPerDoc, 1, 5000, D.contextual.maxChunksPerDoc),
      concurrency: num(ctx.concurrency, 1, 20, D.contextual.concurrency),
      tier: tier(ctx.tier, D.contextual.tier),
    },
    intelligence: {
      dedupThreshold: num(intel.dedupThreshold, 0.5, 0.99, D.intelligence.dedupThreshold),
      suggestThreshold: num(intel.suggestThreshold, 0.3, 0.95, D.intelligence.suggestThreshold),
      taxonomyAutoApprove: bool(intel.taxonomyAutoApprove, D.intelligence.taxonomyAutoApprove),
      classifyTier: tier(intel.classifyTier, D.intelligence.classifyTier),
      compileTier: tier(intel.compileTier, D.intelligence.compileTier),
      intentTier: tier(intel.intentTier, D.intelligence.intentTier),
      laneCandidates: num(intel.laneCandidates, 10, 120, D.intelligence.laneCandidates),
    },
  };
}

// ---------------------------------------------------------------------------
// Service-role load / save (server-only)
// ---------------------------------------------------------------------------

/**
 * Load the org's RagSettings. Never throws — a missing row or read error
 * resolves to DEFAULT_SETTINGS so the pipeline always has a usable config.
 */
export async function loadSettings(
  orgId: string,
  db?: SupabaseClient
): Promise<{ settings: RagSettings; updatedAt: string | null }> {
  try {
    const client = db ?? supabaseAdmin();
    const { data, error } = await client
      .from("app_settings")
      .select("data, updated_at")
      .eq("org_id", orgId)
      .maybeSingle();
    if (error || !data) return { settings: { ...DEFAULT_SETTINGS }, updatedAt: null };
    return {
      settings: mergeSettings((data as { data?: unknown }).data),
      updatedAt: (data as { updated_at?: string | null }).updated_at ?? null,
    };
  } catch {
    return { settings: { ...DEFAULT_SETTINGS }, updatedAt: null };
  }
}

/** Upsert the org's settings (normalized through mergeSettings first). */
export async function saveSettings(
  orgId: string,
  raw: unknown,
  updatedBy: string | null,
  db?: SupabaseClient
): Promise<RagSettings> {
  const settings = mergeSettings(raw);
  const client = db ?? supabaseAdmin();
  const { error } = await client.from("app_settings").upsert(
    {
      org_id: orgId,
      data: settings as unknown as Record<string, unknown>,
      updated_at: new Date().toISOString(),
      updated_by: updatedBy,
    },
    { onConflict: "org_id" }
  );
  // A silent failure here would tell the dashboard "saved" while the Brain kept
  // running on the old settings.
  if (error) throw new Error(`settings save failed: ${error.message}`);
  return settings;
}
