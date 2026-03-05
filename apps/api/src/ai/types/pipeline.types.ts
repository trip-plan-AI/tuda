export type ChatRole = 'user' | 'assistant';

export interface SessionMessage {
  role: ChatRole;
  content: string;
}

export type PoiCategory =
  | 'museum'
  | 'park'
  | 'restaurant'
  | 'cafe'
  | 'attraction'
  | 'shopping'
  | 'entertainment';

export interface ParsedIntent {
  city: string;
  days: number;
  budget_total: number | null;
  budget_per_day: number | null;
  party_type: 'solo' | 'couple' | 'family' | 'group';
  party_size: number;
  categories: PoiCategory[];
  excluded_categories: PoiCategory[];
  radius_km: number;
  start_time: string;
  end_time: string;
  preferences_text: string;
}

export interface PlanDayPoint {
  poi_id: string;
  order: number;
  arrival_time: string;
  departure_time: string;
  estimated_cost: number;
}

export interface PlanDay {
  day_number: number;
  date: string;
  day_budget_estimated: number;
  points: PlanDayPoint[];
}

export interface RoutePlan {
  city: string;
  total_budget_estimated: number;
  days: PlanDay[];
  notes?: string;
}
