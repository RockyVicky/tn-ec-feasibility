# TNREGINET EC — POC scaffold

A diagnostic Playwright script for the "Search & View EC" flow on tnreginet.gov.in.
It is **not** a product and **not** an unattended scraper — it pauses for a human
at the CAPTCHA (and OTP) because that is the point the assessment is making.

## Run it

```bash
npm install                       # installs Playwright + Chromium
cp config.sample.json config.json # then edit: YOUR OWN sample property details
npm run ec:search
```

A headed Chromium opens and walks the flow. When it reaches the CAPTCHA it saves
the CAPTCHA image to `./artifacts/` and waits for you to type the code in the
terminal. Every step also drops a screenshot; any failure dumps the page HTML.

## Important preconditions

- **Run from India.** The portal refuses / degrades non-India IPs and OTP needs an
  Indian mobile/email. From outside India the very first step (`openPortal`) will
  fail — that failure is itself a documented finding (see `../REPORT.md` §4).
- **Selectors are unverified.** They come from public documentation, not a live
  DOM (the portal was unreachable during the assessment). Each is marked
  `TODO: verify` in `ec-search.mjs`. Open the portal by hand once from India,
  read the real element ids off the `FAIL__*.html` dumps, and update the
  `firstVisible([...])` candidate lists.
- **Anonymous vs logged-in.** With `run.stopBeforeLogin: true` the script searches
  without an account (works for the search, but the full EC PDF now needs login).
  Set it to `false` and fill `account` to exercise the login + OTP path.

## What each step is checking

| Step | Purpose | Expected blocker |
|---|---|---|
| `openPortal` | reachability, maintenance detection | geo-block / maintenance window |
| `maybeLogin` | account + OTP handling | Indian-mobile OTP, per-session CAPTCHA |
| `chooseSearchType` | the 3 EC search modes | — |
| `fillSearchForm` | cascading zone→district→SRO→village dropdowns + AJAX timing | slow cascade, stale options |
| `submitAndCollect` | CAPTCHA, optional submit-OTP, result parse, PDF download | **CAPTCHA (hard blocker)**, ambiguous "no records", human-laid-out PDF |

## Output

Everything lands in `./artifacts/`:
- `*__NN-step.png` — per-step screenshots
- `*__captcha-*.png` — the CAPTCHA image handed to the operator
- `*__FAIL__*.html` / `*__FAIL__*.png` — diagnostics on failure
- `*__EC.pdf` — the downloaded informational EC, if the run completes
- `*__run-summary.json` — machine-readable step outcomes
