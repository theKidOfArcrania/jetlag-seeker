// Geometry helpers. Ported 1:1 from jetlag_mapper's Python implementation to keep
// the client's answers identical to the reference optimizer.
//   - haversine_mi:      jetlag/transit/reachability.py
//   - point-in-polygon:  jetlag/questions/catalog.py (_point_in_polygon, ray casting)

import type { LatLon } from "./types";

export const EARTH_R_MI = 3958.7613;

export function haversineMi(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
): number {
  const rad = Math.PI / 180;
  const p1 = lat1 * rad;
  const p2 = lat2 * rad;
  const dp = (lat2 - lat1) * rad;
  const dl = (lon2 - lon1) * rad;
  const a =
    Math.sin(dp / 2) ** 2 +
    Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * EARTH_R_MI * Math.asin(Math.sqrt(a));
}

export function distMi(a: LatLon, b: LatLon): number {
  return haversineMi(a.lat, a.lon, b.lat, b.lon);
}

// Ray-casting point-in-polygon. Ring is a list of [lat, lon] pairs.
// Mirrors _point_in_polygon in jetlag/questions/catalog.py exactly.
export function pointInPolygon(
  pt: LatLon,
  ring: readonly [number, number][],
): boolean {
  const lat = pt.lat;
  const lon = pt.lon;
  let inside = false;
  const n = ring.length;
  let j = n - 1;
  for (let i = 0; i < n; i++) {
    const yi = ring[i][0];
    const xi = ring[i][1];
    const yj = ring[j][0];
    const xj = ring[j][1];
    if (
      yi > lat !== yj > lat &&
      lon < ((xj - xi) * (lat - yi)) / (yj - yi || 1e-12) + xi
    ) {
      inside = !inside;
    }
    j = i;
  }
  return inside;
}
