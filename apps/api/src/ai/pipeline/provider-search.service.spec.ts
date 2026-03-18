import { ProviderSearchService } from './provider-search.service';
import type { ParsedIntent } from '../types/pipeline.types';
import type { PoiItem } from '../types/poi.types';

const buildPoi = (
  id: string,
  category: PoiItem['category'],
  lat: number,
): PoiItem => ({
  id,
  name: `POI ${id}`,
  address: `Address ${id}`,
  category,
  coordinates: { lat, lon: 37.6 },
  rating: 4.2,
});

describe('ProviderSearchService mass collection shadow diagnostics', () => {
  const baseIntent: ParsedIntent = {
    city: 'Москва',
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
    categories: ['museum'],
    excluded_categories: [],
    radius_km: 5,
    start_time: '10:00',
    end_time: '20:00',
    preferences_text: '',
  };

  it('fills diagnostics for KudaGo ok + Overpass ok', async () => {
    const kudagoPois = [buildPoi('k-1', 'museum', 55.71)];
    const overpassPois = [buildPoi('o-1', 'park', 55.75)];

    const service = new ProviderSearchService(
      { fetchByIntent: jest.fn().mockResolvedValue(kudagoPois) } as never,
      { fetchByIntent: jest.fn().mockResolvedValue(overpassPois) } as never,
      {
        client: { chat: { completions: { create: jest.fn() } } },
        model: 'test',
      } as never,
      { search: jest.fn() } as never,
    );

    const result = await service.fetchAndFilter({ ...baseIntent }, []);

    expect(result.pois).toHaveLength(2);
    expect(result.shadowDiagnostics).toMatchObject({
      provider_stats: [
        {
          provider: 'kudago',
          attempted: true,
          raw_count: 1,
          used_count: 1,
          failed: false,
        },
        {
          provider: 'overpass',
          attempted: true,
          raw_count: 2,
          used_count: 1,
          failed: false,
        },
        {
          provider: 'photon',
          attempted: false,
          raw_count: 0,
          used_count: 0,
          failed: false,
        },
        {
          provider: 'llm_fill',
          attempted: false,
          raw_count: 0,
          used_count: 0,
          failed: false,
        },
      ],
      totals: {
        before_dedup: 2,
        after_dedup: 2,
        returned: 2,
      },
    });
  });

  it('fills diagnostics for KudaGo empty + Overpass fallback', async () => {
    const overpassPois = [
      buildPoi('o-1', 'park', 55.75),
      buildPoi('o-2', 'museum', 55.79),
    ];
    const fallbacks: string[] = [];

    const service = new ProviderSearchService(
      { fetchByIntent: jest.fn().mockResolvedValue([]) } as never,
      { fetchByIntent: jest.fn().mockResolvedValue(overpassPois) } as never,
      {
        client: { chat: { completions: { create: jest.fn() } } },
        model: 'test',
      } as never,
      { search: jest.fn() } as never,
    );

    const result = await service.fetchAndFilter({ ...baseIntent }, fallbacks);

    expect(result.pois).toHaveLength(2);
    expect(fallbacks).toContain('KUDAGO_UNAVAILABLE_OVERPASS_ONLY');
    expect(result.shadowDiagnostics?.provider_stats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'kudago',
          attempted: true,
          raw_count: 0,
          used_count: 0,
        }),
        expect.objectContaining({
          provider: 'overpass',
          attempted: true,
          raw_count: 4,
          used_count: 2,
        }),
      ]),
    );
  });

  it('marks llm_fill as attempted when provider shortage remains', async () => {
    const kudagoPois = [buildPoi('k-1', 'museum', 55.71)];
    const overpassPois = [
      buildPoi('o-1', 'park', 55.75),
      buildPoi('o-2', 'attraction', 55.79),
    ];

    const service = new ProviderSearchService(
      { fetchByIntent: jest.fn().mockResolvedValue(kudagoPois) } as never,
      { fetchByIntent: jest.fn().mockResolvedValue(overpassPois) } as never,
      {
        client: { chat: { completions: { create: jest.fn() } } },
        model: 'test',
      } as never,
      { search: jest.fn() } as never,
    );

    jest
      .spyOn(service as any, 'generateMissingPois')
      .mockResolvedValue([
        buildPoi('l-1', 'cafe', 55.81),
        buildPoi('l-2', 'restaurant', 55.83),
        buildPoi('l-3', 'park', 55.85),
      ]);

    const result = await service.fetchAndFilter({ ...baseIntent, days: 3 }, []);

    expect(result.shadowDiagnostics?.provider_stats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: 'llm_fill',
          attempted: true,
          raw_count: 3,
          used_count: 3,
          failed: false,
        }),
      ]),
    );
    expect(result.shadowDiagnostics?.totals.before_dedup).toBe(6);
    expect(result.pois).toHaveLength(6);
  });
});
