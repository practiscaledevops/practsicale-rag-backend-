"use client";

// The dashboard landing page: the AI Brain overview (CEO view) with the
// operational layer (Team view) one toggle away. Both payloads are computed
// org-scoped on the server and arrive as props, so neither view paints a
// skeleton on first load. Both stay mounted so switching is instant and a
// client-side Refresh of the Brain numbers survives a toggle.
//
// The view lives in the URL (`?view=team`) so it can be linked and survives a
// reload. It is written with history.replaceState, not router.replace: the
// page is force-dynamic, and a router navigation would re-run requireAdmin and
// both server loaders on every toggle. Next 15 syncs replaceState into
// useSearchParams, which is how a later link to ?view=... is followed.

import * as React from "react";
import { useSearchParams } from "next/navigation";
import { PageHeader, Segmented, type SegmentedOption } from "@/components/ui";
import type { BrainOverview } from "@/lib/brain-overview";
import type { ControlTowerData } from "@/lib/dashboard-metrics";
import { BrainOverviewClient } from "./BrainOverviewClient";
import { OperationsPanel } from "./OperationsPanel";

export type OverviewView = "ceo" | "team";

const VIEW_OPTIONS: SegmentedOption<OverviewView>[] = [
  { value: "ceo", label: "CEO view" },
  { value: "team", label: "Team view" },
];

const DESCRIPTIONS: Record<OverviewView, string> = {
  ceo: "What the Brain knows, what it trusts, what it has learned, how it is connected, fed and answering, with live numbers for every part.",
  team: "Operations and data health: ingestion runs, knowledge by source and collection, and what needs attention.",
};

export function OverviewClient({
  brain,
  operations,
  email,
  initialView = "ceo",
}: {
  brain: BrainOverview;
  operations: ControlTowerData;
  email: string;
  initialView?: OverviewView;
}) {
  const [view, setView] = React.useState<OverviewView>(initialView);

  // Follow the URL when it changes underneath the page (a link to /dashboard or
  // /dashboard?view=team while this page is already mounted).
  const params = useSearchParams();
  const urlView: OverviewView = params.get("view") === "team" ? "team" : "ceo";
  React.useEffect(() => {
    setView(urlView);
  }, [urlView]);

  function changeView(next: OverviewView) {
    setView(next);
    const url = new URL(window.location.href);
    if (next === "team") url.searchParams.set("view", "team");
    else url.searchParams.delete("view");
    window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  }

  return (
    <div>
      <PageHeader
        title="Overview"
        description={DESCRIPTIONS[view]}
        actions={<Segmented label="Overview view" value={view} options={VIEW_OPTIONS} onChange={changeView} />}
      />

      <div className={view === "ceo" ? undefined : "hidden"}>
        <BrainOverviewClient initial={brain} />
      </div>
      <div className={view === "team" ? undefined : "hidden"}>
        <OperationsPanel data={operations} email={email} />
      </div>
    </div>
  );
}
