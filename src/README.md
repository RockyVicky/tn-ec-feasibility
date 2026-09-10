# EC Service — skeleton (Phase 0)

Runnable stub of the internal API from [`../docs/internal-api-contract.md`](../docs/internal-api-contract.md).
In-memory store, mock provider, no auth, no queue, no webhook signing. Its job is to
let the ERP team code against the contract now.

## Run

```bash
cd src
npm install
npm run dev        # Fastify on :8080
```

```bash
curl -XPOST localhost:8080/v1/ec-requests \
  -H 'content-type: application/json' \
  -H 'idempotency-key: 11111111-1111-1111-1111-111111111111' \
  -d '{"searchType":"EC_WISE","certified":false,
       "property":{"zone":"CHENNAI","district":"CENTRAL CHENNAI","sroCode":"TVL",
                   "village":"THIRUVOTTIYUR","surveyNumber":"123/4","subdivisionNumber":"1"},
       "period":{"from":"2004-01-01","to":"2024-12-31"},
       "callbackUrl":"https://example.internal/hooks/ec","reference":"ERP-DEAL-1"}'
# -> 202 { requestId, status: "queued", ... }

curl localhost:8080/v1/ec-requests/<requestId>
# -> canonical result after ~instant (mock)
```

## Layout

| File | Role |
|---|---|
| `server.ts` | Fastify app; `POST /v1/ec-requests`, `GET /v1/ec-requests/{id}`, `/healthz` |
| `contract.ts` | Request/status types + canonical EC result types (zod for the request) |
| `providers/types.ts` | `EcProvider` interface + human-in-the-loop task/response types |
| `providers/mock.ts` | Canned canonical result for Phase 0 |

## Phase 1 replaces

- in-memory `Map` → Postgres (request store) + object storage (docs/artifacts)
- `setImmediate` → BullMQ/Redis queue + worker
- `autoAnswer` → real human-in-the-loop console
- `would_send_webhook` log → signed webhook delivery with retry
- `MockProvider` → `providers/landeed.ts`, `providers/surepass.ts`, `providers/automation.ts` + a provider router
- no auth → per-tenant API key + HMAC signature / mTLS
