import { createClient } from "@supabase/supabase-js";
import { isDemo } from "@/lib/demo/mode";
import { fakeSupabase } from "@/lib/demo/client";

// Browser / anon client (respects Row Level Security)
export const supabase = isDemo()
  ? (fakeSupabase() as ReturnType<typeof createClient>)
  : createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
    );

// Server-only client with the service role key. Bypasses RLS.
// NEVER import this into client components.
// In DEMO MODE this returns an in-memory fake — no Supabase project required.
export function supabaseAdmin() {
  if (isDemo()) return fakeSupabase() as ReturnType<typeof createClient>;
  return createClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.SUPABASE_SERVICE_ROLE_KEY!,
    { auth: { persistSession: false } }
  );
}
