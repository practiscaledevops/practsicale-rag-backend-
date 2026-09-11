import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { isDemo } from "@/lib/demo/mode";

// Security regression guard: a NEXT_PUBLIC_DEMO_MODE baked into a PRODUCTION
// build must never bypass real auth / serve fixtures. Only the server flag, or
// the client flag in development, may enable demo mode.
describe("isDemo (demo-mode auth guard)", () => {
  const KEYS = ["DEMO_MODE", "NEXT_PUBLIC_DEMO_MODE", "NODE_ENV"] as const;
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of KEYS) saved[k] = process.env[k];
    delete process.env.DEMO_MODE;
    delete process.env.NEXT_PUBLIC_DEMO_MODE;
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (saved[k] === undefined) delete (process.env as Record<string, string | undefined>)[k];
      else process.env[k] = saved[k];
    }
  });

  it("server DEMO_MODE=1 always enables demo", () => {
    process.env.DEMO_MODE = "1";
    (process.env as Record<string, string>).NODE_ENV = "production";
    expect(isDemo()).toBe(true);
  });

  it("honours NEXT_PUBLIC_DEMO_MODE in development", () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = "1";
    (process.env as Record<string, string>).NODE_ENV = "development";
    expect(isDemo()).toBe(true);
  });

  it("IGNORES NEXT_PUBLIC_DEMO_MODE in production (no auth bypass)", () => {
    process.env.NEXT_PUBLIC_DEMO_MODE = "1";
    (process.env as Record<string, string>).NODE_ENV = "production";
    expect(isDemo()).toBe(false);
  });

  it("is off when nothing is set", () => {
    (process.env as Record<string, string>).NODE_ENV = "production";
    expect(isDemo()).toBe(false);
  });
});
