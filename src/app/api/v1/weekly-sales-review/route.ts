import { AuthError, resolveContext } from "@/lib/auth/context";
import { requireCapability, scopeFilters } from "@/lib/auth/scope";
import { appointmentSnapshotCounts } from "@/lib/connectors/appointment-snapshot";
import { payrollAccess } from "@/lib/connectors/payroll-report";
import { requireSourcePermission } from "@/lib/connectors/source-access";
import { callReviewInScope } from "@/lib/orchestrator";
import { checkRateLimit, rateLimitHeaders } from "@/lib/ratelimit";
import { zonedRangeBoundsUTC } from "@/lib/timezone";
import { readWeeklyCoaching } from "@/lib/weekly-call-coaching";
import { completedReviewWeek, readWeeklyPayroll, weeklyReviewRequest } from "@/lib/weekly-sales-review";
import { z } from "zod";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 120;

const headers = { "Cache-Control": "private, no-store" };
const schema = weeklyReviewRequest.extend({ canReviewCalls: z.boolean() });

async function readSection<T>(read: () => Promise<T>, message: string) {
  try {
    return { status: "ready" as const, data: await read() };
  } catch {
    return { status: "unavailable" as const, message };
  }
}

export async function POST(req: Request) {
  let ctx;
  try {
    ctx = await resolveContext(req);
    requireCapability(ctx.key, "chat");
    if (!payrollAccess(ctx.orgId, ctx.key.id)) throw new AuthError("Report access denied", 403);
  } catch (error) {
    return Response.json({ error: error instanceof AuthError && error.status < 500 ? "Report access denied." : "Report access could not be verified." },
      { status: error instanceof AuthError ? error.status : 500, headers });
  }

  const parsed = schema.safeParse(await req.json().catch(() => null));
  const week = parsed.success ? completedReviewWeek(parsed.data.from) : null;
  if (!parsed.success || !week) return Response.json({ error: "Choose a Monday from a completed week." }, { status: 400, headers });
  const accessSignal = AbortSignal.any([req.signal, AbortSignal.timeout(10_000)]);
  let email: string;
  try {
    // This company-wide review is limited to chatbot admins with current Payroll
    // reporting access. Payroll independently checks this permission again.
    email = await requireSourcePermission(req.headers.get("x-chatbot-user-token"), "reporting.view", accessSignal, { adminOnly: true });
  } catch {
    return Response.json({ error: "Weekly Sales Review requires chatbot admin and Payroll reporting access." }, { status: 403, headers });
  }

  const rate = await checkRateLimit(`weekly-sales-review:${ctx.key.id}`, Math.min(ctx.key.rate_limit_per_min || 12, 12));
  if (!rate.ok) return Response.json({ error: "Too many report requests. Try again shortly." }, { status: 429, headers: { ...headers, ...rateLimitHeaders(rate) } });
  const { from, through, timeZone } = week;
  const { refreshGhl, canReviewCalls } = parsed.data;
  const signal = AbortSignal.any([req.signal, AbortSignal.timeout(refreshGhl ? 100_000 : 35_000)]);
  const bounds = zonedRangeBoundsUTC(from, through, timeZone);
  const ghlSection = readSection(
    () => appointmentSnapshotCounts({ start: bounds.startISO, end: bounds.endISO }, signal, refreshGhl),
    refreshGhl ? "The GHL refresh did not finish. The last completed scan is still available if it covers this week."
      : "No complete GHL appointment snapshot could be read for this week. Try refreshing from GHL.",
  );
  if (refreshGhl) return Response.json({ week, ghl: await ghlSection }, { headers });

  const [payroll, ghl, scoring] = await Promise.all([
    readSection(() => readWeeklyPayroll(from, through, email, signal), "Payroll weekly figures could not be verified."),
    ghlSection,
    canReviewCalls && callReviewInScope(scopeFilters(ctx.key))
      ? readSection(() => readWeeklyCoaching(ctx.orgId, from, through, timeZone, signal), "Call Scoring coverage could not be verified.")
      : Promise.resolve({ status: "unavailable" as const, message: "Your account does not have access to this Call Scoring review." }),
  ]);
  return Response.json({ week, payroll, ghl, scoring }, { headers });
}
