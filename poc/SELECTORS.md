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

- Whether the CAPTCHA is plain image, audio-enabled, or has changed to a widget.
- Rate-limiting thresholds — throttle test runs.
- Certified-EC ("Apply") flow selectors — separate lock-down, includes the payment gateway
  and its own account-lock/session quirks (see below).
- Exact element `id`s for the search form and CAPTCHA — confirmed reachable (below), but
  the raw HTML still hasn't been captured; screenshots + column headers only so far.

## Confirmed live (12 Sep 2026, real account, WARP/VPN off)

Superseding the "known unknowns" this replaces — these are no longer guesses:

- **"Search & View EC" (the free path) loads and is fully fillable with no login at
  all** — zone/district/SRO/village cascading selects, survey/document search modes.
  The header still shows unused Login/Register buttons at this point.
- **A logged-in property/document search does not land directly on an EC entries
  table.** It first resolves to a **document-index result** — one or more matching
  registered documents (document number, SRO, registration district, registration
  village, survey/sub-division numbers, property type) — each with an **"Apply
  Online"** action. Real example captured and now in the codebase as
  `service/src/parse/__fixtures__/ec-document-match.html`, parsed by
  `parseDocumentMatchTable()` in `service/src/parse/ec-html.ts`.
- **"Apply Online" here means requesting the certified/signed copy** (paid,
  Sub-Registrar-signed, days-long) — it is **not** re-registering the property and
  does not resubmit any document. The free instant view is a separate action from
  this same result row; exactly which link/button gives the free view directly
  is still unconfirmed — next thing to check.
- **The registration village name is not reliably guessable from a layout map or
  deed excerpt.** A real search on a real property returned "Kullamanaickenpatti"
  where a geography-based guess from the surrounding documents had said
  "Kullampalayam" — close, but wrong. Only the portal's own index has the
  authoritative village name.
- **A survey number printed on an old deed (e.g. "11/4") often no longer matches
  the current sub-division numbering** the portal indexes against (the same
  property came back as `11/1A1, 11/41A1A1A1, 11/47A1A1A1A, 11/4A1A1, 12/1A1A1A1A,
  12/2G1A1A1A`). A real "Search & View EC" run should search a *range* of related
  sub-divisions, not assume the deed's original number still resolves directly.
- **The homepage's "Presence Less Registration" promo modal reappears on most
  navigations/reloads**, including over the login popup — has to be dismissed
  (its close `×` button) before interacting with whatever is underneath. This is
  a real UX obstacle for a naive automation script, independent of CAPTCHA/OTP.
- **Account lockout is a real, distinct failure mode**, separate from wrong
  password: a login can return "account is locked, try after some time" for a
  password/username that's otherwise correct, likely triggered by an earlier
  interrupted registration (see the JS-crash note above). The login popup has
  three separate recovery links — Unlock Account, Forgot Username, Forgot
  Password — and only the first is relevant to a locked-account error; the
  latter two additionally require the *exact* mobile number on file (not email),
  in the exact format it was stored in.
