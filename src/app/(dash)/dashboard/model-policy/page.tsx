"use client";

// Model policy (Governance) — org-wide model + generation policy: default tier,
// temperature ceiling, answer budget, and the cheap tier used for
// contextualization. Admin-only (the (dash) layout gates it; the settings API
// enforces the permission). Ordinary team users never see these controls.

import { Loader2 } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Alert } from "@/components/ui/Alert";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/Card";
import { usePolicySettings, SaveButton, NumberField, TierSelect } from "@/components/ui/policy";

export default function ModelPolicyPage() {
  const { settings, patch, save, saving, loading, notice } = usePolicySettings();

  return (
    <div>
      <PageHeader
        title="Model policy"
        description="Org-wide model and generation policy. These are administrator controls — they apply to every answer and every app, and ordinary team members can't change them."
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
              <CardTitle>Default answer model</CardTitle>
              <CardDescription>
                The tier used when a request doesn&apos;t pick one. Friendly labels map to Fast /
                Balanced / Best quality; the concrete model is resolved server-side.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <TierSelect label="Default tier" hint="Balanced is recommended for most orgs." value={settings.generation.defaultTier} onChange={(v) => patch("generation", { defaultTier: v })} />
              <NumberField label="Temperature ceiling" hint="0 = most faithful. Keep low for grounded answers." value={settings.generation.temperature} onChange={(v) => patch("generation", { temperature: v })} min={0} max={2} step={0.1} />
              <NumberField label="Max answer tokens" hint="Context budget for a single answer (128–8192)." value={settings.generation.maxTokens} onChange={(v) => patch("generation", { maxTokens: v })} min={128} max={8192} />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Auxiliary models</CardTitle>
              <CardDescription>
                The cheap tier used for background work (per-chunk contextualization at ingest, query
                rewriting, and the free LLM reranker). Keep this on the Fast tier to control cost.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <TierSelect label="Context / utility tier" hint="Used for contextualization + rewrite + rerank." value={settings.contextual.tier} onChange={(v) => patch("contextual", { tier: v })} />
              <NumberField label="Context concurrency" hint="Parallel context calls at ingest (1–20)." value={settings.contextual.concurrency} onChange={(v) => patch("contextual", { concurrency: v })} min={1} max={20} />
              <NumberField label="Max chunks / document" hint="Skip contextualization above this (cost guard)." value={settings.contextual.maxChunksPerDoc} onChange={(v) => patch("contextual", { maxChunksPerDoc: v })} min={1} max={5000} />
            </CardContent>
          </Card>

          <Card className="lg:col-span-2">
            <CardContent className="p-5">
              <p className="text-sm text-muted-foreground">
                Provider API keys, embedding-model configuration, and per-model cost tracking live under{" "}
                <a href="/dashboard/settings" className="text-accent hover:underline">Settings</a> and{" "}
                <a href="/dashboard/analytics" className="text-accent hover:underline">Analytics</a>. Per-key and
                per-app cost budgets are a planned addition.
              </p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
