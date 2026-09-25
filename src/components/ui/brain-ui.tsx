"use client";

// Legacy primitives for the Operating Intelligence screens. Every export keeps
// its name and props, but each one is now a thin wrapper over the shared,
// token-styled primitives (Button, Input, Select, Badge, EmptyState, ...), so
// these pages follow the chatbot palette in Light and Dark. New code should
// import the primitives from "@/components/ui" directly.

import * as React from "react";
import { cn } from "@/lib/utils";
import { Button, type ButtonSize, type ButtonVariant } from "./Button";
import { Input } from "./Input";
import { Textarea } from "./Textarea";
import { Select, type SelectOption } from "./Select";
import { FilterTabs } from "./Tabs";
import { EmptyState } from "./EmptyState";
import { Spinner as LoadingSpinner, Skeleton as LoadingSkeleton } from "./Loading";

export type { SelectOption } from "./Select";
export { fmtDate, humanize } from "@/lib/format";
export { CLASS_LABEL } from "@/lib/ui-labels";

/**
 * @deprecated Inline-style palette kept only so older screens keep compiling.
 * The values are theme tokens (CSS variables), so they already follow Light /
 * Dark. Use token classes instead (text-muted-foreground, bg-surface, ...);
 * this export is deleted once no screen reads it.
 */
export const C = {
  bg: "rgb(var(--background))",
  sidebar: "rgb(var(--sidebar))",
  surface: "rgb(var(--surface))",
  raised: "rgb(var(--surface-muted))",
  border: "rgb(var(--border))",
  text: "rgb(var(--foreground))",
  muted: "rgb(var(--muted-foreground))",
  green: "rgb(var(--accent-strong))",
  restricted: "rgb(var(--success))",
  amber: "rgb(var(--warning))",
  red: "rgb(var(--danger))",
  info: "rgb(var(--info))",
  violet: "rgb(var(--muted-foreground))",
};

export type Tone = "green" | "amber" | "red" | "muted" | "info" | "violet" | "mint";

/** Chip classes per legacy tone (the Badge recipe). */
export const TONE_CLASS: Record<Tone, string> = {
  green: "border-transparent bg-accent-soft text-accent-strong",
  mint: "border-transparent bg-success/10 text-success-ink",
  amber: "border-transparent bg-warning/10 text-warning-ink",
  red: "border-transparent bg-danger/10 text-danger-ink",
  info: "border-transparent bg-info/10 text-info-ink",
  violet: "border-border bg-surface text-foreground",
  muted: "border-transparent bg-surface-muted text-muted-foreground",
};

/** Text colour per legacy tone. */
export const TONE_TEXT: Record<Tone, string> = {
  green: "text-accent-strong",
  mint: "text-success",
  amber: "text-warning",
  red: "text-danger",
  info: "text-info",
  violet: "text-foreground",
  muted: "text-muted-foreground",
};

const TONE_DOT: Partial<Record<Tone, string>> = {
  mint: "bg-success",
  amber: "bg-warning",
  red: "bg-danger",
  info: "bg-info",
  violet: "bg-foreground/60",
};

/** Row hover wash for clickable table rows. */
export const ROW_HOVER = "transition-colors hover:bg-surface-muted/60";

export function Chip({
  tone = "muted",
  children,
  title,
  className,
}: {
  tone?: Tone;
  children: React.ReactNode;
  title?: string;
  className?: string;
}) {
  return (
    <span
      title={title}
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4",
        TONE_CLASS[tone],
        className
      )}
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
    <section className={cn("rounded-2xl border border-border bg-surface shadow-soft", className)}>
      {(title || actions) && (
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="min-w-0">
            {title && <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>}
            {subtitle && <p className="mt-0.5 text-xs text-muted-foreground">{subtitle}</p>}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? "p-4" : ""}>{children}</div>
    </section>
  );
}

const KBTN_VARIANT: Record<"primary" | "outline" | "ghost" | "danger", ButtonVariant> = {
  primary: "primary",
  outline: "secondary",
  ghost: "ghost",
  danger: "danger-secondary",
};
const KBTN_SIZE: Record<"sm" | "md" | "xs", ButtonSize> = { xs: "sm", sm: "toolbar", md: "md" };

export function KBtn({
  variant = "outline",
  size = "sm",
  loading,
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "outline" | "ghost" | "danger";
  size?: "sm" | "md" | "xs";
  loading?: boolean;
}) {
  return <Button variant={KBTN_VARIANT[variant]} size={KBTN_SIZE[size]} loading={loading} {...rest} />;
}

export function KInput(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return <Input {...props} />;
}

export function KTextarea(props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <Textarea {...props} />;
}

export function KSelect(
  props: React.SelectHTMLAttributes<HTMLSelectElement> & {
    options?: SelectOption[];
    /** Grouped options (rendered as <optgroup>); used with or instead of `options`. */
    groups?: { label: string; options: SelectOption[] }[];
    placeholder?: string;
  }
) {
  return <Select {...props} />;
}

export function Field({
  label,
  hint,
  children,
  className,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <label className={cn("block space-y-1.5", className)}>
      <span className="block text-xs font-medium text-muted-foreground">{label}</span>
      {children}
      {hint && <span className="block text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

export function KTabs<T extends string>({
  tabs,
  value,
  onChange,
}: {
  tabs: { id: T; label: string; count?: number }[];
  value: T;
  onChange: (v: T) => void;
}) {
  return <FilterTabs label="Filter" tabs={tabs} value={value} onChange={onChange} />;
}

export function Empty({ title, hint, action }: { title: string; hint?: string; action?: React.ReactNode }) {
  return <EmptyState variant="dashed" title={title} description={hint} action={action} />;
}

export function Spinner({ label }: { label?: string }) {
  return <LoadingSpinner label={label} />;
}

/** Loading placeholder block, sized by className (e.g. "h-4 w-24"). */
export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return <LoadingSkeleton className={className} style={style} />;
}

export function StatBox({
  label,
  value,
  hint,
  tone = "green",
}: {
  label: string;
  value: React.ReactNode;
  hint?: string;
  tone?: Tone;
}) {
  const dot = TONE_DOT[tone];
  return (
    <div className="rounded-xl border border-border bg-surface p-4 shadow-soft">
      <p className="flex items-center gap-1.5 text-[13px] font-medium text-muted-foreground">
        {dot && <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", dot)} />}
        <span className="truncate">{label}</span>
      </p>
      <p className="mt-1 text-[22px] font-semibold leading-7 tracking-tight tabular-nums text-foreground">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

export function ErrorNote({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger-ink">
      {message}
    </p>
  );
}

/** Table shell: fixed header, scrolling body. */
export function KTable({
  head,
  children,
  className,
}: {
  head: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("overflow-auto rounded-xl border border-border bg-surface", className)}>
      <table className="w-full border-collapse text-left text-[13px]">
        <thead className="sticky top-0 z-10 bg-surface">
          <tr>{head}</tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Th({ children, className, ...props }: React.ThHTMLAttributes<HTMLTableCellElement>) {
  return (
    <th
      scope="col"
      className={cn("border-b border-border px-4 py-2 text-xs font-medium text-muted-foreground", className)}
      {...props}
    >
      {children}
    </th>
  );
}

export function Td({
  children,
  className,
  onClick,
  title,
  ...props
}: React.TdHTMLAttributes<HTMLTableCellElement> & { onClick?: () => void }) {
  return (
    <td
      className={cn("border-t border-border px-4 py-2 align-top text-[13px] text-foreground", className)}
      onClick={onClick}
      title={title}
      {...props}
    >
      {children}
    </td>
  );
}

/** Tone for governance values. */
export function endorsementTone(v: string | null | undefined): Tone {
  return v === "practiscale_standard" ? "green" : v === "approved" ? "mint" : "muted";
}
export function authorityTone(v: string | null | undefined): Tone {
  if (!v) return "muted";
  return v.startsWith("A") ? "green" : v.startsWith("B") ? "info" : "amber";
}
/** Lifecycle status: active is green, draft needs attention, historical and archived are neutral. */
export function statusTone(v: string | null | undefined): Tone {
  return v === "active" ? "green" : v === "draft" ? "amber" : "muted";
}
export function classTone(v: string | null | undefined): Tone {
  return v === "business_reality"
    ? "green"
    : v === "playbook"
      ? "info"
      : v === "organizational_learning"
        ? "violet"
        : v === "platform_intelligence"
          ? "mint"
          : v === "performance_memory"
            ? "amber"
            : "muted";
}

/** Small fetch helper with JSON + error surfacing. */
export async function api<T = unknown>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, { cache: "no-store", ...init, headers: { "content-type": "application/json", ...(init?.headers ?? {}) } });
  const json = (await res.json().catch(() => ({}))) as T & { error?: string };
  if (!res.ok) throw new Error((json as { error?: string }).error ?? `Request failed (${res.status})`);
  return json;
}
