import { z } from "zod";

const opportunityResponse = z.object({
  opportunity: z.object({
    id: z.string(),
    locationId: z.string(),
    status: z.enum(["open", "won", "lost", "abandoned"]),
    pipelineId: z.string(),
    pipelineStageId: z.string(),
    lastStatusChangeAt: z.string().nullable().optional(),
    monetaryValue: z.number().finite().nullable().optional(),
  }),
});

export const ghlOpportunityIdPattern = /^[A-Za-z0-9_-]{15,100}$/;

export function ghlOpportunityCitation(id: string): string {
  return `ghl-opportunity:${id}`;
}

/** Fetch a single live CRM record after the caller has authorized its use. */
export async function readGhlOpportunity(id: string, signal: AbortSignal) {
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(id)) throw new Error("Invalid opportunity ID");
  const token = process.env.BRAIN_GHL_READ_TOKEN;
  const location = process.env.BRAIN_GHL_LOCATION_ID;
  if (!token || !location) throw new Error("Live CRM access is not configured");
  const response = await fetch("https://services.leadconnectorhq.com/opportunities/" + id, {
    headers: { Authorization: "Bearer " + token, Version: "v3", Accept: "application/json" },
    redirect: "error",
    cache: "no-store",
    signal: AbortSignal.any([signal, AbortSignal.timeout(6000)]),
  });
  if (!response.ok) throw new Error("CRM opportunity lookup unavailable");
  const { opportunity } = opportunityResponse.parse(await response.json());
  if (opportunity.locationId !== location || opportunity.id !== id) throw new Error("Unexpected CRM opportunity");
  return opportunity;
}
