import type { Config } from "tailwindcss";

/**
 * Design system for the Brain dashboard.
 *
 * Colors are driven by CSS variables (see globals.css) so light/dark themes swap
 * without duplicating class names. Dark mode follows the OS via `media` — no
 * toggle to build or persist. The palette is a clean, neutral slate/zinc base
 * with a single indigo accent, sized generously for a back-office admin tool.
 */
const config: Config = {
  darkMode: "media",
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        // Semantic tokens — each maps to a CSS variable (rgb channel triplet)
        // so we can use Tailwind's opacity modifiers, e.g. bg-surface/50.
        background: "rgb(var(--background) / <alpha-value>)",
        foreground: "rgb(var(--foreground) / <alpha-value>)",
        surface: "rgb(var(--surface) / <alpha-value>)",
        "surface-muted": "rgb(var(--surface-muted) / <alpha-value>)",
        border: "rgb(var(--border) / <alpha-value>)",
        muted: "rgb(var(--muted) / <alpha-value>)",
        "muted-foreground": "rgb(var(--muted-foreground) / <alpha-value>)",
        accent: "rgb(var(--accent) / <alpha-value>)",
        "accent-foreground": "rgb(var(--accent-foreground) / <alpha-value>)",
        "accent-hover": "rgb(var(--accent-hover) / <alpha-value>)",
        ring: "rgb(var(--ring) / <alpha-value>)",
        success: "rgb(var(--success) / <alpha-value>)",
        warning: "rgb(var(--warning) / <alpha-value>)",
        danger: "rgb(var(--danger) / <alpha-value>)",
      },
      borderColor: {
        DEFAULT: "rgb(var(--border) / <alpha-value>)",
      },
      borderRadius: {
        lg: "0.625rem",
        xl: "0.875rem",
      },
      fontFamily: {
        sans: ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono: ["ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
