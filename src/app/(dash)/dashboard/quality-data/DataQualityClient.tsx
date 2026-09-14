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
  Loader2,
  ArrowRight,
} from "lucide-react";
import { Card, CardContent } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Alert } from "@/components/ui/Alert";
import { cn } from "@/lib/utils";
import type { DataQuality, QualityDoc } from "@/lib/data-quality";

const SOURCE_LABELS: Record<string, string> = {
  document: "Document",
  call_score: "Call score",
  coaching: "Coaching",
  transcript: "Transcript",
};

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

  return (
    <div className="space-y-6">
      {error && <Alert tone="danger">{error}</Alert>}

      {/* Summary cards */}
      <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5">
        <SummaryCard icon={Layers} tone={data.counts.unsearchable > 0 ? "bad" : "ok"} label="Not searchable" value={data.counts.unsearchable} />
        <SummaryCard icon={AlertTriangle} tone={data.counts.failedRuns > 0 ? "bad" : "ok"} label="Failed runs" value={data.counts.failedRuns} />
        <SummaryCard icon={CalendarClock} tone={data.counts.reviewDue > 0 ? "warn" : "ok"} label="Review due" value={data.counts.reviewDue} />
        <SummaryCard icon={Clock} tone={data.counts.stale > 0 ? "warn" : "ok"} label="Stale (90d+)" value={data.counts.stale} />
        <SummaryCard icon={UserX} tone={data.counts.noOwner > 0 ? "warn" : "ok"} label="No owner" value={data.counts.noOwner} />
      </div>

      {allClear ? (
        <Card>
          <CardContent className="flex items-center gap-3 p-6">
            <CheckCircle2 className="h-6 w-6 text-emerald-500" />
            <div>
              <p className="font-medium">Knowledge base is in good shape.</p>
              <p className="text-sm text-muted-foreground">
                Everything is searchable, owned, fresh, and processing cleanly across {data.totalDocuments.toLocaleString()} documents.
              </p>
            </div>
          </CardContent>
        </Card>
      ) : (
        <div className="space-y-6">
          {/* Not searchable — highest priority (reprocess) */}
          {data.unsearchable.length > 0 && (
            <Section title="Not searchable" hint="Documents with no embedded chunks. Reprocess to make them retrievable." tone="bad">
              <DocList
                docs={data.unsearchable}
                action={(d) => (
                  <Button variant="outline" size="sm" onClick={() => reprocess(d.id)} disabled={reprocessing === d.id}>
                    {reprocessing === d.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
                    Reprocess
                  </Button>
                )}
              />
            </Section>
          )}

          {/* Failed runs */}
          {data.failedRuns.length > 0 && (
            <Section title="Failed ingestion runs" hint="Open the source to retry a failed sync." tone="bad">
              <ul className="divide-y divide-border rounded-lg border border-border">
                {data.failedRuns.map((r) => (
                  <li key={r.id} className="flex items-center gap-3 px-3 py-2.5">
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{r.error || "Unknown error"}</span>
                      <span className="text-xs text-muted-foreground">{r.trigger} · {new Date(r.startedAt).toLocaleString()}</span>
                    </span>
                    {r.dataSourceId ? (
                      <Link href={`/dashboard/sources/${r.dataSourceId}`} className="inline-flex items-center gap-1 rounded-lg border border-border px-2.5 py-1.5 text-sm text-muted-foreground hover:bg-surface-muted hover:text-foreground">
                        Open source <ArrowRight className="h-3.5 w-3.5" />
                      </Link>
                    ) : (
                      <Link href="/dashboard/processing" className="text-sm text-accent hover:underline">Processing</Link>
                    )}
                  </li>
                ))}
              </ul>
            </Section>
          )}

          {/* Review due */}
          {data.reviewDue.length > 0 && (
            <Section title="Review date passed" hint="These sources are due for an owner review." tone="warn">
              <DocList docs={data.reviewDue} action={(d) => (
                <Link href={`/dashboard/documents/${d.id}`} className="text-sm text-accent hover:underline">Open</Link>
              )} />
            </Section>
          )}

          {/* Stale */}
          {data.stale.length > 0 && (
            <Section title="Stale knowledge" hint="Not updated in 90+ days. Confirm it's still accurate or assign a review." tone="warn">
              <DocList docs={data.stale} action={(d) => (
                <Link href={`/dashboard/documents/${d.id}`} className="text-sm text-accent hover:underline">Open</Link>
              )} />
            </Section>
          )}

          {/* Collections without owner */}
          {data.collectionsNoOwner.length > 0 && (
            <Section title="Collections without an owner" hint="Assign an owner in each collection's governance settings." tone="warn">
              <ul className="flex flex-wrap gap-2">
                {data.collectionsNoOwner.map((c) => (
                  <Link key={c.id} href="/dashboard/collections" className="inline-flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm hover:bg-surface-muted">
                    {c.name} <ArrowRight className="h-3.5 w-3.5 text-muted-foreground" />
                  </Link>
                ))}
              </ul>
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

function SummaryCard({ icon: Icon, tone, label, value }: { icon: typeof Clock; tone: "ok" | "warn" | "bad"; label: string; value: number }) {
  const cls = tone === "bad" && value > 0 ? "text-rose-500" : tone === "warn" && value > 0 ? "text-amber-500" : "text-emerald-500";
  return (
    <Card>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 text-muted-foreground">
          <Icon className="h-4 w-4" aria-hidden />
          <span className="text-xs font-medium">{label}</span>
        </div>
        <p className={cn("mt-1.5 text-2xl font-semibold tabular-nums", value > 0 ? cls : "text-foreground")}>{value}</p>
      </CardContent>
    </Card>
  );
}

function Section({ title, hint, tone, children }: { title: string; hint: string; tone: "bad" | "warn"; children: React.ReactNode }) {
  return (
    <Card>
      <CardContent className="p-5">
        <div className="mb-3 flex items-start gap-2">
          <span className={cn("mt-1 h-2 w-2 shrink-0 rounded-full", tone === "bad" ? "bg-rose-500" : "bg-amber-500")} />
          <div>
            <h2 className="text-base font-semibold">{title}</h2>
            <p className="text-xs text-muted-foreground">{hint}</p>
          </div>
        </div>
        {children}
      </CardContent>
    </Card>
  );
}

function DocList({ docs, action }: { docs: QualityDoc[]; action: (d: QualityDoc) => React.ReactNode }) {
  return (
    <ul className="divide-y divide-border rounded-lg border border-border">
      {docs.map((d) => (
        <li key={d.id} className="flex items-center gap-3 px-3 py-2.5">
          <span className="min-w-0 flex-1">
            <Link href={`/dashboard/documents/${d.id}`} className="block truncate text-sm font-medium text-accent hover:underline">
              {d.title || "Untitled"}
            </Link>
            <span className="text-xs text-muted-foreground">{d.reason}</span>
          </span>
          <Badge tone="neutral">{SOURCE_LABELS[d.sourceType] ?? d.sourceType}</Badge>
          {action(d)}
        </li>
      ))}
    </ul>
  );
}
