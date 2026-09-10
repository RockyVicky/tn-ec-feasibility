/**
 * EC Service — contract types.
 * Mirrors docs/internal-api-contract.md and docs/canonical-ec-result.md.
 * Keep this file and those docs in sync.
 */
import { z } from "zod";

// ---- request ---------------------------------------------------------------

export const SearchType = z.enum(["EC_WISE", "DOCUMENT_WISE", "PLOT_FLAT_WARD_WISE"]);

export const EcRequest = z.object({
  searchType: SearchType,
  certified: z.boolean(),
  property: z.object({
    zone: z.string().min(1),
    district: z.string().min(1),
    sroCode: z.string().min(1),
    village: z.string().nullish(),
    surveyNumber: z.string().nullish(),
    subdivisionNumber: z.string().nullish(),
    documentNumber: z.string().nullish(),
    registrationYear: z.number().int().nullish(),
  }),
  period: z.object({
    from: z.string().date(),
    to: z.string().date(),
  }),
  callbackUrl: z.string().url(),
  reference: z.string().optional(),
  priority: z.enum(["normal", "high"]).default("normal"),
});
export type EcRequest = z.infer<typeof EcRequest>;

// ---- status --------------------------------------------------------------

export type RequestStatusValue =
  | "queued"
  | "in_progress"
  | "needs_human"
  | "completed"
  | "partial"
  | "failed";

export type FailureCode =
  | "validation"
  | "unresolvable"
  | "portal_unavailable"
  | "provider_error"
  | "no_records_unconfirmed"
  | "payment_required"
  | "not_digitised"
  | "captcha_unrecoverable"
  | "timeout";

export interface RequestStatus {
  requestId: string;
  reference?: string;
  status: RequestStatusValue;
  certified: boolean;
  source: string | null; // "aggregator:<name>" | "automation" | null
  submittedAt: string;
  completedAt: string | null;
  estimate?: { type: "minutes" | "days"; value: number };
  result: EcResult | null;
  documents: Array<{
    kind: "ec_pdf" | "raw_html" | "screenshot";
    url: string;
    expiresAt: string;
    sha256: string;
  }>;
  failure: {
    code: FailureCode;
    message: string;
    retryable: boolean;
    operatorNote: string | null;
  } | null;
}

// ---- canonical EC result -------------------------------------------------

export type Outcome = "ENTRIES_FOUND" | "NIL_CONFIRMED" | "NIL_UNCONFIRMED" | "PERIOD_GAP";

export type InstrumentType =
  | "SALE" | "MORTGAGE" | "GIFT" | "RELEASE" | "PARTITION" | "SETTLEMENT" | "LEASE"
  | "AGREEMENT" | "POWER_OF_ATTORNEY" | "ATTACHMENT" | "COURT_ORDER" | "CORRECTION" | "OTHER";

export type CaveatCode =
  | "ONLINE_DATA_FROM_1975" | "PARTIAL_PERIOD_DIGITISED" | "OCR_LOW_CONFIDENCE"
  | "TRANSLITERATION_AMBIGUITY" | "VILLAGE_NAME_FUZZY_MATCH"
  | "MULTIPLE_SUBDIVISIONS_PRESENT" | "NIL_NOT_HUMAN_VERIFIED";

export interface Money { value: number; currency: "INR"; }

export interface EcEntry {
  seq: number;
  instrumentType: InstrumentType;
  rawInstrumentType: string;
  documentNumber: string | null;
  sroName: string | null;
  executionDate: string | null;
  registrationDate: string | null;
  presentationDate: string | null;
  considerationAmount: Money | null;
  marketValue: Money | null;
  extentSurveyed: string | null;
  parties: Array<{ role: "EXECUTANT" | "CLAIMANT" | "OTHER"; rawRole?: string | null; name: string }>;
  propertyDescription: string | null;
  remarks: string | null;
  pageRef: string | null;
}

export interface EcResult {
  schemaVersion: "1.0";
  search: {
    type: z.infer<typeof SearchType>;
    property: Record<string, string | number | null | undefined>;
    period: { from: string; to: string };
    performedAt: string;
  };
  outcome: Outcome;
  encumbrancePresent: boolean | null;
  entryCount: number;
  entries: EcEntry[];
  documents: Array<{ kind: "ec_pdf" | "raw_html" | "screenshot"; sha256: string; pages: number | null; sourceUrl: string; signed: boolean }>;
  caveats: Array<{ code: CaveatCode; message: string }>;
  provenance: {
    source: string;
    sourceReference: string | null;
    certified: boolean;
    retrievedAt: string;
    operatorId: string | null;
    rawArtifactRefs: string[];
  };
  disclaimer: string;
}

export const EC_DISCLAIMER =
  "An EC lists registered instruments for the period and keys searched. It is not proof " +
  "of ownership or clear title; absence of entries does not prove the property is " +
  "unencumbered or unoccupied.";
