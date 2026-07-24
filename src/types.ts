// Shared data types for the jetlag_seek webapp. These mirror the shape of
// public/data/dataset.json produced by scripts/build_dataset.py.

export type LatLon = { lat: number; lon: number };

export interface Candidate {
  id: string;
  name: string;
  lat: number;
  lon: number;
  travel_min: number;
}

export interface Feature {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

export interface AdminPolygon {
  name: string;
  ring: [number, number][]; // [lat, lon] pairs
}

export type QuestionCategory =
  | "radar"
  | "measuring"
  | "coast"
  | "matching"
  | "admin"
  | "thermometer";

export interface QuestionSpec {
  category: QuestionCategory;
  name: string;
  payload: string | number; // distance (radar/thermo), feature kind, or admin level
}

export interface DatasetConfig {
  start_station_name: string;
  start_lat: number;
  start_lon: number;
  hiding_period_min: number;
  zone_radius_mi: number;
  radar_bands_mi: number[];
  thermometer_bands_mi: number[];
  measuring_kinds: string[];
  matching_kinds: string[];
  admin_levels: number[];
}

export interface Dataset {
  config: DatasetConfig;
  candidates: Candidate[];
  features_by_kind: Record<string, Feature[]>;
  admin_polygons: Record<string, AdminPolygon[]>;
  coastlines: [number, number][][];
  question_catalog: QuestionSpec[];
  transit_lines: TransitLine[];
}

// A hider-allowed transit line (Link 1/2, RapidRide A-H) for the map overlay.
export interface TransitLine {
  short_name: string;
  long_name: string;
  route_type: number; // 0 = light rail, 3 = bus (RapidRide)
  color: string; // "#RRGGBB"
  points: [number, number][]; // [lat, lon] polyline
}

// A user-added reference pin ("location of interest").
export interface Loi {
  id: string;
  name: string;
  lat: number;
  lon: number;
  enabled: boolean;
}
