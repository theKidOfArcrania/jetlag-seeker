"""Build the static dataset consumed by the jetlag_seek webapp.

Reuses the verified ``jetlag_mapper`` project to:
  1. Load + merge the Seattle GTFS feeds and build a time-dependent reach index.
  2. Enumerate every transit station reachable from the start station within the
     hiding period on the HIDER's allowed network (the candidate hider universe).
  3. Load the OSM feature context (POIs, admin polygons, coastline).
  4. Emit a single ``public/data/dataset.json`` the client uses to answer questions
     and eliminate candidates entirely offline.

Run with the jetlag_mapper virtualenv (which has ``jetlag`` installed), e.g.::

    ~/git/jetlag_mapper/.venv/bin/python scripts/build_dataset.py

Admin polygons and coastlines are simplified (Douglas-Peucker) to keep the bundle
small while preserving point-in-polygon / distance answers to within a few meters.
"""
from __future__ import annotations

import argparse
import html
import json
import re
import sys
import xml.etree.ElementTree as ET
from pathlib import Path
from urllib.request import urlopen

from shapely.geometry import LineString

from jetlag.config import DEFAULT_CONFIG, GameConfig
from jetlag.osm.features import fetch_all
from jetlag.questions.catalog import (
    MATCHING_FEATURE_KINDS,
    MEASURING_FEATURE_KINDS,
    RADAR_DISTANCES_MI,
    build_question_catalog,
)

# Medium-game thermometer travel distances (miles). See rules summary section 3/4.
THERMOMETER_DISTANCES_MI = (0.5, 3.0, 10.0)

# Simplification tolerances in degrees (~0.0002 deg ~= 22 m).
ADMIN_SIMPLIFY_TOL = 0.0002
COAST_SIMPLIFY_TOL = 0.0002
LINE_SIMPLIFY_TOL = 0.0001  # transit lines want a little more fidelity (~11 m)

# Authoritative game map ("Jetlag the Seattle" Google My Map). It defines the
# hiding boundary (Seattle City Limit), the exact hider transit network + stations,
# and the neighborhood regions used for admin-matching questions. Cached locally.
KML_MID = "1-LHw6acRiIvcYsM6eGUBIMc2OeMi-0g"
KML_URL = f"https://www.google.com/maps/d/kml?mid={KML_MID}&forcekml=1"
KML_NS = {"k": "http://www.opengis.net/kml/2.2"}

# Folders (in the KML) that hold hider network stations + lines. Monorail is
# intentionally excluded per the game rules.
NETWORK_FOLDERS = (
    "1 Line",
    "2 Line (Extension Only)",
    "RapidRide (B, C, D, E, G, H)",
    "Seattle Streetcar",
)
CITY_LIMIT_FOLDER = "Seattle City Limit"
NEIGHBORHOODS_FOLDER = "Seattle Neighborhoods"

# Brand styling for each route family (color, GTFS route_type).
LINE_GREEN = "#28813F"
LINE_BLUE = "#007CAD"
RAPIDRIDE_RED = "#9C182F"
STREETCAR_ORANGE = "#F47836"

COORD_PRECISION = 5  # decimals; ~1.1 m at Seattle's latitude.
DEDUP_TOL_DEG = 0.0006  # ~55 m: collapse opposite-direction / multi-bay stops.

REPO_ROOT = Path(__file__).resolve().parents[1]
OUT_PATH = REPO_ROOT / "public" / "data" / "dataset.json"
KML_CACHE = REPO_ROOT / "public" / "data" / "game_map.kml"


def _round(v: float) -> float:
    return round(float(v), COORD_PRECISION)


def _simplify_ring(ring: list[tuple[float, float]], tol: float) -> list[list[float]]:
    """Simplify a (lat, lon) ring, returning [[lat, lon], ...]."""
    if len(ring) < 3:
        return [[_round(a), _round(b)] for a, b in ring]
    line = LineString([(lon, lat) for lat, lon in ring])  # shapely is (x=lon, y=lat)
    simplified = line.simplify(tol, preserve_topology=False)
    coords = list(simplified.coords)
    if len(coords) < 3:  # over-simplified; fall back to the original ring
        coords = [(lon, lat) for lat, lon in ring]
    return [[_round(lat), _round(lon)] for lon, lat in coords]


def _simplify_polyline(line: list[tuple[float, float]], tol: float) -> list[list[float]]:
    if len(line) < 2:
        return [[_round(a), _round(b)] for a, b in line]
    ls = LineString([(lon, lat) for lat, lon in line]).simplify(tol, preserve_topology=False)
    return [[_round(lat), _round(lon)] for lon, lat in ls.coords]


def _clean_str(v: object) -> str:
    """Coerce a possibly-None value to a trimmed string ('' when missing)."""
    if v is None:
        return ""
    s = str(v).strip()
    return "" if s.lower() == "nan" else s


# ---- KML parsing (authoritative game map) -----------------------------------


def load_kml() -> ET.Element:
    """Return the KML <Document> element, downloading + caching the map once."""
    if not KML_CACHE.exists():
        print(f"Downloading game map KML -> {KML_CACHE} ...")
        KML_CACHE.parent.mkdir(parents=True, exist_ok=True)
        with urlopen(KML_URL) as resp:  # noqa: S310 (trusted Google My Maps URL)
            KML_CACHE.write_bytes(resp.read())
    doc = ET.parse(KML_CACHE).getroot().find("k:Document", KML_NS)
    if doc is None:
        raise RuntimeError("KML has no <Document>")
    return doc


def _txt(el: ET.Element, tag: str) -> str | None:
    x = el.find("k:" + tag, KML_NS)
    if x is None or x.text is None:
        return None
    return html.unescape(x.text)


def _folder(doc: ET.Element, name: str) -> ET.Element:
    for f in doc.findall("k:Folder", KML_NS):
        if _txt(f, "name") == name:
            return f
    raise KeyError(f"KML folder {name!r} not found")


def _parse_coords(text: str) -> list[tuple[float, float]]:
    """Parse a KML <coordinates> string 'lon,lat,alt ...' -> [(lat, lon), ...]."""
    out = []
    for tok in text.split():
        parts = tok.split(",")
        if len(parts) >= 2:
            out.append((float(parts[1]), float(parts[0])))
    return out


def _placemark_geoms(pm: ET.Element, tag: str) -> list[list[tuple[float, float]]]:
    return [_parse_coords(c.text) for c in pm.findall(f".//k:{tag}//k:coordinates", KML_NS) if c.text]


def _point_in_ring(lat: float, lon: float, ring: list[tuple[float, float]]) -> bool:
    inside = False
    n = len(ring)
    j = n - 1
    for i in range(n):
        yi, xi = ring[i]
        yj, xj = ring[j]
        if ((yi > lat) != (yj > lat)) and (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi):
            inside = not inside
        j = i
    return inside


def parse_boundary(doc: ET.Element) -> list[tuple[float, float]]:
    pm = _folder(doc, CITY_LIMIT_FOLDER).find("k:Placemark", KML_NS)
    ring = _placemark_geoms(pm, "Polygon")[0]
    return ring


def _line_meta(folder_name: str, ls_name: str) -> tuple[str, str, int]:
    """Map a KML LineString to (route display name, color, route_type)."""
    if folder_name == "1 Line":
        return "1 Line", LINE_GREEN, 0
    if folder_name.startswith("2 Line"):
        return "2 Line", LINE_BLUE, 0
    if folder_name.startswith("RapidRide"):
        m = re.search(r"RapidRide\s+(\w)\s+Line", ls_name or "")
        letter = m.group(1) if m else "?"
        return f"RapidRide {letter} Line", RAPIDRIDE_RED, 3
    if folder_name == "Seattle Streetcar":
        base = (ls_name or "Streetcar").split(":", 1)[0].strip()
        return base, STREETCAR_ORANGE, 0
    return folder_name, "#444444", 3


def parse_transit_lines(doc: ET.Element) -> list[dict]:
    """Group every network LineString into one polyline-set per route so branches
    and both directions are drawn (fixes partial routes like the B Line)."""
    grouped: dict[str, dict] = {}
    for folder_name in NETWORK_FOLDERS:
        folder = _folder(doc, folder_name)
        for pm in folder.findall("k:Placemark", KML_NS):
            segs = _placemark_geoms(pm, "LineString")
            if not segs:
                continue
            name, color, rtype = _line_meta(folder_name, _txt(pm, "name"))
            entry = grouped.setdefault(
                name, {"name": name, "color": color, "route_type": rtype, "segments": []}
            )
            for seg in segs:
                entry["segments"].append(_simplify_polyline(seg, LINE_SIMPLIFY_TOL))
    lines = sorted(grouped.values(), key=lambda d: d["name"])
    return lines


def _clean_station_name(name: str) -> str:
    name = re.sub(r"\s*-\s*Bay\s*\d+.*$", "", name or "").strip()
    name = re.sub(r"\s*\(.*?\)\s*$", "", name).strip()
    return name


def parse_candidates(doc: ET.Element, boundary: list[tuple[float, float]]) -> list[dict]:
    """Every hider-network station Point inside the city limit, deduped by name +
    proximity (collapsing opposite-direction and multi-bay stops)."""
    raw: list[tuple[str, float, float]] = []
    for folder_name in NETWORK_FOLDERS:
        for pm in _folder(doc, folder_name).findall("k:Placemark", KML_NS):
            pts = _placemark_geoms(pm, "Point")
            if not pts:
                continue
            lat, lon = pts[0][0]  # first (and only) coordinate of the Point
            if not _point_in_ring(lat, lon, boundary):
                continue
            raw.append((_clean_station_name(_txt(pm, "name") or ""), lat, lon))

    # Cluster points sharing a cleaned name within DEDUP_TOL_DEG into one station.
    clusters: list[dict] = []
    for name, lat, lon in raw:
        hit = None
        for c in clusters:
            if c["name"] == name and abs(c["lat"] - lat) < DEDUP_TOL_DEG and abs(c["lon"] - lon) < DEDUP_TOL_DEG:
                hit = c
                break
        if hit:
            hit["lats"].append(lat)
            hit["lons"].append(lon)
        else:
            clusters.append({"name": name, "lat": lat, "lon": lon, "lats": [lat], "lons": [lon]})

    candidates = []
    used_ids: set[str] = set()
    for c in sorted(clusters, key=lambda c: c["name"]):
        lat = sum(c["lats"]) / len(c["lats"])
        lon = sum(c["lons"]) / len(c["lons"])
        slug = re.sub(r"[^a-z0-9]+", "-", c["name"].lower()).strip("-") or "stop"
        sid = slug
        n = 2
        while sid in used_ids:
            sid = f"{slug}-{n}"
            n += 1
        used_ids.add(sid)
        candidates.append({"id": sid, "name": c["name"], "lat": _round(lat), "lon": _round(lon)})
    return candidates


def parse_admin_regions(doc: ET.Element, boundary: list[tuple[float, float]]) -> dict[str, list[dict]]:
    """Three nested matching tiers from the map: city (the whole Seattle City Limit),
    neighborhood (the 20 'District' groupings), and neighborhood_region (the 94 fine
    'District - Neighborhood' polygons)."""
    neigh_pms = _folder(doc, NEIGHBORHOODS_FOLDER).findall("k:Placemark", KML_NS)

    regions: list[dict] = []  # {"district": str, "full": str, "ring": [...]}
    for pm in neigh_pms:
        full = _txt(pm, "name") or ""
        district = full.split(" - ", 1)[0].strip() if " - " in full else full.strip()
        for ring in _placemark_geoms(pm, "Polygon"):
            regions.append({"district": district, "full": full, "ring": ring})

    city = [{"name": "Seattle", "ring": _simplify_ring(boundary, ADMIN_SIMPLIFY_TOL)}]
    # District-level: same fine polygons, renamed to their district so point-in-polygon
    # returns the coarse grouping ("same neighborhood?" == same district).
    neighborhood = [
        {"name": r["district"], "ring": _simplify_ring(r["ring"], ADMIN_SIMPLIFY_TOL)} for r in regions
    ]
    neighborhood_region = [
        {"name": r["full"], "ring": _simplify_ring(r["ring"], ADMIN_SIMPLIFY_TOL)} for r in regions
    ]
    return {
        "city": city,
        "neighborhood": neighborhood,
        "neighborhood_region": neighborhood_region,
    }



def build(cfg: GameConfig) -> dict:
    doc = load_kml()
    print("Parsing authoritative game map (KML)...")

    boundary = parse_boundary(doc)
    candidates = parse_candidates(doc, boundary)
    print(f"Candidate stations (inside city limit): {len(candidates)}")

    transit_lines = parse_transit_lines(doc)
    print(f"Transit lines (hider network): {len(transit_lines)} "
          f"({', '.join(l['name'] for l in transit_lines)})")

    admin_polygons = parse_admin_regions(doc, boundary)
    print("Admin tiers: " + ", ".join(f"{k}={len(v)}" for k, v in admin_polygons.items()))

    # Start station (Symphony) from the parsed candidates; fall back to the known
    # Sound Transit coordinate if the map ever renames it.
    start = next((c for c in candidates if c["name"].lower().startswith("symphony")), None)
    start_lat, start_lon = (start["lat"], start["lon"]) if start else (47.607246, -122.335754)

    print("Loading OSM context (POIs + coastline) ...")
    ctx = fetch_all()
    features_by_kind = {
        kind: [
            {"id": f.osm_id, "name": f.name, "lat": _round(f.lat), "lon": _round(f.lon)}
            for f in feats
        ]
        for kind, feats in ctx.features_by_kind.items()
    }
    coastlines = [_simplify_polyline(ln, COAST_SIMPLIFY_TOL) for ln in ctx.coastlines]

    # Question catalog: keep the verified non-admin questions from jetlag; replace
    # the OSM admin-level questions with the map's three nested matching tiers.
    catalog = [
        {"category": q.category, "name": q.name, "payload": q.payload}
        for q in build_question_catalog()
        if q.category != "admin"
    ]
    catalog += [
        {"category": "admin", "name": "Same city", "payload": "city"},
        {"category": "admin", "name": "Same neighborhood", "payload": "neighborhood"},
        {"category": "admin", "name": "Same neighborhood region", "payload": "neighborhood_region"},
    ]

    return {
        "config": {
            "start_station_name": cfg.start_station_name,
            "start_lat": start_lat,
            "start_lon": start_lon,
            "hiding_period_min": cfg.hiding_period_min,
            "zone_radius_mi": cfg.zone_radius_mi,
            "radar_bands_mi": list(RADAR_DISTANCES_MI),
            "thermometer_bands_mi": list(THERMOMETER_DISTANCES_MI),
            "measuring_kinds": list(MEASURING_FEATURE_KINDS),
            "matching_kinds": list(MATCHING_FEATURE_KINDS),
            "admin_regions": ["city", "neighborhood", "neighborhood_region"],
        },
        "candidates": candidates,
        "features_by_kind": features_by_kind,
        "admin_polygons": admin_polygons,
        "coastlines": coastlines,
        "boundary": _simplify_ring(boundary, ADMIN_SIMPLIFY_TOL),
        "question_catalog": catalog,
        "transit_lines": transit_lines,
    }


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--budget", type=int, default=DEFAULT_CONFIG.hiding_period_min)
    ap.add_argument("--origin", default=DEFAULT_CONFIG.start_station_name)
    ap.add_argument("--out", default=str(OUT_PATH))
    args = ap.parse_args()

    cfg = GameConfig(start_station_name=args.origin, hiding_period_min=args.budget)
    dataset = build(cfg)

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(dataset, separators=(",", ":")))
    size_kb = out.stat().st_size / 1024
    n_feat = sum(len(v) for v in dataset["features_by_kind"].values())
    print(
        f"Wrote {out} ({size_kb:.0f} KB): {len(dataset['candidates'])} candidates, "
        f"{n_feat} features, {len(dataset['question_catalog'])} questions"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
