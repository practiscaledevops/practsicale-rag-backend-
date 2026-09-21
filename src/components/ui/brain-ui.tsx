"use client";

// Shared primitives for the Operating Intelligence screens (green control-center
// style, self-contained palette so these pages match the Collections workspace).

import * as React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

export const C = {
  bg: "#06100D",
  sidebar: "#091914",
  surface: "#0D1E18",
  raised: "#122B23",
  border: "#204438",
  text: "#EDF7F2",
  muted: "#91AAA0",
  green: "#00BFAE",
  restricted: "#94DCA7",
  amber: "#F3B661",
  red: "#FF7B75",
  info: "#75BFFF",
  violet: "#B6A4FF",
};

export type Tone = "green" | "amber" | "red" | "muted" | "info" | "violet" | "mint";

const TONE: Record<Tone, { fg: string; bg: string; bd: string }> = {
  green: { fg: C.green, bg: "rgba(0,191,174,0.12)", bd: "rgba(0,191,174,0.35)" },
  mint: { fg: C.restricted, bg: "rgba(148,220,167,0.12)", bd: "rgba(148,220,167,0.35)" },
  amber: { fg: C.amber, bg: "rgba(243,182,97,0.12)", bd: "rgba(243,182,97,0.35)" },
  red: { fg: C.red, bg: "rgba(255,123,117,0.12)", bd: "rgba(255,123,117,0.35)" },
  info: { fg: C.info, bg: "rgba(117,191,255,0.12)", bd: "rgba(117,191,255,0.35)" },
  violet: { fg: C.violet, bg: "rgba(182,164,255,0.12)", bd: "rgba(182,164,255,0.35)" },
  muted: { fg: C.muted, bg: "rgba(145,170,160,0.10)", bd: "rgba(145,170,160,0.30)" },
};

export function Chip({ tone = "muted", children, title, className }: { tone?: Tone; children: React.ReactNode; title?: string; className?: string }) {
  const t = TONE[tone];
  return (
    <span
      title={title}
      className={cn("inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium leading-4 whitespace-nowrap", className)}
      style={{ color: t.fg, background: t.bg, border: `1px solid ${t.bd}` }}
    >
      {children}
    </span>
  );
}

export function Panel({
  title,
  subtitle,
  actions,
  children,
  className,
  padded = true,
}: {
  title?: React.ReactNode;
  subtitle?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  padded?: boolean;
}) {
  return (
    <section className={cn("rounded-xl", className)} style={{ background: C.surface, border: `1px solid ${C.border}` }}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 px-4 py-3" style={{ borderBottom: `1px solid ${C.border}` }}>
          <div className="min-w-0">
            {title && <h2 className="truncate text-sm font-semibold" style={{ color: C.text }}>{title}</h2>}
            {subtitle && <p className="truncate text-xs" style={{ color: C.muted }}>{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? "p-4" : ""}>{children}</div>
    </section>
  );
}

export function KBtn({
  variant = "outline",
  size = "sm",
  className,
  children,
  loading,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "outline" | "ghost" | "danger"; size?: "sm" | "md" | "xs"; loading?: boolean }) {
  const base = "inline-flex items-center justify-center gap-1.5 rounded-lg font-medium transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus-visible:outline-none focus-visible:ring-2";
  const sz = size === "xs" ? "h-7 px-2 text-[11px]" : size === "md" ? "h-10 px-4 text-sm" : "h-8 px-3 text-xs";
  const style: React.CSSProperties =
    variant === "primary"
      ? { background: C.green, color: "#04211D", border: `1px solid ${C.green}` }
      : variant === "danger"
        ? { background: "rgba(255,123,117,0.12)", color: C.red, border: `1px solid rgba(255,123,117,0.4)` }
        : variant === "ghost"
          ? { background: "transparent", color: C.muted, border: "1px solid transparent" }
          : { background: C.raised, color: C.text, border: `1px solid ${C.border}` };
  return (
    <button className={cn(base, sz, className)} style={style} disabled={loading || rest.disabled} {...rest}>
      {loading && <Loader2 size={13} className="animate-spin" />}
      {children}
    </button>
  );
}

const fieldStyle: React.CSSProperties = { background: C.bg, color: C.text, border: `1px solid ${C.border}` };

export function KInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cn("h-9 w-full rounded-lg px-3 text-sm outline-none placeholder:opacity-50 focus:ring-2", props.className)} style={{ ...fieldStyle, ...(props.style ?? {}) }} />;
}

export function KTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea {...props} className={cn("w-full rounded-lg px-3 py-2 text-sm outline-none placeholder:opacity-50 focus:ring-2", props.className)} style={{ ...fieldStyle, ...(props.style ?? {}) }} />;
}

export function KSelect({ options, placeholder, ...props }: React.SelectHTMLAttributes<HTMLSelectElement> & { options: { value: string; label: string; disabled?: boolean }[]; placeholder?: string }) {
  return (
    <select {...props} className={cn("h-9 w-full rounded-lg px-2.5 text-sm outline-none focus:ring-2", props.className)} style={{ ...fieldStyle, ...(props.style ?? {}) }}>
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {options.map((o) => (
        <option key={o.value} value={o.value} disabled={o.disabled}>
          {o.label}
        </option>
      ))}
    </select>
  );
}

export function Field({ label, hint, children, className }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <label className={cn("block", className)}>
      <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider" style={{ color: C.muted }}>{label}</span>
      {children}
      {hint && <span className="mt-1 block text-xs" style={{ color: C.muted }}>{hint}</span>}
    </label>
  );
}

export function KTabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: string; count?: number }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div className="flex flex-wrap gap-1 rounded-lg p-1" style={{ background: C.bg, border: `1px solid ${C.border}` }}>
      {tabs.map((t) => {
        const active = t.id === value;
        return (
          <button
            key={t.id}
            type="button"
            onClick={() => onChange(t.id)}
            className="inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors"
            style={active ? { background: "rgba(0,191,174,0.14)", color: C.green, border: "1px solid rgba(0,191,174,0.35)" } : { color: C.muted, border: "1px solid transparent" }}
          >
            {t.label}
            {typeof t.count === "number" && (
              <span className="rounded px-1 text-[10px]" style={{ background: active ? "rgba(0,191,174,0.2)" : C.raised, color: active ? C.green : C.muted }}>
                {t.count}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center justify-center gap-2 rounded-lg px-6 py-10 text-center" style={{ border: `1px dashed ${C.border}` }}>
      <p className="text-sm font-medium" style={{ color: C.text }}>{title}</p>
      {hint && <p className="max-w-md text-xs" style={{ color: C.muted }}>{hint}</p>}
      {action}
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return (
    <div className="flex items-center gap-2 py-6 text-sm" style={{ color: C.muted }}>
      <Loader2 size={16} className="animate-spin" /> {label ?? "Loading…"}
    </div>
  );
}

export function StatBox({ label, value, hint, tone = "green" }: { label: string; value: React.ReactNode; hint?: string; tone?: Tone }) {
  return (
    <div className="rounded-xl px-4 py-3" style={{ background: C.surface, border: `1px solid ${C.border}` }}>
      <p className="text-[11px] font-semibold uppercase tracking-wider" style={{ color: C.muted }}>{label}</p>
      <p className="mt-1 text-2xl font-semibold" style={{ color: TONE[tone].fg }}>{value}</p>
      {hint && <p className="text-xs" style={{ color: C.muted }}>{hint}</p>}
    </div>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p className="rounded-lg px-3 py-2 text-xs" style={{ color: C.red, background: "rgba(255,123,117,0.10)", border: "1px solid rgba(255,123,117,0.35)" }}>
      {message}
    </p>
  );
}

/** Table shell: fixed header, scrolling body. */
export function KTable({ head, children, className }: { head: React.ReactNode; children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("overflow-auto rounded-lg", className)} style={{ border: `1px solid ${C.border}` }}>
      <table className="w-full border-collapse text-left text-sm">
        <thead className="sticky top-0 z-10" style={{ background: C.raised }}>
          <tr>{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Th({ children, className }: { children?: React.ReactNode; className?: string }) {
  return (
    <th className={cn("px-3 py-2 text-[11px] font-semibold uppercase tracking-wider", className)} style={{ color: C.muted, borderBottom: `1px solid ${C.border}` }}>
      {children}
    </th>
  );
}

export function Td({ children, className, onClick, title }: { children?: React.ReactNode; className?: string; onClick?: () => void; title?: string }) {
  return (
    <td className={cn("px-3 py-2 align-top text-sm", className)} style={{ color: C.text, borderBottom: `1px solid ${C.border}` }} onClick={onClick} title={title}>
      {children}
    </td>
  );
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "—" : d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric" });
}

export function humanize(s: string | null | undefined): string {
  if (!s) return "—";
  const t = s.replace(/[_-]+/g, " ");
  return t.charAt(0).toUpperCase() + t.slice(1);
}

/** Tone for governance values. */
export function endorsementTone(v: string | null | undefined): Tone {
  return v === "practiscale_standard" ? "green" : v === "approved" ? "mint" : "muted";
}
export function authorityTone(v: string | null | undefined): Tone {
  if (!v) return "muted";
  return v.startsWith("A") ? "green" : v.startsWith("B") ? "info" : "amber";
}
export function statusTone(v: string | null | undefined): Tone {
  return v === "active" ? "green" : v === "draft" ? "amber" : v === "historical" ? "muted" : v === "archived" ? "red" : "muted";
}
export function classTone(v: string | null | undefined): Tone {
  return v === "business_reality" ? "green" : v === "playbook" ? "info" : v === "organizational_learning" ? "violet" : v === "platform_intelligence" ? "mint" : v === "performance_memory" ? "amber" : "muted";
}
export const CLASS_LABEL: Record<string, string> = {
  business_reality: "Business Reality",
  playbook: "Playbook",
  organizational_learning: "Org Learning",
  platform_intelligence: "Platform Intel",
  performance_memory: "Performance",
  raw_archive: "Raw",
};

/** Small fetch helper with JSON + error surfacing. */
export async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `Request failed (${res.status})`);
  return json;
}
