import { describe, expect, it } from "vitest";
import { adminContaining, matchingAdminAnswer, answerQuestion } from "../answers";
import { loadDatasetSync } from "./helpers";
import type { Dataset, QuestionSpec } from "../types";

// Admin/region matching is sourced from the authoritative KML (string tiers
// city -> neighborhood -> neighborhood_region) and therefore isn't covered by
// the Python parity fixture. These tests exercise the ported logic directly.
const ds: Dataset = loadDatasetSync();
const far = { lat: 48.9, lon: -122.9 }; // well outside the Seattle city limit

describe("admin region matching (KML tiers)", () => {
  it("exposes the three configured tiers with polygons", () => {
    expect(ds.config.admin_regions).toEqual(["city", "neighborhood", "neighborhood_region"]);
    for (const tier of ds.config.admin_regions) {
      expect(ds.admin_polygons[tier]?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("places every candidate inside the single city polygon", () => {
    const city = ds.admin_polygons.city;
    for (const c of ds.candidates) {
      expect(adminContaining(c, city)).not.toBeNull();
    }
    // Any two candidates share the same city -> "yes".
    expect(matchingAdminAnswer(ds.candidates[0], ds.candidates[10], city)).toBe("yes");
  });

  it("nests neighborhood_region within neighborhood (fine name carries the coarse prefix)", () => {
    const nbhd = ds.admin_polygons.neighborhood;
    const region = ds.admin_polygons.neighborhood_region;
    let checked = 0;
    for (const c of ds.candidates) {
      const coarse = adminContaining(c, nbhd);
      const fine = adminContaining(c, region);
      if (coarse === null || fine === null) continue;
      // Fine names are "District - Neighborhood"; the district equals the
      // coarse (neighborhood) tier name.
      expect(fine.startsWith(coarse)).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("same fine region implies same coarse neighborhood", () => {
    const nbhd = ds.admin_polygons.neighborhood;
    const region = ds.admin_polygons.neighborhood_region;
    for (let i = 0; i < ds.candidates.length; i++) {
      for (let j = i + 1; j < ds.candidates.length; j++) {
        const a = ds.candidates[i];
        const b = ds.candidates[j];
        if (matchingAdminAnswer(a, b, region) === "yes") {
          expect(matchingAdminAnswer(a, b, nbhd)).toBe("yes");
        }
      }
    }
  });

  it("returns 'no' when one point is outside the region set", () => {
    const region = ds.admin_polygons.neighborhood_region;
    expect(matchingAdminAnswer(ds.candidates[0], far, region)).toBe("no");
  });

  it("answerQuestion routes admin questions to the right tier polygons", () => {
    const q: QuestionSpec = { category: "admin", name: "Same city", payload: "city" };
    expect(answerQuestion(q, ds.candidates[0], ds.candidates[5], ds)).toBe("yes");
    const qFar: QuestionSpec = { category: "admin", name: "Same city", payload: "city" };
    expect(answerQuestion(qFar, ds.candidates[0], far, ds)).toBe("no");
  });
});
