// Route-level loading state for every /dashboard page (and the Suspense
// fallback of knowledge/page.tsx): a skeleton of the standard page layout —
// title block, a row of stat tiles and a table card — in the theme tokens.
// Self-contained (no client code) so it renders before the bundle is ready.

import { Skeleton } from "@/components/ui/Loading";

/** Varied row widths so the skeleton reads as a table, not a block. */
const ROW_WIDTHS = ["w-2/3", "w-1/2", "w-3/5", "w-2/5", "w-1/2", "w-1/3"];

export default function DashboardLoading() {
  return (
    <div role="status" aria-live="polite" className="space-y-5">
      <span className="sr-only">Loading…</span>

      <div className="space-y-2" aria-hidden>
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-4 w-80 max-w-full" />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4" aria-hidden>
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="rounded-xl border border-border bg-surface p-4 shadow-soft">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="mt-3 h-6 w-16" />
          </div>
        ))}
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-surface shadow-soft" aria-hidden>
        <div className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <Skeleton className="h-4 w-40" />
          <Skeleton className="h-8 w-48 max-w-[40%]" />
        </div>
        <div className="divide-y divide-border">
          {ROW_WIDTHS.map((w, i) => (
            <div key={i} className="flex items-center gap-4 px-4 py-2.5">
              <Skeleton className={`h-4 ${w}`} />
              <Skeleton className="ml-auto h-4 w-16" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
