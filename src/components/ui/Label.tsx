import * as React from "react";
import { cn } from "@/lib/utils";

/** Form label (the chatbot's labelClass). Pair with a field via htmlFor, or use <Field>. */
export const Label = React.forwardRef<HTMLLabelElement, React.LabelHTMLAttributes<HTMLLabelElement>>(
  ({ className, ...props }, ref) => (
    <label ref={ref} className={cn("block text-xs font-medium text-muted-foreground", className)} {...props} />
  )
);
Label.displayName = "Label";
