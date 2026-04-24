export type ElementCategory =
  | 'flower'
  | 'tree'
  | 'vegetable'
  | 'fruit'
  | 'herb'
  | 'structure'
  | 'water'
  | 'landscape'
  | 'accessory';

export interface GardenElement {
  id: string;
  name: string;
  emoji: string;
  category: ElementCategory;
  size: 1 | 2 | 3;
  tileColor: string;
  wateringDays?: number;
}

export interface PlacedElement {
  id: string;
  elementId: string;
  x: number;
  y: number;
  gardenId: string;
  placedAt: string;
}

export type HealthStatus = 'healthy' | 'needs_attention' | 'sick';
export type CareAction = 'watered' | 'pruned' | 'fertilized' | 'health_check';
export type Priority = 'high' | 'medium' | 'low';

export interface Garden {
  id: string;
  user_id: string;
  name: string;
  location_lat: number | null;
  location_lon: number | null;
  grid_rows: number;
  grid_cols: number;
  created_at: string;
}

export interface Plant {
  id: string;
  garden_id: string;
  user_id: string;
  name: string;
  species: string | null;
  type: PlantType;
  grid_x: number | null;
  grid_y: number | null;
  photo_url: string | null;
  watering_interval_days: number;
  last_watered_at: string | null;
  health_status: HealthStatus;
  care_notes: string | null;
  created_at: string;
}

export type PlantType =
  | 'tree'
  | 'flower'
  | 'vegetable'
  | 'herb'
  | 'grass'
  | 'cactus'
  | 'succulent'
  | 'shrub'
  | 'fruit'
  | 'other';

export interface CareLog {
  id: string;
  plant_id: string;
  user_id: string;
  action: CareAction;
  notes: string | null;
  logged_at: string;
}

export interface WeatherData {
  temperature: number;
  precipitation: number;
  wind_speed: number;
  weathercode: number;
  daily: DailyWeather[];
}

export interface DailyWeather {
  date: string;
  temp_max: number;
  temp_min: number;
  precipitation: number;
  precipitation_probability: number;
  weathercode: number;
}

export interface CareSuggestion {
  id: string;
  plant_id: string;
  plant_name: string;
  plant_emoji: string;
  action: string;
  reason: string;
  priority: Priority;
}

export interface PlantIdResult {
  name: string;
  probability: number;
  common_names: string[];
  wiki_description?: string;
  watering?: string;
}

export type ZoneType =
  | 'raised_bed'
  | 'flower_bed'
  | 'lawn'
  | 'tree'
  | 'vegetable_patch'
  | 'fruit'
  | 'shrub'
  | 'path'
  | 'other';

export interface GardenZone {
  id: string;
  garden_id: string;
  name: string;
  type: ZoneType;
  x: number;       // 0–100 percent of canvas width
  y: number;       // 0–100 percent of canvas height
  width: number;   // 0–100 percent
  height: number;  // 0–100 percent
  detected_plants: string[];
  description: string | null;
  created_at: string;
}
