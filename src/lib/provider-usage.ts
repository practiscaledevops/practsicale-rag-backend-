import { randomUUID } from "node:crypto";
import { costUsd, PRICING } from "@/lib/pricing";
import { supabaseAdmin } from "@/lib/supabase";

export async function reserveUsage(provider: string, model: string, inputBound: number, outputBound: number) {
  if (process.env.NODE_ENV === "test" && !process.env.TEST_PROVIDER_LEDGER) return async (_input: number, _output: number) => {};
  const raw = process.env.BRAIN_DAILY_MODEL_BUDGET_USD;
  const cap = raw === undefined ? null : Number(raw);
  if (cap !== null && (!raw?.trim() || !Number.isFinite(cap) || cap < 0)) throw new Error("Invalid model budget");
  if (cap !== null && !Object.keys(PRICING).some(k => model === k || model.startsWith(k + "-"))) {
    throw new Error("Model has no configured budget rate");
  }
  const id = randomUUID();
  const db = supabaseAdmin();
  const { data, error } = await db.rpc("reserve_provider_usage", {
    p_id: id, p_provider: provider, p_model: model,
    p_reserved: costUsd(model, inputBound, outputBound), p_cap: cap,
  }).abortSignal(AbortSignal.timeout(4000));
  if (error) throw new Error("Model budget service unavailable");
  if (data !== true) throw new Error("Daily model budget reached");
  return async (input: number, output: number) => {
    if (![input, output].every(n => Number.isSafeInteger(n) && n >= 0)) return;
    const { error } = await db.from("provider_usage_ledger").update({
      input_tokens: input, output_tokens: output, estimated_usd: costUsd(model, input, output),
    }).eq("id", id).abortSignal(AbortSignal.timeout(3000));
    if (error) console.error("Could not settle provider usage", id);
  };
}

