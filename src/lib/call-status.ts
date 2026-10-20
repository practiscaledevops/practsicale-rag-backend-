// A manager/CRM status is current truth; call_outcome is the model's original
// interpretation and may still say FOLLOW_UP after the deal has closed.
export function callStatus(meta: Record<string, unknown>): string {
  return typeof meta.call_status === "string" && meta.call_status.trim() ? meta.call_status.trim().toLowerCase() : "pending";
}
export function callStatusLabel(meta: Record<string, unknown>): string {
  const status = callStatus(meta);
  return ({ closed: "Closed", not_closed: "Not Closed", disqualified: "Disqualified", pending: "Pending" } as Record<string, string>)[status] ?? status;
}
export function closingTypeLabel(meta: Record<string, unknown>): string {
  return meta.ticket_category === "high_ticket" ? "High Ticket" : meta.ticket_category === "low_ticket" ? "Low Ticket" : "Unclassified";
}

export function originalOutcomeLabel(meta: Record<string, unknown>): string {
  const value = typeof meta.call_outcome === "string" ? meta.call_outcome.toUpperCase() : "";
  return ({ CLOSED: "Closed", FOLLOW_UP: "Follow Up", LOST: "Lost" } as Record<string, string>)[value] ?? "Unknown";
}

export function callSequenceLabel(meta: Record<string, unknown>): string {
  const n = Number(meta.call_sequence);
  return Number.isInteger(n) && n > 0 ? `Call ${n}${n > 1 ? " (follow-up call)" : " (initial call)"}` : "Unknown";
}

/** Keep current CRM truth inside the numbered, citeable evidence itself. Legacy
 * transcript headers can still contain the model's original "Outcome: CLOSED"
 * while a historical backfill is pending. A separate roster alone isn't enough
 * to stop a model from mistaking that old header for the current CRM status. */
export function currentCallEvidence(content: string, sourceType: string | null | undefined, meta: Record<string, unknown>): string {
  if (sourceType !== "call_score" && sourceType !== "transcript") return content;
  const historical = content.replace(/(^|\n)Outcome:\s*(CLOSED|FOLLOW_UP|LOST)(?=\r?\n|$)/g, "$1Original model outcome (historical; not CRM status): $2");
  return [
    `Call sequence: ${callSequenceLabel(meta)}`,
    `Original call outcome: ${originalOutcomeLabel(meta)} (historical; separate from current CRM status)`,
    `Current CRM status: ${callStatusLabel(meta)}`,
    `Closing type: ${closingTypeLabel(meta)}`,
    ...(meta.overall_score != null ? [`Current QA score: ${meta.overall_score}/100${meta.performance_band ? ` (${meta.performance_band})` : ""}`] : []),
    "These current CRM/QA fields are authoritative. Outcomes in the original report or transcript below are historical model interpretations and cannot override these fields.",
    "",
    historical,
  ].join("\n");
}
