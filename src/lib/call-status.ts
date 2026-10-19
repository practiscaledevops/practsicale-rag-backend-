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
