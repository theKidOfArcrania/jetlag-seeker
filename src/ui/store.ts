// App state store: wraps the elimination engine, the seeker location, and the
// user's locations of interest, with localStorage persistence and a tiny
// pub/sub so views can re-render on change.

import { EliminationEngine, type Step } from "../engine";
import type { Dataset, Feature, LatLon, Loi } from "../types";

const STORAGE_KEY = "jetlag_seek_state_v1";

interface PersistShape {
  steps: Step[];
  seeker: LatLon;
  lois: Loi[];
  disabledKinds?: string[];
  disabledFeatures?: string[];
}

export class Store extends EventTarget {
  readonly ds: Dataset;
  readonly engine: EliminationEngine;
  seeker: LatLon;
  lois: Loi[] = [];
  // Builtin feature categories (park, library, …) the user has switched off; a
  // disabled category is dropped from the Ask-tab Measuring & Matching dropdowns.
  private disabledKinds = new Set<string>();
  // Individual feature points switched off; a disabled point is excluded from the
  // measuring/matching answers and the eliminated-area math (via a filtered
  // dataset swapped into the engine).
  private disabledFeatures = new Set<string>();

  constructor(ds: Dataset) {
    super();
    this.ds = ds;
    this.engine = new EliminationEngine(ds);
    this.seeker = { lat: ds.config.start_lat, lon: ds.config.start_lon };
    this.restore();
    this.syncEngineDataset();
  }

  private emit(): void {
    this.dispatchEvent(new Event("change"));
  }

  onChange(fn: () => void): void {
    this.addEventListener("change", fn);
  }

  setSeeker(loc: LatLon): void {
    this.seeker = loc;
    this.persist();
    this.emit();
  }

  addLoi(name: string, loc: LatLon): Loi {
    const loi: Loi = {
      id: `loi-${Date.now()}-${Math.floor(Math.random() * 1e4)}`,
      name: name.trim() || "Unnamed",
      lat: loc.lat,
      lon: loc.lon,
      enabled: true,
    };
    this.lois.push(loi);
    this.persist();
    this.emit();
    return loi;
  }

  toggleLoi(id: string): void {
    const loi = this.lois.find((l) => l.id === id);
    if (loi) loi.enabled = !loi.enabled;
    this.persist();
    this.emit();
  }

  removeLoi(id: string): void {
    this.lois = this.lois.filter((l) => l.id !== id);
    this.persist();
    this.emit();
  }

  // ---- Builtin feature categories (measuring & matching) --------------------

  /** All builtin feature categories, in config order (measuring ∪ matching). */
  allKinds(): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const k of [...this.ds.config.measuring_kinds, ...this.ds.config.matching_kinds]) {
      if (!seen.has(k)) {
        seen.add(k);
        out.push(k);
      }
    }
    return out;
  }

  isKindEnabled(kind: string): boolean {
    return !this.disabledKinds.has(kind);
  }

  setKindEnabled(kind: string, enabled: boolean): void {
    if (enabled) this.disabledKinds.delete(kind);
    else this.disabledKinds.add(kind);
    this.persist();
    this.emit();
  }

  /** Disable (false) or enable (true) every builtin feature category at once. */
  setAllKindsEnabled(enabled: boolean): void {
    if (enabled) this.disabledKinds.clear();
    else for (const k of this.allKinds()) this.disabledKinds.add(k);
    this.persist();
    this.emit();
  }

  enabledMeasuringKinds(): string[] {
    return this.ds.config.measuring_kinds.filter((k) => this.isKindEnabled(k));
  }

  enabledMatchingKinds(): string[] {
    return this.ds.config.matching_kinds.filter((k) => this.isKindEnabled(k));
  }

  // ---- Individual feature points --------------------------------------------

  /** The full (unfiltered) feature list for a category, for building the UI. */
  featuresForKind(kind: string): Feature[] {
    return this.ds.features_by_kind[kind] ?? [];
  }

  isFeatureEnabled(id: string): boolean {
    return !this.disabledFeatures.has(id);
  }

  setFeatureEnabled(id: string, enabled: boolean): void {
    if (enabled) this.disabledFeatures.delete(id);
    else this.disabledFeatures.add(id);
    this.syncEngineDataset();
    this.persist();
    this.emit();
  }

  toggleFeature(id: string): void {
    this.setFeatureEnabled(id, this.disabledFeatures.has(id));
  }

  /** Enable/disable every feature point in one category at once. */
  setAllFeaturesEnabledForKind(kind: string, enabled: boolean): void {
    for (const f of this.featuresForKind(kind)) {
      if (enabled) this.disabledFeatures.delete(f.id);
      else this.disabledFeatures.add(f.id);
    }
    this.syncEngineDataset();
    this.persist();
    this.emit();
  }

  /** Enable/disable every individual feature point across all categories at once. */
  setAllFeaturesEnabled(enabled: boolean): void {
    for (const kind of this.allKinds()) {
      for (const f of this.featuresForKind(kind)) {
        if (enabled) this.disabledFeatures.delete(f.id);
        else this.disabledFeatures.add(f.id);
      }
    }
    this.syncEngineDataset();
    this.persist();
    this.emit();
  }

  /** How many feature points in a category are currently disabled. */
  disabledCountForKind(kind: string): number {
    let n = 0;
    for (const f of this.featuresForKind(kind)) if (this.disabledFeatures.has(f.id)) n++;
    return n;
  }

  /** Feature ids disabled across all categories (for the map to grey them out). */
  disabledFeatureIds(): ReadonlySet<string> {
    return this.disabledFeatures;
  }

  /**
   * Build the dataset the engine should answer questions against: identical to
   * the source dataset except each category's feature list drops the disabled
   * points. Returns the source dataset untouched when nothing is disabled.
   */
  private buildWorkingDataset(): Dataset {
    if (this.disabledFeatures.size === 0) return this.ds;
    const features_by_kind: Record<string, Feature[]> = {};
    for (const [kind, feats] of Object.entries(this.ds.features_by_kind)) {
      features_by_kind[kind] = feats.filter((f) => !this.disabledFeatures.has(f.id));
    }
    return { ...this.ds, features_by_kind };
  }

  private syncEngineDataset(): void {
    this.engine.setDataset(this.buildWorkingDataset());
  }

  // Engine mutations funnel through the store so we persist + notify uniformly.
  applyStep(...args: Parameters<EliminationEngine["apply"]>): void {
    this.engine.apply(...args);
    this.persist();
    this.emit();
  }

  undo(): void {
    this.engine.undo();
    this.persist();
    this.emit();
  }

  redo(): void {
    this.engine.redoStep();
    this.persist();
    this.emit();
  }

  reset(): void {
    this.engine.reset();
    this.persist();
    this.emit();
  }

  private persist(): void {
    try {
      const data: PersistShape = {
        steps: [...this.engine.history()],
        seeker: this.seeker,
        lois: this.lois,
        disabledKinds: [...this.disabledKinds],
        disabledFeatures: [...this.disabledFeatures],
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      /* localStorage may be unavailable (private mode); ignore. */
    }
  }

  private restore(): void {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const data = JSON.parse(raw) as PersistShape;
      if (data.seeker) this.seeker = data.seeker;
      if (Array.isArray(data.lois)) this.lois = data.lois;
      if (Array.isArray(data.disabledKinds)) this.disabledKinds = new Set(data.disabledKinds);
      if (Array.isArray(data.disabledFeatures)) this.disabledFeatures = new Set(data.disabledFeatures);
      if (Array.isArray(data.steps)) this.engine.loadSteps(data.steps);
    } catch {
      /* corrupt state; start fresh. */
    }
  }
}
