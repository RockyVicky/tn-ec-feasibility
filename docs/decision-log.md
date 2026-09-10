# Decision log

Lightweight ADRs. Newest first. Status: PROPOSED / ACCEPTED / SUPERSEDED.

---

## ADR-0005 — Provider router with ordered failover + circuit breaker
**Status:** ACCEPTED (2026-09-10) · **By:** Raakesh

Providers are tried in `PROVIDER_ORDER`; first `supports()` && breaker-closed wins.
Retryable `ProviderError` → fall through to next provider; non-retryable → stop.
3 failures opens a provider's breaker for 60s. Lets us run aggregator-primary with
automation-fallback and survive a vendor outage without code changes.

---

## ADR-0004 — Tech stack: Node 22 + TypeScript + Fastify; Postgres + Redis (Phase 1)
**Status:** ACCEPTED pending client D7 (2026-09-10) · **By:** Raakesh

Matches the client's existing Node/React estate and team skills. Fastify for a
small, fast API surface; zod for request validation; BullMQ/Redis for the queue;
Postgres for the request store + audit trail. Phase-0 runs fully in-memory so it
needs no infra to demo. Revisit if the client's platform team mandates otherwise.

---

## ADR-0003 — Async-only internal API (no synchronous EC endpoint)
**Status:** ACCEPTED (2026-09-10) · **By:** Raakesh

Every EC ultimately depends on an external portal with variable latency and uptime.
A synchronous endpoint would export that flakiness to the ERP. The contract is
submit → webhook, with a polling fallback (`GET /ec-requests/{id}`).

---

## ADR-0002 — Hybrid sourcing, aggregator-first
**Status:** ACCEPTED (2026-09-10) · **By:** Raakesh · **Basis:** REPORT.md §5, §9

Primary source = licensed third-party API (Landeed / SurePass), chosen by RFP.
Fallback = supervised India-hosted browser automation of TNREGINET with a
human-in-the-loop console. Rejected: (a) official TNREGINET/API Setu API — does not
exist; (b) automation-only — too fragile, highest legal exposure, needs a human per
search anyway.

Revisit if: no vendor meets coverage/SLA for the client's districts, or legal
blocks direct automation (then aggregator-only).

---

## ADR-0001 — Canonical EC result model
**Status:** ACCEPTED (2026-09-10) · **By:** Raakesh

One normalised result shape (`docs/canonical-ec-result.md` + JSON Schema). Adapters
map into it; the ERP integrates once. `caveats[]` is the formal channel for any
ambiguity the system detects; the service never emits a legal verdict.

---

## Open / pending

| Ref | Decision | Waiting on |
|---|---|---|
| D7 | Stack confirmed by client (ADR-0004 is provisional) | Client platform team |
| D4 | Whether the browser-automation fallback is built at all | Client + legal (risk appetite) |
| D5 | Ops ownership of the HITL console + Indian SIM/mailbox | Client |
| — | Primary aggregator: Landeed vs SurePass | RFP responses |
| D6 | Data retention window + residency (India) | Client compliance |
