// Server-only: load the ACTIVE prompt for a use-case from the DB, falling back
// to the built-in default. This is what wires the Prompt Studio to the runtime —
// editing/activating a version here changes the pipeline's behaviour live.
//
// Kept separate from prompts.ts (which is client-safe) because it touches the
// service-role client.

import { supabaseAdmin } from "@/lib/supabase";
import { defaultPromptFor } from "@/lib/prompts";

/**
 * Return the active prompt content for (org, useCase). Falls back to the
 * built-in default when no active version exists or on any error, so the
 * pipeline never breaks because a prompt row is missing.
 */
export async function getActivePrompt(orgId: string, useCase: string): Promise<string> {
  try {
    const { data } = await supabaseAdmin()
      .from("prompts")
      .select("content")
      .eq("org_id", orgId)
      .eq("use_case", useCase)
      .eq("is_active", true)
      .order("version", { ascending: false })
      .limit(1)
      .maybeSingle();
    const content = (data as { content?: string } | null)?.content;
    return content && content.trim() ? content : defaultPromptFor(useCase);
  } catch {
    return defaultPromptFor(useCase);
  }
}

/**
 * Load several active prompts at once (one query). Returns a map keyed by
 * use_case; any missing use-case falls back to its built-in default.
 */
export async function getActivePrompts(
  orgId: string,
  useCases: string[]
): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const uc of useCases) out[uc] = defaultPromptFor(uc);
  try {
    const { data } = await supabaseAdmin()
      .from("prompts")
      .select("use_case, content, version")
      .eq("org_id", orgId)
      .eq("is_active", true)
      .in("use_case", useCases)
      .order("version", { ascending: false });
    for (const row of (data ?? []) as { use_case: string; content: string }[]) {
      // First row per use_case wins (highest version, thanks to the ordering).
      if (row.content && row.content.trim() && out[row.use_case] === defaultPromptFor(row.use_case)) {
        out[row.use_case] = row.content;
      }
    }
  } catch {
    /* keep defaults */
  }
  return out;
}
