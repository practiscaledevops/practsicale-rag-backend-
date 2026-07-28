import { redirect } from "next/navigation";
import { getAdmin } from "@/lib/auth/session";
import { AppShell } from "@/components/ui/AppShell";

// Authenticated dashboard shell. Middleware already blocks unauthenticated
// visitors, but we resolve the admin here too (defense in depth) to render the
// signed-in email and to guarantee every /dashboard page has a real session.
export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const admin = await getAdmin();
  if (!admin) redirect("/login");

  return <AppShell email={admin.email}>{children}</AppShell>;
}
