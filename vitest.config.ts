import { defineConfig } from "vitest/config";
import { fileURLToPath } from "node:url";

// Unit tests for the Brain's pure logic. We provide dummy Supabase/env values so
// modules that construct a client at import time (via @/lib/supabase) don't throw
// — the tests themselves never hit the network (they exercise pure functions).
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    env: {
      NEXT_PUBLIC_SUPABASE_URL: "http://localhost:54321",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "test-anon-key",
      SUPABASE_SERVICE_ROLE_KEY: "test-service-key",
      APP_SECRET: "test-app-secret-0123456789",
    },
  },
});
