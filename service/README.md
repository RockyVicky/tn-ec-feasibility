# EC Service

Async internal API the client ERP calls to retrieve Tamil Nadu Encumbrance
Certificates. One contract; the data source (licensed aggregator or supervised
browser automation) is hidden behind it.

Contract: [`../docs/internal-api-contract.md`](../docs/internal-api-contract.md) ·
[`../docs/openapi.yaml`](../docs/openapi.yaml).
Architecture: [`../docs/architecture.md`](../docs/architecture.md).

## Status

Phase-0 skeleton: **runnable and tested** (31 tests). In-memory store + queue,
`mock` provider by default. Aggregator adapters and the automation worker are
stubs pending sandbox access / India infra.

## Run

```bash
npm install          # Node >= 22
npm run dev          # http://localhost:8080  (tsx watch)
npm test             # vitest — 31 tests
npm run typecheck    # tsc --noEmit
```

No `.env` needed for a basic run — defaults are baked in (`BACKEND=memory`,
`PROVIDER_ORDER=mock`, `HITL_MODE=auto`, tenant key `dev-tenant-key`).
See `.env.example` for all knobs.

### Try it

```bash
curl -s -XPOST localhost:8080/v1/ec-requests \
  -H 'authorization: Bearer dev-tenant-key' \
  -H 'content-type: application/json' \
  -H 'idempotency-key: demo-0001' \
  -d '{"searchType":"EC_WISE","certified":false,
       "property":{"zone":"Chennai","district":"North Chennai","sroCode":"CHN-NO-TVL",
                   "village":"Thiruvottiyur","surveyNumber":"123/4","subdivisionNumber":"1"},
       "period":{"from":"2004-01-01","to":"2024-12-31"},
       "callbackUrl":"https://httpbin.org/post","reference":"ERP-DEAL-1"}'
# -> 202 { "requestId": "...", "status": "queued" }

curl -s localhost:8080/v1/ec-requests/<requestId> -H 'authorization: Bearer dev-tenant-key'
# -> canonical EC result (survey numbers containing "4" return a mortgage entry;
#    "7" returns an unverified nil; "9" triggers a nil-review HITL task)
```

- Manual test client (drive it from a browser): <http://localhost:8080/demo>
- Operator console: <http://localhost:8080/> → `/public/console.html`
- Project dashboard: <http://localhost:8080/dashboard>

## Layout

| Path | Role |
|---|---|
| `src/app.ts` | Fastify app factory (routes, auth, wiring) — testable, no `listen` |
| `src/index.ts` | entrypoint |
| `src/config.ts` | env → config; assumptions flagged |
| `src/contract.ts` | request/status types + zod schema |
| `src/canonical.ts` | canonical EC result model, `classifyInstrument`, `deriveOutcome` |
| `src/masterdata/` | TN zone/district/SRO resolution (partial seed) |
| `src/store/` | `RequestStore` — `memory` (default), `postgres` (sketch) |
| `src/queue/` | `Queue` — `memory` (retry+backoff), BullMQ in Phase 1 |
| `src/providers/` | `EcProvider` + `mock`, `landeed`, `surepass`, `automation`, `router` |
| `src/parse/ec-html.ts` | TNREGINET EC results table → canonical entries (+ fixtures) |
| `src/webhook/` | HMAC signing + retrying delivery |
| `src/hitl/` | human-in-the-loop task model + operator routes |
| `src/pipeline.ts` | orchestration: validate → dedupe → route → persist → webhook |
| `public/` | operator console + project dashboard (static) |
| `test/` | vitest suites — see `../docs/test-plan.md` |

## What Phase 1 changes

`memory` store/queue → Postgres + Redis (BullMQ) · `mock` → real Landeed/SurePass
adapters · `automation` stub → Playwright worker pool on India infra · auth → mTLS /
signed JWT · add object storage for PDFs · OCR service for scanned ECs.
