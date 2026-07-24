import "leaflet/dist/leaflet.css";
import "./style.css";
import { fetchDataset } from "./loadDataset";
import { MapView } from "./ui/map";
import { computeEliminatedArea } from "./area";
import { Store } from "./ui/store";
import { Panels } from "./ui/panels";
import { el } from "./ui/dom";
import type { Dataset } from "./types";

async function main(): Promise<void> {
  const app = document.getElementById("app")!;
  let ds: Dataset;
  try {
    ds = await fetchDataset();
  } catch (err) {
    app.append(el("div", { class: "fatal", text: String(err) }));
    return;
  }

  const store = new Store(ds);

  const mapEl = document.getElementById("map")!;
  const map = new MapView(mapEl, { lat: ds.config.start_lat, lon: ds.config.start_lon }, store.seeker);

  // Top status bar
  let showEliminated = true;
  const countEl = el("span", { class: "count" });
  const bar = el("div", { class: "statusbar" }, [
    el("span", { class: "brand", text: "Jet Lag · Seeker" }),
    countEl,
    el("button", {
      class: "chip",
      text: "Fit",
      onclick: () => map.fitToSurvivors(store.engine.survivors()),
    }),
    el("button", {
      class: "chip toggle",
      text: "Eliminated ✓",
      onclick: (e: Event) => {
        showEliminated = !showEliminated;
        (e.target as HTMLElement).textContent = showEliminated ? "Eliminated ✓" : "Eliminated ✕";
        renderMap();
      },
    }),
    el("button", {
      class: "chip",
      text: "📍 Locate",
      onclick: (e: Event) => {
        const btn = e.target as HTMLButtonElement;
        if (!("geolocation" in navigator)) {
          alert("Geolocation is not available in this browser.");
          return;
        }
        const prev = btn.textContent;
        btn.textContent = "Locating…";
        btn.disabled = true;
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            const loc = { lat: pos.coords.latitude, lon: pos.coords.longitude };
            store.setSeeker(loc);
            map.setSeeker(loc);
            map.panTo(loc);
            btn.textContent = prev;
            btn.disabled = false;
          },
          (err) => {
            alert(`Could not get your location: ${err.message}`);
            btn.textContent = prev;
            btn.disabled = false;
          },
          { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 },
        );
      },
    }),
  ]);
  document.body.prepend(bar);

  const panelRoot = document.getElementById("panel")!;
  new Panels(store, map, panelRoot);

  // Toggleable overlays: boundary, admin regions, transit lines, and the
  // eliminated area. The area is computed analytically (exact per-question
  // polygons) only while its layer is visible, and recomputed on store changes.
  let areaVisible = false;
  map.setupOverlays(ds, (visible) => {
    areaVisible = visible;
    if (visible) renderArea();
    else map.clearArea();
  });

  function renderArea(): void {
    if (!areaVisible) return;
    map.renderArea(computeEliminatedArea(ds, store.engine));
  }

  function renderMap(): void {
    const survivors = store.engine.survivors();
    const eliminated = store.engine.eliminated();
    map.renderCandidates(survivors, eliminated, showEliminated);
    map.renderLois(store.lois);
    map.setSeeker(store.seeker);
    countEl.textContent = `${survivors.length}/${ds.candidates.length} left`;
    renderArea();
  }

  map.setSeekerMoveHandler((loc) => {
    store.setSeeker(loc);
  });

  store.onChange(renderMap);
  renderMap();
}

main();
