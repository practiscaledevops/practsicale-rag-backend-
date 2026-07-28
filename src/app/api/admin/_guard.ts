// Convenience re-export for admin API routes.
//
// Example route:
//   import { requireAdmin, AdminAuthError } from "@/app/api/admin/_guard";
//   export async function POST(req: Request) {
//     let admin;
//     try { admin = await requireAdmin("api_keys:write"); }
//     catch (e) {
//       const err = e as AdminAuthError;
//       return Response.json({ error: err.message }, { status: err.status });
//     }
//     // ... admin.orgId is safe to use as the tenant scope
//   }

export { requireAdmin, AdminAuthError } from "@/lib/auth/admin";
export type { AdminSession, Permissions, AdminRole } from "@/lib/auth/session";
