export interface AiPoi {
  id: string;
  name: string;
  address: string;
  coordinates: {
    lat: number;
    lon: number;
  };
  category: 'museum' | 'park' | 'restaurant' | 'cafe' | 'attraction' | 'shopping' | 'entertainment';
  rating?: number;
  working_hours?: string;
  price_segment?: 'free' | 'budget' | 'mid' | 'premium';
  phone?: string;
  website?: string;
  image_url?: string;
  description?: string;
}

export interface ChatPlannedPoint {
  poi: AiPoi;
  order: number;
  arrival_time: string;
  departure_time: string;
  visit_duration_min: number;
  travel_from_prev_min?: number;
  estimated_cost?: number;
}

export interface ChatRoutePlanDay {
  day_number: number;
  date: string;
  points: ChatPlannedPoint[];
  day_budget_estimated: number;
  day_start_time: string;
  day_end_time: string;
}

export interface ChatRoutePlan {
  city: string;
  days: ChatRoutePlanDay[];
  total_budget_estimated: number;
  notes?: string;
}

export interface ChatMeta {
  steps_duration_ms: {
    orchestrator: number;
    yandex_fetch: number;
    semantic_filter: number;
    scheduler: number;
    total: number;
  };
  poi_counts: {
    yandex_raw: number;
    after_prefilter: number;
    after_semantic: number;
  };
  fallbacks_triggered: string[];
}

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  routePlan?: ChatRoutePlan;
  meta?: ChatMeta;
  timestamp: string;
  isError?: boolean;
  userName?: string;
  userAvatar?: string;
}
