import { defineConfig } from "@trigger.dev/sdk/v3";

// Trigger.dev runs the heavy, long-running jobs (deep call audits over hundreds
// or thousands of transcripts) on dedicated machines with no serverless timeout,
// draining the SAME job queue the Vercel cron drains. See docs/JOBS.md for setup.
//
// The project ref comes from your Trigger.dev project (Settings → General, looks
// like `proj_abc123`). Set TRIGGER_PROJECT_REF in your Trigger.dev CLI shell, or
// replace the fallback below with your ref. The app triggers tasks only when
// TRIGGER_SECRET_KEY is set; otherwise it falls back to the Vercel cron drainer,
// so nothing here is required for the Brain to run.
export default defineConfig({
  project: process.env.TRIGGER_PROJECT_REF ?? "proj_REPLACE_ME",
  runtime: "node",
  logLevel: "info",
  // Default machine time budget for any task (seconds); the deep-audit tasks set
  // their own 3-hour ceiling. Kept high so a large batch never gets cut short.
  maxDuration: 3 * 60 * 60,
  // Where the task files live. Only these are bundled + deployed to Trigger.dev;
  // the Next.js app never imports them (it triggers by task id).
  dirs: ["./src/trigger"],
  // A stuck LLM call shouldn't fail a whole batch on the first blip.
  retries: {
    enabledInDev: false,
    default: {
      maxAttempts: 3,
      minTimeoutInMs: 2_000,
      maxTimeoutInMs: 30_000,
      factor: 2,
      randomize: true,
    },
  },
});
