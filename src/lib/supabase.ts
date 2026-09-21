import { createClient, type SupabaseClient } from "@supabase/supabase-js";
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
// The live client is a module-level singleton: one chat request used to build
// ~10 clients (auth, settings, prompts, logs…), each with its own fetch setup.
let adminClient: SupabaseClient | null = null;
export function supabaseAdmin(): SupabaseClient {
  if (isDemo()) return fakeSupabase() as unknown as SupabaseClient;
  if (!adminClient) {
    adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { persistSession: false } }
    );
  }
  return adminClient;
}
