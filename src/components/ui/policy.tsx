"use client";

// Shared controls + a load/save hook for the governance policy pages (Model
// policy, Retrieval policy). Both edit subsets of the org's RagSettings and PUT
// the FULL object back to /api/admin/settings (mergeSettings fills omissions from
// defaults, so a partial PUT would reset the rest — we always send everything).

import * as React from "react";
import { Loader2, Save } from "lucide-react";
import type { RagSettings } from "@/lib/settings";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Button } from "@/components/ui/Button";

export type Tier = "fast" | "recommended" | "max";
export type Notice = { tone: "success" | "danger"; message: string };

/** Load + edit + save the org's RagSettings from a client page. */
export function usePolicySettings() {
  const [settings, setSettings] = React.useState<RagSettings | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [notice, setNotice] = React.useState<Notice | null>(null);

  const load = React.useCallback(async () => {
    try {
      const res = await fetch("/api/admin/settings", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load settings");
      setSettings(json.settings as RagSettings);
    } catch (e) {
      setNotice({ tone: "danger", message: e instanceof Error ? e.message : "Failed to load settings" });
    } finally {
      setLoading(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
  }, [load]);

  const patch = React.useCallback(<K extends keyof RagSettings>(section: K, values: Partial<RagSettings[K]>) => {
    setSettings((s) => (s ? { ...s, [section]: { ...s[section], ...values } } : s));
  }, []);

  const save = React.useCallback(async () => {
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
      setNotice({ tone: "success", message: "Policy saved. Changes apply immediately, org-wide." });
    } catch (e) {
      setNotice({ tone: "danger", message: e instanceof Error ? e.message : "Failed to save" });
    } finally {
      setSaving(false);
    }
  }, [settings]);

  return { settings, patch, save, saving, loading, notice };
}

export function SaveButton({ onClick, saving, disabled }: { onClick: () => void; saving: boolean; disabled?: boolean }) {
  return (
    <Button onClick={onClick} disabled={saving || disabled}>
      {saving ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Save className="h-4 w-4" aria-hidden="true" />}
      {saving ? "Saving…" : "Save policy"}
    </Button>
  );
}

export function Toggle({ label, hint, checked, onChange }: { label: string; hint: string; checked: boolean; onChange: (v: boolean) => void }) {
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

export function NumberField({ label, hint, value, onChange, min, max, step }: { label: string; hint?: string; value: number; onChange: (v: number) => void; min?: number; max?: number; step?: number }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <Input type="number" value={Number.isFinite(value) ? value : 0} min={min} max={max} step={step ?? 1} onChange={(e) => onChange(Number(e.target.value))} />
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

const TIER_OPTIONS: { value: Tier; label: string }[] = [
  { value: "fast", label: "Fast" },
  { value: "recommended", label: "Balanced" },
  { value: "max", label: "Best quality" },
];

export function TierSelect({ label, hint, value, onChange }: { label: string; hint?: string; value: Tier; onChange: (v: Tier) => void }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as Tier)}
        className="flex h-10 w-full rounded-lg border border-border bg-surface px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        {TIER_OPTIONS.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}
