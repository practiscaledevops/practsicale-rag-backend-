"use client";

import * as React from "react";
import { cn } from "@/lib/utils";

/**
 * Native checkbox in the brand accent. No ring or opacity of its own: the global
 * :focus-visible outline covers focus, and the browser already greys out a
 * disabled checkbox.
 */
export const checkboxClass = "h-4 w-4 shrink-0 cursor-pointer accent-accent disabled:cursor-not-allowed";

export type CheckboxProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, "type">;

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(({ className, ...props }, ref) => (
  <input ref={ref} type="checkbox" className={cn(checkboxClass, className)} {...props} />
));
Checkbox.displayName = "Checkbox";
