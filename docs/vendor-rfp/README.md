# Vendor RFP pack

For choosing a licensed Tamil Nadu EC data provider (feasibility recommendation:
aggregator-first). See `REPORT.md` §5 for the vendor comparison.

## Files

| File | What |
|---|---|
| `email-landeed.md` | Draft cover email to Landeed (`ravi@landeed.com`) |
| `email-surepass.md` | Draft cover email to SurePass (`contact@surepass.io`) |
| `rfp.md` | The 25-question RFP — attach to both emails (export to PDF/doc) |
| `attachment-in-scope-districts.md` | District/SRO coverage list — **fill from client D2** |
| `attachment-expected-volume.md` | Volume estimate for pricing — **fill from client D1** |

Also attach `docs/canonical-ec-result.md` (our result schema) so vendors can say
how cleanly they map to it.

## Before sending

1. Fill the sender identity in each email (your name/title/company/phone/email).
2. Fill the two attachment templates from the client's scope-sheet answers.
3. Add 3–5 real sample properties for the sandbox demo.
4. Confirm with the client whether the emails go from you or from them.

**Claude drafts only — a person sends these.**

## After sending

Replies → sandbox credentials → run the sandbox spike (one real EC each, mapped to
the canonical model) → score side by side → recommend one → client legal reviews
terms → sign → wire the real adapter (`service/src/providers/landeed.ts` /
`surepass.ts`) and retire the mock provider.
