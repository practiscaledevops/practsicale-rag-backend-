import * as React from "react";
import { Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";

// Pill buttons in the PractiScale palette (the chatbot's Button, plus the
// Brain's back-compat `outline` alias, `danger-secondary`, and the 32px
// `toolbar` size the chatbot spells as size="sm" className="h-8 text-[13px]").

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "outline"
  | "ghost"
  | "danger"
  | "danger-secondary"
  | "tea"
  | "dark";

export type ButtonSize = "sm" | "toolbar" | "md" | "lg" | "icon";

const BASE =
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-full font-medium transition-[background-color,color,box-shadow,transform] duration-150 active:scale-[0.98] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-50";

const VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-accent-foreground shadow-soft hover:bg-accent-hover",
  secondary: "border border-border bg-surface text-foreground hover:bg-surface-muted",
  // Back-compat alias: identical to secondary.
  outline: "border border-border bg-surface text-foreground hover:bg-surface-muted",
  ghost: "bg-transparent text-foreground hover:bg-surface-muted",
  // Solid fill token (as in the chatbot): the dark theme lifts --danger for
  // text, which is too light under white text.
  danger: "bg-danger-solid text-white shadow-soft hover:bg-danger-solid-hover",
  "danger-secondary": "border border-danger/30 bg-surface text-danger hover:bg-danger/10",
  tea: "bg-tea text-tea-foreground hover:bg-tea-hover",
  "dark": "bg-ink text-ink-foreground hover:bg-ink-hover",
};

// Standard density: 28 / 32 / 36 / 40px, plus a 32px square icon size.
const SIZES: Record<ButtonSize, string> = {
  sm: "h-7 gap-1.5 px-3 text-xs",
  toolbar: "h-8 gap-1.5 px-3 text-[13px]",
  md: "h-9 px-3.5 text-sm",
  lg: "h-10 px-4 text-sm",
  icon: "h-8 w-8 p-0",
};

/**
 * The Button class string, for styling a next/link (or any element) as a
 * button without nesting a <button> inside an <a>:
 * `<Link href="/x" className={buttonClass({ variant: "secondary", size: "toolbar" })}>`.
 */
export function buttonClass(opts?: {
  variant?: ButtonVariant;
  size?: ButtonSize;
  className?: string;
}): string {
  return cn(BASE, VARIANTS[opts?.variant ?? "primary"], SIZES[opts?.size ?? "md"], opts?.className);
}

export interface ButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Shows a spinner before the label and disables the button (aria-busy). */
  loading?: boolean;
}

/**
 * Pill-shaped text button. Keyboard focus shows the themed ring (--ring);
 * disabled state is dimmed and non-interactive. Defaults to type="button".
 */
export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant = "primary", size = "md", type, loading = false, disabled, children, ...props }, ref) => (
    <button
      ref={ref}
      type={type ?? "button"}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={buttonClass({ variant, size, className })}
      {...props}
    >
      {loading && (
        <Loader2
          size={size === "sm" || size === "toolbar" ? 14 : 16}
          className="shrink-0 animate-spin"
          aria-hidden
        />
      )}
      {children}
    </button>
  )
);
Button.displayName = "Button";
