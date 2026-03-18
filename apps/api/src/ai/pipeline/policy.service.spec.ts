import { PolicyService } from './policy.service';
import type { ParsedIntent } from '../types/pipeline.types';

describe('PolicyService', () => {
  const baseIntent: ParsedIntent = {
    city: 'Москва',
    days: 3,
    budget_total: 12000,
    budget_per_day: 4000,
    budget_per_person: 6000,
    poi_count_requested: null,
    min_restaurants: null,
    min_cafes: null,
    max_poi: null,
    party_type: 'couple',
    party_size: 2,
    categories: ['museum', 'restaurant'],
    excluded_categories: [],
    radius_km: 5,
    start_time: '10:00',
    end_time: '20:00',
    preferences_text: 'хочется спокойный маршрут',
  };

  it('calculates required_capacity as days * 5 + 20% buffer with ceil', () => {
    const service = new PolicyService();

    const result = service.calculatePolicySnapshot(baseIntent, [], 'v2-shadow');

    expect(result.required_capacity).toBe(18);
  });

  it('sets food_mode=none when user explicitly asks for no food', () => {
    const service = new PolicyService();

    const result = service.calculatePolicySnapshot(
      {
        ...baseIntent,
        preferences_text: 'маршрут без еды и без ресторанов',
      },
      [],
      'v2-shadow',
    );

    expect(result.food_policy).toEqual({
      food_mode: 'none',
      food_interval_hours: 4,
    });
  });

  it('sets food_mode=gastrotour with interval 2.0 for strong food focus', () => {
    const service = new PolicyService();

    const result = service.calculatePolicySnapshot(
      {
        ...baseIntent,
        preferences_text: 'хочу гастротур и дегустации локальной кухни',
      },
      [],
      'v2',
    );

    expect(result.food_policy).toEqual({
      food_mode: 'gastrotour',
      food_interval_hours: 2,
    });
    expect(result.policy_version).toBe('v2');
  });
});
