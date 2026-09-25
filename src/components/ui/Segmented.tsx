"use client";

import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
  icon?: LucideIcon;
}

export interface SegmentedProps<T extends string> {
  /** Accessible name for the group, e.g. "Date range". */
  label: string;
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  className?: string;
}

/**
 * Single-select pill toggle (the chatbot's usage-page Segmented): a 32px
 * sunken track with 28px segments; role="group" + aria-pressed.
 */
export function Segmented<T extends string>({ label, value, options, onChange, className }: SegmentedProps<T>) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn("inline-flex h-8 items-center rounded-full bg-surface-sunken p-0.5", className)}
    >
      {options.map((opt) => {
        const active = opt.value === value;
        const Icon = opt.icon;
        return (
          <button
            key={opt.value}
            type="button"
            aria-pressed={active}
            onClick={() => onChange(opt.value)}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              active ? "bg-surface text-foreground shadow-soft" : "text-muted-foreground hover:text-foreground"
            )}
          >
            {Icon && <Icon size={14} aria-hidden className="shrink-0" />}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
