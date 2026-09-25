"use client";

// Action menu rendered in a portal with fixed positioning (the chatbot's
// PopoverMenu), so table scrollers and cards never clip it. Opens 6px below
// the trigger or flips above when there's no room; click-outside, Escape, Tab,
// scroll and resize close it; arrow keys, Home and End move between items.

import * as React from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { Check, MoreHorizontal, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  onSelect?: () => void;
  /** Renders the item as a link (next/link, or <a target=_blank> when external). */
  href?: string;
  external?: boolean;
  danger?: boolean;
  /** Set (true/false) to make this a menuitemradio with aria-checked and a check mark; leave undefined for a plain action. */
  active?: boolean;
  disabled?: boolean;
  /** Draws a hairline above this item. */
  separatorBefore?: boolean;
}

export interface MenuProps {
  /** Accessible name for the trigger and the menu, e.g. "Actions for Q3 report". */
  label: string;
  items: MenuItem[];
  /** Trigger content; defaults to a "more" (…) icon. */
  trigger?: React.ReactNode;
  triggerClassName?: string;
  /** Trigger size: sm 28px, md 32px (default). */
  size?: "sm" | "md";
  /** Which trigger edge the menu lines up with. */
  align?: "start" | "end";
  width?: number;
  disabled?: boolean;
}

const ROW_H = 32;
const SEPARATOR_H = 9; // my-1 + 1px hairline
const CHROME_H = 10; // p-1 + border
const GAP = 6;
const EDGE = 8;

export function Menu({
  label,
  items,
  trigger,
  triggerClassName,
  size = "md",
  align = "end",
  width = 220,
  disabled = false,
}: MenuProps) {
  const [open, setOpen] = React.useState(false);
  const [pos, setPos] = React.useState<{ top: number; left: number } | null>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const menuRef = React.useRef<HTMLDivElement>(null);
  const itemRefs = React.useRef<(HTMLElement | null)[]>([]);

  const height = items.length * ROW_H + items.filter((it, i) => i > 0 && it.separatorBefore).length * SEPARATOR_H + CHROME_H;

  const place = React.useCallback(() => {
    const el = triggerRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const preferred = align === "end" ? r.right - width : r.left;
    const left = Math.min(vw - width - EDGE, Math.max(EDGE, preferred));
    const below = r.bottom + GAP;
    const top = below + height > vh - EDGE ? Math.max(EDGE, r.top - height - GAP) : below;
    setPos({ top, left });
  }, [align, width, height]);

  React.useLayoutEffect(() => {
    if (open) place();
    else setPos(null);
  }, [open, place]);

  const close = React.useCallback((refocus: boolean) => {
    setOpen(false);
    if (refocus) triggerRef.current?.focus();
  }, []);

  React.useEffect(() => {
    if (!open) return;
    const t = window.setTimeout(() => {
      itemRefs.current.find((b) => b && !b.hasAttribute("disabled"))?.focus({ preventScroll: true });
    }, 0);
    function onDown(e: MouseEvent) {
      const target = e.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.stopPropagation();
        close(true);
      }
    }
    function onScroll(e: Event) {
      if (menuRef.current?.contains(e.target as Node)) return;
      setOpen(false);
    }
    const onResize = () => setOpen(false);
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, true);
    return () => {
      window.clearTimeout(t);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll, true);
    };
  }, [open, close]);

  function onMenuKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Tab") {
      // Return focus to the trigger; the browser's Tab then moves on from there.
      close(true);
      return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) return;
    e.preventDefault();
    const list = itemRefs.current.filter((b): b is HTMLElement => !!b && !b.hasAttribute("disabled"));
    if (list.length === 0) return;
    const i = list.indexOf(document.activeElement as HTMLElement);
    const next =
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? list.length - 1
          : e.key === "ArrowDown"
            ? (i + 1) % list.length
            : (i - 1 + list.length) % list.length;
    list[next]?.focus();
  }

  function select(it: MenuItem) {
    // Refocus the trigger first so a dialog opened by onSelect restores focus to it.
    close(true);
    it.onSelect?.();
  }

  const itemClass = (it: MenuItem) =>
    cn(
      "flex h-8 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors hover:bg-surface-muted focus-visible:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
      it.danger && "text-danger",
      it.active && "text-accent-strong"
    );

  // A selection item (active set) is a menuitemradio so its state is announced.
  const roleProps = (it: MenuItem) =>
    it.active !== undefined
      ? ({ role: "menuitemradio", "aria-checked": it.active } as const)
      : ({ role: "menuitem" } as const);

  const itemInner = (it: MenuItem) => {
    const Icon = it.icon;
    return (
      <>
        {Icon && (
          <Icon
            size={14}
            aria-hidden
            className={cn(
              "shrink-0",
              it.danger ? "text-danger" : it.active ? "text-accent" : "text-muted-foreground"
            )}
          />
        )}
        <span className="min-w-0 flex-1 truncate">{it.label}</span>
        {it.active && <Check size={14} aria-hidden className="shrink-0 text-accent" />}
      </>
    );
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="menu"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => setOpen((o) => !o)}
        className={cn(
          "inline-flex shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
          size === "sm" ? "h-7 w-7" : "h-8 w-8",
          open && "bg-surface-muted text-foreground",
          triggerClassName
        )}
      >
        {trigger ?? <MoreHorizontal size={16} aria-hidden />}
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            aria-label={label}
            onKeyDown={onMenuKeyDown}
            style={{ top: pos.top, left: pos.left, width }}
            className="fixed z-[60] rounded-xl border border-border bg-surface p-1 text-foreground shadow-soft-lg motion-safe:animate-fadeUp"
          >
            {items.map((it, i) => {
              const setRef = (el: HTMLElement | null) => {
                itemRefs.current[i] = el;
              };
              const separator = i > 0 && it.separatorBefore && (
                <div role="separator" className="mx-1 my-1 border-t border-border" />
              );
              let node: React.ReactNode;
              if (it.href && !it.disabled && it.external) {
                node = (
                  <a
                    ref={setRef}
                    href={it.href}
                    target="_blank"
                    rel="noopener noreferrer"
                    {...roleProps(it)}
                    tabIndex={-1}
                    onClick={() => select(it)}
                    className={itemClass(it)}
                  >
                    {itemInner(it)}
                  </a>
                );
              } else if (it.href && !it.disabled) {
                node = (
                  <Link
                    ref={setRef}
                    href={it.href}
                    {...roleProps(it)}
                    tabIndex={-1}
                    onClick={() => select(it)}
                    className={itemClass(it)}
                  >
                    {itemInner(it)}
                  </Link>
                );
              } else {
                node = (
                  <button
                    ref={setRef}
                    type="button"
                    {...roleProps(it)}
                    tabIndex={-1}
                    disabled={it.disabled}
                    onClick={() => select(it)}
                    className={itemClass(it)}
                  >
                    {itemInner(it)}
                  </button>
                );
              }
              return (
                <React.Fragment key={`${i}-${it.label}`}>
                  {separator}
                  {node}
                </React.Fragment>
              );
            })}
          </div>,
          document.body
        )}
    </>
  );
}

/** Alias matching the chatbot's component name. */
export const PopoverMenu = Menu;
export type PopoverMenuItem = MenuItem;
