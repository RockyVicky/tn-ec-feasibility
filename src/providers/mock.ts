import type { EcProvider, RetrieveContext } from "./types.ts";
import { type EcRequest, type EcResult, EC_DISCLAIMER } from "../contract.ts";

/**
 * Stand-in provider for Phase 0. Returns a canned canonical result so the ERP team
 * can integrate against the contract before a real aggregator adapter exists.
 * Replace with providers/landeed.ts, providers/surepass.ts, providers/automation.ts.
 */
export class MockProvider implements EcProvider {
  readonly name = "mock";

  supports(_req: EcRequest): boolean {
    return true;
  }

  async retrieve(req: EcRequest, ctx: RetrieveContext): Promise<EcResult> {
    ctx.log("mock.retrieve.start", { requestId: ctx.requestId });

    const now = new Date().toISOString();
    const hasEntries = (req.property.surveyNumber ?? "").includes("4"); // arbitrary demo rule

    return {
      schemaVersion: "1.0",
      search: {
        type: req.searchType,
        property: { ...req.property },
        period: req.period,
        performedAt: now,
      },
      outcome: hasEntries ? "ENTRIES_FOUND" : "NIL_UNCONFIRMED",
      encumbrancePresent: hasEntries ? true : null,
      entryCount: hasEntries ? 1 : 0,
      entries: hasEntries
        ? [
            {
              seq: 1,
              instrumentType: "MORTGAGE",
              rawInstrumentType: "Simple Mortgage",
              documentNumber: `${req.property.sroCode}/2231/2019`,
              sroName: req.property.sroCode,
              executionDate: "2019-07-04",
              registrationDate: "2019-07-09",
              presentationDate: "2019-07-04",
              considerationAmount: { value: 3_500_000, currency: "INR" },
              marketValue: { value: 4_200_000, currency: "INR" },
              extentSurveyed: "1200 sq.ft",
              parties: [
                { role: "EXECUTANT", name: "A. Kumar" },
                { role: "CLAIMANT", name: "XYZ Bank Ltd" },
              ],
              propertyDescription: `Survey ${req.property.surveyNumber} subdiv ${req.property.subdivisionNumber}`,
              remarks: null,
              pageRef: "Vol 45 / Pg 210",
            },
          ]
        : [],
      documents: [],
      caveats: [
        { code: "ONLINE_DATA_FROM_1975", message: "Online EC covers registrations from ~1975 only." },
        ...(hasEntries
          ? []
          : [{ code: "NIL_NOT_HUMAN_VERIFIED" as const, message: "No entries returned; not yet confirmed by an operator." }]),
      ],
      provenance: {
        source: "mock",
        sourceReference: `MOCK-${ctx.requestId.slice(0, 8)}`,
        certified: req.certified,
        retrievedAt: now,
        operatorId: null,
        rawArtifactRefs: [],
      },
      disclaimer: EC_DISCLAIMER,
    };
  }
}
