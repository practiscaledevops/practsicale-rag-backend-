import Link from "next/link";
import { FileQuestion } from "lucide-react";
import { buttonClass } from "@/components/ui/Button";

// In-shell 404: rendered when a /dashboard page calls notFound() (e.g. an
// unknown source or document id), so the rail and top bar stay in place.
export default function DashboardNotFound() {
  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <div className="flex w-full max-w-[380px] flex-col items-center gap-4 rounded-2xl border border-border bg-surface p-5 text-center shadow-soft">
        <span className="grid h-10 w-10 place-items-center rounded-full bg-accent-soft text-accent" aria-hidden>
          <FileQuestion size={16} />
        </span>
        <div className="space-y-1">
          <h1 className="text-xl font-semibold tracking-tight text-foreground">Page not found</h1>
          <p className="text-[13px] text-muted-foreground">This page doesn&apos;t exist or was moved.</p>
        </div>
        <Link href="/dashboard" className={buttonClass({ variant: "primary", size: "toolbar" })}>
          Back to overview
        </Link>
      </div>
    </div>
  );
}
