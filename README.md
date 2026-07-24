# jetlag_seek

A **mobile-first webapp** that helps _seekers_ in a Seattle game of **Jet Lag:
The Game — Hide + Seek** narrow down where the hider is. You ask questions, enter
the hider's answer, and the app **cumulatively eliminates** the transit stations
where the hider could be — with live **preview**, **undo/redo**, a manual
**radar slider**, and custom **locations of interest**.

<p align="center"><em>Runs fully offline in the browser — deployable as static files.</em></p>

## How it works

- The candidate universe is every hider-network transit station inside the
  **play region** — the **Seattle city limit plus the Eastside cities the 2 Line
  and B Line reach (Bellevue, Redmond, Mercer Island)**. The hiding region and
  network are taken from the authoritative ["Jetlag the Seattle" Google My Maps](https://www.google.com/maps/d/viewer?mid=1-LHw6acRiIvcYsM6eGUBIMc2OeMi-0g).
  (Bellevue/Redmond come from the map's zip-code polygons; Mercer Island from OSM.)
  The network is **Link 1/2 + RapidRide B/C/D/E/G/H + the Seattle Streetcar**.
  POIs and coastline still come from OSM via [`jetlag_mapper`](../jetlag_mapper).
- Each turn you pick a **question**, drag the **seeker marker (◉)** to where you
  asked from, and tap the hider's real **answer**. Every candidate whose computed
  answer differs from the observed one is eliminated. Answers are computed in the
  browser (a 1:1 TypeScript port of the Python question logic).

### Supported questions
| Category | Question | Notes |
|---|---|---|
| **Radar** | "Are you within X miles?" | Fixed bands **or** the manual slider tool |
| **Thermometer** | seeker moves A→B, "hotter/colder?" | drag ◉ and ◎ markers |
| **Measuring** | "Closer or further to nearest _feature_?" | parks, hospitals, museums, … + coastline |
| **Matching** | "Same nearest _feature_ / same region?" | features + admin regions (city / neighborhood / neighborhood region) |

Photo and Tentacle questions are out of scope for automatic elimination.

## Features
- Live **remaining-candidate count** and map (survivors solid, eliminated faded).
- **Preview** before applying: see how many candidates survive each possible
  answer, with the map shaded green (keep) / orange (drop).
- **Undo / redo / reset** history of every question asked.
- **Radar slider**: drag a radius around the seeker; the circle and inside/outside
  counts update live; apply "within" or "outside". The scale is non-linear (skewed
  toward short distances — **10 mi sits at the slider midpoint**).
- **Map layers** (toggle via the layers control, top-right):
  - **Play region** — the hiding-region boundary (Seattle + Eastside; on by default).
  - **Transit lines** — the hider network (Link 1/2 + RapidRide B/C/D/E/G/H +
    Seattle Streetcar), brand-colored (on by default).
  - **Regions** — the three matching tiers: city, neighborhood, and neighborhood
    region.
  - **Features · _kind_** — the reference points behind each matching question
    (parks, libraries, museums, …), one toggleable layer per category (off by
    default). Also switchable from the **Places** tab's "Reference features by
    category" chips.
  - **Eliminated area** — **exact analytic polygons** of every location currently
    ruled out by the applied questions (radar disks, thermometer half-planes,
    region polygons, matching Voronoi cells, measuring/coast disk-unions),
    intersected and subtracted from the play-region boundary (computed lazily while
    the layer is visible).
- **Locate me**: the **📍 Locate** chip snaps the seeker marker to your real GPS
  location (requires HTTPS or localhost and location permission).
- **Locations of interest**: add reference pins (tap map or at the seeker),
  enable/disable, delete.
- **Persistence**: the round is saved to `localStorage` and survives reloads.

## Getting started
```bash
npm install
npm run dev        # start the dev server
npm run build      # typecheck + production build to dist/
npm run preview    # serve the production build
```

## Tests
```bash
npm test                                   # Vitest: geometry, answer parity, engine, undo/redo
node scripts/smoke.mjs                      # headless end-to-end smoke test (builds dist first)
~/git/jetlag_mapper/.venv/bin/python scripts/test_build_dataset.py   # dataset invariants (shape, boundary, network, region tiers)
```
The answer suite asserts **exact parity** with the Python reference optimizer:
`scripts/gen_parity_fixture.py` computes golden answers with `jetlag_mapper` on
the shipped dataset, and `src/__tests__/answers.test.ts` checks the TypeScript
port reproduces every one. (Region/admin questions use the KML region model,
which the Python oracle can't consume, so they're covered by dedicated unit
tests in `src/__tests__/admin.test.ts` instead.)

## Regenerating the dataset
The app ships with `public/data/dataset.json` prebuilt. To regenerate it (e.g.
after a map or OSM refresh, or a config change) you need the `jetlag_mapper`
virtualenv, which has the OSM cache and `jetlag` package. The build downloads the
authoritative game-map KML (cached to `public/data/game_map.kml`) for the hiding
region, network, and admin regions:
```bash
~/git/jetlag_mapper/.venv/bin/python scripts/build_dataset.py
~/git/jetlag_mapper/.venv/bin/python scripts/gen_parity_fixture.py   # refresh the test oracle
```

## Architecture
```
scripts/build_dataset.py   → public/data/dataset.json  (KML region/network/regions + OSM features + catalog)
src/geometry.ts            haversine + point-in-polygon (ported from Python)
src/answers.ts             radar / measuring / matching / admin / thermometer answerers
src/area.ts                exact per-question analytic regions for the eliminated-area overlay
src/engine.ts              EliminationEngine: survivors, preview, undo/redo, persistence
src/ui/                    store, Leaflet map, bottom-sheet panels
src/main.ts                app wiring
```
Stack: Vite + TypeScript + Leaflet + Vitest. No backend; the whole app is static.
