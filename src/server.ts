/**
 * EC Service — Phase 0 skeleton API.
 *
 * Implements the shape of docs/internal-api-contract.md with an in-memory store and
 * a mock provider. NOT production: no real queue, no persistence, no auth, no
 * webhook signing. Enough for the ERP team to integrate against the contract.
 *
 *   npm install && npm run dev
 *   curl -XPOST localhost:8080/v1/ec-requests -H 'content-type: application/json' \
 *     -H 'idempotency-key: 11111111-1111-1111-1111-111111111111' \
 *     -d '{"searchType":"EC_WISE","certified":false,
 *          "property":{"zone":"CHENNAI","district":"CENTRAL CHENNAI","sroCode":"TVL",
 *                      "village":"THIRUVOTTIYUR","surveyNumber":"123/4","subdivisionNumber":"1"},
 *          "period":{"from":"2004-01-01","to":"2024-12-31"},
 *          "callbackUrl":"https://example.internal/hooks/ec","reference":"ERP-DEAL-1"}'
 */
import Fastify from "fastify";
import { randomUUID } from "node:crypto";
import { EcRequest, type FailureCode, type RequestStatus } from "./contract.ts";
import { MockProvider } from "./providers/mock.ts";
import { ProviderError, type HumanResponse, type HumanTask } from "./providers/types.ts";

const app = Fastify({ logger: true });
const provider = new MockProvider();

/** in-memory stores — swap for Postgres + BullMQ in Phase 1 */
const requests = new Map<string, RequestStatus>();
const idempotency = new Map<string, string>(); // key -> requestId

function autoAnswer(task: HumanTask): HumanResponse {
  // Phase 0: no operator console — auto-resolve so the demo flows.
  switch (task.kind) {
    case "captcha": return { kind: "captcha", value: "DEMO" };
    case "otp": return { kind: "otp", value: "000000" };
    case "nil_review": return { kind: "nil_review", confirmedNil: false, note: "phase-0 auto" };
    case "ocr_review": return { kind: "ocr_review", corrections: {}, note: "phase-0 auto" };
  }
}

async function process(requestId: string): Promise<void> {
  const rec = requests.get(requestId);
  if (!rec) return;
  rec.status = "in_progress";
  rec.source = provider.name;
  try {
    const result = await provider.retrieve(
      // stored payload lives on the record in this skeleton
      (rec as RequestStatus & { _req: EcRequest })._req,
      {
        requestId,
        requestHuman: async (t) => autoAnswer(t),
        log: (event, data) => app.log.info({ event, requestId, ...data }),
      },
    );
    rec.result = result;
    rec.completedAt = new Date().toISOString();
    if (result.outcome === "NIL_UNCONFIRMED" || result.caveats.some((c) => c.code === "OCR_LOW_CONFIDENCE")) {
      rec.status = "partial";
    } else {
      rec.status = "completed";
    }
  } catch (err) {
    rec.status = "failed";
    rec.completedAt = new Date().toISOString();
    const code: FailureCode =
      err instanceof ProviderError
        ? err.code === "unsupported"
          ? "unresolvable"
          : err.code
        : "provider_error";
    rec.failure = {
      code,
      message: err instanceof Error ? err.message : String(err),
      retryable: err instanceof ProviderError ? err.retryable : false,
      operatorNote: null,
    };
  }
  // Phase 1: emit signed webhook to rec-> callbackUrl here.
  app.log.info({ event: "would_send_webhook", requestId, status: rec.status });
}

app.post("/v1/ec-requests", async (req, reply) => {
  const idem = req.headers["idempotency-key"];
  if (typeof idem !== "string" || idem.length < 8) {
    return reply.code(400).send({ error: "validation", details: [{ field: "Idempotency-Key", message: "required" }] });
  }
  const parsed = EcRequest.safeParse(req.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "validation", details: parsed.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })) });
  }
  if (parsed.data.period.from > parsed.data.period.to) {
    return reply.code(400).send({ error: "validation", details: [{ field: "period", message: "from must be <= to" }] });
  }

  const existing = idempotency.get(idem);
  if (existing) return reply.code(200).send(requests.get(existing));

  const requestId = randomUUID();
  const rec: RequestStatus & { _req: EcRequest } = {
    requestId,
    reference: parsed.data.reference,
    status: "queued",
    certified: parsed.data.certified,
    source: null,
    submittedAt: new Date().toISOString(),
    completedAt: null,
    estimate: parsed.data.certified ? { type: "days", value: 5 } : { type: "minutes", value: 5 },
    result: null,
    documents: [],
    failure: null,
    _req: parsed.data,
  };
  requests.set(requestId, rec);
  idempotency.set(idem, requestId);

  setImmediate(() => void process(requestId)); // Phase 1: enqueue instead

  return reply.code(202).send(stripInternal(rec));
});

app.get("/v1/ec-requests/:id", async (req, reply) => {
  const rec = requests.get((req.params as { id: string }).id);
  if (!rec) return reply.code(404).send({ error: "not_found" });
  return reply.send(stripInternal(rec));
});

app.get("/healthz", async () => ({ ok: true }));

function stripInternal(rec: RequestStatus & { _req?: EcRequest }): RequestStatus {
  const { _req, ...rest } = rec;
  return rest;
}

const port = Number(process.env.PORT ?? 8080);
app.listen({ port, host: "0.0.0.0" }).catch((e) => {
  app.log.error(e);
  process.exit(1);
});
