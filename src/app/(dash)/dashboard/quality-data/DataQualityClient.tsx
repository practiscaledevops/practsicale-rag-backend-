"use client";

import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import {
  Clock,
  Layers,
  CalendarClock,
  UserX,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  ArrowRight,
} from "lucide-react";
import {
  Alert,
  Badge,
  Button,
  Card,
  SectionCard,
  StatGrid,
  StatTile,
  buttonClass,
  type StatTone,
} from "@/components/ui";
import { fmtDateTime, fmtInt, relTime } from "@/lib/format";
import { sourceTypeLabel, triggerLabel } from "@/lib/ui-labels";
import type { DataQuality, QualityDoc } from "@/lib/data-quality";

/** In-page anchors: each summary tile links to its section. */
const SECTION_IDS = {
  unsearchable: "not-searchable",
  failedRuns: "failed-runs",
  reviewDue: "review-due",
  stale: "stale-knowledge",
  noOwner: "collections-without-owner",
} as const;


/** Table links: foreground text, accent on hover. */
const tableLink = "font-medium text-foreground hover:text-accent-strong hover:underline";

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

export function DataQualityClient({ data }: { data: DataQuality }) {
  const router = useRouter();
  const [error, setError] = React.useState<string | null>(null);
  const [reprocessing, setReprocessing] = React.useState<string | null>(null);

  const allClear =
    data.counts.stale === 0 &&
    data.counts.unsearchable === 0 &&
    data.counts.reviewDue === 0 &&
    data.counts.noOwner === 0 &&
    data.counts.failedRuns === 0;

  async function reprocess(id: string) {
    setReprocessing(id);
    setError(null);
    try {
      const res = await fetch(`/api/admin/documents/${encodeURIComponent(id)}/reingest`, { method: "POST" });
      if (!res.ok) {
        const json = await res.json().catch(() => ({}));
        setError(json.error ?? `Reprocess failed (${res.status})`);
        return;
      }
      router.refresh();
    } catch {
      setError("Network error — please try again.");
    } finally {
      setReprocessing(null);
    }
  }

  // Tile tone: danger/warning while there is something to fix, success when clear.
  const tileTone = (count: number, severity: "danger" | "warning"): StatTone => (count > 0 ? severity : "success");
  const anchor = (count: number, id: string) => (count > 0 ? `#${id}` : undefined);

  const openDoc = (d: QualityDoc) => (
    <Link
      href={`/dashboard/documents/${d.id}`}
      aria-label={`Open ${d.title || "untitled document"}`}
      className={buttonClass({ variant: "secondary", size: "sm" })}
    >
      Open
    </Link>
  );

  return (
    <div className="space-y-5">
      {error && (
        <Alert tone="danger" onDismiss={() => setError(null)}>
          {error}
        </Alert>
      )}

      {/* Summary tiles, each linking to its section below */}
      <StatGrid cols={3} className="lg:grid-cols-5">
        <StatTile
          icon={Layers}
          tone={tileTone(data.counts.unsearchable, "danger")}
          label="Not searchable"
          value={fmtInt(data.counts.unsearchable)}
          hint="Documents with no chunks"
          href={anchor(data.counts.unsearchable, SECTION_IDS.unsearchable)}
        />
        <StatTile
          icon={AlertTriangle}
          tone={tileTone(data.counts.failedRuns, "danger")}
          label="Failed runs"
          value={fmtInt(data.counts.failedRuns)}
          hint="Syncs that errored"
          href={anchor(data.counts.failedRuns, SECTION_IDS.failedRuns)}
        />
        <StatTile
          icon={CalendarClock}
          tone={tileTone(data.counts.reviewDue, "warning")}
          label="Review due"
          value={fmtInt(data.counts.reviewDue)}
          hint="Review date has passed"
          href={anchor(data.counts.reviewDue, SECTION_IDS.reviewDue)}
        />
        <StatTile
          icon={Clock}
          tone={tileTone(data.counts.stale, "warning")}
          label="Stale (90d+)"
          value={fmtInt(data.counts.stale)}
          hint="Not updated in 90+ days"
          href={anchor(data.counts.stale, SECTION_IDS.stale)}
        />
        <StatTile
          icon={UserX}
          tone={tileTone(data.counts.noOwner, "warning")}
          label="No owner"
          value={fmtInt(data.counts.noOwner)}
          hint="Collections without an owner"
          href={anchor(data.counts.noOwner, SECTION_IDS.noOwner)}
        />
      </StatGrid>

      {allClear ? (
        <Card className="flex items-center gap-3 p-4">
          <span aria-hidden className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-success/10 text-success">
            <CheckCircle2 size={18} />
          </span>
          <div className="min-w-0">
            <p className="text-sm font-medium text-foreground">Knowledge base is in good shape.</p>
            <p className="text-[13px] text-muted-foreground">
              Everything is searchable, owned, fresh, and processing cleanly across {fmtInt(data.totalDocuments)} documents.
            </p>
          </div>
        </Card>
      ) : (
        <div className="space-y-5">
          {/* Not searchable — highest priority (reprocess) */}
          {data.unsearchable.length > 0 && (
            <Section
              id={SECTION_IDS.unsearchable}
              icon={Layers}
              title="Not searchable"
              description="Documents with no embedded chunks. Reprocess them to make them retrievable."
              tone="danger"
              shown={data.unsearchable.length}
              total={data.counts.unsearchable}
            >
              <DocList
                docs={data.unsearchable}
                action={(d) => (
                  <Button
                    variant="secondary"
                    size="sm"
                    onClick={() => reprocess(d.id)}
                    loading={reprocessing === d.id}
                    aria-label={`Reprocess ${d.title || "untitled document"}`}
                  >
                    {reprocessing !== d.id && <RefreshCw size={14} aria-hidden />}
                    Reprocess
                  </Button>
                )}
              />
            </Section>
          )}

          {/* Failed runs */}
          {data.failedRuns.length > 0 && (
            <Section
              id={SECTION_IDS.failedRuns}
              icon={AlertTriangle}
              title="Failed ingestion runs"
              description="Open the source to retry a failed sync."
              tone="danger"
              shown={data.failedRuns.length}
              total={data.counts.failedRuns}
            >
              <ul>
                {data.failedRuns.map((r) => (
                  <li key={r.id} className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5 first:border-t-0">
                    <div className="min-w-0 flex-1">
                      <p className="break-words text-[13px] font-medium text-foreground">
                        {r.error || "Unknown error"}
                      </p>
                      <p className="truncate text-xs text-muted-foreground">
                        {triggerLabel(r.trigger)} · <TimeAgo iso={r.startedAt} />
                      </p>
                    </div>
                    {r.dataSourceId ? (
                      <Link
                        href={`/dashboard/sources/${r.dataSourceId}`}
                        className={buttonClass({ variant: "secondary", size: "sm", className: "shrink-0" })}
                      >
                        Open source
                        <ArrowRight size={14} aria-hidden />
                      </Link>
                    ) : (
                      <Link
                        href="/dashboard/processing"
                        className={buttonClass({ variant: "secondary", size: "sm", className: "shrink-0" })}
                      >
                        Processing runs
                      </Link>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {/* Review due */}
          {data.reviewDue.length > 0 && (
            <Section
              id={SECTION_IDS.reviewDue}
              icon={CalendarClock}
              title="Review date passed"
              description="These sources are due for an owner review."
              tone="warning"
              shown={data.reviewDue.length}
              total={data.counts.reviewDue}
            >
              <DocList docs={data.reviewDue} action={openDoc} />
            </Section>
          )}

          {/* Stale */}
          {data.stale.length > 0 && (
            <Section
              id={SECTION_IDS.stale}
              icon={Clock}
              title="Stale knowledge"
              description="Not updated in 90+ days. Confirm it's still accurate or assign a review."
              tone="warning"
              shown={data.stale.length}
              total={data.counts.stale}
            >
              <DocList docs={data.stale} action={openDoc} />
            </Section>
          )}

          {/* Collections without owner */}
          {data.collectionsNoOwner.length > 0 && (
            <Section
              id={SECTION_IDS.noOwner}
              icon={UserX}
              title="Collections without an owner"
              description="Assign an owner in each collection's governance settings."
              tone="warning"
              shown={data.collectionsNoOwner.length}
              total={data.counts.noOwner}
              padded
            >
              <ul className="flex flex-wrap gap-2">
                {data.collectionsNoOwner.map((c) => (
                  <li key={c.id}>
                    <Link
                      href="/dashboard/collections"
                      className="inline-flex h-7 items-center gap-1.5 rounded-full border border-border bg-surface px-3 text-[13px] text-foreground transition-colors hover:bg-surface-muted"
                    >
                      {c.name}
                      <ArrowRight size={14} aria-hidden className="text-muted-foreground" />
                    </Link>
                  </li>
                ))}
              </ul>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

function Section({
  id,
  icon,
  title,
  description,
  tone,
  shown,
  total,
  padded = false,
  children,
}: {
  id: string;
  icon: React.ComponentProps<typeof SectionCard>["icon"];
  title: string;
  description: string;
  tone: "danger" | "warning";
  shown: number;
  total: number;
  /** Pad the body (chip lists); row lists run edge to edge. */
  padded?: boolean;
  children: React.ReactNode;
}) {
  return (
    <SectionCard
      id={id}
      icon={icon}
      title={title}
      description={description}
      actions={<Badge tone={tone}>{fmtInt(total)}</Badge>}
      className="scroll-mt-4"
      bodyClassName={padded ? "p-4" : "p-0"}
    >
      {children}
      {total > shown && (
        <p
          className={
            padded
              ? "mt-3 text-xs text-muted-foreground"
              : "border-t border-border px-4 py-2.5 text-xs text-muted-foreground"
          }
        >
          Showing the first {fmtInt(shown)} of {fmtInt(total)}.
        </p>
      )}
    </SectionCard>
  );
}

function DocList({ docs, action }: { docs: QualityDoc[]; action: (d: QualityDoc) => React.ReactNode }) {
  return (
    <ul>
      {docs.map((d) => (
        <li key={d.id} className="flex items-center justify-between gap-3 border-t border-border px-4 py-2.5 first:border-t-0">
          <div className="min-w-0 flex-1">
            <Link href={`/dashboard/documents/${d.id}`} className={`block truncate text-[13px] ${tableLink}`}>
              {d.title || "Untitled"}
            </Link>
            <p className="truncate text-xs text-muted-foreground">{d.reason}</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <Badge tone="neutral" className="hidden sm:inline-flex">
              {sourceTypeLabel(d.sourceType)}
            </Badge>
            {action(d)}
          </div>
        </li>
      ))}
    </ul>
  );
}
