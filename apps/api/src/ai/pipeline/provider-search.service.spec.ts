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
  provider: 'overpass',
});

describe('ProviderSearchService (Refactored)', () => {
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
    country_code: 'RU',
    start_time: '10:00',
    end_time: '20:00',
    preferences_text: '',
  };

  const mockKudago = { fetchByIntent: jest.fn().mockResolvedValue([]) };
  const mockOverpass = { fetchByIntent: jest.fn().mockResolvedValue([]) };
  const mockOsmFetch = { fetchAndFilter: jest.fn().mockResolvedValue([]) };
  const mockLlmClient = {
    isCisRegion: jest.fn().mockReturnValue(true),
    chat: jest.fn().mockResolvedValue(
      JSON.stringify({
        selected_ids: ['o-1'],
        hidden_gems: [],
      }),
    ),
  };
  const mockGeosearch = { suggest: jest.fn().mockResolvedValue([]) };
  const mockAiDiscovery = {};
  const mockFuzzyMatcher = { calculateMatchScore: jest.fn().mockReturnValue(1.0) };
  const mockCityAnalyzer = { analyze: jest.fn().mockReturnValue({ description: 'Test context' }) };
  const mockClustering = { clusterPois: jest.fn().mockReturnValue({ clusters: [], noise: [] }) };

  it('successfully executes Stage 1 and Stage 2', async () => {
    const overpassPois = [buildPoi('o-1', 'museum', 55.75)];
    mockOverpass.fetchByIntent.mockResolvedValueOnce(overpassPois);

    const service = new ProviderSearchService(
      mockKudago as any,
      mockOverpass as any,
      mockOsmFetch as any,
      mockLlmClient as any,
      mockGeosearch as any,
      mockAiDiscovery as any,
      mockFuzzyMatcher as any,
      mockCityAnalyzer as any,
      mockClustering as any,
    );

    const result = await service.fetchAndFilter({ ...baseIntent });

    expect(result.pois).toHaveLength(1);
    expect(result.pois[0].id).toBe('o-1');
    expect(result.shadowDiagnostics?.provider_stats).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ provider: 'overpass', raw_count: 1 }),
        expect.objectContaining({ provider: 'discovery', attempted: true }),
      ]),
    );
  });

  it('throws UnprocessableEntityException if no hard data found', async () => {
    mockOverpass.fetchByIntent.mockResolvedValueOnce([]);
    mockKudago.fetchByIntent.mockResolvedValueOnce([]);

    const service = new ProviderSearchService(
      mockKudago as any,
      mockOverpass as any,
      mockOsmFetch as any,
      mockLlmClient as any,
      mockGeosearch as any,
      mockAiDiscovery as any,
      mockFuzzyMatcher as any,
      mockCityAnalyzer as any,
      mockClustering as any,
    );

    await expect(service.fetchAndFilter({ ...baseIntent })).rejects.toThrow(
      'CITY_DATA_UNAVAILABLE',
    );
  });
});
