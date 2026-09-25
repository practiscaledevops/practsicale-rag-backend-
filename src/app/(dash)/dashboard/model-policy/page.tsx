"use client";

// Model policy (Governance) — org-wide model + generation policy: default tier,
// temperature ceiling, answer budget, and the cheap tier used for
// contextualization. Admin-only (the (dash) layout gates it; the settings API
// enforces the permission). Ordinary team users never see these controls.

import Link from "next/link";
import { Cpu, Sparkles } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Alert } from "@/components/ui/Alert";
import { SectionCard } from "@/components/ui/Card";
import {
  usePolicySettings,
  NumberField,
  TierSelect,
  SaveBar,
  SettingsList,
  PolicySkeleton,
} from "@/components/ui/policy";

const LINK = "font-medium text-accent-strong underline-offset-2 hover:underline";

export default function ModelPolicyPage() {
  const { settings, patch, save, saving, loading, notice, dirty, savedAt, justSaved, discard } =
    usePolicySettings();

  return (
    <div className="w-full max-w-4xl">
      <PageHeader
        title="Model policy"
        description="Which model tier answers each kind of request, and the limits that apply."
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
              icon={Sparkles}
              title="Default answer model"
              description="The tier used when a request doesn't pick one: Fast, Recommended or Max. The concrete model is resolved on the server."
            >
              <SettingsList>
                <TierSelect
                  label="Default tier"
                  hint="Recommended suits most orgs."
                  value={settings.generation.defaultTier}
                  onChange={(v) => patch("generation", { defaultTier: v })}
                />
                <NumberField
                  label="Temperature ceiling"
                  hint="0 = most faithful. Keep low for grounded answers (0–2)."
                  value={settings.generation.temperature}
                  onChange={(v) => patch("generation", { temperature: v })}
                  min={0}
                  max={2}
                  step={0.1}
                />
                <NumberField
                  label="Max answer tokens"
                  hint="Token budget for a single answer (128–8192)."
                  value={settings.generation.maxTokens}
                  onChange={(v) => patch("generation", { maxTokens: v })}
                  min={128}
                  max={8192}
                />
              </SettingsList>
            </SectionCard>

            <SectionCard
              icon={Cpu}
              title="Auxiliary models"
              description="The cheap tier used for background work: per-chunk contextualization at ingest, query rewriting and the free LLM reranker. Keep it on Fast to control cost."
            >
              <SettingsList>
                <TierSelect
                  label="Context and utility tier"
                  hint="Used for contextualization, rewriting and reranking."
                  value={settings.contextual.tier}
                  onChange={(v) => patch("contextual", { tier: v })}
                />
                <NumberField
                  label="Context concurrency"
                  hint="Parallel context calls at ingest (1–20)."
                  value={settings.contextual.concurrency}
                  onChange={(v) => patch("contextual", { concurrency: v })}
                  min={1}
                  max={20}
                />
                <NumberField
                  label="Max chunks per document"
                  hint="Skip contextualization above this (cost guard, 1–5000)."
                  value={settings.contextual.maxChunksPerDoc}
                  onChange={(v) => patch("contextual", { maxChunksPerDoc: v })}
                  min={1}
                  max={5000}
                />
              </SettingsList>
            </SectionCard>

            <p className="rounded-xl border border-border bg-surface-muted/50 px-4 py-3 text-[13px] text-muted-foreground">
              Provider API keys and embedding configuration live in{" "}
              <Link href="/dashboard/settings" className={LINK}>
                Settings
              </Link>
              ; per-model cost tracking is in{" "}
              <Link href="/dashboard/analytics" className={LINK}>
                Analytics
              </Link>
              . Per-key and per-app cost budgets are a planned addition.
            </p>
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
    </div>
  );
}
