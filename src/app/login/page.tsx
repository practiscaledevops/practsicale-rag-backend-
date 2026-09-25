"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2, LogIn } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase-server";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/Button";
import { inputClass } from "@/components/ui/Input";
import { ThemedLogo } from "@/components/ui/Brand";

/** The shared field recipe at the chatbot login's 40px height. */
const fieldClass = cn(inputClass, "h-10");

/** Inline error callout. */
const alertClass = "rounded-xl border border-danger/30 bg-danger/10 px-3 py-2 text-[13px] text-danger-ink";

/**
 * Only honor a `redirectTo` that is a same-origin, absolute PATH. Anything else
 * — an absolute URL (`https://evil.com`), a protocol-relative URL (`//evil.com`),
 * a backslash trick (`/\evil.com`), or a `javascript:`/`data:` scheme — is a
 * post-login open-redirect / phishing vector, so we fall back to /dashboard.
 */
function safeRedirect(target: string | null): string {
  if (!target) return "/dashboard";
  // Must start with a single "/" and not begin a scheme/host.
  if (!target.startsWith("/")) return "/dashboard";
  if (target.startsWith("//") || target.startsWith("/\\")) return "/dashboard";
  return target;
}

/**
 * Public sign-in page. Authenticates against Supabase Auth with email +
 * password using the @supabase/ssr browser client, which writes the session
 * cookie the server and middleware read. On success we go to the requested
 * page (redirectTo) or /dashboard.
 */
function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const redirectTo = safeRedirect(params.get("redirectTo"));

  const demo = process.env.NEXT_PUBLIC_DEMO_MODE === "1";
  const [email, setEmail] = React.useState(demo ? "demo@practiscale.co" : "");
  const [password, setPassword] = React.useState(demo ? "demo" : "");
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setLoading(true);
    // In demo mode any credentials work — go straight to the dashboard.
    if (demo) {
      router.replace(redirectTo);
      router.refresh();
      return;
    }
    const supabase = supabaseBrowser();
    const { error } = await supabase.auth.signInWithPassword({
      email: email.trim(),
      password,
    });
    if (error) {
      setError(error.message);
      setLoading(false);
      return;
    }
    // Full navigation so Server Components re-read the fresh session cookie.
    router.replace(redirectTo);
    router.refresh();
  }

  return (
    <main className="flex min-h-app flex-col items-center justify-center bg-background bg-[radial-gradient(1200px_600px_at_50%_-10%,rgb(var(--accent-soft)),transparent_60%)] px-4 py-10">
      <div className="w-full max-w-[380px] rounded-2xl border border-border bg-surface p-5 shadow-float">
        {/* Dark wordmark in light, white wordmark in dark. */}
        <ThemedLogo className="mx-auto block h-5" />

        <h1 className="mt-4 text-center text-xl font-semibold tracking-tight">Sign in to the Brain</h1>
        <p className="mt-1 text-center text-[13px] text-muted-foreground">
          {demo
            ? "Demo mode — any credentials work. Just press Sign in."
            : "Admin access to the back office."}
        </p>

        <form onSubmit={onSubmit} className="mt-5 space-y-3.5">
          <div className="space-y-1.5">
            <label htmlFor="email" className="block text-xs font-medium text-muted-foreground">
              Email
            </label>
            <input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              placeholder="you@practiscale.co"
              className={fieldClass}
            />
          </div>

          <div className="space-y-1.5">
            <label htmlFor="password" className="block text-xs font-medium text-muted-foreground">
              Password
            </label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              required
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder="••••••••"
              className={fieldClass}
            />
          </div>

          {error && (
            <p role="alert" className={alertClass}>
              {error}
            </p>
          )}

          <Button type="submit" size="lg" className="mt-1 w-full" disabled={loading}>
            {loading ? (
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            ) : (
              <LogIn className="h-4 w-4" aria-hidden="true" />
            )}
            {loading ? "Signing in…" : "Sign in"}
          </Button>
        </form>
      </div>
    </main>
  );
}

// useSearchParams (in LoginForm) must sit under a Suspense boundary for the
// build's static prerender pass.
export default function LoginPage() {
  return (
    <React.Suspense>
      <LoginForm />
    </React.Suspense>
  );
}
