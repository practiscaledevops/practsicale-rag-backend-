// Which server env vars a pull connector may reference as its secret.
//
// A data source stores auth_secret_ref = the NAME of an env var, and the runner
// sends that var's value to the source's endpoint as its credential. Without a
// boundary, an admin (or a phished admin session) could point a source at their
// own server with auth_secret_ref=SUPABASE_SERVICE_ROLE_KEY and read the platform's
// secrets straight off the wire. So a reference must look like a connector
// credential (CONNECTOR_*, *_API_KEY, *_TOKEN, *_SECRET, *_KEY) AND must not be
// one of the platform's own variables — checked when a source is saved and
// again by the runner (defence in depth).

const PLATFORM_PREFIXES = /^(SUPABASE_|NEXT_|VERCEL_|AWS_|POSTGRES_|DATABASE_|ANTHROPIC_|OPENAI_|COHERE_|VOYAGE_|CRON_|EMBEDDING|NODE_|LANGFUSE_|UPSTASH_|REDIS_|GITHUB_|NPM_)/;
const PLATFORM_EXACT = new Set(["APP_SECRET", "INGEST_SECRET", "CRON_SECRET", "SUPABASE_SERVICE_ROLE_KEY", "PATH", "HOME"]);
const CONNECTOR_SHAPE = /^(CONNECTOR_[A-Z0-9_]+|[A-Z0-9_]+_(API_KEY|TOKEN|SECRET|KEY))$/;

/** True when `name` is an env-var name a connector is allowed to use as its credential. */
export function isAllowedSecretRef(name: string): boolean {
  if (!/^[A-Z][A-Z0-9_]{2,63}$/.test(name)) return false;
  if (PLATFORM_EXACT.has(name) || PLATFORM_PREFIXES.test(name)) return false;
  return CONNECTOR_SHAPE.test(name);
}

export const SECRET_REF_RULE =
  "auth_secret_ref must name a connector credential env var (CONNECTOR_*, or *_API_KEY / *_TOKEN / *_SECRET / *_KEY) and cannot reference platform variables";
