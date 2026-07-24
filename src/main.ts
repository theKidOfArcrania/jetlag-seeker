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
  const countEl = el("span", { class: "count" });
  const bar = el("div", { class: "statusbar" }, [
    el("span", { class: "brand", text: "Jet Lag · Seeker" }),
    countEl,
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
  // The bar lives at the top of the #app flex column so the map sits *below* it
  // instead of being overlaid by the fixed, full-viewport #app (which would paint
  // the map over the bar). Re-flow Leaflet after the map box shrinks.
  app.prepend(bar);
  map.map.invalidateSize();

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
  // Tapping a feature point on the map toggles whether that place counts in
  // measuring/matching questions.
  map.onFeatureClick((id) => store.toggleFeature(id));

  function renderArea(): void {
    if (!areaVisible) return;
    map.renderArea(computeEliminatedArea(store.engine.ds, store.engine));
  }

  function renderMap(): void {
    const survivors = store.engine.survivors();
    const eliminated = store.engine.eliminated();
    map.renderCandidates(survivors, eliminated);
    map.renderLois(store.lois);
    map.setSeeker(store.seeker);
    map.setDisabledFeatures(store.disabledFeatureIds());
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
