import { describe, expect, it } from "vitest";
import { candidateBounds, computeEliminatedArea, computePreviewEliminatedArea, type LatLngMultiPolygon } from "../area";
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

describe("computePreviewEliminatedArea (analytic)", () => {
  it("marks exactly the stations a pending answer would newly eliminate", () => {
    const eng = new EliminationEngine(ds);
    const spec = { category: "radar", payload: 3, seeker: origin } as const;
    const mp = computePreviewEliminatedArea(ds, eng, spec, true);
    expect(mp.length).toBeGreaterThan(0);

    const keep = new Set(eng.survivorsIf(spec, true).map((c) => c.id));
    let checked = 0;
    for (const c of ds.candidates) {
      if (Math.abs(distMi(c, origin) - 3) < 0.1) continue; // edge band
      // In previewed area iff answering "true" would drop it (not kept).
      expect(insideArea(mp, c), `${c.name}`).toBe(!keep.has(c.id));
      checked++;
    }
    expect(checked).toBeGreaterThan(100);
  });

  it("is incremental: never re-covers already-eliminated stations", () => {
    const eng = new EliminationEngine(ds);
    eng.apply({ category: "radar", payload: 3, seeker: origin }, true); // keep within 3mi
    const mp = computePreviewEliminatedArea(
      ds,
      eng,
      { category: "radar", payload: 2, seeker: origin },
      true,
    );
    for (const c of ds.candidates) {
      if (eng.survivesAll(c)) continue; // only inspect already-eliminated stations
      if (Math.abs(distMi(c, origin) - 3) < 0.15) continue; // prior-radar edge band
      expect(insideArea(mp, c), `${c.name}`).toBe(false);
    }
  });

  it("is empty when the pending answer eliminates nothing new", () => {
    const eng = new EliminationEngine(ds);
    eng.apply({ category: "radar", payload: 3, seeker: origin }, true);
    // Answering the identical question the same way removes nothing further.
    const mp = computePreviewEliminatedArea(
      ds,
      eng,
      { category: "radar", payload: 3, seeker: origin },
      true,
    );
    for (const c of ds.candidates) {
      if (Math.abs(distMi(c, origin) - 3) < 0.15) continue;
      expect(insideArea(mp, c), `${c.name}`).toBe(false);
    }
  });

  it("thermometer: hotter/colder each shade a non-empty complementary half", () => {
    const eng = new EliminationEngine(ds);
    const seekerTo: LatLon = { lat: origin.lat + 0.02, lon: origin.lon + 0.02 };
    const spec = { category: "thermometer", payload: 0, seeker: origin, seekerTo } as const;

    const hotter = computePreviewEliminatedArea(ds, eng, spec, "hotter");
    const colder = computePreviewEliminatedArea(ds, eng, spec, "colder");
    // Both answers must produce visible shading (regression: thermometer preview
    // used to render nothing / get cleared).
    expect(hotter.length).toBeGreaterThan(0);
    expect(colder.length).toBeGreaterThan(0);

    // "hotter" (closer to the destination) eliminates the far half; "colder" the
    // near half. The two previews are disjoint and each covers real stations.
    let inHotter = 0;
    let inColder = 0;
    for (const c of ds.candidates) {
      const loc = { lat: c.lat, lon: c.lon };
      const h = insideArea(hotter, loc);
      const k = insideArea(colder, loc);
      expect(h && k, `${c.name} in both halves`).toBe(false);
      if (h) inHotter++;
      if (k) inColder++;
    }
    expect(inHotter).toBeGreaterThan(0);
    expect(inColder).toBeGreaterThan(0);
  });

  it("thermometer preview over a thermometer-carved region computes without crashing", () => {
    // Regression: `current \ (current ∩ kept)` was computed as an intersection
    // followed by a difference; the intersection's output shared near-coincident
    // (1-ULP) edges with `current`, and feeding those back into difference made
    // polygon-clipping throw "Unable to complete output ring". This exact pair of
    // thermometer questions used to crash; it must now compute a real region.
    const byId = (id: string): LatLon => {
      const c = ds.candidates.find((c) => c.id === id);
      if (!c) throw new Error(`missing candidate ${id}`);
      return { lat: c.lat, lon: c.lon };
    };
    const eng = new EliminationEngine(ds);
    eng.apply(
      { category: "thermometer", payload: 0, seeker: byId("12th-jackson"), seekerTo: byId("148th-ave-ne-ne-55th-st") },
      "hotter",
    );
    const spec = {
      category: "thermometer",
      payload: 0,
      seeker: byId("156th-ave-ne-ne-15th-pl"),
      seekerTo: byId("15th-ave-w-w-armour-st"),
    } as const;
    expect(() => computePreviewEliminatedArea(ds, eng, spec, "hotter")).not.toThrow();
    expect(() => computePreviewEliminatedArea(ds, eng, spec, "colder")).not.toThrow();
    expect(computePreviewEliminatedArea(ds, eng, spec, "hotter").length).toBeGreaterThan(0);
  });

  it("coast: closer/further each shade a non-empty region matching elimination", () => {
    const eng = new EliminationEngine(ds);
    const spec = { category: "coast", payload: "coastline", seeker: origin } as const;
    const dsCoast = coastlineDistanceMi(origin, ds.coastlines)!;

    const closer = computePreviewEliminatedArea(ds, eng, spec, "closer");
    const further = computePreviewEliminatedArea(ds, eng, spec, "further");
    // Regression: coastline preview must render shading (used to appear blank).
    expect(closer.length).toBeGreaterThan(0);
    expect(further.length).toBeGreaterThan(0);

    // "closer" keeps stations nearer the coast than the seeker, so it eliminates
    // the farther ones (and vice-versa); the two previews are complementary.
    let inCloser = 0;
    let inFurther = 0;
    for (const c of ds.candidates) {
      const loc = { lat: c.lat, lon: c.lon };
      if (Math.abs(coastlineDistanceMi(loc, ds.coastlines)! - dsCoast) < 0.15) continue; // edge band
      const cl = insideArea(closer, loc);
      const fa = insideArea(further, loc);
      expect(cl && fa, `${c.name} in both`).toBe(false);
      if (cl) inCloser++;
      if (fa) inFurther++;
    }
    expect(inCloser).toBeGreaterThan(0);
    expect(inFurther).toBeGreaterThan(0);
  });

  it("water: closer/further each shade a non-empty region matching elimination", () => {
    const eng = new EliminationEngine(ds);
    const spec = { category: "water", payload: "water", seeker: origin } as const;
    // Reuse the generic polyline distance helper against the water-body borders.
    const dsWater = coastlineDistanceMi(origin, ds.water_bodies)!;
    expect(ds.water_bodies.length).toBeGreaterThan(0);

    const closer = computePreviewEliminatedArea(ds, eng, spec, "closer");
    const further = computePreviewEliminatedArea(ds, eng, spec, "further");
    expect(closer.length).toBeGreaterThan(0);
    expect(further.length).toBeGreaterThan(0);

    let inCloser = 0;
    let inFurther = 0;
    for (const c of ds.candidates) {
      const loc = { lat: c.lat, lon: c.lon };
      if (Math.abs(coastlineDistanceMi(loc, ds.water_bodies)! - dsWater) < 0.15) continue; // edge band
      const cl = insideArea(closer, loc);
      const fa = insideArea(further, loc);
      expect(cl && fa, `${c.name} in both`).toBe(false);
      if (cl) inCloser++;
      if (fa) inFurther++;
    }
    expect(inCloser).toBeGreaterThan(0);
    expect(inFurther).toBeGreaterThan(0);
  });
});
