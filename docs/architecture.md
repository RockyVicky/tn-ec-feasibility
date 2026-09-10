# Architecture

Expands `REPORT.md` §8 with the sequence flows and how the Phase-0 skeleton in
`service/` maps to the production design.

## 1. Component map

```
 ERP/CRM ──► EC Service ──► Provider router ──► [ Landeed API | SurePass API | Automation worker ]
              │  │  │                                                    │
              │  │  └─ Request store (Postgres)                          ▼
              │  └──── Queue (Redis / BullMQ)                    HITL console (operators)
              └─────── Webhook deliverer ──► ERP callback              │
                                                                       ▼
                       Object storage (PDFs, screenshots, raw HTML)  ◄─┘
```

| Production component | Phase-0 skeleton (`service/src/`) | Phase-1 swap |
|---|---|---|
| API layer | `app.ts` (Fastify) | + rate limiting, mTLS/JWT, request-size limits |
| Request store | `store/memory.ts` | `store/postgres.ts` (schema already sketched) |
| Queue | `queue/memory.ts` | BullMQ on Redis; N worker processes |
| Provider router | `providers/router.ts` (order + circuit breaker) | config per district/age; metrics |
| Aggregator adapters | `providers/landeed.ts`, `providers/surepass.ts` (stubs) | real endpoints after sandbox onboarding |
| Automation worker | `providers/automation.ts` (HITL handshake only) | Playwright pool on India infra (see `poc/`) |
| HITL | `hitl/*` + `public/console.html` | SSO, operator roles, SLA metrics, audio/image CAPTCHA render |
| Webhooks | `webhook/*` (HMAC + retry) | persistent outbox, dead-letter, replay endpoint |
| Object storage | (none — `documents: []`) | S3-compatible, encrypted, access-logged |
| EC parser | `parse/ec-html.ts` (regex) | DOM parser + OCR service for scanned ECs |
| Master data | `masterdata/*` (partial seed) | full SRO list + refresh job |

## 2. Request lifecycle — informational EC via aggregator

```
ERP                EC Service         Queue        Router        Landeed
 │  POST /ec-requests │                 │            │              │
 │───────────────────►│ validate, store │            │              │
 │  202 requestId     │ enqueue ────────►            │              │
 │◄───────────────────│                 │ job ───────►              │
 │  webhook ec.received                 │            │ supports()?  │
 │◄───────────────────────────────────  │            │ retrieve ────►
 │                                      │            │              │ (EC search)
 │                                      │            │◄──── result ─│
 │                                      │  store completed          │
 │  webhook ec.completed  + signed URL  │            │              │
 │◄───────────────────────────────────  │            │              │
 │  GET /ec-requests/{id}  (fallback)   │            │              │
```

## 3. Request lifecycle — fallback automation with CAPTCHA

```
Queue      Router     Automation worker      HITL store        Operator console
 │ job ─────►         │                       │                 │
 │          retrieve ─►  load form            │                 │
 │                   │  fill fields           │                 │
 │                   │  hit CAPTCHA           │                 │
 │                   │  requestHuman() ──────►│  open task      │
 │   (status: needs_human, webhook ec.needs_human sent)         │
 │                   │                       │◄─ GET /ops/tasks │ (poll 5s)
 │                   │                       │   answer ────────│ operator types code
 │                   │◄──── captcha value ───│                 │
 │                   │  submit search        │                 │
 │                   │  [OTP? → another HITL task]              │
 │                   │  scrape results → parseEcHtml            │
 │          result ──►  store completed/partial                 │
```

## 4. Failure taxonomy → ERP

| `failure.code` | Cause | ERP should |
|---|---|---|
| `validation` | bad request body | fix + resubmit |
| `unresolvable` | zone/district/SRO not recognised | correct location, resubmit |
| `portal_unavailable` | TNREGINET / provider down, geo-block, maintenance | auto-retried; then surface "temporarily unavailable" |
| `provider_error` | aggregator 4xx/5xx after failover | ops alert; manual follow-up |
| `no_records_unconfirmed` | empty result, not human-verified | show "needs review", never "clean" |
| `payment_required` | certified EC, payment step not completed | route to ops for payment authorisation |
| `not_digitised` | period predates ~1975 | raise manual SRO-visit task |
| `captcha_unrecoverable` | operator didn't answer in time | retry in next ops window |
| `timeout` | overall deadline exceeded | resubmit or escalate |

## 5. Security posture

- Per-tenant API keys now; mTLS or signed JWT for Phase 1. Tenant identity recorded on every request's audit trail.
- Webhooks signed HMAC-SHA256 over `timestamp.body`; ERP rejects stale timestamps.
- Property search keys are not personal PII, but parties' names in EC results are — encrypt at rest, access-log reads, retention per `D6`.
- TNREGINET account credentials + the Indian OTP mailbox/SIM live in a secrets manager, never in code or the DB.
- Least privilege: the automation worker's account pool has only citizen-level portal access.

## 6. Observability (Phase 1)

Metrics: request rate, success rate & p50/p95 turnaround by provider, CAPTCHA rate, OTP rate,
human-touch rate, provider failover count, circuit-breaker trips, webhook delivery failures,
cost per EC. Alerts: provider error-rate spike, portal-down detector, DLQ growth, operator queue depth.
