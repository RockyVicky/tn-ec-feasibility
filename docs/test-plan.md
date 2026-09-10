# Test plan

## Automated (`service/`)

`npm test` — 31 tests, Vitest. Run in CI on every push.

| Suite | Covers |
|---|---|
| `validation.test.ts` | request schema, auth, idempotency-key presence, period order, DOCUMENT_WISE required fields, happy-path 202 |
| `idempotency.test.ts` | same key+body → same id (200); same key+different body → 409 |
| `masterdata.test.ts` | zone/district/SRO resolution by code and name; unknown-level errors; coverage stat |
| `parse.test.ts` | EC HTML → canonical entries (with/without entries); instrument classification; `deriveOutcome` for nil/verified-nil/period-gap |
| `router.test.ts` | first-supporting-provider; failover on retryable error; stop on non-retryable; circuit breaker; no-provider case |
| `webhook.test.ts` | HMAC sign/verify; tamper rejection; stop-after-2xx; retry-to-budget on 5xx |
| `lifecycle.test.ts` | end-to-end via HTTP inject: ENTRIES_FOUND, NIL_UNCONFIRMED (partial), needs_human path, unresolvable SRO, PERIOD_GAP, dedupe cache hit |

**Not yet automated (needs external access):**
- real Landeed / SurePass adapter responses (needs sandbox)
- live TNREGINET automation flow (needs India IP + worker infra)
- Postgres store implementation
- load / concurrency behaviour

## Black-box + UI (`verification/qa/`)

- `run-e2e.mjs` — 30 API checks against hermetically-spawned service instances:
  the 5 manual cases (TC1–TC5) plus negative, security, boundary, webhook-signature
  and performance-smoke checks. Independent HMAC verification via `webhook-sink.mjs`.
- `ui-tests.mjs` — 16 Playwright + Chromium checks: dashboard structure, dark/light
  mode contrast, mobile no-overflow, and a real click-through of the operator
  console clearing a CAPTCHA task.

Latest run: 33 + 30 + 16 = **79 pass, 0 fail**. Full report: `verification/QA-REPORT.md`.

## Manual

See `manual-test-cases.md` (tester-friendly) — the same cases are rendered as
step-cards on the project dashboard (`service/public/dashboard.html`).

## Phase-1 additions

- Contract tests against the ERP's real callback endpoint
- Aggregator adapter contract tests recorded from sandbox (nock/polly-style fixtures)
- Playwright smoke of the automation flow from an India runner (nightly)
- Load test: sustained N req/min, verify concurrency caps + breaker behaviour
- Chaos: provider 500s, portal timeouts, webhook endpoint down → correct failure codes + recovery
