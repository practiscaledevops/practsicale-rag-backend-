// DEPRECATED / not yet enabled. Content generation is deferred (see
// docs/00-master-plan.md §0.2, item 11). The original route read `orgId` from the
// request body (a tenant-crossing hole) and is disabled.
//
// When generation ships, it will live at POST /api/v1/generate, guarded by a
// scoped key with the 'generate' capability and using scope-aware retrieval.

export const runtime = "nodejs";

export async function POST() {
  return Response.json(
    { error: "Not available. Content generation is deferred; see docs/00-master-plan.md." },
    { status: 410 }
  );
}
