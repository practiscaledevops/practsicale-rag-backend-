// Bulk-compile a folder of sources into knowledge objects through the AI
// ingestion agent (the same path as "Add knowledge" in the dashboard).
//
//   npm run compile:knowledge -- <dir-or-file> --class playbook [--bucket founder_brain]
//       [--expert "Name"] [--platform instagram] [--type video] [--dry] [--force-new]
//
// Reads .md / .markdown / .txt files (a canonical .md with frontmatter is used
// as-is; anything else is classified + compiled). Each file runs the full
// pipeline: classify → taxonomy → NEW/ENRICH/DUPLICATE/CONFLICT → compile →
// chunk → embed → entities → relationships, with every decision logged.
// --dry previews without writing. Requires migration 0017 + provider keys.

import { readFileSync, readdirSync, statSync } from "fs";
import { join, extname, basename } from "path";

function loadEnvLocal(path = ".env.local"): void {
  let text: string;
  try { text = readFileSync(path, "utf-8"); } catch { return; }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("="); if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (key && process.env[key] === undefined) process.env[key] = val;
  }
}
loadEnvLocal();

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const target = process.argv[2];
  if (!target || target.startsWith("--")) {
    console.error("Usage: npm run compile:knowledge -- <dir-or-file> --class playbook|business_reality|platform_intelligence [--bucket …] [--dry]");
    process.exit(1);
  }
  const cls = (arg("class") ?? "playbook") as "playbook" | "business_reality" | "platform_intelligence" | "organizational_learning";
  const bucket = arg("bucket") as never;
  const dry = flag("dry");

  const { supabaseAdmin } = await import("../src/lib/supabase");
  const { compileKnowledge } = await import("../src/lib/knowledge-compiler");
  const db = supabaseAdmin();

  const { data: org } = await db.from("orgs").select("id, name").order("created_at", { ascending: true }).limit(1).maybeSingle();
  if (!org) throw new Error("no org found — run setup:live first");
  const orgId = org.id as string;
  console.log(`• Org: ${org.name} · class=${cls}${bucket ? ` bucket=${bucket}` : ""}${dry ? " · DRY RUN" : ""}`);

  const files: string[] = [];
  const st = statSync(target);
  if (st.isDirectory()) {
    for (const f of readdirSync(target)) {
      if ([".md", ".markdown", ".txt"].includes(extname(f).toLowerCase())) files.push(join(target, f));
    }
  } else files.push(target);
  files.sort();
  console.log(`• ${files.length} file(s)`);

  let created = 0, enriched = 0, duplicates = 0, conflicts = 0, failed = 0;
  for (const file of files) {
    const text = readFileSync(file, "utf-8");
    const name = basename(file);
    process.stdout.write(`  ${name} … `);
    try {
      const res = await compileKnowledge(db, {
        orgId,
        intelligenceClass: cls,
        bucket: bucket ?? null,
        text,
        title: name.replace(/\.(md|markdown|txt)$/i, ""),
        mode: dry ? "preview" : "commit",
        forceNew: flag("force-new"),
        createdBy: "compile-knowledge script",
        hints: { sourceExpert: arg("expert"), sourcePlatform: arg("platform"), sourceType: arg("type") },
      });
      if (res.blocked) { console.log(`BLOCKED: ${res.blocked.reason}`); failed++; continue; }
      const d = res.dedup.decision;
      if (dry) { console.log(`${d.toUpperCase()} → ${res.draft.ref} ${res.draft.name} [${res.draft.domain}/${res.draft.object_type}/${res.draft.subtype ?? "-"}]`); continue; }
      if (res.object) { console.log(`${d === "conflict" ? "NEW (conflict)" : "NEW"} ${res.object.ref} ${res.object.name} · ${res.chunks} chunks`); d === "conflict" ? conflicts++ : created++; }
      else if (res.target) { console.log(`${d.toUpperCase()} → ${res.target.ref} ${res.target.name}`); d === "enrich" ? enriched++ : duplicates++; }
      else console.log("done");
    } catch (e) {
      console.log(`FAILED: ${e instanceof Error ? e.message : e}`);
      failed++;
    }
  }
  if (!dry) console.log(`\n✓ created ${created} · enriched ${enriched} · duplicates ${duplicates} · conflicts ${conflicts} · failed ${failed}`);
}

main().catch((e) => { console.error("✖ compile-knowledge failed:", e instanceof Error ? e.message : e); process.exit(1); });
