# Project charter — TN EC → ERP Integration

**Status:** Initiation
**Owner:** Raakesh R
**Started:** 10 September 2026
**Feasibility basis:** [`REPORT.md`](REPORT.md)

---

## 1. Goal

Give the client's ERP a single, reliable way to retrieve Tamil Nadu Encumbrance
Certificate (EC) data programmatically, replacing manual entry on TNREGINET and
manual PDF handling — with a clearly defined, small human-in-the-loop.

**In scope:** EC search + retrieval (informational and certified), parsing to a
structured result, delivery to the ERP.
**Out of scope:** Patta/Chitta/Adangal/FMB generation, mutation, any automated
legal conclusion about ownership or clear title.

## 2. Approach (from the feasibility assessment)

Hybrid, aggregator-first:

- **Internal EC Service** — one async REST contract the ERP calls (`POST /ec-requests`
  → webhook). Source of the data is swappable behind it.
- **Primary source:** a licensed third-party API (Landeed or SurePass), chosen by RFP.
- **Fallback source:** supervised, India-hosted browser automation of TNREGINET,
  with a human-in-the-loop console for CAPTCHA / OTP / QA. Never bypasses portal
  security controls.
- **Certified ECs** are asynchronous on every path (a Sub-Registrar signs them).

## 3. Two parallel tracks

| Track | Who | Now |
|---|---|---|
| **A — Decisions & commercials** | Client + Raakesh | Scope sheet, aggregator RFPs, legal review. Longest lead time — drives the go/no-go. |
| **B — Technical foundation** | Raakesh | Internal API contract, canonical result model, repo skeleton, from-India automation spike. Buildable now, independent of Track A outcome. |

## 4. Decisions required before Phase 1 build

| # | Decision | Needed from | Blocks |
|---|---|---|---|
| D1 | Monthly EC volume + certified-vs-informational mix | Client | Sizing, vendor pricing |
| D2 | Districts / SROs in scope | Client | Vendor coverage check |
| D3 | Budget for per-EC fees (aggregator opex) | Client | Vendor selection |
| D4 | Risk appetite: aggregator-only, or is supervised own-automation allowed? | Client + legal | Whether Track B fallback is built |
| D5 | Who owns the ops function (HITL console + Indian SIM/mailbox for OTP) | Client | Fallback + certified-EC flow |
| D6 | Data retention + residency rules for stored ECs | Client | Storage design |
| D7 | Tech stack for the EC Service | Raakesh (proposed: Node + TypeScript, Fastify, BullMQ/Redis, Postgres) | Repo skeleton |
| D8 | Any existing IGR Tamil Nadu / TNeGA relationship | Client | Whether to pursue an official MoU/API in parallel |

Log outcomes in [`docs/decision-log.md`](docs/decision-log.md).

## 5. Phases

| Phase | Scope | Exit criteria |
|---|---|---|
| **0 — Initiation** (current) | Charter, internal API contract, canonical model, RFP drafts, repo skeleton | This doc + `docs/` complete; RFPs sent; decisions D1–D8 tracked |
| **1 — EC Service MVP** (~3 wks after go) | API layer + request store + queue + Landeed adapter + canonical model + webhook/polling; ERP integration in staging | ERP submits a request in staging, gets a parsed result + PDF via aggregator sandbox |
| **2 — 2nd provider + caching + dashboards** (~2 wks) | SurePass adapter, provider router + circuit breaker, dedupe cache, observability | Automatic failover demonstrated; cost/turnaround metrics live |
| **3 — Supervised browser fallback** (~3 wks) | Playwright worker on India infra, account pool + keep-alive, HITL console, EC parser + OCR | End-to-end EC via automation with one human CAPTCHA touch; selectors stable 2 wks |
| **4 — Harden** (~2 wks) | Load test, maintenance/block handling, alerting, retention/audit, DR, runbook | Meets agreed SLA at expected volume; on-call runbook signed off |

## 6. Immediate next actions

| # | Action | Owner | Output | State |
|---|---|---|---|---|
| 1 | Send scope sheet (D1–D8) to client | Raakesh | Filled scope sheet | ⏭️ |
| 2 | Send RFP to Landeed + SurePass | Raakesh | Sandbox keys + quotes | 📝 draft ready: [`docs/vendor-rfp/`](docs/vendor-rfp/) |
| 3 | Request legal review of aggregator + direct-automation routes | Client legal | Go/no-go on Track B fallback | ⏭️ |
| 4 | Agree internal API contract with ERP team | Raakesh + ERP team | Signed-off `docs/openapi.yaml` | 🔄 draft in `docs/` |
| 5 | Aggregator sandbox spike (pull 1 EC → canonical model) | Raakesh | Working proof, gap list | ⏭️ after #2 |
| 6 | From-India automation spike (lock POC selectors) | Raakesh | Working fallback scaffold | ⏭️ if D4 allows |
| 7 | EC Service repo skeleton | Raakesh | Runnable stub | 🔄 `src/` |

## 7. Key risks

| Risk | Mitigation |
|---|---|
| Aggregator can't meet SLA / coverage for the client's districts | RFP two vendors; keep the supervised-automation fallback |
| Legal blocks direct automation | Aggregator-only is still viable; only the fallback is lost |
| TNREGINET redesign breaks automation | Fallback only; monitoring + on-call runbook; aggregator absorbs it on the primary path |
| Certified-EC latency (1–10 days) unacceptable to ERP UX | Set expectations early; make the ERP flow async with visible status |
| No vendor is a *government-authorised* channel | Contractual rep/warranty + indemnity; re-check official API route in 6–12 months |
