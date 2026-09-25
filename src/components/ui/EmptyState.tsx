import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface EmptyStateProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  icon?: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Optional call-to-action (e.g. a Button). */
  action?: React.ReactNode;
  /** "dashed" (default) draws the dashed outline; "plain" sits inside a card. */
  variant?: "plain" | "dashed";
}

/** Placeholder shown when a list or section has no data yet (chatbot icon-disc recipe). */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  variant = "dashed",
  className,
  ...props
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-2.5 px-4 py-8 text-center",
        variant === "dashed" && "rounded-xl border border-dashed border-border",
        className
      )}
      {...props}
    >
      {Icon && (
        <span aria-hidden className="grid h-10 w-10 place-items-center rounded-full bg-accent-soft text-accent">
          <Icon size={16} />
        </span>
      )}
      <p className="text-[13px] font-medium text-foreground">{title}</p>
      {description && <p className="max-w-sm text-[13px] text-muted-foreground">{description}</p>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}
