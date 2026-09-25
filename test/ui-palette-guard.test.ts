import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Palette guard for the back office UI.
 *
 * The UI is themed only through the chatbot's design tokens (globals.css +
 * tailwind.config.ts) and the primitives in src/components/ui. This test walks
 * every UI source file (src/app minus src/app/api, plus src/components) and fails
 * `npm test` when a hard-coded palette or an off-system pattern creeps back in.
 * Each rule prints `file:line  match` for every offender.
 *
 * Fix an offender by switching to a token class (bg-surface, text-muted-foreground,
 * text-danger, …) or a primitive — do not widen the allowlist.
 */

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const SCAN_DIRS = ["src/app", "src/components"];
const SKIP_PREFIXES = ["src/app/api/"];

type RuleId = "R1" | "R2" | "R3" | "R4" | "R5" | "R6" | "R7" | "R8";

interface Rule {
  id: RuleId;
  title: string;
  re: RegExp;
  /** Ignore lines that are only a comment (JS line/block comments or JSX comments). */
  skipComments?: boolean;
}

const RULES: Rule[] = [
  {
    id: "R1",
    title: "hex colour literal (use a token class)",
    re: /["'`[(\s:]#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})(?![0-9a-zA-Z_-])/g,
    skipComments: true,
  },
  {
    id: "R2",
    title: "rgb()/rgba() numeric literal (use a token class)",
    re: /rgba?\(\s*\d/g,
    skipComments: true,
  },
  {
    id: "R3",
    title: "Tailwind palette colour class (use a token class)",
    re: /\b(?:bg|text|border|ring|fill|stroke|from|to|via|divide|outline|decoration|placeholder)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g,
    skipComments: true,
  },
  {
    id: "R4",
    title: "deprecated brain-ui `C.*` palette outside brain-ui.tsx",
    re: /\bC\.(?:bg|sidebar|surface|raised|border|text|muted|green|restricted|amber|red|info|violet)\b/g,
    skipComments: true,
  },
  {
    id: "R5",
    title: "native confirm/alert dialog (use useConfirm / ConfirmDialog / Alert)",
    re: /\bwindow\.(?:confirm|alert)\(|(?:^|[^\w.])(?:confirm|alert)\(\s*["'`]/g,
    skipComments: true,
  },
  {
    id: "R6",
    title: "`dark:` variant (tokens already switch with the theme)",
    // Only a real Tailwind variant (`dark:bg-…`, `dark:[…]`), not object keys like `{ dark: Moon }`.
    re: /\bdark:[a-z[]/g,
    skipComments: true,
  },
  {
    id: "R7",
    title: "9–10px text (minimum is 11px)",
    re: /\btext-\[(?:9|10)(?:\.\d+)?px\]|\bfontSize:\s*["'`]?(?:9|10)(?:\.\d+)?(?:px)?\b/g,
    skipComments: true,
  },
  {
    id: "R8",
    title: "Tailwind default shadow scale (use the token shadows)",
    re: /\bshadow-(?:sm|md|lg|xl|2xl)\b/g,
    skipComments: true,
  },
];

/**
 * The allowlist. Keep it minimal and justify every entry.
 * `rules` exempts the whole file from a rule; `literals` exempts only the exact
 * strings listed (they are blanked out of the line before the rule runs).
 */
const ALLOW: Record<string, { rules?: RuleId[]; literals?: Partial<Record<RuleId, string[]>> }> = {
  // The root layout has failed when this renders, so globals.css tokens may not be
  // loaded; it must carry its own literal colours.
  "src/app/global-error.tsx": { rules: ["R1", "R2"] },
  // The chatbot rail is dark in both themes; these four values are copied verbatim
  // from the chatbot's Sidebar (rail menu panel, rail danger text, two rail shadows).
  "src/components/ui/AppShell.tsx": {
    literals: {
      R1: ["#232323", "#ff8f86"],
      R2: ["rgb(0_0_0/0.6)", "rgb(255_255_255/0.07)"],
    },
  },
  // Two logo images (light/dark artwork) cannot be swapped with a token.
  "src/components/ui/Brand.tsx": { rules: ["R6"] },
  // Unread-count badge on the bell: the only place 10px text is allowed.
  "src/components/ui/NotificationsBell.tsx": { literals: { R7: ["text-[10px]"] } },
};

const DEPRECATED_PALETTE_HOME = "src/components/ui/brain-ui.tsx";

function listSourceFiles(): string[] {
  const out: string[] = [];
  for (const dir of SCAN_DIRS) {
    const entries = readdirSync(join(ROOT, dir), { recursive: true, encoding: "utf8" });
    for (const entry of entries) {
      const rel = `${dir}/${entry.split("\\").join("/")}`;
      if (!/\.(?:tsx|ts)$/.test(rel)) continue;
      if (/\.test\.tsx?$/.test(rel)) continue;
      if (SKIP_PREFIXES.some((p) => rel.startsWith(p))) continue;
      out.push(rel);
    }
  }
  return out.sort();
}

function isCommentLine(line: string): boolean {
  const t = line.trim();
  return (
    t.startsWith("//") ||
    t.startsWith("/*") ||
    t.startsWith("*") ||
    t.startsWith("{/*") ||
    t.startsWith("*/")
  );
}

function blankLiterals(line: string, literals: string[] | undefined): string {
  if (!literals) return line;
  let out = line;
  for (const lit of literals) out = out.split(lit).join(" ".repeat(lit.length));
  return out;
}

function scanText(rel: string, text: string, rule: Rule): string[] {
  const allow = ALLOW[rel];
  if (allow?.rules?.includes(rule.id)) return [];
  if (rule.id === "R4" && rel === DEPRECATED_PALETTE_HOME) return [];
  const hits: string[] = [];
  const lines = text.split(/\r?\n/);
  lines.forEach((raw, i) => {
    if (rule.skipComments && isCommentLine(raw)) return;
    const line = blankLiterals(raw, allow?.literals?.[rule.id]);
    for (const m of line.matchAll(rule.re)) {
      hits.push(`${rel}:${i + 1}  ${m[0].trim()}  | ${raw.trim().slice(0, 140)}`);
    }
  });
  return hits;
}

const FILES = listSourceFiles();
const SOURCES = new Map(FILES.map((rel) => [rel, readFileSync(join(ROOT, rel), "utf8")]));

describe("ui palette guard", () => {
  it("scans the UI source tree", () => {
    // A broken walker would make every rule pass vacuously.
    expect(FILES.length).toBeGreaterThan(50);
    expect(FILES).toContain("src/components/ui/AppShell.tsx");
    expect(FILES.some((f) => f.startsWith("src/app/api/"))).toBe(false);
  });

  it("every allowlisted file exists", () => {
    for (const rel of Object.keys(ALLOW)) expect(FILES).toContain(rel);
  });

  for (const rule of RULES) {
    it(`${rule.id}: no ${rule.title}`, () => {
      const offenders = FILES.flatMap((rel) => scanText(rel, SOURCES.get(rel) ?? "", rule));
      expect(offenders, `${rule.id} — ${rule.title}\n${offenders.join("\n")}`).toEqual([]);
    });
  }
});

describe("ui palette guard rules (self-test)", () => {
  const hit = (id: RuleId, src: string, rel = "src/app/x.tsx") =>
    scanText(rel, src, RULES.find((r) => r.id === id)!).length > 0;

  it("R1 catches hex colours but not anchors or ids", () => {
    expect(hit("R1", `<div className="bg-[#1a1a19]" />`)).toBe(true);
    expect(hit("R1", `const c = "#fff";`)).toBe(true);
    expect(hit("R1", `stroke: #14b8a6;`)).toBe(true);
    expect(hit("R1", `<a href="#chunks">`)).toBe(false);
    expect(hit("R1", `// accent was #14b8a6`)).toBe(false);
  });

  it("R2 catches numeric rgb/rgba but not token rgb(var(--x))", () => {
    expect(hit("R2", `style={{ background: "rgba(0,0,0,.4)" }}`)).toBe(true);
    expect(hit("R2", `shadow-[0_1px_rgb(0_0_0/0.1)]`)).toBe(true);
    expect(hit("R2", `color: "rgb(var(--foreground))"`)).toBe(false);
  });

  it("R3 catches palette classes only", () => {
    expect(hit("R3", `className="text-emerald-400"`)).toBe(true);
    expect(hit("R3", `className="hover:bg-rose-500/10"`)).toBe(true);
    expect(hit("R3", `className="text-success bg-surface-muted"`)).toBe(false);
  });

  it("R4 flags C.* outside brain-ui only", () => {
    expect(hit("R4", `style={{ color: C.muted }}`)).toBe(true);
    expect(hit("R4", `style={{ color: C.muted }}`, DEPRECATED_PALETTE_HOME)).toBe(false);
  });

  it("R5 catches native dialogs but not the useConfirm hook", () => {
    expect(hit("R5", `if (!window.confirm("Delete?")) return;`)).toBe(true);
    expect(hit("R5", `window.alert(msg)`)).toBe(true);
    expect(hit("R5", `if (!confirm("Delete?")) return;`)).toBe(true);
    expect(hit("R5", `if (!(await confirm({ title: "Delete?" }))) return;`)).toBe(false);
  });

  it("R6 catches dark: variants but not object keys", () => {
    expect(hit("R6", `className="dark:bg-black"`)).toBe(true);
    expect(hit("R6", `const icons = { light: Sun, dark: Moon };`)).toBe(false);
  });

  it("R7 catches 9–10px text", () => {
    expect(hit("R7", `className="text-[10px]"`)).toBe(true);
    expect(hit("R7", `className="text-[9px]"`)).toBe(true);
    expect(hit("R7", `className="text-[11px]"`)).toBe(false);
    expect(hit("R7", `className="text-[10px]"`, "src/components/ui/NotificationsBell.tsx")).toBe(false);
  });

  it("R8 catches the default shadow scale", () => {
    expect(hit("R8", `className="shadow-md"`)).toBe(true);
    expect(hit("R8", `className="hover:shadow-lg"`)).toBe(true);
    expect(hit("R8", `className="shadow-card"`)).toBe(false);
  });
});
