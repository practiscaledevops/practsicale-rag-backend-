// Shared display formatters for the Brain back office. Pure functions, no
// React: safe in server components, client components and tests.
//
// Every formatter returns "—" (an em dash) for null, undefined or invalid
// input, so callers never render "NaN", "Invalid Date" or "undefined".

/** The placeholder every formatter returns for missing or invalid input. */
export const DASH = "—";

type DateInput = string | number | Date | null | undefined;

function toDate(v: DateInput): Date | null {
  if (v === null || v === undefined || v === "") return null;
  const d = v instanceof Date ? new Date(v.getTime()) : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

function toNumber(v: number | string | null | undefined): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

const shortDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" });
const fullDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" });
const fullDateTime = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const intFmt = new Intl.NumberFormat("en-US");
const compactFmt = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/**
 * Relative time for "last synced", "updated" and similar columns:
 * "just now" (under a minute), "5m ago", "3h ago", "yesterday", "4d ago"
 * (under 7 days), then "Jan 5" (same year) or "Jan 5, 2025".
 * A missing value reads as `opts.never` (default "never"); an unparseable one
 * as "—". Future timestamps (clock skew) read as "just now".
 * `absolute: false` keeps "Nd ago" past 7 days: the absolute date depends on the
 * runtime's time zone, so server-rendered text passes false until hydration.
 */
export function relTime(iso: DateInput, opts?: { never?: string; now?: number; absolute?: boolean }): string {
  if (iso === null || iso === undefined || iso === "") return opts?.never ?? "never";
  const d = toDate(iso);
  if (!d) return DASH;
  const now = opts?.now ?? Date.now();
  const diff = now - d.getTime();
  if (diff < MINUTE) return "just now";
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  const days = Math.floor(diff / DAY);
  if (days === 1) return "yesterday";
  if (days < 7 || opts?.absolute === false) return `${days}d ago`;
  return d.getFullYear() === new Date(now).getFullYear() ? shortDate.format(d) : fullDate.format(d);
}

/** "Jan 5, 2026". */
export function fmtDate(iso: DateInput): string {
  const d = toDate(iso);
  return d ? fullDate.format(d) : DASH;
}

/** "Jan 5, 2026, 3:04 PM". */
export function fmtDateTime(iso: DateInput): string {
  const d = toDate(iso);
  return d ? fullDateTime.format(d) : DASH;
}

/** Grouped number, e.g. 1,204,553 (fractions kept as toLocaleString keeps them). */
export function fmtNumber(n: number | string | null | undefined): string {
  const v = toNumber(n);
  return v === null ? DASH : v.toLocaleString("en-US");
}

/** Grouped integer, e.g. 1,204,553 (rounded). */
export function fmtInt(n: number | string | null | undefined): string {
  const v = toNumber(n);
  return v === null ? DASH : intFmt.format(Math.round(v));
}

/** Compact count, chatbot style: 840, 1.2K, 2.5M. */
export function fmtCompact(n: number | string | null | undefined): string {
  const v = toNumber(n);
  return v === null ? DASH : compactFmt.format(v);
}

/**
 * USD with the chatbot's adaptive precision: 2 decimals, but 4 when the
 * amount is under a cent (0 < |v| < 0.01), so tiny costs are not "$0.00".
 */
export function fmtMoney(usd: number | string | null | undefined): string {
  const v = toNumber(usd);
  if (v === null) return DASH;
  const dp = v !== 0 && Math.abs(v) < 0.01 ? 4 : 2;
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: dp,
    maximumFractionDigits: dp,
  }).format(v);
}

/** A 0..1 ratio as a percentage: fmtPct(0.423) -> "42%", fmtPct(0.423, 1) -> "42.3%". */
export function fmtPct(ratio: number | string | null | undefined, digits = 0): string {
  const v = toNumber(ratio);
  return v === null ? DASH : `${(v * 100).toFixed(digits)}%`;
}

/** Elapsed time: "850ms", "1.2s", "45s", "3m 5s", "1h 2m". */
export function fmtDuration(ms: number | string | null | undefined): string {
  const v = toNumber(ms);
  if (v === null || v < 0) return DASH;
  if (v < 1000) return `${Math.round(v)}ms`;
  const tenths = Math.round(v / 100) / 10; // seconds, one decimal
  if (tenths < 60) return `${Number.isInteger(tenths) ? tenths : tenths.toFixed(1)}s`;
  const totalSec = Math.round(v / 1000);
  if (totalSec < 3600) return `${Math.floor(totalSec / 60)}m ${totalSec % 60}s`;
  const totalMin = Math.floor(totalSec / 60);
  return `${Math.floor(totalMin / 60)}h ${totalMin % 60}m`;
}

/** File size: "512 B", "1.5 KB", "3.2 MB", "1.1 GB" (binary units, 1 decimal). */
export function fmtBytes(bytes: number | string | null | undefined): string {
  const v = toNumber(bytes);
  if (v === null || v < 0) return DASH;
  if (v < 1024) return `${Math.round(v)} B`;
  const units = ["KB", "MB", "GB"] as const;
  let n = v / 1024;
  let i = 0;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${units[i]}`;
}

/** "needs_review" -> "Needs review", "call-score" -> "Call score". */
export function humanize(s: string | null | undefined): string {
  if (!s) return DASH;
  const t = s.replace(/[_-]+/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}
