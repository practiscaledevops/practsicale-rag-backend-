import { BrainCircuit } from "lucide-react";

/**
 * The installed desktop app's title bar (PWA "window controls overlay"). With
 * the overlay on, the OS draws its window buttons over the top of the page, so
 * the app reserves that strip as its own full-width bar: a draggable band in
 * the rail colour with the product mark, and every page starts below it (see
 * --titlebar-h in globals.css). In a normal browser tab the overlay is off,
 * the strip has zero height and this renders nothing visible.
 */
export function TitleBar() {
  return (
    <div className="app-titlebar" aria-hidden>
      <div className="app-titlebar-inner">
        <BrainCircuit size={14} className="shrink-0 text-accent" />
        <span className="truncate text-[12px] font-semibold tracking-tight text-sidebar-foreground">
          Practiscale <span className="font-medium text-sidebar-muted">Intelligent Operations</span>
        </span>
      </div>
    </div>
  );
}
