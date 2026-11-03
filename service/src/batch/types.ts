export interface ExtractedProperty {
  zone: string;
  district: string;
  sroCode: string;
  village: string;
  surveyNumber: string;
}

export type BatchRecordStatus =
  | "extracted" // parsed from the PDF, waiting for review/start
  | "queued"
  | "in_progress"
  | "needs_human"
  | "completed"
  | "partial"
  | "failed";

export interface BatchRecord {
  id: string;
  fileName: string;
  extracted: ExtractedProperty;
  periodFrom: string;
  periodTo: string;
  status: BatchRecordStatus;
  requestId?: string;
  pdfPath?: string;
  failureMessage?: string;
  extractionWarning?: string;
  /** When this record's automation run actually started (ISO timestamp). */
  startedAt?: string;
  /** startedAt + a typical-run estimate — shown as "usually done by" in the UI, not a guarantee. */
  estimatedEndAt?: string;
  /** startedAt + the hard per-record timeout — past this, the run is cancelled and the batch moves on. */
  timeoutAt?: string;
}

export interface Batch {
  id: string;
  createdAt: string;
  records: BatchRecord[];
  started: boolean;
  completedAt?: string;
}
