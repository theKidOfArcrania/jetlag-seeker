// The bottom-sheet UI: Ask, Radar, Places (LOI), and History tabs. All preview
// overlays and elimination actions funnel through here into the store + map.

import { distMi } from "../geometry";
import type { StepSpec } from "../engine";
import type { LatLon } from "../types";
import type { MapView } from "./map";
import type { Store } from "./store";
import { clear, el, fmtAnswer } from "./dom";

type TabId = "ask" | "radar" | "places" | "history";

function titleCase(s: string): string {
  return s.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

// Non-linear radar scale skewed toward small distances. The slider position
// t ∈ [0,1] maps to miles via exp(A·t² + B·t + C), a monotonic curve fit so that
// t=0 → 0.1 mi, t=0.5 → 10 mi, t=1 → 50 mi (10 mi sits at the halfway point).
const RADAR_A = -5.991465;
const RADAR_B = 12.206073;
const RADAR_C = -2.302585; // ln(0.1)
const RADAR_STEPS = 1000;

function sliderToMiles(t: number): number {
  const clamped = Math.min(1, Math.max(0, t));
  return Math.exp(RADAR_A * clamped * clamped + RADAR_B * clamped + RADAR_C);
}

/** Inverse of sliderToMiles: binary search (the curve is monotonic on [0,1]). */
function milesToSliderValue(mi: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (sliderToMiles(mid) < mi) lo = mid;
    else hi = mid;
  }
  return Math.round(((lo + hi) / 2) * RADAR_STEPS);
}

export class Panels {
  private store: Store;
  private map: MapView;
  private root: HTMLElement;
  private body: HTMLElement;
  private tab: TabId = "ask";

  // Ask-tab selection state
  private category = "radar";
  private param: string | number = 0.25;
  private seekerTo: LatLon | null = null;
  private selectedAnswerKey: string | null = null;

  // Radar-tab state
  private radarRadius = 1;

  private placingLoi = false;

  constructor(store: Store, map: MapView, root: HTMLElement) {
    this.store = store;
    this.map = map;
    this.root = root;
    this.body = el("div", { class: "panel-body" });
    this.mount();
    this.store.onChange(() => this.onStoreChange());
    this.map.setMapClickHandler((loc) => this.onMapClick(loc));
    // Keep the Places-tab category chips in sync with the map layer control.
    this.map.onMatchingToggle(() => {
      if (this.tab === "places") this.renderPlaces();
    });
  }

  private mount(): void {
    const tabs: [TabId, string][] = [
      ["ask", "Ask"],
      ["radar", "Radar"],
      ["places", "Places"],
      ["history", "History"],
    ];
    const bar = el(
      "div",
      { class: "tabbar" },
      tabs.map(([id, label]) =>
        el("button", {
          class: `tab ${this.tab === id ? "active" : ""}`,
          "data-tab": id,
          text: label,
          onclick: () => this.switchTab(id),
        }),
      ),
    );
    this.root.append(bar, this.body);
    this.renderTab();
  }

  private switchTab(id: TabId): void {
    this.tab = id;
    this.map.clearPreview();
    this.selectedAnswerKey = null;
    if (id !== "ask" || this.category !== "thermometer") {
      this.map.setSeekerTo(null);
      this.seekerTo = null;
    }
    this.placingLoi = false;
    for (const b of this.root.querySelectorAll(".tab")) {
      b.classList.toggle("active", (b as HTMLElement).dataset.tab === id);
    }
    this.renderTab();
  }

  private onStoreChange(): void {
    // Keep count-dependent tabs fresh; preview overlays are transient.
    if (this.tab === "history" || this.tab === "places") this.renderTab();
    if (this.tab === "ask") this.renderPreview();
    if (this.tab === "radar") this.renderRadar();
  }

  private renderTab(): void {
    clear(this.body);
    if (this.tab === "ask") this.renderAsk();
    else if (this.tab === "radar") this.renderRadar();
    else if (this.tab === "places") this.renderPlaces();
    else this.renderHistory();
  }

  // ---- Ask tab --------------------------------------------------------------

  private currentSpec(): StepSpec | null {
    const seeker = this.store.seeker;
    if (this.category === "coast") return { category: "coast", payload: "coastline", seeker };
    if (this.category === "thermometer") {
      if (!this.seekerTo) return null;
      return { category: "thermometer", payload: 0, seeker, seekerTo: this.seekerTo };
    }
    return { category: this.category as StepSpec["category"], payload: this.param, seeker };
  }

  private renderAsk(): void {
    const cfg = this.store.ds.config;
    const catSel = el(
      "select",
      { class: "select", onchange: (e: Event) => this.onCategory((e.target as HTMLSelectElement).value) },
      [
        ["radar", "Radar (within X?)"],
        ["thermometer", "Thermometer (hotter/colder)"],
        ["measuring", "Measuring (closer/further)"],
        ["matching", "Matching (same nearest)"],
        ["admin", "Matching admin region"],
        ["coast", "Measuring coastline"],
      ].map(([v, label]) =>
        el("option", { value: v, selected: v === this.category, text: label }),
      ),
    );

    const paramWrap = el("div", { class: "param" });
    this.buildParam(paramWrap, cfg);

    const hint = el("div", { class: "hint" }, [
      this.category === "thermometer"
        ? "Drag the seeker (◉ start) and destination (◎) markers, then pick the hider's answer below."
        : "Drag the seeker marker (◉) to where you asked from, then tap the hider's real answer.",
    ]);

    const preview = el("div", { class: "preview", id: "ask-preview" });

    this.body.append(
      el("label", { class: "field-label", text: "Question type" }),
      catSel,
      paramWrap,
      hint,
      el("div", { class: "field-label", text: "Preview — tap the hider's answer, then Apply" }),
      preview,
    );
    this.renderPreview();
  }

  private buildParam(wrap: HTMLElement, cfg: Store["ds"]["config"]): void {
    clear(wrap);
    if (this.category === "radar") {
      if (typeof this.param !== "number") this.param = cfg.radar_bands_mi[0];
      wrap.append(
        el("label", { class: "field-label", text: "Distance (miles)" }),
        el(
          "select",
          { class: "select", onchange: (e: Event) => { this.param = Number((e.target as HTMLSelectElement).value); this.renderPreview(); } },
          cfg.radar_bands_mi.map((d) => el("option", { value: d, selected: d === this.param, text: `${d} mi` })),
        ),
      );
    } else if (this.category === "measuring" || this.category === "matching") {
      const kinds = this.category === "measuring" ? cfg.measuring_kinds : cfg.matching_kinds;
      if (typeof this.param !== "string" || !kinds.includes(this.param)) this.param = kinds[0];
      wrap.append(
        el("label", { class: "field-label", text: "Feature" }),
        el(
          "select",
          { class: "select", onchange: (e: Event) => { this.param = (e.target as HTMLSelectElement).value; this.renderPreview(); } },
          kinds.map((k) => el("option", { value: k, selected: k === this.param, text: titleCase(k) })),
        ),
      );
    } else if (this.category === "admin") {
      const regions = cfg.admin_regions;
      if (typeof this.param !== "string" || !regions.includes(this.param)) this.param = regions[0];
      const labels: Record<string, string> = {
        city: "City",
        neighborhood: "Neighborhood",
        neighborhood_region: "Neighborhood region",
      };
      wrap.append(
        el("label", { class: "field-label", text: "Region level" }),
        el(
          "select",
          { class: "select", onchange: (e: Event) => { this.param = (e.target as HTMLSelectElement).value; this.renderPreview(); } },
          regions.map((key) => el("option", { value: key, selected: key === this.param, text: labels[key] ?? titleCase(key) })),
        ),
      );
    }
  }

  private onCategory(cat: string): void {
    this.category = cat;
    this.param = 0;
    this.selectedAnswerKey = null;
    if (cat === "thermometer") {
      const s = this.store.seeker;
      this.seekerTo = { lat: s.lat + 0.02, lon: s.lon + 0.02 };
      this.map.setSeekerTo(this.seekerTo);
      this.map.onSeekerToMove((loc) => { this.seekerTo = loc; this.renderPreview(); });
    } else {
      this.map.setSeekerTo(null);
      this.seekerTo = null;
    }
    this.renderTab();
  }

  private renderPreview(): void {
    const host = this.body.querySelector("#ask-preview") as HTMLElement | null;
    if (!host) return;
    clear(host);
    const spec = this.currentSpec();
    if (!spec) {
      host.append(el("div", { class: "hint", text: "Place the destination marker to preview." }));
      return;
    }
    const buckets = this.store.engine.preview(spec);
    if (this.category === "thermometer" && this.seekerTo) {
      this.map.clearPreview();
      this.map.showThermometerPreview(this.store.seeker, this.seekerTo);
    }
    const survivors = this.store.engine.survivors();
    for (const b of buckets) {
      const key = typeof b.answer === "boolean" ? String(b.answer) : b.answer;
      const btn = el("button", {
        class: `bucket ${this.selectedAnswerKey === key ? "selected" : ""}`,
        onclick: () => this.selectAnswer(spec, b.answer, key),
      }, [
        el("span", { class: "bucket-ans", text: fmtAnswer(b.answer) }),
        el("span", { class: "bucket-count", text: `${b.survivors.length}` }),
      ]);
      host.append(btn);
    }
    host.append(el("div", { class: "hint", text: `${survivors.length} candidates remain now.` }));

    const applyBtn = el("button", {
      class: "apply",
      disabled: this.selectedAnswerKey === null,
      onclick: () => this.applyAsk(spec),
      text: "Apply elimination",
    });
    host.append(applyBtn);
  }

  private selectAnswer(spec: StepSpec, answer: boolean | string, key: string): void {
    this.selectedAnswerKey = key;
    const keep = this.store.engine.survivorsIf(spec, answer);
    const keepIds = new Set(keep.map((c) => c.id));
    const drop = this.store.engine.survivors().filter((c) => !keepIds.has(c.id));
    this.map.clearPreview();
    if (this.category === "thermometer" && this.seekerTo) {
      this.map.showThermometerPreview(this.store.seeker, this.seekerTo);
    }
    this.map.paintPreview(keep, drop);
    this.renderPreview();
  }

  private applyAsk(spec: StepSpec): void {
    if (this.selectedAnswerKey === null) return;
    const buckets = this.store.engine.preview(spec);
    const bucket = buckets.find(
      (b) => (typeof b.answer === "boolean" ? String(b.answer) : b.answer) === this.selectedAnswerKey,
    );
    if (!bucket) return;
    this.store.applyStep(spec, bucket.answer);
    this.selectedAnswerKey = null;
    this.map.clearPreview();
  }

  // ---- Radar tab (manual slider) -------------------------------------------

  private renderRadar(): void {
    clear(this.body);

    const compute = () => {
      const seeker = this.store.seeker;
      const survivors = this.store.engine.survivors();
      const inside = survivors.filter((c) => distMi(c, seeker) <= this.radarRadius);
      const insideIds = new Set(inside.map((c) => c.id));
      const outside = survivors.filter((c) => !insideIds.has(c.id));
      return { seeker, inside, outside };
    };

    let { seeker, inside, outside } = compute();
    this.map.showRadarPreview(seeker, this.radarRadius, inside, outside);

    const valEl = el("span", { class: "radar-val", text: `${this.radarRadius.toFixed(2)} mi` });
    const countEl = el("span", { class: "hint", text: `${inside.length} inside · ${outside.length} outside` });
    const keepBtn = el("button", {
      class: "apply keep",
      text: `Hider is WITHIN → keep ${inside.length}`,
      onclick: () => this.applyRadar(true),
    });
    const dropBtn = el("button", {
      class: "apply drop",
      text: `Hider is OUTSIDE → keep ${outside.length}`,
      onclick: () => this.applyRadar(false),
    });

    let raf = 0;
    const slider = el("input", {
      class: "slider",
      type: "range",
      min: "0",
      max: String(RADAR_STEPS),
      step: "1",
      value: String(milesToSliderValue(this.radarRadius)),
      // Live drag: only update the readout + circle (cheap). Full inside/outside
      // recolor is deferred to `change` (drag release) to keep the slider smooth.
      oninput: (e: Event) => {
        this.radarRadius = sliderToMiles(Number((e.target as HTMLInputElement).value) / RADAR_STEPS);
        if (raf) cancelAnimationFrame(raf);
        raf = requestAnimationFrame(() => {
          const r = compute();
          valEl.textContent = `${this.radarRadius.toFixed(2)} mi`;
          countEl.textContent = `${r.inside.length} inside · ${r.outside.length} outside`;
          keepBtn.textContent = `Hider is WITHIN → keep ${r.inside.length}`;
          dropBtn.textContent = `Hider is OUTSIDE → keep ${r.outside.length}`;
          this.map.setRadarCircle(r.seeker, this.radarRadius);
        });
      },
      onchange: () => {
        const r = compute();
        this.map.showRadarPreview(r.seeker, this.radarRadius, r.inside, r.outside);
      },
    });

    this.body.append(
      el("div", { class: "field-label", text: "Radar radius around the seeker (◉)" }),
      el("div", { class: "radar-readout" }, [valEl, countEl]),
      slider,
      el("div", { class: "row" }, [keepBtn, dropBtn]),
      el("div", { class: "hint", text: "Drag the seeker marker to recenter. Scale is non-linear (10 mi at the midpoint). This asks a Radar question at the exact radius you set." }),
    );
  }

  private applyRadar(within: boolean): void {
    const spec: StepSpec = { category: "radar", payload: this.radarRadius, seeker: this.store.seeker };
    this.store.applyStep(spec, within, `Radar ${this.radarRadius.toFixed(2)} mi → ${within ? "within" : "outside"}`);
    this.map.clearPreview();
  }

  // ---- Places tab (LOIs) ----------------------------------------------------

  private renderPlaces(): void {
    clear(this.body);
    const nameInput = el("input", { class: "text-input", type: "text", placeholder: "Location name" }) as HTMLInputElement;
    this.body.append(
      el("div", { class: "field-label", text: "Add a location of interest" }),
      nameInput,
      el("div", { class: "row" }, [
        el("button", {
          class: "apply",
          text: "Add at seeker (◉)",
          onclick: () => { this.store.addLoi(nameInput.value, this.store.seeker); nameInput.value = ""; },
        }),
        el("button", {
          class: `apply ${this.placingLoi ? "keep" : ""}`,
          text: this.placingLoi ? "Tap map…" : "Tap map to add",
          onclick: () => { this.placingLoi = !this.placingLoi; this.renderPlaces(); },
        }),
      ]),
      el("div", { class: "field-label", text: `Locations (${this.store.lois.length})` }),
      el(
        "div",
        { class: "loi-list" },
        this.store.lois.length === 0
          ? [el("div", { class: "hint", text: "None yet." })]
          : this.store.lois.map((loi) =>
              el("div", { class: `loi-row ${loi.enabled ? "" : "off"}` }, [
                el("span", { class: "loi-name", text: loi.name }),
                el("button", { class: "chip", text: loi.enabled ? "On" : "Off", onclick: () => this.store.toggleLoi(loi.id) }),
                el("button", { class: "chip del", text: "✕", onclick: () => this.store.removeLoi(loi.id) }),
              ]),
            ),
      ),
      this.renderFeatureCategories(),
    );
  }

  /** Toggle map layers of matching-feature reference points (park, library, …). */
  private renderFeatureCategories(): HTMLElement {
    const cats = this.map.matchingCategories();
    return el("div", { class: "feature-cats" }, [
      el("div", { class: "field-label", text: "Reference features by category" }),
      el("div", { class: "hint", text: "Show/hide matching-question feature points on the map." }),
      el(
        "div",
        { class: "cat-chips" },
        cats.map((c) =>
          el("button", {
            class: `chip ${c.visible ? "keep" : ""}`,
            text: `${c.label} (${c.count})`,
            onclick: () => {
              this.map.setMatchingCategoryVisible(c.kind, !c.visible);
              this.renderPlaces();
            },
          }),
        ),
      ),
    ]);
  }

  private onMapClick(loc: LatLon): void {
    if (this.tab === "places" && this.placingLoi) {
      const name = prompt("Name this location:", "Location") ?? "Location";
      this.store.addLoi(name, loc);
      this.placingLoi = false;
      this.renderPlaces();
    }
  }

  // ---- History tab ----------------------------------------------------------

  private renderHistory(): void {
    clear(this.body);
    const eng = this.store.engine;
    const steps = eng.history();
    const trail = eng.survivorTrail();

    this.body.append(
      el("div", { class: "row" }, [
        el("button", { class: "chip", text: "↶ Undo", disabled: !eng.canUndo(), onclick: () => this.store.undo() }),
        el("button", { class: "chip", text: "↷ Redo", disabled: !eng.canRedo(), onclick: () => this.store.redo() }),
        el("button", { class: "chip del", text: "Reset", disabled: steps.length === 0, onclick: () => { if (confirm("Clear all questions?")) this.store.reset(); } }),
      ]),
      el("div", { class: "field-label", text: `${trail[trail.length - 1]} of ${this.store.ds.candidates.length} candidates remain` }),
      el(
        "ol",
        { class: "history-list" },
        steps.length === 0
          ? [el("li", { class: "hint", text: "No questions asked yet." })]
          : steps.map((s, i) =>
              el("li", { class: "history-row" }, [
                el("span", { class: "history-label", text: s.label }),
                el("span", { class: "history-count", text: `${trail[i]} → ${trail[i + 1]}` }),
              ]),
            ),
      ),
    );
  }
}
