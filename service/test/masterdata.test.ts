import { describe, expect, it } from "vitest";
import { MasterDataError, coverage, resolveUnit } from "../src/masterdata/index.ts";

describe("resolveUnit", () => {
  it("resolves by SRO code, case-insensitively", () => {
    const u = resolveUnit({ zone: "chennai", district: "North Chennai", sro: "chn-no-tvl" });
    expect(u).toMatchObject({ zone: "Chennai", district: "North Chennai", sroCode: "CHN-NO-TVL", sroName: "Thiruvottiyur" });
  });

  it("resolves by SRO name", () => {
    const u = resolveUnit({ zone: "Chennai", district: "North Chennai", sro: "Thiruvottiyur" });
    expect(u.sroCode).toBe("CHN-NO-TVL");
  });

  it("throws MasterDataError for an unknown zone", () => {
    expect(() => resolveUnit({ zone: "Atlantis", district: "X", sro: "Y" })).toThrow(MasterDataError);
  });

  it("throws for a valid zone but unknown SRO", () => {
    try {
      resolveUnit({ zone: "Chennai", district: "North Chennai", sro: "Nowhere" });
      expect.unreachable();
    } catch (e) {
      expect((e as MasterDataError).field).toBe("sroCode");
    }
  });

  it("reports partial coverage", () => {
    const c = coverage();
    expect(c.partial).toBe(true);
    expect(c.zones).toBe(11);
    expect(c.sros).toBeGreaterThan(10);
  });
});
