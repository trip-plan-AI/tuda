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
