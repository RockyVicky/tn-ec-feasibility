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
import type { RetrieveContext } from "./types.ts";
import { ProviderError } from "./types.ts";
import type { EcRequest } from "../contract.ts";
import { type EcResult, EC_DISCLAIMER, deriveOutcome } from "../canonical.ts";
import { parseEcHtml } from "../parse/ec-html.ts";

export interface WorkerConfig {
  portalUrl: string;
  username?: string;
  password?: string;
  headless?: boolean;
}

/**
 * The real portal's homepage runs a promo modal ("Presence Less Registration")
 * that reappears on most navigations and sits on top of the login form — Playwright
 * correctly refuses to fill a field it's covering ("element is not visible"),
 * which is the exact failure this fixes. Best-effort, several strategies, never
 * throws: dismissing a promo popup is not part of the flow worth failing over.
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
  } catch {
    // best-effort only
  }
}

/**
 * The real portal's login inputs sit in a panel that's hidden until the header
 * "Login" control toggles it open (a JS-driven show/hide, not a page navigation) —
 * confirmed directly: loading the page alone leaves #username present but not
 * visible. Try a few real-world candidates (English + Tamil, button or link) and
 * click whichever is actually visible and clickable.
 */
async function revealLoginPanel(page: import("playwright").Page): Promise<void> {
  const candidates = [
    page.getByRole("button", { name: /^(login|sign in|உள்நுழைவு)$/i }),
    page.getByRole("link", { name: /^(login|sign in|உள்நுழைவு)$/i }),
    page.locator('button:has-text("Login"), a:has-text("Login")'),
    page.locator('button:has-text("Sign In"), a:has-text("Sign In")'),
    page.locator("#loginBtn, .login-btn, [onclick*=\"login\" i]"),
  ];
  for (const loc of candidates) {
    const el = loc.first();
    if ((await el.count().catch(() => 0)) && (await el.isVisible().catch(() => false))) {
      await el.click({ timeout: 3000 }).catch(() => {});
      await page.waitForTimeout(500);
      if (await page.locator("#username").first().isVisible().catch(() => false)) return;
    }
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

async function clickFirst(page: import("playwright").Page, selectors: string[]): Promise<boolean> {
  for (const sel of selectors) {
    const el = page.locator(sel).first();
    if (await el.count().catch(() => 0)) {
      await el.click({ timeout: 3000 }).catch(() => {});
      return true;
    }
  }
  return false;
}

async function solveCaptcha(page: import("playwright").Page, ctx: RetrieveContext, inputSelectors: string[]): Promise<void> {
  // Only one of these ever exists on a given portal, so joining into one CSS
  // selector resolves to exactly the right single element either way.
  const inputSel = inputSelectors.join(", ");
  // Screenshot just the CAPTCHA image itself when we can find one near the answer
  // box — smaller and clearer for the operator than a full-page capture. Common
  // patterns: an <img> right next to/before the answer input, or one whose id/src
  // hints at "captcha". Falls back to the full page if none of that matches.
  const imgCandidates = [
    ...inputSelectors.map((sel) => `${sel} ~ img`),
    `img[id*="captcha" i]`,
    `img[src*="captcha" i]`,
    `img[alt*="captcha" i]`,
  ];
  let shot: Buffer | undefined;
  for (const sel of imgCandidates) {
    const img = page.locator(sel).first();
    if (await img.count().catch(() => 0)) {
      shot = await img.screenshot().catch(() => undefined);
      if (shot) break;
    }
  }
  shot ??= await page.screenshot();

  const _mockAnswer = await mockAnswer(page);
  const ans = await ctx.requestHuman({
    kind: "captcha",
    // full image, not a truncated fragment — the operator has to actually read this
    context: { note: "portal CAPTCHA", imageBase64: `data:image/png;base64,${shot.toString("base64")}`, _mockAnswer },
  });
  if (ans.kind !== "captcha" || !ans.value) throw new ProviderError("captcha_unrecoverable", "no CAPTCHA answer");
  await page.fill(inputSel, ans.value);
}

export async function runWorker(cfg: WorkerConfig, req: EcRequest, ctx: RetrieveContext): Promise<EcResult> {
  let browser: Browser | undefined;
  try {
    browser = await chromium.launch({ headless: cfg.headless ?? true });
    const page = await browser.newPage();
    const base = cfg.portalUrl.replace(/\/$/, "");

    // 1. login
    await page.goto(`${base}/portal`, { waitUntil: "domcontentloaded" });
    await dismissPromoModal(page);
    if (await page.locator("#username").count()) {
      // On the real portal, #username exists in the DOM from page load but stays
      // hidden until the header "Login" control toggles its panel open — a plain
      // goto() never triggers that, so fill() times out waiting for visibility.
      if (!(await page.locator("#username").first().isVisible().catch(() => false))) {
        await revealLoginPanel(page);
        await dismissPromoModal(page); // the promo can reappear after the click too
      }
      await page.fill("#username", cfg.username ?? "worker");
      await page.fill("#password", cfg.password ?? "worker");
      await solveCaptcha(page, ctx, ["#captcha"]);
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
      const searchLink = page.getByRole("link", { name: /search\s*\/?\s*view\s*ec/i });
      if (await searchLink.count().catch(() => 0)) {
        await dismissPromoModal(page);
        await searchLink.first().click({ timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(800);
      }
      if (!(await hasSearchForm())) {
        await page.goto(`${base}/portal/ec-search`, { waitUntil: "domcontentloaded" }).catch(() => {});
      }
      await dismissPromoModal(page);
    }

    const p = req.property;
    // Zone -> District -> SRO -> Village cascade via AJAX on the real portal
    // (confirmed live: each combo's options only populate ~1s after its parent
    // fires) — the pause between selects is required there, harmless on the mock.
    await fillFirst(page, ["#cmb_Zone", "#zone"], p.zone);
    await page.waitForTimeout(800);
    await fillFirst(page, ["#cmb_District", "#district"], p.district);
    await page.waitForTimeout(800);
    await fillFirst(page, ["#cmb_SroName", "#sro"], p.sroCode);
    await page.waitForTimeout(800);
    if (p.village) {
      await fillFirst(page, ["#cmb_Village", "#village"], p.village);
      await page.waitForTimeout(500);
    }
    // Real portal: survey number and subdivision number are separate fields
    // (e.g. "11" and "1A1", not the combined "11/1A1" printed on an old deed —
    // confirmed live) that must be added as a row before the CAPTCHA even renders.
    if (p.surveyNumber) await fillFirst(page, ["#txt_SurveyNo", "#survey"], p.surveyNumber);
    if (p.subdivisionNumber) await fillFirst(page, ["#txt_SubDivisionNo", "#subdiv"], p.subdivisionNumber);
    await clickFirst(page, ["#btn_AddSurvey"]); // real-portal-only step; no-op on the mock
    // NOTE: only proven live via the real date-picker widget (click field -> click
    // month/year header -> click day), not via fill(). fill() is tried here as the
    // simpler first attempt and is confirmed to work against the mock; if a live
    // run shows the real portal's date fields silently ignoring it, swap this for
    // picker clicks using the sequence above.
    await fillFirst(page, ["#txt_PeriodStartDt", "#from"], isoToDmy(req.period.from));
    await fillFirst(page, ["#txt_PeriodEndDt", "#to"], isoToDmy(req.period.to));

    // 3. search CAPTCHA
    await solveCaptcha(page, ctx, ["#txt_Captcha", "#ec-captcha"]);
    await Promise.all([
      page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => {}),
      clickFirst(page, ["#btn_SearchDoc", "#ec-submit"]),
    ]);

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
        rawArtifactRefs: [`data:image/png;base64,${shot.toString("base64").slice(0, 24)}…`],
      },
      disclaimer: EC_DISCLAIMER,
    };
  } catch (err) {
    if (err instanceof ProviderError) throw err;
    throw new ProviderError("portal_unavailable", `automation worker failed: ${(err as Error).message}`, true);
  } finally {
    await browser?.close().catch(() => {});
  }
}

function isoToDmy(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}
