import { beforeEach, describe, expect, it } from "vitest";
import { EliminationEngine, equalAnswer, evaluate, type StepSpec } from "../engine";
import { radarAnswer } from "../answers";
import { loadDatasetSync } from "./helpers";
import type { Dataset, LatLon } from "../types";

const ds: Dataset = loadDatasetSync();
const origin: LatLon = { lat: ds.config.start_lat, lon: ds.config.start_lon };

describe("EliminationEngine radar elimination", () => {
  let eng: EliminationEngine;
  beforeEach(() => {
    eng = new EliminationEngine(ds);
  });

  it("starts with the full candidate universe", () => {
    expect(eng.survivors().length).toBe(ds.candidates.length);
    expect(eng.eliminated().length).toBe(0);
  });

  it("radar=yes keeps exactly the candidates within the radius", () => {
    const spec: StepSpec = { category: "radar", payload: 3, seeker: origin };
    eng.apply(spec, true);
    const survivors = eng.survivors();
    for (const c of survivors) {
      expect(radarAnswer(c, origin, 3)).toBe(true);
    }
    // and none of the eliminated are within the radius
    for (const c of eng.eliminated()) {
      expect(radarAnswer(c, origin, 3)).toBe(false);
    }
  });

  it("preview partition is exhaustive and disjoint and matches survivorsIf", () => {
    const spec: StepSpec = { category: "radar", payload: 1, seeker: origin };
    const buckets = eng.preview(spec);
    const total = buckets.reduce((n, b) => n + b.survivors.length, 0);
    expect(total).toBe(eng.survivors().length);

    // disjoint: no candidate appears in two buckets
    const seen = new Set<string>();
    for (const b of buckets) {
      for (const c of b.survivors) {
        expect(seen.has(c.id)).toBe(false);
        seen.add(c.id);
      }
    }
    // preview bucket counts equal the count you'd get by actually applying
    for (const b of buckets) {
      expect(eng.survivorsIf(spec, b.answer).length).toBe(b.survivors.length);
    }
  });

  it("applying a step equals the matching preview bucket", () => {
    const spec: StepSpec = { category: "radar", payload: 5, seeker: origin };
    const yesCount = eng.survivorsIf(spec, true).length;
    eng.apply(spec, true);
    expect(eng.survivors().length).toBe(yesCount);
  });
});

describe("EliminationEngine undo/redo", () => {
  it("undo restores the exact prior survivor set; redo re-applies it", () => {
    const eng = new EliminationEngine(ds);
    const before = eng.survivors().length;

    eng.apply({ category: "radar", payload: 3, seeker: origin }, true);
    const afterApply = eng.survivors().length;
    expect(afterApply).toBeLessThan(before);

    expect(eng.canUndo()).toBe(true);
    eng.undo();
    expect(eng.survivors().length).toBe(before);
    expect(eng.canRedo()).toBe(true);

    eng.redoStep();
    expect(eng.survivors().length).toBe(afterApply);
  });

  it("applying a new step after undo clears the redo branch", () => {
    const eng = new EliminationEngine(ds);
    eng.apply({ category: "radar", payload: 10, seeker: origin }, true);
    eng.undo();
    expect(eng.canRedo()).toBe(true);
    eng.apply({ category: "radar", payload: 1, seeker: origin }, true);
    expect(eng.canRedo()).toBe(false);
  });

  it("cumulative steps are monotonically non-increasing in survivor count", () => {
    const eng = new EliminationEngine(ds);
    const counts = [eng.survivors().length];
    eng.apply({ category: "radar", payload: 10, seeker: origin }, true);
    counts.push(eng.survivors().length);
    eng.apply({ category: "radar", payload: 5, seeker: origin }, true);
    counts.push(eng.survivors().length);
    eng.apply({ category: "radar", payload: 3, seeker: origin }, true);
    counts.push(eng.survivors().length);
    for (let i = 1; i < counts.length; i++) {
      expect(counts[i]).toBeLessThanOrEqual(counts[i - 1]);
    }
  });
});

describe("EliminationEngine persistence", () => {
  it("round-trips through toJSON/loadSteps", () => {
    const eng = new EliminationEngine(ds);
    eng.apply({ category: "radar", payload: 3, seeker: origin }, true);
    eng.apply({ category: "matching", payload: "park", seeker: origin }, "yes");
    const snapshot = eng.survivors().length;

    const json = JSON.parse(JSON.stringify(eng.toJSON()));
    const eng2 = new EliminationEngine(ds);
    eng2.loadSteps(json.steps);
    expect(eng2.survivors().length).toBe(snapshot);
    expect(eng2.history().length).toBe(2);
  });
});

describe("thermometer step", () => {
  it("keeps candidates consistent with the hotter/colder answer", () => {
    const eng = new EliminationEngine(ds);
    const from = origin;
    const to: LatLon = { lat: origin.lat + 0.05, lon: origin.lon };
    const spec: StepSpec = { category: "thermometer", payload: 0, seeker: from, seekerTo: to };
    eng.apply(spec, "hotter");
    for (const c of eng.survivors()) {
      expect(equalAnswer(evaluate(ds, spec, c), "hotter")).toBe(true);
    }
  });
});
