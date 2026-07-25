import { describe, expect, it, beforeEach } from "vitest";
import { Store } from "../ui/store";
import { loadDatasetSync } from "./helpers";
import type { Dataset } from "../types";

const ds: Dataset = loadDatasetSync();

// Minimal in-memory localStorage so Store persistence round-trips in Node.
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string) { return this.m.has(k) ? this.m.get(k)! : null; }
  setItem(k: string, v: string) { this.m.set(k, v); }
  removeItem(k: string) { this.m.delete(k); }
  clear() { this.m.clear(); }
}

describe("Store — builtin feature category enablement", () => {
  beforeEach(() => {
    (globalThis as any).localStorage = new MemStorage();
  });

  it("all categories are enabled by default", () => {
    const s = new Store(ds);
    for (const k of s.allKinds()) expect(s.isKindEnabled(k)).toBe(true);
    expect(s.enabledMeasuringKinds()).toEqual(ds.config.measuring_kinds);
    expect(s.enabledMatchingKinds()).toEqual(ds.config.matching_kinds);
  });

  it("disabling a category drops it from measuring & matching kinds", () => {
    const s = new Store(ds);
    const kind = s.allKinds()[0];
    s.setKindEnabled(kind, false);
    expect(s.isKindEnabled(kind)).toBe(false);
    expect(s.enabledMeasuringKinds()).not.toContain(kind);
    expect(s.enabledMatchingKinds()).not.toContain(kind);
  });

  it("disable-all then enable-all round-trips", () => {
    const s = new Store(ds);
    s.setAllKindsEnabled(false);
    expect(s.enabledMeasuringKinds()).toHaveLength(0);
    expect(s.enabledMatchingKinds()).toHaveLength(0);
    s.setAllKindsEnabled(true);
    expect(s.enabledMeasuringKinds()).toEqual(ds.config.measuring_kinds);
  });

  it("persists disabled categories across reloads", () => {
    const s1 = new Store(ds);
    const kind = s1.allKinds()[1];
    s1.setKindEnabled(kind, false);
    const s2 = new Store(ds); // reads the same MemStorage
    expect(s2.isKindEnabled(kind)).toBe(false);
    expect(s2.enabledMeasuringKinds()).not.toContain(kind);
  });
});

describe("Store — individual feature enablement", () => {
  beforeEach(() => {
    (globalThis as any).localStorage = new MemStorage();
  });

  // Pick a category with several features to exercise per-place toggling.
  function kindWithFeatures(s: Store): string {
    return s.allKinds().find((k) => s.featuresForKind(k).length >= 3)!;
  }

  it("all features are enabled by default", () => {
    const s = new Store(ds);
    const kind = kindWithFeatures(s);
    for (const f of s.featuresForKind(kind)) expect(s.isFeatureEnabled(f.id)).toBe(true);
    expect(s.disabledCountForKind(kind)).toBe(0);
    expect(s.disabledFeatureIds().size).toBe(0);
  });

  it("disabling a feature removes it from the engine's working dataset", () => {
    const s = new Store(ds);
    const kind = kindWithFeatures(s);
    const f = s.featuresForKind(kind)[0];
    s.setFeatureEnabled(f.id, false);
    expect(s.isFeatureEnabled(f.id)).toBe(false);
    expect(s.disabledCountForKind(kind)).toBe(1);
    const working = s.engine.ds.features_by_kind[kind];
    expect(working.some((x) => x.id === f.id)).toBe(false);
    expect(working).toHaveLength(ds.features_by_kind[kind].length - 1);
    // Source dataset stays untouched.
    expect(ds.features_by_kind[kind].some((x) => x.id === f.id)).toBe(true);
  });

  it("toggleFeature flips enablement", () => {
    const s = new Store(ds);
    const id = s.featuresForKind(kindWithFeatures(s))[0].id;
    s.toggleFeature(id);
    expect(s.isFeatureEnabled(id)).toBe(false);
    s.toggleFeature(id);
    expect(s.isFeatureEnabled(id)).toBe(true);
  });

  it("setAllFeaturesEnabledForKind disables/enables a whole category", () => {
    const s = new Store(ds);
    const kind = kindWithFeatures(s);
    const total = s.featuresForKind(kind).length;
    s.setAllFeaturesEnabledForKind(kind, false);
    expect(s.disabledCountForKind(kind)).toBe(total);
    expect(s.engine.ds.features_by_kind[kind]).toHaveLength(0);
    s.setAllFeaturesEnabledForKind(kind, true);
    expect(s.disabledCountForKind(kind)).toBe(0);
    expect(s.engine.ds.features_by_kind[kind]).toHaveLength(total);
  });

  it("setAllFeaturesEnabled disables/enables every location across all categories", () => {
    const s = new Store(ds);
    const kinds = s.allKinds().filter((k) => s.featuresForKind(k).length > 0);
    const totalByKind = new Map(kinds.map((k) => [k, s.featuresForKind(k).length]));
    s.setAllFeaturesEnabled(false);
    for (const k of kinds) {
      expect(s.disabledCountForKind(k)).toBe(totalByKind.get(k)!);
      expect(s.engine.ds.features_by_kind[k]).toHaveLength(0);
    }
    // Categories themselves remain enabled — only the individual places are off.
    for (const k of kinds) expect(s.isKindEnabled(k)).toBe(true);
    s.setAllFeaturesEnabled(true);
    for (const k of kinds) {
      expect(s.disabledCountForKind(k)).toBe(0);
      expect(s.engine.ds.features_by_kind[k]).toHaveLength(totalByKind.get(k)!);
    }
  });

  it("persists disabled features across reloads", () => {
    const s1 = new Store(ds);
    const id = s1.featuresForKind(kindWithFeatures(s1))[0].id;
    s1.setFeatureEnabled(id, false);
    const s2 = new Store(ds); // same MemStorage
    expect(s2.isFeatureEnabled(id)).toBe(false);
    expect(s2.disabledFeatureIds().has(id)).toBe(true);
  });
});
