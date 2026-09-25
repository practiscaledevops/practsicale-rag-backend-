// Recharts colours for the Brain back office, as CSS-variable strings so every
// chart follows the Light / Dark theme without re-rendering (the chatbot's usage
// chart hard-codes the light palette; this avoids that bug).
//
// Usage: <CartesianGrid stroke={CHART.grid} />, <XAxis tick={CHART.tick} />,
// <Tooltip {...CHART.tooltip} cursor={{ fill: CHART.cursor }} />,
// <Bar fill={CHART.series[i % CHART.series.length]} />.

export const CHART = {
  grid: "rgb(var(--border))",
  axis: "rgb(var(--muted-foreground))",
  cursor: "rgb(var(--surface-muted))",
  primary: "rgb(var(--accent))",
  primarySoft: "rgb(var(--accent) / 0.35)",
  warning: "rgb(var(--warning))",
  danger: "rgb(var(--danger))",
  // Multi-series colours: only the status/brand tokens that stay >= 3:1 on the
  // card in both themes (the lighter --chart-* and folder tints do not on white).
  series: [
    "rgb(var(--accent))",
    "rgb(var(--info))",
    "rgb(var(--warning))",
    "rgb(var(--danger))",
    "rgb(var(--private))",
  ],
  tick: { fill: "rgb(var(--muted-foreground))", fontSize: 11 },
  tooltip: {
    contentStyle: {
      background: "rgb(var(--surface))",
      border: "1px solid rgb(var(--border))",
      borderRadius: 12,
      color: "rgb(var(--foreground))",
      fontSize: 12,
      boxShadow: "var(--shadow-soft-lg)",
    },
    labelStyle: { color: "rgb(var(--muted-foreground))" },
    itemStyle: { color: "rgb(var(--foreground))" },
  },
} as const;
