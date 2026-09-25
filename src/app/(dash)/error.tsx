"use client";

import { useEffect, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/Button";

// Error boundary for the signed-in dashboard (rendered inside the shell): a
// thrown render/data error shows a calm, recoverable card (with a retry)
// instead of a blank page. The message is kept generic — the details go to the
// console/server logs, never the UI.
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  const router = useRouter();
  const [retrying, startTransition] = useTransition();
  // reset() alone re-renders with the cached server payload; refresh first so a
  // failed server component is fetched again (Next 15).
  const retry = () =>
    startTransition(() => {
      router.refresh();
      reset();
    });

  useEffect(() => {
    console.error("[dashboard] render error:", error);
  }, [error]);

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="flex w-full max-w-[380px] flex-col items-center gap-4 rounded-2xl border border-border bg-surface p-5 text-center shadow-soft">
        <span className="grid h-10 w-10 place-items-center rounded-full bg-danger/10 text-danger" aria-hidden>
          <AlertTriangle size={16} />
        </span>
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Something went wrong</h1>
          <p className="text-[13px] text-muted-foreground">
            The Brain is still running; only this view failed to load. Try again, or head back to the overview.
          </p>
          {error.digest ? (
            <p className="pt-1 text-[11px] text-muted-foreground">Reference: {error.digest}</p>
          ) : null}
        </div>
        <div className="flex flex-wrap justify-center gap-2">
          <Button variant="primary" size="toolbar" onClick={retry} loading={retrying}>
            {!retrying && <RotateCcw size={14} aria-hidden />}
            Try again
          </Button>
          {/* A full reload: a soft link keeps the error card when the error came from /dashboard itself
              (the boundary only resets on a pathname change). */}
          <Button variant="secondary" size="toolbar" onClick={() => window.location.assign("/dashboard")}>
            Back to overview
          </Button>
        </div>
      </div>
    </div>
  );
}
