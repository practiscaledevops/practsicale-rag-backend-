import * as React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

/** Inline loading line: a 14px spinner and a label, announced politely. */
export function Spinner({ label = "Loading…", className }: { label?: string; className?: string }) {
  return (
    <div role="status" className={cn("flex items-center gap-2 py-5 text-[13px] text-muted-foreground", className)}>
      <Loader2 size={14} aria-hidden className="shrink-0 animate-spin" />
      {label}
    </div>
  );
}

/** Loading placeholder block, sized by className (e.g. "h-4 w-24"). */
export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <div
      aria-hidden
      className={cn("animate-pulse rounded-lg bg-surface-muted motion-reduce:animate-none", className)}
      style={style}
    />
  );
}
