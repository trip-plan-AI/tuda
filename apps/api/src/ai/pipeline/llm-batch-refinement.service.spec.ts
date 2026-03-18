import { LlmBatchRefinementService } from './llm-batch-refinement.service';
import { LlmClientService } from './llm-client.service';
import type { FilteredPoi } from '../types/poi.types';

const buildPoi = (id: string): FilteredPoi => ({
  id,
  name: `POI ${id}`,
  address: `Address ${id}`,
  category: 'museum',
  score: 0.5,
  coordinates: { lat: 55.75, lon: 37.61 },
  description: `desc ${id}`,
});

describe('LlmBatchRefinementService', () => {
  let service: LlmBatchRefinementService;
  let llmClient: LlmClientService;

  beforeEach(() => {
    llmClient = {
      isCisRegion: jest.fn().mockReturnValue(true),
      yandexConfig: { apiKey: 'test-key', folderId: 'test-folder' },
      model: 'test-model',
      chat: jest.fn(),
    } as any;
    service = new LlmBatchRefinementService(llmClient);
    global.fetch = jest.fn();
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('uses Yandex for CIS region when config is available', async () => {
    const pois = [buildPoi('p1')];
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: true,
      json: () => ({
        result: {
          alternatives: [
            {
              message: {
                text: JSON.stringify({
                  refinedPois: [{ id: 'p1', description: 'yandex refined' }],
                }),
              },
            },
          ],
        },
      }),
    });

    const result = await service.refineSelectedInBatches(pois, 'persona', {
      intent: { city: 'Moscow', country_code: 'RU' } as any,
    });

    expect(global.fetch).toHaveBeenCalled();
    expect(result.refined[0].description).toBe('yandex refined');
    expect(result.diagnostics.provider).toBe('yandex');
  });

  it('falls back to OpenRouter when Yandex fails', async () => {
    const pois = [buildPoi('p1')];
    (global.fetch as jest.Mock).mockResolvedValueOnce({
      ok: false,
      status: 500,
    });
    (
      llmClient.chat as jest.Mock
    ).mockResolvedValueOnce(
      JSON.stringify({
        refinedPois: [{ id: 'p1', description: 'openrouter refined' }],
      }),
    );

    const result = await service.refineSelectedInBatches(pois, 'persona', {
      intent: { city: 'Moscow', country_code: 'RU' } as any,
    });

    expect(global.fetch).toHaveBeenCalled();
    expect(llmClient.chat).toHaveBeenCalled();
    expect(result.refined[0].description).toBe('openrouter refined');
    expect(result.diagnostics.provider).toBe('openrouter');
  });

  it('uses OpenRouter for non-CIS region', async () => {
    (llmClient.isCisRegion as jest.Mock).mockReturnValue(false);
    const pois = [buildPoi('p1')];
    (
      llmClient.chat as jest.Mock
    ).mockResolvedValueOnce(
      JSON.stringify({
        refinedPois: [{ id: 'p1', description: 'openrouter refined' }],
      }),
    );

    const result = await service.refineSelectedInBatches(pois, 'persona', {
      intent: { city: 'Paris', country_code: 'FR' } as any,
    });

    expect(global.fetch).not.toHaveBeenCalled();
    expect(llmClient.chat).toHaveBeenCalled();
    expect(result.refined[0].description).toBe('openrouter refined');
  });
});
