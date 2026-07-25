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
import type { EliminationEngine, Step, StepSpec } from "./engine";
import type { Answer } from "./answers";
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
 *  whose disk can reach the running-region bbox (xy-bounds, padded by r).
 *
 *  Points are spatially bucketed (cell ~4r) so each local union stays small and
 *  distant buckets never interact; the bucket blobs are then unioned. This is
 *  exact — the result is identical to unioning every disk at once — but several
 *  times faster for large, spread-out point sets (coastline vertices, parks). */
function unionDisksXY(pts: Pt[], r: number, keepBox: Bounds | null): MultiPolygon {
  const kept: Pt[] = [];
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
    kept.push([x, y]);
  }
  if (kept.length === 0) return [];
  if (kept.length === 1) return [circle(kept[0][0], kept[0][1], r, 28)];

  const cell = Math.max(r * 4, 1e-6);
  const buckets = new Map<string, Pt[]>();
  for (const p of kept) {
    const k = `${Math.floor(p[0] / cell)},${Math.floor(p[1] / cell)}`;
    let arr = buckets.get(k);
    if (!arr) buckets.set(k, (arr = []));
    arr.push(p);
  }

  const blobs: MultiPolygon[] = [];
  for (const grp of buckets.values()) {
    const disks = grp.map(([x, y]) => circle(x, y, r, 28));
    blobs.push(disks.length === 1 ? [disks[0]] : polygonClipping.union(disks[0], ...disks.slice(1)));
  }
  if (blobs.length === 1) return blobs[0];
  return polygonClipping.union(blobs[0], ...blobs.slice(1));
}

/**
 * Kept region for a "closer/further to a border" measuring question, built as a
 * smooth iso-distance contour via marching squares rather than a union of
 * per-vertex disks.
 *
 * A border (coastline, and later international / administrative borders) has
 * ~2400 vertices. Unioning a disk of radius `d` (the seeker's distance to the
 * border) around every one of them is slow, and when the seeker sits far from
 * the border (e.g. on the Eastside, ~10mi from Puget Sound) the huge overlapping
 * disks overwhelmed polygon-clipping and threw "infinite loop when passing sweep
 * line over endpoints". Instead we rasterise: sample the signed distance
 * `dist(border) - d` on a fine grid of corners (accelerated by a spatial hash
 * with a distance-bounded search so far corners are cheap), then trace the
 * `f == 0` contour with marching squares, linearly interpolating each crossing
 * so the boundary is a smooth diagonal curve rather than a rectilinear
 * staircase. Robust and fast (<400ms) at any distance, reusable for the other
 * border questions.
 *
 * A one-corner "guard ring" around the sampled box is forced to read as outside
 * the kept region, so every region closes with a real contour inside the padded
 * box and `closer`/`further` (which share the same `f == 0` curve but fill
 * opposite sides) come out correctly. `closer` keeps within `d`, else beyond.
 */
function borderDistanceRegion(vertsXY: Pt[], d: number, closer: boolean, box: Polygon): MultiPolygon {
  if (vertsXY.length === 0) return closer ? [] : [box];

  // Spatial hash of border vertices for a distance-bounded nearest-vertex query.
  const BIN = 1.0; // miles
  const index = new Map<string, Pt[]>();
  for (const p of vertsXY) {
    const k = `${Math.floor(p[0] / BIN)},${Math.floor(p[1] / BIN)}`;
    let arr = index.get(k);
    if (!arr) index.set(k, (arr = []));
    arr.push(p);
  }
  // Distance to the nearest border vertex, capped at `cap` (far corners return
  // the cap — fine, since only the sign of `dist - d` matters away from the
  // contour, and the Lipschitz-1 distance keeps corners near the contour exact).
  const boundedDist = (px: number, py: number, cap: number): number => {
    const cx = Math.floor(px / BIN);
    const cy = Math.floor(py / BIN);
    let best = cap;
    const maxR = Math.ceil(cap / BIN) + 2;
    for (let r = 0; r <= maxR; r++) {
      for (let gx = cx - r; gx <= cx + r; gx++) {
        for (let gy = cy - r; gy <= cy + r; gy++) {
          if (Math.max(Math.abs(gx - cx), Math.abs(gy - cy)) !== r) continue; // shell only
          const arr = index.get(`${gx},${gy}`);
          if (!arr) continue;
          for (const [x, y] of arr) {
            const dx = x - px;
            const dy = y - py;
            const dd = Math.sqrt(dx * dx + dy * dy);
            if (dd < best) best = dd;
          }
        }
      }
      if ((r - 1) * BIN > best) break; // no unchecked bin can hold a nearer vertex
    }
    return best;
  };

  // Universe box extent.
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of box[0]) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }

  const cell = Math.min(Math.max(d * 0.1, 0.05), 0.2);
  const nx = Math.max(2, Math.ceil((x1 - x0) / cell) + 1); // corner columns
  const ny = Math.max(2, Math.ceil((y1 - y0) / cell) + 1); // corner rows
  const cap = d + 2 * cell + 0.001;

  // Signed-distance samples at every corner.
  const val = new Float64Array(nx * ny);
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) val[j * nx + i] = boundedDist(x0 + i * cell, y0 + j * cell, cap);
  }
  // Guard ring: force the outermost corners to read as outside the kept region.
  const guard = closer ? d + 1000 : -1000;
  for (let i = 0; i < nx; i++) {
    val[i] = guard;
    val[(ny - 1) * nx + i] = guard;
  }
  for (let j = 0; j < ny; j++) {
    val[j * nx] = guard;
    val[j * nx + (nx - 1)] = guard;
  }

  // f = dist - d for `closer`, negated for `further`; inside the kept region is f <= 0.
  const f = (i: number, j: number): number => (closer ? val[j * nx + i] - d : d - val[j * nx + i]);
  const inside = (v: number): boolean => v <= 0;
  const cx = (i: number): number => x0 + i * cell;
  const cy = (j: number): number => y0 + j * cell;
  // Interpolated f==0 crossing on the edge between corners (ia,ja) and (ib,jb).
  const lerp = (ia: number, ja: number, ib: number, jb: number): Pt => {
    const fa = f(ia, ja);
    const fb = f(ib, jb);
    let t = fa / (fa - fb);
    if (!Number.isFinite(t)) t = 0.5;
    t = Math.max(0, Math.min(1, t));
    return [cx(ia) + t * (cx(ib) - cx(ia)), cy(ja) + t * (cy(jb) - cy(ja))];
  };

  // Per-edge crossing points, keyed so adjacent cells share the same node.
  const HK = (i: number, j: number): string => `H_${i}_${j}`; // horizontal edge (i,j)-(i+1,j)
  const VK = (i: number, j: number): string => `V_${i}_${j}`; // vertical edge (i,j)-(i,j+1)
  const ptOf = new Map<string, Pt>();
  const adj = new Map<string, string[]>();
  const link = (a: string, b: string): void => {
    let la = adj.get(a);
    if (!la) adj.set(a, (la = []));
    la.push(b);
    let lb = adj.get(b);
    if (!lb) adj.set(b, (lb = []));
    lb.push(a);
  };

  for (let j = 0; j < ny - 1; j++) {
    for (let i = 0; i < nx - 1; i++) {
      const fBL = f(i, j);
      const fBR = f(i + 1, j);
      const fTR = f(i + 1, j + 1);
      const fTL = f(i, j + 1);
      const bBL = inside(fBL);
      const bBR = inside(fBR);
      const bTR = inside(fTR);
      const bTL = inside(fTL);
      const c = (bBL ? 1 : 0) | (bBR ? 2 : 0) | (bTR ? 4 : 0) | (bTL ? 8 : 0);
      if (c === 0 || c === 15) continue;
      const eB = HK(i, j);
      const eT = HK(i, j + 1);
      const eL = VK(i, j);
      const eR = VK(i + 1, j);
      if (!ptOf.has(eB) && bBL !== bBR) ptOf.set(eB, lerp(i, j, i + 1, j));
      if (!ptOf.has(eT) && bTL !== bTR) ptOf.set(eT, lerp(i, j + 1, i + 1, j + 1));
      if (!ptOf.has(eL) && bBL !== bTL) ptOf.set(eL, lerp(i, j, i, j + 1));
      if (!ptOf.has(eR) && bBR !== bTR) ptOf.set(eR, lerp(i + 1, j, i + 1, j + 1));
      const conn: [string, string][] = [];
      switch (c) {
        case 1: case 14: conn.push([eL, eB]); break;
        case 2: case 13: conn.push([eB, eR]); break;
        case 3: case 12: conn.push([eL, eR]); break;
        case 4: case 11: conn.push([eR, eT]); break;
        case 6: case 9: conn.push([eB, eT]); break;
        case 7: case 8: conn.push([eL, eT]); break;
        case 5: {
          const centre = inside((fBL + fBR + fTR + fTL) / 4);
          if (centre) { conn.push([eL, eT], [eB, eR]); } else { conn.push([eL, eB], [eR, eT]); }
          break;
        }
        case 10: {
          const centre = inside((fBL + fBR + fTR + fTL) / 4);
          if (centre) { conn.push([eB, eL], [eT, eR]); } else { conn.push([eB, eR], [eT, eL]); }
          break;
        }
      }
      for (const [a, b] of conn) if (ptOf.has(a) && ptOf.has(b)) link(a, b);
    }
  }
  if (adj.size === 0) return closer ? [] : [box];

  // Walk linked crossings into closed loops.
  const visited = new Set<string>();
  const rings: Ring[] = [];
  for (const start of adj.keys()) {
    if (visited.has(start)) continue;
    const loop: string[] = [];
    let cur = start;
    let prev = "";
    for (let g = 0; g < adj.size + 5; g++) {
      loop.push(cur);
      visited.add(cur);
      const nbrs = adj.get(cur) || [];
      let next = nbrs.find((n) => n !== prev && !visited.has(n));
      if (next === undefined) {
        next = nbrs.find((n) => n === start && loop.length > 2);
        if (next === undefined) break;
      }
      prev = cur;
      cur = next;
      if (cur === start) break;
    }
    if (loop.length >= 3) rings.push(loop.map((k) => ptOf.get(k)!));
  }
  if (rings.length === 0) return closer ? [] : [box];

  // Even-odd nesting: rings at even containment depth are outers, odd are holes.
  const pip = (r: Ring, p: Pt): boolean => {
    let ins = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const xi = r[i][0];
      const yi = r[i][1];
      const xj = r[j][0];
      const yj = r[j][1];
      if (yi > p[1] !== yj > p[1] && p[0] < ((xj - xi) * (p[1] - yi)) / (yj - yi) + xi) ins = !ins;
    }
    return ins;
  };
  const depthOf = (r: Ring): number => {
    let dp = 0;
    const p = r[0];
    for (const o of rings) {
      if (o === r) continue;
      if (pip(o, p)) dp++;
    }
    return dp;
  };
  const polys: Polygon[] = [];
  const holes: Ring[] = [];
  for (const r of rings) {
    if (depthOf(r) % 2 === 0) polys.push([r]);
    else holes.push(r);
  }
  for (const h of holes) {
    for (const poly of polys) {
      if (pip(poly[0], h[0])) {
        poly.push(h);
        break;
      }
    }
  }
  return polys;
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
      if (step.answer !== "closer" && step.answer !== "further") return EMPTY; // "tie"
      const pts: Pt[] = [];
      for (const line of ds.coastlines) for (const [lat, lon] of line) pts.push(proj.toXY(lat, lon));
      return borderDistanceRegion(pts, dcMi, step.answer === "closer", box);
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
  const steps = engine.history();
  if (steps.length === 0) return [];
  const ctx = areaContext(ds);
  if (!ctx) return [];

  const surviving = survivingRegion(ds, steps, ctx);
  const eliminated =
    surviving.length === 0
      ? ctx.boundaryMulti
      : polygonClipping.difference(ctx.boundaryMulti, surviving);
  return unproject(eliminated, ctx.proj);
}

/**
 * The *incremental* area that answering `spec` with `answer` would eliminate, on
 * top of the already-applied steps: the currently-surviving region minus the
 * region that would still survive after the hypothetical step. Powers the Ask-tab
 * preview shading. Empty when nothing new would be eliminated.
 */
export function computePreviewEliminatedArea(
  ds: Dataset,
  engine: EliminationEngine,
  spec: StepSpec,
  answer: Answer,
): LatLngMultiPolygon {
  const ctx = areaContext(ds);
  if (!ctx) return [];

  const current = survivingRegion(ds, engine.history(), ctx);
  if (current.length === 0) return [];

  const step: Step = { ...spec, id: "__preview__", label: "", answer };
  const runBox = bboxOfMultiPolygon(current);
  const kept = keptRegionForStep(ds, step, ctx.proj, ctx.box, runBox);
  const previewSurviving =
    kept.length === 0 ? [] : polygonClipping.intersection(current, kept);
  const eliminated =
    previewSurviving.length === 0 ? current : polygonClipping.difference(current, previewSurviving);
  return unproject(eliminated, ctx.proj);
}

interface AreaContext {
  proj: Projection;
  box: Polygon;
  boundaryMulti: MultiPolygon;
}

/** Shared projection + universe rectangle + projected boundary multipolygon. */
function areaContext(ds: Dataset): AreaContext | null {
  const boundary = ds.boundary;
  if (!boundary || boundary.length === 0) return null;

  const b = multiPolygonBounds(boundary);
  if (!Number.isFinite(b.minLat)) return null;
  const proj = new Projection((b.minLat + b.maxLat) / 2, (b.minLon + b.maxLon) / 2);
  const box = rectPolygon(b, proj);

  const boundaryMulti: MultiPolygon = boundary
    .filter((poly) => poly.length > 0 && poly[0].length >= 3)
    .map((poly) => poly.map((ring) => closeRing(ring.map(([lat, lon]) => proj.toXY(lat, lon)))));
  if (boundaryMulti.length === 0) return null;
  return { proj, box, boundaryMulti };
}

/** Intersect the boundary with every step's kept region -> the surviving region. */
function survivingRegion(ds: Dataset, steps: readonly Step[], ctx: AreaContext): MultiPolygon {
  let surviving: MultiPolygon = ctx.boundaryMulti;
  const ordered = [...steps].sort(
    (s1, s2) => (CATEGORY_RANK[s1.category] ?? 9) - (CATEGORY_RANK[s2.category] ?? 9),
  );
  for (const step of ordered) {
    const runBox = bboxOfMultiPolygon(surviving);
    const kept = keptRegionForStep(ds, step, ctx.proj, ctx.box, runBox);
    surviving = kept.length === 0 ? [] : polygonClipping.intersection(surviving, kept);
    if (surviving.length === 0) break;
  }
  return surviving;
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
