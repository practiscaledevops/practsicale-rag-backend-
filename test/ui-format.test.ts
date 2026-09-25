import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fmtBytes,
  fmtCompact,
  fmtDate,
  fmtDuration,
  fmtMoney,
  fmtNumber,
  fmtPct,
  humanize,
  relTime,
} from "@/lib/format";
import {
  CLASS_DOT,
  CLASS_LABEL,
  dedupTone,
  sourceTypeLabel,
  statusLabel,
  statusTone,
  triggerLabel,
} from "@/lib/ui-labels";

describe("relTime", () => {
  // Midday UTC, so the calendar date is the same in every CI timezone.
  const NOW = new Date("2026-06-15T12:00:00Z");
  const minus = (ms: number) => new Date(NOW.getTime() - ms).toISOString();

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("buckets recent times", () => {
    expect(relTime(minus(10_000))).toBe("just now");
    expect(relTime(minus(5 * 60_000))).toBe("5m ago");
    expect(relTime(minus(3 * 3_600_000))).toBe("3h ago");
    expect(relTime(minus(30 * 3_600_000))).toBe("yesterday");
    expect(relTime(minus(4 * 86_400_000))).toBe("4d ago");
  });

  it("treats future timestamps (clock skew) as just now", () => {
    expect(relTime(new Date(NOW.getTime() + 60_000).toISOString())).toBe("just now");
  });

  it("switches to a date after a week", () => {
    expect(relTime(minus(20 * 86_400_000))).toBe("May 26");
    // absolute: false keeps the time-zone-independent form (server-rendered text).
    expect(relTime(minus(20 * 86_400_000), { absolute: false })).toBe("20d ago");
    expect(relTime(minus(4 * 86_400_000), { absolute: true })).toBe("4d ago");
    expect(relTime("2025-01-05T12:00:00Z")).toBe("Jan 5, 2025");
  });

  it("reads missing values as never (or a custom label) and invalid ones as a dash", () => {
    expect(relTime(null)).toBe("never");
    expect(relTime(undefined, { never: "Never synced" })).toBe("Never synced");
    expect(relTime("not a date")).toBe("—");
  });

  it("accepts an explicit clock", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(relTime(new Date(now - 2 * 3_600_000).toISOString(), { now })).toBe("2h ago");
  });
});

describe("fmtMoney", () => {
  it("uses 2 decimals", () => {
    expect(fmtMoney(1234.5)).toBe("$1,234.50");
    expect(fmtMoney(0)).toBe("$0.00");
    expect(fmtMoney(0.01)).toBe("$0.01");
  });
  it("uses 4 decimals below a cent", () => {
    expect(fmtMoney(0.0042)).toBe("$0.0042");
    expect(fmtMoney(-0.005)).toBe("-$0.0050");
  });
  it("returns a dash for missing or invalid input", () => {
    expect(fmtMoney(null)).toBe("—");
    expect(fmtMoney(undefined)).toBe("—");
    expect(fmtMoney(Number.NaN)).toBe("—");
  });
});

describe("fmtDuration", () => {
  it("formats ms, seconds, minutes and hours", () => {
    expect(fmtDuration(850)).toBe("850ms");
    expect(fmtDuration(1200)).toBe("1.2s");
    expect(fmtDuration(45_000)).toBe("45s");
    expect(fmtDuration(185_000)).toBe("3m 5s");
    expect(fmtDuration(3_720_000)).toBe("1h 2m");
  });
  it("returns a dash for missing or negative input", () => {
    expect(fmtDuration(null)).toBe("—");
    expect(fmtDuration(-5)).toBe("—");
  });
});

describe("fmtBytes", () => {
  it("formats B, KB, MB and GB", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(1536)).toBe("1.5 KB");
    expect(fmtBytes(3.2 * 1024 * 1024)).toBe("3.2 MB");
    expect(fmtBytes(1.1 * 1024 ** 3)).toBe("1.1 GB");
  });
  it("returns a dash for missing input", () => {
    expect(fmtBytes(undefined)).toBe("—");
  });
});

describe("other formatters", () => {
  it("fmtDate / fmtNumber / fmtCompact / fmtPct", () => {
    expect(fmtDate("2026-01-05T12:00:00Z")).toBe("Jan 5, 2026");
    expect(fmtDate("garbage")).toBe("—");
    expect(fmtNumber(1204553)).toBe("1,204,553");
    expect(fmtCompact(1200)).toBe("1.2K");
    expect(fmtCompact(2_500_000)).toBe("2.5M");
    expect(fmtPct(0.423)).toBe("42%");
    expect(fmtPct(0.4236, 1)).toBe("42.4%");
    expect(fmtPct(null)).toBe("—");
  });
});

describe("humanize", () => {
  it("capitalises and replaces separators", () => {
    expect(humanize("needs_review")).toBe("Needs review");
    expect(humanize("call-score")).toBe("Call score");
    expect(humanize("business__reality")).toBe("Business reality");
  });
  it("returns a dash for empty input", () => {
    expect(humanize("")).toBe("—");
    expect(humanize(null)).toBe("—");
  });
});

describe("statusTone", () => {
  it("maps healthy and done states to success", () => {
    for (const s of ["success", "completed", "ready", "active", "indexed", "healthy", "ok"]) {
      expect(statusTone(s)).toBe("success");
    }
  });
  it("maps in-progress states to accent", () => {
    for (const s of ["running", "processing", "in_progress", "syncing"]) expect(statusTone(s)).toBe("accent");
  });
  it("maps attention states to warning", () => {
    for (const s of ["partial", "stale", "draft", "needs_review", "pending_review"]) expect(statusTone(s)).toBe("warning");
  });
  it("maps failures to danger", () => {
    for (const s of ["failed", "error", "rejected", "blocked"]) expect(statusTone(s)).toBe("danger");
  });
  it("keeps archived, paused, never and unknown values neutral", () => {
    for (const s of ["archived", "historical", "paused", "never", "queued", "something_else"]) {
      expect(statusTone(s)).toBe("neutral");
    }
    expect(statusTone(null)).toBe("neutral");
    expect(statusTone(undefined)).toBe("neutral");
  });
  it("is case-insensitive and treats - and _ the same", () => {
    expect(statusTone("FAILED")).toBe("danger");
    expect(statusTone("In-Progress")).toBe("accent");
    expect(statusTone("needs-review")).toBe("warning");
    expect(statusTone("Changes Requested")).toBe("warning");
  });
});

describe("labels", () => {
  it("sourceTypeLabel uses the shared map and falls back to humanize", () => {
    expect(sourceTypeLabel("document")).toBe("Document");
    expect(sourceTypeLabel("call_score")).toBe("Call score");
    expect(sourceTypeLabel("web_page")).toBe("Web page");
    expect(sourceTypeLabel(null)).toBe("—");
  });
  it("statusLabel humanizes", () => {
    expect(statusLabel("needs_review")).toBe("Needs review");
  });
  it("every knowledge class has a label and a dot colour", () => {
    expect(Object.keys(CLASS_DOT).sort()).toEqual(Object.keys(CLASS_LABEL).sort());
  });
  it("class labels come from the taxonomy", () => {
    expect(CLASS_LABEL.organizational_learning).toBe("Organizational Learning");
    expect(CLASS_LABEL.raw_archive).toBe("Raw Archive");
  });
  it("triggerLabel uses the shared map and falls back to humanize", () => {
    expect(triggerLabel("manual")).toBe("Manual sync");
    expect(triggerLabel("schedule")).toBe("Scheduled");
    expect(triggerLabel("cron_job")).toBe("Cron job");
    expect(triggerLabel(null)).toBe("—");
  });
});

describe("dedupTone", () => {
  it("colours each dedup outcome the same everywhere", () => {
    expect(dedupTone("new")).toBe("success");
    expect(dedupTone("enrich")).toBe("info");
    expect(dedupTone("enriched")).toBe("info");
    expect(dedupTone("duplicate")).toBe("neutral");
    expect(dedupTone("conflict")).toBe("warning");
    expect(dedupTone("blocked")).toBe("warning");
    expect(dedupTone("failed")).toBe("danger");
  });
  it("checks failure and conflict before new", () => {
    expect(dedupTone("new_conflict")).toBe("warning");
    expect(dedupTone("raw_failed")).toBe("danger");
    expect(dedupTone("something_else")).toBe("neutral");
  });
});
