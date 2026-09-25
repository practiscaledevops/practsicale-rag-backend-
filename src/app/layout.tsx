import type { Metadata, Viewport } from "next";
import { Inter } from "next/font/google";
import { ThemeSync } from "@/components/ui/ThemeSync";
import { TitleBar } from "@/components/ui/TitleBar";
import { CHROME_COLOR, THEME_INIT_SCRIPT } from "@/lib/theme-shared";
import "./globals.css";

// Inter across the whole back office (Light → Bold), self-hosted by next/font
// and exposed as --font-inter for the --font-sans token (see globals.css).
const inter = Inter({
  subsets: ["latin"],
  weight: ["300", "400", "500", "600", "700"],
  variable: "--font-inter",
  display: "swap",
});

export const metadata: Metadata = {
  // Each route sets its own title, so client-side navigation changes document.title
  // and Next's route announcer reads the new page to screen readers.
  title: { default: "Practiscale Brain", template: "%s · Practiscale Brain" },
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

// Browser chrome follows the rail colour; the init script / ThemeSync switch
// it to CHROME_COLOR.dark when the dark theme is on.
export const viewport: Viewport = {
  themeColor: CHROME_COLOR.light,
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    // The init script sets the theme class before hydration, hence
    // suppressHydrationWarning on <html> (its class/style differ by design).
    <html lang="en" className={inter.variable} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      {/* Theme surfaces come from the shared design tokens (see globals.css). */}
      <body className="min-h-screen bg-background text-foreground antialiased">
        <TitleBar />
        <ThemeSync />
        {children}
      </body>
    </html>
  );
}
