"use client";

// Analytics — read-only usage reporting for the org.
//
// Fetches aggregates from GET /api/admin/usage (which resolves org server-side
// and enforces the 'analytics' permission) and renders totals, a daily time
// series (recharts), and breakdowns by model/tier and by API key.

import * as React from "react";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
} from "recharts";
import { Activity, ArrowDownToLine, ArrowUpFromLine, CircleDollarSign, BarChart3 } from "lucide-react";
import {
  Alert,
  EmptyState,
  PageHeader,
  SectionCard,
  Segmented,
  Skeleton,
  StatGrid,
  StatTile,
  Table,
  TableCard,
  TableEmptyRow,
  TableSkeletonRows,
  Tag,
  TBody,
  Td,
  Th,
  THead,
  Tr,
  type SegmentedOption,
} from "@/components/ui";
import { CHART } from "@/lib/chart-theme";
import { DASH, fmtCompact, fmtInt, humanize } from "@/lib/format";
import { TIER_LABELS } from "@/lib/ui-labels";

/** LLM cost at 4 decimals on this page, so per-model and per-key rows add up to the total. */
const costFmt = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 4,
  maximumFractionDigits: 4,
});
const fmtCost = (usd: number) => (Number.isFinite(usd) ? costFmt.format(usd) : DASH);

interface Bucket {
  requests: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}
interface UsageResponse {
  range: { days: number; since: string };
  totals: Bucket;
  series: Array<{ date: string } & Bucket>;
  byModel: Array<{ model: string; tier: string } & Bucket>;
  byKey: Array<{ api_key_id: string | null; name: string } & Bucket>;
}

const RANGES = [7, 30, 90] as const;
const RANGE_OPTIONS: SegmentedOption<string>[] = RANGES.map((r) => ({ value: String(r), label: `${r} days` }));

const dayShort = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
const dayLong = new Intl.DateTimeFormat("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

/** "2026-07-29" -> "Jul 29" (UTC: the series is bucketed by UTC day). */
function fmtDay(d: string): string {
  return dayShort.format(new Date(d + "T00:00:00Z"));
}
/** "2026-07-29" -> "Wed, Jul 29" for the tooltip. */
function fmtDayLong(d: string): string {
  return dayLong.format(new Date(d + "T00:00:00Z"));
}

function tierLabel(tier: string): string {
  return (TIER_LABELS as Record<string, string>)[tier] ?? humanize(tier);
}

export default function AnalyticsPage() {
  const [days, setDays] = React.useState<number>(30);
  const [data, setData] = React.useState<UsageResponse | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    fetch(`/api/admin/usage?days=${days}`, { cache: "no-store" })
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json?.error || `Request failed (${res.status})`);
        return json as UsageResponse;
      })
      .then((json) => {
        if (!cancelled) setData(json);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : "Failed to load usage");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [days]);

  const totals = data?.totals;
  const hasSeriesData = !!data && data.series.some((d) => d.requests > 0);
  const rangeLabel = `${days} days`;

  return (
    <div>
      <PageHeader
        title="Analytics"
        description="Requests, tokens and cost across every app that uses the Brain."
        actions={
          <Segmented
            label="Date range"
            value={String(days)}
            options={RANGE_OPTIONS}
            onChange={(v) => setDays(Number(v))}
          />
        }
      />

      <div className="space-y-4">
        {error && (
          <Alert tone="danger" title="Couldn't load analytics">
            <span className="text-danger">{error}</span>
          </Alert>
        )}

        {/* Totals */}
        <section aria-label="Totals">
          <StatGrid cols={4}>
            <StatTile
              icon={Activity}
              label="Requests"
              value={totals ? fmtInt(totals.requests) : "—"}
              hint={`Last ${rangeLabel}`}
              loading={loading}
            />
            <StatTile
              icon={ArrowDownToLine}
              label="Input tokens"
              value={totals ? fmtCompact(totals.input_tokens) : "—"}
              title={totals ? fmtInt(totals.input_tokens) : undefined}
              hint={totals ? `${fmtInt(totals.input_tokens)} total` : undefined}
              loading={loading}
            />
            <StatTile
              icon={ArrowUpFromLine}
              label="Output tokens"
              value={totals ? fmtCompact(totals.output_tokens) : "—"}
              title={totals ? fmtInt(totals.output_tokens) : undefined}
              hint={totals ? `${fmtInt(totals.output_tokens)} total` : undefined}
              loading={loading}
            />
            <StatTile
              icon={CircleDollarSign}
              label="Est. cost"
              value={totals ? fmtCost(totals.cost_usd) : "—"}
              hint="Estimated (USD)"
              loading={loading}
            />
          </StatGrid>
        </section>

        {/* Time series */}
        <SectionCard icon={BarChart3} title="Requests over time" description={`Daily · last ${rangeLabel}`}>
          <div className="h-64 w-full">
            {loading ? (
              <Skeleton className="h-full w-full rounded-xl" />
            ) : hasSeriesData ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data!.series} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                  <defs>
                    <linearGradient id="analytics-requests-fill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor={CHART.primary} stopOpacity={0.35} />
                      <stop offset="100%" stopColor={CHART.primary} stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke={CHART.grid} strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tickFormatter={fmtDay}
                    tick={CHART.tick}
                    axisLine={false}
                    tickLine={false}
                    minTickGap={24}
                  />
                  <YAxis allowDecimals={false} tick={CHART.tick} axisLine={false} tickLine={false} width={40} />
                  <Tooltip
                    labelFormatter={(l) => fmtDayLong(String(l))}
                    formatter={(v) => [fmtInt(Number(v)), "Requests"] as [string, string]}
                    contentStyle={CHART.tooltip.contentStyle}
                    labelStyle={CHART.tooltip.labelStyle}
                    itemStyle={CHART.tooltip.itemStyle}
                    cursor={{ stroke: CHART.axis, strokeOpacity: 0.35 }}
                  />
                  <Area
                    type="monotone"
                    dataKey="requests"
                    stroke={CHART.primary}
                    strokeWidth={2}
                    fill="url(#analytics-requests-fill)"
                    activeDot={{ r: 4, fill: CHART.primary, stroke: "rgb(var(--surface))", strokeWidth: 2 }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <EmptyState
                variant="plain"
                className="h-full justify-center"
                icon={BarChart3}
                title="No usage yet"
                description="Once the API and playground log requests, they will appear here."
              />
            )}
          </div>
        </SectionCard>

        {/* Breakdowns */}
        <div className="grid grid-cols-1 items-start gap-4 lg:grid-cols-2">
          <TableCard
            title="By model and tier"
            meta={data && !loading ? `${data.byModel.length} model${data.byModel.length === 1 ? "" : "s"}` : undefined}
          >
            <Table minWidth={0} caption="Usage by model and tier">
              <THead>
                <tr>
                  <Th>Model</Th>
                  <Th>Tier</Th>
                  <Th numeric>Requests</Th>
                  <Th numeric>Tokens</Th>
                  <Th numeric>Cost</Th>
                </tr>
              </THead>
              <TBody>
                {loading ? (
                  <TableSkeletonRows rows={3} cols={5} />
                ) : data && data.byModel.length > 0 ? (
                  data.byModel.map((m) => (
                    <Tr key={`${m.model}|${m.tier}`}>
                      <Td className="font-medium">{m.model}</Td>
                      <Td>
                        <Tag>{tierLabel(m.tier)}</Tag>
                      </Td>
                      <Td numeric>{fmtInt(m.requests)}</Td>
                      <Td numeric title={fmtInt(m.input_tokens + m.output_tokens)}>
                        {fmtCompact(m.input_tokens + m.output_tokens)}
                      </Td>
                      <Td numeric className="font-medium">
                        {fmtCost(m.cost_usd)}
                      </Td>
                    </Tr>
                  ))
                ) : (
                  <TableEmptyRow colSpan={5}>No usage in this range.</TableEmptyRow>
                )}
              </TBody>
            </Table>
          </TableCard>

          <TableCard
            title="By API key"
            meta={data && !loading ? `${data.byKey.length} key${data.byKey.length === 1 ? "" : "s"}` : undefined}
          >
            <Table minWidth={0} caption="Usage by API key">
              <THead>
                <tr>
                  <Th>Key</Th>
                  <Th numeric>Requests</Th>
                  <Th numeric>Tokens</Th>
                  <Th numeric>Cost</Th>
                </tr>
              </THead>
              <TBody>
                {loading ? (
                  <TableSkeletonRows rows={3} cols={4} />
                ) : data && data.byKey.length > 0 ? (
                  data.byKey.map((k) => (
                    <Tr key={k.api_key_id ?? "internal"}>
                      <Td className="font-medium">{k.name}</Td>
                      <Td numeric>{fmtInt(k.requests)}</Td>
                      <Td numeric title={fmtInt(k.input_tokens + k.output_tokens)}>
                        {fmtCompact(k.input_tokens + k.output_tokens)}
                      </Td>
                      <Td numeric className="font-medium">
                        {fmtCost(k.cost_usd)}
                      </Td>
                    </Tr>
                  ))
                ) : (
                  <TableEmptyRow colSpan={4}>No usage in this range.</TableEmptyRow>
                )}
              </TBody>
            </Table>
          </TableCard>
        </div>
      </div>
    </div>
  );
}
