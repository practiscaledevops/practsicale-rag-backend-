import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Practiscale Brain",
  description:
    "Back office for the Practiscale Brain — ingestion, retrieval, prompts, and scoped API keys.",
  icons: {
    icon: [
      { url: "/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: "/apple-touch-icon.png",
  },
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
