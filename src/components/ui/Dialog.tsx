"use client";

import * as React from "react";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "./Button";

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: string;
  description?: string;
  children?: React.ReactNode;
  /** Footer actions, right-aligned. */
  footer?: React.ReactNode;
  className?: string;
}

/**
 * Accessible modal dialog. Closes on Escape and backdrop click; traps focus by
 * moving focus to the panel on open and restoring it on close. Rendered inline
 * (no portal) to stay dependency-light — fine for a single top-level modal.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
}: DialogProps) {
  const panelRef = React.useRef<HTMLDivElement>(null);
  const previouslyFocused = React.useRef<HTMLElement | null>(null);

  React.useEffect(() => {
    if (!open) return;
    previouslyFocused.current = document.activeElement as HTMLElement | null;
    panelRef.current?.focus();

    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    document.addEventListener("keydown", onKey);
    // Lock background scroll while the dialog is open.
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      previouslyFocused.current?.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  const titleId = title ? "dialog-title" : undefined;
  const descId = description ? "dialog-desc" : undefined;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
      onMouseDown={(e) => {
        // Backdrop click (not clicks inside the panel).
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="absolute inset-0 bg-black/50" aria-hidden="true" />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descId}
        tabIndex={-1}
        className={cn(
          "relative z-10 w-full max-w-lg rounded-xl border border-border bg-surface shadow-xl focus:outline-none",
          className
        )}
      >
        <div className="flex items-start justify-between gap-4 p-5 pb-3">
          <div className="min-w-0">
            {title && (
              <h2 id={titleId} className="text-base font-semibold">
                {title}
              </h2>
            )}
            {description && (
              <p id={descId} className="mt-1 text-sm text-muted-foreground">
                {description}
              </p>
            )}
          </div>
          <Button
            variant="ghost"
            size="icon"
            onClick={onClose}
            aria-label="Close dialog"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>
        {children && <div className="px-5 py-1">{children}</div>}
        {footer && (
          <div className="flex items-center justify-end gap-2 p-5 pt-4">
            {footer}
          </div>
        )}
      </div>
    </div>
  );
}
