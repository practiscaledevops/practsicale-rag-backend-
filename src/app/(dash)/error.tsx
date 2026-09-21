"use client";

import { useEffect } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { C, KBtn } from "@/components/ui/brain-ui";

// Error boundary for the signed-in dashboard: a thrown render/data error shows
// a calm, recoverable panel (with a retry) instead of a blank page. The message
// is kept generic — the details go to the console/server logs, never the UI.
export default function DashboardError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => {
    console.error("[dashboard] render error:", error);
  }, [error]);

  return (
    <div className="mx-auto max-w-lg py-16 text-center">
      <div
        className="mx-auto mb-4 grid h-12 w-12 place-items-center rounded-full"
        style={{ background: "rgba(243,182,97,0.12)", color: C.amber }}
        aria-hidden
      >
        <AlertTriangle size={22} />
      </div>
      <h1 className="text-lg font-semibold" style={{ color: C.text }}>This page hit a problem</h1>
      <p className="mt-2 text-sm" style={{ color: C.muted }}>
        The Brain is still running; only this view failed to render. Try again, and if it keeps happening check
        Processing runs and Data quality for the underlying issue.
      </p>
      {error.digest && (
        <p className="mt-2 font-mono text-[11px]" style={{ color: C.muted }}>
          ref {error.digest}
        </p>
      )}
      <div className="mt-5 flex justify-center gap-2">
        <KBtn variant="primary" onClick={reset}>
          <RotateCcw size={13} /> Try again
        </KBtn>
        <KBtn onClick={() => (window.location.href = "/dashboard")}>Go to Overview</KBtn>
      </div>
    </div>
  );
}
