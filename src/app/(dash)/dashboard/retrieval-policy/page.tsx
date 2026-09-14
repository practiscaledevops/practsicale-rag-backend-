"use client";

// Retrieval policy (Governance) — org-wide retrieval + grounding policy: the
// vector/keyword balance, candidate pool, rerank depth, parent expansion, and the
// accuracy/anti-hallucination guards. Admin-only; applies to every answer.

import { Loader2 } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Alert } from "@/components/ui/Alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { usePolicySettings, SaveButton, NumberField, Toggle } from "@/components/ui/policy";

export default function RetrievalPolicyPage() {
  const { settings, patch, save, saving, loading, notice } = usePolicySettings();

  return (
    <div>
      <PageHeader
        title="Retrieval policy"
        description="Org-wide retrieval and grounding policy — how the knowledge base is searched and how strictly answers must be supported. Administrator controls; they apply to every answer."
        actions={settings ? <SaveButton onClick={save} saving={saving} /> : undefined}
      />

      {notice && <Alert tone={notice.tone} className="mb-4">{notice.message}</Alert>}

      {loading || !settings ? (
        <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading policy…
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Hybrid search</CardTitle>
              <CardDescription>Vector (meaning) vs keyword (exact) balance, and how many candidates to consider.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <NumberField label="Semantic weight" hint="Vector / meaning influence." value={settings.retrieval.semanticWeight} onChange={(v) => patch("retrieval", { semanticWeight: v })} min={0} max={10} step={0.1} />
              <NumberField label="Keyword weight" hint="Full-text / exact influence." value={settings.retrieval.fullTextWeight} onChange={(v) => patch("retrieval", { fullTextWeight: v })} min={0} max={10} step={0.1} />
              <NumberField label="Candidate pool (top-K)" hint="Chunks pulled before reranking (10–200)." value={settings.retrieval.matchCount} onChange={(v) => patch("retrieval", { matchCount: v })} min={10} max={200} />
              <NumberField label="Rerank top-N" hint="Max sources kept for the answer (1–50)." value={settings.retrieval.rerankTopN} onChange={(v) => patch("retrieval", { rerankTopN: v })} min={1} max={50} />
              <NumberField label="Rank-fusion k" hint="RRF constant." value={settings.retrieval.rrfK} onChange={(v) => patch("retrieval", { rrfK: v })} min={1} max={1000} />
              <div className="sm:col-span-2 border-t border-border pt-1">
                <Toggle label="Expand to parent chunks" hint="Return the fuller surrounding section for each hit (more context)." checked={settings.retrieval.expandParents} onChange={(v) => patch("retrieval", { expandParents: v })} />
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Accuracy &amp; grounding guards</CardTitle>
              <CardDescription>The stages that keep answers honest. Turning guards off trades safety for speed.</CardDescription>
            </CardHeader>
            <CardContent className="divide-y divide-border">
              <Toggle label="Reranking" hint="Reorder candidates by relevance (free LLM reranker; Cohere if a key is set)." checked={settings.features.rerank} onChange={(v) => patch("features", { rerank: v })} />
              <Toggle label="Query rewriting" hint="Distil the question into a clean search query before retrieval (recall ↑)." checked={settings.features.queryRewrite} onChange={(v) => patch("features", { queryRewrite: v })} />
              <Toggle label="Contextual retrieval" hint="Situate each chunk in its document before embedding. Applies on next ingest." checked={settings.features.contextualRetrieval} onChange={(v) => patch("features", { contextualRetrieval: v })} />
              <Toggle label="LLM source router" hint="Use a model to pick which source types to search (off = fast keyword router)." checked={settings.features.llmRouter} onChange={(v) => patch("features", { llmRouter: v })} />
              <Toggle label="Faithfulness check" hint="Verify every claim is supported by context after generation (+1 LLM call)." checked={settings.features.faithfulnessCheck} onChange={(v) => patch("features", { faithfulnessCheck: v })} />
              <Toggle label="Ground or refuse" hint="Refuse (no model call) when retrieval finds nothing relevant. Guarantees no hallucination." checked={settings.features.groundOrRefuse} onChange={(v) => patch("features", { groundOrRefuse: v })} />
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
