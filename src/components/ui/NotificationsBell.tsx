"use client";

// Notification center for the Brain dashboard — a live ops bell in the top bar
// (the chatbot's bell recipe). Fetches derived alerts from /api/admin/alerts
// (always current, no stored notifications) and shows them by priority in the
// status tokens: danger errors, warning, info, success, and `private` for
// CEO/confidential. Clicking an alert jumps to the fix.

import * as React from "react";
import Link from "next/link";
import { Bell, AlertTriangle, AlertOctagon, Info, CheckCircle2, Lock, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { IconButton } from "./IconButton";

type Priority = "error" | "warning" | "info" | "success" | "ceo";

interface Alert {
  id: string;
  priority: Priority;
  title: string;
  body: string;
  href: string;
}

const META: Record<Priority, { icon: typeof Info; dot: string; text: string }> = {
  error: { icon: AlertOctagon, dot: "bg-danger", text: "text-danger" },
  ceo: { icon: Lock, dot: "bg-private", text: "text-private" },
  warning: { icon: AlertTriangle, dot: "bg-warning", text: "text-warning" },
  info: { icon: Info, dot: "bg-info", text: "text-info" },
  success: { icon: CheckCircle2, dot: "bg-success", text: "text-success" },
};

// Which priorities count toward the badge (actionable now).
const BADGE = new Set<Priority>(["error", "warning", "ceo"]);

export function NotificationsBell() {
  const [alerts, setAlerts] = React.useState<Alert[]>([]);
  const [open, setOpen] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  // UI-only status of the most recent fetch (the fetch itself is unchanged).
  const [busy, setBusy] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);
  const triggerRef = React.useRef<HTMLButtonElement>(null);
  const panelId = React.useId();

  const load = React.useCallback(async () => {
    setBusy(true);
    try {
      const res = await fetch("/api/admin/alerts", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { alerts: Alert[] };
        setAlerts(data.alerts ?? []);
        setFailed(false);
      } else {
        setFailed(true);
      }
    } catch {
      /* keep last known */
      setFailed(true);
    } finally {
      setLoaded(true);
      setBusy(false);
    }
  }, []);

  React.useEffect(() => {
    void load();
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  React.useEffect(() => {
    if (open) void load();
  }, [open, load]);

  // Escape closes and returns focus to the bell; a click outside just closes.
  React.useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    // Capture phase + preventDefault: this Escape is handled here, so a page's
    // BulkActionBar (which skips handled Escapes) does not also clear its selection.
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        setOpen(false);
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey, true);
    };
  }, [open]);

  const badgeCount = alerts.filter((a) => BADGE.has(a.priority)).length;
  const hasError = alerts.some((a) => a.priority === "error");

  return (
    <div className="relative" ref={ref}>
      <IconButton
        ref={triggerRef}
        aria-label={badgeCount > 0 ? `Notifications (${badgeCount} need attention)` : "Notifications"}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        onClick={() => setOpen((o) => !o)}
        pressed={open}
        className="relative"
      >
        <Bell size={16} aria-hidden />
        {badgeCount > 0 && (
          <span
            aria-hidden
            className={cn(
              "absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full px-1 text-[11px] font-semibold leading-none text-accent-foreground ring-2 ring-background",
              hasError ? "bg-danger" : "bg-accent"
            )}
          >
            {badgeCount > 9 ? "9+" : badgeCount}
          </span>
        )}
      </IconButton>

      {open && (
        <div
          id={panelId}
          // A panel of links + text, not a menu of menuitems — so "dialog".
          role="dialog"
          aria-label="Notifications"
          className="absolute right-0 z-40 mt-2 w-[min(20rem,calc(100vw-4.5rem))] overflow-hidden rounded-xl border border-border bg-surface p-1 shadow-soft-lg motion-safe:animate-fadeUp"
        >
          <div className="-mx-1 -mt-1 mb-1 flex h-10 items-center justify-between gap-2 border-b border-border pl-3.5 pr-1.5">
            <span className="text-[13px] font-semibold">Notifications</span>
            <span className="flex items-center gap-1.5 pr-2 text-xs text-muted-foreground">
              {busy && loaded && <Loader2 size={14} className="animate-spin" aria-hidden />}
              {loaded && failed && alerts.length > 0 ? (
                <span className="text-danger">Couldn&apos;t refresh</span>
              ) : loaded && alerts.length > 0 ? (
                <span>{alerts.length} active</span>
              ) : null}
            </span>
          </div>

          <div className="max-h-[60vh] overflow-y-auto" aria-live="polite" aria-busy={!loaded}>
            {!loaded ? (
              <div className="flex items-center gap-2.5 px-2.5 py-6 text-[13px] text-muted-foreground">
                <Loader2 size={14} className="shrink-0 animate-spin" aria-hidden />
                Checking…
              </div>
            ) : alerts.length === 0 && failed ? (
              <p className="px-2.5 py-6 text-[13px] text-danger">Couldn&apos;t load alerts</p>
            ) : alerts.length === 0 ? (
              <div className="flex flex-col items-center gap-2.5 px-3 py-8 text-center">
                <span className="grid h-10 w-10 place-items-center rounded-full bg-accent-soft text-accent" aria-hidden>
                  <CheckCircle2 size={16} />
                </span>
                <p className="text-[13px] text-muted-foreground">You&apos;re all caught up</p>
              </div>
            ) : (
              <ul className="space-y-0.5">
                {alerts.map((a) => {
                  const m = META[a.priority];
                  const Icon = m.icon;
                  return (
                    <li key={a.id}>
                      <Link
                        href={a.href}
                        onClick={() => setOpen(false)}
                        className="flex w-full items-start gap-2.5 rounded-lg px-2.5 py-2 text-left transition-colors hover:bg-surface-muted focus-visible:bg-surface-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
                      >
                        <span className="flex h-5 w-4 shrink-0 items-center justify-center" aria-hidden>
                          <Icon size={14} className={m.text} />
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="flex min-h-5 items-center gap-1.5">
                            <span className="text-[13px] font-medium text-foreground">{a.title}</span>
                            {BADGE.has(a.priority) && (
                              <span className={cn("h-1.5 w-1.5 shrink-0 rounded-full", m.dot)} aria-hidden />
                            )}
                          </span>
                          <span className="mt-0.5 block text-xs text-muted-foreground">{a.body}</span>
                        </span>
                      </Link>
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
