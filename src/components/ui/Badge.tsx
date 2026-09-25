import * as React from "react";
import { cn } from "@/lib/utils";
import { CLASS_DOT, CLASS_DOT_BASE, CLASS_LABEL } from "@/lib/ui-labels";
import { humanize } from "@/lib/format";

/**
 * success = healthy/done, warning = needs attention, danger = failed,
 * info = informational, accent = brand/selected/in progress,
 * neutral = counts, categories, archived, paused, never synced,
 * strong = an outlined emphasis chip.
 */
export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info" | "strong";

const TONES: Record<BadgeTone, string> = {
  neutral: "border-transparent bg-surface-muted text-muted-foreground",
  accent: "border-transparent bg-accent-soft text-accent-strong",
  // Text on the /10 tints uses the -ink tokens (darker in light mode) for AA.
  success: "border-transparent bg-success/10 text-success-ink",
  warning: "border-transparent bg-warning/10 text-warning-ink",
  danger: "border-transparent bg-danger/10 text-danger-ink",
  info: "border-transparent bg-info/10 text-info-ink",
  strong: "border-border bg-surface text-foreground",
};

export interface BadgeProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: BadgeTone;
  /** Leading dot in the text colour. */
  dot?: boolean;
}

/** Small rounded status/label chip (the chatbot's ObjectDrawer Chip). */
export function Badge({ className, tone = "neutral", dot = false, children, ...props }: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-medium leading-4",
        TONES[tone],
        className
      )}
      {...props}
    >
      {dot && <span aria-hidden className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />}
      {children}
    </span>
  );
}

export type StatusDotTone = "success" | "warning" | "danger" | "info" | "accent" | "neutral";

const DOTS: Record<StatusDotTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  danger: "bg-danger",
  info: "bg-info",
  accent: "bg-accent",
  neutral: "bg-muted-foreground/50",
};

export interface StatusDotProps extends React.HTMLAttributes<HTMLSpanElement> {
  tone?: StatusDotTone;
}

/** Coloured dot + text (the chatbot's users-table status). */
export function StatusDot({ tone = "neutral", className, children, ...props }: StatusDotProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 text-xs",
        tone === "neutral" ? "text-muted-foreground" : "text-foreground",
        className
      )}
      {...props}
    >
      <span aria-hidden className={cn("h-1.5 w-1.5 shrink-0 rounded-full", DOTS[tone])} />
      {children}
    </span>
  );
}

/** Tiny neutral tag pill (the chatbot's provider tag). */
export function Tag({ className, ...props }: React.HTMLAttributes<HTMLSpanElement>) {
  return (
    <span
      className={cn(
        "inline-flex items-center rounded-full bg-surface-muted px-1.5 py-px text-[11px] font-medium text-muted-foreground",
        className
      )}
      {...props}
    />
  );
}

/** Knowledge class as a neutral chip with its folder-colour dot (categorical, not status). */
export function ClassBadge({ klass, className }: { klass: string | null | undefined; className?: string }) {
  const key = klass ?? "";
  return (
    <Badge tone="neutral" className={className}>
      <span aria-hidden className={cn(CLASS_DOT_BASE, CLASS_DOT[key] ?? "bg-muted-foreground/40")} />
      {CLASS_LABEL[key] ?? humanize(klass)}
    </Badge>
  );
}
