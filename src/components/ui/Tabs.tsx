"use client";

import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface TabItem<T extends string> {
  id: T;
  label: string;
  count?: number;
  icon?: LucideIcon;
}

function CountPill({ count, active }: { count: number; active: boolean }) {
  return (
    <span
      className={cn(
        "rounded-full px-1.5 text-[11px] tabular-nums",
        active ? "bg-accent/15 text-accent-deep" : "bg-surface-muted text-muted-foreground"
      )}
    >
      {count}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Tabs + TabPanel: real ARIA tabs (roving tabindex, arrow keys)
// ---------------------------------------------------------------------------

export interface TabsProps<T extends string> {
  /** Accessible name for the tab list. */
  label: string;
  value: T;
  tabs: TabItem<T>[];
  onChange: (id: T) => void;
  /** Shared with each <TabPanel idPrefix> to link tabs and panels. */
  idPrefix: string;
  className?: string;
}

/**
 * Tab list. Pair each tab with a <TabPanel idPrefix={same} id={tab.id}>.
 * Arrow Left/Right, Home and End move focus and select (automatic activation).
 */
export function Tabs<T extends string>({ label, value, tabs, onChange, idPrefix, className }: TabsProps<T>) {
  const refs = React.useRef<(HTMLButtonElement | null)[]>([]);

  function onKeyDown(e: React.KeyboardEvent, index: number) {
    const last = tabs.length - 1;
    let next = -1;
    if (e.key === "ArrowRight") next = index === last ? 0 : index + 1;
    else if (e.key === "ArrowLeft") next = index === 0 ? last : index - 1;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = last;
    if (next < 0) return;
    e.preventDefault();
    refs.current[next]?.focus();
    onChange(tabs[next].id);
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      className={cn("inline-flex max-w-full flex-wrap gap-0.5 rounded-xl bg-surface p-0.5 shadow-soft", className)}
    >
      {tabs.map((t, i) => {
        const active = t.id === value;
        const Icon = t.icon;
        return (
          <button
            key={t.id}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`${idPrefix}-tab-${t.id}`}
            aria-selected={active}
            aria-controls={`${idPrefix}-panel-${t.id}`}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(t.id)}
            onKeyDown={(e) => onKeyDown(e, i)}
            className={cn(
              "inline-flex h-8 items-center gap-1.5 rounded-[10px] px-3 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active ? "bg-accent-soft text-accent-strong" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {Icon && <Icon size={14} aria-hidden className="shrink-0" />}
            {t.label}
            {typeof t.count === "number" && <CountPill count={t.count} active={active} />}
          </button>
        );
      })}
    </div>
  );
}

export interface TabPanelProps {
  idPrefix: string;
  id: string;
  active: boolean;
  /** Keep the panel mounted (hidden) when inactive, so its state survives tab switches. */
  keepMounted?: boolean;
  children: React.ReactNode;
  className?: string;
}

export function TabPanel({ idPrefix, id, active, keepMounted = false, children, className }: TabPanelProps) {
  if (!active && !keepMounted) return null;
  return (
    <div
      role="tabpanel"
      id={`${idPrefix}-panel-${id}`}
      aria-labelledby={`${idPrefix}-tab-${id}`}
      hidden={!active}
      tabIndex={0}
      className={cn("focus-visible:outline-none", className)}
    >
      {children}
    </div>
  );
}

// ---------------------------------------------------------------------------
// FilterTabs: pill filters with counts (a button group, not ARIA tabs)
// ---------------------------------------------------------------------------

export interface FilterTabsProps<T extends string> {
  /** Accessible name for the group, e.g. "Filter by status". */
  label: string;
  value: T;
  tabs: TabItem<T>[];
  onChange: (id: T) => void;
  className?: string;
}

export function FilterTabs<T extends string>({ label, value, tabs, onChange, className }: FilterTabsProps<T>) {
  return (
    <div role="group" aria-label={label} className={cn("flex flex-wrap items-center gap-1", className)}>
      {tabs.map((t) => {
        const active = t.id === value;
        const Icon = t.icon;
        return (
          <button
            key={t.id}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(t.id)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active
                ? "bg-accent-soft text-accent-strong"
                : "text-muted-foreground hover:bg-surface-muted hover:text-foreground"
            )}
          >
            {Icon && <Icon size={14} aria-hidden className="shrink-0" />}
            {t.label}
            {typeof t.count === "number" && <CountPill count={t.count} active={active} />}
          </button>
        );
      })}
    </div>
  );
}
