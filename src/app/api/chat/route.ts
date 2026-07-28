// DEPRECATED. The original scaffold route read `orgId` from the request body,
// which is a tenant-crossing hole. Use the secured, key-scoped endpoint instead:
//     POST /api/v1/chat   (Authorization: Bearer psk_...)
//
// The dashboard's internal "playground" chat (admin-session auth) will live at a
// separate internal route in Phase 2.

export const runtime = "nodejs";

export async function POST() {
  return Response.json(
    { error: "Deprecated. Use POST /api/v1/chat with an Authorization: Bearer psk_... key." },
    { status: 410 }
  );
}
