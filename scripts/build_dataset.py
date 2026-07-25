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

from shapely.geometry import LineString, MultiPolygon
from shapely.geometry import Point as ShapelyPoint
from shapely.geometry import Polygon as ShapelyPolygon
from shapely.geometry.base import BaseGeometry
from shapely.ops import unary_union
from shapely.prepared import prep

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

# Hand-curated feature locations to add on top of the OSM-derived POIs, keyed by
# feature kind. Each entry is (name, lat, lon, id). Use for game-specific spots
# that OSM doesn't tag the way the game counts them (e.g. Boeing Field, which OSM
# marks non-commercial, or small/bespoke "zoos"/"aquariums"). They are merged in
# before the play-region filter, so any that fall outside the boundary are
# dropped with a warning just like OSM features.
MANUAL_FEATURES: dict[str, list[tuple[str, float, float, str]]] = {
    "zoo": [
        ("Ballard Mallards", 47.6764752, -122.3833345, "manual/ballard-mallards"),
    ],
    "aquarium": [
        ("Aquatic Enterprises Inc", 47.5671742, -122.3543913, "manual/aquatic-enterprises"),
        ("Tanks and Beyond", 47.6006742, -122.3351764, "manual/tanks-and-beyond"),
        ("FishTanks4u", 47.6367866, -122.3411615, "manual/fishtanks4u"),
    ],
    "airport": [
        ("Boeing Field", 47.5414813, -122.3197907, "relation/537472"),
    ],
}

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
# Light-rail (Link) folders only. Their stations become the "rail_station"
# measuring feature kind ("closest rail station" uses light rail per game rules).
LIGHT_RAIL_FOLDERS = (
    "1 Line",
    "2 Line (Extension Only)",
)
CITY_LIMIT_FOLDER = "Seattle City Limit"
NEIGHBORHOODS_FOLDER = "Seattle Neighborhoods"

# Eastside extension: the play region also covers the cities the 2 Line + B Line
# reach (Bellevue, Redmond, Mercer Island). Bellevue/Redmond boundaries come from
# the KML's zip-code polygons; Mercer Island (absent from the KML) comes from OSM.
EASTSIDE_ZIP_FOLDER = "Bellevue/Redmond Zip Codes"
CITY_BY_ZIP = {
    "98004": "Bellevue",
    "98005": "Bellevue",
    "98007": "Bellevue",
    "98008": "Bellevue",
    "98052": "Redmond",
}
MERCER_ISLAND_NAME = "Mercer Island"  # OSM admin_level=8 city name
OSM_CITY_ADMIN_LEVEL = 8

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


def parse_boundary(doc: ET.Element) -> list[tuple[float, float]]:
    pm = _folder(doc, CITY_LIMIT_FOLDER).find("k:Placemark", KML_NS)
    ring = _placemark_geoms(pm, "Polygon")[0]
    return ring


# ---- Play region (Seattle + Eastside extension) -----------------------------


def _ring_to_shapely(ring: list[tuple[float, float]]) -> ShapelyPolygon:
    """(lat, lon) ring -> shapely Polygon in (x=lon, y=lat) coords."""
    return ShapelyPolygon([(lon, lat) for lat, lon in ring])


def _iter_polygons(geom: BaseGeometry):
    """Yield each simple Polygon of a Polygon/MultiPolygon geometry."""
    if isinstance(geom, MultiPolygon):
        yield from geom.geoms
    elif isinstance(geom, ShapelyPolygon):
        yield geom
    # ignore empty / non-polygonal geometries


def _shapely_to_latlon_multipolygon(
    geom: BaseGeometry, tol: float, min_hole_area: float = 1e-5
) -> list[list[list[list[float]]]]:
    """Convert a (Multi)Polygon to a simplified geographic multipolygon:
    polygons -> rings (exterior first, then holes) -> [lat, lon]. Sub-threshold
    holes (slivers left where zip polygons don't perfectly tile) are dropped."""
    out: list[list[list[list[float]]]] = []
    for poly in _iter_polygons(geom):
        rings = [poly.exterior] + [r for r in poly.interiors if ShapelyPolygon(r).area >= min_hole_area]
        latlon_rings = [
            _simplify_ring([(lat, lon) for lon, lat in ring.coords], tol) for ring in rings
        ]
        out.append(latlon_rings)
    return out


def _reconstruct_ring(points: list[tuple[float, float]]) -> ShapelyPolygon:
    """OSM relation boundaries arrive as unordered concatenated ways, so build a
    clean ring by nearest-neighbour chaining the (deduped) vertices. Falls back to
    the convex hull if the chain self-intersects."""
    from shapely.geometry import MultiPoint

    pts = list(dict.fromkeys(points))  # dedup, preserve first-seen order
    remaining = pts[:]
    chain = [remaining.pop(0)]
    while remaining:
        la, lo = chain[-1]
        j = min(range(len(remaining)), key=lambda k: (remaining[k][0] - la) ** 2 + (remaining[k][1] - lo) ** 2)
        chain.append(remaining.pop(j))
    poly = ShapelyPolygon([(lon, lat) for lat, lon in chain]).buffer(0)
    if poly.geom_type != "Polygon" or poly.is_empty:
        poly = MultiPoint([(lon, lat) for lat, lon in pts]).convex_hull
    return poly


def _eastside_zip_polygons(doc: ET.Element) -> list[tuple[str, str, ShapelyPolygon]]:
    """Return (city, zip_code, polygon) for each Bellevue/Redmond zip placemark
    polygon (a placemark may hold several polygons)."""
    out: list[tuple[str, str, ShapelyPolygon]] = []
    for pm in _folder(doc, EASTSIDE_ZIP_FOLDER).findall("k:Placemark", KML_NS):
        zip_code = (_txt(pm, "name") or "").strip()
        city = CITY_BY_ZIP.get(zip_code)
        if not city:
            continue
        for ring in _placemark_geoms(pm, "Polygon"):
            out.append((city, zip_code, _ring_to_shapely(ring).buffer(0)))
    return out


def _mercer_island_polygon(ctx) -> BaseGeometry | None:
    """Mercer Island's boundary from OSM (absent from the KML); reassembled from
    the relation's unordered ways into a clean ring."""
    for name, ring in ctx.admin_polygons.get(OSM_CITY_ADMIN_LEVEL, []):
        if name == MERCER_ISLAND_NAME and len(ring) >= 4:
            return _reconstruct_ring(ring)
    return None


def build_city_polygons(doc: ET.Element, ctx) -> list[tuple[str, BaseGeometry]]:
    """Return (city_name, shapely geometry) for every city in the play region:
    Seattle (KML city limit), Bellevue + Redmond (KML zip polygons unioned per
    city), and Mercer Island (OSM, reassembled)."""
    cities: list[tuple[str, BaseGeometry]] = [("Seattle", _ring_to_shapely(parse_boundary(doc)).buffer(0))]

    by_city: dict[str, list[ShapelyPolygon]] = {}
    for city, _zip, poly in _eastside_zip_polygons(doc):
        by_city.setdefault(city, []).append(poly)
    for city, polys in by_city.items():
        cities.append((city, unary_union(polys)))

    mercer = _mercer_island_polygon(ctx)
    if mercer is not None:
        cities.append((MERCER_ISLAND_NAME, mercer))

    return cities


def build_eastside_neighborhoods(doc: ET.Element, ctx) -> list[tuple[str, BaseGeometry]]:
    """Finer 'neighborhood'-tier entries for the Eastside: each Bellevue/Redmond
    zip code on its own (e.g. "Bellevue 98004"), plus Mercer Island as a single
    neighborhood. (The Eastside has no data finer than zips.)"""
    by_zip: dict[tuple[str, str], list[ShapelyPolygon]] = {}
    for city, zip_code, poly in _eastside_zip_polygons(doc):
        by_zip.setdefault((city, zip_code), []).append(poly)

    out: list[tuple[str, BaseGeometry]] = []
    for (city, zip_code), polys in sorted(by_zip.items()):
        out.append((f"{city} {zip_code}", unary_union(polys)))

    mercer = _mercer_island_polygon(ctx)
    if mercer is not None:
        out.append((MERCER_ISLAND_NAME, mercer))

    return out


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


def parse_stations(
    doc: ET.Element,
    region: BaseGeometry,
    folders: tuple[str, ...],
    id_prefix: str = "",
) -> list[dict]:
    """Every station Point in ``folders`` inside the play region, deduped by name +
    proximity (collapsing opposite-direction and multi-bay stops)."""
    region_prepared = prep(region)
    raw: list[tuple[str, float, float]] = []
    for folder_name in folders:
        for pm in _folder(doc, folder_name).findall("k:Placemark", KML_NS):
            pts = _placemark_geoms(pm, "Point")
            if not pts:
                continue
            lat, lon = pts[0][0]  # first (and only) coordinate of the Point
            if not region_prepared.covers(ShapelyPoint(lon, lat)):
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

    stations = []
    used_ids: set[str] = set()
    for c in sorted(clusters, key=lambda c: c["name"]):
        lat = sum(c["lats"]) / len(c["lats"])
        lon = sum(c["lons"]) / len(c["lons"])
        slug = re.sub(r"[^a-z0-9]+", "-", c["name"].lower()).strip("-") or "stop"
        sid = f"{id_prefix}{slug}"
        n = 2
        while sid in used_ids:
            sid = f"{id_prefix}{slug}-{n}"
            n += 1
        used_ids.add(sid)
        stations.append({"id": sid, "name": c["name"], "lat": _round(lat), "lon": _round(lon)})
    return stations


def parse_candidates(doc: ET.Element, region: BaseGeometry) -> list[dict]:
    """Every hider-network station Point inside the play region (all route families)."""
    return parse_stations(doc, region, NETWORK_FOLDERS)


def parse_admin_regions(
    doc: ET.Element,
    city_polygons: list[tuple[str, BaseGeometry]],
    eastside_neighborhoods: list[tuple[str, BaseGeometry]],
) -> dict[str, list[dict]]:
    """Three nested matching tiers: city (every city in the play region — Seattle
    plus the Eastside cities), neighborhood (the ~20 Seattle 'District' outlines
    formed by unioning the fine polygons, plus one entry per Eastside zip region),
    and neighborhood_region (the 94 fine 'District - Neighborhood' polygons). The
    Eastside has no data finer than zips, so it appears only in the city and
    neighborhood tiers."""
    neigh_pms = _folder(doc, NEIGHBORHOODS_FOLDER).findall("k:Placemark", KML_NS)

    # Simplify each fine region ONCE, then reuse those exact rings for both the
    # neighborhood_region tier and (unioned per district) the neighborhood tier.
    # Building the district outline from the same simplified polygons guarantees
    # neighborhood_region is nested inside neighborhood (no edge leakage from
    # independent simplification).
    regions: list[dict] = []  # {"district", "full", "ring" (simplified [lat, lon])}
    by_district: dict[str, list[ShapelyPolygon]] = {}
    for pm in neigh_pms:
        full = _txt(pm, "name") or ""
        district = full.split(" - ", 1)[0].strip() if " - " in full else full.strip()
        for ring in _placemark_geoms(pm, "Polygon"):
            simp = _simplify_ring(ring, ADMIN_SIMPLIFY_TOL)
            regions.append({"district": district, "full": full, "ring": simp})
            by_district.setdefault(district, []).append(
                ShapelyPolygon([(lon, lat) for lat, lon in simp]).buffer(0)
            )

    # City tier: one entry per exterior ring of each city (MultiPolygons split).
    city: list[dict] = []
    for name, geom in city_polygons:
        for poly in _iter_polygons(geom):
            ring = [(lat, lon) for lon, lat in poly.exterior.coords]
            city.append({"name": name, "ring": _simplify_ring(ring, ADMIN_SIMPLIFY_TOL)})

    # Neighborhood tier: dissolve the fine polygons into true district outlines. A
    # district may union into a MultiPolygon -> one entry per exterior ring. The
    # union is NOT re-simplified so it exactly covers its fine regions.
    neighborhood: list[dict] = []
    for district in sorted(by_district):
        merged = unary_union(by_district[district])
        for poly in _iter_polygons(merged):
            ring = [[_round(lat), _round(lon)] for lon, lat in poly.exterior.coords]
            neighborhood.append({"name": district, "ring": ring})

    # Eastside has no data finer than zips: add each zip region (+ Mercer Island)
    # as its own neighborhood so Eastside stations match at this tier too.
    for name, geom in eastside_neighborhoods:
        for poly in _iter_polygons(geom):
            ring = [[_round(lat), _round(lon)] for lon, lat in poly.exterior.coords]
            neighborhood.append({"name": name, "ring": ring})

    neighborhood_region = [{"name": r["full"], "ring": r["ring"]} for r in regions]
    return {
        "city": city,
        "neighborhood": neighborhood,
        "neighborhood_region": neighborhood_region,
    }



def build(cfg: GameConfig) -> dict:
    doc = load_kml()
    print("Parsing authoritative game map (KML)...")

    print("Loading OSM context (POIs + coastline) ...")
    ctx = fetch_all()

    # Play region = Seattle City Limit unioned with the Eastside cities reachable
    # via the 2 Line + B Line (Bellevue, Redmond, Mercer Island).
    city_polygons = build_city_polygons(doc, ctx)
    print("Play-region cities: " + ", ".join(name for name, _ in city_polygons))
    region = unary_union([g for _, g in city_polygons])

    candidates = parse_candidates(doc, region)
    print(f"Candidate stations (inside play region): {len(candidates)}")

    transit_lines = parse_transit_lines(doc)
    print(f"Transit lines (hider network): {len(transit_lines)} "
          f"({', '.join(l['name'] for l in transit_lines)})")

    admin_polygons = parse_admin_regions(doc, city_polygons, build_eastside_neighborhoods(doc, ctx))
    print("Admin tiers: " + ", ".join(f"{k}={len(v)}" for k, v in admin_polygons.items()))

    # Start station (Symphony) from the parsed candidates; fall back to the known
    # Sound Transit coordinate if the map ever renames it.
    start = next((c for c in candidates if c["name"].lower().startswith("symphony")), None)
    start_lat, start_lon = (start["lat"], start["lon"]) if start else (47.607246, -122.335754)

    # POI features, restricted to the play region: a hider is confined to the
    # boundary, so out-of-area locations are dropped (they were also cluttering
    # the map). Kinds left with no in-area feature are removed entirely, and their
    # measuring/matching questions are dropped below.
    region_prepared = prep(region)
    features_by_kind = {}
    for kind, feats in ctx.features_by_kind.items():
        kept = [
            {"id": f.osm_id, "name": f.name, "lat": _round(f.lat), "lon": _round(f.lon)}
            for f in feats
            if region_prepared.covers(ShapelyPoint(f.lon, f.lat))
        ]
        if kept:
            features_by_kind[kind] = kept
        else:
            print(f"  dropping feature kind '{kind}' (no locations inside play region)")
    # Merge hand-curated locations (deduped by id). These are intentional
    # game-specific additions, so they bypass the play-region gate that prunes
    # bulk OSM POIs — e.g. Boeing Field sits ~100m outside the simplified boundary
    # but is within Seattle's real limits and wanted as an airport reference.
    for kind, items in MANUAL_FEATURES.items():
        bucket = features_by_kind.setdefault(kind, [])
        seen = {f["id"] for f in bucket}
        for name, lat, lon, fid in items:
            if fid in seen:
                continue
            bucket.append({"id": fid, "name": name, "lat": _round(lat), "lon": _round(lon)})
            print(f"  added manual feature {name!r} ({kind})")
        if not bucket:
            del features_by_kind[kind]

    # Light-rail (Link) stations as a measuring feature kind: "closest rail
    # station" measures to light rail. These come straight from the KML rail
    # folders (not OSM POIs), so they're added after the region filter above.
    rail_stations = parse_stations(doc, region, LIGHT_RAIL_FOLDERS, id_prefix="rail-")
    if rail_stations:
        features_by_kind["rail_station"] = rail_stations
        print(f"  added feature kind 'rail_station' ({len(rail_stations)} light-rail stations)")

    nonempty_kinds = set(features_by_kind)
    measuring_kinds = [k for k in MEASURING_FEATURE_KINDS if k in nonempty_kinds]
    if "rail_station" in nonempty_kinds:
        measuring_kinds.append("rail_station")
    matching_kinds = [k for k in MATCHING_FEATURE_KINDS if k in nonempty_kinds]
    coastlines = [_simplify_polyline(ln, COAST_SIMPLIFY_TOL) for ln in ctx.coastlines]

    # Question catalog: keep the verified non-admin questions from jetlag (dropping
    # any measuring/matching question whose feature kind is now empty); replace the
    # OSM admin-level questions with the map's three nested matching tiers.
    catalog = [
        {"category": q.category, "name": q.name, "payload": q.payload}
        for q in build_question_catalog()
        if q.category != "admin"
        and not (q.category in ("measuring", "matching") and q.payload not in nonempty_kinds)
    ]
    if "rail_station" in nonempty_kinds:
        catalog.append({"category": "measuring", "name": "measuring_rail_station", "payload": "rail_station"})
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
            "measuring_kinds": measuring_kinds,
            "matching_kinds": matching_kinds,
            "admin_regions": ["city", "neighborhood", "neighborhood_region"],
        },
        "candidates": candidates,
        "features_by_kind": features_by_kind,
        "admin_polygons": admin_polygons,
        "coastlines": coastlines,
        "boundary": _shapely_to_latlon_multipolygon(region, ADMIN_SIMPLIFY_TOL),
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
