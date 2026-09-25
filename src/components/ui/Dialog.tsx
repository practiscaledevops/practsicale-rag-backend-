"use client";

import * as React from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { cn } from "@/lib/utils";
import { IconButton } from "./IconButton";

export type DialogSize = "sm" | "md" | "lg" | "xl";

const SIZES: Record<DialogSize, string> = {
  sm: "max-w-sm",
  md: "max-w-md",
  lg: "max-w-2xl",
  xl: "max-w-3xl",
};

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title?: React.ReactNode;
  description?: React.ReactNode;
  children?: React.ReactNode;
  /** Footer actions, right-aligned above a hairline. */
  footer?: React.ReactNode;
  /** Extra classes for the panel (e.g. a custom max-w). */
  className?: string;
  /** Panel width: sm 384 / md 448 (default) / lg 672 / xl 768px. */
  size?: DialogSize;
  /** false hides the X and ignores Escape and backdrop clicks (e.g. while saving). */
  dismissible?: boolean;
  /** false keeps the dialog open on a backdrop click (forms, one-time secrets). */
  closeOnBackdrop?: boolean;
  /** Element to focus on open, instead of the first field / focusable. */
  initialFocusRef?: React.RefObject<HTMLElement | null>;
  /**
   * Where focus goes on close when the element that opened the dialog is gone
   * by then (e.g. the row a delete removed). Without it focus falls to <body>.
   */
  returnFocus?: () => HTMLElement | null | undefined;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

// Open dialogs, innermost last: only the top one handles Escape / Tab, so a
// confirm opened from inside a dialog closes on its own.
const dialogStack: symbol[] = [];

function useMounted() {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => setMounted(true), []);
  return mounted;
}

/**
 * Accessible modal dialog (the chatbot's Modal, hardened): portaled to <body>,
 * labelled by its title, focus moved in on open (first field, else first
 * focusable, else the panel), Tab / Shift+Tab trapped, Escape closes, focus
 * returns to the trigger on close and body scroll is locked while open.
 */
export function Dialog({
  open,
  onClose,
  title,
  description,
  children,
  footer,
  className,
  size = "md",
  dismissible = true,
  closeOnBackdrop = true,
  initialFocusRef,
  returnFocus,
}: DialogProps) {
  const mounted = useMounted();
  const visible = open && mounted;
  const panelRef = React.useRef<HTMLDivElement>(null);
  const titleId = React.useId();
  const descId = React.useId();

  // Latest callbacks/flags in refs, so parent re-renders (a new inline onClose
  // on every keystroke) never re-run the effect below and steal focus.
  const onCloseRef = React.useRef(onClose);
  const dismissibleRef = React.useRef(dismissible);
  const initialFocus = React.useRef(initialFocusRef);
  const returnFocusRef = React.useRef(returnFocus);
  React.useEffect(() => {
    onCloseRef.current = onClose;
    dismissibleRef.current = dismissible;
    initialFocus.current = initialFocusRef;
    returnFocusRef.current = returnFocus;
  });

  React.useEffect(() => {
    if (!visible) return;
    const panel = panelRef.current;
    if (!panel) return;
    const token = Symbol("dialog");
    dialogStack.push(token);
    const previouslyFocused = document.activeElement as HTMLElement | null;

    const focusables = () =>
      Array.from(panel.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getClientRects().length > 0
      );

    // Initial focus (unless something inside already took it, e.g. autoFocus).
    if (!panel.contains(document.activeElement)) {
      const items = focusables();
      const target =
        initialFocus.current?.current ??
        items.find((el) => el.matches("input, textarea, select")) ??
        items[0] ??
        panel;
      target.focus({ preventScroll: true });
    }

    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";

    function onKeyDown(e: KeyboardEvent) {
      if (dialogStack[dialogStack.length - 1] !== token || !panel) return;
      // Keys inside a portaled menu opened from this dialog belong to the menu.
      const target = e.target as Element | null;
      if (target && !panel.contains(target) && target.closest?.('[role="menu"]')) return;

      if (e.key === "Escape") {
        e.stopPropagation();
        if (dismissibleRef.current) onCloseRef.current();
        return;
      }
      if (e.key !== "Tab") return;
      const items = focusables();
      if (items.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!panel.contains(active)) {
        e.preventDefault();
        (e.shiftKey ? last : first).focus();
      } else if (e.shiftKey && (active === first || active === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }

    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      const i = dialogStack.indexOf(token);
      if (i >= 0) dialogStack.splice(i, 1);
      document.body.style.overflow = prevOverflow;
      // The opener may have been removed while the dialog was open (a delete).
      const target = previouslyFocused?.isConnected ? previouslyFocused : returnFocusRef.current?.();
      target?.focus?.({ preventScroll: true });
    };
  }, [visible]);

  if (!visible) return null;

  const hasHeader = Boolean(title || description || dismissible);

  return createPortal(
    <div
      className="scrim fixed inset-0 z-50 flex items-center justify-center p-4 motion-safe:animate-fadeIn"
      onMouseDown={(e) => {
        // Only a press on the backdrop itself (not one that started in the panel).
        if (e.target === e.currentTarget && dismissible && closeOnBackdrop) onClose();
      }}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? titleId : undefined}
        aria-describedby={description ? descId : undefined}
        tabIndex={-1}
        className={cn(
          "relative flex max-h-[calc(100dvh-2rem)] w-full flex-col rounded-2xl border border-border bg-surface p-5 text-foreground shadow-soft-lg outline-none motion-safe:animate-fadeUp",
          SIZES[size],
          className
        )}
      >
        {hasHeader && (
          <div className="mb-3 flex items-start justify-between gap-3">
            <div className="min-w-0">
              {title && (
                <h2 id={titleId} className="text-[15px] font-semibold tracking-tight">
                  {title}
                </h2>
              )}
              {description && (
                <p id={descId} className="mt-1 text-[13px] text-muted-foreground">
                  {description}
                </p>
              )}
            </div>
            {dismissible && (
              <IconButton aria-label="Close dialog" size="sm" onClick={onClose}>
                <X size={16} aria-hidden />
              </IconButton>
            )}
          </div>
        )}
        {/* -m-1 p-1: room for field focus rings inside the scroll area (net-zero layout). */}
        {children && <div className="-m-1 min-h-0 flex-1 overflow-y-auto p-1">{children}</div>}
        {footer && (
          <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-border pt-4">
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body
  );
}
