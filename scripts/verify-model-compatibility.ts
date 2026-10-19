import { loadEnvConfig } from "@next/env";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
loadEnvConfig(process.cwd());
async function main() {
  const [{ getModel }, { MODELS, generationParams }, { generateText }] = await Promise.all([import("../src/lib/llm"), import("../src/lib/models-catalog"), import("ai")]);
  const results: object[] = [];
  for (let i = 0; i < MODELS.length; i += 2) {
    await Promise.all(MODELS.slice(i, i + 2).map(async model => {
      const started = Date.now();
      try {
        const m = await getModel(model.id);
        const result = await generateText({ model: m, system: "Follow the user's exact output instruction.", prompt: "Reply with exactly READY and nothing else.", ...generationParams(model.id, { maxTokens: 128, temperature: 0 }), abortSignal: AbortSignal.timeout(80_000) });
        const row = { model: model.id, passed: result.text.trim() === "READY", nonempty: !!result.text.trim(), finishReason: result.finishReason, usage: result.usage, ms: Date.now() - started };
        results.push(row); console.log(JSON.stringify(row));
      } catch (e) {
        const row = { model: model.id, passed: false, error: e instanceof Error ? e.message.slice(0, 500) : "Provider error", ms: Date.now() - started };
        results.push(row); console.log(JSON.stringify(row));
      }
    }));
  }
  const folder = path.resolve(process.cwd(), "../verification"); await mkdir(folder, { recursive: true });
  const report = path.join(folder, `model-compatibility-${Date.now()}.json`);
  await writeFile(report, JSON.stringify({ results }, null, 2)); console.log(JSON.stringify({ report }));
  if (results.some(r => !(r as { passed: boolean }).passed)) process.exitCode = 1;
}
main().catch(() => { console.error("Model audit failed before probes"); process.exitCode = 1; });
