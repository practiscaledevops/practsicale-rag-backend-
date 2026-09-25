import * as React from "react";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { cn } from "@/lib/utils";

export interface PageHeaderProps extends Omit<React.HTMLAttributes<HTMLDivElement>, "title"> {
  title: string;
  description?: React.ReactNode;
  /** Right-aligned actions (buttons, links). */
  actions?: React.ReactNode;
  /** Adds a "Back" link above the title (detail pages). */
  backHref?: string;
  backLabel?: string;
}

/** The page's single h1, its description and actions; children render below. */
export function PageHeader({
  title,
  description,
  actions,
  backHref,
  backLabel,
  className,
  children,
  ...props
}: PageHeaderProps) {
  return (
    <div className={cn("mb-5", className)} {...props}>
      {backHref && (
        <Link
          href={backHref}
          className="mb-2 inline-flex items-center gap-1 rounded-md text-[13px] text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <ArrowLeft size={14} aria-hidden />
          {backLabel ?? "Back"}
        </Link>
      )}
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">{title}</h1>
          {description && <p className="mt-0.5 max-w-3xl text-[13px] text-muted-foreground">{description}</p>}
        </div>
        {/* max-w-full caps the group at the header width so its own flex-wrap kicks in on phones. */}
        {actions && <div className="flex max-w-full shrink-0 flex-wrap items-center gap-2">{actions}</div>}
      </div>
      {children}
    </div>
  );
}
