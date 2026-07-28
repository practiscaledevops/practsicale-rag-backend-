// Local ingestion helper: reads a file and posts it to /api/ingest.
// Usage: npm run ingest -- ./sample.md [sourceType] [orgId]
//
// Env:
//   ORG_ID         org to ingest into (overrides the 3rd arg default)
//   INGEST_SECRET  must match the server's INGEST_SECRET (write guard)
//   APP_URL        base URL (default http://localhost:3000)
import { readFileSync } from "fs";

async function main() {
  const path = process.argv[2];
  const sourceType = process.argv[3] ?? "document";
  const orgId = process.argv[4] ?? process.env.ORG_ID ?? "00000000-0000-0000-0000-000000000000";
  if (!path) throw new Error("Provide a file path");

  const text = readFileSync(path, "utf8");
  const base = process.env.APP_URL ?? "http://localhost:3000";
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (process.env.INGEST_SECRET) headers["x-ingest-secret"] = process.env.INGEST_SECRET;

  const res = await fetch(`${base}/api/ingest`, {
    method: "POST",
    headers,
    body: JSON.stringify({ orgId, sourceType, title: path, text, metadata: {} }),
  });
  console.log(await res.json());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
