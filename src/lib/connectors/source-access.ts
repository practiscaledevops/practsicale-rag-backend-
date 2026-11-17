import { z } from "zod";

const payroll = "https://zxifguiyvzrafrqskeyq.supabase.co";
/** Validates the actual chatbot session, then checks the source account each time.
 * Never accepts email, role or permissions supplied in the chat body. */
export async function requireSourcePermission(token: string | null, permission: "dashboard.view" | "pipeline.view", signal: AbortSignal) {
  const url = process.env.CHATBOT_AUTH_URL;
  const anon = process.env.CHATBOT_AUTH_PUBLISHABLE_KEY;
  const key = process.env.PAYROLL_REPORTS_SERVER_KEY;
  if (!token || token.length > 12000 || !url || !anon || !key) throw new Error("Source access unavailable");
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co$/.test(url)) throw new Error("Invalid auth configuration");
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(8000)]);
  async function read(target: string, headers: Record<string, string>) {
    const response = await fetch(target, { headers, signal: deadline, cache: "no-store", redirect: "error" });
    if (!response.ok) throw new Error("Source access unavailable");
    return response.json();
  }
  const userHeaders = { apikey: anon, Authorization: `Bearer ${token}` };
  const user = z.object({ id: z.string().uuid(), email: z.string().email(), email_confirmed_at: z.string().min(1) })
    .parse(await read(`${url}/auth/v1/user`, userHeaders));
  const profiles = z.array(z.object({ is_active: z.boolean() })).length(1)
    .parse(await read(`${url}/rest/v1/profiles?select=is_active&id=eq.${user.id}`, userHeaders));
  if (!profiles[0].is_active) throw new Error("Source access denied");
  const sourceHeaders = { apikey: key, ...(key.startsWith("eyJ") ? { Authorization: `Bearer ${key}` } : {}) };
  // Explicit operator-configured aliases bind a verified immutable user ID to
  // a source identity. Never load this mapping from user-editable metadata.
  const aliases = z.record(z.string().uuid(), z.string().email()).parse(JSON.parse(process.env.SOURCE_ACCOUNT_ALIASES ?? "{}"));
  const sourceEmail = aliases[user.id] ?? user.email;
  const query = new URLSearchParams({ select: "role,role_id,active", email: `eq.${sourceEmail.trim().toLowerCase()}`, limit: "2" });
  const accounts = z.array(z.object({ role: z.string().nullable(), role_id: z.string().uuid().nullable(), active: z.boolean() })).length(1)
    .parse(await read(`${payroll}/rest/v1/admin_users?${query}`, sourceHeaders));
  const account = accounts[0];
  if (!account.active) throw new Error("Source access denied");
  if (account.role_id) {
    const roles = z.array(z.object({ permissions: z.array(z.string()) })).length(1)
      .parse(await read(`${payroll}/rest/v1/admin_roles?select=permissions&id=eq.${account.role_id}`, sourceHeaders));
    if (roles[0].permissions.includes("*") || roles[0].permissions.includes(permission)) return;
  } else if (account.role === "admin") {
    return;
  }
  throw new Error("Source access denied");
}
