"use client";

// Notification center for the Brain dashboard — a live ops bell. Fetches derived
// alerts from /api/admin/alerts (always current, no stored notifications) and
// shows them by priority with the spec's colors: red errors, amber warnings, blue
// info, teal success, purple CEO/confidential. Clicking an alert jumps to the fix.

import * as React from "react";
import Link from "next/link";
import { Bell, AlertTriangle, AlertOctagon, Info, CheckCircle2, Lock, ArrowRight } from "lucide-react";
import { cn } from "@/lib/utils";

type Priority = "error" | "warning" | "info" | "success" | "ceo";

interface Alert {
  id: string;
  priority: Priority;
  title: string;
  body: string;
  href: string;
}

const META: Record<Priority, { icon: typeof Info; dot: string; text: string }> = {
  error: { icon: AlertOctagon, dot: "bg-rose-500", text: "text-rose-500" },
  ceo: { icon: Lock, dot: "bg-purple-500", text: "text-purple-400" },
  warning: { icon: AlertTriangle, dot: "bg-amber-500", text: "text-amber-500" },
  info: { icon: Info, dot: "bg-sky-500", text: "text-sky-500" },
  success: { icon: CheckCircle2, dot: "bg-emerald-500", text: "text-emerald-500" },
};

// Which priorities count toward the red badge (actionable now).
const BADGE = new Set<Priority>(["error", "warning", "ceo"]);

export function NotificationsBell() {
  const [alerts, setAlerts] = React.useState<Alert[]>([]);
  const [open, setOpen] = React.useState(false);
  const [loaded, setLoaded] = React.useState(false);
  const ref = React.useRef<HTMLDivElement>(null);

  const load = React.useCallback(async () => {
    try {
      const res = await fetch("/api/admin/alerts", { cache: "no-store" });
      if (res.ok) {
        const data = (await res.json()) as { alerts: Alert[] };
        setAlerts(data.alerts ?? []);
      }
    } catch {
      /* keep last known */
    } finally {
      setLoaded(true);
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

  React.useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const badgeCount = alerts.filter((a) => BADGE.has(a.priority)).length;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        aria-label={badgeCount > 0 ? `Notifications (${badgeCount} need attention)` : "Notifications"}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="relative grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
      >
        <Bell className="h-[18px] w-[18px]" />
        {badgeCount > 0 && (
          <span className="absolute -right-0.5 -top-0.5 grid h-4 min-w-4 place-items-center rounded-full bg-rose-500 px-1 text-[10px] font-semibold text-white">
            {badgeCount > 9 ? "9+" : badgeCount}
          </span>
        )}
      </button>

      {open && (
        <div role="menu" className="absolute right-0 z-40 mt-1.5 w-96 max-w-[calc(100vw-2rem)] overflow-hidden rounded-xl border border-border bg-surface shadow-lg">
          <div className="flex items-center justify-between border-b border-border px-4 py-2.5">
            <span className="text-sm font-semibold">Notifications</span>
            <span className="text-xs text-muted-foreground">{alerts.length} active</span>
          </div>
          <div className="max-h-[70vh] overflow-y-auto">
            {alerts.length === 0 ? (
              <div className="flex items-center gap-2.5 px-4 py-8 text-sm text-muted-foreground">
                <CheckCircle2 className="h-5 w-5 text-emerald-500" />
                {loaded ? "All clear — nothing needs attention." : "Loading…"}
              </div>
            ) : (
              <ul className="divide-y divide-border">
                {alerts.map((a) => {
                  const m = META[a.priority];
                  const Icon = m.icon;
                  return (
                    <li key={a.id}>
                      <Link href={a.href} onClick={() => setOpen(false)} className="flex items-start gap-3 px-4 py-3 transition-colors hover:bg-surface-muted">
                        <span className={cn("mt-0.5 h-2 w-2 shrink-0 rounded-full", m.dot)} aria-hidden />
                        <Icon className={cn("mt-0.5 h-4 w-4 shrink-0", m.text)} aria-hidden />
                        <span className="min-w-0 flex-1">
                          <span className="block text-sm font-medium">{a.title}</span>
                          <span className="block text-xs text-muted-foreground">{a.body}</span>
                        </span>
                        <ArrowRight className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
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
