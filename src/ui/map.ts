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

function divPin(emoji: string, color: string): L.DivIcon {
  return L.divIcon({
    className: "jl-pin",
    html: `<span style="--pin:${color}">${emoji}</span>`,
    iconSize: [28, 28],
    iconAnchor: [14, 26],
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
  private radarCircle: L.Circle | null = null;

  constructor(el: HTMLElement, start: LatLon, seeker: LatLon) {
    this.map = L.map(el, { zoomControl: true }).setView([start.lat, start.lon], 12);
    L.tileLayer("https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png", {
      attribution: "&copy; OpenStreetMap, &copy; CARTO",
      maxZoom: 19,
    }).addTo(this.map);

    this.candidateLayer.addTo(this.map);
    this.previewLayer.addTo(this.map);
    this.loiLayer.addTo(this.map);

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
      }).bindTooltip("Seeker destination").addTo(this.map);
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

  renderCandidates(survivors: Candidate[], eliminated: Candidate[], showEliminated: boolean): void {
    this.candidateLayer.clearLayers();
    if (showEliminated) {
      for (const c of eliminated) {
        L.circleMarker([c.lat, c.lon], {
          radius: 3,
          color: COLORS.eliminated,
          weight: 0,
          fillColor: COLORS.eliminated,
          fillOpacity: 0.5,
        }).addTo(this.candidateLayer);
      }
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
    this.radarCircle = null;
  }

  /**
   * Build the toggleable overlay layers (Seattle City Limit boundary, admin
   * regions, eliminated-area polygons, transit lines) and a Leaflet layers
   * control. `onAreaVisible` fires whenever the eliminated-area layer is toggled
   * so the caller can lazily compute the polygons.
   */
  setupOverlays(ds: Dataset, onAreaVisible: (visible: boolean) => void): void {
    const overlays: Record<string, L.Layer> = {};

    // Seattle City Limit boundary (the play area); default ON.
    const boundaryLayer = L.layerGroup();
    if (ds.boundary && ds.boundary.length >= 3) {
      L.polygon(ds.boundary as [number, number][], {
        color: "#111827",
        weight: 2,
        opacity: 0.7,
        fill: false,
        interactive: false,
      }).addTo(boundaryLayer);
    }
    boundaryLayer.addTo(this.map);
    overlays["Seattle City Limit"] = boundaryLayer;

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

    // Eliminated-area polygons; computed lazily by the caller when toggled on.
    overlays["Eliminated area"] = this.areaLayer;

    L.control.layers(undefined, overlays, { collapsed: true, position: "topright" }).addTo(this.map);

    this.map.on("overlayadd", (e: L.LayersControlEvent) => {
      if (e.layer === this.areaLayer) onAreaVisible(true);
    });
    this.map.on("overlayremove", (e: L.LayersControlEvent) => {
      if (e.layer === this.areaLayer) onAreaVisible(false);
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
      }).addTo(this.previewLayer);
    }
    for (const c of keep) {
      L.circleMarker([c.lat, c.lon], {
        radius: 6,
        color: "#fff",
        weight: 1,
        fillColor: COLORS.previewKeep,
        fillOpacity: 0.95,
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

  fitToSurvivors(survivors: Candidate[]): void {
    if (survivors.length === 0) return;
    const bounds = L.latLngBounds(survivors.map((c) => [c.lat, c.lon] as [number, number]));
    this.map.fitBounds(bounds.pad(0.15));
  }
}
