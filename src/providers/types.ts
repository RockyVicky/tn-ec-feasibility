import type { EcRequest, EcResult } from "../contract.ts";

/**
 * Every EC source (aggregator API or our own browser automation) implements this.
 * The provider router picks one; the ERP never sees which.
 */
export interface EcProvider {
  readonly name: string; // e.g. "aggregator:landeed", "automation"

  /** Cheap check — does this provider cover the request's district / search type? */
  supports(req: EcRequest): boolean;

  /**
   * Attempt retrieval. Resolves with a canonical result, or throws a ProviderError.
   * May take minutes (informational) to days (certified) — callers run this on the queue,
   * not in the request path.
   */
  retrieve(req: EcRequest, ctx: RetrieveContext): Promise<EcResult>;
}

export interface RetrieveContext {
  requestId: string;
  /** Park a task for a human operator (CAPTCHA / OTP / QA) and await their input. */
  requestHuman(task: HumanTask): Promise<HumanResponse>;
  /** Structured logging sink. */
  log: (event: string, data?: Record<string, unknown>) => void;
}

export type HumanTask =
  | { kind: "captcha"; imageRef: string }
  | { kind: "otp"; channel: "sms" | "email"; hint: string }
  | { kind: "nil_review"; rawArtifactRef: string }
  | { kind: "ocr_review"; rawArtifactRef: string; fields: string[] };

export type HumanResponse =
  | { kind: "captcha"; value: string }
  | { kind: "otp"; value: string }
  | { kind: "nil_review"; confirmedNil: boolean; note?: string }
  | { kind: "ocr_review"; corrections: Record<string, string>; note?: string };

export class ProviderError extends Error {
  constructor(
    readonly code:
      | "unsupported"
      | "portal_unavailable"
      | "provider_error"
      | "no_records_unconfirmed"
      | "payment_required"
      | "not_digitised"
      | "captcha_unrecoverable"
      | "timeout",
    message: string,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "ProviderError";
  }
}
