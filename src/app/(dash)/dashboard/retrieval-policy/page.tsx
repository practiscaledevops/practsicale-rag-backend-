"use client";

// Retrieval policy (Governance) — org-wide retrieval + grounding policy: the
// vector/keyword balance, candidate pool, rerank depth, parent expansion, and the
// accuracy/anti-hallucination guards. Admin-only; applies to every answer.

import { SearchCheck, ShieldCheck } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Alert } from "@/components/ui/Alert";
import { SectionCard } from "@/components/ui/Card";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import {
  usePolicySettings,
  NumberField,
  Toggle,
  SaveBar,
  SettingsList,
  PolicySkeleton,
  RERANK_HINT,
  guardOffConfirm,
  type GuardKey,
} from "@/components/ui/policy";

export default function RetrievalPolicyPage() {
  const { settings, patch, save, saving, loading, notice, dirty, savedAt, justSaved, discard } =
    usePolicySettings();
  const { confirm, dialog } = useConfirm();

  /** Turning a guard off asks first; turning it on doesn't. */
  async function setGuard(guard: GuardKey, next: boolean) {
    if (!next && !(await confirm({ ...guardOffConfirm(guard) }))) return;
    patch("features", guard === "groundOrRefuse" ? { groundOrRefuse: next } : { faithfulnessCheck: next });
  }

  return (
    <div className="w-full max-w-4xl">
      <PageHeader
        title="Retrieval policy"
        description="How the knowledge base is searched, and how strictly answers must be supported. Applies to every answer."
      />

      {!settings && notice?.tone === "danger" && (
        <Alert tone="danger" className="mb-4">
          {notice.message}
        </Alert>
      )}

      {loading ? (
        <PolicySkeleton />
      ) : settings ? (
        <>
          <div className="space-y-4 pb-4">
            <SectionCard
              icon={SearchCheck}
              title="Hybrid search"
              description="The balance between vector (meaning) and keyword (exact) search, and how many candidates to consider."
            >
              <SettingsList>
                <NumberField
                  label="Semantic weight"
                  hint="Vector / meaning influence (0–10)."
                  value={settings.retrieval.semanticWeight}
                  onChange={(v) => patch("retrieval", { semanticWeight: v })}
                  min={0}
                  max={10}
                  step={0.1}
                />
                <NumberField
                  label="Keyword weight"
                  hint="Full-text / exact influence (0–10)."
                  value={settings.retrieval.fullTextWeight}
                  onChange={(v) => patch("retrieval", { fullTextWeight: v })}
                  min={0}
                  max={10}
                  step={0.1}
                />
                <NumberField
                  label="Candidate pool (top-K)"
                  hint="Chunks pulled before reranking (10–200)."
                  value={settings.retrieval.matchCount}
                  onChange={(v) => patch("retrieval", { matchCount: v })}
                  min={10}
                  max={200}
                />
                <NumberField
                  label="Rerank top-N"
                  hint="Max sources kept for the answer (1–50)."
                  value={settings.retrieval.rerankTopN}
                  onChange={(v) => patch("retrieval", { rerankTopN: v })}
                  min={1}
                  max={50}
                />
                <NumberField
                  label="Rank-fusion k"
                  hint="Reciprocal rank fusion constant (1–1000)."
                  value={settings.retrieval.rrfK}
                  onChange={(v) => patch("retrieval", { rrfK: v })}
                  min={1}
                  max={1000}
                />
                <Toggle
                  label="Expand to parent chunks"
                  hint="Return the fuller surrounding section for each hit (more context)."
                  checked={settings.retrieval.expandParents}
                  onChange={(v) => patch("retrieval", { expandParents: v })}
                />
              </SettingsList>
            </SectionCard>

            <SectionCard
              icon={ShieldCheck}
              title="Accuracy and grounding guards"
              description="The stages that keep answers honest. Turning guards off trades safety for speed."
            >
              <SettingsList>
                <Toggle
                  label="Reranking"
                  hint={RERANK_HINT}
                  checked={settings.features.rerank}
                  onChange={(v) => patch("features", { rerank: v })}
                />
                <Toggle
                  label="Query rewriting"
                  hint="Distil the question into a clean search query before retrieval (better recall)."
                  checked={settings.features.queryRewrite}
                  onChange={(v) => patch("features", { queryRewrite: v })}
                />
                <Toggle
                  label="Contextual retrieval"
                  hint="Situate each chunk in its document before embedding. Applies on the next ingest."
                  checked={settings.features.contextualRetrieval}
                  onChange={(v) => patch("features", { contextualRetrieval: v })}
                />
                <Toggle
                  label="LLM source router"
                  hint="Use a model to pick which source types to search (off = fast keyword router)."
                  checked={settings.features.llmRouter}
                  onChange={(v) => patch("features", { llmRouter: v })}
                />
                <Toggle
                  label="Faithfulness check"
                  hint="Verify every claim is supported by context after generation (+1 LLM call)."
                  checked={settings.features.faithfulnessCheck}
                  onChange={(v) => void setGuard("faithfulnessCheck", v)}
                />
                <Toggle
                  label="Ground or refuse"
                  hint="Refuse (no model call) when retrieval finds nothing relevant. Guarantees no hallucination."
                  checked={settings.features.groundOrRefuse}
                  onChange={(v) => void setGuard("groundOrRefuse", v)}
                />
              </SettingsList>
            </SectionCard>
          </div>

          <SaveBar
            dirty={dirty}
            saving={saving}
            onSave={() => void save()}
            onDiscard={discard}
            savedAt={savedAt}
            justSaved={justSaved}
            error={notice?.tone === "danger" ? notice.message : null}
          />
        </>
      ) : null}

      {dialog}
    </div>
  );
}
