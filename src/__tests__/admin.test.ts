import { describe, expect, it } from "vitest";
import { adminContaining, matchingAdminAnswer, answerQuestion } from "../answers";
import { pointInPolygon } from "../geometry";
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

  it("places every candidate inside some city polygon", () => {
    const city = ds.admin_polygons.city;
    for (const c of ds.candidates) {
      expect(adminContaining(c, city), c.name).not.toBeNull();
    }
    // The play region now spans several cities (Seattle + the Eastside).
    const cityNames = new Set(city.map((p) => p.name));
    expect(cityNames).toContain("Seattle");
    expect(cityNames).toContain("Mercer Island");
  });

  it("matches two candidates in the same city and rejects cross-city pairs", () => {
    const city = ds.admin_polygons.city;
    const cityOf = (c: (typeof ds.candidates)[number]) => adminContaining(c, city);
    const seattle = ds.candidates.find((c) => cityOf(c) === "Seattle")!;
    const seattle2 = ds.candidates.find((c) => c !== seattle && cityOf(c) === "Seattle")!;
    const eastside = ds.candidates.find((c) => cityOf(c) !== null && cityOf(c) !== "Seattle")!;
    expect(seattle && seattle2 && eastside).toBeTruthy();
    expect(matchingAdminAnswer(seattle, seattle2, city)).toBe("yes");
    expect(matchingAdminAnswer(seattle, eastside, city)).toBe("no");
  });

  it("every fine region nests within its own district's merged outline", () => {
    // District outlines are the dissolved union of that district's fine polygons,
    // so each candidate's fine region must be covered by a same-named district
    // polygon. (Independent first-match can disagree where the source KML
    // neighborhoods overlap, so we assert geometric membership, not first-match.)
    const nbhd = ds.admin_polygons.neighborhood;
    const region = ds.admin_polygons.neighborhood_region;
    let checked = 0;
    for (const c of ds.candidates) {
      const fine = adminContaining(c, region);
      if (fine === null) continue;
      const district = fine.split(" - ")[0];
      const inDistrict = nbhd.some((p) => p.name === district && pointInPolygon(c, p.ring));
      expect(inDistrict, `${c.name} fine="${fine}"`).toBe(true);
      checked++;
    }
    expect(checked).toBeGreaterThan(20);
  });

  it("the neighborhood tier is coarser than the region tier", () => {
    const nbhd = new Set(ds.admin_polygons.neighborhood.map((p) => p.name));
    const region = new Set(ds.admin_polygons.neighborhood_region.map((p) => p.name));
    // ~20 districts vs ~94 fine "District - Neighborhood" regions.
    expect(nbhd.size).toBeLessThan(region.size);
    // Every fine region's district prefix is a real neighborhood-tier name.
    for (const name of region) {
      expect(nbhd.has(name.split(" - ")[0]), name).toBe(true);
    }
  });

  it("returns 'no' when one point is outside the region set", () => {
    const region = ds.admin_polygons.neighborhood_region;
    expect(matchingAdminAnswer(ds.candidates[0], far, region)).toBe("no");
  });

  it("answerQuestion routes admin questions to the right tier polygons", () => {
    const city = ds.admin_polygons.city;
    const inSeattle = ds.candidates.filter((c) => adminContaining(c, city) === "Seattle");
    const q: QuestionSpec = { category: "admin", name: "Same city", payload: "city" };
    expect(answerQuestion(q, inSeattle[0], inSeattle[1], ds)).toBe("yes");
    expect(answerQuestion(q, inSeattle[0], far, ds)).toBe("no");
  });
});
