import * as React from "react";
import { cn } from "@/lib/utils";
import { compactFieldClass, inputClass, type FieldDensity } from "./Input";

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

export interface SelectOptionGroup {
  label: string;
  options: SelectOption[];
}

export interface SelectProps extends React.SelectHTMLAttributes<HTMLSelectElement> {
  /** "compact" = 32px toolbar filter height. */
  density?: FieldDensity;
  options?: SelectOption[];
  /** Grouped options (rendered as <optgroup>; empty groups are skipped). */
  groups?: SelectOptionGroup[];
  /** Renders a leading <option value="">. */
  placeholder?: string;
}

const renderOption = (o: SelectOption) => (
  <option key={o.value} value={o.value} disabled={o.disabled}>
    {o.label}
  </option>
);

/** Native select in the field recipe (keeps the native arrow, as the chatbot does). */
export const Select = React.forwardRef<HTMLSelectElement, SelectProps>(
  ({ className, density = "default", options, groups, placeholder, children, ...props }, ref) => (
    <select
      ref={ref}
      className={cn(inputClass, "cursor-pointer pr-8", density === "compact" && compactFieldClass, className)}
      {...props}
    >
      {placeholder !== undefined && <option value="">{placeholder}</option>}
      {(options ?? []).map(renderOption)}
      {(groups ?? [])
        .filter((g) => g.options.length > 0)
        .map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.options.map(renderOption)}
          </optgroup>
        ))}
      {children}
    </select>
  )
);
Select.displayName = "Select";
