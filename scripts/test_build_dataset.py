"""Tests for the dataset build output (scripts/build_dataset.py).

Runnable two ways:
  * pytest:            pytest scripts/test_build_dataset.py
  * plain interpreter: ~/git/jetlag_mapper/.venv/bin/python scripts/test_build_dataset.py

The structure tests need only the built ``public/data/dataset.json``. The
simplification-fidelity test additionally imports ``jetlag`` (available in the
jetlag_mapper virtualenv) and is skipped gracefully if it is not importable.
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
    for key in ("config", "candidates", "features_by_kind", "admin_polygons", "coastlines", "question_catalog", "transit_lines"):
        assert key in ds, f"missing top-level key {key!r}"

    cfg = ds["config"]
    for key in ("start_lat", "start_lon", "hiding_period_min", "zone_radius_mi", "radar_bands_mi"):
        assert key in cfg, f"config missing {key!r}"
    assert cfg["hiding_period_min"] == 45
    assert cfg["zone_radius_mi"] == 0.25


def test_candidates_are_wellformed() -> None:
    ds = load()
    cands = ds["candidates"]
    assert len(cands) > 100, f"expected a large candidate universe, got {len(cands)}"
    ids = set()
    for c in cands:
        assert {"id", "name", "lat", "lon", "travel_min"} <= c.keys()
        assert 47.0 < c["lat"] < 48.5, c
        assert -123.0 < c["lon"] < -121.5, c
        assert c["travel_min"] <= ds["config"]["hiding_period_min"] + 0.01
        ids.add(c["id"])
    assert len(ids) == len(cands), "candidate ids must be unique"


def test_question_catalog_covers_all_categories() -> None:
    ds = load()
    cats = {q["category"] for q in ds["question_catalog"]}
    assert {"radar", "measuring", "matching", "admin", "coast"} <= cats
    assert len(ds["question_catalog"]) >= 30


def test_features_and_polygons_present() -> None:
    ds = load()
    total_feats = sum(len(v) for v in ds["features_by_kind"].values())
    assert total_feats > 500
    # Admin polygons for the medium-game levels, each ring a list of [lat, lon].
    for lvl in ("6", "8", "10"):
        assert lvl in ds["admin_polygons"]
    for polys in ds["admin_polygons"].values():
        for p in polys:
            assert len(p["ring"]) >= 3
            assert all(len(pt) == 2 for pt in p["ring"])


def test_admin_simplification_preserves_answers() -> None:
    """Simplified admin rings must classify candidates the same as full OSM data
    for the overwhelming majority of points (small boundary shifts allowed)."""
    try:
        from jetlag.osm.features import fetch_all
        from jetlag.questions.catalog import admin_containing
    except Exception:  # pragma: no cover - jetlag not installed in this interpreter
        print("SKIP test_admin_simplification_preserves_answers (jetlag unavailable)")
        return

    ds = load()
    ctx = fetch_all()
    cands = [(c["lat"], c["lon"]) for c in ds["candidates"]]

    for lvl_str, polys in ds["admin_polygons"].items():
        lvl = int(lvl_str)
        full = ctx.admin_polygons.get(lvl, [])
        if not full:
            continue
        simplified = [(p["name"], [(lat, lon) for lat, lon in p["ring"]]) for p in polys]
        agree = 0
        for pt in cands:
            if admin_containing(pt, full) == admin_containing(pt, simplified):
                agree += 1
        ratio = agree / len(cands)
        assert ratio >= 0.97, f"admin level {lvl}: only {ratio:.1%} of candidates classified identically"
        print(f"admin level {lvl}: {ratio:.1%} agreement across {len(cands)} candidates")


def test_transit_lines_wellformed() -> None:
    ds = load()
    lines = ds["transit_lines"]
    # Link 1/2 + RapidRide A-H = 10 hider-network routes.
    assert len(lines) == 10, f"expected 10 transit lines, got {len(lines)}"
    names = {ln["short_name"] for ln in lines}
    assert names == {f"{n} Line" for n in ("1", "2", "A", "B", "C", "D", "E", "F", "G", "H")}, names
    for ln in lines:
        assert {"short_name", "long_name", "route_type", "color", "points"} <= ln.keys()
        assert ln["color"].startswith("#") and len(ln["color"]) == 7, ln["color"]
        assert ln["route_type"] in (0, 3)
        assert len(ln["points"]) >= 2, ln["short_name"]
        for pt in ln["points"]:
            assert len(pt) == 2
            assert 47.0 < pt[0] < 48.5 and -123.0 < pt[1] < -121.5, pt
    # Light rail (Link) uses route_type 0; RapidRide buses use 3.
    by_name = {ln["short_name"]: ln for ln in lines}
    assert by_name["1 Line"]["route_type"] == 0 and by_name["2 Line"]["route_type"] == 0
    assert all(by_name[f"{c} Line"]["route_type"] == 3 for c in "ABCDEFGH")


def _run() -> int:
    tests = [
        test_dataset_has_required_shape,
        test_candidates_are_wellformed,
        test_question_catalog_covers_all_categories,
        test_features_and_polygons_present,
        test_admin_simplification_preserves_answers,
        test_transit_lines_wellformed,
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
