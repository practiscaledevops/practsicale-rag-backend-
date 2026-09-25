import { redirect } from "next/navigation";
import type { Metadata } from "next";

export const metadata: Metadata = { title: "Brain" };

/**
 * /dashboard/brain — the AI Brain overview now IS the dashboard landing page.
 * Kept only so old links and bookmarks still land on it.
 */
export default function BrainOverviewRedirect() {
  redirect("/dashboard");
}
