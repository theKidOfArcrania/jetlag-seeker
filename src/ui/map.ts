// Leaflet map view. Renders the candidate universe (survivors vs eliminated),
// a draggable seeker marker, the start station, user LOIs, and transient preview
// overlays (radar circle, thermometer line, per-answer shading).

import L from "leaflet";
import type { Candidate, Dataset, LatLon, Loi } from "../types";

const COLORS = {
  survivor: "#2563eb",
  eliminated: "#c9ced6",
  previewKeep: "#16a34a",
  previewDrop: "#f97316",
  start: "#111827",
  seeker: "#dc2626",
  seekerTo: "#7c3aed",
  loi: "#0891b2",
  loiOff: "#9ca3af",
};

const FEATURE_COLORS = [
  "#e11d48", "#7c3aed", "#0891b2", "#16a34a", "#d97706", "#db2777",
  "#2563eb", "#65a30d", "#9333ea", "#0d9488", "#c2410c", "#4f46e5",
];

function featureLabel(kind: string): string {
  return kind.replace(/_/g, " ").replace(/\b\w/g, (m) => m.toUpperCase());
}

function divPin(emoji: string, color: string): L.DivIcon {
  return L.divIcon({
    className: "jl-pin",
    html: `<span style="--pin:${color}">${emoji}</span>`,
    iconSize: [28, 28],
    // The glyph is centred in the 28x28 box (see .jl-pin span), so anchor at the
    // box centre. A bottom anchor would render these symmetric markers ~12px
    // north of their true location (e.g. the seeker dot off-centre in its radar).
    iconAnchor: [14, 14],
  });
}

export type SeekerMoveHandler = (loc: LatLon) => void;
export type MapClickHandler = (loc: LatLon) => void;

export class MapView {
  readonly map: L.Map;
  private candidateLayer = L.layerGroup();
  private loiLayer = L.layerGroup();
  private previewLayer = L.layerGroup();
  private seekerMarker: L.Marker;
  private seekerToMarker: L.Marker | null = null;
  private onSeekerMove: SeekerMoveHandler | null = null;
  private mapClick: MapClickHandler | null = null;
  private areaRenderer = L.canvas({ padding: 0.5 });
  private areaLayer = L.layerGroup();
  private previewAreaLayer = L.layerGroup();
  private radarCircle: L.Circle | null = null;
  private featureRenderer = L.canvas({ padding: 0.5 });
  private matchingLayers = new Map<string, L.LayerGroup>();
  private matchingVisible = new Set<string>();
  private matchingToggleCb: (() => void) | null = null;
  // Feature-point markers by id (+ their enabled colour) so we can restyle them
  // when the user disables/enables individual places.
  private matchingMarkers = new Map<string, { marker: L.CircleMarker; color: string }>();
  private featureClickCb: ((id: string) => void) | null = null;
  private disabledFeatures: ReadonlySet<string> = new Set();

  constructor(el: HTMLElement, start: LatLon, seeker: LatLon) {
    this.map = L.map(el, { zoomControl: true }).setView([start.lat, start.lon], 12);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      attribution: "&copy; OpenStreetMap, &copy; CARTO",
      maxZoom: 19,
    }).addTo(this.map);

    this.candidateLayer.addTo(this.map);
    this.previewAreaLayer.addTo(this.map);
    this.previewLayer.addTo(this.map);
    this.loiLayer.addTo(this.map);

    // Decorative shading (committed + preview eliminated area) is drawn on a
    // canvas. Put it on a dedicated pane *below* the overlay pane (where the
    // interactive feature-point markers live) with pointer-events disabled, so
    // the shading never intercepts hover/click meant for the POI icons above it.
    this.map.createPane("shading");
    const shadingPane = this.map.getPane("shading")!;
    shadingPane.style.zIndex = "350"; // tilePane(200) < shading < overlayPane(400)
    shadingPane.style.pointerEvents = "none";
    this.areaRenderer.options.pane = "shading";

    L.marker([start.lat, start.lon], {
      icon: divPin("★", COLORS.start),
      interactive: true,
    })
      .bindTooltip("Start / Symphony")
      .addTo(this.map);

    this.seekerMarker = L.marker([seeker.lat, seeker.lon], {
      icon: divPin("◉", COLORS.seeker),
      draggable: true,
      zIndexOffset: 1000,
    })
      .bindTooltip("Seeker (drag me)")
      .addTo(this.map);
    this.seekerMarker.on("dragend", () => {
      const p = this.seekerMarker.getLatLng();
      this.onSeekerMove?.({ lat: p.lat, lon: p.lng });
    });

    this.map.on("click", (e: L.LeafletMouseEvent) => {
      this.mapClick?.({ lat: e.latlng.lat, lon: e.latlng.lng });
    });
  }

  setSeekerMoveHandler(fn: SeekerMoveHandler): void {
    this.onSeekerMove = fn;
  }

  setMapClickHandler(fn: MapClickHandler | null): void {
    this.mapClick = fn;
  }

  setSeeker(loc: LatLon): void {
    this.seekerMarker.setLatLng([loc.lat, loc.lon]);
  }

  /** Recenter the map on a location (keeps current zoom, or zooms in a bit). */
  panTo(loc: LatLon): void {
    this.map.setView([loc.lat, loc.lon], Math.max(this.map.getZoom(), 13));
  }

  /** Show/refresh a secondary marker for the thermometer destination. */
  setSeekerTo(loc: LatLon | null): void {
    if (!loc) {
      if (this.seekerToMarker) {
        this.map.removeLayer(this.seekerToMarker);
        this.seekerToMarker = null;
      }
      return;
    }
    if (!this.seekerToMarker) {
      this.seekerToMarker = L.marker([loc.lat, loc.lon], {
        icon: divPin("◎", COLORS.seekerTo),
        draggable: true,
        zIndexOffset: 900,
      }).bindTooltip("Thermometer start (drag me)").addTo(this.map);
    } else {
      this.seekerToMarker.setLatLng([loc.lat, loc.lon]);
    }
  }

  onSeekerToMove(fn: SeekerMoveHandler): void {
    // (re)bind on the current destination marker if present
    if (this.seekerToMarker) {
      this.seekerToMarker.off("dragend");
      this.seekerToMarker.on("dragend", () => {
        const p = this.seekerToMarker!.getLatLng();
        fn({ lat: p.lat, lon: p.lng });
      });
    }
  }

  renderCandidates(survivors: Candidate[], eliminated: Candidate[]): void {
    this.candidateLayer.clearLayers();
    for (const c of eliminated) {
      L.circleMarker([c.lat, c.lon], {
        radius: 3,
        color: COLORS.eliminated,
        weight: 0,
        fillColor: COLORS.eliminated,
        fillOpacity: 0.5,
      }).addTo(this.candidateLayer);
    }
    for (const c of survivors) {
      L.circleMarker([c.lat, c.lon], {
        radius: 6,
        color: "#fff",
        weight: 1,
        fillColor: COLORS.survivor,
        fillOpacity: 0.9,
      })
        .bindTooltip(c.name)
        .addTo(this.candidateLayer);
    }
  }

  renderLois(lois: Loi[]): void {
    this.loiLayer.clearLayers();
    for (const loi of lois) {
      L.marker([loi.lat, loi.lon], {
        icon: divPin("⚑", loi.enabled ? COLORS.loi : COLORS.loiOff),
        opacity: loi.enabled ? 1 : 0.5,
      })
        .bindTooltip(loi.name)
        .addTo(this.loiLayer);
    }
  }

  clearPreview(): void {
    this.previewLayer.clearLayers();
    this.previewAreaLayer.clearLayers();
    this.radarCircle = null;
  }

  /**
   * Shade the area a pending answer *would* eliminate (Ask-tab preview). Drawn in
   * the drop colour and distinct from the committed red "Eliminated area" overlay.
   * `polygons` is a geographic multipolygon (outer ring + holes per polygon).
   */
  renderPreviewArea(polygons: [number, number][][][]): void {
    this.previewAreaLayer.clearLayers();
    for (const rings of polygons) {
      if (rings.length === 0) continue;
      L.polygon(rings, {
        renderer: this.areaRenderer,
        stroke: true,
        color: COLORS.previewDrop,
        weight: 1,
        opacity: 0.6,
        fillColor: COLORS.previewDrop,
        fillOpacity: 0.2,
        interactive: false,
      }).addTo(this.previewAreaLayer);
    }
  }

  /**
   * Build the toggleable overlay layers (play-region boundary, admin
   * regions, eliminated-area polygons, transit lines, and one point layer per
   * matching-feature category) and a Leaflet layers control. `onAreaVisible`
   * fires whenever the eliminated-area layer is toggled so the caller can lazily
   * compute the polygons.
   */
  setupOverlays(ds: Dataset, onAreaVisible: (visible: boolean) => void): void {
    const overlays: Record<string, L.Layer> = {};

    // Play-region boundary (Seattle + Eastside extension); default ON. A
    // multipolygon whose polygons each have an exterior ring followed by holes.
    const boundaryLayer = L.layerGroup();
    for (const poly of ds.boundary ?? []) {
      if (poly.length === 0 || poly[0].length < 3) continue;
      L.polygon(poly as [number, number][][], {
        color: "#111827",
        weight: 2,
        opacity: 0.7,
        fill: false,
        interactive: false,
      }).addTo(boundaryLayer);
    }
    boundaryLayer.addTo(this.map);
    overlays["Play region"] = boundaryLayer;

    // Admin matching regions, one toggle per tier (coarse -> fine).
    const adminColors: Record<string, string> = {
      city: "#b45309",
      neighborhood: "#7c3aed",
      neighborhood_region: "#0e7490",
    };
    const adminLabels: Record<string, string> = {
      city: "Regions · city",
      neighborhood: "Regions · neighborhood",
      neighborhood_region: "Regions · neighborhood region",
    };
    for (const key of ds.config.admin_regions) {
      const polys = ds.admin_polygons[key];
      if (!polys || polys.length === 0) continue;
      const grp = L.layerGroup();
      const color = adminColors[key] ?? "#6b7280";
      for (const poly of polys) {
        L.polygon(poly.ring as [number, number][], {
          color,
          weight: 1.2,
          opacity: 0.7,
          fillColor: color,
          fillOpacity: 0.05,
        })
          .bindTooltip(poly.name, { sticky: true })
          .addTo(grp);
      }
      overlays[adminLabels[key] ?? `Regions · ${key}`] = grp;
    }

    // Transit lines (hider network), colored by brand; default ON. Each line may
    // have several segments (both directions / branches).
    const transitLayer = L.layerGroup();
    for (const line of ds.transit_lines) {
      for (const seg of line.segments) {
        L.polyline(seg as [number, number][], {
          color: line.color,
          weight: line.route_type === 0 ? 5 : 4,
          opacity: 0.85,
        })
          .bindTooltip(line.name, { sticky: true })
          .addTo(transitLayer);
      }
    }
    transitLayer.addTo(this.map);
    overlays["Transit lines"] = transitLayer;

    // Coastline reference: the OSM `natural=coastline` polylines (the Puget Sound
    // saltwater shoreline) used by the "measuring coastline" question. Default
    // OFF; drawn in water blue. Note this covers salt water only — inland lakes
    // (Washington, Sammamish) are not coastline.
    const coastlines = ds.coastlines ?? [];
    if (coastlines.length > 0) {
      const coastLayer = L.layerGroup();
      for (const line of coastlines) {
        if (line.length < 2) continue;
        L.polyline(line as [number, number][], {
          color: "#0369a1",
          weight: 2.5,
          opacity: 0.85,
        })
          .bindTooltip("Coastline", { sticky: true })
          .addTo(coastLayer);
      }
      overlays[`Coastline (${coastlines.length})`] = coastLayer;
    }

    // Bodies of water: named OSM `natural=water` borders (lakes, rivers, bays,
    // canals) used by the "measuring body of water" question. Default OFF; drawn
    // in a lighter aqua to distinguish from the saltwater coastline above.
    const waterBodies = ds.water_bodies ?? [];
    if (waterBodies.length > 0) {
      const waterLayer = L.layerGroup();
      for (const line of waterBodies) {
        if (line.length < 2) continue;
        L.polyline(line as [number, number][], {
          color: "#0891b2",
          weight: 2,
          opacity: 0.85,
        })
          .bindTooltip("Body of water", { sticky: true })
          .addTo(waterLayer);
      }
      overlays[`Bodies of water (${waterBodies.length})`] = waterLayer;
    }

    // Eliminated-area polygons; computed lazily by the caller when toggled on.
    // Default ON so seekers immediately see the ruled-out region.
    this.areaLayer.addTo(this.map);
    overlays["Eliminated area"] = this.areaLayer;

    // Feature reference points: one toggleable layer per feature kind used by
    // Measuring or Matching questions (park, library, museum, rail_station, …).
    // All default OFF (parks alone are ~2800 points).
    const featureKinds = [...new Set([...ds.config.measuring_kinds, ...ds.config.matching_kinds])];
    featureKinds.forEach((kind, i) => {
      const feats = ds.features_by_kind[kind] ?? [];
      if (feats.length === 0) return;
      const color = FEATURE_COLORS[i % FEATURE_COLORS.length];
      const grp = L.layerGroup();
      for (const f of feats) {
        const marker = L.circleMarker([f.lat, f.lon], {
          renderer: this.featureRenderer,
          radius: 7,
          color: "#fff",
          weight: 1,
          fillColor: color,
          fillOpacity: 0.9,
        })
          .bindTooltip(`${f.name || featureLabel(kind)} (${featureLabel(kind)}) — double-tap to toggle`)
          .on("dblclick", (e: L.LeafletMouseEvent) => {
            // Swallow the event so Leaflet's double-click zoom doesn't also fire.
            L.DomEvent.stop(e.originalEvent);
            this.featureClickCb?.(f.id);
          })
          .addTo(grp);
        this.matchingMarkers.set(f.id, { marker, color });
      }
      this.matchingLayers.set(kind, grp);
      overlays[`Features · ${featureLabel(kind)} (${feats.length})`] = grp;
    });

    L.control.layers(undefined, overlays, { collapsed: true, position: "topright" }).addTo(this.map);

    this.map.on("overlayadd", (e: L.LayersControlEvent) => {
      if (e.layer === this.areaLayer) onAreaVisible(true);
      const kind = this.kindForLayer(e.layer);
      if (kind) {
        this.matchingVisible.add(kind);
        this.matchingToggleCb?.();
      }
    });
    this.map.on("overlayremove", (e: L.LayersControlEvent) => {
      if (e.layer === this.areaLayer) onAreaVisible(false);
      const kind = this.kindForLayer(e.layer);
      if (kind) {
        this.matchingVisible.delete(kind);
        this.matchingToggleCb?.();
      }
    });
  }

  private kindForLayer(layer: L.Layer): string | null {
    for (const [kind, grp] of this.matchingLayers) {
      if (grp === layer) return kind;
    }
    return null;
  }

  /** Matching-feature categories with their point counts and current visibility. */
  matchingCategories(): { kind: string; label: string; count: number; visible: boolean }[] {
    const out: { kind: string; label: string; count: number; visible: boolean }[] = [];
    for (const [kind, grp] of this.matchingLayers) {
      const count = (grp.getLayers() as L.Layer[]).length;
      out.push({ kind, label: featureLabel(kind), count, visible: this.matchingVisible.has(kind) });
    }
    return out;
  }

  /** Show/hide a matching-feature category layer (keeps the layer control in sync). */
  setMatchingCategoryVisible(kind: string, visible: boolean): void {
    const grp = this.matchingLayers.get(kind);
    if (!grp) return;
    if (visible) {
      if (!this.map.hasLayer(grp)) this.map.addLayer(grp);
      this.matchingVisible.add(kind);
    } else {
      if (this.map.hasLayer(grp)) this.map.removeLayer(grp);
      this.matchingVisible.delete(kind);
    }
  }

  /** Register a callback fired whenever a matching-feature layer is toggled. */
  onMatchingToggle(cb: () => void): void {
    this.matchingToggleCb = cb;
  }

  /** Register a callback fired when a feature point is tapped (id of the point). */
  onFeatureClick(cb: (id: string) => void): void {
    this.featureClickCb = cb;
  }

  /** Update which feature points are disabled and restyle them (greyed/hollow). */
  setDisabledFeatures(ids: ReadonlySet<string>): void {
    this.disabledFeatures = ids;
    for (const id of this.matchingMarkers.keys()) this.styleFeatureMarker(id);
  }

  private styleFeatureMarker(id: string): void {
    const entry = this.matchingMarkers.get(id);
    if (!entry) return;
    const off = this.disabledFeatures.has(id);
    entry.marker.setStyle({
      fillColor: off ? COLORS.eliminated : entry.color,
      color: off ? COLORS.eliminated : "#fff",
      fillOpacity: off ? 0.35 : 0.9,
      weight: off ? 0 : 1,
    });
  }

  /** Draw the eliminated area as translucent red polygon(s) (even-odd holes). */
  /**
   * Draw the eliminated area as translucent red polygons. `polygons` is a
   * multipolygon: each entry is an array of rings ([lat, lon] pairs) whose first
   * ring is the outer boundary and the rest are holes — Leaflet renders the
   * holes natively.
   */
  renderArea(polygons: [number, number][][][]): void {
    this.areaLayer.clearLayers();
    if (polygons.length === 0) return;
    for (const rings of polygons) {
      if (rings.length === 0) continue;
      L.polygon(rings, {
        renderer: this.areaRenderer,
        stroke: true,
        color: "#b91c1c",
        weight: 1,
        opacity: 0.5,
        fillColor: "#dc2626",
        fillOpacity: 0.25,
        interactive: false,
      }).addTo(this.areaLayer);
    }
  }

  clearArea(): void {
    this.areaLayer.clearLayers();
  }

  /** Create or cheaply update the live radar circle (used while dragging the slider). */
  setRadarCircle(center: LatLon, radiusMi: number): void {
    const meters = radiusMi * 1609.34;
    if (!this.radarCircle) {
      this.radarCircle = L.circle([center.lat, center.lon], {
        radius: meters,
        color: COLORS.previewKeep,
        weight: 2,
        fillColor: COLORS.previewKeep,
        fillOpacity: 0.08,
        interactive: false,
      }).addTo(this.previewLayer);
    } else {
      this.radarCircle.setLatLng([center.lat, center.lon]);
      this.radarCircle.setRadius(meters);
    }
  }

  /** Draw a radar circle and color candidates inside vs outside. */
  showRadarPreview(center: LatLon, radiusMi: number, inside: Candidate[], outside: Candidate[]): void {
    this.previewLayer.clearLayers();
    this.radarCircle = null;
    this.setRadarCircle(center, radiusMi);
    this.paintPreview(inside, outside);
  }

  /** Color candidates that would survive (keep) vs be eliminated (drop). */
  paintPreview(keep: Candidate[], drop: Candidate[]): void {
    for (const c of drop) {
      L.circleMarker([c.lat, c.lon], {
        radius: 5,
        color: COLORS.previewDrop,
        weight: 1,
        fillColor: COLORS.previewDrop,
        fillOpacity: 0.85,
        interactive: false,
      }).addTo(this.previewLayer);
    }
    for (const c of keep) {
      L.circleMarker([c.lat, c.lon], {
        radius: 6,
        color: "#fff",
        weight: 1,
        fillColor: COLORS.previewKeep,
        fillOpacity: 0.95,
        interactive: false,
      }).addTo(this.previewLayer);
    }
  }

  showThermometerPreview(from: LatLon, to: LatLon): void {
    L.polyline(
      [
        [from.lat, from.lon],
        [to.lat, to.lon],
      ],
      { color: COLORS.seekerTo, weight: 3, dashArray: "6 6" },
    ).addTo(this.previewLayer);
  }
}
