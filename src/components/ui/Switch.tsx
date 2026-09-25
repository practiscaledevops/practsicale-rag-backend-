"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

interface SwitchBaseProps {
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  id?: string;
  className?: string;
  "aria-describedby"?: string;
}

/** An accessible name is required: a `label` (aria-label) or aria-labelledby. */
export type SwitchProps = SwitchBaseProps &
  ({ label: string; "aria-labelledby"?: string } | { label?: string; "aria-labelledby": string });

/** Accessible on/off switch (role="switch"), the chatbot admin recipe: 36x20. */
export const Switch = React.forwardRef<HTMLButtonElement, SwitchProps>(
  ({ checked, onChange, label, disabled, id, className, ...aria }, ref) => (
    <button
      ref={ref}
      id={id}
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={aria["aria-labelledby"] ? undefined : label}
      aria-labelledby={aria["aria-labelledby"]}
      aria-describedby={aria["aria-describedby"]}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50",
        // Off: a 1px inset edge (~3.3:1) keeps the track visible on white cards (WCAG 1.4.11).
        checked ? "bg-accent" : "bg-surface-sunken shadow-[inset_0_0_0_1px_rgb(var(--muted-foreground)/0.8)]",
        className
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block h-4 w-4 transform rounded-full bg-white shadow-soft transition-transform",
          checked ? "translate-x-[18px]" : "translate-x-0.5"
        )}
      />
    </button>
  )
);
Switch.displayName = "Switch";

export interface SwitchRowProps {
  title: React.ReactNode;
  hint?: React.ReactNode;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
  className?: string;
}

/** A bordered settings row: title + hint on the left, the switch on the right. */
export function SwitchRow({ title, hint, checked, onChange, disabled, className }: SwitchRowProps) {
  const baseId = React.useId();
  const titleId = `${baseId}-title`;
  const hintId = hint ? `${baseId}-hint` : undefined;
  return (
    <div className={cn("flex items-center justify-between gap-4 rounded-xl border border-border px-3 py-2.5", className)}>
      <div className="min-w-0">
        <p id={titleId} className="text-[13px] font-medium text-foreground">
          {title}
        </p>
        {hint && (
          <p id={hintId} className="mt-0.5 text-xs text-muted-foreground">
            {hint}
          </p>
        )}
      </div>
      <Switch
        checked={checked}
        onChange={onChange}
        disabled={disabled}
        aria-labelledby={titleId}
        aria-describedby={hintId}
      />
    </div>
  );
}
