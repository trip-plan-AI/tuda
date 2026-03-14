import { VectorPrefilterService } from './vector-prefilter.service';
import type { PoiItem } from '../types/poi.types';

describe('VectorPrefilterService', () => {
  const embedding = new Array<number>(1536).fill(0.01);

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

  it('writes POI embeddings on cache miss and returns ok from KNN search', async () => {
    const executeCommand = jest.fn(
      async (command: string, ...args: unknown[]) => {
        if (command === 'FT.INFO') return ['index_definition'];
        if (command === 'HGET') return null;
        if (command === 'HSET') return 1;
        if (command === 'EXPIRE') return 1;
        if (command === 'FT.SEARCH')
          return [2, 'ai:poi:vec:poi-1', 'ai:poi:vec:poi-2'];
        throw new Error(`Unexpected command: ${command} ${args.join(' ')}`);
      },
    );

    const redisService = {
      isAvailable: true,
      executeCommand,
    };
    const llmClientService = {
      client: {
        embeddings: {
          create: jest
            .fn()
            .mockResolvedValue({ data: [{ embedding }] })
            .mockResolvedValueOnce({ data: [{ embedding }] })
            .mockResolvedValueOnce({ data: [{ embedding }] })
            .mockResolvedValueOnce({ data: [{ embedding }] }),
        },
      },
    };
    const service = new VectorPrefilterService(
      redisService as never,
      llmClientService as never,
    );

    const result = await service.runShadowPrefilter('persona', candidates, 5);

    expect(result).toEqual({
      status: 'ok',
      total_candidates: 2,
      selected_count: 2,
      top_k: 5,
    });

    expect(llmClientService.client.embeddings.create).toHaveBeenCalledTimes(3);
    expect(llmClientService.client.embeddings.create).toHaveBeenNthCalledWith(
      1,
      {
        model: 'text-embedding-3-small',
        input: '[museum] Точка 1 ()',
      },
    );
    expect(llmClientService.client.embeddings.create).toHaveBeenNthCalledWith(
      2,
      {
        model: 'text-embedding-3-small',
        input: '[park] Точка 2 ()',
      },
    );
    expect(llmClientService.client.embeddings.create).toHaveBeenNthCalledWith(
      3,
      {
        model: 'text-embedding-3-small',
        input: 'persona',
      },
    );

    const hsetCalls = executeCommand.mock.calls.filter(
      ([command]) => command === 'HSET',
    );
    const expireCalls = executeCommand.mock.calls.filter(
      ([command]) => command === 'EXPIRE',
    );

    expect(hsetCalls).toHaveLength(2);
    expect(expireCalls).toHaveLength(2);
  });

  it('does not re-embed POI on cache hit', async () => {
    const executeCommand = jest.fn(async (command: string) => {
      if (command === 'FT.INFO') return ['index_definition'];
      if (command === 'HGET') return Buffer.from([1, 2, 3, 4]);
      if (command === 'FT.SEARCH') return [1, 'ai:poi:vec:poi-1'];
      throw new Error(`Unexpected command: ${command}`);
    });

    const redisService = {
      isAvailable: true,
      executeCommand,
    };
    const llmClientService = {
      client: {
        embeddings: {
          create: jest.fn().mockResolvedValue({ data: [{ embedding }] }),
        },
      },
    };
    const service = new VectorPrefilterService(
      redisService as never,
      llmClientService as never,
    );

    const result = await service.runShadowPrefilter('persona', candidates, 10);

    expect(result).toEqual({
      status: 'ok',
      total_candidates: 2,
      selected_count: 1,
      top_k: 10,
    });

    expect(llmClientService.client.embeddings.create).toHaveBeenCalledTimes(1);
    expect(llmClientService.client.embeddings.create).toHaveBeenCalledWith({
      model: 'text-embedding-3-small',
      input: 'persona',
    });

    expect(
      executeCommand.mock.calls.some(([command]) => command === 'HSET'),
    ).toBe(false);
  });

  it('returns fallback VECTOR_INDEX_MISSING when index create/check fails with unknown index', async () => {
    const redisService = {
      isAvailable: true,
      executeCommand: jest
        .fn()
        .mockRejectedValueOnce(new Error('Unknown Index name'))
        .mockRejectedValueOnce(new Error('Unknown Index name')),
    };
    const llmClientService = {
      client: {
        embeddings: {
          create: jest.fn(),
        },
      },
    };
    const service = new VectorPrefilterService(
      redisService as never,
      llmClientService as never,
    );

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
    const llmClientService = {
      client: {
        embeddings: {
          create: jest.fn(),
        },
      },
    };
    const service = new VectorPrefilterService(
      redisService as never,
      llmClientService as never,
    );

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

  it('returns fallback REDISEARCH_UNAVAILABLE when RediSearch command fails', async () => {
    const redisService = {
      isAvailable: true,
      executeCommand: jest
        .fn()
        .mockResolvedValueOnce(['index_definition'])
        .mockResolvedValueOnce(Buffer.from([1, 2, 3]))
        .mockResolvedValueOnce(Buffer.from([1, 2, 3]))
        .mockRejectedValueOnce(new Error('Connection timeout')),
    };
    const llmClientService = {
      client: {
        embeddings: {
          create: jest.fn().mockResolvedValue({ data: [{ embedding }] }),
        },
      },
    };
    const service = new VectorPrefilterService(
      redisService as never,
      llmClientService as never,
    );

    const result = await service.runShadowPrefilter('persona', candidates, 4);

    expect(result).toEqual({
      status: 'fallback',
      reason: 'REDISEARCH_UNAVAILABLE',
      total_candidates: 2,
      selected_count: 2,
      top_k: 4,
    });
  });
});
