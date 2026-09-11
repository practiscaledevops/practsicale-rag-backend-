// DEMO MODE flag.
//
// When on, the app runs with NO Supabase and NO LLM keys: auth is bypassed with
// a demo admin, all data comes from in-memory fixtures, and chat is a canned
// stream. This lets you click through every screen and function before wiring
// real databases. Turn it on with DEMO_MODE=1 (server) / NEXT_PUBLIC_DEMO_MODE=1
// (client). See .env.demo.

export function isDemo(): boolean {
  // The server flag always counts.
  if (process.env.DEMO_MODE === "1") return true;
  // The client-inlined NEXT_PUBLIC flag is baked at build time, so a value that
  // leaked into a PRODUCTION build must NEVER be able to bypass real auth or
  // serve fixtures. Honour it only in development (local click-through demos).
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.NEXT_PUBLIC_DEMO_MODE === "1"
  );
}
