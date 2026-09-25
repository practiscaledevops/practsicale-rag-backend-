import * as React from "react";
import Link from "next/link";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type StatTone = "default" | "neutral" | "success" | "warning" | "danger";

const ICON_TONE: Record<StatTone, string> = {
  default: "bg-accent-soft text-accent",
  // Paused / never synced / no data: not in progress, so no brand tint.
  neutral: "bg-surface-muted text-muted-foreground",
  success: "bg-success/10 text-success",
  warning: "bg-warning/10 text-warning",
  danger: "bg-danger/10 text-danger",
};

export interface StatTileProps {
  icon?: LucideIcon;
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  /** Tooltip for the value (e.g. the exact number behind "1.2K"). */
  title?: string;
  /** Tints the icon tile; the value itself always stays foreground. */
  tone?: StatTone;
  /** Shows a skeleton instead of the value. */
  loading?: boolean;
  /** Makes the whole tile a link. */
  href?: string;
  className?: string;
}

/** KPI tile (the chatbot's admin StatCard / KpiCard). */
export function StatTile({
  icon: Icon,
  label,
  value,
  hint,
  title,
  tone = "default",
  loading = false,
  href,
  className,
}: StatTileProps) {
  const valueTitle = title ?? (typeof value === "string" || typeof value === "number" ? String(value) : undefined);
  const body = (
    <>
      <div className="flex items-center gap-2.5 text-muted-foreground">
        {Icon && (
          <span aria-hidden className={cn("grid h-8 w-8 shrink-0 place-items-center rounded-lg", ICON_TONE[tone])}>
            <Icon size={16} />
          </span>
        )}
        <span className="truncate text-[13px] font-medium">{label}</span>
      </div>
      {loading ? (
        <div aria-hidden className="mt-3 h-7 w-24 animate-pulse rounded-lg bg-surface-muted" />
      ) : (
        <div
          title={valueTitle}
          className="mt-3 text-[22px] font-semibold leading-7 tracking-tight tabular-nums text-foreground"
        >
          {value}
        </div>
      )}
      {hint && <div className="mt-0.5 text-xs text-muted-foreground">{hint}</div>}
    </>
  );
  const tile = "rounded-xl border border-border bg-surface p-4 shadow-soft";
  if (href) {
    return (
      <Link
        href={href}
        aria-busy={loading || undefined}
        className={cn(
          tile,
          "block transition-[border-color,box-shadow,transform] duration-200 hover:-translate-y-0.5 hover:border-accent/30 hover:shadow-float focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className
        )}
      >
        {body}
      </Link>
    );
  }
  return (
    <div aria-busy={loading || undefined} className={cn(tile, className)}>
      {body}
    </div>
  );
}

/** Responsive KPI grid: 1 column, 2 from sm, then 3 or 4 from lg. */
export function StatGrid({
  cols = 4,
  className,
  children,
}: {
  cols?: 2 | 3 | 4;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div
      className={cn(
        "grid grid-cols-1 gap-3 sm:grid-cols-2",
        cols === 3 && "lg:grid-cols-3",
        cols === 4 && "lg:grid-cols-4",
        className
      )}
    >
      {children}
    </div>
  );
}

/** Small borderless stat (the chatbot account page's compact stat). */
export function CompactStat({
  icon: Icon,
  label,
  value,
  hint,
  className,
}: {
  icon?: LucideIcon;
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("rounded-xl bg-surface-muted px-3.5 py-3", className)}>
      <div className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
        {Icon && <Icon size={14} aria-hidden className="shrink-0" />}
        {label}
      </div>
      <div className="mt-1 text-xl font-semibold tabular-nums tracking-tight text-foreground">{value}</div>
      {hint && <div className="mt-0.5 text-[11px] text-muted-foreground">{hint}</div>}
    </div>
  );
}

export type MeterTone = "auto" | "accent" | "success" | "warning" | "danger";

const METER_FILL: Record<Exclude<MeterTone, "auto">, string> = {
  accent: "bg-accent",
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
};

/**
 * Thin progress bar (the chatbot's Teams budget meter). "auto" tone: accent,
 * warning from 80%, danger above 100%. A value of 0 renders an empty track.
 * `indeterminate` shows a full pulsing fill with no value (work of unknown length).
 */
export function Meter({
  value,
  max = 100,
  label,
  tone = "auto",
  indeterminate = false,
  className,
}: {
  value: number;
  max?: number;
  /** Accessible name, e.g. "Monthly budget used". */
  label: string;
  tone?: MeterTone;
  indeterminate?: boolean;
  className?: string;
}) {
  const v = Number.isFinite(value) ? Math.max(0, value) : 0;
  const pct = max > 0 ? (v / max) * 100 : 0;
  const resolved = tone === "auto" ? (pct > 100 ? "danger" : pct >= 80 ? "warning" : "accent") : tone;
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={max}
      aria-valuenow={indeterminate ? undefined : Math.min(v, max)}
      aria-valuetext={indeterminate ? undefined : `${Math.round(pct)}%`}
      className={cn("h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken", className)}
    >
      <div
        className={cn("h-full rounded-full transition-[width]", METER_FILL[resolved], indeterminate && "animate-pulse")}
        style={{ width: indeterminate ? "100%" : `${Math.min(100, pct)}%` }}
      />
    </div>
  );
}
