// Eliminated-area overlay: a grid over the candidate region where each cell's
// center is treated as a hypothetical hider and classified as eliminated or
// still-possible against the applied questions. This generalizes to every
// question type (radar, measuring, matching, admin, thermometer) because it
// reuses EliminationEngine.survivesAll().

import type { EliminationEngine } from "./engine";
import type { Dataset } from "./types";

export interface AreaCell {
  south: number;
  west: number;
  north: number;
  east: number;
  eliminated: boolean;
}

export interface Bounds {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

export interface AreaGridOptions {
  cellDeg?: number; // grid cell size in degrees
  padDeg?: number; // padding added around the candidate bounding box
}

export function candidateBounds(ds: Dataset): Bounds {
  const cs = ds.candidates;
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  for (const c of cs) {
    if (c.lat < minLat) minLat = c.lat;
    if (c.lat > maxLat) maxLat = c.lat;
    if (c.lon < minLon) minLon = c.lon;
    if (c.lon > maxLon) maxLon = c.lon;
  }
  return { minLat, minLon, maxLat, maxLon };
}

/**
 * Build the classified grid. Cells are returned for the whole padded bounding
 * box; each carries an `eliminated` flag. With no applied questions, no cell is
 * eliminated.
 */
export function computeAreaGrid(
  ds: Dataset,
  engine: EliminationEngine,
  opts: AreaGridOptions = {},
): AreaCell[] {
  const cell = opts.cellDeg ?? 0.007;
  const pad = opts.padDeg ?? 0.02;
  if (ds.candidates.length === 0) return [];

  const b = candidateBounds(ds);
  const minLat = b.minLat - pad;
  const maxLat = b.maxLat + pad;
  const minLon = b.minLon - pad;
  const maxLon = b.maxLon + pad;

  const cells: AreaCell[] = [];
  for (let lat = minLat; lat < maxLat; lat += cell) {
    const north = Math.min(lat + cell, maxLat);
    const cLat = (lat + north) / 2;
    for (let lon = minLon; lon < maxLon; lon += cell) {
      const east = Math.min(lon + cell, maxLon);
      const cLon = (lon + east) / 2;
      const eliminated = !engine.survivesAll({ lat: cLat, lon: cLon });
      cells.push({ south: lat, west: lon, north, east, eliminated });
    }
  }
  return cells;
}
