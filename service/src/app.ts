import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { readdir as fsReaddir, stat as fsStat, readFile as fsReadFile } from "node:fs/promises";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";
import fastifyMultipart from "@fastify/multipart";

import { loadConfig, type Config } from "./config.ts";
import { EcRequestSchema, type RequestStatus } from "./contract.ts";
import { openDb, type Db } from "./db/pg.ts";
import { MemoryRequestStore } from "./store/memory.ts";
import { PostgresRequestStore } from "./store/postgres.ts";
import type { RequestStore, StoredRequest } from "./store/types.ts";
import { MemoryQueue } from "./queue/memory.ts";
import { PostgresQueue } from "./queue/postgres.ts";
import type { Queue } from "./queue/types.ts";
import { MemoryHitlStore } from "./hitl/store.ts";
import type { HitlStore } from "./hitl/types.ts";
import { registerHitlRoutes } from "./hitl/routes.ts";
import { MemoryObjectStore, LocalObjectStore } from "./storage/index.ts";
import type { ObjectStore } from "./storage/types.ts";
import { ProviderRouter } from "./providers/router.ts";
import type { EcProvider } from "./providers/types.ts";
import { MockProvider } from "./providers/mock.ts";
import { LandeedProvider } from "./providers/landeed.ts";
import { SurepassProvider } from "./providers/surepass.ts";
import { AutomationProvider } from "./providers/automation.ts";
import { HttpWebhookDeliverer, type WebhookDeliverer } from "./webhook/deliver.ts";
import { createPipeline, type Pipeline } from "./pipeline.ts";
import { paramHash } from "./util/hash.ts";
import { coverage } from "./masterdata/index.ts";
import { metrics } from "./metrics.ts";
import { extractPropertyFromPdf } from "./batch/extract.ts";
import { MemoryBatchStore } from "./batch/store.ts";
import { createBatchRunner } from "./batch/runner.ts";
import type { Batch, BatchRecord } from "./batch/types.ts";

declare module "fastify" {
  interface FastifyInstance {
    _internals: {
      store: RequestStore;
      hitl: HitlStore;
      queue: Queue<{ requestId: string }>;
      pipeline: Pipeline;
      storage: ObjectStore;
      config: Config;
      db?: Db;
    };
  }
  interface FastifyRequest {
    tenant?: string;
  }
}

export interface BuildOptions {
  config?: Partial<Config>;
  store?: RequestStore;
  hitl?: HitlStore;
  providers?: EcProvider[];
  webhooks?: WebhookDeliverer;
  queue?: Queue<{ requestId: string }>;
  storage?: ObjectStore;
}

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const OPEN_PREFIXES = ["/healthz", "/metrics", "/ops", "/public", "/dashboard", "/demo", "/batch", "/v1/documents"];

export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const config: Config = { ...loadConfig(), ...opts.config };
  const app = Fastify({ logger: { level: config.logLevel } });
  const log = (event: string, data?: Record<string, unknown>) => app.log.info({ event, ...data });

  // ---- backend wiring ----
  let db: Db | undefined;
  let store: RequestStore;
  let queue: Queue<{ requestId: string }>;

  if (opts.store && opts.queue) {
    store = opts.store;
    queue = opts.queue;
  } else if (config.backend === "postgres") {
    db = await openDb(config.databaseUrl);
    store = opts.store ?? new PostgresRequestStore(db);
    queue = opts.queue ?? new PostgresQueue<{ requestId: string }>(db, "ec");
  } else {
    store = opts.store ?? new MemoryRequestStore();
    queue =
      opts.queue ??
      new MemoryQueue<{ requestId: string }>({ maxAttempts: 5, baseDelayMs: 1000, onDlq: (job, err) => app.log.error({ event: "dlq", job: job.id, err: String(err) }) });
  }

  const storage: ObjectStore =
    opts.storage ??
    (config.storage.startsWith("local:")
      ? new LocalObjectStore(config.webhookSigningSecret, config.storage.slice("local:".length))
      : new MemoryObjectStore(config.webhookSigningSecret));

  const hitl = opts.hitl ?? new MemoryHitlStore(config.hitlMode);
  const webhooks =
    opts.webhooks ??
    new HttpWebhookDeliverer(config.webhookSigningSecret, config.webhookRetry, (e, d) => app.log.info({ event: e, ...d }));

  const providers = opts.providers ?? buildProviders(config);
  const router = new ProviderRouter(orderProviders(providers, config.providerOrder));
  const pipeline = createPipeline({
    store, router, webhooks, hitl, storage, config, log,
    enqueueDelayed: (id, ms) => queue.add({ requestId: id }, { delayMs: ms }).then(() => undefined),
  });

  queue.process(async (job) => {
    const t = metrics.timer("pipeline_run");
    try {
      await pipeline.run(job.payload.requestId);
    } finally {
      t();
    }
  });

  // ---- auth + rate limit ----
  const buckets = new Map<string, { count: number; resetAt: number }>();
  app.addHook("onRequest", async (req, reply) => {
    metrics.inc("http_requests_total");
    if (OPEN_PREFIXES.some((p) => req.url === p || req.url.startsWith(p + "/") || req.url.startsWith(p + "?")) || req.url === "/") return;

    const key = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const tenant = Object.entries(config.tenantKeys).find(([, v]) => v === key)?.[0];
    if (!tenant) {
      metrics.inc("auth_rejected_total");
      return reply.code(401).send({ error: "unauthorized" });
    }
    req.tenant = tenant;

    const now = Date.now();
    const b = buckets.get(tenant);
    if (!b || b.resetAt < now) {
      buckets.set(tenant, { count: 1, resetAt: now + config.rateLimit.windowMs });
    } else if (b.count >= config.rateLimit.max) {
      metrics.inc("rate_limited_total");
      reply.header("retry-after", Math.ceil((b.resetAt - now) / 1000));
      return reply.code(429).send({ error: "rate_limited" });
    } else {
      b.count += 1;
    }
  });

  // ---- API ----
  app.post("/v1/ec-requests", async (req, reply) => {
    const idem = req.headers["idempotency-key"];
    if (typeof idem !== "string" || idem.length < 8) {
      return reply.code(400).send({ error: "validation", details: [{ field: "Idempotency-Key", message: "header required (min 8 chars)" }] });
    }
    const parsed = EcRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: "validation", details: parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })) });
    }

    const existing = await store.findByIdempotencyKey(idem);
    if (existing) {
      if (existing.paramHash !== paramHash(parsed.data)) return reply.code(409).send({ error: "idempotency_conflict" });
      return reply.code(200).send(existing.status);
    }

    const requestId = randomUUID();
    const now = new Date().toISOString();
    const status: RequestStatus = {
      requestId,
      reference: parsed.data.reference,
      status: "queued",
      certified: parsed.data.certified,
      source: null,
      submittedAt: now,
      completedAt: null,
      estimate: parsed.data.certified ? { type: "days", value: 5 } : { type: "minutes", value: 5 },
      result: null,
      documents: [],
      failure: null,
    };
    const rec: StoredRequest = {
      status,
      request: parsed.data,
      idempotencyKey: idem,
      paramHash: paramHash(parsed.data),
      createdAt: now,
      updatedAt: now,
      audit: [{ at: now, event: "received", detail: { tenant: req.tenant } }],
    };
    await store.create(rec);
    metrics.inc("ec_requests_total");
    void webhooks.send("ec.received", status, parsed.data.callbackUrl);
    await queue.add({ requestId });

    return reply.code(202).send(status);
  });

  app.get("/v1/ec-requests/:id", async (req, reply) => {
    const rec = await store.get((req.params as { id: string }).id);
    if (!rec) return reply.code(404).send({ error: "not_found" });
    return rec.status;
  });

  // ---- documents (signed, no bearer needed) ----
  app.get("/v1/documents/*", async (req, reply) => {
    const key = decodeURIComponent((req.params as Record<string, string>)["*"] ?? "");
    const { exp, token } = req.query as { exp?: string; token?: string };
    if (!storage.verify(key, exp ?? "", token ?? "")) return reply.code(403).send({ error: "bad_or_expired_token" });
    const obj = await storage.get(key);
    if (!obj) return reply.code(404).send({ error: "not_found" });
    metrics.inc("documents_served_total");
    return reply.type(obj.contentType).send(obj.data);
  });

  // ---- ops / HITL ----
  registerHitlRoutes(app, hitl);
  app.get("/ops/coverage", async () => coverage());
  // Read-only, unauthenticated mirror of GET /v1/ec-requests/:id for the operator
  // console: the console has no tenant API key of its own, so it can't call the
  // bearer-protected endpoint directly. Lets it show success/failure right after
  // a CAPTCHA/OTP is answered instead of leaving the operator with no feedback.
  app.get("/ops/requests/:id", async (req, reply) => {
    const rec = await store.get((req.params as { id: string }).id);
    if (!rec) return reply.code(404).send({ error: "not_found" });
    return rec.status;
  });
  // Persistent list view for the console — survives a page reload, unlike the
  // console's own in-memory "answered this session" tracking.
  app.get("/ops/requests", async () => {
    const recs = await store.list();
    return {
      requests: recs.map((rec) => {
        const p = rec.request.property;
        const pdfRef = rec.status.result?.provenance.rawArtifactRefs.find((r) => r.startsWith("file://"));
        return {
          requestId: rec.status.requestId,
          reference: rec.status.reference,
          combo: [p.zone, p.district, p.sroCode, p.village].filter(Boolean).join(" / "),
          surveyNumber: p.surveyNumber,
          status: rec.status.status,
          outcome: rec.status.result?.outcome ?? null,
          entryCount: rec.status.result?.entryCount ?? null,
          failure: rec.status.failure ?? null,
          pdfFile: pdfRef ? pdfRef.replace("file://", "").split(/[\\/]/).pop() : null,
          createdAt: rec.createdAt,
          updatedAt: rec.updatedAt,
        };
      }),
    };
  });
  // Lists what's actually landed on disk in the PDF download folder, independent
  // of the request store — the folder is the source of truth for "what did we
  // actually get," including files from before the current process started.
  app.get("/ops/downloads", async () => {
    const dir = config.automation.pdfDownloadDir;
    if (!dir) return { dir: null, files: [] };
    try {
      const names = (await fsReaddir(dir)).filter((n) => n.toLowerCase().endsWith(".pdf"));
      const files = await Promise.all(
        names.map(async (name) => {
          const st = await fsStat(path.join(dir, name));
          return { name, sizeBytes: st.size, modifiedAt: st.mtime.toISOString() };
        }),
      );
      files.sort((a, b) => (a.modifiedAt < b.modifiedAt ? 1 : -1));
      return { dir, files };
    } catch {
      return { dir, files: [] };
    }
  });
  // Streams a single downloaded PDF so the console can open/view it directly —
  // filename only (no path segments) to stay confined to pdfDownloadDir.
  app.get("/ops/downloads/:name", async (req, reply) => {
    const dir = config.automation.pdfDownloadDir;
    const name = (req.params as { name: string }).name;
    if (!dir || name.includes("/") || name.includes("\\") || name.includes("..")) {
      return reply.code(400).send({ error: "bad_filename" });
    }
    try {
      const data = await fsReadFile(path.join(dir, name));
      return reply.type("application/pdf").send(data);
    } catch {
      return reply.code(404).send({ error: "not_found" });
    }
  });

  // ---- observability ----
  app.get("/metrics", async (_req, reply) => reply.type("text/plain").send(metrics.prometheus()));
  app.get("/healthz", async () => ({
    ok: true,
    backend: config.backend,
    storage: config.storage.startsWith("local:") ? "local" : "memory",
    providers: providers.map((p) => p.name),
    db: db ? "connected" : "n/a",
  }));

  // ---- batch PDF upload / review / run ----
  await app.register(fastifyMultipart, { limits: { fileSize: 25 * 1024 * 1024, files: 50 } });
  const batchStore = new MemoryBatchStore();
  const batchTenantKey = Object.values(config.tenantKeys)[0] ?? "dev-tenant-key";
  const batchRunner = createBatchRunner(app, batchStore, store, batchTenantKey);

  // Upload a folder's worth of EC PDFs. Each is parsed for Zone/District/SRO/
  // Village/Survey No. and comes back as an editable record for the review
  // step — extraction is best-effort (see batch/extract.ts), not authoritative.
  app.post("/ops/batch", async (req, reply) => {
    const parts = req.parts();
    const records: BatchRecord[] = [];
    for await (const part of parts) {
      if (part.type !== "file" || !part.filename?.toLowerCase().endsWith(".pdf")) continue;
      const buf = await part.toBuffer();
      let extraction: Awaited<ReturnType<typeof extractPropertyFromPdf>>;
      try {
        extraction = await extractPropertyFromPdf(buf);
      } catch (e) {
        extraction = { property: { zone: "", district: "", sroCode: "", village: "", surveyNumber: "" }, warning: `Could not read this PDF: ${String(e)}` };
      }
      records.push({
        id: randomUUID(),
        fileName: part.filename,
        extracted: extraction.property,
        // Confirmed live: the portal's own "Data Availability Period" for
        // these villages ends 31-Dec-2024 (printed on the real certificates
        // themselves) - defaulting this to today's date put every batch
        // record's end date outside that window. The year/month dropdowns
        // accept it fine (they're generic), but the day-click silently does
        // nothing for a day outside the available range, leaving the field
        // empty with no error - exactly the bug chased for the last hour.
        // Matches every manual test tonight, all of which used this value.
        periodFrom: "2004-01-01",
        periodTo: "2024-12-31",
        status: "extracted",
        extractionWarning: extraction.warning,
      });
    }
    if (records.length === 0) return reply.code(400).send({ error: "no_pdfs", message: "No .pdf files found in the upload" });
    const batch: Batch = { id: randomUUID(), createdAt: new Date().toISOString(), records, started: false };
    batchStore.create(batch);
    return reply.code(201).send(batch);
  });

  app.get("/ops/batch/:id", async (req, reply) => {
    const batch = batchStore.get((req.params as { id: string }).id);
    if (!batch) return reply.code(404).send({ error: "not_found" });
    return batch;
  });

  // Edit one record's fields during the review step, before the batch starts.
  app.patch("/ops/batch/:id/records/:recordId", async (req, reply) => {
    const { id, recordId } = req.params as { id: string; recordId: string };
    const batch = batchStore.get(id);
    if (!batch) return reply.code(404).send({ error: "not_found" });
    if (batch.started) return reply.code(409).send({ error: "already_started" });
    const patch = req.body as Partial<BatchRecord>;
    const rec = batchStore.updateRecord(id, recordId, {
      extracted: patch.extracted ? { ...batch.records.find((r) => r.id === recordId)?.extracted, ...patch.extracted } : undefined,
      periodFrom: patch.periodFrom,
      periodTo: patch.periodTo,
    } as Partial<BatchRecord>);
    if (!rec) return reply.code(404).send({ error: "not_found" });
    return rec;
  });

  // Kicks off the batch in the background — one record at a time, in order
  // (see batch/runner.ts). Returns immediately; the dashboard polls GET
  // /ops/batch/:id for live status of each record, including any CAPTCHA
  // (via the existing /ops/tasks endpoint) the currently-running one needs.
  app.post("/ops/batch/:id/start", async (req, reply) => {
    const batch = batchStore.get((req.params as { id: string }).id);
    if (!batch) return reply.code(404).send({ error: "not_found" });
    if (!batchStore.tryMarkStarted(batch.id)) return reply.code(409).send({ error: "already_started" });
    void batchRunner.runBatch(batch).catch((e) => app.log.error({ event: "batch.run_failed", batchId: batch.id, error: String(e) }));
    return reply.code(202).send(batch);
  });

  // ---- static ----
  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: "/public/" });
  app.get("/", async (_req, reply) => reply.redirect("/public/console.html"));
  app.get("/dashboard", async (_req, reply) => reply.redirect("/public/dashboard.html"));
  app.get("/demo", async (_req, reply) => reply.redirect("/public/demo.html"));
  app.get("/batch", async (_req, reply) => reply.redirect("/public/batch.html"));

  app.addHook("onClose", async () => {
    await queue.close();
    if (db) await db.close();
  });

  app.decorate("_internals", { store, hitl, queue, pipeline, storage, config, db });
  return app;
}

function buildProviders(config: Config): EcProvider[] {
  return [
    new MockProvider(),
    new LandeedProvider(config.aggregators.landeed),
    new SurepassProvider(config.aggregators.surepass),
    new AutomationProvider(
      config.automation.portalUrl
        ? {
            portalUrl: config.automation.portalUrl,
            username: config.automation.username,
            password: config.automation.password,
            headless: config.automation.headless,
            recordVideoDir: config.automation.recordVideoDir || undefined,
            pdfDownloadDir: config.automation.pdfDownloadDir || undefined,
            userDataDir: config.automation.userDataDir || undefined,
            twoCaptchaApiKey: config.automation.twoCaptchaApiKey || undefined,
            nopechaExtensionPath: config.automation.nopechaExtensionPath || undefined,
            cdpConnectUrl: config.automation.cdpConnectUrl || undefined,
            fastCaptchaApiKey: config.automation.fastCaptchaApiKey || undefined,
          }
        : {},
    ),
  ];
}

function orderProviders(providers: EcProvider[], order: string[]): EcProvider[] {
  const byName = new Map(providers.map((p) => [p.name, p]));
  const ordered = order.map((n) => byName.get(n)).filter((p): p is EcProvider => Boolean(p));
  return ordered.length ? ordered : providers;
}
