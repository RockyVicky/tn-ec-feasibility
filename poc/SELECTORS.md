# TNREGINET selector lock-down

`poc/ec-search.mjs` ships with **candidate** selectors from public documentation.
The portal is geo-restricted, so they were never verified against the live DOM.
This is the checklist to finish that, from an India IP.

## Procedure

1. From an India machine, open <https://tnreginet.gov.in/portal/> in a normal browser.
2. Register a test Citizen account (needs an Indian mobile for OTP). Record the
   credentials in the secrets manager, not here.
3. Go to **E-Services → Encumbrance Certificate → Search & View EC**.
4. Open DevTools. For each field below, copy the real `id` / `name` / stable
   selector and replace the candidate array in `ec-search.mjs`.
5. Run `npm run ec:search` with `config.json` pointing at a known test property.
   On any failure the script writes `artifacts/*FAIL*.html` — read the real markup
   from there.

## Fields to confirm

| Step in `ec-search.mjs` | What to capture |
|---|---|
| `openPortal` | exact URL/path for the EC search view (the `actionVal=` param) |
| `maybeLogin` | login link, `#username`, `#password`, login CAPTCHA `<img>`, submit button, OTP field |
| `chooseSearchType` | the control for EC-wise vs Document-wise vs Plot/Flat/Ward-Block-wise (radios? tabs?) |
| `fillSearchForm` | `select` elements for zone / district / SRO / village; the AJAX that cascades them (and how long it takes); date inputs (format? datepicker widget?); survey no / subdivision inputs |
| `humanCaptcha` | CAPTCHA `<img>` selector, refresh button, the answer `<input>` |
| `submitAndCollect` | Search button; any submit-time OTP field; results table selector; the "download PDF" link; the "no records" message text/element |

## Known unknowns

- Whether "Search & View EC" still works partially without login, or now requires it fully.
- Whether the CAPTCHA is plain image, audio-enabled, or has changed to a widget.
- Rate-limiting thresholds — throttle test runs.
- Certified-EC ("Apply") flow selectors — separate lock-down, includes the payment gateway.
