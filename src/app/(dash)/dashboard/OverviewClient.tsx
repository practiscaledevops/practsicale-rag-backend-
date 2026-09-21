"use client";

// The dashboard landing page: the AI Brain overview (CEO view) with the
// operational layer (Team view) one toggle away. Both payloads are computed
// org-scoped on the server and arrive as props, so neither view paints a
// skeleton on first load. Both stay mounted so switching is instant and a
// client-side Refresh of the Brain numbers survives a toggle.

import * as React from "react";
import { cn } from "@/lib/utils";
import type { BrainOverview } from "@/lib/brain-overview";
import type { ControlTowerData } from "@/lib/dashboard-metrics";
import { BrainOverviewClient } from "./BrainOverviewClient";
import { OperationsPanel } from "./OperationsPanel";

type View = "ceo" | "team";

const VIEWS: { id: View; label: string; description: string }[] = [
  {
    id: "ceo",
    label: "CEO view",
    description: "What the Brain knows, what it trusts, what it has learned, how it is connected, fed and answering — with live numbers for every part.",
  },
  {
    id: "team",
    label: "Team view",
    description: "Operations & data health: ingestion runs, knowledge by source and collection, and what needs attention.",
  },
];

export function OverviewClient({ brain, operations, email }: { brain: BrainOverview; operations: ControlTowerData; email: string }) {
  const [view, setView] = React.useState<View>("ceo");
  const current = VIEWS.find((v) => v.id === view) ?? VIEWS[0];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="text-2xl font-semibold tracking-tight">AI Brain overview</h1>
          <p className="mt-1 text-sm text-muted-foreground">{current.description}</p>
        </div>
        <div className="inline-flex rounded-lg border border-border bg-surface p-0.5 text-sm">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              type="button"
              aria-pressed={view === v.id}
              onClick={() => setView(v.id)}
              className={cn(
                "rounded-md px-3 py-1.5 font-medium transition-colors",
                view === v.id ? "bg-accent/15 text-accent" : "text-muted-foreground hover:text-foreground"
              )}
            >
              {v.label}
            </button>
          ))}
        </div>
      </div>

      <div className={view === "ceo" ? undefined : "hidden"}>
        <BrainOverviewClient initial={brain} />
      </div>
      <div className={view === "team" ? undefined : "hidden"}>
        <OperationsPanel data={operations} email={email} />
      </div>
    </div>
  );
}
