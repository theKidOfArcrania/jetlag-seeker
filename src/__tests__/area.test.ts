import { describe, expect, it } from "vitest";
import { candidateBounds, computeEliminatedArea, type LatLngMultiPolygon } from "../area";
import { EliminationEngine } from "../engine";
import { distMi } from "../geometry";
import { nearestDistanceMi, coastlineDistanceMi } from "../answers";
import { loadDatasetSync } from "./helpers";
import type { Dataset, LatLon } from "../types";

const ds: Dataset = loadDatasetSync();
const origin: LatLon = { lat: ds.config.start_lat, lon: ds.config.start_lon };

// Even-odd point-in-multipolygon across every ring (outer rings and holes).
// polygon-clipping outputs non-overlapping polygons with holes as separate
// rings, so counting crossings over all rings yields the correct inside test.
function insideArea(mp: LatLngMultiPolygon, p: LatLon): boolean {
  let inside = false;
  for (const poly of mp) {
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [latI, lonI] = ring[i];
        const [latJ, lonJ] = ring[j];
        const intersect =
          latI > p.lat !== latJ > p.lat &&
          p.lon < ((lonJ - lonI) * (p.lat - latI)) / (latJ - latI) + lonI;
        if (intersect) inside = !inside;
      }
    }
  }
  return inside;
}

describe("computeEliminatedArea (analytic)", () => {
  it("is empty when no questions have been applied", () => {
    const mp = computeEliminatedArea(ds, new EliminationEngine(ds));
    expect(mp.length).toBe(0);
  });

  it("radar=yes: overlay classifies real stations the same as the engine", () => {
    const eng = new EliminationEngine(ds);
    const threshold = 3;
    eng.apply({ category: "radar", payload: threshold, seeker: origin }, true);
    const mp = computeEliminatedArea(ds, eng);
    expect(mp.length).toBeGreaterThan(0);

    let checked = 0;
    let elimSeen = 0;
    for (const c of ds.candidates) {
      // Skip stations within a small band of the radar edge to avoid ambiguity
      // from circle segmentation / projection.
      if (Math.abs(distMi(c, origin) - threshold) < 0.1) continue;
      const eliminated = !eng.survivesAll(c);
      expect(insideArea(mp, c), `${c.name}`).toBe(eliminated);
      if (eliminated) elimSeen++;
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
    expect(elimSeen).toBeGreaterThan(0);
  });

  it("the eliminated area never extends outside the city boundary", () => {
    const eng = new EliminationEngine(ds);
    eng.apply({ category: "radar", payload: 1, seeker: origin }, true);
    const mp = computeEliminatedArea(ds, eng);
    // A point well outside the Seattle city limit must never be eliminated.
    const far = { lat: 48.9, lon: -122.9 };
    expect(insideArea(mp, far)).toBe(false);
  });

  it("admin=yes: overlay matches station elimination for a region question", () => {
    const eng = new EliminationEngine(ds);
    // Ask "same neighborhood region?" from the origin, observed yes.
    eng.apply({ category: "admin", payload: "neighborhood_region", seeker: origin }, "yes");
    const mp = computeEliminatedArea(ds, eng);

    for (const c of ds.candidates) {
      expect(insideArea(mp, c), `${c.name}`).toBe(!eng.survivesAll(c));
    }
  });

  it("tighter radar eliminates a superset of the wider radar (monotonic)", () => {
    const wide = new EliminationEngine(ds);
    wide.apply({ category: "radar", payload: 10, seeker: origin }, true);
    const wideMp = computeEliminatedArea(ds, wide);

    const tight = new EliminationEngine(ds);
    tight.apply({ category: "radar", payload: 3, seeker: origin }, true);
    const tightMp = computeEliminatedArea(ds, tight);

    for (const c of ds.candidates) {
      if (insideArea(wideMp, c)) {
        expect(insideArea(tightMp, c), `${c.name}`).toBe(true);
      }
    }
  });

  it("measuring & coast overlays match station elimination, and compute quickly", () => {
    // Use a measuring question with a small/dense feature set is expensive; parks
    // are the largest (~2800) so this also exercises the pruning + union path.
    const eng = new EliminationEngine(ds);
    eng.apply({ category: "measuring", payload: "park", seeker: origin }, "closer");
    eng.apply({ category: "coast", payload: "coast", seeker: origin }, "closer");
    const t0 = performance.now();
    const mp = computeEliminatedArea(ds, eng);
    const ms = performance.now() - t0;
    expect(ms).toBeLessThan(2000);

    const parks = ds.features_by_kind.park;
    const dsPark = nearestDistanceMi(origin, parks)!;
    const dsCoast = coastlineDistanceMi(origin, ds.coastlines)!;
    let checked = 0;
    for (const c of ds.candidates) {
      // Skip stations near either union-of-disks edge: segmented feature disks
      // are ambiguous within ~a segment of the true circle there.
      if (Math.abs(nearestDistanceMi(c, parks)! - dsPark) < 0.1) continue;
      if (Math.abs(coastlineDistanceMi(c, ds.coastlines)! - dsCoast) < 0.1) continue;
      expect(insideArea(mp, c), `${c.name}`).toBe(!eng.survivesAll(c));
      checked++;
    }
    expect(checked).toBeGreaterThan(50);
  });

  it("candidateBounds spans all candidates", () => {
    const b = candidateBounds(ds);
    for (const c of ds.candidates) {
      expect(c.lat).toBeGreaterThanOrEqual(b.minLat);
      expect(c.lat).toBeLessThanOrEqual(b.maxLat);
      expect(c.lon).toBeGreaterThanOrEqual(b.minLon);
      expect(c.lon).toBeLessThanOrEqual(b.maxLon);
    }
  });
});
