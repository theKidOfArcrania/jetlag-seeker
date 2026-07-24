import { describe, expect, it } from "vitest";
import { candidateBounds, computeAreaGrid } from "../area";
import { EliminationEngine, type StepSpec } from "../engine";
import { loadDatasetSync } from "./helpers";
import type { Dataset, LatLon } from "../types";

const ds: Dataset = loadDatasetSync();
const origin: LatLon = { lat: ds.config.start_lat, lon: ds.config.start_lon };

describe("computeAreaGrid", () => {
  it("covers a padded bounding box around the candidates", () => {
    const b = candidateBounds(ds);
    const cells = computeAreaGrid(ds, new EliminationEngine(ds), { cellDeg: 0.02 });
    expect(cells.length).toBeGreaterThan(0);
    const west = Math.min(...cells.map((c) => c.west));
    const east = Math.max(...cells.map((c) => c.east));
    const south = Math.min(...cells.map((c) => c.south));
    const north = Math.max(...cells.map((c) => c.north));
    expect(west).toBeLessThanOrEqual(b.minLon);
    expect(east).toBeGreaterThanOrEqual(b.maxLon);
    expect(south).toBeLessThanOrEqual(b.minLat);
    expect(north).toBeGreaterThanOrEqual(b.maxLat);
  });

  it("eliminates nothing when no questions have been applied", () => {
    const cells = computeAreaGrid(ds, new EliminationEngine(ds), { cellDeg: 0.02 });
    expect(cells.every((c) => !c.eliminated)).toBe(true);
  });

  it("radar=yes eliminates cells whose center is outside the radius", () => {
    const eng = new EliminationEngine(ds);
    const spec: StepSpec = { category: "radar", payload: 3, seeker: origin };
    eng.apply(spec, true);
    const cells = computeAreaGrid(ds, eng, { cellDeg: 0.02 });

    const eliminated = cells.filter((c) => c.eliminated);
    const kept = cells.filter((c) => !c.eliminated);
    expect(eliminated.length).toBeGreaterThan(0);
    expect(kept.length).toBeGreaterThan(0);

    // Every kept cell center survives; every eliminated cell center does not.
    for (const c of kept) {
      const center = { lat: (c.south + c.north) / 2, lon: (c.west + c.east) / 2 };
      expect(eng.survivesAll(center)).toBe(true);
    }
    for (const c of eliminated) {
      const center = { lat: (c.south + c.north) / 2, lon: (c.west + c.east) / 2 };
      expect(eng.survivesAll(center)).toBe(false);
    }
  });

  it("applying more questions never un-eliminates a cell (monotonic)", () => {
    const eng = new EliminationEngine(ds);
    eng.apply({ category: "radar", payload: 10, seeker: origin }, true);
    const before = computeAreaGrid(ds, eng, { cellDeg: 0.02 });
    const beforeElim = new Set(
      before.filter((c) => c.eliminated).map((c) => `${c.south},${c.west}`),
    );
    eng.apply({ category: "radar", payload: 3, seeker: origin }, true);
    const after = computeAreaGrid(ds, eng, { cellDeg: 0.02 });
    for (const key of beforeElim) {
      const cell = after.find((c) => `${c.south},${c.west}` === key)!;
      expect(cell.eliminated).toBe(true);
    }
  });
});
