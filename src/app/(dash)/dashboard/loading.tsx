// Route-level loading state for every /dashboard page: a page-shaped skeleton
// (title, stat row, panel) in the green palette, shown while the server
// component resolves the session and data. Self-contained so it never depends
// on the client bundle being ready.
export default function DashboardLoading() {
  return (
    <div className="animate-pulse space-y-4" aria-busy="true" aria-label="Loading">
      <div className="space-y-2">
        <div className="h-6 w-56 rounded-md bg-surface-muted" />
        <div className="h-3.5 w-96 max-w-full rounded bg-surface-muted/70" />
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <div key={i} className="h-20 rounded-xl border border-border bg-surface" />
        ))}
      </div>
      <div className="space-y-3 rounded-xl border border-border bg-surface p-4">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="h-4 rounded bg-surface-muted" style={{ width: `${88 - i * 9}%` }} />
        ))}
      </div>
    </div>
  );
}
