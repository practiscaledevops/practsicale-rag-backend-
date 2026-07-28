import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Practiscale Brain",
  description:
    "Back office for the Practiscale Brain — ingestion, retrieval, prompts, and scoped API keys.",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
