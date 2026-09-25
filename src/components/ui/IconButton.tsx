import * as React from "react";
import { cn } from "@/lib/utils";

export interface IconButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: icon buttons have no visible text, so they need an accessible name. */
  "aria-label": string;
  /** 28 / 32 (default) / 36px. */
  size?: "sm" | "md" | "lg";
  /** Visual pressed/open state (pair with aria-pressed or aria-expanded as fits). */
  pressed?: boolean;
}

const SIZES = { sm: "h-7 w-7", md: "h-8 w-8", lg: "h-9 w-9" } as const;

/**
 * Round, icon-only button (the chatbot's IconButton). `aria-label` is required
 * by the type so these are always announced to screen readers.
 */
export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, size = "md", pressed = false, type, children, ...props }, ref) => (
    <button
      ref={ref}
      type={type ?? "button"}
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-surface-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50",
        SIZES[size],
        pressed && "bg-surface-muted text-foreground",
        className
      )}
      {...props}
    >
      {children}
    </button>
  )
);
IconButton.displayName = "IconButton";
