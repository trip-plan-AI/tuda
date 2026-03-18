import { DeterministicPlannerService } from './deterministic-planner.service';
import type { ParsedIntent, RoutePlan } from '../types/pipeline.types';
import type { FilteredPoi } from '../types/poi.types';

describe('DeterministicPlannerService', () => {
  const baseIntent: ParsedIntent = {
    city: 'Москва',
    days: 2,
    budget_total: 10000,
    budget_per_day: 5000,
    budget_per_person: 10000,
    poi_count_requested: null,
    min_restaurants: null,
    min_cafes: null,
    max_poi: null,
    party_type: 'solo',
    party_size: 1,
    categories: ['museum'],
    excluded_categories: [],
    radius_km: 5,
    start_time: '10:00',
    end_time: '20:00',
    preferences_text: 'исторические места',
  };

  const selectedPois: FilteredPoi[] = [
    {
      id: 'poi-2',
      name: 'Парк Горького',
      address: 'Крымский Вал, 9, Москва',
      category: 'park',
      description: 'Большой парк в центре города',
      coordinates: { lat: 55.7298, lon: 37.601 },
    },
    {
      id: 'poi-1',
      name: 'ГМИИ им. Пушкина',
      address: 'Волхонка, 12, Москва',
      category: 'museum',
      description: 'Крупнейший художественный музей',
      coordinates: { lat: 55.7472, lon: 37.6052 },
    },
  ];

  it('returns stable hash for equal input data', () => {
    const service = new DeterministicPlannerService();

    const first = service.buildInputHash(baseIntent, selectedPois);
    const second = service.buildInputHash(baseIntent, [...selectedPois]);

    expect(first).toBe(second);
  });

  it('returns different hash when input changes', () => {
    const service = new DeterministicPlannerService();

    const first = service.buildInputHash(baseIntent, selectedPois);
    const second = service.buildInputHash(
      {
        ...baseIntent,
        days: 3,
      },
      selectedPois,
    );

    expect(first).not.toBe(second);
  });

  it('builds decision summary with duplicates count', () => {
    const service = new DeterministicPlannerService();
    const routePlan: RoutePlan = {
      city: 'Москва',
      total_budget_estimated: 7500,
      days: [
        {
          day_number: 1,
          date: '2026-03-12',
          day_budget_estimated: 3500,
          day_start_time: '10:00',
          day_end_time: '20:00',
          points: [
            {
              poi_id: 'poi-1',
              poi: selectedPois[1],
              order: 1,
              arrival_time: '10:00',
              departure_time: '11:00',
              visit_duration_min: 60,
              estimated_cost: 1000,
            },
            {
              poi_id: 'poi-2',
              poi: selectedPois[0],
              order: 2,
              arrival_time: '12:00',
              departure_time: '13:00',
              visit_duration_min: 60,
              estimated_cost: 500,
            },
          ],
        },
        {
          day_number: 2,
          date: '2026-03-13',
          day_budget_estimated: 4000,
          day_start_time: '10:00',
          day_end_time: '20:00',
          points: [
            {
              poi_id: 'poi-1',
              poi: selectedPois[1],
              order: 1,
              arrival_time: '10:30',
              departure_time: '11:30',
              visit_duration_min: 60,
              estimated_cost: 1200,
            },
          ],
        },
      ],
    };

    const summary = service.buildDecisionLogSummary(routePlan);

    expect(summary).toEqual({
      days_count: 2,
      points_total: 3,
      unique_poi_count: 2,
      duplicate_poi_count: 1,
    });
  });
});
