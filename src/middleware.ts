// Middleware: refresh the Supabase session cookie on every request and gate the
// dashboard behind authentication.
//
// Why here: Server Components can't write cookies, so the session's rolling
// refresh has to happen in middleware. We also cheaply redirect unauthenticated
// visitors away from /dashboard/* before any page renders. (Fine-grained
// permission checks stay in the pages/routes via requireAdmin.)

import { NextResponse, type NextRequest } from "next/server";
import { createServerClient, type CookieOptions } from "@supabase/ssr";

export async function middleware(req: NextRequest) {
  // DEMO MODE: no Supabase session — let every route through (getAdmin() returns
  // the demo admin, so the dashboard renders).
  if (process.env.NEXT_PUBLIC_DEMO_MODE === "1" || process.env.DEMO_MODE === "1") {
    return NextResponse.next({ request: req });
  }

  // Start from a pass-through response we can attach refreshed cookies to.
  let res = NextResponse.next({ request: req });

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return req.cookies.getAll();
        },
        setAll(
          cookiesToSet: { name: string; value: string; options?: CookieOptions }[]
        ) {
          // Write to both the request (so downstream sees it) and the response
          // (so the browser stores the refreshed cookie).
          for (const { name, value } of cookiesToSet) {
            req.cookies.set(name, value);
          }
          res = NextResponse.next({ request: req });
          for (const { name, value, options } of cookiesToSet) {
            res.cookies.set(name, value, options);
          }
        },
      },
    }
  );

  // Touch the user to trigger a token refresh when needed.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  // Gate the dashboard. Unauthenticated -> /login (remember where they wanted).
  const { pathname } = req.nextUrl;
  const isDashboard = pathname === "/dashboard" || pathname.startsWith("/dashboard/");
  if (isDashboard && !user) {
    const loginUrl = req.nextUrl.clone();
    loginUrl.pathname = "/login";
    loginUrl.searchParams.set("redirectTo", pathname);
    return NextResponse.redirect(loginUrl);
  }

  return res;
}

export const config = {
  // Run on app routes but skip static assets, image optimizer, and API routes
  // (API routes enforce their own auth via requireAdmin / resolveContext).
  matcher: ["/((?!_next/static|_next/image|favicon.ico|api/).*)"],
};
