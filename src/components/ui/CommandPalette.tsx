"use client";

// Global command palette (Ctrl+K / ⌘K), ported from the chatbot's
// CommandPalette. A keyboard-first launcher for the back office: jump to any
// page, add knowledge, switch theme or sign out. Purely a navigation /
// quick-action surface — everything it triggers is still enforced server-side.
//
// ARIA: a modal dialog holding a combobox (the input keeps focus) that controls
// a listbox; the active option is announced via aria-activedescendant.

import * as React from "react";
import { useRouter } from "next/navigation";
import { CornerDownLeft, Search, type LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

export type CommandGroup = "Navigate" | "Actions";

export interface CommandItem {
  id: string;
  group: CommandGroup;
  label: string;
  /** Muted trailing text (e.g. the nav group); also searched. */
  hint?: string;
  /** Extra search terms that are not shown (e.g. a page's former name). */
  keywords?: string;
  icon: LucideIcon;
  /** Navigate here on select (router.push). */
  href?: string;
  /** Or run this on select. Runs after the palette closes. */
  onSelect?: () => void;
}

export interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  items: CommandItem[];
}

/** Stable section order in the results. */
const GROUP_ORDER: CommandGroup[] = ["Navigate", "Actions"];

export function CommandPalette({ open, onClose, items }: CommandPaletteProps) {
  const router = useRouter();
  const [query, setQuery] = React.useState("");
  const [active, setActive] = React.useState(0);
  const inputRef = React.useRef<HTMLInputElement>(null);
  const listRef = React.useRef<HTMLDivElement>(null);
  const returnFocusRef = React.useRef<HTMLElement | null>(null);
  const baseId = React.useId();
  const listId = `${baseId}-list`;
  const optionId = (idx: number) => `${baseId}-opt-${idx}`;

  // Filter (case-insensitive over label + hint + keywords), then order by group
  // so the running index matches what is rendered.
  const results = React.useMemo(() => {
    const q = query.trim().toLowerCase();
    const matched = q
      ? items.filter((c) => `${c.label} ${c.hint ?? ""} ${c.keywords ?? ""}`.toLowerCase().includes(q))
      : items;
    return GROUP_ORDER.flatMap((g) => matched.filter((c) => c.group === g));
  }, [items, query]);

  // Reset transient state whenever the palette opens; remember what had focus
  // so it can be restored on close.
  React.useEffect(() => {
    if (!open) return;
    const prev = document.activeElement;
    returnFocusRef.current = prev instanceof HTMLElement && prev !== document.body ? prev : null;
    setQuery("");
    setActive(0);
    // Focus after paint so the caret lands in the input.
    const raf = requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      cancelAnimationFrame(raf);
      const el = returnFocusRef.current;
      returnFocusRef.current = null;
      if (el && el.isConnected) el.focus({ preventScroll: true });
    };
  }, [open]);

  React.useEffect(() => {
    setActive(0);
  }, [query]);

  // Keep the active row scrolled into view.
  React.useEffect(() => {
    if (!open) return;
    const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${active}"]`);
    el?.scrollIntoView({ block: "nearest" });
  }, [active, open]);

  const run = React.useCallback(
    (item: CommandItem | undefined) => {
      if (!item) return;
      onClose();
      if (item.href) router.push(item.href);
      else item.onSelect?.();
    },
    [onClose, router]
  );

  const onKeyDown = React.useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActive((a) => (results.length ? (a + 1) % results.length : 0));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActive((a) => (results.length ? (a - 1 + results.length) % results.length : 0));
      } else if (e.key === "Home" && results.length) {
        e.preventDefault();
        setActive(0);
      } else if (e.key === "End" && results.length) {
        e.preventDefault();
        setActive(results.length - 1);
      } else if (e.key === "Enter") {
        e.preventDefault();
        run(results[active]);
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      } else if (e.key === "Tab") {
        // The input is the dialog's only tab stop: keep focus inside.
        e.preventDefault();
      }
    },
    [results, active, run, onClose]
  );

  if (!open) return null;

  const activeItem = results[active];
  let runningIdx = -1;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center p-4 pt-[12vh]">
      <button
        type="button"
        tabIndex={-1}
        aria-label="Close"
        className="absolute inset-0 scrim motion-safe:animate-fadeIn"
        onClick={onClose}
      />
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Search pages"
        // Clicks anywhere in the panel keep focus in the combobox input, so its
        // onKeyDown keeps handling Escape, Tab, the arrows and Enter.
        onMouseDown={(e) => {
          if (e.target !== inputRef.current) e.preventDefault();
        }}
        className="relative z-10 w-full max-w-xl overflow-hidden rounded-2xl border border-border bg-surface shadow-soft-lg motion-safe:animate-fadeUp"
      >
        <div className="flex items-center gap-2.5 border-b border-border px-4">
          <Search size={16} className="shrink-0 text-muted-foreground" aria-hidden />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-label="Search pages and actions"
            aria-autocomplete="list"
            aria-expanded="true"
            aria-controls={listId}
            aria-activedescendant={activeItem ? optionId(active) : undefined}
            autoComplete="off"
            spellCheck={false}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder="Search pages and actions…"
            className="h-10 w-full border-0 bg-transparent text-sm text-foreground outline-none placeholder:text-subtle-foreground focus-visible:outline-none"
          />
          <kbd className="hidden rounded-md border border-border bg-surface-muted px-1.5 py-0.5 text-[11px] leading-none text-muted-foreground sm:inline">
            Esc
          </kbd>
        </div>

        <div ref={listRef} id={listId} role="listbox" aria-label="Results" className="max-h-[50vh] overflow-y-auto p-1.5">
          {results.length === 0 ? (
            <p role="presentation" className="px-3 py-8 text-center text-[13px] text-muted-foreground">
              No matches.
            </p>
          ) : (
            GROUP_ORDER.map((group) => {
              const rows = results.filter((c) => c.group === group);
              if (rows.length === 0) return null;
              const labelId = `${baseId}-group-${group}`;
              return (
                <div key={group} role="group" aria-labelledby={labelId} className="mb-1 last:mb-0">
                  <p id={labelId} role="presentation" className="px-2.5 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">
                    {group}
                  </p>
                  {rows.map((c) => {
                    runningIdx += 1;
                    const idx = runningIdx;
                    const Icon = c.icon;
                    const isActive = idx === active;
                    return (
                      <div
                        key={c.id}
                        id={optionId(idx)}
                        role="option"
                        aria-selected={isActive}
                        data-idx={idx}
                        onMouseMove={() => setActive(idx)}
                        // Keep focus in the input when a row is clicked.
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => run(c)}
                        className={cn(
                          "flex h-8 w-full cursor-pointer select-none items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors",
                          isActive ? "bg-surface-muted text-foreground" : "text-foreground/90"
                        )}
                      >
                        <span className="flex w-4 shrink-0 items-center justify-center" aria-hidden>
                          <Icon size={14} className={isActive ? "text-accent" : "text-muted-foreground"} />
                        </span>
                        <span className="min-w-0 flex-1 truncate">{c.label}</span>
                        {c.hint && (
                          <span className="max-w-[45%] shrink-0 truncate text-xs text-muted-foreground">{c.hint}</span>
                        )}
                        <span className="flex w-3.5 shrink-0 items-center justify-center" aria-hidden>
                          {isActive && <CornerDownLeft size={12} className="text-muted-foreground" />}
                        </span>
                      </div>
                    );
                  })}
                </div>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
