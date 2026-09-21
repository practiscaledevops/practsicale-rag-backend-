import { describe, it, expect } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { safeFilename, uploadPath, assertOrgPath, downloadUpload, UploadError, MAX_STORAGE_UPLOAD_BYTES, UPLOAD_BUCKET } from "@/lib/knowledge-uploads";
import { MAX_BYTES_BY_KIND, MAX_DIRECT_UPLOAD_BYTES, MAX_LONG_TEXT_CHARS, capText } from "@/lib/ingest-adapters/pure";
import { extractAny } from "@/lib/ingest-adapters";

// Pure parts only — no Supabase project, no network.

const ORG = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-2222-3333-4444-555555555555";
const ID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("safeFilename", () => {
  it("keeps a plain name and its extension", () => {
    expect(safeFilename("PreSold-TheBook.pdf")).toBe("PreSold-TheBook.pdf");
    expect(safeFilename("voice_note.2026-09.m4a")).toBe("voice_note.2026-09.m4a");
  });

  it("drops directories, traversal, spaces, unicode and shell characters", () => {
    expect(safeFilename("C:\\Users\\me\\Desktop\\My Book (final).pdf")).toBe("My-Book-final-.pdf");
    expect(safeFilename("../../etc/passwd")).toBe("passwd");
    expect(safeFilename("..\\..\\secret.txt")).toBe("secret.txt");
    expect(safeFilename("résumé – v2.pdf")).toBe("resume-v2.pdf");
    expect(safeFilename("a/b/../c?.pdf")).toBe("c-.pdf");
    expect(safeFilename("x;rm -rf $HOME.pdf")).toBe("x-rm-rf-HOME.pdf");
    expect(safeFilename("....hidden")).toBe("hidden");
    for (const n of ["weird name#1?.pdf", "日本語の本.pdf", "a..b...c.pdf"]) expect(safeFilename(n), n).toMatch(/^[A-Za-z0-9_-][A-Za-z0-9._-]*$/);
    expect(safeFilename("a..b...c.pdf")).not.toContain("..");
  });

  it("falls back to 'upload' and caps the length, keeping the extension", () => {
    expect(safeFilename("")).toBe("upload");
    expect(safeFilename("///")).toBe("upload");
    expect(safeFilename("???")).toBe("upload");
    const long = safeFilename(`${"a".repeat(300)}.pdf`);
    expect(long.length).toBeLessThanOrEqual(80);
    expect(long.endsWith(".pdf")).toBe(true);
  });
});

describe("uploadPath", () => {
  it("is org/<orgId>/<uuid>-<safe filename>", () => {
    expect(uploadPath(ORG, "My Book.pdf", ID)).toBe(`org/${ORG}/${ID}-My-Book.pdf`);
    // A generated id is a uuid, and the result passes the guard.
    const p = uploadPath(ORG, "../../x.pdf");
    expect(p).toMatch(new RegExp(`^org/${ORG}/[0-9a-f-]{36}-x\\.pdf$`));
    expect(assertOrgPath(ORG, p)).toBe(p);
  });

  it("refuses an org id that could escape the prefix", () => {
    for (const bad of ["", "../other", "a/b", "a\\b"]) expect(() => uploadPath(bad, "x.pdf"), bad).toThrow(UploadError);
  });
});

describe("assertOrgPath (the server-side org-prefix guard)", () => {
  const good = `org/${ORG}/${ID}-book.pdf`;

  it("accepts a path under the caller's own prefix", () => {
    expect(assertOrgPath(ORG, good)).toBe(good);
  });

  it("refuses another org's prefix, traversal, nesting, absolute paths and junk with a 403", () => {
    for (const bad of [
      `org/${OTHER}/${ID}-book.pdf`,
      `org/${ORG}/../${OTHER}/${ID}-book.pdf`,
      `org/${ORG}/${ID}-book.pdf/../../${OTHER}/x`,
      `org/${ORG}/sub/${ID}-book.pdf`,
      `org/${ORG}/${ID}-..pdf/x`,
      `org/${ORG}/${ID}-a\\b.pdf`,
      `/org/${ORG}/${ID}-book.pdf`,
      `org/${ORG}/book.pdf`,
      `org/${ORG}/${ID}-`,
      `org/${ORG}/`,
      `org/${ORG}`,
      `ORG/${ORG}/${ID}-book.pdf`,
      `org/${ORG}/${ID}-book name.pdf`,
      `org/${ORG}/${ID}-${"a".repeat(400)}.pdf`,
      "",
      null,
      42,
      { path: good },
    ]) {
      let err: unknown;
      try {
        assertOrgPath(ORG, bad);
      } catch (e) {
        err = e;
      }
      expect(err, String(bad)).toBeInstanceOf(UploadError);
      expect((err as UploadError).status).toBe(403);
    }
    // The same path is fine for ITS org and refused for any other.
    expect(() => assertOrgPath(OTHER, good)).toThrow(UploadError);
    expect(() => assertOrgPath("", good)).toThrow(UploadError);
  });

  it("downloadUpload checks the prefix before it touches storage", async () => {
    let touched = false;
    const db = { storage: { from: () => { touched = true; return { download: async () => ({ data: null, error: { message: "x" } }) }; } } } as unknown as SupabaseClient;
    await expect(downloadUpload(db, ORG, `org/${OTHER}/${ID}-book.pdf`)).rejects.toMatchObject({ status: 403 });
    expect(touched).toBe(false);
    // Own prefix → storage is asked; a missing object is a readable 404.
    await expect(downloadUpload(db, ORG, good)).rejects.toMatchObject({ status: 404 });
    expect(touched).toBe(true);
    // The demo client has no storage → readable 503, not a crash.
    await expect(downloadUpload({} as SupabaseClient, ORG, good)).rejects.toMatchObject({ status: 503 });
  });
});

describe("upload limits", () => {
  it("50 MB through storage, 4 MB direct, per-kind ceilings", () => {
    expect(UPLOAD_BUCKET).toBe("knowledge-uploads");
    expect(MAX_STORAGE_UPLOAD_BYTES).toBe(50 * 1024 * 1024);
    expect(MAX_DIRECT_UPLOAD_BYTES).toBe(4 * 1024 * 1024);
    expect(MAX_BYTES_BY_KIND.pdf).toBe(MAX_STORAGE_UPLOAD_BYTES);
    expect(MAX_BYTES_BY_KIND.audio).toBe(25 * 1024 * 1024);
  });

  it("`full` lifts the 60k text cap to the long cap (truncation still reported)", async () => {
    const buffer = Buffer.from(("z".repeat(80) + "\n").repeat(1000)); // 81k chars
    const capped = await extractAny({ file: { name: "big.txt", mime: "text/plain", buffer } });
    expect(capped.truncated).toBe(true);
    const full = await extractAny({ file: { name: "big.txt", mime: "text/plain", buffer } }, { full: true });
    expect(full.truncated).toBe(false);
    expect(full.chars).toBe(80_999);
    const r = capText("y".repeat(MAX_LONG_TEXT_CHARS + 10), MAX_LONG_TEXT_CHARS);
    expect(r.truncated).toBe(true);
    expect(r.text).toContain("truncated to 2,000,000 characters");
  });
});
