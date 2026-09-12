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

## Confirmed live (12 Sep 2026, second session) — full free search cycle, no login

Ran the whole "Search & View EC" flow end to end against the real portal with no
account at all, and captured the real element ids (now wired into
`service/src/providers/automation-worker.ts` as the primary selectors, mock-portal
ids kept as fallbacks so both keep working):

- **No stable URL for this screen.** The homepage link "Search/View EC" (footer,
  under Online Services) drives a client-side AJAX swap — the address bar keeps
  showing the homepage's `actionVal=homePage` throughout. `page.goto()` to a
  guessed URL doesn't work; you have to click the link.
- **Real element ids, all human-readable** (not JSF-mangled as feared):
  `#cmb_Zone`, `#cmb_District`, `#cmb_SroName`, `#cmb_Village` (selects, cascading
  — see below), `#txt_SurveyNo`, `#txt_SubDivisionNo` (plain inputs),
  `#txt_PeriodStartDt` / `#txt_PeriodEndDt` (date inputs), `#btn_AddSurvey`,
  `#btn_SearchDoc`, `#btn_ResetForm`, `#txt_Captcha` (input), `#captcha` (the
  actual `<img>` — matches the automation worker's existing generic
  `img[id*="captcha" i]` fallback with no code change needed there).
- **Zone -> District -> SRO -> Village is a real cascading AJAX chain** (each
  fires a `POST .../loadDistrictCombo?...&comboValue=<parentValue>` and the
  child `<select>` only gets its options ~1s later). A tool that sets a select's
  value without dispatching a real change event won't trigger it — worth knowing
  if a future automation approach isn't Playwright's own `selectOption`.
- **Survey No. and Subdivision No. are separate fields that reject a combined
  value.** Typing the old deed's `11/1A1` into one box fails silently
  ("Only numbers are allowed") — it has to be split into Survey No. `11` +
  Subdivision No. `1A1`. Confirms and sharpens last session's finding about old
  survey numbers not matching current sub-division numbering.
- **The CAPTCHA doesn't exist until you click "Add"** to register the survey
  detail as a row (the form supports adding several rows — the multi-sub-division
  search the earlier note recommended). Screenshotting for CAPTCHA before this
  point captures whatever else is on the page, not a CAPTCHA — this is exactly
  what produced an unreadable/wrong image in the very first live automation
  attempt tonight, since the worker's assumed `/portal/ec-search` URL doesn't
  exist on the real portal and it silently continued on the wrong page.
- **Date fields didn't accept plain typed input** in manual testing (value stuck
  only after using the built-in calendar widget: click the field, click the
  month/year header to jump to a month directly, click the day) — unconfirmed
  whether Playwright's `page.fill()` behaves differently (it often does, being a
  lower-level input mechanism than synthetic keystrokes); the worker tries
  `fill()` first and this needs a live check.
- **A real, successful, login-free cycle completed**: Zone=Salem,
  District=Salem West, SRO=Omalur, Village=Kullamanaickenpatti, Survey 11 / Sub
  1A1, a 10-day date window, real CAPTCHA solved by a human operator, real
  result: "No Documents registered during the Search Period." (a true nil result
  for that narrow window, not a bug) — proving the whole chain works end to end
  when pointed at the real ids.

## Confirmed live (12 Sep 2026, third session) — the automated worker's first real end-to-end run

Wiring in the ids above wasn't enough on its own: the very first automated
(headless Playwright) run against the real portal still produced a garbled
CAPTCHA capture, same as the very first manual one had. Root-caused with a
standalone diagnostic script rather than guessing — two real, distinct bugs,
both now fixed in `automation-worker.ts`:

- **A fresh session renders the whole page in Tamil by default.** Every English
  text/selector match (the "Search/View EC" link included) silently finds
  nothing until the page's own "English" link (`a[href*="changeLanguage('en')"]`)
  is clicked. A manual walkthrough never hits this because a human's browser
  profile already carries the language choice from an earlier session — an
  automated worker starting cold always sees Tamil first.
- **A second promo modal exists** (`id="MobileAppModal"`, distinct from the
  "Presence Less Registration" one already handled) that blocked a click on a
  first-time/cookie-less session. Rather than special-casing another modal by
  name, `dismissPromoModal()` now also force-removes any `.modal.show` /
  `.modal-backdrop` left standing after the close-button attempt — a promo
  overlay is never something the flow needs to interact with, so this should
  hold for whatever the next one turns out to be called.
- Also fixed in the same pass: the login-branch check was `if (#username
  exists)`, but `#username` exists in the real page's DOM from load (hidden
  behind a header toggle) regardless of whether login is actually needed —
  meaning the worker was *always* taking the login branch on the real portal.
  Checking `isVisible()` instead means it only logs in when a portal (like the
  mock) presents the field up front, matching what's actually confirmed: this
  free search needs no account at all.
- Diagnosed via a disposable standalone Playwright script rather than
  instrumenting the real request path first — much faster to iterate (dump
  `navigator.webdriver`, `page.content()`, live link lists) without waiting on
  the queue/HITL round trip each time.
- **Result: a fully autonomous run, end to end**, live: page load -> language
  switch -> both promo modals cleared -> "Search/View EC" clicked -> Zone(5) ->
  District(20030) -> SRO(20387:1) -> Village(16094) cascaded and set -> Survey
  11 / Sub 1A1 added -> a real CAPTCHA rendered in the operator console -> a
  human solved it -> outcome `NIL_UNCONFIRMED` (0 entries — correctly flagged as
  needing operator confirmation, not assumed clean, per this project's core
  design rule). No manual click-through needed anywhere in this run.
