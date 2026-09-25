"use client";

// Settings — the RAG pipeline control panel. Every knob that shapes retrieval,
// generation, and the anti-hallucination guards lives here and is persisted to
// the database (app_settings), so changing behaviour never needs a redeploy.
//
// Client Component: all data access goes through /api/admin/settings, which
// resolves org_id server-side and enforces the admin's `settings` permission.

import * as React from "react";
import { KeyRound, Layers, RotateCcw, SearchCheck, ShieldCheck, Sparkles } from "lucide-react";
import type { RagSettings } from "@/lib/settings";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Alert } from "@/components/ui/Alert";
import { Badge, Tag } from "@/components/ui/Badge";
import { SectionCard } from "@/components/ui/Card";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { Skeleton } from "@/components/ui/Loading";
import {
  NumberField,
  PolicySkeleton,
  RERANK_HINT,
  SaveBar,
  SettingsList,
  TierSelect,
  Toggle,
  guardOffConfirm,
  sameSettings,
  type GuardKey,
} from "@/components/ui/policy";

type Notice = { tone: "success" | "danger"; message: string };

export default function SettingsPage() {
  const [settings, setSettings] = React.useState<RagSettings | null>(null);
  const [defaults, setDefaults] = React.useState<RagSettings | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<Notice | null>(null);
  const [updatedAt, setUpdatedAt] = React.useState<string | null>(null);
  // UI-only: the last loaded/saved settings, for the save bar's dirty state
  // and Discard. It never changes what is fetched or sent.
  const [snapshot, setSnapshot] = React.useState<RagSettings | null>(null);
  const { confirm, dialog } = useConfirm();

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/settings", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load settings");
      setSettings(json.settings as RagSettings);
      setSnapshot(json.settings as RagSettings);
      setDefaults(json.defaults as RagSettings);
      setUpdatedAt(json.updatedAt ?? null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load settings");
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  function patch<K extends keyof RagSettings>(section: K, values: Partial<RagSettings[K]>) {
    setSettings((s) => (s ? { ...s, [section]: { ...s[section], ...values } } : s));
  }

  async function save() {
    if (!settings) return;
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/settings", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ settings }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to save");
      setSettings(json.settings as RagSettings);
      setSnapshot(json.settings as RagSettings);
      setUpdatedAt(new Date().toISOString());
      setNotice({ tone: "success", message: "Settings saved. Changes apply immediately." });
    } catch (e) {
      setNotice({ tone: "danger", message: e instanceof Error ? e.message : "Failed to save" });
    } finally {
      setSaving(false);
    }
  }

  function resetDefaults() {
    if (defaults) setSettings(structuredClone(defaults));
  }

  async function confirmResetDefaults() {
    const ok = await confirm({
      title: "Reset to defaults?",
      description:
        "Every pipeline setting on this page goes back to its default. Nothing changes for anyone until you save.",
      tone: "danger",
      confirmLabel: "Reset",
    });
    if (ok) resetDefaults();
  }

  /** Turning a guard off asks first; turning it on doesn't. */
  async function setGuard(guard: GuardKey, next: boolean) {
    if (!next && !(await confirm({ ...guardOffConfirm(guard) }))) return;
    patch("features", guard === "groundOrRefuse" ? { groundOrRefuse: next } : { faithfulnessCheck: next });
  }

  const dirty = settings !== null && snapshot !== null && !sameSettings(settings, snapshot);

  function discard() {
    if (snapshot) setSettings(snapshot);
    setNotice(null);
  }

  return (
    <div className="w-full max-w-4xl">
      <PageHeader
        title="Settings"
        description="Workspace-wide pipeline settings and provider keys."
        actions={
          <Button
            variant="secondary"
            size="toolbar"
            onClick={() => void confirmResetDefaults()}
            disabled={loading || saving}
          >
            <RotateCcw size={14} aria-hidden />
            Reset to defaults
          </Button>
        }
      />

      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}

      <div className="space-y-4">
        {loading ? (
          <PolicySkeleton cards={3} />
        ) : settings ? (
          // The save bar sticks while this pipeline column is on screen and
          // stops above Providers, whose keys save on their own.
          <div>
            <div className="space-y-4 pb-4">
              <SectionCard
                icon={ShieldCheck}
                title="Pipeline features"
                description="Turn the accuracy and anti-hallucination stages on or off."
              >
                <SettingsList>
                  <Toggle
                    label="Query rewriting"
                    hint="Rewrite the question into a standalone search query before retrieval (better recall)."
                    checked={settings.features.queryRewrite}
                    onChange={(v) => patch("features", { queryRewrite: v })}
                  />
                  <Toggle
                    label="Contextual retrieval"
                    hint="Situate each chunk in its document before embedding (Anthropic technique). Applies on the next ingest or re-ingest."
                    checked={settings.features.contextualRetrieval}
                    onChange={(v) => patch("features", { contextualRetrieval: v })}
                  />
                  <Toggle
                    label="Reranking"
                    hint={RERANK_HINT}
                    checked={settings.features.rerank}
                    onChange={(v) => patch("features", { rerank: v })}
                  />
                  <Toggle
                    label="LLM source router"
                    hint="Use a model to pick source types (off = fast keyword router)."
                    checked={settings.features.llmRouter}
                    onChange={(v) => patch("features", { llmRouter: v })}
                  />
                  <Toggle
                    label="Faithfulness check"
                    hint="Verify every claim is supported by context after generation."
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

              <SectionCard icon={SearchCheck} title="Retrieval" description="Hybrid search and reranking parameters.">
                <SettingsList>
                  <NumberField
                    label="Candidate pool"
                    hint="Chunks pulled before reranking (10–200)."
                    value={settings.retrieval.matchCount}
                    onChange={(v) => patch("retrieval", { matchCount: v })}
                    min={10}
                    max={200}
                  />
                  <NumberField
                    label="Rerank top-N"
                    hint="Chunks kept for the answer (1–50)."
                    value={settings.retrieval.rerankTopN}
                    onChange={(v) => patch("retrieval", { rerankTopN: v })}
                    min={1}
                    max={50}
                  />
                  <NumberField
                    label="Full-text weight"
                    hint="Keyword / exact-match influence (0–10)."
                    value={settings.retrieval.fullTextWeight}
                    onChange={(v) => patch("retrieval", { fullTextWeight: v })}
                    min={0}
                    max={10}
                    step={0.1}
                  />
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
                    label="RRF k"
                    hint="Rank-fusion constant (1–1000)."
                    value={settings.retrieval.rrfK}
                    onChange={(v) => patch("retrieval", { rrfK: v })}
                    min={1}
                    max={1000}
                  />
                  <Toggle
                    label="Expand to parent chunks"
                    hint="Return the fuller parent section for each hit."
                    checked={settings.retrieval.expandParents}
                    onChange={(v) => patch("retrieval", { expandParents: v })}
                  />
                </SettingsList>
              </SectionCard>

              <SectionCard icon={Sparkles} title="Generation" description="How the grounded answer is produced.">
                <SettingsList>
                  <TierSelect
                    label="Default tier"
                    hint="Used when a request doesn't specify one."
                    value={settings.generation.defaultTier}
                    onChange={(v) => patch("generation", { defaultTier: v })}
                  />
                  <NumberField
                    label="Temperature"
                    hint="0 = most faithful (0–2)."
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
                icon={Layers}
                title="Contextual retrieval"
                description="Cost controls for per-chunk context generation at ingest."
              >
                <SettingsList>
                  <TierSelect
                    label="Context model tier"
                    hint="The cheap tier is recommended."
                    value={settings.contextual.tier}
                    onChange={(v) => patch("contextual", { tier: v })}
                  />
                  <NumberField
                    label="Concurrency"
                    hint="Parallel context calls (1–20)."
                    value={settings.contextual.concurrency}
                    onChange={(v) => patch("contextual", { concurrency: v })}
                    min={1}
                    max={20}
                  />
                  <NumberField
                    label="Max chunks per document"
                    hint="Skip context generation above this (cost guard, 1–5000)."
                    value={settings.contextual.maxChunksPerDoc}
                    onChange={(v) => patch("contextual", { maxChunksPerDoc: v })}
                    min={1}
                    max={5000}
                  />
                </SettingsList>
              </SectionCard>
            </div>

            <SaveBar
              dirty={dirty}
              saving={saving}
              onSave={() => void save()}
              onDiscard={discard}
              savedAt={updatedAt}
              justSaved={notice?.tone === "success" && !dirty}
              error={notice?.tone === "danger" ? notice.message : null}
            />
          </div>
        ) : null}

        <ProvidersCard />
      </div>

      {dialog}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provider API keys — set/rotate OpenAI, Anthropic, Cohere, Exa from the dashboard.
// Secrets are write-only: the server returns only a masked status.
// ---------------------------------------------------------------------------

interface ProviderStatus {
  provider: "openai" | "anthropic" | "cohere" | "exa";
  configured: boolean;
  source: "db" | "env" | "none";
  last4: string | null;
  updatedAt: string | null;
}

const PROVIDER_LABELS: Record<string, { label: string; hint: string }> = {
  openai: { label: "OpenAI", hint: "Embeddings (semantic search). Required for full hybrid retrieval." },
  anthropic: { label: "Anthropic", hint: "Claude generation + query rewrite / contextual / faithfulness." },
  cohere: { label: "Cohere", hint: "Reranking (optional). Improves top-k ordering." },
  exa: { label: "Exa", hint: "Link capture (optional). Reads YouTube transcripts from the server, social posts and blocked pages." },
};

function ProvidersCard() {
  const [rows, setRows] = React.useState<ProviderStatus[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);
  const { confirm, dialog } = useConfirm();

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/providers", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load providers");
      setRows(json.providers as ProviderStatus[]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load providers");
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  async function save(provider: string) {
    const secret = (drafts[provider] ?? "").trim();
    if (!secret) return;
    setBusy(provider);
    setNotice(null);
    try {
      const res = await fetch("/api/admin/providers", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ provider, secret }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Save failed");
      setRows(json.providers as ProviderStatus[]);
      setDrafts((d) => ({ ...d, [provider]: "" }));
      setNotice(`${PROVIDER_LABELS[provider]?.label ?? provider} key saved. Applies within ~30s.`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(null);
    }
  }

  async function clearKey(provider: string) {
    setBusy(provider);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/providers?provider=${encodeURIComponent(provider)}`, {
        method: "DELETE",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Clear failed");
      setRows(json.providers as ProviderStatus[]);
      setNotice(`${PROVIDER_LABELS[provider]?.label ?? provider} key cleared (falls back to env if set).`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Clear failed");
    } finally {
      setBusy(null);
    }
  }

  async function confirmClear(provider: string) {
    const label = PROVIDER_LABELS[provider]?.label ?? provider;
    const ok = await confirm({
      title: `Remove the saved ${label} key?`,
      description: "The Brain falls back to the environment variable if one is set; otherwise features that need this provider stop working.",
      tone: "danger",
      confirmLabel: "Remove key",
    });
    if (ok) await clearKey(provider);
  }

  return (
    <SectionCard
      icon={KeyRound}
      title="Provider API keys"
      description="Set or rotate the model-provider keys without a redeploy. Stored encrypted; a key set here overrides the environment variable. Super-admin only. Key changes save immediately, separately from the save bar."
      bodyClassName="space-y-3"
    >
      {notice && <Alert tone="success">{notice}</Alert>}
      {error && <Alert tone="danger">{error}</Alert>}
      {rows === null ? (
        error ? null : (
          <div role="status" className="space-y-2">
            <span className="sr-only">Loading providers…</span>
            <Skeleton className="h-14 rounded-xl" />
            <Skeleton className="h-14 rounded-xl" />
          </div>
        )
      ) : (
        <div className="divide-y divide-border overflow-hidden rounded-xl border border-border">
          {rows.map((r) => {
            const meta = PROVIDER_LABELS[r.provider] ?? { label: r.provider, hint: "" };
            const inputId = `provider-key-${r.provider}`;
            const draft = drafts[r.provider] ?? "";
            const isBusy = busy === r.provider;
            return (
              <div
                key={r.provider}
                className="flex flex-wrap items-center justify-between gap-3 bg-surface px-3 py-2.5"
              >
                <div className="min-w-0 flex-1 basis-60">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="text-[13px] font-medium text-foreground">{meta.label}</span>
                    {r.configured ? (
                      <>
                        <Badge tone="success">Configured</Badge>
                        <Tag>{r.source === "db" ? "Saved" : "From env"}</Tag>
                        {r.last4 && <Tag className="font-mono">••••{r.last4}</Tag>}
                      </>
                    ) : (
                      <Badge tone="neutral">Not set</Badge>
                    )}
                  </div>
                  {meta.hint && <p className="mt-0.5 text-xs text-muted-foreground">{meta.hint}</p>}
                </div>

                <div className="flex w-full items-center gap-2 sm:w-auto">
                  <label htmlFor={inputId} className="sr-only">
                    {`API key for ${meta.label}`}
                  </label>
                  <Input
                    id={inputId}
                    type="password"
                    density="compact"
                    autoComplete="off"
                    placeholder={r.configured ? "Enter a new key to rotate…" : "Paste API key…"}
                    value={draft}
                    onChange={(e) => setDrafts((d) => ({ ...d, [r.provider]: e.target.value }))}
                    className="min-w-0 flex-1 sm:w-60 sm:flex-none"
                  />
                  <Button
                    variant="secondary"
                    size="toolbar"
                    onClick={() => void save(r.provider)}
                    disabled={isBusy || !draft.trim()}
                    loading={isBusy && draft.trim() !== ""}
                  >
                    Save
                  </Button>
                  {r.source === "db" && (
                    <Button
                      variant="ghost"
                      size="toolbar"
                      onClick={() => void confirmClear(r.provider)}
                      disabled={isBusy}
                    >
                      Clear
                    </Button>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {dialog}
    </SectionCard>
  );
}
