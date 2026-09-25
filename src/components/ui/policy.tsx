"use client";

// Shared controls + a load/save hook for the governance policy pages (Model
// policy, Retrieval policy; Settings reuses the controls). Both policy pages
// edit subsets of the org's RagSettings and PUT the FULL object back to
// /api/admin/settings (mergeSettings fills omissions from defaults, so a
// partial PUT would reset the rest — we always send everything).

import * as React from "react";
import { Check, RotateCcw, Save } from "lucide-react";
import type { RagSettings } from "@/lib/settings";
import { cn } from "@/lib/utils";
import { fmtDateTime, relTime } from "@/lib/format";
import { TIER_HINTS, TIER_LABELS, type Tier as TierKey } from "@/lib/ui-labels";
import { Button } from "@/components/ui/Button";
import { Select } from "@/components/ui/Select";
import { SwitchRow } from "@/components/ui/Switch";
import { Skeleton } from "@/components/ui/Loading";
import type { ConfirmOptions } from "@/components/ui/ConfirmDialog";

export type Tier = TierKey;
export type Notice = { tone: "success" | "danger"; message: string };

/** Load + edit + save the org's RagSettings from a client page. */
export function usePolicySettings() {
  const [settings, setSettings] = React.useState<RagSettings | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [saving, setSaving] = React.useState(false);
  const [notice, setNotice] = React.useState<Notice | null>(null);
  // UI-only: the last loaded/saved settings (dirty tracking + Discard) and when
  // they were saved. Neither changes what is fetched or sent.
  const [snapshot, setSnapshot] = React.useState<RagSettings | null>(null);
  const [savedAt, setSavedAt] = React.useState<string | null>(null);

  const load = React.useCallback(async () => {
    try {
      const res = await fetch("/api/admin/settings", { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to load settings");
      setSettings(json.settings as RagSettings);
      setSnapshot(json.settings as RagSettings);
      setSavedAt(typeof json.updatedAt === "string" ? json.updatedAt : null);
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
      setSnapshot(json.settings as RagSettings);
      setSavedAt(new Date().toISOString());
      setNotice({ tone: "success", message: "Policy saved. Changes apply immediately, org-wide." });
    } catch (e) {
      setNotice({ tone: "danger", message: e instanceof Error ? e.message : "Failed to save" });
    } finally {
      setSaving(false);
    }
  }, [settings]);

  const dirty = React.useMemo(
    () => settings !== null && snapshot !== null && !sameSettings(settings, snapshot),
    [settings, snapshot]
  );

  /** Restore the last loaded/saved settings (UI state only). */
  const discard = React.useCallback(() => {
    if (snapshot) setSettings(snapshot);
    setNotice(null);
  }, [snapshot]);

  const justSaved = notice?.tone === "success" && !dirty;

  return { settings, patch, save, saving, loading, notice, dirty, savedAt, justSaved, discard };
}

/** Snapshot compare for RagSettings (plain JSON data; patches keep key order). */
export function sameSettings(a: RagSettings | null, b: RagSettings | null): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

// ---------------------------------------------------------------------------
// Shared copy
// ---------------------------------------------------------------------------

/** One reranking help text for Retrieval policy and Settings. */
export const RERANK_HINT =
  "Reorders the top results before answering. Uses the built-in LLM reranker, or Cohere when a Cohere key is set.";

/** The anti-hallucination guards whose switch-off asks for confirmation. */
export type GuardKey = "groundOrRefuse" | "faithfulnessCheck";

const GUARD_OFF: Record<GuardKey, { name: string; effect: string }> = {
  groundOrRefuse: {
    name: "ground or refuse",
    effect:
      "The Brain will answer even when retrieval finds nothing relevant, so answers may include claims the knowledge base doesn't support.",
  },
  faithfulnessCheck: {
    name: "the faithfulness check",
    effect:
      "Answers will no longer be checked against their sources after generation, so unsupported claims may get through.",
  },
};

/** useConfirm() options for turning a guard OFF (turning one on needs no confirmation). */
export function guardOffConfirm(guard: GuardKey): ConfirmOptions {
  const g = GUARD_OFF[guard];
  return {
    title: `Turn off ${g.name}?`,
    description: `${g.effect} This applies to every answer, org-wide, once you save.`,
    confirmLabel: "Turn off",
    tone: "danger",
  };
}

// ---------------------------------------------------------------------------
// Settings rows
// ---------------------------------------------------------------------------

/** A settings list group: hairline-divided rows in one rounded border. */
export function SettingsList({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className={cn("divide-y divide-border overflow-hidden rounded-xl border border-border", className)}>
      {children}
    </div>
  );
}

/**
 * One settings row (the chatbot's LimitRow): label and hint on the left, the
 * control on the right. Stacks below `sm` so the hint isn't squeezed.
 */
export function SettingRow({
  htmlFor,
  label,
  hint,
  hintId,
  children,
}: {
  /** The control's id (binds the label). */
  htmlFor: string;
  label: React.ReactNode;
  hint?: React.ReactNode;
  hintId?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2 bg-surface px-3 py-2.5 sm:flex-row sm:items-center sm:justify-between sm:gap-4">
      <div className="min-w-0">
        <label htmlFor={htmlFor} className="text-[13px] font-medium text-foreground">
          {label}
        </label>
        {hint && (
          <div id={hintId} className="mt-0.5 text-xs text-muted-foreground">
            {hint}
          </div>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** An on/off setting: a role="switch" row (label bound via aria-labelledby). Use inside SettingsList. */
export function Toggle({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <SwitchRow
      title={label}
      hint={hint}
      checked={checked}
      onChange={onChange}
      disabled={disabled}
      className="rounded-none border-0 bg-surface"
    />
  );
}

/**
 * A bounded number setting (the chatbot's affixed number field). Keeps a local
 * draft so the admin can type freely: only an in-range value is reported while
 * typing, and blur snaps the draft into range. The server clamps again on save.
 */
export function NumberField({
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
  const id = React.useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const shown = Number.isFinite(value) ? value : 0;
  const [draft, setDraft] = React.useState(String(shown));

  // Follow outside changes (Discard, the server-normalized value after Save)
  // without clobbering a draft that already means the same number.
  React.useEffect(() => {
    setDraft((d) => (d.trim() !== "" && Number(d) === shown ? d : String(shown)));
  }, [shown]);

  const lo = min ?? Number.NEGATIVE_INFINITY;
  const hi = max ?? Number.POSITIVE_INFINITY;
  const inRange = (n: number) => Number.isFinite(n) && n >= lo && n <= hi;

  function commit(raw: string) {
    const n = Number(raw);
    const next = raw.trim() === "" || !Number.isFinite(n) ? shown : Math.min(hi, Math.max(lo, n));
    setDraft(String(next));
    if (next !== value) onChange(next);
  }

  const stepValue = step ?? 1;

  return (
    <SettingRow htmlFor={id} label={label} hint={hint} hintId={hintId}>
      <div className="inline-flex h-8 items-center gap-1.5 rounded-xl border border-border bg-surface px-2.5 transition-colors focus-within:border-accent focus-within:ring-2 focus-within:ring-ring/30">
        <input
          id={id}
          type="number"
          inputMode={Number.isInteger(stepValue) ? "numeric" : "decimal"}
          min={min}
          max={max}
          step={stepValue}
          aria-describedby={hintId}
          value={draft}
          onChange={(e) => {
            const raw = e.target.value;
            setDraft(raw);
            const n = Number(raw);
            if (raw.trim() !== "" && inRange(n) && n !== value) onChange(n);
          }}
          onBlur={(e) => commit(e.target.value)}
          className="w-16 bg-transparent text-right text-[13px] tabular-nums text-foreground outline-none focus-visible:outline-none"
        />
      </div>
    </SettingRow>
  );
}

const TIER_ORDER: Tier[] = ["fast", "recommended", "max"];
const TIER_OPTIONS = TIER_ORDER.map((t) => ({ value: t, label: TIER_LABELS[t] }));

/** A model-tier setting: Fast / Recommended / Max, with the chosen tier's hint. */
export function TierSelect({
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
  const id = React.useId();
  const hintId = `${id}-hint`;
  const tierHint = TIER_HINTS[value];
  return (
    <SettingRow
      htmlFor={id}
      label={label}
      hintId={hintId}
      hint={
        <>
          {hint && <p>{hint}</p>}
          {tierHint && (
            <p>
              {TIER_LABELS[value]}: {tierHint.charAt(0).toLowerCase() + tierHint.slice(1)}
            </p>
          )}
        </>
      }
    >
      <Select
        id={id}
        density="compact"
        aria-describedby={hintId}
        value={value}
        onChange={(e) => onChange(e.target.value as Tier)}
        options={TIER_OPTIONS}
        className="sm:w-44"
      />
    </SettingRow>
  );
}

// ---------------------------------------------------------------------------
// Saving
// ---------------------------------------------------------------------------

export function SaveButton({ onClick, saving, disabled }: { onClick: () => void; saving: boolean; disabled?: boolean }) {
  return (
    <Button size="toolbar" onClick={onClick} disabled={disabled} loading={saving}>
      {!saving && <Save size={14} aria-hidden />}
      {saving ? "Saving…" : "Save policy"}
    </Button>
  );
}

export interface SaveBarProps {
  dirty: boolean;
  saving: boolean;
  onSave: () => void;
  /** Shows a Discard button that restores the last saved state. */
  onDiscard?: () => void;
  /** When the settings were last saved (ISO), for "Last saved 3h ago". */
  savedAt?: string | null;
  /** Show "Saved" (right after a successful save). */
  justSaved?: boolean;
  /** A failed save, shown in the bar (role="alert"). */
  error?: string | null;
  /** Idle status text, in place of "Last saved …". */
  message?: React.ReactNode;
  saveLabel?: string;
}

/**
 * The shell of a sticky bottom action bar (SaveBar, the Add-knowledge review):
 * a floating pill that sticks to the bottom of the scroll area. Put the status
 * and the actions inside; width and border overrides go through className.
 */
export function StickyActionBar({ className, children }: { className?: string; children: React.ReactNode }) {
  return (
    <div className="pointer-events-none sticky bottom-0 z-20 -mx-4 px-4 pb-4 sm:-mx-6 sm:px-6">
      <div
        className={cn(
          "pointer-events-auto mx-auto flex max-w-4xl items-center justify-between gap-3 rounded-2xl border border-border bg-surface/95 py-2.5 pl-4 pr-2.5 shadow-soft-lg backdrop-blur transition-colors",
          className
        )}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * The chatbot's sticky save bar. Place it as the last child of the column the
 * settings live in: it sticks to the bottom of the scroll area while that
 * column is on screen.
 */
export function SaveBar({
  dirty,
  saving,
  onSave,
  onDiscard,
  savedAt,
  justSaved,
  error,
  message,
  saveLabel = "Save changes",
}: SaveBarProps) {
  const showError = Boolean(error) && !saving;
  const status: React.ReactNode = saving ? (
    "Saving…"
  ) : dirty ? (
    <span className="font-medium text-foreground">Unsaved changes</span>
  ) : justSaved ? (
    <span className="inline-flex items-center gap-1.5 font-medium text-success">
      <Check size={14} aria-hidden />
      Saved
    </span>
  ) : message ? (
    message
  ) : savedAt ? (
    <span title={fmtDateTime(savedAt)}>Last saved {relTime(savedAt)}</span>
  ) : (
    "No unsaved changes"
  );

  return (
    <StickyActionBar className={dirty ? "border-accent/40" : undefined}>
      <div className="min-w-0 text-[13px] leading-5">
        {showError && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        <p role="status" className={cn("text-muted-foreground", showError && "sr-only")}>
          {status}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {onDiscard && (
          <Button
            variant="secondary"
            size="toolbar"
            onClick={onDiscard}
            disabled={!dirty || saving}
            className="max-sm:w-8 max-sm:px-0"
          >
            <RotateCcw size={14} aria-hidden />
            <span className="sr-only sm:not-sr-only">Discard</span>
          </Button>
        )}
        <Button size="toolbar" onClick={onSave} disabled={!dirty} loading={saving}>
          {!saving && <Save size={14} aria-hidden />}
          {saving ? "Saving…" : saveLabel}
        </Button>
      </div>
    </StickyActionBar>
  );
}

/** Loading placeholder for a settings column. */
export function PolicySkeleton({ cards = 2 }: { cards?: number }) {
  return (
    <div role="status" className="space-y-4">
      <span className="sr-only">Loading…</span>
      {Array.from({ length: cards }, (_, i) => (
        <Skeleton key={i} className="h-56 rounded-2xl" />
      ))}
    </div>
  );
}
