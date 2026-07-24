"""Tests for the dataset build output (scripts/build_dataset.py).

Runnable two ways:
  * pytest:            pytest scripts/test_build_dataset.py
  * plain interpreter: ~/git/jetlag_mapper/.venv/bin/python scripts/test_build_dataset.py

The dataset is sourced from the authoritative "Jetlag the Seattle" Google
My Maps KML (hiding region = Seattle City Limit; network = Link 1/2 +
RapidRide B/C/D/E/G/H + Seattle Streetcar). POIs/coastline still come from OSM
via ``jetlag``.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
DATASET = REPO_ROOT / "public" / "data" / "dataset.json"


def load() -> dict:
    return json.loads(DATASET.read_text())


def test_dataset_has_required_shape() -> None:
    ds = load()
    for key in ("config", "candidates", "features_by_kind", "admin_polygons", "coastlines", "boundary", "question_catalog", "transit_lines"):
        assert key in ds, f"missing top-level key {key!r}"

    cfg = ds["config"]
    for key in ("start_lat", "start_lon", "hiding_period_min", "zone_radius_mi", "radar_bands_mi", "admin_regions"):
        assert key in cfg, f"config missing {key!r}"
    assert cfg["hiding_period_min"] == 45
    assert cfg["zone_radius_mi"] == 0.25
    assert cfg["admin_regions"] == ["city", "neighborhood", "neighborhood_region"]


def test_boundary_is_wellformed() -> None:
    ds = load()
    mp = ds["boundary"]  # multipolygon: polygons -> rings -> [lat, lon]
    assert len(mp) >= 1, "expected at least one boundary polygon"
    for poly in mp:
        assert len(poly) >= 1, "each polygon needs an exterior ring"
        for ring in poly:
            assert len(ring) >= 3, "each ring needs at least a triangle"
            for pt in ring:
                assert len(pt) == 2
                lat, lon = pt
                assert 47.0 < lat < 48.5, pt
                assert -123.0 < lon < -121.5, pt


def test_candidates_are_wellformed() -> None:
    ds = load()
    cands = ds["candidates"]
    assert len(cands) > 100, f"expected a large candidate universe, got {len(cands)}"
    ids = set()
    for c in cands:
        assert {"id", "name", "lat", "lon"} <= c.keys()
        assert "travel_min" not in c, "candidates no longer carry travel_min"
        assert 47.0 < c["lat"] < 48.5, c
        assert -123.0 < c["lon"] < -121.5, c
        ids.add(c["id"])
    assert len(ids) == len(cands), "candidate ids must be unique"


def test_candidate_names_are_unescaped() -> None:
    ds = load()
    for c in ds["candidates"]:
        assert "&amp;" not in c["name"], c["name"]
        assert "&#" not in c["name"], c["name"]


def test_question_catalog_covers_all_categories() -> None:
    ds = load()
    cats = {q["category"] for q in ds["question_catalog"]}
    assert {"radar", "measuring", "matching", "admin", "coast"} <= cats
    assert len(ds["question_catalog"]) >= 30
    admin_payloads = {q["payload"] for q in ds["question_catalog"] if q["category"] == "admin"}
    assert admin_payloads == {"city", "neighborhood", "neighborhood_region"}, admin_payloads


def test_features_and_polygons_present() -> None:
    ds = load()
    total_feats = sum(len(v) for v in ds["features_by_kind"].values())
    assert total_feats > 500
    # Admin polygons for the three KML-sourced tiers, each ring a list of [lat, lon].
    for tier in ("city", "neighborhood", "neighborhood_region"):
        assert tier in ds["admin_polygons"], tier
    for polys in ds["admin_polygons"].values():
        for p in polys:
            assert len(p["ring"]) >= 3
            assert all(len(pt) == 2 for pt in p["ring"])


def test_admin_tiers_nest_coarse_to_fine() -> None:
    ds = load()
    ap = ds["admin_polygons"]
    city_names = {p["name"] for p in ap["city"]}
    nbhd_names = {p["name"] for p in ap["neighborhood"]}
    region_names = {p["name"] for p in ap["neighborhood_region"]}
    assert len(city_names) >= 1, city_names
    # City tier covers Seattle plus the Eastside extension cities.
    assert {"Seattle", "Bellevue", "Redmond", "Mercer Island"} <= city_names, city_names
    # ~20 neighborhood districts, ~90 fine neighborhood regions.
    assert 10 <= len(nbhd_names) <= 40, len(nbhd_names)
    assert len(region_names) >= len(nbhd_names), (len(region_names), len(nbhd_names))
    # Fine names ("District - Neighborhood") carry their district (coarse) prefix.
    for name in region_names:
        district = name.split(" - ")[0]
        assert district in nbhd_names, name
    # Eastside has no data finer than zips: each Bellevue/Redmond zip region and
    # Mercer Island appear as their own neighborhood (but not as fine regions).
    assert {"Bellevue 98004", "Redmond 98052", "Mercer Island"} <= nbhd_names, nbhd_names
    for eastside in ("Bellevue 98004", "Redmond 98052", "Mercer Island"):
        assert eastside not in region_names, eastside


def test_transit_lines_wellformed() -> None:
    ds = load()
    lines = ds["transit_lines"]
    # Link 1/2 + RapidRide B/C/D/E/G/H + 2 Seattle Streetcars = 10 network routes.
    assert len(lines) == 10, f"expected 10 transit lines, got {len(lines)}"
    names = {ln["name"] for ln in lines}
    expected = {
        "1 Line",
        "2 Line",
        "RapidRide B Line",
        "RapidRide C Line",
        "RapidRide D Line",
        "RapidRide E Line",
        "RapidRide G Line",
        "RapidRide H Line",
        "South Lake Union Streetcar",
        "First Hill Streetcar",
    }
    assert names == expected, names
    for ln in lines:
        assert {"name", "route_type", "color", "segments"} <= ln.keys()
        assert ln["color"].startswith("#") and len(ln["color"]) == 7, ln["color"]
        assert ln["route_type"] in (0, 3)
        assert len(ln["segments"]) >= 1, ln["name"]
        for seg in ln["segments"]:
            assert len(seg) >= 2, ln["name"]
            for pt in seg:
                assert len(pt) == 2
                assert 47.0 < pt[0] < 48.5 and -123.0 < pt[1] < -121.5, pt
    by_name = {ln["name"]: ln for ln in lines}
    # Light rail + streetcars use route_type 0; RapidRide buses use 3.
    assert by_name["1 Line"]["route_type"] == 0 and by_name["2 Line"]["route_type"] == 0
    assert by_name["South Lake Union Streetcar"]["route_type"] == 0
    assert by_name["First Hill Streetcar"]["route_type"] == 0
    assert all(by_name[f"RapidRide {c} Line"]["route_type"] == 3 for c in "BCDEGH")


def test_candidates_inside_boundary() -> None:
    """Every candidate should fall inside the play-region boundary multipolygon."""
    ds = load()
    mp = ds["boundary"]

    def inside(lat: float, lon: float) -> bool:
        hit = False
        for poly in mp:
            for ring in poly:
                n = len(ring)
                j = n - 1
                for i in range(n):
                    yi, xi = ring[i]
                    yj, xj = ring[j]
                    if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
                        hit = not hit
                    j = i
        return hit

    outside = [c for c in ds["candidates"] if not inside(c["lat"], c["lon"])]
    ratio = 1 - len(outside) / len(ds["candidates"])
    assert ratio >= 0.98, f"only {ratio:.1%} of candidates inside the boundary ({len(outside)} outside)"


def test_eastside_extension_included() -> None:
    """The 2 Line + B Line extension reaches Bellevue/Redmond/Mercer Island."""
    ds = load()
    names = {c["name"] for c in ds["candidates"]}
    assert "Mercer Island" in names, "Mercer Island 2 Line station should be a candidate"
    # Redmond/Bellevue stations sit east of Lake Washington (lon > -122.22).
    eastside = [c for c in ds["candidates"] if c["lon"] > -122.22]
    assert len(eastside) >= 20, f"expected many Eastside candidates, got {len(eastside)}"
    # But E-Line (Shoreline, north) and H-Line (Burien, south) stay excluded.
    for c in ds["candidates"]:
        assert c["lat"] < 47.74, f"unexpected far-north (Shoreline) candidate: {c['name']}"
        assert c["lat"] > 47.48, f"unexpected far-south (Burien) candidate: {c['name']}"


def _run() -> int:
    tests = [
        test_dataset_has_required_shape,
        test_boundary_is_wellformed,
        test_candidates_are_wellformed,
        test_candidate_names_are_unescaped,
        test_question_catalog_covers_all_categories,
        test_features_and_polygons_present,
        test_admin_tiers_nest_coarse_to_fine,
        test_transit_lines_wellformed,
        test_candidates_inside_boundary,
        test_eastside_extension_included,
    ]
    failed = 0
    for t in tests:
        try:
            t()
            print(f"PASS {t.__name__}")
        except AssertionError as e:
            failed += 1
            print(f"FAIL {t.__name__}: {e}")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(_run())
