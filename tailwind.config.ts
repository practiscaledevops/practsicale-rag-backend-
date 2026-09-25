import type { Config } from "tailwindcss";

/**
 * Design system for the PractiScale Brain back office. It is a verbatim copy of
 * the sister chatbot app's config, so both apps share one set of tokens (see
 * globals.css for the values and rationale).
 *
 * Colors are driven by CSS variables so opacity modifiers work (bg-accent/10).
 * Light by default; the `.dark` class on <html> swaps every token (the user's
 * Light / Dark / System choice), so components never need dark-mode variants.
 */
const config: Config = {
  darkMode: "class",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        background: "rgb(var(--background) / <alpha-value>)",
        foreground: "rgb(var(--foreground) / <alpha-value>)",
        surface: "rgb(var(--surface) / <alpha-value>)",
        "surface-muted": "rgb(var(--surface-muted) / <alpha-value>)",
        "surface-sunken": "rgb(var(--surface-sunken) / <alpha-value>)",
        border: "rgb(var(--border) / <alpha-value>)",
        muted: "rgb(var(--muted) / <alpha-value>)",
        "muted-foreground": "rgb(var(--muted-foreground) / <alpha-value>)",
        "subtle-foreground": "rgb(var(--subtle-foreground) / <alpha-value>)",
        accent: "rgb(var(--accent) / <alpha-value>)",
        "accent-strong": "rgb(var(--accent-strong) / <alpha-value>)",
        "accent-deep": "rgb(var(--accent-deep) / <alpha-value>)",
        "accent-foreground": "rgb(var(--accent-foreground) / <alpha-value>)",
        "accent-hover": "rgb(var(--accent-hover) / <alpha-value>)",
        "accent-soft": "rgb(var(--accent-soft) / <alpha-value>)",
        "accent-softer": "rgb(var(--accent-softer) / <alpha-value>)",
        tea: "rgb(var(--tea) / <alpha-value>)",
        "tea-hover": "rgb(var(--tea-hover) / <alpha-value>)",
        "tea-foreground": "rgb(var(--tea-foreground) / <alpha-value>)",
        ring: "rgb(var(--ring) / <alpha-value>)",
        success: "rgb(var(--success) / <alpha-value>)",
        warning: "rgb(var(--warning) / <alpha-value>)",
        danger: "rgb(var(--danger) / <alpha-value>)",
        // Solid danger fill under white text (danger buttons) — AA in both themes.
        "danger-solid": "rgb(var(--danger-solid) / <alpha-value>)",
        "danger-solid-hover": "rgb(var(--danger-solid-hover) / <alpha-value>)",
        info: "rgb(var(--info) / <alpha-value>)",
        // Status text on its own /10 tint (chips, banners): AA in both themes.
        "success-ink": "rgb(var(--success-ink) / <alpha-value>)",
        "warning-ink": "rgb(var(--warning-ink) / <alpha-value>)",
        "danger-ink": "rgb(var(--danger-ink) / <alpha-value>)",
        "info-ink": "rgb(var(--info-ink) / <alpha-value>)",
        private: "rgb(var(--private) / <alpha-value>)",
        // Dark navigation rail (constant).
        sidebar: "rgb(var(--sidebar) / <alpha-value>)",
        "sidebar-panel": "rgb(var(--sidebar-panel) / <alpha-value>)",
        "sidebar-item": "rgb(var(--sidebar-item) / <alpha-value>)",
        "sidebar-item-hover": "rgb(var(--sidebar-item-hover) / <alpha-value>)",
        "sidebar-foreground": "rgb(var(--sidebar-foreground) / <alpha-value>)",
        "sidebar-muted": "rgb(var(--sidebar-muted) / <alpha-value>)",
        "sidebar-border": "rgb(var(--sidebar-border) / <alpha-value>)",
        // Folder accent bars.
        "folder-1": "rgb(var(--folder-1) / <alpha-value>)",
        "folder-2": "rgb(var(--folder-2) / <alpha-value>)",
        "folder-3": "rgb(var(--folder-3) / <alpha-value>)",
        "folder-4": "rgb(var(--folder-4) / <alpha-value>)",
        "folder-5": "rgb(var(--folder-5) / <alpha-value>)",
        // Answer tables: cell grid + zebra rows.
        "table-grid": "rgb(var(--table-grid) / <alpha-value>)",
        "table-stripe": "rgb(var(--table-stripe) / <alpha-value>)",
        // Near-black chips/buttons that invert in the dark theme.
        ink: "rgb(var(--ink) / <alpha-value>)",
        "ink-hover": "rgb(var(--ink-hover) / <alpha-value>)",
        "ink-foreground": "rgb(var(--ink-foreground) / <alpha-value>)",
      },
      borderColor: {
        DEFAULT: "rgb(var(--border) / <alpha-value>)",
      },
      // A bare `ring-offset-*` follows the theme (Tailwind's default offset
      // colour is #fff — a white halo around focus rings in dark mode).
      ringOffsetColor: {
        DEFAULT: "rgb(var(--background))",
      },
      // Standard-density radii (8 / 12 / 16 / 20).
      borderRadius: {
        lg: "0.5rem",
        xl: "0.75rem",
        "2xl": "1rem",
        "3xl": "1.25rem",
      },
      boxShadow: {
        soft: "var(--shadow-soft)",
        "soft-lg": "var(--shadow-soft-lg)",
        float: "var(--shadow-float)",
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        // Source Serif 4 (next/font, see layout.tsx) for serif answers.
        serif: ["var(--font-serif)", "Georgia", "Cambria", "serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "Consolas", "Liberation Mono", "monospace"],
      },
      keyframes: {
        // Popover/menu open: gentle rise + fade (use with motion-safe:).
        fadeUp: {
          from: { opacity: "0", transform: "translateY(5px)" },
          to: { opacity: "1", transform: "translateY(0)" },
        },
        fadeIn: {
          from: { opacity: "0" },
          to: { opacity: "1" },
        },
      },
      animation: {
        fadeUp: "fadeUp 160ms ease-out",
        fadeIn: "fadeIn 220ms ease-out",
      },
    },
  },
  plugins: [],
};

export default config;
