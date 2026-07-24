// Eliminated-area overlay computed as *exact analytic polygons* per question,
// instead of classifying a grid of sample points. For every applied step we
// build the region of hypothetical hider locations whose answer would match the
// observed one ("kept region"). The surviving region is the intersection of all
// kept regions clipped to the Seattle city-limit boundary; the eliminated region
// is the boundary minus that. Boolean polygon operations are done with
// `polygon-clipping`.
//
// All geometry is done in a *local equirectangular projection* measured in miles
// (x = east, y = north) centred on the boundary, so radar disks are true
// circles, thermometer cuts are straight perpendicular bisectors, and matching
// Voronoi cells are Euclidean — matching the haversine answerers to well within
// rendering tolerance at city scale.

import polygonClipping, { type MultiPolygon, type Polygon, type Ring } from "polygon-clipping";
import { nearestFeature, nearestDistanceMi, coastlineDistanceMi, adminContaining } from "./answers";
import type { EliminationEngine, Step } from "./engine";
import type { AdminPolygon, Dataset, LatLon } from "./types";

export interface Bounds {
  minLat: number;
  minLon: number;
  maxLat: number;
  maxLon: number;
}

/** A multipolygon of geographic rings: polygons -> rings (outer + holes) -> [lat, lon]. */
export type LatLngMultiPolygon = [number, number][][][];

const MI_PER_DEG_LAT = 69.047;
const CIRCLE_SEGMENTS = 96; // segments per radar disk / feature disk
const DEG = Math.PI / 180;

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

// ---- Local projection (degrees <-> miles) -----------------------------------

class Projection {
  readonly lat0: number;
  readonly lon0: number;
  readonly mpLon: number; // miles per degree longitude at lat0
  constructor(lat0: number, lon0: number) {
    this.lat0 = lat0;
    this.lon0 = lon0;
    this.mpLon = MI_PER_DEG_LAT * Math.cos(lat0 * DEG);
  }
  toXY(lat: number, lon: number): [number, number] {
    return [(lon - this.lon0) * this.mpLon, (lat - this.lat0) * MI_PER_DEG_LAT];
  }
  toXYLoc(p: LatLon): [number, number] {
    return this.toXY(p.lat, p.lon);
  }
  fromXY(x: number, y: number): [number, number] {
    return [this.lat0 + y / MI_PER_DEG_LAT, this.lon0 + x / this.mpLon];
  }
}

// ---- Geometry helpers (planar, miles) ---------------------------------------

type Pt = [number, number];

function closeRing(ring: Pt[]): Ring {
  if (ring.length === 0) return ring;
  const [fx, fy] = ring[0];
  const [lx, ly] = ring[ring.length - 1];
  return fx === lx && fy === ly ? ring : [...ring, [fx, fy]];
}

function circle(cx: number, cy: number, r: number, segs = CIRCLE_SEGMENTS): Polygon {
  const ring: Pt[] = [];
  for (let i = 0; i < segs; i++) {
    const a = (i / segs) * 2 * Math.PI;
    ring.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]);
  }
  ring.push(ring[0]);
  return [ring];
}

function rectPolygon(b: Bounds, proj: Projection, marginMi = 5): Polygon {
  const [x0, y0] = proj.toXY(b.minLat, b.minLon);
  const [x1, y1] = proj.toXY(b.maxLat, b.maxLon);
  const minX = Math.min(x0, x1) - marginMi;
  const maxX = Math.max(x0, x1) + marginMi;
  const minY = Math.min(y0, y1) - marginMi;
  const maxY = Math.max(y0, y1) + marginMi;
  return [[
    [minX, minY],
    [maxX, minY],
    [maxX, maxY],
    [minX, maxY],
    [minX, minY],
  ]];
}

/**
 * Clip a convex ring by the half-plane of points at least as close to `keep` as
 * to `other` (i.e. `keep`'s side of the perpendicular bisector). Sutherland-
 * Hodgman; the input is assumed convex (our box / running Voronoi cell).
 */
function clipByBisector(ring: Pt[], keep: Pt, other: Pt): Pt[] {
  // Half-plane: points p with (p - mid)·(keep - other) >= 0.
  const nx = keep[0] - other[0];
  const ny = keep[1] - other[1];
  const midx = (keep[0] + other[0]) / 2;
  const midy = (keep[1] + other[1]) / 2;
  const side = (p: Pt): number => (p[0] - midx) * nx + (p[1] - midy) * ny;

  const out: Pt[] = [];
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    const a = ring[i];
    const b = ring[(i + 1) % n];
    const sa = side(a);
    const sb = side(b);
    if (sa >= 0) out.push(a);
    if ((sa >= 0) !== (sb >= 0)) {
      const t = sa / (sa - sb);
      out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
    }
  }
  return out;
}

function bboxOfMultiPolygon(mp: MultiPolygon): Bounds | null {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of mp) {
    for (const [x, y] of poly[0]) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (!Number.isFinite(minX)) return null;
  return { minLat: minY, maxLat: maxY, minLon: minX, maxLon: maxX }; // reused as x/y bounds
}

// ---- Per-question kept-regions ----------------------------------------------

/** Union of disks of radius `r` (mi) around each point, keeping only points
 *  whose disk can reach the running-region bbox (xy-bounds, padded by r). */
function unionDisksXY(pts: Pt[], r: number, keepBox: Bounds | null): MultiPolygon {
  const disks: Polygon[] = [];
  for (const [x, y] of pts) {
    if (
      keepBox &&
      (x < keepBox.minLon - r ||
        x > keepBox.maxLon + r ||
        y < keepBox.minLat - r ||
        y > keepBox.maxLat + r)
    ) {
      continue;
    }
    disks.push(circle(x, y, r, 28));
  }
  if (disks.length === 0) return [];
  if (disks.length === 1) return [disks[0]];
  return polygonClipping.union(disks[0], ...disks.slice(1));
}

/** Voronoi cell of `site` among `sites` (planar), clipped to `box`. */
function voronoiCellXY(site: Pt, sites: Pt[], box: Polygon): Polygon {
  let ring: Pt[] = box[0].slice();
  for (const other of sites) {
    if (other === site) continue;
    if (other[0] === site[0] && other[1] === site[1]) continue;
    ring = clipByBisector(ring, site, other);
    if (ring.length < 3) return [];
  }
  return [closeRing(ring)];
}

const EMPTY: MultiPolygon = [];

/**
 * The kept region (as an XY MultiPolygon) for a single applied step. `runBox` is
 * the xy-bounds of the currently-surviving region, used to prune far features
 * for measuring/coast. `box` is the universe rectangle.
 */
function keptRegionForStep(
  ds: Dataset,
  step: Step,
  proj: Projection,
  box: Polygon,
  runBox: Bounds | null,
): MultiPolygon {
  const boxMP: MultiPolygon = [box];
  const complement = (region: MultiPolygon): MultiPolygon =>
    region.length === 0 ? boxMP : polygonClipping.difference(boxMP, region);

  switch (step.category) {
    case "radar": {
      const [sx, sy] = proj.toXYLoc(step.seeker);
      const r = Number(step.payload);
      const disk: MultiPolygon = [circle(sx, sy, r)];
      return step.answer === true ? disk : complement(disk);
    }
    case "thermometer": {
      if (!step.seekerTo) return boxMP;
      const A = proj.toXYLoc(step.seeker);
      const B = proj.toXYLoc(step.seekerTo);
      if (step.answer === "hotter") return [voronoiHalf(box, B, A)];
      if (step.answer === "colder") return [voronoiHalf(box, A, B)];
      return EMPTY; // "same": measure-zero line -> nothing kept
    }
    case "admin": {
      const polys = ds.admin_polygons[String(step.payload)] ?? [];
      if (polys.length === 0) return boxMP;
      const seekerName = adminContaining(step.seeker, polys);
      const all = adminUnion(polys, proj);
      if (step.answer === "yes") {
        if (seekerName === null) return EMPTY;
        return adminUnion(polys, proj, seekerName);
      }
      if (step.answer === "yes_both_outside") return complement(all);
      // "no"
      if (seekerName !== null) return complement(adminUnion(polys, proj, seekerName));
      return all;
    }
    case "matching": {
      const feats = ds.features_by_kind[String(step.payload)] ?? [];
      if (feats.length === 0) return boxMP;
      const ns = nearestFeature(step.seeker, feats);
      if (ns === null) return boxMP;
      const sites = feats.map((f) => proj.toXY(f.lat, f.lon));
      const siteOfNs = proj.toXY(ns.lat, ns.lon);
      const cell = voronoiCellXY(siteOfNs, sites, box);
      const cellMP: MultiPolygon = cell.length === 0 ? [] : [cell];
      return step.answer === "yes" ? cellMP : complement(cellMP);
    }
    case "measuring": {
      const feats = ds.features_by_kind[String(step.payload)] ?? [];
      if (feats.length === 0) return boxMP;
      const dsMi = nearestDistanceMi(step.seeker, feats);
      if (dsMi === null) return boxMP;
      const pts = feats.map((f) => proj.toXY(f.lat, f.lon));
      const union = unionDisksXY(pts, dsMi, runBox);
      if (step.answer === "closer") return union;
      if (step.answer === "further") return complement(union);
      return EMPTY; // "tie"
    }
    case "coast": {
      const dcMi = coastlineDistanceMi(step.seeker, ds.coastlines);
      if (dcMi === null) return boxMP;
      const pts: Pt[] = [];
      for (const line of ds.coastlines) for (const [lat, lon] of line) pts.push(proj.toXY(lat, lon));
      const union = unionDisksXY(pts, dcMi, runBox);
      if (step.answer === "closer") return union;
      if (step.answer === "further") return complement(union);
      return EMPTY; // "tie"
    }
    default:
      return boxMP;
  }
}

/** Half-plane (as a polygon) of the box on `keep`'s side of the bisector of keep/other. */
function voronoiHalf(box: Polygon, keep: Pt, other: Pt): Polygon {
  const ring = clipByBisector(box[0].slice(), keep, other);
  return ring.length < 3 ? [] : [closeRing(ring)];
}

/** Union of admin polygons (optionally only those named `name`) in XY. */
function adminUnion(polys: readonly AdminPolygon[], proj: Projection, name?: string): MultiPolygon {
  const geoms: Polygon[] = [];
  for (const p of polys) {
    if (name !== undefined && p.name !== name) continue;
    const ring = closeRing(p.ring.map(([lat, lon]) => proj.toXY(lat, lon)));
    geoms.push([ring]);
  }
  if (geoms.length === 0) return [];
  if (geoms.length === 1) return [geoms[0]];
  return polygonClipping.union(geoms[0], ...geoms.slice(1));
}

// Cheap, strongly-constraining questions first so the surviving region shrinks
// before we process measuring/coast (whose feature sets get pruned against it).
const CATEGORY_RANK: Record<string, number> = {
  radar: 0,
  admin: 1,
  thermometer: 2,
  matching: 3,
  measuring: 4,
  coast: 5,
};

/**
 * Compute the eliminated area as exact analytic polygons (a geographic
 * multipolygon of [lat, lon] rings with holes). Empty when no questions applied.
 */
export function computeEliminatedArea(ds: Dataset, engine: EliminationEngine): LatLngMultiPolygon {
  const boundary = ds.boundary;
  if (!boundary || boundary.length === 0) return [];
  const steps = engine.history();
  if (steps.length === 0) return [];

  const b = multiPolygonBounds(boundary);
  if (!Number.isFinite(b.minLat)) return [];
  const proj = new Projection((b.minLat + b.maxLat) / 2, (b.minLon + b.maxLon) / 2);
  const box = rectPolygon(b, proj);

  const boundaryMulti: MultiPolygon = boundary
    .filter((poly) => poly.length > 0 && poly[0].length >= 3)
    .map((poly) => poly.map((ring) => closeRing(ring.map(([lat, lon]) => proj.toXY(lat, lon)))));
  if (boundaryMulti.length === 0) return [];
  let surviving: MultiPolygon = boundaryMulti;

  const ordered = [...steps].sort(
    (s1, s2) => (CATEGORY_RANK[s1.category] ?? 9) - (CATEGORY_RANK[s2.category] ?? 9),
  );

  for (const step of ordered) {
    const runBox = bboxOfMultiPolygon(surviving);
    const kept = keptRegionForStep(ds, step, proj, box, runBox);
    surviving = kept.length === 0 ? [] : polygonClipping.intersection(surviving, kept);
    if (surviving.length === 0) break;
  }

  const eliminated =
    surviving.length === 0 ? boundaryMulti : polygonClipping.difference(boundaryMulti, surviving);
  return unproject(eliminated, proj);
}

function multiPolygonBounds(mp: readonly [number, number][][][]): Bounds {
  let minLat = Infinity;
  let minLon = Infinity;
  let maxLat = -Infinity;
  let maxLon = -Infinity;
  for (const poly of mp) {
    for (const ring of poly) {
      for (const [lat, lon] of ring) {
        if (lat < minLat) minLat = lat;
        if (lat > maxLat) maxLat = lat;
        if (lon < minLon) minLon = lon;
        if (lon > maxLon) maxLon = lon;
      }
    }
  }
  return { minLat, minLon, maxLat, maxLon };
}

function unproject(mp: MultiPolygon, proj: Projection): LatLngMultiPolygon {
  return mp.map((poly) => poly.map((ring) => ring.map(([x, y]) => proj.fromXY(x, y))));
}
