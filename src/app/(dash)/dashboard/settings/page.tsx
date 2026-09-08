"use client";

// Settings — the RAG pipeline control panel. Every knob that shapes retrieval,
// generation, and the anti-hallucination guards lives here and is persisted to
// the database (app_settings), so changing behaviour never needs a redeploy.
//
// Client Component: all data access goes through /api/admin/settings, which
// resolves org_id server-side and enforces the admin's `settings` permission.

import * as React from "react";
import { Loader2, Save, RotateCcw } from "lucide-react";
import type { RagSettings } from "@/lib/settings";
import { PageHeader } from "@/components/ui/PageHeader";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Alert } from "@/components/ui/Alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/Card";

type Notice = { tone: "success" | "danger"; message: string };
type Tier = "fast" | "recommended" | "max";

/** A labelled on/off row. */
function Toggle({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="flex items-start justify-between gap-4 py-2.5">
      <span className="min-w-0">
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted-foreground">{hint}</span>
      </span>
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="mt-1 h-4 w-4 shrink-0 rounded border-border accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
    </label>
  );
}

/** A labelled numeric field. */
function NumberField({
  label,
  hint,
  value,
  onChange,
  min,
  max,
  step,
}: {
  label: string;
  hint?: string;
  value: number;
  onChange: (v: number) => void;
  min?: number;
  max?: number;
  step?: number;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input
        type="number"
        value={Number.isFinite(value) ? value : 0}
        min={min}
        max={max}
        step={step ?? 1}
        onChange={(e) => onChange(Number(e.target.value))}
      />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

const TIER_OPTIONS: { value: Tier; label: string }[] = [
  { value: "fast", label: "Fast" },
  { value: "recommended", label: "Recommended" },
  { value: "max", label: "Max" },
];

function TierSelect({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: Tier;
  onChange: (v: Tier) => void;
}) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as Tier)}
        className="flex h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {TIER_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export default function SettingsPage() {
  const [settings, setSettings] = React.useState<RagSettings | null>(null);
  const [defaults, setDefaults] = React.useState<RagSettings | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<Notice | null>(null);
  const [updatedAt, setUpdatedAt] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/admin/settings", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load settings");
      setSettings(json.settings as RagSettings);
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

  return (
    <div>
      <PageHeader
        title="Settings"
        description="Tune the RAG pipeline — retrieval, generation, and the anti-hallucination guards. Stored in the database; changes apply live, no redeploy."
        actions={
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={resetDefaults} disabled={loading || saving}>
              <RotateCcw className="h-4 w-4" aria-hidden="true" />
              Reset to defaults
            </Button>
            <Button onClick={save} disabled={loading || saving || !settings}>
              {saving ? (
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              ) : (
                <Save className="h-4 w-4" aria-hidden="true" />
              )}
              {saving ? "Saving…" : "Save changes"}
            </Button>
          </div>
        }
      />

      {notice && (
        <Alert tone={notice.tone} className="mb-4">
          {notice.message}
        </Alert>
      )}
      {error && (
        <Alert tone="danger" className="mb-4">
          {error}
        </Alert>
      )}
      {updatedAt && (
        <p className="mb-4 text-xs text-muted-foreground">
          Last saved {new Date(updatedAt).toLocaleString()}.
        </p>
      )}

      <div className="mb-6">
        <ProvidersCard />
      </div>

      {loading || !settings ? (
        <div className="flex items-center gap-2 py-16 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
          Loading settings…
        </div>
      ) : (
        <div className="grid gap-6 lg:grid-cols-2">
          {/* Features / guards */}
          <Card>
            <CardHeader>
              <CardTitle>Pipeline features</CardTitle>
              <CardDescription>
                Turn the accuracy and anti-hallucination stages on or off.
              </CardDescription>
            </CardHeader>
            <CardContent className="divide-y divide-border">
              <Toggle
                label="Query rewriting"
                hint="Rewrite the question into a standalone search query before retrieval (recall ↑)."
                checked={settings.features.queryRewrite}
                onChange={(v) => patch("features", { queryRewrite: v })}
              />
              <Toggle
                label="Contextual retrieval"
                hint="Situate each chunk in its document before embedding (Anthropic technique). Applies on next ingest/re-ingest."
                checked={settings.features.contextualRetrieval}
                onChange={(v) => patch("features", { contextualRetrieval: v })}
              />
              <Toggle
                label="Reranking (Cohere)"
                hint="Cross-encoder reorders candidates. No-op without a Cohere key."
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
                onChange={(v) => patch("features", { faithfulnessCheck: v })}
              />
              <Toggle
                label="Ground or refuse"
                hint="Refuse (no model call) when retrieval finds nothing relevant. Guarantees no hallucination."
                checked={settings.features.groundOrRefuse}
                onChange={(v) => patch("features", { groundOrRefuse: v })}
              />
            </CardContent>
          </Card>

          {/* Retrieval */}
          <Card>
            <CardHeader>
              <CardTitle>Retrieval</CardTitle>
              <CardDescription>Hybrid search + reranking parameters.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
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
                value={settings.retrieval.fullTextWeight}
                onChange={(v) => patch("retrieval", { fullTextWeight: v })}
                min={0}
                max={10}
                step={0.1}
              />
              <NumberField
                label="Semantic weight"
                value={settings.retrieval.semanticWeight}
                onChange={(v) => patch("retrieval", { semanticWeight: v })}
                min={0}
                max={10}
                step={0.1}
              />
              <NumberField
                label="RRF k"
                hint="Rank-fusion constant."
                value={settings.retrieval.rrfK}
                onChange={(v) => patch("retrieval", { rrfK: v })}
                min={1}
                max={1000}
              />
              <div className="sm:col-span-2">
                <Toggle
                  label="Expand to parent chunks"
                  hint="Return the fuller parent section for each hit."
                  checked={settings.retrieval.expandParents}
                  onChange={(v) => patch("retrieval", { expandParents: v })}
                />
              </div>
            </CardContent>
          </Card>

          {/* Generation */}
          <Card>
            <CardHeader>
              <CardTitle>Generation</CardTitle>
              <CardDescription>How the grounded answer is produced.</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <TierSelect
                label="Default tier"
                hint="Used when a request doesn't specify one."
                value={settings.generation.defaultTier}
                onChange={(v) => patch("generation", { defaultTier: v })}
              />
              <NumberField
                label="Temperature"
                hint="0 = most faithful."
                value={settings.generation.temperature}
                onChange={(v) => patch("generation", { temperature: v })}
                min={0}
                max={2}
                step={0.1}
              />
              <NumberField
                label="Max answer tokens"
                value={settings.generation.maxTokens}
                onChange={(v) => patch("generation", { maxTokens: v })}
                min={128}
                max={8192}
              />
            </CardContent>
          </Card>

          {/* Contextual retrieval cost controls */}
          <Card>
            <CardHeader>
              <CardTitle>Contextual retrieval</CardTitle>
              <CardDescription>
                Cost controls for per-chunk context generation at ingest.
              </CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <TierSelect
                label="Context model tier"
                hint="Cheap tier is recommended."
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
                label="Max chunks / document"
                hint="Skip context generation above this (cost guard)."
                value={settings.contextual.maxChunksPerDoc}
                onChange={(v) => patch("contextual", { maxChunksPerDoc: v })}
                min={1}
                max={5000}
              />
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Provider API keys — set/rotate OpenAI, Anthropic, Cohere from the dashboard.
// Secrets are write-only: the server returns only a masked status.
// ---------------------------------------------------------------------------

interface ProviderStatus {
  provider: "openai" | "anthropic" | "cohere";
  configured: boolean;
  source: "db" | "env" | "none";
  last4: string | null;
  updatedAt: string | null;
}

const PROVIDER_LABELS: Record<string, { label: string; hint: string }> = {
  openai: { label: "OpenAI", hint: "Embeddings (semantic search). Required for full hybrid retrieval." },
  anthropic: { label: "Anthropic", hint: "Claude generation + query rewrite / contextual / faithfulness." },
  cohere: { label: "Cohere", hint: "Reranking (optional). Improves top-k ordering." },
};

function ProvidersCard() {
  const [rows, setRows] = React.useState<ProviderStatus[] | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [drafts, setDrafts] = React.useState<Record<string, string>>({});
  const [busy, setBusy] = React.useState<string | null>(null);
  const [notice, setNotice] = React.useState<string | null>(null);

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

  return (
    <Card>
      <CardHeader>
        <CardTitle>Provider API keys</CardTitle>
        <CardDescription>
          Set or rotate the model-provider keys without a redeploy. Stored encrypted; a key set here
          overrides the environment variable. Super-admin only.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {notice && <Alert tone="success">{notice}</Alert>}
        {error && <Alert tone="danger">{error}</Alert>}
        {rows === null ? (
          <div className="flex items-center gap-2 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading…
          </div>
        ) : (
          <div className="space-y-4">
            {rows.map((r) => {
              const meta = PROVIDER_LABELS[r.provider] ?? { label: r.provider, hint: "" };
              return (
                <div key={r.provider} className="rounded-lg border border-border p-3">
                  <div className="mb-2 flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-medium">{meta.label}</span>
                        {r.configured ? (
                          <span className="rounded-full bg-success/15 px-2 py-0.5 text-xs font-medium text-success">
                            {r.source === "db" ? "set" : "from env"}
                            {r.last4 ? ` · ••••${r.last4}` : ""}
                          </span>
                        ) : (
                          <span className="rounded-full bg-surface-muted px-2 py-0.5 text-xs text-muted-foreground">
                            not set
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">{meta.hint}</p>
                    </div>
                    {r.source === "db" && (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => clearKey(r.provider)}
                        disabled={busy === r.provider}
                      >
                        Clear
                      </Button>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <Input
                      type="password"
                      autoComplete="off"
                      placeholder={r.configured ? "Enter a new key to rotate…" : "Paste API key…"}
                      value={drafts[r.provider] ?? ""}
                      onChange={(e) => setDrafts((d) => ({ ...d, [r.provider]: e.target.value }))}
                    />
                    <Button
                      onClick={() => save(r.provider)}
                      disabled={busy === r.provider || !(drafts[r.provider] ?? "").trim()}
                    >
                      {busy === r.provider ? (
                        <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                      ) : (
                        <Save className="h-4 w-4" aria-hidden="true" />
                      )}
                      Save
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
