// POST /api/ingest — RETIRED.
//
// This was the pre-dashboard, secret-header upload path. It ran with the service
// role and trusted a caller-supplied orgId, which is exactly the tenant-crossing
// shape rule 1 forbids, and every ingest now goes through the admin-session
// routes (/api/admin/uploads, the Add-knowledge wizard, pull connectors, cron).
// Kept as a hard 410 so old integrations get a clear answer instead of a 404.

export const runtime = "nodejs";
export const preferredRegion = ["sin1"];

export async function POST() {
  return Response.json(
    {
      error: "This endpoint has been retired. Upload through the dashboard (Add knowledge / Bulk upload) or a pull connector.",
    },
    { status: 410 }
  );
}
