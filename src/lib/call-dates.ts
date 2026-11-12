/** DATE values are calendar days. Import timestamps never establish occurrence. */
export function validCallDate(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith("0000")) return null;
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === value ? value : null;
}

export function recordedCallDate(meta: Record<string, unknown>): string | null {
  // Pre-v2 metadata replaced call_date with the import date. Only the preserved
  // reported date is trustworthy until the source metadata has been repaired.
  return validCallDate(meta.call_date_basis === "source" ? meta.call_date : meta.reported_call_date);
}

export function outcomeTimestamp(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
