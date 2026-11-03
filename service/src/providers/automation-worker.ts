/**
 * Playwright worker that drives a TNREGINET-shaped portal end to end:
 * login (+ CAPTCHA) -> EC search form -> CAPTCHA -> optional OTP -> scrape results.
 *
 * Points at AUTOMATION_PORTAL_URL. Against the real tnreginet.gov.in this needs
 * to run from India with a real account; against verification/mock-portal it runs
 * anywhere and is covered by tests. CAPTCHA/OTP are never solved here — each opens
 * a human-in-the-loop task with a screenshot; a real operator answers.
 */
import { chromium, type Browser } from "playwright";
import { writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { RetrieveContext } from "./types.ts";
import { ProviderError } from "./types.ts";
import type { EcRequest } from "../contract.ts";
import { type EcResult, EC_DISCLAIMER, deriveOutcome } from "../canonical.ts";
import { parseEcHtml } from "../parse/ec-html.ts";
import { solveImageCaptcha } from "./captcha-2captcha.ts";
import { solveImageCaptchaFastCaptcha } from "./captcha-fastcaptcha.ts";
import { registerRun, unregisterRun } from "./automation-registry.ts";

export interface WorkerConfig {
  portalUrl: string;
  username?: string;
  password?: string;
  headless?: boolean;
  /**
   * When set, records the whole run as a .webm video via Playwright's built-in
   * context recorder — useful for proving/inspecting a live run when there's no
   * way to show the (headless) browser's window on screen directly.
   */
  recordVideoDir?: string;
  /**
   * When set, the results page is printed to a PDF and saved here as
   * EC-<district>-<sroCode>-<surveyNumber>-<requestId>.pdf — the real portal's
   * free search has no dedicated "download" link (confirmed live), so this is
   * a browser print-to-PDF of the actual rendered results page rather than a
   * file sourced from the portal itself.
   */
  pdfDownloadDir?: string;
  /**
   * When set, launches from a persistent Chrome profile at this path instead
   * of a fresh throwaway session each run — cookies/login survive across
   * runs, so the operator can log into the portal once in the visible
   * browser and stay signed in for later automated runs.
   */
  userDataDir?: string;
  /**
   * Feature flag, off by default: when set to a real 2Captcha API key, each
   * CAPTCHA is first sent to 2Captcha's solving API; the existing
   * ctx.requestHuman (console HITL) flow is only used as a fallback if
   * 2Captcha errors or times out. Unset (the default) leaves solveCaptcha()
   * byte-for-byte the same as before this flag existed — every CAPTCHA goes
   * straight to the human operator, same as today.
   */
  twoCaptchaApiKey?: string;
  /**
   * Separate, independent feature flag from twoCaptchaApiKey above: path to
   * an UNPACKED NopeCHA browser extension directory. When set, the
   * extension is loaded into the launched Chrome via --load-extension and
   * solveCaptcha() gives it a few seconds to auto-fill the CAPTCHA field
   * itself (its free tier needs no API key) before falling through to
   * 2Captcha/the human operator exactly as it would with this flag unset.
   * Unset (the default): no extension is loaded, nothing changes.
   */
  nopechaExtensionPath?: string;
  /**
   * Separate, independent feature flag from both captcha flags above: a CDP
   * URL (e.g. "http://localhost:9222") of a Chrome YOU start yourself
   * normally (chrome.exe --remote-debugging-port=9222), with NopeCHA
   * already installed via the Chrome Web Store and Developer mode already
   * on in that profile. Needed because Chrome refuses to let an
   * automation-launched browser (--remote-debugging-pipe, which Playwright
   * always adds when it launches Chrome itself) enable Developer mode or
   * load unpacked extensions — confirmed live: the "Installation is not
   * enabled" dialog and a hidden Developer-mode toggle, both coming from
   * Chrome itself, not from anything configurable here. Connecting to an
   * already-running, normally-launched Chrome sidesteps that restriction
   * entirely. When set, this takes over the whole browser-launch step below
   * and none of userDataDir/nopechaExtensionPath/headless apply — they're
   * meaningless for a browser we didn't launch. Unset (the default): this
   * branch never runs, existing launch behavior is unchanged.
   */
  cdpConnectUrl?: string;
  /**
   * Separate, independent feature flag from everything above: a FastCaptcha
   * (fastcaptcha.org) API key. Plain synchronous REST call, no browser
   * extension or special profile involved, so none of the Chrome
   * automation-lockdown issues NopeCHA hit apply here. Tried in
   * solveCaptcha() alongside 2Captcha (whichever key is set runs; if both
   * are set, FastCaptcha is tried first), falling back to the human
   * operator on any failure exactly as today. Unset (the default): no
   * change to existing behavior.
   */
  fastCaptchaApiKey?: string;
}

/**
 * The real portal runs promo modals — "Presence Less Registration" on most
 * navigations, and a separate "MobileAppModal" seen live intercepting a click
 * on a *fresh* session (no existing cookies dismissing it, as a real returning
 * visitor's browser would have) — that sit on top of whatever's underneath and
 * block Playwright from clicking it ("element is not visible" / "intercepts
 * pointer events"). There will likely be more of these over time; rather than
 * naming each one, try known close-button patterns first and, if any `.modal.show`
 * is still up after that, remove it and its backdrop directly — it's a marketing
 * overlay, not something the flow ever needs to interact with. Best-effort,
 * never throws: dismissing a promo popup is not part of the flow worth failing over.
 */
async function dismissPromoModal(page: import("playwright").Page): Promise<void> {
  try {
    await page.keyboard.press("Escape").catch(() => {});
    const candidates = [
      'button[aria-label="Close" i]',
      '[data-dismiss="modal"]',
      ".modal.show .close",
      ".modal .close",
      'button:has-text("×")',
      '[class*="close" i]:visible',
    ];
    for (const sel of candidates) {
      const el = page.locator(sel).first();
      if ((await el.count().catch(() => 0)) && (await el.isVisible().catch(() => false))) {
        await el.click({ timeout: 2000 }).catch(() => {});
        break;
      }
    }
    await page.waitForTimeout(300);
    // Guaranteed fallback: nothing legitimate in this flow is ever inside a
    // Bootstrap-style `.modal.show` overlay, so any still standing is a promo
    // that a close-button click missed — clear it and its backdrop directly.
    // Runs inside the browser page, not Node — this project's tsconfig has no
    // DOM lib (it's a server codebase), so `document` is reached via globalThis.
    await page.evaluate(() => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const doc = (globalThis as any).document;
      doc.querySelectorAll(".modal.show").forEach((m: { remove: () => void }) => m.remove());
      doc.querySelectorAll(".modal-backdrop").forEach((m: { remove: () => void }) => m.remove());
      doc.body.classList.remove("modal-open");
    }).catch(() => {});
  } catch {
    // best-effort only
  }
}

/** For the mock portal only: read the answer it exposes so tests can proceed unattended. */
async function mockAnswer(page: import("playwright").Page): Promise<string | undefined> {
  return page.locator("#captcha-answer").first().textContent({ timeout: 200 }).catch(() => null).then((t) => t?.trim() || undefined);
}

/**
 * Try each candidate selector in order (real-portal id first, mock-portal id as
 * fallback) and act on the first one present. Both portals get a mix of <select>
 * and plain <input> for the "same" field (e.g. village is a cascading dropdown on
 * the real portal but a free-text field on the mock), so this always attempts
 * selectOption-by-label first and falls back to fill — exactly the pattern already
 * proven for zone/district/sro before this helper existed.
 */
async function fillFirst(page: import("playwright").Page, selectors: string[], value: string): Promise<boolean> {
  for (const sel of selectors) {
    if (await page.locator(sel).count().catch(() => 0)) {
      await page.selectOption(sel, { label: value }).catch(() => page.fill(sel, value).catch(() => {}));
      return true;
    }
  }
  return false;
}

/**
 * Confirmed live: a promo modal can reappear well into the flow, not just at
 * page load — one blocked a click for 30+ seconds during diagnosis. The
 * previous version of this helper swallowed a failed click and returned true
 * regardless (it only checked that the element existed, not that the click
 * landed), which meant a modal silently blocking the final "Search" click was
 * invisible: the worker pressed on to scrape whatever page was left, producing
 * a false "no records found" instead of a real result or a real failure. Now
 * it clears any blocking modal and retries once before honestly reporting
 * whether the click actually happened.
 */
async function clickFirst(page: import("playwright").Page, selectors: string[]): Promise<boolean> {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.count().catch(() => 0)) {
      try {
        await el.click({ timeout: 5000 });
        return true;
      } catch {
        await dismissPromoModal(page);
        try {
          await el.click({ timeout: 5000 });
          return true;
        } catch {
          return false;
        }
      }
    }
  }
  return false;
}

/**
 * Confirmed live, the hard way, after a lengthy investigation: the EC Start/End
 * Date fields are bound to a JS calendar widget that page.fill() does not
 * actually update — it can open the picker (side effect of focusing the field)
 * but the real portal reads the fields as still empty afterward, which was
 * silently failing the site's own mandatory-field check on every run and
 * producing a false "no records" result instead of a real search.
 *
 * The widget is the jQuery "datePick" plugin (`.datepick-popup`), not a classic
 * table calendar — confirmed live by inspecting its DOM directly: there is no
 * "Prev"/"Next" text anywhere (those are icon-only links identified only by
 * class name) and no `<td>` day cells (days are `<a>`/`<span>` elements with a
 * `dp<epoch-ms>` class). Navigation instead goes through two `<select
 * class="datepick-month-year">` dropdowns — one lists month names, the other
 * years — whose `value` attributes encode "month/year" using the OTHER
 * dropdown's currently-shown value, so the year must be set first (its options
 * carry the currently-displayed month) and the month re-read and set second
 * (after the year change, its options regenerate for the new year). Verified
 * directly in the live DOM: setting year 2016 then month "March" then clicking
 * the day-15 element set the field to "15-Mar-2016".
 */
// Confirmed live: a flat 400ms wait after clicking the field was enough for
// the FIRST date (start) most of the time, but not reliably for the SECOND
// (end) — clicked right after the first picker's popup was still
// transitioning closed, the wait elapsed before the new popup actually
// opened, and the year/month/day steps silently found nothing there. Poll
// for the popup to actually exist instead of guessing a fixed delay.
async function waitForDatepickPopup(page: import("playwright").Page, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await page.locator(".datepick-popup").count().catch(() => 0)) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

async function pickDate(page: import("playwright").Page, fieldSelector: string, iso: string): Promise<{ ok: boolean; failedAt?: string }> {
  const field = page.locator(fieldSelector).first();
  if (!(await field.count().catch(() => 0))) return { ok: false, failedAt: "field_not_found" };

  await field.click({ timeout: 5000 }).catch(() => {});
  if (!(await waitForDatepickPopup(page))) return { ok: false, failedAt: "popup_never_opened" };

  const target = new Date(`${iso}T00:00:00Z`);
  const targetYear = String(target.getUTCFullYear());
  const targetMonth = target.toLocaleString("en-US", { month: "long", timeZone: "UTC" });
  const targetDay = String(target.getUTCDate());

  // This project's tsconfig has no DOM lib (it's a server codebase), so every
  // element here is reached via `(globalThis as any)`, same convention used
  // elsewhere in this file for in-page evaluate() code. No TypeScript type
  // annotations anywhere inside these callbacks (not on the outer param, not
  // on any inner helper) — annotating them makes esbuild/tsx emit a
  // `__name(...)` helper call around the function; since Playwright sends
  // this function's source text (via toString()) into the browser to run
  // there, that helper — real only on the Node side — throws "__name is not
  // defined" the instant the browser runs it. Confirmed live: this is
  // exactly what broke the first version of this fix.
  const result: { ok: boolean } = await page.evaluate((targetYear) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = (globalThis as any).document;
    const popup = doc.querySelector(".datepick-popup");
    if (!popup) return { ok: false };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sels = Array.from(popup.querySelectorAll(".datepick-month-year")) as any[];
    const yearSel = sels.find((s) => !Number.isNaN(Number(s.options[0] && s.options[0].text)));
    if (!yearSel) return { ok: false };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opt = (Array.from(yearSel.options) as any[]).find((o) => o.text.trim() === targetYear);
    if (!opt) return { ok: false };
    yearSel.value = opt.value;
    yearSel.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }, targetYear);
  if (!result.ok) return { ok: false, failedAt: "year_select" };

  if (!(await waitForDatepickPopup(page))) return { ok: false, failedAt: "popup_closed_after_year" }; // month select's options regenerate for the new year

  const monthResult: { ok: boolean } = await page.evaluate((targetMonth) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const doc = (globalThis as any).document;
    const popup = doc.querySelector(".datepick-popup");
    if (!popup) return { ok: false };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sels = Array.from(popup.querySelectorAll(".datepick-month-year")) as any[];
    const monthSel = sels.find((s) => Number.isNaN(Number(s.options[0] && s.options[0].text)));
    if (!monthSel) return { ok: false };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opt = (Array.from(monthSel.options) as any[]).find((o) => o.text.trim() === targetMonth);
    if (!opt) return { ok: false };
    monthSel.value = opt.value;
    monthSel.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true };
  }, targetMonth);
  if (!monthResult.ok) return { ok: false, failedAt: "month_select" };

  if (!(await waitForDatepickPopup(page))) return { ok: false, failedAt: "popup_closed_after_month" }; // day grid regenerates for the new month

  // Confirmed live: clicking the day via a raw in-page element.click() call
  // reported success every time, yet the end date field still ended up
  // empty downstream. A synthetic .click() always "succeeds" regardless of
  // whether the element is actually clickable to a real user — it skips
  // Playwright's own actionability checks, so it can't tell a genuine click
  // from one that silently landed on nothing (e.g. a leftover overlay from
  // the previous popup still covering it). Use a real Playwright-driven
  // click instead, which waits for and verifies genuine clickability.
  const popupLocator = page.locator(".datepick-popup");
  const dayLocator = popupLocator
    .locator("a:not(.datepick-other-month), span:not(.datepick-other-month)")
    .getByText(targetDay, { exact: true });
  const dayMatchCount = await dayLocator.count().catch(() => 0);
  if (!dayMatchCount) return { ok: false, failedAt: "day_not_found" };
  // Ground-truth diagnostic: every theory so far (synthetic click, element
  // obstruction) was wrong - the real click lands cleanly but no value gets
  // written. Capture exactly what got clicked and what the popup actually
  // contains at that moment instead of guessing again.
  const clickedOuterHtml = await dayLocator.first().evaluate((el) => (el as unknown as { outerHTML: string }).outerHTML).catch(() => "?");
  try {
    await dayLocator.first().click({ timeout: 3000 });
  } catch (e) {
    return { ok: false, failedAt: `day_click_blocked: ${String(e)}`.slice(0, 200) };
  }

  await page.waitForTimeout(150);
  const writtenValue = await field.inputValue().catch(() => "");
  if (!writtenValue) {
    const popupHtmlAfter = await popupLocator.first().evaluate((el) => (el as unknown as { outerHTML: string }).outerHTML.slice(0, 1500)).catch(() => "?");
    return { ok: false, failedAt: `day_click_no_value_written | matches=${dayMatchCount} clicked=${clickedOuterHtml.slice(0, 200)} popupAfter=${popupHtmlAfter}` };
  }

  await page.waitForTimeout(200);
  return { ok: true };
}

/**
 * Playwright's own video recorder proved unreliable for the specific moment
 * right around clicking Search — twice, with two different fix attempts, it
 * cut off before showing the click's effect (confirmed by a direct
 * page.screenshot() showing the same page state the video's last frame did,
 * ruling out a settle-timing problem in our own code). Explicit screenshots
 * have worked every single time tonight (the CAPTCHA image, the post-submit
 * screenshot), so build the video from a rapid burst of those instead of
 * depending on Playwright's internal screencast encoder at all. Runs
 * concurrently with the actual click/submit flow — start it just before
 * clicking, stop it a few seconds after the page settles.
 */
function startBurstCapture(page: import("playwright").Page, dir: string, intervalMs = 300, maxDurationMs = 15000) {
  const state = { stop: false };
  const done = (async () => {
    let i = 0;
    const start = Date.now();
    while (!state.stop && Date.now() - start < maxDurationMs) {
      i += 1;
      // jpeg, not png: the frames get piped into Playwright's own bundled
      // ffmpeg afterward to build a video, and that build only has an mjpeg
      // decoder wired in (no png decoder) — confirmed by testing it directly.
      const shot = await page.screenshot({ type: "jpeg", quality: 85 }).catch(() => null);
      if (shot) await writeFile(path.join(dir, `f-${String(i).padStart(4, "0")}.jpg`), shot).catch(() => {});
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  })();
  return { stop: () => { state.stop = true; }, done };
}

/**
 * The real portal's Zone -> District -> SRO -> Village chain is a genuine
 * network round-trip (confirmed live: each select's options only populate after
 * its own AJAX call returns), not a fixed local delay — a flat sleep guessed too
 * short here on a first live automated run and produced a garbage CAPTCHA capture
 * (the worker pressed on to a page state that was never actually ready). Poll for
 * the child <select> to actually gain options instead of guessing a duration.
 * No-ops immediately for selectors that don't exist (e.g. the mock portal, whose
 * equivalents aren't cascading) or that already have options (nothing to wait for).
 */
async function waitForOptions(page: import("playwright").Page, selector: string, minCount = 2, timeoutMs = 10000): Promise<void> {
  const el = page.locator(selector).first();
  if (!(await el.count().catch(() => 0))) return;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await el.locator("option").count().catch(() => 0)) >= minCount) return;
    await page.waitForTimeout(250);
  }
}

// Confirmed live: `${sel} ~ img` uses CSS's *general* sibling combinator,
// which matches ANY later <img> sharing the input's parent - not
// necessarily the adjacent one. On the real portal that once matched an
// unrelated nav icon ("BANKS/NBFCs") instead of the CAPTCHA, producing a
// wrong-but-successful capture that looked fine to the code but was
// useless to the operator. id/src/alt hints for "captcha" are far more
// specific and go first; the adjacent-only `+ img` combinator is a safer
// fallback than the old broad `~ img`.
function captchaImgCandidates(inputSelectors: string[]): string[] {
  return [
    `img[id*="captcha" i]`,
    `img[src*="captcha" i]`,
    `img[alt*="captcha" i]`,
    ...inputSelectors.map((sel) => `${sel} + img`),
  ];
}
// A real CAPTCHA image is small (a short code on a noisy background); a
// mis-matched nav icon or logo is usually a different shape. Reject
// candidates outside a plausible CAPTCHA size as an extra guard, rather
// than trusting the first element any selector happens to find.
function plausibleCaptchaSize(box: { width: number; height: number } | null): boolean {
  return !!box && box.width >= 40 && box.width <= 300 && box.height >= 15 && box.height <= 120;
}
// Poll briefly rather than checking once: on the real portal the CAPTCHA
// image only exists after the "Add" step's re-render settles, and checking
// too early is exactly what produced a full-page (garbage) capture on the
// first live automated run. Returns undefined (not a full-page fallback) so
// callers can decide what "no CAPTCHA image found" should mean for them.
async function captureCaptchaShot(page: import("playwright").Page, inputSelectors: string[], timeoutMs = 5000): Promise<Buffer | undefined> {
  const imgCandidates = captchaImgCandidates(inputSelectors);
  let shot: Buffer | undefined;
  const deadline = Date.now() + timeoutMs;
  while (!shot && Date.now() < deadline) {
    for (const sel of imgCandidates) {
      const img = page.locator(sel).first();
      if (await img.count().catch(() => 0)) {
        const box = await img.boundingBox().catch(() => null);
        if (!plausibleCaptchaSize(box)) continue;
        shot = await img.screenshot().catch(() => undefined);
        if (shot) break;
      }
    }
    if (!shot) await page.waitForTimeout(250);
  }
  return shot;
}

async function solveCaptcha(
  page: import("playwright").Page,
  ctx: RetrieveContext,
  inputSelectors: string[],
  twoCaptchaApiKey?: string,
  nopechaEnabled?: boolean,
  fastCaptchaApiKey?: string,
): Promise<{ alreadyDone: boolean }> {
  // Only one of these ever exists on a given portal, so joining into one CSS
  // selector resolves to exactly the right single element either way.
  const inputSel = inputSelectors.join(", ");
  const imgCandidates = captchaImgCandidates(inputSelectors);
  let shot = await captureCaptchaShot(page, inputSelectors);

  // Separate, independent path from the 2Captcha one below: if the NopeCHA
  // extension is loaded, give it a few seconds to notice the CAPTCHA and
  // fill the answer in on its own (its content script runs in-page, not
  // through this code) before touching 2Captcha or the human operator at
  // all. If it hasn't filled anything by the deadline, fall through to the
  // exact same flow that already runs today with this flag unset.
  if (nopechaEnabled) {
    const target = page.locator(inputSel).first();
    const deadline = Date.now() + 6000;
    let autoFilled = "";
    while (!autoFilled && Date.now() < deadline) {
      autoFilled = await target.inputValue().catch(() => "");
      if (!autoFilled) await page.waitForTimeout(300);
    }
    if (autoFilled) {
      ctx.log("automation.debug", { step: "captcha_nopecha_autofilled" });
      return { alreadyDone: false };
    }
    ctx.log("automation.debug", { step: "captcha_nopecha_no_autofill_fallback" });
  }
  if (!shot) {
    // Confirmed live: a caller-side "already done?" check can pass and THEN
    // the page transitions to the Acknowledgement page during this
    // function's own ~5s poll for a CAPTCHA image - the full-page fallback
    // below would otherwise capture that success page and present it to the
    // operator as if it were a CAPTCHA to solve. Re-check right here, at the
    // moment of falling back, not just once before this function was called.
    if (await isOnAcknowledgementPage(page)) {
      ctx.log("automation.debug", { step: "already_succeeded_during_solve" });
      return { alreadyDone: true };
    }
    shot = await page.screenshot();
  }

  // The operator's round trip (read the screenshot, type the answer, hit
  // Submit in the console) can take long enough that the page moves on
  // underneath it — confirmed live repeatedly: the field this screenshot was
  // taken against is sometimes just gone by the time the answer comes back,
  // and page.fill()'s default 30s timeout turned that into a dead 30-second
  // wait before failing the whole run. Re-screenshot and ask again instead
  // of burning that timeout — up to 4 extra rounds — so a stale field
  // recovers in a few seconds, not a wasted half-minute. Bumped from 3 to 5
  // total rounds: confirmed live that 3 wasn't always enough slack for a
  // slower operator round-trip through the console, which exhausted all
  // rounds and failed the whole run before ever reaching the download step.
  for (let round = 1; round <= 5; round++) {
    const _mockAnswer = await mockAnswer(page);

    // Feature-flagged path, tried first when a key is configured: if
    // 2Captcha errors or times out, fall through to the exact same
    // ctx.requestHuman call below that already runs when no key is set —
    // nothing about the existing human flow changes.
    let answerValue: string | undefined;

    // Separate, independent feature-flagged path, tried before 2Captcha
    // when its own key is set — a plain synchronous REST call, so no
    // polling loop needed. Falls through to 2Captcha/human on any failure,
    // same pattern as every other flag here.
    if (fastCaptchaApiKey) {
      try {
        answerValue = await solveImageCaptchaFastCaptcha(shot.toString("base64"), { apiKey: fastCaptchaApiKey });
        ctx.log("automation.debug", { step: "captcha_fastcaptcha_solved", round });
      } catch (err) {
        ctx.log("automation.debug", { step: "captcha_fastcaptcha_failed_fallback", round, error: (err as Error).message });
      }
    }

    if (!answerValue && twoCaptchaApiKey) {
      try {
        answerValue = await solveImageCaptcha(shot.toString("base64"), { apiKey: twoCaptchaApiKey });
        ctx.log("automation.debug", { step: "captcha_2captcha_solved", round });
      } catch (err) {
        ctx.log("automation.debug", { step: "captcha_2captcha_failed_fallback_to_human", round, error: (err as Error).message });
      }
    }

    if (!answerValue) {
      const ans = await ctx.requestHuman({
        kind: "captcha",
        // full image, not a truncated fragment — the operator has to actually read this
        context: { note: "portal CAPTCHA", imageBase64: `data:image/png;base64,${shot.toString("base64")}`, _mockAnswer },
      });
      if (ans.kind !== "captcha" || !ans.value) throw new ProviderError("captcha_unrecoverable", "no CAPTCHA answer");
      answerValue = ans.value;
    }

    // A short single check here was prone to false "it's gone" positives
    // during a brief page re-render (e.g. right after the modal-Ok reset),
    // which re-showed the operator the SAME still-valid CAPTCHA as if it
    // were a fresh one. Retry the attachment check a few times before
    // concluding the field actually disappeared.
    const target = page.locator(inputSel).first();
    let stillThere = 0;
    for (let i = 0; i < 3 && !stillThere; i++) {
      stillThere = await target
        .waitFor({ state: "attached", timeout: 2000 })
        .then(() => 1)
        .catch(() => 0);
    }
    if (stillThere) {
      await target.fill(answerValue, { timeout: 3000 }).catch(() => {});
      return { alreadyDone: false };
    }
    // Field's gone — the page moved on while we were waiting. Could be a
    // genuine stale-field timing issue (ask again), or the search already
    // succeeded and moved on to the Acknowledgement page - check before
    // assuming it's the former.
    if (await isOnAcknowledgementPage(page)) {
      ctx.log("automation.debug", { step: "already_succeeded_during_solve", round });
      return { alreadyDone: true };
    }
    if (round === 5) throw new ProviderError("captcha_unrecoverable", "CAPTCHA input field disappeared repeatedly before an answer could be filled in", true);
    let freshShot: Buffer | undefined;
    const freshDeadline = Date.now() + 5000;
    while (!freshShot && Date.now() < freshDeadline) {
      for (const sel of imgCandidates) {
        const img = page.locator(sel).first();
        if (await img.count().catch(() => 0)) {
          freshShot = await img.screenshot().catch(() => undefined);
          if (freshShot) break;
        }
      }
      if (!freshShot) await page.waitForTimeout(250);
    }
    if (!freshShot) {
      if (await isOnAcknowledgementPage(page)) {
        ctx.log("automation.debug", { step: "already_succeeded_during_solve", round });
        return { alreadyDone: true };
      }
      freshShot = await page.screenshot();
    }
    shot = freshShot;
  }
  return { alreadyDone: false };
}

// Confirmed live: `page.getByText(regex).first().isVisible()` was unreliable
// here - .first() picks the first DOM match, not necessarily the visible
// one, so a hidden/duplicate element earlier in the DOM could make this
// report false even while the acknowledgement text was plainly on screen
// (confirmed by a screenshot showing it). A plain substring check against
// the page's own rendered text has no such pitfall.
async function isOnAcknowledgementPage(page: import("playwright").Page): Promise<boolean> {
  const text = await page.locator("body").innerText().catch(() => "");
  return /pdf\s*has\s*been\s*generated|click\s*here\s*to\s*download/i.test(text);
}

export async function runWorker(cfg: WorkerConfig, req: EcRequest, ctx: RetrieveContext): Promise<EcResult> {
  let browser: Browser | undefined;
  let context: import("playwright").BrowserContext | undefined;
  try {
    // channel: "chrome" launches the machine's real installed Chrome (not
    // Playwright's bundled Chromium) — when headless is off, this is a genuine
    // visible Chrome window the operator can watch the run happen in, not a
    // simulation of one. Falls back to bundled Chromium if real Chrome isn't
    // installed (channel option is simply ignored by Playwright in that case
    // only when explicitly caught below).
    // Loading the NopeCHA extension needs Chrome's real extension support,
    // which only works in a headed (or Chrome's "new" headless) window —
    // this project already runs headed by default, so no change needed
    // there. Unset nopechaExtensionPath (the default) adds no args at all.
    const extensionArgs = cfg.nopechaExtensionPath
      ? [`--disable-extensions-except=${cfg.nopechaExtensionPath}`, `--load-extension=${cfg.nopechaExtensionPath}`]
      : [];
    const launchOpts = {
      headless: cfg.headless ?? true,
      channel: "chrome" as const,
      ...(extensionArgs.length ? { args: extensionArgs } : {}),
    };
    const videoOpt = cfg.recordVideoDir ? { recordVideo: { dir: cfg.recordVideoDir, size: { width: 1280, height: 900 } } } : {};
    if (cfg.cdpConnectUrl) {
      // Attach to a Chrome the operator already started themselves — see
      // the WorkerConfig.cdpConnectUrl doc comment for why this exists.
      // Reuses whatever tab/context is already open rather than opening a
      // fresh one, so the operator's own NopeCHA-configured profile is the
      // one actually driven.
      browser = await chromium.connectOverCDP(cfg.cdpConnectUrl);
      context = browser.contexts()[0] ?? (await browser.newContext());
    } else if (cfg.userDataDir) {
      // Persistent profile: no separate Browser object - launchPersistentContext
      // returns the BrowserContext directly, backed by a real on-disk Chrome
      // profile, so cookies/login carry over between runs.
      try {
        context = await chromium.launchPersistentContext(cfg.userDataDir, { ...launchOpts, ...videoOpt });
      } catch {
        ctx.log("automation.debug", { step: "chrome_channel_unavailable", fallback: "bundled chromium (persistent profile)" });
        context = await chromium.launchPersistentContext(cfg.userDataDir, { headless: cfg.headless ?? true, ...videoOpt });
      }
    } else {
      try {
        browser = await chromium.launch(launchOpts);
      } catch {
        ctx.log("automation.debug", { step: "chrome_channel_unavailable", fallback: "bundled chromium" });
        browser = await chromium.launch({ headless: cfg.headless ?? true });
      }
      context = await browser.newContext(videoOpt);
    }
    // Registered so a caller elsewhere in this process (the batch runner)
    // can forcibly cancel this specific run if it's taking too long — see
    // automation-registry.ts for why a hard close, not just "stop waiting
    // on it", is the safe way to do that with a shared browser profile.
    // Skipped in CDP-connect mode: that "browser" is the operator's own
    // real Chrome, which a cancel must never be allowed to close.
    if (!cfg.cdpConnectUrl) registerRun(ctx.requestId, { context, browser });
    const page = context.pages()[0] ?? (await context.newPage());
    const base = cfg.portalUrl.replace(/\/$/, "");

    // Confirmed live: the operator sometimes clicks the real "Click here to
    // download" link themselves in the visible browser, ahead of wherever
    // our own script currently is in its flow (e.g. still waiting on a
    // CAPTCHA elsewhere). Playwright still intercepts that download either
    // way, but unless SOMETHING calls download.saveAs() it just sits in
    // Playwright's own temp artifacts dir and looks, to the operator, like
    // "nothing downloaded". Register a page-wide listener up front - this is
    // the single place that actually saves a download, regardless of
    // whether our script's own click triggered it or the operator's did.
    let downloadCaptured: string | undefined;
    let pdfPath: string | undefined;
    if (cfg.pdfDownloadDir) {
      await mkdir(cfg.pdfDownloadDir, { recursive: true }).catch(() => {});
      const safe = (s: string | null | undefined) => (s ?? "x").replace(/[^a-zA-Z0-9-]+/g, "_").slice(0, 40);
      const prop = req.property;
      const fileName = `EC-${safe(prop.district)}-${safe(prop.sroCode)}-${safe(prop.surveyNumber)}-${ctx.requestId}.pdf`;
      pdfPath = path.join(cfg.pdfDownloadDir, fileName);
      const capturePath = pdfPath;
      // Confirmed from the real link's own HTML: the "Click here" anchor has
      // target="_blank" - clicking it opens a NEW browser tab, and the
      // download happens there, not on the original `page` object. A
      // page-scoped `page.on("download", ...)` only ever fires for downloads
      // on that specific page, so it would silently miss this every time.
      // Register on the BrowserContext instead - it fires for a download on
      // ANY page/tab opened within it, including ones opened after this
      // listener was attached.
      context.on("download", (download) => {
        if (downloadCaptured) return; // already saved this request's PDF
        download
          .saveAs(capturePath)
          .then(() => {
            downloadCaptured = capturePath;
            ctx.log("automation.pdf_saved", { path: capturePath, source: "site_download" });
          })
          .catch((e) => ctx.log("automation.debug", { step: "download_save_failed", error: String(e) }));
      });
    }

    // 1. login (only if actually required)
    // Confirmed live (12 Sep 2026): the real portal's free "Search & View EC"
    // needs no account at all. #username exists in its DOM from page load
    // regardless — it's a hidden header toggle for an optional citizen login —
    // so checking count() alone (as an earlier version of this code did) means
    // ALWAYS taking the login branch on the real portal, which is wrong for this
    // search and was the actual cause of a garbled/wrong CAPTCHA capture tonight.
    // Checking visibility instead means: log in only when a portal (like the
    // mock) actually presents the field up front; never chase down a hidden one.
    await page.goto(`${base}/portal`, { waitUntil: "domcontentloaded" });
    // The real portal's footer links (incl. "Search/View EC") are rendered by
    // client-side JS that finishes shortly after domcontentloaded, not at it —
    // looking for them too early found nothing on a live run. Give it a moment.
    await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    // Confirmed live: a fresh session (no prior language cookie, as any first-time
    // automated run has) renders the whole page in Tamil by default — every
    // English text/selector match below silently finds nothing until this runs.
    // A manual walkthrough doesn't hit this because a human already switched
    // language earlier in the same browser profile.
    const englishLink = page.locator("a[href*=\"changeLanguage('en')\"]");
    if (await englishLink.count().catch(() => 0)) {
      await dismissPromoModal(page);
      await englishLink.first().click({ timeout: 5000 }).catch(() => {});
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
    }
    await dismissPromoModal(page);
    if (await page.locator("#username").first().isVisible().catch(() => false)) {
      await page.fill("#username", cfg.username ?? "worker");
      await page.fill("#password", cfg.password ?? "worker");
      await solveCaptcha(page, ctx, ["#captcha"], cfg.twoCaptchaApiKey, !!cfg.nopechaExtensionPath, cfg.fastCaptchaApiKey);
      await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => {}), page.click("#login-submit")]);
      ctx.log("automation.logged_in");
    }

    // 2. EC search form
    // Confirmed live (12 Sep 2026): the real portal's search screen isn't a
    // separately loadable URL — it's a client-side AJAX swap of the homepage
    // (the address bar keeps showing actionVal=homePage throughout). It's reached
    // only by clicking the actual "Search/View EC" link. The mock portal, by
    // contrast, *is* a real separate page at /portal/ec-search — try the direct
    // URL there, and fall back to the real portal's click-through otherwise.
    const hasSearchForm = async () => (await page.locator("#ec-submit, #btn_SearchDoc").count()) > 0;
    if (!(await hasSearchForm())) {
      // Not getByRole("link", ...): the real portal's footer anchor has no href
      // attribute (onclick-driven nav instead), so it carries no accessible
      // "link" role for Playwright to match on — confirmed the hard way live.
      // Match on visible text instead, which works regardless of markup style.
      const searchLink = page.locator("a", { hasText: /search\s*\/?\s*view\s*ec/i });
      const linkFound = await searchLink.count().catch(() => 0);
      ctx.log("automation.debug", { step: "search_link", found: linkFound > 0, url: page.url() });
      if (linkFound) {
        await dismissPromoModal(page);
        await searchLink.first().click({ timeout: 5000 }).catch((e) => ctx.log("automation.debug", { step: "search_link_click_failed", error: String(e) }));
        // The AJAX swap doesn't always settle within a flat 800ms (confirmed
        // live: one run landed back on index.jsp and the code pressed on
        // anyway, cascade-filling nothing and asking the operator to solve a
        // CAPTCHA on a blank screenshot). Poll briefly instead of a single
        // fixed wait before deciding the click didn't land.
        const settleDeadline = Date.now() + 8000;
        while (!(await hasSearchForm()) && Date.now() < settleDeadline) {
          await page.waitForTimeout(500);
        }
      }
      if (!(await hasSearchForm())) {
        await page.goto(`${base}/portal/ec-search`, { waitUntil: "domcontentloaded" }).catch(() => {});
      }
      await dismissPromoModal(page);
    }
    const searchFormFound = await hasSearchForm();
    ctx.log("automation.debug", { step: "search_form_reached", found: searchFormFound, url: page.url() });
    if (!searchFormFound) {
      throw new ProviderError("portal_unavailable", `never reached the EC search form - landed on ${page.url()} instead`, true);
    }

    const p = req.property;
    // Confirmed live: a "Data Availability Period" modal reset can clear the
    // WHOLE form, not just the survey row - re-adding only the survey number
    // kept failing silently (Add validates that a village is selected) and
    // the modal just kept reappearing. Factored the original one-shot fill
    // sequence into a function so the same full re-fill can be replayed on
    // recovery, not just the survey fields.
    const fillFormAndAddSurvey = async (logPrefix: string) => {
      // Zone -> District -> SRO -> Village cascade via AJAX on the real portal —
      // wait for each child's options to actually arrive rather than guessing a
      // fixed delay (see waitForOptions).
      await fillFirst(page, ["#cmb_Zone", "#zone"], p.zone);
      await waitForOptions(page, "#cmb_District").catch(() => {});
      await fillFirst(page, ["#cmb_District", "#district"], p.district);
      await waitForOptions(page, "#cmb_SroName").catch(() => {});
      await fillFirst(page, ["#cmb_SroName", "#sro"], p.sroCode);
      if (p.village) {
        await waitForOptions(page, "#cmb_Village").catch(() => {});
        await fillFirst(page, ["#cmb_Village", "#village"], p.village);
      }
      ctx.log("automation.debug", {
        step: `${logPrefix}cascade_filled`,
        zone: await page.locator("#cmb_Zone, #zone").first().inputValue().catch(() => "?"),
        district: await page.locator("#cmb_District, #district").first().inputValue().catch(() => "?"),
        sro: await page.locator("#cmb_SroName, #sro").first().inputValue().catch(() => "?"),
        village: await page.locator("#cmb_Village, #village").first().inputValue().catch(() => "?"),
      });
      // Real portal: survey number and subdivision number are separate fields
      // (e.g. "11" and "1A1", not the combined "11/1A1" printed on an old deed —
      // confirmed live) that must be added as a row before the CAPTCHA even renders.
      if (p.surveyNumber) await fillFirst(page, ["#txt_SurveyNo", "#survey"], p.surveyNumber);
      if (p.subdivisionNumber) await fillFirst(page, ["#txt_SubDivisionNo", "#subdiv"], p.subdivisionNumber);
      const addClicked = await clickFirst(page, ["#btn_AddSurvey"]);
      if (addClicked) await page.waitForTimeout(500); // real-portal-only step; no-op on the mock
      ctx.log("automation.debug", { step: `${logPrefix}add_survey`, clicked: addClicked, captchaImgPresent: await page.locator("#captcha, #txt_Captcha ~ img, #ec-captcha ~ img").count().catch(() => 0) });
      // Confirmed live: page.fill() opens the picker widget but never actually
      // sets a value the real portal's own validation reads as non-empty — this
      // was the true, silent cause of every "nothing happens after Search"
      // result tonight, not a CAPTCHA or click problem at all. Drive the actual
      // picker on the real portal; fill() is kept for the mock's plain inputs.
      // Each picker gets one retry on failure now that pickDate() reports
      // exactly why it failed (popup timing race) instead of silently
      // leaving the field empty - confirmed live that the race is
      // intermittent, so a second attempt recovers it rather than failing
      // the whole run over a timing hiccup.
      const pickDateWithRetry = async (sel: string, iso: string, logLabel: string) => {
        for (let attempt = 1; attempt <= 2; attempt++) {
          const r = await pickDate(page, sel, iso);
          if (r.ok) return;
          ctx.log("automation.debug", { step: `${logLabel}_pickdate_failed`, attempt, failedAt: r.failedAt });
        }
      };
      if (await page.locator("#txt_PeriodStartDt").count().catch(() => 0)) {
        await pickDateWithRetry("#txt_PeriodStartDt", req.period.from, "start_date");
      } else {
        await fillFirst(page, ["#from"], isoToDmy(req.period.from));
      }
      if (await page.locator("#txt_PeriodEndDt").count().catch(() => 0)) {
        await pickDateWithRetry("#txt_PeriodEndDt", req.period.to, "end_date");
      } else {
        await fillFirst(page, ["#to"], isoToDmy(req.period.to));
      }
      // Guard against the exact failure mode just fixed above (and any future
      // one like it): if a mandatory field silently failed to populate, the
      // portal will accept the click and show its own form again with nothing
      // happening — which this worker used to mistake for a genuine "no
      // records" result. Fail loudly instead of reporting a false negative.
      if (await page.locator("#txt_PeriodStartDt").count().catch(() => 0)) {
        const startVal = await page.locator("#txt_PeriodStartDt").inputValue().catch(() => "");
        const endVal = await page.locator("#txt_PeriodEndDt").inputValue().catch(() => "");
        ctx.log("automation.debug", { step: `${logPrefix}dates_filled`, startVal, endVal });
        if (!startVal || !endVal) {
          throw new ProviderError("portal_unavailable", `mandatory date field(s) empty before search (start="${startVal}" end="${endVal}")`, true);
        }
      }
    };
    await fillFormAndAddSurvey("");

    // 3. search CAPTCHA — retried with a *fresh* screenshot if the site rejects
    // the answer. Confirmed live: a real-world CAPTCHA here can expire between
    // when the operator sees the screenshot and when the answer actually gets
    // typed and submitted (read it, type it, click Submit in the console, then
    // the worker fills + clicks Search on the real page) — that round trip
    // easily takes 20-40+ seconds, and the site accepted the exact same kind of
    // answer fine when a human filled it live in one go. When that happens the
    // page shows "Please Enter Valid Captcha" and generates a new code for the
    // next try — so retry with that new code rather than treating one stale
    // answer as a hard failure.
    // Bumped from 4 to 8: the "Data Availability Period" info modal consumes
    // an attempt on its own each time it appears, and confirmed live that
    // some SRO/village combinations trigger it - and the survey-row reset
    // that comes with clicking its "Ok" - repeatedly (seen 3-4 times in a
    // row for two different villages so far), not just once. 4 wasn't
    // enough headroom for those; the survey-recovery logic itself works
    // once it gets the attempts to run in.
    const MAX_CAPTCHA_ATTEMPTS = 8;
    let postClickText = "";
    for (let attempt = 1; attempt <= MAX_CAPTCHA_ATTEMPTS; attempt++) {
      // Confirmed live: solveCaptcha() was being called unconditionally at
      // the top of every attempt, even once the search had already
      // succeeded and the page had moved on to the real "Acknowledgement"
      // page ("Your PDF has been generated... Click here to download PDF",
      // its own separate overlay with its own "OK" button - distinct from
      // the "Data Availability Period" modal handled below). With no real
      // CAPTCHA image left to find, it fell back to a full-page screenshot
      // and presented the success page itself to the operator as if it were
      // a CAPTCHA to solve. Check for "already done" before ever asking.
      const alreadyDoneBeforeSolve = await isOnAcknowledgementPage(page);
      const captchaFieldMissing = !(await page.locator("#txt_Captcha, #ec-captcha").first().count().catch(() => 0));
      if (alreadyDoneBeforeSolve || captchaFieldMissing) {
        ctx.log("automation.debug", { step: "already_succeeded_before_solve", attempt, alreadyDoneBeforeSolve, captchaFieldMissing });
        postClickText = await page.locator("body").innerText().catch(() => "");
        break;
      }
      const solveResult = await solveCaptcha(page, ctx, ["#txt_Captcha", "#ec-captcha"], cfg.twoCaptchaApiKey, !!cfg.nopechaExtensionPath, cfg.fastCaptchaApiKey);
      if (solveResult.alreadyDone) {
        postClickText = await page.locator("body").innerText().catch(() => "");
        break;
      }

      // Start the screenshot-burst right as we're about to click — see
      // startBurstCapture's doc comment for why this replaces Playwright's own
      // video recorder for this specific moment. Also listen for any network
      // activity to the portal's own host during this window, to answer the
      // open question directly: does clicking Search fire a request at all?
      const burstDir = cfg.recordVideoDir ? path.join(cfg.recordVideoDir, `click-burst-attempt${attempt}`) : null;
      if (burstDir) await mkdir(burstDir, { recursive: true }).catch(() => {});
      const burst = burstDir ? startBurstCapture(page, burstDir, 300, 40000) : null;

      const portalHost = new URL(base).host;
      const seenRequests: string[] = [];
      const onRequest = (req: import("playwright").Request) => {
        try {
          if (new URL(req.url()).host === portalHost) seenRequests.push(`${req.method()} ${req.url()}`);
        } catch { /* ignore unparseable urls */ }
      };
      page.on("request", onRequest);
      // Also capture the actual response body for the CAPTCHA-check call
      // itself — confirmed live that clicking Search fires exactly this async
      // request, so its response is the direct answer to whether the CAPTCHA
      // was actually accepted, rather than inferring it from page text.
      const seenResponses: { url: string; status: number; body: string }[] = [];
      const onResponse = (res: import("playwright").Response) => {
        if (/actionVal=checkCaptcha/i.test(res.url())) {
          res.text().then((body) => seenResponses.push({ url: res.url(), status: res.status(), body: body.slice(0, 300) })).catch(() => {});
        }
      };
      page.on("response", onResponse);
      // Confirmed live the checkCaptcha validation itself succeeds ("##true")
      // every time, with nothing visible happening afterward regardless of
      // timing (a blur-then-pause fix made no difference) — so it's neither a
      // wrong/expired CAPTCHA nor a race condition. Next candidate: the site's
      // own success-callback throwing a JS error partway through, silently,
      // with no on-page indication. Capture console output and page errors
      // for this same window to check directly instead of guessing again.
      const seenConsoleErrors: string[] = [];
      const onConsole = (msg: import("playwright").ConsoleMessage) => {
        if (msg.type() === "error") seenConsoleErrors.push(msg.text());
      };
      const onPageError = (err: Error) => seenConsoleErrors.push(`pageerror: ${err.message}`);
      page.on("console", onConsole);
      page.on("pageerror", onPageError);

      await page.locator("#txt_Captcha, #ec-captcha").first().blur().catch(() => {});
      await page.waitForTimeout(1200);

      // Three theories ruled out live tonight (wrong/expired CAPTCHA, a race
      // with the async check, a silent JS error) — rather than guess at a
      // fourth, read what the button's own code actually says it does. Pulls
      // the onclick attribute and, if it's a plain function-name call, that
      // function's real source straight out of the page.
      if (cfg.recordVideoDir) {
        // Runs inside the browser page, not Node — this project's tsconfig has
        // no DOM lib, so document/window are reached via globalThis.
        const btnInfo = await page.evaluate(() => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const g = globalThis as any;
          const el = g.document.querySelector("#btn_SearchDoc");
          if (!el) return null;
          const onclick = el.getAttribute("onclick") ?? "";
          const fnNameMatch = onclick.match(/^\s*([a-zA-Z_$][\w$]*)\s*\(/);
          const fnName = fnNameMatch?.[1];
          const fnSource = fnName && typeof g[fnName] === "function" ? g[fnName].toString() : null;
          return { outerHTML: el.outerHTML.slice(0, 500), onclick, fnName: fnName ?? null, fnSource: fnSource?.slice(0, 2000) ?? null };
        }).catch((e) => ({ error: String(e) }));
        ctx.log("automation.debug", { step: "search_button_source", attempt, btnInfo });

        // The button's own source shows three gates before it does anything:
        // checkMandSearchDocYearWise() -> (async) getVillageDetails() ->
        // encryptPlotFlat(). If any is falsy the function just stops — no
        // error, no request, nothing visible, exactly what's been observed
        // all night. Call each directly to see which one is actually failing,
        // rather than continuing to infer it from the outside.
        const gateCheck = await page.evaluate(async () => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const g = globalThis as any;
          const out: Record<string, unknown> = {};
          try {
            out.checkMand = typeof g.checkMandSearchDocYearWise === "function" ? g.checkMandSearchDocYearWise() : "fn-missing";
            // checkMandSearchDocYearWise() only returns one boolean — read
            // every individual condition it checks directly, so we know
            // exactly which one(s) are actually failing instead of guessing.
            const $ = g.jQuery ?? g.$;
            out.mandFields = {
              zone: $("#cmb_Zone").val(),
              district: $("#cmb_District").val(),
              sro: $("#cmb_SroName").val(),
              revenueDistrict: $("#cmb_RevenueDistrict").val(),
              revenueTaluka: $("#cmb_RevenueTaluka").val(),
              periodStart: $("#txt_PeriodStartDt").val(),
              periodEnd: $("#txt_PeriodEndDt").val(),
              convExtent: $("#txt_convExtent").val(),
              surveyRowCount: g.document.getElementById("multiAddSurvey")?.getElementsByTagName("tbody")[0]?.rows.length ?? "elem-missing",
              validateCaptcheForEc: typeof g.validateCaptcheForEc === "function" ? g.validateCaptcheForEc() : "fn-missing",
              validateFromDate: typeof g.validateFromDate === "function" ? g.validateFromDate() : "fn-missing",
              validateToDate: typeof g.validateToDate === "function" ? g.validateToDate() : "fn-missing",
            };
          } catch (e) { out.checkMandError = String(e); }
          try { out.villageDetailsValid = typeof g.getVillageDetails === "function" ? await g.getVillageDetails() : "fn-missing"; } catch (e) { out.villageDetailsError = String(e); }
          try { out.encryptPlotFlat = typeof g.encryptPlotFlat === "function" ? g.encryptPlotFlat() : "fn-missing"; } catch (e) { out.encryptPlotFlatError = String(e); }
          return out;
        }).catch((e) => ({ error: String(e) }));
        ctx.log("automation.debug", { step: "search_gate_check", attempt, gateCheck });
      }

      const searchClicked = await clickFirst(page, ["#btn_SearchDoc", "#ec-submit"]);
      // Confirmed live: a reappeared promo modal silently ate this exact click —
      // clickFirst used to report success regardless, so the worker scraped the
      // unchanged homepage and reported a false "no records found". Now that
      // clickFirst honestly reports failure, treat it as a real failure too,
      // rather than pressing on to scrape whatever's on screen.
      const offAll = () => {
        page.off("request", onRequest);
        page.off("response", onResponse);
        page.off("console", onConsole);
        page.off("pageerror", onPageError);
      };
      if (!searchClicked) {
        burst?.stop();
        offAll();
        throw new ProviderError("portal_unavailable", "could not click Search — the button was blocked (likely a promo modal)", true);
      }
      await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
      await page.waitForTimeout(800);
      // Confirmed live: clicking Search fires checkCaptcha then an async
      // getVillageDetails call, and the portal shows its own "Data
      // Availability Period for Village X ... From <date> To <date>" info
      // modal as a side effect of that call — sitting directly over the
      // Search button.
      // Confirmed by comparing against a reference implementation of this
      // same flow (Indhureka025/tnecproject) that reported succeeding with
      // only ONE CAPTCHA on the same villages where ours needed several:
      // that project never clicks this modal's real "Ok" button at all - it
      // just force-removes any `.modal.show` + `.modal-backdrop` node
      // directly (the same generic technique our own dismissPromoModal
      // already has, unrelated to the riskier ancestor-climbing DOM surgery
      // tried and abandoned earlier). Clicking the real "Ok" button runs the
      // portal's own JS onclick handler, which is almost certainly what was
      // resetting the whole form (clearing the survey row, sometimes the
      // CAPTCHA) for certain SRO/village combinations. Deleting the modal's
      // DOM node directly never touches that handler, so the underlying
      // form - survey row included - is left untouched. Try that safe path
      // first; only fall back to clicking "Ok" if the modal is somehow still
      // there afterward.
      const dataAvailModal = page.getByText("Data Availability Period", { exact: false }).first();
      if (await dataAvailModal.count().catch(() => 0)) {
        ctx.log("automation.debug", { step: "data_availability_modal_seen", attempt });
        // Captured confirmed live: reported "the second CAPTCHA is always the
        // same as the first". Root cause - clicking Ok doesn't always trigger
        // the portal to actually regenerate the CAPTCHA image; sometimes the
        // very same <img> (same bytes) is still sitting there. Asking the
        // operator to re-solve it is pointless and confusing when nothing
        // actually changed. Snapshot the image bytes before the click so we
        // can tell a genuine reset from a no-op dismiss.
        const preOkShot = await captureCaptchaShot(page, ["#txt_Captcha", "#ec-captcha"], 1500);
        await dismissPromoModal(page);
        const stillUp = await page.getByText("Data Availability Period", { exact: false }).first().count().catch(() => 0);
        if (stillUp) {
          ctx.log("automation.debug", { step: "modal_dom_removal_failed_fallback_to_ok", attempt });
          const okBtn = page.getByRole("button", { name: "Ok", exact: true }).first();
          await okBtn.click({ timeout: 3000 }).catch(() => {});
        }
        await page.waitForLoadState("networkidle", { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(800);
        burst?.stop();
        offAll();
        // The modal doesn't always mean the form reset - confirmed live that
        // the search can have already succeeded underneath it (the modal is
        // just an informational overlay on top of the real results page).
        // Treating every modal dismissal as "needs a fresh CAPTCHA" produced
        // a needless, confusing second CAPTCHA request while the operator
        // could already see the real "Click here to download" page in the
        // live browser. Check for that before assuming a reset happened.
        const alreadyOnAck = await isOnAcknowledgementPage(page);
        const captchaFieldGone = !(await page.locator("#txt_Captcha, #ec-captcha").first().count().catch(() => 0));
        ctx.log("automation.debug", { step: "modal_dismiss_check", attempt, alreadyOnAck, captchaFieldGone });
        if (alreadyOnAck || captchaFieldGone) {
          ctx.log("automation.debug", { step: "modal_dismiss_already_succeeded", attempt, alreadyOnAck, captchaFieldGone });
          postClickText = await page.locator("body").innerText().catch(() => "");
          break; // genuinely on the results/acknowledgement page - no fresh CAPTCHA needed
        }
        // Confirmed live: a SECOND "Data Availability Period" modal can
        // appear after the reset-and-resubmit cycle, with the CAPTCHA image
        // unchanged - but that does NOT always mean success. It can instead
        // mean the survey row added earlier got cleared by the reset, Search
        // was resubmitted with no survey row, and the portal just shows the
        // modal again with "Please add atleast one Survey details" once
        // dismissed. Blindly treating "image unchanged" as success produced
        // exactly that: a saved PDF that was just a screenshot of this error
        // page. Check for the actual error text and recover by re-adding the
        // survey row, instead of assuming success.
        const bodyTextNow = await page.locator("body").innerText().catch(() => "");
        const surveyMissing = /add\s*atleast\s*one\s*survey/i.test(bodyTextNow);
        ctx.log("automation.debug", { step: "modal_dismiss_survey_check", attempt, surveyMissing, bodyTextSample: bodyTextNow.slice(0, 300) });
        if (surveyMissing) {
          // Re-filling only the survey number kept failing silently here -
          // confirmed live (3 attempts in a row) that "Add" validates a
          // village is selected, and the WHOLE form (not just the survey
          // row) goes back to blank on this kind of reset. Replay the full
          // original fill sequence, not just the survey fields.
          await fillFormAndAddSurvey("recovery_");
          if (attempt === MAX_CAPTCHA_ATTEMPTS) {
            throw new ProviderError("portal_unavailable", "survey row kept getting lost across modal resets", true);
          }
          continue; // retry the solve-and-click cycle with the full form restored
        }
        const postOkShot = await captureCaptchaShot(page, ["#txt_Captcha", "#ec-captcha"], 2000);
        const captchaImageUnchanged = !!preOkShot && !!postOkShot && preOkShot.equals(postOkShot);
        ctx.log("automation.debug", { step: "modal_dismiss_fallback_check", attempt, captchaImageUnchanged });
        if (captchaImageUnchanged) {
          // No survey-missing error and the CAPTCHA didn't change - best
          // remaining guess is that the search already went through. Logged
          // distinctly from the confirmed-success case above so this can be
          // told apart if it turns out to be wrong again.
          ctx.log("automation.debug", { step: "modal_dismiss_assumed_succeeded_unverified", attempt });
          postClickText = bodyTextNow;
          break;
        }
        if (attempt === MAX_CAPTCHA_ATTEMPTS) {
          throw new ProviderError("captcha_unrecoverable", "stuck behind the data-availability modal after the max retry attempts", true);
        }
        continue; // go solve the fresh CAPTCHA this reset just produced
      }
      postClickText = await page.locator("body").innerText().catch(() => "");
      ctx.log("automation.debug", { step: "post_search_click", attempt, searchClicked, url: page.url(), bodyTextSample: postClickText.slice(0, 400) });
      // Give it a full 30s to actually settle before deciding nothing happened
      // — confirmed live that a 3-4s window wasn't enough to say either way.
      if (burst) { await page.waitForTimeout(30000).catch(() => {}); burst.stop(); await burst.done; }
      offAll();
      ctx.log("automation.debug", { step: "captcha_check_response", attempt, responses: seenResponses });
      ctx.log("automation.debug", {
        step: "post_click_network_activity",
        attempt,
        requestCount: seenRequests.length,
        requests: seenRequests.slice(0, 20),
      });
      ctx.log("automation.debug", { step: "post_click_console_errors", attempt, errors: seenConsoleErrors });

      if (!/please enter valid captcha/i.test(postClickText)) break; // accepted (or some other outcome) — stop retrying
      ctx.log("automation.captcha_rejected", { attempt, maxAttempts: MAX_CAPTCHA_ATTEMPTS });
      if (attempt === MAX_CAPTCHA_ATTEMPTS) {
        throw new ProviderError("captcha_unrecoverable", `CAPTCHA rejected ${MAX_CAPTCHA_ATTEMPTS} times in a row (likely expiring before the answer round-trips back)`, true);
      }
    }
    // Belt-and-braces: a successful click can still land somewhere unexpected
    // (a stale CSRF token, a server-side error page, etc.) — confirmed live
    // that this specific homepage tile text shows up when that happens. Fail
    // honestly instead of scraping a page that was never a real results page.
    if (/Registration of Document/i.test(postClickText) && /Token Availability/i.test(postClickText)) {
      throw new ProviderError("portal_unavailable", "search submitted but landed back on the homepage, not a results page", true);
    }
    // When recording, settle here — right after the click, before any of our
    // own screenshot()/content() calls below compete with the video encoder
    // for the same CDP pipe. Confirmed live: placing this settle wait *after*
    // the scrape step instead (right before returning) consistently produced
    // a recording that cut off at "answer filled in, not yet submitted" even
    // though the click and scrape had both already succeeded — the dwell time
    // existed, just in the wrong place to actually get captured.
    if (cfg.recordVideoDir) await page.waitForTimeout(2500).catch(() => {});

    // 4. optional OTP
    if (await page.locator("#otp-input").count()) {
      ctx.log("automation.otp_prompt");
      const otpHint = await page.locator("#otp-value").first().textContent().catch(() => null);
      const ans = await ctx.requestHuman({ kind: "otp", context: { channel: "sms", hint: "registered mobile", _mockAnswer: otpHint?.trim() } });
      if (ans.kind !== "otp" || !ans.value) throw new ProviderError("timeout", "no OTP from operator");
      await page.fill("#otp-input", ans.value);
      await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => {}), page.click("#otp-submit")]);
    }

    // 5. scrape
    if (await page.locator("#err").count()) {
      throw new ProviderError("provider_error", (await page.locator("#err").first().textContent()) ?? "portal error");
    }
    const now = new Date().toISOString();
    const shot = await page.screenshot();
    // Reuse recordVideoDir as a general "debug artifacts on" signal — saves the
    // actual post-submit page as a real file, since video capture has proven
    // unreliable for this specific fast transition (confirmed live: the click
    // and its result never showed up in the recorded video, even after moving
    // the settle wait). A direct screenshot doesn't have that problem.
    if (cfg.recordVideoDir) {
      await writeFile(path.join(cfg.recordVideoDir, "post-submit-screenshot.png"), shot).catch(() => {});
    }
    let entries: import("../canonical.ts").EcEntry[];
    const extraCaveats: import("../canonical.ts").Caveat[] = [];

    const scanned = page.locator("#scanned-ec");
    if (await scanned.count()) {
      // pre-1987 record served as a scanned image -> OCR, then flag for review
      ctx.log("automation.scanned_ec");
      const src = await scanned.getAttribute("src");
      const imgUrl = src?.startsWith("http") ? src : `${base}${src}`;
      const png = Buffer.from(await (await fetch(imgUrl)).arrayBuffer());
      const { ocrEcImage } = await import("../parse/ocr.ts");
      const ocr = await ocrEcImage(png);
      entries = ocr.entries;
      extraCaveats.push({ code: "OCR_LOW_CONFIDENCE", message: `Result read from a scanned image by OCR (confidence ${ocr.confidence.toFixed(0)}%). Every entry must be verified by an operator.` });
      await ctx.requestHuman({ kind: "ocr_review", context: { rawText: ocr.text.slice(0, 500), fields: entries.map((e) => e.rawInstrumentType) } });
    } else {
      entries = parseEcHtml(await page.content());
    }

    const { outcome, encumbrancePresent, caveats } = deriveOutcome({ entries, periodFrom: req.period.from, nilHumanVerified: false, extraCaveats });

    if (cfg.pdfDownloadDir && pdfPath) {
      // Confirmed live: the real portal has its own "Download" control on the
      // results page that produces the genuine, official, multi-page PDF
      // certificate (not a screenshot of the page) — a real %PDF file served
      // by the portal itself. Prefer that over our own print-to-PDF below.
      // The actual saving now happens in the page-wide "download" listener
      // registered right after page creation (it also catches the operator
      // manually clicking the link ahead of this code reaching it) — this
      // block just needs to trigger the click, then wait for that listener
      // to report success, instead of independently calling saveAs() itself
      // (doing both risked two concurrent writers to the same file).
      // The real target after a successful search is an "Acknowledgement" page
      // ("Your PDF has been generated successfully! Click here to download PDF")
      // whose own link text is just "Click here" - it does NOT contain the
      // words download/print/certificate, so a text-keyword filter alone
      // misses it. Try the acknowledgement-page link first, by scoping to the
      // page that actually shows that generated-PDF message; fall back to the
      // older keyword filter for any other page layout the portal might show.
      if (!downloadCaptured) {
        const onAckPage = await isOnAcknowledgementPage(page);
        const candidates = onAckPage
          ? [page.getByRole("link", { name: /click\s*here/i }).first(), page.locator("a, button, span").filter({ hasText: /click\s*here/i }).first()]
          : [];
        candidates.push(page.locator("a, button").filter({ hasText: /download|print|view\s*certificate/i }).first());

        for (const downloadTrigger of candidates) {
          if (downloadCaptured) break;
          if (!(await downloadTrigger.count().catch(() => 0))) continue;
          await downloadTrigger.click({ timeout: 5000 }).catch((e) => ctx.log("automation.debug", { step: "download_trigger_click_failed", error: String(e) }));
          const waitDeadline = Date.now() + 10000;
          while (!downloadCaptured && Date.now() < waitDeadline) await page.waitForTimeout(250);
        }
      }
      if (!downloadCaptured) {
        await page.pdf({ path: pdfPath, format: "A4", printBackground: true }).catch((e) => {
          ctx.log("automation.debug", { step: "pdf_save_failed", error: String(e) });
          pdfPath = undefined;
        });
        if (pdfPath) ctx.log("automation.pdf_saved", { path: pdfPath, source: "print_to_pdf" });
      }
    }

    return {
      schemaVersion: "1.0",
      search: { type: req.searchType, property: { ...req.property }, period: req.period, performedAt: now },
      outcome,
      encumbrancePresent,
      entryCount: entries.length,
      entries,
      documents: [],
      caveats,
      provenance: {
        source: "automation",
        sourceReference: null,
        certified: false,
        retrievedAt: now,
        operatorId: "operator",
        // A reference, not an embedded image — matches every other provider's
        // convention (see automation.ts, mock.ts). The previous version here
        // truncated a base64 PNG to 24 characters, producing a value that
        // wasn't a real reference *or* a usable image — same class of bug as
        // the CAPTCHA-image truncation fixed the night before.
        rawArtifactRefs: [
          `automation://post-submit-screenshot/${ctx.requestId}.png`,
          ...(pdfPath ? [`file://${pdfPath.replace(/\\/g, "/")}`] : []),
        ],
      },
      disclaimer: EC_DISCLAIMER,
    };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError("portal_unavailable", `automation worker failed: ${(err as Error).message}`, true);
  } finally {
    unregisterRun(ctx.requestId);
    // In CDP-connect mode, `browser` is the operator's own real Chrome
    // (attached via connectOverCDP, not launched by us) — closing it would
    // close their actual browser window at the end of every run, not just
    // on cancel. Only close what this run actually launched.
    if (!cfg.cdpConnectUrl) {
      // context.close() must happen before browser.close() — it's what
      // flushes and finalizes the recorded .webm file, if recording was enabled.
      await context?.close().catch(() => {});
      await browser?.close().catch(() => {});
    }
  }
}

function isoToDmy(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}
