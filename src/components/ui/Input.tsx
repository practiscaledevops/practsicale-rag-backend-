import * as React from "react";
import { Search } from "lucide-react";
import { cn } from "@/lib/utils";

/** The chatbot's form-field recipe (36px, rounded-xl, accent focus ring). */
export const inputClass =
  "h-9 w-full rounded-xl border border-border bg-surface px-3 text-sm text-foreground outline-none transition-colors placeholder:text-subtle-foreground focus-visible:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/30 disabled:cursor-not-allowed disabled:opacity-60";

/** Dense toolbar filter controls (search + selects above a table): 32px at 13px. */
export const compactFieldClass = "h-8 text-[13px]";

export type FieldDensity = "default" | "compact";

export interface InputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  /** "compact" = 32px toolbar filter height. */
  density?: FieldDensity;
}

/** Text input styled to the design system. */
export const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type = "text", density = "default", ...props }, ref) => (
    <input
      ref={ref}
      type={type}
      className={cn(inputClass, density === "compact" && compactFieldClass, className)}
      {...props}
    />
  )
);
Input.displayName = "Input";

export interface SearchInputProps extends Omit<InputProps, "type"> {
  /** Required: a search field has no visible label. */
  "aria-label": string;
  /** Class for the positioning wrapper (width, flex). */
  wrapperClassName?: string;
}

/** Search field with a leading magnifier; compact (32px) by default. */
export const SearchInput = React.forwardRef<HTMLInputElement, SearchInputProps>(
  ({ className, wrapperClassName, density = "compact", ...props }, ref) => (
    <div className={cn("relative min-w-0", wrapperClassName)}>
      <Search
        size={14}
        aria-hidden
        className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground"
      />
      <Input ref={ref} type="search" density={density} className={cn("pl-8", className)} {...props} />
    </div>
  )
);
SearchInput.displayName = "SearchInput";
