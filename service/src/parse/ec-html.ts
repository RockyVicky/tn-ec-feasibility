/**
 * Parse a TNREGINET "Search & View EC" results table into canonical EC entries.
 *
 * IMPLEMENTATION NOTE: this uses regex row/cell extraction to avoid a DOM-parser
 * dependency while the exact live HTML is unknown (portal is geo-restricted from CI).
 * Once the real markup is captured from an India IP, switch to a proper parser
 * (linkedom / cheerio) and map by column header rather than positional index.
 * The fixture in __fixtures__/ec-with-entries.html defines the column order assumed here.
 */
import { classifyInstrument, type EcEntry, type Party } from "../canonical.ts";

const stripTags = (s: string) => s.replace(/<[^>]*>/g, "").replace(/&nbsp;/g, " ").trim();

function toIsoDate(dmy: string): string | null {
  const m = dmy.trim().match(/^(\d{2})[/-](\d{2})[/-](\d{4})$/);
  if (!m) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function toMoney(s: string): { value: number; currency: "INR" } | null {
  const n = Number(s.replace(/[,\s]/g, ""));
  if (!Number.isFinite(n) || n <= 0) return null;
  return { value: n, currency: "INR" };
}

function names(s: string): string[] {
  return stripTags(s)
    .split(/\s*[,;/]\s*|\s+and\s+/i)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** Extract `<tbody>` `<tr>` rows; returns [] when the results table is empty. */
export function parseEcHtml(html: string): EcEntry[] {
  const tbody = html.match(/<tbody[^>]*>([\s\S]*?)<\/tbody>/i)?.[1] ?? "";
  const rows = [...tbody.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((m) => m[1] ?? "");

  const entries: EcEntry[] = [];
  for (const row of rows) {
    const cells = [...row.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => stripTags(m[1] ?? ""));
    if (cells.length < 6) continue; // header stragglers / malformed

    const [
      sno, nature, docYear, sro, execDate, regDate,
      consideration, marketValue, executants, claimants, extent, volPage, remarks,
    ] = cells;

    const parties: Party[] = [
      ...names(executants ?? "").map((n) => ({ role: "EXECUTANT" as const, name: n })),
      ...names(claimants ?? "").map((n) => ({ role: "CLAIMANT" as const, name: n })),
    ];

    entries.push({
      seq: Number(sno) || entries.length + 1,
      instrumentType: classifyInstrument(nature ?? ""),
      rawInstrumentType: nature ?? "",
      documentNumber: docYear || null,
      sroName: sro || null,
      executionDate: toIsoDate(execDate ?? ""),
      registrationDate: toIsoDate(regDate ?? ""),
      presentationDate: null,
      considerationAmount: toMoney(consideration ?? ""),
      marketValue: toMoney(marketValue ?? ""),
      extentSurveyed: extent || null,
      parties,
      propertyDescription: null,
      remarks: remarks || null,
      pageRef: volPage || null,
    });
  }
  return entries;
}
