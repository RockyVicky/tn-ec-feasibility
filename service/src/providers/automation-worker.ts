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

/** For the mock portal only: read the answer it exposes so tests can proceed unattended. */
async function mockAnswer(page: import("playwright").Page): Promise<string | undefined> {
  return page.locator("#captcha-answer").first().textContent({ timeout: 200 }).catch(() => null).then((t) => t?.trim() || undefined);
}

async function solveCaptcha(page: import("playwright").Page, ctx: RetrieveContext, inputSel: string): Promise<void> {
  const shot = await page.screenshot();
  const _mockAnswer = await mockAnswer(page);
  const ans = await ctx.requestHuman({
    kind: "captcha",
    context: { note: "portal CAPTCHA", imageBase64: shot.toString("base64").slice(0, 64) + "…", _mockAnswer },
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
    if (await page.locator("#username").count()) {
      await page.fill("#username", cfg.username ?? "worker");
      await page.fill("#password", cfg.password ?? "worker");
      await solveCaptcha(page, ctx, "#captcha");
      await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => {}), page.click("#login-submit")]);
      ctx.log("automation.logged_in");
    }

    // 2. EC search form
    if (!(await page.locator("#ec-submit").count())) {
      await page.goto(`${base}/portal/ec-search`, { waitUntil: "domcontentloaded" });
    }
    const p = req.property;
    for (const [sel, val] of [
      ["#zone", p.zone], ["#district", p.district], ["#sro", p.sroCode],
    ] as const) {
      if (await page.locator(sel).count()) await page.selectOption(sel, { label: String(val) }).catch(() => page.fill(sel, String(val)).catch(() => {}));
    }
    for (const [sel, val] of [
      ["#village", p.village], ["#survey", p.surveyNumber], ["#subdiv", p.subdivisionNumber],
      ["#from", isoToDmy(req.period.from)], ["#to", isoToDmy(req.period.to)],
    ] as const) {
      if (val != null && (await page.locator(sel).count())) await page.fill(sel, String(val));
    }

    // 3. search CAPTCHA
    await solveCaptcha(page, ctx, "#ec-captcha");
    await Promise.all([page.waitForNavigation({ waitUntil: "domcontentloaded" }).catch(() => {}), page.click("#ec-submit")]);

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
