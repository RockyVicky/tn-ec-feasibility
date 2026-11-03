import { PDFParse } from "pdf-parse";
import type { ExtractedProperty } from "./types.ts";

export interface ExtractResult {
  property: ExtractedProperty;
  warning?: string;
}

/** Parses Zone / District / Sub-Registrar Office / Village / Survey No. out of a
 * real downloaded TNREGINET EC certificate PDF. Confirmed live against an actual
 * certificate: it carries a clean, bilingual-labeled header line
 * ("Zone: Vellore District: Cheyyar S.R.O: Arani_Cheyyar") and a village/survey
 * line ("Village /.../:Adaiyapulam Survey Details /.../: 5") with no OCR/rendering
 * noise — this is the real document the user will upload, not our own
 * print-to-PDF fallback of the search form (which has a totally different,
 * un-labeled layout and was the wrong target for this parser initially).
 * Best-effort: every field lands in an editable review table in the UI, so a
 * miss here costs one manual correction, not a silent bad run. */
export async function extractPropertyFromPdf(buffer: Buffer): Promise<ExtractResult> {
  const parser = new PDFParse({ data: buffer });
  const { text } = await parser.getText();
  await parser.destroy();

  // Single-line flatten tolerates the label/value sometimes landing on
  // adjacent extracted lines instead of one, depending on PDF layout noise.
  const flat = text.replace(/\s+/g, " ");

  let zone = "";
  let district = "";
  let sroCode = "";
  let village = "";
  let surveyNumber = "";
  const warnings: string[] = [];

  const zds = flat.match(/Zone:\s*(.+?)\s*District:\s*(.+?)\s*S\.?R\.?O:\s*([^0-9]+?)(?:\s+\d|$)/i);
  if (zds) {
    zone = zds[1]?.trim() ?? "";
    district = zds[2]?.trim() ?? "";
    sroCode = zds[3]?.trim() ?? "";
  } else {
    warnings.push("Could not find the \"Zone / District / S.R.O\" line — fields left blank.");
  }

  const vs = flat.match(/Village\s*\/[^:]*:\s*([^\s/][^/]*?)\s*Survey Details\s*\/[^:]*:\s*([^\s]+)/i);
  if (vs) {
    village = vs[1]?.trim() ?? "";
    surveyNumber = vs[2]?.trim() ?? "";
  } else {
    warnings.push("Could not find the \"Village / Survey Details\" line — fields left blank.");
  }

  return {
    property: { zone, district, sroCode, village, surveyNumber },
    warning: warnings.length ? warnings.join(" ") : undefined,
  };
}
