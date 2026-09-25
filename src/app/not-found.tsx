import Link from "next/link";
import { BrainCircuit } from "lucide-react";
import { buttonClass } from "@/components/ui/Button";

// App-wide 404 (the chatbot's recipe). Styled with the theme tokens only (no
// client code), so it also renders correctly for signed-out visitors outside
// the dashboard shell.
export default function NotFound() {
  return (
    <main className="flex min-h-app flex-col items-center justify-center gap-4 bg-background bg-[radial-gradient(1200px_600px_at_50%_-10%,rgb(var(--accent-soft)),transparent_60%)] px-4 text-center">
      <span className="grid h-12 w-12 place-items-center rounded-full bg-brand-gradient text-white" aria-hidden>
        <BrainCircuit size={24} />
      </span>
      <p className="text-2xl font-semibold tracking-tight text-brand-gradient">404</p>
      <div className="space-y-1">
        <h1 className="text-xl font-semibold tracking-tight text-foreground">Page not found</h1>
        <p className="text-[13px] text-muted-foreground">That page isn&apos;t in the Brain. The link may be old, or the item was removed.</p>
      </div>
      <Link href="/dashboard" className={buttonClass({ variant: "primary", size: "md", className: "px-4" })}>
        Back to overview
      </Link>
    </main>
  );
}
