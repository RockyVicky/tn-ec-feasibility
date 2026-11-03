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
  /** "memory" = in-process everything; "postgres" = Postgres store + durable queue */
  backend: "memory" | "postgres";
  databaseUrl: string;
  /** "memory" | "local:<dir>" object store for EC documents */
  storage: string;
  providerOrder: string[];
  webhookSigningSecret: string;
  tenantKeys: Record<string, string>;
  hitlMode: "auto" | "console";
  aggregators: {
    landeed: { baseUrl: string; apiKey: string };
    surepass: { baseUrl: string; apiKey: string };
  };
  automation: { portalUrl: string; username: string; password: string; headless: boolean; recordVideoDir: string; pdfDownloadDir: string; userDataDir: string; twoCaptchaApiKey: string; nopechaExtensionPath: string; cdpConnectUrl: string; fastCaptchaApiKey: string };
  /** ASSUMPTION (docs/assumptions.md A5): dedupe window for informational ECs. */
  dedupeWindowDays: number;
  /** ASSUMPTION (A6): webhook delivery retry budget. */
  webhookRetry: { attempts: number; baseDelayMs: number };
  /** per-tenant request rate limit (requests / window) */
  rateLimit: { max: number; windowMs: number };
  /**
   * Simulated wait for a Sub-Registrar to digitally sign a certified EC. In
   * reality 1-10 days; short here so the async flow is demonstrable. Real
   * deployments poll the portal / vendor for the signed copy instead.
   */
  certifiedSignDelayMs: number;
}

export function loadConfig(): Config {
  return {
    port: Number(env("PORT", "8080")),
    logLevel: env("LOG_LEVEL", "info"),
    backend: env("BACKEND", "memory") as Config["backend"],
    databaseUrl: env("DATABASE_URL", "pglite://memory"),
    storage: env("STORAGE", "memory"),
    providerOrder: env("PROVIDER_ORDER", "mock").split(",").map((s) => s.trim()).filter(Boolean),
    webhookSigningSecret: env("WEBHOOK_SIGNING_SECRET", "dev-secret-change-me"),
    tenantKeys: JSON.parse(env("TENANT_KEYS", '{"erp-staging":"dev-tenant-key"}')),
    hitlMode: env("HITL_MODE", "auto") as Config["hitlMode"],
    aggregators: {
      landeed: { baseUrl: env("LANDEED_BASE_URL", ""), apiKey: env("LANDEED_API_KEY", "") },
      surepass: { baseUrl: env("SUREPASS_BASE_URL", ""), apiKey: env("SUREPASS_API_KEY", "") },
    },
    automation: {
      portalUrl: env("AUTOMATION_PORTAL_URL", ""),
      username: env("AUTOMATION_USERNAME", ""),
      password: env("AUTOMATION_PASSWORD", ""),
      // Default headless; set to "false" to watch the worker's browser window
      // live (e.g. while diagnosing against the real portal).
      headless: env("AUTOMATION_HEADLESS", "true") !== "false",
      // Set to a directory to record the run as a .webm video — useful proof of
      // a live run when there's no way to show the headless browser on screen.
      recordVideoDir: env("AUTOMATION_RECORD_VIDEO_DIR", ""),
      // Set to a directory to save a print-to-PDF of each successful results
      // page there — the real portal's free search has no download link of
      // its own (confirmed live), so this is our own copy, not a portal file.
      pdfDownloadDir: env("AUTOMATION_PDF_DOWNLOAD_DIR", ""),
      // Set to a directory to launch from a persistent Chrome profile there
      // instead of a fresh throwaway session each run, so a login done once
      // in the visible browser carries over to later automated runs.
      userDataDir: env("AUTOMATION_USER_DATA_DIR", ""),
      // Feature flag, off by default: set to a real 2Captcha API key to try
      // auto-solving each portal CAPTCHA via 2Captcha before falling back to
      // the human operator (console HITL). Empty string = untouched existing
      // behavior — every CAPTCHA still goes straight to the operator.
      twoCaptchaApiKey: env("TWO_CAPTCHA_API_KEY", ""),
      // Separate, independent feature flag — NOT the 2Captcha path above.
      // Set to the folder of an UNPACKED NopeCHA browser extension (download
      // it yourself from the Chrome Web Store or a GitHub release and unzip
      // it; this code never downloads it for you) to have NopeCHA's free
      // tier (100 solves/day, no API key/cost) try to auto-fill the CAPTCHA
      // field directly in the browser before either 2Captcha or the human
      // operator ever gets asked. Empty = extension never loads; existing
      // behavior is completely unchanged.
      nopechaExtensionPath: env("NOPECHA_EXTENSION_PATH", ""),
      // Separate, independent feature flag: a CDP URL of a Chrome you start
      // yourself (chrome.exe --remote-debugging-port=9222), with NopeCHA
      // already installed normally. Chrome blocks Developer mode / unpacked
      // extensions in any browser Playwright launches itself, so this is
      // the sidestep — see WorkerConfig.cdpConnectUrl in
      // automation-worker.ts. Empty = this path never runs.
      cdpConnectUrl: env("AUTOMATION_CDP_URL", ""),
      // Separate, independent feature flag from everything above: a
      // FastCaptcha API key (fastcaptcha.org). Plain synchronous REST API,
      // no browser extension/profile involved, so none of the Chrome
      // automation-lockdown issues NopeCHA hit apply. Empty = untouched
      // existing behavior.
      fastCaptchaApiKey: env("FASTCAPTCHA_API_KEY", ""),
    },
    dedupeWindowDays: Number(env("DEDUPE_WINDOW_DAYS", "14")),
    webhookRetry: { attempts: 8, baseDelayMs: 2000 },
    rateLimit: { max: Number(env("RATE_LIMIT_MAX", "120")), windowMs: Number(env("RATE_LIMIT_WINDOW_MS", "60000")) },
    certifiedSignDelayMs: Number(env("CERTIFIED_SIGN_DELAY_MS", "4000")),
  };
}
