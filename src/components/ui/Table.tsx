import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Table primitives in the chatbot admin recipe: 13px, sentence-case headers,
 * `px-4 py-2` cells, hairline row borders. <Table> brings its own horizontal
 * scroller, so don't wrap it in another one.
 */
export interface TableProps extends React.TableHTMLAttributes<HTMLTableElement> {
  /** Minimum table width before the wrapper scrolls horizontally (default 640px). */
  minWidth?: number | string;
  /** Screen-reader caption. */
  caption?: React.ReactNode;
  wrapperClassName?: string;
}

export function Table({ minWidth = 640, caption, wrapperClassName, className, style, children, ...props }: TableProps) {
  return (
    // Focusable so keyboard users can scroll a wide table (Safari doesn't focus
    // scrollers on its own). Inset ring: TableCard's overflow-hidden would clip an outline.
    <div
      tabIndex={0}
      {...(typeof caption === "string" ? { role: "region", "aria-label": caption } : {})}
      className={cn(
        "overflow-x-auto focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
        wrapperClassName
      )}
    >
      <table
        className={cn("w-full border-collapse text-left text-[13px]", className)}
        style={{ minWidth, ...style }}
        {...props}
      >
        {caption && <caption className="sr-only">{caption}</caption>}
        {children}
      </table>
    </div>
  );
}

export function THead({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  // Header rows get the bottom hairline; body rows draw their own top border.
  return <thead className={cn("[&>tr]:border-b [&>tr]:border-t-0 [&>tr]:border-border", className)} {...props} />;
}

export function TBody({ className, ...props }: React.HTMLAttributes<HTMLTableSectionElement>) {
  return <tbody className={className} {...props} />;
}

export interface TrProps extends React.HTMLAttributes<HTMLTableRowElement> {
  /** Adds the row hover wash (clickable / linked rows). */
  interactive?: boolean;
}

export function Tr({ className, interactive = false, ...props }: TrProps) {
  return (
    <tr
      className={cn(
        "border-t border-border",
        interactive && "transition-colors hover:bg-surface-muted/60",
        className
      )}
      {...props}
    />
  );
}

export interface ThProps extends React.ThHTMLAttributes<HTMLTableCellElement> {
  /** Right-aligns the header of a numeric column. */
  numeric?: boolean;
}

export function Th({ className, numeric = false, scope = "col", ...props }: ThProps) {
  return (
    <th
      scope={scope}
      className={cn(
        "px-4 py-2 text-left text-xs font-medium text-muted-foreground",
        numeric && "text-right",
        className
      )}
      {...props}
    />
  );
}

export interface TdProps extends React.TdHTMLAttributes<HTMLTableCellElement> {
  /** Right-aligned tabular figures that never wrap. */
  numeric?: boolean;
}

export function Td({ className, numeric = false, ...props }: TdProps) {
  return (
    <td
      className={cn(
        "px-4 py-2 align-middle text-[13px] text-foreground",
        numeric && "whitespace-nowrap text-right tabular-nums",
        className
      )}
      {...props}
    />
  );
}

export interface TableCardProps {
  title?: React.ReactNode;
  /** Muted text beside the title, e.g. "42 documents". */
  meta?: React.ReactNode;
  actions?: React.ReactNode;
  footer?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  id?: string;
}

/** A card holding a table: optional title/actions strip and a muted footer. */
export function TableCard({ title, meta, actions, footer, children, className, id }: TableCardProps) {
  return (
    <section
      id={id}
      className={cn("overflow-hidden rounded-2xl border border-border bg-surface shadow-soft", className)}
    >
      {(title || actions) && (
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
            {title && <h2 className="text-sm font-semibold text-foreground">{title}</h2>}
            {meta && <span className="text-xs text-muted-foreground">{meta}</span>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
      {footer && <div className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">{footer}</div>}
    </section>
  );
}

/** Full-width message row ("No documents match your filters."). */
export function TableEmptyRow({ colSpan, children }: { colSpan: number; children: React.ReactNode }) {
  return (
    <tr className="border-t border-border">
      <td colSpan={colSpan} className="px-4 py-5 text-center text-[13px] text-muted-foreground">
        {children}
      </td>
    </tr>
  );
}

const SKELETON_WIDTHS = ["w-3/4", "w-1/2", "w-2/3", "w-1/3", "w-3/5"];

/** Placeholder rows while a table loads. */
export function TableSkeletonRows({ rows = 5, cols }: { rows?: number; cols: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, r) => (
        <tr key={r} aria-hidden className="border-t border-border">
          {Array.from({ length: cols }, (_, c) => (
            <td key={c} className="px-4 py-2.5">
              <div
                className={cn(
                  "h-4 animate-pulse rounded-full bg-surface-muted motion-reduce:animate-none",
                  SKELETON_WIDTHS[(r + c) % SKELETON_WIDTHS.length]
                )}
              />
            </td>
          ))}
        </tr>
      ))}
    </>
  );
}
