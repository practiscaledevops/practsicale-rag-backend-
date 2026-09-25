import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

/** Surface container: rounded-2xl, hairline border, soft shadow. */
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("rounded-2xl border border-border bg-surface text-foreground shadow-soft", className)}
      {...props}
    />
  );
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("flex flex-col gap-0.5 px-4 pt-4", className)} {...props} />;
}

export function CardTitle({ className, ...props }: React.HTMLAttributes<HTMLHeadingElement>) {
  return <h3 className={cn("text-sm font-semibold tracking-tight text-foreground", className)} {...props} />;
}

export function CardDescription({ className, ...props }: React.HTMLAttributes<HTMLParagraphElement>) {
  return <p className={cn("text-xs text-muted-foreground", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  // pt-3.5 under a CardHeader, pt-4 when first. A caller's own p-/py-/pt- class
  // wins outright (tailwind-merge can't cancel the `first:` variant for us).
  const ownTop = !!className && /(^|\s)!?(p|py|pt)-/.test(className);
  return <div className={cn("px-4 pb-4 pt-3.5", !ownTop && "first:pt-4", className)} {...props} />;
}

export function CardFooter({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("flex items-center justify-end gap-2 border-t border-border px-4 py-3", className)}
      {...props}
    />
  );
}

export interface SectionCardProps {
  icon?: LucideIcon;
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Right-aligned header actions. */
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  /** Overrides the body's default `p-4` (e.g. "p-0" for a flush table). */
  bodyClassName?: string;
  id?: string;
}

/** Settings-style section: icon tile + title/description header, padded body (chatbot admin Section). */
export function SectionCard({
  icon: Icon,
  title,
  description,
  actions,
  children,
  className,
  bodyClassName,
  id,
}: SectionCardProps) {
  return (
    <section id={id} className={cn("rounded-2xl border border-border bg-surface shadow-soft", className)}>
      <header className="flex items-start gap-3 border-b border-border px-4 py-3">
        {Icon && (
          <span
            aria-hidden
            className="mt-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-accent-soft text-accent"
          >
            <Icon size={16} />
          </span>
        )}
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">{title}</h2>
          {description && <p className="mt-0.5 text-[13px] text-muted-foreground">{description}</p>}
        </div>
        {actions && <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      <div className={cn("p-4", bodyClassName)}>{children}</div>
    </section>
  );
}
