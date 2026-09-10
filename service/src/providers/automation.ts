import type { EcProvider, RetrieveContext } from "./types.ts";
import { ProviderError } from "./types.ts";
import type { EcRequest } from "../contract.ts";
import { type EcResult, EC_DISCLAIMER, deriveOutcome } from "../canonical.ts";
import { parseEcHtml } from "../parse/ec-html.ts";

/**
 * Browser-automation adapter — fallback provider.
 *
 * In production this drives a pool of Playwright workers on India-hosted infra
 * (see ../../poc/ec-search.mjs for the flow and ../../docs/runbook.md). The worker:
 *   1. loads the TNREGINET EC search form (fresh session, carries CSRF token)
 *   2. fills the property fields
 *   3. hits the CAPTCHA  -> opens a HITL 'captcha' task, waits for the operator
 *   4. submits; on an OTP prompt -> HITL 'otp' task
 *   5. scrapes the results table -> parseEcHtml -> canonical entries
 *   6. downloads the informational PDF
 *
 * This stub does NOT launch a browser (the portal is geo-blocked from CI and the
 * worker infra is a Phase 3 deliverable). It demonstrates the HITL handshake and
 * the HTML->canonical parse against a fixture, then reports portal_unavailable so
 * the behaviour is honest.
 */
export class AutomationProvider implements EcProvider {
  readonly name = "automation";

  constructor(private readonly opts: { simulateHtml?: string } = {}) {}

  supports(req: EcRequest): boolean {
    // Automation can technically attempt any search type; certified adds a payment step.
    return !req.certified;
  }

  async retrieve(req: EcRequest, ctx: RetrieveContext): Promise<EcResult> {
    ctx.log("automation.retrieve.start", { requestId: ctx.requestId });

    // Step 3 — CAPTCHA is unavoidable. Prove the HITL handshake.
    const captcha = await ctx.requestHuman({
      kind: "captcha",
      context: { note: "TNREGINET EC search CAPTCHA", imageRef: "automation://captcha.png" },
    });
    if (captcha.kind !== "captcha" || !captcha.value) {
      throw new ProviderError("captcha_unrecoverable", "no CAPTCHA answer from operator");
    }
    ctx.log("automation.captcha.answered", { requestId: ctx.requestId });

    if (!this.opts.simulateHtml) {
      // Real worker not available in this environment.
      throw new ProviderError(
        "portal_unavailable",
        "browser-automation worker not deployed (Phase 3). TNREGINET is also geo-restricted to India.",
        true,
      );
    }

    // Step 5 — parse a simulated results page to exercise the mapping.
    const now = new Date().toISOString();
    const entries = parseEcHtml(this.opts.simulateHtml);
    const { outcome, encumbrancePresent, caveats } = deriveOutcome({
      entries,
      periodFrom: req.period.from,
      nilHumanVerified: false,
    });

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
        source: this.name,
        sourceReference: null,
        certified: false,
        retrievedAt: now,
        operatorId: "operator",
        rawArtifactRefs: ["automation://results.html"],
      },
      disclaimer: EC_DISCLAIMER,
    };
  }
}
