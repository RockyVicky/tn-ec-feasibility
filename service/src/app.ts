import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import fastifyStatic from "@fastify/static";

import { loadConfig, type Config } from "./config.ts";
import { EcRequestSchema, type RequestStatus } from "./contract.ts";
import { MemoryRequestStore } from "./store/memory.ts";
import type { RequestStore, StoredRequest } from "./store/types.ts";
import { MemoryQueue } from "./queue/memory.ts";
import type { Queue } from "./queue/types.ts";
import { MemoryHitlStore } from "./hitl/store.ts";
import type { HitlStore } from "./hitl/types.ts";
import { registerHitlRoutes } from "./hitl/routes.ts";
import { ProviderRouter } from "./providers/router.ts";
import type { EcProvider } from "./providers/types.ts";
import { MockProvider } from "./providers/mock.ts";
import { LandeedProvider } from "./providers/landeed.ts";
import { SurepassProvider } from "./providers/surepass.ts";
import { AutomationProvider } from "./providers/automation.ts";
import { HttpWebhookDeliverer, type WebhookDeliverer } from "./webhook/deliver.ts";
import { createPipeline } from "./pipeline.ts";
import { paramHash } from "./util/hash.ts";
import { coverage } from "./masterdata/index.ts";
import type { Pipeline } from "./pipeline.ts";

declare module "fastify" {
  interface FastifyInstance {
    _internals: {
      store: RequestStore;
      hitl: HitlStore;
      queue: Queue<{ requestId: string }>;
      pipeline: Pipeline;
      config: Config;
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
}

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");

export async function buildApp(opts: BuildOptions = {}): Promise<FastifyInstance> {
  const config: Config = { ...loadConfig(), ...opts.config };
  const app = Fastify({ logger: { level: config.logLevel } });
  const log = (event: string, data?: Record<string, unknown>) => app.log.info({ event, ...data });

  const store = opts.store ?? new MemoryRequestStore();
  const hitl = opts.hitl ?? new MemoryHitlStore(config.hitlMode);
  const webhooks =
    opts.webhooks ??
    new HttpWebhookDeliverer(config.webhookSigningSecret, config.webhookRetry, (e, d) => app.log.info({ event: e, ...d }));

  const providers =
    opts.providers ??
    buildProviders(config);
  const router = new ProviderRouter(orderProviders(providers, config.providerOrder));
  const pipeline = createPipeline({ store, router, webhooks, hitl, config, log });

  const queue: Queue<{ requestId: string }> =
    opts.queue ?? new MemoryQueue<{ requestId: string }>({ maxAttempts: 5, baseDelayMs: 1000, onDlq: (job, err) => app.log.error({ event: "dlq", job: job.id, err: String(err) }) });
  queue.process(async (job) => pipeline.run(job.payload.requestId));

  // ---- auth ----
  app.addHook("onRequest", async (req, reply) => {
    if (req.url === "/healthz" || req.url.startsWith("/ops") || req.url.startsWith("/public") || req.url === "/" || req.url.startsWith("/dashboard") || req.url.startsWith("/demo")) return;
    const key = (req.headers.authorization ?? "").replace(/^Bearer\s+/i, "");
    const tenant = Object.entries(config.tenantKeys).find(([, v]) => v === key)?.[0];
    if (!tenant) return reply.code(401).send({ error: "unauthorized" });
    (req as { tenant?: string }).tenant = tenant;
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
      if (existing.paramHash !== paramHash(parsed.data)) {
        return reply.code(409).send({ error: "idempotency_conflict" });
      }
      return reply.code(200).send(publicStatus(existing));
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
      audit: [{ at: now, event: "received", detail: { tenant: (req as { tenant?: string }).tenant } }],
    };
    await store.create(rec);
    void webhooks.send("ec.received", status, parsed.data.callbackUrl);
    await queue.add({ requestId });

    return reply.code(202).send(status);
  });

  app.get("/v1/ec-requests/:id", async (req, reply) => {
    const rec = await store.get((req.params as { id: string }).id);
    if (!rec) return reply.code(404).send({ error: "not_found" });
    return publicStatus(rec);
  });

  // ---- ops / HITL ----
  registerHitlRoutes(app, hitl);
  app.get("/ops/coverage", async () => coverage());

  // ---- health + static ----
  app.get("/healthz", async () => ({ ok: true, providers: providers.map((p) => p.name), backend: config.backend }));
  await app.register(fastifyStatic, { root: PUBLIC_DIR, prefix: "/public/" });
  app.get("/", async (_req, reply) => reply.redirect("/public/console.html"));
  app.get("/dashboard", async (_req, reply) => reply.redirect("/public/dashboard.html"));
  app.get("/demo", async (_req, reply) => reply.redirect("/public/demo.html"));

  app.decorate("_internals", { store, hitl, queue, pipeline, config });
  return app;
}

function publicStatus(rec: StoredRequest): RequestStatus {
  return rec.status;
}

function buildProviders(config: Config): EcProvider[] {
  return [
    new MockProvider(),
    new LandeedProvider(config.aggregators.landeed),
    new SurepassProvider(config.aggregators.surepass),
    new AutomationProvider(),
  ];
}

function orderProviders(providers: EcProvider[], order: string[]): EcProvider[] {
  const byName = new Map(providers.map((p) => [p.name, p]));
  const ordered = order.map((n) => byName.get(n)).filter((p): p is EcProvider => Boolean(p));
  return ordered.length ? ordered : providers;
}
