import type { Metadata } from "next";

// page.tsx is a client component, so its <title> is set here (the route announcer reads document.title).
export const metadata: Metadata = { title: "Model policy" };

export default function Layout({ children }: { children: React.ReactNode }) {
  return children;
}
