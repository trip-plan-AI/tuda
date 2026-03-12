import { YandexBatchRefinementService } from './yandex-batch-refinement.service';
import type { FilteredPoi } from '../types/poi.types';

const buildPoi = (id: string): FilteredPoi => ({
  id,
  name: `POI ${id}`,
  address: `Address ${id}`,
  category: 'museum',
  coordinates: { lat: 55.75, lon: 37.61 },
  description: `desc ${id}`,
});

describe('YandexBatchRefinementService', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    process.env.YANDEX_GPT_API_KEY = 'test-key';
    process.env.YANDEX_FOLDER_ID = 'test-folder';
    process.env.YANDEX_BATCH_SIZE = '2';
    process.env.YANDEX_BATCH_TIMEOUT_MS = '8000';
    global.fetch = jest.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    delete process.env.YANDEX_GPT_API_KEY;
    delete process.env.YANDEX_FOLDER_ID;
    delete process.env.YANDEX_BATCH_SIZE;
    delete process.env.YANDEX_BATCH_TIMEOUT_MS;
    jest.clearAllMocks();
  });

  it('chunks input and refines each batch successfully', async () => {
    const service = new YandexBatchRefinementService();
    const pois = [
      buildPoi('p1'),
      buildPoi('p2'),
      buildPoi('p3'),
      buildPoi('p4'),
    ];

    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: true,
        json: () => ({
          result: {
            alternatives: [
              {
                message: {
                  text: JSON.stringify({
                    selected: [
                      { id: '1', description: 'refined 1' },
                      { id: '2', description: 'refined 2' },
                    ],
                  }),
                },
              },
            ],
          },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => ({
          result: {
            alternatives: [
              {
                message: {
                  text: JSON.stringify({
                    selected: [
                      { id: '1', description: 'refined 3' },
                      { id: '2', description: 'refined 4' },
                    ],
                  }),
                },
              },
            ],
          },
        }),
      });

    const result = await service.refineSelectedInBatches(pois, 'persona');

    expect(global.fetch).toHaveBeenCalledTimes(2);
    expect(result.diagnostics).toEqual({
      batch_count: 2,
      failed_batches: 0,
      fallback_reasons: [],
    });
    expect(result.refined.map((poi) => poi.description)).toEqual([
      'refined 1',
      'refined 2',
      'refined 3',
      'refined 4',
    ]);
  });

  it('falls back only failed batch and records reason on partial failure', async () => {
    const service = new YandexBatchRefinementService();
    const pois = [buildPoi('p1'), buildPoi('p2'), buildPoi('p3')];

    (global.fetch as jest.Mock)
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
      })
      .mockResolvedValueOnce({
        ok: true,
        json: () => ({
          result: {
            alternatives: [
              {
                message: {
                  text: JSON.stringify({
                    selected: [{ id: '1', description: 'refined p3' }],
                  }),
                },
              },
            ],
          },
        }),
      });

    const result = await service.refineSelectedInBatches(pois, 'persona');

    expect(result.diagnostics.batch_count).toBe(2);
    expect(result.diagnostics.failed_batches).toBe(1);
    expect(result.diagnostics.fallback_reasons).toContain(
      'batch_1:YANDEX_HTTP_500',
    );
    expect(result.refined[0].description).toBe('desc p1');
    expect(result.refined[1].description).toBe('desc p2');
    expect(result.refined[2].description).toBe('refined p3');
  });

  it('falls back and records INVALID_JSON when model returns invalid json', async () => {
    const service = new YandexBatchRefinementService();
    const pois = [buildPoi('p1'), buildPoi('p2')];

    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: () => ({
        result: {
          alternatives: [
            {
              message: {
                text: '{bad-json',
              },
            },
          ],
        },
      }),
    });

    const result = await service.refineSelectedInBatches(pois, 'persona');

    expect(result.diagnostics).toEqual({
      batch_count: 1,
      failed_batches: 1,
      fallback_reasons: ['batch_1:INVALID_JSON'],
    });
    expect(result.refined).toEqual(pois);
  });
});
