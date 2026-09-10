# Tamil Nadu Encumbrance Certificate (EC) → ERP Integration

Give a client ERP a reliable way to retrieve Tamil Nadu EC data programmatically
instead of staff keying details into TNREGINET and handling PDFs by hand.

**Status:** Initiation (Phase 0). Feasibility done; project kicked off.

## Start here

| Doc | What |
|---|---|
| [`REPORT.md`](REPORT.md) | Feasibility assessment — the "can we / should we" answer |
| [`PROJECT.md`](PROJECT.md) | Project charter — approach, phases, decisions needed, next actions |
| [`docs/internal-api-contract.md`](docs/internal-api-contract.md) | The one contract the ERP integrates against |
| [`docs/canonical-ec-result.md`](docs/canonical-ec-result.md) | Normalised EC result model (+ [JSON Schema](docs/schemas/ec-result.schema.json)) |
| [`docs/openapi.yaml`](docs/openapi.yaml) | Machine-readable API spec |
| [`docs/decision-log.md`](docs/decision-log.md) | ADRs + open decisions |
| [`docs/vendor-rfp/`](docs/vendor-rfp/) | RFP + cover email for Landeed / SurePass (drafts) |
| [`src/`](src/) | EC Service skeleton — runnable stub of the contract |
| [`poc/`](poc/) | Playwright scaffold for the TNREGINET flow (diagnostic, human-in-the-loop) |
| [`research/`](research/) | Research log + sources |

## Approach (one line)

Hybrid, aggregator-first: an internal async **EC Service** (REST + queue + webhook)
the ERP calls → licensed third-party API (Landeed/SurePass) as primary source →
supervised India-hosted browser automation as fallback → small human-in-the-loop
console for CAPTCHA / OTP / QA. Certified ECs are async on every path.

## Scope boundary

EC ≠ Patta ≠ legal ownership. The system surfaces registered instruments + the exact
search parameters and period. It does **not** generate Patta and does **not**
auto-conclude ownership or that land is unencumbered/unoccupied.

## Immediate next actions

See [`PROJECT.md` §6](PROJECT.md). Short version: send the client scope sheet (D1–D8),
send the vendor RFPs, request legal review, and get the ERP team to sign off
`docs/openapi.yaml`.
