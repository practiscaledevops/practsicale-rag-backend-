"use client";

import * as React from "react";
import { fmtDateTime, relTime } from "@/lib/format";

const noopSubscribe = () => () => {};

/**
 * true only after hydration (false on the server and during the hydration
 * render), so clock- and time-zone-dependent strings never mismatch the server HTML.
 */
export function useHydrated(): boolean {
  return React.useSyncExternalStore(noopSubscribe, () => true, () => false);
}

/**
 * Relative time ("5m ago") that is safe in server-rendered markup. The server and
 * the hydration render show a time-zone-independent "12d ago"; after hydration
 * it switches to the local absolute date ("Sep 18") past 7 days and adds the exact
 * local date and time as a tooltip. suppressHydrationWarning only covers the
 * minute-boundary drift between server and client clocks.
 */
export function RelTime({
  iso,
  never,
  className,
}: {
  iso: string | null | undefined;
  never?: string;
  className?: string;
}) {
  const hydrated = useHydrated();
  if (!iso) return <span className={className}>{relTime(iso, { never })}</span>;
  return (
    <time
      dateTime={iso}
      title={hydrated ? fmtDateTime(iso) : undefined}
      className={className}
      suppressHydrationWarning
    >
      {relTime(iso, { never, absolute: hydrated })}
    </time>
  );
}
