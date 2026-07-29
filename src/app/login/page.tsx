"use client";

import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { Loader2 } from "lucide-react";
import { supabaseBrowser } from "@/lib/supabase-server";
import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Label } from "@/components/ui/Label";
import { Alert } from "@/components/ui/Alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/Card";

/**
 * Public sign-in page. Authenticates against Supabase Auth with email +
 * password using the @supabase/ssr browser client, which writes the session
 * cookie the server and middleware read. On success we go to the requested
 * page (redirectTo) or /dashboard.
 */
function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const redirectTo = params.get("redirectTo") || "/dashboard";

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
    <main className="relative flex min-h-screen items-center justify-center bg-background px-4">
      {/* Soft brand wash behind the card */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-x-0 top-0 h-64 bg-brand-gradient opacity-[0.06]"
      />
      <div className="relative w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="Practiscale" className="h-8 w-auto" />
          <span className="rounded-full bg-accent/10 px-2.5 py-0.5 text-xs font-semibold text-accent">
            Brain · Back office
          </span>
        </div>

        <Card className="shadow-soft-lg">
          <CardHeader>
            <CardTitle>Sign in</CardTitle>
            <CardDescription>
              {demo
                ? "Demo mode — any credentials work. Just press Sign in."
                : "Admin access to the back office."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="space-y-4">
              {error && <Alert tone="danger">{error}</Alert>}

              <div className="space-y-1.5">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@practiscale.co"
                />
              </div>

              <div className="space-y-1.5">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                />
              </div>

              <Button
                type="submit"
                size="lg"
                className="w-full"
                disabled={loading}
              >
                {loading && (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                )}
                {loading ? "Signing in…" : "Sign in"}
              </Button>
            </form>
          </CardContent>
        </Card>
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
