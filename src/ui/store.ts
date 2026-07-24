// App state store: wraps the elimination engine, the seeker location, and the
// user's locations of interest, with localStorage persistence and a tiny
// pub/sub so views can re-render on change.

import { EliminationEngine, type Step } from "../engine";
import type { Dataset, LatLon, Loi } from "../types";

const STORAGE_KEY = "jetlag_seek_state_v1";

interface PersistShape {
  steps: Step[];
  seeker: LatLon;
  lois: Loi[];
}

export class Store extends EventTarget {
  readonly ds: Dataset;
  readonly engine: EliminationEngine;
  seeker: LatLon;
  lois: Loi[] = [];

  constructor(ds: Dataset) {
    super();
    this.ds = ds;
    this.engine = new EliminationEngine(ds);
    this.seeker = { lat: ds.config.start_lat, lon: ds.config.start_lon };
    this.restore();
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
      if (Array.isArray(data.steps)) this.engine.loadSteps(data.steps);
    } catch {
      /* corrupt state; start fresh. */
    }
  }
}
