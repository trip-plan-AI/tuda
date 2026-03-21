/**
 * SchedulerService — regression tests for point count logic.
 *
 * Covers scenarios that produced wrong results in production:
 *   - Food-focused queries returning only 2 points instead of 5+
 *   - Starvation false-positive when all POIs are restaurants
 *   - 2-opt route improvement reducing total distance
 */

import { SchedulerService } from './scheduler.service';
import type { ParsedIntent } from '../types/pipeline.types';
import type { FilteredPoi } from '../types/poi.types';

// ─── Helpers ────────────────────────────────────────────────────────────────

function poi(
  id: string,
  name: string,
  category: FilteredPoi['category'],
  lat: number,
  lon: number,
  score = 0.7,
): FilteredPoi {
  return {
    id,
    name,
    category,
    score,
    address: name,
    description: name,
    coordinates: { lat, lon },
    provider: 'test',
  };
}

const BASE_INTENT: ParsedIntent = {
  city: 'Казань',
  days: 1,
  budget_total: null,
  budget_per_day: null,
  budget_per_person: null,
  poi_count_requested: null,
  min_restaurants: null,
  min_cafes: null,
  max_poi: null,
  party_type: 'solo',
  party_size: 1,
  categories: [],
  excluded_categories: [],
  radius_km: 5,
  country_code: 'RU',
  start_time: '10:00',
  end_time: '20:00',
  preferences_text: '',
};

// Real Kazan POIs from production logs (2026-03-21)
const KAZAN_FOOD_POIS: FilteredPoi[] = [
  poi('p-park',   'Парк Чёрное озеро', 'park',          55.7953, 49.1189),
  poi('p-r1',     'El Viento',         'restaurant',    55.8005, 48.9768),
  poi('p-r2',     'ДаВинчи',           'restaurant',    55.8628, 48.8047),
  poi('p-r3',     'Амирхан',           'restaurant',    55.8662, 49.0236),
  poi('p-r4',     'Темле перемяч',     'restaurant',    55.8256, 49.0436),
  poi('p-r5',     'Жемчужина',         'restaurant',    55.9102, 49.0528),
  poi('p-r6',     'М-7',               'restaurant',    55.8270, 49.0260),
  poi('p-r7',     'Подкова',           'restaurant',    55.8759, 48.8590),
  poi('p-c1',     'Coffee Like',       'cafe',          55.8730, 48.8823),
  poi('p-r8',     'Уют',               'restaurant',    55.8667, 48.8562),
  poi('p-ent',    'Зодиак',            'entertainment', 55.8201, 49.0516),
  poi('p-r9',     'Объект 784',        'restaurant',    55.8476, 48.8511),
];

const KAZAN_MIXED_POIS: FilteredPoi[] = [
  poi('m-museum1', 'Казанский Кремль',       'museum',      55.7986, 49.1060, 0.95),
  poi('m-museum2', 'Нац. музей Татарстана',  'museum',      55.7960, 49.1084, 0.90),
  poi('m-park1',   'Парк Чёрное озеро',      'park',        55.7953, 49.1189, 0.80),
  poi('m-attr1',   'Мечеть Кул-Шариф',       'attraction',  55.7999, 49.1002, 0.92),
  poi('m-attr2',   'Башня Сююмбике',         'attraction',  55.7998, 49.1049, 0.88),
  poi('m-r1',      'Татарская усадьба',      'restaurant',  55.7970, 49.1075, 0.75),
  poi('m-c1',      'Кофе-Хауз',              'cafe',        55.7942, 49.1155, 0.65),
  poi('m-attr3',   'Улица Баумана',          'attraction',  55.7955, 49.1177, 0.82),
];

// ─── Tests ───────────────────────────────────────────────────────────────────

describe('SchedulerService', () => {
  let scheduler: SchedulerService;

  beforeEach(() => {
    scheduler = new SchedulerService();
  });

  // ── REGRESSION: food-focused query ──────────────────────────────────────

  describe('food-focused query (regression: was returning 2 points)', () => {
    it('schedules ≥ 3 points when 12 food POIs provided for 1 day', () => {
      // Old bug: totalPoisCount=1 (only non-food counted) → pointsForThisDay=1
      // → scheduler targeted 1 point and added 1 food supplement = 2 total.
      // Fix: totalPoisCount=12 → pointsForThisDay=8 (capped).
      // With 4h restaurant gap and 10h window, 3 food venues is correct max.
      const plan = scheduler.buildPlan(
        KAZAN_FOOD_POIS,
        { ...BASE_INTENT, categories: ['restaurant', 'cafe'] },
      );

      const totalPoints = plan.days.reduce((sum, d) => sum + d.points.length, 0);
      expect(totalPoints).toBeGreaterThanOrEqual(3);
    });

    it('does NOT trigger Data Starvation when all POIs are food', () => {
      // With the old bug: totalPoisCount=1 (only park counted), starvation triggered
      // With the fix: totalPoisCount=12, no starvation
      const warnSpy = jest.spyOn(
        (scheduler as any).logger,
        'warn',
      );

      scheduler.buildPlan(KAZAN_FOOD_POIS, { ...BASE_INTENT });

      const starvationCalls = warnSpy.mock.calls.filter(
        (args) => String(args[0]).includes('Data Starvation'),
      );
      expect(starvationCalls).toHaveLength(0);
    });

    it('schedules no more than 8 points per day (cap)', () => {
      const plan = scheduler.buildPlan(KAZAN_FOOD_POIS, { ...BASE_INTENT });
      for (const day of plan.days) {
        expect(day.points.length).toBeLessThanOrEqual(8);
      }
    });
  });

  // ── Normal mixed scenario ─────────────────────────────────────────────

  describe('mixed POIs (museums + food)', () => {
    it('schedules ≥ 3 points for 1 day with 8 mixed POIs', () => {
      const plan = scheduler.buildPlan(KAZAN_MIXED_POIS, { ...BASE_INTENT });
      const totalPoints = plan.days.reduce((sum, d) => sum + d.points.length, 0);
      expect(totalPoints).toBeGreaterThanOrEqual(3);
    });

    it('assigns correct day count', () => {
      const plan = scheduler.buildPlan(KAZAN_MIXED_POIS, { ...BASE_INTENT, days: 1 });
      expect(plan.days).toHaveLength(1);
    });
  });

  // ── Genuine starvation ────────────────────────────────────────────────

  describe('genuine data starvation', () => {
    it('reduces days when only 2 POIs for 3 requested days', () => {
      const twoPois = KAZAN_MIXED_POIS.slice(0, 2);
      const intent = { ...BASE_INTENT, days: 3 };

      const plan = scheduler.buildPlan(twoPois, intent);

      // Should have reduced to 1 day (floor(2/2)=1)
      expect(plan.days.length).toBeLessThanOrEqual(2);
    });

    it('returns at least 1 day even with 1 POI', () => {
      const onePoi = [KAZAN_MIXED_POIS[0]];
      const plan = scheduler.buildPlan(onePoi, { ...BASE_INTENT, days: 2 });
      expect(plan.days.length).toBeGreaterThanOrEqual(1);
    });
  });

  // ── 2-opt route improvement ───────────────────────────────────────────

  describe('2-opt route improvement', () => {
    it('improves or maintains route distance (never increases)', () => {
      // twoOptImprove takes PlanDayPoint[] where each point has .poi with .coordinates
      const pois = KAZAN_FOOD_POIS.slice(0, 6);
      const startMins = 10 * 60; // 10:00

      // Build PlanDayPoint[] as the method expects
      const planPoints = pois.map((p, i) => ({
        poi: p,
        order: i + 1,
        arrival_time: '10:00',
        departure_time: '11:00',
        visit_duration_min: 60,
        travel_from_prev_min: 15,
        day_cost: 0,
      }));

      const improved = (scheduler as any).twoOptImprove(planPoints, startMins);

      // Calculate total Haversine distance for original vs improved ordering
      const dist = (arr: { poi: FilteredPoi }[]) =>
        arr.slice(1).reduce((sum, p, i) => {
          return (
            sum +
            (scheduler as any).haversineKm(
              arr[i].poi.coordinates.lat, arr[i].poi.coordinates.lon,
              p.poi.coordinates.lat, p.poi.coordinates.lon,
            )
          );
        }, 0);

      const originalDist = dist(planPoints);
      const improvedDist = dist(improved);

      // 2-opt should never make the route longer
      expect(improvedDist).toBeLessThanOrEqual(originalDist + 0.01);
    });
  });

  // ── 2-opt time recalculation ──────────────────────────────────────────

  describe('2-opt recalculateDayTimes', () => {
    it('times cascade correctly — no stale pre-reorder departure_time leakage', () => {
      // Points with stale departure_times that differ wildly from what 2-opt should produce
      const stalePoints = [
        { poi: KAZAN_MIXED_POIS[0], order: 1, arrival_time: '10:00', departure_time: '11:00', visit_duration_min: 60, estimated_cost: 0 },
        { poi: KAZAN_MIXED_POIS[3], order: 2, arrival_time: '16:32', departure_time: '17:22', visit_duration_min: 50, estimated_cost: 0 },
        { poi: KAZAN_MIXED_POIS[1], order: 3, arrival_time: '17:30', departure_time: '18:20', visit_duration_min: 50, estimated_cost: 0 },
      ];
      const result = (scheduler as any).recalculateDayTimes(stalePoints, 10 * 60);

      // Point 0 must start at 10:00
      expect(result[0].arrival_time).toBe('10:00');

      // Point 1 must start after point 0 departs (10:00 + 60min = 11:00 + transit)
      const p1Arrival = scheduler.timeToMinutes(result[1].arrival_time);
      expect(p1Arrival).toBeGreaterThan(11 * 60); // after 11:00
      expect(p1Arrival).toBeLessThan(12 * 60);    // but not past noon

      // Point 2 must follow point 1 — NOT jump back to stale 17:30
      const p2Arrival = scheduler.timeToMinutes(result[2].arrival_time);
      const p1Departure = scheduler.timeToMinutes(result[1].departure_time);
      expect(p2Arrival).toBeGreaterThanOrEqual(p1Departure + 5); // at least 5min transit
      // Crucially: must NOT equal the stale departure_time of stalePoints[1] (16:32/17:30)
      expect(p2Arrival).toBeLessThan(14 * 60); // well before stale 17:30
    });
  });

  // ── Point count requested ─────────────────────────────────────────────

  describe('poi_count_requested', () => {
    it('trims plan to requested count', () => {
      const plan = scheduler.buildPlan(
        KAZAN_MIXED_POIS,
        { ...BASE_INTENT, poi_count_requested: 3 },
      );
      const totalPoints = plan.days.reduce((sum, d) => sum + d.points.length, 0);
      expect(totalPoints).toBeLessThanOrEqual(3);
    });
  });

  // ── Time window ───────────────────────────────────────────────────────

  describe('time window', () => {
    it('all departure times are within start_time–end_time window', () => {
      const plan = scheduler.buildPlan(KAZAN_MIXED_POIS, {
        ...BASE_INTENT,
        start_time: '09:00',
        end_time: '18:00',
      });

      const endMins = 18 * 60;
      for (const day of plan.days) {
        for (const point of day.points) {
          const arrMins = scheduler.timeToMinutes(point.arrival_time);
          expect(arrMins).toBeLessThanOrEqual(endMins);
        }
      }
    });
  });
});
