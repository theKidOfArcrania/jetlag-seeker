"""Generate a JS/Python parity fixture for the ported answerers.

Reconstructs an ``OsmContext`` from the *shipped* dataset.json (so simplified
admin polygons / coastlines match what the client actually uses), then calls the
verified ``jetlag.answer_question`` for a grid of (hider, seeker) pairs across the
whole question catalog. The TS test suite loads this fixture and asserts its port
produces identical answers.

    ~/git/jetlag_mapper/.venv/bin/python scripts/gen_parity_fixture.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

from jetlag.osm.features import Feature, OsmContext
from jetlag.questions.catalog import QuestionSpec, answer_question

REPO_ROOT = Path(__file__).resolve().parents[1]
DATASET = REPO_ROOT / "public" / "data" / "dataset.json"
OUT = REPO_ROOT / "src" / "__tests__" / "parity_fixture.json"


def ctx_from_dataset(ds: dict) -> OsmContext:
    ctx = OsmContext(bbox=(0, 0, 0, 0))
    ctx.features_by_kind = {
        kind: [Feature(kind=kind, name=f["name"], lat=f["lat"], lon=f["lon"], osm_id=f["id"]) for f in feats]
        for kind, feats in ds["features_by_kind"].items()
    }
    # Admin regions are sourced from the authoritative KML with string keys
    # ("city"/"neighborhood"/"neighborhood_region"), which jetlag's numeric-level
    # answerer cannot consume. Admin questions are excluded from this parity
    # fixture and covered by dedicated TS unit tests instead.
    ctx.admin_polygons = {}
    ctx.coastlines = [[(lat, lon) for lat, lon in ln] for ln in ds["coastlines"]]
    return ctx


def main() -> int:
    ds = json.loads(DATASET.read_text())
    ctx = ctx_from_dataset(ds)
    # Build the question list straight from the shipped catalog (minus admin, which
    # uses a KML region model the Python oracle can't consume). This keeps the
    # fixture aligned 1:1 with the client's dataset and automatically covers extra
    # feature kinds (e.g. rail_station) that aren't in build_question_catalog().
    questions = [
        QuestionSpec(category=q["category"], name=q["name"], payload=q["payload"])
        for q in ds["question_catalog"]
        if q["category"] != "admin"
    ]

    cands = ds["candidates"]
    # Hiders: a spread across the candidate list. Seekers: origin + a few candidates.
    hiders = [cands[i] for i in range(0, len(cands), max(1, len(cands) // 40))][:40]
    seeker_pts = [(ds["config"]["start_lat"], ds["config"]["start_lon"])]
    seeker_pts += [(cands[i]["lat"], cands[i]["lon"]) for i in (5, 30, 80, 150, 200) if i < len(cands)]

    cases = []
    for h in hiders:
        hloc = (h["lat"], h["lon"])
        for sloc in seeker_pts:
            answers = [answer_question(q, hloc, sloc, ctx) for q in questions]
            cases.append({"hider": list(hloc), "seeker": list(sloc), "answers": answers})

    fixture = {
        "questions": [{"category": q.category, "name": q.name, "payload": q.payload} for q in questions],
        "cases": cases,
    }
    OUT.write_text(json.dumps(fixture, separators=(",", ":")))
    print(f"Wrote {OUT}: {len(cases)} cases x {len(questions)} questions")
    return 0


if __name__ == "__main__":
    sys.exit(main())
