import { describe, expect, it } from "vitest";
import { haversineMi, pointInPolygon } from "../geometry";

describe("haversineMi", () => {
  it("is zero for identical points", () => {
    expect(haversineMi(47.6, -122.3, 47.6, -122.3)).toBe(0);
  });

  it("is symmetric", () => {
    const a = haversineMi(47.6, -122.3, 47.65, -122.2);
    const b = haversineMi(47.65, -122.2, 47.6, -122.3);
    expect(a).toBeCloseTo(b, 12);
  });

  it("matches a known one-degree-longitude distance at the equator", () => {
    // 1 deg of longitude at the equator ~= 69.09 statute miles.
    expect(haversineMi(0, 0, 0, 1)).toBeCloseTo(69.09, 1);
  });

  it("computes a realistic Seattle inter-station distance", () => {
    // Symphony -> Capitol Hill Station, ~1.5 mi as the crow flies.
    const d = haversineMi(47.607246, -122.335754, 47.6191, -122.3203);
    expect(d).toBeGreaterThan(1.0);
    expect(d).toBeLessThan(1.6);
  });
});

describe("pointInPolygon", () => {
  const square: [number, number][] = [
    [0, 0],
    [0, 10],
    [10, 10],
    [10, 0],
  ];

  it("detects an interior point", () => {
    expect(pointInPolygon({ lat: 5, lon: 5 }, square)).toBe(true);
  });

  it("rejects an exterior point", () => {
    expect(pointInPolygon({ lat: 15, lon: 5 }, square)).toBe(false);
    expect(pointInPolygon({ lat: 5, lon: -1 }, square)).toBe(false);
  });

  it("handles a concave polygon", () => {
    // An L-shape; the notch at (8,8) is outside.
    const L: [number, number][] = [
      [0, 0],
      [0, 10],
      [4, 10],
      [4, 4],
      [10, 4],
      [10, 0],
    ];
    expect(pointInPolygon({ lat: 2, lon: 2 }, L)).toBe(true);
    expect(pointInPolygon({ lat: 8, lon: 8 }, L)).toBe(false);
  });
});
