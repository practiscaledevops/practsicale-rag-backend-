import { describe, it, expect, afterEach, vi } from "vitest";
import { isDemo } from "@/lib/demo/mode";

// Security regression guard: a NEXT_PUBLIC_DEMO_MODE baked into a PRODUCTION
// build must never bypass real auth / serve fixtures. Only the server flag, or
// the client flag in development, may enable demo mode.
describe("isDemo (demo-mode auth guard)", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("server DEMO_MODE=1 always enables demo", () => {
    vi.stubEnv("DEMO_MODE", "1");
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(isDemo()).toBe(true);
  });

  it("honours NEXT_PUBLIC_DEMO_MODE in development", () => {
    vi.stubEnv("DEMO_MODE", "");
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "1");
    vi.stubEnv("NODE_ENV", "development");
    expect(isDemo()).toBe(true);
  });

  it("IGNORES NEXT_PUBLIC_DEMO_MODE in production (no auth bypass)", () => {
    vi.stubEnv("DEMO_MODE", "");
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "1");
    vi.stubEnv("NODE_ENV", "production");
    expect(isDemo()).toBe(false);
  });

  it("is off when nothing is set", () => {
    vi.stubEnv("DEMO_MODE", "");
    vi.stubEnv("NEXT_PUBLIC_DEMO_MODE", "");
    vi.stubEnv("NODE_ENV", "production");
    expect(isDemo()).toBe(false);
  });
});
