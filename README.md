# jetlag_seek

A **mobile-first webapp** that helps _seekers_ in a Seattle game of **Jet Lag:
The Game — Hide + Seek** narrow down where the hider is. You ask questions, enter
the hider's answer, and the app **cumulatively eliminates** the transit stations
where the hider could be — with live **preview**, **undo/redo**, a manual
**radar slider**, and custom **locations of interest**.

<p align="center"><em>Runs fully offline in the browser — deployable as static files.</em></p>

## How it works

- The candidate universe is every transit station reachable from **Symphony
  Station** within the **45-minute hiding period** on the hider's allowed network
  (Link 1/2 + RapidRide A–H). This is precomputed into a static dataset by
  reusing the verified [`jetlag_mapper`](../jetlag_mapper) reachability code.
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
| **Matching** | "Same nearest _feature_ / same region?" | features + admin regions (county / city / neighborhood) |

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
  - **Transit lines** — the hider network (Link 1/2 + RapidRide A–H), brand-colored
    (on by default).
  - **Admin regions** — county (L6), city (L8), and neighborhood (L10) boundaries.
  - **Eliminated area** — a grid shading every location currently ruled out by the
    applied questions (computed lazily while the layer is visible).
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
~/git/jetlag_mapper/.venv/bin/python scripts/test_build_dataset.py   # dataset invariants + simplification fidelity
```
The answer suite asserts **exact parity** with the Python reference optimizer:
`scripts/gen_parity_fixture.py` computes golden answers with `jetlag_mapper` on
the shipped dataset, and `src/__tests__/answers.test.ts` checks the TypeScript
port reproduces every one.

## Regenerating the dataset
The app ships with `public/data/dataset.json` prebuilt. To regenerate it (e.g.
after a GTFS/OSM refresh or a config change) you need the `jetlag_mapper`
virtualenv, which has the GTFS feeds, OSM cache, and `jetlag` package:
```bash
~/git/jetlag_mapper/.venv/bin/python scripts/build_dataset.py
~/git/jetlag_mapper/.venv/bin/python scripts/gen_parity_fixture.py   # refresh the test oracle
```

## Architecture
```
scripts/build_dataset.py   → public/data/dataset.json  (candidates + OSM features + catalog)
src/geometry.ts            haversine + point-in-polygon (ported from Python)
src/answers.ts             radar / measuring / matching / admin / thermometer answerers
src/engine.ts              EliminationEngine: survivors, preview, undo/redo, persistence
src/ui/                    store, Leaflet map, bottom-sheet panels
src/main.ts                app wiring
```
Stack: Vite + TypeScript + Leaflet + Vitest. No backend; the whole app is static.
