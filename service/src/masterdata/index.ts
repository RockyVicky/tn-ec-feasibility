/**
 * TN registration master data — resolves and validates zone / district / SRO.
 * Backed by a PARTIAL seed (tn-registration-units.json). See the note in that file.
 */
import raw from "./tn-registration-units.json" with { type: "json" };

export interface ResolvedUnit {
  zone: string;
  district: string;
  sroCode: string;
  sroName: string;
}

interface Sro { code: string; name: string; }
interface District { name: string; sros: Sro[]; }
interface Zone { name: string; districts: District[]; }

const zones: Zone[] = (raw as { zones: Zone[] }).zones;

const norm = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export class MasterDataError extends Error {
  constructor(readonly field: "zone" | "district" | "sroCode", message: string) {
    super(message);
    this.name = "MasterDataError";
  }
}

/**
 * Resolve a (zone, district, sro) triple to canonical names.
 * `sro` matches on code or name, case-insensitively.
 * Throws MasterDataError when a level cannot be resolved.
 */
export function resolveUnit(input: { zone: string; district: string; sro: string }): ResolvedUnit {
  const zone = zones.find((z) => norm(z.name) === norm(input.zone));
  if (!zone) {
    throw new MasterDataError("zone", `unknown zone "${input.zone}". Known: ${zones.map((z) => z.name).join(", ")}`);
  }
  const district = zone.districts.find((d) => norm(d.name) === norm(input.district));
  if (!district) {
    throw new MasterDataError("district", `unknown district "${input.district}" in zone "${zone.name}". Known: ${zone.districts.map((d) => d.name).join(", ")}`);
  }
  const sro = district.sros.find((s) => norm(s.code) === norm(input.sro) || norm(s.name) === norm(input.sro));
  if (!sro) {
    throw new MasterDataError("sroCode", `unknown SRO "${input.sro}" in district "${district.name}". Known: ${district.sros.map((s) => `${s.code} (${s.name})`).join(", ")}`);
  }
  return { zone: zone.name, district: district.name, sroCode: sro.code, sroName: sro.name };
}

export function listZones(): string[] {
  return zones.map((z) => z.name);
}

/** Coverage stat for the dashboard / ops. */
export function coverage(): { zones: number; districts: number; sros: number; partial: true } {
  return {
    zones: zones.length,
    districts: zones.reduce((n, z) => n + z.districts.length, 0),
    sros: zones.reduce((n, z) => n + z.districts.reduce((m, d) => m + d.sros.length, 0), 0),
    partial: true,
  };
}
