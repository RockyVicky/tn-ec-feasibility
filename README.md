# Tamil Nadu Encumbrance Certificate (EC) → ERP Integration

Give a client ERP a reliable way to retrieve Tamil Nadu EC data programmatically
instead of staff keying details into the TNREGINET portal and handling PDFs by hand.

**Status:** Phase 0 (initiation) complete. Feasibility done; service skeleton built,
tested (31 tests), and demo-verified. Blocked on 8 client decisions before Phase 1.

## Start here

| Doc | What |
|---|---|
| [`REPORT.md`](REPORT.md) | Feasibility assessment — the "can we / should we" answer |
| [`PROJECT.md`](PROJECT.md) | Project charter — approach, phases, decisions, next actions |
| [`service/`](service/) | **EC Service** — runnable, tested skeleton of the whole design |
| [`service/public/dashboard.html`](service/public/dashboard.html) | Project dashboard with manual test step-cards (open the service and visit `/dashboard`) |

## Docs

| Doc | What |
|---|---|
| [`docs/internal-api-contract.md`](docs/internal-api-contract.md) · [`docs/openapi.yaml`](docs/openapi.yaml) | The one contract the ERP integrates against |
| [`docs/canonical-ec-result.md`](docs/canonical-ec-result.md) · [schema](docs/schemas/ec-result.schema.json) | Normalised EC result model |
| [`docs/architecture.md`](docs/architecture.md) | Component map + sequence flows + failure taxonomy |
| [`docs/assumptions.md`](docs/assumptions.md) | What Phase 0 assumed pending client answers |
| [`docs/decision-log.md`](docs/decision-log.md) | ADRs + open decisions |
| [`docs/runbook.md`](docs/runbook.md) | On-call procedures |
| [`docs/test-plan.md`](docs/test-plan.md) · [`docs/manual-test-cases.md`](docs/manual-test-cases.md) | Test coverage + tester-friendly cases |
| [`docs/client-scope-sheet.md`](docs/client-scope-sheet.md) | D1–D8 questionnaire to send the client |
| [`docs/vendor-rfp/`](docs/vendor-rfp/) | RFP + cover email for Landeed / SurePass (drafts) |
| [`verification/QA-REPORT.md`](verification/QA-REPORT.md) | Full QA pass — 79 checks (unit + API black-box + Playwright UI), 1 defect found & fixed |
| [`verification/qa/`](verification/qa/) | The runnable QA suites + screenshots |
| [`verification/AI-VERIFICATION.md`](verification/AI-VERIFICATION.md) | First-pass verification record |
| [`poc/`](poc/) · [`poc/SELECTORS.md`](poc/SELECTORS.md) | Playwright scaffold for the TNREGINET flow + selector lock-down checklist |
| [`research/`](research/) | Research log + sources |

## Approach (one line)

Hybrid, aggregator-first: an internal async **EC Service** (REST + queue + webhook)
the ERP calls → licensed third-party API (Landeed/SurePass) as primary source →
supervised India-hosted browser automation as fallback → operator console for
CAPTCHA / OTP / QA. Certified ECs are async on every path.

## Scope boundary

EC ≠ Patta ≠ legal ownership. The system surfaces registered instruments + the exact
search parameters and period. It does **not** generate Patta and does **not**
auto-conclude ownership or that land is unencumbered/unoccupied.

## Run the skeleton

```bash
cd service && npm install && npm test && npm run dev
```

Then `curl` per [`service/README.md`](service/README.md), or open
<http://localhost:8080/dashboard>.
