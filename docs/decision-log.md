# Decision log

Lightweight ADRs. Newest first. Status: PROPOSED / ACCEPTED / SUPERSEDED.

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
| D7 | EC Service stack — proposed Node + TypeScript + Fastify + BullMQ/Redis + Postgres | Raakesh to confirm; align with client platform |
| D4 | Whether the browser-automation fallback is built at all | Client + legal (risk appetite) |
| D5 | Ops ownership of the HITL console + Indian SIM/mailbox | Client |
| — | Primary aggregator: Landeed vs SurePass | RFP responses |
| D6 | Data retention window + residency (India) | Client compliance |
