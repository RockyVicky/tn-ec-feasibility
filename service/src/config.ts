/**
 * Runtime config. Values come from the environment; see .env.example.
 * Assumptions made in the absence of client answers are documented in
 * ../../docs/assumptions.md and flagged here with ASSUMPTION:.
 */

function env(key: string, fallback?: string): string {
  const v = process.env[key] ?? fallback;
  if (v === undefined) throw new Error(`missing required env: ${key}`);
  return v;
}

export interface Config {
  port: number;
  logLevel: string;
  backend: "memory" | "postgres+redis";
  databaseUrl: string;
  redisUrl: string;
  providerOrder: string[];
  webhookSigningSecret: string;
  tenantKeys: Record<string, string>;
  hitlMode: "auto" | "console";
  aggregators: {
    landeed: { baseUrl: string; apiKey: string };
    surepass: { baseUrl: string; apiKey: string };
  };
  /** ASSUMPTION (docs/assumptions.md A5): dedupe window for informational ECs. */
  dedupeWindowDays: number;
  /** ASSUMPTION (A6): webhook delivery retry budget. */
  webhookRetry: { attempts: number; baseDelayMs: number };
}

export function loadConfig(): Config {
  return {
    port: Number(env("PORT", "8080")),
    logLevel: env("LOG_LEVEL", "info"),
    backend: env("BACKEND", "memory") as Config["backend"],
    databaseUrl: env("DATABASE_URL", "postgres://ec:ec@localhost:5432/ec"),
    redisUrl: env("REDIS_URL", "redis://localhost:6379"),
    providerOrder: env("PROVIDER_ORDER", "mock").split(",").map((s) => s.trim()).filter(Boolean),
    webhookSigningSecret: env("WEBHOOK_SIGNING_SECRET", "dev-secret-change-me"),
    tenantKeys: JSON.parse(env("TENANT_KEYS", '{"erp-staging":"dev-tenant-key"}')),
    hitlMode: env("HITL_MODE", "auto") as Config["hitlMode"],
    aggregators: {
      landeed: { baseUrl: env("LANDEED_BASE_URL", ""), apiKey: env("LANDEED_API_KEY", "") },
      surepass: { baseUrl: env("SUREPASS_BASE_URL", ""), apiKey: env("SUREPASS_API_KEY", "") },
    },
    dedupeWindowDays: Number(env("DEDUPE_WINDOW_DAYS", "14")),
    webhookRetry: { attempts: 8, baseDelayMs: 2000 },
  };
}
