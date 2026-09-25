"use client";

import * as React from "react";
import Link from "next/link";
import { ChevronRight, ListChecks } from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  EmptyState,
  IconButton,
  Select,
  Spinner,
  Table,
  TableCard,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  buttonClass,
  type BadgeTone,
} from "@/components/ui";
import { api } from "@/components/ui/brain-ui";
import { dedupTone } from "@/lib/ui-labels";
import { fmtDateTime, fmtDuration, humanize, relTime } from "@/lib/format";
import { cn } from "@/lib/utils";

interface Decision { id: string; stage: string; decision: string; input: unknown; output: unknown; model: string | null; confidence: number | null; duration_ms: number | null; created_at: string; object_id: string | null }
interface Resp { decisions: Decision[]; objects: Record<string, { id: string; ref: string; name: string }>; counts: { byStage: Record<string, number>; byDecision: Record<string, number> }; migrationMissing?: boolean }

const STAGES = ["classify", "taxonomy", "dedup", "compile", "entities", "relationships", "learning", "guard", "persist"];
const COLS = 8;

// true only after hydration, so locale-dependent strings never mismatch the server HTML.
const noopSubscribe = () => () => {};
function useHydrated() {
  return React.useSyncExternalStore(noopSubscribe, () => true, () => false);
}

/** Relative time ("5m ago") with the exact local date and time in its tooltip. */
function TimeAgo({ iso }: { iso: string }) {
  const hydrated = useHydrated();
  return (
    <time dateTime={iso} title={hydrated ? fmtDateTime(iso) : undefined} suppressHydrationWarning>
      {relTime(iso, { never: "—", absolute: hydrated })}
    </time>
  );
}

/**
 * Decision outcome tone, shared with the wizard and long-source panel via
 * dedupTone: added = success, enriched = info, duplicate = neutral,
 * conflict / blocked (needs review) = warning, failed = danger. Proposed /
 * suggested decisions also need review (warning).
 */
const tone = (d: string): BadgeTone => (d.includes("propose") || d.includes("suggest") ? "warning" : dedupTone(d));

const preClass = "max-h-64 overflow-auto rounded-xl border border-border bg-surface-muted p-3 font-mono text-xs text-foreground";

export function DecisionsClient() {
  const [stage, setStage] = React.useState("");
  const [decision, setDecision] = React.useState("");
  const [data, setData] = React.useState<Resp | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [open, setOpen] = React.useState<string | null>(null);

  React.useEffect(() => {
    (async () => {
      try {
        const p = new URLSearchParams();
        if (stage) p.set("stage", stage);
        if (decision) p.set("decision", decision);
        setData(await api<Resp>(`/api/admin/knowledge/decisions?${p}`));
        setError(null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to load");
      }
    })();
  }, [stage, decision]);

  const filtered = Boolean(stage || decision);

  const filters = (
    <>
      <Select
        density="compact"
        aria-label="Filter by stage"
        value={stage}
        onChange={(e) => setStage(e.target.value)}
        placeholder="All stages"
        className="w-44"
        options={STAGES.map((s) => ({ value: s, label: `${humanize(s)}${data?.counts.byStage[s] ? ` (${data.counts.byStage[s]})` : ""}` }))}
      />
      <Select
        density="compact"
        aria-label="Filter by decision"
        value={decision}
        onChange={(e) => setDecision(e.target.value)}
        placeholder="All decisions"
        className="w-52"
        options={Object.keys(data?.counts.byDecision ?? {}).sort().map((d) => ({ value: d, label: `${humanize(d)} (${data!.counts.byDecision[d]})` }))}
      />
    </>
  );

  return (
    <div className="space-y-4">
      {data?.migrationMissing && (
        <Alert tone="info" title="Not enabled yet">
          <p>Decision logging isn&apos;t switched on in this workspace yet.</p>
          <details className="mt-1">
            <summary className="cursor-pointer text-xs font-medium text-foreground">Technical details</summary>
            <p className="mt-1 text-xs">
              Apply Brain migration <code className="font-mono">0017_operating_intelligence.sql</code> to start logging
              decisions.
            </p>
          </details>
        </Alert>
      )}
      {error && <Alert tone="danger">{error}</Alert>}

      <TableCard
        title="Decisions"
        meta={data && data.decisions.length > 0 ? `${data.decisions.length} shown, newest first` : undefined}
        actions={filters}
      >
        {!data ? (
          <Spinner label="Loading decisions…" className="px-4" />
        ) : data.decisions.length === 0 ? (
          filtered ? (
            <EmptyState
              variant="plain"
              icon={ListChecks}
              title="No decisions match these filters"
              description="Try another stage or decision, or clear the filters."
              action={
                <Button
                  variant="secondary"
                  size="toolbar"
                  onClick={() => {
                    setStage("");
                    setDecision("");
                  }}
                >
                  Clear filters
                </Button>
              }
            />
          ) : (
            <EmptyState
              variant="plain"
              icon={ListChecks}
              title="No decisions logged yet"
              description="Compile something via Add knowledge or sync a source, and every decision will be recorded here."
              action={
                <Link href="/dashboard/sources" className={buttonClass({ variant: "secondary", size: "toolbar" })}>
                  Go to Sources
                </Link>
              }
            />
          )
        ) : (
          <Table minWidth={900} caption="Ingestion decisions">
            <THead>
              <tr>
                <Th className="w-12">
                  <span className="sr-only">Details</span>
                </Th>
                <Th>When</Th>
                <Th>Stage</Th>
                <Th>Decision</Th>
                <Th>Object</Th>
                <Th>Model</Th>
                <Th numeric>Confidence</Th>
                <Th numeric>Time</Th>
              </tr>
            </THead>
            <TBody>
              {data.decisions.map((d) => {
                const o = d.object_id ? data.objects[d.object_id] : null;
                const isOpen = open === d.id;
                const detailsId = `decision-${d.id}-details`;
                return (
                  <React.Fragment key={d.id}>
                    <Tr interactive className="cursor-pointer" onClick={() => setOpen(isOpen ? null : d.id)}>
                      <Td className="w-12 py-1 pr-0">
                        <IconButton
                          size="sm"
                          aria-label={`Details: ${humanize(d.stage)}, ${humanize(d.decision)}`}
                          aria-expanded={isOpen}
                          aria-controls={isOpen ? detailsId : undefined}
                          pressed={isOpen}
                          onClick={(e) => {
                            // The row toggles on click too; don't let it toggle back.
                            e.stopPropagation();
                            setOpen(isOpen ? null : d.id);
                          }}
                        >
                          <ChevronRight
                            size={14}
                            aria-hidden
                            className={cn("transition-transform", isOpen && "rotate-90")}
                          />
                        </IconButton>
                      </Td>
                      <Td className="whitespace-nowrap text-xs text-muted-foreground">
                        <TimeAgo iso={d.created_at} />
                      </Td>
                      <Td>
                        <Badge tone="neutral">{humanize(d.stage)}</Badge>
                      </Td>
                      <Td>
                        <Badge tone={tone(d.decision)}>{humanize(d.decision)}</Badge>
                      </Td>
                      <Td>
                        {o ? (
                          <Link
                            href={`/dashboard/knowledge/${o.id}`}
                            onClick={(e) => e.stopPropagation()}
                            className="group inline-flex min-w-0 max-w-[32ch] items-baseline gap-1.5 hover:underline"
                          >
                            <span className="shrink-0 font-mono text-xs text-accent-strong">{o.ref}</span>
                            <span className="truncate text-xs font-medium text-foreground group-hover:text-accent-strong">
                              {o.name}
                            </span>
                          </Link>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </Td>
                      <Td className="text-xs text-muted-foreground">{d.model ?? "—"}</Td>
                      <Td numeric className="text-xs text-muted-foreground">
                        {typeof d.confidence === "number" ? `${Math.round(d.confidence * 100)}%` : "—"}
                      </Td>
                      <Td numeric className="text-xs text-muted-foreground">
                        {typeof d.duration_ms === "number" ? fmtDuration(d.duration_ms) : "—"}
                      </Td>
                    </Tr>
                    {isOpen && (
                      <tr id={detailsId} className="bg-surface-muted/30">
                        <td colSpan={COLS} className="px-4 pb-3 pt-1">
                          <div className="grid gap-3 md:grid-cols-2">
                            <div className="min-w-0">
                              <p className="mb-1 text-xs font-medium text-muted-foreground">Input</p>
                              <pre className={preClass}>
                                {JSON.stringify(d.input, null, 2)}
                              </pre>
                            </div>
                            <div className="min-w-0">
                              <p className="mb-1 text-xs font-medium text-muted-foreground">Output</p>
                              <pre className={preClass}>
                                {JSON.stringify(d.output, null, 2)}
                              </pre>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </TBody>
          </Table>
        )}
      </TableCard>
    </div>
  );
}
