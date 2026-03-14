export type ChatRole = 'user' | 'assistant';

import type { PoiItem } from './poi.types';

export interface SessionMessage {
  role: ChatRole;
  content: string;
  route_plan?: RoutePlan;
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
  budget_per_person: number | null; // budget_total / party_size
  party_type: 'solo' | 'couple' | 'family' | 'group';
  party_size: number;
  // Quantitative constraints extracted from user query
  poi_count_requested: number | null; // e.g., "Find 3 places"
  min_restaurants: number | null; // e.g., "2 best cafes"
  min_cafes: number | null;
  max_poi: number | null; // e.g., "not more than 5 places"
  categories: PoiCategory[];
  excluded_categories: PoiCategory[];
  radius_km: number;
  start_time: string;
  end_time: string;
  preferences_text: string;
}

export interface PlanDayPoint {
  poi_id: string;
  poi: PoiItem;
  order: number;
  arrival_time: string;
  departure_time: string;
  visit_duration_min: number;
  travel_from_prev_min?: number;
  estimated_cost: number;
}

export interface PlanDay {
  day_number: number;
  date: string;
  day_budget_estimated: number;
  day_start_time: string;
  day_end_time: string;
  points: PlanDayPoint[];
}

export interface RoutePlan {
  city: string;
  total_budget_estimated: number;
  days: PlanDay[];
  notes?: string;
}

export type PlannerVersion = 'legacy' | 'v2-shadow' | 'v2';

export type PipelineStageStatus = 'ok' | 'fallback' | 'skipped';

export interface PipelineStatus {
  intent: PipelineStageStatus;
  provider: PipelineStageStatus;
  semantic: PipelineStageStatus;
  scheduler: PipelineStageStatus;
}

export interface PlanResponseContractMeta {
  planner_version: PlannerVersion;
  pipeline_status: PipelineStatus;
  policy_snapshot?: PolicySnapshot;
  mass_collection_shadow?: MassCollectionShadowMeta;
  yandex_batch_refinement?: YandexBatchRefinementMeta;
  mutation_applied?: boolean;
  mutation_type?: IntentRouterActionType;
  mutation_fallback_reason?: string;
}

export type YandexBatchRefinementStatus = 'ok' | 'fallback';

export interface YandexBatchRefinementDiagnostics {
  batch_count: number;
  failed_batches: number;
  fallback_reasons: string[];
}

export interface YandexBatchRefinementMeta extends YandexBatchRefinementDiagnostics {
  status: YandexBatchRefinementStatus;
}

// TRI-108-6: Added 'photon' for food-specific venue search
export type MassCollectionShadowProvider = 'kudago' | 'overpass' | 'llm_fill' | 'photon';

export interface MassCollectionShadowProviderStat {
  provider: MassCollectionShadowProvider;
  attempted: boolean;
  raw_count: number;
  used_count: number;
  failed: boolean;
  fail_reason?: string;
}

export interface MassCollectionShadowMeta {
  provider_stats: MassCollectionShadowProviderStat[];
  totals: {
    before_dedup: number;
    after_dedup: number;
    returned: number;
  };
}

export interface LogicalIdShadowMeta {
  total_candidates: number;
  duplicates_groups: number;
  duplicates_total: number;
}

export type VectorPrefilterShadowStatus = 'ok' | 'fallback';

export type VectorPrefilterShadowFallbackReason =
  | 'REDISEARCH_UNAVAILABLE'
  | 'VECTOR_INDEX_MISSING';

export interface VectorPrefilterShadowMeta {
  status: VectorPrefilterShadowStatus;
  reason?: VectorPrefilterShadowFallbackReason;
  total_candidates: number;
  selected_count: number;
  top_k: number;
}

export type DeterministicPlannerShadowStatus = 'ok' | 'fallback';

export type DeterministicPlannerMode = 'shadow';

export interface DeterministicPlannerDecisionSummary {
  days_count: number;
  points_total: number;
  unique_poi_count: number;
  duplicate_poi_count: number;
}

export interface DeterministicPlannerShadowMeta {
  status: DeterministicPlannerShadowStatus;
  input_hash: string | null;
  decision_summary: DeterministicPlannerDecisionSummary | null;
  deterministic_mode: DeterministicPlannerMode;
}

export type FoodMode = 'none' | 'gastrotour' | 'default';

export interface PolicySnapshot {
  required_capacity: number;
  food_policy: {
    food_mode: FoodMode;
    food_interval_hours: number;
  };
  user_persona_summary: string;
  policy_version: Extract<PlannerVersion, 'v2-shadow' | 'v2'>;
}

export type IntentRouterActionType =
  | 'REMOVE_POI'
  | 'REPLACE_POI'
  | 'ADD_POI'
  | 'ADD_DAYS'
  | 'APPLY_GLOBAL_FILTER'
  | 'NEW_ROUTE';

export type IntentRouterRouteMode = 'targeted_mutation' | 'full_rebuild';

export interface IntentRouterDecision {
  action_type: IntentRouterActionType;
  confidence: number;
  target_poi_id: string | null;
  route_mode: IntentRouterRouteMode;
  fallback_reason?: 'LOW_CONFIDENCE';
}
