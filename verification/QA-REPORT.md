# QA report — EC Service

**Tester:** Claude (automated + exploratory pass, pro-QA style)
**Date:** 10 September 2026
**Build:** branch `feature/phase-0-1-mvp`, service Phase-0 skeleton
**Environment:** Windows 11, Node 22.13, service run in-memory (mock provider); Playwright + Chromium for UI.
**Verdict:** ✅ **Ready for internal review.** 1 defect found and fixed during testing; 4 observations logged (none blocking).

Status is `AI VERIFIED` — automated + tool-driven checks pass. A human click-through is still required before `SIGNED OFF`.

---

## 1. What was tested

| Layer | Tool | Count | Result |
|---|---|---|---|
| Unit + integration | Vitest (`service/test/`) | 33 | ✅ all pass |
| API black-box (functional, negative, security, boundary, webhook, perf) | custom runner (`verification/qa/run-e2e.mjs`) | 30 | ✅ all pass |
| Web UI (dashboard + operator console) | Playwright + Chromium (`verification/qa/ui-tests.mjs`) | 16 | ✅ all pass |
| **Total** | | **79** | ✅ |

Everything is repeatable — see §6.

## 2. Manual test cases (the 5 on the dashboard) — executed

| ID | Case | Method | Result |
|---|---|---|---|
| TC1 | Submit a property → structured EC result, `ENTRIES_FOUND`, mortgage entry, disclaimer present | API E2E + live curl | ✅ PASS |
| TC2 | Automation hits a CAPTCHA → operator answers → job continues (then honest `portal_unavailable`) | API E2E + Playwright (real click on the console) | ✅ PASS |
| TC3 | Unknown Sub-Registrar office → `failed / unresolvable`, message lists valid offices, not retryable | API E2E | ✅ PASS |
| TC4 | No records + not human-verified → `partial / NIL_UNCONFIRMED`, `encumbrancePresent: null` (never `false`), caveat present | API E2E | ✅ PASS |
| TC5 | Identical informational request within the window → served from cache, fast; certified never deduped | API E2E | ✅ PASS |

## 3. Exploratory / negative / security testing (pro pass)

All passed. Highlights:

- **Auth:** no token → 401; wrong token → 401.
- **Bad input:** missing `Idempotency-Key` → 400; malformed JSON → 400 (not 500); missing `period` → 400; `from > to` → 400 with a clear message; `DOCUMENT_WISE` without `documentNumber` → 400; unknown `searchType` → 400; empty body → 400.
- **Idempotency:** same key + same body → 200 replay, same `requestId`; same key + different body → 409; concurrent duplicate submits → exactly one request created (no race).
- **Injection / abuse:** `1' OR '1'='1` in `surveyNumber` → handled gracefully, no 500, service stays healthy; 20 KB field → rejected, service healthy; `reference` > 120 chars → 400.
- **Boundaries:** `from == to` allowed; pre-1975 period → `PERIOD_GAP` with `encumbrancePresent: null` and the 1975 caveat; survey "999" → `nil_review` HITL task opened and an `ec.needs_human` webhook delivered.
- **Webhooks:** `ec.received` and `ec.completed` both delivered to the callback; **every delivery carried a valid HMAC-SHA256 signature** (verified independently, not with the service's own code).
- **Performance smoke:** 20 sequential requests, all completed. p50 ≈ 4 ms, p95 ≈ 62 ms (mock provider, in-memory — real latency will be dominated by the aggregator/portal, not this service).

## 3a. Recorded walkthrough

A ~32 s screen recording of a live manual-test session driven end to end:
dashboard tour → the **Manual Test Client** (`/demo`) running TC1 (entries found),
TC4 (no records), TC3 (bad SRO), and the invalid-date rejection → the **CAPTCHA
human-in-the-loop flow** (request stalls at "waiting for an operator", the operator
opens the console, types the code, submits, and the job completes).

- `verification/qa/video/manual-test-walkthrough.webm` (plays in any modern browser / VLC)
- `verification/qa/video/manual-test-walkthrough.gif`

Regenerate: `node verification/qa/record-walkthrough.mjs`.

## 4. Web UI testing (Playwright)

**Dashboard** (`/dashboard`): loads with the right title; all 5 sections present; 5 test-case cards each with numbered steps, a "what you should see" box, PASS/FAIL boxes and an `AI VERIFIED` badge; decisions table lists D1–D8; **no card claims `SIGNED OFF`**; no console errors; renders correctly in dark and light mode (contrast checked programmatically); **no horizontal overflow at 375 px mobile width**; technical-detail sections collapsed by default. Screenshots: `verification/qa/screens/dashboard-{light,dark,mobile}.png`.

**Operator console** (`/public/console.html`): loads; shows an empty state when idle; a submitted request surfaces a CAPTCHA card with a text input and a Submit button; **typing an answer and clicking Submit clears the task** (real browser interaction, not simulated); links to the dashboard; no console errors. Screenshots: `console-task.png`, `console-empty.png`.

## 5. Defects & observations

### DEF-1 — Impossible calendar dates were accepted · Severity: Medium · **FIXED**
`period.from` / `period.to` were validated only by shape (`YYYY-MM-DD` regex), so `2024-13-45` and `2023-02-29` passed and a request was queued (202).
**Impact:** garbage dates would reach the provider/automation layer and produce confusing failures far from the cause.
**Fix:** `service/src/contract.ts` — `isoDate` now also verifies the string is a real calendar date (`new Date(...).toISOString()` round-trip). Regression tests added to `service/test/validation.test.ts` (2). Re-verified: now returns 400 `"not a valid calendar date"`.

### OBS-1 — `GET /v1/ec-requests/{id}` is not tenant-scoped · Severity: Low (Phase 0) · Open
The GET authenticates the caller but does not check the request belongs to that tenant. With one tenant configured this is moot; **before multi-tenant go-live, scope reads to the owning tenant.** Tracked for Phase 1.

### OBS-2 — Automation provider always ends `portal_unavailable` outside India · Not a defect
Expected: no worker is deployed and TNREGINET is geo-restricted. The value being tested is the CAPTCHA/OTP human handshake, which works. Becomes a real path in Phase 3 (India infra + `poc/SELECTORS.md`).

### OBS-3 — E2E harness leaked child processes on Windows · **FIXED** (test infra)
The first harness used `spawn(..., { shell: true })`; `child.kill()` then killed the shell, not the `tsx` grandchild, leaving orphan services on the test ports that served stale code (this is what made DEF-1's re-test flap). Fixed: spawn `node --import tsx` directly + a `taskkill /T` fallback. `verification/qa/kill-orphans.ps1` added for manual cleanup.

### OBS-4 — Dashboard PASS boxes are pre-filled · Severity: Low
The dashboard renders each card's result as PASS. That is now backed by this run, but a human should still do their own click-through before marking anything `SIGNED OFF`.

## 6. How to re-run

```bash
# unit + integration
cd service && npm test

# API black-box (spawns its own service instances + webhook receiver)
node verification/qa/run-e2e.mjs        # -> verification/qa/results.json

# web UI (Playwright + Chromium; needs: cd poc && npm install && npx playwright install chromium)
node verification/qa/ui-tests.mjs       # -> verification/qa/ui-results.json + screens/

# if a run is interrupted and leaves servers on test ports:
powershell -ExecutionPolicy Bypass -File verification/qa/kill-orphans.ps1
```

## 7. Not covered (needs external access / later phases)

- Real Landeed / SurePass API behaviour — needs vendor sandbox.
- Live TNREGINET automation (form fill → CAPTCHA → submit → PDF) — needs an India IP + the Phase-3 worker.
- Postgres store + BullMQ queue implementations.
- Sustained load / soak testing, and failover under real provider outages.
- Certified-EC payment flow.
