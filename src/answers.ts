// Question answerers. Ported 1:1 from jetlag_mapper's
// jetlag/questions/catalog.py so the client's elimination logic matches the
// reference optimizer exactly. Radar returns a boolean; every other category
// returns a string token (matching Python's return types, incl. the NULL
// sentinel), so JSON parity fixtures compare exactly.
//
// Thermometer is added here (client-only; not in the Python fingerprint catalog)
// because the app supports the seeker physically moving between two points.

import { distMi, haversineMi, pointInPolygon } from "./geometry";
import type { AdminPolygon, Dataset, Feature, LatLon, QuestionSpec } from "./types";

export const NULL = "_null_";

export type Answer = boolean | string;

export function nearestFeature(loc: LatLon, feats: readonly Feature[]): Feature | null {
  if (feats.length === 0) return null;
  let best = feats[0];
  let bestD = haversineMi(loc.lat, loc.lon, best.lat, best.lon);
  for (let i = 1; i < feats.length; i++) {
    const f = feats[i];
    const d = haversineMi(loc.lat, loc.lon, f.lat, f.lon);
    if (d < bestD) {
      bestD = d;
      best = f;
    }
  }
  return best;
}

export function nearestDistanceMi(loc: LatLon, feats: readonly Feature[]): number | null {
  const f = nearestFeature(loc, feats);
  if (f === null) return null;
  return haversineMi(loc.lat, loc.lon, f.lat, f.lon);
}

// ---- Radar ------------------------------------------------------------------

export function radarAnswer(hider: LatLon, seeker: LatLon, distMiThreshold: number): boolean {
  return distMi(hider, seeker) <= distMiThreshold;
}

// ---- Measuring (closer/further to nearest feature) --------------------------

export function measuringAnswer(
  hider: LatLon,
  seeker: LatLon,
  feats: readonly Feature[],
): string {
  if (feats.length === 0) return NULL;
  const dh = nearestDistanceMi(hider, feats);
  const ds = nearestDistanceMi(seeker, feats);
  if (dh === null || ds === null) return NULL;
  if (Math.abs(dh - ds) < 1e-6) return "tie";
  return dh < ds ? "closer" : "further";
}

// ---- Measuring (closer/further to nearest coastline vertex) -----------------

function nearestPointOnPolylineMi(pt: LatLon, line: readonly [number, number][]): number {
  let best = Infinity;
  for (const [qlat, qlon] of line) {
    const d = haversineMi(pt.lat, pt.lon, qlat, qlon);
    if (d < best) best = d;
  }
  return best;
}

export function coastlineDistanceMi(
  loc: LatLon,
  coastlines: readonly [number, number][][],
): number | null {
  if (coastlines.length === 0) return null;
  let best = Infinity;
  for (const ln of coastlines) {
    const d = nearestPointOnPolylineMi(loc, ln);
    if (d < best) best = d;
  }
  return best;
}

export function measuringCoastlineAnswer(
  hider: LatLon,
  seeker: LatLon,
  coastlines: readonly [number, number][][],
): string {
  if (coastlines.length === 0) return NULL;
  const dh = coastlineDistanceMi(hider, coastlines);
  const ds = coastlineDistanceMi(seeker, coastlines);
  if (dh === null || ds === null) return NULL;
  if (Math.abs(dh - ds) < 1e-6) return "tie";
  return dh < ds ? "closer" : "further";
}

// ---- Matching (same nearest feature) ----------------------------------------

export function matchingAnswer(
  hider: LatLon,
  seeker: LatLon,
  feats: readonly Feature[],
): string {
  if (feats.length === 0) return NULL;
  const nh = nearestFeature(hider, feats);
  const ns = nearestFeature(seeker, feats);
  if (nh === null || ns === null) return NULL;
  return nh.id === ns.id ? "yes" : "no";
}

// ---- Matching by admin polygon ----------------------------------------------

export function adminContaining(pt: LatLon, polygons: readonly AdminPolygon[]): string | null {
  for (const poly of polygons) {
    if (pointInPolygon(pt, poly.ring)) return poly.name;
  }
  return null;
}

export function matchingAdminAnswer(
  hider: LatLon,
  seeker: LatLon,
  polygons: readonly AdminPolygon[],
): string {
  if (polygons.length === 0) return NULL;
  const nh = adminContaining(hider, polygons);
  const ns = adminContaining(seeker, polygons);
  if (nh === null && ns === null) return "yes_both_outside";
  if (nh === null || ns === null) return "no";
  return nh === ns ? "yes" : "no";
}

// ---- Thermometer (client-only) ----------------------------------------------
// Seeker travels from `from` to `to`; "hotter" if they got closer to the hider.

export function thermometerAnswer(hider: LatLon, from: LatLon, to: LatLon): string {
  const dFrom = distMi(hider, from);
  const dTo = distMi(hider, to);
  if (Math.abs(dTo - dFrom) < 1e-6) return "same";
  return dTo < dFrom ? "hotter" : "colder";
}

// ---- Dispatch ---------------------------------------------------------------
// Mirrors answer_question() in catalog.py. `thermometer` is handled by the
// engine directly (needs two seeker points) and is not dispatched here.

export function answerQuestion(
  q: QuestionSpec,
  hider: LatLon,
  seeker: LatLon,
  ds: Dataset,
): Answer {
  switch (q.category) {
    case "radar":
      return radarAnswer(hider, seeker, Number(q.payload));
    case "measuring":
      return measuringAnswer(hider, seeker, ds.features_by_kind[String(q.payload)] ?? []);
    case "coast":
      return measuringCoastlineAnswer(hider, seeker, ds.coastlines);
    case "matching":
      return matchingAnswer(hider, seeker, ds.features_by_kind[String(q.payload)] ?? []);
    case "admin":
      return matchingAdminAnswer(hider, seeker, ds.admin_polygons[String(q.payload)] ?? []);
    default:
      throw new Error(`answerQuestion: unsupported category ${q.category}`);
  }
}
