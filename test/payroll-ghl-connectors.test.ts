import { afterEach, expect, it, vi } from "vitest";
import { payrollAccess, readPayrollClosings, renderPayrollClosings } from "@/lib/connectors/payroll-report";
import { readGhlOpportunity } from "@/lib/connectors/ghl-opportunity";

afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

it("restricts Payroll reporting to the provisioned Brain organization and key", () => {
  vi.stubEnv("PAYROLL_BRAIN_ORG_ID", "org");
  vi.stubEnv("PAYROLL_BRAIN_KEY_ID", "sales-key");
  expect(payrollAccess("org", "sales-key")).toBe(true);
  expect(payrollAccess("elsewhere", "sales-key")).toBe(false);
  expect(payrollAccess("org", "shared-key")).toBe(false);
});

it("renders Payroll totals and rejects inconsistent figures", async () => {
  vi.stubEnv("PAYROLL_REPORTS_SERVER_KEY", "fixture");
  const row = { closings: 22, usd_minor: "1850000", high_ticket: 7, low_ticket: 15,
    high_usd_minor: "1020000", low_usd_minor: "830000" };
  const request = vi.fn().mockResolvedValueOnce(Response.json([row]))
    .mockResolvedValueOnce(Response.json([{ ...row, closings: 21 }]));
  vi.stubGlobal("fetch", request);
  const signal = new AbortController().signal;
  const totals = await readPayrollClosings("2026-11-01", "2026-11-17", signal);
  expect(renderPayrollClosings(totals, "2026-11-01", "2026-11-17")).toContain("$18,500.00 USD closed across 22 deals");
  await expect(readPayrollClosings("2026-11-01", "2026-11-17", signal)).rejects.toThrow();
});

it("rejects a GHL opportunity outside the configured location", async () => {
  vi.stubEnv("BRAIN_GHL_READ_TOKEN", "fixture");
  vi.stubEnv("BRAIN_GHL_LOCATION_ID", "our-location");
  vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({
    opportunity: { id: "deal", locationId: "other-location", status: "won", pipelineId: "p", pipelineStageId: "s" },
  })));
  await expect(readGhlOpportunity("deal", new AbortController().signal)).rejects.toThrow("Unexpected CRM opportunity");
});
