import { VectorPrefilterService } from './vector-prefilter.service';
import type { PoiItem } from '../types/poi.types';

describe('VectorPrefilterService', () => {
  const candidates: PoiItem[] = [
    {
      id: 'poi-1',
      name: 'Точка 1',
      address: 'Москва',
      category: 'museum',
      coordinates: {
        lat: 55.75,
        lon: 37.61,
      },
    },
    {
      id: 'poi-2',
      name: 'Точка 2',
      address: 'Москва',
      category: 'park',
      coordinates: {
        lat: 55.76,
        lon: 37.62,
      },
    },
  ];

  afterEach(() => {
    delete process.env.AI_VECTOR_INDEX_NAME;
  });

  it('returns ok when Redis is available and FT.SEARCH command succeeds', async () => {
    const redisService = {
      isAvailable: true,
      executeCommand: jest.fn().mockResolvedValue([0]),
    };
    const service = new VectorPrefilterService(redisService as never);

    const result = await service.runShadowPrefilter('persona', candidates, 5);

    expect(result).toEqual({
      status: 'ok',
      total_candidates: 2,
      selected_count: 2,
      top_k: 5,
    });
  });

  it('returns fallback VECTOR_INDEX_MISSING when RediSearch index is missing', async () => {
    const redisService = {
      isAvailable: true,
      executeCommand: jest
        .fn()
        .mockRejectedValue(new Error('Unknown Index name')),
    };
    const service = new VectorPrefilterService(redisService as never);

    const result = await service.runShadowPrefilter('persona', candidates, 10);

    expect(result).toEqual({
      status: 'fallback',
      reason: 'VECTOR_INDEX_MISSING',
      total_candidates: 2,
      selected_count: 2,
      top_k: 10,
    });
  });

  it('returns fallback REDISEARCH_UNAVAILABLE when Redis is unavailable', async () => {
    const redisService = {
      isAvailable: false,
      executeCommand: jest.fn(),
    };
    const service = new VectorPrefilterService(redisService as never);

    const result = await service.runShadowPrefilter('persona', candidates, 3);

    expect(result).toEqual({
      status: 'fallback',
      reason: 'REDISEARCH_UNAVAILABLE',
      total_candidates: 2,
      selected_count: 2,
      top_k: 3,
    });
    expect(redisService.executeCommand).not.toHaveBeenCalled();
  });
});
