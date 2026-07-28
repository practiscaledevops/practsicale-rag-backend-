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
import { Activity, ArrowDownToLine, ArrowUpFromLine, DollarSign, BarChart3 } from "lucide-react";
import { PageHeader } from "@/components/ui/PageHeader";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Table, THead, TBody, Tr, Th, Td } from "@/components/ui/Table";
import { Badge } from "@/components/ui/Badge";
import { Alert } from "@/components/ui/Alert";
import { EmptyState } from "@/components/ui/EmptyState";
import { cn } from "@/lib/utils";

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

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString();
}
function fmtUsd(n: number): string {
  return `$${n.toFixed(4)}`;
}
function fmtDay(d: string): string {
  // "2026-07-29" -> "Jul 29"
  const dt = new Date(d + "T00:00:00Z");
  return dt.toLocaleDateString(undefined, { month: "short", day: "numeric", timeZone: "UTC" });
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
  const stats = [
    { label: "Requests", value: totals ? fmtInt(totals.requests) : "—", icon: Activity },
    { label: "Input tokens", value: totals ? fmtInt(totals.input_tokens) : "—", icon: ArrowDownToLine },
    { label: "Output tokens", value: totals ? fmtInt(totals.output_tokens) : "—", icon: ArrowUpFromLine },
    { label: "Est. cost", value: totals ? fmtUsd(totals.cost_usd) : "—", icon: DollarSign },
  ];

  const hasSeriesData = !!data && data.series.some((d) => d.requests > 0);

  return (
    <div>
      <PageHeader
        title="Analytics"
        description="Token usage, estimated cost, and request volume across the org."
        actions={
          <div
            className="inline-flex rounded-lg border border-border bg-surface p-0.5"
            role="group"
            aria-label="Time range"
          >
            {RANGES.map((r) => (
              <button
                key={r}
                type="button"
                onClick={() => setDays(r)}
                aria-pressed={days === r}
                className={cn(
                  "rounded-md px-3 py-1 text-sm font-medium transition-colors",
                  "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  days === r
                    ? "bg-accent/10 text-accent"
                    : "text-muted-foreground hover:text-foreground"
                )}
              >
                {r}d
              </button>
            ))}
          </div>
        }
      />

      {error && (
        <Alert tone="danger" title="Could not load analytics" className="mb-6">
          {error}
        </Alert>
      )}

      {/* Totals */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map(({ label, value, icon: Icon }) => (
          <Card key={label}>
            <CardContent className="flex items-center justify-between p-5">
              <div className="min-w-0">
                <p className="text-sm text-muted-foreground">{label}</p>
                <p className="mt-1 text-2xl font-semibold tabular-nums">{loading ? "…" : value}</p>
              </div>
              <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-surface-muted text-muted-foreground">
                <Icon className="h-5 w-5" aria-hidden="true" />
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      {/* Time series */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>Requests over time</CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
              Loading…
            </div>
          ) : hasSeriesData ? (
            <div className="h-64 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={data!.series} margin={{ top: 8, right: 8, bottom: 0, left: -12 }}>
                  <defs>
                    <linearGradient id="reqFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="rgb(var(--accent))" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="rgb(var(--accent))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid stroke="rgb(var(--border))" strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="date"
                    tickFormatter={fmtDay}
                    tick={{ fill: "rgb(var(--muted-foreground))", fontSize: 12 }}
                    stroke="rgb(var(--border))"
                    minTickGap={24}
                  />
                  <YAxis
                    allowDecimals={false}
                    tick={{ fill: "rgb(var(--muted-foreground))", fontSize: 12 }}
                    stroke="rgb(var(--border))"
                    width={40}
                  />
                  <Tooltip
                    labelFormatter={(l) => fmtDay(String(l))}
                    formatter={(v) => [fmtInt(Number(v)), "Requests"] as [string, string]}
                    contentStyle={{
                      background: "rgb(var(--surface))",
                      border: "1px solid rgb(var(--border))",
                      borderRadius: 8,
                      color: "rgb(var(--foreground))",
                      fontSize: 12,
                    }}
                  />
                  <Area
                    type="monotone"
                    dataKey="requests"
                    stroke="rgb(var(--accent))"
                    strokeWidth={2}
                    fill="url(#reqFill)"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <EmptyState
              icon={BarChart3}
              title="No usage yet"
              description="Once the API and playground log requests, they will appear here."
            />
          )}
        </CardContent>
      </Card>

      {/* Breakdowns */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>By model &amp; tier</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : data && data.byModel.length > 0 ? (
              <Table>
                <THead>
                  <tr>
                    <Th>Model</Th>
                    <Th>Tier</Th>
                    <Th className="text-right">Reqs</Th>
                    <Th className="text-right">Tokens</Th>
                    <Th className="text-right">Cost</Th>
                  </tr>
                </THead>
                <TBody>
                  {data.byModel.map((m) => (
                    <Tr key={`${m.model}|${m.tier}`}>
                      <Td className="font-medium">{m.model}</Td>
                      <Td>
                        <Badge tone="neutral">{m.tier}</Badge>
                      </Td>
                      <Td className="text-right tabular-nums">{fmtInt(m.requests)}</Td>
                      <Td className="text-right tabular-nums">
                        {fmtInt(m.input_tokens + m.output_tokens)}
                      </Td>
                      <Td className="text-right tabular-nums">{fmtUsd(m.cost_usd)}</Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            ) : (
              <p className="text-sm text-muted-foreground">No data.</p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>By API key</CardTitle>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : data && data.byKey.length > 0 ? (
              <Table>
                <THead>
                  <tr>
                    <Th>Key</Th>
                    <Th className="text-right">Reqs</Th>
                    <Th className="text-right">Tokens</Th>
                    <Th className="text-right">Cost</Th>
                  </tr>
                </THead>
                <TBody>
                  {data.byKey.map((k) => (
                    <Tr key={k.api_key_id ?? "internal"}>
                      <Td className="font-medium">{k.name}</Td>
                      <Td className="text-right tabular-nums">{fmtInt(k.requests)}</Td>
                      <Td className="text-right tabular-nums">
                        {fmtInt(k.input_tokens + k.output_tokens)}
                      </Td>
                      <Td className="text-right tabular-nums">{fmtUsd(k.cost_usd)}</Td>
                    </Tr>
                  ))}
                </TBody>
              </Table>
            ) : (
              <p className="text-sm text-muted-foreground">No data.</p>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
