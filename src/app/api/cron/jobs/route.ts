// GET /api/cron/jobs — drain queued job tasks. The serverless baseline runner:
// each run claims and processes as many tasks as fit in the budget, across all
// orgs. Overlapping runs are safe (tasks are claimed optimistically — a loser of
// the race gets nothing). For hours-long / high-throughput jobs, Trigger.dev
// drains the same queue in parallel (see docs/JOBS.md); this cron is the floor.
//
// SECURITY: protected by CRON_SECRET (Vercel Cron sends Authorization: Bearer …).

import { timingSafeEqual } from "node:crypto";
import { drainTasks } from "@/lib/jobs/engine";
import { drainScoringEvents } from "@/lib/connectors/scoring-events";

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];
export const maxDuration = 300;
const BUDGET_MS = 230_000;

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
function authorized(req: Request): boolean {
  const secret = process.env.CRON_SECRET;
  if (!secret) return false;
  return safeEqual(req.headers.get("authorization") ?? "", `Bearer ${secret}`);
}

export async function GET(req: Request) {
  if (!authorized(req)) return Response.json({ error: "Unauthorized" }, { status: 401 });
  const deadlineAt = Date.now() + BUDGET_MS;
  // Reserve time for ordinary jobs while the initial call backfill drains.
  const scoringRefreshed = await drainScoringEvents(Math.min(deadlineAt, Date.now() + 90_000));
  const ran = await drainTasks({ deadlineAt });
  return Response.json({ ran, scoringRefreshed });
}
