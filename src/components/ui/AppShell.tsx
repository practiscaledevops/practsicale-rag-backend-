"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LayoutDashboard,
  Database,
  Upload,
  FileText,
  MessageSquareText,
  KeyRound,
  Plug,
  BarChart3,
  FlaskConical,
  Users,
  Brain,
  LogOut,
  Menu,
  X,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { supabaseBrowser } from "@/lib/supabase-server";
import { Button } from "./Button";

/**
 * Complete navigation for the dashboard. Defined ONCE here so section page
 * agents never touch the shell — adding a page means adding a route, not editing
 * this list (it already links every planned section).
 */
interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
}

const NAV: NavItem[] = [
  { href: "/dashboard", label: "Overview", icon: LayoutDashboard },
  { href: "/dashboard/sources", label: "Data Sources", icon: Database },
  { href: "/dashboard/uploads", label: "Uploads", icon: Upload },
  { href: "/dashboard/documents", label: "Documents", icon: FileText },
  { href: "/dashboard/prompts", label: "Prompts", icon: MessageSquareText },
  { href: "/dashboard/keys", label: "API Keys", icon: KeyRound },
  { href: "/dashboard/connectors", label: "Connectors", icon: Plug },
  { href: "/dashboard/analytics", label: "Analytics", icon: BarChart3 },
  { href: "/dashboard/playground", label: "Playground", icon: FlaskConical },
  { href: "/dashboard/admins", label: "Admins", icon: Users },
];

/** Is `href` the active route? Overview matches exactly; others match prefix. */
function isActive(pathname: string, href: string): boolean {
  if (href === "/dashboard") return pathname === "/dashboard";
  return pathname === href || pathname.startsWith(href + "/");
}

export function AppShell({
  email,
  children,
}: {
  email: string;
  children: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [mobileOpen, setMobileOpen] = React.useState(false);
  const [signingOut, setSigningOut] = React.useState(false);

  // Close the mobile drawer whenever the route changes.
  React.useEffect(() => {
    setMobileOpen(false);
  }, [pathname]);

  async function signOut() {
    setSigningOut(true);
    await supabaseBrowser().auth.signOut();
    router.replace("/login");
    router.refresh();
  }

  const nav = (
    <nav className="flex-1 space-y-1 px-3 py-4" aria-label="Primary">
      {NAV.map(({ href, label, icon: Icon }) => {
        const active = isActive(pathname, href);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium transition-colors",
              active
                ? "bg-accent/10 text-accent"
                : "text-muted-foreground hover:bg-surface-muted hover:text-foreground"
            )}
          >
            <Icon className="h-4 w-4 shrink-0" aria-hidden="true" />
            {label}
          </Link>
        );
      })}
    </nav>
  );

  const brand = (
    <div className="flex h-14 items-center gap-2 border-b border-border px-5">
      <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-accent text-accent-foreground">
        <Brain className="h-4 w-4" aria-hidden="true" />
      </div>
      <span className="text-sm font-semibold">Practiscale Brain</span>
    </div>
  );

  return (
    <div className="flex min-h-screen bg-background">
      {/* Desktop sidebar */}
      <aside className="hidden w-60 shrink-0 flex-col border-r border-border bg-surface lg:flex">
        {brand}
        {nav}
      </aside>

      {/* Mobile drawer */}
      {mobileOpen && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <div
            className="absolute inset-0 bg-black/50"
            aria-hidden="true"
            onClick={() => setMobileOpen(false)}
          />
          <aside className="relative z-10 flex h-full w-60 flex-col border-r border-border bg-surface">
            {brand}
            {nav}
          </aside>
        </div>
      )}

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-14 items-center justify-between gap-3 border-b border-border bg-surface px-4 lg:px-6">
          <Button
            variant="ghost"
            size="icon"
            className="lg:hidden"
            aria-label={mobileOpen ? "Close menu" : "Open menu"}
            onClick={() => setMobileOpen((v) => !v)}
          >
            {mobileOpen ? (
              <X className="h-5 w-5" />
            ) : (
              <Menu className="h-5 w-5" />
            )}
          </Button>

          <div className="ml-auto flex items-center gap-3">
            <span
              className="hidden text-sm text-muted-foreground sm:inline"
              title={email}
            >
              {email}
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={signOut}
              disabled={signingOut}
            >
              <LogOut className="h-4 w-4" aria-hidden="true" />
              <span className="hidden sm:inline">
                {signingOut ? "Signing out…" : "Sign out"}
              </span>
            </Button>
          </div>
        </header>

        <main className="flex-1 p-4 lg:p-6">{children}</main>
      </div>
    </div>
  );
}
