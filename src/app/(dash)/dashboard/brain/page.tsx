import { redirect } from "next/navigation";

/**
 * /dashboard/brain — the AI Brain overview now IS the dashboard landing page.
 * Kept only so old links and bookmarks still land on it.
 */
export default function BrainOverviewRedirect() {
  redirect("/dashboard");
}
