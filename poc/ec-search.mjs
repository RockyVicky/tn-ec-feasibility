/**
 * TNREGINET Encumbrance Certificate — feasibility POC
 * ==================================================
 *
 * WHAT THIS IS
 *   A throwaway scaffold that drives the TNREGINET "Search & View EC" flow with
 *   Playwright, up to and including a HUMAN-IN-THE-LOOP pause for the CAPTCHA
 *   (and OTP, if login is used). It is deliberately NOT an unattended scraper
 *   and does NOT attempt to defeat the CAPTCHA.
 *
 * WHAT IT PROVES
 *   - the shape of the flow, the fields, the session/token handling
 *   - exactly where a human step is unavoidable
 *   - how the portal behaves under automation (blocks, timeouts, maintenance)
 *
 * KNOWN LIMITATION (see REPORT.md §4)
 *   TNREGINET refuses / degrades connections from non-India IP addresses and is
 *   frequently in maintenance. During the assessment it was unreachable from the
 *   test environment, so the selectors below are taken from public documentation
 *   and are marked `TODO: verify`. Run this from an India-hosted machine, open
 *   the portal by hand once, and lock the selectors down (the script dumps the
 *   DOM + a screenshot on every failure to make that quick).
 *
 * USAGE
 *   npm install
 *   cp config.sample.json config.json   # then edit with YOUR OWN sample property
 *   npm run ec:search
 */

import { chromium } from "playwright";
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

const cfg = JSON.parse(fs.readFileSync(new URL("./config.json", import.meta.url)));
const ARTIFACTS = path.resolve(cfg.run.artifactsDir ?? "./artifacts");
fs.mkdirSync(ARTIFACTS, { recursive: true });

const ts = () => new Date().toISOString().replace(/[:.]/g, "-");
const log = (msg) => console.log(`[${new Date().toISOString()}] ${msg}`);

async function ask(question) {
  const rl = readline.createInterface({ input, output });
  const answer = await rl.question(question);
  rl.close();
  return answer.trim();
}

async function snap(page, name) {
  const file = path.join(ARTIFACTS, `${ts()}__${name}.png`);
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  log(`  screenshot -> ${file}`);
  return file;
}

async function dumpOnFailure(page, name, err) {
  log(`STEP FAILED: ${name} :: ${err?.message ?? err}`);
  await snap(page, `FAIL__${name}`);
  const html = await page.content().catch(() => "");
  const file = path.join(ARTIFACTS, `${ts()}__FAIL__${name}.html`);
  fs.writeFileSync(file, html);
  log(`  DOM dump   -> ${file}`);
}

/**
 * Try a list of selector candidates in order; return the first that resolves.
 * Keeps the POC alive while the real selectors are being confirmed.
 */
async function firstVisible(page, candidates, { timeout = 8000 } = {}) {
  for (const sel of candidates) {
    try {
      const loc = page.locator(sel).first();
      await loc.waitFor({ state: "visible", timeout: timeout / candidates.length });
      return loc;
    } catch {
      /* try next */
    }
  }
  throw new Error(`none of these selectors matched: ${JSON.stringify(candidates)}`);
}

// ---------------------------------------------------------------------------
// flow steps
// ---------------------------------------------------------------------------

async function openPortal(page) {
  const url = cfg.portal.ecSearchPath || cfg.portal.baseUrl;
  log(`STEP open portal: ${url}`);
  const res = await page.goto(url, { waitUntil: "domcontentloaded", timeout: cfg.run.stepTimeoutMs });
  log(`  HTTP ${res?.status()}`);
  await snap(page, "01-landing");

  const bodyText = (await page.textContent("body").catch(() => "")) || "";
  if (/maintenance|not available|try again later/i.test(bodyText)) {
    throw new Error("portal appears to be in a maintenance window");
  }
}

async function maybeLogin(page) {
  if (cfg.run.stopBeforeLogin || !cfg.account?.username) {
    log("STEP login: skipped (stopBeforeLogin=true or no credentials). " +
        "Anonymous mode can search but the full EC PDF needs a logged-in account.");
    return;
  }
  log("STEP login");
  // TODO: verify — login link + form field ids
  await (await firstVisible(page, ['a:has-text("Login")', "#loginLink", 'a[href*="login"]'])).click();
  await (await firstVisible(page, ["#username", 'input[name="username"]'])).fill(cfg.account.username);
  await (await firstVisible(page, ["#password", 'input[name="password"]'])).fill(cfg.account.password);

  // portal shows its own CAPTCHA on the login form too
  await humanCaptcha(page, "login");

  await (await firstVisible(page, ['button:has-text("Login")', 'input[type="submit"]'])).click();

  // OTP is sometimes required on login / on a new device
  const otpField = await firstVisible(page, ["#otp", 'input[name="otp"]']).catch(() => null);
  if (otpField) {
    const otp = await ask("  >> OTP sent to the registered Indian mobile/email. Enter it here: ");
    await otpField.fill(otp);
    await (await firstVisible(page, ['button:has-text("Verify")', 'button:has-text("Submit")'])).click();
  }
  await snap(page, "02-post-login");
}

async function chooseSearchType(page) {
  log(`STEP choose search type: ${cfg.search.type}`);
  // TODO: verify — the three EC search modes are radio buttons / tabs
  const map = {
    EC_WISE: ['label:has-text("EC Wise")', 'text=Survey / Flat / Ward Block Wise', "#ecWise"],
    DOCUMENT_WISE: ['label:has-text("Document")', "#docWise"],
    PLOT_FLAT_WISE: ['label:has-text("Plot")', 'label:has-text("Flat")', "#plotWise"],
  };
  await (await firstVisible(page, map[cfg.search.type])).click();
  await snap(page, "03-search-type");
}

async function fillSearchForm(page) {
  log("STEP fill EC-wise search form");
  const s = cfg.search;

  // TODO: verify every selector below against the live DOM.
  // These are <select> dropdowns that cascade (zone -> district -> SRO -> village).
  const setSelect = async (candidates, value) => {
    const loc = await firstVisible(page, candidates);
    await loc.selectOption({ label: value }).catch(async () => {
      await loc.selectOption({ value }); // fall back to option value
    });
    await page.waitForTimeout(cfg.run.slowMoMs * 4); // let the cascade AJAX settle
  };

  await setSelect(["#zone", 'select[name="zone"]'], s.zone);
  await setSelect(["#district", 'select[name="district"]'], s.district);
  await setSelect(["#sro", 'select[name="sro"]'], s.sro);

  await (await firstVisible(page, ["#ecStartDate", 'input[name="ecStartDate"]'])).fill(s.ecStartDate);
  await (await firstVisible(page, ["#ecEndDate", 'input[name="ecEndDate"]'])).fill(s.ecEndDate);

  await setSelect(["#village", 'select[name="village"]'], s.village);
  await (await firstVisible(page, ["#surveyNo", 'input[name="surveyNo"]'])).fill(s.surveyNumber);
  await (await firstVisible(page, ["#subdivisionNo", 'input[name="subdivisionNo"]'])).fill(s.subdivisionNumber);

  await snap(page, "04-form-filled");
}

/**
 * HUMAN-IN-THE-LOOP. We show the operator the CAPTCHA and take the answer.
 * We do NOT call any solver service. This is the hard blocker for unattended
 * automation and the reason a licensed aggregator is the recommended path.
 */
async function humanCaptcha(page, where = "search") {
  log(`STEP captcha (${where}) — HUMAN INPUT REQUIRED`);
  // TODO: verify — captcha <img> selector + refresh button
  const img = await firstVisible(page, ["#captchaImg", 'img[src*="captcha" i]', 'img[alt*="captcha" i]'])
    .catch(() => null);
  if (img) {
    const file = path.join(ARTIFACTS, `${ts()}__captcha-${where}.png`);
    await img.screenshot({ path: file }).catch(() => {});
    log(`  captcha image saved -> ${file}  (open it, read the code)`);
  } else {
    log("  could not locate the captcha image element — check the FAIL dump");
    await snap(page, `captcha-${where}-page`);
  }
  const code = await ask("  >> Enter the CAPTCHA text exactly as shown: ");
  await (await firstVisible(page, ["#captcha", 'input[name="captcha"]', 'input[placeholder*="captcha" i]']))
    .fill(code);
}

async function submitAndCollect(page) {
  log("STEP submit search");
  await humanCaptcha(page, "search");
  await (await firstVisible(page, ['button:has-text("Search")', 'input[type="submit"][value*="Search" i]'])).click();

  // Some submissions trigger a second OTP confirmation.
  const otpField = await firstVisible(page, ["#searchOtp", 'input[name="otp"]'], { timeout: 4000 }).catch(() => null);
  if (otpField) {
    const otp = await ask("  >> Search confirmation OTP (Indian mobile/email). Enter it: ");
    await otpField.fill(otp);
    await (await firstVisible(page, ['button:has-text("Verify")', 'button:has-text("Submit")'])).click();
  }

  await page.waitForLoadState("networkidle", { timeout: cfg.run.stepTimeoutMs }).catch(() => {});
  await snap(page, "05-results");

  const bodyText = (await page.textContent("body").catch(() => "")) || "";
  if (/no records? found|no encumbrance/i.test(bodyText)) {
    log("  RESULT: portal reports no records for this property/period.");
    log("  -> a HUMAN must confirm this is a genuine 'clean' EC and not a wrong village/period/survey.");
    return { outcome: "NO_RECORDS" };
  }

  // TODO: verify — result table + the "download PDF" link
  const pdfLink = await firstVisible(page, ['a:has-text("PDF")', 'a:has-text("Download")', 'a[href$=".pdf"]'])
    .catch(() => null);
  if (pdfLink) {
    const [download] = await Promise.all([
      page.waitForEvent("download", { timeout: cfg.run.stepTimeoutMs }),
      pdfLink.click(),
    ]);
    const dest = path.join(ARTIFACTS, `${ts()}__EC.pdf`);
    await download.saveAs(dest);
    log(`  RESULT: EC PDF downloaded -> ${dest} (informational copy; certified EC is a separate Apply flow)`);
    return { outcome: "PDF_DOWNLOADED", file: dest };
  }

  log("  RESULT: results page reached but no download link located — inspect artifacts.");
  return { outcome: "RESULTS_NO_DOWNLOAD" };
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

const STEPS = [
  ["openPortal", openPortal],
  ["maybeLogin", maybeLogin],
  ["chooseSearchType", chooseSearchType],
  ["fillSearchForm", fillSearchForm],
  ["submitAndCollect", submitAndCollect],
];

(async () => {
  log(`TNREGINET EC POC — artifacts dir: ${ARTIFACTS}`);
  const browser = await chromium.launch({
    headless: cfg.run.headless ?? false,
    slowMo: cfg.run.slowMoMs ?? 100,
  });
  const context = await browser.newContext({
    acceptDownloads: true,
    locale: "en-IN",
    timezoneId: "Asia/Kolkata",
    viewport: { width: 1366, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(cfg.run.stepTimeoutMs ?? 45000);

  const summary = [];
  try {
    for (const [name, fn] of STEPS) {
      try {
        const r = await fn(page);
        summary.push({ step: name, ok: true, ...(r ? { result: r } : {}) });
      } catch (err) {
        await dumpOnFailure(page, name, err);
        summary.push({ step: name, ok: false, error: String(err?.message ?? err) });
        break; // stop at first failure — this is a diagnostic POC
      }
    }
  } finally {
    const file = path.join(ARTIFACTS, `${ts()}__run-summary.json`);
    fs.writeFileSync(file, JSON.stringify(summary, null, 2));
    log(`run summary -> ${file}`);
    log("\n==== SUMMARY ====");
    for (const s of summary) log(`  ${s.ok ? "OK  " : "FAIL"}  ${s.step}${s.error ? "  :: " + s.error : ""}`);
    if (!cfg.run.headless) {
      await ask("\nPress Enter to close the browser...");
    }
    await browser.close();
  }
})();
