// Supabase clients for the dashboard (SSR + browser), built on @supabase/ssr.
//
// These are the *auth-aware* clients: they carry the signed-in admin's session
// via cookies and respect Row Level Security. They are distinct from the
// service-role client in src/lib/supabase.ts (which bypasses RLS and is used by
// server ingestion / trusted lookups). Keep both:
//   - supabaseServer()  — read the session in Server Components / route handlers.
//   - supabaseBrowser() — sign-in / sign-out from Client Components.
//
// SECURITY: org_id is never read from these clients' user input. Session helpers
// (lib/auth/session.ts) resolve org membership via the service-role client.

import {
  createServerClient,
  createBrowserClient,
  type CookieOptions,
} from "@supabase/ssr";
import { isDemo } from "@/lib/demo/mode";
import { fakeSupabase } from "@/lib/demo/client";

const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

/**
 * Server-side Supabase client bound to the request's cookies.
 * Use in Server Components, Server Actions, and route handlers to read the
 * authenticated admin's session. In Next.js 15 `cookies()` is async.
 *
 * Note: Server Components cannot set cookies; writes are swallowed. The
 * middleware (src/middleware.ts) is responsible for refreshing the session
 * cookie on each request.
 */
export async function supabaseServer() {
  if (isDemo()) return fakeSupabase();
  // Dynamic import so this module stays importable from Client Components (which
  // import supabaseBrowser below). A static `next/headers` import would taint
  // the client bundle and fail the build.
  const { cookies } = await import("next/headers");
  const cookieStore = await cookies();
  return createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return cookieStore.getAll();
      },
      setAll(
        cookiesToSet: { name: string; value: string; options?: CookieOptions }[]
      ) {
        try {
          for (const { name, value, options } of cookiesToSet) {
            cookieStore.set(name, value, options);
          }
        } catch {
          // Called from a Server Component — cookie mutation is not allowed
          // there. Safe to ignore; middleware handles session refresh.
        }
      },
    },
  });
}

/**
 * Browser Supabase client for Client Components (login form, sign out).
 * Reads/writes the session cookie in the browser.
 */
export function supabaseBrowser() {
  if (isDemo()) return fakeSupabase();
  return createBrowserClient(url, anonKey);
}
