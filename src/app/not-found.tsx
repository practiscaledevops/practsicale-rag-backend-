import Link from "next/link";

// App-wide 404. Styled with the theme tokens only (no client code), so it also
// renders correctly for unauthenticated visitors outside the dashboard shell.
export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center bg-background px-6 text-center text-foreground">
      <div>
        <p className="text-xs font-semibold uppercase tracking-widest text-accent">404</p>
        <h1 className="mt-2 text-2xl font-semibold">That page isn&apos;t in the Brain</h1>
        <p className="mt-2 text-sm text-muted-foreground">The link may be old, or the item was removed.</p>
        <Link
          href="/dashboard"
          className="mt-6 inline-flex items-center rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:bg-accent-hover"
        >
          Back to the dashboard
        </Link>
      </div>
    </main>
  );
}
