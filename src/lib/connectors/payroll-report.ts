import { z } from "zod";

const payrollRpc = "https://zxifguiyvzrafrqskeyq.supabase.co/rest/v1/rpc/brain_monthly_sales_closings";
const dashboard = "https://payroll.practicescalingsystems.com/admin?tab=closings";
const minor = z.string().regex(/^-?\d{1,15}$/).transform(Number);
const totals = z.object({
  closings: z.number().int().nonnegative(),
  usd_minor: minor,
  high_ticket: z.number().int().nonnegative(),
  low_ticket: z.number().int().nonnegative(),
  high_usd_minor: minor,
  low_usd_minor: minor,
}).refine(row => row.closings === row.high_ticket + row.low_ticket &&
  row.usd_minor === row.high_usd_minor + row.low_usd_minor);

export function payrollAccess(orgId: string, keyId: string) {
  return orgId === process.env.PAYROLL_BRAIN_ORG_ID && keyId === process.env.PAYROLL_BRAIN_KEY_ID;
}

export async function readPayrollClosings(from: string, through: string, signal: AbortSignal) {
  const key = process.env.PAYROLL_REPORTS_SERVER_KEY;
  if (!key) throw new Error("Payroll reporting is not configured");
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(6000)]);
  const response = await fetch(payrollRpc, {
    method: "POST",
    redirect: "error",
    cache: "no-store",
    headers: { apikey: key, "Content-Type": "application/json" },
    body: JSON.stringify({ p_month: from, p_through: through }),
    signal: deadline,
  });
  if (!response.ok) throw new Error("Payroll reporting is unavailable");
  return z.tuple([totals]).parse(await response.json())[0];
}

const usd = (value: number) => new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(value / 100);

export function renderPayrollClosings(row: z.infer<typeof totals>, from: string, through: string) {
  return [
    "**" + usd(row.usd_minor) + " USD closed across " + row.closings + " deals**.",
    "- High ticket: " + row.high_ticket + " deals · " + usd(row.high_usd_minor) + " USD",
    "- Low ticket: " + row.low_ticket + " deals · " + usd(row.low_usd_minor) + " USD",
    "",
    "Period: " + from + " to " + through + " (UTC, using Payroll’s reporting dates).",
    "Source: [Sales Payroll · Closings](" + dashboard + ").",
  ].join("\n");
}
